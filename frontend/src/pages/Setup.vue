<template>
  <div class="setup-page">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>

    <section class="setup-shell">
      <header class="hero">
        <p class="eyebrow">Primeira configuração</p>
        <h1>Conecte o MathAI ao seu ambiente</h1>
        <p class="subtitle">
          Defina OpenAI e escolha o modo de operação: banco de dados ou API (Swagger).
        </p>
      </header>

      <div class="panel">
        <div class="section-title">Nome do ambiente</div>
        <label class="label">Identifique esta conexão</label>
        <input
          v-model="form.name"
          class="input"
          type="text"
          placeholder="Ex: Produção, DW, Staging..."
        />
      </div>

      <div class="panel">
        <div class="section-title">Modo de operação</div>
        <div class="toggle-group">
          <button
            class="toggle"
            :class="{ active: form.mode === 'database' }"
            @click="form.mode = 'database'"
          >
            Banco de Dados
          </button>
          <button
            class="toggle"
            :class="{ active: form.mode === 'api' }"
            @click="form.mode = 'api'"
          >
            API (Swagger)
          </button>
        </div>
      </div>

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

      <div v-if="form.mode === 'database'" class="panel">
        <div class="section-title">Banco</div>

        <label class="label">Tipo de banco</label>
        <div class="toggle-group">
          <button
            class="toggle"
            :class="{ active: form.dbType === 'sqlserver' }"
            @click="form.dbType = 'sqlserver'; form.dbPort = 1433"
          >
            SQL Server
          </button>
          <button
            class="toggle"
            :class="{ active: form.dbType === 'oracle' }"
            @click="form.dbType = 'oracle'; form.dbPort = 1521"
          >
            Oracle
          </button>
          <button
            class="toggle"
            :class="{ active: form.dbType === 'mysql' }"
            @click="form.dbType = 'mysql'; form.dbPort = 3306"
          >
            MySQL
          </button>
          <button
            class="toggle"
            :class="{ active: form.dbType === 'postgresql' }"
            @click="form.dbType = 'postgresql'; form.dbPort = 5432"
          >
            PostgreSQL
          </button>
        </div>

        <label class="label">Idioma do banco (schema)</label>
        <select v-model="schemaLanguage" class="input">
          <option value="pt">Português</option>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>

        <label class="label">Qtd. de tabelas de referência</label>
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
            <label class="label">{{ form.dbType === 'oracle' ? 'Service Name' : 'Database (nome)' }}</label>
            <input v-model="form.dbName" class="input" type="text" />
          </div>
          <div>
            <label class="label">Usuário</label>
            <input v-model="form.dbUser" class="input" type="text" />
          </div>
          <div class="full">
            <label class="label">Senha</label>
            <input v-model="form.dbPassword" class="input" type="password" />
          </div>
        </div>

        <div class="actions-inline">
          <button class="btn btn-secondary" :disabled="testingDb" @click="onTestDb">
            {{ testingDb ? 'Testando...' : 'Testar Conexão' }}
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

      <div v-if="form.mode === 'api'" class="panel">
        <div class="section-title">API (Swagger)</div>

        <label class="label">Base URL da API</label>
        <input
          v-model="form.apiBaseUrl"
          class="input"
          type="text"
          placeholder="https://api.exemplo.com"
        />

        <label class="label">Autenticação</label>
        <div class="toggle-group">
          <button
            class="toggle"
            :class="{ active: form.apiAuthType === 'none' }"
            @click="form.apiAuthType = 'none'"
          >
            Nenhuma
          </button>
          <button
            class="toggle"
            :class="{ active: form.apiAuthType === 'bearer' }"
            @click="form.apiAuthType = 'bearer'"
          >
            Bearer
          </button>
          <button
            class="toggle"
            :class="{ active: form.apiAuthType === 'apikey' }"
            @click="form.apiAuthType = 'apikey'"
          >
            API Key
          </button>
          <button
            class="toggle"
            :class="{ active: form.apiAuthType === 'basic' }"
            @click="form.apiAuthType = 'basic'"
          >
            Basic
          </button>
        </div>

        <div v-if="form.apiAuthType === 'bearer'" class="grid">
          <div class="full">
            <label class="label">Token</label>
            <input v-model="form.apiAuthToken" class="input" type="password" placeholder="Token Bearer" />
          </div>
        </div>

        <div v-if="form.apiAuthType === 'apikey'" class="grid">
          <div>
            <label class="label">Header name</label>
            <input v-model="form.apiAuthApiKeyHeader" class="input" type="text" placeholder="X-API-Key" />
          </div>
          <div>
            <label class="label">Valor da chave</label>
            <input v-model="form.apiAuthApiKeyValue" class="input" type="password" placeholder="Valor" />
          </div>
        </div>

        <div v-if="form.apiAuthType === 'basic'" class="grid">
          <div>
            <label class="label">Usuário</label>
            <input v-model="form.apiAuthUsername" class="input" type="text" />
          </div>
          <div>
            <label class="label">Senha</label>
            <input v-model="form.apiAuthPassword" class="input" type="password" />
          </div>
        </div>

        <label class="label">Swagger / OpenAPI URL</label>
        <input
          v-model="form.swaggerUrl"
          class="input"
          type="text"
          placeholder="https://api.exemplo.com/swagger.json"
        />

        <label class="label">Ou cole o conteúdo do Swagger (JSON/YAML)</label>
        <textarea
          v-model="form.swaggerContent"
          class="input swagger-textarea"
          rows="5"
          placeholder="Cole aqui o JSON ou YAML do OpenAPI..."
        ></textarea>

        <label class="toggle-line">
          <input v-model="form.apiReadOnly" type="checkbox" />
          <span>Somente leitura (apenas GET)</span>
        </label>

        <div class="actions-inline">
          <button class="btn btn-secondary" :disabled="testingApi" @click="onTestApi">
            {{ testingApi ? 'Testando...' : 'Testar Conexão API' }}
          </button>
        </div>
      </div>

      <footer class="footer">
        <button class="btn btn-primary" :disabled="saving" @click="onSave">
          {{ saving ? 'Salvando...' : 'Salvar e Começar' }}
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
import type { AppMode, ApiAuthType, DbType } from '../types'

