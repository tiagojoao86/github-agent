# github-agent — Roadmap de Evolução

## Contexto

Primeira versão funcional entregue: fluxo completo de desenvolvimento sem sair do GitHub.
Issues como interface de entrada, comentários como canal de interação, PRs como entrega.
Benchmark da v1: issue #49, 7 etapas, 9 commits, 2 bugs resolvidos em sessão, execução autônoma.

---

## Etapa 1 — Comunicação mais rica + estabilização dos logs

**Objetivo:** melhorar o feedback dado ao utilizador nas issues e garantir observabilidade real do sistema.

- Corrigir gravação do log em disco (permissões do volume Docker)
- Registar `cacheRead` e `cacheCreate` tokens no log para análise de custos
- Agente inclui `AGENT_SUMMARY:` no output com resumo do que foi implementado
- Comentário automático na issue ao concluir com sucesso (resumo + lista de arquivos + link do PR)
- PR body gerado automaticamente com lista de ficheiros alterados via `git diff`

---

## Etapa 2 — Interações via comentários do PR

**Objetivo:** fechar o ciclo de revisão de código sem sair do GitHub.

- Monitorar PRs abertos em busca de review comments não resolvidos
- Novo label `agent-review` na issue: agente retoma com contexto do PR e dos comentários
- Agente aplica sugestões de código e resolve as conversas do PR
- Fluxo: reviewer comenta no PR → label `agent-review` na issue → agente corrige e faz push

---

## Etapa 3 — Suporte a múltiplos projetos

**Objetivo:** um agente atendendo vários repositórios, habilitando uso por outras pessoas.

- Configuração `PROJECTS` como lista de `{owner, repo, localPath, chromaCollection}`
- Scheduler processa todos os projetos em cada tick
- RAG isolado por projeto (coleções ChromaDB separadas)
- Deploy continua sendo um único container

---

## Etapa 4 — Execução de plano sequencial entre issues

**Objetivo:** automatizar a execução de features multi-etapa do início ao fim.

- Issue de plano (label `agent-plan`) com lista de etapas no corpo
- Agente cria automaticamente uma issue filha por etapa com `agent-ready`
- Issues filhas são processadas em ordem, com contexto passado via `.agent-context.md` no repo
- Issue pai fecha somente quando todas as filhas fecharem com `agent-done`
- Elimina a necessidade de criar issues filhas e controlar a ordem manualmente

---

## Etapa 5 — Skills para economizar tokens

**Objetivo:** reduzir custo e tempo por sessão através de ferramentas pré-construídas.

- Diretório `skills/` com ferramentas específicas por tipo de projeto (Java/Spring, Angular, etc.)
- Exemplos: `list-entities`, `find-component`, `check-migration-exists`, `run-tests`
- Skills carregadas no system prompt conforme o projeto configurado
- Reduz o tempo que o agente passa explorando arquivos em cada sessão

---

## Etapa 6 — Abertura para múltiplos modelos e utilizadores

**Objetivo:** tornar o agente model-agnostic e acessível a outras pessoas.

- Interface `AgentExecutor` abstraindo o spawn do Claude Code
- `ClaudeCodeExecutor` (comportamento atual) e `OpenCodeExecutor` (OpenCode SDK — 75+ providers)
- Config por projeto: `AGENT_EXECUTOR`, `AGENT_MODEL`
- Multi-utilizador: cada projeto pode ter API key e modelo próprios
- Qualquer pessoa pode apontar para o seu repositório com o modelo que preferir
