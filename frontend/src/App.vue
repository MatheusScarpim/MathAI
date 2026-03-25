<template>
  <div class="app-layout" :class="{ 'setup-mode': isSetupRoute }">
    <aside v-if="!isSetupRoute" class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2" />
            <path d="M10 16h12M16 10v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <circle cx="16" cy="16" r="4" fill="var(--color-accent)" />
          </svg>
          <span class="logo-text">Math<span class="accent">AI</span></span>
        </div>
      </div>

      <div v-if="environments.length > 1" class="env-selector">
        <label class="env-label">Ambiente</label>
        <select
          v-model="selectedEnvironmentId"
          class="env-select"
          @change="onEnvironmentChange"
        >
          <option
            v-for="env in environments"
            :key="env.environmentId"
            :value="env.environmentId"
          >
            {{ env.name }}
          </option>
        </select>
      </div>

      <nav class="nav-menu">
        <router-link to="/chat" class="nav-item" :class="{ active: $route.path === '/chat' }">
          <span>Perguntar</span>
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }">
          <span>Histórico</span>
        </router-link>
        <router-link to="/schema" class="nav-item" :class="{ active: $route.path === '/schema' }">
          <span>{{ appMode === 'api' ? 'Endpoints' : 'Tabelas' }}</span>
        </router-link>
        <router-link to="/instructions" class="nav-item" :class="{ active: $route.path === '/instructions' }">
          <span>Instruções</span>
        </router-link>
        <router-link to="/environments" class="nav-item" :class="{ active: $route.path === '/environments' }">
          <span>Ambientes</span>
        </router-link>
        <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }">
          <span>Configurações</span>
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <div class="status">
          <span class="status-dot"></span>
          <span>{{ statusText }}</span>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './services/api'
import type { AppMode, DbType, EnvironmentSummary } from './types'

const route = useRoute()
const router = useRouter()
const dbType = ref<DbType | null>(null)
const appMode = ref<AppMode>('database')
const environments = ref<EnvironmentSummary[]>([])
const selectedEnvironmentId = ref<string | undefined>(undefined)
const environmentVersion = ref(0)

provide('selectedEnvironmentId', selectedEnvironmentId)
provide('environmentVersion', environmentVersion)
provide('environments', environments)

const isSetupRoute = computed(() => route.path === '/setup')
const statusText = computed(() => {
  const env = environments.value.find(e => e.environmentId === selectedEnvironmentId.value)
  const envName = env?.name ? ` (${env.name})` : ''
  if (appMode.value === 'api') return `API conectada${envName}`
  if (dbType.value === 'oracle') return `Oracle conectado${envName}`
  if (dbType.value === 'mysql') return `MySQL conectado${envName}`
  return `SQL Server conectado${envName}`
})

const onEnvironmentChange = async () => {
  if (!selectedEnvironmentId.value) return
  environmentVersion.value++
  try {
    const env = await api.getEnvironment(selectedEnvironmentId.value)
    dbType.value = env.dbType ?? null
    appMode.value = env.mode ?? 'database'
  } catch { /* ignore */ }
}

const enforceSetupFlow = async () => {
  try {
    const status = await api.getConfigStatus()
    if (!status.configured && route.path !== '/setup') {
      await router.replace('/setup')
      return
    }
    if (status.configured && route.path === '/setup') {
      await router.replace('/chat')
      return
    }
    if (status.configured) {
      environments.value = status.environments ?? []
      if (environments.value.length > 0 && !selectedEnvironmentId.value) {
        selectedEnvironmentId.value = environments.value[0]!.environmentId
      }
      const cfg = await api.getConfig()
      dbType.value = cfg.dbType ?? null
      appMode.value = cfg.mode ?? 'database'
    }
  } catch {
    if (route.path !== '/setup') {
      await router.replace('/setup')
    }
  }
}

onMounted(enforceSetupFlow)
watch(() => route.path, () => {
  void enforceSetupFlow()
})
</script>

<style scoped>
.app-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}

.app-layout.setup-mode {
  grid-template-columns: 1fr;
}

.sidebar {
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.4);
  border-right: 1px solid var(--border-color);
}

.sidebar-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--color-gray-50);
}

.logo-text {
  font-family: var(--font-display);
  font-size: 1.125rem;
  font-weight: 600;
}

.logo-text .accent {
  color: var(--color-accent);
}

.env-selector {
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.env-label {
  display: block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-gray-500);
  margin-bottom: 0.375rem;
}

.env-select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--color-gray-200);
  font-size: 0.85rem;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}

.env-select:hover,
.env-select:focus {
  border-color: var(--color-accent);
}

.env-select option {
  background: var(--bg-card);
  color: var(--color-gray-200);
}

.nav-menu {
  flex: 1;
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  color: var(--color-gray-400);
  text-decoration: none;
  font-size: 0.9rem;
  transition: all 0.15s;
}

.nav-item:hover {
  background: var(--bg-card-hover);
  color: var(--color-gray-200);
}

.nav-item.active {
  background: rgba(16, 185, 129, 0.1);
  color: var(--color-accent);
}

.sidebar-footer {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border-color);
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--color-gray-500);
}

.status-dot {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.main-content {
  overflow-y: auto;
  height: 100vh;
}

@media (max-width: 768px) {
  .app-layout {
    grid-template-columns: 1fr;
  }

  .sidebar {
    display: none;
  }
}
</style>
