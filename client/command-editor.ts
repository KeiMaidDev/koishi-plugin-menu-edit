/**
 * Command Panel 结构化编辑器。
 *
 * 每个 Panel Item 是一张可折叠卡片：拖拽手柄 + 类型徽标 + 名称 + 使用场景数量 +
 * 管理员标记 + 校验状态 + 上移/下移/复制/删除。展开后可编辑指令名、指令介绍、
 * 权限菜单、使用场景与链接。所有变更通过 `update:items` 上抛，由页面统一保存。
 */
import { defineComponent, h, reactive, type VNodeChild } from 'vue'
import { COMMAND_PANEL_MAX_ITEMS, PANEL_SCOPES, type PanelScope, type ValidationIssue } from '../src/types'
import {
  asRecord,
  cloneAt,
  moveAt,
  removeAt,
  replaceAt,
} from './private-menu'
import {
  changePanelItemType,
  createPanelItem,
  defaultScopes,
  PANEL_ITEM_TYPES,
  panelItemDesc,
  panelItemLabel,
  panelItemLink,
  panelItemName,
  panelItemOnlyAdmin,
  panelItemScopes,
  panelItemType,
  panelScopeLabel,
  patchPanelItem,
  scopeItemCounts,
  togglePanelItemScope,
  type PanelItemType,
} from './command-panel'

function textInput(value: string, placeholder: string, onInput: (value: string) => void) {
  return h('input', {
    class: 'me-input',
    value,
    placeholder,
    spellcheck: false,
    onInput: (event: Event) => onInput((event.target as HTMLInputElement).value),
  })
}

function select(value: string, options: { value: string; label: string }[], onChange: (value: string) => void) {
  return h(
    'select',
    {
      class: 'me-select',
      value,
      onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value),
    },
    options.map(option => h('option', { value: option.value }, option.label)),
  )
}

function field(label: string, control: VNodeChild) {
  return h('label', { class: 'me-field' }, [h('span', { class: 'me-field-label' }, label), control])
}

/** 指令名输入框只填名字，存储时拼成 `/名字`。 */
function commandNameInput(item: unknown): string {
  const name = panelItemName(item).trim()
  return name.startsWith('/') ? name.slice(1) : name
}

