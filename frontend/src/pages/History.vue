<template>
  <div class="history-page">
    <header class="page-header">
      <div>
        <h1>Histórico</h1>
        <p>Veja todas as perguntas anteriores e seus resultados</p>
      </div>
    </header>

    <!-- Filters -->
    <div class="filters-section">
      <div class="filters-row">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Buscar pergunta..."
          class="search-input"
        />
        <div class="filter-buttons">
          <button
            class="filter-btn"
            :class="{ active: filter === 'all' }"
            @click="filter = 'all'; currentPage = 1"
          >
            Todos
          </button>
          <button
            class="filter-btn"
            :class="{ active: filter === 'favorites' }"
            @click="filter = 'favorites'; currentPage = 1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            Favoritos
          </button>
          <button
            class="filter-btn"
            :class="{ active: filter === 'errors' }"
            @click="filter = 'errors'; currentPage = 1"
          >
            Erros
          </button>
        </div>
      </div>
      <div class="filters-row">
        <div class="date-filters">
          <label>
            De:
            <input type="date" v-model="dateFrom" class="date-input" />
          </label>
          <label>
            Até:
            <input type="date" v-model="dateTo" class="date-input" />
          </label>
          <button v-if="dateFrom || dateTo" class="clear-dates-btn" @click="dateFrom = ''; dateTo = ''">
            Limpar datas
          </button>
        </div>
        <div class="results-info" v-if="!loading && filteredHistory.length > 0">
          {{ filteredHistory.length }}
          {{ pluralize(filteredHistory.length, 'resultado', 'resultados') }}
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading">
      <span class="spinner"></span>
      Carregando histórico...
    </div>

    <!-- Error -->
    <div v-else-if="error" class="error-card">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      {{ error }}
    </div>

    <!-- Empty State -->
    <div v-else-if="filteredHistory.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <h3>{{ filter === 'all' ? 'Nenhuma pergunta ainda' : 'Nenhum item encontrado' }}</h3>
      <p>{{ filter === 'all' ? 'Faça uma pergunta na aba "Perguntar" para começar.' : 'Tente outro filtro.' }}</p>
    </div>

    <!-- History List -->
    <div v-else class="history-list">
      <div
        v-for="item in paginatedHistory"
        :key="item.id"
        class="history-card"
        :class="{ error: !item.success }"
      >
        <div class="card-header">
          <div class="card-meta">
            <span class="status-badge" :class="item.success !== false ? 'success' : 'fail'">
              {{ item.success !== false ? 'OK' : 'ERRO' }}
            </span>
            <span class="date">{{ formatDate(item.createdAt) }}</span>
            <span v-if="item.elapsedMs" class="time-badge">{{ item.elapsedMs }}ms</span>
            <span v-if="item.rowCount !== undefined" class="rows-badge">
              {{ item.rowCount }} {{ pluralize(item.rowCount, 'linha', 'linhas') }}
            </span>
          </div>
          <div class="card-actions">
            <button
              class="action-btn"
              :class="{ active: item.favorite }"
              @click="toggleFavorite(item)"
              title="Favorito"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" :fill="item.favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="question">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          {{ item.question }}
        </div>

        <div v-if="item.summary" class="summary">
          {{ item.summary }}
        </div>

        <div v-if="item.errorMessage" class="error-message">
          {{ item.errorMessage }}
        </div>

        <div class="sql-preview" v-if="item.sql">
          <code>{{ truncateSQL(item.sql) }}</code>
          <button
            class="copy-btn"
            :class="{ copied: copiedItemId === item.id }"
            @click="copySQL(item.id, item.sql)"
            :title="copiedItemId === item.id ? 'Copiado!' : 'Copiar SQL'"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>

        <div class="tags-row" v-if="item.tags && item.tags.length > 0">
          <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>

        <!-- Tag Editor -->
        <div class="tag-editor" v-if="editingTagsId === item.id">
          <input
            v-model="newTag"
            type="text"
            placeholder="Nova tag..."
            @keyup.enter="addTag(item)"
          />
          <button class="add-tag-btn" @click="addTag(item)">+</button>
        </div>
        <button
          v-else
          class="edit-tags-btn"
          @click="editingTagsId = item.id"
        >
          + Adicionar tags
        </button>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="pagination">
        <button
          class="page-btn"
          :disabled="currentPage === 1"
          @click="currentPage = 1"
          title="Primeira página"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
          </svg>
        </button>
        <button
          class="page-btn"
          :disabled="currentPage === 1"
          @click="currentPage--"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div class="page-numbers">
          <button
            v-for="page in visiblePages"
            :key="page"
            class="page-num"
            :class="{ active: page === currentPage }"
            @click="currentPage = page"
          >
            {{ page }}
          </button>
        </div>
        <button
          class="page-btn"
          :disabled="currentPage === totalPages"
          @click="currentPage++"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
        <button
          class="page-btn"
          :disabled="currentPage === totalPages"
          @click="currentPage = totalPages"
          title="Última página"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>
          </svg>
        </button>
        <span class="page-info">Página {{ currentPage }} de {{ totalPages }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, watch, type Ref } from 'vue'
