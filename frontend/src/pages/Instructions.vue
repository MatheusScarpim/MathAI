<template>
  <div class="instructions-page">
    <header class="page-header">
      <div>
        <h1>Instrucoes Personalizadas</h1>
        <p>Configure regras globais para guiar a geracao de SQL</p>
      </div>
    </header>

    <!-- Add Global Instruction -->
    <div class="add-section">
      <h2>Nova Instrucao Global</h2>
      <p class="section-desc">Instrucoes globais sao aplicadas em todas as consultas.</p>
      <div class="add-form">
        <textarea
          v-model="newInstruction"
          placeholder="Ex: Sempre use TOP 100 nas consultas. Evite o campo Dt_Transacao, prefira Dt_Producao..."
          rows="3"
          :maxlength="2000"
        ></textarea>
        <div class="form-footer">
          <span class="char-count">{{ newInstruction.length }}/2000</span>
          <button class="btn-primary" @click="addInstruction" :disabled="!newInstruction.trim() || saving">
            <svg v-if="!saving" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span v-else class="spinner"></span>
            Adicionar
          </button>
        </div>
      </div>
    </div>

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
      Carregando...
    </div>

    <template v-else>
      <!-- Global Instructions -->
      <div class="instructions-section">
        <h2>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
          </svg>
          Instrucoes Globais
        </h2>

        <div v-if="globalInstructions.length === 0" class="empty-state small">
          <p>Nenhuma instrucao global configurada</p>
        </div>

        <div v-else class="instructions-list">
          <div v-for="instruction in globalInstructions" :key="instruction.id" class="instruction-card global">
            <div class="instruction-content">
              <p>{{ instruction.text }}</p>
              <span class="date">{{ formatDate(instruction.createdAt) }}</span>
            </div>
            <button class="btn-delete" @click="deleteInstruction(instruction.id)" title="Excluir instrucao">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Table Instructions -->
      <div class="instructions-section">
        <h2>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          Instrucoes por Tabela
        </h2>
        <p class="section-desc">
          Instrucoes especificas por tabela sao aplicadas apenas quando a tabela e usada na consulta.
          <router-link to="/schema">Gerencie na pagina de Tabelas</router-link>
        </p>

        <div v-if="tableInstructions.length === 0" class="empty-state small">
          <p>Nenhuma instrucao por tabela configurada</p>
        </div>

        <div v-else class="instructions-list">
          <div v-for="instruction in tableInstructions" :key="instruction.id" class="instruction-card table">
            <div class="instruction-content">
              <div class="table-badge">{{ instruction.tableFullName }}</div>
              <p>{{ instruction.text }}</p>
              <span class="date">{{ formatDate(instruction.createdAt) }}</span>
            </div>
            <button class="btn-delete" @click="deleteInstruction(instruction.id)" title="Excluir instrucao">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Examples -->
    <div class="examples-section">
      <h2>Exemplos de Instrucoes Globais</h2>
      <div class="examples-grid">
        <div
          v-for="example in examples"
          :key="example"
          class="example-card"
          @click="useExample(example)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          {{ example }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '../services/api'
import type { Instruction } from '../types'

const instructions = ref<Instruction[]>([])
const newInstruction = ref('')
const loading = ref(true)
const saving = ref(false)
const successMessage = ref('')
const errorMessage = ref('')

const globalInstructions = computed(() =>
  instructions.value.filter(i => !i.tableFullName)
)

const tableInstructions = computed(() =>
  instructions.value.filter(i => i.tableFullName)
)

const examples = [
  'Sempre use TOP 100 nas consultas para limitar resultados',
  'Evite o campo Dt_Transacao, prefira Dt_Producao para filtros de data',
  'Use alias em portugues para as colunas nos resultados',
  'Sempre inclua o campo Id nas consultas de clientes',
  'Formate valores monetarios com 2 casas decimais',
  'Agrupe resultados de vendas sempre por regiao'
]

onMounted(async () => {
  try {
    instructions.value = await api.getInstructions()
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao carregar instrucoes'
  } finally {
    loading.value = false
  }
})

async function addInstruction() {
  if (!newInstruction.value.trim() || saving.value) return

  saving.value = true
  successMessage.value = ''
  errorMessage.value = ''

  try {
    const created = await api.createInstruction(newInstruction.value.trim())
    instructions.value.unshift(created)
    newInstruction.value = ''
    successMessage.value = 'Instrucao adicionada com sucesso!'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao adicionar instrucao'
  } finally {
    saving.value = false
  }
}

function useExample(example: string) {
  newInstruction.value = example
}

async function deleteInstruction(id: string) {
  if (!confirm('Deseja realmente excluir esta instrucao?')) return

  try {
    await api.deleteInstruction(id)
    instructions.value = instructions.value.filter(i => i.id !== id)
    successMessage.value = 'Instrucao excluida!'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e: any) {
    errorMessage.value = e.message || 'Erro ao excluir instrucao'
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
.instructions-page {
  padding: 2rem;
  max-width: 800px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
}

.page-header p {
  color: var(--color-gray-500);
}

.add-section {
  margin-bottom: 1.5rem;
}

.add-section h2 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

.section-desc {
  font-size: 0.85rem;
  color: var(--color-gray-500);
  margin-bottom: 0.75rem;
}

.section-desc a {
  color: var(--color-accent);
}

.add-form textarea {
  width: 100%;
  padding: 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-gray-200);
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
}

.add-form textarea:focus {
  border-color: var(--color-accent);
}

.add-form textarea::placeholder {
  color: var(--color-gray-600);
}

.form-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.75rem;
}

.char-count {
  font-size: 0.8rem;
  color: var(--color-gray-500);
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1.25rem;
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
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
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
  gap: 0.75rem;
  padding: 2rem;
  justify-content: center;
  color: var(--color-gray-500);
}

.loading .spinner {
  border-color: var(--border-color);
  border-top-color: var(--color-accent);
}

.instructions-section {
  margin-bottom: 2rem;
}

.instructions-section h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  margin-bottom: 0.75rem;
}

.empty-state {
  text-align: center;
  padding: 3rem 2rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.empty-state.small {
  padding: 1.5rem;
}

.empty-state p {
  color: var(--color-gray-500);
  font-size: 0.9rem;
}

.instructions-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.instruction-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.instruction-content {
  flex: 1;
}

.instruction-card.global {
  border-left: 3px solid var(--color-accent);
}

.instruction-card.table {
  border-left: 3px solid #a78bfa;
}

.table-badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  background: rgba(139, 92, 246, 0.2);
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  color: #a78bfa;
  margin-bottom: 0.5rem;
}

.instruction-card p {
  color: var(--color-gray-200);
  margin-bottom: 0.5rem;
  line-height: 1.5;
}

.instruction-card .date {
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

.examples-section h2 {
  font-size: 1rem;
  margin-bottom: 1rem;
}

.examples-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
}

.example-card {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 0.85rem;
  color: var(--color-gray-400);
  cursor: pointer;
  transition: all 0.15s;
}

.example-card:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.example-card svg {
  flex-shrink: 0;
  margin-top: 2px;
}

@media (max-width: 768px) {
  .examples-grid {
    grid-template-columns: 1fr;
  }
}
</style>
