import type { ColumnFormat } from '../types'

/**
 * Renderizacao de celula a partir da mascara que o backend derivou.
 *
 * Antes daqui a tabela do chat tinha uma regra so: `typeof val === 'number'`
 * virava `toLocaleString('pt-BR')`. Isso trata dinheiro, taxa, contagem e chave
 * surrogate como a mesma coisa — `SK_PRODUTO` = 1234 saia "1.234", igualzinho a
 * uma medicao.
 *
 * A decisao de QUAL mascara usar nao esta aqui: e do backend
 * (`apps/api/src/schema/columnFormat.ts`), que a deriva do lexico e do tipo
 * declarado pelo driver. Este modulo so aplica. Manter a decisao no backend e o
 * que faz a mascara chegar identica no cache, no SSE e no payload final.
 *
 * Toda funcao aqui e total: mascara ausente cai no comportamento antigo, e
 * mascara numerica sobre valor que nao e numero devolve o texto cru em vez de
 * "NaN". Um `kind` errado nunca deve esconder o dado.
 */

const LOCALE = 'pt-BR'

const DEFAULT_DECIMALS: Record<ColumnFormat['kind'], number> = {
  currency: 2,
  percent: 1,
  fraction: 1,
  integer: 0,
  decimal: 2,
  gram: 1,
  date: 0,
  datetime: 0,
  text: 0
}

/**
 * Mascara que renderiza numero — o chamador usa para alinhar a direita.
 *
 * Espelha `isNumericKind` do backend. `date` e `text` ficam de fora: data
 * alinhada a direita fica desalinhada da coluna de texto ao lado sem ganho
 * nenhum de leitura.
 */
export function isNumericFormat(format: ColumnFormat | undefined): boolean {
  if (!format) return false
  return (
    format.kind === 'currency' ||
    format.kind === 'percent' ||
    format.kind === 'fraction' ||
    format.kind === 'integer' ||
    format.kind === 'decimal' ||
    format.kind === 'gram'
  )
}

/**
 * Numero a partir do que o driver devolveu.
 *
 * Precisa existir porque nem todo driver entrega numero como `number`: mssql
 * manda `BIGINT` e `DECIMAL` grandes como string para nao perder precisao, e o
 * pg faz o mesmo com `numeric`. Sem isto a coluna cairia no ramo de texto e
 * perderia a mascara justamente nas colunas de dinheiro.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Marca de fuso explicita: `Z`, `+00:00`, `-0300`. */
const HAS_TZ = /(z|[+-]\d{2}:?\d{2})$/i

/** ISO sem fuso, com ou sem hora: `2026-03-04`, `2026-03-04T14:20:00.123`. */
const ISO_NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/i

/** Data ja escrita em pt-BR, que `new Date` leria como mes/dia. */
const PTBR_DATE = /^(\d{2})\/(\d{2})\/(\d{4})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * `Date` local a partir dos componentes, recusando o que nao existe.
 *
 * `new Date(2026, 12, 45)` nao e `Invalid Date`: o construtor TRANSBORDA e
 * devolve 14/02/2027. Sem conferir, `"2026-13-45"` — que casa o formato mas nao
 * e data — sairia renderizado como uma data plausivel e errada. Vale para
 * `"2026-02-30"` tambem. So aceito se os componentes voltarem iguais.
 */
const localDate = (
  y: string, mo: string, d: string, h?: string, mi?: string, s?: string
): Date | null => {
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h ?? 0)
  const minute = Number(mi ?? 0)
  const second = Number(s ?? 0)

  if (hour > 23 || minute > 59 || second > 59) return null

  const date = new Date(year, month - 1, day, hour, minute, second)
  if (Number.isNaN(date.getTime())) return null

  // So a data de calendario e conferida. A hora pode divergir legitimamente:
  // em fuso com horario de verao a meia-noite de um domingo de virada nao
  // existe, e o construtor a desloca para 01:00 — o dia continua certo, e
  // recusar ai transformaria uma data valida em texto cru.
  const survived =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day

  return survived ? date : null
}

