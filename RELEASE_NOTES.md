# Feishu Task Sync 1.5.0

**English** | [简体中文](https://github.com/LLLLAAAA2333/feishu-task-sync/blob/1.5.0/RELEASE_NOTES.zh-CN.md)

The plugin and repository are now **Feishu Task Sync** (`feishu-task-sync`). Documentation is available in English and Simplified Chinese, with a language switch at the top of every guide.

The installer migrates this project's previous plugin ID, UI preferences, enabled state, and keyboard shortcuts. Existing settings, automatic sync, vault identity, Area sections, and Feishu task GUIDs carry over. Project sync and optional folder/tag scopes keep their current behavior.

**New installation:** place `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/feishu-task-sync/`, then enable **Feishu Task Sync**.

**Upgrade from JH Wang's 飞书任务联动 1.3.x–1.4.x:** close Obsidian, rename the old `feishu-sync` plugin folder to `feishu-task-sync`, keep `data.json`, and replace the three release files. Reopen Obsidian and enable the renamed plugin. Reassign custom shortcuts if upgrading manually; the source installer migrates them automatically.

[Installation and upgrade guide](https://github.com/LLLLAAAA2333/feishu-task-sync/blob/1.5.0/README.md)
