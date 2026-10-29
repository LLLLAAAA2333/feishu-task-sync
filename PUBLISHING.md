# Publishing

**English** | [简体中文](PUBLISHING.zh-CN.md)

## GitHub releases

1. Use [LLLLAAAA2333/feishu-task-sync](https://github.com/LLLLAAAA2333/feishu-task-sync), with `main` as the default branch. The plugin ID is `feishu-task-sync` and the display name is **Feishu Task Sync**.
2. Update the version in `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`. Update both languages of the changelog, release notes, and validation record.
3. Run `npm ci`, `npm test`, `npm run check-release`, and `npm run package`.
4. Commit, create a tag matching the manifest version exactly, such as `1.5.0`, and push the branch and tag.
5. The release workflow uploads `main.js`, `manifest.json`, `styles.css`, `Feishu-Task-Sync-<version>-Desktop.zip`, and `SHA256SUMS.txt`. The release notes link to their Chinese translation.

The repository includes source, tests, bilingual documentation, and an MIT license. Local evidence, account settings, task associations, and build output stay outside version control.

## Obsidian community directory

After the GitHub release is available:

1. Sign in at [Obsidian Community](https://community.obsidian.md) and connect your GitHub account in your profile.
2. Add a plugin using `https://github.com/LLLLAAAA2333/feishu-task-sync` as the repository. The directory reads `manifest.json` from the default branch.
3. Review the automated checks. Address errors in the repository and publish a new release when needed, then select **Publish** in the directory.

After publication, users can install and update the plugin inside Obsidian. Later versions are distributed through GitHub releases without a new directory submission. The release tag must match the manifest version, and its assets must include `main.js`, `manifest.json`, and this plugin's `styles.css`.

References: [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) · [plugin submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).

## Documentation languages

`README.md` is the English entry point; `README.zh-CN.md` is the Chinese entry point. Publishing, changelog, release notes, and validation use the same `.md` / `.zh-CN.md` pairs. Each page links to its counterpart at the top. Update both languages together when behavior or installation steps change.
