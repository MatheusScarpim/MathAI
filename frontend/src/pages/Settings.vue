<template>
  <div class="settings-page">
    <header class="page-header">
      <h1>Configurações</h1>
      <p>Gerencie os agentes de IA e redefina o ambiente quando precisar recomeçar do zero.</p>
    </header>

    <section class="agents-section">
      <div class="section-title-row">
        <h2>Configuração de Agentes</h2>
        <button class="btn-secondary" :disabled="loadingAgents" @click="loadAgentsConfig">
          Recarregar
        </button>
      </div>

      <p class="section-description">Ajuste modelos e parâmetros usados por cada agente.</p>

      <p v-if="agentsMessage" class="message" :class="agentsMessageType">{{ agentsMessage }}</p>

      <div v-if="loadingAgents" class="loading">Carregando configurações dos agentes...</div>

      <template v-else-if="agentsConfig">
        <div class="agents-grid">
          <article class="agent-card">
            <h3>SQL</h3>
            <p>Gera consultas SQL e faz retries quando necessário.</p>

            <label>
              Modelo principal
              <input v-model="agentsConfig.sql.model" type="text" placeholder="gpt-5" />
            </label>

            <label>
              Modelo mini
              <input v-model="agentsConfig.sql.modelMini" type="text" placeholder="gpt-5-mini" />
            </label>

            <label>
              Temperatura (opcional)
              <input
                v-model="sqlTemperatureInput"
                type="number"
                min="0"
                max="2"
                step="0.1"
                placeholder="vazio = padrão do modelo"
              />
            </label>

            <label>
              Max retries
              <input v-model.number="agentsConfig.sql.maxRetries" type="number" min="1" max="10" step="1" />
            </label>
          </article>

          <article class="agent-card">
            <h3>HTTP</h3>
            <p>Gera requisições HTTP para APIs a partir de endpoints Swagger.</p>

            <label>
              Modelo
              <input v-model="agentsConfig.http.model" type="text" placeholder="gpt-5" />
            </label>

            <label>
              Temperatura (opcional)
              <input
                v-model="httpTemperatureInput"
                type="number"
                min="0"
                max="2"
                step="0.1"
                placeholder="vazio = padrão do modelo"
              />
            </label>

            <label>
              Max retries
              <input v-model.number="agentsConfig.http.maxRetries" type="number" min="1" max="10" step="1" />
            </label>
          </article>

          <article class="agent-card">
            <h3>Resumo</h3>
            <p>Gera um resumo textual dos resultados retornados pela query.</p>

            <label>
              Modelo
              <input v-model="agentsConfig.summary.model" type="text" placeholder="gpt-4o-mini" />
            </label>

            <label>
              Temperatura
              <input
                v-model.number="agentsConfig.summary.temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
            </label>

            <label class="toggle-line">
              <input v-model="agentsConfig.summary.enabled" type="checkbox" />
              <span>Ativado</span>
            </label>
          </article>

          <article class="agent-card">
            <h3>Tradução</h3>
            <p>Traduz pergunta e resumo conforme idioma de schema/resposta.</p>

            <label>
              Modelo
              <input v-model="agentsConfig.translation.model" type="text" placeholder="gpt-4o-mini" />
            </label>

            <label>
              Temperatura
              <input
                v-model.number="agentsConfig.translation.temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
            </label>

            <label class="toggle-line">
              <input v-model="agentsConfig.translation.enabled" type="checkbox" />
              <span>Ativado</span>
            </label>
          </article>

          <article class="agent-card">
            <h3>Gráfico</h3>
            <p>Infere visualização de dados para resposta tabular.</p>

            <label>
              Modelo
              <input v-model="agentsConfig.chart.model" type="text" placeholder="gpt-4o-mini" />
            </label>

            <label>
              Temperatura
              <input
                v-model.number="agentsConfig.chart.temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
            </label>

            <label class="toggle-line">
              <input v-model="agentsConfig.chart.enabled" type="checkbox" />
              <span>Ativado</span>
            </label>
          </article>

          <article class="agent-card">
            <h3>Planner</h3>
            <p>Decompõe perguntas complexas em subconsultas independentes.</p>

            <label>
              Modelo
              <input v-model="plannerModel" type="text" placeholder="gpt-5-mini" />
            </label>

            <label>
              Temperatura
              <input
                v-model.number="plannerTemperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
            </label>

            <label class="toggle-line">
              <input v-model="plannerEnabled" type="checkbox" />
              <span>Ativado</span>
            </label>
          </article>

          <article class="agent-card">
            <h3>Embedding</h3>
            <p>Gera embeddings para busca semântica de contexto e schema.</p>

            <label>
              Modelo
              <input
                v-model="agentsConfig.embedding.model"
                type="text"
                placeholder="text-embedding-3-small"
              />
            </label>
          </article>
        </div>

        <div class="actions-row">
          <button class="btn-primary" :disabled="savingAgents" @click="saveAgentsConfig">
            {{ savingAgents ? 'Salvando...' : 'Salvar configurações de agentes' }}
          </button>
        </div>

      </template>
    </section>

    <section class="routing-section">
      <div class="section-title-row">
        <h2>Roteamento de Modelos</h2>
        <button class="btn-secondary" :disabled="loadingRouting" @click="loadRoutingRules">
          {{ loadingRouting ? 'Carregando...' : 'Recarregar' }}
        </button>
      </div>
      <p class="section-description">
        Regras determinísticas que escolhem qual provedor + modelo executa cada subtask.
        Avaliadas em ordem de prioridade; a primeira que matchar vence.
      </p>

      <div class="providers-health">
        <strong>Status do fleet:</strong>
        <span v-for="(p, name) in providersHealth" :key="name" class="provider-pill" :class="`health-${p.status}`">
          {{ p.status === 'ok' ? '🟢' : '🔴' }} {{ name }} <code>{{ p.url }}</code>
        </span>
        <span v-if="!providersHealth || !Object.keys(providersHealth).length" class="muted">
          (não verificado — clique em "Recarregar")
        </span>
      </div>

      <table v-if="routingRules.length" class="routing-table">
        <thead>
          <tr>
            <th>Prio</th>
            <th>Agent</th>
            <th>Type</th>
            <th>Description regex</th>
            <th>Repo regex</th>
            <th>Provider</th>
            <th>Model</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, i) in routingRules" :key="i">
            <td><input type="number" v-model.number="rule.priority" class="prio-input" /></td>
            <td>
              <select v-model="rule.agent">
                <option value="taskCode">taskCode</option>
                <option value="taskPlanner">taskPlanner</option>
                <option value="taskReviewer">taskReviewer</option>
                <option value="taskReporter">taskReporter</option>
                <option value="any">any</option>
              </select>
            </td>
            <td>
              <select v-model="rule.when!.type">
                <option :value="undefined">(any)</option>
                <option value="github">github</option>
                <option value="api">api</option>
                <option value="custom">custom</option>
                <option value="trello">trello</option>
              </select>
            </td>
            <td><input type="text" v-model="rule.when!.descriptionMatches" placeholder="(none)" /></td>
            <td><input type="text" v-model="rule.when!.repoMatches" placeholder="(none)" /></td>
            <td>
              <select v-model="rule.route.provider">
                <option value="anthropic">anthropic</option>
                <option value="codex">codex</option>
                <option value="deepseek">deepseek</option>
              </select>
            </td>
            <td><input type="text" v-model="rule.route.model" /></td>
            <td>
              <button class="btn-link-danger" @click="removeRoutingRule(i)" title="Remover">✕</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="actions-row">
        <button class="btn-secondary" @click="addRoutingRule">+ Adicionar regra</button>
        <button class="btn-primary" :disabled="savingRouting" @click="saveRoutingRules">
          {{ savingRouting ? 'Salvando...' : 'Salvar regras' }}
        </button>
        <button class="btn-secondary" @click="openTestRouting">Testar regra</button>
      </div>

      <div v-if="routingMessage" class="status-line" :class="routingMessageType">
        {{ routingMessage }}
      </div>

      <div v-if="showRoutingTest" class="routing-test">
        <h3>Simular roteamento</h3>
        <div class="routing-test-grid">
          <label>Agent
            <select v-model="testInput.agent">
              <option value="taskCode">taskCode</option>
              <option value="taskPlanner">taskPlanner</option>
              <option value="taskReviewer">taskReviewer</option>
              <option value="taskReporter">taskReporter</option>
            </select>
          </label>
          <label>Type
            <select v-model="testInput.type">
              <option :value="undefined">(none)</option>
              <option value="github">github</option>
              <option value="api">api</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label>Description
            <input type="text" v-model="testInput.description" placeholder="atualizar Calculator.vue" />
          </label>
          <label>Repo
            <input type="text" v-model="testInput.repo" placeholder="owner/repo" />
          </label>
        </div>
        <div class="actions-row">
          <button class="btn-primary" @click="runRoutingTest">Rodar</button>
          <button class="btn-secondary" @click="showRoutingTest = false">Fechar</button>
        </div>
        <pre v-if="testResult" class="routing-test-result">{{ JSON.stringify(testResult, null, 2) }}</pre>
      </div>
    </section>

    <section class="auth-section">
      <div class="section-title-row">
        <h2>Autenticação</h2>
      </div>
      <p class="section-description">
        Quando ativo, exige login com usuário e senha para acessar o sistema.
      </p>

      <div v-if="!authEnabled && !showAuthSetup" class="auth-toggle-row">
        <button class="btn-primary" @click="showAuthSetup = true">Ativar autenticação</button>
      </div>

      <div v-if="!authEnabled && showAuthSetup" class="auth-setup-form">
        <p class="auth-setup-hint">Crie o primeiro usuário para ativar a autenticação.</p>

        <label class="label-field">
          Usuário
          <input v-model="newAuthUsername" type="text" placeholder="Mínimo 3 caracteres" />
        </label>

        <label class="label-field">
          Senha
          <input v-model="newAuthPassword" type="password" placeholder="Mínimo 8 caracteres (1 letra + 1 número)" />
        </label>

        <label class="label-field">
          Confirmar senha
          <input v-model="newAuthConfirm" type="password" placeholder="Repita a senha" />
        </label>

        <div class="auth-setup-actions">
          <button
            class="btn-primary"
            :disabled="activatingAuth"
            @click="onActivateAuth"
          >
            {{ activatingAuth ? 'Ativando...' : 'Criar usuário e ativar' }}
          </button>
          <button class="btn-secondary" @click="showAuthSetup = false">Cancelar</button>
        </div>
      </div>

      <div v-if="authEnabled" class="auth-toggle-row">
        <label class="toggle-line">
          <span class="auth-active-badge">Autenticação ativa</span>
        </label>
        <button class="btn-danger-sm" :disabled="activatingAuth" @click="onDeactivateAuth">
          {{ activatingAuth ? 'Desativando...' : 'Desativar autenticação' }}
        </button>
      </div>

      <p v-if="authMessage" class="message" :class="authMessageType">{{ authMessage }}</p>
    </section>

    <section class="integrations-section">
      <div class="section-title-row">
        <h2>Integracoes</h2>
      </div>
      <p class="section-description">Configure as integracoes do Task Orchestrator.</p>

      <div class="integration-grid">
        <!-- Trello -->
        <div class="integration-card">
          <h3>Trello</h3>
          <label>
            API Key
            <input v-model="integrations.trelloApiKey" type="password" placeholder="TRELLO_API_KEY" />
          </label>
          <label>
            API Token
            <input v-model="integrations.trelloApiToken" type="password" placeholder="TRELLO_API_TOKEN" />
          </label>
          <label>
            Board Padrao
            <div class="select-row">
              <select v-model="integrations.trelloBoardId" @change="onTrelloBoardChange">
                <option value="">— escolha um board —</option>
                <option v-for="b in trelloBoards" :key="b.id" :value="b.id">{{ b.name }}</option>
              </select>
              <button type="button" class="btn-mini" :disabled="trelloLoadingBoards" @click="loadTrelloBoards" title="Recarregar boards">
                {{ trelloLoadingBoards ? '...' : '↻' }}
              </button>
            </div>
            <small v-if="trelloError" class="hint-error">{{ trelloError }}</small>
            <small v-else-if="!trelloBoards.length && integrations.trelloApiKey && integrations.trelloApiToken" class="hint-muted">
              Salve primeiro as credenciais para listar os boards.
            </small>
          </label>
          <label>
            Lista Padrao (coluna)
            <select v-model="integrations.trelloListId" :disabled="!integrations.trelloBoardId || trelloLoadingLists">
              <option value="">— primeira lista do board —</option>
              <option v-for="l in trelloLists" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select>
          </label>
          <label>
            Lista "Done" (destino ao finalizar)
            <select v-model="integrations.trelloDoneListId" :disabled="!integrations.trelloBoardId || trelloLoadingLists">
              <option value="">— nao mover automaticamente —</option>
              <option v-for="l in trelloLists" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select>
            <small class="hint-muted">Cards sao movidos pra esta coluna quando a task termina (sucesso ou falha).</small>
          </label>
        </div>

        <!-- GitHub -->
        <div class="integration-card">
          <h3>GitHub</h3>
          <label>
            Token
            <input v-model="integrations.githubToken" type="password" placeholder="GITHUB_TOKEN" />
          </label>
          <label>
            Owner Padrao
            <input v-model="integrations.githubOwner" type="text" placeholder="GITHUB_DEFAULT_OWNER" />
          </label>
          <label>
            Repo Padrao
            <input v-model="integrations.githubRepo" type="text" placeholder="GITHUB_DEFAULT_REPO" />
          </label>
        </div>

        <!-- WhatsApp -->
        <div class="integration-card">
          <h3>WhatsApp <span class="card-badge">beta</span></h3>
          <label class="toggle-line">
            <input v-model="integrations.whatsappEnabled" type="checkbox" />
            <span>Ativar bot WhatsApp</span>
          </label>
          <label>
            Rate limit (ms entre msgs)
            <input v-model.number="integrations.whatsappRateLimitMs" type="number" min="500" step="100" />
          </label>
          <p v-if="waPairingStatus" class="wa-status" :class="`wa-${waPairingStatus}`">
            <span v-if="waPairingStatus === 'paired'">✅ Pareado: +{{ waPhone || '?' }}</span>
            <span v-else-if="waPairingStatus === 'logged_out'">⚠️ Sessao revogada</span>
            <span v-else>⏳ Nao pareado</span>
            <span v-if="waHealth" class="wa-health-badge" :class="`wa-health-${waHealth}`">
              {{ waHealth === 'ok' ? '🟢 ok' : waHealth === 'degraded' ? '🟡 degraded' : '🔴 warning' }}
            </span>
          </p>
          <p v-if="waMetrics" class="wa-metrics">
            ↑{{ waMetrics.messagesSent }} · ↓{{ waMetrics.messagesReceived }} ·
            😀{{ waMetrics.reactionsSent }} · 📎{{ waMetrics.documentsSent }} ·
            ❌{{ waMetrics.sendErrors }} · ⟳{{ waMetrics.reconnects }}
          </p>
          <router-link to="/settings/whatsapp" class="btn-link">
            Abrir tela de pareamento →
          </router-link>
        </div>

        <!-- OpenClaude / DeepSeek -->
        <div class="integration-card">
          <h3>OpenClaude (Code Agent)</h3>
          <label>
            Modelo
            <input v-model="integrations.openclaudeModel" type="text" placeholder="deepseek-chat" />
          </label>
          <label>
            Provider
            <select v-model="integrations.openclaudeProvider" class="config-select">
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn-primary" :disabled="savingIntegrations" @click="saveIntegrations">
          {{ savingIntegrations ? 'Salvando...' : 'Salvar integracoes' }}
        </button>
      </div>

      <p v-if="integrationsMessage" class="message" :class="integrationsMessageType">{{ integrationsMessage }}</p>
    </section>

    <section class="danger-zone">
      <h2>Zona de risco</h2>
      <p>
        Esta ação remove configuração, histórico, instruções, configurações e schema indexado.
        Depois disso, o sistema volta para o setup inicial.
      </p>

      <label class="confirm-line">
        Digite <code>RESET</code> para habilitar:
        <input v-model="confirmText" type="text" placeholder="RESET" />
      </label>

      <button
        class="btn-danger"
        :disabled="resetting || confirmText !== 'RESET'"
        @click="onResetEnvironment"
      >
        {{ resetting ? 'Limpando ambiente...' : 'Resetar ambiente' }}
      </button>

      <p v-if="resetMessage" class="message" :class="resetMessageType">{{ resetMessage }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import type { RoutingRule } from '../services/api'
import { setToken } from '../services/auth'
import type { AgentsConfig } from '../types'

const router = useRouter()

const loadingAgents = ref(true)
const savingAgents = ref(false)
const agentsConfig = ref<AgentsConfig | null>(null)
const sqlTemperatureInput = ref('')
const agentsMessage = ref('')
const agentsMessageType = ref<'ok' | 'error'>('ok')

const authEnabled = ref(false)
const showAuthSetup = ref(false)
const newAuthUsername = ref('')
const newAuthPassword = ref('')
const newAuthConfirm = ref('')
const activatingAuth = ref(false)
const authMessage = ref('')
const authMessageType = ref<'ok' | 'error'>('ok')

const confirmText = ref('')
const resetting = ref(false)
const resetMessage = ref('')
const resetMessageType = ref<'ok' | 'error'>('ok')

const integrations = ref({
  trelloApiKey: '',
  trelloApiToken: '',
  trelloBoardId: '',
  trelloListId: '',
  trelloDoneListId: '',
  githubToken: '',
  githubOwner: '',
  githubRepo: '',
  openclaudeModel: '',
  openclaudeProvider: 'deepseek',
  whatsappEnabled: false,
  whatsappRateLimitMs: 2500
})

const waPairingStatus = ref<'unpaired' | 'paired' | 'logged_out' | ''>('')
const waPhone = ref('')
const waHealth = ref<'ok' | 'degraded' | 'warning' | ''>('')
const waMetrics = ref<{
  messagesSent: number; messagesReceived: number; reactionsSent: number;
  documentsSent: number; sendErrors: number; reconnects: number;
} | null>(null)
const savingIntegrations = ref(false)
const integrationsMessage = ref('')
const integrationsMessageType = ref<'ok' | 'error'>('ok')

// Trello dropdowns
const trelloBoards = ref<Array<{ id: string; name: string; url: string }>>([])
const trelloLists = ref<Array<{ id: string; name: string }>>([])
const trelloLoadingBoards = ref(false)
const trelloLoadingLists = ref(false)
const trelloError = ref('')

const loadTrelloBoards = async () => {
  trelloError.value = ''
  if (!integrations.value.trelloApiKey || !integrations.value.trelloApiToken) {
    trelloBoards.value = []
    return
  }
  trelloLoadingBoards.value = true
  try {
    trelloBoards.value = await api.getTrelloBoards()
  } catch (err) {
    trelloBoards.value = []
    trelloError.value = err instanceof Error ? err.message : 'Falha ao carregar boards. Salve e teste API Key/Token.'
  } finally {
    trelloLoadingBoards.value = false
  }
}

const loadTrelloLists = async (boardId: string) => {
  if (!boardId) {
    trelloLists.value = []
    return
  }
  trelloLoadingLists.value = true
  try {
    trelloLists.value = await api.getTrelloLists(boardId)
  } catch {
    trelloLists.value = []
  } finally {
    trelloLoadingLists.value = false
  }
}

const onTrelloBoardChange = async () => {
  integrations.value.trelloListId = ''
  await loadTrelloLists(integrations.value.trelloBoardId)
}

const httpTemperatureInput = ref('')
const plannerModel = ref('gpt-5-mini')
const plannerTemperature = ref(0)
const plannerEnabled = ref(true)

const cloneAgentsConfig = (config: AgentsConfig): AgentsConfig => ({
  sql: { ...config.sql },
  http: { ...config.http },
  summary: { ...config.summary },
  translation: { ...config.translation },
  chart: { ...config.chart },
  embedding: { ...config.embedding },
  planner: config.planner ? { ...config.planner } : undefined
})

const clampTemperature = (value: number): number => Math.max(0, Math.min(2, value))

const parseRequiredTemperature = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return clampTemperature(n)
}

