# Plugin Roadmap

Organized implementation plan. Tasks are grouped by dependency tier — complete each tier before the next.

---

## Tier 1 — Foundation (no dependencies)

### PR 1: Vault-wide ID tracking for all entity types
> Tasks, project notes, and section notes are all found by their ID frontmatter property, regardless of where in the vault the file lives.

- [x] **Tasks tracked by ID vault-wide** — extend `buildTodoistIdIndexInTaskFolder()` to scan all vault markdown files (not just `tasksFolderPath`) when looking up existing synced tasks
- [x] **Project notes tracked by ID** — replace path-based lookup in `ensureProjectNote()` with a `buildProjectNoteIndex()` scan for `project_id` frontmatter; no more duplicate notes on rename/move
- [x] **Section notes tracked by ID** — same fix for `ensureSectionNote()` using `buildSectionNoteIndex()` for `section_id` frontmatter
- [x] **Single-pass scan** — build all three indexes (tasks, projects, sections) in one `getMarkdownFiles()` pass for performance

### PR 2: Decouple task filename from title
> Filenames are never auto-renamed. Only the `task_title` frontmatter property is updated on sync. Users control the filename.

- [x] Change `autoRenameTaskFiles` default to `false` in `DEFAULT_SETTINGS` (`src/settings.ts`)
- [x] Update setting description in `src/settings-tab.ts` to clarify behavior

---

## Tier 2 — Linking (requires Tier 1)

### PR 3: Wiki links between related notes
> Section notes link to their parent project note. Sub-project notes link to their parent project note.

- [x] **Section → project link** — write `project_link: "[[path/to/project]]"` into section note frontmatter on creation; add `{{project_link}}` template variable
- [x] **Sub-project → parent link** — write `parent_project_link: "[[path/to/parent]]"` into project note frontmatter when a parent exists; add `{{parent_project_link}}` template variable
- [x] Add `parent_id: string | null` to `TodoistProject` interface in `src/todoist-client.ts` and extract it in `normalizeProjects()`
- [x] Change `ensureProjectNote()` return type to `Promise<TFile | null>` so the project file can be passed to `ensureSectionNote()`

---

## Tier 3 — Configuration (no dependencies)

### PR 4: Exclusion lists + area project templates

- [x] **Exclude projects from sync** — add `excludedProjectNames: string` setting (comma-separated); filter in `src/import-rules.ts`
- [x] **Exclude sections from sync** — add `excludedSectionNames: string` setting; filter in `src/import-rules.ts` (requires passing `sectionNameById` to `filterImportableItems()`)
- [x] **Area project names** — add `areaProjectNames: string` setting (comma-separated list of projects treated as "areas")
- [x] **Area project template** — add `areaProjectNoteTemplate: string` setting; use it in `ensureProjectNote()` when the project name matches the area list
- [x] Add all four settings to `src/settings.ts` and `DEFAULT_SETTINGS`
- [x] Add UI blocks in `src/settings-tab.ts` (Import tab for exclusions, Notes tab for area template)

---

## Tier 4 — Lifecycle (depends on Tier 1; most complex)

### PR 5: Delete file when task is deleted in Todoist

- [x] Add `'delete-file'` to `ArchiveMode` type in `src/settings.ts`
- [x] Add dropdown option "Move to Obsidian trash (recoverable)" in `src/settings-tab.ts`
- [x] In `applyMissingRemoteTasks()` (`src/task-note-repository.ts`), add branch: `await this.app.vault.trash(entry.file, false)` (use `.trash()`, not `.delete()` — keeps files recoverable)

### PR 6: Archive project/section notes when archived in Todoist
> When a project or section is archived in Todoist, its note moves to a configurable archive folder. Tasks under it are already handled by the existing archive mode.

- [x] Add `is_archived: boolean` to `TodoistProject` and `TodoistSection` in `src/todoist-client.ts`; extract in `normalizeProjects()` / `normalizeSections()`
- [x] Add `projectArchiveFolderPath: string` setting (default `'Projects/_archive'`)
- [x] Add `sectionArchiveFolderPath: string` setting (default `''` = under project archive folder)
- [x] Add UI path settings in `src/settings-tab.ts` Sync tab
- [x] Add `applyArchivedProjectsAndSections()` to `src/task-note-repository.ts` — uses project/section ID indexes (Tier 1) to find notes and move them
- [x] Call `applyArchivedProjectsAndSections()` from `src/sync-service.ts` after building the snapshot

---

## Tier 5 — ID Tracking System Improvements (depends on Tier 1)

> Adds a stable vault UUID, unifies project/section ID keys through PropNames, detects duplicate `todoist_id` conflicts with user warnings, and prevents duplicate Todoist task creation when a sync crashes mid-flight.

### PR 7: Unify project/section ID keys through PropNames
> Prerequisite cleanup — makes `project_id` and `section_id` configurable like all other property names. Backward-compatible dual-read for existing notes.

- [x] Add `projectId: string` and `sectionId: string` to `PropNames` interface in `src/settings.ts` (defaults: `'project_id'`, `'section_id'`)
- [x] Update `buildVaultIndexes()` in `src/task-note-repository.ts` — replace hardcoded `fm['project_id']` / `fm['section_id']` reads with PropNames-aware dual-read:
  ```ts
  const rawProjectId = fm[p.projectId] ?? (p.projectId !== 'project_id' ? fm['project_id'] : undefined);
  ```
- [x] Update default content in `ensureProjectNote()` and `ensureSectionNote()` to use `${p.projectId}:` / `${p.sectionId}:` instead of hardcoded keys
- [x] Add `addPropNameSetting()` entries for `projectId` and `sectionId` in `src/settings-tab.ts`

