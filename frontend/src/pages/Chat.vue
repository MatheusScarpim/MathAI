<template>
  <div class="chat-page">
    <header class="page-header">
      <div>
        <h1>Perguntar</h1>
        <p>Faça perguntas em linguagem natural sobre seus dados</p>
      </div>
      <div class="header-actions">
        <button class="ghost-btn" @click="resetConversation" :disabled="!entries.length">
          Nova conversa
        </button>
      </div>
    </header>

    <div class="chat-container">
      <!-- Query Input -->
      <div class="query-section">
        <div class="query-input" :class="{ focused: inputFocused }">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            v-model="question"
            type="text"
            placeholder="Ex: Qual foi o faturamento total em janeiro de 2024?"
            @keyup.enter="ask"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
          <select v-model="language" class="lang-select" title="Idioma da resposta">
            <option value="pt">PT</option>
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
          <button class="send-btn" @click="ask" :disabled="sending || !question.trim()">
            <svg v-if="!sending" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            <span v-else class="spinner"></span>
          </button>
        </div>
        <div class="query-hint" v-if="entries.length">
          <span class="hint-pill">Sessão ativa</span>
          <span class="hint-text">
            {{ entries.length }} {{ pluralize(entries.length, 'pergunta', 'perguntas') }}
          </span>
        </div>
      </div>

      <!-- Conversation -->
      <div class="conversation">
        <!-- Empty State -->
        <div v-if="!entries.length && !sending" class="empty-state">
          <div class="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <h3>Faça uma pergunta</h3>
          <p>Digite uma pergunta em linguagem natural e receba o SQL e os resultados.</p>
        </div>

        <TransitionGroup name="entry" tag="div" class="entries-list">
          <div v-for="entry in entries" :key="entry.id" class="entry-card">
            <!-- Entry header -->
            <div class="entry-header">
              <div class="entry-label">
                <span class="entry-dot"></span>
                Pergunta
              </div>
              <div class="entry-meta">
                <span class="lang-pill">{{ entry.language.toUpperCase() }}</span>
                <span class="entry-time">{{ formatTime(entry.createdAt) }}</span>
              </div>
            </div>

            <p class="entry-question">{{ entry.question }}</p>
            <p
              v-if="entry.result?.translatedQuestion && entry.result.translatedQuestion !== entry.question"
              class="entry-translation"
            >
              Pergunta (db): {{ entry.result.translatedQuestion }}
            </p>

            <!-- Error -->
            <div v-if="entry.error" class="error-card">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <strong>{{ entry.error.errorMessage }}</strong>
                <p v-if="entry.error.hint">{{ entry.error.hint }}</p>
              </div>
            </div>

            <!-- Results -->
            <div v-if="entry.result && (entry.result.sql || entry.result.httpRequest)" class="results-container">

              <!-- AI Assistant Summary -->
              <div
                v-if="entry.result.summary"
                class="assistant-card"
                :class="{ 'assistant-visible': !entry.loading }"
              >
                <div class="assistant-avatar">
                  <div class="avatar-ring-outer"></div>
                  <div class="avatar-ring-inner"></div>
                  <div class="avatar-core">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                  </div>
                </div>
                <div class="assistant-body">
                  <div class="assistant-header-row">
                    <span class="assistant-label">Análise</span>
                    <span class="assistant-badge">IA</span>
                    <span v-if="entry.result.cacheHit" class="cache-badge-sm">Cache</span>
                  </div>
                  <p class="assistant-text">
                    {{ entry.summaryTyped }}<span v-if="entry.summaryTyping" class="type-cursor">|</span>
                  </p>
                </div>
              </div>

              <!-- HTTP Request -->
              <div v-if="entry.result.httpRequest" class="sql-card">
                <div class="card-header" @click="entry.sqlExpanded = !entry.sqlExpanded" style="cursor:pointer">
                  <div class="card-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                    Requisição HTTP
                    <span v-if="entry.result.cacheHit" class="cache-badge">Cache</span>
                  </div>
                  <div class="card-actions" @click.stop>
                    <button class="action-btn expand-btn" @click="entry.sqlExpanded = !entry.sqlExpanded" :title="entry.sqlExpanded ? 'Colapsar' : 'Expandir'">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                           :style="{ transform: entry.sqlExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                      {{ entry.sqlExpanded ? 'Colapsar' : 'Expandir' }}
                    </button>
                    <button class="action-btn" @click="copyContent(entry, entry.result.httpRequest!)" :title="entry.copied ? 'Copiado!' : 'Copiar'">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      {{ entry.copied ? 'Copiado!' : 'Copiar' }}
                    </button>
                    <button
                      v-if="entry.result.historyId"
                      class="action-btn"
                      :class="{ active: entry.isFavorite }"
                      @click="toggleFavorite(entry)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" :fill="entry.isFavorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      Favorito
                    </button>
                  </div>
                </div>
                <div class="collapsible" :class="{ expanded: entry.sqlExpanded }">
                  <div><pre class="sql-code">{{ formatHttpRequest(entry.result.httpRequest) }}</pre></div>
                </div>
              </div>

              <!-- SQL Generated -->
              <div v-else-if="entry.result.sql" class="sql-card">
                <div class="card-header" @click="entry.sqlExpanded = !entry.sqlExpanded" style="cursor:pointer">
                  <div class="card-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="16 18 22 12 16 6"/>
                      <polyline points="8 6 2 12 8 18"/>
                    </svg>
                    SQL Gerado
                    <span v-if="entry.result.cacheHit" class="cache-badge">Cache</span>
                  </div>
                  <div class="card-actions" @click.stop>
                    <button class="action-btn expand-btn" @click="entry.sqlExpanded = !entry.sqlExpanded" :title="entry.sqlExpanded ? 'Colapsar' : 'Expandir'">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                           :style="{ transform: entry.sqlExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                      {{ entry.sqlExpanded ? 'Colapsar' : 'Expandir' }}
                    </button>
                    <button class="action-btn" @click="copyContent(entry, entry.result.sql)" :title="entry.copied ? 'Copiado!' : 'Copiar SQL'">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      {{ entry.copied ? 'Copiado!' : 'Copiar' }}
                    </button>
                    <button
                      v-if="entry.result.historyId"
                      class="action-btn"
                      :class="{ active: entry.isFavorite }"
                      @click="toggleFavorite(entry)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" :fill="entry.isFavorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      Favorito
                    </button>
                  </div>
                </div>
                <div class="collapsible" :class="{ expanded: entry.sqlExpanded }">
                  <div><pre class="sql-code">{{ entry.result.sql }}</pre></div>
                </div>
              </div>

              <!-- Results Table -->
              <div v-if="entry.result.rows && entry.result.rows.length > 0" class="table-card">
                <div class="card-header" @click="entry.tableExpanded = !entry.tableExpanded" style="cursor:pointer">
                  <div class="card-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <line x1="3" y1="9" x2="21" y2="9"/>
                      <line x1="9" y1="21" x2="9" y2="9"/>
                    </svg>
                    Resultados
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         :style="{ transform: entry.tableExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', color: 'var(--color-gray-500)' }">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  <div class="table-stats" @click.stop>
                    <span class="tstat tstat-rows">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                      {{ entry.result.rows.length }} {{ pluralize(entry.result.rows.length, 'linha', 'linhas') }}
                    </span>
                    <span class="tstat tstat-time">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      {{ entry.result.elapsedMs }}ms
                    </span>
                  </div>
                </div>
                <div class="collapsible" :class="{ expanded: entry.tableExpanded }">
                  <div><div class="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th v-for="col in entry.result.columns" :key="col"
                              :class="{ 'th-number': isColumnNumeric(entry, col) }">
                            <span class="th-dot" :class="isColumnNumeric(entry, col) ? 'dot-num' : 'dot-txt'"></span>
                            {{ col }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="(row, i) in entry.result.rows"
                          :key="i"
                          class="row-animate"
                          :style="{ animationDelay: `${Math.min(i * 25, 700)}ms` }"
                        >
                          <td
                            v-for="col in entry.result.columns"
                            :key="col"
                            :class="{
                              number: isNumericCell(entry, col, row[col]),
                              'cell-null': row[col] === null || row[col] === undefined
                            }"
                          >
                            <span v-if="row[col] === null || row[col] === undefined" class="null-badge">null</span>
                            <span v-else>{{ formatCell(row[col], formatOf(entry, col)) }}</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <!-- Insights chips -->
                  <div v-if="getInsights(entry).length" class="insights-row">
                    <div
                      v-for="(chip, ci) in getInsights(entry)"
                      :key="ci"
                      class="insight-chip"
                      :class="`chip-${chip.type}`"
                      :style="{ animationDelay: `${ci * 60}ms` }"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" v-html="chip.iconPath"></svg>
                      {{ chip.text }}
                    </div>
                  </div>
                  </div>
                </div>
              </div>

              <!-- Chart -->
              <div v-if="entry.result.chart && entry.result.chart.data.length > 0" class="chart-card">
                <div class="card-header">
                  <div class="card-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                    </svg>
                    {{ entry.result.chart.title || 'Gráfico' }}
                  </div>
                </div>
                <BarChart
                  :data="entry.result.chart.data.map((d: any) => ({ category: String(d.category ?? d[entry.result!.chart!.xKey!] ?? ''), value: typeof d.value === 'number' ? d.value : (d[entry.result!.chart!.yKey!] ?? null) }))"
                  :title="entry.result.chart.title"
                  :height="200"
                />
              </div>

              <!-- Pipeline Debug -->
              <PipelineDebug
                v-if="!entry.loading && (entry.steps.length > 0 || entry.result.tokenUsage)"
                :steps="entry.steps"
                :token-usage="entry.result.tokenUsage"
                :cache-hit="entry.result.cacheHit"
                :translated-question="entry.result.translatedQuestion"
                :elapsed-ms="entry.result.elapsedMs"
                :history-id="entry.result.historyId"
                :chat-id="entry.result.chatId"
              />

              <!-- Tags -->
              <div v-if="entry.result.historyId" class="tags-section">
                <label>Tags:</label>
                <div class="tags-input">
                  <span v-for="tag in entry.tags" :key="tag" class="tag">
                    {{ tag }}
                    <button @click="removeTag(entry, tag)">&times;</button>
                  </span>
                  <input
                    v-model="entry.newTag"
                    type="text"
                    placeholder="Adicionar tag..."
                    @keyup.enter="addTag(entry)"
                  />
                </div>
              </div>
            </div>

            <!-- Step timeline during loading -->
            <div v-if="entry.loading" class="step-timeline">
              <div
                v-for="(step, si) in entry.steps"
                :key="si"
                class="timeline-step"
                :class="si === entry.steps.length - 1 ? 'step-current' : 'step-done'"
              >
                <div class="timeline-node">
                  <svg v-if="si < entry.steps.length - 1" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  <div v-else class="node-pulse"></div>
                </div>
                <div class="timeline-track" v-if="si < entry.steps.length - 1"></div>
                <span class="timeline-label">{{ step.label }}</span>
              </div>
              <div v-if="!entry.steps.length" class="timeline-step step-current">
                <div class="timeline-node"><div class="node-pulse"></div></div>
                <span class="timeline-label">{{ entry.stepLabel || 'Iniciando...' }}</span>
              </div>
            </div>

          </div>
        </TransitionGroup>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, inject, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import { api } from '../services/api'
