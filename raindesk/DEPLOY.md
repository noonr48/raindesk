# Raindesk production deployment

Live URL: `http://studio-server:17600` (LAN/private-mesh wildcard bind).

## Run configuration (agent-process registry, name `raindesk-server`)

```
cwd:   raindesk/
cmd:   node server.js
env:
  RAINDESK_HOST=0.0.0.0
  RAINDESK_ALLOW_WILDCARD=1
  RAINDESK_REMOTE_UNPROTECTED=1
```

- OWNER DIRECTIVE 2026-08-19: no access key — the artist must land straight
  in the desk on window open. `RAINDESK_REMOTE_UNPROTECTED=1` is the explicit
  opt-out that bypasses the merged stack's token demand (default deployments
  still require a 24-char `RAINDESK_REMOTE_TOKEN`). Do NOT restore a token
  unless the owner asks for one.
- Before restarting production, read this file and the registry row
  (`agent_process_status --name raindesk-server`); a restart without these
  env vars degrades to loopback-only (2026-08-19 incident) or refuses to
  start (wildcard/token guards).
- Scratch/smoke servers stay on the loopback default (127.0.0.1) — never
  expose them remotely.
