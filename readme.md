# koishi-plugin-menu-edit

[![npm](https://img.shields.io/npm/v/koishi-plugin-menu-edit?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-menu-edit)

QQ 机器人菜单编辑面板。在 Koishi Console 中以 `/menu-edit` 按 Bot Instance（QQ AppID）编辑
Private Menu 与 Group Panel 的 Panel Configuration，Draft 自动保存到数据目录下的 JSON，
Publish 单独触发。

当前纵向切片（issue #3 / #4）提供 Private Menu 与 Group Panel 全链路：

- 只列出 `bot.platform === 'qq'` 的 Bot Instance，并按 AppID 隔离 Draft、revision 与写入队列。
- 一键导入当前 Private Menu：读取失败会显示错误并允许重试，不用空配置静默覆盖 Draft。
- 结构化编辑器支持 `send_message`、`link`、`menu`、`switch` 四类条目：新增、删除、复制、
  拖拽/上下移排序、展开编辑与子菜单编辑；一级按钮上限 10、子菜单上限 5。
- 可视化手机预览：Private Menu Strip 横向滚动不换行，`send_message` / `link` / `menu`
  使用参考页图标，`switch` 显示灰/蓝状态点，点击 `menu` 打开底部 Menu Sheet；预览操作
  不修改 Draft，也不发送消息或打开链接。
- JSON 模式与结构化模式双向同步，未知字段在保存与 Publish 后原样保留。
- Publish Private Menu 通过 `setMenu` 整体覆盖写入平台：成功更新 Published Revision，
  失败（revision 冲突 / 硬校验错误 / 平台错误）保留 Draft 与旧 Published Revision。
- 携带 expected revision 的 Draft 保存；过期 revision 返回 `revision-conflict`，可选择重载或强制覆盖。
- Discard Draft（需确认），恢复 Published Revision；未发布时回退到导入内容。
- Group Panel 首次导入：零个候选时创建并接管 group/all Managed Panel，一个候选时自动接管，
  多个候选时列出 panel ID、备注、更新时间与条目摘要，由用户选择唯一接管对象。
- Group Panel 结构化编辑器支持 command / link 条目的名称、描述、链接与 `only_admin` 编辑，
  以及新增、删除、复制、展开与拖拽/上下移排序；条目上限 20，超出时阻止 Publish。
- Group Panel 手机预览按编辑区顺序展示名称、描述与管理员标记。
- Publish Group Panel 优先修改 Managed Panel，不存在时创建；发布前列出其他 group Panel 并要求
  用户确认，Managed Panel 写入成功后再逐项删除其他面板。
- Group Panel 连续平台写入按 AppID 串行并强制至少间隔 6500ms，并发请求无法绕过；
  清理部分失败时返回 partial 并持久化待清理 panel ID。
- 平台返回 QQ 错误码 `40030013`（条目数量超限）时返回 `quantity-limit`，保留 Draft 与旧
  Published Revision。
- 页面与所有读取/写入 RPC 均要求 `authority: 4`。

状态文件位于 `<baseDir>/data/menu-edit/<encoded-appId>.json`，采用按 AppID 串行化写入、
临时文件替换与 `.bak` 备份。

Drift 检测与统一发布确认（issue #5）、待清理显式重试（issue #6）等尚未接入。

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
