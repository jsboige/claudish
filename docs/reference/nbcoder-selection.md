# nb_coder selection — App GitHub wiring (read-only)

**Scope** : composition des lots de parité C# CoursIA (cibles orphelines). Outil :
`scripts/nbcoder-select.py`. Mandat : GO coordinateur ai-01:CoursIA
2026-11-19T01:03Z (thread `c2048-nbcoder-app-selection`) — lectures de sélection
sur le seau de l'App du siège, écritures hors périmètre.

## Contrat

- **Jeton App process-local** : forgé en tête de run via l'organe flotte
  `github_app_token.py` ( défauts `--forge`/`--key`/`--app-id`, surcharge env
  `APP_SELECT_FORGE`/`APP_SELECT_PEM` ), injecté dans l'env des sous-processus
  gh uniquement — jamais en argv, jamais sur disque, jamais affiché.
- **Refus explicite, aucun repli** : App indisponible → `exit 3`, zéro appel
  réseau du processus, jamais de bascule sur le compte partagé.
  `--witness` = self-test du refus (exit 3 attendu, sans réseau).
- **Écritures inchangées** : issues, PRs, comments restent sous l'identité
  ambiante ; l'unique chemin en identité partagée est le sous-processus de
  comparaison `--shared-corpus-dump`, jamais le mode défaut.

## Barre 4 voies (REST pur, points d'entrée listes)

Une cible est disponible ssi absente de : (a) `main` (jumeau C#),
(b) les fichiers des **PRs ouvertes toutes lanes**, (c) les corps des issues
ouvertes, (d) les grains en vol (`--inflight <state-dir>`, repeatable).
Aucun appel par candidat ; un run complet ≈ 220 appels quel que soit le nombre
de candidats (mesuré 00:31Z 19/11 : 219 appels, 269 disponibles).

⚠ **La barre ne couvre pas l'axe claims** : les marqueurs `[CLAIMED]` vivent
sur les issues, pas sur les chemins — une cible libre au dump peut être
claimée entre sélection et lancement (mesuré : course perdue de 39 s contre
une lane sœur, refus propre du scheduler, 0 spend). Perdre cette course est
le fonctionnement voulu.

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
   diff vide au premier run de preuve 00:20Z 19/11).

## Usage

```bash
python scripts/nbcoder-select.py \
  --inflight nbcoder-w1n \
  --out .tmp/avail-app.json \
  --evidence .tmp/app-proof.json --corpus-check
```

Codée le 2026-11-19 (commit `1574007e`) ; mesures de preuve dans la PR
documentaire associée.
