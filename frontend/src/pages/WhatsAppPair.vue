<template>
  <div class="wa-page">
    <header class="page-header">
      <h1>WhatsApp — Pareamento</h1>
      <p>Conecte sua conta WhatsApp ao MathAI escaneando o QR code.</p>
    </header>

    <section class="status-card">
      <div class="row">
        <span class="label">Status:</span>
        <span class="value" :class="`status-${status.pairingStatus}`">
          {{ statusLabel }}
        </span>
      </div>
      <div v-if="status.phoneNumber" class="row">
        <span class="label">Numero:</span>
        <span class="value mono">+{{ status.phoneNumber }}</span>
      </div>
      <div v-if="status.lastConnectedAt" class="row">
        <span class="label">Ultima conexao:</span>
        <span class="value">{{ formatDate(status.lastConnectedAt) }}</span>
      </div>
      <div class="row">
        <span class="label">Conexao:</span>
        <span class="value mono">{{ status.connection }}</span>
      </div>
    </section>

    <section v-if="status.pairingStatus !== 'paired'" class="qr-card">
      <h2>Escaneie o QR no WhatsApp</h2>
      <ol class="hint-list">
        <li>Abra <b>WhatsApp</b> no celular</li>
        <li>Toque em <b>Configuracoes &gt; Aparelhos conectados</b></li>
        <li>Toque em <b>Conectar um aparelho</b></li>
        <li>Aponte a camera pro QR abaixo</li>
      </ol>

      <div class="qr-box">
        <canvas v-show="qrDataUrl" ref="qrCanvas"></canvas>
        <div v-if="!qrDataUrl" class="qr-loading">
          {{ qrError || 'Aguardando QR do WhatsApp...' }}
        </div>
      </div>

      <p v-if="qrCount > 0" class="hint-muted">QR atualiza automaticamente. Versao: {{ qrCount }}</p>
    </section>

    <section v-else class="actions-card">
      <p class="ok-msg">✅ Conta WhatsApp pareada com sucesso.</p>
      <button class="btn-danger" :disabled="acting" @click="onLogout">
        {{ acting ? 'Desconectando...' : 'Desconectar e despareiar' }}
      </button>
    </section>

    <section class="bind-card">
      <h2>Vincular um chat</h2>
      <p class="hint">Cada chat WhatsApp precisa ser vinculado a um projeto. Quando voce mandar <code>!task &lt;desc&gt;</code>, o bot vai usar os repos GitHub e o board Trello deste projeto automaticamente.</p>

      <label class="field">
        <span class="field-label">Projeto default deste chat</span>
        <select v-model="selectedProjectId" class="field-input">
          <option value="">— escolher depois (via !project no chat) —</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">
            {{ p.name }}{{ p.isInbox ? ' (inbox)' : '' }}
            <template v-if="p.repoIds && p.repoIds.length"> · {{ p.repoIds.length }} repo{{ p.repoIds.length > 1 ? 's' : '' }}</template>
            <template v-if="p.trelloBoardId"> · trello ✓</template>
          </option>
        </select>
        <small v-if="selectedProjectName" class="hint-muted">
          ✓ Tasks vao usar os repos e Trello configurados em <b>{{ selectedProjectName }}</b>.
        </small>
      </label>

      <button class="btn-primary" :disabled="genningToken" @click="onGenerateToken">
        {{ genningToken ? 'Gerando...' : 'Gerar token de vinculo' }}
      </button>
      <div v-if="bindToken" class="token-display">
        <p>Mande pro bot:</p>
        <code class="token-code">!start {{ bindToken }}</code>
        <p class="hint-muted">Expira em 10 minutos.</p>
      </div>
      <p v-if="bindError" class="error">{{ bindError }}</p>
    </section>

    <section v-if="privateBindings.length > 0" class="bindings-card">
      <h2>Chats privados vinculados</h2>
      <ul class="bindings-list">
        <li v-for="b in privateBindings" :key="b.id">
          <span class="mono">{{ b.displayName || b.chatId }}</span>
          <button class="btn-mini-danger" @click="onUnbind(b.id)">Remover</button>
        </li>
      </ul>
    </section>

    <section v-if="groupBindings.length > 0" class="bindings-card">
      <h2>Grupos vinculados</h2>
      <p class="hint">Cada grupo pode ter um projeto proprio e permissoes por comando. Admins do grupo podem rodar tudo; para os demais, libere comando a comando (numeros com DDI, ex: 5511999998888).</p>

      <div v-for="g in groupBindings" :key="g.id" class="group-card">
        <div class="group-head">
          <span class="group-name">👥 {{ g.groupSubject || g.displayName || g.chatId }}</span>
          <button class="btn-mini-danger" @click="onUnbind(g.id)">Remover</button>
        </div>

        <label class="field">
          <span class="field-label">Projeto do grupo</span>
          <select v-model="edits[g.id].defaultProjectId" class="field-input">
            <option value="">— nenhum —</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.isInbox ? ' (inbox)' : '' }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Admins (numeros separados por virgula)</span>
          <input v-model="edits[g.id].adminsText" class="field-input" placeholder="5511999998888, 5511888887777" />
        </label>

        <div class="perm-matrix">
          <span class="field-label">Permissoes por comando</span>
          <div v-for="k in permKeys" :key="k" class="perm-row">
            <span class="perm-key">!{{ k }}</span>
            <input v-model="edits[g.id].permText[k]" class="field-input perm-input" placeholder="so admin (vazio) — ou numeros liberados" />
          </div>
        </div>

        <div class="members-block">
          <div class="members-head">
            <span class="field-label">Selecionar por membro do grupo</span>
            <button class="btn-mini" :disabled="membersLoading[g.id]" @click="loadMembers(g.id)">
              {{ membersLoading[g.id] ? 'Carregando...' : (members[g.id] ? 'Recarregar' : 'Carregar membros') }}
            </button>
          </div>

          <p v-if="members[g.id] && members[g.id].length === 0" class="hint-muted">
            Nenhum membro retornado (o bot precisa estar conectado e dentro do grupo).
          </p>

          <div v-if="members[g.id] && members[g.id].length" class="members-table">
            <div class="members-row members-header">
              <span class="m-name">Membro</span>
              <span class="m-col">admin</span>
              <span v-for="k in permKeys" :key="k" class="m-col">{{ k }}</span>
            </div>
            <div v-for="m in members[g.id]" :key="m.value" class="members-row">
              <span class="m-name" :title="m.value">{{ memberLabel(m) }}</span>
              <label class="m-col">
                <input type="checkbox" :checked="memberChecked(g.id, 'admin', m)" @change="toggleMember(g.id, 'admin', m)" />
              </label>
              <label v-for="k in permKeys" :key="k" class="m-col">
                <input type="checkbox" :checked="memberChecked(g.id, k, m)" @change="toggleMember(g.id, k, m)" />
              </label>
            </div>
          </div>
        </div>

        <div class="group-actions">
          <button class="btn-primary" :disabled="edits[g.id].saving" @click="onSaveGroup(g.id)">
            {{ edits[g.id].saving ? 'Salvando...' : 'Salvar' }}
          </button>
          <small v-if="edits[g.id].saved" class="saved-msg">✓ salvo</small>
          <small v-if="edits[g.id].error" class="error">{{ edits[g.id].error }}</small>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import QRCode from 'qrcode'
