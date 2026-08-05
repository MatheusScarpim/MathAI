import type { AskSuccessResponse } from "@auraia/shared";
import { resolveColumnFormatsFromNames } from "../schema/columnFormat.js";

const fallbackSummary = (rowCount: number, language: string | undefined): string => {
  if (language === "en") {
    return rowCount === 0
      ? "No results were found for this question."
      : `The query returned ${rowCount} result${rowCount === 1 ? "" : "s"}.`;
  }
  if (language === "es") {
    return rowCount === 0
      ? "No se encontraron resultados para esta pregunta."
      : `La consulta devolvio ${rowCount} resultado${rowCount === 1 ? "" : "s"}.`;
  }
  return rowCount === 0
    ? "Nenhum resultado foi encontrado para esta pergunta."
    : `A consulta retornou ${rowCount} resultado${rowCount === 1 ? "" : "s"}.`;
};

export const normalizeAskSuccessResponse = (data: AskSuccessResponse): AskSuccessResponse => {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const columns = Array.isArray(data.columns) ? data.columns : [];

  return {
    ...data,
    sql: typeof data.sql === "string" ? data.sql : "",
    rows,
    columns,
    // Hit de cache gravado antes deste campo existir traria a resposta sem
    // mascara, e a tabela alternaria de formatada para crua durante os 900s de
    // TTL. Recalcular aqui e possivel exatamente porque a derivacao e
    // deterministica — nao precisa versionar chave de cache nem invalidar nada.
    //
    // Sem o vocabulario do ambiente (esta funcao e sincrona e nao sabe o
    // environmentId), entao vale so a convencao PT-BR embutida. Pior que o
    // caminho normal, melhor que nada, e dura um TTL.
    columnFormats: data.columnFormats ?? resolveColumnFormatsFromNames(columns, { samples: rows }),
    elapsedMs: Number.isFinite(data.elapsedMs) ? data.elapsedMs : 0,
    summary:
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : fallbackSummary(rows.length, data.responseLanguage)
  };
};
