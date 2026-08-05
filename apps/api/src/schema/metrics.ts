/**
 * Catalogo de metricas canonicas — o "como se calcula", que o dicionario nao
 * tem como derivar.
 *
 * As guardas do E3 sabem o que NAO fazer (nao tirar media de percentual, nao
 * somar coluna acumulada). O dicionario sabe o grao e a data do evento. O que
 * faltava e o inverso da guarda: a definicao POSITIVA. Uma taxa de negocio tem
 * um numerador e um denominador so, e sem catalogo o modelo reinventa o par a
 * cada pergunta — as vezes acerta, as vezes divide pela coluna vizinha, e o
 * resultado passa pelas guardas porque e formalmente uma razao bem formada.
 *
 * Este modulo e MOTOR: define a forma, valida e renderiza. Nenhuma metrica
 * mora aqui — todas vem do seed do ambiente, e `vocabulary.test.ts` falha se
 * um nome de metrica reaparecer chumbado neste arquivo.
 */

/**
 * Como a metrica se comporta sob agregacao. Cada valor mapeia exatamente uma
 * guarda do E3 — e essa correspondencia e o ponto do catalogo: o prompt manda
 * fazer o que a guarda deixaria passar.
 */
export const METRIC_KINDS = ["ratio", "rate_only", "level", "cumulative", "snapshot"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * De onde saiu o mapeamento de coluna.
 *
 * `schema` = par numerador/denominador corroborado por artefato do repo (a
 * coluna pre-calculada existe ao lado, ou a curadoria de tabela declara).
 * `inferred` = deduzido do nome da coluna e AINDA NAO CONFIRMADO por ninguem
 * que conheca o negocio. A distincao existe para nao maquiar cobertura: uma
 * metrica inferida entra no prompt marcada, e o consumidor decide se confia.
 */
export const METRIC_PROVENANCES = ["schema", "inferred"] as const;
export type MetricProvenance = (typeof METRIC_PROVENANCES)[number];

export const METRIC_UNITS = ["fraction", "percent", "count", "gram", "kcal", "weight"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** `ratio` e a unica forma que carrega par; as demais leem uma coluna so. */
export const kindNeedsPair = (kind: MetricKind): boolean => kind === "ratio";
export const kindNeedsColumn = (kind: MetricKind): boolean => kind !== "ratio";

export type MetricDefinition = {
  /** Identificador estavel, minusculo, sem espaco. */
  id: string;
  /** Rotulo em prosa, so para leitura humana. */
  label: string;
  /** Como o usuario pode chamar a metrica na pergunta. */
  synonyms: readonly string[];
  kind: MetricKind;
  /** Nome completo da tabela onde a metrica se calcula. */
  table: string;
  /** `ratio`: numerador. */
  numerator?: string;
  /** `ratio`: denominador. */
  denominator?: string;
  /** Demais formas: a coluna lida direto. */
  column?: string;
  /** Coluna ja calculada pelo banco, quando existe ao lado do par. */
  precomputed?: string;
  /** Coluna de meta/referencia do seed. NUNCA e o realizado. */
  targetColumn?: string;
  unit: MetricUnit;
  provenance: MetricProvenance;
  /** Armadilhas especificas. Entram no prompt junto com a formula. */
  pitfalls: readonly string[];
};

/**
 * A expressao SQL correta para agregar a metrica.
 *
 * Derivada de `kind`, nunca escrita no seed. Um seed que pudesse trazer o SQL
 * pronto poderia trazer `AVG(pct_eclosao)` e o catalogo passaria a ensinar
 * exatamente o erro que a guarda existe para barrar.
 */
export const metricSql = (m: MetricDefinition): string | null => {
  switch (m.kind) {
    case "ratio":
      return `SUM(${m.numerator}) / NULLIF(SUM(${m.denominator}), 0)`;
    case "cumulative":
      return `MAX(${m.column})`;
    case "level":
      return `AVG(${m.column})`;
    case "snapshot":
    case "rate_only":
      // De proposito sem expressao: nao existe agregacao correta sem saber o
      // peso de cada registro. Dizer "use SUM" aqui seria inventar.
      return null;
  }
};

/** A regra de agregacao em uma frase, no vocabulario das guardas do E3. */
const kindRule = (m: MetricDefinition): string => {
  switch (m.kind) {
    case "ratio":
      return "taxa: recalcule pelo par, nunca AVG da coluna pronta";
    case "rate_only":
      return "taxa sem par disponivel: leia por registro; para agregar, pondere pelo volume";
    case "cumulative":
      return "acumulada: use MAX, nunca SUM entre linhas";
    case "snapshot":
      return "saldo pontual: nao se soma entre periodos";
    case "level":
      return "nivel medido: AVG entre linhas, nunca SUM";
  }
};

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const TOKEN = /[a-z0-9]+/g;

const tokensOf = (text: string): Set<string> => new Set(norm(text).match(TOKEN) ?? []);

/**
 * Metricas que a pergunta menciona.
 *
 * Casamento por FRASE, nao por token solto: um sinonimo de uma palavra so
 * ("postura") casa quando o token aparece; um sinonimo composto ("ovo ave")
 * exige os dois tokens presentes. Token solto de duas letras nunca casa —
 * `cv` e `mf` sao sinonimos legitimos mas casariam com ruido demais se
 * entrassem por substring.
 *
 * Silencio na duvida, como no E3: e melhor nao injetar a formula do que
 * injetar a formula errada e ensinar o modelo a olhar a tabela errada.
 */
export const findMetrics = (
  question: string,
  metrics: readonly MetricDefinition[]
): MetricDefinition[] => {
  const asked = tokensOf(question);
  if (asked.size === 0) return [];

  return metrics.filter((m) =>
    [m.id, ...m.synonyms].some((phrase) => {
      const parts = [...tokensOf(phrase)];
      if (parts.length === 0) return false;
      return parts.every((p) => asked.has(p));
    })
  );
};

/**
 * Bloco de prompt para as metricas reconhecidas.
 *
 * Devolve `null` quando nao ha nada a dizer — o chamador nao precisa saber se
 * o catalogo esta vazio, se a pergunta nao casou ou se o ambiente nem tem
 * seed instalado. Todos os tres casos degradam para o prompt de antes.
 */
export const renderMetricsSection = (matched: readonly MetricDefinition[]): string | null => {
  if (matched.length === 0) return null;

  const lines = matched.map((m) => {
    const parts: string[] = [`- ${m.label} (${m.table}): ${kindRule(m)}.`];

    const sql = metricSql(m);
    if (sql) parts.push(`  formula: ${sql}`);
    if (m.precomputed) {
      parts.push(
        sql
          ? `  ja calculada em ${m.precomputed} — use so quando o recorte e de um registro so`
          : `  coluna pronta: ${m.precomputed}`
      );
    }
    if (!sql && !m.precomputed && m.column) parts.push(`  coluna: ${m.column}`);
    if (m.targetColumn) parts.push(`  referencia: ${m.targetColumn} (e a meta, nunca o realizado)`);
    for (const p of m.pitfalls) parts.push(`  atencao: ${p}`);
    if (m.provenance === "inferred") {
      parts.push("  MAPEAMENTO NAO CONFIRMADO: confira a coluna antes de afirmar o numero");
    }
    return parts.join("\n");
  });

  return ["Metricas canonicas (definicao do negocio, ja validada):", ...lines].join("\n");
};

/**
 * Toda coluna que a metrica referencia, para quem precisa garantir que a poda
 * do E4 nao corte o que a formula exige.
 */
export const metricColumns = (m: MetricDefinition): string[] =>
  [m.numerator, m.denominator, m.column, m.precomputed, m.targetColumn].filter(
    (c): c is string => typeof c === "string"
  );
