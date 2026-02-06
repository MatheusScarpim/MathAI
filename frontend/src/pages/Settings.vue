<template>
  <div class="settings-page">
    <header class="page-header">
      <h1>Settings</h1>
      <p>Gerencie a aplicacao e redefina o ambiente quando precisar recomecar do zero.</p>
    </header>

    <section class="danger-zone">
      <h2>Zona de risco</h2>
      <p>
        Esta acao remove configuracao, historico, instrucoes, settings e schema indexado.
        Depois disso, o sistema volta para o setup inicial.
      </p>

      <label class="confirm-line">
        Digite <code>RESET</code> para habilitar:
        <input v-model="confirmText" type="text" placeholder="RESET" />
      </label>

      <button
        class="btn-danger"
        :disabled="resetting || confirmText !== 'RESET'"
        @click="onResetEnvironment"
      >
        {{ resetting ? 'Limpando ambiente...' : 'Resetar ambiente' }}
      </button>

      <p v-if="message" class="message" :class="messageType">{{ message }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'

const router = useRouter()
const confirmText = ref('')
const resetting = ref(false)
const message = ref('')
const messageType = ref<'ok' | 'error'>('ok')

const onResetEnvironment = async () => {
  if (confirmText.value !== 'RESET') return
  resetting.value = true
  message.value = ''

  try {
    await api.resetEnvironment()
    messageType.value = 'ok'
    message.value = 'Ambiente resetado com sucesso. Redirecionando para setup...'
    await router.replace('/setup')
  } catch (error) {
    messageType.value = 'error'
    message.value = (error as Error).message || 'Erro ao resetar ambiente.'
  } finally {
    resetting.value = false
  }
}
</script>

<style scoped>
.settings-page {
  padding: 2rem;
  max-width: 900px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 1.5rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
}

.page-header p {
  color: var(--color-gray-500);
}

.danger-zone {
  background: rgba(127, 29, 29, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 12px;
  padding: 1.25rem;
}

.danger-zone h2 {
  color: #fca5a5;
  margin-bottom: 0.5rem;
}

.danger-zone p {
  color: var(--color-gray-300);
}

.confirm-line {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 1rem 0;
  color: var(--color-gray-300);
}

.confirm-line input {
  width: 220px;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--color-gray-100);
}

.btn-danger {
  background: #dc2626;
  color: white;
  border: none;
  border-radius: 8px;
  padding: 0.7rem 1rem;
  cursor: pointer;
}

.btn-danger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.message {
  margin-top: 0.75rem;
}

.message.ok {
  color: var(--color-accent-light);
}

.message.error {
  color: #fda4af;
}
</style>
