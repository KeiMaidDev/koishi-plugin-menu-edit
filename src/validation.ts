/**
 * Draft 的校验规则（设计文档第 8 节）。
 *
 * 结构化模式与 JSON 模式共用这里的同一套规则：硬错误阻止 Publish，警告需要用户确认。
 * 结果使用稳定的 code 与可定位的 path，UI 与测试都只依赖这两者，不依赖文案。
 *
 * 平台契约（adapter-qq-crack `src/types.ts`）：MenuItem.switch 是 `{ switch_id, default }`
 * 对象，SubMenuItemType 只允许 `send_message` / `link`。
 */
import { panelItemBelongsTo, panelItemScopes, scopeItemCounts } from './command-panel'
import { isRecord } from './guards'
import {
  COMMAND_PANEL_ITEM_TYPES,
  COMMAND_PANEL_MAX_ITEMS,
  PANEL_SCOPE_LABELS,
  PANEL_SCOPES,
  PRIVATE_MENU_ITEM_TYPES,
  PRIVATE_MENU_MAX_ITEMS,
  PRIVATE_MENU_MAX_SUB_ITEMS,
  PRIVATE_MENU_SUB_ITEM_TYPES,
  type CommandPanelConfiguration,
  type PanelConfiguration,
  type PanelScope,
  type PrivateMenuConfiguration,
  type ValidationIssue,
  type ValidationResult,
} from './types'

const MENU_ITEM_TYPES = new Set<string>(PRIVATE_MENU_ITEM_TYPES)
const SUB_MENU_ITEM_TYPES = new Set<string>(PRIVATE_MENU_SUB_ITEM_TYPES)
const COMMAND_PANEL_ITEM_TYPE_SET = new Set<string>(COMMAND_PANEL_ITEM_TYPES)

/** 名称展示宽度；中文等宽字符按 2 计，与适配器/平台限制口径一致。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char)
      ? 2
      : 1
  }
  return width
}

function error(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'error', code, path, message }
}

function warning(code: string, path: string, message: string): ValidationIssue {
  return { severity: 'warning', code, path, message }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 收集同级条目里重名的名称，用于生成 warning。 */
function duplicateNames(items: unknown[]): Set<string> {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const item of items) {
    if (!isRecord(item) || typeof item.name !== 'string') continue
    const name = item.name.trim()
    if (!name) continue
    if (seen.has(name)) duplicated.add(name)
    else seen.add(name)
  }
  return duplicated
}

function validateName(
  item: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  duplicatedNames: Set<string>,
  limit: number,
  codePrefix: string,
) {
  if (!isNonEmptyString(item.name)) {
    issues.push(error(`${codePrefix}.name-required`, `${path}.name`, '菜单项名称不能为空。'))
    return
  }
  const name = item.name.trim()
  if (displayWidth(name) > limit) {
    issues.push(warning(`${codePrefix}.name-too-wide`, `${path}.name`, `名称展示宽度超过约 ${limit} 个字符。`))
  }
  if (duplicatedNames.has(name)) {
    issues.push(warning(`${codePrefix}.name-duplicate`, `${path}.name`, `同级存在重名菜单项「${name}」。`))
  }
}

function validateLink(value: unknown, path: string, issues: ValidationIssue[], codePrefix: string) {
  if (!isNonEmptyString(value)) {
    issues.push(error(`${codePrefix}.link-required`, path, 'link 类型必须填写链接。'))
  } else if (!value.startsWith('https://')) {
    issues.push(warning(`${codePrefix}.link-insecure`, path, '链接必须以 https:// 开头。'))
  }
}

