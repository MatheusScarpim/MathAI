<template>
  <div class="dashboard-page">

    <!-- Header -->
    <header class="page-header">
      <div class="header-left">
        <h1>Dashboard</h1>
        <p class="subtitle">Métricas de uso</p>
      </div>
      <div class="period-selector">
        <button
          v-for="p in periods"
          :key="p.value"
          class="period-btn"
          :class="{ active: selectedDays === p.value }"
          @click="setDays(p.value)"
        >
          {{ p.label }}
        </button>
      </div>
    </header>

    <!-- Loading skeleton -->
    <template v-if="loading">
      <div class="stats-grid">
        <div v-for="i in 4" :key="i" class="stat-card skeleton"></div>
      </div>
      <div class="chart-card skeleton skeleton-chart"></div>
      <div class="bottom-grid">
        <div class="glass-card skeleton skeleton-half"></div>
        <div class="glass-card skeleton skeleton-half"></div>
      </div>
    </template>

    <!-- Error state -->
    <div v-else-if="error" class="error-banner">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ error }}</span>
      <button class="retry-btn" @click="loadStats">Tentar novamente</button>
    </div>

    <template v-else-if="stats">

      <!-- Empty state -->
      <div v-if="stats.totalQueries === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
        </div>
        <h3>Nenhuma query registrada ainda</h3>
        <p>Faça sua primeira pergunta para ver as métricas aparecerem aqui.</p>
      </div>

      <template v-else>

        <!-- Stats Cards -->
        <div class="stats-grid">

          <!-- Total Queries -->
          <div class="stat-card stat-enter" style="--delay:0ms">
            <div class="stat-icon stat-icon-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ stats.totalQueries.toLocaleString('pt-BR') }}</div>
              <div class="stat-label">Total de Queries</div>
            </div>
            <div class="stat-accent-bar"></div>
          </div>

          <!-- Success Rate -->
          <div class="stat-card stat-enter" style="--delay:80ms">
            <div class="success-ring-wrap">
              <svg class="success-ring" viewBox="0 0 44 44" width="56" height="56">
                <circle class="ring-track" cx="22" cy="22" r="18" />
                <circle
                  class="ring-fill"
                  :class="successRingColor"
                  cx="22" cy="22" r="18"
                  :stroke-dasharray="`${(stats.successRate / 100) * 113.1} 113.1`"
                  transform="rotate(-90 22 22)"
                />
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value" :class="successRingColor === 'ring-green' ? 'val-green' : successRingColor === 'ring-yellow' ? 'val-yellow' : 'val-red'">
                {{ stats.successRate.toFixed(1) }}<span class="stat-unit">%</span>
              </div>
              <div class="stat-label">Taxa de Sucesso</div>
              <div class="stat-sub" :class="successRingColor === 'ring-green' ? 'sub-green' : 'sub-red'">
                {{ stats.successRate >= 90 ? 'Excelente' : stats.successRate >= 70 ? 'Regular' : 'Crítico' }}
              </div>
            </div>
          </div>

          <!-- Cache Hit Rate -->
          <div class="stat-card stat-card-cyan stat-enter" style="--delay:160ms">
            <div class="stat-icon stat-icon-cyan">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value cyan-val">{{ stats.cacheHitRate.toFixed(1) }}<span class="stat-unit">%</span></div>
              <div class="stat-label">Cache Hit Rate</div>
              <div class="cache-bar-wrap">
                <div class="cache-bar-fill" :style="{ width: stats.cacheHitRate + '%' }"></div>
              </div>
            </div>
          </div>

          <!-- Avg Response Time -->
          <div class="stat-card stat-enter" style="--delay:240ms">
            <div class="stat-icon" :class="avgTimeIconClass">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value" :class="avgTimeClass">
                {{ formatMs(stats.avgElapsedMs) }}<span class="stat-unit">ms</span>
              </div>
              <div class="stat-label">Tempo Médio</div>
              <div class="stat-sub" :class="avgTimeSubClass">
                {{ stats.avgElapsedMs < 500 ? 'Rápido' : stats.avgElapsedMs < 2000 ? 'Normal' : 'Lento' }}
              </div>
            </div>
          </div>

        </div>

        <!-- Queries Per Day Chart -->
        <div class="chart-card glass-card">
          <div class="chart-header">
            <span class="chart-title">Queries por dia</span>
            <div class="chart-legend">
              <span class="legend-item">
                <span class="legend-dot dot-queries"></span>Queries
              </span>
              <span class="legend-item" v-if="hasErrors">
                <span class="legend-dot dot-errors"></span>Erros
              </span>
            </div>
          </div>
          <BarChart :data="chartData" title="" :height="200" />
          <div v-if="hasErrors" class="error-overlay-chart">
            <div
              v-for="(d, i) in stats.queriesPerDay"
              :key="i"
              class="error-bar-wrap"
              :title="`${d.errors} erro(s) em ${d.date.slice(5)}`"
            >
              <div
                v-if="d.errors > 0"
                class="error-bar"
                :style="{ height: Math.min((d.errors / maxDayCount) * 100, 100) + '%' }"
              ></div>
            </div>
          </div>
        </div>

        <!-- Bottom grid -->
        <div class="bottom-grid">

          <!-- Top Errors -->
          <div class="glass-card bottom-card">
            <h3 class="card-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Erros mais frequentes
            </h3>

            <div v-if="!topErrors.length" class="success-notice">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Nenhum erro encontrado
            </div>

            <ul v-else class="error-list">
              <li v-for="(err, idx) in topErrors" :key="idx" class="error-item">
                <span class="error-rank">{{ idx + 1 }}</span>
                <span class="error-msg">{{ err.message }}</span>
                <span class="error-count">{{ err.count }}×</span>
              </li>
            </ul>
          </div>

          <!-- Token Usage -->
          <div class="glass-card bottom-card">
            <h3 class="card-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              Consumo de Tokens
            </h3>

            <!-- Total overview -->
            <div class="token-total-row">
              <div class="token-total-num">{{ stats.totalTokens.total.toLocaleString('pt-BR') }}</div>
              <div class="token-total-sub">tokens totais no período</div>
            </div>

            <!-- Input / Output split bar -->
            <div class="token-split-bar" v-if="stats.totalTokens.total > 0">
              <div
                class="split-seg split-input"
                :style="{ width: ((stats.totalTokens.input / stats.totalTokens.total) * 100) + '%' }"
                :title="`Input: ${stats.totalTokens.input.toLocaleString('pt-BR')}`"
              ></div>
              <div
                class="split-seg split-output"
                :style="{ width: ((stats.totalTokens.output / stats.totalTokens.total) * 100) + '%' }"
                :title="`Output: ${stats.totalTokens.output.toLocaleString('pt-BR')}`"
              ></div>
            </div>
            <div class="split-legend">
              <span><span class="split-dot dot-input"></span>Input: {{ stats.totalTokens.input.toLocaleString('pt-BR') }}</span>
              <span><span class="split-dot dot-output"></span>Output: {{ stats.totalTokens.output.toLocaleString('pt-BR') }}</span>
            </div>

            <!-- Breakdown by step -->
            <div class="breakdown-title">Por etapa</div>
            <div class="breakdown-list">

              <div class="breakdown-row">
                <div class="breakdown-label">
                  <span class="breakdown-dot dot-sql"></span>
                  <span>Geração SQL</span>
                </div>
                <div class="breakdown-right">
                  <span class="breakdown-val">{{ (stats.tokenBreakdown?.sql?.total ?? 0).toLocaleString('pt-BR') }}</span>
                  <div class="breakdown-bar-wrap">
                    <div
                      class="breakdown-bar bar-sql"
                      :style="{ width: tokenPct(stats.tokenBreakdown?.sql?.total ?? 0) + '%' }"
                    ></div>
                  </div>
                </div>
              </div>

              <div class="breakdown-row">
                <div class="breakdown-label">
                  <span class="breakdown-dot dot-summary"></span>
                  <span>Resumo / Análise</span>
                </div>
                <div class="breakdown-right">
                  <span class="breakdown-val">{{ (stats.tokenBreakdown?.summary?.total ?? 0).toLocaleString('pt-BR') }}</span>
                  <div class="breakdown-bar-wrap">
                    <div
                      class="breakdown-bar bar-summary"
                      :style="{ width: tokenPct(stats.tokenBreakdown?.summary?.total ?? 0) + '%' }"
                    ></div>
                  </div>
                </div>
              </div>

            </div>

            <!-- By environment -->
            <template v-if="stats.environmentBreakdown.length > 0">
              <div class="breakdown-title" style="margin-top:1.25rem">Por ambiente</div>
              <ul class="env-breakdown-list">
                <li v-for="env in stats.environmentBreakdown" :key="env.envId" class="env-breakdown-item">
                  <span class="env-id">{{ env.envId || 'default' }}</span>
                  <span class="env-count">{{ env.count.toLocaleString('pt-BR') }} queries</span>
                </li>
              </ul>
            </template>

          </div>

        </div>

      </template>
    </template>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, onMounted, type Ref } from 'vue'
