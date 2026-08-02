# Casos de eval

Cada arquivo `.json` nesta pasta é um array de `EvalCase` (ver `../types.ts`).
Todos são carregados juntos; o nome do arquivo só serve para organizar.

## Rodando

```bash
npm run eval -- --list                 # valida a suíte, não precisa de env
npm run eval -- --tags ano,idioma      # roda só um subconjunto
npm run eval -- --only recusa-update   # roda um caso
npm run eval -- --label baseline       # grava eval/runs/baseline.json
```

`--list` não importa o pipeline, então roda sem `JWT_SECRET`/Mongo/Qdrant.
Use como lint da suíte no CI. Qualquer outra invocação precisa de um ambiente
configurado e alcançável.

Cada caso roda em um `chatId` novo (`eval-<id>-<uuid>`), o que garante caminho
frio e isola o histórico de conversa. `--warm` reusa o mesmo `chatId` para medir
o caminho com cache semântico.

## Medindo uma mudança

```bash
npm run eval -- --label antes
# ... aplica a mudança ...
npm run eval -- --label depois
npm run eval:diff
```

`eval:diff` separa **regressões** (passava, agora falha) de **correções**. Olhe
as regressões primeiro: uma taxa de acerto que sobe escondendo três regressões
não é progresso, é churn. Sai com código 1 se houver qualquer regressão.

Comparação de latência só vale entre runs com o mesmo `--concurrency` e o mesmo
estado de cache — o diff avisa quando divergem.

## Escrevendo casos

Os dois tipos de caso têm regras diferentes.

**Invariantes** (`invariants.json`) afirmam consistência interna, não valores de
domínio: que o resumo não cita ano que o SQL não filtrou, que o idioma da
resposta é o pedido, que uma query legítima não é bloqueada. Rodam em qualquer
schema. Escreva estes à mão.

**Casos de domínio** afirmam que uma pergunta específica dá um número
específico. Dependem do schema e dos dados. Gere rascunhos do histórico real:

```bash
npm run eval:bootstrap -- --favorites --limit 30
npm run eval:bootstrap -- --limit 60 --out drafts.json
```

Todo rascunho sai com `"skip": true`, e isso é o ponto: um caso gerado de uma
resposta passada afirma que aquela resposta *estava correta*, o que ninguém
verificou. Habilitar automaticamente congelaria os bugs de hoje na baseline como
comportamento esperado.

Revisão de cada rascunho:

1. A resposta registrada estava realmente certa? Se não, corrija `expect` ou
   descarte o caso.
2. Aperte o `expect`: `sqlMustMatch` para a tabela que precisa ser usada,
   `expectedValue` quando você sabe o número verdadeiro.
3. Remova o `skip` e comite.

Um `expect` frouxo é pior que nenhum caso — passa sempre e dá falsa confiança.

## Assertivas disponíveis

| Campo | Para que serve |
| --- | --- |
| `shouldSucceed` | `false` para casos que **devem** ser recusados (DDL, DML, multi-statement) |
| `sqlMustMatch` / `sqlMustNotMatch` | regex no SQL gerado — tabela obrigatória, join proibido |
| `sqlYears` | conjunto exato de anos que o SQL deve filtrar |
| `minRows` / `maxRows` / `exactRows` | forma do resultado |
| `expectedValue` (+ `tolerance`) | valor numérico de uma coluna; tolera formato pt-BR |
| `answerContains` / `answerMustNotContain` | conteúdo do resumo |
| `summaryYearsSubsetOfSql` | resumo não cita ano fora do filtro do SQL (**ligado por padrão**) |
| `assertLanguage` | idioma da resposta bate com o pedido |
| `maxElapsedMs` | piso de latência |

`history` transforma o caso em multi-turno: as perguntas são enviadas antes da
principal, no mesmo `chatId`.

## Códigos de falha

Cada `FailureCode` aponta para um item do plano
(`.claude/plans/auraia-assertividade-latencia.md`) via `FAILURE_HINTS` em
`../types.ts`. Um pico concentrado em um código indica qual item mexer. Dois
pares merecem atenção:

- `FALSE_BLOCK` é o **nosso** validador recusando query legítima (item #3).
  `SQL_ERROR` é o banco recusando. Consertos diferentes.
- `SUMMARY_YEAR_INCONSISTENT` é o item #1: o resumo afirma um período que a
  query não consultou.

## Convenções

- `id` em kebab-case, estável — é a chave do diff entre runs. Renomear um `id`
  aparece como um caso removido e um adicionado.
- `tags` para fatiar por defeito (`ano`, `idioma`, `falso-bloqueio`, `recusa`,
  `latencia`, `historico`).
- `notes` explicando **qual defeito o caso protege**. Sem isso, um caso que
  falha em seis meses vira candidato a ser deletado em vez de investigado.
