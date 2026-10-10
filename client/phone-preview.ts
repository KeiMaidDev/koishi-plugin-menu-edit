/**
 * Private Menu 手机预览。
 *
 * 按 docs/menu-edit-panel-design.md §11.4 的参考图数值复刻手机 QQ 私聊界面：
 * 输入框上方是横向滚动、不换行的 Private Menu Strip；点击 menu 按钮从底部弹出
 * Menu Sheet。所有点击只改变预览态，不修改 Draft、不发送消息、不打开链接、
 * 不切换真实开关。
 */
import { defineComponent, h, reactive, ref } from 'vue'
import { iconFor, labelFor } from './icons'
import { itemName, itemType, subItems, switchConfigOf } from './private-menu'

export const PrivateMenuPreview = defineComponent({
  name: 'PrivateMenuPreview',
  props: {
    items: { type: Array as () => unknown[], required: true },
    name: { type: String, default: '' },
    online: { type: Boolean, default: true },
  },
  setup(props) {
    // key 用 switch_id，缺省时退回索引；只存在于预览态。
    const switchState = reactive<Record<string, boolean>>({})
    const openIndex = ref<number | null>(null)
    const flashIndex = ref<number | null>(null)

    const switchKey = (index: number, item: unknown): string => {
      const id = switchConfigOf(item).switch_id
      return id ? `id:${id}` : `index:${index}`
    }

    const switchValue = (index: number, item: unknown): boolean => {
      const key = switchKey(index, item)
      if (key in switchState) return switchState[key]
      return switchConfigOf(item).default
    }

    const flash = (token: number) => {
      flashIndex.value = token
      window.setTimeout(() => {
        if (flashIndex.value === token) flashIndex.value = null
      }, 350)
    }

    const onItemClick = (index: number, item: unknown) => {
      const type = itemType(item)
      if (type === 'menu') {
        openIndex.value = openIndex.value === index ? null : index
        return
      }
      if (type === 'switch') {
        const key = switchKey(index, item)
        switchState[key] = !switchValue(index, item)
        return
      }
      flash(index)
    }

    /** 类型图标；参考图里图标为近黑色，switch 与未知类型没有图标。 */
    const renderLeadingIcon = (item: unknown, iconClass: string) => {
      const type = itemType(item)
      const url = iconFor(type)
      return url
        ? h('img', { class: iconClass, src: url, alt: '' })
        : h('span', { class: 'me-strip-fallback', title: labelFor(type) }, '?')
    }

    const renderStripButton = (item: unknown, index: number) => {
      const type = itemType(item)
      const isSwitch = type === 'switch'
      const active = isSwitch && switchValue(index, item)
      const children = [
        isSwitch ? null : renderLeadingIcon(item, 'me-strip-icon'),
        h('span', { class: 'me-strip-name' }, itemName(item) || '未命名'),
        // switch 没有图标，名称右侧显示状态点（设计 §11.4）。
        isSwitch ? h('span', { class: ['me-switch-dot', active ? 'me-on' : 'me-off'] }) : null,
      ].filter(child => child !== null)
      return h(
        'button',
        {
          type: 'button',
          class: [
            'me-strip-btn',
            isSwitch ? (active ? 'me-switch-on' : 'me-switch-off') : '',
            openIndex.value === index ? 'me-strip-btn-open' : '',
            flashIndex.value === index ? 'me-strip-btn-flash' : '',
          ],
          onClick: () => onItemClick(index, item),
          title: labelFor(type),
        },
        children,
      )
    }

    /** 参考图里 Menu Sheet 的子项只显示名称，没有再列一遍类型图标。 */
    const renderSheetRow = (sub: unknown, index: number) => {
      const token = -(index + 1)
      return h(
        'button',
        {
          type: 'button',
          class: ['me-sheet-row', flashIndex.value === token ? 'me-sheet-row-flash' : ''],
          onClick: () => flash(token),
        },
        [
          h('span', { class: 'me-sheet-name' }, itemName(sub) || '未命名'),
          h('span', { class: 'me-sheet-line' }),
        ],
      )
    }

    const renderSheet = () => {
      if (openIndex.value === null) return null
      const item = props.items[openIndex.value]
      const subs = subItems(item)
      return h('div', { class: 'me-sheet' }, [
        h('div', {
          class: 'me-sheet-handle',
          onClick: () => { openIndex.value = null },
        }),
        h('div', { class: 'me-sheet-head' }, [
          renderLeadingIcon(item, 'me-sheet-icon'),
          h('span', { class: 'me-sheet-title' }, itemName(item) || '子菜单'),
        ]),
        subs.length
          ? h('div', { class: 'me-sheet-list' }, subs.map(renderSheetRow))
          : h('div', { class: 'me-sheet-empty' }, '这个子菜单还没有条目'),
      ])
    }

    return () => h('div', { class: 'me-phone' }, [
      h('div', { class: 'me-phone-screen' }, [
        h('div', { class: 'me-chat-head' }, [
          h('span', { class: 'me-chat-back' }, '\u2039'),
          h('div', { class: 'me-chat-title' }, [
            h('div', { class: 'me-chat-name' }, props.name || '机器人'),
            h('div', { class: 'me-chat-status' }, [
              h('span', { class: ['me-chat-state', props.online ? '' : 'me-chat-state-offline'] }),
              h('span', {}, props.online ? '在线' : '离线'),
            ]),
          ]),
        ]),
        h('div', { class: 'me-chat-body' }, [
          h('div', { class: 'me-bubble' }, '你好，点击下方菜单试试。'),
        ]),
        h('div', { class: 'me-phone-input-zone' }, [
          props.items.length
            ? h('div', { class: 'me-strip' }, props.items.map(renderStripButton))
            : h('div', { class: 'me-strip-empty' }, '暂无菜单项'),
          h('div', { class: 'me-cp-input-row' }, [
            h('div', { class: 'me-cp-input' }, [
              h('span', { class: 'me-cp-input-text' }, '/'),
            ]),
            h('div', { class: 'me-cp-send' }, '发送'),
          ]),
        ]),
      ]),
      openIndex.value !== null
        ? h('div', { class: 'me-sheet-mask', onClick: () => { openIndex.value = null } })
        : null,
      renderSheet(),
    ])
  },
})
