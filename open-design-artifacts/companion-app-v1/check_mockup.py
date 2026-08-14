#!/usr/bin/env python3
"""Deterministic validation for Raindesk mockup v1 (index.html).
Checks: parseable HTML, the four phone screens with their required
spec elements, self-containment (no external src/href), and live
server bytes == disk bytes. Exit 0 prints RAINDESK_MOCKUP_V1_OK.
"""
import html.parser
import re
import sys
import urllib.request

PATH = "/home/benbi/lab/creative/after-the-last-rain/open-design-artifacts/companion-app-v1/index.html"
URL = "http://127.0.0.1:17590/index.html"

disk = open(PATH, encoding="utf-8").read()

class Check(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []
        self.ids = set()
        self.external = []
        self.void = {"meta","br","img","input","hr","link","line","path","circle","rect","ellipse"}
    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if "data-od-id" in d:
            self.ids.add(d["data-od-id"])
        if tag not in self.void:
            self.stack.append(tag)
        for k, v in attrs:
            if k in ("src", "href") and v and not v.startswith(("#", "data:")):
                self.external.append((k, v))
    def handle_endtag(self, tag):
        if tag in self.void:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"mismatched close: {tag} (stack top: {self.stack[-1] if self.stack else 'EMPTY'})")
        else:
            self.stack.pop()

c = Check()
c.feed(disk)
assert not c.errors, f"HTML structural errors: {c.errors[:3]}"
assert not c.stack, f"unclosed tags: {c.stack}"
assert not c.external, f"external resources found: {c.external[:3]}"

required_screens = {
    "screen-page": ["drawer-handle", "tool", "genbar", "gen-btn"],
    "screen-drawer": ["drawer-panel", "dtab", "bubble agent", "bubble user", "composer"],
    "screen-generate": ["overlay-patch", "commit-btn", "x-btn", "sel"],
    "screen-layers": ["penpop", "layer", "lanes", "lane hot"],
}
for screen, needles in required_screens.items():
    assert screen in c.ids, f"missing data-od-id: {screen}"
for needle in [n for v in required_screens.values() for n in v]:
    assert needle in disk or f'class="{needle}"' in disk or f" {needle}" in disk, f"missing element: {needle}"

assert "COMMIT" in disk and "⟳" in disk, "commit/loop semantics missing"

live = urllib.request.urlopen(URL, timeout=5).read()
assert live == disk.encode("utf-8"), "served bytes differ from disk"

print("RAINDESK_MOCKUP_V1_OK: 4 screens, structural pass, self-contained, live==disk,", len(disk), "bytes")
sys.exit(0)
