<template>
  <div class="tasks-page">
    <!-- Sidebar de projetos -->
    <ProjectsSidebar
      :projects="projects"
      :selected-id="selectedProjectId"
      @select="onSelectProject"
      @create="openCreateProject"
      @edit="openEditProject"
    />

    <!-- Coluna principal -->
    <div class="main-col">
    <!-- Header -->
    <header class="page-header">
      <div>
        <h1>{{ selectedProject?.name || 'Task Orchestrator' }}</h1>
        <p>{{ selectedProject?.description || 'Descreva uma demanda e o sistema executa automaticamente' }}</p>
      </div>
    </header>

    <!-- Composer -->
    <div class="composer-card">
      <div class="composer" :class="{ focused: inputFocused || selectedRepoIds.length > 0 || useTrello }">
        <div class="composer-field">
          <svg class="ci" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
          </svg>
          <input
            v-model="description"
            type="text"
            placeholder="Descreva o que precisa ser feito..."
            @keyup.enter="submitTask"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
        </div>
        <div class="composer-actions">
          <button class="tool" :class="{ on: selectedRepoIds.length > 0 }" @click="openReposModal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
            <span v-if="selectedRepoIds.length" class="tool-badge">{{ selectedRepoIds.length }}</span>
          </button>
          <button class="tool" :class="{ on: useTrello }" @click="useTrello = !useTrello">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 2h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm2 3v10h4V5H7zm8 0v6h4V5h-4z"/></svg>
            Trello
          </button>
          <select v-model="language" class="lang">
            <option value="pt">PT</option>
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
          <button class="send" @click="submitTask" :disabled="executing || !description.trim()">
            <svg v-if="!executing" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            <span v-else class="spinner"></span>
          </button>
        </div>
      </div>

      <!-- Selected repos preview -->
      <div v-if="selectedRepoIds.length" class="repos-preview">
        <span class="preview-label">Repositorios selecionados:</span>
        <span v-for="r in selectedRepos" :key="r.id" class="repo-chip">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          {{ r.owner }}/{{ r.repo }}
          <button class="chip-remove" @click="toggleRepo(r.id)" title="Remover da selecao">&times;</button>
        </span>
      </div>
    </div>

    <!-- Repos Modal -->
    <div v-if="reposModalOpen" class="modal-overlay" @click.self="closeReposModal">
      <div class="modal-card">
        <div class="modal-header">
          <h2>Repositorios GitHub</h2>
          <button class="close-btn" @click="closeReposModal">&times;</button>
        </div>

        <div class="modal-body">
          <div v-if="reposLoading" class="modal-loading">Carregando...</div>

          <!-- Lista de repos cadastrados -->
          <div v-if="!reposLoading && savedRepos.length" class="repos-list">
            <div
              v-for="r in savedRepos"
              :key="r.id"
              class="saved-repo"
              :class="{ selected: selectedRepoIds.includes(r.id), editing: editingRepoId === r.id }"
            >
              <label class="saved-repo-main" @click.prevent="toggleRepo(r.id)">
                <span class="check" :class="{ on: selectedRepoIds.includes(r.id) }">
                  <svg v-if="selectedRepoIds.includes(r.id)" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <div class="saved-repo-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                </div>
                <div class="saved-repo-info">
                  <div class="saved-repo-title">{{ r.owner }}<span class="dim">/</span>{{ r.repo }}</div>
                  <div class="saved-repo-meta">
                    <span v-if="r.name && r.name !== r.repo" class="meta-tag">{{ r.name }}</span>
                    <span class="meta-tag branch">{{ r.baseBranch || 'auto' }}</span>
                    <span class="meta-tag" :class="r.hasToken ? 'ok' : 'warn'">
                      {{ r.hasToken ? 'token ok' : 'sem token' }}
                    </span>
                  </div>
                </div>
              </label>
              <div class="saved-repo-actions">
                <button class="icon-btn" @click="startEdit(r)" title="Editar">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="icon-btn danger" @click="confirmDelete(r)" title="Remover">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>

          <div v-if="!reposLoading && !savedRepos.length && !showCreateForm" class="empty-repos">
            <p>Voce ainda nao cadastrou nenhum repositorio.</p>
          </div>

          <!-- Form de criacao/edicao -->
          <div v-if="showCreateForm || editingRepoId" class="repo-form">
            <div class="form-title">{{ editingRepoId ? 'Editar repositorio' : 'Novo repositorio' }}</div>
            <label class="field">
              <span class="field-label">URL ou owner/repo</span>
              <input
                v-model="form.url"
                class="field-input"
                placeholder="https://github.com/owner/repo  ou  owner/repo"
                @input="onFormUrlInput"
              />
              <span v-if="form.parsedDisplay" class="field-hint">&#10003; {{ form.parsedDisplay }}</span>
            </label>
            <div class="field-row">
              <label class="field">
                <span class="field-label">Nome (apelido)</span>
                <input v-model="form.name" class="field-input" :placeholder="form.repo || 'opcional'" />
              </label>
              <label class="field">
                <span class="field-label">Branch base</span>
                <input v-model="form.baseBranch" class="field-input" placeholder="main (auto)" />
              </label>
            </div>
            <label class="field">
              <span class="field-label">
                Token GitHub
                <span v-if="editingRepoId" class="field-sub">(deixe em branco para manter o atual)</span>
              </span>
              <input
                v-model="form.token"
                type="password"
                class="field-input"
                :placeholder="editingRepoId ? '••••••••••' : 'ghp_...'"
                autocomplete="new-password"
              />
            </label>
            <div v-if="form.error" class="form-error">{{ form.error }}</div>
            <div class="form-actions">
              <button class="btn-secondary" @click="cancelForm">Cancelar</button>
              <button class="btn-primary" :disabled="form.saving || !canSave" @click="saveForm">
                <span v-if="form.saving" class="spinner-sm"></span>
                {{ editingRepoId ? 'Salvar' : 'Adicionar' }}
              </button>
            </div>
          </div>

          <button v-if="!showCreateForm && !editingRepoId" class="add-repo-btn" @click="startCreate">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            Adicionar repositorio
          </button>
        </div>

        <div class="modal-footer">
          <span class="modal-status">
            <template v-if="selectedRepoIds.length === 0">Nenhum repositorio selecionado</template>
            <template v-else>{{ selectedRepoIds.length }} selecionado{{ selectedRepoIds.length > 1 ? 's' : '' }}</template>
          </span>
          <button class="btn-primary" @click="closeReposModal">Confirmar</button>
        </div>
      </div>
    </div>

    <!-- Timeline -->
    <div class="timeline" v-if="boardTasks.length || executing">
      <section
        v-for="sec in sections"
        :key="sec.key"
        class="time-group"
        :class="sec.key"
      >
        <header class="time-head" @click="toggleCollapsed(sec.key)">
          <svg class="chev" :class="{ collapsed: collapsed[sec.key] }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span class="time-dot" :class="sec.key"></span>
          <span class="time-label">{{ sec.label }}</span>
          <span class="time-count">{{ sec.count }}</span>
        </header>
        <div v-if="!collapsed[sec.key]" class="time-body">
          <router-link
            v-for="task in tasksByStatus(sec.key)"
            :key="task.id"
            :to="`/tasks/${task.id}`"
            class="time-card"
            :class="task.status"
          >
            <div class="time-card-top">
              <span class="time-card-title">{{ task.description }}</span>
              <span class="time-card-meta">
                <span v-if="taskProjectName(task)">{{ taskProjectName(task) }}</span>
                <span v-if="taskRepoLabel(task)" class="dot-sep">·</span>
                <span v-if="taskRepoLabel(task)">{{ taskRepoLabel(task) }}</span>
                <span class="dot-sep">·</span>
                <span>{{ formatElapsed(task) }}</span>
              </span>
            </div>
            <div class="time-card-bar" :class="{ indet: progressIndeterminate(task) }">
              <div class="fill" :class="task.status" :style="{ width: progressPct(task) + '%' }"></div>
            </div>
            <div class="time-card-foot">
              <span class="foot-item">{{ progressLabel(task) }} subs</span>
              <span v-if="task.githubPrUrls?.length" class="foot-item">{{ task.githubPrUrls.length }} {{ task.githubPrUrls.length === 1 ? 'PR' : 'PRs' }}</span>
              <span class="foot-spacer"></span>
              <span v-if="task.status === 'executing' || task.status === 'planning'" class="foot-running">
                <span class="pulse-dot"></span> em execução
              </span>
            </div>
          </router-link>
        </div>
      </section>
    </div>

    <div v-if="!boardTasks.length && !executing" class="empty-state">
      <p>{{ emptyMessage }}</p>
    </div>
    </div>

    <!-- Project Form Modal -->
    <ProjectFormModal
      v-if="projectModalOpen"
      :project="editingProject"
      @close="closeProjectModal"
      @saved="onProjectSaved"
      @deleted="onProjectDeleted"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../services/api'
