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
            <button v-if="result" class="btn-secondary btn-export" @click="exportCsv">
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

        <!-- Pipeline Animation -->
        <Transition name="pipeline-fade">
          <div v-if="loading" class="pipeline-container">
            <div class="pipeline-bg-grid"></div>
            <div class="pipeline-label">
              <span class="pipeline-dot-blink"></span>
              Processando sua consulta
            </div>
            <div class="pipeline-stages">
              <div
                v-for="(stage, i) in pipelineStages"
                :key="i"
                class="pipeline-stage"
                :class="{
                  'stage-done': currentStage > i,
                  'stage-active': currentStage === i,
                  'stage-pending': currentStage < i
                }"
              >
                <div class="stage-node">
                  <div class="stage-icon-wrap">
                    <svg v-if="currentStage > i" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <component v-else :is="'svg'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="stage.iconPath"></component>
                  </div>
                  <div v-if="currentStage === i" class="stage-pulse-ring"></div>
                </div>
                <div class="stage-connector" v-if="i < pipelineStages.length - 1">
                  <div class="connector-line" :class="{ 'line-filled': currentStage > i }"></div>
                </div>
                <div class="stage-text">
                  <span class="stage-name">{{ stage.label }}</span>
                  <span class="stage-desc">{{ currentStage === i ? stage.activeDesc : (currentStage > i ? stage.doneDesc : stage.pendingDesc) }}</span>
                </div>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Results Area -->
        <Transition name="results-fade">
          <div class="results-area" v-if="!loading">

            <!-- Empty State -->
            <div v-if="!result && !errorMessage" class="empty-state">
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

            <!-- Results section -->
            <template v-else-if="result">

              <!-- AI Assistant Card -->
              <div class="assistant-card" :class="{ 'assistant-visible': assistantReady }">
                <div class="assistant-avatar">
                  <div class="avatar-ring-outer"></div>
                  <div class="avatar-ring-inner"></div>
                  <div class="avatar-core">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                  </div>
                </div>
                <div class="assistant-body">
                  <div class="assistant-header-row">
                    <span class="assistant-label">Análise dos dados</span>
                    <span class="assistant-badge">IA</span>
                  </div>
                  <p class="assistant-text">
                    {{ displayedText }}<span v-if="isTyping" class="type-cursor">|</span>
                  </p>
                </div>
              </div>

              <!-- Stats Row -->
              <div class="stats-row">
                <div
                  v-for="(stat, i) in computedStats"
                  :key="stat.key"
                  class="stat-card"
                  :style="{ '--stat-color': stat.color, '--stat-glow': stat.glow, animationDelay: `${i * 80}ms` }"
                >
                  <div class="stat-icon-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="stat.iconPath"></svg>
                  </div>
                  <div class="stat-value" :ref="(el) => { if (el) statRefs[stat.key] = el as HTMLElement }">
                    {{ stat.displayValue }}
                  </div>
                  <div class="stat-label">{{ stat.label }}</div>
                  <div class="stat-bar">
                    <div class="stat-bar-fill" :style="{ width: stat.fillPct + '%' }"></div>
                  </div>
                </div>
              </div>

              <!-- Insights Chips -->
              <div v-if="dataInsights.length" class="insights-row">
                <div
                  v-for="(chip, i) in dataInsights"
                  :key="i"
                  class="insight-chip"
                  :class="`chip-${chip.type}`"
                  :style="{ animationDelay: `${200 + i * 60}ms` }"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" v-html="chip.iconPath"></svg>
                  {{ chip.text }}
                </div>
              </div>

              <!-- Zero rows -->
              <div v-if="result.rows.length === 0" class="empty-state">
                <div class="empty-icon empty-icon-success">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <p class="empty-title">Query executada com sucesso</p>
                <p class="empty-sub">Nenhum registro retornado em {{ result.elapsedMs }}ms</p>
              </div>

              <!-- Results Table -->
              <div v-else class="table-card">
                <div class="table-header-bar">
                  <span class="table-title-text">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <line x1="3" y1="9" x2="21" y2="9"/>
                      <line x1="9" y1="21" x2="9" y2="9"/>
                    </svg>
                    Resultados
                  </span>
                  <div class="col-type-legend">
                    <span class="legend-item legend-num">
                      <span class="legend-dot"></span>Número
                    </span>
                    <span class="legend-item legend-txt">
                      <span class="legend-dot"></span>Texto
                    </span>
                  </div>
                </div>
                <div class="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th
                          v-for="col in result.columns"
                          :key="col"
                          :class="{ 'th-number': isColumnNumeric(col) }"
                        >
                          <span class="th-type-dot" :class="isColumnNumeric(col) ? 'dot-num' : 'dot-txt'"></span>
                          {{ col }}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(row, i) in result.rows"
                        :key="i"
                        class="row-animate"
                        :class="{ 'row-even': Number(i) % 2 === 0 }"
                        :style="{ animationDelay: `${Math.min(i * 25, 800)}ms` }"
                      >
                        <td
                          v-for="col in result.columns"
                          :key="col"
                          :class="{ 'cell-number': isNumber(row[col]), 'cell-null': row[col] === null || row[col] === undefined }"
                          :title="String(row[col] ?? '')"
                        >
                          <span v-if="row[col] === null || row[col] === undefined" class="null-badge">null</span>
                          <span v-else>{{ formatValue(row[col]) }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>

          </div>
        </Transition>
      </div>

      <!-- Right: Query History Sidebar -->
      <aside class="history-sidebar" :class="{ collapsed: historyCollapsed }">
        <div class="history-header" @click="historyCollapsed = !historyCollapsed">
          <div class="history-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            Histórico
            <span v-if="history.length" class="history-count">{{ history.length }}</span>
          </div>
          <svg
            class="chevron"
            :class="{ rotated: historyCollapsed }"
            width="15" height="15" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
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
              Limpar histórico
            </button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
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

interface HistoryItem { id: string; sql: string; ts: number }
const history = ref<HistoryItem[]>([])

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    history.value = raw ? JSON.parse(raw) : []
  } catch { history.value = [] }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
}

