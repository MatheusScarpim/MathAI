<template>
  <div class="task-detail">
    <!-- Loading state -->
    <div v-if="loading && !task" class="state">
      <div class="spinner"></div>
      <p>Carregando tarefa...</p>
    </div>

    <!-- Error / not found -->
    <div v-else-if="!task" class="state">
      <h2>Tarefa não encontrada</h2>
      <p>A tarefa <code>{{ taskId }}</code> não existe ou foi removida.</p>
      <router-link to="/tasks" class="btn-back">← Voltar para Tarefas</router-link>
    </div>

    <!-- Loaded -->
    <template v-else>
      <!-- Breadcrumb -->
      <nav class="crumbs">
        <router-link to="/tasks" class="crumb-link">← Tarefas</router-link>
        <span v-if="projectName" class="sep">·</span>
        <span v-if="projectName" class="crumb-proj">{{ projectName }}</span>
        <span class="sep">·</span>
        <code class="crumb-id">#{{ task.id.slice(0, 7) }}</code>
      </nav>

      <!-- Hero -->
      <header class="hero" :class="task.status">
        <div class="hero-status">
          <span class="dot" :class="task.status"></span>
          <span class="status-text">{{ statusLabel(task.status) }}</span>
        </div>
        <h1 class="hero-title">{{ task.description }}</h1>
        <div class="hero-meta">
          <span v-if="total">{{ done }}/{{ total }} subtarefas</span>
          <span v-if="task.createdAt">{{ formatElapsed(task.createdAt, task.completedAt, now) }}</span>
          <span v-if="task.language">{{ task.language.toUpperCase() }}</span>
          <span v-if="repoLabel" class="repo">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            {{ repoLabel }}
          </span>
        </div>
        <div v-if="total" class="hero-progress">
          <div class="hero-bar">
            <div class="fill" :class="task.status" :style="{ width: pct + '%' }"></div>
          </div>
          <span class="hero-pct">{{ pct }}%</span>
        </div>
        <div v-if="canCancel" class="hero-actions">
          <button class="btn-danger" @click="cancel">Cancelar execução</button>
        </div>

        <!-- Preview deploy -->
        <div v-if="canPreview" class="hero-actions preview-actions">
          <button
            v-if="!preview || preview.status === 'stopped' || preview.status === 'failed'"
            class="btn-preview"
            :disabled="previewStarting"
            @click="onStartPreview"
          >
            <span v-if="previewStarting" class="spinner-sm"></span>
            🌐 {{ previewStarting ? previewStatusText : 'Testar (preview)' }}
          </button>
          <template v-else-if="preview.status === 'ready'">
            <a :href="preview.tunnelUrl" target="_blank" rel="noopener" class="btn-preview-url">
              🌐 Abrir preview ↗
            </a>
            <button class="btn-secondary" @click="onCopyPreview">📋</button>
            <button class="btn-secondary" @click="onStopPreview">Parar</button>
            <span v-if="previewExpiresIn" class="preview-ttl">expira em {{ previewExpiresIn }}</span>
          </template>
          <span v-else-if="preview.status === 'starting'" class="preview-starting">
            <span class="spinner-sm"></span>
            Subindo preview...
          </span>
        </div>
        <p v-if="preview?.status === 'failed' && preview.errorMessage" class="preview-error">
          ⚠️ {{ preview.errorMessage }}
        </p>
      </header>

      <!-- Timeline -->
      <section class="card-section">
        <h2>Timeline de execução</h2>
        <ol class="tl">
          <li v-if="task.createdAt" class="tl-item planning done">
            <span class="tl-dot done"></span>
            <div class="tl-body">
              <div class="tl-head">
                <span class="tl-time">{{ formatTimestamp(task.createdAt) }}</span>
                <span class="tl-title">Tarefa criada e plano gerado</span>
              </div>
              <div class="tl-meta">
                <span v-if="total">{{ total }} subtarefas geradas</span>
                <span v-if="task.tokenUsage?.planner" class="dim">·</span>
                <span v-if="task.tokenUsage?.planner">{{ formatNumber(task.tokenUsage.planner.totalTokens) }} tokens (planner)</span>
              </div>
            </div>
          </li>

          <li
            v-for="sub in task.subtasks ?? []"
            :key="sub.id"
            class="tl-item"
            :class="sub.status"
          >
            <span class="tl-dot" :class="sub.status">
              <span v-if="sub.status === 'completed'">✓</span>
              <span v-else-if="sub.status === 'failed' || sub.status === 'cancelled'">✕</span>
              <span v-else-if="sub.status === 'executing'" class="pulse"></span>
            </span>
            <div class="tl-body">
              <div class="tl-head">
                <span class="tl-time">{{ formatTimestamp(sub.startedAt) || '—' }}</span>
                <span class="tl-id">{{ sub.id }}</span>
                <span class="tl-type" :class="sub.type">{{ sub.type }}</span>
                <span class="tl-title">{{ sub.description }}</span>
                <span class="tl-spacer"></span>
                <span v-if="sub.startedAt && sub.completedAt" class="tl-dur">
                  {{ formatDuration(durationMs(sub)!) }}
                </span>
                <span v-else-if="sub.status === 'executing'" class="tl-running">em curso</span>
              </div>
              <div v-if="sub.status === 'failed' && sub.error" class="tl-err">
                <strong>Erro:</strong> {{ sub.error }}
                <span v-if="sub.retryCount" class="dim"> · retry {{ sub.retryCount }}/{{ sub.maxRetries ?? '?' }}</span>
              </div>
              <div v-if="(sub.status === 'failed' || sub.status === 'cancelled') && sub.type === 'github'" class="tl-retry-row">
                <button
                  class="btn-retry"
                  :disabled="retryingSubId === sub.id"
                  @click="onRetrySub(sub.id)"
                >
                  <span v-if="retryingSubId === sub.id" class="spinner-sm"></span>
                  🔁 {{ retryingSubId === sub.id ? 'Retentando...' : 'Retentar subtask' }}
                </button>
                <span class="tl-retry-help">Re-executa só essa subtask com contexto das outras; PR atualiza automaticamente.</span>
              </div>
              <div v-if="sub.result?.prUrl" class="tl-pr">
                <a :href="sub.result.prUrl" target="_blank" rel="noopener" class="pr-chip">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                  {{ shortPr(sub.result.prUrl) }} · abrir no GitHub
                </a>
              </div>
            </div>
          </li>
        </ol>
      </section>

      <!-- PRs -->
      <section v-if="prList.length" class="card-section">
        <h2>Pull Requests <span class="count">{{ prList.length }}</span></h2>
        <div class="pr-list">
          <a
            v-for="pr in prList"
            :key="pr.url"
            :href="pr.url"
            target="_blank"
            rel="noopener"
            class="pr-card"
          >
            <div class="pr-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            </div>
            <div class="pr-body">
              <div class="pr-top">
                <span class="pr-num">#{{ pr.number }}</span>
                <span class="pr-repo">{{ pr.owner }}/{{ pr.repo }}</span>
              </div>
              <div class="pr-title">{{ pr.subtaskDescription }}</div>
              <div class="pr-meta">
                <span class="pr-branch">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                  </svg>
                  {{ pr.branch }}
                </span>
                <span v-if="pr.changes != null" class="dim">·</span>
                <span v-if="pr.changes != null">{{ pr.changes }} {{ pr.changes === 1 ? 'arquivo' : 'arquivos' }}</span>
              </div>
            </div>
            <div class="pr-arrow">↗</div>
          </a>
        </div>
      </section>

      <!-- Tokens por agente -->
      <section v-if="hasTokens" class="card-section">
        <h2>Tokens por agente</h2>
        <table class="tokens-table">
          <thead>
            <tr>
              <th>Agente</th>
              <th class="num">Input</th>
              <th class="num">Output</th>
              <th class="num">Total</th>
              <th class="bar-col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tokenRows" :key="row.agent">
              <td class="t-agent">{{ row.agent }}</td>
              <td class="num">{{ formatNumber(row.in) }}</td>
              <td class="num">{{ formatNumber(row.out) }}</td>
              <td class="num t-total">{{ formatNumber(row.total) }}</td>
              <td class="bar-col">
                <div class="mini-bar"><div class="fill" :style="{ width: row.pct + '%' }"></div></div>
              </td>
            </tr>
          </tbody>
          <tfoot v-if="task.tokenUsage?.total">
            <tr>
              <th>Total</th>
              <th class="num">{{ formatNumber(task.tokenUsage.total.inputTokens) }}</th>
              <th class="num">{{ formatNumber(task.tokenUsage.total.outputTokens) }}</th>
              <th class="num">{{ formatNumber(task.tokenUsage.total.totalTokens) }}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </section>

      <!-- Saída e arquivos -->
      <section v-if="outputSubs.length" class="card-section">
        <h2>Saída e arquivos</h2>
        <details v-for="sub in outputSubs" :key="sub.id" class="sub-output">
          <summary>
            <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            <span class="o-status" :class="sub.status"></span>
            <code class="o-id">{{ sub.id }}</code>
            <span class="o-type" :class="sub.type">{{ sub.type }}</span>
            <span class="o-desc">{{ sub.description }}</span>
            <span v-if="changeCount(sub)" class="o-count">{{ changeCount(sub) }} {{ changeCount(sub) === 1 ? 'arquivo' : 'arquivos' }}</span>
          </summary>
          <div class="o-content">
            <div v-if="changeCount(sub)" class="o-changes">
              <div
                v-for="c in (sub.result?.changes ?? [])"
                :key="(c.file || '') + ':' + (c.action || '')"
                class="o-change"
              >
                <span class="o-action" :class="c.action">{{ c.action }}</span>
                <code>{{ c.file }}</code>
              </div>
            </div>
            <div v-else-if="sub.result?.message || sub.result?.result" class="o-text">
              <p v-if="sub.result.message"><strong>{{ sub.result.message }}</strong></p>
              <pre v-if="sub.result.result">{{ sub.result.result }}</pre>
            </div>
            <div v-else-if="sub.error" class="o-err">{{ sub.error }}</div>
            <div v-else class="o-empty">Sem saída registrada.</div>
          </div>
        </details>
      </section>

      <!-- Resumo -->
      <section v-if="task.summary" class="card-section">
        <h2>Resumo</h2>
        <div class="summary-content" v-html="renderMarkdown(task.summary)"></div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../services/api'
