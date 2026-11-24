#!/usr/bin/env python3
"""Native (Anthropic-billed) consumption diagnosis from claudish captures.

Answers, in one run, the recurring fleet question: WHO burns the
Anthropic-native budget, how much, on cron or interactive traffic, and at
what hourly cadence.

    python scripts/native-consumption.py [--since 2026-09-13T00] [--top 10]
        [--captures-dir D:\\claudish-captures]
    python scripts/native-consumption.py --leak-policy --since 2026-11-09T00 \\
        --captures-dir //192.168.0.50/d$/claudish-captures   # verdict, tetes seules

Reads only loose req-*.json / resp-*.sse captures (archives are packed
nightly by compress-captures.ps1 at 02:47 — run before packing, or pull the
day's archive first).

Per-response attribution needs req<->resp pairing; each trap below produced
a wrong-but-plausible number during development:

  1. req captures are ENVELOPES: {ts, src, machine, model, pid, body}. The
     Anthropic payload (system/messages/metadata) lives under .body.
  2. req filenames end in EITHER -direct.json (LAN) or
     -<ip>__<ip>_<port>.json (WAN via ARR). The native lane is WAN-shaped:
     an index built on -direct alone silently drops every native request.
  3. Pairing key is (pid, reqN-from-resp-HEADER), never the resp filename
     rank rNNNN: the response counter is a different sequence, and BOTH
     counters reset at every container restart — always add a time window
     (req within 35 min before its resp, same day). The req FILENAME pads
     the counter to 4 digits (req-1-0100-...) while the header says
     reqN=100: the index keys on the integer, or every request below 1000
     after a restart stays unpaired (found 09/11 on the hub corpus).
  4. Timestamps: parse as datetimes. String-slicing minutes across two
     different filename shapes is how you pair 06:49 with 06:09.
  5. Usage tokens: input/cache fields come from message_start (FIRST
     occurrence), output_tokens from message_delta (LAST occurrence,
     cumulative). Mixing them double-counts or zeroes arbitrarily.
  6. Workspace attribution is by MOST-CITED known path root in the decoded
     body (these clients carry no Working-directory env block; identity
     lives in the paths of the conversation). A session about CoursIA
     mentioning claudish 8 times still attributes to CoursIA. Label the
     numbers heuristic, not exact.
  7. cc_workload=cron / cc_entrypoint live in system[0] (the
     x-anthropic-billing-header block), device_id in metadata.user_id.
  8. cc_workload=cron is a PER-REQUEST stamp. A cron-fired turn in a REPL
     session carries it on the turn's requests only — tool-loop continuations
     and later turns of the same session do NOT. "Unmarked" therefore means
     "not stamped on this request", NEVER "a human is driving". To tell what
     a request actually is, classify the LAST user message: a compaction
     call ("CRITICAL: Respond with TEXT ONLY"), a continuation summary
     ("This session is being continued") or a slash command each identify
     the turn's nature with no workload marker at all.
  9. Index req captures WITHOUT the --since/--until filter: a req filed at
     23:xx the previous day pairs a 00:0x response, and window-filtering
     the index turns those into fake "non appariées" at day edges (found
     cross-seat by myia-ai-01: 57 unp vs 10 on the same corpus). The
     35-min pairing window on the response side is the only gate needed.
  10. A KNOWN_ROOTS entry can collide with a USERNAME path segment:
      "myia" matches C:\\Users\\MYIA\\... inside every ai-01 conversation
      path, biasing attribution toward the "myia" workspace. Scrub
      users/<name> path segments before counting roots.
"""

import argparse
import collections
import json
import os
import re
import sys
from datetime import datetime, timedelta

USER_PATH_RE = re.compile(r"[\\/]+users[\\/]+[a-z_0-9-]+")

RESP_RE = re.compile(
    r"^resp-(\d+)-r\d+-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.sse$")
