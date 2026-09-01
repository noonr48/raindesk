# Adapter-Family — RISKS

- **Double-store divergence**: A2/A3 write BOTH stores per request — a crash between them must never leave v3 ahead of v4 identity-wise (synthetic creates: v4 first, then v3 upsert; failures surface typed).
- **legacyRevision coupling**: legacy adapters must not bump structural/spatial v4 revisions on no-op diffs (idempotent diff computation).
- **Migration idempotence**: seedFromV3 runs only on ENOENT; the backup must be written exactly once (a second boot must not overwrite the original backup with a post-migration v3).
- **Test isolation**: migration tests need their own DATA_DIR (RAINDESK_DATA_DIR env) so they never touch the real data dir.
- **410 rule blast radius**: window_* missing → 410 could break unknown existing callers that create window_-prefixed rows through the legacy route — grep the tree first; the freeform manager (the only window_* author) is already on v4.
