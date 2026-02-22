# Sync Issues Fix Plan

All changes confined to `src/task-note-repository.ts`.

## To-Do

- [x] **1. Fix task duplication** — `listPendingLocalCreates` (~line 593)
  - **Root cause:** `typeof todoistId === 'string'` check misses number-typed YAML values — task appears as pending create and gets created again in Todoist
  - **Fix:** Normalize ID like `buildVaultIndexes` does (lines 1018–1022) — handle both string and number types

- [x] **2. Fix project renames** — `ensureProjectNote` (~lines 158–216)
  - **Root cause:** Found-by-ID path returns immediately without checking if the name changed in Todoist
  - **Fix:** Compare cached `project_name` to current Todoist name; if different:
    - Update frontmatter `project_name`
    - If sanitized name differs and `useProjectSubfolders`: rename folder `{tasksFolder}/{oldSanitized}` → `{tasksFolder}/{newSanitized}`, then rename file inside
    - If `projectNotesFolderPath`: rename just the file

- [ ] **3. Fix section renames + stale section → project link** — `ensureSectionNote` (~lines 218–276)
  - **Root cause:** Found-by-ID path returns early without updating `section_name` or `todoist_project_link`
  - **Fix:** Check both `section_name` and `todoist_project_link` against current values; if either stale:
    - Update frontmatter
    - If sanitized section name differs: rename section subfolder and file

- [ ] **4. Fix task wikilinks not updating** — `updateTaskFile` (~lines 813–815)
  - **Root cause:** Signature-match early return skips `processFrontMatter` entirely — tasks never get `todoist_project_link`/`todoist_section_link` when project/section notes are created after the task was first synced
  - **Fix:** Before returning on signature match, compute `projectLink`/`sectionLink`, compare to cached values; if stale, run a targeted `processFrontMatter` for just those two fields (no stat increment)

## Verification

1. `npm run build` — must pass TypeScript strict checks
2. Rename project in Todoist → sync → project note + folder renamed, tasks keep links
3. Rename section in Todoist → sync → section note renamed, `todoist_project_link` updated
4. Enable `createProjectNotes` on vault with existing synced tasks → sync → tasks get `todoist_project_link`
5. Simulate number-typed `todoist_id` in YAML → sync → no duplicate created in Todoist
