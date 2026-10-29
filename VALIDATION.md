# Validation

**English** | [简体中文](VALIDATION.zh-CN.md)

## 1.5.0

Verified on 2026-10-29:

- All 231 tests and release checks passed, including migration of enabled/disabled installations, preferences and shortcuts, repeated installs, coexisting versions, and another plugin using the legacy ID.
- All 3 vault dashboard bridge checks passed with the new plugin ID and the legacy fallback.
- Obsidian 1.14.4 on macOS loaded `feishu-task-sync` 1.5.0. The old plugin was unloaded and archived; UI preferences and automatic sync were retained.
- The configuration SHA-256 and all 676 stored GUID fields matched before and after migration. Installed files matched the new release build.
- A live sync completed with 96 successes, zero failures, and two skips. The sync issue list was empty. The panel rendered without horizontal overflow, and no error-level console messages were captured.

## 1.4.2

Verified on 2026-10-29:

- All 225 tests and release checks passed.
- Added regressions for removed and restored Area notes, temporarily unavailable link caches, newly resolving links, links resolved from different folders, same-named areas, and ambiguous short links.
- Section checks cover every page and completed tasks. Empty-section cleanup verifies the owning task list, default section, and task count.
- Before and after the live duplicate-section repair, all project/action GUIDs, associated projects' Feishu placement, and completion states matched. The configuration file's SHA-256 also matched.

## 1.4.1

Verified on 2026-10-29:

- All 216 tests and release checks passed.
- All 16 live Obsidian interaction checks passed: read-only expansion, current-name prefilling, individual and batch cancellation, input-method confirmation, Enter/Esc, search, and navigation to settings.
- No horizontal overflow at a panel width of 400 px, including inline editing; no error-level console messages were captured during checks.
- The configuration file's SHA-256 matched before and after interaction checks.

## 1.4.0

Verified on 2026-10-29:

- After `npm ci`, all 216 tests and release checks passed.
- All 55 vault compatibility-entry and shared action-service tests passed.
- Loaded successfully in Obsidian 1.14.4 on macOS. No horizontal overflow at 400 px; no error-level console messages were captured during checks.
- After upgrading from 1.3.0, configuration and existing task/project GUIDs matched, and automatic sync remained enabled.
- The new version completed a live sync with zero failures. Installed files and release artifacts had matching SHA-256 hashes.

Validation commands:

```bash
npm test
npm run check-release
npm run package
```

Tests cover the Feishu API, project hierarchy, completion updates in both directions, conflicts, identity and GUID recovery, device transfers, background scheduling, plugin lifecycle, and release files.

The 1.4.0 additions cover extra folders, property/body tags, subtags, exclusions, scope overlap, removal and re-entry, status updates for ordinary notes, and transferring extra scopes between devices.

Lifecycle tests load the actual bundle without Components or vault service sources. Live installation and interface evidence stays in the local, ignored `evidence/` directory.