import type { AskResponse, ColumnFormat, PipelineStep } from '../types'
import { formatCell, isNumericFormat, toNumber } from '../utils/formatters'
import PipelineDebug from '../components/PipelineDebug.vue'
import BarChart from '../components/BarChart.vue'

const selectedEnvironmentId = inject<Ref<string | undefined>>('selectedEnvironmentId')
const environmentVersion = inject<Ref<number>>('environmentVersion')

type ChatEntry = {
  id: string
  question: string
  language: 'pt' | 'en' | 'es'
  createdAt: number
  loading: boolean
  stepLabel: string
  error: AskResponse['error'] | null
  result: AskResponse['data'] | null
  copied: boolean
  isFavorite: boolean
  tags: string[]
  newTag: string
  steps: PipelineStep[]
  summaryTyped: string
  summaryTyping: boolean
  sqlExpanded: boolean
  tableExpanded: boolean
}

const question = ref('')
const language = ref<'pt' | 'en' | 'es'>('pt')
const schemaLanguage = ref<'pt' | 'en' | 'es'>('pt')
const sending = ref(false)
const inputFocused = ref(false)
const entries = ref<ChatEntry[]>([])
const chatId = ref(createChatId())

const typewriterTimers = new Map<string, ReturnType<typeof setInterval>>()

