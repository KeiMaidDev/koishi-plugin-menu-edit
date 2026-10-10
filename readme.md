# koishi-plugin-menu-edit

[![npm](https://img.shields.io/npm/v/koishi-plugin-menu-edit?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-menu-edit)

QQ 机器人菜单编辑面板。在 Koishi Console 中以 `/menu-edit` 按 Bot Instance（QQ AppID）编辑
Private Menu 与 Command Panel 的 Panel Configuration，Draft 自动保存到数据目录下的 JSON，
Publish 单独触发。

当前纵向切片（issue #3 / #4 / #8）提供 Private Menu 与 Command Panel 全链路：

- 只列出 `bot.platform === 'qq'` 的 Bot Instance，并按 AppID 隔离 Draft、revision 与写入队列。
- 一键导入当前 Private Menu：读取失败会显示错误并允许重试，不用空配置静默覆盖 Draft。
- Private Menu 结构化编辑器支持 `send_message`、`link`、`menu`、`switch` 四类条目：新增、
  删除、复制、拖拽/上下移排序、展开编辑与子菜单编辑；一级按钮上限 10、子菜单上限 5。
- Private Menu 手机预览：与 Command Panel 预览共用手机聊天外壳；Strip 横向滚动不换行，
  `send_message` / `link` / `menu` 使用参考页图标，`switch` 关闭时显示灰色状态点、开启时
  按钮填充、文字与状态点一起转蓝；点击 `menu` 打开带拖拽条、父项图标与子项分隔线的
  Menu Sheet。预览操作不修改 Draft，也不发送消息或打开链接。
- Command Panel 对齐官方 `/v2/panels`：Panel Item 自带本地字段 `scopes`（channel / dm /
  group / c2c 可多选），Draft 只保留一份条目列表，发布时按场景派生各场景内容并剥掉本地
  `scopes`；平台返回的未知字段原样保留。
- Command Panel 首次导入按场景分页拉取 all 面板候选：零候选留空且不预创建，单候选自动接管，
  多候选时由用户为每个场景选择唯一接管对象；跨场景同名且 `desc` / `only_admin` / `link`
  完全一致的条目合并为一条并把 `scopes` 取并集，同名但字段不一致时保留为多条并报告冲突。
  同场景其他 all 面板记为待清理对象，既有 `specific` 面板只在导入结果里提示且不会触碰。
- Command Panel 结构化编辑器支持 command / link 条目；指令名仅 command 固定 `/` 前缀，
  command 显示指令介绍，link 只编辑链接；权限菜单、使用场景多选以及新增、删除、复制、
  展开与拖拽/上下移排序均可用，新建条目不默认勾选使用场景。每个使用场景独立 20 条上限。
- Publish Command Panel 按场景派生内容，逐场景修改或创建 all 受管面板；发布前按场景列出
  其他 all 面板并要求用户确认，写入成功后逐项删除；场景没有条目时删除该场景受管面板。
  `specific` 面板既不接管也不删除；某个场景失败不阻断其他场景，结果按场景聚合为
  成功、失败或 partial。
- Command Panel 连续平台写入跨场景按 AppID 串行并强制至少间隔 6500ms；清理部分失败时该
  场景返回 partial 并持久化待清理 panel ID。
- JSON 模式与结构化模式双向同步，未知字段在保存与 Publish 后原样保留。
- Publish Private Menu 通过 `setMenu` 整体覆盖写入平台：成功更新 Published Revision，
  失败（revision 冲突 / 硬校验错误 / 平台错误）保留 Draft 与旧 Published Revision。
- 携带 expected revision 的 Draft 保存；过期 revision 返回 `revision-conflict`，可选择重载或强制覆盖。
- Discard Draft（需确认），恢复 Published Revision；未发布时回退到导入内容。
- 读到 `schemaVersion: 1` 的状态文件时自动迁移：`draft.groupPanel` → `draft.commandPanel`
  （条目补 `scopes: ['group']`），`published.groupPanel` → `published.commandPanels.group`，
  其余场景从空开始；读到未知的更高版本时拒绝静默覆盖并提示。
- 平台返回 QQ 错误码 `40030013`（条目数量超限）时返回 `quantity-limit`，保留 Draft 与旧
  Published Revision。
- 发布安全层（issue #5）：结构化与 JSON 模式共用同一套校验；非法 JSON、数量超限、
  必填字段缺失、类型错误、非 `https://` 链接与空使用场景阻止 Publish，描述为空、
  同场景重名、重复 switch ID 与导入同名冲突以警告形式要求确认。
- 「刷新平台状态」手动读取 Private Menu 与四个使用场景的平台内容，并按
  未发布 / 一致 / 有变化 / 面板缺失 / 读取失败展示 Drift；平台读取失败不影响其他场景。
- Drift 不阻止发布，但存在 Drift 时必须先确认；Publish 携带 expected revision，
  Draft 被其他页面改写时发布失败并要求重新确认。
- 页面与所有读取/写入 RPC 均要求 `authority: 4`。

状态文件位于 `<baseDir>/data/menu-edit/<encoded-appId>.json`，采用按 AppID 串行化写入、
临时文件替换与 `.bak` 备份。

待清理显式重试（issue #6）等尚未接入。

## 开发

在 Koishi 工作区根目录运行：

```sh
# 类型检查
npx tsc -p external/menu-edit/tsconfig.json
npx tsc -p external/menu-edit/tsconfig.client.json

# 行为测试（fake BotRegistry + fake MenuPlatform + 真实 JSON store + 隔离临时目录）
npx tsx --test "external/menu-edit/tests/*.test.ts"

# 构建服务端与 Console 客户端
npx yakumo build external/menu-edit
```