import { api } from '../services/api'
import type { HistoryRecord } from '../types'

const environmentVersion = inject<Ref<number>>('environmentVersion')

const history = ref<HistoryRecord[]>([])
const loading = ref(true)
const error = ref('')
const filter = ref<'all' | 'favorites' | 'errors'>('all')
const editingTagsId = ref<string | null>(null)
const newTag = ref('')
const copiedItemId = ref<string | null>(null)

// Pagination
const currentPage = ref(1)
const itemsPerPage = 10

// Search and date filters
const searchQuery = ref('')
const dateFrom = ref('')
const dateTo = ref('')

// Reset page when filters change
watch([searchQuery, dateFrom, dateTo], () => {
  currentPage.value = 1
})

const filteredHistory = computed(() => {
  let result = history.value

  // Status filter
  switch (filter.value) {
    case 'favorites':
      result = result.filter(h => h.favorite)
      break
    case 'errors':
      result = result.filter(h => !h.success)
      break
  }

  // Search filter
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(h =>
      h.question.toLowerCase().includes(query) ||
      (h.sql && h.sql.toLowerCase().includes(query)) ||
      (h.summary && h.summary.toLowerCase().includes(query))
    )
  }

  // Date filters
  if (dateFrom.value) {
    const fromDate = new Date(dateFrom.value)
    fromDate.setHours(0, 0, 0, 0)
    result = result.filter(h => new Date(h.createdAt) >= fromDate)
  }

  if (dateTo.value) {
    const toDate = new Date(dateTo.value)
    toDate.setHours(23, 59, 59, 999)
    result = result.filter(h => new Date(h.createdAt) <= toDate)
  }

  return result
})

const totalPages = computed(() =>
  Math.ceil(filteredHistory.value.length / itemsPerPage)
)

const paginatedHistory = computed(() => {
  const start = (currentPage.value - 1) * itemsPerPage
  return filteredHistory.value.slice(start, start + itemsPerPage)
})

const visiblePages = computed(() => {
  const pages: number[] = []
  const total = totalPages.value
  const current = currentPage.value

  let start = Math.max(1, current - 2)
  let end = Math.min(total, current + 2)

  if (end - start < 4) {
    if (start === 1) {
      end = Math.min(total, 5)
    } else {
      start = Math.max(1, total - 4)
    }
  }

  for (let i = start; i <= end; i++) {
    pages.push(i)
  }

  return pages
})

async function loadHistory() {
  loading.value = true
  error.value = ''
  try {
    history.value = await api.getHistory()
  } catch (e: any) {
    error.value = e.message || 'Erro ao carregar histórico'
  } finally {
    loading.value = false
  }
}

onMounted(loadHistory)

// Quando troca de ambiente, recarrega historico
if (environmentVersion) {
  watch(environmentVersion, () => {
    void loadHistory()
  })
}

async function toggleFavorite(item: HistoryRecord) {
  const newValue = !item.favorite
  item.favorite = newValue

  try {
    await api.updateHistory(item.id, { favorite: newValue })
  } catch (e) {
    item.favorite = !newValue
  }
}

async function addTag(item: HistoryRecord) {
  if (!newTag.value.trim()) return
  const tag = newTag.value.trim().toLowerCase()

  if (!item.tags) item.tags = []
  if (item.tags.includes(tag)) return

  item.tags.push(tag)
  newTag.value = ''

  try {
    await api.updateHistory(item.id, { tags: item.tags })
  } catch (e) {
    item.tags = item.tags.filter(t => t !== tag)
  }
}

function copyViaFallback(sql: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = sql
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  return ok
}

async function copySQL(itemId: string, sql: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(sql)
    } else {
      const ok = copyViaFallback(sql)
      if (!ok) throw new Error('copy failed')
    }
    copiedItemId.value = itemId
    window.setTimeout(() => {
      if (copiedItemId.value === itemId) copiedItemId.value = null
    }, 1500)
  } catch {
    error.value = 'Não foi possível copiar o SQL.'
  }
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(dateStr))
}

function truncateSQL(sql: string): string {
  const lines = sql.split('\n')
  if (lines.length <= 3) return sql
  return lines.slice(0, 3).join('\n') + '\n...'
}
</script>

<style scoped>
.history-page {
  padding: 2rem 1.5rem;
  max-width: 900px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
  background: linear-gradient(135deg, var(--color-gray-50, #f8fafc), var(--color-gray-300, #cbd5e1));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.page-header p {
  color: var(--color-gray-500);
}

.filters-section {
  margin-bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1rem;
}

.filters-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.search-input {
  flex: 1;
  min-width: 200px;
  max-width: 300px;
  padding: 0.5rem 1rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--color-gray-200);
  outline: none;
  transition: all 0.25s ease;
}

.search-input:focus {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.filter-buttons {
  display: flex;
  gap: 0.5rem;
}

.date-filters {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.date-filters label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-gray-400);
}

.date-input {
  padding: 0.375rem 0.75rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--color-gray-200);
  outline: none;
  transition: all 0.25s ease;
}

