<template>
  <div class="setup-page">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>

    <section class="setup-shell">
      <header class="hero">
        <p class="eyebrow">Primeira configuracao</p>
        <h1>Conecte o MathAI ao seu ambiente</h1>
        <p class="subtitle">
          Defina OpenAI, banco de dados e idioma do schema para o parser gerar SQL correto.
        </p>
      </header>

      <div class="panel">
        <div class="section-title">OpenAI</div>
        <label class="label">API Key</label>
        <input
          v-model="form.openAiApiKey"
          class="input"
          type="password"
          placeholder="sk-..."
          autocomplete="off"
        />
        <div class="actions-inline">
          <button class="btn btn-secondary" :disabled="testingOpenAi" @click="onTestOpenAi">
            {{ testingOpenAi ? 'Testando...' : 'Testar OpenAI' }}
          </button>
        </div>
      </div>

      <div class="panel">
        <div class="section-title">Banco</div>

        <label class="label">Tipo de banco</label>
        <div class="toggle-group">
          <button
            class="toggle"
            :class="{ active: form.dbType === 'sqlserver' }"
            @click="form.dbType = 'sqlserver'"
          >
            SQL Server
          </button>
          <button
            class="toggle"
            :class="{ active: form.dbType === 'oracle' }"
            @click="form.dbType = 'oracle'"
          >
            Oracle
          </button>
        </div>

        <label class="label">Idioma do banco (schema)</label>
        <select v-model="schemaLanguage" class="input">
          <option value="pt">Portugues</option>
          <option value="en">English</option>
          <option value="es">Espanol</option>
        </select>

        <label class="label">Qtd. de tabelas de referencia</label>
        <input
          v-model.number="tableReferenceCount"
          class="input"
          type="number"
          min="1"
          max="30"
        />

        <div class="grid">
          <div>
            <label class="label">Host</label>
            <input v-model="form.dbHost" class="input" type="text" placeholder="localhost" />
          </div>
          <div>
            <label class="label">Porta</label>
            <input v-model.number="form.dbPort" class="input" type="number" min="1" />
          </div>
          <div>
            <label class="label">{{ form.dbType === 'oracle' ? 'Service Name' : 'Database' }}</label>
            <input v-model="form.dbName" class="input" type="text" />
          </div>
          <div>
            <label class="label">Usuario</label>
            <input v-model="form.dbUser" class="input" type="text" />
          </div>
          <div class="full">
            <label class="label">Senha</label>
            <input v-model="form.dbPassword" class="input" type="password" />
          </div>
        </div>

        <div class="actions-inline">
          <button class="btn btn-secondary" :disabled="testingDb" @click="onTestDb">
            {{ testingDb ? 'Testando...' : 'Testar Conexao' }}
          </button>
        </div>

        <div v-if="form.dbType === 'oracle'" class="oracle-hint">
          <strong>Oracle com NNE/Data Integrity:</strong>
          <span>
            Se aparecer <code>NJS-533</code> ou <code>ORA-12660</code>, configure
            <code>ORACLE_DRIVER_MODE=thick</code> e <code>ORACLE_CLIENT_LIB_DIR</code>
            no ambiente da API.
          </span>
        </div>
      </div>

      <footer class="footer">
        <button class="btn btn-primary" :disabled="saving" @click="onSave">
          {{ saving ? 'Salvando...' : 'Salvar e Comecar' }}
        </button>
        <p v-if="message" class="message" :class="messageType">{{ message }}</p>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import type { DbType } from '../types'

const router = useRouter()

const form = reactive({
  openAiApiKey: '',
  dbType: 'sqlserver' as DbType,
  dbHost: 'localhost',
  dbPort: 1433,
  dbName: '',
  dbUser: '',
  dbPassword: ''
})

const schemaLanguage = ref<'pt' | 'en' | 'es'>('pt')
const tableReferenceCount = ref(8)
const testingOpenAi = ref(false)
const testingDb = ref(false)
const saving = ref(false)
const message = ref('')
const messageType = ref<'ok' | 'error'>('ok')

const setMessage = (text: string, type: 'ok' | 'error') => {
  message.value = text
  messageType.value = type
}

const mapDbError = (error: unknown): string => {
  const raw = (error as Error)?.message ?? ''
  const normalized = raw.toLowerCase()
  const isNneError =
    normalized.includes('njs-533') ||
    normalized.includes('ora-12660') ||
    normalized.includes('native network encryption')

  if (isNneError) {
    return 'Oracle exige Native Network Encryption/Data Integrity. Configure ORACLE_DRIVER_MODE=thick e ORACLE_CLIENT_LIB_DIR na API.'
  }

  return raw || 'Erro ao conectar no banco.'
}