onMounted(async () => {
  try {
    const res = await api.getSchemaLanguage()
    schemaLanguage.value = res.schemaLanguage
  } catch {
    // keep default
  }
})

onBeforeUnmount(() => {
  typewriterTimers.forEach(timer => clearInterval(timer))
  typewriterTimers.clear()
})

function createChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeEntry(questionText: string, lang: 'pt' | 'en' | 'es'): ChatEntry {
  return {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    question: questionText,
    language: lang,
    createdAt: Date.now(),
    loading: true,
    stepLabel: 'Iniciando...',
    error: null,
    result: null,
    copied: false,
    isFavorite: false,
    tags: [],
    newTag: '',
    steps: [],
    summaryTyped: '',
    summaryTyping: false,
    sqlExpanded: false,
    tableExpanded: false
  }
}

function startSummaryTypewriter(entry: ChatEntry) {
  const text = entry.result?.summary
  if (!text) return
  entry.summaryTyped = ''
  entry.summaryTyping = true
  let i = 0
  const timer = setInterval(() => {
    if (i < text.length) {
      entry.summaryTyped += text[i++]
    } else {
      entry.summaryTyping = false
      clearInterval(timer)
      typewriterTimers.delete(entry.id)
    }
  }, 20)
  typewriterTimers.set(entry.id, timer)
}