const router = useRouter()

const form = reactive({
  name: '',
  openAiApiKey: '',
  mode: 'database' as AppMode,
  dbType: 'sqlserver' as DbType,
  dbHost: 'localhost',
  dbPort: 1433,
  dbName: '',
  dbUser: '',
  dbPassword: '',
  apiBaseUrl: '',
  apiAuthType: 'none' as ApiAuthType,
  apiAuthToken: '',
  apiAuthApiKeyHeader: '',
  apiAuthApiKeyValue: '',
  apiAuthUsername: '',
  apiAuthPassword: '',
  swaggerUrl: '',
  swaggerContent: '',
  apiReadOnly: true
})

const schemaLanguage = ref<'pt' | 'en' | 'es'>('pt')
const tableReferenceCount = ref(8)
const testingOpenAi = ref(false)
const testingDb = ref(false)
const testingApi = ref(false)
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
      mode: 'database',
      dbType: form.dbType,
      dbHost: form.dbHost.trim(),
      dbPort: Number(form.dbPort),
      dbName: form.dbName.trim(),
      dbUser: form.dbUser.trim(),
      dbPassword: form.dbPassword
    })
    setMessage('Conexão com banco validada com sucesso.', 'ok')
  } catch (error) {
    setMessage(mapDbError(error), 'error')
  } finally {
    testingDb.value = false
  }
}

const onTestApi = async () => {
  if (!form.apiBaseUrl.trim()) {
    setMessage('Informe a Base URL da API.', 'error')
    return
  }

  testingApi.value = true
  try {
    await api.testApiConnection({
      apiBaseUrl: form.apiBaseUrl.trim(),
      apiAuthType: form.apiAuthType,
      apiAuthToken: form.apiAuthToken || undefined,
      apiAuthApiKeyHeader: form.apiAuthApiKeyHeader || undefined,
      apiAuthApiKeyValue: form.apiAuthApiKeyValue || undefined,
      apiAuthUsername: form.apiAuthUsername || undefined,
      apiAuthPassword: form.apiAuthPassword || undefined
    })
    setMessage('Conexão com API validada com sucesso.', 'ok')
  } catch (error) {
    setMessage((error as Error).message || 'Erro ao conectar na API.', 'error')
  } finally {
    testingApi.value = false
  }
}

