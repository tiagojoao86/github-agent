# Etapa 4 — Execução de plano sequencial entre issues

## Objetivo

Automatizar a execução de features multi-etapa do início ao fim.
O utilizador abre uma issue de plano, o agente cria todas as issues filhas com dependências,
executa-as em sequência à medida que o utilizador valida e mergeia cada PR.

---

## Fluxo completo

```
[issue #42: agent-plan]
         │
         ▼
  cria agent/plan-42 (branch base: dev)
  cria .agent-context.md vazio na branch
  agente analisa e cria issues filhas via gh issue create
         │
         ▼
  #43 deps:[]      → agent-ready  (começa imediatamente)
  #44 deps:[43]    → agent-queued (aguarda PR de #43 mergeado em agent/plan-42)
  #45 deps:[43,44] → agent-queued (aguarda PRs de #43 e #44 mergeados)
         │
  utilizador testa PR #43, mergeia em agent/plan-42
         │
         ▼
  scheduler detecta → #44 desbloqueada → agent-ready → agente implementa
  ...e assim por diante...
         │
  todas as filhas com agent-done + PRs mergeados
         │
         ▼
  PR final: agent/plan-42 → dev
  issue pai → agent-done
```

---

## Novos labels

| Label | Cor | Uso |
|---|---|---|
| `agent-plan` | `#0057e7` | Gatilho para criar o plano |
| `agent-plan-running` | `#e6ac00` | Issue pai enquanto o plano está em execução |
| `agent-queued` | `#cccccc` | Issue filha aguardando dependências |

---

## Metadata nas issues filhas

Cada issue filha terá no corpo um comentário HTML invisível para humanos:

```html
<!-- agent-plan-meta: {"planIssue":42,"planBranch":"agent/plan-42","dependsOn":[43,44],"step":2,"totalSteps":5} -->
```

---

## Estrutura do `.agent-context.md`

Um ficheiro por plano, vive na branch `agent/plan-{N}`, é atualizado por cada etapa concluída:

```markdown
# Plano #42 — FEAT: Melhorias no fluxo de caixa

## Visão geral
[Descrição do que o plano implementa]

## Progresso

### ✅ Etapa 1 — Backend: entidade e migration (issue #43)
- Adicionado campo `desconto` à entidade `MovimentacaoCaixa`
- Migration `V20260601000001` criada
- `RecebimentoCaixaServiceImpl` atualizado com lógica de desconto

### 🔄 Etapa 2 — Frontend: componente de recebimento (issue #44)
[em progresso]
```

---

## Sub-tarefas de implementação

---

### 4.1 Novos labels e env

**Ficheiro:** `src/config/env.ts`

```typescript
LABEL_PLAN:         'agent-plan',
LABEL_PLAN_RUNNING: 'agent-plan-running',
LABEL_QUEUED:       'agent-queued',
```

**Ficheiro:** `src/github/client.ts` — adicionar ao `ensureLabelsExists`:

```typescript
{ name: env.LABEL_PLAN,         color: '0057e7', description: 'Criar plano de execução' },
{ name: env.LABEL_PLAN_RUNNING, color: 'e6ac00', description: 'Plano em execução' },
{ name: env.LABEL_QUEUED,       color: 'cccccc', description: 'Aguardando dependências' },
```

### Como testar
- Subir o agent e verificar nos logs que os 3 novos labels foram criados no GitHub.

---

### 4.2 Métodos no GitHubClient

**Ficheiro:** `src/github/client.ts`

#### 4.2.1 `createIssue`
```typescript
async createIssue(title: string, body: string, labels: string[]): Promise<number>
// Retorna o número da issue criada
```

#### 4.2.2 `getChildIssues`
```typescript
async getChildIssues(planIssueNumber: number): Promise<GitHubIssue[]>
// Busca issues cujo corpo contém "planIssue":{planIssueNumber}
// Usa search API: q=repo:{owner}/{repo} "agent-plan-meta" {planIssueNumber} in:body
```

