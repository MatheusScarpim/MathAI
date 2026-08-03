import type { ExpandedContext } from "./schema.js";
import type { ColumnClass } from "../schema/lexicon.js";
import { periodStatus, type TableFacts } from "../schema/tableFacts.js";
import type { DictionaryIndex } from "../schema/dictionaryOps.js";

/**
 * O que o dicionario sabe, dito ao modelo ANTES de ele escrever o SQL (E4).
 *
 * As guardas do E3 barram depois. Barrar funciona, mas custa uma tentativa de
 * retry por uma coisa que o prompt podia ter evitado — e o retry tem budget
 * finito, entao um erro previsivel gasta a bala que faltaria para um erro
 * imprevisivel. Aqui o mesmo conhecimento vira instrucao.
 *
 * REGRA DURA: todo texto abaixo sai de `ColumnClass`/`TableFacts`. Nao ha
 * lista paralela escrita a mao. Se as guardas mudarem de opiniao e este
 * modulo nao mudar junto, o modelo aprende uma coisa e e punido por outra —
 * que e pior do que nao dizer nada, porque ai o retry nem converge.
 *
 * Nao ha vocabulario de dominio aqui, pela mesma razao do `sqlGuards.ts`:
 * `schema/vocabulary.test.ts` varre este arquivo nominalmente.
 */

export type SemanticContext = {
  facts: readonly TableFacts[];
  dictionary: DictionaryIndex;
  overlappingBuckets: Readonly<Record<string, readonly string[]>>;
};

type Language = "pt" | "en" | "es";
type ContextTable = ExpandedContext["tables"][number];

const pick = <T>(language: Language, pt: T, en: T, es: T): T =>
  language === "en" ? en : language === "es" ? es : pt;

// --- tokens -----------------------------------------------------------------

/**
 * Mecanismo puro: quebra em pedacos alfanumericos e joga fora o que e curto
 * demais para discriminar. Nenhum termo de negocio participa da decisao.
 */
const tokenize = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u00c0-\u00ff]+/)) {
    if (raw.length >= 3) out.add(raw);
  }
  return out;
};

const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const t of a) if (b.has(t)) return true;
  return false;
};

// --- poda -------------------------------------------------------------------

/**
 * Acima disto a lista de colunas passa a atrapalhar mais do que ajuda: o
 * modelo perde a coluna certa no meio de 180 nomes parecidos.
 *
 * Tabela menor que o teto sai INTACTA — a poda so existe para o caso em que
 * despejar tudo e o problema. Podar uma tabela pequena so adicionaria risco.
 */
const MAX_COLUMNS_PER_TABLE = 40;

/** Colunas que a poda nunca corta, porque sem elas o SQL nao se escreve. */
const structuralColumns = (table: ContextTable, facts: TableFacts | undefined): Set<string> => {
  const keep = new Set<string>();
  const add = (name: string | null | undefined): void => {
    if (name) keep.add(name.toLowerCase());
  };

  for (const c of table.primaryKey) add(c);
  for (const fk of table.foreignKeys) {
    // A chave estrangeira aparece dos dois lados; so o lado desta tabela e
    // coluna dela, mas guardar os dois nomes e barato e evita depender de
    // como o ingest normalizou `fromTable`.
    add(fk.fromColumn);
    add(fk.toColumn);
  }
  if (facts) {
    add(facts.eventDateColumn);
    add(facts.joinKey);
    for (const c of facts.alternateDateColumns) add(c);
    for (const c of facts.periodJoinColumns) add(c);
  }
  return keep;
};

/**
 * Toda coluna sobre a qual o bloco semantico tem algo a dizer.
 *
 * Precisa sobreviver a poda: um aviso "nao some X" citando uma coluna que nao
 * esta no schema mostrado confunde mais do que orienta, e ainda sugere ao
 * modelo que X existe e e util.
 */
const isNoteworthy = (cls: ColumnClass): boolean =>
  cls.cumulative || cls.unit === "rate" || cls.nature !== null || cls.bucket !== null;

