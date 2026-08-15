#!/usr/bin/env python3
"""Kill-proof for the deskfit tripwire: remove the anchoring mechanism,
expect the tripwire to FAIL, restore, expect green. Prints the verdict."""
import subprocess
import sys

CSS = "public/css/app.css"
MARK = "--art-x"  # first anchored rule marker

src = open(CSS).read()
assert MARK in src, "anchor marker not found"
# kill: strip the anchored-desktop rule block that uses --art-x (first occurrence line)
lines = src.splitlines(keepends=True)
kept, removed = [], False
for ln in lines:
    if not removed and MARK in ln and ln.lstrip().startswith("."):
        removed = True
        continue  # drop this one rule line entirely
    kept.append(ln)
mutated = "".join(kept)
assert mutated != src, "mutation did not apply"
open(CSS, "w").write(mutated)
print("KILL_APPLIED (one --art-x rule removed):", removed)


def run_tests():
    r = subprocess.run(
        ["node", "--test", "tests/frontend/deskfit.test.js"],
        capture_output=True, text=True, timeout=120,
    )
    fails = next((int(l.split()[-1]) for l in r.stdout.splitlines() if l.startswith("ℹ fail")), -1)
    return fails


fails = run_tests()
subprocess.run(["git", "checkout", "--", CSS], check=True)
print("KILL_RUN fail count:", fails)
print("RESTORED (git checkout)")
back = run_tests()
print("RESTORED_RUN fail count:", back)
ok = fails >= 1 and back == 0
print("TRIPWIRE_KILL_PROOF:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
