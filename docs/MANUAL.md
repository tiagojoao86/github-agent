# Manual do GitHub Agent

Guia prático para quem opera o sistema — como iniciar tarefas, interpretar estados, e lidar com as situações mais comuns.

---

## O que o sistema faz

O GitHub Agent monitoriza repositórios GitHub e executa automaticamente issues marcadas com labels especiais. Usa o Claude Code CLI para escrever código, abre PRs, faz code review automático e pede ajuda humana quando fica bloqueado.

---

## Configuração inicial

Acede ao dashboard em `http://<servidor>:3000` e adiciona um projeto com:

| Campo | Exemplo | Descrição |
|-------|---------|-----------|
| Owner | `tiagojoao86` | Utilizador/organização no GitHub |
| Repo | `gestao-integrada-pipa` | Nome do repositório |
| Local path | `/workspace/gestao-integrada-pipa` | Caminho dentro do container |
| Base branch | `dev` | Branch de destino dos PRs |
| GitHub token | `ghp_...` | Token do bot (ver secção de tokens abaixo) |
| Modelos | (opcional) | Modelo por fase: plan / dev / review |

### Token GitHub

Cria um token **Classic** em `Settings → Developer settings → Personal access tokens → Tokens (classic)` para a conta bot, com o escopo `repo` completo.

Permissões mínimas necessárias:

| Permissão | Acesso |
|-----------|--------|
| Contents | Leitura e escrita |
| Issues | Leitura e escrita |
| Pull requests | Leitura e escrita |
| Metadata | Leitura |

---

## Como iniciar uma tarefa

### Tarefa simples

1. Cria uma issue no GitHub com título e descrição clara do que deve ser feito
2. Adiciona o label **`agent-ready`**
3. O agente processa na próxima iteração (padrão: a cada 5 minutos)

### Tarefa complexa com plano (multi-etapa)

1. Cria a issue descrevendo o conjunto de funcionalidades
2. Adiciona o label **`agent-plan`**
3. O agente cria um plano com etapas e posta como comentário
4. Revisa o plano:
   - Se está correto: adiciona `agent-plan-approved`
   - Se quer mudanças: comenta o que alterar e recoloca `agent-plan`
5. Após aprovação, o agente cria issues filhas e executa em sequência

---

## Estados (labels) e o que significam

```
agent-plan
    │ agente cria plano
    ▼
agent-plan-review ──[humano rejeita]──► agent-plan (volta ao início)
    │ humano aprova
    ▼
agent-plan-approved
    │ agente cria issues filhas
    ▼
agent-queued ──[dependências resolvidas]──► agent-ready
    │
    ▼
agent-ready ──────────────────────────────────────────────────────┐
    │ agente inicia                                                │
    ▼                                                             │
agent-processing                                                  │
    │                                                             │
    ├──[concluído]──► agent-code-review                           │
    │                     │ aprovado                              │
    │                     ├────────────► agent-done               │
    │                     │ rejeitado (até 2×)                    │
    │                     └────────────► agent-ready ─────────────┘
    │                     │ rejeitado (3ª vez)
    │                     └────────────► waiting-for-human
    │
    ├──[pergunta]──► waiting-for-human
    │                     │ humano responde e aplica:
    │                     └────────────► waiting-for-agent
    │                                       │ agente retoma
    │                                       └──► agent-processing
    │
    └──[rate limit / erro]──► agent-ready (volta para fila)
```

---

## Situações comuns e o que fazer

### O agente fez uma pergunta

**Sintoma:** issue com label `waiting-for-human` e comentário do agente com uma dúvida.

**O que fazer:**
1. Lê o comentário do agente
2. Responde na issue com a informação pedida
3. Muda o label para **`waiting-for-agent`**

O agente retoma com o contexto completo da conversa.

---

### O reviewer rejeitou o código

**Sintoma:** label voltou para `agent-ready` com comentário `🔴 Code review rejeitado`.

**O que fazer:** Nada — o agente vai corrigir automaticamente na próxima iteração. Os comentários de rejeição ficam visíveis no prompt do dev.

**Após 2 rejeições consecutivas**, o sistema escala para `waiting-for-human` com a mensagem "⚠️ Intervenção humana necessária". Nesse caso:
1. Lê os comentários de rejeição para entender o problema
2. Ajuda o agente com um comentário mais específico
3. Aplica o label **`waiting-for-agent`**

---

### Os testes estão a falhar no PR de uma tarefa simples

**Sintoma:** PR aberto pelo agente, mas CI reporta testes a falhar. A issue está em `agent-done`.

**O que fazer:**
1. Copia o output de erro dos testes
2. Posta como comentário na issue com o erro completo
3. Muda o label de `agent-done` para **`agent-ready`**