import {
  renderMarkdown,
  formatElapsed,
  formatDuration,
  formatTimestamp,
  formatNumber,
  shortPr,
  prRepoFromUrl,
  subtaskBranch,
  statusLabel
} from '../utils/taskFormat'

type Change = { file: string; action: string; content?: string }
type SubResult = {
  prUrl?: string | null
  cardUrl?: string | null
  trelloCardId?: string | null
  changes?: Change[]
  message?: string
  result?: string
} | null
type Subtask = {
  id: string
  type: string
  description: string
  status: string
  startedAt?: string
  completedAt?: string
  error?: string
  retryCount?: number
  maxRetries?: number
  result?: SubResult
}
type TokenBlock = { inputTokens: number; outputTokens: number; totalTokens: number }
type TaskView = {
  id: string
  description: string
  status: string
  subtaskCount?: number
  subtasks?: Subtask[]
  trelloCardIds?: string[]
  githubPrUrls?: string[]
  projectId?: string
  repoIds?: string[]
  summary?: string
  language?: string
  tokenUsage?: { planner?: TokenBlock; code?: TokenBlock; reviewer?: TokenBlock; reporter?: TokenBlock; total?: TokenBlock }
  createdAt?: string
  updatedAt?: string
  completedAt?: string
}
type ProjectView = {
  id: string
  name: string
  isInbox: boolean
}

