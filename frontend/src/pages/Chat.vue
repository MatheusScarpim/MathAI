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

        <div v-for="entry in entries" :key="entry.id" class="entry-card">
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

          <div v-if="entry.result && (entry.result.sql || entry.result.httpRequest)" class="results-container">
            <!-- Summary -->
            <div v-if="entry.result.summary" class="summary-card">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <p>{{ entry.result.summary }}</p>
            </div>

            <!-- HTTP Request (API mode) -->
            <div v-if="entry.result.httpRequest" class="sql-card">
              <div class="card-header">
                <div class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                  </svg>
                  Requisição HTTP
                  <span v-if="entry.result.cacheHit" class="cache-badge">Cache</span>
                </div>
                <div class="card-actions">
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
              <pre class="sql-code">{{ formatHttpRequest(entry.result.httpRequest) }}</pre>
            </div>

            <!-- SQL Generated (DB mode) -->
            <div v-else-if="entry.result.sql" class="sql-card">
              <div class="card-header">
                <div class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
                  </svg>
                  SQL Gerado
                  <span v-if="entry.result.cacheHit" class="cache-badge">Cache</span>
                </div>
                <div class="card-actions">
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
              <pre class="sql-code">{{ entry.result.sql }}</pre>
            </div>

            <!-- Results Table -->
            <div v-if="entry.result.rows && entry.result.rows.length > 0" class="table-card">
              <div class="card-header">
                <div class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="9" y1="21" x2="9" y2="9"/>
                  </svg>
                  Resultados
                </div>
                <span class="meta">
                  {{ entry.result.rows.length }}
                  {{ pluralize(entry.result.rows.length, 'linha', 'linhas') }}
                  em {{ entry.result.elapsedMs }}ms
                </span>
              </div>
              <div class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th v-for="col in entry.result.columns" :key="col">{{ col }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, i) in entry.result.rows" :key="i">
                      <td v-for="col in entry.result.columns" :key="col" :class="{ number: isNumber(row[col]) }">
                        {{ formatValue(row[col]) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

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

          <!-- Loading indicator - after partial results so it appears at the bottom -->
          <div v-if="entry.loading" class="entry-loading">
            <span class="spinner small"></span>
            {{ entry.stepLabel || 'Iniciando...' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../services/api'
import type { AskResponse } from '../types'

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
}

const question = ref('')
const language = ref<'pt' | 'en' | 'es'>('pt')
const schemaLanguage = ref<'pt' | 'en' | 'es'>('pt')
const sending = ref(false)
const inputFocused = ref(false)
const entries = ref<ChatEntry[]>([])
const chatId = ref(createChatId())

onMounted(async () => {
  try {
    const res = await api.getSchemaLanguage()
    schemaLanguage.value = res.schemaLanguage
  } catch {
    // keep default if settings API is unavailable
  }
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
    newTag: ''
  }
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

  const entry = makeEntry(trimmed, language.value)
  entries.value.push(entry)
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
        responseLanguage: language.value
      })
    })

    if (!res.ok || !res.body) {
      const payload = await res.json().catch(() => null)
      entry.error = {
        errorMessage: payload?.errorMessage || `HTTP ${res.status}`
      }
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
                elapsedMs: parsed.elapsedMs
              } as any
              break
            case 'done':
              entry.result = parsed
              entry.isFavorite = false
              entry.tags = []
              entry.loading = false
              break
            case 'error':
              entry.error = parsed
              entry.loading = false
              break
          }
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim()) {
      const events = parseSSEEvents(buffer + '\n\n')
      for (const { event, data } of events) {
        let parsed: any
        try { parsed = JSON.parse(data) } catch { continue }
        if (event === 'done') {
          entry.result = parsed
          entry.isFavorite = false
          entry.tags = []
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
  entries.value = []
  chatId.value = createChatId()
  question.value = ''
}

function copyContent(entry: ChatEntry, text: string) {
  navigator.clipboard.writeText(text)
  entry.copied = true
  setTimeout(() => {
    entry.copied = false
  }, 2000)
}

function formatHttpRequest(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

async function toggleFavorite(entry: ChatEntry) {
  if (!entry.result?.historyId) return
  entry.isFavorite = !entry.isFavorite
  try {
    await api.updateHistory(entry.result.historyId, { favorite: entry.isFavorite })
  } catch (e) {
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
  } catch (e) {
    entry.tags = entry.tags.filter(t => t !== tag)
  }
}

async function removeTag(entry: ChatEntry, tag: string) {
  if (!entry.result?.historyId) return
  entry.tags = entry.tags.filter(t => t !== tag)

  try {
    await api.updateHistory(entry.result.historyId, { tags: entry.tags })
  } catch (e) {
    entry.tags.push(tag)
  }
}

function isNumber(val: any): boolean {
  return typeof val === 'number'
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

function formatValue(val: any): string {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'number') return val.toLocaleString('pt-BR')
  return String(val)
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch (e) {
    return ''
  }
}
</script>

<style scoped>
.chat-page {
  padding: 2rem 2rem 4rem;
  max-width: 1100px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
}

.page-header p {
  color: var(--color-gray-500);
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

.ghost-btn {
  padding: 0.5rem 0.9rem;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--color-gray-300);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.ghost-btn:hover:not(:disabled) {
  border-color: var(--color-gray-500);
  color: var(--color-gray-100);
  background: var(--bg-card-hover);
}

.ghost-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-container {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

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
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.7), rgba(17, 24, 39, 0.6));
  border: 1px solid var(--border-color);
  border-radius: 16px;
  transition: all 0.2s;
  backdrop-filter: blur(10px);
  box-shadow: 0 15px 30px rgba(0, 0, 0, 0.25);
}

.query-input.focused {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1), 0 18px 40px rgba(0, 0, 0, 0.35);
}

.query-input svg {
  color: var(--color-gray-500);
  flex-shrink: 0;
}

.query-input input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 1rem;
  color: var(--color-gray-100);
}