.date-input:focus {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.clear-dates-btn {
  padding: 0.375rem 0.75rem;
  background: none;
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-size: 0.8rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.25s ease;
}

.clear-dates-btn:hover {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.results-info {
  font-size: 0.85rem;
  color: var(--color-gray-500);
}

.filter-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  font-size: 0.85rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.25s ease;
}

.filter-btn:hover {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.filter-btn.active {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.25);
  color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 4rem;
  color: var(--color-gray-500);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--glass-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}

.error-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.18);
  border-radius: 10px;
  color: #f87171;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
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
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  color: var(--color-gray-600);
  margin-bottom: 1.5rem;
  animation: float 4s ease-in-out infinite;
}

.empty-state h3 {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
}

.empty-state p {
  color: var(--color-gray-500);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.history-card {
  padding: 1.25rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  transition: all 0.25s ease;
}

.history-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-sm);
}

.history-card.error {
  border-color: rgba(239, 68, 68, 0.2);
  box-shadow: 0 0 16px rgba(239, 68, 68, 0.08);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-gray-500);
}

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status-badge.success {
  background: rgba(16, 185, 129, 0.12);
  color: var(--color-accent);
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.status-badge.fail {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.25);
}

.time-badge {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  background: rgba(34, 211, 238, 0.08);
  border: 1px solid rgba(34, 211, 238, 0.15);
  border-radius: 4px;
  color: var(--color-cyan);
}

.rows-badge {
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.card-actions {
  display: flex;
  gap: 0.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  color: var(--color-gray-500);
  cursor: pointer;
  transition: all 0.25s ease;
}

.action-btn:hover {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.action-btn.active {
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.25);
  color: #fbbf24;
}

.question {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 1rem;
  color: var(--color-gray-100);
  margin-bottom: 0.75rem;
}

.question svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--color-accent);
}

.summary {
  padding: 0.75rem 1rem;
  background: rgba(16, 185, 129, 0.04);
  border-left: 3px solid var(--color-accent);
  border-radius: 0 6px 6px 0;
  font-size: 0.9rem;
  color: var(--color-gray-300);
  margin-bottom: 0.75rem;
}

.error-message {
  padding: 0.75rem 1rem;
  background: rgba(239, 68, 68, 0.08);
  border-left: 3px solid #ef4444;
  border-radius: 0 6px 6px 0;
  font-size: 0.9rem;
  color: #f87171;
  margin-bottom: 0.75rem;
}

.sql-preview {
  position: relative;
  padding: 0.75rem 1rem;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  margin-bottom: 0.75rem;
}

.sql-preview code {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--color-gray-400);
  white-space: pre-wrap;
  line-height: 1.5;
}

.copy-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 4px;
  color: var(--color-gray-400);
  cursor: pointer;
  opacity: 0;
  transition: all 0.25s ease;
}

.sql-preview:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  background: var(--glass-bg-strong);
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.copy-btn.copied {
  opacity: 1;
  background: rgba(16, 185, 129, 0.15);
  color: var(--color-accent-light);
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
}

.tag {
  padding: 0.25rem 0.5rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.18);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--color-accent);
}

.tag-editor {
  display: flex;
  gap: 0.5rem;
}

.tag-editor input {
  flex: 1;
  padding: 0.375rem 0.625rem;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-size: 0.8rem;
  color: var(--color-gray-200);
  outline: none;
  transition: all 0.25s ease;
}

.tag-editor input:focus {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.add-tag-btn {
  padding: 0.375rem 0.75rem;
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  color: white;
  cursor: pointer;
  transition: all 0.25s ease;
}

.edit-tags-btn {
  background: none;
  border: none;
  font-size: 0.8rem;
  color: var(--color-gray-500);
  cursor: pointer;
  transition: color 0.25s ease;
}

.edit-tags-btn:hover {
  color: var(--color-accent);
}

/* Pagination */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--glass-border);
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.25s ease;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
  box-shadow: var(--glow-accent);
}

.page-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.page-numbers {
  display: flex;
  gap: 0.25rem;
}

.page-num {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  height: 36px;
  padding: 0 0.5rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.25s ease;
}

.page-num:hover {
  border-color: var(--glass-border-hover);
  color: var(--color-gray-200);
}

.page-num.active {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-light, var(--color-accent)));
  border-color: transparent;
  color: white;
  box-shadow: var(--glow-accent);
}

.page-info {
  margin-left: 1rem;
  font-size: 0.85rem;
  color: var(--color-gray-500);
}

@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 1rem;
  }

  .filters-row {
    flex-direction: column;
    align-items: stretch;
  }

  .search-input {
    max-width: 100%;
  }

  .filter-buttons {
    justify-content: flex-start;
  }

  .date-filters {
    flex-wrap: wrap;
  }

  .pagination {
    flex-wrap: wrap;
  }

  .page-info {
    width: 100%;
    text-align: center;
    margin-left: 0;
    margin-top: 0.5rem;
  }
}
</style>
