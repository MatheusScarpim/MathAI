<template>
  <div class="env-page">
    <header class="page-header">
      <div>
        <h1>Ambientes</h1>
        <p>Gerencie conexões independentes a bancos de dados diferentes.</p>
      </div>
      <button class="btn-primary" @click="openNew">+ Novo ambiente</button>
    </header>

    <p v-if="message" class="message" :class="messageType">{{ message }}</p>

    <div v-if="loading" class="loading">Carregando ambientes...</div>

    <div v-else-if="!envs.length" class="empty">
      Nenhum ambiente configurado. Crie o primeiro acima.
    </div>

    <div v-else class="env-grid">
      <article
        v-for="env in envs"
        :key="env.environmentId"
        class="env-card"
        :class="{ selected: env.environmentId === currentEnvId }"
      >
        <div class="env-card-header">
          <h3>{{ env.name }}</h3>
          <span class="badge">{{ env.mode === 'api' ? 'API' : (env.dbType ?? 'database').toUpperCase() }}</span>
        </div>

        <div class="env-id" @click="copyId(env.environmentId)" title="Clique para copiar">
          <code>{{ env.environmentId }}</code>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </div>

        <div class="env-details">
          <template v-if="env.mode === 'api'">
            <span>{{ env.apiBaseUrl ?? '-' }}</span>
          </template>
          <template v-else>
            <span>{{ env.dbHost ?? '-' }}:{{ env.dbPort ?? '-' }}</span>
            <span>{{ env.dbName ?? '-' }}</span>
          </template>
        </div>

        <div class="env-actions">
          <button class="btn-sm btn-ghost" @click="onSelect(env)">Selecionar</button>
          <button class="btn-sm btn-ghost" @click="onTestDb(env)">Testar</button>
          <button class="btn-sm btn-ghost" @click="openEdit(env)">Editar</button>
          <button class="btn-sm btn-danger-ghost" @click="onDelete(env)">Excluir</button>
        </div>
      </article>
    </div>

    <!-- Modal de criacao/edicao -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-overlay" @click.self="showModal = false">
        <div class="modal">
          <h2>{{ editing ? 'Editar ambiente' : 'Novo ambiente' }}</h2>

          <label class="field">
            Nome
            <input v-model="form.name" type="text" placeholder="Producao, DW, Staging..." />
          </label>

          <label class="field">
            OpenAI API Key
            <input v-model="form.openAiApiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </label>

          <div class="field">
            <span>Modo</span>
            <div class="toggle-group">
              <button class="toggle" :class="{ active: form.mode === 'database' }" @click="form.mode = 'database'">Banco</button>
              <button class="toggle" :class="{ active: form.mode === 'api' }" @click="form.mode = 'api'">API</button>
            </div>
          </div>

          <template v-if="form.mode === 'database'">
            <div class="field">
              <span>Tipo</span>
              <div class="toggle-group">
                <button class="toggle" :class="{ active: form.dbType === 'sqlserver' }" @click="form.dbType = 'sqlserver'; form.dbPort = 1433">SQL Server</button>
                <button class="toggle" :class="{ active: form.dbType === 'oracle' }" @click="form.dbType = 'oracle'; form.dbPort = 1521">Oracle</button>
                <button class="toggle" :class="{ active: form.dbType === 'mysql' }" @click="form.dbType = 'mysql'; form.dbPort = 3306">MySQL</button>
                <button class="toggle" :class="{ active: form.dbType === 'postgresql' }" @click="form.dbType = 'postgresql'; form.dbPort = 5432">PostgreSQL</button>
              </div>
            </div>

            <div class="field-row">
              <label class="field flex-grow">
                Host
                <input v-model="form.dbHost" type="text" placeholder="localhost" />
              </label>
              <label class="field" style="max-width:100px">
                Porta
                <input v-model.number="form.dbPort" type="number" />
              </label>
            </div>

            <label class="field">
              Database / Service Name
              <input v-model="form.dbName" type="text" placeholder="meu_banco" />
            </label>

            <div class="field-row">
              <label class="field flex-grow">
                Usuário
                <input v-model="form.dbUser" type="text" placeholder="sa" />
              </label>
              <label class="field flex-grow">
                Senha
                <input v-model="form.dbPassword" type="password" autocomplete="off" />
              </label>
            </div>
          </template>

          <template v-if="form.mode === 'api'">
            <label class="field">
              URL base da API
              <input v-model="form.apiBaseUrl" type="text" placeholder="https://api.exemplo.com" />
            </label>
          </template>

          <p v-if="formMessage" class="message" :class="formMessageType">{{ formMessage }}</p>

          <div class="modal-actions">
            <button class="btn-secondary" @click="showModal = false">Cancelar</button>
            <button class="btn-primary" :disabled="saving" @click="onSave">
              {{ saving ? 'Salvando...' : (editing ? 'Salvar' : 'Criar') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, type Ref } from 'vue'
import { api } from '../services/api'
import type { EnvironmentView, EnvironmentSummary } from '../types'

const selectedEnvironmentId = inject<Ref<string | undefined>>('selectedEnvironmentId')
const globalEnvironments = inject<Ref<EnvironmentSummary[]>>('environments')
const currentEnvId = computed(() => selectedEnvironmentId?.value)

const envs = ref<EnvironmentView[]>([])
const loading = ref(true)
const message = ref('')
const messageType = ref<'ok' | 'error'>('ok')

const showModal = ref(false)
const editing = ref<string | null>(null)
const saving = ref(false)
const formMessage = ref('')
const formMessageType = ref<'ok' | 'error'>('ok')

const defaultForm = () => ({
  name: '',
  openAiApiKey: '',
  mode: 'database' as 'database' | 'api',
  dbType: 'sqlserver' as 'sqlserver' | 'oracle' | 'mysql' | 'postgresql',
  dbHost: '',
  dbPort: 1433,
  dbName: '',
  dbUser: '',
  dbPassword: '',
  apiBaseUrl: ''
})

const form = ref(defaultForm())

async function loadEnvs() {
  loading.value = true
  message.value = ''
  try {
    const res = await api.listEnvironments()
    envs.value = res.environments
  } catch (e: any) {
    messageType.value = 'error'
    message.value = e.message || 'Erro ao carregar ambientes.'
  } finally {
    loading.value = false
  }
}

function openNew() {
  editing.value = null
  form.value = defaultForm()
  formMessage.value = ''
  showModal.value = true
}

function openEdit(env: EnvironmentView) {
  editing.value = env.environmentId
  form.value = {
    name: env.name,
    openAiApiKey: '',
    mode: env.mode,
    dbType: (env.dbType ?? 'sqlserver') as any,
    dbHost: env.dbHost ?? '',
    dbPort: env.dbPort ?? 1433,
    dbName: env.dbName ?? '',
    dbUser: env.dbUser ?? '',
    dbPassword: '',
    apiBaseUrl: env.apiBaseUrl ?? ''
  }
  formMessage.value = ''
  showModal.value = true
}

async function onSave() {
  if (!form.value.name.trim()) {
    formMessage.value = 'Nome obrigatório.'
    formMessageType.value = 'error'
    return
  }

  saving.value = true
  formMessage.value = ''

  try {
    const payload: Record<string, unknown> = { ...form.value }
    // Remove empty openAiApiKey on edit to keep existing
    if (editing.value && !payload.openAiApiKey) {
      delete payload.openAiApiKey
    }

    if (editing.value) {
      await api.updateEnvironment(editing.value, payload)
    } else {
      if (!form.value.openAiApiKey.trim()) {
        formMessage.value = 'OpenAI API Key obrigatória para novo ambiente.'
        formMessageType.value = 'error'
        saving.value = false
        return
      }
      await api.createEnvironment(payload)
    }

    showModal.value = false
    await loadEnvs()
    syncGlobal()
    messageType.value = 'ok'
    message.value = editing.value ? 'Ambiente atualizado.' : 'Ambiente criado com sucesso.'
  } catch (e: any) {
    formMessageType.value = 'error'
    formMessage.value = e.message || 'Erro ao salvar ambiente.'
  } finally {
    saving.value = false
  }
}

async function copyId(id: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(id)
    } else {
      const ta = document.createElement('textarea')
      ta.value = id
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    messageType.value = 'ok'
    message.value = `ID copiado: ${id}`
  } catch {
    messageType.value = 'error'
    message.value = 'Falha ao copiar. Selecione manualmente.'
  }
}