const parseOptionalTemperature = (value: string): number | undefined => {
  const raw = value.trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return clampTemperature(n)
}

const applyAgentsConfig = (config: AgentsConfig): void => {
  agentsConfig.value = cloneAgentsConfig(config)
  sqlTemperatureInput.value =
    typeof config.sql.temperature === 'number' && Number.isFinite(config.sql.temperature)
      ? String(config.sql.temperature)
      : ''
  httpTemperatureInput.value =
    typeof config.http.temperature === 'number' && Number.isFinite(config.http.temperature)
      ? String(config.http.temperature)
      : ''
  plannerModel.value = config.planner?.model ?? 'gpt-5-mini'
  plannerTemperature.value = config.planner?.temperature ?? 0
  plannerEnabled.value = config.planner?.enabled !== false
}

const loadAgentsConfig = async (): Promise<void> => {
  loadingAgents.value = true
  agentsMessage.value = ''

  try {
    const config = await api.getAgentsConfig()
    applyAgentsConfig(config)
  } catch (error) {
    agentsMessageType.value = 'error'
    agentsMessage.value = (error as Error).message || 'Erro ao carregar configurações de agentes.'
  } finally {
    loadingAgents.value = false
  }
}

const buildPayload = (config: AgentsConfig): AgentsConfig => ({
  sql: {
    model: config.sql.model.trim(),
    modelMini: config.sql.modelMini.trim(),
    temperature: parseOptionalTemperature(sqlTemperatureInput.value),
    maxRetries: Math.max(1, Math.min(10, Math.floor(Number(config.sql.maxRetries) || 1))),
    enabled: config.sql.enabled !== false
  },
  http: {
    model: config.http.model.trim(),
    temperature: parseOptionalTemperature(httpTemperatureInput.value),
    maxRetries: Math.max(1, Math.min(10, Math.floor(Number(config.http.maxRetries) || 1))),
    enabled: config.http.enabled !== false
  },
  summary: {
    model: config.summary.model.trim(),
    temperature: parseRequiredTemperature(config.summary.temperature, 0.2),
    enabled: config.summary.enabled !== false
  },
  translation: {
    model: config.translation.model.trim(),
    temperature: parseRequiredTemperature(config.translation.temperature, 0),
    enabled: config.translation.enabled !== false
  },
  chart: {
    model: config.chart.model.trim(),
    temperature: parseRequiredTemperature(config.chart.temperature, 0.2),
    enabled: config.chart.enabled !== false
  },
  embedding: {
    model: config.embedding.model.trim()
  },
  planner: {
    model: plannerModel.value.trim() || 'gpt-5-mini',
    temperature: parseRequiredTemperature(plannerTemperature.value, 0),
    enabled: plannerEnabled.value
  }
})

