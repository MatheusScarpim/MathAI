<template>
  <div class="schema-page">
    <header class="page-header">
      <div>
        <h1>Tabelas Indexadas</h1>
        <p>Visualize as tabelas, relacionamentos e adicione instruções específicas</p>
      </div>
      <div class="header-actions">
        <div class="schema-language">
          <label for="schema-language">Idioma do banco</label>
          <select id="schema-language" v-model="schemaLanguage" class="schema-select">
            <option value="pt">Português (PT)</option>
            <option value="en">English (EN)</option>
            <option value="es">Español (ES)</option>
          </select>
        </div>
        <button class="btn-danger" @click="clearSchema" :disabled="clearing || indexing">
          <svg v-if="!clearing" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span v-else class="spinner"></span>
          {{ clearing ? 'Zerando...' : 'Zerar esquema' }}
        </button>
        <button class="btn-primary" @click="reindex" :disabled="indexing || clearing">
          <svg v-if="!indexing" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
          <span v-else class="spinner"></span>
          {{ indexing ? 'Indexando...' : 'Reindexar esquema' }}
        </button>
      </div>
    </header>

    <!-- Messages -->
    <div v-if="successMessage" class="success-card">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>
      </svg>
      {{ successMessage }}
    </div>
    <div v-if="errorMessage" class="error-card">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      {{ errorMessage }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading">
      <span class="spinner"></span>
      Carregando tabelas...
    </div>

    <!-- Empty State -->
    <div v-else-if="tables.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>
      </div>
      <h3>Nenhuma tabela indexada</h3>
      <p>Clique em "Reindexar esquema" para carregar as tabelas do SQL Server.</p>
    </div>

    <!-- Tables List -->
    <div v-else class="tables-section">
      <div class="tables-header">
        <h2>
          {{ tables.length }} {{ pluralize(tables.length, 'tabela encontrada', 'tabelas encontradas') }}
        </h2>
        <input
          v-model="search"
          type="text"
          placeholder="Buscar tabela..."
          class="search-input"
        />
      </div>

      <div class="tables-list">
        <div
          v-for="table in filteredTables"
          :key="table.tableFullName"
          class="table-card"
          :class="{ expanded: expandedTable === table.tableFullName }"
        >
          <div class="table-header" @click="toggleTable(table.tableFullName)">
            <div class="table-info">
              <span v-for="tag in table.tags" :key="tag" class="tag" :class="tag.toLowerCase()">
                {{ tag }}
              </span>
              <span class="table-name">{{ table.tableFullName }}</span>
              <span class="column-count">
                {{ table.columns.length }} {{ pluralize(table.columns.length, 'coluna', 'colunas') }}
              </span>
            </div>
            <div class="table-actions">
              <span v-if="table.foreignKeys.length" class="fk-badge">
                {{ table.foreignKeys.length }} {{ pluralize(table.foreignKeys.length, 'FK', 'FKs') }}
              </span>
              <span v-if="getTableInstructions(table.tableFullName).length" class="instruction-badge">
                {{ getTableInstructions(table.tableFullName).length }}
                {{ pluralize(getTableInstructions(table.tableFullName).length, 'instrução', 'instruções') }}
              </span>
              <svg
                width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                :class="{ rotated: expandedTable === table.tableFullName }"
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          </div>

          <div v-if="expandedTable === table.tableFullName" class="table-details">
            <!-- Columns -->
            <div class="detail-section">
              <h4>Colunas</h4>
              <div class="columns-grid">
                <div v-for="col in table.columns" :key="col.name" class="column-item">
                  <span class="col-name" :class="{ pk: table.primaryKey.includes(col.name) }">
                    {{ col.name }}
                    <svg v-if="table.primaryKey.includes(col.name)" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                    </svg>
                  </span>
                  <span class="col-type">{{ col.type }}</span>
                </div>
              </div>
            </div>

            <!-- Foreign Keys -->
            <div v-if="table.foreignKeys.length" class="detail-section">
              <h4>Chaves estrangeiras</h4>
              <div class="fk-list">
                <div v-for="(fk, i) in table.foreignKeys" :key="i" class="fk-item">
                  <code>{{ fk.fromColumn }}</code>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                  </svg>
                  <code>{{ fk.toTable }}.{{ fk.toColumn }}</code>
                </div>
              </div>
            </div>

            <!-- Instructions -->
            <div class="detail-section">
              <h4>Instruções para esta tabela</h4>
              <p class="section-desc">Estas instruções serão incluídas no prompt quando esta tabela for selecionada.</p>

              <div v-if="getTableInstructions(table.tableFullName).length" class="instructions-list">
                <div v-for="inst in getTableInstructions(table.tableFullName)" :key="inst.id" class="instruction-item">
                  <div class="instruction-content">
                    <p>{{ inst.text }}</p>
                    <span class="inst-date">{{ formatDate(inst.createdAt) }}</span>
                  </div>
                  <button class="btn-delete" @click="deleteInstruction(inst.id)" title="Excluir instrução">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>

              <div class="add-instruction">
                <textarea
                  v-model="newInstructions[table.tableFullName]"
                  placeholder="Ex: Use sempre a coluna Dt_Producao para filtros de data nesta tabela..."
                  rows="2"
                ></textarea>
                <button
                  class="btn-add"
                  @click="addInstruction(table.tableFullName)"
                  :disabled="!newInstructions[table.tableFullName]?.trim() || saving"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  Adicionar
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { api } from '../services/api'
import type { TableInfo, Instruction } from '../types'

const tables = ref<TableInfo[]>([])
const instructions = ref<Instruction[]>([])
const loading = ref(true)
const indexing = ref(false)
const clearing = ref(false)
const saving = ref(false)
const successMessage = ref('')
const errorMessage = ref('')
const search = ref('')
const expandedTable = ref<string | null>(null)
const newInstructions = reactive<Record<string, string>>({})
const schemaLanguage = ref<'pt' | 'en' | 'es'>('pt')
const schemaLanguageLoaded = ref(false)

const filteredTables = computed(() => {
  if (!search.value.trim()) return tables.value
  const q = search.value.toLowerCase()
  return tables.value.filter(t =>
    t.tableFullName.toLowerCase().includes(q) ||
    t.columns.some(c => c.name.toLowerCase().includes(q))
  )
})

function getTableInstructions(tableFullName: string): Instruction[] {
  return instructions.value.filter(i => i.tableFullName === tableFullName)
}

onMounted(async () => {
  await Promise.all([loadData(), loadSchemaLanguage()])
})

watch(schemaLanguage, async (value, previous) => {
  if (!schemaLanguageLoaded.value || value === previous) return
  try {
    await api.setSchemaLanguage(value)
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao salvar idioma do banco'
  }
})

async function loadData() {
  loading.value = true
  errorMessage.value = ''

  try {
    const [tablesRes, instructionsRes] = await Promise.all([
      api.getTables(),
      api.getInstructions()
    ])
    tables.value = tablesRes.tables
    instructions.value = instructionsRes
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao carregar dados'
  } finally {
    loading.value = false
  }
}

async function loadSchemaLanguage() {
  try {
    const res = await api.getSchemaLanguage()
    schemaLanguage.value = res.schemaLanguage
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao carregar idioma do banco'
  } finally {
    schemaLanguageLoaded.value = true
  }
}

async function reindex() {
  if (indexing.value) return

  indexing.value = true
  successMessage.value = ''
  errorMessage.value = ''

  try {
    const res = await api.ingestSchema()
    successMessage.value = `${res.tablesIndexed} ${pluralize(res.tablesIndexed, 'tabela indexada', 'tabelas indexadas')} com sucesso!`
    await loadData()
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao indexar esquema'
  } finally {
    indexing.value = false
  }
}

async function clearSchema() {
  if (clearing.value) return
  if (!confirm('Isso vai remover todas as tabelas indexadas. Deseja continuar?')) return

  clearing.value = true
  successMessage.value = ''
  errorMessage.value = ''

  try {
    await api.clearSchema()
    successMessage.value = 'Esquema zerado com sucesso!'
    tables.value = []
    expandedTable.value = null
    await loadData()
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao zerar esquema'
  } finally {
    clearing.value = false
  }
}

function toggleTable(tableFullName: string) {
  expandedTable.value = expandedTable.value === tableFullName ? null : tableFullName
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

async function addInstruction(tableFullName: string) {
  const text = newInstructions[tableFullName]?.trim()
  if (!text || saving.value) return

  saving.value = true

  try {
    const created = await api.createInstruction(text, tableFullName)
    instructions.value.unshift(created)
    newInstructions[tableFullName] = ''
    successMessage.value = 'Instrução adicionada!'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao adicionar instrução'
  } finally {
    saving.value = false
  }
}

async function deleteInstruction(id: string) {
  if (!confirm('Deseja realmente excluir esta instrução?')) return

  try {
    await api.deleteInstruction(id)
    instructions.value = instructions.value.filter(i => i.id !== id)
    successMessage.value = 'Instrução excluída!'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao excluir instrução'
  }
}

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(dateStr))
}
</script>

