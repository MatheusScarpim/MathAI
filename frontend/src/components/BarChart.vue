<template>
  <div class="bar-chart" ref="containerRef">
    <p v-if="title" class="bar-chart-title">{{ title }}</p>

    <svg
      v-if="visibleBars.length"
      :width="svgWidth"
      :height="svgHeight"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
      style="display: block; width: 100%; overflow: visible;"
    >
      <!-- Gridlines -->
      <g>
        <line
          v-for="tick in yTicks"
          :key="tick.value"
          :x1="paddingLeft"
          :y1="tick.y"
          :x2="svgWidth - paddingRight"
          :y2="tick.y"
          stroke="var(--glass-border)"
          stroke-width="1"
        />
      </g>

      <!-- Y-axis labels -->
      <g>
        <text
          v-for="tick in yTicks"
          :key="`yl-${tick.value}`"
          :x="paddingLeft - 8"
          :y="tick.y + 4"
          text-anchor="end"
          font-size="11"
          fill="var(--color-gray-400)"
          font-family="var(--font-mono)"
        >{{ formatYLabel(tick.value) }}</text>
      </g>

      <!-- Bars -->
      <g>
        <g
          v-for="(bar, i) in visibleBars"
          :key="i"
          class="bar-group"
          @mouseenter="showTooltip($event, bar)"
          @mouseleave="hideTooltip"
          style="cursor: pointer;"
        >
          <path
            :d="buildBarPath(bar)"
            :fill="resolvedColor"
            class="bar-rect"
          />
          <!-- Transparent hover zone spanning full column height -->
          <rect
            :x="bar.x"
            :y="chartTop"
            :width="bar.width"
            :height="chartHeight"
            fill="transparent"
          />
        </g>
      </g>

      <!-- X-axis labels -->
      <g>
        <text
          v-for="(bar, i) in visibleBars"
          :key="`xl-${i}`"
          :x="bar.x + bar.width / 2"
          :y="svgHeight - paddingBottom + 14"
          text-anchor="middle"
          font-size="11"
          fill="var(--color-gray-400)"
          :transform="rotateLabels
            ? `rotate(-35, ${bar.x + bar.width / 2}, ${svgHeight - paddingBottom + 14})`
            : ''"
        >{{ truncateLabel(String(bar.category)) }}</text>
      </g>

      <!-- X-axis baseline -->
      <line
        :x1="paddingLeft"
        :y1="svgHeight - paddingBottom"
        :x2="svgWidth - paddingRight"
        :y2="svgHeight - paddingBottom"
        stroke="var(--glass-border)"
        stroke-width="1"
      />
    </svg>

    <div v-else class="bar-chart-empty">Sem dados para exibir</div>

    <!-- Tooltip -->
    <Transition name="tooltip-fade">
      <div
        v-if="tooltip.visible"
        class="bar-tooltip"
        :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }"
      >
        <span class="tooltip-category">{{ tooltip.category }}</span>
        <span class="tooltip-value">{{ formatTooltipValue(tooltip.value) }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  data: Array<{ category: string | number; value: number | null }>
  title?: string
  xKey?: string
  yKey?: string
  color?: string
  height?: number
}>()

// ── Container sizing ──────────────────────────────────────────────────────────
const containerRef = ref<HTMLDivElement | null>(null)
const containerWidth = ref(400)

let ro: ResizeObserver | null = null

onMounted(() => {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth || 400
    ro = new ResizeObserver(entries => {
      containerWidth.value = entries[0]?.contentRect.width || 400
    })
    ro.observe(containerRef.value)
  }
})

onUnmounted(() => ro?.disconnect())

// ── Layout constants ──────────────────────────────────────────────────────────
const MAX_BARS = 15
const DEFAULT_HEIGHT = 200
const paddingLeft = 48
const paddingRight = 12
const paddingTop = 12

const svgHeight = computed(() => props.height ?? DEFAULT_HEIGHT)
const svgWidth  = computed(() => containerWidth.value || 400)

const paddingBottom = 40
const rotateLabels = computed((): boolean => validData.value.length > 7)
const chartTop    = paddingTop
const chartHeight = computed((): number => svgHeight.value - paddingTop - paddingBottom)
const chartWidth  = computed((): number => svgWidth.value - paddingLeft - paddingRight)

