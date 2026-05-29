# Spike: Todoist Sync API vs REST polling (Tier 2)

**Status:** Investigated 2026-05-29. Conclusion: **already on the Sync API; defer incremental `sync_token` adoption.**

## What the plugin does today

The client in [src/todoist-client.ts](../src/todoist-client.ts) already talks to the
**Sync API** (`POST https://api.todoist.com/api/v1/sync`), not the REST API:

- `fetchSyncSnapshot()` sends `sync_token: '*'` with `resource_types: ['user','projects','sections','items']` — a **full** sync every run.
- All writes (`createTask`, `updateTask`, `deleteTask`, `createProject`) go through `commands[]` with per-command UUIDs, which the Sync API dedupes (see T1.4).
- Deletion detection uses the Activities API (`fetchRecentlyDeletedTaskIds`) plus an unused `fetchDeletedItemIds(sinceSyncToken)` helper.

So the "REST polling" framing in the roadmap is inaccurate — the transport is the Sync API. The remaining optimization is **incremental sync**: pass the stored `sync_token` instead of `'*'` so the server returns only items changed since last sync.

## Why incremental sync is not a quick win here

1. **The payload isn't the bottleneck.** The wall described in Tier 2 is the **O(vault) local scan** on every sync, not the network response. That is addressed by the event-driven vault index (T2.1) and the lazy pre-pass (T2.2), which are now implemented. A smaller network payload would not move the needle on a 5K-note vault.

2. **State management cost.** Incremental sync requires:
   - Treating the response as a **delta** (upserts + tombstones) rather than the authoritative full set. Today, "absent from the full snapshot" *is* the signal for completed/deleted — that logic (`findMissingEntries`, Phase 8) would have to be rewritten to consume explicit `is_deleted` deltas instead.
   - **Full-resync recovery**: tokens expire / can desync; we'd need a fallback to `'*'` and reconciliation, plus correct token persistence (now gated on a clean apply — see T1.6).
   - Interaction with the two-snapshot flow (Phase 3 pre-push, Phase 6 post-push). Incremental tokens across two syncs-per-run add ordering hazards.

3. **Correctness risk outweighs benefit.** The current full-sync model is simple and robust; the Tier 1 reliability work depends on "the snapshot is the truth." Moving to deltas reopens exactly the duplicate/clobber/missed-change classes we just hardened.

## Recommendation

- **Keep full sync (`'*'`) for now.** The implemented T2.1/T2.2/T2.3 changes capture the real performance win (no per-sync vault scan, touched-only project/section pre-pass, cached duplicate resolution).
- **Prerequisites already in place** if we revisit incremental later: `lastSyncToken` is persisted, now gated on a fully-applied snapshot (T1.6), so a future incremental path has a trustworthy token to build on.
- **Revisit only if** profiling shows the Sync network payload (not the local scan) dominates sync time for very large accounts. At that point, scope it as: incremental items delta + tombstone handling + `'*'` fallback on token error, behind tests (Tier 5).
