# Feishu Task Sync

**English** | [简体中文](README.zh-CN.md)

[Download](https://github.com/LLLLAAAA2333/feishu-task-sync/releases/latest) · [Report an issue](https://github.com/LLLLAAAA2333/feishu-task-sync/issues)

Sync Obsidian projects and Markdown tasks with Feishu. Complete or reopen a task on either side.

The plugin includes a dedicated panel, settings, commands, and background sync. Install the three release files to use it on Obsidian desktop 1.7.2 or later. The interface currently uses Chinese.

## Install and connect

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/LLLLAAAA2333/feishu-task-sync/releases/latest) into `.obsidian/plugins/feishu-task-sync/` in your vault. You can also extract `Feishu-Task-Sync-1.5.2-Desktop.zip` into that directory.
2. Enable **Feishu Task Sync** in Obsidian's community plugin settings.
3. Create a custom enterprise app in the [Feishu developer console](https://open.feishu.cn/app). Enable these app permissions: `task:task:write`, `task:tasklist:write`, `task:section:write`, and `task:custom_field:write`. Publish the app version.
4. Enter the App ID, App Secret, and the receiving user's Open ID in the plugin settings. You can copy the Open ID from the [API Explorer](https://open.feishu.cn/api-explorer) for the same app.
5. Save the settings, open the sync overview, create the vault task list, preview the sync scope, and enable automatic sync.

Click the cloud icon in the ribbon or run **打开飞书任务面板** (Open Feishu task panel). Run **立即同步任务到飞书** (Sync tasks to Feishu now) for an immediate sync. Background sync continues when the panel is closed and stops when the vault closes.

Expand a hierarchy card in the overview to see its names. Click **改名** (Rename) on a row to edit its Feishu display name. The next sync applies the saved name; the note's filename stays the same.

## Sync scope

Project mode is the default. Add other sources under **Settings → Feishu Task Sync → 同步范围** (Sync scope).

| Source | Selection | Destination in Feishu |
| --- | --- | --- |
| Projects | Notes tagged `project` in the project folder | Vault task list → Area section → project parent task → action subtasks |
| Extra folders | One vault-relative path per line, including subfolders | Checkboxes go directly into the vault task list |
| Extra note tags | Comma-separated tags, such as `action, meeting` | Checkboxes in matching notes go directly into the vault task list |
| Daily notes | Enable **日记行动** in connection settings and set the folder and task-list GUID | A separate daily task list |

A note is included if it matches an extra folder or tag. Tags can appear in properties or the note body; parent tags match subtags, so `action` also matches `action/next`. Excluded folders take precedence over every source. If scopes overlap, project and daily notes keep their existing behavior.

For example, add `Meetings` as an extra folder or tag a note `#action` to sync its regular checkboxes. Ordinary task notes do not need frontmatter, `status`, or `area`.

Removing a note from the scope stops syncing it. Adding it back reuses its existing task associations. The scope preview shows the project, extra-note, and action totals.

## Project mode

The default project folder is `50_Tasks`; you can choose another folder. Example project note:

```markdown
---
tags: [project]
status: doing
area: "[[work]]"
---
## Next actions
- [ ] Draft a proposal
- [ ] Schedule a discussion
```

Project status accepts `todo`, `doing`, `done`, and `canceled`. Leave `area` empty or link one area note. Rename projects, Area sections, and the vault task list from the overview.

The plugin syncs checkbox titles, descriptions, and completion states while retaining parent–child relationships. Project status and action status are independent. Reopening a completed project in Feishu restores its previous `todo` or `doing` status. When first sending an individual task, you can set a due time and reminder; times use the Shanghai time zone.

When edits on both sides conflict, the panel lets you compare and choose. If a task's creation result has not been confirmed, association recovery can reconnect the original task.

## Upgrade and use across devices

Starting with 1.5.0, the plugin ID and repository name are `feishu-task-sync`, and the display name is **Feishu Task Sync**. These rename steps apply to JH Wang's **飞书任务联动** releases 1.3.x–1.4.x.

1. Close Obsidian.
2. Rename `.obsidian/plugins/feishu-sync/` to `.obsidian/plugins/feishu-task-sync/`. Keep `data.json` and replace the three release files with the new ones.
3. Reopen Obsidian and enable **Feishu Task Sync**. If you had keyboard shortcuts, reassign them to the new plugin's commands in Hotkeys.

When installing from source, the install script below migrates the directory, enabled state, UI preferences, and shortcuts, and backs up the old plugin. Connection settings, automatic sync, vault identity, sections, and Feishu task GUIDs carry over.

For later updates, replace the three release files in the new directory and reload the plugin.

To switch devices, disable automatic sync on the original device and export a transfer package. Import it on the new device, enter the App Secret, check associations, and enable automatic sync. The package includes the sync scope and task associations. Use a fresh package for each switch and run automatic sync for a vault on one device at a time.

Existing Components dashboards can call the plugin as optional entry points. The plugin installs and runs independently of Components.

## Connection and storage

The plugin requires a Feishu account and a custom enterprise app. It calls `https://open.feishu.cn/open-apis` to sync task titles, descriptions, times, states, and association identifiers from the selected notes.

To retain existing device settings, local data stays outside the vault at its original path:

```text
~/.config/obsidian-feishu-sync/<first 24 hex characters of the vault absolute path's SHA-256>/
  config.json
  records.json
  backups/
```

The App Secret uses system encryption and is excluded from transfer packages. The plugin directory's `data.json` stores UI preferences. If you move a vault to another path, restore its identity and associations with a transfer package. The plugin collects no telemetry.

## Development and releases

Requires Node.js 22 or later.

```bash
npm ci
npm test
npm run check-release
npm run package
npm run install-vault -- "/absolute/path/to/vault"
```

Close Obsidian before running the install script, then reopen it. The script backs up the previous plugin and preserves UI preferences. If it finds this project's old ID, it also migrates enabled state and shortcuts. Pass a custom Obsidian configuration directory as the second argument. Use `npm run dev` during development; after updating a build under the same ID, run `obsidian plugin:reload id=feishu-task-sync`.

- `src/`: plugin lifecycle, panel, and settings.
- `lib/`: scope selection, task parsing, Feishu API, sync, scheduling, and device transfer.
- `tests/`: sync regressions, installation, and lifecycle tests.
- `scripts/`: build, install, packaging, and release checks.

Optional dashboards access `app.plugins.plugins['feishu-task-sync']`. The `service`, `openPanel`, `syncNow`, and `getAutoStatus` interfaces remain available after the rename.

GitHub Actions runs tests on all three desktop platforms. Pushing a tag that matches the manifest version publishes the plugin files, ZIP, and checksums. See the [publishing guide](PUBLISHING.md) for the first community directory submission.

## Documentation

[Changelog](CHANGELOG.md) · [Current release notes](RELEASE_NOTES.md) · [Validation](VALIDATION.md)

## License

[MIT](LICENSE). The interface uses React, React DOM, and Scheduler; their MIT license notices are included in the release bundle.