<style scoped>
.schema-page {
  padding: 2rem;
  max-width: 1000px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
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
  align-items: center;
  gap: 0.75rem;
}

.schema-language {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-gray-500);
}

.schema-language label {
  font-size: 0.75rem;
  color: var(--color-gray-500);
}

.schema-select {
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.85rem;
  color: var(--color-gray-200);
  outline: none;
  min-width: 180px;
}

.schema-select:focus {
  border-color: var(--color-accent);
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 500;
  color: white;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-accent-light);
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-danger {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 500;
  color: #f87171;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  color: #fecaca;
}

.btn-danger:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.success-card, .error-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-radius: 10px;
  margin-bottom: 1.5rem;
}

.success-card {
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.2);
  color: var(--color-accent);
}

.error-card {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 4rem;
  color: var(--color-gray-500);
}

.loading .spinner {
  border-color: var(--border-color);
  border-top-color: var(--color-accent);
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

.tables-section h2 {
  font-size: 1rem;
  color: var(--color-gray-300);
}

.tables-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.search-input {
  padding: 0.5rem 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--color-gray-200);
  width: 250px;
  outline: none;
}

.search-input:focus {
  border-color: var(--color-accent);
}

.tables-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.table-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.2s;
}

.table-card.expanded {
  border-color: var(--color-accent);
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  cursor: pointer;
  transition: background 0.15s;
}

