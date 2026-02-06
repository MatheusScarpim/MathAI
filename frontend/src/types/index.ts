export interface HistoryRecord {
  id: string
  chatId?: string
  question: string
  sql: string
  summary?: string
  language?: 'pt' | 'en' | 'es'
  responseLanguage?: 'pt' | 'en' | 'es'
  createdAt: string
  favorite: boolean
  tags: string[]
  success?: boolean
  errorMessage?: string
  elapsedMs?: number
  rowCount?: number
}

export interface Instruction {
  id: string
  text: string
  tableFullName?: string
  createdAt: string
}

export interface ChartData {
  type: 'bar' | 'line'
  data: Record<string, any>[]
  title: string
  xKey: string
  yKey: string
}

export interface AskResponse {
  ok: boolean
  data?: {
    sql: string
    rows: Record<string, unknown>[]
    columns: string[]
    elapsedMs: number
    chatId?: string
    historyId?: string
    summary?: string
    translatedQuestion?: string
    cacheHit?: boolean
    responseLanguage?: 'pt' | 'en' | 'es'
    chart?: ChartData
    tokenUsage?: {
      sql?: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
      summary?: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
      total: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
    }
  }
  error?: {
    errorMessage: string
    hint?: string
  }
}

export interface RunResponse {
  sql: string
  rows: Record<string, any>[]
  columns: string[]
  elapsedMs: number
  chart?: ChartData
}

export interface IngestResponse {
  tablesIndexed: number
}

export interface TableInfo {
  tableFullName: string
  columns: { name: string; type: string }[]
  primaryKey: string[]
  foreignKeys: {
    fromTable: string
    fromColumn: string
    toTable: string
    toColumn: string
  }[]
  tags: string[]
}

export type DbType = 'sqlserver' | 'oracle'

export interface ConfigStatusResponse {
  configured: boolean
}

export interface AppConfigView {
  dbType: DbType
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  openAiKeySet: boolean
}

export interface SaveAppConfigPayload {
  openAiApiKey: string
  dbType: DbType
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  dbPassword: string
}

export interface TableReferenceCountSetting {
  tableReferenceCount: number
}

export interface ResetEnvironmentResponse {
  ok: boolean
  cleared: {
    history: number
    instructions: number
    settings: number
    appConfig: number
    redisKeys: number
  }
}
