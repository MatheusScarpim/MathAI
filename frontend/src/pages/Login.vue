<template>
  <div class="login-page">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>

    <section class="login-shell">
      <header class="hero">
        <p class="eyebrow">MathAI</p>
        <h1>{{ isRegister ? 'Criar conta' : 'Entrar' }}</h1>
        <p class="subtitle">
          {{ isRegister ? 'Registre-se para acessar o sistema.' : 'Faça login para continuar.' }}
        </p>
      </header>

      <div class="panel">
        <form @submit.prevent="onSubmit">
          <label class="label">Usuário</label>
          <input
            v-model="username"
            class="input"
            type="text"
            placeholder="Seu username"
            autocomplete="username"
          />

          <label class="label">Senha</label>
          <input
            v-model="password"
            class="input"
            type="password"
            placeholder="Sua senha"
            autocomplete="current-password"
          />

          <template v-if="isRegister">
            <label class="label">Confirmar senha</label>
            <input
              v-model="confirmPassword"
              class="input"
              type="password"
              placeholder="Repita a senha"
              autocomplete="new-password"
            />
          </template>

          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>

          <button class="btn btn-primary submit-btn" :disabled="loading" type="submit">
            {{ loading ? 'Aguarde...' : isRegister ? 'Registrar' : 'Entrar' }}
          </button>
        </form>

        <p class="toggle-mode">
          {{ isRegister ? 'Já tem conta?' : 'Não tem conta?' }}
          <a href="#" @click.prevent="toggleMode">
            {{ isRegister ? 'Fazer login' : 'Criar conta' }}
          </a>
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import { setToken } from '../services/auth'

const router = useRouter()

const isRegister = ref(false)
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const errorMsg = ref('')
const loading = ref(false)

function toggleMode() {
  isRegister.value = !isRegister.value
  errorMsg.value = ''
}

async function onSubmit() {
  errorMsg.value = ''

  if (!username.value || !password.value) {
    errorMsg.value = 'Preencha todos os campos'
    return
  }

  if (isRegister.value && password.value !== confirmPassword.value) {
    errorMsg.value = 'As senhas não coincidem'
    return
  }

  loading.value = true
  try {
    const res = isRegister.value
      ? await api.register(username.value, password.value)
      : await api.login(username.value, password.value)

    setToken(res.token)
    router.push('/chat')
  } catch (err: any) {
    errorMsg.value = err.message || 'Erro ao autenticar'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  overflow: hidden;
}

.glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(80px);
  opacity: 0.28;
  pointer-events: none;
}

.glow-a {
  width: 500px;
  height: 500px;
  background: #10b981;
  top: -120px;
  right: -120px;
}

.glow-b {
  width: 400px;
  height: 400px;
  background: #22d3ee;
  bottom: -120px;
  left: -120px;
}

.login-shell {
  position: relative;
  z-index: 1;
  width: min(440px, 100%);
  display: grid;
  gap: 1rem;
}

.hero {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 1.25rem;
  text-align: center;
  box-shadow: var(--shadow-md);
  transition: border-color 0.25s ease;
}

.eyebrow {
  color: var(--color-accent-light);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero h1 {
  margin-top: 0.35rem;
  font-size: clamp(1.5rem, 2vw, 2rem);
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-cyan));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  margin-top: 0.5rem;
  color: var(--color-gray-400);
}

.panel {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  padding: 1.5rem;
  box-shadow: var(--shadow-md);
  transition: border-color 0.25s ease;
}

.label {
  display: block;
  margin-bottom: 0.35rem;
  margin-top: 0.75rem;
  color: var(--color-gray-300);
  font-size: 0.9rem;
}

.label:first-child {
  margin-top: 0;
}

.input {
  width: 100%;
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-gray-100);
  border-radius: 10px;
  padding: 0.68rem 0.75rem;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18), var(--glow-accent);
}

.error-msg {
  margin-top: 0.75rem;
  color: #ef4444;
  font-size: 0.875rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.submit-btn {
  margin-top: 1.25rem;
  width: 100%;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-light));
  box-shadow: var(--glow-accent);
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}

.submit-btn:hover:not(:disabled) {
  box-shadow: var(--glow-accent-strong);
}

.toggle-mode {
  margin-top: 1rem;
  text-align: center;
  color: var(--color-gray-400);
  font-size: 0.875rem;
}

.toggle-mode a {
  color: var(--color-accent-light);
  text-decoration: none;
  transition: text-shadow 0.25s ease;
}

.toggle-mode a:hover {
  text-decoration: underline;
  text-shadow: var(--glow-accent);
}
</style>