/** 子菜单项只允许 send_message / link（平台 SubMenuItemType）。 */
function validateSubItems(item: Record<string, unknown>, path: string, issues: ValidationIssue[]) {
  const raw = item.sub_menu_items
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    issues.push(error('private-menu.sub-items.not-array', `${path}.sub_menu_items`, 'menu 的子菜单必须是数组。'))
    return
  }
  const subItems: unknown[] = Array.isArray(raw) ? raw : []
  if (subItems.length > PRIVATE_MENU_MAX_SUB_ITEMS) {
    issues.push(error(
      'private-menu.sub-items.max',
      `${path}.sub_menu_items`,
      `子菜单最多 ${PRIVATE_MENU_MAX_SUB_ITEMS} 项，当前 ${subItems.length} 项。`,
    ))
  }
  const duplicated = duplicateNames(subItems)
  subItems.forEach((sub, index) => {
    const subPath = `${path}.sub_menu_items[${index}]`
    if (!isRecord(sub)) {
      issues.push(error('private-menu.sub-item.not-object', subPath, '子菜单项必须是对象。'))
      return
    }
    validateName(sub, subPath, issues, duplicated, 13, 'private-menu.sub-item')
    const type = sub.type
    if (typeof type !== 'string' || !SUB_MENU_ITEM_TYPES.has(type)) {
      issues.push(error('private-menu.sub-item.type-invalid', `${subPath}.type`, `子菜单不支持的条目类型：${String(type)}。`))
      return
    }
    if (type === 'send_message') {
      if (!isNonEmptyString(sub.send_message)) {
        issues.push(error('private-menu.sub-item.send-message-required', `${subPath}.send_message`, 'send_message 子项必须填写发送内容。'))
      }
    } else {
      validateLink(sub.link, `${subPath}.link`, issues, 'private-menu.sub-item')
    }
  })
}

function validateSwitch(item: Record<string, unknown>, path: string, issues: ValidationIssue[], switchIds: Map<string, string>) {
  const raw = item.switch
  const switchPath = `${path}.switch`
  if (!isRecord(raw)) {
    issues.push(error('private-menu.item.switch-required', switchPath, 'switch 类型必须提供 switch 对象。'))
    return
  }
  if (!isNonEmptyString(raw.switch_id)) {
    issues.push(error('private-menu.item.switch-id-required', `${switchPath}.switch_id`, 'switch 必须有非空 switch_id。'))
  } else {
    const first = switchIds.get(raw.switch_id)
    if (first) {
      issues.push(warning('private-menu.switch-id-duplicate', `${switchPath}.switch_id`, `switch_id「${raw.switch_id}」与 ${first} 重复。`))
    } else {
      switchIds.set(raw.switch_id, switchPath)
    }
  }
  if (typeof raw.default !== 'boolean') {
    issues.push(error('private-menu.item.switch-default-required', `${switchPath}.default`, 'switch 的 default 必须是布尔值。'))
  }
}

function validateTopLevelItem(
  item: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  switchIds: Map<string, string>,
  duplicatedNames: Set<string>,
) {
  validateName(item, path, issues, duplicatedNames, 10, 'private-menu.item')
  const type = item.type
  if (typeof type !== 'string' || !MENU_ITEM_TYPES.has(type)) {
    issues.push(error('private-menu.item.type-invalid', `${path}.type`, `不支持的菜单项类型：${String(type)}。`))
    return
  }
  if (type === 'send_message') {
    if (!isNonEmptyString(item.send_message)) {
      issues.push(error('private-menu.item.send-message-required', `${path}.send_message`, 'send_message 类型必须填写发送内容。'))
    }
  } else if (type === 'link') {
    validateLink(item.link, `${path}.link`, issues, 'private-menu.item')
  } else if (type === 'switch') {
    validateSwitch(item, path, issues, switchIds)
  } else if (type === 'menu') {
    validateSubItems(item, path, issues)
  }
}

/** 校验 Private Menu；返回全部硬错误与警告。 */
export function validatePrivateMenu(menu: PrivateMenuConfiguration): ValidationResult {
  const issues: ValidationIssue[] = []
  const items = Array.isArray(menu.items) ? menu.items : []
  if (!Array.isArray(menu.items)) {
    issues.push(error('private-menu.items.not-array', 'privateMenu.items', 'privateMenu.items 必须是数组。'))
  }
  if (items.length > PRIVATE_MENU_MAX_ITEMS) {
    issues.push(error(
      'private-menu.items.max',
      'privateMenu.items',
      `Private Menu 一级按钮最多 ${PRIVATE_MENU_MAX_ITEMS} 个，当前 ${items.length} 个。`,
    ))
  }

  const switchIds = new Map<string, string>()
  const duplicated = duplicateNames(items)
  items.forEach((item, index) => {
    const path = `privateMenu.items[${index}]`
    if (!isRecord(item)) {
      issues.push(error('private-menu.item.not-object', path, '菜单项必须是对象。'))
      return
    }
    validateTopLevelItem(item, path, issues, switchIds, duplicated)
  })

  return partition(issues)
}