import ProjectsSidebar from '../components/ProjectsSidebar.vue'
import ProjectFormModal from '../components/ProjectFormModal.vue'
import { formatElapsed as formatElapsedUtil } from '../utils/taskFormat'

const description = ref('')
const language = ref<'pt' | 'en' | 'es'>('pt')
const inputFocused = ref(false)
const executing = ref(false)

const useTrello = ref(false)

// ─── Projects ────────────────────────────────────────────────
type Project = {
  id: string
  name: string
  description?: string
  repoIds: string[]
  trelloBoardId?: string
  trelloListId?: string
  trelloDoneListId?: string
  isInbox: boolean
  taskCount?: number
  openTaskCount?: number
  createdAt?: string
  updatedAt?: string
}
const projects = ref<Project[]>([])
const selectedProjectId = ref<string | null>(null)
const projectModalOpen = ref(false)
const editingProject = ref<Project | null>(null)

const selectedProject = computed(() =>
  projects.value.find(p => p.id === selectedProjectId.value) ?? null
)

const loadProjects = async () => {
  try {
    const list = (await api.listProjects()) as Project[]
    projects.value = list
    if (!selectedProjectId.value && list.length) {
      const inbox = list.find(p => p.isInbox)
      selectedProjectId.value = (inbox ?? list[0]).id
    }
  } catch { /* */ }
}

