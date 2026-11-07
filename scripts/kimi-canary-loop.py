#!/usr/bin/env python3
"""#712 Kimi canary, part 4 — the long loop, which is what #360 actually measured.

#360's signature was not "one tool call fails": it was 229 empty shell commands in
one session, i.e. a LOOP that keeps emitting tool_use without converging. A
one-turn canary cannot see that. This drives 6 sequential turns, feeding a
plausible tool_result each time, and flags degenerate repetition instead of
scoring the prose.

Nothing is armed.
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
TURNS = int(os.environ.get("CANARY_TURNS", "6"))

HEADERS = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "x-claudish-machine": "myia-po-2025",
}

TOOLS = [
    {"name": "Grep", "description": "Content search built on ripgrep.",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}, "output_mode": {"type": "string"}}, "required": ["pattern"]}},
    {"name": "Read", "description": "Read a file from the local filesystem.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}},
    {"name": "Bash", "description": "Run a shell command.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}, "description": {"type": "string"}}, "required": ["command"]}},
    {"name": "Edit", "description": "Exact string replacement in a file.",
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}, "required": ["file_path", "old_string", "new_string"]}},
]

FILLER_UNIT = ("Regle de travail : lire le corps complet avant toute action, ne jamais armer "
               "une cascade pendant un mur, preferer une action reversible. ")
SYSTEM = ("Tu es un agent de developpement autonome. Tu disposes d'outils et tu dois les "
          "enchainer jusqu'a avoir termine la tache, puis repondre.\n\n" + FILLER_UNIT * 12000)

TASK = ("Dans le depot, trouve la fonction resolveFailoverTarget, lis le fichier qui la "
        "definit, puis ajoute une ligne de commentaire au-dessus de la fonction. "
        "Enchaine les outils necessaires.")

# Canned tool results, keyed by the tool the model picks. Plausible, so the loop
# can actually terminate if the model is capable of terminating.
RESULTS = {
    "Grep": "packages/cli/src/fork/failover.ts:142:export function resolveFailoverTarget(role: Role)",
    "Read": "142: export function resolveFailoverTarget(role: Role) {\n143:   return state.roles[role]?.resolved ?? null;\n144: }",
    "Edit": "Edit applied: 1 replacement in packages/cli/src/fork/failover.ts",
}
DEFAULT_RESULT = "(no output)"


def post(payload):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=HEADERS, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return {"status": r.status, "elapsed": round(time.time() - t0, 2),
                    "doc": json.loads(r.read().decode("utf-8", "replace"))}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": e.read()[:300].decode("utf-8", "replace")}
    except Exception as e:
        return {"status": None, "elapsed": round(time.time() - t0, 2), "doc": None,
                "raw": f"{type(e).__name__}: {e}"}


messages = [{"role": "user", "content": TASK}]
turns = []
fed = 0

for i in range(TURNS):
    r = post({"model": MODEL, "max_tokens": 1024, "stream": False, "system": SYSTEM,
              "tools": TOOLS, "messages": messages})
    doc = r.get("doc") or {}
    u = doc.get("usage") or {}
    blocks = doc.get("content") or []
    tool_blocks = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use"]
    text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    entry = {
        "turn": i + 1,
        "status": r["status"],
        "elapsed_s": r["elapsed"],
        "stop_reason": doc.get("stop_reason"),
        "prompt": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
        "uncached": u.get("input_tokens"),
        "cache_read": u.get("cache_read_input_tokens"),
        "output": u.get("output_tokens"),
        "thinking": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
        "tool_calls": [{"name": b.get("name"), "input": b.get("input")} for b in tool_blocks],
        "text_head": text[:160],
    }
    turns.append(entry)

    if not tool_blocks:
        break  # converged on a final answer

    # Degenerate-loop detector: an empty shell command, or the exact same call
    # twice in a row, is the #360 signature.
    call = tool_blocks[0]
    if call.get("name") == "Bash" and not (call.get("input") or {}).get("command", "").strip():
        entry["DEGENERATE"] = "empty bash command"
    if i > 0 and turns[i - 1]["tool_calls"] and turns[i - 1]["tool_calls"][0] == entry["tool_calls"][0]:
        entry["DEGENERATE"] = "identical repeat of previous call"

    messages.append({"role": "assistant", "content": blocks})
    content = []
    for b in tool_blocks:
        content.append({"type": "tool_result", "tool_use_id": b.get("id"),
                        "content": RESULTS.get(b.get("name"), DEFAULT_RESULT)})
        fed += 1
    messages.append({"role": "user", "content": content})

print(json.dumps({
    "model": MODEL,
    "turns": turns,
    "tool_results_fed": fed,
    "converged": not turns[-1]["tool_calls"],
    "degenerate_turns": [t["turn"] for t in turns if t.get("DEGENERATE")],
    "total_output": sum(t["output"] or 0 for t in turns),
    "total_thinking": sum(t["thinking"] or 0 for t in turns),
    "wall_s": round(sum(t["elapsed_s"] for t in turns), 2),
}, indent=2, ensure_ascii=False))