#### 4.2.3 `isPRMergedIntoBranch`
```typescript
async isPRMergedIntoBranch(issueNumber: number, planBranch: string): Promise<boolean>
// Encontra o PR da branch agent/issue-{N} que targeta planBranch
// Verifica se merged === true
```

#### 4.2.4 `parsePlanMetadata`
```typescript
function parsePlanMetadata(issueBody: string): PlanMetadata | null
// Extrai o JSON do comentário <!-- agent-plan-meta: {...} -->
// Exportar como função standalone (usada em vários lugares)

type PlanMetadata = {
  planIssue: number;
  planBranch: string;
  dependsOn: number[];
  step: number;
  totalSteps: number;
};
```

#### 4.2.5 `createBranch` — aceitar base opcional
```typescript
async createBranch(issueNumber: number, baseBranch = env.BASE_BRANCH): Promise<string>
```

#### 4.2.6 `createPullRequest` — aceitar base opcional
```typescript
async createPullRequest(
  issueNumber: number,
  branchName: string,
  title: string,
  body: string,
  base = env.BASE_BRANCH
): Promise<PullRequestResult>
```

### Como testar
```typescript
// Teste unitário para parsePlanMetadata:
const body = `Descrição\n<!-- agent-plan-meta: {"planIssue":42,"planBranch":"agent/plan-42","dependsOn":[43],"step":2,"totalSteps":3} -->`;
const meta = parsePlanMetadata(body);
// Esperado: { planIssue: 42, planBranch: "agent/plan-42", dependsOn: [43], step: 2, totalSteps: 3 }

// Testar com body sem metadata:
parsePlanMetadata("body sem metadata") // → null
```

---

### 4.3 Prompt de criação de plano

**Ficheiro:** `src/agent/prompt-base.ts` — adicionar novo system prompt para planos

```typescript
export function buildPlanSystemPrompt(planBranch: string, repoPath: string, owner: string, repo: string): string {
  return `Você é um agente de engenharia de software especializado em criar planos de execução.

## Tarefa

Analise a issue de plano e crie as issues filhas no GitHub com as suas dependências.

## Como criar as issues filhas

Use o GitHub CLI para criar cada issue:

\`\`\`bash
gh issue create \
  --repo ${owner}/${repo} \
  --title "Etapa N: título da etapa" \
  --label "agent-queued" \
  --body "$(cat <<'EOF'
Descrição detalhada do que esta etapa deve implementar.

Contexto técnico relevante: arquivos a criar/modificar, entidades envolvidas, etc.

<!-- agent-plan-meta: {"planIssue":PLAN_NUMBER,"planBranch":"${planBranch}","dependsOn":[N,M],"step":N,"totalSteps":T} -->
EOF
)"
\`\`\`

## Regras para dependências

- Liste APENAS dependências diretas (não transitivas)
- Uma etapa depende de outra quando precisa do código dela para funcionar
- Etapas independentes (ex: frontend e backend diferentes) podem ter dependsOn:[]
- Se A depende de B e B depende de C, a etapa A só lista B (não C)

## Ficheiro de contexto

Após criar todas as issues, crie o ficheiro de contexto na branch do plano:

\`\`\`bash
cd ${repoPath}
git checkout ${planBranch}
cat > .agent-context.md << 'EOF'
# Plano — [título do plano]

## Visão geral
[Resumo do que o plano implementa]

## Etapas
[Lista das etapas com títulos e dependências]

## Progresso
EOF
git add .agent-context.md
git commit -m "chore: inicializa plano de execução"
\`\`\`

## Como sinalizar conclusão

Ao terminar de criar todas as issues e o .agent-context.md:

AGENT_STATUS: PLAN_CREATED
AGENT_PLAN_ISSUES: 43,44,45
`;
}
```

**Ficheiro:** `src/agent/prompt-builder.ts` — novo método

```typescript
async buildForPlanCreation(
  issue: GitHubIssue,
  repoPath: string,
  planBranch: string
): Promise<AgentPrompt> {
  const systemPrompt = buildPlanSystemPrompt(planBranch, repoPath, env.GITHUB_OWNER, env.GITHUB_REPO);

  const userPrompt = `## Issue de Plano

**Issue #${issue.number}:** ${issue.title}
**Branch do plano:** ${planBranch}

**Descrição:**
${issue.body ?? '(Sem descrição)'}

## Instruções

1. Analise o que precisa ser implementado
2. Quebre em etapas coesas (cada etapa = uma mudança completa e testável)
3. Identifique as dependências entre etapas
4. Crie as issues filhas com \`gh issue create\`
5. Crie o \`.agent-context.md\` na branch ${planBranch}
6. Sinalize com AGENT_STATUS: PLAN_CREATED e AGENT_PLAN_ISSUES: <numeros>`;

  return { systemPrompt, userPrompt };
}
```

### Como testar
- Criar uma issue simples com `agent-plan` e verificar se o agente cria as issues filhas com o metadata correto.
- Verificar se o `.agent-context.md` foi criado na plan branch.
- Verificar se as issues filhas têm `agent-queued` label.

---

### 4.4 AgentRunner — método `createPlan`

**Ficheiro:** `src/agent/runner.ts`

```typescript
async createPlan(issue: GitHubIssue): Promise<AgentResult> {
  const log = createContextLogger({ issueNumber: issue.number, phase: 'plan-creation' });

  const planBranch = `agent/plan-${issue.number}`;

  // Cria a plan branch a partir de BASE_BRANCH
  await this.github.createBranch(issue.number, env.BASE_BRANCH);
  // Nota: reutilizamos createBranch mas a branch criada será agent/issue-N
  // Para planos, precisamos de uma branch com nome diferente — ver 4.2.5

  const git = simpleGit(env.REPO_LOCAL_PATH);
  await git.fetch('origin');
  await git.checkout(planBranch);

  const prompt = await this.promptBuilder.buildForPlanCreation(
    issue,
    env.REPO_LOCAL_PATH,
    planBranch
  );

  return this.runAgentSession(issue, planBranch, prompt.systemPrompt, prompt.userPrompt, false, false, true);
}
```

**Atualizar `runAgentSession`** para aceitar `isPlan = false` e detectar `AGENT_STATUS: PLAN_CREATED`.

**Atualizar `parseAgentResult`** — novo bloco antes dos existentes:

```typescript
if (agentOutput.includes('AGENT_STATUS: PLAN_CREATED')) {
  const issuesMatch = agentOutput.match(/AGENT_PLAN_ISSUES:\s*([\d,\s]+)/);
  const childIssueNumbers = (issuesMatch?.[1] ?? '')
    .split(',')
    .map(n => parseInt(n.trim()))
    .filter(n => !isNaN(n));

  log.info(`Plano criado. Issues filhas: ${childIssueNumbers.join(', ')}`);
  return { type: 'plan-created', childIssues: childIssueNumbers };
}
```

**Atualizar `AgentResult`:**

```typescript
export type AgentResult =
  | { type: 'success'; prUrl: string }
  | { type: 'needs-clarification'; question: string }
  | { type: 'rate-limit'; retryAfterMs?: number }
  | { type: 'plan-created'; childIssues: number[] };
```

**Atualizar `createBranch` para planos** — nome diferente de `agent/issue-{N}`:

```typescript
// Em client.ts, adicionar método dedicado para plan branch
async createPlanBranch(planIssueNumber: number): Promise<string> {
  const branchName = `agent/plan-${planIssueNumber}`;
  // mesma lógica de createBranch mas com nome customizado
  return branchName;
}
```

**Processar issues filhas com plan branch como base:**
Em `processIssue`, após criar a branch, verificar se a issue tem metadata de plano:

```typescript
const planMeta = parsePlanMetadata(issue.body ?? '');
const baseBranch = planMeta?.planBranch ?? env.BASE_BRANCH;
const branchName = await this.github.createBranch(issue.number, baseBranch);
```

E em `parseAgentResult` (sucesso normal), usar `planMeta?.planBranch ?? env.BASE_BRANCH` como base do PR.

**Após sucesso de issue filha**, atualizar `.agent-context.md`:
- Incluir no prompt da issue filha a instrução de atualizar o ficheiro com o que foi feito.

### Como testar
- Verificar log `Plano criado. Issues filhas: 43, 44, 45`
- Verificar que a plan branch foi criada no GitHub
- Verificar que as issues filhas existem com labels `agent-queued`

---

### 4.5 Scheduler — orquestração do plano

**Ficheiro:** `src/scheduler/loop.ts`

#### 4.5.1 Adicionar ao tick

```typescript
await this.processAgentPlanIssues();      // cria planos
await this.checkQueuedIssues();           // desbloqueia issues
await this.checkPlanCompletion();         // fecha planos concluídos
await this.processReadyIssues();
await this.resumeWaitingForAgentIssues();
await this.processAgentReviewIssues();
```

#### 4.5.2 `processAgentPlanIssues`

```typescript
private async processAgentPlanIssues(): Promise<void> {
  const issues = await this.github.getIssuesWithLabel(env.LABEL_PLAN);
  for (const issue of issues) {
    await this.createPlanWithIsolation(issue);
  }
}

