<template>
  <div class="dashboard-page">

    <!-- Header -->
    <header class="page-header">
      <div class="header-left">
        <h1>Dashboard</h1>
        <p class="subtitle">Metricas de uso</p>
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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ error }}</span>
      <button class="retry-btn" @click="loadStats">Tentar novamente</button>
    </div>

    <template v-else-if="stats">

      <!-- Empty state -->
      <div v-if="stats.totalQueries === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
        </div>
        <h3>Nenhuma query registrada ainda</h3>
        <p>Faça sua primeira pergunta para ver as metricas aparecerem aqui.</p>
      </div>

      <template v-else>

        <!-- Stats Cards -->
        <div class="stats-grid">

          <!-- Total Queries -->
          <div class="stat-card">
            <div class="stat-icon stat-icon-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ stats.totalQueries.toLocaleString() }}</div>
              <div class="stat-label">Total de Queries</div>
            </div>
          </div>

          <!-- Success Rate -->
          <div class="stat-card">
            <div class="success-ring-wrap">
              <svg class="success-ring" viewBox="0 0 44 44" width="56" height="56">
                <circle class="ring-track" cx="22" cy="22" r="18" />
                <circle
                  class="ring-fill"
                  :class="successRingColor"
                  cx="22" cy="22" r="18"
                  :stroke-dasharray="`${(stats.successRate / 100) * 113.1} 113.1`"
                  stroke-dashoffset="0"
                  transform="rotate(-90 22 22)"
                />
              </svg>
              <span class="ring-label" :class="successRingColor">{{ stats.successRate.toFixed(1) }}%</span>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ stats.successRate.toFixed(1) }}<span class="stat-unit">%</span></div>
              <div class="stat-label">Taxa de Sucesso</div>
            </div>
          </div>

          <!-- Cache Hit Rate -->
          <div class="stat-card stat-card-cyan">
            <div class="stat-icon stat-icon-cyan">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value cyan-val">{{ stats.cacheHitRate.toFixed(1) }}<span class="stat-unit">%</span></div>
              <div class="stat-label">Cache Hit Rate</div>
            </div>
          </div>

          <!-- Avg Response Time -->
          <div class="stat-card">
            <div class="stat-icon stat-icon-muted">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ formatMs(stats.avgElapsedMs) }}<span class="stat-unit">ms</span></div>
              <div class="stat-label">Tempo Medio</div>
            </div>
          </div>

        </div>

        <!-- Queries Per Day Chart -->
        <div class="chart-card glass-card">
          <BarChart
            :data="chartData"
            title="Queries por dia"
          />
        </div>

        <!-- Bottom two-column grid -->
        <div class="bottom-grid">

          <!-- Top Errors -->
          <div class="glass-card bottom-card">
            <h3 class="card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Erros mais frequentes
            </h3>

            <div v-if="!topErrors.length" class="success-notice">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Nenhum erro encontrado
            </div>

            <ul v-else class="error-list">
              <li v-for="(err, idx) in topErrors" :key="idx" class="error-item">
                <span class="error-msg">{{ err.message }}</span>
                <span class="error-count">{{ err.count }}</span>
              </li>
            </ul>
          </div>

          <!-- Token Usage -->
          <div class="glass-card bottom-card">
            <h3 class="card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4l3 3"/>
              </svg>
              Consumo de Tokens
            </h3>

            <div class="token-rows">
              <div class="token-row">
                <span class="token-label">Input</span>
                <span class="token-value">{{ stats.totalTokens.input.toLocaleString() }}</span>
              </div>
              <div class="token-row">
                <span class="token-label">Output</span>
                <span class="token-value">{{ stats.totalTokens.output.toLocaleString() }}</span>
              </div>
              <div class="token-divider"></div>
              <div class="token-row token-total">
                <span class="token-label">Total</span>
                <span class="token-value token-total-val">{{ stats.totalTokens.total.toLocaleString() }}</span>
              </div>
            </div>

            <template v-if="stats.environmentBreakdown.length > 0">
              <div class="env-breakdown-title">Por ambiente</div>
              <ul class="env-breakdown-list">
                <li v-for="env in stats.environmentBreakdown" :key="env.envId" class="env-breakdown-item">
                  <span class="env-id">{{ env.envId || 'default' }}</span>
                  <span class="env-count">{{ env.count.toLocaleString() }} queries</span>
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

// Environment awareness
const selectedEnvironmentId = inject<Ref<string | undefined>>('selectedEnvironmentId')
const environmentVersion = inject<Ref<number>>('environmentVersion')

// State
const stats = ref<StatsResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const selectedDays = ref(30)

const periods = [
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 }
]

// Computed
const chartData = computed(() =>
  (stats.value?.queriesPerDay ?? []).map((d: { date: string; count: number }) => ({
    category: d.date.slice(5),
    value: d.count
  }))
)

const topErrors = computed(() =>
  (stats.value?.topErrors ?? []).slice(0, 10)
)

const successRingColor = computed(() => {
  const rate = stats.value?.successRate ?? 0
  if (rate >= 90) return 'ring-green'
  if (rate >= 70) return 'ring-yellow'
  return 'ring-red'
})

// Helpers
function formatMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 'k' : Math.round(ms).toString()
}

