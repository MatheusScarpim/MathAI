// PRECISA vir antes de qualquer `Date`. Node aplica `process.env.TZ` em tempo de
// execucao, e o import abaixo nao constroi data nenhuma no topo do modulo.
//
// O fuso e FIXADO de proposito, e num offset NEGATIVO. A regressao que estes
// testes guardam — `new Date("2026-03-04")` ser meia-noite UTC — so se manifesta
// a oeste de Greenwich: em `Europe/Berlin` o codigo com bug imprime 04/03/2026,
// certo por acidente. Sem fixar, a suite ficaria verde em CI rodando em UTC e o
// bug voltaria sem ninguem ver.
process.env.TZ = 'America/Sao_Paulo'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatCell, isNumericFormat } from './formatters'

/**
 * Roda pelo `node:test` via `tsx`, sem runner novo: este modulo e TS puro e o
 * unico import dele e `import type`, que o compilador apaga. Nao ha Vue aqui.
 */

describe('formatCell: data nao volta um dia', () => {
  it('o fuso do teste esta fixado onde a regressao aparece', () => {
    // Guarda da guarda. Se alguem trocar o pin por UTC ou por fuso positivo,
    // este asserto cai e explica por que, em vez de os outros passarem em falso.
    assert.equal(new Date().getTimezoneOffset() > 0, true, 'esperado offset negativo (oeste)')
    assert.equal(new Date('2026-03-04').toLocaleDateString('pt-BR'), '03/03/2026')
  })

  it('string ISO sem fuso mantem o dia do calendario', () => {
    assert.equal(formatCell('2026-03-04', { kind: 'date' }), '04/03/2026')
  })

  it('primeiro dia do mes nao cai no mes anterior', () => {
    assert.equal(formatCell('2026-01-01', { kind: 'date' }), '01/01/2026')
  })

  it('ISO com hora e sem fuso tambem mantem o dia', () => {
    // Hora baixa e o caso pior: 02:30 local recuaria para o dia anterior.
    assert.equal(formatCell('2026-03-04T02:30:00', { kind: 'date' }), '04/03/2026')
  })

  it('ISO com milissegundos, como o Postgres manda', () => {
    assert.equal(formatCell('2026-03-04T02:30:00.123', { kind: 'date' }), '04/03/2026')
  })

  it('ISO com espaco no lugar do T, como o MySQL manda', () => {
    assert.equal(formatCell('2026-03-04 02:30:00', { kind: 'date' }), '04/03/2026')
  })

  it('datetime preserva dia e hora declarados', () => {
    assert.equal(formatCell('2026-03-04T14:20:00', { kind: 'datetime' }), '04/03/2026 14:20')
  })

  it('string ja em pt-BR nao e lida como mes/dia', () => {
    // `new Date("04/03/2026")` e 3 de abril no parser US.
    assert.equal(formatCell('04/03/2026', { kind: 'date' }), '04/03/2026')
  })

  it('fuso explicito e respeitado como instante', () => {
    // Aqui converter e correto e desejado: o valor identifica um instante, e
    // meio-dia UTC e mesmo dia 4 as 09:00 em Sao Paulo.
    assert.equal(formatCell('2026-03-04T12:00:00Z', { kind: 'datetime' }), '04/03/2026 09:00')
    // E o instante que de fato cruza a meia-noite deve mudar de dia.
    assert.equal(formatCell('2026-03-04T02:00:00Z', { kind: 'date' }), '03/03/2026')
    assert.equal(formatCell('2026-03-04T00:00:00-03:00', { kind: 'date' }), '04/03/2026')
  })

  it('objeto Date do driver passa direto', () => {
    assert.equal(formatCell(new Date(2026, 2, 4), { kind: 'date' }), '04/03/2026')
  })

  it('valor que nao e data devolve o texto cru, nunca "Invalid Date"', () => {
    assert.equal(formatCell('sem data', { kind: 'date' }), 'sem data')
    assert.equal(formatCell('', { kind: 'date' }), '')
    // Casa o FORMATO mas nao e data. `new Date(2026, 12, 45)` nao e invalido:
    // transborda para 14/02/2027, e sem o guard de componentes a celula
    // mostraria essa data inventada com toda a confianca.
    assert.equal(formatCell('2026-13-45', { kind: 'date' }), '2026-13-45')
    assert.equal(formatCell('2026-02-30', { kind: 'date' }), '2026-02-30')
    assert.equal(formatCell('2026-03-04T25:00:00', { kind: 'date' }), '2026-03-04T25:00:00')
    // Ano bissexto de verdade continua passando.
    assert.equal(formatCell('2024-02-29', { kind: 'date' }), '29/02/2024')
  })
})

describe('formatCell: mascaras numericas', () => {
  it('moeda ganha simbolo e duas casas', () => {
    const out = formatCell(1234.56, { kind: 'currency', decimals: 2 })
    assert.match(out, /R\$/)
    assert.match(out, /1\.234,56/)
  })

  it('percent nao multiplica; fraction multiplica', () => {
    assert.equal(formatCell(87.5, { kind: 'percent', decimals: 1 }), '87,5%')
    assert.equal(formatCell(0.875, { kind: 'fraction', decimals: 1 }), '87,5%')
  })

  it('chave sai crua, sem separador de milhar', () => {
    assert.equal(formatCell(1234, { kind: 'text' }), '1234')
  })

  it('numero em string do driver nao perde a mascara', () => {
    // mssql manda BIGINT/DECIMAL grandes como string, e o pg faz o mesmo com
    // `numeric`, justamente nas colunas de dinheiro.
    assert.match(formatCell('1234.56', { kind: 'currency', decimals: 2 }), /1\.234,56/)
    assert.equal(formatCell('87.5', { kind: 'percent', decimals: 1 }), '87,5%')
  })

  it('gramas recebem sufixo', () => {
    assert.equal(formatCell(62.4, { kind: 'gram', decimals: 1 }), '62,4 g')
  })

  it('`decimals` absurdo nao derruba a celula', () => {
    // Vem do `scale` de um driver ou de curadoria de seed; acima de 20 o
    // `Intl.NumberFormat` lanca `RangeError`.
    assert.equal(formatCell(1.5, { kind: 'decimal', decimals: 999 }), (1.5).toLocaleString('pt-BR', {
      minimumFractionDigits: 20,
      maximumFractionDigits: 20
    }))
  })

  it('mascara numerica sobre texto devolve o texto, nunca NaN', () => {
    assert.equal(formatCell('n/d', { kind: 'currency' }), 'n/d')
  })

  it('nulo vira tracinho', () => {
    assert.equal(formatCell(null, { kind: 'currency' }), '-')
    assert.equal(formatCell(undefined), '-')
  })

  it('sem mascara mantem o comportamento antigo', () => {
    assert.equal(formatCell(1234), (1234).toLocaleString('pt-BR'))
    assert.equal(formatCell('texto'), 'texto')
  })

  it('kind desconhecido nao esconde o dado', () => {
    assert.equal(formatCell(1234, { kind: 'nao_existe' } as never), (1234).toLocaleString('pt-BR'))
  })
})

describe('isNumericFormat', () => {
  it('alinha a direita so o que e numero', () => {
    for (const kind of ['currency', 'percent', 'fraction', 'integer', 'decimal', 'gram'] as const) {
      assert.equal(isNumericFormat({ kind }), true, kind)
    }
    for (const kind of ['date', 'datetime', 'text'] as const) {
      assert.equal(isNumericFormat({ kind }), false, kind)
    }
    assert.equal(isNumericFormat(undefined), false)
  })
})
