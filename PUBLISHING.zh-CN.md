# 发布指南

[English](PUBLISHING.md) | **简体中文**

## GitHub Release

1. 发布仓库为 [LLLLAAAA2333/feishu-task-sync](https://github.com/LLLLAAAA2333/feishu-task-sync)，默认分支为 `main`。插件 ID 为 `feishu-task-sync`，显示名称为 **Feishu Task Sync**。
2. 更新 `manifest.json`、`package.json`、`package-lock.json` 和 `versions.json` 的版本信息。同时更新中英文的更新记录、发行说明与验证记录。
3. 执行 `npm ci`、`npm test`、`npm run check-release` 和 `npm run package`。
4. 提交后创建与 manifest 版本完全一致的标签，例如 `1.5.2`，推送分支和标签。
5. 发布工作流上传 `main.js`、`manifest.json`、`styles.css`、`Feishu-Task-Sync-<版本>-Desktop.zip` 和 `SHA256SUMS.txt`。Release 说明顶部提供中文版本链接。三个插件文件附带 GitHub 构建来源证明；ZIP 和校验和用于手动安装。

仓库包含源码、测试、中英文文档和 MIT 许可证。本机证据、账号配置、关联记录和构建目录均不进入版本控制。

## Obsidian 社区目录

GitHub Release 发布后：

1. 登录 [Obsidian Community](https://community.obsidian.md)，在个人资料中绑定 GitHub。
2. 添加插件，仓库填写 `https://github.com/LLLLAAAA2333/feishu-task-sync`。社区目录会读取默认分支的 `manifest.json`。
3. 查看自动检查结果。Error 会阻止安装；修正后先用 **Review branch** 预检，再发布新版本。可用 **Check for new releases** 更新版本、用 **Request review** 触发复审，最后选择 **Publish**。

上架后，用户即可在 Obsidian 内安装和更新。后续版本通过 GitHub Release 分发，无需重新提交目录。Release 标签须与 manifest 版本一致，附件包含 `main.js`、`manifest.json` 和本插件的 `styles.css`。

参考：[官方提交步骤](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) · [插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)。

## 文档语言

`README.md` 为英文入口，`README.zh-CN.md` 为中文入口。发布指南、更新记录、发行说明和验证记录也采用 `.md` / `.zh-CN.md` 成对组织，每页顶部链接到另一种语言。功能或安装步骤变化时，同时更新两个版本。
