import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSql, __testing } from "./validation.js";
import type { DbType } from "./appConfig.js";

const isOk = (sql: string, dbType: DbType = "sqlserver"): boolean =>
  validateSql(sql, dbType).ok;

const errorOf = (sql: string, dbType: DbType = "sqlserver"): string | null => {
  const result = validateSql(sql, dbType);
  return result.ok ? null : (result.error.errorMessage ?? "");
};

/**
 * Regression suite for the false positives reported in the assertiveness review:
 * the blocklist used to run over the raw SQL string, so any legitimate query
 * carrying a keyword inside a literal or a quoted identifier was rejected.
 */
describe("validateSql — literais nao disparam mais o blocklist", () => {
  it("aceita LIKE com a palavra insert no valor", () => {
    assert.equal(
      isOk("SELECT nome FROM clientes WHERE nome LIKE '%insert%' FETCH FIRST 100 ROWS ONLY", "oracle"),
      true
    );
  });

  it("aceita um cliente chamado Create", () => {
    assert.equal(isOk("SELECT id FROM clientes WHERE nome = 'Create'"), true);
  });

  it("aceita texto com set, into e call no mesmo literal", () => {
    assert.equal(isOk("SELECT id FROM logs WHERE msg = 'set into call'"), true);
  });

  it("aceita ponto e virgula dentro do literal", () => {
    assert.equal(isOk("SELECT id FROM t WHERE csv = 'a;b'"), true);
  });

  it("aceita dois hifens dentro do literal", () => {
    assert.equal(isOk("SELECT id FROM t WHERE txt = 'valor--comentario'"), true);
  });

  it("aceita SELECT * dentro do literal", () => {
    assert.equal(isOk("SELECT id FROM t WHERE txt = 'select * from x'"), true);
  });

  it("aceita LIMIT alto dentro do literal", () => {
    assert.equal(isOk("SELECT id FROM t WHERE txt = 'limit 9999' LIMIT 10", "mysql"), true);
  });

  it("aceita aspa simples escapada por duplicacao", () => {
    assert.equal(isOk("SELECT id FROM t WHERE nome = 'it''s insert'"), true);
  });

  it("aceita aspa simples escapada com barra invertida no mysql", () => {
    assert.equal(isOk("SELECT id FROM t WHERE nome = 'it\\'s insert' LIMIT 10", "mysql"), true);
  });
});

describe("validateSql — identificadores citados nao disparam o blocklist", () => {
  it("aceita coluna Create entre aspas duplas", () => {
    assert.equal(isOk('SELECT "Create" FROM t'), true);
  });

  it("aceita coluna insert entre colchetes no sqlserver", () => {
    assert.equal(isOk("SELECT TOP 10 [insert] FROM t", "sqlserver"), true);
  });

  it("aceita coluna call entre backticks no mysql", () => {
    assert.equal(isOk("SELECT `call` FROM t LIMIT 10", "mysql"), true);
  });
});

describe("validateSql — sem colisao por prefixo/sufixo", () => {
  it("OFFSET nao eh confundido com SET", () => {
    assert.equal(
      isOk("SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH FIRST 100 ROWS ONLY", "oracle"),
      true
    );
  });

  it("colunas com underscore nao colidem com keywords", () => {
    assert.equal(isOk("SELECT bulk_qty, call_count, set_id FROM fato_vendas"), true);
  });

  it("COUNT(*) continua permitido", () => {
    assert.equal(isOk("SELECT COUNT(*) FROM t"), true);
  });
});

describe("validateSql — protecoes preservadas", () => {
  it("bloqueia DELETE no inicio", () => {
    assert.equal(isOk("DELETE FROM t"), false);
  });

  it("bloqueia DELETE dentro de um WITH", () => {
    assert.equal(isOk("WITH x AS (SELECT 1 AS a FROM dual) DELETE FROM t"), false);
  });

  it("bloqueia SELECT INTO", () => {
    assert.equal(isOk("SELECT a INTO nova_tabela FROM t"), false);
  });

  it("bloqueia segunda instrucao apos ponto e virgula", () => {
    assert.equal(isOk("SELECT a FROM t; SELECT b FROM u"), false);
  });

  it("bloqueia comentario de bloco", () => {
    assert.equal(isOk("SELECT a FROM t WHERE 1 = 1 /* nada */"), false);
  });

  it("bloqueia comentario de linha", () => {
    assert.equal(isOk("SELECT a FROM t -- nada"), false);
  });

  it("bloqueia query que comeca com comentario", () => {
    assert.equal(isOk("/* x */ SELECT a FROM t"), false);
  });

  it("bloqueia SELECT *", () => {
    assert.equal(isOk("SELECT * FROM t"), false);
  });

  it("bloqueia prefixo dbms_ mesmo em subquery", () => {
    assert.equal(isOk("SELECT a FROM t WHERE b = (SELECT dbms_random.value FROM dual)", "oracle"), false);
  });

  it("bloqueia EXEC", () => {
    assert.equal(isOk("EXEC sp_who"), false);
  });

  it("bloqueia limite de linhas acima de 500", () => {
    assert.equal(isOk("SELECT a FROM t FETCH FIRST 9999 ROWS ONLY", "oracle"), false);
  });

  it("bloqueia SQL vazio", () => {
    assert.equal(isOk("   "), false);
  });
});

describe("validateSql — literal nao fechado", () => {
  it("rejeita string aberta", () => {
    const message = errorOf("SELECT a FROM t WHERE x = 'abc");
    assert.match(String(message), /nao fechado/);
  });

  it("rejeita identificador aberto", () => {
    const message = errorOf('SELECT "abc FROM t');
    assert.match(String(message), /nao fechado/);
  });
});

