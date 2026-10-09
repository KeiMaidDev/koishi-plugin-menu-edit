/**
 * Private Menu 结构化编辑器。
 *
 * 每个菜单项是一张可折叠卡片：拖拽手柄 + 类型图标 + 名称 + 校验状态 + 上移/下移/复制/删除。
 * 展开后按类型显示字段；menu 类型再嵌套子菜单项（子项支持拖拽、增删和类型切换）。
 * 所有变更都通过 `update:items` 上抛，由页面统一保存，组件自身不写服务端。
 */
import { defineComponent, h, reactive, type VNodeChild } from 'vue'
import { PRIVATE_MENU_MAX_ITEMS, PRIVATE_MENU_MAX_SUB_ITEMS, type ValidationIssue } from '../src/types'
import { iconFor, labelFor } from './icons'
import {
  asRecord,
  changeItemType,
  changeSubItemType,
  cloneAt,
  createItem,
  createSubItem,
  itemName,
  itemType,
  MENU_ITEM_TYPES,
  moveAt,
  patchItem,
  patchSwitch,
  removeAt,
  replaceAt,
  SUB_MENU_ITEM_TYPES,
  subItems,
  switchConfigOf,
  type MenuItemType,
  type SubMenuItemType,
} from './private-menu'

function textInput(value: string, placeholder: string, onInput: (value: string) => void) {
  return h('input', {
    class: 'me-input',
    value,
    placeholder,
    spellcheck: false,
    onInput: (event: Event) => onInput((event.target as HTMLInputElement).value),
  })
}

function typeSelect<T extends string>(value: string, types: readonly T[], onChange: (type: T) => void) {
  return h(
    'select',
    {
      class: 'me-select',
      value,
      onChange: (event: Event) => {
        const next = (event.target as HTMLSelectElement).value
        if ((types as readonly string[]).includes(next)) onChange(next as T)
      },
    },
    types.map(type => h('option', { value: type }, labelFor(type))),
  )
}

function field(label: string, control: VNodeChild) {
  return h('label', { class: 'me-field' }, [h('span', { class: 'me-field-label' }, label), control])
}

