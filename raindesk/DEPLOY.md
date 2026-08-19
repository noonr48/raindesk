# Raindesk production deployment

Live URL: `http://studio-server:17600` (LAN/private-mesh wildcard bind).

## Run configuration (agent-process registry, name `raindesk-server`)

```
cwd:   raindesk/
cmd:   node server.js
env:
  RAINDESK_HOST=0.0.0.0
  RAINDESK_ALLOW_WILDCARD=1
  RAINDESK_REMOTE_TOKEN=<24+ char phrase key>
```

- The merged stack (server-core.js `validateBindOptions`) refuses remote
  binds without a token and wildcards without an explicit opt-in. The
  production token is a typeable phrase; owners receive it via Vault and
  enter it once per 12 hours in the unlock page (`/__unlock` → HttpOnly
  `raindesk_auth` cookie). Bearer `Authorization` also works for probes.
- Scratch/smoke servers stay on the loopback default (127.0.0.1) — no token
  needed there; never expose them remotely.
- Before restarting production, read this file and the registry row
  (`agent_process_status --name raindesk-server`); a restart without these
  env vars silently degrades to loopback (2026-08-19 incident: post-merge
  restart bound 127.0.0.1, breaking the owner URL until re-deployed).