describe("validateSql — mensagens acionaveis", () => {
  it("sugere aspas duplas quando a keyword pode ser um nome de coluna", () => {
    const message = errorOf("SELECT create FROM t");
    assert.match(String(message), /aspas duplas/);
  });

  it("pede colunas explicitas no lugar de SELECT *", () => {
    const message = errorOf("SELECT * FROM t");
    assert.match(String(message), /liste as colunas/);
  });
});

/**
 * Probes the verification pass found, ported here so they stay covered.
 * Both are dialect-gating bugs: a quote form was honoured in a dialect that
 * does not have it, or not honoured in the one that does.
 */
describe("validateSql — formas de citacao sao especificas do dialeto", () => {
  it("nao trata backtick como citacao fora do mysql", () => {
    // A backtick is not a valid token in pg/oracle/mssql, so the statement
    // would die at the database anyway - but blanking the region hid `drop`
    // from the blocklist, and not hiding keywords is this scan's only job.
    const sql = "SELECT id FROM t WHERE x = `a` OR `; DROP TABLE alunos;`";

    for (const dialect of ["postgresql", "oracle", "sqlserver"] as DbType[]) {
      assert.equal(isOk(sql, dialect), false, `${dialect} deveria bloquear`);
      assert.match(errorOf(sql, dialect) ?? "", /drop/i, `${dialect}`);
    }
  });

  it("aceita backtick como identificador no mysql", () => {
    assert.equal(
      isOk("SELECT `update` FROM `pedidos` LIMIT 100", "mysql"),
      true
    );
  });

  it("aceita q-quote do Oracle com apostrofo interno", () => {
    // Was rejected as an unterminated string: the apostrophe inside q'{...}'
    // read as a terminator. Valid Oracle, and exactly the class of false
    // positive this validator was rewritten to stop producing.
    assert.equal(
      isOk("SELECT id FROM t WHERE obs = q'{it's fine}' FETCH FIRST 10 ROWS ONLY", "oracle"),
      true
    );
  });

  it("aceita todos os delimitadores espelhados de q-quote", () => {
    for (const [open, close] of [["[", "]"], ["{", "}"], ["(", ")"], ["<", ">"]]) {
      const sql = `SELECT id FROM t WHERE obs = q'${open}don't${close}' FETCH FIRST 10 ROWS ONLY`;
      assert.equal(isOk(sql, "oracle"), true, `delimitador ${open}${close}`);
    }
  });

  it("nao deixa o q-quote esconder codigo depois do terminador", () => {
    assert.equal(
      isOk("SELECT id FROM t WHERE obs = q'{x}' ; DROP TABLE alunos", "oracle"),
      false
    );
  });

  it("q-quote nao fechado e malformado, nao aceito", () => {
    assert.equal(
      isOk("SELECT id FROM t WHERE obs = q'{sem fim FETCH FIRST 10 ROWS ONLY", "oracle"),
      false
    );
  });

  it("nao interpreta q-quote fora do oracle", () => {
    // `q` followed by a quote is just an alias and a literal elsewhere.
    assert.equal(isOk("SELECT id FROM t WHERE x = 'a' AND q = 'b'", "postgresql"), true);
  });

  it("nao confunde um identificador terminado em q com q-quote", () => {
    // The `q` here is the tail of `faq`, so the q-quote branch must not fire:
    // `'texto'` stays an ordinary literal and what remains as code is `faq`, a
    // column name. Were the guard missing, the branch would hunt for a `}'`
    // style terminator and swallow the rest of the statement.
    assert.equal(
      isOk("SELECT id FROM t WHERE faq = 'texto' FETCH FIRST 10 ROWS ONLY", "oracle"),
      true
    );

    // Same shape, but with a keyword outside the literal that must still be seen.
    assert.equal(
      isOk("SELECT id FROM t WHERE faq = 'texto' ; DROP TABLE alunos", "oracle"),
      false
    );
  });
});

describe("scanSql", () => {
  const { scanSql } = __testing;

  it("preserva o comprimento da string", () => {
    const sql = "SELECT a FROM t WHERE x = 'insert into' AND y = 1";
    assert.equal(scanSql(sql, "oracle").code.length, sql.length);
  });

  it("apaga o literal mas mantem o codeigo em volta", () => {
    const scan = scanSql("SELECT a FROM t WHERE x = 'insert' AND y = 1", "oracle");
    assert.equal(scan.code.includes("insert"), false);
    assert.equal(scan.code.includes("SELECT a FROM t WHERE x ="), true);
    assert.equal(scan.code.includes("AND y = 1"), true);
  });

  it("sinaliza comentario", () => {
    assert.equal(scanSql("SELECT a FROM t -- x", "oracle").hasComment, true);
    assert.equal(scanSql("SELECT a FROM t WHERE x = '-- x'", "oracle").hasComment, false);
  });

  it("trata # como comentario apenas no mysql", () => {
    assert.equal(scanSql("SELECT a FROM t # x", "mysql").hasComment, true);
    assert.equal(scanSql("SELECT a FROM t # x", "oracle").hasComment, false);
  });

  it("sinaliza literal nao terminado", () => {
    assert.equal(scanSql("SELECT a FROM t WHERE x = 'abc", "oracle").unterminated, "string");
    assert.equal(scanSql("SELECT a FROM t WHERE x = 'abc'", "oracle").unterminated, null);
  });
});