import { api } from '../services/api'
import BarChart from '../components/BarChart.vue'
import type { StatsResponse } from '../types'

const selectedEnvironmentId = inject<Ref<string | undefined>>('selectedEnvironmentId')
const environmentVersion = inject<Ref<number>>('environmentVersion')

const stats = ref<StatsResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const selectedDays = ref(30)

const periods = [
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 }
]

const chartData = computed(() =>
  (stats.value?.queriesPerDay ?? []).map((d) => ({
    category: d.date.slice(5),
    value: d.count
  }))
)

const topErrors = computed(() => (stats.value?.topErrors ?? []).slice(0, 10))

const hasErrors = computed(() =>
  (stats.value?.queriesPerDay ?? []).some(d => d.errors > 0)
)

const maxDayCount = computed(() =>
  Math.max(...(stats.value?.queriesPerDay ?? []).map(d => d.count), 1)
)

const successRingColor = computed(() => {
  const rate = stats.value?.successRate ?? 0
  if (rate >= 90) return 'ring-green'
  if (rate >= 70) return 'ring-yellow'
  return 'ring-red'
})

const avgTimeClass = computed(() => {
  const ms = stats.value?.avgElapsedMs ?? 0
  if (ms < 500) return 'val-green'
  if (ms < 2000) return 'val-yellow'
  return 'val-red'
})

