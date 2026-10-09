/**
 * Private Menu 手机预览。
 *
 * 复刻 QQ 原生私聊菜单：输入栏上方是横向滚动、不换行的 Private Menu Strip；
 * 点击 menu 按钮从底部弹出 Menu Sheet。所有点击只改变预览态，不修改 Draft、
 * 不发送消息、不打开链接、不切换真实开关。
 */
import { defineComponent, h, reactive, ref } from 'vue'
import { iconFor, labelFor } from './icons'
import { itemName, itemType, subItems, switchConfigOf } from './private-menu'

export const PrivateMenuPreview = defineComponent({
  name: 'PrivateMenuPreview',
  props: {
    items: { type: Array as () => unknown[], required: true },
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

    const renderLeadingIcon = (item: unknown) => {
      const type = itemType(item)
      const url = iconFor(type)
      return url
        ? h('img', { class: 'me-strip-icon', src: url, alt: '' })
        : h('span', { class: 'me-strip-fallback' }, labelFor(type).slice(0, 1) || '?')
    }

    const renderStripButton = (item: unknown, index: number) => {
      const type = itemType(item)
      const isSwitch = type === 'switch'
      const active = isSwitch && switchValue(index, item)
      const children = [
        isSwitch ? null : renderLeadingIcon(item),
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

    const renderSheetRow = (sub: unknown, index: number) => {
      const token = -(index + 1)
      return h(
        'button',
        {
          type: 'button',
          class: ['me-sheet-row', flashIndex.value === token ? 'me-sheet-row-flash' : ''],
          onClick: () => flash(token),
        },
        [renderLeadingIcon(sub), h('span', { class: 'me-sheet-name' }, itemName(sub) || '未命名')],
      )
    }

    const renderSheet = () => {
      if (openIndex.value === null) return null
      const item = props.items[openIndex.value]
      const subs = subItems(item)
      return h('div', { class: 'me-sheet' }, [
        h('div', { class: 'me-sheet-head' }, [
          h('span', { class: 'me-sheet-title' }, itemName(item) || '子菜单'),
          h('button', { type: 'button', class: 'me-sheet-close', onClick: () => { openIndex.value = null } }, '×'),
        ]),
        subs.length
          ? h('div', { class: 'me-sheet-list' }, subs.map(renderSheetRow))
          : h('div', { class: 'me-sheet-empty' }, '这个子菜单还没有条目'),
      ])
    }

    return () => h('div', { class: 'me-phone' }, [
      h('div', { class: 'me-phone-screen' }, [
        h('div', { class: 'me-phone-notice' }, 'QQ 聊天预览'),
        h('div', { class: 'me-phone-body' }, [
          h('div', { class: 'me-bubble' }, '你好，点击下方菜单试试。'),
        ]),
        h('div', { class: 'me-phone-input-zone' }, [
          props.items.length
            ? h('div', { class: 'me-strip' }, props.items.map(renderStripButton))
            : h('div', { class: 'me-strip-empty' }, '暂无菜单项'),
          h('div', { class: 'me-phone-inputbar' }, '输入消息…'),
        ]),
      ]),
      renderSheet(),
    ])
  },
})
