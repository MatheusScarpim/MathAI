export type ErrorCategory =
  | "column_not_found"
  | "type_mismatch"
  | "syntax_error"
  | "timeout"
  | "table_not_found"
  | "ambiguous_column"
  | "aggregation_error"
  | "join_error"
  | "permission_denied"
  | "validation_error"
  | "connection_error"
  | "unknown";

export type ClassifiedError = {
  category: ErrorCategory;
  originalMessage: string;
  hint: string;
};

/**
 * Errors that no amount of SQL rewriting can fix. Retrying these only burns
 * wall-clock time (each Oracle connect attempt blocks for the full TCP
 * timeout) and reflection tokens, and it buries the real cause under a
 * generic "nao consegui responder" message.
 */
const NON_RETRIABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  "connection_error"
]);

export const isRetriableError = (category: ErrorCategory): boolean =>
  !NON_RETRIABLE_CATEGORIES.has(category);

const errorPatterns: Array<{ pattern: RegExp; category: ErrorCategory; hint: string }> = [
  // Must precede the generic timeout rule: ORA-12170 is a *connect* timeout,
  // not a query timeout, and telling the model to "simplify the query" is
  // actively misleading when the database is simply unreachable.
  {
    pattern:
      /ORA-12170|ORA-12541|ORA-12514|ORA-12545|ORA-01034|ORA-27101|ORA-12537|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|connect timeout|could not connect|connection refused|failed to connect|network-related or instance-specific/i,
    category: "connection_error",
    hint: "Nao foi possivel conectar ao banco de dados. Isso nao e um problema do SQL - verifique host, porta, VPN/firewall e se a instancia esta no ar."
  },
  {
    pattern: /invalid column name|column .+ (not found|does not exist|nao existe)|unknown column|ORA-00904/i,
    category: "column_not_found",
    hint: "A coluna referenciada nao existe na tabela. Verifique os nomes exatos das colunas no schema fornecido e use apenas colunas listadas."
  },
  {
    pattern: /invalid object name|table .+ (not found|does not exist|nao existe)|relation .+ does not exist|ORA-00942/i,
    category: "table_not_found",
    hint: "A tabela referenciada nao existe. Use apenas tabelas listadas no schema fornecido, com schema e nome completos (ex: dbo.NomeTabela)."
  },
  {
    pattern: /conversion failed|cannot convert|type mismatch|incompatible|operand type clash|ORA-01722|ORA-01858/i,
    category: "type_mismatch",
    hint: "Ha incompatibilidade de tipos. Verifique os tipos das colunas no schema e use CAST/CONVERT quando necessario. Datas devem usar o formato correto do banco."
  },
  {
    pattern: /syntax error|incorrect syntax|unexpected token|ORA-00933|ORA-00936|parse error/i,
    category: "syntax_error",
    hint: "Erro de sintaxe SQL. Revise a estrutura da query: parenteses, virgulas, palavras-chave e clausulas obrigatorias."
  },
  {
    pattern: /timeout|timed out|execution time|ORA-01013|wait timeout/i,
    category: "timeout",
    hint: "A query excedeu o tempo limite. Simplifique: reduza JOINs, adicione filtros mais restritivos, evite subqueries correlacionadas e use TOP/LIMIT menor."
  },
  {
    pattern: /ambiguous column|ambiguous .+ reference|ORA-00918/i,
    category: "ambiguous_column",
    hint: "Coluna ambigua encontrada. Quando usar JOINs, qualifique todas as colunas com o alias da tabela (ex: t1.coluna, t2.coluna)."
  },
  {
    pattern: /not .+ in .+ aggregate|not contained in .+ group by|aggregate function|ORA-00937|ORA-00979/i,
    category: "aggregation_error",
    hint: "Erro de agregacao. Toda coluna no SELECT que nao esta em uma funcao de agregacao (SUM, COUNT, etc.) precisa estar no GROUP BY."
  },
  {
    pattern: /multi-part identifier .+ could not be bound|join .+ failed|cannot resolve|ORA-00905/i,
    category: "join_error",
    hint: "Erro no JOIN. Verifique se as tabelas e colunas de juncao existem no schema e se os aliases estao corretos."
  },
  {
    pattern: /permission denied|access denied|ORA-01031|unauthorized/i,
    category: "permission_denied",
    hint: "Sem permissao para acessar o objeto. Tente usar tabelas/views alternativas do schema fornecido."
  }
];

export const classifyError = (errorMessage: string, isValidationError: boolean = false): ClassifiedError => {
  if (isValidationError) {
    return {
      category: "validation_error",
      originalMessage: errorMessage,
      hint: "O SQL gerado violou regras de validacao. Releia as regras: apenas SELECT/WITH, sem SELECT *, com limitacao de linhas (TOP/LIMIT/FETCH), sem keywords proibidas."
    };
  }

  for (const { pattern, category, hint } of errorPatterns) {
    if (pattern.test(errorMessage)) {
      return { category, originalMessage: errorMessage, hint };
    }
  }

  return {
    category: "unknown",
    originalMessage: errorMessage,
    hint: "Analise a mensagem de erro com cuidado e tente uma abordagem diferente para a query."
  };
};