const avgTimeSubClass = computed(() => {
  const ms = stats.value?.avgElapsedMs ?? 0
  if (ms < 500) return 'sub-green'
  if (ms < 2000) return 'sub-yellow'
  return 'sub-red'
})

const avgTimeIconClass = computed(() => {
  const ms = stats.value?.avgElapsedMs ?? 0
  if (ms < 500) return 'stat-icon-accent'
  if (ms < 2000) return 'stat-icon-yellow'
  return 'stat-icon-red'
})

function tokenPct(val: number): number {
  const total = stats.value?.totalTokens.total ?? 0
  if (!total) return 0
  return Math.round((val / total) * 100)
}

function formatMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 'k' : Math.round(ms).toString()
}

async function loadStats(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    stats.value = await api.getStats(selectedEnvironmentId?.value, selectedDays.value)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Erro ao carregar métricas'
  } finally {
    loading.value = false
  }
}

function setDays(days: number): void {
  selectedDays.value = days
  void loadStats()
}

onMounted(() => { void loadStats() })
watch(() => environmentVersion?.value, () => { void loadStats() })
</script>

<style scoped>
.dashboard-page {
  padding: 2rem 2rem 3rem;
  max-width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ──────────────────────────────────────────────────────────────────── */

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.page-header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-gray-50);
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--color-gray-50), var(--color-gray-300));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  font-size: 0.875rem;
  color: var(--color-gray-500);
  margin-top: 0.2rem;
}

.period-selector {
  display: flex;
  gap: 4px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 4px;
}

.period-btn {
  padding: 0.35rem 0.9rem;
  border: none;
  border-radius: 7px;
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  color: var(--color-gray-400);
  background: transparent;
  transition: all 0.2s ease;
}

.period-btn:hover { color: var(--color-gray-200); background: rgba(255,255,255,0.05); }

.period-btn.active {
  background: var(--color-accent);
  color: #fff;
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
}

/* ── Glass card base ─────────────────────────────────────────────────────────── */

.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius-lg);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.glass-card:hover { border-color: var(--glass-border-hover); }

/* ── Stats grid ──────────────────────────────────────────────────────────────── */

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}