function onSelect(env: EnvironmentView) {
  if (selectedEnvironmentId) {
    selectedEnvironmentId.value = env.environmentId
  }
  messageType.value = 'ok'
  message.value = `Ambiente "${env.name}" selecionado.`
}

async function onTestDb(env: EnvironmentView) {
  message.value = 'Testando conexão...'
  messageType.value = 'ok'
  try {
    const res = await api.testEnvironmentDb(env.environmentId)
    if (res.ok) {
      messageType.value = 'ok'
      message.value = `Conexão com "${env.name}" OK!`
    } else {
      messageType.value = 'error'
      message.value = `Falha: ${res.error ?? 'Erro desconhecido'}`
    }
  } catch (e: any) {
    messageType.value = 'error'
    message.value = e.message || 'Erro ao testar conexão.'
  }
}

async function onDelete(env: EnvironmentView) {
  if (!confirm(`Excluir o ambiente "${env.name}"? Schema e cache desse ambiente serão apagados.`)) return

  try {
    await api.deleteEnvironment(env.environmentId)
    if (selectedEnvironmentId?.value === env.environmentId) {
      selectedEnvironmentId.value = undefined
    }
    await loadEnvs()
    syncGlobal()
    messageType.value = 'ok'
    message.value = `Ambiente "${env.name}" excluído.`
  } catch (e: any) {
    messageType.value = 'error'
    message.value = e.message || 'Erro ao excluir ambiente.'
  }
}