REQ_RE = re.compile(
    r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-.+\.json$")
HDR_RE = re.compile(r"^# parser=\S+ model=(\S+) reqN=(\d+) pid=(\d+)", re.M)
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
U_CC = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')
DEV_RE = re.compile(r'"device_id":"([0-9a-f]{8})')

KNOWN_ROOTS = [
    "coursia", "epita", "argumentum", "roo-extensions", "claudish",
    "models-index", "maintenance", "myia",
]


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--captures-dir", action="append", default=None,
                    help="racine du corpus de captures ; REPETABLE (#1180) — un "
                         "corpus reparti sur deux disques (captures deplacees "
                         "vers un overflow) se lit en union dedupliquee par nom "
                         "de fichier. Defaut : D:\\claudish-captures")
    ap.add_argument("--since", default="",
                    help="YYYY-MM-DD, YYYY-MM-DDTHH or full ISO like "
                         "2026-10-15T23:00:00Z (UTC, truncated to the hour, inclusive)")
    ap.add_argument("--until", default="", help="same shapes as --since, exclusive")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--fleet", default="",
                    help="machines sidecar attendues (separees par des virgules) — "
                         "active l'avertissement d'angle mort AUTONOMOUS (#933)")
    ap.add_argument("--reconcile-dir", default="",
                    help="dossier des archives outage-*.7z (defaut : GDrive du "
                         "script de reconciliation, env CLAUDISH_RECONCILE_DIR ; "
                         "<corpus>/reconcile reste source additionnelle, #940)")
    ap.add_argument("--selftest", action="store_true",
                    help="run the fname_dt parsing checks and exit")
    ap.add_argument("--leak-policy", action="store_true",
                    help="verdict leak-policy rapide (#445) : reponses natives et Opus "
                         "par machine (enveloppe req), seau sans machine, axe lane "
                         "Opus (#1055 : basename du cwd, jamais le chemin), sous-agents "
                         "Opus hors --opus-home ; tetes pour tout, le corps ENTIER des "
                         "seuls Opus. Exit 3 = verdict refuse (Opus sans machine ou "
                         "non apparie)")
    ap.add_argument("--opus-home", default="myia-ai-01",
                    help="machine dont l'Opus n'est pas detaille (defaut myia-ai-01)")
    ap.add_argument("--workers", type=int, default=16,
                    help="taille du pool des tete-lectures (#997) : 95 ms par "
                         "ouverture sur UNC rendaient les verdicts serie >30 min ; "
                         "plafond de threads, pas un objectif. 1 = passe "
                         "exactement serie, sans pool (temoin d'equivalence)")
    return ap.parse_args()


# Accepted --since/--until shapes: date-only, date-hour (canonical, matches the
# capture filename stamp) and full ISO (:MM, :MM:SS, optional trailing Z) —
# anything else exits with a clean message instead of a strptime traceback.
_DATE_BOUND_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?(?::(\d{2}))?(?::(\d{2}))?$")


def fname_dt(date_h, minutes):
    s = date_h.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1]
    m = _DATE_BOUND_RE.match(s)
    if not m:
        raise SystemExit(f"unparseable date bound {date_h!r}: expected YYYY-MM-DD, "
                         "YYYY-MM-DDTHH or ISO (e.g. 2026-10-15T23:00:00Z)")
    hh = m.group(2) or "00"
    # minute/second components are truncated — bounds are hour-granular by design
    try:
        return datetime.strptime(m.group(1) + "T" + hh + minutes, "%Y-%m-%dT%H%M")
    except ValueError:
        # right digit count, impossible date (e.g. 2026-13-45T99) — same clean exit
        raise SystemExit(f"unparseable date bound {date_h!r}: expected YYYY-MM-DD, "
                         "YYYY-MM-DDTHH or ISO (e.g. 2026-10-15T23:00:00Z)")


def selftest():
    ok = datetime(2026, 10, 15, 23, 0)
    for shape in ("2026-10-15T23", "2026-10-15T23:00", "2026-10-15T23:00:00",
                  "2026-10-15T23:00:00Z", "2026-10-15T23:00:00z"):
        got = fname_dt(shape, "00")
        assert got == ok, f"{shape} -> {got}, expected {ok}"
    day = datetime(2026, 10, 15, 0, 0)
    got = fname_dt("2026-10-15", "00")
    assert got == day, f"date-only -> {got}, expected {day}"
    until = fname_dt("2026-10-15T23:59:59Z", "59")
    assert until == datetime(2026, 10, 15, 23, 59), f"until -> {until}"
    for bad in ("2026-10-15T23:00:00+02:00", "yesterday", "2026-10-15T2"):
        try:
            fname_dt(bad, "00")
        except SystemExit as e:
            assert "unparseable" in str(e), f"{bad}: odd message {e}"
        else:
            raise AssertionError(f"{bad} accepted, should have exited")
    print("selftest OK: 6 shapes parsed, 3 rejected cleanly")