function parseSSEEvents(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    if (!block.trim()) continue
    const eventMatch = block.match(/^event: (.+)$/m)
    const dataMatch = block.match(/^data: (.+)$/m)
    if (eventMatch && dataMatch) {
      events.push({ event: eventMatch[1], data: dataMatch[1] })
    }
  }
  return events
}

async function ask() {
  const trimmed = question.value.trim()
  if (!trimmed || sending.value) return

  entries.value.push(makeEntry(trimmed, language.value))
  const entry = entries.value[entries.value.length - 1]
  question.value = ''
  sending.value = true

  try {
    const res = await fetch('/api/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: trimmed,
        chatId: chatId.value,
        language: language.value,
        schemaLanguage: schemaLanguage.value,
        responseLanguage: language.value,
        environmentId: selectedEnvironmentId?.value
      })
    })

    if (!res.ok || !res.body) {
      const payload = await res.json().catch(() => null)
      entry.error = { errorMessage: payload?.errorMessage || `HTTP ${res.status}` }
      entry.loading = false
      sending.value = false
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()!

      for (const block of parts) {
        const events = parseSSEEvents(block + '\n\n')
        for (const { event, data } of events) {
          let parsed: any
          try { parsed = JSON.parse(data) } catch { continue }

          switch (event) {
            case 'step':
              entry.stepLabel = parsed.label ?? ''
              entry.steps.push({ step: parsed.step ?? '', label: parsed.label ?? '', timestamp: Date.now() })
              break
            case 'sql':
              entry.result = { ...(entry.result ?? {}), sql: parsed.sql } as any
              break
            case 'httpRequest':
              entry.result = { ...(entry.result ?? {}), httpRequest: parsed.httpRequest } as any
              break
            case 'rows':
              entry.result = {
                ...(entry.result ?? {}),
                rows: parsed.rows,
                columns: parsed.columns,
                // Vem no mesmo evento das linhas de proposito: sem isso a
                // tabela renderizaria crua durante o streaming e so se
                // reformataria no `done`, piscando na frente do usuario.
                columnFormats: parsed.columnFormats,
                elapsedMs: parsed.elapsedMs
              } as any
              break
            case 'done':
              entry.result = parsed
              entry.isFavorite = false
              entry.tags = []
              entry.loading = false
              setTimeout(() => startSummaryTypewriter(entry), 350)
              break
            case 'error':
              entry.error = parsed
              entry.loading = false
              break
          }
        }
      }
    }

    if (buffer.trim()) {
      const events = parseSSEEvents(buffer + '\n\n')
      for (const { event, data } of events) {
        let parsed: any
        try { parsed = JSON.parse(data) } catch { continue }
        if (event === 'done') {
          entry.result = parsed
          entry.isFavorite = false
          entry.tags = []
          setTimeout(() => startSummaryTypewriter(entry), 350)
        } else if (event === 'error') {
          entry.error = parsed
        }
      }
    }
  } catch (e: any) {
    entry.error = { errorMessage: e.message || 'Erro ao processar pergunta' }
  } finally {
    entry.loading = false
    sending.value = false
  }
}