const onSelectProject = (id: string) => {
  selectedProjectId.value = id
  loadTasks()
}

const openCreateProject = () => {
  editingProject.value = null
  projectModalOpen.value = true
}

const openEditProject = (p: Project) => {
  editingProject.value = p
  projectModalOpen.value = true
}

const closeProjectModal = () => {
  projectModalOpen.value = false
  editingProject.value = null
}

const onProjectSaved = (saved: Record<string, unknown>) => {
  closeProjectModal()
  loadProjects().then(() => {
    if (saved && typeof saved.id === 'string') selectedProjectId.value = saved.id
  })
}

const onProjectDeleted = (_id: string) => {
  closeProjectModal()
  selectedProjectId.value = null
  loadProjects()
}

// ─── Repos GitHub (persistidos no backend) ─────────────────────
type SavedRepo = {
  id: string
  name: string
  owner: string
  repo: string
  baseBranch?: string
  hasToken: boolean
  createdAt: string
  updatedAt: string
}
const savedRepos = ref<SavedRepo[]>([])
const selectedRepoIds = ref<string[]>([])
const reposModalOpen = ref(false)
const reposLoading = ref(false)
const showCreateForm = ref(false)
const editingRepoId = ref<string | null>(null)

const selectedRepos = computed(() => savedRepos.value.filter(r => selectedRepoIds.value.includes(r.id)))

// Auto-popula composer com defaults do projeto (repos + Trello) ao trocar de projeto.
// User pode fazer override manual desmarcando/marcando depois.
let lastAppliedProjectId: string | null = null
const applyProjectDefaults = (p: Project | null): void => {
  if (!p) return
  selectedRepoIds.value = [...(p.repoIds ?? [])]
  useTrello.value = !!p.trelloBoardId
  lastAppliedProjectId = p.id
}

watch(selectedProjectId, (id) => {
  if (!id || id === lastAppliedProjectId) return
  const p = projects.value.find(x => x.id === id) ?? null
  applyProjectDefaults(p)
})

// Quando lista de projetos chega depois (loadProjects async), aplica pro inicial
watch(projects, (list) => {
  if (selectedProjectId.value && lastAppliedProjectId !== selectedProjectId.value) {
    const p = list.find(x => x.id === selectedProjectId.value) ?? null
    applyProjectDefaults(p)
  }
})

const form = ref<{
  url: string
  owner: string
  repo: string
  name: string
  baseBranch: string
  token: string
  parsedDisplay: string
  error: string
  saving: boolean
}>({ url: '', owner: '', repo: '', name: '', baseBranch: '', token: '', parsedDisplay: '', error: '', saving: false })

const canSave = computed(() => {
  if (editingRepoId.value) return !!form.value.url
  return !!form.value.url && !!form.value.token
})

