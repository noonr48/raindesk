# risks.md — Stage-2

| risk | likelihood | impact | mitigation | spike? |
|---|---|---|---|---|
| Projection extraction changes floating-point behavior subtly (CreativeDesk regressions) | L | H | P0 is byte-identical move + creative-desk tests green unchanged; journey re-run | NO |
| Backfill uses a viewport that has drifted since the rows were written → world positions land "somewhere else" visually | M | M | one-time migration uses the persisted viewport AT migration time; receipt records it; down-migration exists; journey's reload witness catches gross drift | NO |
| Screen-space chrome (drawer, topbar) accidentally classified world → wanders on pan | M | M | classification explicit-only; criterion-2 validator + journey pan step catches | NO |
| Group/dock interplay under world units (dockRect in screen px vs world frame) | M | H | docking stays presentation-only; frame geometry stays world; P2 skeleton includes the dock round-trip in its discriminator | NO |
| Dual-path period (screen+world surfaces coexist in P2-P4) doubles geometry bug surface | M | M | per-surface revert (plan P4 rollback); skeleton-first ordering proves the path before batching | NO |
| Context/compaction mid-Stage-2 | M | M | this shelf is committed before code; per-step commits; LEDGER next-entry-point | NO |
