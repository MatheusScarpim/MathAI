export type AppMode = 'database' | 'api'
export type ApiAuthType = 'none' | 'bearer' | 'apikey' | 'basic'

export interface EndpointInfo {
  operationId: string
  method: string
  path: string
  summary?: string
  description?: string
  parameters: { name: string; in: string; required: boolean; type: string; description?: string }[]
  requestBodySchema?: string
  responseSchema?: string
  tags: string[]
}

export interface HistoryRecord {
  id: string
  chatId?: string
  question: string
  sql: string
  httpRequest?: string
  mode?: AppMode
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
  /**
   * Resultado gravado. O backend ja devolvia estes tres campos em
   * `mapHistoryDoc`; o tipo e que nao os declarava, entao a tabela do historico
   * nao tinha como ser escrita sem `any`.
   *
   * `columnFormats` e opcional porque item gravado antes do campo existir nao o
   * tem — nesse caso `mapHistoryDoc` deriva a mascara pelo nome da coluna.
   */
  rows?: Record<string, unknown>[]
  columns?: string[]
  columnFormats?: Record<string, ColumnFormat>
  tokenUsage?: {
    sql?: { inputTokens: number; outputTokens: number; totalTokens: number }
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number }
    sqlMini?: { inputTokens: number; outputTokens: number; totalTokens: number }
    sqlLarge?: { inputTokens: number; outputTokens: number; totalTokens: number }
    summary?: { inputTokens: number; outputTokens: number; totalTokens: number }
    total: { inputTokens: number; outputTokens: number; totalTokens: number }
  }
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

/**
 * Duplicado de `@auraia/shared` porque o frontend nao depende do pacote —
 * mesma razao pela qual `AskResponse` abaixo tambem e uma copia. Se um `kind`
 * novo nascer no shared, ele precisa aparecer aqui E ganhar um `case` em
 * `utils/formatters.ts`.
 */
export type ColumnFormatKind =
  | 'currency'
  | 'percent'
  | 'fraction'
  | 'integer'
  | 'decimal'
  | 'gram'
  | 'date'
  | 'datetime'
  | 'text'

export interface ColumnFormat {
  kind: ColumnFormatKind
  decimals?: number
  suffix?: string
}

export interface AskResponse {
  ok: boolean
  data?: {
    sql: string
    httpRequest?: string
    mode?: AppMode
    rows: Record<string, unknown>[]
    columns: string[]
    /** Mascara por nome de coluna. Ausente em resposta de versao antiga. */
    columnFormats?: Record<string, ColumnFormat>
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

export type DbType = 'sqlserver' | 'oracle' | 'mysql' | 'postgresql'

export interface EnvironmentSummary {
  environmentId: string
  name: string
}

export interface EnvironmentView {
  environmentId: string
  name: string
  mode: AppMode
  dbType?: DbType
  dbHost?: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  apiBaseUrl?: string
  apiAuthType?: ApiAuthType
  apiReadOnly?: boolean
  swaggerUrl?: string
  configuredAt: string
}

export interface ConfigStatusResponse {
  configured: boolean
  environmentCount?: number
  environments?: EnvironmentSummary[]
}

export interface AppConfigView {
  mode: AppMode
  dbType?: DbType
  dbHost?: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  openAiKeySet: boolean
  apiBaseUrl?: string
  apiAuthType?: ApiAuthType
  apiReadOnly?: boolean
  swaggerUrl?: string
}

export interface SaveAppConfigPayload {
  openAiApiKey: string
  mode: AppMode
  dbType?: DbType
  dbHost?: string
  dbPort?: number
  dbName?: string
  dbUser?: string
  dbPassword?: string
  apiBaseUrl?: string
  apiAuthType?: ApiAuthType
  apiAuthToken?: string
  apiAuthApiKeyHeader?: string
  apiAuthApiKeyValue?: string
  apiAuthUsername?: string
  apiAuthPassword?: string
  apiReadOnly?: boolean
  swaggerUrl?: string
  swaggerContent?: string
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

export interface AgentConfig {
  model: string
  temperature?: number
  enabled?: boolean
}

export interface SqlAgentConfig extends AgentConfig {
  modelMini: string
  maxRetries: number
}

export interface EmbeddingAgentConfig {
  model: string
}

export interface HttpAgentConfig extends AgentConfig {
  maxRetries: number
}

export interface AgentsConfig {
  sql: SqlAgentConfig
  http: HttpAgentConfig
  summary: AgentConfig
  translation: AgentConfig
  chart: AgentConfig
  embedding: EmbeddingAgentConfig
  planner?: AgentConfig
}

// ── Developer features ──

export interface PipelineStep {
  step: string
  label: string
  timestamp: number
}

export interface StatsResponse {
  totalQueries: number
  successRate: number
  cacheHitRate: number
  avgElapsedMs: number
  totalTokens: { input: number; output: number; total: number }
  tokenBreakdown: {
    sql: { input: number; output: number; total: number }
    summary: { input: number; output: number; total: number }
  }
  queriesPerDay: Array<{ date: string; count: number; errors: number }>
  topErrors: Array<{ message: string; count: number }>
  environmentBreakdown: Array<{ envId: string; count: number }>
  days: number
}
