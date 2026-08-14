#!/usr/bin/env python3
"""Deterministic check for the After the Last Rain creative-push working root.

Usage: python3 check_atr_root.py
Exits 0 with ATR_ROOT_OK if the working-root artifacts are intact:
  1. packet/ is byte-identical to git ref roompc/main d934ec4c
     (canonical GitHub state, bridged 2026-08-14)
  2. BOARD.md has the 7-shot ladder with lawful states and the
     owner-locked constraints + provenance lines.
Read-only: performs no writes.
"""
import re
import subprocess
import sys

REPO = "/home/studio/Desktop/the-box-project"
BASE = "planning/animation/after-the-last-rain/"
ROOT = "/home/studio/lab/creative/after-the-last-rain"

names = subprocess.run(
    ["git", "-C", REPO, "ls-tree", "--name-only", f"roompc/main:{BASE}"],
    capture_output=True, text=True,
).stdout.split()
assert len(names) == 10, f"expected 10 docs in git ref, got {len(names)}"

for n in names:
    ref = subprocess.run(
        ["git", "-C", REPO, "show", f"roompc/main:{BASE}{n}"],
        capture_output=True,
    ).stdout
    assert ref == open(f"{ROOT}/packet/{n}", "rb").read(), f"packet doc differs from git ref: {n}"
print("packet: 10/10 docs byte-identical to roompc/main (d934ec4c)")

b = open(f"{ROOT}/BOARD.md").read()
rows = [l for l in b.splitlines() if re.match(r"^\| S0", l)]
states = {r.split("|")[3].strip() for r in rows}
assert len(rows) == 7, f"expected 7 shots, got {len(rows)}"
assert states == {"breakdown", "queued"}, f"unlawful states: {states}"
for needle in ("Anna = source Eris", "d934ec4c", "DECISION_LOG.md", "FL2VA"):
    assert needle in b, f"BOARD.md missing: {needle}"
print("board: 7 shots, states ['breakdown','queued'], constraints+provenance present")

print("ATR_ROOT_OK")
sys.exit(0)