/**
 * Colunas que o texto injetado nomeia numa tabela DIFERENTE da que as declara.
 *
 * `periodJoinColumns` vive nos fatos da tabela SEM data, mas o cabecalho dela
 * manda "junte com T por a, b" — e `a, b` precisam estar visiveis tambem em
 * `T`, senao a instrucao e impossivel de cumprir. Resolver isso dentro de
 * `pruneTable` nao daria: quando `T` e podada, ninguem ali sabe que outra
 * tabela vai apontar para ela. Por isso o fecho e calculado antes, sobre o
 * conjunto inteiro.
 *
 * O modo de falha que isto evita e caro e silencioso: faltando uma coluna do
 * ON, o modelo junta so pela chave, casa varias linhas do outro lado e infla
 * o SUM sem erro nenhum.
 */
const crossTableKeeps = (semantics: SemanticContext): Map<string, Set<string>> => {
  const keeps = new Map<string, Set<string>>();
  const add = (table: string, name: string | null | undefined): void => {
    if (!name) return;
    const key = table.toLowerCase();
    let set = keeps.get(key);
    if (!set) {
      set = new Set<string>();
      keeps.set(key, set);
    }
    set.add(name.toLowerCase());
  };

  for (const f of semantics.facts) {
    if (periodStatus(f) !== "requires-join" || !f.periodJoinTable) continue;
    // Mesma escolha do cabecalho: as colunas do ON, ou a chave quando nao ha
    // nenhuma. Ler daqui e do texto duas listas diferentes seria a divergencia
    // que este modulo inteiro existe para nao ter.
    if (f.periodJoinColumns.length) {
      for (const c of f.periodJoinColumns) add(f.periodJoinTable, c);
    } else {
      add(f.periodJoinTable, f.joinKey);
    }
  }
  return keeps;
};

const NO_KEEPS: ReadonlySet<string> = new Set<string>();

/**
 * Corta colunas irrelevantes, preservando o que e estrutural, o que a pergunta
 * cita e o que as guardas comentam. O resto entra por ordem original ate o
 * teto — ordem original porque o ingest ja devolve as colunas na ordem do
 * catalogo, que costuma agrupar o que pertence junto.
 */
const pruneTable = (
  table: ContextTable,
  question: ReadonlySet<string>,
  semantics: SemanticContext,
  fromOtherTables: ReadonlySet<string> = NO_KEEPS
): ContextTable => {
  if (table.columns.length <= MAX_COLUMNS_PER_TABLE) return table;

  const facts = semantics.facts.find(
    (f) => f.tableFullName.toLowerCase() === table.tableFullName.toLowerCase()
  );
  const structural = structuralColumns(table, facts);

  const required: typeof table.columns = [];
  const optional: typeof table.columns = [];
  for (const col of table.columns) {
    const cls = semantics.dictionary.column(table.tableFullName, col.name)?.class;
    const keep =
      structural.has(col.name.toLowerCase()) ||
      fromOtherTables.has(col.name.toLowerCase()) ||
      overlaps(tokenize(col.name), question) ||
      (cls !== undefined && (cls.role === "date" || cls.role === "key" || isNoteworthy(cls)));
    (keep ? required : optional).push(col);
  }

  // O teto e alvo, nao limite duro: se so o que e obrigatorio ja o estoura,
  // cortar ali dentro tiraria justamente a coluna que o SQL precisa.
  const room = MAX_COLUMNS_PER_TABLE - required.length;
  const columns = room <= 0 ? required : [...required, ...optional.slice(0, room)];

  // Ordem original preservada — a lista acima intercala required/optional.
  const kept = new Set(columns.map((c) => c.name));
  return { ...table, columns: table.columns.filter((c) => kept.has(c.name)) };
};

/**
 * Sem dicionario devolve a MESMA referencia, nao uma copia: o chamador precisa
 * poder confiar que o caminho sem E4 e byte-a-byte o de antes.
 */
export const pruneContext = (
  context: ExpandedContext,
  question: string,
  semantics: SemanticContext | null
): ExpandedContext => {
  if (!semantics || semantics.dictionary.all.length === 0) return context;
  const tokens = tokenize(question);
  const keeps = crossTableKeeps(semantics);
  return {
    ...context,
    tables: context.tables.map((t) =>
      pruneTable(t, tokens, semantics, keeps.get(t.tableFullName.toLowerCase()) ?? NO_KEEPS)
    )
  };
};

