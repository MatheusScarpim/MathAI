<template>
  <div class="calc-page">
    <div class="calc-card">
      <header class="calc-header">
        <h1>Calculadora</h1>
      </header>

      <div class="calc-display">
        <div class="calc-expression">{{ expression || '\u00a0' }}</div>
        <div class="calc-current">{{ display }}</div>
      </div>

      <div class="calc-keys">
        <button class="key key-fn" @click="clearAll">C</button>
        <button class="key key-fn" @click="toggleSign">±</button>
        <button class="key key-fn" @click="percent">%</button>
        <button class="key key-op" @click="chooseOperator('/')">÷</button>

        <button class="key" @click="inputDigit('7')">7</button>
        <button class="key" @click="inputDigit('8')">8</button>
        <button class="key" @click="inputDigit('9')">9</button>
        <button class="key key-op" @click="chooseOperator('*')">×</button>

        <button class="key" @click="inputDigit('4')">4</button>
        <button class="key" @click="inputDigit('5')">5</button>
        <button class="key" @click="inputDigit('6')">6</button>
        <button class="key key-op" @click="chooseOperator('-')">−</button>

        <button class="key" @click="inputDigit('1')">1</button>
        <button class="key" @click="inputDigit('2')">2</button>
        <button class="key" @click="inputDigit('3')">3</button>
        <button class="key key-op" @click="chooseOperator('+')">+</button>

        <button class="key key-zero" @click="inputDigit('0')">0</button>
        <button class="key" @click="inputDecimal">,</button>
        <button class="key key-eq" @click="equals">=</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

type Operator = '+' | '-' | '*' | '/'

const display = ref('0')
const previous = ref<number | null>(null)
const operator = ref<Operator | null>(null)
const waitingForOperand = ref(false)

const opSymbol: Record<Operator, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }

const expression = computed(() => {
  if (previous.value === null || operator.value === null) return ''
  return `${formatNumber(previous.value)} ${opSymbol[operator.value]}`
})

function formatNumber(n: number): string {
  if (!isFinite(n)) return 'Erro'
  return String(parseFloat(n.toPrecision(12))).replace('.', ',')
}

function inputDigit(d: string) {
  if (waitingForOperand.value) {
    display.value = d
    waitingForOperand.value = false
  } else {
    display.value = display.value === '0' ? d : display.value + d
  }
}

function inputDecimal() {
  if (waitingForOperand.value) {
    display.value = '0,'
    waitingForOperand.value = false
    return
  }
  if (!display.value.includes(',')) display.value += ','
}

function currentValue(): number {
  return parseFloat(display.value.replace(',', '.'))
}

function compute(a: number, b: number, op: Operator): number {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? NaN : a / b
  }
}

function chooseOperator(op: Operator) {
  const value = currentValue()
  if (previous.value !== null && operator.value && !waitingForOperand.value) {
    const result = compute(previous.value, value, operator.value)
    display.value = formatNumber(result)
    previous.value = isFinite(result) ? result : null
  } else {
    previous.value = value
  }
  operator.value = op
  waitingForOperand.value = true
}

function equals() {
  if (previous.value === null || operator.value === null) return
  const result = compute(previous.value, currentValue(), operator.value)
  display.value = formatNumber(result)
  previous.value = null
  operator.value = null
  waitingForOperand.value = true
}

function clearAll() {
  display.value = '0'
  previous.value = null
  operator.value = null
  waitingForOperand.value = false
}

function toggleSign() {
  if (display.value === '0') return
  display.value = display.value.startsWith('-') ? display.value.slice(1) : '-' + display.value
}

function percent() {
  display.value = formatNumber(currentValue() / 100)
  waitingForOperand.value = true
}

function onKey(e: KeyboardEvent) {
  const k = e.key
  if (k >= '0' && k <= '9') inputDigit(k)
  else if (k === '.' || k === ',') inputDecimal()
  else if (k === '+' || k === '-' || k === '*' || k === '/') chooseOperator(k as Operator)
  else if (k === 'Enter' || k === '=') { e.preventDefault(); equals() }
  else if (k === 'Escape') clearAll()
  else if (k === '%') percent()
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.calc-page {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2.5rem 1.5rem;
  min-height: 100%;
}

.calc-card {
  width: 100%;
  max-width: 360px;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong));
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  padding: 1.25rem;
}

.calc-header h1 {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--color-gray-100);
  margin: 0 0 1rem;
}

.calc-display {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 1rem 1.1rem;
  margin-bottom: 1rem;
  text-align: right;
  min-height: 70px;
}

.calc-expression {
  font-size: 0.85rem;
  color: var(--color-gray-500);
  min-height: 1.1rem;
}

.calc-current {
  font-family: var(--font-display);
  font-size: 2.1rem;
  font-weight: 600;
  color: var(--color-gray-50);
  overflow-wrap: anywhere;
}

.calc-keys {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.key {
  padding: 0.9rem 0;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--color-gray-100);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.key:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--glass-border-hover);
}

.key:active {
  transform: scale(0.96);
}

.key-fn {
  color: var(--color-gray-300);
  background: rgba(255, 255, 255, 0.03);
}

.key-op {
  color: var(--color-accent-light);
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
}

.key-op:hover {
  background: rgba(16, 185, 129, 0.15);
}

.key-zero {
  grid-column: span 1;
}

.key-eq {
  color: #0b0f0d;
  background: linear-gradient(135deg, var(--color-accent-light), var(--color-cyan));
  border: none;
  font-weight: 700;
}

.key-eq:hover {
  box-shadow: var(--glow-accent);
}
</style>