const saveAgentsConfig = async (): Promise<void> => {
  if (!agentsConfig.value) return

  savingAgents.value = true
  agentsMessage.value = ''

  try {
    const payload = buildPayload(agentsConfig.value)
    const saved = await api.saveAgentsConfig(payload)
    applyAgentsConfig(saved)
    agentsMessageType.value = 'ok'
    agentsMessage.value = 'Configurações de agentes salvas com sucesso.'
  } catch (error) {
    agentsMessageType.value = 'error'
    agentsMessage.value = (error as Error).message || 'Erro ao salvar configurações de agentes.'
  } finally {
    savingAgents.value = false
  }
}

const onResetEnvironment = async () => {
  if (confirmText.value !== 'RESET') return
  resetting.value = true
  resetMessage.value = ''

  try {
    await api.resetEnvironment()
    resetMessageType.value = 'ok'
    resetMessage.value = 'Ambiente resetado com sucesso. Redirecionando para setup...'
    await router.replace('/setup')
  } catch (error) {
    resetMessageType.value = 'error'
    resetMessage.value = (error as Error).message || 'Erro ao resetar ambiente.'
  } finally {
    resetting.value = false
  }
}

const loadAuthStatus = async () => {
  try {
    const status = await api.getAuthStatus()
    authEnabled.value = status.enabled
  } catch { /* ignore */ }
}