const route = useRoute()
const taskId = computed(() => String(route.params.id))

const task = ref<TaskView | null>(null)
const loading = ref(true)
const projects = ref<ProjectView[]>([])
const repos = ref<Array<{ id: string; owner: string; repo: string }>>([])
const now = ref(Date.now())

let pollTimer: number | null = null
let nowTimer: number | null = null
let previewPollTimer: number | null = null

// Preview state
type PreviewView = {
  taskId: string
  tunnelUrl: string
  status: 'starting' | 'ready' | 'stopped' | 'failed'
  startedAt: string
  expiresAt: string
  errorMessage?: string
}
const preview = ref<PreviewView | null>(null)
const previewStarting = ref(false)
const previewStatusText = ref('')

// Subtask retry state
const retryingSubId = ref<string | null>(null)

const loadTask = async () => {
  try {
    const t = (await api.getTask(taskId.value)) as TaskView
    task.value = t
  } catch {
    task.value = null
  } finally {
    loading.value = false
  }
}

const loadAuxiliary = async () => {
  try { projects.value = (await api.listProjects()) as ProjectView[] } catch { /* */ }
  try { repos.value = (await api.listRepos()) as typeof repos.value } catch { /* */ }
}

const ensurePolling = () => {
  const active = task.value?.status === 'executing' || task.value?.status === 'planning'
  if (active && pollTimer === null) {
    pollTimer = window.setInterval(loadTask, 2000)
  } else if (!active && pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(() => task.value?.status, ensurePolling)
watch(taskId, async () => {
  loading.value = true
  task.value = null
  await loadTask()
  ensurePolling()
})

onMounted(async () => {
  await Promise.all([loadTask(), loadAuxiliary(), loadPreview()])
  ensurePolling()
  nowTimer = window.setInterval(() => { now.value = Date.now() }, 30_000)
  // Poll preview a cada 30s pra ver mudancas de TTL/status
  previewPollTimer = window.setInterval(loadPreview, 30_000)
})

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  if (nowTimer !== null) window.clearInterval(nowTimer)
  if (previewPollTimer !== null) window.clearInterval(previewPollTimer)
})

// ── Preview deploy ────────────────────────────────────────────────

const loadPreview = async () => {
  if (!task.value) return
  try {
    const p = await api.getPreview(taskId.value)
    preview.value = p as PreviewView | null
  } catch { /* ignore */ }
}

const canPreview = computed(() => {
  const t = task.value
  if (!t) return false
  // Permitir somente quando task terminou (completed/failed) ou ja tem preview ativo
  return t.status === 'completed' || t.status === 'failed' || !!preview.value
})

const previewExpiresIn = computed(() => {
  if (!preview.value?.expiresAt) return ''
  const diffMs = new Date(preview.value.expiresAt).getTime() - now.value
  if (diffMs <= 0) return 'expirado'
  const min = Math.ceil(diffMs / 60000)
  return `${min}min`
})

