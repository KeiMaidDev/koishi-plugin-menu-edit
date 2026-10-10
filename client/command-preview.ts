/**
 * Command Panel 手机预览。
 *
 * 复用 `.me-phone` 手机外壳，按使用场景展示该场景派生出的条目（`command` 显示 `/`
 * 指令名与描述，`link` 显示进入箭头）。面板贴在底部输入区上方，留白出现在面板上方；
 * 场景切换与展示只影响预览态，不修改 Draft，也不触发任何平台动作。
 */
import { defineComponent, h, ref } from 'vue'
import { PANEL_SCOPES, type PanelScope } from '../src/types'
import { deriveScopeItems } from '../src/command-panel'
import {
  panelItemDisplayName,
  panelItemOnlyAdmin,
  panelRowTrailing,
  panelScopeLabel,
} from './command-panel'

export const CommandPanelPreview = defineComponent({
  name: 'CommandPanelPreview',
  props: {
    items: { type: Array as () => unknown[], required: true },
    name: { type: String, default: '' },
    online: { type: Boolean, default: true },
  },
  setup(props) {
    const activeScope = ref<PanelScope>(
      PANEL_SCOPES.find(scope => deriveScopeItems({ items: props.items }, scope).length > 0) ?? 'group',
    )

    const renderRow = (item: Record<string, unknown>) => {
      const trailing = panelRowTrailing(item)
      return h('div', { class: 'me-cp-item' }, [
        h('div', { class: 'me-cp-title' }, [
          h('span', { class: 'me-cp-name' }, panelItemDisplayName(item)),
          panelItemOnlyAdmin(item) ? h('span', { class: 'me-cp-admin' }, '管理员') : null,
        ].filter(child => child !== null)),
        trailing.kind === 'chevron'
          ? h('span', { class: 'me-cp-chevron' }, '\u203a')
          : h('span', { class: 'me-cp-desc' }, trailing.text),
      ])
    }

    return () => {
      const items = deriveScopeItems({ items: props.items }, activeScope.value)
      const panel = items.length
        ? h('div', { class: 'me-cp-list' }, items.map(renderRow))
        : h('div', { class: 'me-cp-empty' }, `${panelScopeLabel(activeScope.value)}场景暂无条目`)
      return h('div', { class: 'me-phone me-cp-phone' }, [
        h('div', { class: 'me-phone-screen me-cp-screen' }, [
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
          h('div', { class: 'me-cp-chat' }, [
            h('div', { class: 'me-bubble' }, '你好，点击下方菜单试试。'),
            h('div', { class: 'me-cp-panel' }, [
              h('div', { class: 'me-scope-tabs' }, PANEL_SCOPES.map(scope => h('button', {
                type: 'button',
                class: ['me-scope-tab', activeScope.value === scope ? 'me-scope-tab-active' : ''],
                onClick: () => { activeScope.value = scope },
              }, panelScopeLabel(scope)))),
              panel,
            ]),
          ]),
          h('div', { class: 'me-cp-input-row' }, [
            h('div', { class: 'me-cp-input' }, [
              h('span', { class: 'me-cp-input-text' }, '/'),
            ]),
            h('div', { class: 'me-cp-send' }, '发送'),
          ]),
        ]),
      ])
    }
  },
})