function pushHistory(sqlText: string) {
  const trimmed = sqlText.trim()
  if (!trimmed) return
  if (history.value[0]?.sql === trimmed) return
  history.value = history.value.filter((h: HistoryItem) => h.sql !== trimmed)
  history.value.unshift({ id: `h_${Date.now()}`, sql: trimmed, ts: Date.now() })
  if (history.value.length > MAX_HISTORY) history.value = history.value.slice(0, MAX_HISTORY)
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

// ── Pipeline ──────────────────────────────────────────────────────────────────

const pipelineStages = [
  {
    label: 'Analisando',
    activeDesc: 'Verificando sintaxe SQL...',
    doneDesc: 'Sintaxe validada',
    pendingDesc: 'Aguardando...',
    iconPath: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
  },
  {
    label: 'Conectando',
    activeDesc: 'Abrindo conexão...',
    doneDesc: 'Banco conectado',
    pendingDesc: 'Aguardando...',
    iconPath: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
  },
  {
    label: 'Executando',
    activeDesc: 'Processando no servidor...',
    doneDesc: 'Query executada',
    pendingDesc: 'Aguardando...',
    iconPath: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
  },
  {
    label: 'Carregando',
    activeDesc: 'Transferindo dados...',
    doneDesc: 'Dados carregados',
    pendingDesc: 'Aguardando...',
    iconPath: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'
  }
]

const currentStage = ref(-1)
let stageTimers: ReturnType<typeof setTimeout>[] = []

function startPipeline() {
  currentStage.value = 0
  stageTimers = [
    setTimeout(() => { currentStage.value = 1 }, 600),
    setTimeout(() => { currentStage.value = 2 }, 1300),
    setTimeout(() => { currentStage.value = 3 }, 2200),
  ]
}

function clearPipelineTimers() {
  stageTimers.forEach(clearTimeout)
  stageTimers = []
}

// ── AI Assistant typewriter ────────────────────────────────────────────────────

const displayedText = ref('')
const isTyping = ref(false)
const assistantReady = ref(false)
let typewriterTimer: ReturnType<typeof setInterval> | null = null

function generateInsightText(res: RunResponse): string {
  const { rows, columns, elapsedMs } = res
  if (rows.length === 0) {
    return `A consulta foi executada com sucesso em ${elapsedMs}ms, mas não retornou registros. Verifique os filtros aplicados na cláusula WHERE.`
  }

  const parts: string[] = []
  const plural = rows.length === 1 ? 'registro' : 'registros'
  const colPlural = columns.length === 1 ? 'coluna' : 'colunas'
  const speedLabel = elapsedMs < 200 ? 'muito rápida' : elapsedMs < 1000 ? 'em tempo aceitável' : 'com latência elevada'

  parts.push(`Encontrei ${rows.length.toLocaleString('pt-BR')} ${plural} distribuídos em ${columns.length} ${colPlural}, processados ${speedLabel} em ${elapsedMs}ms.`)

  const numericCols = columns.filter(col => rows.some(r => typeof r[col] === 'number'))
  if (numericCols.length > 0) {
    const col = numericCols[0]
    const vals = rows.map(r => r[col]).filter(v => typeof v === 'number') as number[]
    if (vals.length > 0) {
      const min = Math.min(...vals)
      const max = Math.max(...vals)
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length
      parts.push(`A coluna "${col}" varia de ${min.toLocaleString('pt-BR')} a ${max.toLocaleString('pt-BR')}, com média de ${avg.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}.`)
    }
  }

  const textCols = columns.filter(col => rows.some(r => typeof r[col] === 'string'))
  if (textCols.length > 0) {
    const col = textCols[0]
    const distinct = new Set(rows.map(r => String(r[col] ?? ''))).size
    const ratio = distinct / rows.length
    if (ratio < 0.3 && distinct > 1) {
      parts.push(`"${col}" contém ${distinct} valores únicos — pode ser interessante para agrupamentos.`)
    }
  }

  const totalCells = rows.length * columns.length
  const nullCells = rows.reduce((acc, row) =>
    acc + columns.filter(c => row[c] === null || row[c] === undefined).length, 0)
  if (nullCells > 0) {
    const pct = Math.round((nullCells / totalCells) * 100)
    parts.push(`Atenção: ${pct}% das células contêm valores nulos.`)
  }

  return parts.join(' ')
}

function startTypewriter(text: string) {
  displayedText.value = ''
  isTyping.value = true
  assistantReady.value = false
  let i = 0
  if (typewriterTimer) clearInterval(typewriterTimer)
  setTimeout(() => {
    assistantReady.value = true
    typewriterTimer = setInterval(() => {
      if (i < text.length) {
        displayedText.value += text[i++]
      } else {
        isTyping.value = false
        if (typewriterTimer) clearInterval(typewriterTimer)
        typewriterTimer = null
      }
    }, 22)
  }, 400)
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const statRefs: Record<string, HTMLElement> = {}

const computedStats = computed(() => {
  if (!result.value) return []
  const { rows, columns, elapsedMs } = result.value
  const totalCells = rows.length * columns.length
  const nullCells = totalCells > 0
    ? rows.reduce((acc, row) => acc + columns.filter(c => row[c] === null || row[c] === undefined).length, 0)
    : 0
  const nullPct = totalCells > 0 ? Math.round((nullCells / totalCells) * 100) : 0

  const timeColor = elapsedMs < 200 ? '#10b981' : elapsedMs < 1000 ? '#f59e0b' : '#ef4444'
  const timeGlow = elapsedMs < 200
    ? 'rgba(16,185,129,0.3)'
    : elapsedMs < 1000 ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)'

  return [
    {
      key: 'rows',
      label: 'Registros',
      displayValue: rows.length.toLocaleString('pt-BR'),
      rawValue: rows.length,
      color: '#10b981',
      glow: 'rgba(16,185,129,0.25)',
      fillPct: Math.min(rows.length / 5, 100),
      iconPath: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'
    },
    {
      key: 'cols',
      label: 'Colunas',
      displayValue: String(columns.length),
      rawValue: columns.length,
      color: '#22d3ee',
      glow: 'rgba(34,211,238,0.25)',
      fillPct: Math.min(columns.length * 10, 100),
      iconPath: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'
    },
    {
      key: 'time',
      label: 'Tempo (ms)',
      displayValue: String(elapsedMs),
      rawValue: elapsedMs,
      color: timeColor,
      glow: timeGlow,
      fillPct: Math.max(0, 100 - Math.min(elapsedMs / 20, 100)),
      iconPath: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
    },
    {
      key: 'nulls',
      label: 'Valores nulos',
      displayValue: nullPct + '%',
      rawValue: nullPct,
      color: nullPct === 0 ? '#10b981' : nullPct < 10 ? '#f59e0b' : '#ef4444',
      glow: nullPct === 0 ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)',
      fillPct: nullPct,
      iconPath: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
    }
  ]
})

