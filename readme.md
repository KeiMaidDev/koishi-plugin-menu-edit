# koishi-plugin-menu-edit

[![npm](https://img.shields.io/npm/v/koishi-plugin-menu-edit?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-menu-edit)

> [!NOTE]
> 本项目由 AI 工具参与开发，平台接口变化和边缘场景可能仍有问题；欢迎提交 Issue 或 PR。

面向 Koishi Console 的 QQ 机器人菜单编辑插件。

## 功能

- 按 QQ Bot Instance 隔离 Draft、Published Revision 与写入队列，多机器人互不串扰。
- 编辑并发布 Private Menu：支持 `send_message`、`link`、`menu`、`switch`，一级按钮最多 10 个，`menu` 子菜单最多 5 项。
- 编辑并发布 Command Panel：按 QQ频道、频道私信、QQ群、消息列表四个使用场景下发，每个场景最多 20 项。
- 首次导入按场景分页拉取 all 面板：零候选留空、单候选自动接管、多候选由用户选择；跨场景同名且字段一致的条目自动合并。
- 结构化编辑器与 JSON 模式双向同步，平台返回的未知字段在保存和发布后原样保留。
- 手机预览还原 QQ 私聊菜单与指令面板，支持场景切换、Menu Sheet 和开关预览，不触发真实平台动作。
- Publish 前统一校验、Drift 检测与待清理面板确认；硬错误阻止发布，警告和 Drift 需要显式确认。
- Private Menu 与各场景指令面板分别写入、分别报告结果，允许部分成功；指令面板写入按 AppID 串行并强制至少间隔 6500ms。
- 状态文件按 AppID 保存，支持 revision 冲突检测、原子替换、`.bak` 备份与 `schemaVersion: 1 → 2` 迁移。
- 页面与所有读取、写入 RPC 均要求 `authority: 4`。

## 安装

在 Koishi 控制台的插件市场中搜索并安装：

```text
menu-edit
```

安装后启用插件，并确认以下服务可用：

- `console`：提供 Console 页面与 RPC。
- [adapter-qq-crack](https://github.com/koishi-shangxue-plugins/koishi-plugin-adapter-qq-crack)：提供 QQ Bot Instance 和 `/v2/menu`、`/v2/panels` 内部接口。
- 至少一个已登录的 QQ Bot Instance。

打开 Console 侧边栏的「机器人菜单」页面（路径 `/menu-edit`）即可使用。本插件没有额外配置项；页面和所有 RPC 都要求 `authority: 4`，普通用户无法访问或调用。

## 运行要求

- Koishi 4.18.7 或兼容版本。
- 可用的 Koishi Console。
- 使用 adapter-qq-crack 接入的 QQ 机器人。
- 数据目录可写；状态文件位于 `<baseDir>/data/menu-edit/<encoded-appId>.json`。

> [!WARNING]
> Publish 不提供跨 Private Menu 与 Command Panel 的平台事务。四个使用场景串行写入并受 6500ms 节流限制，一次完整发布可能超过 20 秒；页面会分别报告成功、失败与 partial 结果。

## 使用

### 编辑对象

| 对象 | 生效场景 | 支持的条目 | 数量限制 |
| --- | --- | --- | --- |
| Private Menu | 私聊 | `send_message` / `link` / `menu` / `switch` | 一级最多 10 项；`menu` 子菜单最多 5 项 |
| Command Panel | QQ频道 / 频道私信 / QQ群 / 消息列表 | `command` / `link` | 每个场景最多 20 项 |

页面分为「私聊菜单」与「指令面板」两个 tab。Private Menu 使用 `setMenu` 整体覆盖；Command Panel 按使用场景分别读写。

### 选择 Bot Instance

页面顶部只列出 `platform === 'qq'` 的 Bot Instance，并显示头像、名称、AppID 与在线状态。Draft、Published Revision、Drift 和写入队列均按 AppID 隔离。

机器人离线时，页面顶部显示离线告警条，导入与发布按钮禁用；保存、重新加载、丢弃草稿和刷新平台状态仍可使用。

### 导入平台现状

点击「导入私聊菜单」或「导入指令面板」会先用平台当前内容覆盖 Draft，并把导入结果记为 Published Revision。导入前每次都会确认。

- 导入私聊菜单：读取当前 Private Menu；读取失败会显示错误并允许重试，不会用空配置静默覆盖 Draft。
- 导入指令面板：按四个使用场景分页拉取 all 面板候选。某场景没有候选时留空且不预创建，只有一个候选时自动接管，多个候选时由用户为每个场景选择一个接管对象。
- 同场景其他 all 面板会记为待清理对象；`specific` 面板只在导入结果里提示，不会被接管或删除。
- 平台返回的 `command` 名称会省略开头的 `/`，插件在平台边界补回，编辑器与 Draft 始终保存 `/名字`。

### 编辑与预览

- Private Menu 编辑器支持新增、删除、复制、拖拽或上下移动排序、展开编辑和子菜单编辑。
- Command Panel 编辑器支持 command / link 条目；指令名固定 `/` 前缀，可编辑介绍、权限和使用场景。新建条目不默认勾选使用场景。
- 结构化模式与 JSON 模式双向同步。JSON 中无法识别的字段不会在保存时丢失。
- Private Menu 预览复刻手机私聊菜单条：`send_message` / `link` / `menu` / `switch` 使用对应图标，点击 `menu` 会打开 Menu Sheet。
- Command Panel 预览复刻手机聊天界面，可在四个使用场景之间切换，只显示当前场景的条目。
- 预览是只读模拟，不会发送消息、打开链接或修改 Draft。

### 发布

1. 确认 Draft 内容无误后点击「发布」。Publish 通过统一服务端入口编排 Private Menu 与四个使用场景的 Command Panel。
2. 发布前统一执行校验、Drift 检测与待清理面板检查，并在同一个确认框中按硬错误、警告、Drift 和待删除面板分区展示。
3. 硬错误会阻止发布；警告、Drift 和待清理面板必须由用户确认后才能继续。
4. Private Menu 通过 `setMenu` 整体覆盖；失败时保留 Draft 与旧 Published Revision。
5. Command Panel 优先修改场景的受管 all 面板，不存在时创建；写入成功后按确认结果删除同场景其他 all 面板。场景没有条目时删除该场景的受管面板。
6. 某个场景失败不会阻断其他场景。目标面板写入成功但清理失败时，该场景返回 partial，并把待清理 panel ID 持久化。
7. 发布携带 expected revision；如果 Draft 在发布期间被其他页面改写，发布会失败并要求重新加载或确认。

指令面板的连续平台写入按 AppID 串行，并强制至少间隔 6500ms。平台返回 `40030013` 时展示为条目数量超限；Draft 不会因此丢失，失败 surface 的旧 Published Revision 也不会被覆盖。

### 刷新平台状态与 Drift

点击「刷新平台状态」会手动读取 Private Menu 与四个使用场景的平台内容，并与 Published Revision 比较，显示以下状态：

- 尚未发布
- 一致
- 有变化
- 面板缺失
- 读取失败

Drift 不阻止发布，但存在 Drift 时必须先确认。平台读取失败只影响对应场景，不会覆盖其他场景的结果。

### 草稿与待清理恢复

Draft 保存会携带 expected revision；旧 revision 返回 `revision-conflict`，可选择重新加载服务端最新 Draft 或强制覆盖。「丢弃草稿」需要确认，会恢复 Published Revision；尚未发布时回退到导入内容。

某场景清理部分失败后，页面会显示「仍有待清理面板」和重试按钮。再次点击可继续清理已持久化的 panel ID，不需要重新发布。

状态文件采用按 AppID 串行化写入、临时文件替换和 `.bak` 备份。插件能自动迁移 `schemaVersion: 1` 的旧状态；读取到未知的更高版本时会拒绝静默覆盖。

## 已知限制

- QQ 平台没有版本 CAS，Publish 前检查无法完全消除并发覆盖窗口。
- 每个使用场景只维护一个受管 all 面板；确认后会删除该场景其他 all 面板，`specific` 面板不会被触碰。
- 四个场景串行写入加 6500ms 节流，最坏情况下一次 Publish 可能超过 20 秒。
- JSON 持久化不保证多进程或多实例共享同一数据目录时的强一致性。

## 项目结构

```text
menu-edit/
├─ client/               # Console 页面、结构化编辑器、手机预览与 RPC 客户端
├─ src/                  # 服务端插件、状态存储、平台边界、校验与发布编排
├─ tests/                # 导入、Drift、发布、状态文件等行为测试
├─ docs/                 # 设计文档、接口文档与 ADR
├─ lib/                  # 服务端构建产物
├─ dist/                 # Console 客户端构建产物
├─ package.json          # npm 与 Koishi 插件元数据
├─ tsconfig.json         # 服务端 TypeScript 配置
├─ tsconfig.client.json  # Console 客户端 TypeScript 配置
└─ readme.md             # 使用与开发文档
```

## 开发

在 Koishi 工作区根目录执行：

```sh
# 克隆源码
yarn clone https://github.com/KeiMaidDev/koishi-plugin-menu-edit

```

## 许可证

MIT
