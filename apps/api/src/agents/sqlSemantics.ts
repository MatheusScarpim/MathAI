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
 * Corta colunas irrelevantes, preservando o que e estrutural, o que a pergunta
 * cita e o que as guardas comentam. O resto entra por ordem original ate o
 * teto — ordem original porque o ingest ja devolve as colunas na ordem do
 * catalogo, que costuma agrupar o que pertence junto.
 */
const pruneTable = (
  table: ContextTable,
  question: ReadonlySet<string>,
  semantics: SemanticContext
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
  return { ...context, tables: context.tables.map((t) => pruneTable(t, tokens, semantics)) };
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
    const present2 = children.map((c) => bucketOf.get(c)).filter((c): c is string => !!c);
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

  if (!blocks.length) return null;

  const label = pick(
    language,
    "Semantica das colunas (o banco aceita o SQL errado em silencio; siga estas regras):",
    "Column semantics (the database accepts wrong SQL silently; follow these rules):",
    "Semantica de las columnas (la base acepta el SQL incorrecto en silencio; sigue estas reglas):"
  );
  return [label, ...blocks].join("\n");
};

export const __semanticsTesting = { tokenize, pruneTable, tableNotes, tableHeader };