def workspace_of(body_text):
    scrubbed = USER_PATH_RE.sub(" /users/x/", body_text)
    counts = {r: scrubbed.count(r) for r in KNOWN_ROOTS}
    best = max(counts, key=lambda r: counts[r])
    return best if counts[best] >= 3 else "(inconnu)"


ENV_MACHINE_RE = re.compile(r'"machine":\s*"([^"]*)"')
ENV_DEVICE8_RE = re.compile(r'"device_id8":\s*"([0-9a-f]{8})"')
# #1051 — le predicat `cc_is_subagent` n'est PAS defini ici. Une seule copie
# vit dans lib/subagent_flag.py : trois etats, segment x-anthropic-billing-
# header seul, dernier segment gagne. Les deux copies locales avaient diverge,
# et celle du mode complet matchait un echo du CLAUDE.md du depot.
NO_MACHINE = "(sans machine)"


def leak_policy(resps, req_index, opus_home, workers=16):
    """Verdict leak-policy (#445) en tetes seulement.

    Meme appariement que le mode complet (piege 3 : reqN + pid lus dans
    l'EN-TETE de la reponse, req au plus 35 min avant, la plus recente) — le
    rang rNNNN du nom de fichier n'est jamais une cle. Machine et device lus
    dans les ~1 Ko de tete de l'enveloppe req ; le corps entier n'est lu que
    pour un OPUS (axe lane #1055 item 2 : le basename du cwd, jamais le
    chemin — parsing partage lib/cwd_lane.py ; signature sous-agent pour les
    hors `opus_home` seulement).

    #997 : chaque lecture passe par le pool borne de la lib blind_spot
    (`workers` threads, defaut 16 — sur UNC une ouverture coute ~95 ms et la
    passe serie depassait 30 min). Decoupage en PHASES : toutes les tetes de
    reponse, puis toutes les tetes d'enveloppe des apparies (dedupliquees par
    chemin : deux retries d'une meme req ne paient qu'une lecture), puis les
    corps des Opus hors home (rares, dedupliques). L'AGREGATION reste dans
    l'ordre serie des reponses : la sortie est identique a workers=1, et une
    lecture en echec (None) vaut exactement l'OSError de la passe serie.
    Le corpus est append-only pendant la lecture : deux reponses citant la
    meme enveloppe voient le meme contenu, ce que le serie garantissait
    seulement de fait.

    Le verdict est REFUSE (retour 3) si un Opus tombe dans le seau sans
    machine ou reste non apparie : c'est ce controle, et lui seul, qui rend le
    verdict valide malgre l'angle mort du relais (qui preserve l'en-tete
    machine sans jamais le poser).

    Exception declaree, pas refusee : une reponse sans requete dont la fenetre
    de 35 min commence AVANT la premiere requete du corpus vivant. La
    compaction nocturne archive les req de la veille (live 09/11 : resp a
    00:00:08Z, reqN=2506, sa req du 08/11 partie dans l'archive) — l'instrument
    ne peut pas la voir, il le dit, comme la ligne BLIND de #933."""
    rows = collections.defaultdict(lambda: {
        "nat": 0, "opus": 0, "sub": 0, "dev": collections.Counter(),
        "hours": collections.Counter(), "lanes": collections.Counter()})
    unp = {"nat": 0, "opus": 0}
    trunc = {"nat": 0, "opus": 0}
    corpus_start = min((c[0] for lst in req_index.values() for c in lst),
                       default=None)
    bs = _load_blind_spot()  # read_heads / read_head : pool borne #997

    # Phase 1 (#997) — tetes de TOUTES les reponses en pool borne, ordre
    # preserve. None = l'OSError du serie : la reponse est sautee.
    heads = bs.read_heads([p for (_ts, _pid, p) in resps], 400, workers)
    # Phase 2 — decisions d'appariement (CPU, serie) ; les compteurs des non-
    # appariees sont increments ICI, dans l'ordre serie.
    planned = []  # (ts, is_opus, req_path) — une entree par reponse appariee
    for (ts, _pid, path), head in zip(resps, heads):
        if head is None:
            continue
        h = HDR_RE.search(head)
        if not h:
            continue
        model, reqN, hdr_pid = h.group(1), h.group(2), h.group(3)
        is_opus = "opus" in model
        cands = sorted(
            (c for c in req_index.get((hdr_pid, int(reqN)), [])
             if c[0] <= ts and ts - c[0] <= timedelta(minutes=35)))
        if not cands:
            if corpus_start and ts - timedelta(minutes=35) < corpus_start:
                trunc["nat"] += 1
                trunc["opus"] += is_opus
                continue
            unp["nat"] += 1
            unp["opus"] += is_opus
            continue
        planned.append((ts, is_opus, cands[-1][1]))

    # Phase 3 (#997) — tetes d'enveloppe des apparies, pool borne, DEDUPLI-
    # QUEES par chemin. Une enveloppe illisible vaut pour CHACUNE des
    # reponses qui la citent : non appariee, comme l'OSError du serie.
    req_paths = sorted({p for (_ts, _op, p) in planned})
    env_heads = dict(zip(req_paths, bs.read_heads(req_paths, 1024, workers)))
    # Phase 4 — agregation, ordre serie des reponses. Les Opus (home
    # compris) reportent leur lecture de CORPS en phase 5 : l'axe lane
    # (#1055 item 2) se lit dans le preambule cwd, donc dans le corps.
    opus_reads = []  # (machine, req_path, off_home) — corps entier a relire
    for ts, is_opus, req_path in planned:
        env_head = env_heads.get(req_path)
        if env_head is None:
            unp["nat"] += 1
            unp["opus"] += is_opus
            continue
        mm = ENV_MACHINE_RE.search(env_head)
        machine = (mm.group(1) if mm else "") or NO_MACHINE
        r = rows[machine]
        r["nat"] += 1
        if not is_opus:
            continue
        r["opus"] += 1
        off_home = machine != opus_home
        if off_home:
            dv = ENV_DEVICE8_RE.search(env_head)
            r["dev"][dv.group(1) if dv else "?"] += 1
            r["hours"][ts.strftime("%d %Hh")] += 1
        opus_reads.append((machine, req_path, off_home))
    # Phase 5 (#997) — corps des Opus (TOUS : axe lane ; les hors home en
    # plus pour la signature sous-agent) : lecture ENTIERE mais PAR LOTS —
    # le rejeu 7 jours (15/11) a fait MemoryError sur le dict tenant TOUS
    # les corps d'un coup (des milliers d'Opus x des Mo chacun). Le lot
    # (32 chemins) paie le pool borne ; SEUL le verdict (axe lane, drapeau
    # sous-agent) survit au lot, le corps est jete. Un corps illisible ne
    # signe rien (le serie faisait except OSError: pass) mais reste
    # VISIBLE dans l'axe lane : un zero mesure et un zero devine ne se
    # lisent pas pareil.
    _UNREAD = _Unread()
    off_home_paths = {p for (_m, p, off) in opus_reads if off}
    verdicts = {}  # req_path -> ((lane, cc), sub|None) ou _UNREAD
    opus_paths = sorted({p for (_m, p, _o) in opus_reads})
    for i in range(0, len(opus_paths), 32):
        chunk = opus_paths[i:i + 32]
        for p, body in zip(chunk, bs.read_heads(chunk, None, workers)):
            if body is None:
                verdicts[p] = _UNREAD
            else:
                verdicts[p] = (_lane_key(body),
                               _subagent_flag(body) if p in off_home_paths else None)
    for machine, req_path, off_home in opus_reads:
        v = verdicts.get(req_path, _UNREAD)
        if v is _UNREAD:
            rows[machine]["lanes"]["(corps illisible)"] += 1
            continue
        (lane, _cc), sub = v
        rows[machine]["lanes"][lane if lane is not None else NON_CC_LANE] += 1
        if off_home and sub is True:
            rows[machine]["sub"] += 1

    print("Leak-policy (#445) — reponses natives par machine "
          "(enveloppe req, appariement en-tete reqN+pid) :")
    print(f"  {'machine':18s} {'natives':>7s} {'opus':>5s}  lanes Opus (basename cwd) · detail hors {opus_home}")
    for machine, r in sorted(rows.items(), key=lambda kv: -kv[1]["opus"]):
        detail = ""
        if r["opus"]:
            lanes = " ".join(f"{k}:{v}" for k, v in r["lanes"].most_common(5))
            detail = f"lanes={lanes}"
            if machine != opus_home:
                devs = " ".join(f"{d}:{c}" for d, c in r["dev"].most_common(4))
                hrs = " ".join(f"{k}:{v}" for k, v in sorted(r["hours"].items()))
                detail += f" sub={r['sub']}/{r['opus']} dev={devs} heures={hrs}"
        print(f"  {machine:18s} {r['nat']:7d} {r['opus']:5d}  {detail}")
    empty_opus = rows[NO_MACHINE]["opus"] if NO_MACHINE in rows else 0
    print(f"Non appariees : natives={unp['nat']} opus={unp['opus']}")
    if trunc["nat"]:
        print(f"Fenetre tronquee (req avant le debut du corpus vivant "
              f"{corpus_start:%Y-%m-%dT%H:%M:%S}Z, archivee par la compaction) : "
              f"natives={trunc['nat']} opus={trunc['opus']} — non attribuees, "
              "hors verdict")
    if empty_opus or unp["opus"]:
        print(f"VERDICT REFUSE : {empty_opus} Opus sans machine, {unp['opus']} Opus "
              "non apparie(s) — l'attribution ne couvre pas tout l'Opus servi")
        return 3
    print("Seau sans machine : 0 Opus, tout Opus apparie -> verdict valide "
          "(corpus hub seulement : « a travers claudish »)")
    return 0


