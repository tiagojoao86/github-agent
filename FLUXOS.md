# github-agent — Guia de Fluxos

## Visão geral dos labels

| Label | Quem coloca | Significado |
|---|---|---|
| `agent-ready` | **Você** | Issue pronta para o agente processar |
| `agent-processing` | Sistema | Agente está a trabalhar |
| `waiting-for-human` | Sistema | Agente fez uma pergunta — aguarda sua resposta |
| `waiting-for-agent` | **Você** | Respondeu ao agente — ele retoma na próxima iteração |
| `agent-done` | Sistema | PR criado, trabalho concluído |
| `agent-review` | **Você** | Quer que o agente aplique comentários do PR |
| `agent-plan` | **Você** | Quer criar um plano multi-etapa |
| `agent-plan-review` | Sistema | Plano gerado — aguarda sua revisão |
| `agent-plan-approved` | **Você** | Plano aprovado — cria as tarefas |
| `agent-plan-running` | Sistema | Plano em execução |
| `agent-queued` | Sistema | Tarefa do plano aguardando dependências |

---

## Fluxo 1 — Implementação direta

Use quando a issue está bem definida e não precisa de esclarecimentos.

```
Você cria a issue
    ↓
Adiciona: agent-ready
    ↓ (agente implementa automaticamente)
Sistema adiciona: agent-done
PR criado e comentário na issue com resumo
```

**O que você faz:**
1. Cria a issue com título e descrição clara
2. Adiciona o label `agent-ready`
3. Aguarda — o agente implementa, cria o PR e posta um resumo na issue
4. Revisa o PR e faz merge

---

## Fluxo 2 — Implementação com esclarecimento

Use quando o agente precisa de informação antes de implementar, ou quando a sua primeira implementação precisa de ajustes.

```
Você cria a issue
    ↓
Adiciona: agent-ready
    ↓ (agente encontra uma dúvida)
Sistema adiciona: waiting-for-human
Agente posta pergunta na issue
    ↓
Você responde nos comentários da issue
Muda label para: waiting-for-agent
    ↓ (agente retoma com o contexto dos comentários)
Sistema adiciona: agent-done
```

**O que você faz:**
1. Adiciona `agent-ready`
2. Quando aparecer `waiting-for-human`: lê a pergunta do agente nos comentários
3. Responde no comentário
4. Muda o label de `waiting-for-human` para `waiting-for-agent`
5. O agente retoma automaticamente no próximo tick

**Para solicitar ajustes após o PR ser criado:**
1. Comenta na issue o que precisa mudar
2. Remove `agent-done`
3. Adiciona `waiting-for-agent`
4. O agente aplica as correções e atualiza o PR

---

## Fluxo 3 — Revisão de PR (agent-review)

Use quando o agente criou o PR e você (ou um reviewer) quer que o agente corrija comentários de review.

```
PR criado (agent-done na issue)
    ↓
Reviewer posta comentários no PR
    ↓
Você adiciona: agent-review na issue
    ↓ (agente lê os comentários do PR e aplica as correções)
Agente faz push das correções
Sistema resolve os threads do PR como resolvidos
Comentário na issue: "🔄 Review aplicado"
    ↓
Você re-revisa o PR
```

**O que você faz:**
1. Após o PR ter comentários de review, vai à issue associada
2. Adiciona o label `agent-review`
3. O agente aplica as correções e marca os threads do PR como resolvidos
4. Revisa o PR atualizado

**Nota:** o label `agent-done` é mantido na issue durante e após o processo de review.

---

## Fluxo 4 — Plano multi-etapa (agent-plan)

Use para features complexas que precisam ser divididas em etapas ordenadas, com dependências entre elas.

### Fase 1 — Criar o plano

```
Você cria a issue com a descrição completa da feature
    ↓
Adiciona: agent-plan
    ↓ (agente analisa e escreve o plano)
Sistema adiciona: agent-plan-review
Agente posta o plano completo como comentário na issue
(e commita .agent-plan.md e .agent-plan.json na branch agent/plan-{N})
```

### Fase 2 — Revisar e aprovar

```
Você lê o plano no comentário ou em agent/plan-{N}:.agent-plan.md
    ↓
Se quiser mudanças:
    Comenta o que alterar na issue
    Muda label de volta para: agent-plan
    → Agente revisa o plano (detecta que já existe e revisa)
    → Volta para agent-plan-review
    ↓
Se aprovado:
    Adiciona: agent-plan-approved
```

### Fase 3 — Execução automática

```
Sistema lê .agent-plan.json
    ↓
Sistema cria todas as issues filhas com agent-queued
Ativa as sem dependências com agent-ready
    ↓
Agente implementa etapa 1 → PR targeting agent/plan-{N}
    ↓
Você revisa e mergeia o PR da etapa 1 em agent/plan-{N}
    ↓ (sistema detecta o merge)
Sistema ativa a próxima etapa (agent-queued → agent-ready)
    ↓
... (repete por todas as etapas)
    ↓
Todas as etapas com agent-done
Sistema cria PR final: agent/plan-{N} → dev
Sistema fecha a issue pai com agent-done
```

**O que você faz:**
1. Cria a issue com a descrição da feature e adiciona `agent-plan`
2. Lê o plano gerado no comentário
3. Se necessário: comenta ajustes e recoloca `agent-plan`
4. Quando satisfeito: adiciona `agent-plan-approved`
5. Para cada etapa: revisa o PR, testa, e faz merge na branch `agent/plan-{N}` (não em `dev`)
6. No final: o sistema cria o PR final de `agent/plan-{N}` para `dev` — você faz o merge final

**Estrutura de branches:**
```
dev
 └── agent/plan-42          ← branch pai do plano
       ├── agent/issue-43   ← etapa 1 (PR targeting agent/plan-42)
       ├── agent/issue-44   ← etapa 2 (aguarda merge da 43)
       └── agent/issue-45   ← etapa 3 (aguarda merges de 43 e 44)
```

---

## Referência rápida

| Situação | O que fazer |
|---|---|
| Quero que o agente implemente uma issue | Adicionar `agent-ready` |
| O agente fez uma pergunta | Responder nos comentários + mudar para `waiting-for-agent` |
| Quero pedir ajustes na implementação | Comentar na issue + remover `agent-done` + adicionar `waiting-for-agent` |
| O agente criou o PR, quero que ele corrija reviews | Adicionar `agent-review` na issue |
| Quero planear uma feature complexa | Criar issue + adicionar `agent-plan` |
| Quero pedir mudanças no plano | Comentar na issue + recolocar `agent-plan` |
| Aprovei o plano, quero criar as tarefas | Adicionar `agent-plan-approved` |
