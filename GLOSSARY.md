# Menu Editing

QQ 机器人菜单在 Koishi 控制台中的配置、发布与状态管理上下文。

## Language

**Menu Edit Panel**:
用于按 QQ 机器人管理菜单配置的控制台页面。
_Avoid_: 指令编辑器, 菜单后台

**Private Menu**:
QQ 私聊场景中展示的自定义菜单。
_Avoid_: 快捷菜单, 私人菜单

**Group Panel**:
QQ 群聊场景中展示的指令面板。
_Avoid_: 群菜单, 指令面板配置

**Private Menu Item**:
Private Menu 中的单个条目，可发送消息、打开链接、切换开关或展开子菜单。
_Avoid_: 快捷项, 菜单按钮

**Panel Item**:
Group Panel 中的单个指令或链接条目。
_Avoid_: 指令卡, 面板按钮

**Bot Instance**:
一组以同一 QQ 应用身份运行的机器人配置边界。
_Avoid_: 账号, 机器人

**Panel Configuration**:
Menu Edit Panel 中由用户维护并准备下发的菜单内容。
_Avoid_: 指令列表, 菜单数据

**Draft**:
用户正在编辑、尚未下发到平台的 Panel Configuration。
_Avoid_: 临时配置, 未保存内容

**Published Revision**:
最近一次成功由 Menu Edit Panel 发布到平台的 Panel Configuration。
_Avoid_: 线上版本, 当前菜单

**Publish**:
将 Draft 下发到某个 Bot Instance 的 Private Menu 和 Group Panel，并把成功结果记录为 Published Revision。
_Avoid_: 同步, 保存, 上架

**Drift**:
平台当前菜单与 Published Revision 不一致的状态。
_Avoid_: 差异, 变更

**Platform State**:
从 QQ API 实时读取的 Private Menu 与 Group Panel 内容。
_Avoid_: 线上状态, 远端配置

**Managed Panel**:
某个 Bot Instance 中被 Menu Edit Panel 接管并可发布的唯一 Group Panel。
_Avoid_: 目标面板, 主面板

## Private Menu UI

**Private Menu Strip**:
私聊菜单在消息输入栏上方展示的一条横向按钮组。
_Avoid_: 菜单栏, 快捷按钮条

**Send Button**:
点击后使用指定消息内容的 Private Menu Item。
_Avoid_: 发送项, 消息按钮

**Link Button**:
点击后打开指定链接的 Private Menu Item。
_Avoid_: 跳转项, URL 按钮

**Menu Button**:
点击后打开 Menu Sheet 的 Private Menu Item。
_Avoid_: 父菜单, 子菜单入口

**Switch Button**:
没有图标、通过状态点表示当前开关状态的 Private Menu Item。
_Avoid_: 开关项, 状态按钮

**Menu Sheet**:
由 Menu Button 从底部展开、用于展示子菜单项的面板。
_Avoid_: 子菜单弹窗, 菜单抽屉
