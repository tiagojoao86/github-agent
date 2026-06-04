# Etapa 1 — Comunicação mais rica + estabilização dos logs

## Objetivo

Melhorar o feedback dado ao utilizador nas issues e garantir observabilidade real do sistema.
Nenhuma mudança na arquitetura central — apenas melhorias de comunicação e estabilidade.

---

## 1.1 Corrigir gravação do log em disco

**Problema:** o diretório `./logs` é criado pelo Docker como `root:root` no host antes do bind mount.
O processo Node.js roda como `node` (uid 1000) e não consegue escrever no ficheiro.
Resultado: `/opt/apps/github-agent/logs/` vazio em produção.

**Diagnóstico:**
```bash
# No servidor, verificar dono do diretório
ls -la /opt/apps/github-agent/logs/
# Esperado: root:root → bug confirmado
```

**Fix 1 — Host (imediato, sem rebuild):**
```bash
sudo chown -R 1000:1000 /opt/apps/github-agent/logs
```

**Fix 2 — Dockerfile (permanente, evita regressão em próximo deploy):**
Adicionar script de entrypoint que garante permissão antes de iniciar:

```dockerfile
# Substituir o CMD final por um entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

```bash
# entrypoint.sh
#!/bin/sh
mkdir -p /app/logs
# Tenta corrigir permissão se possível (ignorar se não tiver acesso)
chown node:node /app/logs 2>/dev/null || true
exec node dist/index.js
```

**Nota:** o `entrypoint.sh` roda como `root` antes do `USER node`, o que permite o `chown`.
Para isso, remover o `USER node` do Dockerfile e delegar ao entrypoint:
```dockerfile
# Remover: USER node
# O entrypoint fará: exec su-exec node node dist/index.js  ← ou usar gosu
```

Alternativa mais simples: usar `user: "1000:1000"` no `docker-compose.prod.yml` e garantir
que o diretório no host tenha a permissão correta no primeiro deploy.

### Como testar

```bash
# 1. No servidor, confirmar que o ficheiro existe após restart
ls -lh /opt/apps/github-agent/logs/agent.log
# Esperado: ficheiro com tamanho > 0

# 2. Ver as últimas linhas em tempo real
tail -f /opt/apps/github-agent/logs/agent.log

# 3. Confirmar que o log persiste após restart do container
docker restart github-agent && sleep 5
ls -lh /opt/apps/github-agent/logs/agent.log
# Esperado: ficheiro ainda existe e tem conteúdo (não foi apagado)

# 4. Confirmar que os logs antigos rodam (após atingir 10MB, cria agent.log.1)
ls -lh /opt/apps/github-agent/logs/
```

---

## 1.2 Registar tokens de cache no log

**Problema:** o log de "Sessão concluída" só grava `input + output`, omitindo `cacheRead` e
`cacheCreate`, que são os maiores componentes de custo.

**Ficheiro:** `src/agent/runner.ts`

**Mudança:** atualizar a linha de log final da sessão:

```typescript
// Antes:
log.info(`Sessão concluída. Tokens: ${running.input} input + ${running.output} output`);

// Depois:
log.info('Sessão concluída', {
  tokens: {
    input:       running.input,
    output:      running.output,
    cacheRead:   running.cacheRead,
    cacheCreate: running.cacheCreate,
    total:       running.input + running.output,
  },
  // Estimativa de custo com Sonnet (valores aproximados em USD)
  estimatedCostUSD: (
    (running.input       * 3.00  / 1_000_000) +
    (running.output      * 15.00 / 1_000_000) +
    (running.cacheRead   * 0.30  / 1_000_000) +
    (running.cacheCreate * 3.75  / 1_000_000)
  ).toFixed(4),
});
```

### Como testar

```bash
# 1. Processar qualquer issue e depois filtrar o log pelo campo tokens
docker logs github-agent 2>&1 | grep 'Sessão concluída' | python3 -m json.tool

# Esperado: entrada JSON com a estrutura:
# {
#   "message": "Sessão concluída",
#   "tokens": { "input": 143, "output": 348, "cacheRead": 40000, "cacheCreate": 12000, "total": 491 },
#   "estimatedCostUSD": "0.0142",
#   ...
# }

