# Coupure hub du 30/10 — post-mortem (mesuré, instruments concordants)

> Siège hub : **po-2025** (`claudish-proxy`). Deux épisodes de coupure fleet-facing ce
> jour : **~09:30Z→10:32Z** et **~15:30Z→16:00Z**.
> ⚠ Conventions horaires : `docker logs -t` et `docker-events.log` sont en **UTC** ;
> `watchdog.log` et l'Event Log Windows sont en **heure locale (UTC+1)**. Toutes les
> heures ci-dessous sont converties en **UTC**.
> ⚠ Le corpus `docker logs` couvrant la coupure a été **détruit à 16:57:48Z** par le
> recreate volontaire du soir (Q-40). L'histogramme de trafic cité ici est la lecture
> `claudish_traffic` du 30/10 16:57:49Z — la dernière avant rotation — conservée dans
> ce document ; les journaux durables (watchdog, docker-events, Event Log) restent
> intacts et vérifiables.

## 1. Résumé

1. **Le conteneur n'a jamais été drainé, recréé ni arrêté pendant les coupures.**
   La piste « 8 cycles drain/recreate » est **réfutée** par le journal durable
   (`docker-events.log`) : **zéro** événement de cycle de vie sur `claudish-proxy`
   entre 29/10 21:27:43Z et 30/10 10:32:02Z, puis rien jusqu'à 15:59:49Z — seulement
   deux `start` isolés, chacun ~3 min après un reboot de l'hôte.
2. **Chaque coupure suit le même schéma en trois temps** : (a) le CLI docker cesse de
   répondre (le watchdog et les collecteurs se taisent — leurs ticks s'arrêtent AVANT
   la coupure de trafic) ; (b) la porte fleet-facing meurt (l'entrée du hub tombe à
   zéro alors que le process continuait de répondre sur loopback) ; (c) le user
   rebootte l'hôte, le conteneur revient en ~3 min, le trafic reprend instantanément.
3. **Le hub a servi du trafic normal jusqu'à ~09:30Z** — la fenêtre « 08:44Z » rapportée
   par les sièges n'est pas celle de la mort de la porte. Le process n'est mort pour
   personne à 08:44Z : 385–838 req/15 min jusqu'au bucket 09:15–09:30Z.
4. **Le blocage d'event loop est corrélé à l'état de la couche, pas au trafic** :
   stalls de 33–55 s/5 min sur le process né à 10:32Z pendant le pic de l'après-midi,
   puis 0,9–1,1 s/5 min à charge égale après le restart de 15:59:49Z.

## 2. Chronologie (UTC, vérifiée)