// ── Insights Chips ────────────────────────────────────────────────────────────

const dataInsights = computed(() => {
  if (!result.value || result.value.rows.length === 0) return []
  const { rows, columns, elapsedMs } = result.value
  const chips: { text: string; type: string; iconPath: string }[] = []

  const numericCols = columns.filter(col => rows.some(r => typeof r[col] === 'number'))
  const textCols = columns.filter(col => rows.some(r => typeof r[col] === 'string'))

  if (numericCols.length > 0)
    chips.push({ text: `${numericCols.length} col. numérica${numericCols.length > 1 ? 's' : ''}`, type: 'num', iconPath: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' })

  if (textCols.length > 0)
    chips.push({ text: `${textCols.length} col. de texto`, type: 'txt', iconPath: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>' })

  if (numericCols.length > 0) {
    const col = numericCols[0]
    const vals = rows.map(r => r[col]).filter(v => typeof v === 'number') as number[]
    chips.push({ text: `Máx ${col}: ${Math.max(...vals).toLocaleString('pt-BR')}`, type: 'stat', iconPath: '<polyline points="18 15 12 9 6 15"/>' })
    chips.push({ text: `Mín ${col}: ${Math.min(...vals).toLocaleString('pt-BR')}`, type: 'stat', iconPath: '<polyline points="6 9 12 15 18 9"/>' })
  }

  if (textCols.length > 0) {
    const col = textCols[0]
    const distinct = new Set(rows.map(r => String(r[col] ?? ''))).size
    chips.push({ text: `${distinct} únicos em "${col}"`, type: 'info', iconPath: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' })
  }

  if (elapsedMs < 200)
    chips.push({ text: 'Consulta rápida', type: 'good', iconPath: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' })
  else if (elapsedMs > 2000)
    chips.push({ text: 'Alta latência', type: 'warn', iconPath: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' })

  return chips
})

// ── Execution ─────────────────────────────────────────────────────────────────

async function execute() {
  const trimmed = sql.value.trim()
  if (!trimmed || loading.value) return

  loading.value = true
  errorMessage.value = null
  result.value = null
  displayedText.value = ''
  assistantReady.value = false

  startPipeline()

  try {
    const res = await api.run(trimmed)
    clearPipelineTimers()
    currentStage.value = 4

    await new Promise(r => setTimeout(r, 250))

    result.value = res
    pushHistory(trimmed)

    const insightText = generateInsightText(res)
    startTypewriter(insightText)
  } catch (err: any) {
    clearPipelineTimers()
    errorMessage.value = err?.message ?? 'Erro ao executar query'
  } finally {
    loading.value = false
  }
}

function clearEditor() {
  sql.value = ''
  result.value = null
  errorMessage.value = null
  displayedText.value = ''
  assistantReady.value = false
  editorRef.value?.focus()
}

function handleEditorKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    execute()
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    const el = e.target as HTMLTextAreaElement
    const start = el.selectionStart
    const end = el.selectionEnd
    const spaces = '  '
    sql.value = sql.value.substring(0, start) + spaces + sql.value.substring(end)
    requestAnimationFrame(() => {
      el.selectionStart = start + spaces.length
      el.selectionEnd = start + spaces.length
    })
  }
}

onBeforeUnmount(() => {
  clearPipelineTimers()
  if (typewriterTimer) clearInterval(typewriterTimer)
})

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

function isColumnNumeric(col: string): boolean {
  if (!result.value) return false
  return result.value.rows.some(r => typeof r[col] === 'number')
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
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}
</script>

<style scoped>
/* ── Page layout ─────────────────────────────────────────────────────────────── */

.playground-page {
  padding: 2rem 2rem 4rem;
  max-width: 100%;
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

.editor-body { position: relative; }

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

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Pipeline Animation ──────────────────────────────────────────────────────── */

.pipeline-container {
  position: relative;
  padding: 1.5rem;
  background: rgba(5, 8, 15, 0.7);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  overflow: hidden;
  backdrop-filter: blur(12px);
}

.pipeline-bg-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(16, 185, 129, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(16, 185, 129, 0.04) 1px, transparent 1px);
  background-size: 32px 32px;
  animation: grid-scroll 8s linear infinite;
  pointer-events: none;
}

@keyframes grid-scroll {
  0% { background-position: 0 0; }
  100% { background-position: 32px 32px; }
}

.pipeline-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-gray-500);
  margin-bottom: 1.25rem;
  font-family: var(--font-mono);
}

.pipeline-dot-blink {
  width: 6px;
  height: 6px;
  background: var(--color-accent);
  border-radius: 50%;
  animation: blink-pulse 1s ease-in-out infinite;
  box-shadow: 0 0 6px var(--color-accent);
}

@keyframes blink-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}

.pipeline-stages {
  display: flex;
  gap: 0;
  align-items: flex-start;
  position: relative;
}

.pipeline-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.625rem;
  text-align: center;
  position: relative;
  transition: all 0.3s ease;
}

.stage-node {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.stage-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: all 0.4s ease;
  position: relative;
  z-index: 1;
}

.stage-done .stage-icon-wrap {
  background: rgba(16, 185, 129, 0.12);
  border-color: rgba(16, 185, 129, 0.3);
  color: var(--color-accent);
}

.stage-active .stage-icon-wrap {
  background: rgba(34, 211, 238, 0.1);
  border-color: rgba(34, 211, 238, 0.4);
  color: var(--color-cyan);
  box-shadow: 0 0 16px rgba(34, 211, 238, 0.2);
}

.stage-pending .stage-icon-wrap {
  color: var(--color-gray-600);
}

.stage-pulse-ring {
  position: absolute;
  inset: -8px;
  border: 1.5px solid rgba(34, 211, 238, 0.4);
  border-radius: 20px;
  animation: pulse-expand 1.5s ease-out infinite;
  pointer-events: none;
}

@keyframes pulse-expand {
  0% { transform: scale(1); opacity: 0.6; }
  100% { transform: scale(1.5); opacity: 0; }
}

.stage-connector {
  position: absolute;
  top: 22px;
  left: 50%;
  width: 100%;
  height: 1px;
  pointer-events: none;
  z-index: 0;
}

.connector-line {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  position: relative;
  overflow: hidden;
}

.connector-line::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--color-accent), transparent);
  transform: translateX(-100%);
  transition: transform 0.6s ease;
}

.line-filled::after {
  transform: translateX(0);
}

.stage-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0 0.5rem;
}

