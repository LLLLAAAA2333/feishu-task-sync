# Feishu Task Sync

[English](README.md) | **简体中文**

[下载](https://github.com/LLLLAAAA2333/feishu-task-sync/releases/latest) · [问题反馈](https://github.com/LLLLAAAA2333/feishu-task-sync/issues)

将 Obsidian 中的项目和 Markdown 任务同步到飞书，在任一端完成或重开行动。

插件提供独立面板、设置页、命令和后台同步。安装三个发行文件即可使用，适用于 Obsidian 桌面版 1.7.2 及以上。

## 安装与连接

1. 下载 [最新 Release](https://github.com/LLLLAAAA2333/feishu-task-sync/releases/latest) 中的 `main.js`、`manifest.json`、`styles.css`，放入仓库的 `.obsidian/plugins/feishu-task-sync/`。也可以解压 `Feishu-Task-Sync-1.5.1-Desktop.zip` 到这个目录。
2. 在 Obsidian 第三方插件中启用「Feishu Task Sync」。
3. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，开通应用身份权限：`task:task:write`、`task:tasklist:write`、`task:section:write`、`task:custom_field:write`，然后发布应用版本。
4. 在插件设置填写 App ID、App Secret 和接收任务用户的 Open ID。Open ID 可从同一应用的 [API 调试台](https://open.feishu.cn/api-explorer)复制。
5. 保存设置，打开同步概览，建立仓库清单，预览同步范围，再开启自动同步。

点击左侧云图标或执行「打开飞书任务面板」进入面板。执行「立即同步任务到飞书」可立即同步。面板关闭后，后台同步继续运行；关闭仓库时停止。

概览中的层级卡片展开为名称列表。点击某一行的“改名”编辑飞书显示名称，保存后在下次同步生效；笔记文件名保持原样。

## 同步范围

默认保留项目模式。额外范围在「设置 → Feishu Task Sync → 同步范围」中添加。

| 来源 | 选择方式 | 飞书中的位置 |
| --- | --- | --- |
| 项目 | 项目目录内带 `project` 标签的笔记 | 仓库清单 → Area 分组 → 项目父任务 → 行动子任务 |
| 额外文件夹 | 每行一个仓库相对路径，包含子文件夹 | checkbox 直接进入仓库清单 |
| 额外笔记标签 | 逗号分隔，例如 `action, meeting` | 匹配笔记中的 checkbox 直接进入仓库清单 |
| 日记 | 在连接设置的“日记行动”中启用，并设置目录、清单 GUID | 单独的日记清单 |

额外文件夹和标签满足任一条件即可纳入。标签支持笔记属性、正文标签及子标签，例如 `action` 也匹配 `action/next`。排除文件夹优先于全部来源。项目、日记与额外范围重叠时，仍保留项目或日记原来的处理方式。

例如，把 `Meetings` 加入额外文件夹，或给笔记加上 `#action`，就能同步里面的普通 checkbox。普通笔记可以没有 frontmatter，不要求 `status` 或 `area`。

移出范围后停止同步该笔记；重新加入会继续使用已有任务关联。范围预览显示项目数、额外笔记数及行动总数。

## 项目模式

项目目录默认使用 `50_Tasks`，可改为自己的目录。项目笔记示例：

```markdown
---
tags: [project]
status: doing
area: "[[work]]"
---
## 下一步行动
- [ ] 整理方案
- [ ] 约时间讨论
```

项目状态支持 `todo`、`doing`、`done`、`canceled`。`area` 可留空或关联一个领域笔记。项目名称、Area 名称和仓库清单名称可在概览中修改。

插件同步普通 checkbox 的标题、说明和完成状态，保留原来的父子任务关系。项目状态与行动状态独立；在飞书重开已完成项目时，会恢复它先前的待办或进行中状态。单条首次发送可以设置截止时间和提醒，时间按上海时区填写。

两端同时编辑产生冲突时，面板提供对比和选择。创建结果暂未确认的任务，可通过恢复关联继续使用原任务。

## 升级与跨设备

1.5.0 起，插件 ID 和仓库名改为 `feishu-task-sync`，显示名称为 **Feishu Task Sync**。以下改名步骤适用于 JH Wang 发布的「飞书任务联动」1.3.x–1.4.x。

1. 关闭 Obsidian。
2. 将 `.obsidian/plugins/feishu-sync/` 改名为 `.obsidian/plugins/feishu-task-sync/`，保留其中的 `data.json`，再覆盖三个新发行文件。
3. 重新打开 Obsidian，启用 **Feishu Task Sync**。如果原来设置过快捷键，在快捷键设置中重新分配给新插件命令。

从源码安装时，下面的安装脚本会完成目录、启用状态、界面偏好和快捷键迁移，并备份旧插件。现有配置、自动同步开关、仓库身份、分组和飞书任务 GUID 直接沿用。

后续升级只需替换新目录中的三个发行文件并重载插件。

在原设备关闭自动同步后，导出接入包；新设备导入后填写 App Secret、检查关联，再启用自动同步。接入包包含同步范围和任务关联。每次切换使用最新接入包，同一仓库在一台设备运行自动同步。

旧 Components 仪表盘可以作为可选入口调用插件；插件的安装和运行均独立于 Components。

## 连接与存储

插件需要飞书账号和企业自建应用，调用 `https://open.feishu.cn/open-apis` 同步所选笔记的任务标题、说明、时间、状态和关联标识。

为沿用已有设备配置，插件在仓库之外保存本机数据：

```text
~/.config/obsidian-feishu-sync/<仓库绝对路径的 SHA-256 前 24 位>/
  config.json
  records.json
  backups/
```

App Secret 使用系统加密存储；接入包不包含密钥。插件目录的 `data.json` 保存界面偏好。仓库移动到新路径时，使用接入包恢复原身份和关联。插件不收集遥测数据。

## 开发与发布

需要 Node.js 22 或以上版本。

```bash
npm ci
npm test
npm run check-release
npm run package
npm run install-vault -- "/absolute/path/to/vault"
```

运行安装脚本前关闭 Obsidian，安装后重新打开。脚本备份旧插件并保留界面偏好；识别到本项目的旧 ID 时，还会迁移启用状态和快捷键。自定义 Obsidian 配置目录可作为第二个参数传入。开发时运行 `npm run dev`；更新同一 ID 的构建后可执行 `obsidian plugin:reload id=feishu-task-sync`。

- `src/`：插件生命周期、面板与设置。
- `lib/`：范围选择、任务解析、飞书 API、同步、调度和接入。
- `tests/`：同步回归、安装包、生命周期测试。
- `scripts/`：构建、安装、打包和发行校验。

可选仪表盘从 `app.plugins.plugins['feishu-task-sync']` 获取插件，改名前的 `service`、`openPanel`、`syncNow` 和 `getAutoStatus` 接口继续沿用。

GitHub Actions 在三个桌面平台执行测试。推送与 manifest 版本一致的标签后，发布工作流上传插件文件、ZIP 和校验和。首次提交社区目录的步骤见 [发布指南](PUBLISHING.zh-CN.md)。

## 相关文档

[更新记录](CHANGELOG.zh-CN.md) · [当前发行说明](RELEASE_NOTES.zh-CN.md) · [验证记录](VALIDATION.zh-CN.md)

## 许可证

[MIT](LICENSE)。界面使用 React、React DOM 和 Scheduler；它们的 MIT 许可声明包含在发行文件中。
