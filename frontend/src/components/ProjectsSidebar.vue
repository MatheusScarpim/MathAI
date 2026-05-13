<template>
  <aside class="projects-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Projetos</span>
      <button class="add-btn" @click="$emit('create')" title="Novo projeto">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      </button>
    </div>

    <div class="projects-list">
      <div
        v-for="p in projects"
        :key="p.id"
        class="project-item"
        :class="{ active: p.id === selectedId }"
        @click="$emit('select', p.id)"
      >
        <div class="project-icon" :class="{ inbox: p.isInbox }">
          <svg v-if="p.isInbox" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="project-info">
          <div class="project-name">{{ p.name }}</div>
          <div class="project-meta">
            <span v-if="p.repoIds?.length" class="meta-item">
              {{ p.repoIds.length }} {{ p.repoIds.length === 1 ? 'repo' : 'repos' }}
            </span>
            <span v-if="(p.taskCount ?? 0) > 0" class="meta-item">
              {{ p.taskCount }} {{ p.taskCount === 1 ? 'tarefa' : 'tarefas' }}
            </span>
          </div>
        </div>
        <span v-if="(p.openTaskCount ?? 0) > 0" class="open-badge" title="Tarefas em andamento">
          {{ p.openTaskCount }}
        </span>
        <button
          v-if="!p.isInbox"
          class="menu-btn"
          @click.stop="$emit('edit', p)"
          title="Editar"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
type Project = {
  id: string
  name: string
  description?: string
  repoIds: string[]
  isInbox: boolean
  taskCount?: number
  openTaskCount?: number
}

defineProps<{
  projects: Project[]
  selectedId: string | null
}>()

defineEmits<{
  (e: 'select', id: string): void
  (e: 'create'): void
  (e: 'edit', project: Project): void
}>()
</script>

<style scoped>
.projects-sidebar {
  background: transparent;
  padding: 0 .25rem 0 0;
  display: flex;
  flex-direction: column;
  gap: .35rem;
  height: fit-content;
  position: sticky;
  top: 1.5rem;
  max-height: calc(100vh - 3rem);
  overflow-y: auto;
  border-right: 1px solid var(--border, #2a2a40);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .25rem .25rem .65rem;
}
.sidebar-title {
  font-size: .72rem;
  font-weight: 700;
  color: var(--text-secondary, #888);
  text-transform: uppercase;
  letter-spacing: .8px;
}
.add-btn {
  background: transparent;
  border: 1px solid var(--border, #333);
  color: var(--text-secondary, #888);
  border-radius: 6px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all .15s;
}
.add-btn:hover {
  border-color: var(--primary, #6c5ce7);
  color: var(--primary, #6c5ce7);
}

.projects-list {
  display: flex;
  flex-direction: column;
  gap: .15rem;
}

.project-item {
  display: flex;
  align-items: center;
  gap: .55rem;
  padding: .5rem .55rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all .12s;
  position: relative;
}
.project-item:hover {
  background: var(--bg-tertiary, #252540);
}
.project-item.active {
  background: rgba(108, 92, 231, .14);
}
.project-item.active .project-name {
  color: var(--primary, #6c5ce7);
  font-weight: 600;
}

.project-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--bg-tertiary, #252540);
  color: var(--text-secondary, #888);
}
.project-icon.inbox {
  background: rgba(108, 92, 231, .15);
  color: var(--primary, #6c5ce7);
}
.project-item.active .project-icon {
  background: rgba(108, 92, 231, .2);
  color: var(--primary, #6c5ce7);
}

.project-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: .1rem;
}
.project-name {
  font-size: .85rem;
  color: var(--text, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-meta {
  display: flex;
  gap: .5rem;
  font-size: .68rem;
  color: var(--text-secondary, #777);
}
.meta-item { white-space: nowrap; }

.open-badge {
  background: rgba(253, 203, 110, .18);
  color: #fdcb6e;
  font-size: .65rem;
  font-weight: 700;
  padding: .1rem .35rem;
  border-radius: 99px;
  min-width: 1.1rem;
  text-align: center;
  flex-shrink: 0;
}

.menu-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary, #555);
  padding: .25rem;
  cursor: pointer;
  border-radius: 5px;
  display: flex;
  opacity: 0;
  transition: all .12s;
}
.project-item:hover .menu-btn {
  opacity: 1;
}
.menu-btn:hover {
  color: var(--text, #fff);
  background: rgba(255, 255, 255, .08);
}
</style>