def _load_lib(name):
    """Charge une lib de scripts/lib/ — une copie par semantique, pas deux."""
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parent / "lib" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_blind_spot():
    """Declaration de l'angle mort AUTONOMOUS (#933) — lib partagee avec
    traffic-consumption.py et billed-attrib.py, une seule copie."""
    return _load_lib("blind_spot")


def _load_partial_parts():
    """Parties de jour #1152 c (declaration PARTIAL + extraction exacte) —
    lib partagee avec traffic-consumption.py et billed-attrib.py."""
    return _load_lib("partial_parts")


_SF = None
_CWD = None
NON_CC_LANE = "(non-cc)"


class _Unread:
    """Sentinelle « corps illisible » — distincte de (None, False), le
    verdict « pas de preambule CC » du predicat : les deux ne se
    confondent JAMAIS, l'un est un echec de lecture, l'autre une lecture
    qui dit quelque chose."""


def _lane_key(raw):
    """L'axe lane (#1055 item 2) — le parsing du preambule cwd, charge une
    fois par processus depuis lib/cwd_lane.py (une copie par semantique).

    Rend (basename minuscule ou seau visible, vient_de_claude_code) —
    (None, False) sans marqueur : l'appelant pose son seau non-CC. Le
    basename, JAMAIS le chemin (arbitrage coordinateur 15/11) : un chemin
    est prive, un nom est un axe.
    """
    global _CWD
    if _CWD is None:
        _CWD = _load_lib("cwd_lane")
    return _CWD.lane_key(raw)


