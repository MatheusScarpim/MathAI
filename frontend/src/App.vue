<template>
  <div class="app-layout" :class="{ 'setup-mode': isSetupRoute }">
    <!-- Mobile hamburger -->
    <button v-if="!isSetupRoute" class="hamburger" @click="mobileOpen = !mobileOpen" :class="{ open: mobileOpen }">
      <span></span><span></span><span></span>
    </button>
    <div v-if="mobileOpen" class="mobile-overlay" @click="mobileOpen = false"></div>

    <aside v-if="!isSetupRoute" class="sidebar" :class="{ 'mobile-open': mobileOpen }">
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
        <router-link to="/chat" class="nav-item" :class="{ active: $route.path === '/chat' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <span>Perguntar</span>
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <span>Histórico</span>
        </router-link>
        <router-link to="/schema" class="nav-item" :class="{ active: $route.path === '/schema' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          <span>{{ appMode === 'api' ? 'Endpoints' : 'Tabelas' }}</span>
        </router-link>
        <router-link to="/instructions" class="nav-item" :class="{ active: $route.path === '/instructions' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <span>Instruções</span>
        </router-link>
        <router-link to="/environments" class="nav-item" :class="{ active: $route.path === '/environments' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
          <span>Ambientes</span>
        </router-link>
        <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          <span>Dashboard</span>
        </router-link>
        <router-link to="/tasks" class="nav-item" :class="{ active: $route.path === '/tasks' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          <span>Tasks</span>
        </router-link>
        <router-link to="/metrics" class="nav-item" :class="{ active: $route.path === '/metrics' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span>Métricas</span>
        </router-link>
        <router-link to="/queue" class="nav-item" :class="{ active: $route.path === '/queue' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <span>Queue</span>
        </router-link>
        <router-link to="/playground" class="nav-item" :class="{ active: $route.path === '/playground' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
          <span>Playground</span>
        </router-link>
        <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }" @click="closeMobile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span>Configurações</span>
        </router-link>
      </nav>

      <div class="sidebar-footer">
        <div class="status">
          <span class="status-dot"></span>
          <span>{{ statusText }}</span>
        </div>
        <button v-if="authEnabled" class="logout-btn" @click="logout">Sair</button>
      </div>
    </aside>

    <main class="main-content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './services/api'
import { logout as authLogout } from './services/auth'
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

const authEnabled = ref(false)
const mobileOpen = ref(false)

const closeMobile = () => { mobileOpen.value = false }

const isSetupRoute = computed(() => route.path === '/setup' || route.path === '/login')
const statusText = computed(() => {
  const env = environments.value.find(e => e.environmentId === selectedEnvironmentId.value)
  const envName = env?.name ? ` (${env.name})` : ''
  if (appMode.value === 'api') return `API conectada${envName}`
  if (dbType.value === 'oracle') return `Oracle conectado${envName}`
  if (dbType.value === 'mysql') return `MySQL conectado${envName}`
  if (dbType.value === 'postgresql') return `PostgreSQL conectado${envName}`
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

const enforceSetupFlow = async (retries = 3) => {
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
  } catch (err: any) {
    if (err?.message === 'Session expired') return
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 2000))
      return enforceSetupFlow(retries - 1)
    }
    if (route.path !== '/setup') {
      await router.replace('/setup')
    }
  }
}

const logout = async () => {
  await authLogout()
  router.push('/login')
}

onMounted(async () => {
  try {
    const status = await api.getAuthStatus()
    authEnabled.value = status.enabled
  } catch { /* ignore */ }
  await enforceSetupFlow()
})
watch(() => route.path, () => {
  void enforceSetupFlow()
})
</script>

<style scoped>
.app-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.app-layout.setup-mode {
  grid-template-columns: 1fr;
}

.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border-right: 1px solid var(--glass-border);
}

.sidebar-header {
  padding: 1.5rem 1.25rem;
  border-bottom: 1px solid var(--glass-border);
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--color-gray-50);
}

.logo svg {
  filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.4));
}

.logo-text {
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.logo-text .accent {
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-cyan));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.env-selector {
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--glass-border);
}

.env-label {
  display: block;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-gray-500);
  margin-bottom: 0.375rem;
  font-weight: 500;
}

.env-select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--color-gray-200);
  font-size: 0.85rem;
  cursor: pointer;
  outline: none;
  transition: all 0.2s;
}

.env-select:hover {
  border-color: var(--glass-border-hover);
  background: rgba(255, 255, 255, 0.06);
}

.env-select option {
  background: var(--color-gray-800);
  color: var(--color-gray-200);
}

.nav-menu {
  flex: 1;
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  border-radius: 10px;
  color: var(--color-gray-400);
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 450;
  transition: all 0.2s ease;
  position: relative;
}

.nav-item svg {
  opacity: 0.6;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-gray-100);
}

.nav-item:hover svg {
  opacity: 0.9;
}

.nav-item.active {
  background: rgba(16, 185, 129, 0.08);
  color: var(--color-accent-light);
  box-shadow: inset 3px 0 0 var(--color-accent);
}

.nav-item.active svg {
  opacity: 1;
  color: var(--color-accent);
  filter: drop-shadow(0 0 4px rgba(16, 185, 129, 0.3));
}

.sidebar-footer {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--glass-border);
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.78rem;
  color: var(--color-gray-500);
}

.status-dot {
  width: 7px;
  height: 7px;
  background: var(--color-accent);
  border-radius: 50%;
  animation: glow-pulse 2.5s ease-in-out infinite;
  flex-shrink: 0;
}

.logout-btn {
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.5rem;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.15);
  border-radius: 8px;
  color: #ef4444;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}

.logout-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.35);
  box-shadow: 0 0 15px rgba(239, 68, 68, 0.1);
}

.main-content {
  overflow-y: auto;
  height: 100vh;
}

/* Page transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Hamburger button */
.hamburger {
  display: none;
  position: fixed;
  top: 1rem;
  left: 1rem;
  z-index: 60;
  width: 42px;
  height: 42px;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  cursor: pointer;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0;
  transition: all 0.2s;
}

.hamburger:hover {
  border-color: var(--glass-border-hover);
  box-shadow: var(--glow-accent);
}

.hamburger span {
  display: block;
  width: 18px;
  height: 2px;
  background: var(--color-gray-300);
  border-radius: 2px;
  transition: all 0.3s ease;
}

.hamburger.open span:nth-child(1) {
  transform: rotate(45deg) translate(5px, 5px);
}

.hamburger.open span:nth-child(2) {
  opacity: 0;
}

.hamburger.open span:nth-child(3) {
  transform: rotate(-45deg) translate(5px, -5px);
}

.mobile-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 39;
}

@media (max-width: 768px) {
  .app-layout {
    grid-template-columns: 1fr;
  }

  .hamburger {
    display: flex;
  }

  .mobile-overlay {
    display: block;
  }

  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 270px;
    z-index: 40;
    transform: translateX(-100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 20px 0 60px rgba(0, 0, 0, 0.5);
  }

  .sidebar.mobile-open {
    transform: translateX(0);
  }
}
</style>
