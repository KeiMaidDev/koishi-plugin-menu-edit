import { send } from '@koishijs/client'
import type {
  BotInstanceSummary,
  DiscardDraftInput,
  DraftMutationResult,
  GroupPanelPublishInput,
  GroupPanelPublishResult,
  ImportGroupPanelInput,
  ImportGroupPanelResult,
  ImportPrivateMenuInput,
  ImportPrivateMenuResult,
  PrivateMenuPublishInput,
  PrivateMenuPublishResult,
  SaveDraftInput,
  WorkspaceSnapshot,
} from '../src/types'

export type {
  BotInstanceSummary,
  DiscardDraftInput,
  DraftMutationResult,
  DraftRevisionConflict,
  GroupPanelCandidate,
  GroupPanelItemType,
  GroupPanelPublishInput,
  GroupPanelPublishResult,
  ImportGroupPanelInput,
  ImportGroupPanelResult,
  ImportPrivateMenuInput,
  ImportPrivateMenuResult,
  PanelConfiguration,
  PrivateMenuPublishInput,
  PrivateMenuPublishResult,
  SaveDraftInput,
  ValidationIssue,
  WorkspaceSnapshot,
} from '../src/types'

// @koishijs/client 的 send 不感知插件事件契约；这里逐个封装 RPC，
// 保持与 src/console.ts 服务端监听一致的类型。

export const fetchBots = () => send<BotInstanceSummary[]>('menu-edit/bots')
export const fetchWorkspace = (appId: string) => send<WorkspaceSnapshot>('menu-edit/workspace', appId)
export const saveDraft = (input: SaveDraftInput) => send<DraftMutationResult>('menu-edit/save-draft', input)
export const discardDraft = (input: DiscardDraftInput) =>
  send<DraftMutationResult>('menu-edit/discard-draft', input)
export const importPrivateMenu = (input: ImportPrivateMenuInput) =>
  send<ImportPrivateMenuResult>('menu-edit/import-private-menu', input)
export const publishPrivateMenu = (input: PrivateMenuPublishInput) =>
  send<PrivateMenuPublishResult>('menu-edit/publish-private-menu', input)
export const importGroupPanel = (input: ImportGroupPanelInput) =>
  send<ImportGroupPanelResult>('menu-edit/import-group-panel', input)
export const publishGroupPanel = (input: GroupPanelPublishInput) =>
  send<GroupPanelPublishResult>('menu-edit/publish-group-panel', input)