const onStartPreview = async () => {
  previewStarting.value = true
  previewStatusText.value = 'instalando deps...'
  // Fake progression a cada ~25s pra dar feedback
  const t1 = window.setTimeout(() => { previewStatusText.value = 'buildando...' }, 25_000)
  const t2 = window.setTimeout(() => { previewStatusText.value = 'abrindo tunnel...' }, 60_000)
  try {
    const result = await api.startPreview(taskId.value)
    preview.value = result as PreviewView
  } catch (err) {
    preview.value = {
      taskId: taskId.value,
      tunnelUrl: '',
      status: 'failed',
      startedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  } finally {
    window.clearTimeout(t1)
    window.clearTimeout(t2)
    previewStarting.value = false
    previewStatusText.value = ''
  }
}

const onStopPreview = async () => {
  try {
    await api.stopPreview(taskId.value)
    preview.value = null
  } catch { /* ignore */ }
}

const onCopyPreview = async () => {
  if (!preview.value?.tunnelUrl) return
  try { await navigator.clipboard.writeText(preview.value.tunnelUrl) } catch { /* ignore */ }
}

// ── Subtask retry ────────────────────────────────────────────────

const onRetrySub = async (subId: string) => {
  if (retryingSubId.value) return
  retryingSubId.value = subId
  try {
    await api.retrySubtask(taskId.value, subId)
    // O retry e fire-and-forget no backend (202). Comeca polling agressivo
    // pra ver o resultado em ~2-3min (ate o status mudar pra completed/failed).
    if (pollTimer === null) {
      pollTimer = window.setInterval(loadTask, 2000)
    }
  } catch (err) {
    console.warn('retrySubtask failed:', err)
  } finally {
    // Solta o lock local em 5s pra evitar que o user clique de novo enquanto polling
    setTimeout(() => { retryingSubId.value = null }, 5_000)
  }
}

const projectName = computed(() => {
  if (!task.value?.projectId) return ''
  const p = projects.value.find(x => x.id === task.value!.projectId)
  if (!p) return ''
  return p.isInbox ? '' : p.name
})

const repoLabel = computed(() => {
  const t = task.value
  if (!t) return ''
  const prUrl = t.githubPrUrls?.[0]
  if (prUrl) {
    const ref = prRepoFromUrl(prUrl)
    if (ref) return `${ref.owner}/${ref.repo}`
  }
  if (t.repoIds?.length) {
    const r = repos.value.find(x => x.id === t.repoIds![0])
    if (r) return `${r.owner}/${r.repo}`
  }
  return ''
})

const total = computed(() => {
  const t = task.value
  if (!t) return 0
  if (t.subtasks?.length) return t.subtasks.length
  return t.subtaskCount ?? 0
})

const done = computed(() => {
  const subs = task.value?.subtasks ?? []
  if (subs.length) return subs.filter(s => s.status === 'completed').length
  if (task.value?.status === 'completed') return total.value
  return 0
})

const pct = computed(() => {
  if (task.value?.status === 'completed') return 100
  if (!total.value) return task.value?.status === 'planning' ? 5 : 0
  return Math.round((done.value / total.value) * 100)
})

const canCancel = computed(() => {
  return task.value?.status === 'executing' || task.value?.status === 'planning'
})

const cancel = async () => {
  if (!task.value) return
  try {
    await api.cancelTask(task.value.id)
    await loadTask()
  } catch { /* */ }
}

const durationMs = (sub: Subtask): number | null => {
  if (!sub.startedAt || !sub.completedAt) return null
  const a = new Date(sub.startedAt).getTime()
  const b = new Date(sub.completedAt).getTime()
  if (isNaN(a) || isNaN(b)) return null
  return Math.max(0, b - a)
}

type PrEntry = {
  url: string
  number: number
  owner: string
  repo: string
  branch: string
  subtaskDescription: string
  changes: number | null
}

const prList = computed<PrEntry[]>(() => {
  const subs = task.value?.subtasks ?? []
  const entries: PrEntry[] = []
  for (const s of subs) {
    const url = s.result?.prUrl
    if (!url) continue
    const ref = prRepoFromUrl(url)
    if (!ref) continue
    entries.push({
      url,
      number: ref.number,
      owner: ref.owner,
      repo: ref.repo,
      branch: subtaskBranch(task.value!.id, s.id),
      subtaskDescription: s.description,
      changes: s.result?.changes?.length ?? null
    })
  }
  return entries
})

const hasTokens = computed(() => {
  const tu = task.value?.tokenUsage
  if (!tu) return false
  return !!(tu.planner || tu.code || tu.reviewer || tu.reporter || tu.total)
})

type TokenRow = { agent: string; in: number; out: number; total: number; pct: number }

const tokenRows = computed<TokenRow[]>(() => {
  const tu = task.value?.tokenUsage
  if (!tu) return []
  const denom = tu.total?.totalTokens || 1
  const order: Array<keyof typeof tu> = ['planner', 'code', 'reviewer', 'reporter']
  const labels: Record<string, string> = {
    planner: 'Planner', code: 'Code', reviewer: 'Reviewer', reporter: 'Reporter'
  }
  return order
    .filter(k => tu[k])
    .map(k => {
      const block = tu[k]!
      return {
        agent: labels[k as string] ?? String(k),
        in: block.inputTokens,
        out: block.outputTokens,
        total: block.totalTokens,
        pct: Math.round((block.totalTokens / denom) * 100)
      }
    })
})

const changeCount = (sub: Subtask): number => sub.result?.changes?.length ?? 0

const outputSubs = computed<Subtask[]>(() => {
  const subs = task.value?.subtasks ?? []
  return subs.filter(s =>
    (s.result?.changes && s.result.changes.length > 0) ||
    s.result?.message ||
    s.result?.result ||
    !!s.error
  )
})
</script>

<style scoped>
.task-detail {
  max-width: 880px;
  margin: 0 auto;
  padding: 1.75rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.state {
  text-align: center;
  padding: 4rem 1rem;
  color: var(--text-secondary, #888);
}
.state h2 { color: var(--text, #fff); margin: 0 0 .5rem; }
.spinner { display: inline-block; width: 28px; height: 28px; border: 2px solid var(--border, #333); border-top-color: var(--primary, #6c5ce7); border-radius: 50%; animation: sp .7s linear infinite; margin-bottom: .75rem; }
@keyframes sp { to { transform: rotate(360deg); } }
.btn-back { display: inline-block; margin-top: 1rem; padding: .5rem 1rem; border: 1px solid var(--border, #333); border-radius: 8px; color: var(--text, #fff); text-decoration: none; font-size: .85rem; }
.btn-back:hover { border-color: var(--primary, #6c5ce7); color: var(--primary, #6c5ce7); }

/* Breadcrumb */
.crumbs { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--text-secondary, #888); }
.crumb-link { color: var(--text-secondary, #888); text-decoration: none; }
.crumb-link:hover { color: var(--text, #fff); }
.crumb-proj { color: var(--text, #ddd); }
.crumb-id { font-family: ui-monospace, monospace; background: var(--bg-tertiary, #252540); padding: .1rem .35rem; border-radius: 4px; font-size: .72rem; }
.sep { opacity: .4; }

/* Hero */
.hero {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-left: 3px solid var(--border, #333);
  border-radius: 12px;
  padding: 1.5rem 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.hero.planning { border-left-color: #74b9ff; }
.hero.executing { border-left-color: #fdcb6e; }
.hero.completed { border-left-color: #00b894; }
.hero.failed, .hero.cancelled { border-left-color: #ff6b6b; }

.hero-status {
  display: inline-flex;
  align-items: center;
  gap: .45rem;
  font-size: .68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-secondary, #aaa);
  align-self: flex-start;
}
.hero-status .dot { width: 7px; height: 7px; border-radius: 50%; }
.hero-status .dot.planning { background: #74b9ff; }
.hero-status .dot.executing { background: #fdcb6e; box-shadow: 0 0 8px rgba(253,203,110,.6); }
.hero-status .dot.completed { background: #00b894; }
.hero-status .dot.failed, .hero-status .dot.cancelled { background: #ff6b6b; }
.hero.planning .status-text { color: #74b9ff; }
.hero.executing .status-text { color: #fdcb6e; }
.hero.completed .status-text { color: #00b894; }
.hero.failed .status-text, .hero.cancelled .status-text { color: #ff6b6b; }

.hero-title {
  font-size: 1.35rem;
  font-weight: 600;
  line-height: 1.4;
  margin: 0;
  color: var(--text, #fff);
  word-break: break-word;
}

.hero-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: .78rem;
  color: var(--text-secondary, #888);
}
.hero-meta .repo {
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  color: var(--text, #ccc);
}

.hero-progress {
  display: flex;
  align-items: center;
  gap: .85rem;
}
.hero-bar {
  flex: 1;
  height: 5px;
  background: rgba(255,255,255,.05);
  border-radius: 3px;
  overflow: hidden;
}
.hero-bar .fill {
  height: 100%;
  border-radius: 3px;
  transition: width .4s ease;
}
.hero-bar .fill.planning { background: #74b9ff; }
.hero-bar .fill.executing { background: linear-gradient(90deg, #fdcb6e, #ffb142); }
.hero-bar .fill.completed { background: #00b894; }
.hero-bar .fill.failed, .hero-bar .fill.cancelled { background: #ff6b6b; }
.hero-pct { font-size: .75rem; font-weight: 600; color: var(--text-secondary, #aaa); font-family: ui-monospace, monospace; min-width: 36px; text-align: right; }

.hero-actions { display: flex; gap: .5rem; }
.btn-danger {
  background: rgba(255,107,107,.1);
  border: 1px solid rgba(255,107,107,.3);
  color: #ff6b6b;
  border-radius: 8px;
  padding: .5rem 1rem;
  cursor: pointer;
  font-size: .8rem;
  font-weight: 500;
  transition: background .15s;
}
.btn-danger:hover { background: rgba(255,107,107,.2); }

/* Preview actions */
.preview-actions { align-items: center; flex-wrap: wrap; margin-top: .5rem; }
.btn-preview {
  background: rgba(108, 92, 231, .15);
  border: 1px solid rgba(108, 92, 231, .4);
  color: #a29bfe;
  border-radius: 8px;
  padding: .5rem 1rem;
  cursor: pointer;
  font-size: .8rem;
  font-weight: 500;
  transition: background .15s;
  display: inline-flex;
  align-items: center;
  gap: .4rem;
}
.btn-preview:hover:not(:disabled) { background: rgba(108, 92, 231, .25); }
.btn-preview:disabled { opacity: .6; cursor: wait; }

.btn-preview-url {
  background: linear-gradient(135deg, #6c5ce7 0%, #a29bfe 100%);
  border: none;
  color: #fff;
  border-radius: 8px;
  padding: .5rem 1rem;
  text-decoration: none;
  font-size: .82rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  transition: filter .15s;
}
.btn-preview-url:hover { filter: brightness(1.1); }

.btn-secondary {
  background: var(--bg-tertiary, #252540);
  border: 1px solid var(--border, #333);
  color: var(--text, #fff);
  border-radius: 8px;
  padding: .5rem .7rem;
  cursor: pointer;
  font-size: .8rem;
  transition: background .15s;
}
.btn-secondary:hover { background: rgba(255,255,255,.05); }

.preview-ttl {
  font-size: .72rem;
  color: var(--text-secondary, #888);
  margin-left: .25rem;
}
.preview-starting {
  display: inline-flex;
  align-items: center;
  gap: .5rem;
  font-size: .8rem;
  color: var(--text-secondary, #aaa);
}
.preview-error {
  font-size: .75rem;
  color: #ff6b6b;
  margin: .35rem 0 0;
  padding: .35rem .65rem;
  background: rgba(255,107,107,.08);
  border-radius: 6px;
}

.tl-retry-row { display: flex; align-items: center; gap: .65rem; margin-top: .35rem; flex-wrap: wrap; }
.btn-retry {
  background: rgba(108,92,231,.12);
  border: 1px solid rgba(108,92,231,.35);
  color: #a29bfe;
  border-radius: 6px;
  padding: .35rem .7rem;
  cursor: pointer;
  font-size: .75rem;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  transition: background .15s;
}
.btn-retry:hover:not(:disabled) { background: rgba(108,92,231,.22); }
.btn-retry:disabled { opacity: .6; cursor: wait; }
.tl-retry-help { font-size: .68rem; color: var(--text-secondary, #888); }
.spinner-sm {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Section header */
.card-section { display: flex; flex-direction: column; gap: .85rem; }
.card-section > h2 {
  font-size: .68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--text-secondary, #888);
  margin: 0;
  padding-top: .5rem;
  border-top: 1px solid var(--border, #2a2a40);
  padding: .85rem 0 0;
  display: flex;
  align-items: center;
  gap: .5rem;
}
.card-section > h2 .count {
  background: var(--bg-tertiary, #252540);
  color: var(--text-secondary, #aaa);
  padding: .1rem .45rem;
  border-radius: 99px;
  font-size: .68rem;
  letter-spacing: 0;
}

/* Timeline */
.tl {
  list-style: none;
  margin: 0;
  padding: 0 0 0 1rem;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.tl::before {
  content: '';
  position: absolute;
  left: .35rem;
  top: .5rem;
  bottom: .5rem;
  width: 2px;
  background: var(--border, #2a2a40);
}
.tl-item {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: .85rem;
  align-items: start;
}
.tl-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bg-tertiary, #252540);
  border: 2px solid var(--border, #2a2a40);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: .6rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  margin-left: -1.55rem;
  z-index: 1;
}
.tl-dot.completed, .tl-dot.done { background: #00b894; border-color: #00b894; }
.tl-dot.executing { background: #fdcb6e; border-color: #fdcb6e; box-shadow: 0 0 0 4px rgba(253,203,110,.18); }
.tl-dot.failed, .tl-dot.cancelled { background: #ff6b6b; border-color: #ff6b6b; }
.tl-dot.pending { background: var(--bg-primary, #0f0f23); border-color: var(--border, #444); }
.tl-dot .pulse { display: inline-block; width: 5px; height: 5px; background: #fff; border-radius: 50%; animation: puls 1.2s infinite; }

.tl-body { min-width: 0; display: grid; gap: .35rem; }
.tl-head {
  display: flex;
  align-items: center;
  gap: .5rem;
  flex-wrap: wrap;
  font-size: .82rem;
}
.tl-time {
  font-family: ui-monospace, monospace;
  font-size: .72rem;
  color: var(--text-secondary, #777);
  min-width: 38px;
}
.tl-id {
  font-family: ui-monospace, monospace;
  font-size: .68rem;
  color: var(--text-secondary, #888);
  background: var(--bg-tertiary, #252540);
  padding: .05rem .3rem;
  border-radius: 3px;
}
.tl-type {
  font-size: .62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  padding: .1rem .35rem;
  border-radius: 3px;
  background: rgba(255,255,255,.05);
  color: var(--text-secondary, #999);
}
.tl-type.github { background: rgba(108,92,231,.15); color: #a29bfe; }
.tl-type.trello { background: rgba(116,185,255,.12); color: #74b9ff; }
.tl-type.api { background: rgba(0,184,148,.12); color: #00b894; }
.tl-title {
  color: var(--text, #fff);
  font-weight: 500;
  flex: 1;
  min-width: 0;
}
.tl-spacer { flex: 1; }
.tl-dur, .tl-running {
  font-size: .72rem;
  color: var(--text-secondary, #888);
  font-family: ui-monospace, monospace;
}
.tl-running { color: #fdcb6e; font-style: italic; }

.tl-item.pending .tl-title,
.tl-item.pending .tl-id,
.tl-item.pending .tl-type { opacity: .55; }

.tl-err {
  font-size: .78rem;
  color: #ff6b6b;
  background: rgba(255,107,107,.08);
  padding: .45rem .65rem;
  border-radius: 6px;
  line-height: 1.4;
}
.tl-pr { font-size: .75rem; }

.pr-chip {
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  padding: .2rem .5rem;
  background: rgba(108,92,231,.12);
  color: var(--primary, #6c5ce7);
  border-radius: 5px;
  font-size: .72rem;
  font-weight: 600;
  text-decoration: none;
  transition: background .15s;
}
.pr-chip:hover { background: rgba(108,92,231,.22); }

/* PR list */
.pr-list { display: flex; flex-direction: column; gap: .5rem; }
.pr-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1rem;
  align-items: center;
  padding: 1rem 1.25rem;
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #2a2a40);
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
  transition: border-color .15s, transform .15s, background .15s;
}
.pr-card:hover {
  border-color: var(--primary, #6c5ce7);
  transform: translateY(-1px);
  background: var(--bg-tertiary, #252540);
}
.pr-icon { color: var(--text-secondary, #888); flex-shrink: 0; }
.pr-card:hover .pr-icon { color: var(--primary, #6c5ce7); }
.pr-body { min-width: 0; display: grid; gap: .25rem; }
.pr-top { display: flex; align-items: center; gap: .5rem; font-size: .75rem; }
.pr-num {
  font-family: ui-monospace, monospace;
  font-weight: 700;
  color: var(--primary, #6c5ce7);
  font-size: .82rem;
}
.pr-repo { color: var(--text-secondary, #888); }
.pr-title {
  font-size: .9rem;
  font-weight: 500;
  color: var(--text, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pr-meta { display: flex; align-items: center; gap: .4rem; font-size: .72rem; color: var(--text-secondary, #888); }
.pr-branch { display: inline-flex; align-items: center; gap: .3rem; font-family: ui-monospace, monospace; }
.pr-arrow { color: var(--text-secondary, #555); font-size: 1.1rem; flex-shrink: 0; }
.pr-card:hover .pr-arrow { color: var(--primary, #6c5ce7); }

/* Tokens table */
.tokens-table {
  width: 100%;
  border-collapse: collapse;
  font-size: .82rem;
}
.tokens-table th {
  text-align: left;
  font-size: .68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--text-secondary, #888);
  padding: .5rem .75rem;
  border-bottom: 1px solid var(--border, #2a2a40);
}
.tokens-table td {
  padding: .65rem .75rem;
  border-bottom: 1px solid rgba(255,255,255,.04);
  color: var(--text, #ddd);
}
.tokens-table .num { font-family: ui-monospace, monospace; text-align: right; }
.tokens-table .t-agent { font-weight: 500; }
.tokens-table .t-total { color: var(--text, #fff); font-weight: 600; }
.tokens-table tfoot th {
  border-top: 1px solid var(--border, #2a2a40);
  border-bottom: none;
  text-transform: none;
  letter-spacing: 0;
  font-size: .82rem;
  color: var(--text, #fff);
  font-family: ui-monospace, monospace;
  text-align: right;
  padding: .65rem .75rem;
}
.tokens-table tfoot th:first-child { font-family: inherit; text-align: left; text-transform: uppercase; font-size: .68rem; letter-spacing: .8px; color: var(--text-secondary, #888); }
.tokens-table .bar-col { width: 80px; text-align: right; }
.mini-bar {
  width: 70px;
  height: 4px;
  background: rgba(255,255,255,.05);
  border-radius: 2px;
  overflow: hidden;
  margin-left: auto;
}
.mini-bar .fill {
  height: 100%;
  background: var(--primary, #6c5ce7);
  border-radius: 2px;
  opacity: .7;
}

/* Output (details) */
.sub-output {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #2a2a40);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: .5rem;
}
.sub-output summary {
  display: flex;
  align-items: center;
  gap: .55rem;
  padding: .75rem .9rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.sub-output summary::-webkit-details-marker { display: none; }
.sub-output summary:hover { background: var(--bg-tertiary, #252540); }
.sub-output .caret { color: var(--text-secondary, #888); transition: transform .15s; flex-shrink: 0; }
.sub-output[open] .caret { transform: rotate(180deg); }

.o-status { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--text-secondary, #555); }
.o-status.completed { background: #00b894; }
.o-status.executing { background: #fdcb6e; }
.o-status.failed, .o-status.cancelled { background: #ff6b6b; }
.o-id {
  font-family: ui-monospace, monospace;
  font-size: .68rem;
  background: var(--bg-tertiary, #252540);
  color: var(--text-secondary, #aaa);
  padding: .05rem .3rem;
  border-radius: 3px;
}
.o-type {
  font-size: .62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  padding: .1rem .35rem;
  border-radius: 3px;
  background: rgba(255,255,255,.05);
  color: var(--text-secondary, #999);
}
.o-type.github { background: rgba(108,92,231,.15); color: #a29bfe; }
.o-desc {
  flex: 1;
  min-width: 0;
  font-size: .82rem;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.o-count { font-size: .7rem; color: var(--text-secondary, #888); }

.o-content { padding: .25rem 1rem 1rem; border-top: 1px solid var(--border, #2a2a40); }
.o-changes { display: flex; flex-direction: column; gap: .25rem; padding-top: .65rem; }
.o-change {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: .35rem .5rem;
  font-size: .8rem;
}
.o-action {
  display: inline-block;
  font-size: .62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  padding: .12rem .4rem;
  border-radius: 3px;
  min-width: 60px;
  text-align: center;
  background: rgba(255,255,255,.05);
  color: var(--text-secondary, #888);
}
.o-action.create, .o-action.created, .o-action.add { background: rgba(0,184,148,.15); color: #00b894; }
.o-action.update, .o-action.updated, .o-action.modify, .o-action.modified, .o-action.edit { background: rgba(116,185,255,.12); color: #74b9ff; }
.o-action.delete, .o-action.deleted, .o-action.remove { background: rgba(255,107,107,.12); color: #ff6b6b; }
.o-change code { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--text, #ddd); }
.o-text { padding-top: .65rem; font-size: .82rem; line-height: 1.5; }
.o-text pre {
  background: var(--bg-primary, #0f0f23);
  border: 1px solid var(--border, #2a2a40);
  border-radius: 6px;
  padding: .65rem .85rem;
  overflow-x: auto;
  font-family: ui-monospace, monospace;
  font-size: .78rem;
  color: var(--text, #ddd);
  margin: .5rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.o-err { padding-top: .65rem; font-size: .82rem; color: #ff6b6b; }
.o-empty { padding-top: .65rem; font-size: .8rem; color: var(--text-secondary, #666); font-style: italic; }

/* Summary */
.summary-content {
  font-size: .85rem;
  line-height: 1.6;
  color: var(--text-secondary, #bbb);
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #2a2a40);
  border-radius: 10px;
  padding: 1rem 1.25rem;
}
.summary-content :deep(h2) { font-size: 1rem; margin: 1rem 0 .4rem; color: var(--text, #fff); font-weight: 600; }
.summary-content :deep(h3) { font-size: .92rem; margin: .9rem 0 .35rem; color: var(--text, #fff); font-weight: 600; }
.summary-content :deep(h4) { font-size: .85rem; margin: .8rem 0 .3rem; color: var(--text, #fff); font-weight: 600; }
.summary-content :deep(p) { margin: .5rem 0; }
.summary-content :deep(ul) { margin: .4rem 0; padding-left: 1.2rem; }
.summary-content :deep(li) { margin: .2rem 0; list-style: disc; }
.summary-content :deep(li.checked) { color: #00b894; list-style: none; margin-left: -1.2rem; }
.summary-content :deep(li.checked)::before { content: "✓ "; font-weight: 700; }
.summary-content :deep(li.unchecked) { list-style: none; margin-left: -1.2rem; opacity: .65; }
.summary-content :deep(li.unchecked)::before { content: "○ "; }
.summary-content :deep(code) {
  background: rgba(255,255,255,.06);
  padding: .05rem .35rem;
  border-radius: 3px;
  font-size: .8rem;
  font-family: ui-monospace, monospace;
  color: var(--text, #fff);
}
.summary-content :deep(a) { color: var(--primary, #6c5ce7); text-decoration: none; word-break: break-all; }
.summary-content :deep(a:hover) { text-decoration: underline; }
.summary-content :deep(strong) { color: var(--text, #fff); }

.dim { opacity: .5; }
@keyframes puls { 0%,100%{opacity:1} 50%{opacity:.4} }

@media (max-width: 700px) {
  .task-detail { padding: 1rem; }
  .hero { padding: 1.25rem; }
  .hero-title { font-size: 1.15rem; }
  .pr-card { grid-template-columns: auto 1fr; gap: .75rem; padding: .85rem; }
  .pr-arrow { display: none; }
  .tokens-table { font-size: .75rem; }
  .tokens-table .bar-col { display: none; }
  .tl-head { gap: .35rem; }
  .tl-time { display: none; }
}
</style>
