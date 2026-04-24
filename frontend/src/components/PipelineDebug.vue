<template>
  <div class="pipeline-debug">
    <div class="card-header" @click="open = !open" style="cursor:pointer">
      <div class="card-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
        Gasto de Tokens
        <span v-if="tokenUsage" class="total-badge">
          {{ tokenUsage.total.totalTokens.toLocaleString() }} tokens
        </span>
        <span v-if="cacheHit" class="cache-badge-sm">Cache Hit</span>
      </div>
      <div class="card-actions" @click.stop>
        <button class="action-btn expand-btn" @click="open = !open">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               :style="{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          {{ open ? 'Colapsar' : 'Expandir' }}
        </button>
      </div>
    </div>

    <div class="collapsible" :class="{ expanded: open }">
      <div>
      <div class="debug-panel">

        <!-- Token Usage -->
        <section v-if="tokenUsage" class="debug-section">
          <h6 class="section-heading">Tokens</h6>
          <table class="token-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>In</th>
                <th>Out</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="tokenUsage.planner">
                <td class="agent-name">Planner <span class="model-tag">gpt-5-mini</span></td>
                <td>{{ tokenUsage.planner.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.planner.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.planner.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr v-if="tokenUsage.sql && !tokenUsage.sqlMini">
                <td class="agent-name">SQL <span class="model-tag">gpt-5</span></td>
                <td>{{ tokenUsage.sql!.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.sql!.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.sql!.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr v-if="tokenUsage.sqlMini">
                <td class="agent-name">SQL Mini <span class="model-tag">gpt-5-mini</span></td>
                <td>{{ tokenUsage.sqlMini.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.sqlMini.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.sqlMini.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr v-if="tokenUsage.sqlLarge">
                <td class="agent-name">SQL Large <span class="model-tag">gpt-5</span></td>
                <td>{{ tokenUsage.sqlLarge.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.sqlLarge.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.sqlLarge.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr v-if="tokenUsage.summary">
                <td class="agent-name">Summary <span class="model-tag">gpt-4o-mini</span></td>
                <td>{{ tokenUsage.summary.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.summary.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.summary.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr class="total-row">
                <td class="agent-name">Total</td>
                <td>{{ tokenUsage.total.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.total.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.total.totalTokens.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Pipeline Timeline -->
        <section v-if="steps.length" class="debug-section">
          <h6 class="section-heading">Pipeline</h6>
          <ol class="timeline">
            <li
              v-for="(step, i) in steps"
              :key="i"
              class="timeline-item"
              :class="{ 'has-line': Number(i) < steps.length - 1 }"
            >
              <span class="tl-dot" :class="stepDotClass(step.step)"></span>
              <span class="tl-time">{{ relativeTime(step.timestamp, steps[0].timestamp) }}</span>
              <span class="tl-label">{{ step.label }}</span>
            </li>
          </ol>
        </section>

        <!-- Details -->
        <section class="debug-section">
          <h6 class="section-heading">Details</h6>
          <dl class="details-grid">
            <template v-if="cacheHit !== undefined">
              <dt>Cache</dt>
              <dd>
                <span class="badge" :class="cacheHit ? 'badge-hit' : 'badge-miss'">
                  {{ cacheHit ? 'Hit' : 'Miss' }}
                </span>
              </dd>
            </template>
            <template v-if="elapsedMs !== undefined">
              <dt>Elapsed</dt>
              <dd class="mono">{{ elapsedMs.toLocaleString() }} ms</dd>
            </template>
            <template v-if="translatedQuestion">
              <dt>Translated</dt>
              <dd class="mono wrap">{{ translatedQuestion }}</dd>
            </template>
            <template v-if="historyId">
              <dt>History&nbsp;ID</dt>
              <dd class="mono muted">{{ historyId }}</dd>
            </template>
            <template v-if="chatId">
              <dt>Chat&nbsp;ID</dt>
              <dd class="mono muted">{{ chatId }}</dd>
            </template>
          </dl>
        </section>

      </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PipelineStep } from '../types'

defineProps<{
  steps: PipelineStep[]
  tokenUsage?: {
    sql?: { inputTokens: number; outputTokens: number; totalTokens: number }
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number }
    sqlMini?: { inputTokens: number; outputTokens: number; totalTokens: number }
    sqlLarge?: { inputTokens: number; outputTokens: number; totalTokens: number }
    summary?: { inputTokens: number; outputTokens: number; totalTokens: number }
    total: { inputTokens: number; outputTokens: number; totalTokens: number }
  }
  cacheHit?: boolean
  translatedQuestion?: string
  elapsedMs?: number
  historyId?: string
  chatId?: string
}>()

const open = ref(false)

function stepDotClass(step: string): string {
  const s = step.toLowerCase()
  if (s.includes('error') || s.includes('reflecting') || s.includes('retry')) return 'dot-warn'
  return 'dot-ok'
}

function relativeTime(ts: number, origin: number): string {
  const diff = (ts - origin) / 1000
  return `+${diff.toFixed(1)}s`
}
</script>

<style scoped>
.pipeline-debug {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

/* reuse the same card-header pattern as SQL/Table cards in Chat.vue */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid transparent;
  background: rgba(0, 0, 0, 0.15);
  transition: border-color 0.2s;
}

.card-header:hover {
  border-bottom-color: var(--glass-border);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-gray-300);
}

.total-badge {
  padding: 0.1rem 0.45rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 999px;
  font-size: 0.68rem;
  color: var(--color-accent);
  font-family: var(--font-mono);
}

.cache-badge-sm {
  padding: 0.08rem 0.4rem;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 4px;
  font-size: 0.6rem;
  color: #a5b4fc;
  font-weight: 500;
}

.card-actions { display: flex; gap: 0.5rem; }

.action-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  font-size: 0.78rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
  background: rgba(255, 255, 255, 0.06);
}

/* Collapsible */
.collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.collapsible > div { min-height: 0; }

.collapsible.expanded { grid-template-rows: 1fr; }

.debug-panel {
  padding: 0.875rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

/* Section */
.debug-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-heading {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--color-gray-500);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin: 0;
}

/* Token table */
.token-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.token-table th {
  text-align: right;
  color: var(--color-gray-500);
  font-weight: 500;
  padding: 0.2rem 0.5rem;
  border-bottom: 1px solid var(--glass-border);
  white-space: nowrap;
}

.token-table th:first-child { text-align: left; }

.token-table td {
  text-align: right;
  color: var(--color-gray-300);
  padding: 0.2rem 0.5rem;
  white-space: nowrap;
}

.token-table td:first-child { text-align: left; }

.agent-name {
  color: var(--color-gray-400) !important;
  font-size: 0.7rem;
  text-transform: capitalize;
}

.total-cell {
  color: var(--color-accent) !important;
  font-weight: 600;
}

.total-row td {
  border-top: 1px solid var(--glass-border);
  color: var(--color-gray-200);
}

/* Timeline */
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.timeline-item {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.22rem 0 0.22rem 1rem;
  font-size: 0.75rem;
  line-height: 1.4;
}

.timeline-item.has-line::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 14px;
  width: 1px;
  height: calc(100% - 6px);
  background: var(--glass-border);
}

.tl-dot {
  position: absolute;
  left: 0;
  top: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-ok { background: var(--color-accent); box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15); }
.dot-warn { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.15); }

.tl-time {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-gray-600);
  min-width: 3.5rem;
  flex-shrink: 0;
}

.tl-label { color: var(--color-gray-300); font-size: 0.75rem; }

/* Details grid */
.details-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  align-items: baseline;
}

.details-grid dt { font-size: 0.7rem; color: var(--color-gray-500); white-space: nowrap; }
.details-grid dd { font-size: 0.75rem; color: var(--color-gray-300); margin: 0; }

.mono { font-family: var(--font-mono); }
.muted { color: var(--color-gray-600) !important; font-size: 0.68rem !important; }
.wrap { word-break: break-word; white-space: pre-wrap; }

/* Badges */
.badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  font-size: 0.68rem;
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}

.badge-hit {
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.25);
  color: var(--color-accent);
}

.badge-miss {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-border);
  color: var(--color-gray-500);
}
</style>