O agente vai retomar na branch existente e tentar corrigir.

---

### Os testes estão a falhar no PR do plano (`agent/plan-N` → `dev`)

**Sintoma:** Todas as etapas do plano foram concluídas, mas o PR final (`agent/plan-N` → `dev`) tem testes a falhar. A issue do plano está em `agent-done` ou `agent-plan-running`.

**O que fazer:**

1. **Edita o corpo da issue do plano** (ex: issue #137) e adiciona no final:
   ```html
   <!-- agent-plan-meta: {"planIssue":137,"planBranch":"agent/plan-137","dependsOn":[],"step":0,"totalSteps":0} -->
   ```
   *(substitui `137` pelo número da tua issue de plano)*

2. **Posta um comentário** na issue com o output completo dos testes a falhar

3. **Muda o label** para **`agent-plan-fix`**

O agente vai trabalhar diretamente na branch `agent/plan-137`, corrigir os testes, e fazer push — o PR existente é atualizado automaticamente.

---

### O agente ficou preso em `agent-processing`

**Sintoma:** issue com `agent-processing` há mais de 10 minutos sem actividade nos logs.

**O que fazer:** O sistema tem um watchdog automático que detecta ticks presos e reinicia. Se persistir:
1. Verifica os logs do container: `docker compose logs --tail=50 agent`
2. Se for rate limit da Anthropic, aguarda — o sistema entra em cooldown automático
3. Se for outro erro, muda manualmente o label de volta para `agent-ready`

---

### O token do bot expirou

**Sintoma:** erro nos logs: `Authentication failed for 'https://github.com/...'`

**O que fazer:**
1. Gera um novo token Classic em `Settings → Developer settings → Personal access tokens`
2. Seleciona o escopo `repo` completo
3. No dashboard (`http://<servidor>:3000`), edita o projeto e substitui o token
4. Reinicia o container: `docker compose up -d --force-recreate agent`

---

### Uma issue filha do plano ficou bloqueada

**Sintoma:** issue filha em `waiting-for-human` ou erro, enquanto outras etapas do plano dependem dela.

**O que fazer:**
1. Resolve o problema da issue filha (responde a dúvida, ou força `agent-ready`)
2. As issues filhas que estavam em `agent-queued` avançam automaticamente quando a dependência é resolvida

---

## Critérios de aceitação (AGENTS.md)

O agente lê um ficheiro `AGENTS.md` (ou `CLAUDE.md`) na raiz do repositório alvo para entender:
- Como executar os testes (`npm test`, `mvn test`, etc.)
- Regras de estilo e linting
- Restrições de arquitetura
- Critérios de aceitação para declarar uma tarefa como concluída

**Sem esse ficheiro, o agente não sabe como validar o seu próprio trabalho.** Cria um `AGENTS.md` no repositório alvo com pelo menos:

```markdown
## Testes
mvn test -q

## Linting / Checkstyle
mvn checkstyle:check

## Critérios de aceitação
- Todos os testes devem passar antes de declarar SUCCESS
- Sem erros de checkstyle
```

---

## Labels de referência rápida

| Label | Quem aplica | Significado |
|-------|-------------|-------------|
| `agent-ready` | Humano | "Processa esta issue" |
| `agent-processing` | Sistema | Em execução — não toques |
| `agent-code-review` | Sistema | Aguardando review automático |
| `agent-done` | Sistema | PR criado, pronto para revisão humana |
| `waiting-for-human` | Sistema | Agente precisa de ajuda |
| `waiting-for-agent` | Humano | "Já respondi, podes continuar" |
| `agent-plan` | Humano | "Cria um plano para isto" |
| `agent-plan-review` | Sistema | Plano pronto para o humano rever |
| `agent-plan-approved` | Humano | "Plano aprovado, executa" |
| `agent-plan-running` | Sistema | Etapas do plano em execução |
| `agent-queued` | Sistema | Aguarda dependências de outras etapas |
| `agent-review` | Humano/Sistema | Há comentários de PR para o agente aplicar |
| `agent-plan-fix` | Humano | Corrigir branch do plano diretamente |

---

## Dicas de uso

- **Sê específico nas issues:** quanto mais detalhe (exemplos, contexto, ficheiros relevantes), melhor o resultado
- **Posta erros completos:** quando reportas um problema para o agente, inclui sempre o stack trace completo — não apenas "os testes falham"
- **Usa o plano para funcionalidades grandes:** tarefas com mais de 3-4 ficheiros a criar/modificar beneficiam do fluxo `agent-plan`
- **O agente lê os comentários:** podes orientar o agente num comentário a qualquer momento antes de marcares `agent-ready` ou `waiting-for-agent`