.stat-card {
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius-lg);
  padding: 1.5rem 1.375rem;
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  min-height: 120px;
  transition: all 0.25s ease;
  position: relative;
  overflow: hidden;
  animation: statEnter 0.4s ease both;
  animation-delay: var(--delay, 0ms);
}

@keyframes statEnter {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

.stat-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.025) 0%, transparent 60%);
  pointer-events: none;
}

.stat-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.stat-accent-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--color-accent), var(--color-cyan));
  opacity: 0.4;
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon-accent {
  background: rgba(16, 185, 129, 0.12);
  color: var(--color-accent-light);
  box-shadow: 0 0 14px rgba(16, 185, 129, 0.15);
}

.stat-icon-cyan {
  background: rgba(34, 211, 238, 0.1);
  color: var(--color-cyan);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.12);
}

.stat-icon-yellow {
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
}

.stat-icon-red {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.stat-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.stat-value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-gray-50);
  line-height: 1.1;
  letter-spacing: -0.03em;
}

.stat-unit {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-gray-500);
  margin-left: 2px;
}

.stat-label {
  font-size: 0.75rem;
  color: var(--color-gray-500);
  font-weight: 450;
}

.stat-sub {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  margin-top: 0.15rem;
}

.val-green  { color: var(--color-accent-light); }
.val-yellow { color: #fbbf24; }
.val-red    { color: #f87171; }
.cyan-val   { color: var(--color-cyan); }

.sub-green  { color: rgba(16,185,129,0.7); }
.sub-yellow { color: rgba(245,158,11,0.7); }
.sub-red    { color: rgba(239,68,68,0.7); }

/* ── Success ring ────────────────────────────────────────────────────────────── */

.success-ring-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
}

.success-ring { position: absolute; inset: 0; }

.ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.07);
  stroke-width: 3.5;
}

.ring-fill {
  fill: none;
  stroke-width: 3.5;
  stroke-linecap: round;
  transition: stroke-dasharray 0.8s cubic-bezier(0.4, 0, 0.2, 1);
}

.ring-green  { stroke: var(--color-accent); }
.ring-yellow { stroke: #f59e0b; }
.ring-red    { stroke: #ef4444; }

/* ── Cache bar ───────────────────────────────────────────────────────────────── */

.cache-bar-wrap {
  height: 3px;
  background: rgba(34, 211, 238, 0.1);
  border-radius: 999px;
  margin-top: 0.5rem;
  overflow: hidden;
}

.cache-bar-fill {
  height: 100%;
  background: var(--color-cyan);
  border-radius: 999px;
  transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 0 6px rgba(34, 211, 238, 0.4);
}

/* ── Chart card ──────────────────────────────────────────────────────────────── */

.chart-card {
  padding: 1.5rem;
  position: relative;
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.chart-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-gray-300);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.chart-legend {
  display: flex;
  gap: 1rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--color-gray-500);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-queries { background: var(--color-accent); }
.dot-errors  { background: #ef4444; }

/* ── Bottom grid ─────────────────────────────────────────────────────────────── */

.bottom-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.bottom-card { padding: 1.5rem; }

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-gray-200);
  margin-bottom: 1.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.card-title svg { color: var(--color-gray-500); flex-shrink: 0; }

/* ── Errors ──────────────────────────────────────────────────────────────────── */

.success-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-accent);
  padding: 0.75rem 1rem;
  background: rgba(16, 185, 129, 0.07);
  border: 1px solid rgba(16, 185, 129, 0.15);
  border-radius: 10px;
}

.error-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  max-height: 280px;
  overflow-y: auto;
}

.error-item {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  background: rgba(239, 68, 68, 0.04);
  border: 1px solid rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  transition: background 0.2s;
}

.error-item:hover { background: rgba(239, 68, 68, 0.08); }

.error-rank {
  font-size: 0.7rem;
  font-weight: 700;
  color: rgba(239, 68, 68, 0.5);
  width: 16px;
  flex-shrink: 0;
  padding-top: 1px;
}

.error-msg {
  font-size: 0.8rem;
  color: var(--color-gray-300);
  line-height: 1.4;
  flex: 1;
  word-break: break-word;
  font-family: var(--font-mono);
}

