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

  // Stats / Developer
  async getStats(environmentId?: string, days = 30): Promise<StatsResponse> {
    const params = new URLSearchParams()
    if (environmentId) params.set('environmentId', environmentId)
    if (days !== 30) params.set('days', String(days))
    const qs = params.toString()
    return request(`/stats${qs ? `?${qs}` : ''}`)
  }
}
