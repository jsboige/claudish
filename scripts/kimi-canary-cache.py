#!/usr/bin/env python3
"""#712 Kimi canary, part 2 — does the coding plan CACHE anything?

A Claude Code turn sends 100-200k prompt tokens (#700: p50 = 163.3k). On a
caching provider the re-paid window is billed at the cache rate; on a
non-caching one every turn pays the full input price. That is the difference
between "uses the plan" and "burns the plan". Measured, nothing armed.
"""
import json
import os
import time
import urllib.request
import urllib.error

URL = os.environ.get("CANARY_URL", "http://127.0.0.1:3000/v1/messages")
KEY = os.environ["PROXY_KEY"]
MODEL = os.environ.get("CANARY_MODEL", "kc@k3.1-pro")
TIMEOUT = float(os.environ.get("CANARY_TIMEOUT", "90"))

HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}

# ~40k chars of stable, low-entropy filler => a realistic re-paid window.
# Repeated text compresses badly for the model but is exactly what we want to
# measure: a stable prefix that a cache could hold.
FILLER = ("Section de contexte stable. Le proxy relaie les requetes vers le hub. "
          "Chaque tour repaie la fenetre de contexte du harnais. ") * 330
SYSTEM = "Tu es un assistant de test. Reponds en une phrase courte.\n\n" + FILLER


def post(payload):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=HEADERS, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            doc = json.loads(r.read().decode("utf-8", "replace"))
            return {"status": r.status, "elapsed": round(time.time() - t0, 2), "doc": doc}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "elapsed": round(time.time() - t0, 2),
                "doc": None, "raw": e.read()[:300].decode("utf-8", "replace")}
    except Exception as e:
        return {"status": None, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": f"{type(e).__name__}: {e}"}


def row(label, r):
    u = (r.get("doc") or {}).get("usage") or {}
    blocks = (r.get("doc") or {}).get("content") or []
    return {
        "case": label,
        "status": r["status"],
        "elapsed_s": r["elapsed"],
        "prompt_uncached": u.get("input_tokens"),
        "cache_creation": u.get("cache_creation_input_tokens"),
        "cache_read": u.get("cache_read_input_tokens"),
        "output": u.get("output_tokens"),
        "thinking": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
        "block_types": [b.get("type") for b in blocks if isinstance(b, dict)],
        "raw": r.get("raw"),
    }


msgs = [{"role": "user", "content": "Quelle est la premiere phrase du contexte ?"}]

out = []
# 1 — cold: does the provider even report a cache write?
r1 = post({"model": MODEL, "max_tokens": 256, "stream": False, "system": SYSTEM, "messages": msgs})
out.append(row("1-cold", r1))

# 2 — identical prefix, immediately after: the cache-read opportunity
r2 = post({"model": MODEL, "max_tokens": 256, "stream": False, "system": SYSTEM, "messages": msgs})
out.append(row("2-same-prefix", r2))

# 3 — prefix + one more user turn (what a real second turn looks like)
r3 = post({"model": MODEL, "max_tokens": 256, "stream": False, "system": SYSTEM,
           "messages": msgs + [{"role": "assistant", "content": "Section de contexte stable."},
                               {"role": "user", "content": "Et la deuxieme ?"}]})
out.append(row("3-next-turn", r3))

print(json.dumps({"model": MODEL, "system_chars": len(SYSTEM), "results": out}, indent=2, ensure_ascii=False))
