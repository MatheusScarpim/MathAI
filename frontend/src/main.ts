import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/global.css'
import { api } from './services/api'
import { isAuthenticated } from './services/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/login', component: () => import('./pages/Login.vue') },
    { path: '/setup', component: () => import('./pages/Setup.vue') },
    { path: '/chat', component: () => import('./pages/Chat.vue') },
    { path: '/history', component: () => import('./pages/History.vue') },
    { path: '/schema', component: () => import('./pages/Schema.vue') },
    { path: '/instructions', component: () => import('./pages/Instructions.vue') },
    { path: '/settings', component: () => import('./pages/Settings.vue') },
    { path: '/environments', component: () => import('./pages/Environments.vue') }
  ]
})

let authEnabled: boolean | null = null

router.beforeEach(async (to) => {
  if (authEnabled === null) {
    try {
      const status = await api.getAuthStatus()
      authEnabled = status.enabled
    } catch {
      authEnabled = false
    }
  }

  if (!authEnabled) return

  if (to.path !== '/login' && !isAuthenticated()) {
    return '/login'
  }
  if (to.path === '/login' && isAuthenticated()) {
    return '/chat'
  }
})

createApp(App).use(router).mount('#app')
