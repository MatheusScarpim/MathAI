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
       :class="{ 'card-error': item.success === false }"
      >
       <!-- Header row: meta + actions -->
        <div class="card-top">
          <div class="card-meta">
           <span class="status-dot" :class="item.success !== false ? 'dot-ok' : 'dot-fail'"></span>
            <span class="date">{{ formatDate(item.createdAt) }}</span>
           <span v-if="item.elapsedMs" class="pill pill-time">{{ item.elapsedMs }}ms</span>
            <span v-if="item.rowCount !== undefined" class="pill pill-rows">
              {{ item.rowCount }} {{ pluralize(item.rowCount, 'linha', 'linhas') }}
            </span>
         </div>
         <button
class="fav-btn" :class="{ active: item.favorite }" @click="toggleFavorite(item)" title="Favorito">
            <svg width="15" height="15" viewBox="0 0 24 24" :fill="item.favorite ? 'currentColor' : 'none'"
              stroke="currentColor" stroke-width="2">
              <polygon
                points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        </div>

      <!-- Question -->
        <p class="question">{{ item.question }}</p>

      <!-- Summary -->
        <div v-if="item.summary" class="summary-block">
          <p class="summary-text" :class="{ 'summary-clamped': !expandedSummaryIds.has(item.id) }">
            {{ item.summary }}
         </p>
          <button v-if="item.summary.length > 160" class="inline-toggle" @click="toggleSummary(item.id)">
            {{ expandedSummaryIds.has(item.id) ? 'ver menos' : 'ver mais' }}
          </button>
        </div>

      <!-- Error -->
        <div v-if="item.errorMessage" class="error-block">
          {{ item.errorMessage }}
        </div>

      <!-- Collapsible details: SQL + Tokens -->
        <div class="details-row" v-if="item.sql || item.tokenUsage">

          <!-- SQL -->
          <div v-if="item.sql" class="detail-section">
            <button
class="detail-toggle" :class="{ open: expandedSqlIds.has(item.id) }" @click="toggleSql(item.id)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              SQL
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                class="chevron">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div class="detail-body" :class="{ expanded: expandedSqlIds.has(item.id) }">
              <div class="detail-inner">
                <div class="sql-actions">
                  <button class="copy-inline" :class="{ copied: copiedItemId === item.id }"
                    @click="copySQL(item.id, item.sql)"
