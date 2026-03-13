<template>
  <div class="settings-page">
    <header class="page-header">
      <h1>Configuracoes</h1>
      <p>Gerencie os agentes de IA e redefina o ambiente quando precisar recomecar do zero.</p>
    </header>

    <section class="agents-section">
      <div class="section-title-row">
        <h2>Configuracao de Agentes</h2>
        <button class="btn-secondary" :disabled="loadingAgents" @click="loadAgentsConfig">
          Recarregar
        </button>
      </div>

      <p class="section-description">Ajuste modelos e parametros usados por cada agente.</p>

      <p v-if="agentsMessage" class="message" :class="agentsMessageType">{{ agentsMessage }}</p>

      <div v-if="loadingAgents" class="loading">Carregando configuracoes dos agentes...</div>

      <template v-else-if="agentsConfig">
        <div class="agents-grid">
          <article class="agent-card">
            <h3>SQL</h3>
            <p>Gera consultas SQL e faz retries quando necessario.</p>

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
                placeholder="vazio = padrao do modelo"
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
                placeholder="vazio = padrao do modelo"
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
            <h3>Traducao</h3>
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
            <h3>Grafico</h3>
            <p>Infere visualizacao de dados para resposta tabular.</p>

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
            <p>Decomp&#245;e perguntas complexas em sub-consultas independentes.</p>

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
            <p>Gera embeddings para busca semantica de contexto e schema.</p>

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
            {{ savingAgents ? 'Salvando...' : 'Salvar configuracoes de agentes' }}
          </button>
        </div>
      </template>
    </section>

    <section class="danger-zone">
      <h2>Zona de risco</h2>
      <p>
        Esta acao remove configuracao, historico, instrucoes, configuracoes e schema indexado.
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
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import type { AgentsConfig } from '../types'

const router = useRouter()

const loadingAgents = ref(true)
const savingAgents = ref(false)
const agentsConfig = ref<AgentsConfig | null>(null)
const sqlTemperatureInput = ref('')
const agentsMessage = ref('')
const agentsMessageType = ref<'ok' | 'error'>('ok')

const confirmText = ref('')
const resetting = ref(false)
const resetMessage = ref('')
const resetMessageType = ref<'ok' | 'error'>('ok')

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
    agentsMessage.value = (error as Error).message || 'Erro ao carregar configuracoes de agentes.'
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
    agentsMessage.value = 'Configuracoes de agentes salvas com sucesso.'
  } catch (error) {
    agentsMessageType.value = 'error'
    agentsMessage.value = (error as Error).message || 'Erro ao salvar configuracoes de agentes.'
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

onMounted(() => {
  void loadAgentsConfig()
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
}

.page-header p {
  color: var(--color-gray-500);
}

.agents-section {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1.25rem;
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
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.01);
  display: grid;
  gap: 0.75rem;
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
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--color-gray-100);
}

.toggle-line {
  display: flex !important;
  align-items: center;
  gap: 0.5rem;
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
}

.btn-primary {
  background: var(--color-accent);
  color: #fff;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-gray-100);
}

.btn-danger {
  background: #dc2626;
  color: #fff;
}

.btn-primary:disabled,
.btn-secondary:disabled,
.btn-danger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.danger-zone {
  background: rgba(127, 29, 29, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 12px;
  padding: 1.25rem;
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
}

.message.ok {
  color: var(--color-accent-light);
}

.message.error {
  color: #fda4af;
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
</style>
