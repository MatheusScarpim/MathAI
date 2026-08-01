<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-card">
      <div class="modal-header">
        <h2>{{ isEdit ? 'Editar projeto' : 'Novo projeto' }}</h2>
        <button class="close-btn" @click="$emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <label class="field">
          <span class="field-label">Nome</span>
          <input
            ref="nameInput"
            v-model="form.name"
            class="field-input"
            placeholder="Ex: Loja online"
            @keyup.enter="handleSave"
          />
        </label>

        <label class="field">
          <span class="field-label">Descricao <span class="field-sub">(opcional)</span></span>
          <textarea
            v-model="form.description"
            class="field-input"
            rows="2"
            placeholder="Sobre o que e este projeto?"
          />
        </label>

        <div class="field">
          <span class="field-label">Repositorios vinculados</span>
          <div v-if="reposLoading" class="repos-loading">Carregando...</div>
          <div v-else-if="!availableRepos.length" class="repos-empty">
            Nenhum repositorio cadastrado. Cadastre repos pelo botao GitHub na composer.
          </div>
          <div v-else class="repos-mini-list">
            <label
              v-for="r in availableRepos"
              :key="r.id"
              class="repo-mini"
              :class="{ on: form.repoIds.includes(r.id) }"
            >
              <input type="checkbox" :checked="form.repoIds.includes(r.id)" @change="toggleRepo(r.id)" />
              <span class="check-box" :class="{ on: form.repoIds.includes(r.id) }">
                <svg v-if="form.repoIds.includes(r.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" class="gh-icon">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <span class="repo-mini-name">{{ r.owner }}/{{ r.repo }}</span>
            </label>
          </div>
        </div>

        <div class="field">
          <span class="field-label">Trello — Board <span class="field-sub">(opcional, sobrescreve o padrao das Configuracoes)</span></span>
          <select
            v-model="form.trelloBoardId"
            class="field-input"
            :disabled="trelloUnavailable && !availableBoards.length"
            @change="onBoardChange"
          >
            <option value="">— usar padrao global —</option>
            <option v-for="b in availableBoards" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
          <span v-if="trelloUnavailable" class="field-hint-muted">
            Configure Trello em Configuracoes para listar boards.
          </span>
        </div>

        <div v-if="form.trelloBoardId" class="field">
          <span class="field-label">Trello — Lista padrao</span>
          <select v-model="form.trelloListId" class="field-input">
            <option value="">— primeira lista do board —</option>
            <option v-for="l in availableLists" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </div>

        <div v-if="form.trelloBoardId" class="field">
          <span class="field-label">Trello — Lista "Done" <span class="field-sub">(destino ao finalizar)</span></span>
          <select v-model="form.trelloDoneListId" class="field-input">
            <option value="">— usar padrao global —</option>
            <option v-for="l in availableLists" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </div>

        <div v-if="form.trelloBoardId" class="field">
          <label class="field-checkbox">
            <input type="checkbox" v-model="form.trelloAgentEnabled" />
            <span>Agente Trello <span class="field-sub">(LLM move o card de coluna e comenta o progresso automaticamente a cada etapa)</span></span>
          </label>
        </div>

        <div v-if="form.trelloBoardId && form.trelloAgentEnabled" class="field">
          <label class="field-checkbox">
            <input type="checkbox" v-model="form.trelloAgentCreateCards" />
            <span>Permitir criar cards <span class="field-sub">(deixa o agente criar novos cards no board quando necessario — desligado por padrao pra evitar excesso)</span></span>
          </label>
        </div>

        <details class="preview-section">
          <summary>Preview deploy (opcional)</summary>
          <p class="preview-help">
            Configure pra habilitar o botao "Testar" nas tasks deste projeto.
            Build estatico + cloudflared tunnel. Requer MSW no projeto pra mockar API.
          </p>
          <div v-if="isEdit" class="setup-msw-row">
            <button
              type="button"
              class="btn-magic"
              :disabled="settingUpPreview"
              @click="onSetupPreview"
            >
              <span v-if="settingUpPreview" class="spinner-sm"></span>
              🪄 {{ settingUpPreview
                ? 'Disparando...'
                : form.previewBuildCmd
                  ? 'Re-executar setup MSW'
                  : 'Configurar MSW automaticamente' }}
            </button>
            <p class="setup-msw-help">
              <template v-if="form.previewBuildCmd">
                Re-dispara a task de scaffold. Util quando o setup anterior nao terminou
                certo (ex: PR vazio ou agent escapou do diretorio).
              </template>
              <template v-else>
                O agent abre PR adicionando msw + script build:preview + bootstrap.
                Apos mergeares, os campos abaixo serao preenchidos.
              </template>
            </p>
            <p v-if="setupPreviewMsg" class="setup-msw-msg">{{ setupPreviewMsg }}</p>
          </div>
          <div class="field">
            <span class="field-label">Build command</span>
            <input
              v-model="form.previewBuildCmd"
              type="text"
              class="field-input"
              placeholder="npm run build:preview"
            />
          </div>
          <div class="field">
            <span class="field-label">Mocks dir <span class="field-sub">(onde o agent gera handlers MSW)</span></span>
            <input
              v-model="form.previewMocksDir"
              type="text"
              class="field-input"
              placeholder="frontend/src/mocks/preview"
            />
          </div>
          <div class="field">
            <span class="field-label">Dist dir <span class="field-sub">(opcional — autodetectado)</span></span>
            <input
              v-model="form.previewDistDir"
              type="text"
              class="field-input"
              placeholder="frontend/dist"
            />
          </div>
        </details>

        <div v-if="form.error" class="form-error">{{ form.error }}</div>
      </div>

      <div class="modal-footer">
        <button v-if="isEdit && !project?.isInbox" class="btn-danger" :disabled="form.saving" @click="handleDelete">
          Excluir
        </button>
        <div class="footer-spacer"></div>
        <button class="btn-secondary" @click="$emit('close')">Cancelar</button>
        <button class="btn-primary" :disabled="form.saving || !form.name.trim()" @click="handleSave">
          <span v-if="form.saving" class="spinner-sm"></span>
          {{ isEdit ? 'Salvar' : 'Criar' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { api } from '../services/api'

type Repo = {
  id: string
  name: string
  owner: string
  repo: string
}

type Project = {
  id: string
  name: string
  description?: string
  repoIds: string[]
  trelloBoardId?: string
  trelloListId?: string
  trelloDoneListId?: string
  trelloAgentEnabled?: boolean
  trelloAgentCreateCards?: boolean
  previewBuildCmd?: string
  previewMocksDir?: string
  previewDistDir?: string
  isInbox: boolean
}

type Board = { id: string; name: string; url: string }
type List = { id: string; name: string }

const props = defineProps<{ project?: Project | null }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', project: Record<string, unknown>): void
  (e: 'deleted', id: string): void
}>()

const isEdit = computed(() => !!props.project?.id)

const nameInput = ref<HTMLInputElement | null>(null)
const availableRepos = ref<Repo[]>([])
const reposLoading = ref(true)
const availableBoards = ref<Board[]>([])
const availableLists = ref<List[]>([])
const trelloUnavailable = ref(false)

const form = ref({
  name: props.project?.name ?? '',
  description: props.project?.description ?? '',
  repoIds: [...(props.project?.repoIds ?? [])],
  trelloBoardId: props.project?.trelloBoardId ?? '',
  trelloListId: props.project?.trelloListId ?? '',
  trelloDoneListId: props.project?.trelloDoneListId ?? '',
  trelloAgentEnabled: props.project?.trelloAgentEnabled ?? true,
  trelloAgentCreateCards: props.project?.trelloAgentCreateCards ?? false,
  previewBuildCmd: props.project?.previewBuildCmd ?? '',
  previewMocksDir: props.project?.previewMocksDir ?? '',
  previewDistDir: props.project?.previewDistDir ?? '',
  saving: false,
  error: ''
})

const settingUpPreview = ref(false)
const setupPreviewMsg = ref('')

const onSetupPreview = async () => {
  if (!props.project?.id) return
  settingUpPreview.value = true
  setupPreviewMsg.value = ''
  try {
    const res = await api.setupProjectPreview(props.project.id)
    setupPreviewMsg.value = res.message || 'Task disparada.'
  } catch (err) {
    setupPreviewMsg.value = 'Erro: ' + (err instanceof Error ? err.message : String(err))
  } finally {
    settingUpPreview.value = false
  }
}

const onBoardChange = async () => {
  form.value.trelloListId = ''
  form.value.trelloDoneListId = ''
  if (!form.value.trelloBoardId) {
    availableLists.value = []
    return
  }
  try {
    availableLists.value = await api.getTrelloLists(form.value.trelloBoardId)
  } catch {
    availableLists.value = []
  }
}

const toggleRepo = (id: string) => {
  const i = form.value.repoIds.indexOf(id)
  if (i >= 0) form.value.repoIds.splice(i, 1)
  else form.value.repoIds.push(id)
}

const handleSave = async () => {
  form.value.error = ''
  if (!form.value.name.trim()) {
    form.value.error = 'Nome obrigatorio'
    return
  }
  form.value.saving = true
  try {
    const body = {
      name: form.value.name.trim(),
      description: form.value.description.trim() || undefined,
      repoIds: form.value.repoIds,
      trelloBoardId: form.value.trelloBoardId || '',
      trelloListId: form.value.trelloListId || '',
      trelloDoneListId: form.value.trelloDoneListId || '',
      trelloAgentEnabled: form.value.trelloAgentEnabled,
      trelloAgentCreateCards: form.value.trelloAgentCreateCards,
      previewBuildCmd: form.value.previewBuildCmd.trim() || '',
      previewMocksDir: form.value.previewMocksDir.trim() || '',
      previewDistDir: form.value.previewDistDir.trim() || ''
    }
    const saved = isEdit.value
      ? await api.updateProject(props.project!.id, body)
      : await api.createProject(body)
    emit('saved', saved)
  } catch (err) {
    form.value.error = err instanceof Error ? err.message : 'Erro ao salvar'
  } finally {
    form.value.saving = false
  }
}

const handleDelete = async () => {
  if (!props.project?.id) return
  if (!confirm(`Excluir projeto "${props.project.name}"? As tarefas serao movidas para o Inbox.`)) return
  form.value.saving = true
  try {
    await api.deleteProject(props.project.id)
    emit('deleted', props.project.id)
  } catch (err) {
    form.value.error = err instanceof Error ? err.message : 'Erro ao excluir'
    form.value.saving = false
  }
}

onMounted(async () => {
  await nextTick()
  nameInput.value?.focus()
  try {
    availableRepos.value = await api.listRepos()
  } catch {
    availableRepos.value = []
  } finally {
    reposLoading.value = false
  }
  // Tenta carregar boards do Trello (silencioso — se nao configurado mostra hint)
  try {
    availableBoards.value = await api.getTrelloBoards()
    trelloUnavailable.value = false
    if (form.value.trelloBoardId) {
      try {
        availableLists.value = await api.getTrelloLists(form.value.trelloBoardId)
      } catch {
        availableLists.value = []
      }
    }
  } catch {
    availableBoards.value = []
    trelloUnavailable.value = true
  }
})
</script>

<style scoped>
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1.5rem; backdrop-filter: blur(4px); animation: fadein .15s ease; }
@keyframes fadein { from { opacity: 0 } to { opacity: 1 } }

