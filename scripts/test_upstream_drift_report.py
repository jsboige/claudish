"""Deterministic unit tests for scripts/upstream-drift-report.py (#897 P0).

No git, no network: zone_of() and the classification predicates are pure
functions of a path string. Run with any interpreter:
  python -I scripts/test_upstream_drift_report.py
Exit 0 = all assertions passed.
"""
from __future__ import annotations

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "upstream_drift_report", os.path.join(_HERE, "upstream-drift-report.py")
)
assert _spec and _spec.loader
udr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(udr)  # type: ignore[union-attr]

zone_of = udr.zone_of

CASES = [
    # (path, expected zone)
    ("packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts", "handlers/shared"),
    ("packages/cli/src/handlers/shared/format/openai-messages.ts", "handlers/shared"),
    ("packages/cli/src/handlers/composed-handler.ts", "handlers"),
    ("packages/cli/src/providers/transport/types.ts", "providers/transport"),
    ("packages/cli/src/providers/provider-profiles.ts", "providers"),
    ("packages/cli/src/providers/catalog-resolvers/openrouter.ts", "providers"),
    ("packages/cli/src/adapters/model-dialect.ts", "adapters"),
    ("packages/cli/src/channel/session-manager.ts", "channel"),
    ("packages/cli/src/middleware/gemini-thought-signature.ts", "middleware"),
    ("packages/cli/src/proxy-server.ts", "proxy-server"),
    ("packages/cli/src/mcp-server.ts", "mcp"),
    ("packages/cli/src/mcp-session/write-json-atomic.ts", "mcp"),
    ("packages/cli/src/team-orchestrator.ts", "team/tui"),
    ("packages/cli/src/tui/App.tsx", "team/tui"),
    ("packages/cli/src/config-command.ts", "config"),
    ("packages/cli/src/config-schema.ts", "config"),
    ("packages/cli/src/default-provider.ts", "config"),
    ("packages/cli/src/model-selector.ts", "config"),
    ("packages/cli/src/profile-config.ts", "config"),
    ("packages/cli/src/cli.ts", "cli/core"),
    ("packages/cli/src/index.ts", "cli/core"),
    ("packages/cli/src/types.ts", "cli/core"),
    ("packages/cli/bin/claudish.cjs", "cli/core"),
    ("package.json", "cli/core"),
    (".gitignore", "cli/core"),
    ("bunfig.toml", "cli/core"),
    ("scripts/upstream-drift-report.py", "scripts"),
    ("docs/reference/relay-internals.md", "docs"),
    ("docker-compose.yml", "compose/infra"),
    (".env.sidecar.example", "compose/infra"),
    ("packages/cli/src/fork/session-budget.ts", "fork"),
    ("packages/cli/src/team-timeout-repro.test.ts", "tests"),  # .test.ts -> tests (first-match)
]

failures = []
for path, expected in CASES:
    got = zone_of(path)
    if got != expected:
        failures.append(f"zone_of({path!r}) = {got!r}, expected {expected!r}")

# Every conflicting path from the real 2026-11-06 run must land in a NAMED zone
# (never the "other" fallback) — the claim unit for #897 must stay usable.
real_paths = [
    "packages/cli/src/channel/channel-wire-format.test.ts",
    "packages/cli/src/channel/session-manager.ts",
    "packages/cli/src/config-command.ts",
    "packages/cli/src/middleware/gemini-thought-signature.ts",
    "packages/cli/src/providers/catalog-resolvers/openrouter.ts",
    "packages/cli/src/providers/model-catalog-resolver.ts",
    "packages/cli/src/proxy-server.ts",
    "packages/cli/src/cli.ts",
    "packages/cli/src/tui/App.tsx",
]
for p in real_paths:
    if zone_of(p) == udr.ZONE_OTHER:
        failures.append(f"real conflict path {p!r} fell into ZONE_OTHER")

# Zones list must have unique names (a worker claims ONE zone by name).
names = [n for n, _ in udr.ZONES]
if len(names) != len(set(names)):
    failures.append("duplicate zone names in ZONES")

# First-match-wins ordering must be stable (deterministic classification).
if udr.ZONES[0][0] != "handlers/shared":
    failures.append("handlers/shared must be evaluated before handlers")

if failures:
    print("FAIL:")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print(f"OK: {len(CASES)} zone cases + {len(real_paths)} real paths + ordering invariants passed")