# 2. Verificar que cacheRead e cacheCreate são > 0 em sessões que leram ficheiros
# (sessões muito curtas podem ter 0 se não houve cache hit)
```

**Validação manual:** somar `estimatedCostUSD` de todas as sessões de uma issue
e comparar com a estimativa feita manualmente no dashboard — devem ser próximos.

---

## 1.3 AGENT_SUMMARY no output do agente

**Objetivo:** extrair um resumo legível do que foi implementado para exibir na issue.

### 1.3.1 Adicionar instrução ao prompt base

**Ficheiro:** `src/agent/prompt-base.ts` (ou equivalente com as instruções do agente)

Adicionar à secção de sinalizadores de status:

```
Ao concluir com sucesso, antes de AGENT_STATUS: SUCCESS, inclua obrigatoriamente:

AGENT_SUMMARY_START
<Resumo em português de 3-5 linhas do que foi implementado, mencionando os principais
ficheiros alterados e as decisões técnicas relevantes>
AGENT_SUMMARY_END

AGENT_STATUS: SUCCESS
```

### 1.3.2 Extrair o summary no runner

**Ficheiro:** `src/agent/runner.ts` — método `parseAgentResult`

```typescript
private extractSummary(agentOutput: string): string | null {
  const match = agentOutput.match(/AGENT_SUMMARY_START\s*([\s\S]*?)\s*AGENT_SUMMARY_END/);
  return match?.[1]?.trim() ?? null;
}
```

Usar no bloco de sucesso:
```typescript
const summary = this.extractSummary(agentOutput);
```

### Como testar

**Teste unitário da regex** (pode rodar localmente sem subir o agente):
```typescript
// Colar no terminal tsx ou num ficheiro de teste
const output = `
  Implementei as mudanças necessárias.
  AGENT_SUMMARY_START
  Adicionei o campo desconto à entidade MovimentacaoCaixa e atualizei
  o RecebimentoCaixaServiceImpl para aplicá-lo corretamente no cálculo.
  AGENT_SUMMARY_END
  AGENT_STATUS: SUCCESS
`;
const match = output.match(/AGENT_SUMMARY_START\s*([\s\S]*?)\s*AGENT_SUMMARY_END/);
console.log(match?.[1]?.trim());
// Esperado: texto do resumo sem as tags
```

**Teste de integração** — criar uma issue de teste simples (ex: "Adicionar comentário no ficheiro X")
e verificar nos logs do dashboard se o agente incluiu o bloco `AGENT_SUMMARY_START...END` no output:

```
# No dashboard, ao ver o evento agent_text da sessão, procurar pelo bloco
# Se o agente não incluir, ajustar a instrução no prompt até incluir consistentemente
```

**Casos a validar:**
- [ ] Agente inclui o bloco quando conclui com sucesso
- [ ] `extractSummary` retorna `null` quando o bloco não existe (não quebra o fluxo)
- [ ] Summary com múltiplas linhas é preservado corretamente

---

## 1.4 Comentário de conclusão na issue

**Objetivo:** ao criar o PR com sucesso, postar um comentário na issue informando o utilizador.

### 1.4.1 Novo método no GitHubClient

**Ficheiro:** `src/github/client.ts`

```typescript
async postSuccessComment(
  issueNumber: number,
  summary: string | null,
  prUrl: string,
  filesChanged: string[]
): Promise<void> {
  const fileList = filesChanged.length > 0
    ? `\n\n**Ficheiros alterados (${filesChanged.length}):**\n` +
      filesChanged.map(f => `- \`${f}\``).join('\n')
    : '';

  const summarySection = summary
    ? `\n\n${summary}`
    : '';

  const body =
    `✅ **Implementação concluída**${summarySection}${fileList}\n\n` +
    `**PR criado:** ${prUrl}`;

  await this.octokit.issues.createComment({
    owner: this.owner,
    repo: this.repo,
    issue_number: issueNumber,
    body,
  });
}
```

### 1.4.2 Obter lista de ficheiros alterados

**Ficheiro:** `src/agent/runner.ts` — bloco de sucesso em `parseAgentResult`

```typescript
const git = simpleGit(env.REPO_LOCAL_PATH);

// Ficheiros alterados entre base e branch
const diffResult = await git
  .diff([`origin/${env.BASE_BRANCH}...HEAD`, '--name-only'])
  .catch(() => '');

const filesChanged = diffResult
  .split('\n')
  .map(f => f.trim())
  .filter(Boolean);
```

### 1.4.3 Chamar o comentário após criação do PR

**Ficheiro:** `src/agent/runner.ts` — após `return { type: 'success', prUrl }` ainda não retornou

```typescript
const summary = this.extractSummary(agentOutput);