// --- bloco injetado ---------------------------------------------------------

/**
 * Cada aviso espelha uma guarda de `sqlGuards.ts`, na ordem em que elas rodam.
 * O texto e mais curto que o `hint` da guarda de proposito: o hint corrige um
 * SQL que ja errou e pode se dar ao luxo de ser longo; isto e prevencao e
 * disputa espaco com o schema inteiro.
 */
const tableNotes = (
  table: ContextTable,
  semantics: SemanticContext,
  language: Language
): string[] => {
  const notes: string[] = [];
  const present = table.columns.map((c) => c.name);

  const classOf = (name: string): ColumnClass | undefined =>
    semantics.dictionary.column(table.tableFullName, name)?.class;

  // Guarda 1 — acumulado.
  const cumulative = present.filter((n) => classOf(n)?.cumulative);
  if (cumulative.length) {
    notes.push(
      pick(
        language,
        `acumuladas (use MAX, nunca SUM/AVG entre linhas): ${cumulative.join(", ")}`,
        `cumulative (use MAX, never SUM/AVG across rows): ${cumulative.join(", ")}`,
        `acumuladas (use MAX, nunca SUM/AVG entre filas): ${cumulative.join(", ")}`
      )
    );
  }

  // Guarda 2 — taxa.
  const rates = present.filter((n) => classOf(n)?.unit === "rate");
  if (rates.length) {
    notes.push(
      pick(
        language,
        `taxas/percentuais (nao some nem tire media simples; recalcule SUM(numerador)/NULLIF(SUM(denominador),0) ou pondere por volume): ${rates.join(", ")}`,
        `rates/percentages (do not sum or average directly; recompute SUM(numerator)/NULLIF(SUM(denominator),0) or weight by volume): ${rates.join(", ")}`,
        `tasas/porcentajes (no sumes ni promedies directamente; recalcula SUM(numerador)/NULLIF(SUM(denominador),0) o pondera por volumen): ${rates.join(", ")}`
      )
    );
  }

  // Guarda 6 — meta x realizado.
  const targets = present.filter((n) => classOf(n)?.nature === "target");
  const actuals = present.filter((n) => classOf(n)?.nature === "actual");
  if (targets.length && actuals.length) {
    notes.push(
      pick(
        language,
        `meta (${targets.join(", ")}) e realizado (${actuals.join(", ")}) nao se somam; compare por diferenca ou razao`,
        `target (${targets.join(", ")}) and actual (${actuals.join(", ")}) must not be added together; compare by difference or ratio`,
        `meta (${targets.join(", ")}) y realizado (${actuals.join(", ")}) no se suman; compara por diferencia o razon`
      )
    );
  }

  // Guarda 3 — faixas que se contem.
  const bucketOf = new Map<string, string>();
  for (const n of present) {
    const b = classOf(n)?.bucket;
    if (b && !bucketOf.has(b)) bucketOf.set(b, n);
  }
  for (const [parent, children] of Object.entries(semantics.overlappingBuckets)) {
    const parentCol = bucketOf.get(parent);
    if (!parentCol) continue;
    // `?? []` pela mesma razao de `sqlGuards.ts`: as duas leem a mesma
    // estrutura e uma defesa so protege metade do caminho.
    const present2 = (children ?? [])
      .map((c) => bucketOf.get(c))
      .filter((c): c is string => !!c);
    if (!present2.length) continue;
    notes.push(
      pick(
        language,
        `"${parentCol}" JA CONTEM ${present2.join(", ")} — nunca some os dois niveis na mesma expressao`,
        `"${parentCol}" ALREADY INCLUDES ${present2.join(", ")} — never add both levels in the same expression`,
        `"${parentCol}" YA CONTIENE ${present2.join(", ")} — nunca sumes los dos niveles en la misma expresion`
      )
    );
  }

  return notes;
};