import { api } from '../services/api'

type WhatsappStatus = {
  enabled: boolean
  connection: 'starting' | 'connecting' | 'open' | 'close'
  connected: boolean
  pairingStatus: 'unpaired' | 'paired' | 'logged_out'
  phoneNumber?: string
  pairedAt?: string
  lastConnectedAt?: string
  rateLimitMs?: number
}

type Binding = {
  id: string
  chatId: string
  displayName?: string
  defaultProjectId?: string
  isGroup?: boolean
  groupSubject?: string
  admins?: string[]
  commandPermissions?: Record<string, string[]>
  createdAt: string
}

const permKeys = ['task', 'ask', 'ideas', 'schedule', 'project'] as const

type GroupEdit = {
  defaultProjectId: string
  adminsText: string
  permText: Record<string, string>
  saving: boolean
  saved: boolean
  error: string
}
const edits = ref<Record<string, GroupEdit>>({})

type GroupMember = {
  value: string
  phone?: string
  lid?: string
  name?: string
  isAdmin: boolean
}
// Membros carregados por grupo (id do binding → lista) + estado de loading.
const members = ref<Record<string, GroupMember[]>>({})
const membersLoading = ref<Record<string, boolean>>({})

const jidToNumber = (jid: string): string => jid.split('@')[0]?.split(':')[0] ?? jid
const numbersToJids = (text: string): string[] =>
  text.split(',').map(s => s.replace(/[^0-9]/g, '')).filter(d => d.length >= 8).map(d => `${d}@s.whatsapp.net`)