// ... (push + findPRForBranch + createPullRequest)

await this.github.postSuccessComment(issue.number, summary, prUrl, filesChanged)
  .catch(err => log.warn('Falha ao postar comentário de conclusão', { err }));

return { type: 'success', prUrl };
```

### Como testar

**Cenário principal:** processar uma issue que resulte em sucesso e verificar na issue do GitHub:

- [ ] Comentário `✅ Implementação concluída` aparece na issue após o agente terminar
- [ ] O comentário contém o resumo (se o agente gerou `AGENT_SUMMARY_START...END`)
- [ ] A lista de ficheiros alterados está correta (bater com o diff do PR)
- [ ] O link do PR no comentário está correto e clicável

**Cenário sem summary** (agente não incluiu o bloco):
- [ ] Comentário aparece na issue mesmo assim, sem a secção de resumo
- [ ] Nenhuma exceção nos logs

**Cenário com 0 ficheiros alterados** (sessão que só leu mas não commitou — edge case):
- [ ] Comentário aparece sem a secção de ficheiros
- [ ] Não mostra "Ficheiros alterados (0):"

**Verificar via API** se necessário:
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/issues/NUMERO/comments" \
  | python3 -c "import json,sys; [print(c['body'][:200]) for c in json.load(sys.stdin)]"
```

---

## 1.5 PR body melhorado

**Objetivo:** o PR body deve incluir a lista de ficheiros e o summary automaticamente.

**Ficheiro:** `src/agent/runner.ts` — método `buildPrBody`

```typescript
private buildPrBody(issue: GitHubIssue, agentOutput: string, filesChanged: string[]): string {
  const summary = this.extractSummary(agentOutput);

  const summarySection = summary
    ? `## O que foi feito\n\n${summary}\n`
    : `## O que foi feito\n\nO agente analisou a issue e implementou as modificações necessárias.\n`;

  const fileSection = filesChanged.length > 0
    ? `## Ficheiros alterados\n\n` +
      filesChanged.map(f => `- \`${f}\``).join('\n') + '\n'
    : '';

  return `## Resolução Automática

Este PR foi criado automaticamente pelo agente de issues.

**Issue resolvida:** #${issue.number} — ${issue.title}

${summarySection}
${fileSection}
## Checklist

- [ ] Revisei as mudanças no diff
- [ ] Os testes passam
- [ ] A implementação resolve o problema descrito na issue

## Solicitar alterações

Se a implementação não estiver correcta:
1. Comente na **issue #${issue.number}** explicando o que está errado
2. Remova o label \`agent-done\` da issue
3. Adicione o label \`waiting-for-agent\`

---
*Gerado automaticamente pelo GitHub Agent*`;
}
```

**Nota:** passar `filesChanged` como argumento ao chamar `buildPrBody` onde já foi calculado.

### Como testar

Abrir o PR criado pelo agente no GitHub e verificar:

- [ ] Secção "O que foi feito" contém o summary do agente (não o texto genérico)
- [ ] Secção "Ficheiros alterados" lista todos os ficheiros do diff — bater com o número
  mostrado pelo GitHub no PR ("X files changed")
- [ ] Sem summary gerado: fallback para o texto genérico, sem quebrar a formatação
- [ ] PR com muitos ficheiros (>20): lista completa aparece, sem truncamento
- [ ] Checklist e secção "Solicitar alterações" continuam presentes e formatados

**Regressão a garantir:** PRs de sessões de retoma (`isResume=true`) também usam o body
melhorado — verificar que `buildPrBody` recebe `filesChanged` nos dois caminhos de código
(sucesso inicial e sucesso após resume).

---

## Ordem de implementação sugerida

1. Fix de permissões do log (1.1) — deploy imediato, sem código
2. Tokens de cache no log (1.2) — 5 minutos de código
3. `extractSummary` + instrução no prompt (1.3) — isolado, fácil de testar
4. Comentário na issue ao concluir (1.4) — novo método no client + chamada no runner
5. PR body melhorado (1.5) — usa o que já foi feito em 1.3 e 1.4

## Ficheiros afetados

| Ficheiro | Mudança |
|---|---|
| `Dockerfile` + `entrypoint.sh` | Fix de permissões do log |
| `src/agent/runner.ts` | Tokens no log, extractSummary, filesChanged, buildPrBody, postSuccessComment call |
| `src/agent/prompt-base.ts` | Instrução AGENT_SUMMARY_START/END |
| `src/github/client.ts` | Método postSuccessComment |
