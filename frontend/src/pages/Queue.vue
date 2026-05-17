<template>
  <div class="queue-page">
    <header class="page-head">
      <div>
        <h1>Queue de tasks</h1>
        <p class="subtitle">Snapshot global + per-provider. Itens pending aguardam slot livre; running estão em execução.</p>
      </div>
      <button class="btn-refresh" :disabled="loading" @click="load">
        <span v-if="loading" class="spinner-sm"></span> ↻ Atualizar
      </button>
    </header>

    <div v-if="error" class="state error">⚠️ {{ error }}</div>

    <template v-else-if="snapshot">
      <section class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">Running</span>
          <span class="kpi-val">{{ snapshot.running }} / {{ snapshot.capacity }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Pending</span>
          <span class="kpi-val">{{ snapshot.pending }}</span>
        </div>
        <div
          v-for="(stats, prov) in snapshot.byProvider"
          :key="prov"
          class="kpi kpi-provider"
        >
          <span class="kpi-label">{{ prov }}</span>
          <span class="kpi-val">{{ stats.running }} / {{ stats.cap }}</span>
        </div>
      </section>

      <section class="items">
        <h2>Items</h2>
        <table v-if="snapshot.items.length > 0" class="queue-table">
          <thead>
            <tr>
              <th>id</th>
              <th>status</th>
              <th>priority</th>
              <th>provider</th>
              <th>description</th>
              <th>waited</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in snapshot.items" :key="it.id">
              <td><code>{{ it.id }}</code></td>
              <td>
                <span class="status-badge" :class="`status-${it.status}`">{{ it.status }}</span>
              </td>
              <td>{{ it.priority }}</td>
              <td>
                <span v-if="it.provider" class="provider-chip">{{ it.provider }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="desc" :title="it.description">{{ it.description }}</td>
              <td><span class="muted">{{ formatMs(it.waitMs) }}</span></td>
              <td>
                <button
                  v-if="it.status === 'pending'"
                  class="btn-cancel"
                  @click="cancel(it.id)"
                  :disabled="cancelling === it.id"
                >cancelar</button>
                <router-link v-if="it.taskId" :to="`/tasks/${it.taskId}`" class="link">task →</router-link>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">Queue vazia.</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

type QueueItem = {
  id: string
  taskId?: string
  provider?: string
  description: string
  priority: 'low' | 'normal' | 'high'
  status: 'pending' | 'running'
  enqueuedAt: string
  startedAt?: string
  waitMs?: number
}
type QueueSnapshot = {
  running: number
  capacity: number
  pending: number
  byProvider: Record<string, { running: number; cap: number }>
  items: QueueItem[]
}

const snapshot = ref<QueueSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const cancelling = ref<string | null>(null)
let pollTimer: number | null = null

const load = async () => {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/queue', { credentials: 'include' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    snapshot.value = await res.json()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const cancel = async (id: string) => {
  cancelling.value = id
  try {
    await fetch(`/api/queue/${id}`, { method: 'DELETE', credentials: 'include' })
    await load()
  } finally {
    cancelling.value = null
  }
}

const formatMs = (ms?: number): string => {
  if (!ms || ms < 1000) return `${ms ?? 0}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

onMounted(() => {
  load()
  // auto-refresh a cada 5s pra refletir queue ao vivo
  pollTimer = window.setInterval(load, 5000)
})
onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
})
</script>

<style scoped>
.queue-page { padding: 1.75rem 2rem; display: flex; flex-direction: column; gap: 1.25rem; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.page-head h1 { margin: 0 0 .3rem; font-size: 1.5rem; color: var(--text, #fff); }
.subtitle { margin: 0; color: var(--text-secondary, #888); font-size: .85rem; max-width: 600px; }

.btn-refresh {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  color: var(--text, #fff);
  padding: .35rem .8rem;
  font-size: .85rem;
  cursor: pointer;
}
.btn-refresh:hover { border-color: var(--primary, #6c5ce7); }
.btn-refresh:disabled { opacity: .5; cursor: wait; }

.state.error { color: #ff6b6b; padding: 1rem; background: rgba(255,107,107,.08); border-radius: 8px; }

.kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: .75rem; }
.kpi {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-radius: 10px;
  padding: .8rem 1rem;
  display: flex; flex-direction: column; gap: .2rem;
}
.kpi-provider { border-color: var(--primary, #6c5ce7); }
.kpi-label {
  font-size: .65rem; text-transform: uppercase; letter-spacing: .8px;
  color: var(--text-secondary, #888); font-weight: 600;
}
.kpi-val { font-size: 1.3rem; font-weight: 600; color: var(--text, #fff); font-family: ui-monospace, monospace; }

.items h2 { font-size: 1rem; color: var(--text-secondary, #aaa); margin: .5rem 0 .5rem; font-weight: 600; }
.empty { color: var(--text-secondary, #888); font-style: italic; }
.queue-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
.queue-table th, .queue-table td {
  text-align: left; padding: .5rem .75rem;
  border-bottom: 1px solid var(--border, #2a2a3e);
}
.queue-table th { color: var(--text-secondary, #888); font-weight: 500; font-size: .7rem; text-transform: uppercase; }
.queue-table tr:hover { background: var(--bg-secondary, #1a1a2e); }
.queue-table .desc { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-badge {
  padding: .15rem .55rem; border-radius: 999px; font-size: .7rem;
  font-weight: 600; text-transform: uppercase;
}
.status-pending { background: #f7b731; color: #1a1a2e; }
.status-running { background: #00b894; color: #fff; }
.provider-chip { background: var(--primary, #6c5ce7); color: #fff; padding: .1rem .45rem; border-radius: 4px; font-size: .7rem; font-family: ui-monospace, monospace; }
.muted { color: var(--text-secondary, #888); }
.btn-cancel { background: transparent; border: 1px solid #ff6b6b; color: #ff6b6b; border-radius: 4px; padding: .15rem .5rem; cursor: pointer; font-size: .75rem; margin-right: .5rem; }
.btn-cancel:hover { background: rgba(255,107,107,.1); }
.btn-cancel:disabled { opacity: .5; cursor: wait; }
.link { color: var(--primary, #6c5ce7); font-size: .8rem; text-decoration: none; }
.link:hover { text-decoration: underline; }
.spinner-sm { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border, #333); border-top-color: var(--primary, #6c5ce7); border-radius: 50%; animation: sp .7s linear infinite; margin-right: .25rem; vertical-align: middle; }
@keyframes sp { to { transform: rotate(360deg); } }
</style>