/**
 * Avisos cujas duas pontas caem em TABELAS diferentes.
 *
 * `tableNotes` monta aviso tabela a tabela, mas `makeResolver` do `sqlGuards`
 * resolve coluna nao-qualificada por consenso entre TODAS as tabelas do SQL.
 * Faixa pai em t1 com faixa filha em t2, ou meta em t1 com realizado em t2,
 * disparavam a guarda sem que o prompt tivesse avisado nada — o modelo era
 * punido por uma regra que ninguem contou, que e exatamente o buraco que o E4
 * existe para fechar.
 *
 * Faixa que contem outra e meta-versus-realizado sao relacoes ENTRE COLUNAS,
 * nao propriedades de uma tabela. So o par no mesmo lugar e que era coberto.
 */
const crossTableNotes = (
  context: ExpandedContext,
  semantics: SemanticContext,
  language: Language
): string[] => {
  if (context.tables.length < 2) return [];

  type Located = { table: string; column: string };
  const qualify = (l: Located): string => `${l.table}.${l.column}`;

  const byBucket = new Map<string, Located[]>();
  const targets: Located[] = [];
  const actuals: Located[] = [];

  for (const table of context.tables) {
    for (const col of table.columns) {
      const cls = semantics.dictionary.column(table.tableFullName, col.name)?.class;
      if (!cls) continue;
      const at: Located = { table: table.tableFullName, column: col.name };
      if (cls.bucket) {
        const list = byBucket.get(cls.bucket);
        // Uma ocorrencia por tabela basta: o aviso e sobre o par de tabelas,
        // e listar cinco colunas da mesma faixa so alonga o prompt.
        if (!list) byBucket.set(cls.bucket, [at]);
        else if (!list.some((l) => l.table === at.table)) list.push(at);
      }
      if (cls.nature === "target") targets.push(at);
      if (cls.nature === "actual") actuals.push(at);
    }
  }

  const notes: string[] = [];

  // Guarda 3, cross-table. O par na mesma tabela ja saiu em `tableNotes`.
  for (const [parent, children] of Object.entries(semantics.overlappingBuckets)) {
    for (const p of byBucket.get(parent) ?? []) {
      const cross = (children ?? [])
        .flatMap((c) => byBucket.get(c) ?? [])
        .filter((c) => c.table !== p.table);
      if (!cross.length) continue;
      const list = cross.map(qualify).join(", ");
      notes.push(
        pick(
          language,
          `"${qualify(p)}" JA CONTEM ${list} — nunca some os dois niveis, mesmo estando em tabelas separadas`,
          `"${qualify(p)}" ALREADY INCLUDES ${list} — never add both levels, even from separate tables`,
          `"${qualify(p)}" YA CONTIENE ${list} — nunca sumes los dos niveles, aunque esten en tablas separadas`
        )
      );
    }
  }

  // Guarda 6, cross-table.
  const crossTargets = targets.filter((t) => actuals.some((a) => a.table !== t.table));
  const crossActuals = actuals.filter((a) => targets.some((t) => t.table !== a.table));
  if (crossTargets.length && crossActuals.length) {
    const t = crossTargets.map(qualify).join(", ");
    const a = crossActuals.map(qualify).join(", ");
    notes.push(
      pick(
        language,
        `meta (${t}) e realizado (${a}) estao em tabelas separadas e mesmo assim nao se somam; compare por diferenca ou razao`,
        `target (${t}) and actual (${a}) sit in separate tables and still must not be added; compare by difference or ratio`,
        `meta (${t}) y realizado (${a}) estan en tablas separadas y aun asi no se suman; compara por diferencia o razon`
      )
    );
  }

  return notes;
};

