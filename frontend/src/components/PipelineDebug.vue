<template>
  <div class="pipeline-debug">
    <!-- Toggle button -->
    <button class="debug-toggle" @click="open = !open" :class="{ active: open }">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
      Dev Info
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        class="chevron"
        :class="{ rotated: open }"
      >
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>

    <!-- Expandable panel -->
    <Transition name="debug-expand">
      <div v-if="open" class="debug-panel">

        <!-- ── Section 1: Pipeline Timeline ─────────────────────────────────── -->
        <section v-if="steps.length" class="debug-section">
          <h6 class="section-heading">Pipeline</h6>
          <ol class="timeline">
            <li
              v-for="(step, i) in steps"
              :key="i"
              class="timeline-item"
              :class="{ 'has-line': Number(i) < steps.length - 1 }"
            >
              <span
                class="tl-dot"
                :class="stepDotClass(step.step)"
              ></span>
              <span class="tl-time">{{ relativeTime(step.timestamp, steps[0].timestamp) }}</span>
              <span class="tl-label">{{ step.label }}</span>
            </li>
          </ol>
        </section>

        <!-- ── Section 2: Token Usage ────────────────────────────────────────── -->
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
              <tr v-if="tokenUsage.sql">
                <td class="agent-name">SQL</td>
                <td>{{ tokenUsage.sql.inputTokens.toLocaleString() }}</td>
                <td>{{ tokenUsage.sql.outputTokens.toLocaleString() }}</td>
                <td class="total-cell">{{ tokenUsage.sql.totalTokens.toLocaleString() }}</td>
              </tr>
              <tr v-if="tokenUsage.summary">
                <td class="agent-name">Summary</td>
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

        <!-- ── Section 3: Details ────────────────────────────────────────────── -->
        <section class="debug-section">
          <h6 class="section-heading">Details</h6>
          <dl class="details-grid">

            <template v-if="cacheHit !== undefined">
              <dt>Cache</dt>
              <dd>
                <span
                  class="badge"
                  :class="cacheHit ? 'badge-hit' : 'badge-miss'"
                >{{ cacheHit ? 'Hit' : 'Miss' }}</span>
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
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PipelineStep } from '../types'

defineProps<{
  steps: PipelineStep[]
  tokenUsage?: {
    sql?: { inputTokens: number; outputTokens: number; totalTokens: number }
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

// Dot colour: orange for error/reflecting steps, green otherwise
function stepDotClass(step: string): string {
  const s = step.toLowerCase()
  if (s.includes('error') || s.includes('reflecting') || s.includes('retry')) {
    return 'dot-warn'
  }
  return 'dot-ok'
}

// Format as "+1.2s" relative to the first step timestamp
function relativeTime(ts: number, origin: number): string {
  const diff = (ts - origin) / 1000
  return `+${diff.toFixed(1)}s`
}
</script>

<style scoped>
/* ── Toggle button ─────────────────────────────────────────────────────────── */
.pipeline-debug {
  margin-top: 0.5rem;
}

.debug-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-gray-500);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  user-select: none;
}

.debug-toggle:hover,
.debug-toggle.active {
  color: var(--color-gray-300);
  border-color: var(--glass-border-hover);
  background: rgba(255, 255, 255, 0.05);
}

.debug-toggle svg:first-child {
  opacity: 0.6;
}

.chevron {
  transition: transform 0.2s ease;
}

.chevron.rotated {
  transform: rotate(180deg);
}

/* ── Panel ──────────────────────────────────────────────────────────────────── */
.debug-panel {
  margin-top: 0.4rem;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ── Expand / collapse transition ─────────────────────────────────────────── */
.debug-expand-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.debug-expand-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.debug-expand-enter-from,
.debug-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── Section ────────────────────────────────────────────────────────────────── */
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

/* ── Timeline ───────────────────────────────────────────────────────────────── */
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
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

/* Vertical connecting line */
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

.dot-ok {
  background: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15);
}

.dot-warn {
  background: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.15);
}

.tl-time {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-gray-600);
  min-width: 3.5rem;
  flex-shrink: 0;
}

.tl-label {
  color: var(--color-gray-300);
  font-size: 0.75rem;
}

/* ── Token table ────────────────────────────────────────────────────────────── */
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

.token-table th:first-child {
  text-align: left;
}

.token-table td {
  text-align: right;
  color: var(--color-gray-300);
  padding: 0.2rem 0.5rem;
  white-space: nowrap;
}

.token-table td:first-child {
  text-align: left;
}

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

/* ── Details grid ───────────────────────────────────────────────────────────── */
.details-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  align-items: baseline;
}

.details-grid dt {
  font-size: 0.7rem;
  color: var(--color-gray-500);
  white-space: nowrap;
}

.details-grid dd {
  font-size: 0.75rem;
  color: var(--color-gray-300);
  margin: 0;
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  color: var(--color-gray-600) !important;
  font-size: 0.68rem !important;
}

.wrap {
  word-break: break-word;
  white-space: pre-wrap;
}

/* ── Badges ─────────────────────────────────────────────────────────────────── */
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