export const PrivateMenuEditor = defineComponent({
  name: 'PrivateMenuEditor',
  props: {
    items: { type: Array as () => unknown[], required: true },
    issues: { type: Array as () => ValidationIssue[], default: () => [] },
  },
  emits: ['update:items'],
  setup(props, { emit }) {
    const expanded = reactive<Record<number, boolean>>({})
    let dragIndex: number | null = null
    let dragSub: { parent: number; index: number } | null = null

    const update = (items: unknown[]) => emit('update:items', items)

    const patched = (index: number, patch: Record<string, unknown>) =>
      update(replaceAt(props.items, index, patchItem(props.items[index], patch)))

    const issuesFor = (prefix: string) => props.issues.filter(issue => issue.path.startsWith(prefix))
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

    const renderSubItems = (item: unknown, index: number) => {
      const subs = subItems(item)
      const setSubs = (next: unknown[]) => patched(index, { sub_menu_items: next })
      return h('div', { class: 'me-sub-list' }, [
        h('div', { class: 'me-sub-title' }, `子菜单 ${subs.length} / ${PRIVATE_MENU_MAX_SUB_ITEMS}`),
        ...subs.map((sub, subIndex) => {
          const record = asRecord(sub)
          const type = itemType(sub)
          const setSub = (patch: Record<string, unknown>) => setSubs(replaceAt(subs, subIndex, patchItem(sub, patch)))
          const valueControl = type === 'link'
            ? textInput(typeof record.link === 'string' ? record.link : '', 'https://…', value => setSub({ link: value }))
            : textInput(typeof record.send_message === 'string' ? record.send_message : '', '发送内容', value => setSub({ send_message: value }))
          return h('div', {
            class: 'me-sub-row',
            draggable: true,
            onDragstart: () => { dragSub = { parent: index, index: subIndex } },
            onDragover: (event: DragEvent) => event.preventDefault(),
            onDrop: (event: DragEvent) => {
              event.preventDefault()
              if (!dragSub || dragSub.parent !== index || dragSub.index === subIndex) return
              setSubs(moveAt(subs, dragSub.index, subIndex))
              dragSub = null
            },
          }, [
            h('span', { class: 'me-drag-handle me-drag-sub' }, '⠿'),
            textInput(typeof record.name === 'string' ? record.name : '', '名称', value => setSub({ name: value })),
            typeSelect<SubMenuItemType>(type as SubMenuItemType, SUB_MENU_ITEM_TYPES, next => setSubs(replaceAt(subs, subIndex, changeSubItemType(sub, next)))),
            valueControl,
            h('button', { type: 'button', class: 'me-icon-btn', title: '上移', disabled: subIndex === 0, onClick: () => setSubs(moveAt(subs, subIndex, subIndex - 1)) }, '↑'),
            h('button', { type: 'button', class: 'me-icon-btn', title: '下移', disabled: subIndex === subs.length - 1, onClick: () => setSubs(moveAt(subs, subIndex, subIndex + 1)) }, '↓'),
            h('button', { type: 'button', class: 'me-icon-btn me-icon-danger', title: '删除', onClick: () => setSubs(removeAt(subs, subIndex)) }, '×'),
          ])
        }),
        h('button', {
          type: 'button',
          class: 'me-button',
          disabled: subs.length >= PRIVATE_MENU_MAX_SUB_ITEMS,
          onClick: () => setSubs([...subs, createSubItem()]),
        }, subs.length >= PRIVATE_MENU_MAX_SUB_ITEMS ? `子菜单已达上限 ${PRIVATE_MENU_MAX_SUB_ITEMS}` : '+ 添加子项'),
      ])
    }

    const renderBody = (item: unknown, index: number) => {
      const record = asRecord(item)
      const type = itemType(item)
      const name = typeof record.name === 'string' ? record.name : ''
      const nameField = field('名称', textInput(name, '菜单项名称', value => patched(index, { name: value })))
      if (type === 'send_message') {
        return h('div', { class: 'me-card-body' }, [
          nameField,
          field('发送内容', textInput(typeof record.send_message === 'string' ? record.send_message : '', '/help', value => patched(index, { send_message: value }))),
        ])
      }
      if (type === 'link') {
        return h('div', { class: 'me-card-body' }, [
          nameField,
          field('链接', textInput(typeof record.link === 'string' ? record.link : '', 'https://…', value => patched(index, { link: value }))),
        ])
      }
      if (type === 'switch') {
        const config = switchConfigOf(item)
        return h('div', { class: 'me-card-body' }, [
          nameField,
          field('switch_id', textInput(config.switch_id, 'switch_id', value => update(replaceAt(props.items, index, patchSwitch(item, { switch_id: value }))))),
          field('默认状态', h('input', {
            type: 'checkbox',
            checked: config.default,
            onChange: (event: Event) => update(replaceAt(props.items, index, patchSwitch(item, { default: (event.target as HTMLInputElement).checked }))),
          })),
        ])
      }
      if (type === 'menu') {
        return h('div', { class: 'me-card-body' }, [nameField, renderSubItems(item, index)])
      }
      return h('div', { class: 'me-card-body' }, [
        h('div', { class: 'me-alert me-alert-warn' }, `未知类型「${type}」，已原样保留；请改为受支持的类型后再发布。`),
        nameField,
      ])
    }

    const renderCard = (item: unknown, index: number) => {
      const switchConfig = switchConfigOf(item)
      const type = itemType(item)
      const name = itemName(item)
      const prefix = `privateMenu.items[${index}]`
      const url = iconFor(type)
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
            type === 'switch'
              ? h('span', { class: ['me-switch-dot', switchConfig.default ? 'me-on' : 'me-off'], title: '默认状态' })
              : url
                ? h('img', { class: 'me-type-icon', src: url, alt: '' })
                : h('span', { class: 'me-strip-fallback' }, labelFor(type).slice(0, 1) || '?'),
            h('span', { class: 'me-card-name' }, name || '未命名'),
            h('span', { class: 'me-type-badge' }, labelFor(type)),
            renderBadge(prefix),
            h('span', { class: 'me-spacer' }),
            h('button', { type: 'button', class: 'me-icon-btn', title: '上移', disabled: index === 0, onClick: () => update(moveAt(props.items, index, index - 1)) }, '↑'),
            h('button', { type: 'button', class: 'me-icon-btn', title: '下移', disabled: index === props.items.length - 1, onClick: () => update(moveAt(props.items, index, index + 1)) }, '↓'),
            h('button', {
              type: 'button',
              class: 'me-icon-btn',
              title: '复制',
              disabled: props.items.length >= PRIVATE_MENU_MAX_ITEMS,
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
        ],
      )
    }

    return () => {
      const full = props.items.length >= PRIVATE_MENU_MAX_ITEMS
      return h('div', { class: 'me-editor-list' }, [
        h('div', { class: 'me-count' }, `一级按钮 ${props.items.length} / ${PRIVATE_MENU_MAX_ITEMS}`),
        ...props.items.map(renderCard),
        h('div', { class: 'me-add-row' }, [
          ...MENU_ITEM_TYPES.map(type => h('button', {
            type: 'button',
            class: 'me-button',
            disabled: full,
            onClick: () => update([...props.items, createItem(type)]),
          }, `+ ${labelFor(type)}`)),
          full ? h('span', { class: 'me-hint' }, '已达一级按钮上限') : null,
        ]),
      ])
    }
  },
})