const loadIntegrations = async () => {
  try {
    const raw = await api.getIntegrationsSettings()
    const s = (raw ?? {}) as Record<string, unknown>
    const str = (k: string): string => typeof s[k] === 'string' ? (s[k] as string) : ''
    if (raw) {
      integrations.value = {
        trelloApiKey: str('trelloApiKey'),
        trelloApiToken: str('trelloApiToken'),
        trelloBoardId: str('trelloBoardId'),
        trelloListId: str('trelloListId'),
        trelloDoneListId: str('trelloDoneListId'),
        githubToken: str('githubToken'),
        githubOwner: str('githubOwner'),
        githubRepo: str('githubRepo'),
        openclaudeModel: str('openclaudeModel'),
        openclaudeProvider: str('openclaudeProvider') || 'deepseek',
        whatsappEnabled: s.whatsappEnabled === true || s.whatsappEnabled === 'true',
        whatsappRateLimitMs: typeof s.whatsappRateLimitMs === 'number' ? s.whatsappRateLimitMs : 2500
      }
    }
    // Status WhatsApp pra exibir badge
    await refreshWhatsappStatus()
    // Pre-carrega boards/lists se as credenciais já estiverem persistidas no DB
    await loadTrelloBoards()
    if (integrations.value.trelloBoardId) {
      await loadTrelloLists(integrations.value.trelloBoardId)
    }
  } catch { /* ignore */ }
}

