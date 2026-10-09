import type { Context } from '@koishijs/client'
import { store } from '@koishijs/client'
import { defineComponent, h } from 'vue'
import { CONSOLE_PANEL_AUTHORITY } from '../src/console-permission'
import App, { PANEL_NAME } from './app'

// plugin-auth 的客户端守卫先于本入口完成渲染，匿名深链有概率先渲染出外壳。
// 这里用同一个 store.user 条件同步兜底；真正的闸门是服务端 console listener 上的 authority。
const GuardedApp = defineComponent({
  name: 'MenuEditPanelGuard',
  setup: () => () => (store.user ? h(App) : null),
})

export default (ctx: Context) => {
  ctx.page({
    path: '/menu-edit',
    name: PANEL_NAME,
    order: 6,
    authority: CONSOLE_PANEL_AUTHORITY,
    component: GuardedApp,
  })
}
