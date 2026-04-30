import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { Copy, Edit3, GitBranch, Plus, Save, Search, ShieldCheck, Trash2, UserRoundCog } from 'lucide-react'
import { getAIProviders, type AIProviderInfo } from '../../types/ai'
import { getAiConfigPresets, getAiProvider, getAiProviderConfig, type AiConfigPreset } from '../../services/config'
import type { AgentDefinitionView, AgentToolView } from '../../stores/agentStore'
import ToolListPanel from './ToolListPanel'

interface Props {
  agents: AgentDefinitionView[]
  selectedAgentId: string | null
  tools: AgentToolView[]
  onSelectAgent: (id: string) => void
  onSaved: () => Promise<void> | void
}

type EditorMode = 'view' | 'edit' | 'new'

type ModelPresetOption = {
  id: string
  label: string
  detail: string
  provider: string
  model: string
  presetId?: string
  isValid: boolean
  invalidReason?: string
}

type AgentRuntimeSettings = {
  memoryModelPresetId: string
  vectorRecallEnabled: boolean
  vectorEmbeddingMode: 'inherit' | 'local' | 'online'
  vectorEmbeddingProfileId: string
}

type EmbeddingProfileOption = {
  id: string
  displayName: string
  dim?: number
  sizeLabel?: string
  performanceLabel?: string
}

type WorkflowDefinitionView = {
  id: string
  name: string
  version: string
  description: string
  category: string
  builtin: boolean
  agentId: string
  defaultAgentId?: string
  allowAgentOverride?: boolean
  requiresContext?: 'none' | 'session' | 'contact' | 'session_or_contact'
  toolIds: string[]
  hookNames: string[]
  maxTurns: number
  maxToolCalls: number
  timeoutMs: number
  enableThinking: boolean
  decisionTemperature: number
  answerTemperature: number
  documentation: string
}

const DEFAULT_CUSTOM_TOOL_IDS = ['native:get_current_time']
const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  memoryModelPresetId: '',
  vectorRecallEnabled: true,
  vectorEmbeddingMode: 'inherit',
  vectorEmbeddingProfileId: 'bge-large-zh-v1.5-int8'
}

function isUsableCustomBaseURL(baseURL?: string): boolean {
  return /^https?:\/\//i.test(String(baseURL || '').trim())
}

function formatWorkflowContextRequirement(value?: WorkflowDefinitionView['requiresContext']): string {
  if (value === 'session') return '会话'
  if (value === 'contact') return '联系人'
  if (value === 'session_or_contact') return '会话或联系人'
  return '无'
}

function createDraft(source?: AgentDefinitionView | null, modelPreset?: ModelPresetOption | null): AgentDefinitionView {
  const now = Date.now()
  const provider = modelPreset?.provider || (source?.isBuiltin ? '' : source?.provider || '')
  const model = modelPreset?.model || (source?.isBuiltin ? '' : source?.model || '')
  return {
    id: `draft-${now}`,
    name: source ? `${source.name} 副本` : '自定义 Agent',
    description: source?.description || '面向当前聊天数据的自定义 Agent',
    isBuiltin: false,
    systemPrompt: source?.systemPrompt || '你是 CipherTalk Agent。请先使用工具收集证据，再回答用户。',
    model,
    provider,
    modelPresetId: modelPreset?.presetId || (!source?.isBuiltin ? source?.modelPresetId : undefined),
    temperature: source?.temperature ?? 0.7,
    maxTokens: source?.maxTokens,
    maxTurns: source?.maxTurns ?? 15,
    toolIds: source?.toolIds || DEFAULT_CUSTOM_TOOL_IDS,
    mcpServerIds: source?.mcpServerIds || [],
    skillIds: source?.skillIds || [],
    dataScope: source?.dataScope || 'all',
    defaultWorkspace: source?.defaultWorkspace,
    createdAt: now,
    updatedAt: now
  }
}

