import { message, messageBox } from '@koishijs/client'
import { defineComponent, h, onBeforeUnmount, onMounted, reactive, resolveComponent } from 'vue'
import { emptyPanelConfiguration, PANEL_SCOPES, PANEL_SCOPE_LABELS, type BotInstanceSummary, type CommandPanelCandidate, type CommandPanelPublishResult, type CommandPanelScopeCandidates, type DraftRevisionConflict, type PanelConfiguration, type PanelScope, type PrivateMenuPublishResult, type ValidationIssue, type WorkspaceSnapshot } from '../src/types'
import { validatePanelConfiguration } from '../src/validation'
import * as api from './api'
import { PrivateMenuEditor } from './private-editor'
import { normalizeConfiguration } from './private-menu'
import { PrivateMenuPreview } from './phone-preview'
import { CommandPanelEditor } from './command-editor'
import { CommandPanelPreview } from './command-preview'

/** 控制台页名：侧栏入口与 ctx.page 的 name 共用同一字面量。 */
export const PANEL_NAME = '机器人菜单'

const AUTO_SAVE_DELAY = 900

type SaveStatus = 'saved' | 'saving' | 'failed' | 'unsaved'
type TabKey = 'private' | 'command'
type ViewMode = 'visual' | 'json'

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
  configuration: PanelConfiguration
  savedJson: string
  jsonText: string
  jsonError: string
  status: SaveStatus
  error: string
  conflict: DraftRevisionConflict | null
  importError: string
  importCandidates: CommandPanelScopeCandidates[]
  importSelections: Partial<Record<PanelScope, string>>
  publishMessage: string
  publishIssues: ValidationIssue[]
  tab: TabKey
  mode: ViewMode
  loading: boolean
  importing: boolean
  publishing: boolean
}


function stringify(configuration: PanelConfiguration): string {
  return JSON.stringify(configuration, null, 2)
}

