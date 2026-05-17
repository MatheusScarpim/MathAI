<template>
  <div class="metrics-page">
    <header class="page-head">
      <div>
        <h1>Qualidade do orquestrador</h1>
        <p class="subtitle">Métricas agregadas de tasks, retry, custo e providers.</p>
      </div>
      <div class="window-picker">
        <label>Janela:</label>
        <select v-model="window" @change="load">
          <option value="24h">24h</option>
          <option value="7d">7d</option>
          <option value="14d">14d</option>
          <option value="30d">30d</option>
        </select>
        <button class="btn-refresh" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner-sm"></span>
          ↻ Atualizar
        </button>
      </div>
    </header>

    <div v-if="loading && !data" class="state">
      <div class="spinner"></div>
      <p>Carregando métricas...</p>
    </div>

    <div v-else-if="error" class="state error">
      <p>⚠️ {{ error }}</p>
    </div>

    <template v-else-if="data">
      <!-- KPIs -->
      <section class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">Total de tasks</span>
          <span class="kpi-val">{{ data.tasks.total }}</span>
          <span class="kpi-sub">janela {{ data.windowDays }}d</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Taxa de sucesso</span>
          <span class="kpi-val" :class="rateClass(data.tasks.successRate, 0.7)">
            {{ pct(data.tasks.successRate) }}
          </span>
          <span class="kpi-sub">{{ data.tasks.completed }}/{{ data.tasks.total }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Taxa de orphan</span>
          <span class="kpi-val" :class="rateClass(1 - data.tasks.orphanRate, 0.95)">
            {{ pct(data.tasks.orphanRate) }}
          </span>
          <span class="kpi-sub">{{ data.tasks.orphaned }} task(s) órfã(s)</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Taxa de replan</span>
          <span class="kpi-val">{{ pct(data.tasks.replanRate) }}</span>
          <span class="kpi-sub">{{ data.tasks.replanned }} replanejada(s)</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Duração média</span>
          <span class="kpi-val">{{ formatDuration(data.tasks.avgDurationMs) }}</span>
          <span class="kpi-sub">createdAt → completedAt</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Sucesso de subtask</span>
          <span class="kpi-val" :class="rateClass(data.subtasks.successRate, 0.8)">
            {{ pct(data.subtasks.successRate) }}
          </span>
          <span class="kpi-sub">{{ data.subtasks.total }} subtask(s)</span>
        </div>
      </section>

      <!-- By Provider -->
      <section v-if="data.byProvider.length" class="card-section">
        <h2>Por provider</h2>
        <table class="m-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th class="num">Chamadas</th>
              <th class="num">Falhas</th>
              <th class="num">Taxa falha</th>
              <th class="num">Custo (USD)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in data.byProvider" :key="p.provider">
              <td><code>{{ p.provider }}</code></td>
              <td class="num">{{ p.calls }}</td>
              <td class="num">{{ p.failures }}</td>
              <td class="num" :class="rateClass(1 - p.failureRate, 0.9)">{{ pct(p.failureRate) }}</td>
              <td class="num">${{ formatCost(p.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- By Agent x Provider -->
      <section v-if="data.byAgentProvider.length" class="card-section">
        <h2>Por agente × provider</h2>
        <table class="m-table">
          <thead>
            <tr>
              <th>Agente</th>
              <th>Provider</th>
              <th class="num">Chamadas</th>
              <th class="num">Tokens in</th>
              <th class="num">Tokens out</th>
              <th class="num">Custo (USD)</th>
              <th class="num">Tempo médio</th>
              <th class="num">Falha</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in data.byAgentProvider" :key="i">
              <td>{{ r.agent }}</td>
              <td><code>{{ r.provider }}</code></td>
              <td class="num">{{ r.calls }}</td>
              <td class="num">{{ fmtN(r.tokensIn) }}</td>
              <td class="num">{{ fmtN(r.tokensOut) }}</td>
              <td class="num">${{ formatCost(r.costUsd) }}</td>
              <td class="num">{{ formatDuration(r.avgDurationMs) }}</td>
              <td class="num" :class="rateClass(1 - r.failureRate, 0.9)">{{ pct(r.failureRate) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Top errors -->
      <section v-if="data.topErrors.length" class="card-section">
        <h2>Erros mais frequentes</h2>
        <ol class="err-list">
          <li v-for="(e, i) in data.topErrors" :key="i">
            <span class="err-count">×{{ e.count }}</span>
            <code class="err-msg">{{ e.message }}</code>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

type MetricsResponse = {
  since: string
  windowDays: number
  tasks: {
    total: number
    completed: number
    failed: number
    orphaned: number
    cancelled: number
    replanned: number
    successRate: number
    orphanRate: number
    replanRate: number
    avgDurationMs: number
  }
  subtasks: {
    total: number
    failed: number
    cancelled: number
    successRate: number
  }
  byAgentProvider: Array<{
    agent: string
    provider: string
    calls: number
    failures: number
    failureRate: number
    tokensIn: number
    tokensOut: number
    costUsd: number
    avgDurationMs: number
  }>
  byProvider: Array<{
    provider: string
    calls: number
    failures: number
    failureRate: number
    costUsd: number
  }>
  topErrors: Array<{ message: string; count: number }>
}

const window = ref<'24h' | '7d' | '14d' | '30d'>('7d')
const data = ref<MetricsResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const load = async () => {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`/api/metrics/quality?since=${window.value}`, { credentials: 'include' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = await res.json()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

const fmtN = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const formatCost = (usd: number): string => {
  if (usd >= 1) return usd.toFixed(2)
  if (usd >= 0.01) return usd.toFixed(3)
  return usd.toFixed(4)
}

const formatDuration = (ms: number): string => {
  if (!ms || ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS > 0 ? `${m}m${remS}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

const rateClass = (rate: number, goodThreshold: number): string => {
  if (rate >= goodThreshold) return 'rate-good'
  if (rate >= goodThreshold - 0.2) return 'rate-mid'
  return 'rate-bad'
}

onMounted(load)
</script>

<style scoped>
.metrics-page {
  padding: 1.75rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.page-head h1 { margin: 0 0 .3rem; font-size: 1.5rem; color: var(--text, #fff); }
.subtitle { margin: 0; color: var(--text-secondary, #888); font-size: .85rem; }

.window-picker {
  display: flex;
  align-items: center;
  gap: .5rem;
  font-size: .85rem;
  color: var(--text-secondary, #aaa);
}
.window-picker select {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  color: var(--text, #fff);
  padding: .35rem .6rem;
  font-size: .85rem;
}
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

.state { text-align: center; padding: 3rem 1rem; color: var(--text-secondary, #888); }
.state.error { color: #ff6b6b; }
.spinner { display: inline-block; width: 28px; height: 28px; border: 2px solid var(--border, #333); border-top-color: var(--primary, #6c5ce7); border-radius: 50%; animation: sp .7s linear infinite; margin-bottom: .75rem; }
.spinner-sm { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border, #333); border-top-color: var(--primary, #6c5ce7); border-radius: 50%; animation: sp .7s linear infinite; margin-right: .25rem; vertical-align: middle; }
@keyframes sp { to { transform: rotate(360deg); } }

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}
.kpi {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-radius: 10px;
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: .25rem;
}
.kpi-label {
  font-size: .7rem;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--text-secondary, #888);
  font-weight: 600;
}
.kpi-val {
  font-size: 1.6rem;
  font-weight: 600;
  color: var(--text, #fff);
  font-family: ui-monospace, monospace;
}
.kpi-val.rate-good { color: #00b894; }
.kpi-val.rate-mid { color: #fdcb6e; }
.kpi-val.rate-bad { color: #ff6b6b; }
.kpi-sub { font-size: .72rem; color: var(--text-secondary, #888); }

.card-section {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border, #333);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
}
.card-section h2 {
  margin: 0 0 1rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text, #fff);
}

.m-table {
  width: 100%;
  border-collapse: collapse;
  font-size: .85rem;
}
.m-table thead th {
  text-align: left;
  font-weight: 600;
  font-size: .72rem;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--text-secondary, #888);
  padding: .5rem .6rem .5rem 0;
  border-bottom: 1px solid var(--border, #333);
}
.m-table thead th.num { text-align: right; }
.m-table tbody td {
  padding: .55rem .6rem .55rem 0;
  border-bottom: 1px solid rgba(255,255,255,.04);
  color: var(--text, #ddd);
}
.m-table tbody td.num {
  text-align: right;
  font-family: ui-monospace, monospace;
}
.m-table tbody tr:last-child td { border-bottom: none; }
.m-table code {
  font-size: .8rem;
  background: rgba(255,255,255,.04);
  padding: .1rem .35rem;
  border-radius: 3px;
}
.rate-good { color: #00b894; }
.rate-mid { color: #fdcb6e; }
.rate-bad { color: #ff6b6b; }

.err-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: .5rem;
}
.err-list li {
  display: flex;
  align-items: center;
  gap: .75rem;
  font-size: .82rem;
  color: var(--text, #ddd);
}
.err-count {
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: #ff6b6b;
  min-width: 3rem;
}
.err-msg {
  background: rgba(255,107,107,.05);
  border: 1px solid rgba(255,107,107,.2);
  padding: .25rem .5rem;
  border-radius: 4px;
  font-size: .78rem;
  flex: 1;
  word-break: break-all;
}
</style>