function createBlankDraft(modelPreset?: ModelPresetOption | null): AgentDefinitionView {
  const now = Date.now()
  return {
    id: `draft-${now}`,
    name: '',
    description: '',
    isBuiltin: false,
    systemPrompt: '',
    model: modelPreset?.model || '',
    provider: modelPreset?.provider || '',
    modelPresetId: modelPreset?.presetId,
    temperature: 0.7,
    maxTokens: undefined,
    maxTurns: 15,
    toolIds: DEFAULT_CUSTOM_TOOL_IDS,
    mcpServerIds: [],
    skillIds: [],
    dataScope: 'all',
    defaultWorkspace: undefined,
    createdAt: now,
    updatedAt: now
  }
}

function toCreateInput(draft: AgentDefinitionView) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt,
    model: draft.model,
    provider: draft.provider,
    modelPresetId: draft.modelPresetId,
    temperature: draft.temperature,
    maxTokens: draft.maxTokens,
    maxTurns: draft.maxTurns,
    toolIds: draft.toolIds,
    mcpServerIds: draft.mcpServerIds,
    skillIds: draft.skillIds,
    dataScope: draft.dataScope,
    defaultWorkspace: draft.defaultWorkspace
  }
}

export default function AgentConfigPanel({ agents, selectedAgentId, tools, onSelectAgent, onSaved }: Props) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<EditorMode>('view')
  const [draft, setDraft] = useState<AgentDefinitionView | null>(null)
  const [status, setStatus] = useState('')
  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [presets, setPresets] = useState<AiConfigPreset[]>([])
  const [activeConfig, setActiveConfig] = useState<ModelPresetOption | null>(null)
  const [runtimeSettings, setRuntimeSettings] = useState<AgentRuntimeSettings>(DEFAULT_AGENT_RUNTIME_SETTINGS)
  const [embeddingProfiles, setEmbeddingProfiles] = useState<EmbeddingProfileOption[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinitionView[]>([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ agent: AgentDefinitionView; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId]
  )
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) || null,
    [selectedWorkflowId, workflows]
  )

  useEffect(() => {
    setDraft(selectedAgent)
    setMode('view')
    setStatus('')
    setSelectedWorkflowId(null)
  }, [selectedAgent])

  useEffect(() => {
    let cancelled = false
    async function loadWorkflows() {
      const result = await window.electronAPI.workflow.list().catch(() => [])
      if (!cancelled) setWorkflows(Array.isArray(result) ? result : [])
    }
    void loadWorkflows()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadModelPresets() {
      const [providerList, presetList, currentProvider, agentSettings, embeddingProfileResult] = await Promise.all([
        getAIProviders(),
        getAiConfigPresets(),
        getAiProvider(),
        window.electronAPI.agent.getRuntimeSettings().catch(() => DEFAULT_AGENT_RUNTIME_SETTINGS),
        window.electronAPI.ai.getEmbeddingModelProfiles().catch(() => null)
      ])
      const currentConfig = await getAiProviderConfig(currentProvider)
      if (cancelled) return
      setProviders(providerList)
      setPresets(presetList)
      setRuntimeSettings({ ...DEFAULT_AGENT_RUNTIME_SETTINGS, ...agentSettings })
      if (embeddingProfileResult?.success && Array.isArray(embeddingProfileResult.result)) {
        setEmbeddingProfiles(embeddingProfileResult.result)
      }
      const providerInfo = providerList.find((provider) => provider.id === currentProvider)
      const model = currentConfig?.model || providerInfo?.models[0] || ''
      const currentBaseURL = currentConfig?.baseURL || ''
      const activeConfigValid = currentProvider !== 'custom' || isUsableCustomBaseURL(currentBaseURL)
      setActiveConfig({
        id: 'active',
        label: '当前配置',
        detail: `${providerInfo?.displayName || currentProvider}${model ? ` · ${model}` : ''}${activeConfigValid ? '' : ' · 服务地址无效'}`,
        provider: currentProvider,
        model,
        isValid: activeConfigValid,
        invalidReason: '当前 custom 配置缺少有效服务地址，请选择一个带有效服务地址的预设，或先保存 http:// / https:// 开头的服务地址。'
      })
    }

    void loadModelPresets().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const filteredAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return agents
    return agents.filter((agent) => `${agent.name} ${agent.description}`.toLowerCase().includes(keyword))
  }, [agents, query])
  const filteredWorkflows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return workflows
    return workflows.filter((workflow) => `${workflow.name} ${workflow.description}`.toLowerCase().includes(keyword))
  }, [query, workflows])

  const builtinAgents = filteredAgents.filter((agent) => agent.isBuiltin)
  const customAgents = filteredAgents.filter((agent) => !agent.isBuiltin)

  const groupedTools = useMemo(() => ({
    native: tools.filter((tool) => tool.source === 'native').length,
    mcp: tools.filter((tool) => tool.source === 'mcp').length,
    skill: tools.filter((tool) => tool.source === 'skill').length
  }), [tools])

  const modelPresetOptions = useMemo<ModelPresetOption[]>(() => {
    const providerName = (providerId: string) => providers.find((provider) => provider.id === providerId)?.displayName || providerId
    const options: ModelPresetOption[] = []
    if (activeConfig) options.push(activeConfig)
    presets.forEach((preset) => {
      const presetBaseURL = preset.baseURL || ''
      const presetValid = preset.provider !== 'custom' || isUsableCustomBaseURL(presetBaseURL)
      options.push({
        id: preset.id,
        label: preset.name,
        detail: `${providerName(preset.provider)} · ${preset.model}${presetValid ? '' : ' · 服务地址无效'}`,
        provider: preset.provider,
        model: preset.model,
        presetId: preset.id,
        isValid: presetValid,
        invalidReason: `预设「${preset.name}」缺少有效服务地址，请使用 http:// 或 https:// 开头的地址。`
      })
    })
    return options
  }, [activeConfig, presets, providers])

  const defaultModelOption = useMemo(() => {
    if (activeConfig?.isValid) return activeConfig
    const matchingActivePreset = modelPresetOptions.find((option) => (
      option.presetId &&
      option.isValid &&
      option.provider === activeConfig?.provider &&
      option.model === activeConfig?.model
    ))
    return matchingActivePreset || modelPresetOptions.find((option) => option.isValid) || activeConfig
  }, [activeConfig, modelPresetOptions])

  const selectedModelPresetId = useMemo(() => {
    if (!draft) return ''
    if (!draft.isBuiltin && draft.modelPresetId) {
      const matchedById = modelPresetOptions.find((option) => option.presetId === draft.modelPresetId)
      if (matchedById) return matchedById.id
    }
    const provider = draft.isBuiltin && activeConfig ? activeConfig.provider : draft.provider
    const model = draft.isBuiltin && activeConfig ? activeConfig.model : draft.model
    if (activeConfig && provider === activeConfig.provider && model === activeConfig.model) {
      return activeConfig.id
    }
    return ''
  }, [activeConfig, draft, modelPresetOptions])

  const beginNew = () => {
    setSelectedWorkflowId(null)
    setDraft(createBlankDraft(defaultModelOption))
    setMode('new')
    setStatus('')
  }

  const copyAgent = async (agent: AgentDefinitionView) => {
    setContextMenu(null)
    const sourceModelOption = agent.isBuiltin
      ? defaultModelOption
      : agent.modelPresetId
        ? modelPresetOptions.find((option) => option.presetId === agent.modelPresetId && option.isValid)
        : undefined
    const copiedDraft = createDraft(agent, sourceModelOption)
    const created = await window.electronAPI.agent.create(toCreateInput(copiedDraft)) as AgentDefinitionView
    await onSaved()
    onSelectAgent(created.id)
    setDraft(created)
    setMode('view')
    setStatus('已复制为新的自定义 Agent')
  }

  const deleteAgent = async (agent: AgentDefinitionView) => {
    setContextMenu(null)
    if (agent.isBuiltin) return
    const ok = window.confirm(`删除自定义 Agent「${agent.name}」？`)
    if (!ok) return
    await window.electronAPI.agent.delete(agent.id)
    const fallback = agents.find((item) => item.id !== agent.id) || null
    await onSaved()
    if (fallback) onSelectAgent(fallback.id)
    setDraft(fallback)
    setMode('view')
    setStatus('已删除 Agent')
  }

  const applyModelPreset = (presetId: string) => {
    const preset = modelPresetOptions.find((option) => option.id === presetId)
    if (!preset || !draft) return
    if (!preset.isValid) {
      setStatus(preset.invalidReason || '当前模型配置不可用')
      return
    }
    setDraft({ ...draft, provider: preset.provider, model: preset.model, modelPresetId: preset.presetId })
    setStatus('')
  }

  const updateRuntimeSetting = async (patch: Partial<AgentRuntimeSettings>) => {
    const next = { ...runtimeSettings, ...patch }
    setRuntimeSettings(next)
    try {
      const saved = await window.electronAPI.agent.updateRuntimeSettings(patch)
      setRuntimeSettings({ ...DEFAULT_AGENT_RUNTIME_SETTINGS, ...saved })
      setStatus('Agent 运行设置已保存')
    } catch (error) {
      setStatus(`Agent 运行设置保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const chooseAgent = (agent: AgentDefinitionView) => {
    setSelectedWorkflowId(null)
    onSelectAgent(agent.id)
    setDraft(agent)
    setMode('view')
    setStatus('')
  }

  const chooseWorkflow = (workflow: WorkflowDefinitionView) => {
    setSelectedWorkflowId(workflow.id)
    setMode('view')
    setStatus('')
    setContextMenu(null)
  }

  const save = async () => {
    if (!draft) return
    const selectedOption = modelPresetOptions.find((option) => option.id === selectedModelPresetId)
    if (selectedOption && !selectedOption.isValid) {
      setStatus(selectedOption.invalidReason || '当前模型配置不可用')
      return
    }
    const normalizedDraft = selectedOption
      ? { ...draft, provider: selectedOption.provider, model: selectedOption.model, modelPresetId: selectedOption.presetId }
      : draft
    if (!normalizedDraft.name.trim()) {
      setStatus('请填写 Agent 名称')
      return
    }
    if (!normalizedDraft.systemPrompt.trim()) {
      setStatus('请填写 System Prompt')
      return
    }
    if (!normalizedDraft.provider) {
      setStatus('请选择当前配置或一个模型预设')
      return
    }

    if (mode === 'new') {
      const created = await window.electronAPI.agent.create(toCreateInput(normalizedDraft)) as AgentDefinitionView
      await onSaved()
      onSelectAgent(created.id)
      setMode('view')
      setDraft(created)
      setStatus('已新建 Agent')
      return
    }

    if (normalizedDraft.isBuiltin) return
    const saved = await window.electronAPI.agent.update(normalizedDraft.id, normalizedDraft) as AgentDefinitionView
    await onSaved()
    onSelectAgent(saved.id)
    setDraft(saved)
    setMode('view')
    setStatus('已保存配置')
  }

  const canEdit = mode === 'new' || (mode === 'edit' && Boolean(draft && !draft.isBuiltin))
  const panelTitle = mode === 'new' ? '新建 Agent' : draft?.isBuiltin ? '内置 Agent' : '编辑 Agent'
  const canEnterEdit = mode === 'view' && Boolean(draft && !draft.isBuiltin)
  const visibleProvider = draft?.isBuiltin && activeConfig ? activeConfig.provider : draft?.provider || ''
  const visibleModel = draft?.isBuiltin && activeConfig ? activeConfig.model : draft?.model || ''

  return (
    <div
      className="agent-config-panel"
      onPointerDownCapture={(event) => {
        if (!contextMenu) return
        if (contextMenuRef.current?.contains(event.target as Node)) return
        setContextMenu(null)
      }}
    >
      <aside className="agent-manager-list">
        <div className="agent-manager-toolbar">
          <label className="agent-manager-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent" />
          </label>
          <button type="button" onClick={beginNew}>
            <Plus size={15} />新建
          </button>
        </div>

        <AgentGroup
          title="内置"
          agents={builtinAgents}
          selectedId={selectedWorkflow ? null : mode === 'new' ? null : draft?.id || selectedAgentId}
          onSelect={chooseAgent}
          onContextMenu={(agent, event) => {
            event.preventDefault()
            setContextMenu({ agent, x: event.clientX, y: event.clientY })
          }}
        />
        <WorkflowGroup
          title="工作流"
          workflows={filteredWorkflows}
          selectedId={selectedWorkflowId}
          onSelect={chooseWorkflow}
        />
        <AgentGroup
          title="自定义"
          agents={customAgents}
          selectedId={selectedWorkflow ? null : mode === 'new' ? null : draft?.id || selectedAgentId}
          onSelect={chooseAgent}
          onContextMenu={(agent, event) => {
            event.preventDefault()
            setContextMenu({ agent, x: event.clientX, y: event.clientY })
          }}
          emptyText="还没有自定义 Agent"
        />

        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="agent-manager-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={() => copyAgent(contextMenu.agent)}>
              <Copy size={14} />复制为新 Agent
            </button>
            {!contextMenu.agent.isBuiltin && (
              <button type="button" className="danger" onClick={() => deleteAgent(contextMenu.agent)}>
                <Trash2 size={14} />删除
              </button>
            )}
          </div>
        )}
      </aside>

      <section className="agent-manager-editor">
        {selectedWorkflow ? (
          <WorkflowDetails workflow={selectedWorkflow} agents={agents} tools={tools} />
        ) : draft ? (
          <>
            <div className="agent-config-summary">
              <div>
                <strong>{panelTitle}</strong>
                <span>{draft.name}</span>
              </div>
              <small>
                工具：Native {groupedTools.native} / MCP {groupedTools.mcp} / Skills {groupedTools.skill}
              </small>
            </div>

            <section className="agent-config-section">
              <h3>Agent 运行设置</h3>
              <div className="agent-config-grid">
                <label>
                  上下文压缩 / 记忆抽取模型
                  <select
                    value={runtimeSettings.memoryModelPresetId}
                    onChange={(event) => void updateRuntimeSetting({ memoryModelPresetId: event.target.value })}
                  >
                    <option value="">跟随当前 Agent 对话模型</option>
                    {modelPresetOptions.filter((option) => option.presetId).map((option) => (
                      <option key={option.id} value={option.presetId || ''} disabled={!option.isValid}>
                        {option.label} - {option.detail}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="agent-config-inline-check">
                  <input
                    type="checkbox"
                    checked={runtimeSettings.vectorRecallEnabled}
                    onChange={(event) => void updateRuntimeSetting({ vectorRecallEnabled: event.target.checked })}
                  />
                  <span>
                    启用长期记忆向量召回
                    <small>不可用时自动使用 LIKE 召回</small>
                  </span>
                </label>
                <label>
                  向量化模式
                  <select
                    value={runtimeSettings.vectorEmbeddingMode}
                    onChange={(event) => void updateRuntimeSetting({ vectorEmbeddingMode: event.target.value as AgentRuntimeSettings['vectorEmbeddingMode'] })}
                  >
                    <option value="inherit">跟随全局向量设置</option>
                    <option value="local">本地向量模型</option>
                    <option value="online">在线向量服务</option>
                  </select>
                </label>
                <label>
                  本地向量模型
                  <select
                    value={runtimeSettings.vectorEmbeddingProfileId}
                    disabled={runtimeSettings.vectorEmbeddingMode === 'online'}
                    onChange={(event) => void updateRuntimeSetting({ vectorEmbeddingProfileId: event.target.value })}
                  >
                    {embeddingProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.displayName}{profile.dim ? ` · ${profile.dim}d` : ''}{profile.sizeLabel ? ` · ${profile.sizeLabel}` : ''}
                      </option>
                    ))}
                    {embeddingProfiles.length === 0 && (
                      <option value={runtimeSettings.vectorEmbeddingProfileId}>当前本地向量模型</option>
                    )}
                  </select>
                </label>
              </div>
            </section>

            <section className="agent-config-section">
              <h3>基础信息</h3>
              <label>
                名称
                <input disabled={!canEdit} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>
                描述
                <input disabled={!canEdit} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </label>
            </section>

            <section className="agent-config-section">
              <h3>模型与运行</h3>
              <div className="agent-config-grid">
                <label>
                  模型配置
                  <select disabled={!canEdit} value={selectedModelPresetId} onChange={(event) => applyModelPreset(event.target.value)}>
                    <option value="" disabled>{modelPresetOptions.length ? '选择当前配置或预设' : '暂无可用配置'}</option>
                    {modelPresetOptions.map((option) => (
                      <option key={option.id} value={option.id} disabled={!option.isValid}>{option.label} - {option.detail}</option>
                    ))}
                  </select>
                </label>
                <label>
                  当前模型
                  <input disabled value={`${visibleProvider || '未选择'}${visibleModel ? ` · ${visibleModel}` : ''}`} placeholder="从当前配置或预设中选择" />
                </label>
                <label>
                  温度 {draft.temperature.toFixed(1)}
                  <input
                    disabled={!canEdit}
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={draft.temperature}
                    onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
                  />
                </label>
                <label>
                  最大轮次
                  <input disabled={!canEdit} type="number" min="1" max="50" value={draft.maxTurns} onChange={(event) => setDraft({ ...draft, maxTurns: Number(event.target.value) || 1 })} />
                </label>
                <label>
                  最大 Tokens
                  <input
                    disabled={!canEdit}
                    type="number"
                    min="0"
                    value={draft.maxTokens ?? ''}
                    onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value ? Number(event.target.value) : undefined })}
                    placeholder="不限"
                  />
                </label>
                <label>
                  数据范围
                  <select disabled={!canEdit} value={draft.dataScope} onChange={(event) => setDraft({ ...draft, dataScope: event.target.value as AgentDefinitionView['dataScope'] })}>
                    <option value="all">全部数据</option>
                    <option value="workspace">工作区</option>
                    <option value="session">当前会话</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="agent-config-section">
              <h3>System Prompt</h3>
              <textarea disabled={!canEdit} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} />
            </section>

            <section className="agent-config-section">
              <h3>工具权限</h3>
              <ToolListPanel
                tools={tools}
                selectedToolIds={draft.toolIds}
                disabled={!canEdit}
                onChange={(toolIds) => setDraft({ ...draft, toolIds })}
              />
            </section>

            <div className="agent-config-actions">
              <button type="button" onClick={() => setMode('edit')} disabled={!canEnterEdit}>
                <Edit3 size={15} />编辑
              </button>
              <button type="button" className="primary" onClick={save} disabled={!canEdit}>
                <Save size={15} />{mode === 'new' ? '创建' : '保存'}
              </button>
            </div>
            {status && <div className={`agent-config-status ${status.includes('请') ? 'warning' : ''}`}>{status}</div>}
          </>
        ) : (
          <div className="agent-config-panel empty">
            <p>暂无 Agent。</p>
            <button type="button" onClick={beginNew}>
              <Plus size={15} />新建 Agent
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function renderWorkflowMarkdown(markdown: string): { __html: string } {
  const html = marked.parse(markdown || '') as string
  return { __html: DOMPurify.sanitize(html) }
}

function WorkflowDetails({
  workflow,
  agents,
  tools
}: {
  workflow: WorkflowDefinitionView
  agents: AgentDefinitionView[]
  tools: AgentToolView[]
}) {
  const linkedAgent = agents.find((agent) => agent.id === (workflow.defaultAgentId || workflow.agentId))
  const toolLabels = workflow.toolIds.map((toolId) => {
    const tool = tools.find((item) => item.id === toolId)
    return tool ? `${tool.name} · ${tool.sourceLabel}` : toolId
  })

  return (
    <>
      <div className="agent-config-summary">
        <div>
          <strong>内置工作流</strong>
          <span>{workflow.name}</span>
        </div>
        <small>{workflow.category || 'workflow'} · v{workflow.version}</small>
      </div>

      <section className="agent-config-section">
        <h3>工作流信息</h3>
        <div className="agent-workflow-detail-grid">
          <span>描述</span>
          <strong>{workflow.description || '暂无描述'}</strong>
          <span>引用 Agent</span>
          <strong>{linkedAgent ? linkedAgent.name : workflow.defaultAgentId || workflow.agentId}</strong>
          <span>上下文要求</span>
          <strong>{formatWorkflowContextRequirement(workflow.requiresContext)}</strong>
          <span>允许覆盖 Agent</span>
          <strong>{workflow.allowAgentOverride ? '是' : '否'}</strong>
          <span>最大轮次</span>
          <strong>{workflow.maxTurns}</strong>
          <span>最大工具调用</span>
          <strong>{workflow.maxToolCalls}</strong>
          <span>决策温度</span>
          <strong>{workflow.decisionTemperature}</strong>
          <span>回答温度</span>
          <strong>{workflow.answerTemperature}</strong>
        </div>
      </section>

      <section className="agent-config-section">
        <h3>工具</h3>
        <div className="agent-workflow-tags">
          {toolLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
      </section>

      <section className="agent-config-section">
        <h3>Hooks</h3>
        <div className="agent-workflow-tags">
          {workflow.hookNames.map((name) => <span key={name}>{name}</span>)}
        </div>
      </section>

      <section className="agent-config-section">
        <h3>文档</h3>
        <div
          className="agent-markdown agent-workflow-doc"
          dangerouslySetInnerHTML={renderWorkflowMarkdown(workflow.documentation)}
        />
      </section>
    </>
  )
}

function WorkflowGroup({
  title,
  workflows,
  selectedId,
  onSelect
}: {
  title: string
  workflows: WorkflowDefinitionView[]
  selectedId?: string | null
  onSelect: (workflow: WorkflowDefinitionView) => void
}) {
  return (
    <section className="agent-manager-group">
      <h3>{title}</h3>
      {workflows.length === 0 && <div className="agent-manager-empty">暂无工作流</div>}
      {workflows.map((workflow) => (
        <button
          key={workflow.id}
          type="button"
          className={`agent-manager-item ${workflow.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(workflow)}
        >
          <span className="agent-manager-icon workflow">
            <GitBranch size={15} />
          </span>
          <span>
            <strong>{workflow.name}</strong>
            <small>{workflow.description || '工作流'}</small>
          </span>
          <em>{workflow.builtin ? '内置' : '自定义'}</em>
        </button>
      ))}
    </section>
  )
}

function AgentGroup({
  title,
  agents,
  selectedId,
  onSelect,
  onContextMenu,
  emptyText = '暂无 Agent'
}: {
  title: string
  agents: AgentDefinitionView[]
  selectedId?: string | null
  onSelect: (agent: AgentDefinitionView) => void
  onContextMenu: (agent: AgentDefinitionView, event: MouseEvent<HTMLButtonElement>) => void
  emptyText?: string
}) {
  return (
    <section className="agent-manager-group">
      <h3>{title}</h3>
      {agents.length === 0 && <div className="agent-manager-empty">{emptyText}</div>}
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          className={`agent-manager-item ${agent.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(agent)}
          onContextMenu={(event) => onContextMenu(agent, event)}
        >
          <span className={`agent-manager-icon ${agent.isBuiltin ? 'builtin' : 'custom'}`}>
            {agent.isBuiltin ? <ShieldCheck size={15} /> : <UserRoundCog size={15} />}
          </span>
          <span>
            <strong>{agent.name}</strong>
            <small>{agent.description || (agent.isBuiltin ? '系统内置 Agent' : '自定义 Agent')}</small>
          </span>
          <em>{agent.isBuiltin ? '内置' : '自定义'}</em>
        </button>
      ))}
    </section>
  )
}
