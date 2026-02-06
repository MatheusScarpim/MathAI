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
  ResetEnvironmentResponse
} from '../types'

const API_BASE = '/api'

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined)
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers,
    ...options
  })

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

  async clearSchema(): Promise<{ ok: boolean }> {
    return request('/schema/clear', { method: 'POST' })
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

  async resetEnvironment(): Promise<ResetEnvironmentResponse> {
    return request('/settings/reset-environment', {
      method: 'POST'
    })
  },

  // Ask (main endpoint)
  async ask(
    question: string,
    chatId?: string,
    language: 'pt' | 'en' | 'es' = 'pt',
    schemaLanguage: 'pt' | 'en' | 'es' = 'pt',
    responseLanguage?: 'pt' | 'en' | 'es'
  ): Promise<AskResponse> {
    const res = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        question,
        chatId,
        language,
        schemaLanguage,
        responseLanguage
      })
    })
    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      const errorMessage =
        payload?.errorMessage ||
        payload?.message ||
        `HTTP ${res.status}`
      return {
        ok: false,
        error: {
          errorMessage,
          hint: payload?.hint
        }
      }
    }

    return { ok: true, data: payload as AskResponse['data'] }
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
  }
}