.error-count {
  font-size: 0.75rem;
  font-weight: 600;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
  border-radius: 20px;
  padding: 0.15rem 0.55rem;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Token usage ─────────────────────────────────────────────────────────────── */

.token-total-row {
  margin-bottom: 0.875rem;
}

.token-total-num {
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-gray-50);
  letter-spacing: -0.03em;
  line-height: 1;
}

.token-total-sub {
  font-size: 0.75rem;
  color: var(--color-gray-500);
  margin-top: 0.2rem;
}

.token-split-bar {
  display: flex;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  gap: 2px;
  margin-bottom: 0.5rem;
}

.split-seg {
  border-radius: 999px;
  transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: help;
}

.split-input  { background: var(--color-cyan); }
.split-output { background: var(--color-accent); }

.split-legend {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.split-legend span {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--color-gray-500);
  font-family: var(--font-mono);
}

.split-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-input  { background: var(--color-cyan); }
.dot-output { background: var(--color-accent); }

.breakdown-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--color-gray-600);
  font-weight: 600;
  margin-bottom: 0.625rem;
}

.breakdown-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.breakdown-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.breakdown-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--color-gray-400);
  flex-shrink: 0;
  min-width: 120px;
}

.breakdown-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-sql     { background: var(--color-cyan); }
.dot-summary { background: #a78bfa; }

.breakdown-right {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  justify-content: flex-end;
}

.breakdown-val {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-gray-300);
  font-family: var(--font-mono);
  min-width: 60px;
  text-align: right;
}

.breakdown-bar-wrap {
  width: 80px;
  height: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  overflow: hidden;
}

.breakdown-bar {
  height: 100%;
  border-radius: 999px;
  transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
}

.bar-sql     { background: var(--color-cyan); box-shadow: 0 0 6px rgba(34,211,238,0.3); }
.bar-summary { background: #a78bfa; box-shadow: 0 0 6px rgba(167,139,250,0.3); }

/* ── Env breakdown ───────────────────────────────────────────────────────────── */

.env-breakdown-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 120px;
  overflow-y: auto;
}

.env-breakdown-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.45rem 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  font-size: 0.8rem;
  transition: background 0.2s;
}

.env-breakdown-item:hover { background: rgba(255,255,255,0.05); }

.env-id {
  color: var(--color-cyan);
  font-family: var(--font-mono);
  font-size: 0.78rem;
}

.env-count { color: var(--color-gray-500); font-size: 0.75rem; }

/* ── Error banner ────────────────────────────────────────────────────────────── */

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: rgba(239, 68, 68, 0.07);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: var(--border-radius);
  color: #fca5a5;
  font-size: 0.875rem;
}

.retry-btn {
  margin-left: auto;
  padding: 0.35rem 0.9rem;
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 7px;
  background: rgba(239, 68, 68, 0.1);
  color: #fca5a5;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}

.retry-btn:hover { background: rgba(239, 68, 68, 0.2); }

/* ── Empty state ─────────────────────────────────────────────────────────────── */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.875rem;
  padding: 5rem 2rem;
  text-align: center;
}

.empty-icon {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-gray-600);
  margin-bottom: 0.5rem;
  animation: float 4s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-6px); }
}

.empty-state h3 { font-size: 1.1rem; color: var(--color-gray-300); }
.empty-state p  { font-size: 0.875rem; color: var(--color-gray-500); max-width: 320px; }

/* ── Skeleton ────────────────────────────────────────────────────────────────── */

.skeleton {
  position: relative;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04) !important;
  border: 1px solid var(--glass-border) !important;
}

.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}

@keyframes shimmer {
  0%   { background-position: -200% center; }
  100% { background-position:  200% center; }
}

.stat-card.skeleton { min-height: 120px; }
.skeleton-chart     { height: 240px; border-radius: var(--border-radius-lg); }
.skeleton-half      { height: 220px; border-radius: var(--border-radius-lg); }

/* ── Responsive ──────────────────────────────────────────────────────────────── */

@media (max-width: 1000px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 640px) {
  .dashboard-page { padding: 1.25rem 1rem 2rem; }
  .stats-grid     { grid-template-columns: 1fr 1fr; }
  .bottom-grid    { grid-template-columns: 1fr; }
  .page-header    { flex-direction: column; align-items: flex-start; }
}
</style>
