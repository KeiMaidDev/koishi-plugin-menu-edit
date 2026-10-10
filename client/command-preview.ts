/**
 * Command Panel 手机预览。
 *
 * 复用 `.me-phone` 手机外壳，按使用场景展示该场景派生出的条目（`command` 显示 `/`
 * 指令名与描述，`link` 显示进入箭头）。场景切换与展示只影响预览态，不修改 Draft，
 * 也不触发任何平台动作。
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
  },
  setup(props) {
    const activeScope = ref<PanelScope>(
      PANEL_SCOPES.find(scope => deriveScopeItems({ items: props.items }, scope).length > 0) ?? 'group',
    )

    const renderRow = (item: Record<string, unknown>, index: number) => {
      const trailing = panelRowTrailing(item)
      return h('div', { class: 'me-command-row' }, [
        h('span', { class: 'me-command-index' }, String(index + 1)),
        h('div', { class: 'me-command-main' }, [
          h('div', { class: 'me-command-title' }, [
            h('span', { class: 'me-command-name' }, panelItemDisplayName(item)),
            panelItemOnlyAdmin(item) ? h('span', { class: 'me-admin-badge' }, '管理员') : null,
          ]),
          trailing.kind === 'desc' && trailing.text
            ? h('div', { class: 'me-command-desc' }, trailing.text)
            : null,
        ].filter(child => child !== null)),
        trailing.kind === 'chevron' ? h('span', { class: 'me-command-chevron' }, '›') : null,
      ].filter(child => child !== null))
    }

    return () => {
      const items = deriveScopeItems({ items: props.items }, activeScope.value)
      const panel = items.length
        ? h('div', { class: 'me-command-list' }, items.map(renderRow))
        : h('div', { class: 'me-command-empty' }, `${panelScopeLabel(activeScope.value)}场景暂无条目`)
      return h('div', { class: 'me-phone' }, [
        h('div', { class: 'me-phone-screen me-command-screen' }, [
          h('div', { class: 'me-scope-tabs' }, PANEL_SCOPES.map(scope => h('button', {
            type: 'button',
            class: ['me-scope-tab', activeScope.value === scope ? 'me-scope-tab-active' : ''],
            onClick: () => { activeScope.value = scope },
          }, panelScopeLabel(scope)))),
          h('div', { class: 'me-command-chat' }, [
            h('div', { class: 'me-command-panel' }, [panel]),
          ]),
          h('div', { class: 'me-command-input-row' }, [
            h('div', { class: 'me-command-input' }, '/'),
            h('div', { class: 'me-command-send' }, '发送'),
          ]),
        ]),
      ])
    }
  },
})