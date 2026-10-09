/**
 * Panel Configuration 的结构化归一。
 *
 * 这里只做「是不是一份可以保存的配置」这一层结构校验：非法 JSON 由客户端在解析时拦截，
 * 菜单项的字段级校验留给 Publish 前的 validation。未知字段一律保留，结构化编辑不会把它们删掉。
 */
import {
  emptyGroupPanel,
  emptyPrivateMenu,
  emptyPanelConfiguration,
  type GroupPanelConfiguration,
  type PanelConfiguration,
  type PrivateMenuConfiguration,
} from './types'

export class MenuConfigurationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'MenuConfigurationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePrivateMenu(value: unknown): PrivateMenuConfiguration {
  if (value === undefined || value === null) return emptyPrivateMenu()
  if (!isRecord(value)) {
    throw new MenuConfigurationError('privateMenu', 'privateMenu 必须是对象。')
  }
  const rawItems = value.items
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
    throw new MenuConfigurationError('privateMenu.items', 'privateMenu.items 必须是数组。')
  }
  return { ...value, items: Array.isArray(rawItems) ? rawItems : [] }
}

function normalizeGroupPanel(value: unknown): GroupPanelConfiguration {
  if (value === undefined || value === null) return emptyGroupPanel()
  if (!isRecord(value)) {
    throw new MenuConfigurationError('groupPanel', 'groupPanel 必须是对象。')
  }
  const rawItems = value.items
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
    throw new MenuConfigurationError('groupPanel.items', 'groupPanel.items 必须是数组。')
  }
  return { ...value, items: Array.isArray(rawItems) ? rawItems : [] }
}

/**
 * 接受 JSON 解析后的任意值，返回可持久化的 Panel Configuration。
 * 顶层与两个 surface 的未知字段都会保留。
 */
export function normalizePanelConfiguration(value: unknown): PanelConfiguration {
  if (value === undefined || value === null) return emptyPanelConfiguration()
  if (!isRecord(value)) {
    throw new MenuConfigurationError('$', 'Panel Configuration 必须是 JSON 对象。')
  }
  return {
    ...value,
    privateMenu: normalizePrivateMenu(value.privateMenu),
    groupPanel: normalizeGroupPanel(value.groupPanel),
  }
}