/** 校验 Command Panel；覆盖各场景数量、必填字段、使用场景与简单警告。 */
export function validateCommandPanel(panel: CommandPanelConfiguration): ValidationResult {
  const issues: ValidationIssue[] = []
  const items = Array.isArray(panel.items) ? panel.items : []
  if (!Array.isArray(panel.items)) {
    issues.push(error('command-panel.items.not-array', 'commandPanel.items', 'commandPanel.items 必须是数组。'))
  }

  const counts = scopeItemCounts(panel)
  for (const scope of PANEL_SCOPES) {
    if (counts[scope] > COMMAND_PANEL_MAX_ITEMS) {
      issues.push(error(
        'command-panel.scope.max',
        `commandPanel.scopes.${scope}`,
        `${PANEL_SCOPE_LABELS[scope]} 场景最多 ${COMMAND_PANEL_MAX_ITEMS} 项，当前 ${counts[scope]} 项。`,
      ))
    }
  }

  const duplicatedByScope = Object.fromEntries(
    PANEL_SCOPES.map(scope => [scope, duplicateNames(items.filter(item => panelItemBelongsTo(item, scope)))]),
  ) as Record<PanelScope, Set<string>>

  items.forEach((item, index) => {
    const path = `commandPanel.items[${index}]`
    if (!isRecord(item)) {
      issues.push(error('command-panel.item.not-object', path, '面板条目必须是对象。'))
      return
    }

    const scopes = panelItemScopes(item)
    if (scopes.length === 0) {
      issues.push(error('command-panel.item.scopes-required', `${path}.scopes`, '面板条目至少勾选一个使用场景。'))
    }

    if (!isNonEmptyString(item.name)) {
      issues.push(error('command-panel.item.name-required', `${path}.name`, '面板条目名称不能为空。'))
    } else {
      const name = item.name.trim()
      if (displayWidth(name) > 14) {
        issues.push(error('command-panel.item.name-too-wide', `${path}.name`, '名称展示宽度超过约 14 个字符。'))
      }
      for (const scope of scopes) {
        if (duplicatedByScope[scope].has(name)) {
          issues.push(warning(
            'command-panel.item.name-duplicate',
            `${path}.name`,
            `${PANEL_SCOPE_LABELS[scope]} 场景内存在重名条目「${name}」。`,
          ))
        }
      }
    }

    if (item.only_admin !== undefined && typeof item.only_admin !== 'boolean') {
      issues.push(error('command-panel.item.only-admin-invalid', `${path}.only_admin`, 'only_admin 必须是布尔值。'))
    }

    const type = item.type
    if (typeof type !== 'string' || !COMMAND_PANEL_ITEM_TYPE_SET.has(type)) {
      issues.push(error('command-panel.item.type-invalid', `${path}.type`, `不支持的条目类型：${String(type)}。`))
      return
    }
    if (type === 'link') {
      if (!isNonEmptyString(item.link)) {
        issues.push(error('command-panel.item.link-required', `${path}.link`, 'link 类型必须填写链接。'))
      } else if (!item.link.startsWith('https://')) {
        issues.push(error('command-panel.item.link-insecure', `${path}.link`, '链接必须以 https:// 开头。'))
      }
    } else if (typeof item.name === 'string' && item.name.trim() && !item.name.trim().startsWith('/')) {
      issues.push(error('command-panel.item.command-prefix', `${path}.name`, 'command 名称必须以 / 开头。'))
    }
    if (typeof item.desc === 'string' && displayWidth(item.desc) > 30) {
      issues.push(error('command-panel.item.desc-too-wide', `${path}.desc`, '描述展示宽度超过约 30 个字符。'))
    }
  })

  return partition(issues)
}

/** 校验整份 Panel Configuration，两个 surface 的结果合并。 */
export function validatePanelConfiguration(configuration: PanelConfiguration): ValidationResult {
  const privateMenu = validatePrivateMenu(configuration.privateMenu)
  const commandPanel = validateCommandPanel(configuration.commandPanel)
  return {
    errors: [...privateMenu.errors, ...commandPanel.errors],
    warnings: [...privateMenu.warnings, ...commandPanel.warnings],
  }
}

function partition(issues: ValidationIssue[]): ValidationResult {
  return {
    errors: issues.filter(issue => issue.severity === 'error'),
    warnings: issues.filter(issue => issue.severity === 'warning'),
  }
}