def _subagent_flag(raw):
    """Le predicat #1051, charge une fois par processus.

    True / False / None. None (« aucune preuve dans ce texte ») ne compte
    jamais comme un sous-agent : c'est la difference entre un zero mesure et
    un zero devine. Les deux chemins (mode complet et --leak-policy) passent
    par ICI — c'est tout l'objet de #1051.
    """
    global _SF
    if _SF is None:
        _SF = _load_lib("subagent_flag")
    return _SF.subagent_flag(raw)


def main():
    a = parse_args()
    if a.selftest:
        selftest()
        return
    # #1180 — `--captures-dir` est repetable : la PREMIERE racine reste le
    # corpus de reference (son archive/ et son reconcile/ gardent leur sens),
    # les suivantes n'ajoutent que leurs captures loose.
    _dirs = a.captures_dir or [r"D:\claudish-captures"]
    cdir = _dirs[0]
    since = fname_dt(a.since, "00") if a.since else None
    until = fname_dt(a.until, "00") if a.until else None

    req_index = collections.defaultdict(list)
    resps = []
    # union dedupliquee par NOM de fichier, premiere racine gagne (#1180).
    # Chaque racine est OUVERTE une fois, ici : une racine que scandir refuse
    # est NON COUVERTE — nommee sur la ligne COVERAGE (stdout), jamais lue
    # comme un corpus vide.
    _seen = set()
    _covered, _uncovered = [], []

    def _index_capture(n, path):
        """One capture file — loose OR extracted from a day part (#1152 c) —
        into the same dual index. The window bound lives HERE so the part
        merge (below) filters exactly like the loose scan."""
        if n.startswith("req-") and n.endswith(".json"):
            m = REQ_RE.match(n)
            if m:
                dt = fname_dt(m.group(3), m.group(4))
                # the req filename pads the counter to 4 digits (req-1-0100-...)
                # while the resp header says reqN=100: key on the integer, or
                # every request below 1000 after a restart stays unpaired
                req_index[(m.group(1), int(m.group(2)))].append((dt, path))
        elif n.startswith("resp-") and "-native-" in n and n.endswith(".sse"):
            m = RESP_RE.match(n)
            if not m:
                return
            dt = fname_dt(m.group(2), m.group(3))
            if since and dt < since:
                return
            if until and dt >= until:
                return
            resps.append((dt, m.group(1), path))

    for _d in _dirs:
        try:
            with os.scandir(_d) as it:
                for e in it:
                    if e.name in _seen:
                        continue
                    _seen.add(e.name)
                    _index_capture(e.name, e.path)
        except OSError as exc:
            # une racine illisible n'est pas un corpus vide : elle se declare
            _uncovered.append(_d)
            print(f"warning: capture dir unreadable ({exc}) -> not covered",
                  file=sys.stderr)
        else:
            _covered.append(_d)
    # #933 — l'angle mort AUTONOMOUS se declare AVANT tout verdict lane : le
    # check est corpus-level, il ne depend pas des captures natives. Une fenetre
    # sans AUCUNE capture native est precisement le cas outillage-aveugle — le
    # early-return ci-dessous ne doit pas l'avaler. Fenetre : since/until
    # declares, sinon l'etendue des resps vues -> maintenant ; sans resps,
    # since ou 24h en arriere. Les bornes fname_dt sont naives (captures UTC) :
    # tz-aware pour la lib.
    from datetime import timezone as _tz
    fleet = [m.strip() for m in a.fleet.split(",") if m.strip()]
    _now = datetime.now(_tz.utc)
    _fallback_start = (resps[0][0] if resps else _now - timedelta(hours=24))
    w_start = (since if since else _fallback_start).replace(tzinfo=_tz.utc)
    w_end = (until if until else _now).replace(tzinfo=_tz.utc)
    _bs = _load_blind_spot()
    _rdir = a.reconcile_dir or _bs.default_reconcile_dir()
    print(f"COVERAGE dirs={len(_covered)}/{len(_dirs)}"
          + (f" uncovered={' | '.join(_uncovered)}" if _uncovered else ""))
    if not _covered:
        # sur main, une racine unique illisible etait un traceback (rc 1) :
        # rien n'a ete lu, un rc 0 le lirait comme un corpus sans trafic
        print("error: no capture dir could be read -> nothing was counted "
              "(exit 2)", file=sys.stderr)
    # #1180 — les comptes nominaux sont SOMMES sur les racines LUES (le
    # meme nom de fichier ne compte qu'une fois, d'une racine a l'autre) ;
    # le verdict BLIND reste la regle unique de blind_spot.assess.
    _skip = set()
    _nominal = {}
    for _d in _covered:
        for _m, _n in _bs.count_nominal_by_machine(
                _d, w_start, w_end, workers=a.workers,
                skip_names=_skip).items():
            _nominal[_m] = _nominal.get(_m, 0) + _n
    # archives outage : lues sous la PREMIERE racine (+ --reconcile-dir) —
    # les captures deplacees ne deplacent pas le dossier reconcile/.
    _blind = _bs.assess(cdir, w_start, w_end, fleet,
                        reconcile_dir=_rdir, nominal_counts=_nominal,
                        workers=a.workers)
    for line in _bs.render(cdir, w_start, w_end, fleet,
                           reconcile_dir=_rdir, res=_blind, workers=a.workers):
        print(line)
    print()

    # #1152 c — a day packed into parts is no longer on loose disk. In
    # --leak-policy mode the verdict must be EXACT (decision AC 4): members of
    # the parts overlapping the window are extracted and indexed like loose
    # captures. Any other mode DECLARES the undercount (PARTIAL line) instead
    # of letting a packed day read as "no traffic".
    _pp = _load_partial_parts()
    _all_parts = _pp.assess_many(_covered, w_start, w_end)
    _merged = ()
    _scratch = None
    if _all_parts["parts"] and a.leak_policy:
        import shutil
        import tempfile
        # NOTE: the scratch must OUTLIVE this block — leak_policy opens the
        # extracted files below. Its rmtree rides the leak_policy call's
        # finally, never here (measured: deleting here swallowed the whole
        # verdict — every read_head came back None).
        _scratch = tempfile.mkdtemp(prefix="claudish-parts-")

        def _keep(b):
            # same bounds as _index_capture (since/until, None = unbounded)
            # — the merge must filter EXACTLY like the loose scan, the
            # w_start/w_end day filter already chose which parts.
            if not b.startswith(("req-", "resp-")):
                return False
            if b.startswith("req-"):
                m = REQ_RE.match(b)
                if not m:
                    return False
                dt = fname_dt(m.group(3), m.group(4))
            else:
                m = RESP_RE.match(b)
                if not m:
                    return False
                dt = fname_dt(m.group(2), m.group(3))
            if since and dt < since:
                return False
            if until and dt >= until:
                return False
            return True
        _ok = []
        for r in _all_parts["parts"]:
            try:
                for fp in _pp.read_members([r["path"]], _scratch, keep=_keep):
                    _index_capture(os.path.basename(fp), fp)
                _ok.append(r["path"])
            except Exception as exc:
                # unreadable part / py7zr missing: that part stays a
                # DECLARED undercount, never a silent one
                print(f"warning: part {r['fname']} unreadable ({exc})"
                      " -> counted as PARTIAL", file=sys.stderr)
        _merged = tuple(_ok)
    _parts_res = _pp.assess_many(_covered, w_start, w_end, merged_paths=_merged)
    for line in _pp.section(cdir, w_start, w_end, merged_paths=_merged,
                            res=_parts_res):
        print(line)
    if _merged or _all_parts["parts"]:
        print()

    if not resps:
        if _scratch:
            import shutil
            shutil.rmtree(_scratch, ignore_errors=True)
        if not _covered:
            # deja dit sur stderr : aucune racine lisible — ce n'est pas
            # une fenetre sans capture, le message d'origine mentirait
            return 2
        print("Aucune capture native dans la fenetre.", file=sys.stderr)
        return 1
    resps.sort()
    if a.leak_policy:
        try:
            return leak_policy(resps, req_index, a.opus_home,
                               workers=a.workers)
        finally:
            if _scratch:
                import shutil
                shutil.rmtree(_scratch, ignore_errors=True)

    ws = collections.defaultdict(lambda: {
        "n": 0, "out": 0, "in": 0, "cr": 0, "cc": 0,
        "cron": 0, "int": 0, "sub": 0, "compact": 0, "cont": 0})
    dev = collections.defaultdict(lambda: {"n": 0, "out": 0})
    hours = collections.Counter()
    top_out = []
    tot = {"n": 0, "out": 0, "in": 0, "cr": 0, "cc": 0, "unp": 0}
    models = collections.Counter()

    for ts, pid, path in resps:
        try:
            head = open(path, encoding="utf-8", errors="replace").read(400)
            h = HDR_RE.search(head)
            if not h:
                continue
            rt = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        model, reqN, hdr_pid = h.group(1), h.group(2), h.group(3)
        models[model] += 1
        ins, outs = U_IN.findall(rt), U_OUT.findall(rt)
        crs, ccs = U_CR.findall(rt), U_CC.findall(rt)
        i = int(ins[0]) if ins else 0
        o = int(outs[-1]) if outs else 0
        cr = int(crs[0]) if crs else 0
        cc = int(ccs[0]) if ccs else 0
        tot["n"] += 1
        tot["out"] += o
        tot["in"] += i
        tot["cr"] += cr
        tot["cc"] += cc
        hours[ts.strftime("%d %Hh")] += 1
        top_out.append((o, ts))
        cands = sorted(
            (c for c in req_index.get((hdr_pid, int(reqN)), [])
             if c[0] <= ts and ts - c[0] <= timedelta(minutes=35)))
        if not cands:
            tot["unp"] += 1
            continue
        try:
            env = json.loads(
                open(cands[-1][1], encoding="utf-8", errors="replace").read())
        except (OSError, ValueError):
            continue
        body = env.get("body", env)
        s = body.get("system")
        stext = " ".join(
            x.get("text", "") for x in s if isinstance(x, dict)
        ) if isinstance(s, list) else (s or "")
        raw = json.dumps(body)
        w = workspace_of((stext + " " + raw).lower())
        # #98: les champs d'attribution persistent dans l'enveloppe (device_id8,
        # workload) — exacts quand presents, regex du body en fallback (captures
        # pre-#98). Le piege 8 tient pour les deux sources : stamp PAR requete.
        wl_env = env.get("workload")
        cron = (wl_env == "cron") if wl_env is not None else ("cc_workload=cron" in stext)
        md = str(body.get("metadata", {}).get("user_id", ""))
        dv = DEV_RE.search(md)
        device = env.get("device_id8") or (dv.group(1) if dv else "?")
        d = ws[w]
        d["n"] += 1
        d["out"] += o
        d["in"] += i
        d["cr"] += cr
        d["cc"] += cc
        d["cron" if cron else "int"] += 1
        last_user = ""
        for m in reversed(body.get("messages", [])):
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str):
                last_user = c
                break
            if isinstance(c, list):
                texts = [x.get("text", "") for x in c
                         if isinstance(x, dict) and x.get("type") == "text"]
                if texts:
                    last_user = texts[0]
                    break
        lu = last_user.strip()
        if lu.startswith("CRITICAL: Respond with TEXT"):
            d["compact"] += 1
        elif lu.startswith("This session is being continued"):
            d["cont"] += 1
        if _subagent_flag(raw) is True:
            d["sub"] += 1
        k = (device, w, "cron" if cron else "interactif")
        dev[k]["n"] += 1
        dev[k]["out"] += o

    print(f"Reponses natives: {tot['n']}  (non appariees: {tot['unp']})")
    print(f"Modeles: {dict(models.most_common())}")
    print(f"Tokens:  OUT={tot['out']:,}  in_frais={tot['in']:,}  "
          f"cache_read={tot['cr']:,}  cache_creation={tot['cc']:,}")
    print(f"Moyenne par requete: OUT={tot['out'] // max(tot['n'], 1):,}  "
          f"cache_read={tot['cr'] // max(tot['n'], 1):,}")
    print()
    print("Par heure:")
    for h in sorted(hours):
        print(f"  {h}  {'#' * (hours[h] // 2 or 1)} {hours[h]}")
    print()
    print(f"Workspace ({'heuristic — racine la plus citee'}), trie par OUT:")
    print(f"  {'workspace':22s} {'n':>5s} {'marqC':>5s} {'nonM':>5s} {'sub':>4s} "
          f"{'OUT tok':>11s} {'in frais':>10s} {'cache_read':>12s} "
          f"{'compact':>7s} {'continu':>7s}")
    print("  (marqC = marque cc_workload=cron SUR CETTE requete — voir piege 8 ;"
          " sub = cc_is_subagent=true dans le segment billing-header seulement —"
          " un echo du CLAUDE.md ne compte pas, une absence d'en-tete reste"
          " inconnue et ne compte pas non plus)")
    for w, d in sorted(ws.items(), key=lambda kv: -kv[1]["out"])[:a.top]:
        print(f"  {w:22s} {d['n']:5d} {d['cron']:5d} {d['int']:5d} {d['sub']:4d} "
              f"{d['out']:11,d} {d['in']:10,d} {d['cr']:12,d} "
              f"{d['compact']:7d} {d['cont']:7d}")
    print()
    print("Par device + workload (top):")
    for (dv, w, wl), c in sorted(dev.items(), key=lambda kv: -kv[1]["out"])[:a.top]:
        print(f"  {dv}  {w:22s} {wl:11s} n={c['n']:4d}  OUT={c['out']:10,d}")
    print()
    top_out.sort(reverse=True)
    print("Top responses par OUT:")
    for o, ts in top_out[:5]:
        print(f"  {ts:%d %H:%M}  OUT={o:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