const saveIntegrations = async () => {
  savingIntegrations.value = true
  integrationsMessage.value = ''
  try {
    await api.saveIntegrationsSettings(integrations.value)
    integrationsMessageType.value = 'ok'
    integrationsMessage.value = 'Integracoes salvas com sucesso.'
    // Recarrega boards apos salvar (pode ter mudado key/token)
    await loadTrelloBoards()
  } catch (err) {
    integrationsMessageType.value = 'error'
    integrationsMessage.value = (err as Error).message || 'Erro ao salvar.'
  } finally {
    savingIntegrations.value = false
  }
}

const onActivateAuth = async () => {
  authMessage.value = ''

  if (!newAuthUsername.value || newAuthUsername.value.length < 3) {
    authMessageType.value = 'error'
    authMessage.value = 'Username deve ter pelo menos 3 caracteres.'
    return
  }
  if (!newAuthPassword.value || newAuthPassword.value.length < 8) {
    authMessageType.value = 'error'
    authMessage.value = 'Senha deve ter pelo menos 8 caracteres.'
    return
  }
  if (!/[a-zA-Z]/.test(newAuthPassword.value) || !/\d/.test(newAuthPassword.value)) {
    authMessageType.value = 'error'
    authMessage.value = 'Senha deve conter pelo menos 1 letra e 1 número.'
    return
  }
  if (newAuthPassword.value !== newAuthConfirm.value) {
    authMessageType.value = 'error'
    authMessage.value = 'As senhas não coincidem.'
    return
  }

  activatingAuth.value = true
  try {
    const registerResult = await api.register(newAuthUsername.value, newAuthPassword.value)
    setToken(registerResult.token)
    await api.toggleAuth(true)
    authEnabled.value = true
    showAuthSetup.value = false
    newAuthUsername.value = ''
    newAuthPassword.value = ''
    newAuthConfirm.value = ''
    authMessageType.value = 'ok'
    authMessage.value = 'Autenticação ativada. Usuário criado com sucesso.'
  } catch (error) {
    authMessageType.value = 'error'
    authMessage.value = (error as Error).message || 'Erro ao ativar autenticação.'
  } finally {
    activatingAuth.value = false
  }
}