>
                   <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                   {{ copiedItemId === item.id ? 'Copiado!' : 'Copiar' }}
                 </button>
                </div>
               <pre class="sql-code">{{ item.sql }}</pre>
              </div>
            </div>
          </div>

        <!-- Tokens -->
          <div v-if="item.tokenUsage" class="detail-section">
            <button class="detail-toggle" :class="{ open: expandedTokenIds.has(item.id) }"
              @click="toggleToken(item.id)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              Tokens
              <span class="token-pill">{{ item.tokenUsage.total.totalTokens.toLocaleString() }}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                class="chevron">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div class="detail-body" :class="{ expanded: expandedTokenIds.has(item.id) }">
              <div class="detail-inner">
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
                    <tr v-if="item.tokenUsage.planner">
                      <td>Planner <small>gpt-5-mini</small></td>
                      <td>{{ item.tokenUsage.planner.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.planner.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.planner.totalTokens.toLocaleString() }}</td>
                    </tr>
                    <tr v-if="item.tokenUsage.sql && !item.tokenUsage.sqlMini">
                      <td>SQL <small>gpt-5</small></td>
                      <td>{{ item.tokenUsage.sql.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.sql.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.sql.totalTokens.toLocaleString() }}</td>
                    </tr>
                    <tr v-if="item.tokenUsage.sqlMini">
                      <td>SQL Mini <small>gpt-5-mini</small></td>
                      <td>{{ item.tokenUsage.sqlMini.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.sqlMini.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.sqlMini.totalTokens.toLocaleString() }}</td>
                    </tr>
                    <tr v-if="item.tokenUsage.sqlLarge">
                      <td>SQL Large <small>gpt-5</small></td>
                      <td>{{ item.tokenUsage.sqlLarge.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.sqlLarge.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.sqlLarge.totalTokens.toLocaleString() }}</td>
                    </tr>
                    <tr v-if="item.tokenUsage.summary">
                      <td>Summary <small>gpt-4o-mini</small></td>
                      <td>{{ item.tokenUsage.summary.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.summary.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.summary.totalTokens.toLocaleString() }}</td>
                    </tr>
                    <tr class="t-total-row">
                      <td>Total</td>
                      <td>{{ item.tokenUsage.total.inputTokens.toLocaleString() }}</td>
                      <td>{{ item.tokenUsage.total.outputTokens.toLocaleString() }}</td>
                      <td class="t-total">{{ item.tokenUsage.total.totalTokens.toLocaleString() }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        </div>

        <!-- Tags -->
        <div class="card-footer">
         <div class="tags-row" v-if="item.tags && item.tags.length > 0">
            <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>
         <div class="tag-editor" v-if="editingTagsId === item.id">
           <input v-model="newTag" type="text" placeholder="Nova tag..." @keyup.enter="addTag(item)"
              @blur="editingTagsId = null" />
            <button class="add-tag-btn" @click="addTag(item)">+</button>
          </div>
         <button v-else class="edit-tags-btn" @click="editingTagsId = item.id">
            + tag
          </button>
        </div>
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
const expandedSqlIds = ref(new Set<string>())
const expandedTokenIds = ref(new Set<string>())
const expandedSummaryIds = ref(new Set<string>())

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

function toggleSql(id: string) {
  const s = new Set(expandedSqlIds.value); s.has(id) ? s.delete(id) : s.add(id); expandedSqlIds.value = s
}
function toggleToken(id: string) {
  const s = new Set(expandedTokenIds.value); s.has(id) ? s.delete(id) : s.add(id); expandedTokenIds.value = s
}
function toggleSummary(id: string) {
  const s = new Set(expandedSummaryIds.value); s.has(id) ? s.delete(id) : s.add(id); expandedSummaryIds.value = s
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


</script>

<style scoped>
.history-page {
  padding: 2rem 2rem 4rem;
    max-width: 100%;
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

/* ── History list ─────────────────────────────────────────────────────────── */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.history-card {
  position: relative;
    padding: 1rem 1.25rem 0.75rem;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 14px;
    transition: border-color 0.2s, box-shadow 0.2s;
    overflow: hidden;
}

.history-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 100%;
  background: linear-gradient(180deg, var(--color-accent), var(--color-cyan));
  opacity: 0.6;
}

.history-card.card-error::before {
  background: #ef4444;
  opacity: 0.5;
}
.history-card:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--shadow-sm);
}

/* top row */
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.625rem;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
    flex-wrap: wrap;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-ok {
  background: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(16, 185, 129, .15);
}

.dot-fail {
  background: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, .15);
}

.date {
  font-size: 0.78rem;
  color: var(--color-gray-500);
}

.pill {
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-family: var(--font-mono);
}

.pill-time {
  background: rgba(34, 211, 238, 0.07);
  border: 1px solid rgba(34, 211, 238, 0.15);
  color: var(--color-cyan);
}

.pill-rows {
  background: rgba(16, 185, 129, 0.07);
  border: 1px solid rgba(16, 185, 129, 0.15);
  color: var(--color-accent-light);
}

.fav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
    height: 30px;
  background: none;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-500);
  cursor: pointer;
  transition: all 0.2s;
    flex-shrink: 0;
  }
    .fav-btn:hover {
      border-color: var(--glass-border-hover);
    color: #fbbf24;
    }
    .fav-btn.active {
      background: rgba(251, 191, 36, .08);
      border-color: rgba(251, 191, 36, .25);
      color: #fbbf24;
    }
    /* question */
    .question {
    font-size: 0.975rem;
      color: var(--color-gray-100);
    margin: 0 0 0.625rem;
      line-height: 1.5;
    }
    
    /* summary */
    .summary-block {
      padding: 0.625rem 0.875rem;
      background: rgba(16, 185, 129, 0.04);
      border-left: 2.5px solid rgba(16, 185, 129, 0.5);
      border-radius: 0 6px 6px 0;
  margin-bottom: 0.75rem;
}

.summary-text {
  font-size: 0.875rem;
  color: var(--color-gray-300);
  line-height: 1.6;
  margin: 0 0 0.25rem;
}

.summary-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.inline-toggle {
  background: none;
  border: none;
  font-size: 0.78rem;
  color: var(--color-accent);
  cursor: pointer;
    padding: 0;
    opacity: 0.8;
    transition: opacity 0.15s;
  }
  
  .inline-toggle:hover {
    opacity: 1;
}

