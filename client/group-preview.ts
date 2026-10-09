/**
 * Group Panel 手机预览。
 *
 * 模拟 QQ 群聊指令面板：按编辑区顺序展示名称、描述与管理员标记；所有内容只读，
 * 点击不触发任何平台动作，也不修改 Draft。
 */
import { defineComponent, h } from 'vue'
import { panelItemDesc, panelItemName, panelItemOnlyAdmin } from './group-panel'

export const GroupPanelPreview = defineComponent({
  name: 'GroupPanelPreview',
  props: {
    items: { type: Array as () => unknown[], required: true },
  },
  setup(props) {
    const renderRow = (item: unknown, index: number) => h(
      'div',
      { class: 'me-group-row' },
      [
        h('span', { class: 'me-group-index' }, String(index + 1)),
        h('div', { class: 'me-group-main' }, [
          h('div', { class: 'me-group-title' }, [
            h('span', { class: 'me-group-name' }, panelItemName(item) || '未命名'),
            panelItemOnlyAdmin(item) ? h('span', { class: 'me-admin-badge' }, '管理员') : null,
          ]),
          h('div', { class: 'me-group-desc' }, panelItemDesc(item) || '无描述'),
        ]),
      ],
    )

    return () => h('div', { class: 'me-phone' }, [
      h('div', { class: 'me-phone-screen me-group-screen' }, [
        h('div', { class: 'me-phone-notice' }, 'QQ 群聊指令面板'),
        h('div', { class: 'me-group-body' }, [
          h('div', { class: 'me-group-bubble' }, '群聊指令面板预览'),
          props.items.length
            ? h('div', { class: 'me-group-list' }, props.items.map(renderRow))
            : h('div', { class: 'me-group-empty' }, '暂无面板条目'),
        ]),
      ]),
    ])
  },
})