const onDeactivateAuth = async () => {
  authMessage.value = ''
  activatingAuth.value = true
  try {
    await api.toggleAuth(false)
    authEnabled.value = false
    authMessageType.value = 'ok'
    authMessage.value = 'Autenticação desativada.'
  } catch (error) {
    authMessageType.value = 'error'
    authMessage.value = (error as Error).message || 'Erro ao desativar autenticação.'
  } finally {
    activatingAuth.value = false
  }
}

/** Recarrega status WhatsApp (chamado no mount e a cada 15s pelo poll). */
async function refreshWhatsappStatus() {
  try {
    const waRes = await fetch('/api/whatsapp/status')
    if (waRes.ok) {
      const wa = await waRes.json()
      waPairingStatus.value = wa.pairingStatus || 'unpaired'
      waPhone.value = wa.phoneNumber || ''
      waHealth.value = wa.health || ''
      waMetrics.value = wa.metrics || null
    }
  } catch { /* ignore — best-effort */ }
}

// ── Routing rules state ─────────────────────────────────────────────
const routingRules = ref<RoutingRule[]>([])
const loadingRouting = ref(false)
const savingRouting = ref(false)
const routingMessage = ref('')
const routingMessageType = ref<'ok' | 'error'>('ok')
const providersHealth = ref<Record<string, { url: string; status: 'ok' | 'down' }>>({})

const showRoutingTest = ref(false)
const testInput = ref<{ agent: 'taskCode' | 'taskPlanner' | 'taskReviewer' | 'taskReporter'; type?: 'trello' | 'github' | 'api' | 'custom'; description: string; repo: string }>({
  agent: 'taskCode',
  type: 'github',
  description: '',
  repo: ''
})
const testResult = ref<unknown>(null)

const ensureWhen = (rule: RoutingRule): RoutingRule => {
  if (!rule.when) rule.when = {}
  return rule
}

const loadRoutingRules = async (): Promise<void> => {
  loadingRouting.value = true
  routingMessage.value = ''
  try {
    const [rulesResp, health] = await Promise.all([
      api.getRoutingRules(),
      api.getProvidersHealth().catch(() => ({}))
    ])
    routingRules.value = rulesResp.rules.map(ensureWhen)
    providersHealth.value = health as Record<string, { url: string; status: 'ok' | 'down' }>
  } catch (err) {
    routingMessageType.value = 'error'
    routingMessage.value = err instanceof Error ? err.message : 'Falha ao carregar regras'
  } finally {
    loadingRouting.value = false
  }
}

const addRoutingRule = (): void => {
  const maxPrio = routingRules.value.reduce((m, r) => Math.max(m, r.priority), 0)
  routingRules.value.push({
    priority: maxPrio + 10,
    agent: 'taskCode',
    when: { type: 'github' },
    route: { provider: 'deepseek', model: 'deepseek-chat' }
  })
}

const removeRoutingRule = (i: number): void => {
  routingRules.value.splice(i, 1)
}

const saveRoutingRules = async (): Promise<void> => {
  savingRouting.value = true
  routingMessage.value = ''
  try {
    // Strip empty optional fields antes de enviar
    const cleaned = routingRules.value.map(r => ({
      priority: r.priority,
      agent: r.agent,
      when: r.when && (r.when.type || r.when.descriptionMatches || r.when.repoMatches)
        ? {
            ...(r.when.type ? { type: r.when.type } : {}),
            ...(r.when.descriptionMatches ? { descriptionMatches: r.when.descriptionMatches } : {}),
            ...(r.when.repoMatches ? { repoMatches: r.when.repoMatches } : {})
          }
        : undefined,
      route: r.route
    }))
    const resp = await api.saveRoutingRules(cleaned as RoutingRule[])
    routingMessageType.value = 'ok'
    routingMessage.value = `Salvas ${resp.count} regras.`
  } catch (err) {
    routingMessageType.value = 'error'
    routingMessage.value = err instanceof Error ? err.message : 'Falha ao salvar'
  } finally {
    savingRouting.value = false
  }
}

const openTestRouting = (): void => {
  showRoutingTest.value = true
  testResult.value = null
}

