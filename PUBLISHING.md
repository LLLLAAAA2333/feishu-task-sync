# 发布

## GitHub Release

1. 发布仓库为 [LLLLAAAA2333/feishu-sync](https://github.com/LLLLAAAA2333/feishu-sync)，默认分支使用 `main`。
2. 更新 `manifest.json`、`package.json`、`package-lock.json`、`versions.json` 和 `RELEASE_NOTES.md` 中的版本信息。
3. 执行 `npm ci && npm test && npm run check-release && npm run package`。
4. 提交后创建与 manifest 完全一致的标签，例如 `1.4.0`，推送分支和标签。
5. `release.yml` 自动上传 `main.js`、`manifest.json`、`styles.css`、安装 ZIP 和 SHA-256 校验和。

仓库包含源码、测试、README 和 MIT 许可证。本机证据、账号配置、关联记录和构建目录均不进入版本控制。

## Obsidian 社区目录

GitHub Release 发布后，在 [Obsidian Community](https://community.obsidian.md) 登录并绑定 GitHub，添加插件仓库，查看自动检查结果并提交发布。社区上架后，用户可以在 Obsidian 内安装和更新。

参考：[官方提交步骤](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、[插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)。社区目录会读取默认分支的 manifest，并使用对应版本的 GitHub Release 附件。
