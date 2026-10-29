# Feishu Task Sync 1.5.1

**English** | [简体中文](https://github.com/LLLLAAAA2333/feishu-task-sync/blob/1.5.1/RELEASE_NOTES.zh-CN.md)

Fix the community review error caused by removing workspace leaves during plugin unload. Disabling or reloading now preserves panel placement, and closing a view releases its React resources.

Settings are searchable on Obsidian 1.13 and later, with the existing settings form retained. Earlier Obsidian versions keep the same settings entry point. Browser timers and scoped CSS selectors improve compatibility, and the three installable release files include GitHub build provenance attestations.

Update `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/feishu-task-sync/` and reload the plugin. Existing settings, vault identity, task associations, and automatic sync are retained.

[Installation and upgrade guide](https://github.com/LLLLAAAA2333/feishu-task-sync/blob/1.5.1/README.md)