onMounted(async () => {
  try {
    const { schemaLanguage: currentLanguage } = await api.getSchemaLanguage()
    schemaLanguage.value = currentLanguage
  } catch {
    schemaLanguage.value = 'pt'
  }

  try {
    const { tableReferenceCount: currentCount } = await api.getTableReferenceCount()
    tableReferenceCount.value = currentCount
  } catch {
    tableReferenceCount.value = 8
  }
})

const onTestOpenAi = async () => {
  if (!form.openAiApiKey.trim()) {
    setMessage('Informe a OpenAI API key.', 'error')
    return
  }

  testingOpenAi.value = true
  try {
    await api.testOpenAi(form.openAiApiKey.trim())
    setMessage('OpenAI validada com sucesso.', 'ok')
  } catch (error) {
    setMessage(mapDbError(error), 'error')
  } finally {
    testingOpenAi.value = false
  }
}

const onTestDb = async () => {
  testingDb.value = true
  try {
    await api.testDbConfig({
      dbType: form.dbType,
      dbHost: form.dbHost.trim(),
      dbPort: Number(form.dbPort),
      dbName: form.dbName.trim(),
      dbUser: form.dbUser.trim(),
      dbPassword: form.dbPassword
    })
    setMessage('Conexao com banco validada com sucesso.', 'ok')
  } catch (error) {
    setMessage(mapDbError(error), 'error')
  } finally {
    testingDb.value = false
  }
}

const onSave = async () => {
  saving.value = true
  try {
    const safeTableCount = Math.min(30, Math.max(1, Number(tableReferenceCount.value) || 8))
    tableReferenceCount.value = safeTableCount
    await api.saveConfig({
      openAiApiKey: form.openAiApiKey.trim(),
      dbType: form.dbType,
      dbHost: form.dbHost.trim(),
      dbPort: Number(form.dbPort),
      dbName: form.dbName.trim(),
      dbUser: form.dbUser.trim(),
      dbPassword: form.dbPassword
    })
    await api.setSchemaLanguage(schemaLanguage.value)
    await api.setTableReferenceCount(safeTableCount)
    setMessage('Configuracao salva. Indexando schema...', 'ok')
    await api.ingestSchema()
    await router.push('/chat')
  } catch (error) {
    setMessage((error as Error).message, 'error')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.setup-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  overflow: hidden;
}

.glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(80px);
  opacity: 0.22;
  pointer-events: none;
}

.glow-a {
  width: 380px;
  height: 380px;
  background: #10b981;
  top: -120px;
  right: -120px;
}

.glow-b {
  width: 300px;
  height: 300px;
  background: #22d3ee;
  bottom: -120px;
  left: -120px;
}

.setup-shell {
  position: relative;
  z-index: 1;
  width: min(860px, 100%);
  display: grid;
  gap: 1rem;
}

.hero {
  background: rgba(9, 15, 22, 0.72);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 1.25rem;
}

.eyebrow {
  color: var(--color-accent-light);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero h1 {
  margin-top: 0.35rem;
  font-size: clamp(1.5rem, 2vw, 2rem);
}

.subtitle {
  margin-top: 0.5rem;
  color: var(--color-gray-400);
}

.panel {
  background: rgba(9, 15, 22, 0.72);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 1.25rem;
}

.section-title {
  font-family: var(--font-display);
  color: var(--color-gray-100);
  margin-bottom: 0.75rem;
}

.label {
  display: block;
  margin-bottom: 0.35rem;
  margin-top: 0.75rem;
  color: var(--color-gray-300);
  font-size: 0.9rem;
}

.input {
  width: 100%;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-gray-100);
  border-radius: 10px;
  padding: 0.68rem 0.75rem;
}

.input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
}

.toggle-group {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.toggle {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--color-gray-300);
  border-radius: 10px;
  padding: 0.5rem 0.85rem;
  cursor: pointer;
}

.toggle.active {
  color: #fff;
  border-color: var(--color-accent);
  background: rgba(16, 185, 129, 0.15);
}

.grid {
  margin-top: 0.3rem;
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.full {
  grid-column: 1 / -1;
}

.actions-inline {
  margin-top: 0.9rem;
}

.footer {
  display: grid;
  gap: 0.75rem;
  justify-items: end;
}

.message {
  margin-top: 0.15rem;
}

.message.ok {
  color: var(--color-accent-light);
}

.message.error {
  color: #fb7185;
}

.oracle-hint {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
  color: #fcd34d;
  background: rgba(234, 179, 8, 0.08);
  border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: 10px;
  padding: 0.75rem;
}

.oracle-hint code {
  color: #fde68a;
}

@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .footer {
    justify-items: stretch;
  }
}
</style>
