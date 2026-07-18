# AGENTS.md — GitHub Agent

Este documento descreve a arquitetura, convenções e fluxos deste projeto para que um agente de IA possa implementar novas funcionalidades com segurança.

## O que é este projeto

Um agente autônomo que monitora issues do GitHub e as implementa automaticamente usando o Claude Code CLI. Roda em Docker, expõe um dashboard Web e suporta múltiplos repositórios simultaneamente.

---

## Arquitetura

```
src/
├── index.ts                  # Entry point: inicializa tudo e inicia o scheduler
├── config/
│   ├── env.ts                # Todas as variáveis de ambiente e labels (constantes)
│   └── project-config.ts     # Tipo ProjectConfig, loadProjects(), saveProjects()
├── github/
│   ├── client.ts             # Toda interação com a API GitHub (Octokit)
│   └── model/                # Tipos: GitHubIssue, GitHubComment, PlanMetadata, etc.
├── agent/
│   ├── runner.ts             # Spawna o Claude Code CLI e interpreta o resultado
│   ├── prompt-builder.ts     # Monta os prompts para cada fase
│   ├── prompt-base.ts        # System prompts base (dev e plan)
│   ├── conversation.ts       # Formata histórico de comentários para o prompt
│   └── rate-limit*.ts        # Detecção e estado de rate limit da Anthropic
├── scheduler/
│   └── loop.ts               # Tick periódico: processa cada label em sequência
├── rag/
│   ├── retriever.ts          # Busca semântica no ChromaDB
│   └── indexer.ts            # Indexa o repositório no ChromaDB via Ollama
└── ui/
    ├── server.ts             # Express + WebSocket: REST API + dashboard
    ├── event-bus.ts          # EventEmitter interno para propagar eventos ao dashboard
    └── public/index.html     # Dashboard (HTML/CSS/JS vanilla, sem frameworks)
```

### Serviços externos (Docker Compose)

| Serviço    | Porta  | Função |
|------------|--------|--------|
| chromadb   | 8000   | Banco vetorial para RAG |
| ollama     | 11434  | Embeddings (`nomic-embed-text`) |
| agent      | 3000   | Este processo Node.js |

---

## Fluxo principal: ciclo de vida de uma issue

O scheduler (`loop.ts`) roda a cada `POLL_INTERVAL_MINUTES` minutos e processa os projetos em sequência. Para cada projeto, executa estas etapas na ordem:

```
1. processAgentPlanIssues   → issues com label agent-plan
2. processApprovedPlans     → issues com label agent-plan-approved
3. checkQueuedIssues        → issues com label agent-queued (verifica dependências)
4. checkPlanCompletion      → verifica se todas etapas do plano foram concluídas
5. processReadyIssues       → issues com label agent-ready  ← ponto de entrada principal
6. resumeWaitingForAgentIssues → issues com label waiting-for-agent
7. processCodeReviewIssues  → issues com label agent-code-review
8. processAgentReviewIssues → issues com label agent-review (PR review comments)
```

### Estado de uma issue (labels como máquina de estados)

```
[humano aplica]
agent-ready
    │
    ▼ scheduler processa
agent-processing
    │
    ├─► agent-code-review     (dev concluiu, aguarda revisor automático)
    │       │
    │       ├─► agent-done    (aprovado → PR pronto para revisão humana)
    │       └─► agent-ready   (rejeitado, até 2x) → waiting-for-human (3ª rejeição)
    │
    ├─► waiting-for-human     (agente fez pergunta ou atingiu limite de rejeições)
    │       │
    │       └─[humano responde e aplica waiting-for-agent]
    │               │
    │               └─► agent-processing → (ciclo acima)
    │
    └─► agent-ready           (erro recuperável: rate limit, timeout)
```

### Fluxo de planos multi-etapa (agent-plan)

```
agent-plan → agent-plan-review → agent-plan-approved
    │                                     │
    │                            cria issues filhas com
    │                            agent-queued (aguardam deps)
    │                            ou agent-ready (sem deps)
    └── branch: agent/plan-{n}
        arquivos: .agent-plan.json, .agent-plan.md, .agent-context.md
```

---

## Componentes chave

### `src/config/project-config.ts`

Define `ProjectConfig` — a unidade de configuração de um repositório:

```typescript
type ProjectConfig = {
  owner: string;        // dono do repo no GitHub
  repo: string;         // nome do repo
  localPath: string;    // caminho local dentro do container (ex: /workspace/meu-repo)
  baseBranch: string;   // branch base para PRs (ex: dev, main)
  githubToken?: string; // token específico do projeto (sobrescreve GITHUB_TOKEN do .env)
  models?: {            // modelos por fase (usa defaults se omitido)
    plan?: string;      // default: claude-opus-4-8
    dev?: string;       // default: claude-sonnet-4-6
    review?: string;    // default: claude-opus-4-8
  };
};
```

Projetos são carregados de `/app/projects.json` (gerenciado pela UI) com fallback para `PROJECTS` env var ou variáveis individuais `GITHUB_OWNER`/`GITHUB_REPO`/`REPO_LOCAL_PATH`.

### `src/agent/runner.ts`

Classe central `AgentRunner`. Métodos públicos:

| Método | Chamado quando |
|--------|----------------|
| `processIssue(issue)` | issue com `agent-ready` |
| `resumeIssue(issue, humanResponse)` | issue com `waiting-for-agent` |
| `reviewPRComments(issue, prNumber, comments)` | issue com `agent-review` |
| `createPlan(issue)` | issue com `agent-plan` |
| `codeReviewIssue(issue)` | issue com `agent-code-review` |

Todos retornam `AgentResult`:
```typescript
type AgentResult =
  | { type: 'success'; prUrl: string }
  | { type: 'needs-clarification'; question: string }
  | { type: 'rate-limit'; retryAfterMs?: number }
  | { type: 'plan-ready' }
  | { type: 'code-review-approved' }
  | { type: 'code-review-rejected'; problems: string };
```

Internamente, `runAgentSession()` spawna o Claude Code CLI com `--output-format stream-json` e itera sobre as mensagens. `parseAgentResult()` lê o output para detectar os sinalizadores (`AGENT_STATUS: SUCCESS`, `REVIEW_STATUS: APPROVED`, etc.).

### `src/github/client.ts`

Wrapper do Octokit. Métodos mais usados:

- `getIssuesWithLabel(label)` → lista issues
- `transitionLabel(num, from, to)` → troca a label de estado
- `postComment(num, body)` → posta comentário
- `createBranch(issueNum, baseBranch)` → cria ou reutiliza branch `agent/issue-{n}`
- `createPullRequest(...)` → abre PR
- `getBranchDiff(branch, base)` → retorna diff formatado para o reviewer
- `getComments(num)` → lista todos os comentários da issue
- `ensureLabelsExists()` → cria todas as labels necessárias no repo (chamado no boot)

### `src/ui/server.ts`

Express + WebSocket. Rotas REST:

```
GET    /api/projects          → lista projetos (do projects.json)
POST   /api/projects          → adiciona projeto
PUT    /api/projects/:owner/:repo → edita projeto
DELETE /api/projects/:owner/:repo → remove projeto
```

WebSocket: o servidor envia todos os `UIEvent` para clientes conectados. Novos clientes recebem replay dos últimos 500 eventos.

### `src/ui/event-bus.ts`

Singleton `eventBus` (EventEmitter). Qualquer módulo pode chamar `eventBus.publish(event)` para transmitir eventos ao dashboard. Tipos definidos em `UIEvent`.

---

## Como adicionar uma nova funcionalidade

### Novo tipo de label/fase de processamento

1. Adicione a constante em `src/config/env.ts` (objeto `env`)
2. Adicione ao array `labelsToCreate` em `GitHubClient.ensureLabelsExists()` com cor e descrição
3. Crie o método de processamento em `Scheduler` seguindo o padrão dos existentes (`processXxxIssues` → `xxxWithIsolation`)
4. Chame o novo método dentro de `tickForProject()` na ordem correta
5. Se precisar de novo prompt, adicione em `PromptBuilder` e `prompt-base.ts`

### Novo campo em ProjectConfig

1. Adicione o campo (opcional) em `ProjectConfig` em `src/config/project-config.ts`
2. Adicione o campo no formulário do modal em `src/ui/public/index.html` (funções `openAddModal`, `openEditModal`, `saveProject`)
3. Use o campo em `AgentRunner` ou `Scheduler` conforme necessário

### Novo evento no dashboard

1. Adicione o tipo ao union `UIEvent` em `src/ui/event-bus.ts`
2. Publique com `eventBus.publish({ type: 'meu_evento', ... })`
3. Trate o novo tipo no `switch(ev.type)` da função `buildRow()` em `index.html`

---

## Convenções de código

- **TypeScript ESM**: todos os imports usam extensão `.js` (mesmo apontando para `.ts`)
- **Sem framework de frontend**: o dashboard é HTML/CSS/JS vanilla — não use React/Vue
- **Logging**: use `logger` de `src/utils/logger.ts` (Winston). Em métodos de agente, use `createContextLogger({ issueNumber, phase })` para contexto automático
- **Erros recuperáveis**: rate limit e timeout retornam `{ type: 'rate-limit' }` sem lançar exceção — o scheduler devolve a issue para a fila
- **Labels como única fonte de estado**: nunca armazene estado de issue em memória. O estado vive nas labels do GitHub
- **`p-limit(1)`**: todas as listas de issues são processadas com concorrência 1 para evitar conflitos de git

## Build e desenvolvimento local

```bash
npm install
npm run dev          # tsx watch — hot reload
npm run build        # tsc + copia public/
npm run index:repo   # indexa o repo configurado no .env
```

Variáveis mínimas para rodar localmente (arquivo `.env`):
```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
CHROMA_URL=http://localhost:8000
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
POLL_INTERVAL_MINUTES=5
```

Projetos configurados em `projects.json` na raiz (ou via UI no dashboard).

## Deploy

```bash
docker build -t pereiratiagojoao/github-agent:latest .
docker push pereiratiagojoao/github-agent:latest
# no servidor:
docker compose pull agent && docker compose up -d --force-recreate agent
```

O compose de produção é `docker-compose.prod.yml`. O servidor usa `docker-compose.yml` (mesma estrutura, sem o profile indexer).

Volume crítico: `./projects.json:/app/projects.json` — sem este mount o agente não encontra os projetos e falha na inicialização.