const resolvedColor = computed(() => props.color ?? 'var(--color-accent)')

// ── Data ──────────────────────────────────────────────────────────────────────
const validData = computed(() =>
  (props.data ?? [])
    .filter((d: { category: string | number; value: number | null }) => d.value !== null && d.value !== undefined)
    .slice(0, MAX_BARS) as Array<{ category: string | number; value: number }>
)

const maxValue = computed(() => {
  const vals = validData.value.map((d: { value: number }) => d.value)
  return vals.length ? Math.max(...vals) : 1
})

// ── Y ticks (0 … maxValue in 4 steps) ────────────────────────────────────────
const yTicks = computed(() => {
  const max = maxValue.value
  const steps = 4
  return Array.from({ length: steps + 1 }, (_, i) => {
    const value = (max / steps) * i
    const y = chartTop + chartHeight.value - (value / max) * chartHeight.value
    return { value, y }
  })
})

// ── Bar geometry ──────────────────────────────────────────────────────────────
interface BarDatum {
  category: string | number
  value: number
  x: number
  y: number
  width: number
  height: number
}

const visibleBars = computed((): BarDatum[] => {
  const items = validData.value
  if (!items.length) return []
  const n   = items.length
  const gap = Math.max(2, Math.floor(chartWidth.value * 0.04))
  const barW = Math.max(4, (chartWidth.value - gap * (n + 1)) / n)

  return items.map((d: { category: string | number; value: number }, i: number): BarDatum => {
    const barH = (d.value / maxValue.value) * chartHeight.value
    const x    = paddingLeft + gap * (i + 1) + barW * i
    const barY: number = chartTop + chartHeight.value - barH
    return { category: d.category, value: d.value, x, y: barY, width: barW, height: barH }
  })
})

// Rounded top-corners SVG path
function buildBarPath(bar: BarDatum): string {
  if (bar.height <= 0) return ''
  const r = Math.min(4, bar.width / 2, bar.height)
  const { x, y, width: w, height: h } = bar
  const bottom = y + h

  if (h < r * 2) {
    return `M${x},${bottom} L${x},${y} L${x + w},${y} L${x + w},${bottom} Z`
  }

  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${bottom}`,
    'Z'
  ].join(' ')
}

// ── Label helpers ─────────────────────────────────────────────────────────────
function truncateLabel(label: string): string {
  return label.length > 9 ? label.slice(0, 8) + '…' : label
}

function formatYLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`
  return value % 1 === 0 ? String(Math.round(value)) : value.toFixed(1)
}

function formatTooltipValue(value: number): string {
  return value.toLocaleString('pt-BR')
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
const tooltip = ref({
  visible:  false,
  x:        0,
  y:        0,
  category: '' as string | number,
  value:    0
})

function showTooltip(event: MouseEvent, bar: BarDatum) {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  tooltip.value = {
    visible:  true,
    x:        event.clientX - rect.left + 12,
    y:        event.clientY - rect.top  - 44,
    category: bar.category,
    value:    bar.value
  }
}

function hideTooltip() {
  tooltip.value.visible = false
}
</script>

<style scoped>
.bar-chart {
  position: relative;
  width: 100%;
}

.bar-chart-title {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-gray-400);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 0.5rem;
}

.bar-chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  font-size: 0.82rem;
  color: var(--color-gray-600);
  border: 1px dashed var(--glass-border);
  border-radius: var(--border-radius);
}

/* Bar hover */
.bar-group:hover .bar-rect {
  filter: brightness(1.2) drop-shadow(0 0 5px rgba(16, 185, 129, 0.4));
  opacity: 1 !important;
}

.bar-rect {
  opacity: 0.82;
  transition: filter 0.15s ease, opacity 0.15s ease;
}

/* Tooltip */
.bar-tooltip {
  position: absolute;
  pointer-events: none;
  z-index: 20;
  background: var(--glass-bg-strong, rgba(15, 23, 42, 0.92));
  border: 1px solid var(--glass-border-hover);
  border-radius: 8px;
  padding: 0.35rem 0.65rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,0.3));
  white-space: nowrap;
}

.tooltip-category {
  font-size: 0.7rem;
  color: var(--color-gray-400);
}

.tooltip-value {
  font-size: 0.85rem;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-accent);
}

.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity 0.12s ease;
}
.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>