const parseRef = (input: string): { owner: string; repo: string } | null => {
  const text = input.trim()
  const urlMatch = text.match(/github\.com[/:]([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/i)
  if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]! }
  const slashMatch = text.match(/^([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/)
  if (slashMatch) return { owner: slashMatch[1]!, repo: slashMatch[2]! }
  return null
}

const onFormUrlInput = () => {
  const parsed = parseRef(form.value.url)
  if (parsed) {
    form.value.owner = parsed.owner
    form.value.repo = parsed.repo
    form.value.parsedDisplay = `${parsed.owner}/${parsed.repo}`
    if (!form.value.name) form.value.name = parsed.repo
  } else {
    form.value.parsedDisplay = ''
  }
}

const openReposModal = async () => {
  reposModalOpen.value = true
  reposLoading.value = true
  try { savedRepos.value = await api.listRepos() }
  catch { savedRepos.value = [] }
  finally { reposLoading.value = false }
}

const closeReposModal = () => {
  reposModalOpen.value = false
  showCreateForm.value = false
  editingRepoId.value = null
  resetForm()
}

const toggleRepo = (id: string) => {
  const i = selectedRepoIds.value.indexOf(id)
  if (i >= 0) selectedRepoIds.value.splice(i, 1)
  else selectedRepoIds.value.push(id)
}

const startCreate = () => {
  resetForm()
  editingRepoId.value = null
  showCreateForm.value = true
}

const startEdit = (r: SavedRepo) => {
  resetForm()
  editingRepoId.value = r.id
  showCreateForm.value = false
  form.value.url = `${r.owner}/${r.repo}`
  form.value.owner = r.owner
  form.value.repo = r.repo
  form.value.name = r.name
  form.value.baseBranch = r.baseBranch ?? ''
  form.value.parsedDisplay = `${r.owner}/${r.repo}`
}

const cancelForm = () => {
  showCreateForm.value = false
  editingRepoId.value = null
  resetForm()
}

const resetForm = () => {
  form.value = { url: '', owner: '', repo: '', name: '', baseBranch: '', token: '', parsedDisplay: '', error: '', saving: false }
}

const saveForm = async () => {
  form.value.error = ''
  const parsed = parseRef(form.value.url)
  if (!parsed) {
    form.value.error = 'URL ou owner/repo invalido'
    return
  }
  form.value.saving = true
  try {
    if (editingRepoId.value) {
      const body: Record<string, unknown> = {
        url: form.value.url,
        name: form.value.name || undefined,
        baseBranch: form.value.baseBranch || undefined
      }
      if (form.value.token) body.token = form.value.token
      await api.updateRepo(editingRepoId.value, body)
    } else {
      if (!form.value.token) {
        form.value.error = 'Token obrigatorio ao criar'
        form.value.saving = false
        return
      }
      const created = await api.createRepo({
        url: form.value.url,
        name: form.value.name || undefined,
        baseBranch: form.value.baseBranch || undefined,
        token: form.value.token
      })
      // auto-seleciona o repo recem-criado
      if (created?.id) selectedRepoIds.value.push(created.id as string)
    }
    savedRepos.value = await api.listRepos()
    cancelForm()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    form.value.error = msg
  } finally {
    form.value.saving = false
  }
}

const confirmDelete = async (r: SavedRepo) => {
  if (!confirm(`Remover ${r.owner}/${r.repo}?`)) return
  try {
    await api.deleteRepo(r.id)
    savedRepos.value = savedRepos.value.filter(x => x.id !== r.id)
    selectedRepoIds.value = selectedRepoIds.value.filter(id => id !== r.id)
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Erro ao remover')
  }
}

type SubtaskResult = { prUrl?: string | null; cardUrl?: string | null; trelloCardId?: string | null } | null
type SubtaskView = {
  id: string
  type: string
  description: string
  status: string
  error?: string
  result?: SubtaskResult
}
type TokenBlock = { inputTokens: number; outputTokens: number; totalTokens: number }
type TaskView = {
  id: string
  description: string
  status: string
  subtaskCount?: number
  subtasks?: SubtaskView[]
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

const allTasks = ref<TaskView[]>([])

const columns = [
  { key: 'planning', label: 'Planejando' },
  { key: 'executing', label: 'Executando' },
  { key: 'completed', label: 'Concluido' },
  { key: 'failed', label: 'Falha' }
]

const boardTasks = computed(() => allTasks.value)

// ─── Timeline state ──────────────────────────────────────────
const COLLAPSE_KEY = 'tasks-timeline-collapsed-v2'
const loadCollapsed = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (raw) return JSON.parse(raw) as Record<string, boolean>
  } catch { /* */ }
  return { planning: false, executing: false, completed: false, failed: false }
}
const collapsed = ref<Record<string, boolean>>(loadCollapsed())
const toggleCollapsed = (key: string) => {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] }
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value)) } catch { /* */ }
}