.stage-name {
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  transition: color 0.3s;
}

.stage-done .stage-name { color: var(--color-accent); }
.stage-active .stage-name { color: var(--color-cyan); }
.stage-pending .stage-name { color: var(--color-gray-600); }

.stage-desc {
  font-size: 0.68rem;
  color: var(--color-gray-600);
  font-family: var(--font-mono);
  line-height: 1.3;
}

.stage-active .stage-desc { color: var(--color-gray-500); }

/* Pipeline transition */
.pipeline-fade-enter-active { transition: all 0.35s ease; }
.pipeline-fade-leave-active { transition: all 0.25s ease; }
.pipeline-fade-enter-from { opacity: 0; transform: translateY(8px); }
.pipeline-fade-leave-to { opacity: 0; transform: translateY(-8px); }

/* Results transition */
.results-fade-enter-active { transition: all 0.4s ease; }
.results-fade-enter-from { opacity: 0; transform: translateY(10px); }

/* ── Results Area ────────────────────────────────────────────────────────────── */

.results-area {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

/* ── Assistant Card ──────────────────────────────────────────────────────────── */

.assistant-card {
  display: flex;
  gap: 1rem;
  padding: 1.125rem 1.25rem;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.04) 0%, rgba(34, 211, 238, 0.03) 100%);
  border: 1px solid rgba(16, 185, 129, 0.15);
  border-radius: var(--border-radius);
  backdrop-filter: blur(12px);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.5s ease, transform 0.5s ease;
}