| Heure (UTC) | Fait | Source |
|---|---|---|
| 29/10 13:19:46Z | Recreate du conteneur (dernier geste de déploiement avant ce jour) | `docker-events.log` (kill→start), `Created` inspect |
| 29/10 21:24:29Z · 21:27:43Z | Deux `start` simples (redémarrages, pas de recreate) | `docker-events.log` |
| 30/10 05:02Z→09:17:16Z | Watchdog OK toutes les 15 min (`uptime` 6.6h→11.8h), sonde profonde streaming OK — **le hub sert** : 385–838 req/15 minjusqu'au bucket 09:15–09:30Z | `watchdog.log`, histogramme `claudish_traffic` |
| 09:17:16Z | **Dernier tick watchdog** — ensuite silence du watchdog pendant 75 min (le CLI docker ne répond plus) | `watchdog.log` |
| 09:17:00Z | po-2027 passe AUTONOMOUS (22 min 40 s) — premier siège à perdre le hub | siège po-2027 (RAPPORTE) |
| 09:19–09:58Z | ai-01 morte ⇒ 38 × 502 sur l'étage `swift` (vLLM) du rôle haiku | siège po-2028 (RAPPORTE) |
| 09:30Z→10:15Z | **Effondrement de l'entrée du hub** : 385 → 49 → 70 → 18 → **0** req/15 min — la porte fleet-facing meurt progressivement, machine par machine | histogramme `claudish_traffic` |
| 10:15–10:30Z | **0 requête** — porte morte pour toute la fleet, `localhost`/loopback non mesuré (plus d'instrument : le watchdog est déjà muet) | histogramme |
| 10:29:08Z | **Reboot de l'hôte par le user** (Event 1074, `Explorer.EXE`, « Autre (non planifié) » — motif user : « docker et le hub claudish étaient HS ») | Event Log System |
| 10:32:02Z | Conteneur relancé par Docker Desktop (`start` **sans** `die`/`destroy` au préalable : le daemon est mort avec l'hôte, aucun événement n'a pu être émis) | `docker-events.log` |
| 10:32:05Z | Bannière `Standalone proxy running` | `docker logs -t` (corpus détruit à 16:57:48Z) |
| 10:30–11:30Z | Trafic revenu : 281 → 548 → 579 → 658 req/15 min | histogramme |
| 12:32:08Z · 13:02:08Z · 13:17:10Z | 3 ticks DEGRADED « upstream wall HTTP 429 — NO restart (a restart cannot fix this) » | `watchdog.log` |
| 12:15–15:15Z | **Pic de trafic de la journée** : 776–1390 req/15 min | histogramme |
| 13:47:12Z | Dernier tick watchdog OK de l'après-midi — ensuite silence 2 h 10 | `watchdog.log` |
| 15:11–15:14Z | Stalls mesurés sur le process né à 10:32Z : `blocked5m` 33 546→54 816 ms, `max60s` 3 829 ms, RTT `/health` jusqu'à 3,1 s, 3–8 flux actifs, 5–8 requêtes en attente | boucle de sondage locale (siège hub) |
| 15:15Z→15:30Z | **Deuxième effondrement d'entrée** : 678 → 231 → **0** req/15 min | histogramme |
| 15:30–16:00Z | ~0 requête (4 req au bucket 15:45–16:00Z) | histogramme |
| 15:57:08Z | **Deuxième reboot de l'hôte par le user** (Event 1074, `StartMenuExperienceHost.exe`) | Event Log System |
| 15:57:18Z | Tick watchdog unique dans le trou : `ENGINE-DOWN: docker CLI cannot reach the engine — recovering` — **conséquence du reboot en cours** (1074 10 s plus tôt), pas une panne Docker autonome | `watchdog.log` |
| 15:59:49Z | Conteneur relancé (`start` isolé) ; stalls retombés : 0,9–1,1 s/5 min à 11–14 flux actifs (16:42–16:44Z) | `docker-events.log`, `eventloop-blocked.log` |
| 16:00Z→ | Trafic revenu : 813 → 755 → 985 → 1181 req/15 min | histogramme |
| 16:57:48Z | Recreate **volontaire** du soir (Q-40, ordre user 30/10, drainé) — détruit le corpus de logs de la journée | drain.log, inspect |

## 3. Ce qui est réfuté

| Affirmation | Verdict | Preuve |
|---|---|---|
| « 8 cycles drain/recreate entre 08:44Z et 10:44Z » | **Réfuté** | `docker-events.log` : **zéro** événement de cycle de vie sur `claudish-proxy` entre 29/10 21:27:43Z et 30/10 10:32:02Z (et rien jusqu'à 15:59:49Z hors les deux `start` post-reboot) ; `drain.log` : **0 ligne** le 30/10 avant 17:52 ; l'ancien corpus ne portait que 4 bannières de démarrage |
| « Un conteneur arrêté de 09:37:55Z à 09:53:53Z » | **Réfuté** | un conteneur arrêté ne sert rien : l'entrée du hub pendant cette fenêtre est de **119 requêtes** (49 + 70 sur les buckets 09:30–10:00Z). La source probable de la confusion : la fenêtre AUTONOMOUS d'un sidecar relay (po-2027 : 22 min 40 s) n'est PAS une fenêtre d'arrêt du conteneur hub |
| « Le watchdog a redémarré le hub » | **Réfuté** | les 4 lignes DEGRADED du 30/10 disent toutes « NO restart (a restart cannot fix this) » ; `drain.log` vide le 30/10 avant 17:52 ; les deux `start` (10:32:02Z, 15:59:49Z) suivent chacun un reboot de l'hôte (1074 à 10:29:08Z et 15:57:08Z) — c'est Docker Desktop qui relance le conteneur au boot, pas le watchdog |
| « Le hub était mort dès 08:44Z » | **Réfuté** | le hub servait 385–838 req/15 minjusqu'à 09:30Z ; le premier siège à le perdre (po-2027) ne passe AUTONOMOUS qu'à 09:17:00Z. L'effondrement de la porte est ~09:30Z→10:15Z, progressif |
| « Le hub était lent/saturé le matin » | **Réfuté pour le matin** | ticks watchdog OK + sonde streaming profonde OK jusqu'à 09:17:16Z ; les stalls sévères (15:11–15:14Z) sont l'après-midi, pendant le pic |

## 4. Cause : dégradation de la couche Docker Desktop / WSL, à trois symptômes ordonnés

Chaîne observée **deux fois**, dans le même ordre :

1. **Le CLI docker cesse de répondre EN PREMIER** — le watchdog (qui appelle `docker`) et
   les collecteurs se taisent à 09:17Z et 13:47Z, soit **avant** la mort de la porte
   (09:30Z et 15:15Z). Le silence des instruments Docker est le premier symptôme, pas
   une conséquence de la coupure de trafic.
2. **La porte fleet-facing (`192.168.0.50:3000`) meurt ENSUITE** — l'entrée du hub
   tombe à zéro alors que rien n'indique une mort du process. La porte n'est pas
   mesurée directement pendant les trous (plus d'instrument actif), mais
   l'asymétrie du 27/10 sur po-2023 (mémoire `wslrelay localhost wedge`) montre que
   les portes d'un port publié **meurent indépendamment** l'une de l'autre :
   `wslrelay` peut posséder le loopback et répondre RST pendant que
   `com.docker.backend` sert le wildcard — ou l'inverse.
3. **Le reboot de l'hôte répare tout en ~3 min**, deux fois — conteneur relancé par
   Docker Desktop au boot, trafic revenu au bucket suivant.

**Pourquoi la couche se dégrade reste une hypothèse** (non établie) : compaction vhdx
sautée 12 jours de suite (`hf-cache` 330 Go, `Docker` 240 Go), rafales
`event streamer: error: EOF`, wedge `wslrelay` (précédents ×3 sur cette machine).
**D: n'est pas le facteur** sur le siège hub (352 Go libres, 18,9 %) — le plancher de
5 % concernait po-2023, autre machine.

### Le point aveugle structurel : le watchdog ne sonde jamais la porte de la fleet

`Get-ClaudishProbeCandidates` ordonne : override `base-url.txt` (retiré sur po-2025)
→ `localhost` → LAN **en dernier**. Quand `localhost` répond, **la porte LAN n'est
jamais sondée** — et c'est le comportement voulu ailleurs (une porte fantôme ne doit
pas faire redémarrer un conteneur sain). Mais ici, l'ordre a une conséquence : pendant
les deux épisodes, l'instrument de santé de l'hôte ne pouvait **ni** voir la porte
morte (il sonde loopback) **ni** ticker du tout (son docker CLI était pendu). Un
sondage de la porte fleet-facing (`http://192.168.0.50:3000/health`) **sans passer
par le CLI docker** — un simple GET borné, comme l'échantillonneur #760 — aurait daté
chaque coupure à la minute et séparé « process mort » de « porte morte ».

**Recommandation** : l'échantillonneur `eventloop-sampler.ps1` (relancé ce jour,
tâche `ClaudishEventLoopSampler`, tick/minute) gagne une seconde cible : la porte
LAN. Un champ `door=200|refused|timeout` par tick NDJSON, aucun appel docker. C'est
l'instrument qui aurait couvert les deux trous ; il tourne déjà toutes les minutes.

## 5. Le blocage d'event loop, vu de l'intérieur

Sur le process né à 10:32:02Z, **pendant le pic de trafic de l'après-midi** :

- 15:11–15:14Z : `blocked5m` 33 546→54 816 ms, `max60s` 3 829 ms, RTT `/health`
  jusqu'à 3 135 ms, 3–8 flux actifs, 5–8 requêtes en attente.

Sur le process né à 15:59:49Z, **à charge égale ou supérieure** :

- 16:42–16:44Z : `blocked5m` 1 100 → 1 018 → **871 ms** (0,3 % de la fenêtre),
  `max60s` 50–67 ms, **11–14 flux actifs** (série `eventloop-blocked.log`, #760).

⇒ Le blocage suit **l'âge/état du process et de la couche**, pas la charge. L'I/O du
proxy vers le volume monté (`D:\claudish-captures` ← couche fichier WSL↔Windows) est
le candidat mécanique — **à confirmer** par la série #760 désormais armée (elle date
la minute exacte de chaque stall et sépare les process par `instanceId`).

## 6. Part attributable à la mort d'ai-01

ai-01 (hôte du backend vLLM `swift-1.5-27b`, étage 0 du rôle haiku) est morte
09:19–09:58Z. Ce qui lui revient : **les 38 × 502** sur cet étage et la charge de
cascade supplémentaire (chaque 502 fait avancer la marche). Ce qui **ne** lui revient
pas : **les coupures elles-mêmes** — le hub servait son trafic pendant la mort d'ai-01
(l'entrée 09:15–09:30Z est de 385 req), et les deux trous de service correspondent
aux deux reboots de po-2025, pas aux fenêtres d'ai-01. ai-01 morte = un barreau en
502 ; hub coupé = 0 requête pour toute la fleet.

## 7. Ce qui manquait pour voir ça

| Manque | État au 30/10 soir |
|---|---|
| Série de lag par minute (#760) | **éteinte** sur le siège hub (Maintenance l'avait désactivée pendant l'incident de flicker : le script n'existait alors que dans un worktree de PR). **Relancée** le 30/10 depuis le clone principal (`RunLevel Limited`, aucune élévation) ; premier tick 16:42:27Z ; journal `~/.claudish/eventloop-blocked.log` |
| Sonde de la porte fleet-facing | **inexistante** — le watchdog sonde loopback et ne sonde la LAN que si loopback ne répond pas ; recommandation §4 |
| Historique de cycle de vie Docker | existe (`docker-events.log`) mais **aveugle quand le daemon ne répond pas** — structurel : à l'intérieur d'une panne de daemon, l'instrument qui la mesure est le premier coupé. Il a néanmoins fourni la preuve durable des réfutations (aucun événement = aucun geste) |
| Compteur de ticks watchdog | **déjà couvrant** : c'est le trou de ticks (09:17Z→10:32Z) qui date le début de la dégradation Docker, AVANT la coupure de trafic |

## 8. Reproduction

```bash
# cycle de vie durable du conteneur (preuve des réfutations — le corpus docker logs
# de la journée a été détruit par le recreate de 16:57:48Z)
python - <<'PY'
import json, datetime
for l in open(r"C:\Users\jsboi\.claudish\docker-events.log", encoding="utf-8", errors="replace"):
    try: o = json.loads(l)
    except: continue
    t = o.get("time")
    ts = datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat() if isinstance(t, (int, float)) else str(t)
    if ts < "2026-10-29": continue
    if (o.get("Actor", {}).get("Attributes") or {}).get("name") == "claudish-proxy":
        print(ts, o["Action"])
PY

# trous de ticks du watchdog (⚠ heures LOCALES UTC+1 : 10:17 local = 09:17Z)
grep -aE "^\[2026-10-30 (0[5-9]|1[0-7]):" ~/.claudish/watchdog.log

# reboots de l'hôte (Event Log = heure locale)
Get-WinEvent -FilterHashtable @{LogName='System';Id=1074,6005,6006} -MaxEvents 8

# série de lag par minute (instrument #760, relancé)
tail -20 ~/.claudish/eventloop-blocked.log
```

L'histogramme de trafic cité (22 775 requêtes, 08:00Z→16:57:49Z, buckets 15 min)
provient de l'outil MCP `claudish_traffic` appelé à 16:57:49Z, **90 secondes avant**
la rotation du corpus — il n'est plus rejouable ; ce document en est la copie.