function resetConversation() {
  typewriterTimers.forEach(timer => clearInterval(timer))
  typewriterTimers.clear()
  entries.value = []
  chatId.value = createChatId()
  question.value = ''
}

if (environmentVersion) {
  watch(environmentVersion, () => { resetConversation() })
}

function copyContent(entry: ChatEntry, text: string) {
  navigator.clipboard.writeText(text)
  entry.copied = true
  setTimeout(() => { entry.copied = false }, 2000)
}

function formatHttpRequest(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

async function toggleFavorite(entry: ChatEntry) {
  if (!entry.result?.historyId) return
  entry.isFavorite = !entry.isFavorite
  try {
    await api.updateHistory(entry.result.historyId, { favorite: entry.isFavorite })
  } catch {
    entry.isFavorite = !entry.isFavorite
  }
}

async function addTag(entry: ChatEntry) {
  if (!entry.newTag.trim() || !entry.result?.historyId) return
  const tag = entry.newTag.trim().toLowerCase()
  if (entry.tags.includes(tag)) return
  entry.tags.push(tag)
  entry.newTag = ''
  try {
    await api.updateHistory(entry.result.historyId, { tags: entry.tags })
  } catch {
    entry.tags = entry.tags.filter(t => t !== tag)
  }
}

async function removeTag(entry: ChatEntry, tag: string) {
  if (!entry.result?.historyId) return
  entry.tags = entry.tags.filter(t => t !== tag)
  try {
    await api.updateHistory(entry.result.historyId, { tags: entry.tags })
  } catch {
    entry.tags.push(tag)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNumber(val: any): boolean {
  return typeof val === 'number'
}

/** Mascara da coluna, quando o backend derivou uma. */
function formatOf(entry: ChatEntry, col: string): ColumnFormat | undefined {
  return entry.result?.columnFormats?.[col]
}

/**
 * Alinhamento da coluna.
 *
 * A mascara decide quando existe, e e por isso que chave surrogate para de
 * alinhar a direita. Sem mascara (resposta de cache antigo) sobra o palpite
 * antigo pelo `typeof` do dado.
 */
function isColumnNumeric(entry: ChatEntry, col: string): boolean {
  const format = formatOf(entry, col)
  if (format) return isNumericFormat(format)
  return !!entry.result?.rows?.some(r => typeof r[col] === 'number')
}

/** Alinhamento da celula, coerente com o cabecalho pela mesma razao. */
function isNumericCell(entry: ChatEntry, col: string, val: unknown): boolean {
  const format = formatOf(entry, col)
  if (format) return isNumericFormat(format)
  return isNumber(val)
}

function getInsights(entry: ChatEntry) {
  const rows = entry.result?.rows
  const columns = entry.result?.columns
  const elapsedMs = entry.result?.elapsedMs
  if (!rows || !columns || rows.length === 0) return []

  const chips: { text: string; type: string; iconPath: string }[] = []

  // A mascara decide o que e numero, pela mesma razao que decide na tabela.
  // Antes daqui o chip usava `typeof r[col] === 'number'` por conta propria e
  // contradizia a tabela logo acima: chave surrogate entrava na contagem de
  // colunas numericas e saia "Max SK_PRODUTO: 1.234", enquanto a celula ja
  // mostrava "1234". Sem mascara sobra o palpite antigo pelo tipo do dado.
  const isNumericCol = (col: string): boolean => {
    const format = formatOf(entry, col)
    if (format) return isNumericFormat(format)
    return rows.some(r => typeof r[col] === 'number')
  }

  const numericCols = columns.filter(isNumericCol)
  const textCols = columns.filter(col => !isNumericCol(col) && rows.some(r => typeof r[col] === 'string'))

  if (numericCols.length > 0)
    chips.push({ text: `${numericCols.length} col. numérica${numericCols.length > 1 ? 's' : ''}`, type: 'num', iconPath: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' })

  if (numericCols.length > 0) {
    const col = numericCols[0]
    // `toNumber` e nao `typeof`: mssql manda BIGINT/DECIMAL como string para
    // nao perder precisao, e a coluna de dinheiro caia fora da conta.
    const vals = rows.map(r => toNumber(r[col])).filter((v): v is number => v !== null)
    if (vals.length > 0) {
      const max = Math.max(...vals)
      chips.push({ text: `Máx ${col}: ${formatCell(max, formatOf(entry, col))}`, type: 'stat', iconPath: '<polyline points="18 15 12 9 6 15"/>' })
    }
  }

  if (textCols.length > 0) {
    const col = textCols[0]
    const distinct = new Set(rows.map(r => String(r[col] ?? ''))).size
    chips.push({ text: `${distinct} únicos em "${col}"`, type: 'info', iconPath: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' })
  }

  if (elapsedMs !== undefined) {
    if (elapsedMs < 200)
      chips.push({ text: 'Resposta rápida', type: 'good', iconPath: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' })
    else if (elapsedMs > 2000)
      chips.push({ text: 'Alta latência', type: 'warn', iconPath: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' })
  }

  return chips
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}
</script>

<style scoped>
.chat-page {
  padding: 2rem 2rem 4rem;
  max-width: 100%;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
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

.header-actions { display: flex; gap: 0.75rem; }

.ghost-btn {
  padding: 0.5rem 1rem;
  background: var(--glass-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  color: var(--color-gray-300);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.25s ease;
}

.ghost-btn:hover:not(:disabled) {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-100);
  background: rgba(255, 255, 255, 0.06);
}

.ghost-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.chat-container {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Query Input ─────────────────────────────────────────────────────────────── */

.query-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.query-input {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  transition: all 0.3s ease;
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  box-shadow: var(--shadow-md);
}

.query-input.focused {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.08), var(--glow-accent), var(--shadow-md);
}

.query-input svg { color: var(--color-gray-500); flex-shrink: 0; transition: color 0.2s; }
.query-input.focused svg { color: var(--color-accent); }

.query-input input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 1rem;
  color: var(--color-gray-100);
}

.query-input input::placeholder { color: var(--color-gray-600); }

.lang-select {
  padding: 0.375rem 0.5rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-300);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}

.lang-select:hover { border-color: var(--glass-border-hover); }

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-dark));
  border: none;
  border-radius: 12px;
  color: white;
  cursor: pointer;
  transition: all 0.25s ease;
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);
}

.send-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-accent));
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(16, 185, 129, 0.35);
}

.send-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }

.query-hint {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-gray-500);
}

.hint-pill {
  padding: 0.2rem 0.6rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 999px;
  color: var(--color-accent);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
}

/* ── Spinner ─────────────────────────────────────────────────────────────────── */

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ── Conversation / Entry Cards ──────────────────────────────────────────────── */

.conversation { display: flex; flex-direction: column; gap: 1.25rem; }
.entries-list { display: flex; flex-direction: column; gap: 1.25rem; }

.entry-enter-active {
  animation: entrySlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes entrySlideIn {
  from { opacity: 0; transform: translateY(20px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.entry-card {
  position: relative;
  padding: 1.25rem 1.25rem 1.5rem;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.entry-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-sm);
}

.entry-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 100%;
  background: linear-gradient(180deg, var(--color-accent) 0%, var(--color-cyan) 100%);
  opacity: 0.8;
}

.entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.entry-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
}

.entry-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1), 0 0 8px rgba(16, 185, 129, 0.3);
}