/**
 * Data a partir do que atravessou o JSON.
 *
 * `new Date(str)` sozinho nao serve: a linha chega sempre como string ISO
 * (SSE e cache serializam), e `new Date("2026-03-04")` e meia-noite **UTC** por
 * especificacao. Em `America/Sao_Paulo` (-03) isso volta 21h do dia anterior, e
 * `toLocaleDateString` imprimia `03/03/2026` — a mascara mostrava o dia errado.
 *
 * Sem fuso declarado a string e uma data de calendario, nao um instante: le os
 * componentes e monta local. Com fuso declarado o instante e real e vale
 * converter. `dd/MM/yyyy` entra porque `new Date` leria como mes/dia (US) e
 * `04/03` viraria 3 de abril.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value

  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  if (typeof value !== 'string') return null

  const text = value.trim()
  if (text === '') return null

  if (!HAS_TZ.test(text)) {
    const iso = ISO_NAIVE.exec(text)
    if (iso) return localDate(iso[1], iso[2], iso[3], iso[4], iso[5], iso[6])

    const ptbr = PTBR_DATE.exec(text)
    if (ptbr) return localDate(ptbr[3], ptbr[2], ptbr[1], ptbr[4], ptbr[5], ptbr[6])
  }

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Casas decimais efetivas.
 *
 * O teto de 20 e o do `Intl.NumberFormat`, que lanca `RangeError` acima disso.
 * `decimals` pode vir do `scale` de um driver ou da curadoria de um seed, e um
 * numero absurdo nao deve derrubar a renderizacao da tabela inteira.
 */
function decimalsOf(format: ColumnFormat): number {
  const declared = format.decimals
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return Math.min(Math.trunc(declared), 20)
  }
  return DEFAULT_DECIMALS[format.kind] ?? 0
}

function asFixed(value: number, decimals: number): string {
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/**
 * Comportamento anterior a existencia da mascara.
 *
 * Continua sendo alcancavel de dois jeitos: resposta gravada em cache antes
 * deste campo existir, e coluna que nem o lexico nem o tipo souberam
 * classificar.
 */
function formatUntyped(value: unknown): string {
  if (typeof value === 'number') return value.toLocaleString(LOCALE)
  return String(value)
}

/** Texto da celula. `null`/`undefined` viram `-`; o chamador pode tratar antes. */
export function formatCell(value: unknown, format?: ColumnFormat): string {
  if (value === null || value === undefined) return '-'
  if (!format) return formatUntyped(value)

  switch (format.kind) {
    case 'currency': {
      const num = toNumber(value)
      if (num === null) return String(value)
      return num.toLocaleString(LOCALE, {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: decimalsOf(format),
        maximumFractionDigits: decimalsOf(format)
      })
    }

    // `percent` chega ja em escala de exibicao (87.5) e `fraction` em escala de
    // razao (0.875). Renderizam igual; a diferenca e so o x100. Nao uso
    // `style: 'percent'` do Intl porque ele SEMPRE multiplica, o que estaria
    // errado para `percent`.
    case 'percent':
    case 'fraction': {
      const num = toNumber(value)
      if (num === null) return String(value)
      const scaled = format.kind === 'fraction' ? num * 100 : num
      return `${asFixed(scaled, decimalsOf(format))}%`
    }

    case 'integer':
    case 'decimal':
    case 'gram': {
      const num = toNumber(value)
      if (num === null) return String(value)
      const text = asFixed(num, decimalsOf(format))
      const suffix = format.suffix ?? (format.kind === 'gram' ? 'g' : undefined)
      return suffix ? `${text} ${suffix}` : text
    }

    case 'date': {
      const date = toDate(value)
      return date ? date.toLocaleDateString(LOCALE) : String(value)
    }

    case 'datetime': {
      const date = toDate(value)
      if (!date) return String(value)
      return `${date.toLocaleDateString(LOCALE)} ${date.toLocaleTimeString(LOCALE, {
        hour: '2-digit',
        minute: '2-digit'
      })}`
    }

    case 'text':
      // Chave surrogate cai aqui. `String` cru de proposito: separador de milhar
      // num identificador e ruido, e era exatamente o bug original.
      return String(value)

    default:
      // `kind` fora da lista. Hoje inalcancavel — `parseSeed` valida contra
      // `COLUMN_FORMAT_KINDS` —, mas sem isto o switch devolveria `undefined` e
      // a celula sumia. Esconder o dado e o pior desfecho possivel aqui.
      return formatUntyped(value)
  }
}