.table-header:hover {
  background: var(--bg-card-hover);
}

.table-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.tag {
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.tag.fat {
  background: rgba(251, 191, 36, 0.2);
  color: #fbbf24;
}

.tag.dim {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}

.table-name {
  font-weight: 500;
  color: var(--color-gray-100);
}

.column-count {
  font-size: 0.8rem;
  color: var(--color-gray-500);
}

.table-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.fk-badge, .instruction-badge {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
}

.fk-badge {
  background: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
}

.instruction-badge {
  background: rgba(16, 185, 129, 0.2);
  color: var(--color-accent);
}

.table-actions svg {
  color: var(--color-gray-500);
  transition: transform 0.2s;
}

.table-actions svg.rotated {
  transform: rotate(180deg);
}

.table-details {
  padding: 1.25rem;
  border-top: 1px solid var(--border-color);
  background: rgba(0, 0, 0, 0.2);
}

.detail-section {
  margin-bottom: 1.5rem;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-section h4 {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-gray-300);
  margin-bottom: 0.75rem;
}

.section-desc {
  font-size: 0.8rem;
  color: var(--color-gray-500);
  margin-bottom: 0.75rem;
}

.columns-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.5rem;
}

.column-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border-radius: 6px;
  font-size: 0.85rem;
}

.col-name {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--color-gray-200);
}

.col-name.pk {
  color: #fbbf24;
}

.col-name svg {
  color: #fbbf24;
}

.col-type {
  color: var(--color-gray-500);
  font-family: monospace;
  font-size: 0.75rem;
}

.fk-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.fk-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border-radius: 6px;
  font-size: 0.85rem;
}

.fk-item code {
  padding: 0.125rem 0.375rem;
  background: rgba(139, 92, 246, 0.1);
  border-radius: 4px;
  color: #a78bfa;
  font-size: 0.8rem;
}

.fk-item svg {
  color: var(--color-gray-500);
}

.instructions-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.instruction-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-card);
  border-radius: 8px;
  border-left: 3px solid var(--color-accent);
}

.instruction-content {
  flex: 1;
}

.instruction-item p {
  color: var(--color-gray-200);
  font-size: 0.9rem;
  margin-bottom: 0.25rem;
}

.inst-date {
  font-size: 0.75rem;
  color: var(--color-gray-500);
}

.btn-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--color-gray-500);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.btn-delete:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.add-instruction {
  display: flex;
  gap: 0.75rem;
}

.add-instruction textarea {
  flex: 1;
  padding: 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-gray-200);
  resize: none;
  outline: none;
}

.add-instruction textarea:focus {
  border-color: var(--color-accent);
}

.btn-add {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.75rem 1rem;
  background: var(--color-accent);
  border: none;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  color: white;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-add:hover:not(:disabled) {
  background: var(--color-accent-light);
}

.btn-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 1rem;
  }

  .header-actions {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }

  .schema-select {
    width: 100%;
  }

  .tables-header {
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
  }

  .search-input {
    width: 100%;
  }

  .columns-grid {
    grid-template-columns: 1fr;
  }

  .add-instruction {
    flex-direction: column;
  }
}
</style>