export const CommandPanelEditor = defineComponent({
  name: 'CommandPanelEditor',
  props: {
    items: { type: Array as () => unknown[], required: true },
    issues: { type: Array as () => ValidationIssue[], default: () => [] },
  },
  emits: ['update:items'],
  setup(props, { emit }) {
    const expanded = reactive<Record<number, boolean>>({})
    let dragIndex: number | null = null

    const update = (items: unknown[]) => emit('update:items', items)
    const patched = (index: number, patch: Record<string, unknown>) =>
      update(replaceAt(props.items, index, patchPanelItem(props.items[index], patch)))

    const issuesFor = (prefix: string) =>
      props.issues.filter(issue => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
    const errorCount = (prefix: string) => issuesFor(prefix).filter(issue => issue.severity === 'error').length
    const warningCount = (prefix: string) => issuesFor(prefix).filter(issue => issue.severity === 'warning').length

    const renderBadge = (prefix: string) => {
      const errors = errorCount(prefix)
      const warnings = warningCount(prefix)
      if (!errors && !warnings) return h('span', { class: 'me-check me-check-ok' }, '✓')
      return h('span', {
        class: ['me-check', errors ? 'me-check-error' : 'me-check-warn'],
        title: issuesFor(prefix).map(issue => issue.message).join('\n'),
      }, errors ? `${errors} 错误` : `${warnings} 警告`)
    }

    const renderScopes = (item: unknown, index: number) => {
      const current = panelItemScopes(item)
      return h('div', { class: 'me-scope-row' }, PANEL_SCOPES.map(scope => h('label', {
        class: ['me-scope-chip', current.includes(scope) ? 'me-scope-chip-on' : ''],
      }, [
        h('input', {
          type: 'checkbox',
          checked: current.includes(scope),
          onChange: () => update(replaceAt(props.items, index, togglePanelItemScope(item, scope))),
        }),
        h('span', {}, panelScopeLabel(scope)),
      ])))
    }

    const renderBody = (item: unknown, index: number) => {
      const type = panelItemType(item)
      const admin = panelItemOnlyAdmin(item)
      return h('div', { class: 'me-card-body' }, [
        field('指令名', type === 'link'
          ? textInput(panelItemName(item), '链接名称', value => patched(index, { name: value }))
          : h('div', { class: 'me-name-input' }, [
            h('span', { class: 'me-name-prefix' }, '/'),
            textInput(commandNameInput(item), '指令名（不含 /）', value => patched(index, { name: value ? `/${value}` : '' })),
          ])),
        field('指令介绍', textInput(panelItemDesc(item), '展示给用户的说明', value => patched(index, { desc: value }))),
        field('类型', select(panelItemType(item), PANEL_ITEM_TYPES.map(candidate => ({
          value: candidate,
          label: panelItemLabel(candidate),
        })), next => update(replaceAt(props.items, index, changePanelItemType(item, next as PanelItemType))))),
        field('权限菜单', select(admin ? 'admin' : 'all', [
          { value: 'all', label: '所有人' },
          { value: 'admin', label: '仅管理员' },
        ], next => patched(index, { only_admin: next === 'admin' }))),
        field('使用场景', renderScopes(item, index)),
        type === 'link'
          ? field('链接', textInput(panelItemLink(item), 'https://…', value => patched(index, { link: value })))
          : null,
      ].filter(child => child !== null))
    }

    const renderCard = (item: unknown, index: number) => {
      const type = panelItemType(item)
      const name = panelItemDisplayNameForCard(item)
      const admin = panelItemOnlyAdmin(item)
      const valid = PANEL_ITEM_TYPES.includes(type as PanelItemType)
      const scopeCount = panelItemScopes(item).length
      const prefix = `commandPanel.items[${index}]`
      return h(
        'div',
        {
          class: ['me-card', errorCount(prefix) ? 'me-card-invalid' : ''],
          draggable: true,
          onDragstart: () => { dragIndex = index },
          onDragover: (event: DragEvent) => event.preventDefault(),
          onDrop: (event: DragEvent) => {
            event.preventDefault()
            if (dragIndex === null || dragIndex === index) return
            update(moveAt(props.items, dragIndex, index))
            dragIndex = null
          },
        },
        [
          h('div', { class: 'me-card-head' }, [
            h('span', { class: 'me-drag-handle', title: '拖拽排序' }, '⠿'),
            h('span', { class: ['me-type-badge', valid ? '' : 'me-type-badge-warn'] }, panelItemLabel(type)),
            h('span', { class: 'me-card-name' }, name || '未命名'),
            h('span', { class: 'me-hint' }, `${scopeCount} 个场景`),
            admin ? h('span', { class: 'me-admin-badge' }, '管理员') : null,
            renderBadge(prefix),
            h('span', { class: 'me-spacer' }),
            h('button', { type: 'button', class: 'me-icon-btn', title: '上移', disabled: index === 0, onClick: () => update(moveAt(props.items, index, index - 1)) }, '↑'),
            h('button', { type: 'button', class: 'me-icon-btn', title: '下移', disabled: index === props.items.length - 1, onClick: () => update(moveAt(props.items, index, index + 1)) }, '↓'),
            h('button', {
              type: 'button',
              class: 'me-icon-btn',
              title: '复制',
              onClick: () => update(cloneAt(props.items, index)),
            }, '⧉'),
            h('button', { type: 'button', class: 'me-icon-btn me-icon-danger', title: '删除', onClick: () => update(removeAt(props.items, index)) }, '×'),
            h('button', {
              type: 'button',
              class: 'me-button me-button-sm',
              onClick: () => { expanded[index] = !expanded[index] },
            }, expanded[index] ? '收起' : '展开'),
          ]),
          expanded[index] ? renderBody(item, index) : null,
        ].filter(child => child !== null),
      )
    }

    const renderCounts = () => {
      const counts = scopeItemCounts({ items: props.items })
      return h('div', { class: 'me-count' }, PANEL_SCOPES
        .map(scope => `${panelScopeLabel(scope)} ${counts[scope]} / ${COMMAND_PANEL_MAX_ITEMS}`)
        .join(' · '))
    }

    return () => {
      const scopes = defaultScopes(props.items)
      return h('div', { class: 'me-editor-list' }, [
        renderCounts(),
        ...props.items.map(renderCard),
        h('div', { class: 'me-add-row' }, [
          ...PANEL_ITEM_TYPES.map(type => h('button', {
            type: 'button',
            class: 'me-button',
            disabled: scopes === null,
            onClick: () => update([...props.items, createPanelItem(type, scopes ?? ['group'])]),
          }, `+ 添加${panelItemLabel(type)}`)),
          scopes === null ? h('span', { class: 'me-hint' }, '四个使用场景都已达到 20 条上限') : null,
        ]),
      ])
    }
  },
})

function panelItemDisplayNameForCard(item: unknown): string {
  const name = panelItemName(item).trim()
  if (!name) return ''
  if (panelItemType(item) === 'command' && !name.startsWith('/')) return `/${name}`
  return name
}
