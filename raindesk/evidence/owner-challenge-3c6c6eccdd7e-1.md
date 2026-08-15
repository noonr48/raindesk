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
swap commit 8324d00 (00:45:11) and require()-caches the workflow — live GEN
still ran z-anime while README claimed Illustrious-XL.

Repair: server restarted via agent-process registry (old pid 3520525 stopped,
fresh pid 684087). Proof: app's own /api/gen job (prompt "glowing brass
lantern on a wet stone wall") = ComfyUI history `c410ae95`, status success,
ckpt_name `Illustrious-XL-v0.1.safetensors`, mirrored to same-origin
`/api/assets/S01/1786816847222-n4vv1m.png`. All z-anime history entries
predate the swap+restart.

Declined finding: "retire inert pid 1927 mockup server" — pid 1927's cwd is
`/home/benbi/Desktop/solane/vault-app` (the Vault messaging app itself), not a
raindesk mockup. Left running deliberately.

## Suite receipts

- v1 mission: `6a33323aad2d6d84` (35/35)
- foundation pass + HEAD b7152d6: `e983b2bcbfe94e06` (44/44)
- post-mutation final: `file-inspection-test_run-2d56d817991d37f3` (44/44, exit 0)
