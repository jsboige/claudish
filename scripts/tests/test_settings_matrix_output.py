#!/usr/bin/env python3
"""Each display label appears once, with missing-label coverage retained (#445)."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile

TARGET = Path(__file__).resolve().parents[1] / "settings-matrix.py"
spec = importlib.util.spec_from_file_location("matrix_output", TARGET)
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


def test_main_prints_labels_once_and_keeps_other_fields_and_blind_spots():
    labels = {key: "label-value" for key in matrix.LABEL_KEYS[:-1]}
    ordinary = "env.ANTHROPIC_DEFAULT_HAIKU_MODEL"
    snapshot = {"format": 1, "state": "ok", "collectedAt": "2026-11-13T00:00:00Z",
                "harmonization": {**labels, ordinary: "claude-haiku-5-5[1m]"},
                "maskedEnvKeys": {}, "otherTopLevelKeys": []}
    with tempfile.TemporaryDirectory() as root:
        folder = Path(root) / "configs" / "myia-po-2028" / "v1-fixture" / "claude-settings"
        folder.mkdir(parents=True)
        (folder / "claude-settings.json").write_text(json.dumps(snapshot), encoding="utf-8")
        previous = sys.argv
        stream = io.StringIO()
        try:
            sys.argv = [str(TARGET), "--shared", root, "myia-po-2028"]
            with contextlib.redirect_stdout(stream):
                matrix.main()
        finally:
            sys.argv = previous
    output = stream.getvalue().splitlines()
    for key in labels:
        assert sum(line.startswith("  " + key + " = ") for line in output) == 1, key
    assert sum(line.startswith("  " + ordinary + " = ") for line in output) == 1
    missing = matrix.LABEL_KEYS[-1]
    assert "  " + missing + ": not published (collector blind spot)" in output
    assert "=== flags" in output


if __name__ == "__main__":
    test_main_prints_labels_once_and_keeps_other_fields_and_blind_spots()
    print("PASS label inventory: once, with coverage")