.entry-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.lang-pill {
  padding: 0.15rem 0.5rem;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.25);
  color: #a5b4fc;
  border-radius: 999px;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 500;
}

.entry-time { font-size: 0.78rem; color: var(--color-gray-500); }

.entry-question {
  font-size: 1.05rem;
  color: var(--color-gray-100);
  margin-bottom: 0.25rem;
  line-height: 1.5;
}

.entry-translation {
  font-size: 0.88rem;
  color: var(--color-gray-400);
  margin-bottom: 0.5rem;
  font-style: italic;
}

/* ── Step Timeline ───────────────────────────────────────────────────────────── */

.step-timeline {
  display: flex;
  align-items: center;
  gap: 0;
  flex-wrap: wrap;
  row-gap: 0.5rem;
  padding-top: 0.875rem;
  margin-top: 0.25rem;
  border-top: 1px solid var(--glass-border);
}

.timeline-step {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.timeline-node {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}

.step-done .timeline-node {
  background: rgba(16, 185, 129, 0.12);
  border: 1.5px solid rgba(16, 185, 129, 0.3);
  color: var(--color-accent);
}

.step-current .timeline-node {
  background: rgba(34, 211, 238, 0.08);
  border: 1.5px solid rgba(34, 211, 238, 0.3);
}

.node-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-cyan);
  animation: nodePulse 1s ease-in-out infinite;
  box-shadow: 0 0 6px rgba(34, 211, 238, 0.5);
}

