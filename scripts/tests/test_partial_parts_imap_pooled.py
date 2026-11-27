#!/usr/bin/env python3
"""Pins for lib/partial_parts.py `imap_pooled` (#1197 symetrique, 26/11).

`warm_first_open` (#1195) divisait l'attente de la PREMIERE ouverture d'un
fichier ; `imap_pooled` divise l'attente la ou le lecteur la REPAIE, pour un
appelant qui doit rendre son resultat dans l'ORDRE. Quatre contrats, et un
seul chiffre (les octets de lecteur) reste a la charge du lecteur :

  O1  ordre — les elements sortent dans l'ordre d'ENTREE, meme quand le
      dernier finit avant le premier ; c'est ce qui permet a l'agregation de
      rester sequentielle et de ne bouger aucun decompte.
  O2  exception RENDUE, jamais levee a la place de l'appelant, et a la place
      qu'elle occupe dans l'ordre — l'appelant applique SA politique.
  O3  interruption — `workers` <= 1 = tout sur le fil de l'appelant (le
      chiffre en serie et l'interrupteur), meme valeurs, memes exceptions.
  O4  BORNE EN VOL — les soumissions ne depassent pas `window` au-dela de ce
      qui a ete consomme (un corpus de 135 054 fichiers ne tient pas en
      memoire), et s'arreter avant la fin n'attend pas les elements en vol.

Aucun temps n'est mesure ici : le gain (x6,9 mesure au tir du creux du 26/11)
se constate sur un run reel, pas dans un pin — une duree de test n'est pas une
preuve de parallelisme.

Run: python scripts/tests/test_partial_parts_imap_pooled.py
"""

import importlib.util
import os
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_HERE, "..", relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pp = _load("partial_parts", os.path.join("lib", "partial_parts.py"))


def drain(gen):
    return list(gen)


def test_o1_order_is_input_order_even_when_the_slow_one_is_first():
    def fn(x):
        # le PREMIER est le plus lent : il finit apres les autres
        if x == "a":
            time.sleep(0.15)
        return x.upper()

    got = [(i, v, e) for i, v, e in pp.imap_pooled(list("abcde"), fn, 4)]
    assert [v for _i, v, _e in got] == list("ABCDE"), got
    assert [i for i, _v, _e in got] == [0, 1, 2, 3, 4], got
    assert not any(e for _i, _v, e in got), got


def test_o2_exception_is_rendered_in_order_never_raised_here():
    def fn(x):
        if x == 3:
            raise ValueError("boom")
        return x

    got = [(i, v, e) for i, v, e in pp.imap_pooled(range(6), fn, 4)]
    assert len(got) == 6, got
    assert [i for i, _v, _e in got] == list(range(6)), got
    bad = [(i, v, e) for i, v, e in got if e is not None]
    assert len(bad) == 1 and bad[0][0] == 3, bad
    assert isinstance(bad[0][2], ValueError), bad
    assert bad[0][1] is None, bad
    # les autres valeurs sont intactes : une exception ne decale rien
    assert [v for i, v, e in got if e is None] == [0, 1, 2, 4, 5], got


def test_o2b_oserror_too_is_rendered():
    """Le lecteur reel attrape OSError lui-meme ; `imap_pooled` n'a pas a
    connaitre cette classe — il rend TOUT ce qui sort, `BaseException` mise a
    part (KeyboardInterrupt/SystemExit ne sont pas des donnees)."""
    def fn(x):
        if x == 0:
            raise OSError("illisible")
        return x

    got = list(pp.imap_pooled([0, 1], fn, 2))
    assert isinstance(got[0][2], OSError) and got[1][1] == 1, got


def test_o3_workers_at_most_one_stays_on_the_caller_thread():
    seen = []

    def fn(x):
        seen.append((x, threading.get_ident()))
        if x == 1:
            raise RuntimeError("nope")
        return x * 2

    for workers in (0, 1, -3, None, "pas-un-nombre"):
        seen.clear()
        got = list(pp.imap_pooled([0, 1, 2], fn, workers))
        assert [v for _i, v, _e in got] == [0, None, 4], (workers, got)
        assert isinstance(got[1][2], RuntimeError), (workers, got)
        assert {t for _x, t in seen} == {threading.get_ident()}, (workers, seen)


def test_o3b_serial_and_pooled_agree_element_for_element():
    def fn(x):
        return x * x

    ser = list(pp.imap_pooled(range(64), fn, 1))
    par = list(pp.imap_pooled(range(64), fn, 8))
    assert ser == par, [s for s, p in zip(ser, par) if s != p][:5]


def test_o4_in_flight_is_bounded_by_the_window():
    """Soumissions <= consommes + window. Sans la fenetre, un pool de 8
    soumettrait 256 elements d'avance (32 x workers) et garderait 256 textes
    de reponse en memoire.

    Les listes sont LIEES EN DEFAUT a chaque `fn` : sans ca, les fils du run
    precedent (shutdown(wait=False)) ecrivent dans la liste du run suivant —
    la liste est un nom de la portee englobante, relu a l'appel (mesure : 135
    « commences » au lieu de 132)."""
    for workers, window in ((4, 8), (8, 32)):
        started = []
        lock = threading.Lock()

        def fn(x, _started=started, _lock=lock):
            with _lock:
                _started.append(x)
            return x

        gen = pp.imap_pooled(range(500), fn, workers, window=window)
        next(gen)
        consumed = 1
        assert len(started) <= window + workers, (workers, window, len(started))
        for _ in range(100):
            next(gen)
            consumed += 1
        with lock:
            snap = len(started)
        assert snap <= consumed + window, (workers, window, snap, consumed)
        gen.close()


def test_o4b_default_window_is_32x_and_stopping_early_does_not_wait():
    """Le defaut (window=None) est 32 x workers — l'appelant qui a besoin
    d'une fenetre plus serree la PASSE (traffic-consumption : 4 x, la taille
    d'un texte de reponse). S'arreter avant la fin ne bloque pas sur les
    elements en vol."""
    started = []
    lock = threading.Lock()

    def fn(x):
        with lock:
            started.append(x)
        return x

    gen = pp.imap_pooled(range(2000), fn, 8)
    next(gen)
    with lock:
        snap = len(started)
    assert snap <= 8 * 32 + 8, snap

    calls = []

    def slow(x):
        calls.append(x)
        return x

    gen2 = pp.imap_pooled(range(1000), slow, 4, window=8)
    t0 = time.monotonic()
    next(gen2)
    gen2.close()
    assert time.monotonic() - t0 < 5, "close() a attendu les elements en vol"
    assert len(calls) <= 8 + 4, len(calls)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
