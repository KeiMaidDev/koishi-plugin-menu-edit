# koishi-plugin-menu-edit

[![npm](https://img.shields.io/npm/v/koishi-plugin-menu-edit?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-menu-edit)

QQ 机器人菜单编辑面板。在 Koishi Console 中以 `/menu-edit` 按 Bot Instance（QQ AppID）编辑
Private Menu 与 Group Panel 的 Panel Configuration，Draft 自动保存到数据目录下的 JSON，
Publish 单独触发。

当前纵向切片（issue #3）提供 Private Menu 全链路：

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
- 页面与所有读取/写入 RPC 均要求 `authority: 4`。

状态文件位于 `<baseDir>/data/menu-edit/<encoded-appId>.json`，采用按 AppID 串行化写入、
临时文件替换与 `.bak` 备份。

Group Panel 全链路（issue #4）与 Drift / 发布确认（issue #5）尚未接入；结构化视图的
群聊面板标签页会提示，GROUP Panel 内容可先用 JSON 模式编辑。

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
