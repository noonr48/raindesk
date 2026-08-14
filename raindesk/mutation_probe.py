#!/usr/bin/env python3
"""Mutation probe: does the reversed-point lasso test pin coordinate identity?

Applies a count-only-identity mutation to canvas.js beginTakeSession, runs the
reversed-point test, expects FAILURE (proving the test discriminates), then
reverts via git. Prints the verdict.
"""
import subprocess
import sys

P = "public/js/canvas.js"
ORIG = (
    "const samePts = !!s && pts.length === s.lassoPoints.length &&\n"
    "        pts.every((p, i) => p.x === s.lassoPoints[i].x && p.y === s.lassoPoints[i].y);"
)
MUT = "const samePts = !!s && pts.length === s.lassoPoints.length; // MUTATION: count-only"

src = open(P).read()
assert ORIG in src, "mutation target not found in canvas.js"
open(P, "w").write(src.replace(ORIG, MUT))
print("MUTATION_APPLIED")

r = subprocess.run(
    ["node", "--test", "--test-name-pattern", "reversed-point", "tests/frontend/canvas.test.js"],
    capture_output=True, text=True, timeout=120,
)
tail = "\n".join(
    line for line in r.stdout.splitlines()
    if line.startswith(("ℹ tests", "ℹ pass", "ℹ fail"))
)
print("MUTATED_RUN:", tail.replace("ℹ ", ""))
subprocess.run(["git", "checkout", "--", P], check=True)
print("MUTATION_REVERTED")

fails = int(next((l.split()[-1] for l in r.stdout.splitlines() if l.startswith("ℹ fail")), "0"))
print("DISCRIMINATOR:", "PROVEN (test fails under count-only mutation)" if fails >= 1 else "WEAK (test passes under mutation — does not pin the fix)")
sys.exit(0 if fails >= 1 else 1)
