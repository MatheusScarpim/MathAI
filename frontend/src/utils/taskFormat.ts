// Formatters and small helpers shared between Tasks.vue (list) and TaskDetail.vue (page).

export const formatNumber = (n: number): string => n.toLocaleString('pt-BR')

export const formatTimestamp = (date?: string): string => {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export const formatElapsed = (start?: string, end?: string, nowMs?: number): string => {
  if (!start) return ''
  const startMs = new Date(start).getTime()
  if (isNaN(startMs)) return ''
  const endMs = end ? new Date(end).getTime() : (nowMs ?? Date.now())
  const ms = Math.max(0, endMs - startMs)
  return formatDuration(ms)
}

export const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS ? `${m}m ${remS}s` : `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 48) return remM ? `${h}h ${remM}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

export const shortPr = (url: string): string => {
  const m = url.match(/\/pull\/(\d+)/)
  return m ? `#${m[1]}` : 'PR'
}

export type PrRef = { owner: string; repo: string; number: number; url: string }

export const prRepoFromUrl = (url: string): PrRef | null => {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]), url }
}

/**
 * Branch naming convention used by the orchestrator: ONE branch per task per repo
 * (all github subtasks of the same task push to the same branch and open a single PR).
 * Older code passed subtaskId as a second argument; it's now ignored for backwards-compat.
 */
export const taskBranch = (taskId: string): string => `mathai/task-${taskId}`

/** @deprecated use taskBranch(taskId) — branch is now per-task, not per-subtask. */
export const subtaskBranch = (taskId: string, _subtaskId?: string): string => taskBranch(taskId)

// Markdown → HTML (small custom renderer; no external dependency).
// Supports headers, inline code, bold, italic, [text](url), bare URLs, lists, checkboxes,
// paragraphs, line breaks. Output is wrapped in <p>…</p>.
export const renderMarkdown = (md: string): string => {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Markdown links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Bare URLs (avoid those already inside an href via the leading boundary)
  html = html.replace(/(^|[\s(])((?:https?:\/\/)[^\s)]+)/g, (_, pre, url) => {
    const short = (url as string).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
    const display = short.length > 50 ? short.slice(0, 47) + '…' : short
    return `${pre}<a href="${url}" target="_blank" rel="noopener">${display}</a>`
  })

  // Lists (checkbox first, then plain)
  html = html
    .replace(/^\s*-\s*\[x\]\s+(.+)$/gmi, '<li class="checked">$1</li>')
    .replace(/^\s*-\s*\[ \]\s+(.+)$/gmi, '<li class="unchecked">$1</li>')
    .replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>')

  html = html.replace(/(?:<li[^>]*>.*?<\/li>\s*)+/g, m => `<ul>${m}</ul>`)

  html = html
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')

  return `<p>${html}</p>`
}

export const statusLabel = (status: string): string => {
  switch (status) {
    case 'planning': return 'Planejando'
    case 'executing': return 'Executando'
    case 'completed': return 'Concluído'
    case 'failed': return 'Falhou'
    case 'cancelled': return 'Cancelada'
    default: return status
  }
}
