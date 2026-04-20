<template>
  <div class="playground-page">
    <header class="page-header">
      <div>
        <h1>Playground</h1>
        <p>Execute queries SQL diretamente no banco de dados</p>
      </div>
      <div class="header-badges">
        <span class="badge badge-mono">SQL</span>
        <span v-if="result" class="badge badge-accent">
          {{ result.rows.length }} {{ pluralize(result.rows.length, 'linha', 'linhas') }}
        </span>
      </div>
    </header>

    <div class="playground-layout">
      <!-- Left: Editor + Results -->
      <div class="editor-panel">
        <!-- SQL Editor -->
        <div class="editor-card" :class="{ focused: editorFocused }">
          <div class="editor-header">
            <div class="editor-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
              Editor SQL
            </div>
            <span class="shortcut-hint">Ctrl+Enter para executar</span>
          </div>
          <div class="editor-body">
            <textarea
              ref="editorRef"
              v-model="sql"
              class="sql-textarea"
              placeholder="SELECT TOP 100 * FROM ..."
              spellcheck="false"
              autocorrect="off"
              autocapitalize="off"
              @focus="editorFocused = true"
              @blur="editorFocused = false"
              @keydown="handleEditorKeydown"
            ></textarea>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="toolbar">
          <div class="toolbar-left">
            <button class="btn-run" @click="execute" :disabled="loading || !sql.trim()">
              <span v-if="!loading" class="btn-run-inner">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Executar
              </span>
              <span v-else class="btn-run-inner">
                <span class="spinner"></span>
                Executando...
              </span>
            </button>
            <button class="btn-secondary" @click="clearEditor" :disabled="loading">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
              Limpar
            </button>
            <button
              v-if="result"
              class="btn-secondary btn-export"
              @click="exportCsv"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Exportar CSV
            </button>
          </div>
          <div v-if="result" class="toolbar-meta">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            {{ result.rows.length }} {{ pluralize(result.rows.length, 'linha', 'linhas') }} em {{ result.elapsedMs }}ms
          </div>
        </div>

        <!-- Results Area -->
        <div class="results-area">
          <!-- Empty State -->
          <div v-if="!result && !errorMessage && !loading" class="empty-state">
            <div class="empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
            </div>
            <p class="empty-title">Execute uma query para ver resultados</p>
            <p class="empty-sub">Escreva um SELECT acima e pressione Ctrl+Enter ou clique em Executar</p>
          </div>

          <!-- Loading Skeleton -->
          <div v-else-if="loading && !result" class="loading-state">
            <span class="spinner spinner-lg"></span>
            <p>Executando query...</p>
          </div>

          <!-- Error -->
          <div v-else-if="errorMessage" class="error-card">
            <div class="error-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Erro ao executar query
            </div>
            <pre class="error-message">{{ errorMessage }}</pre>
          </div>

          <!-- Results Table -->
          <div v-else-if="result && result.rows.length > 0" class="table-card">
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th
                      v-for="col in result.columns"
                      :key="col"
                    >{{ col }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in result.rows" :key="i" :class="{ 'row-even': Number(i) % 2 === 0 }">
                    <td
                      v-for="col in result.columns"
                      :key="col"
                      :class="{ 'cell-number': isNumber(row[col]) }"
                      :title="String(row[col] ?? '')"
                    >
                      {{ formatValue(row[col]) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Zero rows -->
          <div v-else-if="result && result.rows.length === 0" class="empty-state">
            <div class="empty-icon empty-icon-success">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <p class="empty-title">Query executada com sucesso</p>
            <p class="empty-sub">Nenhum registro retornado em {{ result.elapsedMs }}ms</p>
          </div>
        </div>
      </div>

      <!-- Right: Query History Sidebar -->
      <aside class="history-sidebar" :class="{ collapsed: historyCollapsed }">
        <div class="history-header" @click="historyCollapsed = !historyCollapsed">
          <div class="history-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Historico
            <span v-if="history.length" class="history-count">{{ history.length }}</span>
          </div>
          <svg
            class="chevron"
            :class="{ rotated: historyCollapsed }"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </div>

        <div v-if="!historyCollapsed" class="history-body">
          <div v-if="!history.length" class="history-empty">
            <p>Nenhuma query executada ainda</p>
          </div>
          <div v-else class="history-list">
            <button
              v-for="item in history"
              :key="item.id"
              class="history-item"
              @click="loadFromHistory(item.sql)"
              :title="item.sql"
            >
              <span class="history-sql">{{ truncate(item.sql, 60) }}</span>
              <span class="history-time">{{ formatTime(item.ts) }}</span>
            </button>
          </div>
          <div class="history-footer">
            <button class="btn-clear-history" @click.stop="clearHistory">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
              </svg>
              Limpar historico
            </button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../services/api'
import type { RunResponse } from '../types'

// ── State ─────────────────────────────────────────────────────────────────────

const sql = ref('')
const loading = ref(false)
const result = ref<RunResponse | null>(null)
const errorMessage = ref<string | null>(null)
const editorFocused = ref(false)
const historyCollapsed = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)

// ── History ───────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mathai_playground_history'
const MAX_HISTORY = 20

interface HistoryItem {
  id: string
  sql: string
  ts: number
}

const history = ref<HistoryItem[]>([])

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    history.value = raw ? JSON.parse(raw) : []
  } catch {
    history.value = []
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
}

function pushHistory(sqlText: string) {
  const trimmed = sqlText.trim()
  if (!trimmed) return
  // Remove duplicate if already on top
  if (history.value[0]?.sql === trimmed) return
  history.value = history.value.filter((h: HistoryItem) => h.sql !== trimmed)
  history.value.unshift({
    id: `h_${Date.now()}`,
    sql: trimmed,
    ts: Date.now()
  })
  if (history.value.length > MAX_HISTORY) {
    history.value = history.value.slice(0, MAX_HISTORY)
  }
  saveHistory()
}

function loadFromHistory(sqlText: string) {
  sql.value = sqlText
  editorRef.value?.focus()
}

function clearHistory() {
  history.value = []
  saveHistory()
}

onMounted(() => {
  loadHistory()
  editorRef.value?.focus()
})

// ── Execution ─────────────────────────────────────────────────────────────────

async function execute() {
  const trimmed = sql.value.trim()
  if (!trimmed || loading.value) return

  loading.value = true
  errorMessage.value = null
  result.value = null

  try {
    const res = await api.run(trimmed)
    result.value = res
    pushHistory(trimmed)
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Erro ao executar query'
  } finally {
    loading.value = false
  }
}

function clearEditor() {
  sql.value = ''
  result.value = null
  errorMessage.value = null
  editorRef.value?.focus()
}

function handleEditorKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    execute()
  }
  // Tab inserts spaces instead of changing focus
  if (e.key === 'Tab') {
    e.preventDefault()
    const el = e.target as HTMLTextAreaElement
    const start = el.selectionStart
    const end = el.selectionEnd
    const spaces = '  '
    sql.value = sql.value.substring(0, start) + spaces + sql.value.substring(end)
    // Restore cursor position after Vue updates DOM
    requestAnimationFrame(() => {
      el.selectionStart = start + spaces.length
      el.selectionEnd = start + spaces.length
    })
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────────

function exportCsv() {
  if (!result.value) return
  const { columns, rows } = result.value
  const header = columns.join(',')
  const lines = rows.map((row: Record<string, unknown>) =>
    columns.map((col: string) => {
      const val = String(row[col] ?? '')
      return val.includes(',') || val.includes('"') || val.includes('\n')
        ? `"${val.replace(/"/g, '""')}"`
        : val
    }).join(',')
  )
  const csv = [header, ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `query_${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNumber(val: unknown): boolean {
  return typeof val === 'number'
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'number') return val.toLocaleString('pt-BR')
  return String(val)
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? single.slice(0, max) + '…' : single
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return ''
  }
}
</script>

<style scoped>
/* ── Page layout ─────────────────────────────────────────────────────────────── */

.playground-page {
  padding: 2rem 2rem 4rem;
  max-width: 1400px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.375rem;
  background: linear-gradient(135deg, var(--color-gray-50), var(--color-gray-300));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.page-header p {
  color: var(--color-gray-500);
  font-size: 0.9rem;
}

.header-badges {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.badge {
  padding: 0.25rem 0.65rem;
  border-radius: 8px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.badge-mono {
  background: rgba(34, 211, 238, 0.1);
  border: 1px solid rgba(34, 211, 238, 0.2);
  color: var(--color-cyan);
  font-family: var(--font-mono);
}

.badge-accent {
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.2);
  color: var(--color-accent-light);
}

/* ── Two-column layout ───────────────────────────────────────────────────────── */

.playground-layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 1rem;
  flex: 1;
  min-height: 0;
  align-items: start;
}

.editor-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

/* ── SQL Editor ──────────────────────────────────────────────────────────────── */

.editor-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.editor-card.focused {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.08), var(--glow-accent);
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.2);
}

.editor-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.shortcut-hint {
  font-size: 0.72rem;
  color: var(--color-gray-600);
  font-family: var(--font-mono);
}

.editor-body {
  position: relative;
}

.sql-textarea {
  width: 100%;
  min-height: 200px;
  max-height: 440px;
  padding: 1.25rem;
  background: rgba(5, 8, 15, 0.6);
  border: none;
  outline: none;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 0.88rem;
  line-height: 1.75;
  color: var(--color-gray-100);
  caret-color: var(--color-accent);
  letter-spacing: 0.01em;
}

.sql-textarea::placeholder {
  color: var(--color-gray-700);
  font-style: italic;
}

.sql-textarea:focus {
  outline: none;
  box-shadow: none;
  border-color: transparent !important;
}

/* ── Toolbar ─────────────────────────────────────────────────────────────────── */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.toolbar-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8rem;
  color: var(--color-accent);
  font-weight: 500;
}

.btn-run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1.125rem;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-dark));
  border: none;
  border-radius: 10px;
  color: white;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s ease;
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);
  min-width: 110px;
}

.btn-run:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-accent));
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(16, 185, 129, 0.35);
}

.btn-run:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.btn-run-inner {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.875rem;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  color: var(--color-gray-400);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-export {
  color: var(--color-cyan);
  border-color: rgba(34, 211, 238, 0.2);
  background: rgba(34, 211, 238, 0.04);
}

.btn-export:hover {
  border-color: rgba(34, 211, 238, 0.35) !important;
  background: rgba(34, 211, 238, 0.08) !important;
  color: var(--color-cyan) !important;
}

/* ── Spinner ─────────────────────────────────────────────────────────────────── */

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

.spinner-lg {
  width: 28px;
  height: 28px;
  border-width: 3px;
  border-top-color: var(--color-accent);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Results Area ────────────────────────────────────────────────────────────── */

.results-area {
  min-height: 200px;
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  text-align: center;
  gap: 0.75rem;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  color: var(--color-gray-600);
  margin-bottom: 0.5rem;
  animation: float 4s ease-in-out infinite;
}

.empty-icon-success {
  color: var(--color-accent);
  border-color: rgba(16, 185, 129, 0.2);
  background: rgba(16, 185, 129, 0.06);
}

.empty-title {
  font-size: 1rem;
  font-weight: 500;
  color: var(--color-gray-300);
}

.empty-sub {
  font-size: 0.85rem;
  color: var(--color-gray-600);
  max-width: 360px;
}

/* Loading */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 4rem 2rem;
  color: var(--color-gray-400);
  font-size: 0.9rem;
}

/* Error */
.error-card {
  padding: 1.25rem;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.18);
  border-radius: var(--border-radius);
  backdrop-filter: blur(8px);
}

.error-header {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: #f87171;
  margin-bottom: 0.75rem;
}

.error-message {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: #fca5a5;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  margin: 0;
  opacity: 0.85;
}

/* Results Table */
.table-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.table-wrapper {
  overflow: auto;
  max-height: 420px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

thead {
  position: sticky;
  top: 0;
  z-index: 2;
}

th {
  padding: 0.65rem 1rem;
  text-align: left;
  background: rgba(5, 8, 15, 0.75);
  border-bottom: 1px solid var(--glass-border);
  font-family: var(--font-mono);
  font-size: 0.73rem;
  font-weight: 600;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
  backdrop-filter: blur(12px);
}

td {
  padding: 0.6rem 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  color: var(--color-gray-200);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

td.cell-number {
  text-align: right;
  color: var(--color-accent-light);
}

tr.row-even td {
  background: rgba(255, 255, 255, 0.015);
}

tr:hover td {
  background: rgba(16, 185, 129, 0.04) !important;
}

/* ── History Sidebar ─────────────────────────────────────────────────────────── */

.history-sidebar {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: all 0.25s ease;
  position: sticky;
  top: 1.5rem;
  max-height: calc(100vh - 8rem);
  display: flex;
  flex-direction: column;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1rem;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.2);
  cursor: pointer;
  user-select: none;
  transition: background 0.2s;
}

.history-sidebar.collapsed .history-header {
  border-bottom-color: transparent;
}

.history-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.history-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.history-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 999px;
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--color-accent);
}

.chevron {
  color: var(--color-gray-600);
  transition: transform 0.25s ease;
  flex-shrink: 0;
}

.chevron.rotated {
  transform: rotate(-90deg);
}

.history-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.history-empty {
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.82rem;
  color: var(--color-gray-600);
}

.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
}

.history-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  width: 100%;
  padding: 0.625rem 1rem;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.history-item:hover {
  background: rgba(16, 185, 129, 0.05);
}

.history-item:last-child {
  border-bottom: none;
}

.history-sql {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-gray-300);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
}

.history-time {
  font-size: 0.7rem;
  color: var(--color-gray-600);
}

.history-footer {
  padding: 0.625rem 0.75rem;
  border-top: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.15);
}

.btn-clear-history {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  background: none;
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 7px;
  color: rgba(248, 113, 113, 0.7);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.2s;
  width: 100%;
  justify-content: center;
}

.btn-clear-history:hover {
  background: rgba(239, 68, 68, 0.06);
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

/* ── Responsive ──────────────────────────────────────────────────────────────── */

@media (max-width: 900px) {
  .playground-layout {
    grid-template-columns: 1fr;
  }

  .history-sidebar {
    position: static;
    max-height: none;
  }
}

@media (max-width: 600px) {
  .playground-page {
    padding: 1.5rem 1rem 3rem;
  }

  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .toolbar-left {
    flex-wrap: wrap;
  }

  .btn-run {
    flex: 1;
  }
}
</style>
