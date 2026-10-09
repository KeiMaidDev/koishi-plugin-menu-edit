import { message, messageBox } from '@koishijs/client'
import { defineComponent, h, onBeforeUnmount, onMounted, reactive, resolveComponent } from 'vue'
import type {
  BotInstanceSummary,
  DraftRevisionConflict,
  PanelConfiguration,
  WorkspaceSnapshot,
} from '../src/types'
import * as api from './api'

/** 控制台页名：侧栏入口与 ctx.page 的 name 共用同一字面量。 */
export const PANEL_NAME = '机器人菜单'

const AUTO_SAVE_DELAY = 900

type SaveStatus = 'saved' | 'saving' | 'failed' | 'unsaved'

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: '已保存',
  saving: '保存中…',
  failed: '保存失败',
  unsaved: '有未保存修改',
}

interface PanelState {
  bots: BotInstanceSummary[]
  activeAppId: string
  revision: number
  updatedAt: string
  text: string
  savedText: string
  status: SaveStatus
  error: string
  conflict: DraftRevisionConflict | null
  loading: boolean
}

function stringify(configuration: PanelConfiguration): string {
  return JSON.stringify(configuration, null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const PANEL_STYLE_ID = 'menu-edit-panel-style'

const PANEL_STYLE = `
.me-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow-y: auto;
  padding: 16px;
}
.me-panel * { box-sizing: border-box; }
.me-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.me-toolbar .me-spacer { flex: 1; }
.me-bots { display: flex; flex-wrap: wrap; gap: 8px; }
.me-bot {
  display: flex; align-items: center; gap: 10px;
  min-width: 220px; padding: 8px 12px; cursor: pointer;
  border: 1px solid var(--k-border-color, #dcdfe6); border-radius: 8px;
  background: var(--k-card-bg, transparent);
}
.me-bot.me-active { border-color: var(--k-color-primary, #409eff); box-shadow: 0 0 0 1px var(--k-color-primary, #409eff) inset; }
.me-avatar {
  width: 32px; height: 32px; border-radius: 50%; object-fit: cover;
  display: flex; align-items: center; justify-content: center;
  background: var(--k-color-primary, #409eff); color: #fff; font-size: 14px; flex: none;
}
.me-bot-meta { display: flex; flex-direction: column; min-width: 0; }
.me-bot-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-bot-sub { font-size: 12px; color: var(--k-text-light, #909399); }
.me-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #c0c4cc; margin-right: 4px; }
.me-dot.me-online { background: #67c23a; }
.me-badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; background: #f0f2f5; color: #606266; }
.me-badge.me-saved { background: #e8f5e9; color: #2e7d32; }
.me-badge.me-saving { background: #e3f2fd; color: #1565c0; }
.me-badge.me-failed { background: #fdecea; color: #c62828; }
.me-badge.me-unsaved { background: #fff8e1; color: #b26a00; }
.me-button {
  padding: 5px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--k-border-color, #dcdfe6); background: var(--k-card-bg, #fff); color: inherit;
}
.me-button:disabled { cursor: not-allowed; opacity: .5; }
.me-button.me-primary { border-color: var(--k-color-primary, #409eff); background: var(--k-color-primary, #409eff); color: #fff; }
.me-button.me-danger { border-color: #e6a23c; color: #e6a23c; }
.me-alert { padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.me-alert-error { background: #fdecea; color: #c62828; }
.me-alert-warn { background: #fff8e1; color: #8a6d00; }
.me-editor {
  flex: 1; min-height: 320px; width: 100%; resize: vertical; padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
  line-height: 1.5; color: inherit; background: var(--k-card-bg, transparent);
  border: 1px solid var(--k-border-color, #dcdfe6); border-radius: 8px;
}
.me-hint { font-size: 12px; color: var(--k-text-light, #909399); }
.me-conflict { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
`

function injectStyle() {
  if (document.getElementById(PANEL_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = PANEL_STYLE_ID
  style.textContent = PANEL_STYLE
  document.head.appendChild(style)
}

export default defineComponent({
  name: 'MenuEditPanel',
  setup() {
    const state = reactive<PanelState>({
      bots: [],
      activeAppId: '',
      revision: 0,
      updatedAt: '',
      text: '',
      savedText: '',
      status: 'saved',
      error: '',
      conflict: null,
      loading: false,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelAutoSave = () => {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    }

    const isDirty = () => state.text !== state.savedText

    const applyConflict = (conflict: DraftRevisionConflict) => {
      cancelAutoSave()
      state.conflict = conflict
      state.status = 'failed'
      state.error = `revision 冲突：服务端当前为 revision ${conflict.revision}，本地为 revision ${state.revision}。`
    }

    const loadWorkspace = async (appId: string) => {
      // 切换/重载会替换整段文本，先取消尚未触发的自动保存，避免用新 AppID 提交旧内容。
      cancelAutoSave()
      state.loading = true
      try {
        const snapshot: WorkspaceSnapshot = await api.fetchWorkspace(appId)
        state.activeAppId = snapshot.bot.appId
        state.revision = snapshot.revision
        state.updatedAt = snapshot.updatedAt
        state.text = stringify(snapshot.draft)
        state.savedText = state.text
        state.status = 'saved'
        state.error = ''
        state.conflict = null
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      } finally {
        state.loading = false
      }
    }

    const save = async () => {
      if (!state.activeAppId || state.status === 'saving') return
      cancelAutoSave()
      let configuration: PanelConfiguration
      try {
        configuration = JSON.parse(state.text) as PanelConfiguration
      } catch (error) {
        state.status = 'failed'
        state.error = `JSON 解析失败：${errorMessage(error)}`
        return
      }

      // 请求发出后用户可能继续输入；只有文本仍是这一版时才标记为已保存。
      const submitted = state.text
      state.status = 'saving'
      state.error = ''
      try {
        const result = await api.saveDraft({
          appId: state.activeAppId,
          expectedRevision: state.revision,
          configuration,
        })
        if (result.ok) {
          state.revision = result.revision
          state.updatedAt = result.savedAt
          state.savedText = submitted
          state.error = ''
          state.conflict = null
          if (state.text === submitted) {
            state.status = 'saved'
          } else {
            state.status = 'unsaved'
            scheduleAutoSave()
          }
        } else {
          applyConflict(result)
        }
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      }
    }

    const scheduleAutoSave = () => {
      cancelAutoSave()
      timer = setTimeout(() => {
        timer = undefined
        void save()
      }, AUTO_SAVE_DELAY)
    }

    const onInput = (value: string) => {
      state.text = value
      state.conflict = null
      state.error = ''
      if (value === state.savedText) {
        // 文本改回已保存内容时取消排队的自动保存，避免无变更却递增 revision。
        cancelAutoSave()
        state.status = 'saved'
        return
      }
      state.status = 'unsaved'
      scheduleAutoSave()
    }

    const formatJson = () => {
      try {
        state.text = stringify(JSON.parse(state.text) as PanelConfiguration)
        onInput(state.text)
        message.success('已格式化 JSON')
      } catch (error) {
        state.status = 'failed'
        state.error = `JSON 解析失败：${errorMessage(error)}`
      }
    }

    const selectBot = async (appId: string) => {
      if (appId === state.activeAppId || state.loading) return
      if (isDirty()) {
        try {
          await messageBox.confirm('切换机器人会丢弃当前未保存的本地修改，是否继续？', '切换机器人', {
            type: 'warning',
            confirmButtonText: '继续切换',
            cancelButtonText: '取消',
          })
        } catch {
          return
        }
      }
      await loadWorkspace(appId)
    }

    const reload = async () => {
      if (!state.activeAppId) return
      if (isDirty()) {
        try {
          await messageBox.confirm('重新加载会用服务端最新 Draft 覆盖当前本地修改，是否继续？', '重新加载', {
            type: 'warning',
            confirmButtonText: '重新加载',
            cancelButtonText: '取消',
          })
        } catch {
          return
        }
      }
      await loadWorkspace(state.activeAppId)
    }

    const forceOverwrite = async () => {
      if (!state.conflict) return
      state.revision = state.conflict.revision
      state.conflict = null
      await save()
    }

    const discard = async () => {
      if (!state.activeAppId) return
      try {
        await messageBox.confirm(
          'Discard Draft 会丢弃当前未发布的修改，并恢复为最近一次记录的内容。是否继续？',
          'Discard Draft',
          { type: 'warning', confirmButtonText: 'Discard', cancelButtonText: '取消' },
        )
      } catch {
        return
      }
      cancelAutoSave()
      state.status = 'saving'
      try {
        const result = await api.discardDraft({
          appId: state.activeAppId,
          expectedRevision: state.revision,
        })
        if (result.ok) await loadWorkspace(state.activeAppId)
        else applyConflict(result)
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      }
    }

    const init = async () => {
      state.loading = true
      try {
        state.bots = await api.fetchBots()
        if (state.bots.length) await loadWorkspace(state.bots[0].appId)
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      } finally {
        state.loading = false
      }
    }

    onMounted(() => {
      injectStyle()
      void init()
    })
    onBeforeUnmount(cancelAutoSave)

    const renderBot = (bot: BotInstanceSummary) => {
      const active = bot.appId === state.activeAppId
      return h(
        'div',
        {
          class: ['me-bot', active ? 'me-active' : ''],
          onClick: () => void selectBot(bot.appId),
        },
        [
          bot.avatar
            ? h('img', { class: 'me-avatar', src: bot.avatar, alt: bot.name })
            : h('div', { class: 'me-avatar' }, (bot.name || bot.appId).slice(0, 1)),
          h('div', { class: 'me-bot-meta' }, [
            h('div', { class: 'me-bot-name' }, bot.name),
            h('div', { class: 'me-bot-sub' }, [
              h('span', { class: ['me-dot', bot.online ? 'me-online' : ''] }),
              h('span', `${bot.online ? '在线' : '离线'} · AppID ${bot.appId}`),
            ]),
          ]),
        ],
      )
    }

    const renderToolbar = () => h('div', { class: 'me-toolbar' }, [
      h('span', { class: ['me-badge', `me-${state.status}`] }, STATUS_TEXT[state.status]),
      h('span', { class: 'me-hint' }, state.activeAppId ? `revision ${state.revision}` : '未选择机器人'),
      h('span', { class: 'me-spacer' }),
      h('button', { class: 'me-button', disabled: state.loading, onClick: () => void formatJson() }, '格式化 JSON'),
      h('button', { class: 'me-button', disabled: state.loading, onClick: () => void reload() }, '重新加载'),
      h('button', { class: 'me-button me-danger', disabled: state.loading, onClick: () => void discard() }, 'Discard Draft'),
      h('button', { class: 'me-button me-primary', disabled: state.loading || state.status === 'saving', onClick: () => void save() }, '保存'),
    ])

    const renderConflict = () => state.conflict
      ? h('div', { class: 'me-alert me-alert-warn me-conflict' }, [
        h('span', `检测到 revision 冲突：服务端当前为 revision ${state.conflict.revision}。`),
        h('button', { class: 'me-button', onClick: () => void reload() }, '重新加载最新 Draft'),
        h('button', { class: 'me-button me-primary', onClick: () => void forceOverwrite() }, '以最新 revision 强制覆盖'),
      ])
      : null

    return () => {
      const layout = resolveComponent('k-layout')
      const children = [
        renderToolbar(),
        renderConflict(),
        state.error ? h('div', { class: 'me-alert me-alert-error' }, state.error) : null,
        state.bots.length
          ? h('div', { class: 'me-bots' }, state.bots.map(renderBot))
          : h('div', { class: 'me-hint' }, state.loading ? '正在加载机器人列表…' : '没有可管理的 QQ Bot Instance。'),
        state.bots.length
          ? h('div', { style: 'display:flex;flex-direction:column;gap:6px;flex:1' }, [
            h('div', { class: 'me-hint' }, 'JSON Panel Configuration（privateMenu / groupPanel；未知字段会原样保留）'),
            h('textarea', {
              class: 'me-editor',
              value: state.text,
              spellcheck: false,
              onInput: (event: Event) => onInput((event.target as HTMLTextAreaElement).value),
            }),
          ])
          : null,
      ]
      return h(layout, () => h('div', { class: 'me-panel' }, children))
    }
  },
})
