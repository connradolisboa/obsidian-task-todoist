# Plugin Improvements

A prioritized, checkbox-driven roadmap for hardening, refining, and extending the plugin. Tiers are ordered by leverage — **Tier 1 fixes real defects that risk data loss**; do those first. Each task lists **What / Where / How** so it can be picked up without re-deriving the audit.

> Synthesized from two codebase audits (architecture overview + reliability deep-dive on `sync-service.ts`, `task-note-repository.ts`, `todoist-client.ts`, `main.ts`).

---

## Tier 1 — Reliability (make it bulletproof)

These are concrete defects in the current code. Each risks duplicate Todoist tasks, silent data loss, or frontmatter clobbering. Ship as a patch release.

- [x] **Persist `todoist_pending_id` BEFORE `createTask()`, not after**
  - **Where:** [src/sync-service.ts:109-111](src/sync-service.ts#L109-L111)
  - **How:** Generate a UUID locally, write it as `todoist_pending_id` into the note frontmatter, *then* call `createTask()`. On the next sync, any note with a pending ID is reconciled against Todoist (by `temp_id` / title / created-at) instead of re-created. Apply the same ordering to project-task creation ([sync-service.ts:350-361](src/sync-service.ts#L350-L361)) and NoteTask creation ([sync-service.ts:413-523](src/sync-service.ts#L413-L523)).

- [x] **Add a write-ahead log for pending creates**
  - **Where:** new file `src/pending-log.ts`; called from `sync-service.ts`
  - **How:** Single JSON file under `.obsidian/plugins/<id>/pending.json` tracking `{ noteVaultId, kind: 'task'|'project'|'noteTask', dispatchedAt, todoistId? }`. Written before the network call, cleared on confirmation. Survives crashes that beat frontmatter writes to disk.

- [x] **Stop clobbering `todoistProjectLink/SectionLink/Labels` in `local-wins` conflicts**
  - **Where:** [src/task-note-repository.ts:2210-2213](src/task-note-repository.ts#L2210-L2213) (inside `updateTaskFile()`)
  - **How:** When `syncStatus === 'dirty_local'` and `conflictResolution === 'local-wins'`, treat link/label frontmatter as user-editable too — skip writes unless the value is genuinely missing. Better: store a `lastSyncedSnapshot` blob in frontmatter and do a 3-way merge (local vs remote vs base).

- [x] **Reuse command UUIDs across 429 retries**
  - **Where:** [src/todoist-client.ts:339-412](src/todoist-client.ts#L339-L412) (`syncWithCommands`)
  - **How:** Verify that the UUID generated per command is created once at the call site and *not* regenerated inside the retry loop. The Sync API dedupes by UUID; regenerating per attempt causes duplicate updates on rate-limit retries.

- [x] **Surface exhausted-retry errors instead of returning empty results**
  - **Where:** [src/todoist-client.ts:180-202](src/todoist-client.ts#L180-L202) (`fetchRecentlyDeletedTaskIds`)
  - **How:** Change return type to `{ ok: true; ids: Set<string> } | { ok: false; reason: string }`. Caller in `sync-service.ts` skips the deletion phase when `ok: false` and logs to phase errors. Today, exhausted retries silently look like "nothing was deleted" and tasks deleted in Todoist stay in Obsidian forever.

- [x] **Save `lastSyncToken` only on clean snapshot phase**
  - **Where:** [src/sync-service.ts:173-179](src/sync-service.ts#L173-L179)
  - **How:** Track per-phase success; persist `lastSyncToken` only when the snapshot phase has no errors. Currently a token saved after a partial failure causes the next sync to miss changes silently.

- [x] **Re-check file mtime before per-file writes during Phase 7 upsert**
  - **Where:** [src/sync-service.ts:237-248](src/sync-service.ts#L237-L248) → `updateTaskFile()` in `task-note-repository.ts`
  - **How:** Before writing, compare `file.stat.mtime` to the value captured when the file was indexed at sync start. If it changed, mark `syncStatus: 'dirty_local'` and skip the remote-wins write. Today a long sync can clobber edits the user made while it ran.

- [x] **Sync lock: acknowledge every manual trigger**
  - **Where:** [src/main.ts:155-202](src/main.ts#L155-L202)
  - **How:** Replace single boolean queue flag with a counter and a Notice on each trigger ("Sync already running — queued"). Coalesce >1 pending into a single re-run, but every user click should yield user-visible feedback.

- [x] **Confirmation modal + max-deletion cap for destructive `deletedTaskMode: 'delete'`**
  - **Where:** [src/settings-tab.ts](src/settings-tab.ts) (mode selector) + [src/task-note-repository.ts:969-980](src/task-note-repository.ts#L969-L980) (`applyMissingRemoteTasks`)
  - **How:** First time a user picks `delete`, show a modal explaining the risk and requiring "I understand". Add `maxDeletesPerSync` setting (default 25); if exceeded, abort the delete phase and surface a Notice. Protects against a transient API blip that returns an empty task list.

- [x] **NoteTask orphan cleanup on 404**
  - **Where:** [src/sync-service.ts:457-460](src/sync-service.ts#L457-L460) (NoteTask "stop" path) and reconciliation in same file
  - **How:** When pushing an update for a NoteTask returns 404, clear `todoistNoteTaskId` and either re-create or mark the note for user review. Today a failed delete leaves the frontmatter pointing at a vanished task and every future sync silently no-ops.

---

## Tier 2 — Performance & scale

The plugin is O(n) over the entire vault on every sync. Large vaults (5K+ notes) hit a wall.

- [x] **Event-driven vault index**
  - **Where:** [src/vault-index.ts](src/vault-index.ts) (expand) + [src/task-note-repository.ts:172](src/task-note-repository.ts#L172) (`buildVaultIndexes`)
  - **How:** Subscribe to `vault.on('create'|'modify'|'delete'|'rename')` and maintain indexes incrementally. Rebuild only on plugin load. Removes per-sync filesystem scans.

- [x] **Lazy project/section pre-pass**
  - **Where:** [src/task-note-repository.ts:190-229](src/task-note-repository.ts#L190-L229)
  - **How:** Only ensure project/section notes that are touched by the current item set, not all 500 projects up front. Tracks orphan project notes separately for archival.

- [x] **Cache duplicate-resolution state**
  - **Where:** [src/task-note-repository.ts:172-173](src/task-note-repository.ts#L172-L173) (`autoResolveDuplicateIds`)
  - **How:** Skip the full scan when no writes have occurred since last check. Cache "clean" state in memory and invalidate via the vault event subscription above.

- [x] **Investigate Todoist Sync API instead of REST polling**
  - **Where:** [src/todoist-client.ts](src/todoist-client.ts) (whole client)
  - **How:** Sync API returns only items changed since a `sync_token`, dramatically reducing payload size and request count. Trade-off: more state to manage (token persistence, full-resync recovery). Spike before committing.

---

## Tier 3 — UX & usability

50+ settings, 6 tabs — onboarding burden is high. Failures are mostly silent.

- [ ] **First-run onboarding wizard**
  - **What:** Modal flow on first plugin enable: API token → which projects to sync (or "all") → folder location → done.
  - **Where:** new file `src/onboarding-modal.ts`; triggered from `main.ts` `onload()` when no token is set.
  - **How:** Keep advanced settings hidden until the basics work. Hugely lowers the "what do all these options mean" friction.

- [ ] **Sync health panel**
  - **What:** A status view (right sidebar or command-palette modal) showing last sync time, items synced/failed, last error with link to log.
  - **Where:** new `src/sync-health-view.ts`; register as Obsidian `ItemView`.
  - **How:** Read from `lastSyncResult` state in `main.ts`. Replaces today's "Notice appears once and disappears" pattern.

- [ ] **Dry-run mode**
  - **What:** Setting `dryRun: boolean` — sync runs, computes changes, but writes nothing. Displays a summary.
  - **Where:** [src/sync-service.ts](src/sync-service.ts); gate every write behind `if (!settings.dryRun)`.
  - **How:** Critical for first sync against a large existing vault. Surface the planned changes in the health panel.

- [ ] **Per-project sync toggle from the note**
  - **What:** Right-click a project note → "Pause sync for this project". Writes a `syncPaused: true` frontmatter property.
  - **Where:** [src/import-rules.ts](src/import-rules.ts) (honor flag) + Obsidian `file-menu` registration in `main.ts`.

- [ ] **Conflict diff modal**
  - **What:** When `conflictResolution: 'remote-wins'` would overwrite local edits, show a side-by-side diff with "Keep local / Keep remote / Merge" buttons.
  - **Where:** new `src/conflict-modal.ts`; invoked from `updateTaskFile()` when divergence is detected.
  - **How:** Optional — only when `conflictResolution: 'prompt'` (new mode); default remains automatic.

- [ ] **Actionable error notices**
  - **Where:** [src/sync-service.ts](src/sync-service.ts) (phase error capture) + [src/main.ts](src/main.ts) (notice display)
  - **How:** Replace "Sync failed" with `"Sync failed in phase 7 (upsert): 429 rate limit. Retrying at 14:32."` Include a "View log" button that opens the in-vault log file (see Tier 5 logging).

- [ ] **Settings search**
  - **Where:** top of [src/settings-tab.ts](src/settings-tab.ts)
  - **How:** Input box that filters visible setting rows by label/description match. ~30 lines of code.

- [ ] **Progressive disclosure for advanced settings**
  - **Where:** [src/settings-tab.ts](src/settings-tab.ts)
  - **How:** Hide custom frontmatter key remapping, area projects, and the 50+ `addPropNameSetting` rows behind an "Show advanced" toggle. New users see 10 settings, not 50.

---

## Tier 4 — New features

High-leverage additions that fit the existing architecture.

- [ ] **Todoist comments ↔ note section sync**
  - **What:** Mirror Todoist task comments into a `## Comments` section in the note; sync new comments back.
  - **Where:** new `src/comment-sync.ts`; called from `sync-service.ts` per-item.
  - **How:** Use Todoist REST `/comments` endpoint. Store comment IDs in a hidden frontmatter array (`todoistCommentIds`) for reconciliation.

- [ ] **Recurring task surfacing**
  - **What:** Expose recurrence string and next-due preview in frontmatter.
  - **Where:** [src/task-frontmatter.ts](src/task-frontmatter.ts) + [src/todoist-client.ts](src/todoist-client.ts) (extract `due.is_recurring` and `due.string`).
  - **How:** Add `recurrence: string` and `next_due: string` properties; populated from API response.

- [ ] **Attachment handling**
  - **What:** When a Todoist task has file attachments, download into a vault folder and embed/link in the note.
  - **Where:** new `src/attachment-service.ts`; called from `task-note-factory.ts`.
  - **How:** Setting `attachmentsFolderPath`. Skip if file already exists with matching hash.

- [ ] **Daily-note codeblock processor**
  - **What:** Render today's due/scheduled tasks live via <code>```todoist filter=today</code> markdown codeblock.
  - **Where:** new `src/codeblock-processor.ts`; register with `registerMarkdownCodeBlockProcessor` in `main.ts`.
  - **How:** Parses filter args; queries cached vault index; renders as a checkbox list. Complements existing [daily-note-service.ts](src/daily-note-service.ts).

- [ ] **Quick-capture command (Cmd+Shift+T)**
  - **What:** Modal — title / project / date / priority / label — creates locally + queues for sync.
  - **Where:** extend [src/create-task-modal.ts](src/create-task-modal.ts); register hotkey in `main.ts`.
  - **How:** Reuses existing modal but auto-focuses title input. Removes context switch to Todoist for capture.

- [ ] **Bulk operations on folders**
  - **What:** Right-click folder → "Send all notes to Todoist as tasks" / "Complete all tasks in folder" / "Move all to project X".
  - **Where:** new `src/bulk-operations.ts`; `file-menu` registration in `main.ts`.

- [ ] **Multi-account / workspace support**
  - **What:** Multiple Todoist accounts with separate folder roots.
  - **Where:** restructure `src/settings.ts` to support a `profiles: { [name]: ProfileSettings }` shape with an `activeProfile` selector.
  - **How:** Sizeable refactor — defer until Tier 5 settings factory lands.

- [ ] **Optional webhook listener for near-real-time sync**
  - **What:** Todoist webhooks via a local relay; sync triggers immediately on remote change.
  - **Where:** new `src/webhook-listener.ts`; opt-in setting `enableWebhooks: boolean`.
  - **How:** Requires user to set up a public relay URL (or use a service like ngrok). Gated behind clear documentation — most users won't need this.

---

## Tier 5 — Code health (enables everything above)

- [ ] **Vitest test harness**
  - **Where:** new `vitest.config.ts` + `src/__tests__/`
  - **How:** Mock Obsidian's `App`/`Vault`/`TFile` interfaces and a fake Todoist client. Start by covering Tier 1 paths: pending-ID lifecycle, conflict merge, sync-token persistence, mtime guard. These are the regressions that hurt most.

- [ ] **Decompose `task-note-repository.ts` (3,099 lines)**
  - **Where:** split [src/task-note-repository.ts](src/task-note-repository.ts) into:
    - `src/task-note-files.ts` — file CRUD + frontmatter merges
    - `src/project-notes.ts` — project note lifecycle
    - `src/section-notes.ts` — section note lifecycle
    - `src/note-task-sync.ts` — NoteTask logic
    - `src/archive-service.ts` — archive/move/delete operations
    - expand `src/vault-index.ts` to own all index reads/writes
  - **How:** Do this *after* test harness lands so refactors are guarded.

- [ ] **Settings factory pattern**
  - **Where:** [src/settings-tab.ts](src/settings-tab.ts) (1,164 lines of procedural UI)
  - **How:** Replace per-setting render code with a declarative schema: `{ key, label, description, type, default, advanced?, tab }[]`. Generic renderer iterates the schema. Cuts the file by ~60%, enables settings search and progressive disclosure trivially.

- [ ] **Structured logging**
  - **Where:** new `src/logger.ts`; replace ad-hoc `console.log` / `Notice` calls
  - **How:** Levels (debug/info/warn/error). Write rolling log to `.obsidian/plugins/<id>/sync.log`. UI: a "View last sync log" command. Powers the actionable-notices and sync-health-panel features.

- [ ] **CI: typecheck + lint on PR**
  - **Where:** new `.github/workflows/ci.yml`
  - **How:** `npm run build` + `npm run lint` (add eslint if missing). Add `npm test` once Vitest is in. Already builds on Node 20 & 22 — formalize into CI.

---

## Recommended sequence

1. **Tier 1 fixes** — duplicate creation, frontmatter clobber, sync-token regression, destructive-delete confirmation. Ship as patch release.
2. **Vitest scaffolding** (Tier 5) — even minimal coverage on Tier 1 paths prevents regressions during the bigger refactors.
3. **Event-driven vault index** (Tier 2) — unlocks performance ceiling.
4. **Sync health panel + onboarding** (Tier 3) — biggest user-visible quality jump.
5. **Decompose god files** (Tier 5) — opens runway for new features.
6. **Pick from Tier 4** — quick-capture and comment-sync are the highest-leverage and don't need deep refactoring.

---

## Verification scenarios

After each Tier 1 fix, run the matching manual scenario before shipping:

- [ ] Quit Obsidian mid-sync; reopen; confirm no duplicate Todoist tasks were created.
- [ ] Edit a synced note's title while a long sync is running; confirm the local edit survives in `local-wins` mode.
- [ ] Trigger 3 manual syncs in quick succession; confirm all are acknowledged via Notice.
- [ ] Toggle `deletedTaskMode` to `delete`; confirm the confirmation modal appears the first time.
- [ ] Simulate Todoist returning an empty task list (network blip); confirm `maxDeletesPerSync` cap aborts the delete phase instead of deleting everything.
- [ ] Sync against a vault of ~5K notes; measure sync time before/after event-driven index (Tier 2).
- [ ] `npm run build` passes with no TypeScript errors after every PR.
