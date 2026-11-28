# nb_coder selection — App GitHub wiring (read-only)

**Scope** : composition des lots de parité C# CoursIA (cibles orphelines). Outil :
`scripts/nbcoder-select.py`. Mandat : GO coordinateur ai-01:CoursIA
2026-11-19T01:03Z (thread `c2048-nbcoder-app-selection`) — lectures de sélection
sur le seau de l'App du siège, écritures hors périmètre.

## Contrat

- **Jeton App process-local** : forgé en tête de run via l'organe flotte
  `github_app_token.py` ( défaut `--forge` = `<repo>/scripts/secrets/github_app_token.py`,
  surcharges env `APP_SELECT_FORGE`/`APP_SELECT_PEM` ), injecté dans l'env des
  sous-processus gh uniquement — jamais en argv, jamais sur disque, jamais affiché.
- **Configuration portable** : `gh` résolu par `NBCODER_GH` puis PATH ; `--repo`
  défaut = répertoire courant ; `--tmp-root` défaut = `<$TMP>/nbcoder-select`.
  Aucun chemin machine n'est câblé dans le script.
- **Refus explicite, aucun repli** : App indisponible → `exit 3`, zéro appel
  réseau du processus, jamais de bascule sur le compte partagé.
  `--witness` = self-test du refus (exit 3 attendu, sans réseau).
  Un échec Git ou gh est un **défaut d'instrument → `exit 2`** : jamais lu
  comme un arbre vide (sinon tout carnet Python devient un faux orphelin).
  Les échecs de sous-processus porteurs de credentials ne remontent qu'un
  statut **sanitizé** (code de sortie + libellé fixe, jamais la sortie de l'enfant).
- **Écritures inchangées** : issues, PRs, comments restent sous l'identité
  ambiante ; l'unique chemin en identité partagée est le sous-processus de
  comparaison `--shared-corpus-dump`, jamais le mode défaut.

## Barre 4 voies (REST pur, points d'entrée listes)

Une cible est disponible ssi absente de : (a) l'**arbre épinglé** (`--pin`,
défaut `origin/main` ; `git ls-tree` sur le SHA résolu, jamais l'index de
travail — un jumeau stagé non poussé ne doit pas masquer un orphelin),
(b) les fichiers des **PRs ouvertes toutes lanes**, **toutes les pages**
(une cible en page 2 est aussi prise que celle en page 1),
(c) les corps des issues ouvertes, (d) les grains en vol
(`--inflight <state-dir>`, repeatable).
Aucun appel par candidat ; un run complet ≈ 220 appels quel que soit le nombre
de candidats (mesuré 00:31Z 19/11 : 219 appels, 269 disponibles).

⚠ **La barre ne couvre pas l'axe claims** : les marqueurs `[CLAIMED]` vivent
sur les issues, pas sur les chemins — une cible libre au dump peut être
claimée entre sélection et lancement (mesuré : course perdue de 39 s contre
une lane sœur, refus propre du scheduler, 0 spend). Perdre cette course est
le fonctionnement voulu.

## Préflight d'un grain (`--preflight N[=CHEMIN],… --lane L --require-free`)

Avant de mettre un grain en file : quatre mesures par issue nommée, dont chacune refuse
seule. Elles portent sur la cible, qui ne doit être ni (a) dans l'arbre épinglé, ni (b) dans
les fichiers d'une PR ouverte. Le fil ne doit (c) porter aucun `[DELIVERED]`, et (d) le verdict
de `check_lane_claim.py` doit être rendu depuis le checkout CoursIA. `--require-free` sort en
`4` dès qu'une issue n'est pas `FREE`.

**Un chemin d'une issue-lot : `N=CHEMIN`** (28/11, #27133). Le corps d'un lot n'a pas de ligne
`Cible`, et chaque carnet y est attribué par un marqueur borné. Au niveau de l'issue, la barre
refusait MGS-27 de trois façons à la fois : pas de cible dans le corps, le `[DELIVERED]` de
MGS-28, et le garde de claim sans `--paths` qui sortait en 2. Or `check_lane_claim.py --paths
<MGS-27>` rendait CLEAR. Avec un chemin :
- la cible EST ce chemin ; un corps dont la `Cible` nomme un autre carnet refuse
  (`path-is-not-the-issue-cible`) ;
- seul un `[DELIVERED]` qui parle pour ce chemin bloque : sa clause `paths:` de tête le nomme, ou
  bien le marqueur n'a pas de clause et nomme le carnet (nom de fichier ou radical). Les autres
  restent listés dans `delivered_other_paths` ;
- le garde de claim reçoit `--paths CHEMIN` ;
- les mesures (a) et (b) restent entières. Un grain livré ne leur échappe pas, puisque sa PR est
  ouverte ou son fichier est sur main.

## Preuves (`--evidence FILE` + `--corpus-check`)

1. **Témoin refus** : `--witness` → exit 3, message explicite, 0 réseau.
2. **Seau App consommé** : lectures `rate_limit` avant/après sous le jeton ;
   borne unilatérale `delta ≥ appels − sondes free − tolérance`. L'égalité
   stricte n'est PAS opposable : le seau d'installation est partagé par tout
   processus forgeant la même App (mesuré : 208 appels concurrents d'un autre
   consommateur dans une fenêtre d'un run).
3. **Zéro appel au seau partagé** : structurel — tout sous-processus gh du
   mode App porte `GH_TOKEN` App ; corroboré par le compteur du sous-processus
   de comparaison.
4. **Corpus identique sur même instantané** : re-sélection sous identité
   partagée en processus séparé → listes de candidats égales (269 = 269,
   diff vide au premier run de preuve 00:20Z 19/11). Une divergence de corpus
   **refuse** (`exit 2`) — avec ou sans `--evidence` : refuser seulement en
   mode enregistré laisserait un run non enregistré consommer un corpus
   divergent en silence.

Tests de régression hors-ligne (aucun réseau) : `scripts/tests/test_nbcoder_select.py`
— cible en page 2 des fichiers d'une PR, arbre stagé ≠ arbre épinglé, échec Git
qui refuse au lieu de rendre vide, échec de forge sanitizé, refus corpus sans
`--evidence`. `python -m unittest discover -s scripts/tests -p "test_nbcoder_select.py"`.

## Usage

```bash
python scripts/nbcoder-select.py \
  --pin origin/main \
  --inflight nbcoder-w1n \
  --out .tmp/avail-app.json \
  --evidence .tmp/app-proof.json --corpus-check
```

Codée le 2026-11-19 (commit `1574007e`) ; mesures de preuve dans la PR
documentaire associée.
