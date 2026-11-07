#!/usr/bin/env python3
"""#712 Kimi canary, part 5 — cache_control, the one wire shape a raw canary
had not exercised. Claude Code marks breakpoints with
cache_control:{"type":"ephemeral"} on system and message blocks. If the Kimi
coding plan rejected or mishandled them, a real CC session would degrade in a
way none of parts 1-4 can see. Two requests, nothing armed.
"""
import json
import os
import time
import urllib.request
import urllib.error

URL = os.environ.get("CANARY_URL", "http://127.0.0.1:3000/v1/messages")
KEY = os.environ["PROXY_KEY"]
MODEL = os.environ.get("CANARY_MODEL", "kc@k3.1-pro")
TIMEOUT = float(os.environ.get("CANARY_TIMEOUT", "180"))

HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}

FILLER_UNIT = ("Regle de travail : lire le corps complet avant toute action, ne jamais armer "
               "une cascade pendant un mur, preferer une action reversible. ")
SYSTEM_TEXT = ("Tu es un agent de test. Reponds en une phrase courte.\n\n" + FILLER_UNIT * 3000)


def post(payload):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=HEADERS, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return {"status": r.status, "elapsed": round(time.time() - t0, 2),
                    "doc": json.loads(r.read().decode("utf-8", "replace"))}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": e.read()[:400].decode("utf-8", "replace")}
    except Exception as e:
        return {"status": None, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": f"{type(e).__name__}: {e}"}


def row(label, r):
    doc = r.get("doc") or {}
    u = doc.get("usage") or {}
    blocks = doc.get("content") or []
    return {
        "case": label, "status": r["status"], "elapsed_s": r["elapsed"],
        "stop_reason": doc.get("stop_reason"),
        "prompt": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
        "uncached": u.get("input_tokens"),
        "cache_creation": u.get("cache_creation_input_tokens"),
        "cache_read": u.get("cache_read_input_tokens"),
        "output": u.get("output_tokens"),
        "block_types": [b.get("type") for b in blocks if isinstance(b, dict)],
        "raw": r.get("raw") if not doc else None,
    }


out = {"model": MODEL}

# G — CC-shaped system: an ARRAY of blocks carrying cache_control breakpoints
system_cc = [{"type": "text", "text": SYSTEM_TEXT, "cache_control": {"type": "ephemeral"}}]
msgs_cc = [{"role": "user", "content": [
    {"type": "text", "text": "Quelle est la premiere phrase du contexte ?",
     "cache_control": {"type": "ephemeral"}},
]}]
out["g_cold"] = row("G-cold-cache_control", post({
    "model": MODEL, "max_tokens": 256, "stream": False,
    "system": system_cc, "messages": msgs_cc,
}))
out["h_warm"] = row("H-warm-cache_control", post({
    "model": MODEL, "max_tokens": 256, "stream": False,
    "system": system_cc, "messages": msgs_cc,
}))

print(json.dumps(out, indent=2, ensure_ascii=False))
