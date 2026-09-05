# Raindesk production deployment (template)

Bind the desk on your own trusted host: `http://<your-host>:17600`
(LAN/mesh wildcard bind).

## Run configuration

```
cwd:   raindesk/
cmd:   node server.js
env:
  RAINDESK_HOST=0.0.0.0
  RAINDESK_ALLOW_WILDCARD=1
  RAINDESK_REMOTE_TOKEN=<24+ char secret>   # default: key-protected
  # OR the keyless mode (trusted networks only — anyone on the network
  # reaches the desk with no key):
  RAINDESK_REMOTE_UNPROTECTED=1
  # Where the artist's data lives (default: ./data next to the app). The
  # owner's real data lives OUTSIDE this tree — point at it explicitly:
  RAINDESK_DATA_DIR=/absolute/path/to/data
  # Animatic execution (CPU; no GPU): without all three the animatic
  # "Preview this" path is fail-closed (planning_only), see
  # lib/production-adapters.js configuredAnimaticRuntime.
  RAINDESK_ANIMATIC_EXECUTOR=/absolute/path/to/animatic-executor   # #!/bin/sh wrapper: exec python3 '<creative-contracts>/tools/animatic_compile.py' "$@"
  RAINDESK_ANIMATIC_PROJECT_ROOT=/absolute/writable/dir
  RAINDESK_SOURCE_RIGHTS="<explicit rights assertion that travels with every snapshot>"
```

- The server refuses remote binds without a long token, and wildcards without
  an explicit opt-in (`server-core.js validateBindOptions`). Choose the mode
  that matches your network's trust level; the default is token-protected.
  In addition, every `/api/` request (reads included) is checked against a
  Host allowlist derived from the bound interface — this is DNS-rebinding
  defense. Access by hostname (DNS/mDNS/hosts-file alias) requires declaring
  it:

```
  RAINDESK_ALLOWED_HOSTS=desk.local,studio.lan   # comma-separated extra hostnames
```

- Keyless mode is for carefully trusted private networks only — it is NOT the
  normal production posture; prefer a token.
- A restart without these env vars degrades to loopback-only (2026-08
  incident postmortem: a post-merge restart silently rebound 127.0.0.1,
  breaking remote access until re-deployed).
- Scratch/test servers stay on the loopback default (127.0.0.1) — never
  expose them remotely.
