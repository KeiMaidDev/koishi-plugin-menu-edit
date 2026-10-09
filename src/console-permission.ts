/**
 * Menu Edit Panel 的权限门槛。
 *
 * 页面入口和所有读取/写入 RPC 共用同一个值（与 Koishi Console 的「插件配置」页同级）。
 * 抽成常量是为了让页面、服务端监听器和测试引用同一处来源，避免权限漂移。
 */
export const CONSOLE_PANEL_AUTHORITY = 4