private async createPlanWithIsolation(issue: GitHubIssue): Promise<void> {
  try {
    await this.github.transitionLabel(issue.number, env.LABEL_PLAN, env.LABEL_PROCESSING);
    const result = await this.agentRunner.createPlan(issue);

    if (result.type === 'plan-created') {
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_RUNNING);
      // Ativa issues sem dependências
      for (const childNumber of result.childIssues) {
        const child = await this.github.getIssue(childNumber);
        const meta = parsePlanMetadata(child.body ?? '');
        if (meta && meta.dependsOn.length === 0) {
          await this.github.transitionLabel(child.number, env.LABEL_QUEUED, env.LABEL_READY);
          logger.info(`Issue #${child.number} ativada (sem dependências)`);
        }
      }
    } else if (result.type === 'needs-clarification') {
      await this.github.postComment(issue.number, result.question);
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
    } else if (result.type === 'rate-limit') {
      this.rateLimitState.recordHit(result.retryAfterMs);
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN);
    }
  } catch (error) {
    logger.error(`Erro ao criar plano para issue #${issue.number}`, { error });
    await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN).catch(() => {});
  }
}
```

#### 4.5.3 `checkQueuedIssues`

```typescript
private async checkQueuedIssues(): Promise<void> {
  const queued = await this.github.getIssuesWithLabel(env.LABEL_QUEUED, 50);

  for (const issue of queued) {
    const meta = parsePlanMetadata(issue.body ?? '');
    if (!meta) continue;

    const allMet = await Promise.all(
      meta.dependsOn.map(depNum =>
        this.github.isPRMergedIntoBranch(depNum, meta.planBranch)
      )
    );

    if (allMet.every(Boolean)) {
      await this.github.transitionLabel(issue.number, env.LABEL_QUEUED, env.LABEL_READY);
      logger.info(`Issue #${issue.number} desbloqueada — todas as dependências mergeadas`);
    }
  }
}
```

#### 4.5.4 `checkPlanCompletion`

```typescript
private async checkPlanCompletion(): Promise<void> {
  const running = await this.github.getIssuesWithLabel(env.LABEL_PLAN_RUNNING, 20);

  for (const planIssue of running) {
    const children = await this.github.getChildIssues(planIssue.number);
    if (children.length === 0) continue;

    const allDone = children.every(c => c.labels.includes(env.LABEL_DONE));
    const anyBlocked = children.some(c =>
      c.labels.includes(env.LABEL_WAITING) || c.labels.includes(env.LABEL_QUEUED)
    );

    if (allDone) {
      const meta = parsePlanMetadata(children[0].body ?? '');
      const planBranch = meta?.planBranch ?? `agent/plan-${planIssue.number}`;

      // Cria PR final: plan branch → dev
      const pr = await this.github.createPullRequest(
        planIssue.number,
        planBranch,
        `feat: ${planIssue.title} (resolve #${planIssue.number})`,
        this.buildPlanPrBody(planIssue, children),
        env.BASE_BRANCH
      );

      await this.github.transitionLabel(planIssue.number, env.LABEL_PLAN_RUNNING, env.LABEL_DONE);
      logger.info(`Plano #${planIssue.number} concluído. PR final: ${pr.url}`);

      await this.github.postComment(planIssue.number,
        `✅ **Plano concluído!** Todas as ${children.length} etapas foram implementadas.\n\n` +
        `**PR final:** ${pr.url}`
      );
    } else if (!anyBlocked) {
      // Progresso: postar update se há novas etapas concluídas
      const done = children.filter(c => c.labels.includes(env.LABEL_DONE)).length;
      logger.debug(`Plano #${planIssue.number}: ${done}/${children.length} etapas concluídas`);
    }
  }
}
```

### Como testar
- Verificar que `checkQueuedIssues` só ativa uma issue quando todos os PRs dependentes estão merged
- Verificar que `checkPlanCompletion` cria o PR final quando todas as filhas têm `agent-done`
- Testar com issue filha em `waiting-for-human` — o plano não deve fechar prematuramente

---

### 4.6 Contexto das issues filhas

O prompt de cada issue filha (`buildForNewIssue` e `buildForResumedIssue`) deve incluir o `.agent-context.md` quando a issue tem metadata de plano.

**Ficheiro:** `src/agent/prompt-builder.ts`

```typescript
// Em buildForNewIssue e buildForResumedIssue, após getProjectContext:
const planContext = planMeta
  ? await this.getPlanContext(repoPath, planMeta.planBranch)
  : null;
