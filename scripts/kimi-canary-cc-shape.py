#!/usr/bin/env python3
"""#712 Kimi canary, part 3 — the shape Claude Code actually sends.

#360 was measured in a real CC session (0% tool calls, 229 empty shell loops).
Parts 1 and 2 refute the API-level version of that: one inline tool is called
correctly, and the prefix caches. The remaining discriminants are the ones a
trivial canary cannot see: MANY tools with real schemas, a full-size window,
and the latency that shape costs.

Nothing is armed. One request per case; the cold one is the only full-price turn.
"""
import json
import os
import time
import urllib.request
import urllib.error

URL = os.environ.get("CANARY_URL", "http://127.0.0.1:3000/v1/messages")
KEY = os.environ["PROXY_KEY"]
MODEL = os.environ.get("CANARY_MODEL", "kc@k3.1-pro")
TIMEOUT = float(os.environ.get("CANARY_TIMEOUT", "300"))
TARGET_CHARS = int(os.environ.get("CANARY_FILLER_CHARS", "560000"))  # ~140k tokens at 4 chars/tok

HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}

MCP_NAMES = [
    ("Read", "Read a file from the local filesystem.", {"file_path": {"type": "string"}, "offset": {"type": "number"}, "limit": {"type": "number"}}, ["file_path"]),
    ("Edit", "Exact string replacement in a file.", {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}, ["file_path", "old_string", "new_string"]),
    ("Write", "Write a file, overwriting it.", {"file_path": {"type": "string"}, "content": {"type": "string"}}, ["file_path", "content"]),
    ("Grep", "Content search built on ripgrep.", {"pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"}, "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]}}, ["pattern"]),
    ("Glob", "Fast file pattern matching.", {"pattern": {"type": "string"}, "path": {"type": "string"}}, ["pattern"]),
    ("Bash", "Run a shell command.", {"command": {"type": "string"}, "description": {"type": "string"}, "timeout": {"type": "number"}}, ["command"]),
    ("roosync_dashboard", "Shared team dashboard read/write.", {"action": {"type": "string"}, "type": {"type": "string"}, "content": {"type": "string"}, "section": {"type": "string"}}, ["action"]),
    ("roosync_messages", "Inter-machine messaging.", {"action": {"type": "string"}, "to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["action"]),
    ("roosync_inventory", "Machine inventory and health.", {"type": {"type": "string"}, "machineId": {"type": "string"}, "format": {"type": "string"}}, ["type"]),
    ("codebase_search", "Semantic search in code by concept.", {"query": {"type": "string"}, "workspace": {"type": "string"}, "limit": {"type": "number"}}, ["query", "workspace"]),
    ("conversation_browser", "Navigate and summarize conversations.", {"action": {"type": "string"}, "task_id": {"type": "string"}, "limit": {"type": "number"}}, ["action"]),
    ("searxng_web_search", "Web search via SearXNG.", {"query": {"type": "string"}, "language": {"type": "string"}, "pageno": {"type": "number"}}, ["query"]),
    ("web_url_read", "Read the content of a URL.", {"url": {"type": "string"}}, ["url"]),
    ("browser_navigate", "Navigate a browser tab.", {"url": {"type": "string"}}, ["url"]),
    ("browser_snapshot", "Accessibility snapshot of the page.", {"target": {"type": "string"}, "depth": {"type": "number"}}, []),
    ("browser_click", "Click an element on the page.", {"target": {"type": "string"}, "element": {"type": "string"}}, ["target"]),
    ("call_agent", "Send a prompt to an AI agent.", {"prompt": {"type": "string"}, "agent": {"type": "string"}, "attachment": {"type": "string"}}, ["prompt"]),
    ("TodoWrite", "Update the task list.", {"todos": {"type": "array", "items": {"type": "object"}}}, ["todos"]),
    ("NotebookEdit", "Edit a Jupyter notebook cell.", {"notebook_path": {"type": "string"}, "cell_id": {"type": "string"}, "new_source": {"type": "string"}}, ["notebook_path"]),
    ("WebFetch", "Fetch a URL and extract content.", {"url": {"type": "string"}, "prompt": {"type": "string"}}, ["url", "prompt"]),
]

TOOLS = [
    {"name": n, "description": d,
     "input_schema": {"type": "object", "properties": p, "required": r}}
    for n, d, p, r in MCP_NAMES
]

FILLER_UNIT = ("Regle de travail : lire le corps complet avant toute action, ne jamais armer "
               "une cascade pendant un mur, preferer une action reversible. ")
FILLER = FILLER_UNIT * max(1, TARGET_CHARS // len(FILLER_UNIT))
SYSTEM = ("Tu es un agent de developpement. Tu disposes d'outils. Tu dois appeler un outil "
          "avant de repondre quand la tache l'exige.\n\n" + FILLER)


def post(payload, stream=False):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=HEADERS, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
            el = round(time.time() - t0, 2)
            if stream:
                return {"status": r.status, "elapsed": el, "raw": raw.decode("utf-8", "replace")}
            return {"status": r.status, "elapsed": el, "doc": json.loads(raw.decode("utf-8", "replace"))}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "elapsed": round(time.time() - t0, 2),
                "doc": None, "raw": e.read()[:400].decode("utf-8", "replace")}
    except Exception as e:
        return {"status": None, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": f"{type(e).__name__}: {e}"}


TASK = ("Trouve ou est definie la fonction resolveFailoverTarget dans le depot, puis lis le "
        "fichier correspondant. Utilise les outils. Commence par une recherche.")

out = {"model": MODEL, "system_chars": len(SYSTEM), "tools": len(TOOLS), "cases": []}

# E — full CC shape, non-streaming: does it emit tool_use with 20 tools + a full window?
r = post({"model": MODEL, "max_tokens": 1024, "stream": False, "system": SYSTEM,
          "tools": TOOLS, "messages": [{"role": "user", "content": TASK}]})
doc = r.get("doc") or {}
u = doc.get("usage") or {}
blocks = doc.get("content") or []
out["cases"].append({
    "case": "E-cc-shape-20tools",
    "status": r["status"], "elapsed_s": r["elapsed"],
    "stop_reason": doc.get("stop_reason"),
    "prompt": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
    "uncached": u.get("input_tokens"), "cache_read": u.get("cache_read_input_tokens"),
    "output": u.get("output_tokens"),
    "thinking": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
    "block_types": [b.get("type") for b in blocks if isinstance(b, dict)],
    "tool_use": [{"name": b.get("name"), "input": b.get("input")} for b in blocks
                 if isinstance(b, dict) and b.get("type") == "tool_use"],
    "raw": r.get("raw") if doc == {} else None,
})

# F — same shape streamed: TTFT and SSE integrity at full window
r2 = post({"model": MODEL, "max_tokens": 512, "stream": True, "system": SYSTEM,
           "tools": TOOLS, "messages": [{"role": "user", "content": TASK}]}, stream=True)
txt = r2.get("raw") or ""
out["cases"].append({
    "case": "F-cc-shape-stream",
    "status": r2["status"], "elapsed_s": r2["elapsed"],
    "has_message_start": "event:message_start" in txt or "event: message_start" in txt,
    "has_message_stop": "event:message_stop" in txt or "event: message_stop" in txt,
    "message_delta_count": txt.count("event:message_delta"),
    "tool_use_blocks": txt.count('"type":"tool_use"'),
    "raw_head": txt[:200] if r2["status"] != 200 else None,
})

print(json.dumps(out, indent=2, ensure_ascii=False))