// Data loading
async function loadStats(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    stats.value = await api.getStats(selectedEnvironmentId?.value, selectedDays.value)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Erro ao carregar metricas'
  } finally {
    loading.value = false
  }
}

function setDays(days: number): void {
  selectedDays.value = days
  void loadStats()
}

// Lifecycle
onMounted(() => { void loadStats() })

watch(
  () => environmentVersion?.value,
  () => { void loadStats() }
)
</script>

<style scoped>
.dashboard-page {
  padding: 2rem 2rem 3rem;
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ──────────── Header ──────────── */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.page-header h1 {
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-gray-50);
  letter-spacing: -0.02em;
  line-height: 1.2;
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
  font-family: var(--font-body);
}

.period-btn:hover {
  color: var(--color-gray-200);
  background: rgba(255, 255, 255, 0.05);
}

.period-btn.active {
  background: var(--color-accent);
  color: #fff;
  box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
}

/* ──────────── Glass card base ──────────── */
.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius-lg);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.glass-card:hover {
  border-color: var(--glass-border-hover);
}

/* ──────────── Stats grid ──────────── */
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
  padding: 1.375rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  min-height: 105px;
  transition: all 0.25s ease;
  position: relative;
  overflow: hidden;
}

.stat-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.02) 0%, transparent 60%);
  pointer-events: none;
}

.stat-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.stat-card-cyan:hover {
  box-shadow: var(--glow-cyan), var(--shadow-md);
}

.stat-icon {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon-accent {
  background: rgba(16, 185, 129, 0.12);
  color: var(--color-accent-light);
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.15);
}

.stat-icon-cyan {
  background: rgba(34, 211, 238, 0.1);
  color: var(--color-cyan);
  box-shadow: 0 0 12px rgba(34, 211, 238, 0.12);
}

.stat-icon-muted {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-gray-400);
}

.stat-body {
  flex: 1;
  min-width: 0;
}

.stat-value {
  font-family: var(--font-display);
  font-size: 1.65rem;
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
  margin-top: 0.25rem;
  font-weight: 450;
}

.cyan-val {
  color: var(--color-cyan);
}

/* ──────────── Success ring ──────────── */
.success-ring-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
}

.success-ring {
  position: absolute;
  inset: 0;
}

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

.ring-label {
  position: relative;
  font-size: 0;
  opacity: 0;
}

.ring-green { stroke: var(--color-accent); }
.ring-yellow { stroke: #f59e0b; }
.ring-red { stroke: #ef4444; }

/* ──────────── Chart card ──────────── */
.chart-card {
  padding: 1.5rem;
}

/* ──────────── Bottom grid ──────────── */
.bottom-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.bottom-card {
  padding: 1.5rem;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-gray-200);
  margin-bottom: 1.25rem;
}

.card-title svg {
  color: var(--color-gray-500);
  flex-shrink: 0;
}

/* ──────────── Errors ──────────── */
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
  gap: 0.5rem;
  max-height: 260px;
  overflow-y: auto;
}

.error-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  background: rgba(239, 68, 68, 0.04);
  border: 1px solid rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  transition: background 0.2s;
}

.error-item:hover {
  background: rgba(239, 68, 68, 0.08);
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

/* ──────────── Token usage ──────────── */
.token-rows {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  margin-bottom: 1.25rem;
}

.token-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.token-label {
  font-size: 0.82rem;
  color: var(--color-gray-500);
}

.token-value {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-gray-200);
  font-family: var(--font-mono);
}

.token-divider {
  height: 1px;
  background: var(--glass-border);
  margin: 0.25rem 0;
}

.token-total .token-label {
  color: var(--color-gray-300);
  font-weight: 600;
}

.token-total-val {
  color: var(--color-accent-light);
  font-size: 1rem;
}

.env-breakdown-title {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-gray-600);
  font-weight: 500;
  margin-bottom: 0.625rem;
}

.env-breakdown-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 140px;
  overflow-y: auto;
}

.env-breakdown-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.45rem 0.7rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 7px;
  font-size: 0.8rem;
}

.env-id {
  color: var(--color-cyan);
  font-family: var(--font-mono);
  font-size: 0.78rem;
}

.env-count {
  color: var(--color-gray-500);
  font-size: 0.75rem;
}

/* ──────────── Error banner ──────────── */
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
  font-family: var(--font-body);
}

.retry-btn:hover {
  background: rgba(239, 68, 68, 0.2);
}

/* ──────────── Empty state ──────────── */
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
}

.empty-state h3 {
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: var(--color-gray-300);
}

.empty-state p {
  font-size: 0.875rem;
  color: var(--color-gray-500);
  max-width: 320px;
}

/* ──────────── Skeleton / shimmer ──────────── */
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
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.06) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}

.stat-card.skeleton {
  min-height: 105px;
}

.skeleton-chart {
  height: 220px;
  border-radius: var(--border-radius-lg);
}

.skeleton-half {
  height: 200px;
  border-radius: var(--border-radius-lg);
}

/* ──────────── Responsive ──────────── */
@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .dashboard-page {
    padding: 1.25rem 1rem 2rem;
  }

  .stats-grid {
    grid-template-columns: 1fr 1fr;
  }

  .bottom-grid {
    grid-template-columns: 1fr;
  }

  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