@keyframes nodePulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.4); opacity: 0.6; }
}

.timeline-track {
  width: 20px;
  height: 1px;
  background: var(--glass-border);
  flex-shrink: 0;
}

.timeline-label {
  font-size: 0.76rem;
  white-space: nowrap;
  margin-right: 0.4rem;
}

.step-done .timeline-label { color: var(--color-gray-500); }
.step-current .timeline-label { color: var(--color-gray-300); }

/* ── Error ───────────────────────────────────────────────────────────────────── */

.error-card {
  display: flex;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 12px;
  color: #f87171;
  margin-top: 0.75rem;
  backdrop-filter: blur(8px);
}

.error-card strong { display: block; margin-bottom: 0.25rem; }
.error-card p { font-size: 0.88rem; opacity: 0.8; }

/* ── Results container ───────────────────────────────────────────────────────── */

.results-container {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
}

/* ── AI Assistant Card ───────────────────────────────────────────────────────── */

.assistant-card {
  display: flex;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.04) 0%, rgba(34, 211, 238, 0.03) 100%);
  border: 1px solid rgba(16, 185, 129, 0.15);
  border-radius: 14px;
  backdrop-filter: blur(12px);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px);
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
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-ring-outer {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid rgba(16, 185, 129, 0.15);
  animation: ring-spin 6s linear infinite;
}

.avatar-ring-inner {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1.5px solid transparent;
  border-top-color: var(--color-accent);
  border-right-color: rgba(16, 185, 129, 0.25);
  animation: ring-spin 2s linear infinite;
}

@keyframes ring-spin { to { transform: rotate(360deg); } }

.avatar-core {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(34, 211, 238, 0.08));
  border: 1px solid rgba(16, 185, 129, 0.2);
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
  gap: 0.35rem;
  justify-content: center;
}

.assistant-header-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.assistant-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  font-weight: 600;
  color: var(--color-accent);
  font-family: var(--font-mono);
}

.assistant-badge {
  padding: 0.08rem 0.4rem;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 4px;
  font-size: 0.6rem;
  font-weight: 700;
  color: var(--color-accent);
  letter-spacing: 0.08em;
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

/* ── Collapsible ─────────────────────────────────────────────────────────────── */

.collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.collapsible > * { min-height: 0; }

.collapsible.expanded {
  grid-template-rows: 1fr;
}

.expand-btn {
  color: var(--color-gray-400);
}

/* ── SQL Card ────────────────────────────────────────────────────────────────── */

.sql-card, .table-card, .chart-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.15);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-gray-300);
}

.cache-badge {
  padding: 0.15rem 0.5rem;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 6px;
  font-size: 0.65rem;
  color: #a5b4fc;
  font-weight: 500;
}

.card-actions {
  display: flex;
  gap: 0.5rem;
}

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

.action-btn.active {
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.25);
  color: #fbbf24;
}

.sql-code {
  padding: 1.25rem;
  font-family: var(--font-mono);
  font-size: 0.83rem;
  line-height: 1.7;
  color: var(--color-gray-300);
  overflow-x: auto;
  margin: 0;
  white-space: pre-wrap;
  background: rgba(0, 0, 0, 0.15);
}