function canonical(configuration: PanelConfiguration): string {
  return JSON.stringify(configuration)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 清理确认框里按场景逐项展示待删除面板的 ID、备注、更新时间与条目摘要。 */
function formatCleanupCandidates(groups: CommandPanelScopeCandidates[]): string {
  return groups.map(group => {
    const lines = group.candidates.map(candidate => {
      const remark = candidate.remark ? `（${candidate.remark}）` : ''
      const updatedAt = candidate.updatedAt ?? '未知更新时间'
      return `  · ${candidate.panelId}${remark} · ${updatedAt} · ${candidate.itemCount} 项：${candidate.itemSummary}`
    })
    return `${PANEL_SCOPE_LABELS[group.scope]}\n${lines.join('\n')}`
  }).join('\n')
}

const PANEL_STYLE_ID = 'menu-edit-panel-style'

const PANEL_STYLE = `
.me-panel { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; padding: 16px; }
.me-panel * { box-sizing: border-box; }
.me-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.me-toolbar .me-spacer { flex: 1; }
.me-bots { display: flex; flex-wrap: wrap; gap: 8px; }
.me-bot { display: flex; align-items: center; gap: 10px; min-width: 220px; padding: 8px 12px; cursor: pointer; border: 1px solid var(--k-border-color, #dcdfe6); border-radius: 8px; background: var(--k-card-bg, transparent); }
.me-bot.me-active { border-color: var(--k-color-primary, #409eff); box-shadow: 0 0 0 1px var(--k-color-primary, #409eff) inset; }
.me-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: flex; align-items: center; justify-content: center; background: var(--k-color-primary, #409eff); color: #fff; font-size: 14px; flex: none; }
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
.me-button { padding: 5px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; border: 1px solid var(--k-border-color, #dcdfe6); background: var(--k-card-bg, #fff); color: inherit; }
.me-button:disabled { cursor: not-allowed; opacity: .5; }
.me-button.me-button-sm { padding: 3px 10px; font-size: 12px; }
.me-button.me-primary { border-color: var(--k-color-primary, #409eff); background: var(--k-color-primary, #409eff); color: #fff; }
.me-button.me-danger { border-color: #e6a23c; color: #e6a23c; }
.me-icon-btn { width: 26px; height: 26px; padding: 0; border-radius: 6px; cursor: pointer; border: 1px solid var(--k-border-color, #dcdfe6); background: var(--k-card-bg, #fff); color: inherit; font-size: 13px; line-height: 1; }
.me-icon-btn:disabled { cursor: not-allowed; opacity: .4; }
.me-icon-btn.me-icon-danger { color: #c62828; }
.me-alert { padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.me-alert-error { background: #fdecea; color: #c62828; }
.me-alert-warn { background: #fff8e1; color: #8a6d00; }
.me-alert-success { background: #e8f5e9; color: #2e7d32; }
.me-editor { flex: 1; min-height: 320px; width: 100%; resize: vertical; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; color: inherit; background: var(--k-card-bg, transparent); border: 1px solid var(--k-border-color, #dcdfe6); border-radius: 8px; }
.me-hint { font-size: 12px; color: var(--k-text-light, #909399); }
.me-conflict { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.me-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--k-border-color, #dcdfe6); }
.me-tab { padding: 6px 14px; cursor: pointer; border: none; background: transparent; color: inherit; border-bottom: 2px solid transparent; font-size: 14px; }
.me-tab.me-tab-active { color: var(--k-color-primary, #409eff); border-bottom-color: var(--k-color-primary, #409eff); }
.me-mode { display: flex; gap: 4px; }
.me-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.me-column { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.me-editor-list { display: flex; flex-direction: column; gap: 8px; }
.me-count { font-size: 12px; color: var(--k-text-light, #909399); }
.me-card { border: 1px solid var(--k-border-color, #dcdfe6); border-radius: 10px; background: var(--k-card-bg, transparent); overflow: hidden; }
.me-card.me-card-invalid { border-color: #e6a23c; }
.me-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.me-drag-handle { cursor: grab; color: var(--k-text-light, #909399); user-select: none; }
.me-type-icon { width: 18px; height: 18px; object-fit: contain; }
.me-strip-fallback { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: #c0c4cc; color: #fff; font-size: 11px; }
.me-card-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.me-type-badge { padding: 1px 8px; border-radius: 10px; font-size: 11px; background: #eef1f6; color: #606266; }
.me-check { padding: 1px 8px; border-radius: 10px; font-size: 11px; }
.me-check-ok { color: #2e7d32; }
.me-check-error { background: #fdecea; color: #c62828; }
.me-check-warn { background: #fff8e1; color: #b26a00; }
.me-card-body { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 14px; border-top: 1px solid var(--k-border-color, #dcdfe6); }
.me-field { display: flex; align-items: center; gap: 10px; }
.me-field-label { width: 74px; flex: none; font-size: 13px; color: var(--k-text-light, #909399); }
.me-input, .me-select { flex: 1; min-width: 0; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--k-border-color, #dcdfe6); background: var(--k-card-bg, #fff); color: inherit; font-size: 13px; }
.me-sub-list { display: flex; flex-direction: column; gap: 6px; }
.me-sub-title { font-size: 12px; color: var(--k-text-light, #909399); }
.me-sub-row { display: grid; grid-template-columns: auto minmax(0,1.2fr) 110px minmax(0,1.4fr) auto auto auto; gap: 6px; align-items: center; }
.me-add-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.me-phone { position: relative; width: 300px; max-width: 100%; border: 10px solid #2b2b2b; border-radius: 28px; background: #ededed; overflow: hidden; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
.me-phone-screen { display: flex; flex-direction: column; height: 520px; }
.me-phone-notice { padding: 8px; text-align: center; font-size: 12px; color: #666; border-bottom: 1px solid #dcdcdc; }
.me-phone-body { flex: 1; padding: 12px; overflow: hidden; }
.me-bubble { display: inline-block; padding: 8px 12px; background: #fff; border-radius: 10px; font-size: 13px; color: #333; }
.me-phone-input-zone { border-top: 1px solid #dcdcdc; background: #f7f7f7; }
.me-strip { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; padding: 10px; scrollbar-width: thin; }
.me-strip-empty { padding: 10px; font-size: 12px; color: #999; }
.me-strip-btn { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; padding: 7px 12px; border-radius: 18px; border: 1px solid #d9d9d9; background: #fff; color: #333; font-size: 13px; cursor: pointer; white-space: nowrap; }
.me-strip-btn-flash { box-shadow: 0 0 0 2px #409eff inset; }
.me-strip-btn-open { border-color: #409eff; }
.me-strip-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-strip-icon { width: 18px; height: 18px; object-fit: contain; }
.me-switch-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.me-switch-dot.me-off { background: #c0c4cc; }
.me-switch-dot.me-on { background: #409eff; }
.me-strip-btn.me-switch-off { color: #999; }
.me-strip-btn.me-switch-on { color: #409eff; }
.me-phone-inputbar { margin: 0 10px 10px; padding: 8px 12px; border-radius: 18px; background: #fff; color: #bbb; font-size: 13px; }
.me-sheet { position: absolute; left: 0; right: 0; bottom: 0; background: #fff; border-top-left-radius: 16px; border-top-right-radius: 16px; box-shadow: 0 -6px 20px rgba(0,0,0,.16); max-height: 70%; overflow-y: auto; }
.me-sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #eee; }
.me-sheet-title { font-size: 13px; color: #333; }
.me-sheet-close { border: none; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: #999; }
.me-sheet-list { display: flex; flex-direction: column; }
.me-sheet-row { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border: none; border-bottom: 1px solid #f2f2f2; background: #fff; color: #333; font-size: 13px; cursor: pointer; text-align: left; }
.me-sheet-row-flash { background: #f0f7ff; }
.me-sheet-empty { padding: 14px; font-size: 12px; color: #999; }
.me-admin-badge { padding: 1px 6px; border-radius: 8px; font-size: 11px; background: #fff3e0; color: #b26a00; }
.me-type-badge-warn { background: #fdecea; color: #c62828; }
.me-candidate { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 13px; }
.me-candidate-group { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.me-candidate-title { font-size: 12px; font-weight: 600; color: #8a6d00; }
.me-scope-row { display: flex; flex-wrap: wrap; gap: 6px; }
.me-scope-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 14px; border: 1px solid var(--k-border-color, #dcdfe6); font-size: 12px; cursor: pointer; }
.me-scope-chip-on { border-color: var(--k-color-primary, #409eff); color: var(--k-color-primary, #409eff); background: #ecf5ff; }
.me-name-input { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
.me-name-prefix { color: var(--k-text-light, #909399); font-size: 13px; }
.me-command-screen { height: 520px; background: #f0f0f0; }
.me-scope-tabs { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid #e5e5e5; background: #fff; }
.me-scope-tab { flex: 1; padding: 5px 4px; border: none; border-radius: 6px; background: #f4f4f4; color: #666; font-size: 12px; cursor: pointer; }
.me-scope-tab-active { background: #1a8cff; color: #fff; }
.me-command-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; padding: 12px; overflow: hidden; }
.me-command-panel { max-height: 55%; overflow-y: auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
.me-command-list { display: flex; flex-direction: column; overflow: hidden; }
.me-command-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
.me-command-row:last-child { border-bottom: none; }
.me-command-index { flex: none; width: 20px; height: 20px; border-radius: 50%; background: #eef3ff; color: #3b6fd4; font-size: 12px; display: flex; align-items: center; justify-content: center; }
.me-command-main { min-width: 0; flex: 1; }
.me-command-title { display: flex; align-items: center; gap: 6px; }
.me-command-name { font-size: 13px; color: #111; }
.me-command-desc { margin-top: 3px; font-size: 12px; color: #b8b8b8; word-break: break-all; }
.me-command-chevron { flex: none; color: #c4c4c4; font-size: 18px; }
.me-command-empty { padding: 20px 10px; text-align: center; font-size: 12px; color: #999; }
.me-command-input-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px 10px; border-top: 1px solid #e5e5e5; background: #f7f7f7; }
.me-command-input { flex: 1; padding: 8px 12px; border-radius: 16px; background: #fff; color: #bbb; font-size: 13px; }
.me-command-send { padding: 8px 14px; border-radius: 16px; background: #1a8cff; color: #fff; font-size: 13px; }@media (max-width: 900px) { .me-layout { grid-template-columns: minmax(0, 1fr); } }
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
      configuration: emptyPanelConfiguration(),
      savedJson: canonical(emptyPanelConfiguration()),
      jsonText: stringify(emptyPanelConfiguration()),
      jsonError: '',
      status: 'saved',
      error: '',
      conflict: null,
      importError: '',
      importCandidates: [],
      importSelections: {},
      publishMessage: '',
      publishIssues: [],
      tab: 'private',
      mode: 'visual',
      loading: false,
      importing: false,
      publishing: false,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelAutoSave = () => {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    }

    const isDirty = () => canonical(state.configuration) !== state.savedJson

    const applyConflict = (conflict: DraftRevisionConflict) => {
      cancelAutoSave()
      state.conflict = conflict
      state.status = 'failed'
      state.error = `revision 冲突：服务端当前为 revision ${conflict.revision}，本地为 revision ${state.revision}。`
    }

    const markDirty = () => {
      state.conflict = null
      state.error = ''
      state.publishMessage = ''
      state.status = isDirty() ? 'unsaved' : 'saved'
      if (isDirty()) scheduleAutoSave()
    }

    /** 结构化编辑的入口：更新 configuration，并同步 JSON 文本。 */
    const updateConfiguration = (next: PanelConfiguration) => {
      state.configuration = next
      state.jsonText = stringify(next)
      state.jsonError = ''
      markDirty()
    }

    const loadWorkspace = async (appId: string) => {
      cancelAutoSave()
      state.loading = true
      try {
        const snapshot: WorkspaceSnapshot = await api.fetchWorkspace(appId)
        state.activeAppId = snapshot.bot.appId
        state.revision = snapshot.revision
        state.updatedAt = snapshot.updatedAt
        state.configuration = snapshot.draft
        state.savedJson = canonical(snapshot.draft)
        state.jsonText = stringify(snapshot.draft)
        state.jsonError = ''
        state.status = 'saved'
        state.error = ''
        state.conflict = null
        state.importError = ''
        state.importCandidates = []
        state.importSelections = {}
        state.publishMessage = ''
        state.publishIssues = []
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      } finally {
        state.loading = false
      }
    }

    const save = async () => {
      if (!state.activeAppId || state.status === 'saving') return
      if (state.jsonError) {
        state.status = 'failed'
        state.error = `JSON 解析失败：${state.jsonError}`
        return
      }
      if (!isDirty()) {
        state.status = 'saved'
        return
      }
      cancelAutoSave()
      const submitted = canonical(state.configuration)
      state.status = 'saving'
      state.error = ''
      try {
        const result = await api.saveDraft({
          appId: state.activeAppId,
          expectedRevision: state.revision,
          configuration: state.configuration,
        })
        if (result.ok) {
          state.revision = result.revision
          state.updatedAt = result.savedAt
          state.savedJson = submitted
          state.error = ''
          state.conflict = null
          if (canonical(state.configuration) === submitted) state.status = 'saved'
          else {
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

    function scheduleAutoSave() {
      cancelAutoSave()
      timer = setTimeout(() => {
        timer = undefined
        void save()
      }, AUTO_SAVE_DELAY)
    }

    const onJsonInput = (value: string) => {
      state.jsonText = value
      state.conflict = null
      state.publishMessage = ''
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('顶层必须是 JSON 对象')
        }
        state.configuration = normalizeConfiguration(parsed)
        state.jsonError = ''
      } catch (error) {
        state.jsonError = errorMessage(error)
      }
      state.status = state.jsonError ? 'unsaved' : (isDirty() ? 'unsaved' : 'saved')
      state.error = ''
      if (state.jsonError) {
        cancelAutoSave()
        return
      }
      if (isDirty()) scheduleAutoSave()
    }

    const formatJson = () => {
      if (state.jsonError) {
        state.error = `JSON 解析失败：${state.jsonError}`
        return
      }
      state.jsonText = stringify(state.configuration)
      message.success('已格式化 JSON')
    }

    const selectBot = async (appId: string) => {
      if (appId === state.activeAppId || state.loading) return
      if (isDirty()) {
        try {
          await messageBox.confirm('切换 Bot Instance 会丢弃当前未保存的本地修改，是否继续？', '切换 Bot Instance', {
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
        const result = await api.discardDraft({ appId: state.activeAppId, expectedRevision: state.revision })
        if (result.ok) await loadWorkspace(state.activeAppId)
        else applyConflict(result)
      } catch (error) {
        state.status = 'failed'
        state.error = errorMessage(error)
      }
    }

    const importPrivateMenu = async () => {
      if (!state.activeAppId || state.importing) return
      if (isDirty()) {
        try {
          await messageBox.confirm(
            '导入会用平台当前 Private Menu 覆盖 Draft，并记为导入内容。是否继续？',
            '导入 Private Menu',
            { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' },
          )
        } catch {
          return
        }
      }
      cancelAutoSave()
      state.importing = true
      state.importError = ''
      try {
        const result = await api.importPrivateMenu({ appId: state.activeAppId })
        if (result.ok) {
          message.success('已导入 Private Menu')
          await loadWorkspace(state.activeAppId)
        } else {
          state.importError = `导入失败：${result.message}`
        }
      } catch (error) {
        state.importError = `导入失败：${errorMessage(error)}`
      } finally {
        state.importing = false
      }
    }

    const importCommandPanel = async (selections?: Partial<Record<PanelScope, string>>) => {
      if (!state.activeAppId || state.importing) return
      if (selections === undefined && isDirty()) {
        try {
          await messageBox.confirm(
            '导入会用平台当前指令面板覆盖 Draft，并记为导入内容。是否继续？',
            '导入指令面板',
            { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' },
          )
        } catch {
          return
        }
      }
      cancelAutoSave()
      state.importing = true
      state.importError = ''
      if (selections === undefined) {
        state.importCandidates = []
        state.importSelections = {}
      }
      try {
        const result = await api.importCommandPanel({ appId: state.activeAppId, selections })
        if (result.ok) {
          const scopes = Object.keys(result.managedPanelIds) as PanelScope[]
          message.success(scopes.length ? '已导入指令面板' : '平台没有可接管的 all 面板，已留空')
          await loadWorkspace(state.activeAppId)
          state.publishMessage = scopes.length
            ? `已接管 ${scopes.length} 个场景的受管面板。`
            : '当前没有可接管的指令面板；发布时会按场景创建受管面板。'
          state.publishIssues = [
            ...result.conflicts.map(conflict => ({
              severity: 'warning' as const,
              code: 'command-panel.import-conflict',
              path: 'commandPanel.items',
              message: `「${conflict.name}」在 ${conflict.scopes.map(scope => PANEL_SCOPE_LABELS[scope]).join('、')} 有 ${conflict.variants} 种不同字段，已保留为多条。`,
            })),
            ...PANEL_SCOPES.flatMap(scope => (result.specificPanels[scope] ?? []).map(panel => ({
              severity: 'warning' as const,
              code: 'command-panel.import-specific',
              path: `commandPanel.scopes.${scope}`,
              message: `${PANEL_SCOPE_LABELS[scope]} 场景存在 specific 面板 ${panel.panelId}，本页不会接管或删除它。`,
            }))),
          ]
        } else if (result.code === 'selection-required') {
          state.importCandidates = result.candidates
          const next: Partial<Record<PanelScope, string>> = {}
          for (const group of result.candidates) next[group.scope] = group.candidates[0]?.panelId ?? ''
          state.importSelections = next
          state.publishMessage = '多个场景存在多个指令面板候选，请为每个场景选择接管对象。'
        } else {
          state.importError = `导入失败：${result.message}`
        }
      } catch (error) {
        state.importError = `导入失败：${errorMessage(error)}`
      } finally {
        state.importing = false
      }
    }

    const publishCommandPanel = async (
      cleanupPanelIds?: Partial<Record<PanelScope, string[]>>,
      warningsConfirmed = false,
    ): Promise<void> => {
      if (!state.activeAppId || state.publishing) return
      if (state.jsonError) {
        state.error = `JSON 解析失败：${state.jsonError}`
        return
      }
      if (isDirty() || state.status !== 'saved') {
        await save()
      }
      if (isDirty() || state.status === 'failed') return

      const commandValidation = validatePanelConfiguration(state.configuration)
      const commandErrors = commandValidation.errors.filter(issue => issue.path.startsWith('commandPanel'))
      if (commandErrors.length) {
        state.publishIssues = commandErrors
        state.publishMessage = `发布被阻止：指令面板有 ${commandErrors.length} 个硬错误。`
        return
      }
      const warnings = commandValidation.warnings.filter(issue => issue.path.startsWith('commandPanel'))
      if (warnings.length && !warningsConfirmed) {
        try {
          await messageBox.confirm(
            `存在 ${warnings.length} 条警告：\n${warnings.slice(0, 6).map(issue => `· ${issue.message}`).join('\n')}\n\n仍要发布吗？`,
            '发布确认',
            { type: 'warning', confirmButtonText: '发布', cancelButtonText: '取消' },
          )
        } catch {
          return
        }
      }

      state.publishing = true
      state.publishMessage = ''
      state.publishIssues = []
      try {
        const result: CommandPanelPublishResult = await api.publishCommandPanel({
          appId: state.activeAppId,
          expectedRevision: state.revision,
          cleanupPanelIds,
        })
        if (result.ok) {
          const panels = Object.values(result.published).filter(panel => panel !== undefined)
          const pending = panels.reduce((sum, panel) => sum + panel.cleanup.panelIds.length, 0)
          const failedScopes = result.scopeResults.filter(scope => scope.status === 'failed')
          const successfulScopes = result.scopeResults.filter(scope => scope.status !== 'failed')
          if (result.status === 'partial') message.warning('指令面板部分发布')
          else message.success('指令面板已发布')
          await loadWorkspace(state.activeAppId)
          if (result.status === 'partial') {
            const details = [
              successfulScopes.length ? `已写入 ${successfulScopes.length} 个场景` : '',
              failedScopes.length ? `失败场景：${failedScopes.map(item => PANEL_SCOPE_LABELS[item.scope]).join('、')}` : '',
              pending ? `仍有 ${pending} 个面板待清理` : '',
            ].filter(Boolean)
            state.publishMessage = `${details.join('；')}。`
          } else {
            state.publishMessage = `指令面板已发布到 ${panels.length} 个使用场景。`
          }
          state.publishIssues = [
            ...result.warnings,
            ...failedScopes.map(scope => ({
              severity: 'error' as const,
              code: `command-panel.publish-${scope.code ?? 'failed'}`,
              path: `commandPanel.scopes.${scope.scope}`,
              message: `${PANEL_SCOPE_LABELS[scope.scope]} 场景发布失败：${scope.message ?? '未知错误'}`,
            })),
          ]
        } else if (result.code === 'cleanup-confirmation-required') {
          state.publishing = false
          let confirmed = false
          try {
            await messageBox.confirm(
              `发布前需要删除以下其他 all 指令面板：\n\n${formatCleanupCandidates(result.candidates)}\n\n删除后无法从本页面恢复，是否继续？`,
              '确认清理其他指令面板',
              { type: 'warning', confirmButtonText: '确认删除并发布', cancelButtonText: '取消' },
            )
            confirmed = true
          } catch {
            confirmed = false
          }
          if (confirmed) {
            const ids: Partial<Record<PanelScope, string[]>> = {}
            for (const group of result.candidates) ids[group.scope] = group.candidates.map(candidate => candidate.panelId)
            return publishCommandPanel(ids, true)
          }
          state.publishMessage = '已取消清理，Draft 未发布。'
        } else if (result.code === 'revision-conflict') {
          applyConflict({ ok: false, reason: 'revision-conflict', revision: result.revision, draft: result.draft })
          state.publishMessage = result.message
        } else if (result.code === 'validation-failed') {
          state.publishIssues = result.errors
          state.publishMessage = result.message
        } else if (result.code === 'quantity-limit') {
          state.publishMessage = '发布失败：QQ 平台返回条目数量超限（40030013），Draft 与旧 Published Revision 已保留。'
        } else {
          state.publishMessage = `发布失败：${result.message}`
        }
      } catch (error) {
        state.publishMessage = `发布失败：${errorMessage(error)}`
      } finally {
        state.publishing = false
      }
    }

    const localValidation = () => validatePanelConfiguration(state.configuration)

    const publishPrivateMenu = async () => {
      if (!state.activeAppId || state.publishing) return
      if (state.jsonError) {
        state.error = `JSON 解析失败：${state.jsonError}`
        return
      }
      if (isDirty() || state.status !== 'saved') {
        await save()
      }
      if (isDirty() || state.status === 'failed') return

      const privateValidation = validatePanelConfiguration(state.configuration)
      const privateErrors = privateValidation.errors.filter(issue => issue.path.startsWith('privateMenu'))
      if (privateErrors.length) {
        state.publishIssues = privateErrors
        state.publishMessage = `发布被阻止：Private Menu 有 ${privateErrors.length} 个硬错误。`
        return
      }
      const warnings = privateValidation.warnings.filter(issue => issue.path.startsWith('privateMenu'))
      if (warnings.length) {
        try {
          await messageBox.confirm(
            `存在 ${warnings.length} 条警告：\n${warnings.slice(0, 6).map(issue => `· ${issue.message}`).join('\n')}\n\n仍要发布吗？`,
            '发布确认',
            { type: 'warning', confirmButtonText: '发布', cancelButtonText: '取消' },
          )
        } catch {
          return
        }
      }

      state.publishing = true
      state.publishMessage = ''
      state.publishIssues = []
      try {
        const result: PrivateMenuPublishResult = await api.publishPrivateMenu({
          appId: state.activeAppId,
          expectedRevision: state.revision,
        })
        if (result.ok) {
          message.success('Private Menu 已发布')
          await loadWorkspace(state.activeAppId)
          state.publishMessage = `Private Menu 发布成功（平台版本 ${result.published.version ?? '未知'}）。`
          state.publishIssues = result.warnings
        } else if (result.code === 'revision-conflict') {
          applyConflict({ ok: false, reason: 'revision-conflict', revision: result.revision, draft: result.draft })
          state.publishMessage = result.message
        } else if (result.code === 'validation-failed') {
          state.publishIssues = result.errors
          state.publishMessage = result.message
        } else {
          state.publishMessage = `发布失败：${result.message}`
        }
      } catch (error) {
        state.publishMessage = `发布失败：${errorMessage(error)}`
      } finally {
        state.publishing = false
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
      return h('div', { class: ['me-bot', active ? 'me-active' : ''], onClick: () => void selectBot(bot.appId) }, [
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
      ])
    }

    const renderToolbar = () => h('div', { class: 'me-toolbar' }, [
      h('span', { class: ['me-badge', `me-${state.status}`] }, STATUS_TEXT[state.status]),
      h('span', { class: 'me-hint' }, state.activeAppId ? `revision ${state.revision}` : '未选择 Bot Instance'),
      h('span', { class: 'me-spacer' }),
      h('button', {
        type: 'button',
        class: 'me-button',
        disabled: state.loading || state.importing || !state.activeAppId,
        onClick: () => void (state.tab === 'command' ? importCommandPanel() : importPrivateMenu()),
      }, state.importing ? '导入中…' : (state.tab === 'command' ? '导入指令面板' : '导入 Private Menu')),
      h('button', { type: 'button', class: 'me-button', disabled: state.loading, onClick: () => void reload() }, '重新加载'),
      h('button', { type: 'button', class: 'me-button me-danger', disabled: state.loading, onClick: () => void discard() }, 'Discard Draft'),
      h('button', { type: 'button', class: 'me-button', disabled: state.loading || state.status !== 'unsaved', onClick: () => void save() }, '保存'),
      h('button', {
        type: 'button',
        class: 'me-button me-primary',
        disabled: state.loading || state.publishing || !state.activeAppId,
        onClick: () => void (state.tab === 'command' ? publishCommandPanel() : publishPrivateMenu()),
      }, state.publishing ? '发布中…' : 'Publish'),
    ])

    const renderConflict = () => state.conflict
      ? h('div', { class: 'me-alert me-alert-warn me-conflict' }, [
        h('span', `检测到 revision 冲突：服务端当前为 revision ${state.conflict.revision}。`),
        h('button', { type: 'button', class: 'me-button', onClick: () => void reload() }, '重新加载最新 Draft'),
        h('button', { type: 'button', class: 'me-button me-primary', onClick: () => void forceOverwrite() }, '以最新 revision 强制覆盖'),
      ])
      : null

    const renderIssueSummary = () => {
      const validation = localValidation()
      const prefix = state.tab === 'command' ? 'commandPanel' : 'privateMenu'
      const surfaceIssues = [...validation.errors, ...validation.warnings].filter(issue => issue.path.startsWith(prefix))
      const orphan = surfaceIssues.filter(issue => !issue.path.startsWith(`${prefix}.items[`))
      const seen = new Set(orphan.map(issue => `${issue.code}|${issue.path}`))
      const extra = state.publishIssues.filter(issue => issue.path.startsWith(prefix) && !seen.has(`${issue.code}|${issue.path}`))
      const list = [...orphan, ...extra]
      if (!list.length) return null
      const hasError = list.some(issue => issue.severity === 'error')
      return h('div', { class: ['me-alert', hasError ? 'me-alert-error' : 'me-alert-warn'] },
        list.map(issue => h('div', {}, `${issue.severity === 'error' ? '错误' : '警告'} · ${issue.message}`)))
    }

    const renderImportCandidates = () => state.importCandidates.length
      ? h('div', { class: 'me-alert me-alert-warn' }, [
        h('div', {}, '多个场景存在多个指令面板候选，请为每个场景选择接管对象：'),
        ...state.importCandidates.map(group => h('div', { class: 'me-candidate-group' }, [
          h('div', { class: 'me-candidate-title' }, PANEL_SCOPE_LABELS[group.scope]),
          ...group.candidates.map(candidate => h('label', { class: 'me-candidate' }, [
            h('input', {
              type: 'radio',
              name: `command-panel-candidate-${group.scope}`,
              checked: state.importSelections[group.scope] === candidate.panelId,
              onChange: () => { state.importSelections = { ...state.importSelections, [group.scope]: candidate.panelId } },
            }),
            h('span', {}, `${candidate.panelId}${candidate.remark ? `（${candidate.remark}）` : ''} · ${candidate.updatedAt ?? '未知更新时间'} · ${candidate.itemCount} 项：${candidate.itemSummary}`),
          ])),
        ])),
        h('button', {
          type: 'button',
          class: 'me-button me-primary',
          disabled: state.importing || state.importCandidates.some(group => !state.importSelections[group.scope]),
          onClick: () => void importCommandPanel(state.importSelections),
        }, state.importing ? '导入中…' : '接管所选面板'),
      ])
      : null
    const renderBots = () => state.bots.length
      ? h('div', { class: 'me-bots' }, state.bots.map(renderBot))
      : h('div', { class: 'me-hint' }, state.loading ? '正在加载 Bot Instance 列表…' : '没有可管理的 QQ Bot Instance。')

    const renderSwitchTabs = () => h('div', { class: 'me-toolbar' }, [
      h('div', { class: 'me-tabs' }, [
        h('button', { type: 'button', class: ['me-tab', state.tab === 'private' ? 'me-tab-active' : ''], onClick: () => { state.tab = 'private' } }, '私聊菜单'),
        h('button', { type: 'button', class: ['me-tab', state.tab === 'command' ? 'me-tab-active' : ''], onClick: () => { state.tab = 'command' } }, '指令面板'),
      ]),
      h('span', { class: 'me-spacer' }),
      h('div', { class: 'me-mode' }, [
        h('button', { type: 'button', class: ['me-button', state.mode === 'visual' ? 'me-primary' : ''], onClick: () => { state.mode = 'visual' } }, '可视化'),
        h('button', { type: 'button', class: ['me-button', state.mode === 'json' ? 'me-primary' : ''], onClick: () => { state.mode = 'json' } }, 'JSON'),
      ]),
    ])

    const renderJsonEditor = () => h('div', { class: 'me-column' }, [
      h('div', { class: 'me-hint' }, 'JSON Panel Configuration（privateMenu / commandPanel；未知字段会原样保留）'),
      state.jsonError ? h('div', { class: 'me-alert me-alert-error' }, `JSON 解析失败：${state.jsonError}`) : null,
      h('textarea', {
        class: 'me-editor',
        value: state.jsonText,
        spellcheck: false,
        onInput: (event: Event) => onJsonInput((event.target as HTMLTextAreaElement).value),
      }),
      h('div', { class: 'me-toolbar' }, [
        h('button', { type: 'button', class: 'me-button', disabled: !!state.jsonError, onClick: formatJson }, '格式化 JSON'),
      ]),
    ])

    const renderVisual = () => {
      if (state.tab === 'command') {
        const validation = localValidation()
        const issues = [...validation.errors, ...validation.warnings]
        return h('div', { class: 'me-layout' }, [
          h('div', { class: 'me-column' }, [
            h(CommandPanelEditor, {
              items: state.configuration.commandPanel.items,
              issues,
              'onUpdate:items': (items: unknown[]) => updateConfiguration({
                ...state.configuration,
                commandPanel: { ...state.configuration.commandPanel, items },
              }),
            }),
          ]),
          h('div', { class: 'me-column' }, [
            h('div', { class: 'me-hint' }, '手机预览'),
            h(CommandPanelPreview, { items: state.configuration.commandPanel.items }),
            h('div', { class: 'me-hint' }, '预览可在四个使用场景间切换，只读，不触发真实指令。'),
          ]),
        ])
      }
      const validation = localValidation()
      const issues = [...validation.errors, ...validation.warnings]
      return h('div', { class: 'me-layout' }, [
        h('div', { class: 'me-column' }, [
          h(PrivateMenuEditor, {
            items: state.configuration.privateMenu.items,
            issues,
            'onUpdate:items': (items: unknown[]) => updateConfiguration({
              ...state.configuration,
              privateMenu: { ...state.configuration.privateMenu, items },
            }),
          }),
        ]),
        h('div', { class: 'me-column' }, [
          h('div', { class: 'me-hint' }, '手机预览'),
          h(PrivateMenuPreview, { items: state.configuration.privateMenu.items }),
          h('div', { class: 'me-hint' }, '预览中的开关、菜单展开只影响预览态，不修改 Draft。'),
        ]),
      ])
    }

    return () => {
      const layout = resolveComponent('k-layout')
      const children = [
        renderToolbar(),
        renderConflict(),
        renderIssueSummary(),
        state.error ? h('div', { class: 'me-alert me-alert-error' }, state.error) : null,
        state.importError ? h('div', { class: 'me-alert me-alert-error' }, state.importError) : null,
        renderImportCandidates(),
        state.publishMessage ? h('div', { class: ['me-alert', state.publishMessage.includes('成功') ? 'me-alert-success' : 'me-alert-warn'] }, state.publishMessage) : null,
        renderBots(),
        state.bots.length ? renderSwitchTabs() : null,
        state.bots.length ? (state.mode === 'json' ? renderJsonEditor() : renderVisual()) : null,
      ]
      return h(layout, () => h('div', { class: 'me-panel' }, children))
    }
  },
})