const runRoutingTest = async (): Promise<void> => {
  try {
    const resp = await api.testRoutingRule(testInput.value)
    testResult.value = resp.route
  } catch (err) {
    testResult.value = { error: err instanceof Error ? err.message : 'falha' }
  }
}

let waPollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void loadAgentsConfig()
  void loadAuthStatus()
  void loadIntegrations()
  void loadRoutingRules()
  // Poll do status WA a cada 15s pra atualizar badge + counters sem refresh
  waPollTimer = setInterval(() => { void refreshWhatsappStatus() }, 15_000)
})

onUnmounted(() => {
  if (waPollTimer) {
    clearInterval(waPollTimer)
    waPollTimer = null
  }
})
</script>

<style scoped>
.settings-page {
  padding: 2rem;
  max-width: 980px;
  margin: 0 auto;
  display: grid;
  gap: 1.5rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
  background: linear-gradient(135deg, var(--color-gray-50, #f8fafc), var(--color-gray-300, #cbd5e1));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.page-header p {
  color: var(--color-gray-500);
}

.agents-section {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1.25rem;
  transition: border-color 0.25s ease;
}

.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.section-title-row h2 {
  margin: 0;
}

.section-description {
  color: var(--color-gray-400);
  margin: 0.5rem 0 1rem;
}

.loading {
  color: var(--color-gray-400);
}

.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
}

.agent-card {
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 1rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  display: grid;
  gap: 0.75rem;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.agent-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-sm);
}

.agent-card h3 {
  margin: 0;
}

.agent-card p {
  margin: 0;
  color: var(--color-gray-400);
  font-size: 0.92rem;
}

.agent-card label {
  display: grid;
  gap: 0.35rem;
  color: var(--color-gray-300);
  font-size: 0.92rem;
}

.agent-card input[type='text'],
.agent-card input[type='number'],
.confirm-line input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-100);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.agent-card input[type='text']:focus,
.agent-card input[type='number']:focus,
.confirm-line input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
}

.toggle-line {
  display: flex !important;
  align-items: center;
  gap: 0.5rem;
}

.toggle-line input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  width: 2.5rem;
  height: 1.35rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-border);
  position: relative;
  cursor: pointer;
  transition: background 0.25s ease, border-color 0.25s ease;
  flex-shrink: 0;
}

.toggle-line input[type='checkbox']::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 0.9rem;
  height: 0.9rem;
  border-radius: 50%;
  background: var(--color-gray-400);
  transition: transform 0.25s ease, background 0.25s ease;
}

.toggle-line input[type='checkbox']:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.toggle-line input[type='checkbox']:checked::after {
  transform: translateX(1.1rem);
  background: #fff;
}

.actions-row {
  margin-top: 1rem;
  display: flex;
  justify-content: flex-end;
}

.btn-primary,
.btn-secondary,
.btn-danger {
  border: none;
  border-radius: 8px;
  padding: 0.65rem 1rem;
  cursor: pointer;
  transition: box-shadow 0.25s ease, opacity 0.25s ease, background 0.25s ease;
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-dark, #059669));
  color: #fff;
  box-shadow: var(--glow-accent);
}

.btn-primary:hover {
  box-shadow: 0 0 28px rgba(16, 185, 129, 0.25);
}

.btn-secondary {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  color: var(--color-gray-100);
}

.btn-secondary:hover {
  border-color: var(--glass-border-hover);
}

.btn-danger {
  background: linear-gradient(135deg, #dc2626, #991b1b);
  color: #fff;
  box-shadow: 0 0 20px rgba(220, 38, 38, 0.15);
}

.btn-danger:hover {
  box-shadow: 0 0 28px rgba(220, 38, 38, 0.25);
}

.btn-primary:disabled,
.btn-secondary:disabled,
.btn-danger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.integrations-section {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1.25rem;
}

.integration-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
}

.integration-card {
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 1rem;
  background: var(--glass-bg);
  display: grid;
  gap: 0.75rem;
}

.integration-card h3 {
  margin: 0;
}

.integration-card label {
  display: grid;
  gap: 0.35rem;
  color: var(--color-gray-300);
  font-size: 0.92rem;
}

.integration-card input,
.config-select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-100);
}

.integration-card input:focus,
.config-select:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
}

.config-select {
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
}

.auth-toggle-row {
  margin-top: 2rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.auth-active-badge {
  color: var(--color-accent-light);
  font-weight: 500;
  text-shadow: 0 0 12px rgba(16, 185, 129, 0.3);
}

.btn-danger-sm {
  border: 1px solid var(--glass-border);
  background: rgba(127, 29, 29, 0.15);
  color: #fca5a5;
  border-radius: 8px;
  padding: 0.45rem 0.85rem;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}

.btn-danger-sm:hover {
  background: rgba(127, 29, 29, 0.3);
  border-color: rgba(248, 113, 113, 0.35);
  box-shadow: 0 0 16px rgba(220, 38, 38, 0.12);
}

.btn-danger-sm:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.auth-setup-form {
  margin-top: 0.75rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 1rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  display: grid;
  gap: 0.75rem;
  max-width: 380px;
}

.auth-setup-hint {
  color: var(--color-gray-300);
  font-size: 0.9rem;
  margin: 0;
}

.label-field {
  display: grid;
  gap: 0.35rem;
  color: var(--color-gray-300);
  font-size: 0.92rem;
}

.label-field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-100);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.label-field input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
}

