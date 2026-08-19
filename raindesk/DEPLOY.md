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
```

- The server refuses remote binds without a long token, and wildcards without
  the explicit opt-in (`server-core.js validateBindOptions`). Choose the mode
  that matches your network's trust level; the default is token-protected.
- A restart without these env vars degrades to loopback-only (2026-08
  incident postmortem: a post-merge restart silently rebound 127.0.0.1,
  breaking remote access until re-deployed).
- Scratch/test servers stay on the loopback default (127.0.0.1) — never
  expose them remotely.
