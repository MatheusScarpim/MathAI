import type {
  AskResponse,
  RunResponse,
  HistoryRecord,
  Instruction,
  IngestResponse,
  TableInfo,
  AppConfigView,
  ConfigStatusResponse,
  SaveAppConfigPayload,
  TableReferenceCountSetting,
  ResetEnvironmentResponse,
  AgentsConfig,
  AppMode,
  EndpointInfo,
  EnvironmentView,
  StatsResponse
} from '../types'

import { getToken, clearToken } from './auth'

const API_BASE = '/api'

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(options.headers as Record<string, string> | undefined)
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    credentials: 'include',
    headers,
    ...options
  })

  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Request failed' }))
    throw new Error(error.errorMessage || error.message || `HTTP ${res.status}`)
  }

  return res.json()
}

export const api = {
  async getConfigStatus(): Promise<ConfigStatusResponse> {
    return request('/config/status')
  },

  async getConfig(): Promise<AppConfigView> {
    return request('/config')
  },

  async saveConfig(payload: SaveAppConfigPayload): Promise<{ ok: boolean }> {
    return request('/config', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },

  async testDbConfig(payload: Omit<SaveAppConfigPayload, 'openAiApiKey'>): Promise<{ ok: boolean }> {
    return request('/config/test-db', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },

  async testOpenAi(openAiApiKey: string): Promise<{ ok: boolean }> {
    return request('/config/test-openai', {
      method: 'POST',
      body: JSON.stringify({ openAiApiKey })
    })
  },

  // Schema / Tables
  async ingestSchema(): Promise<IngestResponse> {
    return request('/ingest/schema', { method: 'POST' })
  },

  async getTables(): Promise<{ tables: TableInfo[] }> {
    return request('/schema/tables')
  },

  async clearSchema(environmentId?: string): Promise<{ ok: boolean }> {
    return request('/schema/clear', {
      method: 'POST',
      body: environmentId ? JSON.stringify({ environmentId }) : undefined
    })
  },

  async deleteTable(tableFullName: string, environmentId?: string): Promise<{ ok: boolean }> {
    const qs = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ''
    return request(`/schema/tables/${encodeURIComponent(tableFullName)}${qs}`, {
      method: 'DELETE'
    })
  },

  // Settings
  async getSchemaLanguage(): Promise<{ schemaLanguage: 'pt' | 'en' | 'es' }> {
    return request('/settings/schema-language')
  },

  async setSchemaLanguage(
    schemaLanguage: 'pt' | 'en' | 'es'
  ): Promise<{ ok: boolean; schemaLanguage: 'pt' | 'en' | 'es' }> {
    return request('/settings/schema-language', {
      method: 'PUT',
      body: JSON.stringify({ schemaLanguage })
    })
  },

  async getTableReferenceCount(): Promise<TableReferenceCountSetting> {
    return request('/settings/table-reference-count')
  },

  async setTableReferenceCount(
    tableReferenceCount: number
  ): Promise<{ ok: boolean; tableReferenceCount: number }> {
    return request('/settings/table-reference-count', {
      method: 'PUT',
      body: JSON.stringify({ tableReferenceCount })
    })
  },

  async getAgentsConfig(): Promise<AgentsConfig> {
    return request('/settings/agents')
  },

  async saveAgentsConfig(config: AgentsConfig): Promise<AgentsConfig> {
    return request('/settings/agents', {
      method: 'PUT',
      body: JSON.stringify(config)
    })
  },

  async resetEnvironment(): Promise<ResetEnvironmentResponse> {
    return request('/settings/reset-environment', {
      method: 'POST'
    })
  },

  async getIntegrationsSettings(): Promise<Record<string, unknown>> {
    return request('/settings/integrations')
  },

  async saveIntegrationsSettings(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request('/settings/integrations', {
      method: 'PUT',
      body: JSON.stringify(settings)
    })
  },

  // Environments
  async listEnvironments(): Promise<{ environments: EnvironmentView[] }> {
    return request('/environments')
  },

  async getEnvironment(id: string): Promise<EnvironmentView> {
    return request(`/environments/${id}`)
  },

  async createEnvironment(payload: Record<string, unknown>): Promise<EnvironmentView> {
    return request('/environments', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },

  async updateEnvironment(id: string, payload: Record<string, unknown>): Promise<EnvironmentView> {
    return request(`/environments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    })
  },

  async deleteEnvironment(id: string): Promise<{ ok: boolean }> {
    return request(`/environments/${id}`, { method: 'DELETE' })
  },

  async testEnvironmentDb(id: string): Promise<{ ok: boolean; error?: string }> {
    return request(`/environments/${id}/test-db`, { method: 'POST' })
  },

  // Schema (with optional environmentId)
  async ingestSchemaForEnv(environmentId: string): Promise<IngestResponse> {
    return request('/ingest/schema', {
      method: 'POST',
      body: JSON.stringify({ environmentId })
    })
  },

  async getTablesForEnv(environmentId: string): Promise<{ tables: TableInfo[] }> {
    return request(`/schema/tables?environmentId=${encodeURIComponent(environmentId)}`)
  },

  // Ask (main endpoint)
  async ask(
    question: string,
    chatId?: string,
    language: 'pt' | 'en' | 'es' = 'pt',
    schemaLanguage: 'pt' | 'en' | 'es' = 'pt',
    responseLanguage?: 'pt' | 'en' | 'es',
    environmentId?: string
  ): Promise<AskResponse> {
    try {
      const data = await request<AskResponse['data']>('/ask', {
        method: 'POST',
        body: JSON.stringify({
          question, chatId, language, schemaLanguage, responseLanguage, environmentId
        })
      })
      return { ok: true, data }
    } catch (err: any) {
      return {
        ok: false,
        error: {
          errorMessage: err?.message ?? 'Erro ao processar pergunta.',
          hint: err?.hint
        }
      }
    }
  },

  // Run custom SQL
  async run(sql: string): Promise<RunResponse> {
    return request('/run', {
      method: 'POST',
      body: JSON.stringify({ sql })
    })
  },

  // History
  async getHistory(): Promise<HistoryRecord[]> {
    return request('/history')
  },

  async updateHistory(
    id: string,
    data: { favorite?: boolean; tags?: string[] }
  ): Promise<{ ok: boolean }> {
    return request(`/history/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    })
  },

  // Instructions
  async getInstructions(): Promise<Instruction[]> {
    return request('/instructions')
  },

  async createInstruction(text: string, tableFullName?: string): Promise<Instruction> {
    return request('/instructions', {
      method: 'POST',
      body: JSON.stringify({ text, tableFullName })
    })
  },

  async deleteInstruction(id: string): Promise<{ ok: boolean }> {
    return request(`/instructions/${id}`, { method: 'DELETE' })
  },

  // Mode
  async getMode(): Promise<{ mode: AppMode }> {
    return request('/config/mode')
  },

  // API mode
  async testApiConnection(payload: {
    apiBaseUrl: string
    apiAuthType: string
    apiAuthToken?: string
    apiAuthApiKeyHeader?: string
    apiAuthApiKeyValue?: string
    apiAuthUsername?: string
    apiAuthPassword?: string
  }): Promise<{ ok: boolean }> {
    return request('/config/test-api', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },

  async ingestSwagger(payload: { url?: string; content?: string }): Promise<{ endpointsIndexed: number }> {
    return request('/ingest/swagger', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  },

  async getEndpoints(): Promise<{ endpoints: EndpointInfo[] }> {
    return request('/schema/endpoints')
  },

  async clearEndpoints(): Promise<{ ok: boolean }> {
    return request('/schema/endpoints/clear', { method: 'POST' })
  },

  // Auth
  async getAuthStatus(): Promise<{ enabled: boolean }> {
    return request('/auth/status')
  },

  async login(username: string, password: string): Promise<{ ok: boolean; token: string }> {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    })
  },

  async register(username: string, password: string): Promise<{ ok: boolean; token: string }> {
    return request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    })
  },

  async toggleAuth(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
    return request('/auth/toggle', {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    })
  },

  // Github Repos (entidades persistidas)
  async listRepos(): Promise<Array<{
    id: string; name: string; owner: string; repo: string;
    baseBranch?: string; hasToken: boolean; createdAt: string; updatedAt: string;
  }>> {
    return request('/repos')
  },

  async createRepo(body: {
    url?: string; owner?: string; repo?: string;
    name?: string; baseBranch?: string; token: string;
  }): Promise<Record<string, unknown>> {
    return request('/repos', { method: 'POST', body: JSON.stringify(body) })
  },

  async updateRepo(
    id: string,
    body: { url?: string; owner?: string; repo?: string; name?: string; baseBranch?: string; token?: string }
  ): Promise<Record<string, unknown>> {
    return request(`/repos/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  },

  async deleteRepo(id: string): Promise<{ ok: boolean }> {
    return request(`/repos/${id}`, { method: 'DELETE' })
  },

  // Projects (entidades agrupadoras de tasks)
  async listProjects(): Promise<Array<{
    id: string; name: string; description?: string; repoIds: string[];
    trelloBoardId?: string; trelloListId?: string; trelloDoneListId?: string;
    isInbox: boolean;
    taskCount?: number; openTaskCount?: number; createdAt: string; updatedAt: string;
  }>> {
    return request('/projects')
  },

  async getProject(id: string): Promise<Record<string, unknown>> {
    return request(`/projects/${id}`)
  },

  async createProject(body: {
    name: string; description?: string; repoIds?: string[];
    trelloBoardId?: string; trelloListId?: string; trelloDoneListId?: string; trelloAgentEnabled?: boolean; trelloAgentCreateCards?: boolean;
  }): Promise<Record<string, unknown>> {
    return request('/projects', { method: 'POST', body: JSON.stringify(body) })
  },

  async updateProject(id: string, body: {
    name?: string; description?: string; repoIds?: string[];
    trelloBoardId?: string; trelloListId?: string; trelloDoneListId?: string; trelloAgentEnabled?: boolean; trelloAgentCreateCards?: boolean;
  }): Promise<Record<string, unknown>> {
    return request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  },

  async deleteProject(id: string): Promise<{ ok: boolean; migratedTo?: string }> {
    return request(`/projects/${id}`, { method: 'DELETE' })
  },

  async setupProjectPreview(id: string): Promise<{ ok: boolean; message: string }> {
    return request(`/projects/${id}/setup-preview`, { method: 'POST' })
  },

  // Trello
  async getTrelloBoards(): Promise<Array<{ id: string; name: string; url: string }>> {
    return request('/trello/boards')
  },

  async getTrelloLists(boardId: string): Promise<Array<{ id: string; name: string }>> {
    return request(`/trello/boards/${encodeURIComponent(boardId)}/lists`)
  },

  // Task Orchestrator
  async executeTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return request('/task', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  },

  async executeTaskStream(
    body: Record<string, unknown>,
    onEvent: (event: string, data: unknown) => void
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...authHeaders(),
      'Content-Type': 'application/json'
    }

    const res = await fetch(`${API_BASE}/task/stream`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: 'Request failed' }))
      throw new Error(error.errorMessage || error.message || `HTTP ${res.status}`)
    }

    const reader = res.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      let currentEvent = 'message'
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            onEvent(currentEvent, data)
          } catch {
            // skip malformed
          }
        }
      }
    }
  },

  async getTask(id: string): Promise<Record<string, unknown>> {
    return request(`/task/${id}`)
  },

  async getTasks(opts?: { status?: string; limit?: number; projectId?: string }): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams()
    if (opts?.status) params.set('status', opts.status)
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.projectId) params.set('projectId', opts.projectId)
    const qs = params.toString()
    return request(`/tasks${qs ? `?${qs}` : ''}`)
  },

  async cancelTask(id: string): Promise<{ ok: boolean }> {
    return request(`/task/${id}`, { method: 'DELETE' })
  },

  async retrySubtask(taskId: string, subId: string): Promise<{ ok: boolean; message?: string }> {
    return request(`/tasks/${taskId}/subtasks/${encodeURIComponent(subId)}/retry`, { method: 'POST' })
  },

  async approveTaskPlan(taskId: string): Promise<{ ok: boolean; message?: string; subtaskCount?: number }> {
    return request(`/tasks/${taskId}/approve-plan`, { method: 'POST' })
  },

  async rejectTaskPlan(taskId: string, reason?: string): Promise<{ ok: boolean }> {
    return request(`/tasks/${taskId}/reject-plan`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  },

  // Preview deploys
  async startPreview(taskId: string): Promise<{
    taskId: string
    tunnelUrl: string
    status: 'starting' | 'ready' | 'stopped' | 'failed'
    startedAt: string
    expiresAt: string
  }> {
    return request(`/tasks/${taskId}/preview`, { method: 'POST' })
  },

  async stopPreview(taskId: string): Promise<{ ok: boolean }> {
    return request(`/tasks/${taskId}/preview`, { method: 'DELETE' })
  },

  async getPreview(taskId: string): Promise<{
    taskId: string
    tunnelUrl: string
    status: 'starting' | 'ready' | 'stopped' | 'failed'
    startedAt: string
    expiresAt: string
    errorMessage?: string
  } | null> {
    try {
      return await request(`/tasks/${taskId}/preview`)
    } catch {
      return null
    }
  },

  // Stats / Developer
  async getStats(environmentId?: string, days = 30): Promise<StatsResponse> {
    const params = new URLSearchParams()
    if (environmentId) params.set('environmentId', environmentId)
    if (days !== 30) params.set('days', String(days))
    const qs = params.toString()
    return request(`/stats${qs ? `?${qs}` : ''}`)
  },

  // ── Routing (model/provider per subtask) ──
  async getRoutingRules(): Promise<{ rules: RoutingRule[] }> {
    return request('/settings/routing-rules')
  },

  async saveRoutingRules(rules: RoutingRule[]): Promise<{ ok: boolean; count: number }> {
    return request('/settings/routing-rules', {
      method: 'PUT',
      body: JSON.stringify({ rules })
    })
  },

  async testRoutingRule(input: {
    agent: 'taskCode' | 'taskPlanner' | 'taskReviewer' | 'taskReporter'
    type?: 'trello' | 'github' | 'api' | 'custom'
    description?: string
    repo?: string
  }): Promise<{ route: { provider: string; model: string; grpcUrl?: string; reason: string } }> {
    return request('/settings/routing-rules/test', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  },

  async getProvidersHealth(): Promise<Record<string, { url: string; status: 'ok' | 'down' }>> {
    return request('/settings/openclaude-providers/health')
  }
}

// ── Routing types (mirror do backend) ──
export type ProviderName = 'anthropic' | 'codex' | 'deepseek'
export type AgentSlot = 'taskCode' | 'taskPlanner' | 'taskReviewer' | 'taskReporter'
export type RoutingRule = {
  priority: number
  agent: AgentSlot | 'any'
  when?: {
    type?: 'trello' | 'github' | 'api' | 'custom'
    descriptionMatches?: string
    repoMatches?: string
  }
  route: { provider: ProviderName; model: string }
}