function syncGlobal() {
  if (globalEnvironments) {
    globalEnvironments.value = envs.value.map(e => ({
      environmentId: e.environmentId,
      name: e.name
    }))
  }
  if (envs.value.length && !selectedEnvironmentId?.value) {
    if (selectedEnvironmentId) {
      selectedEnvironmentId.value = envs.value[0]!.environmentId
    }
  }
}

onMounted(loadEnvs)
</script>

<style scoped>
.env-page {
  padding: 2rem;
  max-width: 980px;
  margin: 0 auto;
  display: grid;
  gap: 1.5rem;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
  background: linear-gradient(135deg, #f9fafb, #d1d5db);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.page-header p {
  color: var(--color-gray-500);
}

.loading, .empty {
  color: var(--color-gray-400);
  text-align: center;
  padding: 2rem 0;
}

.env-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.env-card {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1.25rem;
  display: grid;
  gap: 0.75rem;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.env-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-sm);
}

.env-card.selected {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.env-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.env-card-header h3 {
  margin: 0;
  font-size: 1.1rem;
}

.badge {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  padding: 0.2rem 0.55rem;
  border-radius: 6px;
  color: var(--color-gray-400);
}

.env-id {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  padding: 0.3rem 0.5rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  width: fit-content;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.env-id:hover {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.env-id code {
  font-size: 0.75rem;
  color: var(--color-gray-400);
  user-select: all;
}

.env-id svg {
  color: var(--color-gray-500);
  flex-shrink: 0;
}

.env-details {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.88rem;
  color: var(--color-gray-400);
}

.env-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn-sm {
  font-size: 0.82rem;
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.25s ease;
}

.btn-ghost {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  color: var(--color-gray-300);
}

.btn-ghost:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--glass-border-hover);
}

.btn-danger-ghost {
  background: rgba(220, 38, 38, 0.1);
  color: #fca5a5;
  border: 1px solid rgba(220, 38, 38, 0.15);
  transition: all 0.25s ease;
}

.btn-danger-ghost:hover {
  background: rgba(220, 38, 38, 0.2);
  box-shadow: 0 0 16px rgba(220, 38, 38, 0.15);
  border-color: rgba(220, 38, 38, 0.3);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  padding: 1.75rem;
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  overflow-y: auto;
  display: grid;
  gap: 1rem;
}

.modal h2 {
  margin: 0;
}

.field {
  display: grid;
  gap: 0.35rem;
  color: var(--color-gray-300);
  font-size: 0.92rem;
}

.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-100);
  transition: border-color 0.25s ease;
}

.field input:focus {
  border-color: var(--glass-border-hover);
  outline: none;
}

.field-row {
  display: flex;
  gap: 0.75rem;
}

.flex-grow {
  flex: 1;
}

.toggle-group {
  display: flex;
  gap: 0.25rem;
}

.toggle {
  padding: 0.45rem 0.85rem;
  border-radius: 6px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  color: var(--color-gray-400);
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.25s ease;
}

.toggle:hover {
  border-color: var(--glass-border-hover);
}

.toggle.active {
  background: rgba(16, 185, 129, 0.15);
  border-color: var(--color-accent);
  color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.btn-primary,
.btn-secondary {
  border: none;
  border-radius: 8px;
  padding: 0.65rem 1.1rem;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.25s ease;
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-dark, #059669));
  color: #fff;
  box-shadow: var(--glow-accent);
}

.btn-primary:hover {
  box-shadow: 0 0 28px rgba(16, 185, 129, 0.25);
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
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

.message {
  font-size: 0.9rem;
  padding: 0.6rem 0.85rem;
  border-radius: 8px;
  transition: all 0.25s ease;
}

.message.ok {
  color: var(--color-accent-light);
  background: rgba(16, 185, 129, 0.06);
  border: 1px solid rgba(16, 185, 129, 0.12);
}

.message.error {
  color: #fda4af;
  background: rgba(220, 38, 38, 0.06);
  border: 1px solid rgba(220, 38, 38, 0.12);
}

@media (max-width: 640px) {
  .env-page {
    padding: 1rem;
  }

  .page-header {
    flex-direction: column;
  }

  .env-grid {
    grid-template-columns: 1fr;
  }

  .field-row {
    flex-direction: column;
  }
}
</style>