const onSave = async () => {
  const envName = form.name.trim() || 'Default'
  saving.value = true
  try {
    if (form.mode === 'database') {
      const safeTableCount = Math.min(30, Math.max(1, Number(tableReferenceCount.value) || 8))
      tableReferenceCount.value = safeTableCount

      const created = await api.createEnvironment({
        name: envName,
        openAiApiKey: form.openAiApiKey.trim(),
        mode: 'database',
        dbType: form.dbType,
        dbHost: form.dbHost.trim(),
        dbPort: Number(form.dbPort),
        dbName: form.dbName.trim(),
        dbUser: form.dbUser.trim(),
        dbPassword: form.dbPassword
      })

      await api.setSchemaLanguage(schemaLanguage.value)
      await api.setTableReferenceCount(safeTableCount)
      setMessage('Ambiente criado. Indexando schema...', 'ok')
      await api.ingestSchemaForEnv(created.environmentId)
    } else {
      if (!form.apiBaseUrl.trim()) {
        setMessage('Informe a Base URL da API.', 'error')
        saving.value = false
        return
      }
      if (!form.swaggerUrl.trim() && !form.swaggerContent.trim()) {
        setMessage('Informe a URL do Swagger ou cole o conteúdo.', 'error')
        saving.value = false
        return
      }

      await api.createEnvironment({
        name: envName,
        openAiApiKey: form.openAiApiKey.trim(),
        mode: 'api',
        apiBaseUrl: form.apiBaseUrl.trim(),
        apiAuthType: form.apiAuthType,
        apiAuthToken: form.apiAuthToken || undefined,
        apiAuthApiKeyHeader: form.apiAuthApiKeyHeader || undefined,
        apiAuthApiKeyValue: form.apiAuthApiKeyValue || undefined,
        apiAuthUsername: form.apiAuthUsername || undefined,
        apiAuthPassword: form.apiAuthPassword || undefined,
        apiReadOnly: form.apiReadOnly,
        swaggerUrl: form.swaggerUrl.trim() || undefined,
        swaggerContent: form.swaggerContent.trim() || undefined
      })
      setMessage('Ambiente criado. Indexando endpoints...', 'ok')
      await api.ingestSwagger({
        url: form.swaggerUrl.trim() || undefined,
        content: form.swaggerContent.trim() || undefined
      })
    }
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
  opacity: 0.28;
  pointer-events: none;
}

.glow-a {
  width: 500px;
  height: 500px;
  background: #10b981;
  top: -120px;
  right: -120px;
}

.glow-b {
  width: 400px;
  height: 400px;
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
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 1.25rem;
  box-shadow: var(--shadow-md);
  transition: border-color 0.25s ease;
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
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-cyan));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  margin-top: 0.5rem;
  color: var(--color-gray-400);
}

.panel {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 1.25rem;
  box-shadow: var(--shadow-md);
  transition: border-color 0.25s ease;
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
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-gray-100);
  border-radius: 10px;
  padding: 0.68rem 0.75rem;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18), var(--glow-accent);
}

.toggle-group {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.toggle {
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  color: var(--color-gray-300);
  border-radius: 10px;
  padding: 0.5rem 0.85rem;
  cursor: pointer;
  transition: border-color 0.25s ease, background 0.25s ease, box-shadow 0.25s ease;
}

.toggle:hover {
  border-color: var(--glass-border-hover);
}

.toggle.active {
  color: #fff;
  border-color: var(--color-accent);
  background: rgba(16, 185, 129, 0.15);
  box-shadow: var(--glow-accent);
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

.footer .btn-primary {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-light));
  box-shadow: var(--glow-accent);
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}

.footer .btn-primary:hover:not(:disabled) {
  box-shadow: var(--glow-accent-strong);
}

.message {
  margin-top: 0.15rem;
}

.message.ok {
  color: var(--color-accent-light);
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.message.error {
  color: #fb7185;
  background: rgba(251, 113, 133, 0.08);
  border: 1px solid rgba(251, 113, 133, 0.2);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.oracle-hint {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
  color: #fcd34d;
  background: rgba(234, 179, 8, 0.08);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 0.75rem;
  transition: border-color 0.25s ease;
}

.oracle-hint code {
  color: #fde68a;
}

.swagger-textarea {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.85rem;
  resize: vertical;
  min-height: 80px;
}

.toggle-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
  color: var(--color-gray-300);
  font-size: 0.9rem;
  cursor: pointer;
}

.toggle-line input[type='checkbox'] {
  width: auto;
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