// ── Seletor de membros: toggles operam sobre o texto CSV de cada campo ──
const memberDigits = (m: GroupMember): string => m.phone || m.lid || m.value.replace(/[^0-9]/g, '')
const memberLabel = (m: GroupMember): string => {
  const who = m.name || (m.phone ? `+${m.phone}` : m.lid ? `LID ${m.lid}` : m.value)
  return m.isAdmin ? `${who} · admin no grupo` : who
}
const textDigits = (text: string): string[] =>
  text.split(',').map(s => s.replace(/[^0-9]/g, '')).filter(Boolean)
const textHasDigits = (text: string, d: string): boolean => textDigits(text).includes(d)
const toggleInText = (text: string, d: string): string => {
  const arr = textDigits(text)
  const i = arr.indexOf(d)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(d)
  return arr.join(', ')
}
const memberChecked = (id: string, field: string, m: GroupMember): boolean => {
  const e = edits.value[id]; if (!e) return false
  const text = field === 'admin' ? e.adminsText : (e.permText[field] ?? '')
  return textHasDigits(text, memberDigits(m))
}
const toggleMember = (id: string, field: string, m: GroupMember): void => {
  const e = edits.value[id]; if (!e) return
  const d = memberDigits(m)
  if (field === 'admin') e.adminsText = toggleInText(e.adminsText, d)
  else e.permText[field] = toggleInText(e.permText[field] ?? '', d)
}
const loadMembers = async (id: string): Promise<void> => {
  membersLoading.value[id] = true
  try {
    const res = await fetch(`/api/whatsapp/bindings/${id}/members`)
    if (res.ok) {
      const data = await res.json()
      members.value[id] = Array.isArray(data.members) ? data.members : []
    }
  } catch { /* ignore */ } finally {
    membersLoading.value[id] = false
  }
}

const status = ref<WhatsappStatus>({
  enabled: false,
  connection: 'starting',
  connected: false,
  pairingStatus: 'unpaired'
})
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrDataUrl = ref('')
const qrCount = ref(0)
const qrError = ref('')

const bindToken = ref('')
const genningToken = ref(false)
const bindError = ref('')

type ProjectListItem = {
  id: string
  name: string
  isInbox: boolean
  repoIds?: string[]
  trelloBoardId?: string
}
const projects = ref<ProjectListItem[]>([])
const selectedProjectId = ref('')
const selectedProjectName = computed(() =>
  projects.value.find(p => p.id === selectedProjectId.value)?.name || ''
)

const acting = ref(false)
const bindings = ref<Binding[]>([])
const groupBindings = computed(() => bindings.value.filter(b => b.isGroup))
const privateBindings = computed(() => bindings.value.filter(b => !b.isGroup))

let eventSource: EventSource | null = null
let pollHandle: number | null = null

const statusLabel = computed(() => {
  switch (status.value.pairingStatus) {
    case 'paired': return 'Pareado'
    case 'logged_out': return 'Sessao revogada — re-pareie'
    case 'unpaired':
    default: return 'Aguardando pareamento'
  }
})

const formatDate = (iso?: string): string => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString('pt-BR') } catch { return iso }
}

const refreshStatus = async (): Promise<void> => {
  try {
    const res = await fetch('/api/whatsapp/status')
    if (res.ok) status.value = await res.json()
  } catch { /* ignore */ }
}

const seedEdits = (force = false): void => {
  for (const g of bindings.value) {
    if (!g.isGroup) continue
    // Nao sobrescreve edits em andamento (polling roda a cada 8s).
    if (!force && edits.value[g.id]) continue
    const permText: Record<string, string> = {}
    for (const k of permKeys) {
      permText[k] = (g.commandPermissions?.[k] ?? []).map(jidToNumber).join(', ')
    }
    edits.value[g.id] = {
      defaultProjectId: g.defaultProjectId ?? '',
      adminsText: (g.admins ?? []).map(jidToNumber).join(', '),
      permText,
      saving: false,
      saved: false,
      error: ''
    }
  }
}

const refreshBindings = async (): Promise<void> => {
  try {
    const res = await fetch('/api/whatsapp/bindings')
    if (res.ok) {
      bindings.value = await res.json()
      seedEdits()
    }
  } catch { /* ignore */ }
}