/** Grao + como recortar periodo. Sai de `TableFacts`/`periodStatus` (E2). */
const tableHeader = (facts: TableFacts, language: Language): string[] => {
  const parts: string[] = [];
  if (facts.grain) {
    parts.push(pick(language, `grao: ${facts.grain}`, `grain: ${facts.grain}`, `grano: ${facts.grain}`));
  }

  switch (periodStatus(facts)) {
    case "ready": {
      const alt = facts.alternateDateColumns.length
        ? pick(
            language,
            ` (NAO use ${facts.alternateDateColumns.join(", ")} para periodo: sao outro momento do processo)`,
            ` (do NOT use ${facts.alternateDateColumns.join(", ")} for period: they mark a different moment)`,
            ` (NO uses ${facts.alternateDateColumns.join(", ")} para periodo: marcan otro momento)`
          )
        : "";
      parts.push(
        pick(
          language,
          `data do evento: ${facts.eventDateColumn}${alt}`,
          `event date: ${facts.eventDateColumn}${alt}`,
          `fecha del evento: ${facts.eventDateColumn}${alt}`
        )
      );
      break;
    }
    case "requires-join": {
      const on = facts.periodJoinColumns.length
        ? facts.periodJoinColumns.join(", ")
        : (facts.joinKey ?? "");
      const onText = on ? pick(language, ` por ${on}`, ` on ${on}`, ` por ${on}`) : "";
      parts.push(
        pick(
          language,
          `sem data propria: para recortar periodo junte com ${facts.periodJoinTable}${onText} e filtre a data de la`,
          `no own date: to filter by period join ${facts.periodJoinTable}${onText} and filter that table's date`,
          `sin fecha propia: para recortar periodo une con ${facts.periodJoinTable}${onText} y filtra la fecha de alli`
        )
      );
      break;
    }
    case "ambiguous":
      if (facts.alternateDateColumns.length > 1) {
        parts.push(
          pick(
            language,
            `varias datas e nenhuma marcada como a do evento (${facts.alternateDateColumns.join(", ")}): diga no SQL qual escolheu`,
            `several dates and none marked as the event date (${facts.alternateDateColumns.join(", ")}): state in the SQL which one you chose`,
            `varias fechas y ninguna marcada como la del evento (${facts.alternateDateColumns.join(", ")}): indica en el SQL cual elegiste`
          )
        );
      }
      break;
    case "unavailable":
      parts.push(
        pick(
          language,
          "nao ha data alcancavel: esta tabela nao responde pergunta com recorte de periodo",
          "no reachable date: this table cannot answer a question with a period filter",
          "no hay fecha alcanzable: esta tabla no responde pregunta con recorte de periodo"
        )
      );
      break;
  }

  return parts;
};

/**
 * O bloco inteiro, ou `null` quando nao ha nada a dizer — string vazia viraria
 * um rotulo orfao no prompt, que gasta token e nao ensina nada.
 *
 * Recebe o contexto JA PODADO: o bloco so pode citar coluna que o modelo esta
 * vendo.
 */
export const buildSemanticsSection = (
  context: ExpandedContext,
  semantics: SemanticContext | null,
  language: Language
): string | null => {
  if (!semantics) return null;

  const blocks: string[] = [];
  for (const table of context.tables) {
    const facts = semantics.facts.find(
      (f) => f.tableFullName.toLowerCase() === table.tableFullName.toLowerCase()
    );
    const header = facts ? tableHeader(facts, language) : [];
    const notes = tableNotes(table, semantics, language);
    if (!header.length && !notes.length) continue;

    const lines = [`${table.tableFullName}: ${header.join("; ")}`.replace(/: $/, ":")];
    for (const n of notes) lines.push(`  - ${n}`);
    blocks.push(lines.join("\n"));
  }

  const cross = crossTableNotes(context, semantics, language);
  if (cross.length) {
    const header = pick(language, "Entre tabelas:", "Across tables:", "Entre tablas:");
    blocks.push([header, ...cross.map((n) => `  - ${n}`)].join("\n"));
  }

  if (!blocks.length) return null;

  const label = pick(
    language,
    "Semantica das colunas (o banco aceita o SQL errado em silencio; siga estas regras):",
    "Column semantics (the database accepts wrong SQL silently; follow these rules):",
    "Semantica de las columnas (la base acepta el SQL incorrecto en silencio; sigue estas reglas):"
  );
  return [label, ...blocks].join("\n");
};

export const __semanticsTesting = {
  tokenize,
  pruneTable,
  tableNotes,
  tableHeader,
  crossTableNotes,
  crossTableKeeps
};
