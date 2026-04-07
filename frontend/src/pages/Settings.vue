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
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
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

onMounted(() => {
  void loadAgentsConfig()
  void loadAuthStatus()
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

.auth-section {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1.25rem;
  transition: border-color 0.25s ease;
}

.auth-toggle-row {
  margin-top: 0.5rem;
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
</style>
