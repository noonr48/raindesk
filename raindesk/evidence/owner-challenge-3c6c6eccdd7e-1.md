# Evidence — Owner Challenge 3c6c6eccdd7e-1 (default imagery)

Complaint (owner, 2026-08-15): "Currently i am not sure if I like the default images."
Challenge rung: replace the generic placeholder with story-specific generated imagery for S01.

## Surveyor verdicts (independent blind, VISUAL_VERIFIER_RESULT_V1 packets)

| take | sha256 | verdict | one-line |
|---|---|---|---|
| 5 (prompt-first T2I) | 91f88ce4… | off-script | cinematic lantern-boat scene; girl ABSENT, no dome/masts |
| 6 (prompt-first T2I) | 089c7879… | off-script | lighthouse waterscape; girl ABSENT, dome→lighthouse |
| 7 (sketch-first img2img 0.78) | b196a2a8… | PARTIAL | girl+hat+coat+lantern+rain readable; dome→moon, masts absent |
| 8 (bolder sketch, 0.72) | f3d8630e… | PARTIAL | girl+lamppost+rain; dome→moon-orb, ships→unreadable |

Conclusion: prompt-first T2I drops all scripted subjects (2/2 blind); sketch-first
img2img reliably keeps the largest silhouette but melts mid-size anchors into
light sources (2/2). Full anchor fidelity = ControlNet conditioning (v1.1
roadmap item), or owner taste accepts the register as-is.

## Commit + delivery

- take7 committed as provisional S01 base via live API: layer
  `1786814045787.png` (POST /api/shot/S01/layer, 2026-08-15T17:14:05Z),
  active on load. Generic placeholder retired.
- Owner taste delivery: vault msg `7a61439f-49dd-47b2-92b1-4d3bdc422183`
  (takes 7+8 attached; options: 1 / 2 / roll / controlnet). Verdict PENDING —
  taste is an owner-only sensor.

## Post-mutation spec wave (BLOCKED→repaired)

Blocker: live 17600 server (started 23:13:50 +0930) predated the checkpoint
swap commit 8324d00 (00:45:11) and require()-cached the pre-swap workflow
(lib/comfy.js) — any in-app GEN before a restart would have submitted
z-anime while README claimed Illustrious-XL (code-path reasoning; no
post-swap z-anime firing exists in surviving ComfyUI history — the process
was restarted before an in-app gen ran).

Repair: server restarted via agent-process registry (old pid 3520525
stopped; wrapper 684087, node listener 684095, started 03:29:55 +0930).
Proof: app's own /api/gen job (prompt "glowing brass lantern on a wet stone
wall") = ComfyUI history `c410ae95-99bf-4ca6-86bc-7c63ec38aa03`, status
success, ckpt_name `Illustrious-XL-v0.1.safetensors`, mirrored to same-origin
`/api/assets/S01/1786816847222-n4vv1m.png`. All z-anime history entries
predate the swap+restart (max output epoch 00:35:29 < swap 00:45:11).

Declined finding: "retire inert pid 1927 mockup server" — pid 1927's cwd is
`/home/benbi/Desktop/solane/vault-app` (the Vault messaging app itself), not a
raindesk mockup. Left running deliberately.

## Suite receipts

Receipt-id provenance: the hex ids below are harness test-run receipt ids
(minted by the SLOANE testing tool — decorative labels; the machine-local
run ledger records each run's timestamp/exit-code but carries NO id
field, so ids are reproducible neither from this repo nor from the
ledger). The repo-reproducible proof for each is the command
`node --test tests/frontend/*.test.js lib/tests/*.test.js` in raindesk/
plus the git SHA at the time:

- v1 mission (35/35): receipt `6a33323aad2d6d84` @ v1 close
- foundation pass + b7152d6 (44/44): receipt `e983b2bcbfe94e06`
- post-mutation first run @ b7152d6 (44/44, exit 0): receipt
  `file-inspection-test_run-2d56d817991d37f3`
- post-repair certification @ 1574bcf (44/44, exit 0): receipt
  `file-inspection-test_run-f243bcfff4849822`
- round-2 repairs certification @ c59f23c (44/44, exit 0): receipt
  `file-inspection-test_run-14cb2d6e7d11f06f`
- round-3 repairs certification @ 959768c (44/44, exit 0): receipt
  `file-inspection-test_run-3271342c33b6edbe`
- round-4 repairs certification @ 94f6976 (44/44, exit 0): receipt
  `file-inspection-test_run-cf735f1943232b54`
- round-6 stateful-gate re-anchor @ 94f6976 frozen tree (44/44, exit 0):
  receipt `file-inspection-test_run-0c3f7480ea96deeb`
- round-7 close certification @ f2e4f37 (44/44, exit 0): receipt
  `file-inspection-test_run-863363e2e6fd5a3a`
- round-8 close certification @ b1e4793 (44/44, exit 0): receipt
  `file-inspection-test_run-7ad258a9a4fcb0c7`
- round-9 close certification @ feb803a (44/44, exit 0): receipt
  `file-inspection-test_run-7e5a33d9cf30e580`

## Wave-cycle termination trigger (round-7/8/9 corrections)

The round-6 closeout's trigger ("next REAL repo mutation") was too narrow:
an owner ROLL executed through the live API (POST /api/shot/S01/layer — the
take7 mechanism) swaps the challenge's subject imagery entirely inside
gitignored raindesk/data/ with zero repo mutation. Round-8 tightened the
predicate to served-state-regardless-of-transport. Round-9 adversarial
review found that wording UNDECIDABLE: data/assets/* appeared in both the
bound class and the non-activating class with no tiebreak. Corrected
trigger — classes DISJOINT BY PATH: a fresh review pair re-binds on
(1) any repo commit, including an uncommitted working-tree change to
server OR CLIENT code, or to any served asset — require-cached ones
(lib/workflows/*.json, comfy.js:82, restart-served) or per-request-read
ones (lib/presets/*.txt, fs.readFileSync per chat, agent.js:64) — that a
process restart, the next page load, or the next request would serve
(public/** is served per-request with no cache headers); (2) any change to
AUTHORITATIVE served state — exactly data/board.json (including its
atomic tmp+rename write sibling) and data/shots/**
(shot meta, layer files, activeLayer) — regardless of how it arrives
(in-app API, direct filesystem write, or RAINDESK_DATA_DIR rehome; a
rehomed/empty data dir that lazily self-seeds a fresh baseline,
board.js:52-58 write at :57, counts as such a change); (3) any owner-verdict event on
the taste question (vault 7a61439f — machine-local channel, observable
only in the Vault app and session transcripts, same honesty class as the
receipt ids above).
data/assets/** is a NON-ACTIVATING display cache by path: gen mirrors
are written there (server.js /api/gen -> assets.store) and served to
phones; the authoritative imagery is what data/shots/*.json references
via layers/activeLayer (saveLayer, shots.js:85, is the sole setter).
Prose closeouts, ledger appends, /tmp review artifacts, and test-file-only
edits (tests/**, lib/tests/**) are non-activating.