/* ── Table Stats ─────────────────────────────────────────────────────────────── */

.table-stats {
  display: flex;
  gap: 0.5rem;
}

.tstat {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
}

.tstat-rows {
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.18);
  color: var(--color-accent-light);
}

.tstat-time {
  background: rgba(34, 211, 238, 0.06);
  border: 1px solid rgba(34, 211, 238, 0.15);
  color: var(--color-cyan);
}

/* ── Table ───────────────────────────────────────────────────────────────────── */

.table-wrapper { overflow-x: auto; }

table { width: 100%; border-collapse: collapse; }

th, td {
  padding: 0.65rem 1rem;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

th {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-gray-400);
  background: rgba(0, 0, 0, 0.2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

th.th-number { text-align: right; }

.th-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 0.3rem;
  vertical-align: middle;
}

.dot-num { background: var(--color-cyan); opacity: 0.7; }
.dot-txt { background: var(--color-gray-500); opacity: 0.5; }

td { font-size: 0.85rem; color: var(--color-gray-200); }

td.number {
  text-align: right;
  font-family: var(--font-mono);
  color: var(--color-accent-light);
}

td.cell-null { text-align: center; }

.null-badge {
  padding: 0.1rem 0.4rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 4px;
  font-size: 0.7rem;
  color: rgba(248, 113, 113, 0.7);
}

tr:hover td { background: rgba(16, 185, 129, 0.04); }

.row-animate { animation: rowIn 0.3s ease both; }

@keyframes rowIn {
  from { opacity: 0; transform: translateX(-8px); }
  to   { opacity: 1; transform: translateX(0); }
}

/* ── Insights Chips ──────────────────────────────────────────────────────────── */

.insights-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.625rem 1rem;
  border-top: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.08);
}

.insight-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  animation: chipPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes chipPop {
  from { opacity: 0; transform: scale(0.8); }
  to   { opacity: 1; transform: scale(1); }
}

.chip-num  { background: rgba(34, 211, 238, 0.08); border: 1px solid rgba(34, 211, 238, 0.2); color: var(--color-cyan); }
.chip-stat { background: rgba(16, 185, 129, 0.07); border: 1px solid rgba(16, 185, 129, 0.18); color: var(--color-accent-light); }
.chip-info { background: rgba(251, 191, 36, 0.07); border: 1px solid rgba(251, 191, 36, 0.2); color: #fbbf24; }
.chip-good { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); color: var(--color-accent); }
.chip-warn { background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); color: #f59e0b; }

/* ── Tags ────────────────────────────────────────────────────────────────────── */

.tags-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
}

.tags-section label { font-size: 0.82rem; color: var(--color-gray-500); }

.tags-input {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  flex: 1;
}

.tag {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.15);
  border-radius: 6px;
  font-size: 0.78rem;
  color: var(--color-accent);
}

.tag button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  opacity: 0.6;
  transition: opacity 0.15s;
}

.tag button:hover { opacity: 1; }

.tags-input input {
  flex: 1;
  min-width: 120px;
  background: none;
  border: none;
  outline: none;
  font-size: 0.83rem;
  color: var(--color-gray-200);
}

/* ── Empty State ─────────────────────────────────────────────────────────────── */

.empty-state {
  text-align: center;
  padding: 5rem 2rem;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100px;
  height: 100px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 24px;
  color: var(--color-gray-600);
  margin-bottom: 1.5rem;
  animation: float 4s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.empty-state h3 { font-size: 1.25rem; margin-bottom: 0.5rem; }
.empty-state p { color: var(--color-gray-500); font-size: 0.9rem; }

/* ── Responsive ──────────────────────────────────────────────────────────────── */

@media (max-width: 720px) {
  .chat-page { padding: 1.5rem 1rem 3rem; }

  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .query-input {
    flex-direction: column;
    align-items: stretch;
  }

  .query-input svg { display: none; }
  .send-btn { width: 100%; height: 44px; }

  .entry-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .assistant-card {
    flex-direction: column;
  }

  .step-timeline {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .timeline-track { display: none; }
}
</style>