const now = ref(Date.now())
setInterval(() => { now.value = Date.now() }, 30_000)

const sections = computed(() => {
  return columns
    .map(c => ({ key: c.key, label: c.label, count: countByStatus(c.key) }))
    .filter(s => s.count > 0)
})

const emptyMessage = computed(() => {
  const p = selectedProject.value
  if (p && !p.isInbox) return `Nenhuma tarefa em "${p.name}". Descreva uma demanda acima para começar.`
  return 'Nenhuma tarefa ainda. Descreva uma demanda acima para começar.'
})

// helpers de card
const progressTotal = (task: TaskView): number => {
  if (task.subtasks?.length) return task.subtasks.length
  return task.subtaskCount ?? 0
}
const progressDone = (task: TaskView): number => {
  if (task.subtasks?.length) return task.subtasks.filter(s => s.status === 'completed').length
  if (task.status === 'completed') return progressTotal(task)
  return 0
}
const progressPct = (task: TaskView): number => {
  if (task.status === 'completed') return 100
  const total = progressTotal(task)
  if (!total) return task.status === 'planning' ? 5 : 0
  return Math.round((progressDone(task) / total) * 100)
}
const progressIndeterminate = (task: TaskView): boolean => {
  return (task.status === 'executing' || task.status === 'planning') &&
    !task.subtasks?.length
}
const progressLabel = (task: TaskView): string => {
  const total = progressTotal(task)
  if (!total) return '—'
  const done = progressDone(task)
  return `${done}/${total}`
}

const taskProjectName = (task: TaskView): string => {
  if (!task.projectId) return ''
  const p = projects.value.find(x => x.id === task.projectId)
  if (!p) return ''
  return p.isInbox ? '' : p.name
}

const taskRepoLabel = (task: TaskView): string => {
  const prUrl = task.githubPrUrls?.[0]
  if (prUrl) {
    const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull/i)
    if (m) return `${m[1]}/${m[2]}`
  }
  if (task.repoIds?.length) {
    const r = savedRepos.value.find(x => x.id === task.repoIds![0])
    if (r) return `${r.owner}/${r.repo}`
  }
  return ''
}

const formatElapsed = (task: TaskView): string => {
  return formatElapsedUtil(task.createdAt, task.completedAt, now.value)
}

const countByStatus = (status: string) => {
  if (status === 'failed') return allTasks.value.filter(t => t.status === 'failed' || t.status === 'cancelled').length
  return allTasks.value.filter(t => t.status === status).length
}

const tasksByStatus = (status: string) => {
  if (status === 'failed') return allTasks.value.filter(t => t.status === 'failed' || t.status === 'cancelled')
  return allTasks.value.filter(t => t.status === status)
}

const loadTasks = async () => {
  try {
    const opts = selectedProjectId.value ? { projectId: selectedProjectId.value } : undefined
    allTasks.value = (await api.getTasks(opts)) as TaskView[]
  } catch { /* */ }
}

onMounted(async () => {
  await loadProjects()
  loadTasks()
  setInterval(loadTasks, 2000)
  setInterval(loadProjects, 5000)
  // Pre-carrega repos para badge de contagem
  try { savedRepos.value = await api.listRepos() } catch { /* */ }
})

const submitTask = async () => {
  if (!description.value.trim() || executing.value) return
  executing.value = true

  const body: Record<string, unknown> = { description: description.value, language: language.value }
  if (selectedProjectId.value) body.projectId = selectedProjectId.value
  if (selectedRepoIds.value.length === 1) {
    body.github = { repoId: selectedRepoIds.value[0] }
  } else if (selectedRepoIds.value.length > 1) {
    body.github = selectedRepoIds.value.map(id => ({ repoId: id }))
  }
  if (useTrello.value) body.trello = {}

  try {
    await api.executeTaskStream(body, (event) => {
      if (event === 'result' || event === 'error') {
        loadTasks()
      }
    })
  } catch { /* */ } finally {
    executing.value = false
    description.value = ''
    loadTasks()
  }
}

</script>