.assistant-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(16, 185, 129, 0.4), rgba(34, 211, 238, 0.4), transparent);
}

.assistant-card.assistant-visible {
  opacity: 1;
  transform: translateY(0);
}

.assistant-avatar {
  flex-shrink: 0;
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-ring-outer {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid rgba(16, 185, 129, 0.2);
  animation: ring-rotate 6s linear infinite;
}

.avatar-ring-inner {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1.5px solid transparent;
  border-top-color: var(--color-accent);
  border-right-color: rgba(16, 185, 129, 0.3);
  animation: ring-rotate 2s linear infinite;
}

@keyframes ring-rotate {
  to { transform: rotate(360deg); }
}

.avatar-core {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(34, 211, 238, 0.1));
  border: 1px solid rgba(16, 185, 129, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-accent);
}

.assistant-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  justify-content: center;
}

.assistant-header-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.assistant-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  font-weight: 600;
  color: var(--color-accent);
  font-family: var(--font-mono);
}

.assistant-badge {
  padding: 0.1rem 0.4rem;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 4px;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--color-accent);
  letter-spacing: 0.08em;
}

.assistant-text {
  font-size: 0.88rem;
  color: var(--color-gray-200);
  line-height: 1.65;
  margin: 0;
}

.type-cursor {
  display: inline-block;
  color: var(--color-accent);
  font-weight: 300;
  animation: cursor-blink 0.7s step-end infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ── Stats Row ───────────────────────────────────────────────────────────────── */

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.625rem;
}