.modal-card { width: 100%; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-secondary, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 14px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.5); animation: slideup .25s ease; }
@keyframes slideup { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }

.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border, #333); }
.modal-header h2 { font-size: 1rem; font-weight: 600; margin: 0; }
.close-btn { background: transparent; border: none; color: var(--text-secondary, #888); font-size: 1.6rem; cursor: pointer; padding: 0; line-height: 1; }
.close-btn:hover { color: var(--text, #fff); }

.modal-body { flex: 1; overflow-y: auto; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .85rem; }

.field { display: flex; flex-direction: column; gap: .3rem; }
.field-label { font-size: .72rem; color: var(--text-secondary, #888); font-weight: 500; }
.field-sub { color: var(--text-secondary, #666); font-weight: 400; margin-left: .25rem; }
.field-checkbox { display: flex; align-items: flex-start; gap: .5rem; cursor: pointer; }
.field-checkbox input { margin-top: .2rem; }
.field-input { padding: .5rem .7rem; background: var(--bg-primary, #0f0f23); border: 1px solid var(--border, #333); border-radius: 7px; color: var(--text, #fff); font-size: .88rem; outline: none; transition: border-color .15s; resize: vertical; font-family: inherit; }
.field-input:focus { border-color: var(--primary, #6c5ce7); }
select.field-input { cursor: pointer; }
select.field-input:disabled { opacity: .55; cursor: not-allowed; }
.field-hint-muted { display: block; margin-top: .35rem; font-size: .72rem; color: var(--text-secondary, #888); }
textarea.field-input { min-height: 50px; }

.repos-loading, .repos-empty { font-size: .8rem; color: var(--text-secondary, #888); padding: .65rem; background: var(--bg-tertiary, #252540); border-radius: 7px; text-align: center; }

.repos-mini-list { display: flex; flex-direction: column; gap: .25rem; max-height: 200px; overflow-y: auto; padding: .25rem; background: var(--bg-tertiary, #252540); border-radius: 8px; }
.repo-mini { display: flex; align-items: center; gap: .5rem; padding: .45rem .55rem; border-radius: 6px; cursor: pointer; transition: background .12s; }
.repo-mini:hover { background: rgba(255,255,255,.04); }
.repo-mini.on { background: rgba(108,92,231,.1); }
.repo-mini input[type="checkbox"] { display: none; }
.check-box { width: 16px; height: 16px; border: 1.5px solid var(--text-secondary, #555); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all .12s; color: #fff; }
.check-box.on { background: var(--primary, #6c5ce7); border-color: var(--primary, #6c5ce7); }
.gh-icon { color: var(--text-secondary, #888); flex-shrink: 0; }
.repo-mini.on .gh-icon { color: var(--primary, #6c5ce7); }
.repo-mini-name { font-size: .82rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.form-error { font-size: .78rem; color: #ff6b6b; padding: .45rem .65rem; background: rgba(255,107,107,.08); border-radius: 6px; }

.preview-section { border: 1px solid var(--border, #333); border-radius: 7px; padding: .5rem .75rem; background: rgba(108,92,231,.04); }
.preview-section > summary { cursor: pointer; font-size: .85rem; font-weight: 500; color: var(--text, #fff); padding: .25rem 0; user-select: none; }
.preview-section > summary:hover { color: var(--primary, #6c5ce7); }
.preview-section[open] > summary { margin-bottom: .5rem; padding-bottom: .35rem; border-bottom: 1px dashed var(--border, #333); }
.preview-help { font-size: .72rem; color: var(--text-secondary, #888); margin: 0 0 .65rem; line-height: 1.4; }
.preview-section .field { margin-bottom: .5rem; }
.preview-section .field:last-child { margin-bottom: 0; }

.setup-msw-row { margin-bottom: .75rem; padding-bottom: .65rem; border-bottom: 1px dashed var(--border, #333); }
.btn-magic {
  background: linear-gradient(135deg, #6c5ce7 0%, #a29bfe 100%);
  border: none;
  color: #fff;
  border-radius: 7px;
  padding: .5rem .85rem;
  cursor: pointer;
  font-size: .82rem;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  transition: filter .15s;
}
.btn-magic:hover:not(:disabled) { filter: brightness(1.1); }
.btn-magic:disabled { opacity: .6; cursor: wait; }
.setup-msw-help { font-size: .7rem; color: var(--text-secondary, #888); margin: .4rem 0 0; line-height: 1.4; }
.setup-msw-msg { font-size: .75rem; color: #a29bfe; margin: .35rem 0 0; padding: .35rem .55rem; background: rgba(108,92,231,.1); border-radius: 5px; }
.spinner-sm {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(255,255,255,.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

.modal-footer { display: flex; align-items: center; gap: .5rem; padding: .85rem 1.25rem; border-top: 1px solid var(--border, #333); background: var(--bg-secondary, #1a1a2e); }
.footer-spacer { flex: 1; }

.btn-primary { background: var(--primary, #6c5ce7); border: none; color: #fff; padding: .5rem 1.1rem; border-radius: 7px; font-size: .85rem; cursor: pointer; transition: opacity .15s; display: inline-flex; align-items: center; gap: .35rem; }
.btn-primary:hover { opacity: .9; }
.btn-primary:disabled { opacity: .4; cursor: not-allowed; }

.btn-secondary { background: transparent; border: 1px solid var(--border, #333); color: var(--text-secondary, #aaa); padding: .5rem 1.1rem; border-radius: 7px; font-size: .85rem; cursor: pointer; }
.btn-secondary:hover { color: var(--text, #fff); border-color: var(--text-secondary, #555); }

.btn-danger { background: rgba(255,107,107,.12); border: 1px solid rgba(255,107,107,.3); color: #ff6b6b; padding: .5rem 1.1rem; border-radius: 7px; font-size: .85rem; cursor: pointer; }
.btn-danger:hover { background: rgba(255,107,107,.2); }
.btn-danger:disabled { opacity: .4; cursor: not-allowed; }

.spinner-sm { width: 12px; height: 12px; border: 2px solid transparent; border-top-color: #fff; border-radius: 50%; animation: sp .6s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
</style>