### PR 8: Add `vault_id` UUID to all plugin notes
> Each note gets a stable, write-once UUID at creation time. Existing notes are backfilled on first sync.

- [x] Add exported `generateUuid()` to `src/task-frontmatter.ts` (uses `crypto.randomUUID()` with a `Date.now()` fallback)
- [x] Add `vaultId: string` to `PropNames` in `src/settings.ts` (default: `'vault_id'`)
- [x] Write `vault_id` at creation time in four places: `buildNewFileContent()`, `createLocalTaskNote()`, `ensureProjectNote()`, `ensureSectionNote()`
- [x] Add `backfillVaultIds(): Promise<number>` method to `TaskNoteRepository` — scans vault-wide, skips notes with no plugin ID, skips notes that already have `vault_id`, writes a new UUID via `processFrontMatter`
- [x] Call `repository.backfillVaultIds()` in `runImportSync()` (`src/sync-service.ts`) after `repairMalformedSignatureFrontmatterLines()`
- [x] Add `vaultIdIndex: Map<string, TFile>` to `buildVaultIndexes()` return type
- [x] Add `addPropNameSetting()` for `vaultId` in `src/settings-tab.ts` with a note that this is write-once

### PR 9: Detect duplicate `todoist_id` in vault
> When two vault files share the same `todoist_id`, emit a console warning and an Obsidian Notice rather than silently resolving non-deterministically.

- [ ] Extend `buildVaultIndexes()` return type with `duplicateTaskIds: Set<string>`
- [ ] In the task index loop, replace unconditional `taskIndex.set(id, file)` with first-seen-wins collision detection that populates `duplicateTaskIds`
- [ ] Add `emitDuplicateIdWarnings(dupes: Set<string>)` method — logs to console and shows an Obsidian `Notice` if any duplicates found; add `Notice` import from `obsidian`
- [ ] Update `syncItems()` and `listSyncedTasks()` to destructure `duplicateTaskIds` and call `emitDuplicateIdWarnings()`

### PR 10: Idempotency guard for local creates
> Prevents a crashed sync from creating a duplicate Todoist task. A `todoist_pending_id` property is written immediately after `createTask()` returns; notes with this property are excluded from the next create pass and cleaned up when the full import syncs them back.

- [ ] Add `todoistPendingId: string` to `PropNames` in `src/settings.ts` (default: `'todoist_pending_id'`)
- [ ] Add `markCreateDispatched(file: TFile, pendingTodoistId: string): Promise<void>` to `TaskNoteRepository` — writes `todoist_pending_id` via `processFrontMatter`
- [ ] In `runImportSync()` create loop (`src/sync-service.ts`), call `repository.markCreateDispatched(pending.file, createdTodoistId)` immediately after `createTask()` returns, before any further async work
- [ ] In `listPendingLocalCreates()`, skip notes that already have a non-empty `todoist_pending_id` frontmatter value
- [ ] In `markLocalCreateSynced()`, delete `data[p.todoistPendingId]` inside `processFrontMatter`
- [ ] In `updateTaskFile()`, clear `todoist_pending_id` if present (recovery path when import catches the task before `markLocalCreateSynced` ran)
- [ ] Add `addPropNameSetting()` for `todoistPendingId` in `src/settings-tab.ts`

---

## Tier 5 Verification

- [ ] In a vault with existing project/section notes using `project_id`/`section_id`, sync still finds them after upgrade (backward compat dual-read)
- [ ] Rename `projectId` prop in settings → new notes use the new key; old notes still found via dual-read
- [ ] Run sync on a vault with existing task notes → all notes gain a `vault_id` property; running sync again does not re-write them
- [ ] Manually give two task notes the same `todoist_id` → run sync → Obsidian Notice appears warning about the duplicate
- [ ] Simulate crash between `createTask()` and `markLocalCreateSynced()` → note gets `todoist_pending_id` written → excluded from `listPendingLocalCreates()` on next run → recovered when full import runs
- [ ] `npm run build` passes with no TypeScript errors

---

## Verification Checklist

- [ ] Move a synced task note to a different folder → sync → file found and updated (not duplicated)
- [ ] Move a project note → sync → found by `project_id`, not duplicated
- [ ] Change task title in Todoist → sync → file NOT renamed, `task_title` frontmatter updated
- [x] Section note created → has `project_link` pointing to correct project note path
- [x] Sub-project note created → has `parent_project_link` pointing to parent project note
- [x] Project in excluded list → its tasks not imported on sync
- [x] Section name in excluded list → tasks in that section not imported
- [x] Project in area list → project note uses area template
- [x] Archive mode = "Move to Obsidian trash" → deleted Todoist task → note appears in `.trash`
- [x] Archive project in Todoist → sync → project note moves to `projectArchiveFolderPath`
- [x] `npm run build` passes with no TypeScript errors

---

## Key Files Reference

| File | Related Tasks |
|------|--------------|
| `src/task-note-repository.ts` | All tiers — primary implementation file |
| `src/settings.ts` | PR 2, 4, 5, 6, 7, 8, 9, 10 |
| `src/settings-tab.ts` | PR 2, 4, 5, 6, 7, 8, 10 |
| `src/todoist-client.ts` | PR 3, 6 (`parent_id`, `is_archived`) |
| `src/import-rules.ts` | PR 4 (exclusion logic) |
| `src/sync-service.ts` | PR 3, 4, 6, 8, 10 (pass new data to repository) |
| `src/task-frontmatter.ts` | PR 8 (`generateUuid()`) |