/* error */
.error-block {
  padding: 0.625rem 0.875rem;
  background: rgba(239, 68, 68, 0.07);
  border-left: 2.5px solid rgba(239, 68, 68, 0.5);
  border-radius: 0 6px 6px 0;
  font-size: 0.875rem;
    color: #f87171;
  margin-bottom: 0.75rem;
}

/* details row (SQL + Tokens) */
.details-row {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 0.625rem;
}

.detail-section {
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  overflow: hidden;
    background: rgba(0, 0, 0, 0.18);
  }
  
  .detail-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.875rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-gray-500);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: background 0.15s, color 0.15s;
    text-align: left;
  }
  
  .detail-toggle:hover {
    background: rgba(255, 255, 255, 0.03);
    color: var(--color-gray-300);
  }
  
  .detail-toggle.open {
    color: var(--color-gray-200);
  }
  
  .detail-toggle .chevron {
    margin-left: auto;
    transition: transform 0.2s;
    color: var(--color-gray-600);
  }
  
  .detail-toggle.open .chevron {
    transform: rotate(180deg);
}

.token-pill {
  padding: 0.1rem 0.4rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 999px;
  font-size: 0.65rem;
  color: var(--color-accent);
  font-family: var(--font-mono);
  text-transform: none;
    letter-spacing: 0;
  }
  
  /* collapsible body */
  .detail-body {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
  }
  
  .detail-body.expanded {
    grid-template-rows: 1fr;
  }
  
  .detail-inner {
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid var(--glass-border);
  }
  
  /* sql inside detail */
  .sql-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0.5rem 0.875rem 0;
}

.copy-inline {
  display: flex;
  align-items: center;
  gap: 0.3rem;
    padding: 0.25rem 0.6rem;
    background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
    font-size: 0.72rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.2s;
  }
  
  .copy-inline:hover {
    border-color: var(--glass-border-hover);
    color: var(--color-gray-200);
  }
  
  .copy-inline.copied {
    background: rgba(16, 185, 129, .1);
    color: var(--color-accent);
    border-color: rgba(16, 185, 129, .25);
  }
  
  .sql-code {
    padding: 0.75rem 1rem 1rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--color-gray-400);
    white-space: pre;
    line-height: 1.65;
    margin: 0;
    overflow: auto;
    max-height: 260px;
  }
  
  /* token table inside detail */
  .token-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  
  .token-table th {
    text-align: right;
    color: var(--color-gray-500);
    font-weight: 500;
    padding: 0.35rem 0.875rem;
    border-bottom: 1px solid var(--glass-border);
    white-space: nowrap;
  }
  
  .token-table th:first-child {
    text-align: left;
  }
  
  .token-table td {
    text-align: right;
    color: var(--color-gray-300);
    padding: 0.3rem 0.875rem;
    white-space: nowrap;
    font-size: 0.72rem;
    text-transform: capitalize;
  }
  
  .token-table td:first-child {
    text-align: left;
    color: var(--color-gray-400);
}

.t-total {
  color: var(--color-accent) !important;
  font-weight: 600;
}

.t-total-row td {
  border-top: 1px solid var(--glass-border);
  color: var(--color-gray-200);
}

/* card footer */
.card-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding-top: 0.375rem;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.tag {
  padding: 0.2rem 0.45rem;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.18);
  border-radius: 4px;
  font-size: 0.72rem;
  color: var(--color-accent);
}

.tag-editor {
  display: flex;
  gap: 0.5rem;
}

.tag-editor input {
  padding: 0.2rem 0.5rem;
    background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-size: 0.78rem;
  color: var(--color-gray-200);
  outline: none;
  transition: border-color 0.2s;
    width: 120px;
}

.tag-editor input:focus {
  border-color: var(--color-accent);
}

.add-tag-btn {
  padding: 0.2rem 0.5rem;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 6px;
  font-size: 0.85rem;
    color: var(--color-accent);
  cursor: pointer;
  transition: all 0.2s;
}

.add-tag-btn:hover {
  background: rgba(16, 185, 129, 0.2);
}
.edit-tags-btn {
  background: none;
  border: none;
  font-size: 0.75rem;
    color: var(--color-gray-600);
  cursor: pointer;
  transition: color 0.2s;
    padding: 0;
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
