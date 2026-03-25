import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles/global.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/setup', component: () => import('./pages/Setup.vue') },
    { path: '/chat', component: () => import('./pages/Chat.vue') },
    { path: '/history', component: () => import('./pages/History.vue') },
    { path: '/schema', component: () => import('./pages/Schema.vue') },
    { path: '/instructions', component: () => import('./pages/Instructions.vue') },
    { path: '/settings', component: () => import('./pages/Settings.vue') },
    { path: '/environments', component: () => import('./pages/Environments.vue') }
  ]
})

createApp(App).use(router).mount('#app')
