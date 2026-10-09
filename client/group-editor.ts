/**
 * Group Panel 结构化编辑器。
 *
 * 每个 Panel Item 是一张可折叠卡片：拖拽手柄 + 类型徽标 + 名称 + 管理员标记 + 校验状态 +
 * 上移/下移/复制/删除。展开后可编辑名称、描述、指令/链接与 only_admin。
 * 所有变更通过 `update:items` 上抛，由页面统一保存，组件自身不写服务端。
 */
import { defineComponent, h, reactive, type VNodeChild } from 'vue'
import { GROUP_PANEL_MAX_ITEMS, type ValidationIssue } from '../src/types'
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
  PANEL_ITEM_TYPES,
  panelItemDesc,
  panelItemLabel,
  panelItemLink,
  panelItemName,
  panelItemOnlyAdmin,
  panelItemType,
  patchPanelItem,
  type PanelItemType,
} from './group-panel'

function textInput(value: string, placeholder: string, onInput: (value: string) => void) {
  return h('input', {
    class: 'me-input',
    value,
    placeholder,
    spellcheck: false,
    onInput: (event: Event) => onInput((event.target as HTMLInputElement).value),
  })
}

function typeSelect(value: string, onChange: (type: PanelItemType) => void) {
  return h(
    'select',
    {
      class: 'me-select',
      value,
      onChange: (event: Event) => {
        const next = (event.target as HTMLSelectElement).value
        if ((PANEL_ITEM_TYPES as readonly string[]).includes(next)) onChange(next as PanelItemType)
      },
    },
    PANEL_ITEM_TYPES.map(type => h('option', { value: type }, panelItemLabel(type))),
  )
}

function field(label: string, control: VNodeChild) {
  return h('label', { class: 'me-field' }, [h('span', { class: 'me-field-label' }, label), control])
}

export const GroupPanelEditor = defineComponent({
  name: 'GroupPanelEditor',
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

    const renderBody = (item: unknown, index: number) => {
      const type = panelItemType(item)
      const admin = panelItemOnlyAdmin(item)
      return h('div', { class: 'me-card-body' }, [
        field('名称', textInput(panelItemName(item), type === 'link' ? '链接名称' : '/指令名', value => patched(index, { name: value }))),
        field('描述', textInput(panelItemDesc(item), '展示给群成员的说明', value => patched(index, { desc: value }))),
        field('类型', typeSelect(type, next => update(replaceAt(props.items, index, changePanelItemType(item, next))))),
        type === 'link'
          ? field('链接', textInput(panelItemLink(item), 'https://…', value => patched(index, { link: value })))
          : null,
        field('管理员限定', h('input', {
          type: 'checkbox',
          checked: admin,
          onChange: (event: Event) => patched(index, { only_admin: (event.target as HTMLInputElement).checked }),
        })),
      ])
    }

    const renderCard = (item: unknown, index: number) => {
      const type = panelItemType(item)
      const name = panelItemName(item)
      const admin = panelItemOnlyAdmin(item)
      const valid = PANEL_ITEM_TYPES.includes(type as PanelItemType)
      const prefix = `groupPanel.items[${index}]`
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
            admin ? h('span', { class: 'me-admin-badge' }, '管理员') : null,
            renderBadge(prefix),
            h('span', { class: 'me-spacer' }),
            h('button', { type: 'button', class: 'me-icon-btn', title: '上移', disabled: index === 0, onClick: () => update(moveAt(props.items, index, index - 1)) }, '↑'),
            h('button', { type: 'button', class: 'me-icon-btn', title: '下移', disabled: index === props.items.length - 1, onClick: () => update(moveAt(props.items, index, index + 1)) }, '↓'),
            h('button', {
              type: 'button',
              class: 'me-icon-btn',
              title: '复制',
              disabled: props.items.length >= GROUP_PANEL_MAX_ITEMS,
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

    return () => {
      const full = props.items.length >= GROUP_PANEL_MAX_ITEMS
      return h('div', { class: 'me-editor-list' }, [
        h('div', { class: 'me-count' }, `面板条目 ${props.items.length} / ${GROUP_PANEL_MAX_ITEMS}`),
        ...props.items.map(renderCard),
        h('div', { class: 'me-add-row' }, [
          ...PANEL_ITEM_TYPES.map(type => h('button', {
            type: 'button',
            class: 'me-button',
            disabled: full,
            onClick: () => update([...props.items, createPanelItem(type)]),
          }, `+ ${panelItemLabel(type)}条目`)),
          full ? h('span', { class: 'me-hint' }, '已达 Group Panel 条目上限 20') : null,
        ]),
      ])
    }
  },
})