.auth-setup-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.danger-zone {
  background: var(--glass-bg-strong);
  border: 1px solid rgba(248, 113, 113, 0.25);
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 0 20px rgba(220, 38, 38, 0.06);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.danger-zone h2 {
  color: #fca5a5;
  margin-bottom: 0.5rem;
}

.danger-zone p {
  color: var(--color-gray-300);
}

.confirm-line {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 1rem 0;
  color: var(--color-gray-300);
  max-width: 280px;
}

.message {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  font-size: 0.92rem;
}

.message.ok {
  color: var(--color-accent-light);
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.15);
}

.message.error {
  color: #fda4af;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.15);
}

@media (max-width: 640px) {
  .settings-page {
    padding: 1rem;
  }

  .section-title-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .actions-row {
    justify-content: stretch;
  }

  .actions-row .btn-primary {
    width: 100%;
  }
}

/* Trello dropdown helpers */
.select-row { display: flex; gap: .5rem; align-items: stretch; }
.select-row select { flex: 1; min-width: 0; }
.btn-mini {
  background: transparent;
  border: 1px solid var(--border, #333);
  color: var(--text-secondary, #aaa);
  border-radius: 6px;
  padding: 0 .65rem;
  cursor: pointer;
  font-size: .85rem;
}
.btn-mini:hover:not(:disabled) { border-color: var(--primary, #6c5ce7); color: var(--primary, #6c5ce7); }
.btn-mini:disabled { opacity: .5; cursor: not-allowed; }
.hint-error { display: block; margin-top: .35rem; color: #ff6b6b; font-size: .72rem; }
.hint-muted { display: block; margin-top: .35rem; color: var(--text-secondary, #888); font-size: .72rem; }
.integration-card select {
  background: var(--bg-primary, #0f0f23);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: .45rem .65rem;
  color: var(--text, #fff);
  font-size: .85rem;
  width: 100%;
}
.integration-card select:disabled { opacity: .55; cursor: not-allowed; }

/* WhatsApp section helpers */
.card-badge {
  display: inline-block;
  font-size: .65rem;
  background: rgba(16, 185, 129, .15);
  color: #6ee7b7;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  margin-left: .35rem;
  vertical-align: middle;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.wa-status { font-size: .85rem; margin: .35rem 0; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.wa-paired { color: #6ee7b7; }
.wa-logged_out { color: #fca5a5; }
.wa-unpaired { color: #fbbf24; }
.wa-health-badge {
  display: inline-block;
  font-size: .7rem;
  padding: .1rem .4rem;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.wa-health-ok { background: rgba(16, 185, 129, .15); color: #6ee7b7; }
.wa-health-degraded { background: rgba(251, 191, 36, .15); color: #fbbf24; }
.wa-health-warning { background: rgba(239, 68, 68, .15); color: #fca5a5; }
.wa-metrics {
  font-size: .75rem;
  color: var(--text-muted, #94a3b8);
  margin: .25rem 0 .35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
}
.btn-link {
  display: inline-block;
  margin-top: .35rem;
  color: var(--color-accent, #10b981);
  text-decoration: none;
  font-size: .9rem;
}
.btn-link:hover { text-decoration: underline; }

/* ── Routing section ─────────────────────────────────────────── */
.routing-section { margin-top: 2rem; }
.providers-health {
  display: flex; gap: .75rem; align-items: center; flex-wrap: wrap;
  background: var(--color-bg-secondary, #1a1a1a);
  padding: .5rem .75rem; border-radius: 6px; font-size: .85rem; margin-bottom: 1rem;
}
.provider-pill {
  display: inline-flex; gap: .3rem; align-items: center;
  background: var(--color-bg-primary, #0f0f0f);
  padding: .25rem .55rem; border-radius: 4px; font-size: .8rem;
}
.provider-pill code { font-size: .75rem; opacity: .7; }
.provider-pill.health-down { border-left: 3px solid #ef4444; }
.provider-pill.health-ok { border-left: 3px solid #10b981; }

.routing-table {
  width: 100%; border-collapse: collapse; font-size: .85rem; margin: .5rem 0 1rem;
}
.routing-table th, .routing-table td {
  text-align: left; padding: .4rem .5rem;
  border-bottom: 1px solid var(--color-border, #2a2a2a);
  vertical-align: middle;
}
.routing-table input, .routing-table select {
  width: 100%; box-sizing: border-box;
  background: var(--color-bg-primary, #0f0f0f);
  color: inherit; border: 1px solid var(--color-border, #2a2a2a);
  padding: .25rem .4rem; border-radius: 4px; font-size: .8rem;
}
.routing-table .prio-input { width: 4rem; }
.btn-link-danger {
  background: transparent; color: #ef4444; border: none; cursor: pointer; font-size: 1rem;
}
.routing-test {
  margin-top: 1rem; padding: 1rem;
  background: var(--color-bg-secondary, #1a1a1a); border-radius: 6px;
}
.routing-test h3 { margin-top: 0; }
.routing-test-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem 1rem;
  margin-bottom: .75rem;
}
.routing-test-grid label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.routing-test-result {
  background: var(--color-bg-primary, #0f0f0f); padding: .75rem; border-radius: 4px;
  margin-top: .75rem; font-size: .8rem; overflow-x: auto;
}
.muted { opacity: .6; font-style: italic; font-size: .85rem; }
.status-line { margin: .5rem 0; font-size: .85rem; }
.status-line.ok { color: #10b981; }
.status-line.error { color: #ef4444; }
</style>