<style scoped>
.tasks-page {
  padding: 1.75rem 2rem;
  display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 2rem; align-items: start;
}
.main-col { display: grid; gap: 1.25rem; min-width: 0; max-width: 960px; }
@media (max-width: 900px) {
  .tasks-page { grid-template-columns: 1fr; padding: 1rem; }
  .main-col { max-width: 100%; }
}
/* Header */
.page-header h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.2rem; letter-spacing: -.01em; }
.page-header p { color: var(--text-secondary, #888); margin: 0; font-size: 0.85rem; }
/* Composer */
.composer-card { display: grid; background: var(--bg-secondary, #1a1a2e); border-radius: 14px; border: 1px solid var(--border, #333); transition: border-color 0.2s; overflow: clip; }
.composer-card:has(.composer.focused) { border-color: var(--primary, #6c5ce7); }
.composer { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; }
.composer-field { flex: 1; display: flex; align-items: center; gap: 0.75rem; }
.ci { flex-shrink: 0; color: var(--text-secondary, #666); }
.composer-field input { flex: 1; background: transparent; border: none; outline: none; color: var(--text, #fff); font-size: 0.95rem; padding: 0; }
.composer-field input::placeholder { color: var(--text-secondary, #555); }
.composer-actions { display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
.tool { display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.65rem; border-radius: 8px; border: 1px solid var(--border, #333); background: transparent; color: var(--text-secondary, #888); cursor: pointer; font-size: 0.78rem; transition: all 0.15s; white-space: nowrap; }
.tool:hover { border-color: var(--text-secondary, #666); color: var(--text, #ccc); }
.tool.on { border-color: var(--primary, #6c5ce7); background: rgba(108,92,231,0.1); color: var(--primary, #6c5ce7); }
.lang { background: transparent; border: 1px solid var(--border, #333); color: var(--text, #fff); border-radius: 6px; padding: 0.3rem 0.4rem; font-size: 0.75rem; cursor: pointer; }
.send { background: var(--primary, #6c5ce7); border: none; border-radius: 8px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; flex-shrink: 0; }
.send:disabled { opacity: 0.4; cursor: not-allowed; }
.tool-badge { background: var(--primary, #6c5ce7); color: #fff; font-size: .68rem; padding: .05rem .35rem; border-radius: 99px; font-weight: 700; min-width: 1.1rem; text-align: center; }

/* Selected repos preview (abaixo da composer) */
.repos-preview { border-top: 1px solid var(--border, #333); padding: .6rem 1rem; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.preview-label { font-size: .72rem; color: var(--text-secondary, #888); text-transform: uppercase; letter-spacing: .5px; }
.repo-chip { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .55rem .25rem .5rem; background: rgba(108,92,231,.12); border: 1px solid rgba(108,92,231,.3); border-radius: 99px; font-size: .78rem; color: var(--text, #fff); }
.repo-chip svg { color: var(--primary, #6c5ce7); }
.chip-remove { background: transparent; border: none; color: var(--text-secondary, #888); font-size: 1rem; line-height: 1; cursor: pointer; padding: 0; margin-left: .15rem; }
.chip-remove:hover { color: #ff6b6b; }

/* ─── Modal de Repos ──────────────────────────────────────── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1.5rem; backdrop-filter: blur(4px); animation: fadein .15s ease; }
@keyframes fadein { from { opacity: 0 } to { opacity: 1 } }
.modal-card { width: 100%; max-width: 640px; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-secondary, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 14px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.5); animation: slideup .25s ease; }
@keyframes slideup { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border, #333); }
.modal-header h2 { font-size: 1.05rem; font-weight: 600; margin: 0; }
.modal-body { flex: 1; overflow-y: auto; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .75rem; }
.modal-loading { color: var(--text-secondary); padding: 1rem; text-align: center; }
.empty-repos { padding: 2rem 1rem; text-align: center; color: var(--text-secondary, #888); }
.empty-repos p { margin: 0; }

/* Lista de repos */
.repos-list { display: flex; flex-direction: column; gap: .5rem; }
.saved-repo { display: flex; align-items: stretch; gap: .25rem; background: var(--bg-tertiary, #252540); border: 1px solid var(--border, #333); border-radius: 10px; transition: border-color .15s, background .15s; }
.saved-repo.selected { border-color: var(--primary, #6c5ce7); background: rgba(108,92,231,.08); }
.saved-repo.editing { border-color: #fdcb6e; }
.saved-repo:hover:not(.editing) { border-color: var(--text-secondary, #555); }
.saved-repo-main { flex: 1; display: flex; align-items: center; gap: .65rem; padding: .7rem .85rem; cursor: pointer; min-width: 0; }
.check { width: 18px; height: 18px; border: 1.5px solid var(--text-secondary, #555); border-radius: 5px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all .15s; color: #fff; }
.check.on { background: var(--primary, #6c5ce7); border-color: var(--primary, #6c5ce7); }
.saved-repo-icon { color: var(--text-secondary, #888); flex-shrink: 0; }
.saved-repo.selected .saved-repo-icon { color: var(--primary, #6c5ce7); }
.saved-repo-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
.saved-repo-title { font-size: .9rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.saved-repo-title .dim { color: var(--text-secondary, #555); margin: 0 .15rem; }
.saved-repo-meta { display: flex; gap: .4rem; flex-wrap: wrap; }
.meta-tag { font-size: .68rem; padding: .1rem .4rem; border-radius: 4px; background: rgba(255,255,255,.06); color: var(--text-secondary, #888); text-transform: lowercase; }
.meta-tag.branch { background: rgba(108,92,231,.15); color: var(--primary, #6c5ce7); font-family: monospace; }
.meta-tag.ok { background: rgba(0,184,148,.12); color: #00b894; }
.meta-tag.warn { background: rgba(255,107,107,.12); color: #ff6b6b; }
.saved-repo-actions { display: flex; align-items: center; padding: 0 .35rem; gap: .15rem; }
.icon-btn { background: transparent; border: none; color: var(--text-secondary, #888); padding: .35rem; cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: all .15s; }
.icon-btn:hover { color: var(--text, #fff); background: rgba(255,255,255,.06); }
.icon-btn.danger:hover { color: #ff6b6b; background: rgba(255,107,107,.1); }

/* Form */
.repo-form { background: var(--bg-tertiary, #252540); border: 1px solid var(--border, #333); border-radius: 10px; padding: .85rem; display: flex; flex-direction: column; gap: .65rem; }
.form-title { font-size: .82rem; font-weight: 600; color: var(--text, #fff); margin-bottom: .15rem; }
.field { display: flex; flex-direction: column; gap: .25rem; flex: 1; min-width: 0; }
.field-label { font-size: .72rem; color: var(--text-secondary, #888); font-weight: 500; }
.field-sub { font-size: .65rem; color: var(--text-secondary, #666); margin-left: .35rem; font-weight: 400; }
.field-input { padding: .45rem .65rem; background: var(--bg-primary, #0f0f23); border: 1px solid var(--border, #333); border-radius: 6px; color: var(--text, #fff); font-size: .85rem; outline: none; transition: border-color .15s; }
.field-input:focus { border-color: var(--primary, #6c5ce7); }
.field-hint { font-size: .72rem; color: #00b894; margin-top: .15rem; }
.field-row { display: flex; gap: .5rem; }
.form-error { font-size: .78rem; color: #ff6b6b; padding: .35rem .55rem; background: rgba(255,107,107,.08); border-radius: 6px; }
.form-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .15rem; }
.btn-primary { background: var(--primary, #6c5ce7); border: none; color: #fff; padding: .45rem 1rem; border-radius: 7px; font-size: .82rem; cursor: pointer; transition: opacity .15s; display: inline-flex; align-items: center; gap: .35rem; }
.btn-primary:hover { opacity: .9; }
.btn-primary:disabled { opacity: .4; cursor: not-allowed; }
.btn-secondary { background: transparent; border: 1px solid var(--border, #333); color: var(--text-secondary, #aaa); padding: .45rem 1rem; border-radius: 7px; font-size: .82rem; cursor: pointer; }
.btn-secondary:hover { color: var(--text, #fff); border-color: var(--text-secondary, #555); }
.spinner-sm { width: 12px; height: 12px; border: 2px solid transparent; border-top-color: #fff; border-radius: 50%; animation: sp .6s linear infinite; }

.add-repo-btn { background: transparent; border: 1px dashed var(--border, #444); color: var(--text-secondary, #888); border-radius: 8px; padding: .6rem; cursor: pointer; font-size: .82rem; display: flex; align-items: center; justify-content: center; gap: .4rem; transition: all .15s; }
.add-repo-btn:hover { border-color: var(--primary, #6c5ce7); color: var(--primary, #6c5ce7); }

.modal-footer { display: flex; align-items: center; justify-content: space-between; padding: .85rem 1.25rem; border-top: 1px solid var(--border, #333); background: var(--bg-secondary, #1a1a2e); }
.modal-status { font-size: .82rem; color: var(--text-secondary, #888); }

/* Timeline */
.timeline { display: flex; flex-direction: column; gap: 1.75rem; }
.time-group { display: grid; gap: .5rem; }
.time-head {
  display: flex; align-items: center; gap: .55rem;
  padding: 0 .25rem .55rem; cursor: pointer; user-select: none;
}
.time-head:hover .time-label { color: var(--text, #fff); }
.time-head .chev { color: var(--text-secondary, #666); transition: transform .18s ease; flex-shrink: 0; }
.time-head .chev.collapsed { transform: rotate(-90deg); }
.time-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.time-dot.planning { background: #74b9ff; }
.time-dot.executing { background: #fdcb6e; box-shadow: 0 0 8px rgba(253,203,110,.5); }
.time-dot.completed { background: #00b894; }
.time-dot.failed { background: #ff6b6b; }
.time-label { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--text-secondary, #888); transition: color .15s; }
.time-count { margin-left: auto; color: var(--text-secondary, #666); font-size: .7rem; font-weight: 500; }

.time-body { display: flex; flex-direction: column; gap: .5rem; }

.time-card {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid transparent;
  border-left: 2px solid var(--border, #333);
  border-radius: 8px;
  padding: .9rem 1.1rem;
  cursor: pointer;
  display: grid; gap: .65rem;
  transition: border-color .15s, transform .15s, box-shadow .15s, background .15s;
}
.time-card:hover { background: var(--bg-tertiary, #252540); border-color: rgba(108,92,231,.4); }
.time-card.planning { border-left-color: #74b9ff; }
.time-card.executing { border-left-color: #fdcb6e; }
.time-card.completed { border-left-color: #00b894; }
.time-card.failed, .time-card.cancelled { border-left-color: #ff6b6b; }
.time-card.active { border-color: var(--primary, #6c5ce7); box-shadow: 0 0 0 1px var(--primary, #6c5ce7), 0 0 16px rgba(108,92,231,.18); }

.time-card-top { display: flex; align-items: flex-start; gap: 1rem; }
.time-card-title {
  flex: 1; min-width: 0;
  font-size: .88rem; font-weight: 500; color: var(--text, #fff);
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  line-height: 1.4;
}
.time-card-meta { font-size: .7rem; color: var(--text-secondary, #777); display: flex; gap: .4rem; flex-shrink: 0; white-space: nowrap; padding-top: .15rem; }
.time-card-meta .dot-sep { opacity: .4; }

.time-card-bar { position: relative; height: 3px; background: rgba(255,255,255,.04); border-radius: 2px; overflow: hidden; }
.time-card-bar .fill { height: 100%; border-radius: 2px; transition: width .4s ease; opacity: .55; }
.time-card-bar .fill.planning { background: #74b9ff; }
.time-card-bar .fill.executing { background: linear-gradient(90deg, #fdcb6e, #ffb142); opacity: .9; }
.time-card-bar .fill.completed { background: #00b894; }
.time-card-bar .fill.failed, .time-card-bar .fill.cancelled { background: #ff6b6b; }
.time-card.completed .time-card-bar { opacity: .6; }
.time-card-bar.indet { background: var(--bg-tertiary, #252540); }
.time-card-bar.indet .fill {
  width: 35% !important;
  background: linear-gradient(90deg, transparent, #fdcb6e, transparent);
  animation: indet 1.6s ease-in-out infinite;
}
@keyframes indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }

.time-card-foot { display: flex; align-items: center; gap: 1rem; font-size: .7rem; color: var(--text-secondary, #777); }
.foot-item { white-space: nowrap; }
.foot-spacer { flex: 1; }
.foot-running { display: inline-flex; align-items: center; gap: .35rem; color: #fdcb6e; font-weight: 500; }
.pulse-dot { width: 6px; height: 6px; border-radius: 50%; background: #fdcb6e; animation: puls 1.2s infinite; }

.empty-state { text-align: center; padding: 3rem 1rem; color: var(--text-secondary, #666); border: 1px dashed var(--border, #333); border-radius: 12px; }

/* router-link reset for time-card */
.time-card { text-decoration: none; color: inherit; }

.spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: sp 0.6s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
@keyframes puls { 0%,100%{opacity:1} 50%{opacity:.4} }
</style>
