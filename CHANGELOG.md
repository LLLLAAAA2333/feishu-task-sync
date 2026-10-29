# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

## 1.5.0 — 2026-10-29

- Rename the plugin ID, package, and GitHub repository to `feishu-task-sync`, with the display name Feishu Task Sync.
- Add English and Chinese versions of the README, publishing guide, changelog, release notes, and validation record.
- Migrate this project's old plugin directory, UI preferences, enabled state, and shortcuts through the install script, with backups.
- Retain the local configuration path, vault identity, section and task GUIDs, note markers, and sync behavior.
- Preserve the integration APIs under the new plugin ID and leave other plugins using the old ID untouched.

## 1.4.2 — 2026-10-29

- Reuse existing Area section identities when an Area note is removed or its link cache is temporarily unavailable, preserving section, project, and action GUIDs.
- Keep the existing section when a previously unresolved Area link starts resolving to a note.
- Distinguish same-named areas by their note references. Ask for a full path when a short link matches several existing sections.
- Add paginated section task checks and an API for removing empty sections.

## 1.4.1 — 2026-10-29

- Expand hierarchy cards into name lists; show an input only after clicking Rename on a row.
- Prefill the current name, support Enter to save and Esc to cancel, and show save/cancel buttons while editing.
- Offer compact search for groups and projects with more than 10 entries, with scrollable lists.
- Consolidate the project folder, extra sync scopes, and daily-note switch in connection settings.

## 1.4.0 — 2026-10-29

- Add extra task folders, note tags, and excluded folders, including body tags and subtags.
- Send ordinary note checkboxes to the vault task list without requiring project metadata.
- Share scope selection across discovery, previews, automatic listeners, single-task operations, and device transfers.
- Preserve project hierarchy, status updates from Feishu, original GUIDs, and automatic sync settings.
- Route Components entry points through the independent plugin and keep sync implementation in this repository.
- Simplify settings and help; add cross-platform packaging, release checks, and GitHub Actions.

## 1.3.0

- Introduce an independent Obsidian plugin panel, settings, commands, and background sync.
- Reuse existing project and action associations and encrypted local settings.