const onSaveGroup = async (id: string): Promise<void> => {
  const e = edits.value[id]
  if (!e) return
  e.saving = true; e.saved = false; e.error = ''
  try {
    const commandPermissions: Record<string, string[]> = {}
    for (const k of permKeys) commandPermissions[k] = numbersToJids(e.permText[k] ?? '')
    const body = {
      defaultProjectId: e.defaultProjectId || null,
      admins: numbersToJids(e.adminsText),
      commandPermissions
    }
    const res = await fetch(`/api/whatsapp/bindings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    e.saved = true
  } catch (err) {
    e.error = (err as Error).message || 'Erro ao salvar'
  } finally {
    e.saving = false
  }
}

const renderQr = async (qr: string): Promise<void> => {
  qrCount.value++
  qrError.value = ''
  qrDataUrl.value = qr
  await nextTick()
  if (!qrCanvas.value) return
  try {
    await QRCode.toCanvas(qrCanvas.value, qr, { width: 280, margin: 1 })
  } catch (err) {
    qrError.value = (err as Error).message || 'Erro ao renderizar QR'
  }
}

const startStream = (): void => {
  if (eventSource) return
  eventSource = new EventSource('/api/whatsapp/qr')
  eventSource.addEventListener('qr', async (ev) => {
    try {
      const { qr } = JSON.parse((ev as MessageEvent).data)
      await renderQr(qr)
    } catch { /* ignore */ }
  })
  eventSource.addEventListener('status', async (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data)
      // Refresca status completo do backend (que tem phoneNumber)
      await refreshStatus()
      if (data.status === 'open') {
        // Pareou — fecha stream
        stopStream()
      }
    } catch { /* ignore */ }
  })
  eventSource.addEventListener('error', () => {
    qrError.value = 'Conexao SSE caiu — recarregue a pagina'
    stopStream()
  })
}

const stopStream = (): void => {
  if (eventSource) { eventSource.close(); eventSource = null }
}

const onGenerateToken = async (): Promise<void> => {
  bindError.value = ''
  bindToken.value = ''
  genningToken.value = true
  try {
    const body: Record<string, string> = {}
    if (selectedProjectId.value) body.defaultProjectId = selectedProjectId.value
    const res = await fetch('/api/whatsapp/bind-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    bindToken.value = data.token
  } catch (err) {
    bindError.value = (err as Error).message || 'Erro ao gerar token'
  } finally {
    genningToken.value = false
  }
}

const loadProjects = async (): Promise<void> => {
  try {
    const list = await api.listProjects()
    projects.value = list.map(p => ({
      id: p.id,
      name: p.name,
      isInbox: p.isInbox,
      repoIds: p.repoIds,
      trelloBoardId: p.trelloBoardId
    }))
  } catch { /* ignore */ }
}

const onLogout = async (): Promise<void> => {
  if (!confirm('Despareiar a conta WhatsApp? Vai precisar de novo QR pra reconectar.')) return
  acting.value = true
  try {
    await fetch('/api/whatsapp/logout', { method: 'POST' })
    qrDataUrl.value = ''
    qrCount.value = 0
    await refreshStatus()
    startStream()
  } finally {
    acting.value = false
  }
}

const onUnbind = async (id: string): Promise<void> => {
  if (!confirm('Remover este vinculo?')) return
  await fetch(`/api/whatsapp/bindings/${id}`, { method: 'DELETE' })
  await refreshBindings()
}

onMounted(async () => {
  await refreshStatus()
  await refreshBindings()
  await loadProjects()
  if (status.value.pairingStatus !== 'paired') {
    startStream()
  }
  // Polling leve de status (caso SSE caia)
  pollHandle = window.setInterval(() => { void refreshStatus(); void refreshBindings() }, 8000)
})

onUnmounted(() => {
  stopStream()
  if (pollHandle !== null) window.clearInterval(pollHandle)
})
</script>

<style scoped>
.wa-page { padding: 2rem; display: grid; gap: 1.25rem; }
.page-header h1 { font-size: 1.5rem; margin-bottom: .25rem; }
.page-header p { color: var(--color-gray-400, #888); margin: 0; }

.status-card, .qr-card, .actions-card, .bind-card, .bindings-card {
  background: var(--glass-bg, rgba(255,255,255,.03));
  border: 1px solid var(--glass-border, #333);
  border-radius: 12px;
  padding: 1rem 1.25rem;
}

.row { display: flex; gap: .75rem; padding: .35rem 0; }
.label { color: var(--color-gray-400, #888); min-width: 130px; }
.value { color: var(--color-gray-100, #fff); }
.mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .9rem; }

.status-paired { color: #6ee7b7; }
.status-unpaired { color: #fbbf24; }
.status-logged_out { color: #fca5a5; }

.qr-card h2, .bind-card h2, .bindings-card h2 { margin: 0 0 .75rem; font-size: 1.05rem; }
.hint-list { color: var(--color-gray-300, #ccc); padding-left: 1.2rem; margin: .5rem 0 1rem; }
.hint-list li { padding: .15rem 0; }
.qr-box {
  display: flex; align-items: center; justify-content: center;
  min-height: 300px; padding: 1rem;
  background: #fff; border-radius: 12px;
  margin: 0 auto; max-width: 320px;
}
.qr-loading { color: #555; text-align: center; }
.hint-muted { color: var(--color-gray-500, #666); font-size: .85rem; margin-top: .5rem; text-align: center; }
.hint { color: var(--color-gray-400, #aaa); font-size: .9rem; margin: 0 0 .75rem; }

.btn-primary { background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; padding: .55rem 1rem; border-radius: 8px; cursor: pointer; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-danger { background: rgba(220,38,38,.15); border: 1px solid rgba(220,38,38,.4); color: #fca5a5; padding: .5rem 1rem; border-radius: 8px; cursor: pointer; }
.btn-danger:hover:not(:disabled) { background: rgba(220,38,38,.25); }
.btn-mini-danger { background: transparent; border: 1px solid rgba(220,38,38,.3); color: #fca5a5; padding: .25rem .55rem; border-radius: 6px; font-size: .78rem; cursor: pointer; margin-left: auto; }

.token-display { margin-top: .75rem; padding: .75rem; background: rgba(255,255,255,.04); border-radius: 8px; }
.token-display p { margin: .25rem 0; color: var(--color-gray-300, #ccc); font-size: .9rem; }
.token-code { display: block; padding: .5rem .65rem; background: rgba(0,0,0,.3); border-radius: 6px; font-family: ui-monospace, monospace; color: #6ee7b7; font-size: .95rem; }

.bindings-list { list-style: none; padding: 0; margin: 0; }
.bindings-list li { display: flex; align-items: center; padding: .5rem 0; border-bottom: 1px solid rgba(255,255,255,.05); }
.bindings-list li:last-child { border-bottom: none; }

.ok-msg { color: #6ee7b7; }
.error { color: #fca5a5; margin-top: .5rem; font-size: .9rem; }

.group-card { border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: .9rem 1rem; margin-top: .75rem; display: grid; gap: .6rem; }
.group-head { display: flex; align-items: center; justify-content: space-between; }
.group-name { font-weight: 600; color: #d1fae5; }
.field { display: grid; gap: .3rem; }
.field-label { color: var(--color-gray-400, #aaa); font-size: .82rem; }
.field-input { background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; padding: .45rem .6rem; color: #fff; font-size: .9rem; }
.perm-matrix { display: grid; gap: .4rem; }
.perm-row { display: flex; align-items: center; gap: .6rem; }
.perm-key { font-family: ui-monospace, monospace; color: #6ee7b7; min-width: 78px; font-size: .85rem; }
.perm-input { flex: 1; }
.group-actions { display: flex; align-items: center; gap: .75rem; margin-top: .25rem; }
.saved-msg { color: #6ee7b7; font-size: .85rem; }

.btn-mini { background: transparent; border: 1px solid rgba(110,231,183,.3); color: #6ee7b7; padding: .25rem .6rem; border-radius: 6px; font-size: .78rem; cursor: pointer; }
.btn-mini:disabled { opacity: .5; cursor: default; }
.members-block { display: grid; gap: .5rem; border-top: 1px dashed rgba(255,255,255,.1); padding-top: .6rem; }
.members-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.members-table { display: grid; gap: .2rem; overflow-x: auto; }
.members-row { display: grid; grid-template-columns: minmax(140px, 1fr) repeat(6, 48px); align-items: center; gap: .2rem; padding: .2rem 0; }
.members-header { color: var(--color-gray-400, #aaa); font-size: .72rem; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,.08); }
.m-name { font-size: .84rem; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-col { display: flex; align-items: center; justify-content: center; font-size: .72rem; color: #9ca3af; }
.m-col input[type="checkbox"] { cursor: pointer; }
</style>
