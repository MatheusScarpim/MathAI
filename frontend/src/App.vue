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

      <nav class="nav-menu">
        <router-link to="/chat" class="nav-item" :class="{ active: $route.path === '/chat' }">
          <span>Perguntar</span>
        </router-link>
        <router-link to="/history" class="nav-item" :class="{ active: $route.path === '/history' }">
          <span>Histórico</span>
        </router-link>
        <router-link to="/schema" class="nav-item" :class="{ active: $route.path === '/schema' }">
          <span>Tabelas</span>
        </router-link>
        <router-link to="/instructions" class="nav-item" :class="{ active: $route.path === '/instructions' }">
          <span>Instruções</span>
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './services/api'

const route = useRoute()
const router = useRouter()
const dbType = ref<'sqlserver' | 'oracle' | null>(null)

const isSetupRoute = computed(() => route.path === '/setup')
const statusText = computed(() =>
  dbType.value === 'oracle' ? 'Oracle conectado' : 'SQL Server conectado'
)

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
      const cfg = await api.getConfig()
      dbType.value = cfg.dbType
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
