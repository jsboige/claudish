#!/usr/bin/env python3
"""#712 Kimi canary, part 6 — THE missing discriminant.

#360's claim is not "Kimi cannot call tools" — my parts 1-5 show it calls
built-ins (Grep/Read/Edit) correctly and converges. The claim is "Kimi never
selects an MCP tool". Parts 3-4 never gave it a task that REQUIRED one, so
their "correct tool choice" results prove nothing about MCP preference.

This part gives two tasks where only an MCP tool can answer, in the exact wire
shape Claude Code uses (mcp__server__tool names), with all built-ins still
available — the escape hatch #360's R3 measured (Grep/Bash instead of MCP)
stays open. Nothing is armed.
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
TARGET_CHARS = int(os.environ.get("CANARY_FILLER_CHARS", "280000"))

HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}

# CC-shaped tool list: built-ins (the escape hatch) + MCP tools under their
# real mcp__server__tool names, mixed in no privileged order.
TOOLS = [
    {"name": "Read", "description": "Read a file from the local filesystem.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}},
    {"name": "Edit", "description": "Exact string replacement in a file.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}, "required": ["file_path", "old_string", "new_string"]}},
    {"name": "Write", "description": "Write a file, overwriting it.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "content": {"type": "string"}}, "required": ["file_path", "content"]}},
    {"name": "Grep", "description": "Content search built on ripgrep.",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}},
    {"name": "Glob", "description": "Fast file pattern matching.",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}},
    {"name": "Bash", "description": "Run a shell command.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}, "description": {"type": "string"}}, "required": ["command"]}},
    {"name": "mcp__searxng__searxng_web_search", "description": "Perform a web search using the SearXNG API. Use this for broad information gathering, recent events, or when you need diverse web sources.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}, "language": {"type": "string"}}, "required": ["query"]}},
    {"name": "mcp__searxng__web_url_read", "description": "Read the content from an URL.",
     "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "mcp__roo-state-manager__roosync_inventory", "description": "Machine inventory, heartbeat status, system snapshot, cluster health of the fleet.",
     "input_schema": {"type": "object", "properties": {"type": {"type": "string"}, "machineId": {"type": "string"}, "format": {"type": "string"}}, "required": ["type"]}},
    {"name": "mcp__roo-state-manager__roosync_dashboard", "description": "Read or write the shared team dashboards (global, machine, workspace).",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string"}, "type": {"type": "string"}, "section": {"type": "string"}}, "required": ["action", "type"]}},
    {"name": "mcp__roo-state-manager__roosync_messages", "description": "Inter-machine messaging: read the inbox, send messages between machines.",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string"}, "status": {"type": "string"}}, "required": ["action"]}},
    {"name": "mcp__roo-state-manager__conversation_browser", "description": "Navigate, visualize and summarize past conversations across the cluster.",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string"}, "limit": {"type": "number"}}, "required": ["action"]}},
]

FILLER_UNIT = ("Regle de travail : lire le corps complet avant toute action, preferer une action "
               "reversible, rendre compte sur le dashboard du workspace. ")
SYSTEM = ("Tu es un agent operations d'une flotte de machines. Tu disposes d'outils : des outils "
          "locaux (Read, Grep, Bash...) et des outils MCP de coordination de flotte "
          "(mcp__roo-state-manager__*, mcp__searxng__*). Choisis l'outil le plus direct pour "
          "la tache.\n\n" + FILLER_UNIT * max(1, TARGET_CHARS // len(FILLER_UNIT)))

TASKS = [
    # Only a fleet MCP tool can answer — no local file knows heartbeat status.
    ("I-mcp-fleet-state",
     "Quel est l'etat (heartbeat, statut) de la machine myia-po-2025 dans le parc ? "
     "Interroge le parc, ne devine pas."),
    # Only a web MCP tool answers cleanly; Bash+curl remains a legitimate-but-
    # telltale escape hatch, and a no-tool answer is the failure mode.
    ("J-mcp-web-search",
     "Quelle est la toute derniere version stable publiee de Node.js ? Cherche sur le web "
     "pour repondre, ne devine pas."),
]


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


out = {"model": MODEL, "system_chars": len(SYSTEM), "tools": len(TOOLS), "cases": []}
for label, task in TASKS:
    r = post({"model": MODEL, "max_tokens": 1024, "stream": False, "system": SYSTEM,
              "tools": TOOLS, "messages": [{"role": "user", "content": task}]})
    doc = r.get("doc") or {}
    u = doc.get("usage") or {}
    blocks = doc.get("content") or []
    calls = [{"name": b.get("name"), "input": b.get("input")} for b in blocks
             if isinstance(b, dict) and b.get("type") == "tool_use"]
    text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    out["cases"].append({
        "case": label,
        "task": task[:80],
        "status": r["status"], "elapsed_s": r["elapsed"],
        "stop_reason": doc.get("stop_reason"),
        "tool_calls": calls,
        "picked_mcp_tool": any(str(c.get("name", "")).startswith("mcp__") for c in calls),
        "picked_builtin": [c.get("name") for c in calls if not str(c.get("name", "")).startswith("mcp__")],
        "no_tool_at_all": not calls,
        "text_head": text[:200],
        "prompt": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
        "output": u.get("output_tokens"),
        "thinking": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
        "raw": r.get("raw") if not doc else None,
    })

print(json.dumps(out, indent=2, ensure_ascii=False))