.stat-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  padding: 1rem 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  backdrop-filter: blur(12px);
  position: relative;
  overflow: hidden;
  animation: slideUpFade 0.4s ease both;
  transition: border-color 0.3s, box-shadow 0.3s;
}

.stat-card:hover {
  border-color: var(--stat-color);
  box-shadow: 0 0 20px var(--stat-glow);
}

.stat-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--stat-color);
  opacity: 0.6;
}

@keyframes slideUpFade {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

.stat-icon-wrap {
  color: var(--stat-color);
  opacity: 0.8;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--stat-color);
  font-family: var(--font-mono);
  line-height: 1;
  letter-spacing: -0.02em;
}

.stat-label {
  font-size: 0.7rem;
  color: var(--color-gray-500);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 500;
}

.stat-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.04);
}

.stat-bar-fill {
  height: 100%;
  background: var(--stat-color);
  opacity: 0.3;
  transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
}

/* ── Insights Chips ──────────────────────────────────────────────────────────── */

.insights-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.insight-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  animation: chipPop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes chipPop {
  from { opacity: 0; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1); }
}

.chip-num {
  background: rgba(34, 211, 238, 0.08);
  border: 1px solid rgba(34, 211, 238, 0.2);
  color: var(--color-cyan);
}

.chip-txt {
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.2);
  color: #a78bfa;
}

.chip-stat {
  background: rgba(16, 185, 129, 0.07);
  border: 1px solid rgba(16, 185, 129, 0.18);
  color: var(--color-accent-light);
}

.chip-info {
  background: rgba(251, 191, 36, 0.07);
  border: 1px solid rgba(251, 191, 36, 0.2);
  color: #fbbf24;
}

.chip-good {
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.25);
  color: var(--color-accent);
}

.chip-warn {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

/* ── Empty State ─────────────────────────────────────────────────────────────── */

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

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
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

/* ── Error ───────────────────────────────────────────────────────────────────── */

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

/* ── Table ───────────────────────────────────────────────────────────────────── */

.table-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--border-radius);
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.table-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.25);
}

.table-title-text {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.74rem;
  font-weight: 500;
  color: var(--color-gray-500);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.col-type-legend {
  display: flex;
  gap: 0.875rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.7rem;
  color: var(--color-gray-600);
}

.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.legend-num .legend-dot { background: var(--color-cyan); }
.legend-txt .legend-dot { background: var(--color-gray-500); }

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

th.th-number {
  text-align: right;
}

.th-type-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 0.3rem;
  vertical-align: middle;
}

.dot-num { background: var(--color-cyan); opacity: 0.7; }
.dot-txt { background: var(--color-gray-500); opacity: 0.5; }

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

td.cell-null {
  text-align: center;
}

.null-badge {
  padding: 0.1rem 0.45rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 4px;
  font-size: 0.7rem;
  color: rgba(248, 113, 113, 0.7);
  letter-spacing: 0.02em;
}

tr.row-even td {
  background: rgba(255, 255, 255, 0.015);
}

tr:hover td {
  background: rgba(16, 185, 129, 0.04) !important;
}

.row-animate {
  animation: rowSlideIn 0.35s ease both;
}

@keyframes rowSlideIn {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
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

@media (max-width: 1100px) {
  .stats-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 900px) {
  .playground-layout {
    grid-template-columns: 1fr;
  }

  .history-sidebar {
    position: static;
    max-height: none;
  }

  .pipeline-stages {
    flex-direction: column;
    gap: 0.5rem;
  }

  .stage-connector {
    display: none;
  }

  .pipeline-stage {
    flex-direction: row;
    text-align: left;
    gap: 0.75rem;
  }

  .stage-text {
    padding: 0;
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

  .stats-row {
    grid-template-columns: repeat(2, 1fr);
  }

  .assistant-card {
    flex-direction: column;
  }
}
</style>
