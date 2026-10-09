/**
 * Private Menu 的类型图标与文案。
 *
 * 图标 URL 来自设计文档第 11.2 节确认的 QQ 参考页资源；switch 没有图标，
 * 由 PhonePreview 用状态点表达。
 */
export const MENU_ITEM_ICON_URLS: Record<string, string> = {
  send_message: 'https://bot-resource-1251316161.file.myqcloud.com/menu_icon/send_msg_2.png',
  link: 'https://bot-resource-1251316161.file.myqcloud.com/menu_icon/link.png',
  menu: 'https://bot-resource-1251316161.file.myqcloud.com/menu_icon/submenu.png',
}

export const MENU_ITEM_TYPE_LABELS: Record<string, string> = {
  send_message: '发送消息',
  link: '打开链接',
  menu: '子菜单',
  switch: '开关',
}

/** 返回类型图标；switch 与未知类型没有图标。 */
export function iconFor(type: string): string | null {
  return MENU_ITEM_ICON_URLS[type] ?? null
}

export function labelFor(type: string): string {
  return MENU_ITEM_TYPE_LABELS[type] ?? (type || '未知类型')
}
