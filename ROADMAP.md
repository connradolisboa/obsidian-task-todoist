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

- [ ] **Exclude projects from sync** — add `excludedProjectNames: string` setting (comma-separated); filter in `src/import-rules.ts`
- [ ] **Exclude sections from sync** — add `excludedSectionNames: string` setting; filter in `src/import-rules.ts` (requires passing `sectionNameById` to `filterImportableItems()`)
- [ ] **Area project names** — add `areaProjectNames: string` setting (comma-separated list of projects treated as "areas")
- [ ] **Area project template** — add `areaProjectNoteTemplate: string` setting; use it in `ensureProjectNote()` when the project name matches the area list
- [ ] Add all four settings to `src/settings.ts` and `DEFAULT_SETTINGS`
- [ ] Add UI blocks in `src/settings-tab.ts` (Import tab for exclusions, Notes tab for area template)

---

## Tier 4 — Lifecycle (depends on Tier 1; most complex)

### PR 5: Delete file when task is deleted in Todoist

- [ ] Add `'delete-file'` to `ArchiveMode` type in `src/settings.ts`
- [ ] Add dropdown option "Move to Obsidian trash (recoverable)" in `src/settings-tab.ts`
- [ ] In `applyMissingRemoteTasks()` (`src/task-note-repository.ts`), add branch: `await this.app.vault.trash(entry.file, false)` (use `.trash()`, not `.delete()` — keeps files recoverable)

### PR 6: Archive project/section notes when archived in Todoist
> When a project or section is archived in Todoist, its note moves to a configurable archive folder. Tasks under it are already handled by the existing archive mode.

- [ ] Add `is_archived: boolean` to `TodoistProject` and `TodoistSection` in `src/todoist-client.ts`; extract in `normalizeProjects()` / `normalizeSections()`
- [ ] Add `projectArchiveFolderPath: string` setting (default `'Projects/_archive'`)
- [ ] Add `sectionArchiveFolderPath: string` setting (default `''` = under project archive folder)
- [ ] Add UI path settings in `src/settings-tab.ts` Sync tab
- [ ] Add `applyArchivedProjectsAndSections()` to `src/task-note-repository.ts` — uses project/section ID indexes (Tier 1) to find notes and move them
- [ ] Call `applyArchivedProjectsAndSections()` from `src/sync-service.ts` after building the snapshot

---

## Verification Checklist

- [ ] Move a synced task note to a different folder → sync → file found and updated (not duplicated)
- [ ] Move a project note → sync → found by `project_id`, not duplicated
- [ ] Change task title in Todoist → sync → file NOT renamed, `task_title` frontmatter updated
- [x] Section note created → has `project_link` pointing to correct project note path
- [x] Sub-project note created → has `parent_project_link` pointing to parent project note
- [ ] Project in excluded list → its tasks not imported on sync
- [ ] Section name in excluded list → tasks in that section not imported
- [ ] Project in area list → project note uses area template
- [ ] Archive mode = "Move to Obsidian trash" → deleted Todoist task → note appears in `.trash`
- [ ] Archive project in Todoist → sync → project note moves to `projectArchiveFolderPath`
- [ ] `npm run build` passes with no TypeScript errors

---

## Key Files Reference

| File | Related Tasks |
|------|--------------|
| `src/task-note-repository.ts` | All tiers — primary implementation file |
| `src/settings.ts` | PR 2, 4, 5, 6 |
| `src/settings-tab.ts` | PR 2, 4, 5, 6 |
| `src/todoist-client.ts` | PR 3, 6 (`parent_id`, `is_archived`) |
| `src/import-rules.ts` | PR 4 (exclusion logic) |
| `src/sync-service.ts` | PR 3, 4, 6 (pass new data to repository) |