```

```typescript
private async getPlanContext(repoPath: string, planBranch: string): Promise<string | null> {
  try {
    // Faz checkout temporário para ler o ficheiro (ou usa git show)
    const { execSync } = await import('child_process');
    const content = execSync(
      `git -C ${repoPath} show origin/${planBranch}:.agent-context.md`,
      { encoding: 'utf-8' }
    );
    return `=== Contexto do Plano (.agent-context.md) ===\n${content}`;
  } catch {
    return null; // ficheiro ainda não existe
  }
}
```

O userPrompt das issues filhas inclui:
1. Contexto do projeto (CLAUDE.md/README.md)
2. Contexto do plano (`.agent-context.md`)
3. RAG chunks relevantes
4. Comentários da issue (histórico de conversa)

E instrui o agente a atualizar o `.agent-context.md` ao finalizar:

```
Ao concluir com sucesso, antes de AGENT_SUMMARY_START, atualize o .agent-context.md
na branch ${planBranch} para registar o que foi implementado nesta etapa.
```

### Como testar
- Verificar que a issue filha da etapa 2 recebe o contexto do `.agent-context.md` atualizado pela etapa 1
- Verificar que o `.agent-context.md` vai sendo atualizado a cada etapa concluída

---

## Ordem de implementação

1. **4.1** — Labels e env (5 min)
2. **4.2** — Métodos no GitHubClient (parsePlanMetadata, createIssue, getChildIssues, isPRMergedIntoBranch, createPlanBranch, base opcional em createBranch/createPullRequest)
3. **4.3** — Prompt de criação de plano
4. **4.4** — AgentRunner.createPlan + AgentResult.plan-created + processIssue com plan branch
5. **4.5** — Scheduler: processAgentPlanIssues, checkQueuedIssues, checkPlanCompletion
6. **4.6** — Contexto do plano no prompt das issues filhas

## Arquivos afetados

| Ficheiro | Mudança |
|---|---|
| `src/config/env.ts` | 3 novos labels |
| `src/github/client.ts` | createIssue, getChildIssues, isPRMergedIntoBranch, createPlanBranch, base opcional, ensureLabels |
| `src/github/model/plan-metadata.ts` | Novo tipo + parsePlanMetadata |
| `src/agent/prompt-base.ts` | buildPlanSystemPrompt |
| `src/agent/prompt-builder.ts` | buildForPlanCreation, getPlanContext, contexto do plano nos prompts existentes |
| `src/agent/runner.ts` | createPlan, AgentResult union, parseAgentResult, processIssue com plan branch |
| `src/scheduler/loop.ts` | processAgentPlanIssues, checkQueuedIssues, checkPlanCompletion, buildPlanPrBody |
