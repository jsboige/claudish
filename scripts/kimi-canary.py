#!/usr/bin/env python3
"""#712 Kimi canary — two properties, measured, nothing armed.

P1 "fonctionne"   : liveness, SSE integrity, and the #360 discriminant (does it call tools?)
P2 "ne tire pas trop vite": prompt/output tokens per request, cache behaviour

Sent through the LOCAL hub with an explicit provider@model, so no cascade,
no defaultProvider and no wall can divert the request. The cluster key is read
from the container env by the caller and passed via PROXY_KEY; it is never printed.
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

BASE_HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}


def post(payload, stream=False):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(URL, data=data, headers=BASE_HEADERS, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read()
            el = time.time() - t0
            return {"status": r.status, "ct": r.headers.get("content-type", ""),
                    "body": body, "elapsed": round(el, 2), "error": None}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return {"status": e.code, "ct": e.headers.get("content-type", ""),
                "body": raw, "elapsed": round(time.time() - t0, 2), "error": f"HTTP {e.code}"}
    except Exception as e:  # timeout, connection reset, ...
        return {"status": None, "ct": "", "body": b"", "elapsed": round(time.time() - t0, 2),
                "error": f"{type(e).__name__}: {e}"}


def parse_json_body(b):
    try:
        return json.loads(b.decode("utf-8", "replace"))
    except Exception:
        return None


def summarize(label, res, stream_scan=False):
    out = {"case": label, "status": res["status"], "elapsed_s": res["elapsed"], "error": res["error"]}
    if stream_scan:
        text = res["body"].decode("utf-8", "replace")
        # The Anthropic wire emits "event:message_start" (no space) but accept the
        # spaced form too — an exact-match check on one spelling reads as a
        # missing event when the stream is fine.
        out["sse_lines"] = text.count("\n")
        out["has_message_start"] = "event:message_start" in text or "event: message_start" in text
        out["has_message_stop"] = "event:message_stop" in text or "event: message_stop" in text
        out["has_tool_use"] = '"type":"tool_use"' in text or '"type": "tool_use"' in text
        out["has_antml_tool_call"] = "antml:invoke" in text or "<tool_use>" in text
        usage = None
        for line in text.splitlines():
            if line.startswith("data:") and '"usage"' in line:
                try:
                    usage = json.loads(line[5:].strip()).get("usage", usage)
                except Exception:
                    pass
        out["usage"] = usage
        out["text_head"] = text[:300]
        return out
    doc = parse_json_body(res["body"])
    out["model"] = (doc or {}).get("model")
    out["stop_reason"] = (doc or {}).get("stop_reason")
    out["usage"] = (doc or {}).get("usage")
    blocks = (doc or {}).get("content") or []
    out["block_types"] = [b.get("type") for b in blocks if isinstance(b, dict)]
    out["text"] = "".join(b.get("text", "") for b in blocks if isinstance(b, dict))[:400]
    tools = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use"]
    out["tool_use"] = [{"name": t.get("name"), "input": t.get("input")} for t in tools]
    if doc is None:
        out["raw_head"] = res["body"][:400].decode("utf-8", "replace")
    return out


WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Return the current weather for a city.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}

results = []

# A — liveness, cheapest possible
results.append(summarize("A-liveness", post({
    "model": MODEL, "max_tokens": 32, "stream": False,
    "messages": [{"role": "user", "content": "Réponds uniquement: OK"}],
})))

# B — the #360 discriminant: a tool is declared and the answer requires it
rb = post({
    "model": MODEL, "max_tokens": 512, "stream": False, "tools": [WEATHER_TOOL],
    "messages": [{"role": "user", "content": "Quel temps fait-il à Paris ? Utilise l'outil get_weather."}],
})
results.append(summarize("B-tool-call", rb))

# C — multi-turn: feed back the tool_result, does it converge on a final answer?
doc_b = parse_json_body(rb["body"]) or {}
tool_blocks = [b for b in (doc_b.get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use"]
if tool_blocks:
    results.append(summarize("C-tool-result", post({
        "model": MODEL, "max_tokens": 512, "stream": False, "tools": [WEATHER_TOOL],
        "messages": [
            {"role": "user", "content": "Quel temps fait-il à Paris ? Utilise l'outil get_weather."},
            {"role": "assistant", "content": doc_b.get("content")},
            {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": tool_blocks[0].get("id"),
                "content": "18°C, ciel dégagé",
            }]},
        ],
    })))
else:
    results.append({"case": "C-tool-result", "skipped": "B returned no tool_use block"})

# D — streaming path (what an agent actually uses)
results.append(summarize("D-stream", post({
    "model": MODEL, "max_tokens": 64, "stream": True,
    "messages": [{"role": "user", "content": "Compte de 1 à 5, séparés par des virgules."}],
}), stream_scan=True))

print(json.dumps({"model": MODEL, "url": URL, "results": results}, indent=2, ensure_ascii=False))