.query-input input::placeholder {
  color: var(--color-gray-600);
}

.lang-select {
  padding: 0.375rem 0.5rem;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--color-gray-300);
  font-size: 0.8rem;
  cursor: pointer;
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  background: var(--color-accent);
  border: none;
  border-radius: 12px;
  color: white;
  cursor: pointer;
  transition: all 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: var(--color-accent-light);
  transform: translateY(-1px);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.query-hint {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-gray-500);
}

.hint-pill {
  padding: 0.15rem 0.5rem;
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 999px;
  color: var(--color-accent-light);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.conversation {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.entry-card {
  position: relative;
  padding: 1.25rem 1.25rem 1.5rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  overflow: hidden;
}

.entry-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 4px;
  height: 100%;
  background: linear-gradient(180deg, rgba(16, 185, 129, 0.9), rgba(34, 211, 238, 0.5));
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
  font-size: 0.75rem;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.entry-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-accent);
  box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.15);
}

.entry-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.lang-pill {
  padding: 0.15rem 0.45rem;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.4);
  color: #93c5fd;
  border-radius: 999px;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.entry-time {
  font-size: 0.8rem;
  color: var(--color-gray-500);
}

.entry-question {
  font-size: 1.05rem;
  color: var(--color-gray-100);
  margin-bottom: 0.25rem;
}

.entry-translation {
  font-size: 0.9rem;
  color: var(--color-gray-400);
  margin-bottom: 0.5rem;
}

.entry-loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--color-gray-400);
  padding-top: 0.4rem;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner.small {
  width: 14px;
  height: 14px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-card {
  display: flex;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 10px;
  color: #f87171;
  margin-top: 0.75rem;
}

.error-card strong {
  display: block;
  margin-bottom: 0.25rem;
}

.error-card p {
  font-size: 0.9rem;
  opacity: 0.8;
}

.results-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1rem;
}

.summary-card {
  display: flex;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 10px;
  color: var(--color-accent-light);
}

.summary-card svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.sql-card, .table-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-gray-300);
}

.cache-badge {
  padding: 0.125rem 0.5rem;
  background: rgba(59, 130, 246, 0.2);
  border-radius: 4px;
  font-size: 0.7rem;
  color: #60a5fa;
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
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.8rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  border-color: var(--color-gray-500);
  color: var(--color-gray-200);
}

.action-btn.active {
  background: rgba(251, 191, 36, 0.1);
  border-color: rgba(251, 191, 36, 0.3);
  color: #fbbf24;
}

.sql-code {
  padding: 1.25rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--color-gray-300);
  overflow-x: auto;
  margin: 0;
  white-space: pre-wrap;
}

.meta {
  font-size: 0.8rem;
  color: var(--color-accent);
}

.table-wrapper {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

th {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-gray-400);
  background: rgba(0, 0, 0, 0.2);
}

td {
  font-size: 0.875rem;
  color: var(--color-gray-200);
}

td.number {
  text-align: right;
  font-family: 'SF Mono', monospace;
}

tr:hover td {
  background: rgba(16, 185, 129, 0.05);
}

.tags-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.tags-section label {
  font-size: 0.85rem;
  color: var(--color-gray-500);
}

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
  padding: 0.25rem 0.5rem;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--color-accent);
}

.tag button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  opacity: 0.7;
}

.tag button:hover {
  opacity: 1;
}

.tags-input input {
  flex: 1;
  min-width: 120px;
  background: none;
  border: none;
  outline: none;
  font-size: 0.85rem;
  color: var(--color-gray-200);
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100px;
  height: 100px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  color: var(--color-gray-600);
  margin-bottom: 1.5rem;
}

.empty-state h3 {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
}

.empty-state p {
  color: var(--color-gray-500);
}

@media (max-width: 720px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .query-input {
    flex-direction: column;
    align-items: stretch;
  }

  .query-input svg {
    display: none;
  }

  .send-btn {
    width: 100%;
  }

  .entry-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
