# Plano Técnico: Agente Autônomo de Resolução de Issues no GitHub

> **Como usar este documento**
>
> Este plano foi feito para ser executado passo a passo, aprendendo durante o processo.
> Abra uma nova sessão do Claude Code dentro da pasta do projeto (`github-agent/`) e use-o
> para tirar dúvidas, pedir explicações mais detalhadas, ou pedir que implemente algum trecho
> específico quando travar. Sugestão de prompt inicial para a nova sessão:
>
> _"Estou seguindo o arquivo PLANO.md para construir um agente de GitHub issues.
> Acabei de terminar a Etapa N e quero começar a Etapa N+1. Pode me ajudar?"_
>
> **Stack:** TypeScript · Claude Code SDK · Octokit · ChromaDB · Docker
>
> **Pré-requisitos antes de começar:**
> - Node.js 20+
> - Docker e Docker Compose
> - `gh` CLI autenticado (`gh auth login`)
> - Conta Anthropic com API key
> - Um repositório GitHub alvo para testar

---

## Visão Geral da Arquitetura

Antes de começar, é importante entender o fluxo completo do sistema que vamos construir:

```
┌─────────────────────────────────────────────────────────────────┐
│                         Docker Container                         │
│                                                                  │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────────────┐   │
│  │ Scheduler │───▶│ GitHub      │    │ ChromaDB (RAG)       │   │
│  │ (N min)  │    │ Client      │    │ - Embeddings do repo  │   │
│  └──────────┘    └──────┬──────┘    └──────────────────────┘   │
│                         │                       ▲               │
│                         ▼                       │               │
│                  ┌──────────────┐    ┌──────────┴───────────┐   │
│                  │ Issue Queue  │───▶│ Prompt Builder        │   │
│                  └──────────────┘    └──────────┬───────────┘   │
│                                                 │               │
│                                                 ▼               │
│                                      ┌──────────────────────┐   │
│                                      │ Agent Runner          │   │
│                                      │ (Claude Code SDK)     │   │
│                                      └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

```
Scheduler tick
    └── busca issues com label 'agent-ready' (até MAX_ISSUES_PER_RUN)
         └── para cada issue:
              ├── adiciona label 'agent-processing'
              ├── constrói contexto via RAG
              ├── roda agente (Claude Code SDK)
              │    ├── sucesso → cria PR → adiciona label 'agent-done'
              │    ├── dúvida → posta comentário → label 'waiting-for-human'
              │    └── rate limit → cancela → remove label → tenta na próxima
              └── busca issues com label 'waiting-for-human' que têm resposta humana
                   └── retoma com contexto da conversa anterior
```

---

## Etapa 1 — Setup do Projeto

### Conceito

Todo projeto TypeScript sério começa com uma estrutura de pastas que reflete sua arquitetura. Aqui, vamos separar responsabilidades em módulos: o cliente do GitHub, o motor de RAG, o runner do agente, e a camada de agendamento. Isso não é burocracia — é o que permite testar cada parte isoladamente e trocar implementações sem quebrar o resto.

O `tsconfig.json` com `moduleResolution: "bundler"` e `target: "ES2022"` é importante porque o SDK da Anthropic usa top-level await e imports ESM. Usar `tsx` como runner de desenvolvimento elimina o ciclo compile→run, acelerando iteração.

### Comandos

```bash
mkdir github-agent && cd github-agent

npm init -y

npm install \
  @anthropic-ai/claude-code \
  @octokit/rest \
  chromadb \
  @anthropic-ai/sdk \
  dotenv \
  winston \
  p-limit \
  simple-git

npm install -D \
  typescript \
  tsx \
  @types/node \
  @types/jest \
  jest \
  ts-jest

mkdir -p src/{github,rag,agent,scheduler,config,utils}
mkdir -p logs
touch src/index.ts
```

### Código

**`tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**`package.json`** — adicione os scripts:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "test": "jest",
    "index:repo": "tsx src/rag/indexer.ts"
  }
}
```

**Estrutura final esperada:**
```
github-agent/
├── src/
│   ├── config/
│   │   └── env.ts           # Validação de variáveis de ambiente
│   ├── github/
│   │   └── client.ts        # Toda comunicação com GitHub API
│   ├── rag/
│   │   ├── indexer.ts       # Indexa o repositório no ChromaDB
│   │   └── retriever.ts     # Busca contexto relevante
│   ├── agent/
│   │   ├── runner.ts        # Roda Claude Code SDK
│   │   ├── prompt-builder.ts # Monta o prompt com contexto RAG
│   │   └── rate-limit.ts   # Detecta e trata rate limits
│   ├── scheduler/
│   │   └── loop.ts          # Loop principal com controle de concorrência
│   ├── utils/
│   │   └── logger.ts        # Logger estruturado
│   └── index.ts             # Entry point
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── tsconfig.json
```

### O que testar

```bash
# Deve compilar sem erros
npx tsc --noEmit

# Deve mostrar a estrutura criada
find src -type f | sort
```

---

## Etapa 2 — Variáveis de Ambiente e Configuração

### Conceito

Variáveis de ambiente são o contrato entre o agente e o mundo externo. Em vez de espalhá-las pelo código, centralizamos em um módulo `env.ts` que valida tudo na inicialização. Se uma variável obrigatória estiver faltando, o processo falha imediatamente com uma mensagem clara — não 20 minutos depois quando o agente tenta usar a variável.

Esse padrão se chama *fail-fast*: é muito melhor descobrir um problema de configuração no boot do que durante o processamento de uma issue importante.

### Código

**`src/config/env.ts`**
```typescript
import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[Config] Variável de ambiente obrigatória não definida: ${name}\n` +
      `Copie .env.example para .env e preencha os valores.`
    );
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  // Anthropic
  ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),

  // GitHub
  GITHUB_TOKEN: requireEnv('GITHUB_TOKEN'),
  GITHUB_OWNER: requireEnv('GITHUB_OWNER'),
  GITHUB_REPO: requireEnv('GITHUB_REPO'),

  // Scheduler
  POLL_INTERVAL_MINUTES: parseInt(optionalEnv('POLL_INTERVAL_MINUTES', '5'), 10),
  MAX_ISSUES_PER_RUN: parseInt(optionalEnv('MAX_ISSUES_PER_RUN', '3'), 10),

  // Agent
  MAX_TOKENS_PER_SESSION: parseInt(optionalEnv('MAX_TOKENS_PER_SESSION', '50000'), 10),
  AGENT_TIMEOUT_MS: parseInt(optionalEnv('AGENT_TIMEOUT_MS', '300000'), 10), // 5 minutos

  // RAG
  CHROMA_URL: optionalEnv('CHROMA_URL', 'http://localhost:8000'),
  REPO_LOCAL_PATH: requireEnv('REPO_LOCAL_PATH'),
  EMBEDDING_MODEL: optionalEnv('EMBEDDING_MODEL', 'voyage-code-3'),

  // Labels de controle (não mude sem atualizar o GitHub também)
  LABEL_READY: 'agent-ready',
  LABEL_PROCESSING: 'agent-processing',
  LABEL_WAITING: 'waiting-for-human',
  LABEL_DONE: 'agent-done',
} as const;

// Valida intervalos mínimos para evitar abuse da API
if (env.POLL_INTERVAL_MINUTES < 1) {
  throw new Error('[Config] POLL_INTERVAL_MINUTES deve ser >= 1');
}
if (env.MAX_ISSUES_PER_RUN < 1 || env.MAX_ISSUES_PER_RUN > 10) {
  throw new Error('[Config] MAX_ISSUES_PER_RUN deve estar entre 1 e 10');
}
```

**`.env.example`**
```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# GitHub — crie um Personal Access Token com: repo, issues, pull_requests
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=seu-usuario-ou-org
GITHUB_REPO=nome-do-repositorio

# Caminho local do repositório clonado (montado como volume no Docker)
REPO_LOCAL_PATH=/workspace/repo

# Scheduler
POLL_INTERVAL_MINUTES=5
MAX_ISSUES_PER_RUN=3

# Agent limits
MAX_TOKENS_PER_SESSION=50000
AGENT_TIMEOUT_MS=300000

# ChromaDB (sobe junto no docker-compose)
CHROMA_URL=http://chromadb:8000

# Modelo de embedding (Anthropic Voyage)
EMBEDDING_MODEL=voyage-code-3
```

**`src/utils/logger.ts`**
```typescript
import winston from 'winston';

// Logger estruturado: em produção emite JSON, em dev emite colorido e legível.
// Isso é essencial para observabilidade — cada log tem timestamp, level e contexto.
const isProd = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: isProd
    ? winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      )
    : winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? '\n  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')
            : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/agent.log',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// Helper para criar loggers com contexto fixo (ex: issue #42)
export function createContextLogger(context: Record<string, unknown>) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) =>
      logger.info(msg, { ...context, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      logger.warn(msg, { ...context, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) =>
      logger.error(msg, { ...context, ...meta }),
    debug: (msg: string, meta?: Record<string, unknown>) =>
      logger.debug(msg, { ...context, ...meta }),
  };
}
```

### O que testar

```bash
# Teste sem o .env criado — deve falhar com mensagem clara
tsx src/config/env.ts

# Crie o .env a partir do exemplo e preencha valores reais
cp .env.example .env
# edite o .env com seus valores reais

# Agora deve importar sem erros
node -e "import('./src/config/env.ts')" 2>&1 || tsx -e "import { env } from './src/config/env.ts'; console.log('Config OK:', env.GITHUB_REPO)"
```

---

## Etapa 3 — GitHub Client

### Conceito

O GitHub Client é a única camada que fala com a API do GitHub. Todas as outras partes do sistema usam esse cliente — nunca fazem chamadas HTTP diretas. Isso é o padrão *Anti-corruption Layer*: se o GitHub mudar sua API, você muda em um lugar só.

Usamos `@octokit/rest`, que é o cliente oficial do GitHub. Ele cuida de autenticação, paginação e retries automaticamente.

Pontos importantes desta etapa:
- **Idempotência nos labels**: adicionar um label que já existe não deve lançar erro
- **Branch naming**: a branch criada para cada issue precisa de um nome previsível e único — usamos `agent/issue-{número}` por convenção
- **Detecção de resposta humana**: para retomar issues com `waiting-for-human`, precisamos identificar comentários novos feitos por humanos (não pelo próprio bot)

### Código

**`src/github/client.ts`**
```typescript
import { Octokit } from '@octokit/rest';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  htmlUrl: string;
  createdAt: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  isBot: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  // Login do bot — preenchido no init() para não fazer chamada no construtor
  private botLogin: string = '';

  constructor() {
    this.octokit = new Octokit({ auth: env.GITHUB_TOKEN });
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
  }

  // Chame isso uma vez no startup para descobrir o login do token
  async init(): Promise<void> {
    const { data } = await this.octokit.users.getAuthenticated();
    this.botLogin = data.login;
    logger.info(`GitHub Client iniciado. Bot login: ${this.botLogin}`);
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  async getIssuesWithLabel(label: string): Promise<GitHubIssue[]> {
    logger.debug(`Buscando issues com label: ${label}`);
    const response = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: env.MAX_ISSUES_PER_RUN,
      sort: 'created',
      direction: 'asc', // issues mais antigas primeiro
    });

    return response.data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
    }));
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const { data } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      labels: data.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
      htmlUrl: data.html_url,
      createdAt: data.created_at,
    };
  }

  // ─── Labels ───────────────────────────────────────────────────────────────

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
      logger.debug(`Label '${label}' adicionado à issue #${issueNumber}`);
    } catch (error: unknown) {
      // Label já existe — não é erro
      if (isOctokitError(error) && error.status === 422) {
        logger.debug(`Label '${label}' já existe na issue #${issueNumber}`);
        return;
      }
      throw error;
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
      logger.debug(`Label '${label}' removido da issue #${issueNumber}`);
    } catch (error: unknown) {
      // Label não existe — não é erro
      if (isOctokitError(error) && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async transitionLabel(
    issueNumber: number,
    fromLabel: string,
    toLabel: string
  ): Promise<void> {
    // Ordem importa: adiciona primeiro para nunca ter a issue sem label de estado
    await this.addLabel(issueNumber, toLabel);
    await this.removeLabel(issueNumber, fromLabel);
  }

  // Garante que os labels de controle existem no repositório
  async ensureLabelsExist(): Promise<void> {
    const labelsToCreate = [
      { name: env.LABEL_READY, color: '0075ca', description: 'Pronto para o agente processar' },
      { name: env.LABEL_PROCESSING, color: 'e4e669', description: 'Sendo processado pelo agente' },
      { name: env.LABEL_WAITING, color: 'd93f0b', description: 'Aguardando resposta humana' },
      { name: env.LABEL_DONE, color: '0e8a16', description: 'PR criado pelo agente' },
    ];

    for (const labelDef of labelsToCreate) {
      try {
        await this.octokit.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          ...labelDef,
        });
        logger.info(`Label criado: ${labelDef.name}`);
      } catch (error: unknown) {
        if (isOctokitError(error) && error.status === 422) {
          // Label já existe — ok
          continue;
        }
        throw error;
      }
    }
  }

  // ─── Comentários ──────────────────────────────────────────────────────────

  async postComment(issueNumber: number, body: string): Promise<number> {
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
    logger.info(`Comentário postado na issue #${issueNumber}`);
    return data.id;
  }

  async getComments(issueNumber: number): Promise<GitHubComment[]> {
    const { data } = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    return data.map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      author: comment.user?.login ?? 'unknown',
      createdAt: comment.created_at,
      // Um comentário é "do bot" se foi escrito pelo mesmo login do token
      isBot: comment.user?.login === this.botLogin,
    }));
  }

  // Retorna os comentários humanos feitos APÓS o último comentário do bot.
  // Isso indica que o humano respondeu à pergunta do agente.
  async getHumanRepliesAfterBot(issueNumber: number): Promise<GitHubComment[]> {
    const comments = await this.getComments(issueNumber);

    // Encontra o índice do último comentário do bot
    let lastBotIndex = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].isBot) {
        lastBotIndex = i;
        break;
      }
    }

    if (lastBotIndex === -1) return []; // Bot nunca comentou

    // Retorna comentários humanos após o bot
    return comments
      .slice(lastBotIndex + 1)
      .filter((c) => !c.isBot);
  }

  // ─── Branches e PRs ───────────────────────────────────────────────────────

  getBranchName(issueNumber: number): string {
    return `agent/issue-${issueNumber}`;
  }

  async createBranch(issueNumber: number): Promise<string> {
    const branchName = this.getBranchName(issueNumber);

    // Obtém o SHA do HEAD da branch default (main/master)
    const { data: repo } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    const defaultBranch = repo.default_branch;

    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${defaultBranch}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
      logger.info(`Branch criada: ${branchName} a partir de ${defaultBranch}`);
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 422) {
        logger.warn(`Branch ${branchName} já existe — reutilizando`);
      } else {
        throw error;
      }
    }

    return branchName;
  }

  async createPullRequest(
    issueNumber: number,
    branchName: string,
    title: string,
    body: string
  ): Promise<PullRequestResult> {
    const { data: repo } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });

    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: branchName,
      base: repo.default_branch,
    });

    logger.info(`PR #${pr.number} criado: ${pr.html_url}`);
    return { number: pr.number, url: pr.html_url };
  }
}

// Type guard para erros do Octokit
function isOctokitError(error: unknown): error is { status: number; message: string } {
  return typeof error === 'object' && error !== null && 'status' in error;
}
```

### O que testar

```typescript
// src/github/test-client.ts — execute com: tsx src/github/test-client.ts
import { GitHubClient } from './client.js';

const client = new GitHubClient();
await client.init();
await client.ensureLabelsExist();

const issues = await client.getIssuesWithLabel('agent-ready');
console.log(`Issues com 'agent-ready': ${issues.length}`);
console.log(JSON.stringify(issues, null, 2));
```

```bash
tsx src/github/test-client.ts
# Deve listar issues (pode ser 0 se não houver nenhuma com o label)
# Deve criar os 4 labels no repositório se não existirem
```

---

## Etapa 4 — Scheduler com Controle de Concorrência

### Conceito

O scheduler é o coração do agente. Ele precisa resolver dois problemas:

1. **Concorrência acidental**: se uma iteração demorar mais que o intervalo de polling, não podemos iniciar outra. Precisamos de um *lock* simples (uma flag `isRunning`).

2. **Isolamento de falhas**: se a issue #42 falhar com um erro inesperado, as issues #43 e #44 devem continuar sendo processadas. O padrão *bulkhead* (compartimento estanque de navio) isola as falhas.

Usamos `p-limit` para controlar quantas issues são processadas em paralelo dentro de uma iteração. Começamos com `concurrency: 1` para facilitar o debugging — você pode aumentar depois.

### Código

**`src/scheduler/loop.ts`**
```typescript
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GitHubClient, GitHubIssue } from '../github/client.js';
import { AgentRunner } from '../agent/runner.js';
import { RagEngine } from '../rag/retriever.js';
import pLimit from 'p-limit';

export class Scheduler {
  private isRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private github: GitHubClient;
  private ragEngine: RagEngine;
  private agentRunner: AgentRunner;

  constructor(github: GitHubClient, ragEngine: RagEngine, agentRunner: AgentRunner) {
    this.github = github;
    this.ragEngine = ragEngine;
    this.agentRunner = agentRunner;
  }

  start(): void {
    const intervalMs = env.POLL_INTERVAL_MINUTES * 60 * 1000;
    logger.info(`Scheduler iniciado. Intervalo: ${env.POLL_INTERVAL_MINUTES} minuto(s)`);

    // Roda imediatamente na primeira vez (não espera o intervalo)
    this.tick().catch((err) => logger.error('Erro no tick inicial', { err }));

    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.error('Erro no tick do scheduler', { err }));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Scheduler parado');
    }
  }

  private async tick(): Promise<void> {
    // Lock simples: não inicia nova iteração se ainda está processando
    if (this.isRunning) {
      logger.warn('Tick pulado: iteração anterior ainda em andamento');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    logger.info('=== Início do tick ===');

    try {
      await this.processReadyIssues();
      await this.resumeWaitingIssues();
    } catch (error) {
      logger.error('Erro inesperado no tick', { error });
    } finally {
      this.isRunning = false;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`=== Fim do tick (${elapsed}s) ===`);
    }
  }

  // Processa issues marcadas como 'agent-ready'
  private async processReadyIssues(): Promise<void> {
    const issues = await this.github.getIssuesWithLabel(env.LABEL_READY);

    if (issues.length === 0) {
      logger.info('Nenhuma issue com agent-ready encontrada');
      return;
    }

    logger.info(`Processando ${issues.length} issue(s) com agent-ready`);

    // Limita paralelismo — comece com 1 para facilitar debug
    const limit = pLimit(1);

    await Promise.allSettled(
      issues.map((issue) =>
        limit(() => this.processIssueWithIsolation(issue))
      )
    );
  }

  // Retoma issues onde o agente fez uma pergunta e o humano respondeu
  private async resumeWaitingIssues(): Promise<void> {
    const waitingIssues = await this.github.getIssuesWithLabel(env.LABEL_WAITING);

    const issuesToResume: GitHubIssue[] = [];

    for (const issue of waitingIssues) {
      const humanReplies = await this.github.getHumanRepliesAfterBot(issue.number);
      if (humanReplies.length > 0) {
        logger.info(`Issue #${issue.number} tem ${humanReplies.length} resposta(s) humana(s) — retomando`);
        issuesToResume.push(issue);
      }
    }

    if (issuesToResume.length === 0) {
      logger.info('Nenhuma issue waiting-for-human com resposta humana');
      return;
    }

    const limit = pLimit(1);
    await Promise.allSettled(
      issuesToResume.map((issue) =>
        limit(() => this.resumeIssueWithIsolation(issue))
      )
    );
  }

  // Isolamento de falha por issue — erros em uma issue não afetam as outras
  private async processIssueWithIsolation(issue: GitHubIssue): Promise<void> {
    const issueLogger = {
      info: (msg: string) => logger.info(msg, { issueNumber: issue.number }),
      error: (msg: string, meta?: object) =>
        logger.error(msg, { issueNumber: issue.number, ...meta }),
    };

    try {
      issueLogger.info(`Iniciando processamento: "${issue.title}"`);
      await this.github.transitionLabel(issue.number, env.LABEL_READY, env.LABEL_PROCESSING);

      const result = await this.agentRunner.processIssue(issue);

      if (result.type === 'success') {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_DONE);
        issueLogger.info(`Issue resolvida. PR: ${result.prUrl}`);
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
        issueLogger.info('Agente fez pergunta — aguardando resposta humana');
      } else if (result.type === 'rate-limit') {
        // Devolve a issue para a fila
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
        issueLogger.info('Rate limit atingido — issue devolvida para fila');
      }
    } catch (error) {
      // Em caso de erro inesperado, devolve para agent-ready para nova tentativa
      issueLogger.error('Erro inesperado no processamento', { error });
      try {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
      } catch {
        // Best-effort
      }
    }
  }

  private async resumeIssueWithIsolation(issue: GitHubIssue): Promise<void> {
    try {
      await this.github.transitionLabel(issue.number, env.LABEL_WAITING, env.LABEL_PROCESSING);

      const humanReplies = await this.github.getHumanRepliesAfterBot(issue.number);
      const humanContext = humanReplies.map((c) => `${c.author}: ${c.body}`).join('\n\n');

      const result = await this.agentRunner.resumeIssue(issue, humanContext);

      if (result.type === 'success') {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_DONE);
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      }
    } catch (error) {
      logger.error(`Erro ao retomar issue #${issue.number}`, { error });
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING)
        .catch(() => {});
    }
  }
}
```

### O que testar

Por enquanto, o `AgentRunner` e o `RagEngine` não existem. Vamos criar stubs para testar o scheduler isoladamente:

```typescript
// Adicione temporariamente no topo do loop.ts para testar:
// const mockAgentRunner = {
//   processIssue: async (issue) => ({ type: 'success', prUrl: 'http://fake-pr' }),
//   resumeIssue: async (issue, ctx) => ({ type: 'success', prUrl: 'http://fake-pr' }),
// };
```

Continuamos nas próximas etapas com as implementações reais.

---

## Etapa 5 — RAG Engine: Indexando o Repositório

### Conceito: O que é RAG e por que é essencial para agentes de código

RAG significa *Retrieval-Augmented Generation* (Geração Aumentada por Recuperação). É a técnica de injetar informação relevante no contexto do modelo antes de pedir que ele gere algo.

**Por que RAG é indispensável aqui?**

Imagine que o repositório tem 500 arquivos. A issue #42 pede para corrigir um bug no módulo de autenticação. O Claude precisa entender:
- Como funciona o módulo de autenticação
- Quais padrões o projeto usa (nomes de variáveis, estrutura de classes)
- Onde o bug provavelmente está

Se você jogar os 500 arquivos no contexto, vai explodir o limite de tokens e o custo será absurdo. Com RAG, você joga **apenas os 5-10 arquivos mais relevantes** para aquela issue específica.

**O pipeline RAG tem 4 fases:**

```
1. INDEXAÇÃO (roda uma vez, ou quando o repo muda)
   Arquivos → Chunks → Embeddings → ChromaDB

2. RETRIEVAL (roda para cada issue)
   Query (título + corpo da issue) → Embedding → Busca vetorial → Top-K chunks

3. RERANKING (opcional, mas melhora qualidade)
   Top-K chunks → Reranker → Top-N chunks ordenados por relevância

4. INJEÇÃO NO PROMPT
   Top-N chunks → Formatação → System prompt do agente
```

**Estratégia de chunking para código:**

Código não deve ser quebrado por número fixo de caracteres (como texto comum). As melhores estratégias são:

| Estratégia | Prós | Contras |
|---|---|---|
| Por arquivo completo | Preserva contexto total | Arquivos grandes desperdiçam tokens |
| Por função/classe | Unidade semântica natural | Requer parser (tree-sitter) |
| Por arquivo (nosso caso) | Simples, boa qualidade | Pode truncar arquivos muito grandes |

Vamos usar "por arquivo" com truncagem inteligente, que é 80% da qualidade com 20% da complexidade.

**ChromaDB vs alternativas:**

| | ChromaDB | Pinecone | Qdrant |
|---|---|---|---|
| Setup | Docker local | SaaS | Docker ou SaaS |
| Custo | Gratuito | Pago por vetor | Gratuito (self-hosted) |
| Performance | Boa para <1M docs | Excelente | Excelente |
| Caso de uso | Dev/projetos médios | Produção em escala | Produção self-hosted |

ChromaDB é perfeito para este agente porque roda como container junto com o agente.

### Código

**`src/rag/indexer.ts`**
```typescript
import { ChromaClient, Collection } from 'chromadb';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Extensões de arquivo que vamos indexar
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.java', '.py', '.go', '.rs',
  '.sql', '.md', '.json',
  '.yaml', '.yml', '.sh',
]);

// Pastas que vamos ignorar (evita indexar node_modules, etc.)
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target',
  '.next', '__pycache__', '.gradle', 'vendor',
]);

// Tamanho máximo por chunk em caracteres (~4 chars por token)
// 2000 tokens * 4 = ~8000 chars por chunk
const MAX_CHUNK_SIZE = 8000;

interface CodeChunk {
  id: string;
  content: string;
  metadata: {
    filePath: string;
    extension: string;
    chunkIndex: number;
    totalChunks: number;
    repoPath: string;
  };
}

export class RepositoryIndexer {
  private chroma: ChromaClient;
  private anthropic: Anthropic;
  private collectionName: string;

  constructor() {
    this.chroma = new ChromaClient({ path: env.CHROMA_URL });
    this.anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.collectionName = `repo-${env.GITHUB_OWNER}-${env.GITHUB_REPO}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  async index(repoPath: string): Promise<void> {
    logger.info(`Iniciando indexação de: ${repoPath}`);

    // Coleta todos os arquivos indexáveis
    const files = await this.collectFiles(repoPath);
    logger.info(`Encontrados ${files.length} arquivos para indexar`);

    // Cria ou recria a collection no ChromaDB
    // Usamos "get_or_create" para ser idempotente
    let collection: Collection;
    try {
      collection = await this.chroma.getOrCreateCollection({
        name: this.collectionName,
        metadata: {
          'hnsw:space': 'cosine', // distância cosseno é melhor para texto/código
          repoPath,
          indexedAt: new Date().toISOString(),
        },
      });
      logger.info(`Collection ChromaDB: ${this.collectionName}`);
    } catch (error) {
      logger.error('Erro ao criar collection no ChromaDB', { error });
      throw error;
    }

    // Processa em batches para não explodir a memória
    const BATCH_SIZE = 10;
    let totalChunks = 0;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const chunks = await this.createChunks(batch, repoPath);

      if (chunks.length === 0) continue;

      // Gera embeddings para o batch
      const embeddings = await this.generateEmbeddings(chunks.map((c) => c.content));

      // Insere no ChromaDB
      await collection.upsert({
        ids: chunks.map((c) => c.id),
        embeddings,
        documents: chunks.map((c) => c.content),
        metadatas: chunks.map((c) => c.metadata),
      });

      totalChunks += chunks.length;
      logger.info(
        `Indexados ${i + batch.length}/${files.length} arquivos (${totalChunks} chunks)`
      );
    }

    logger.info(`Indexação concluída. Total: ${totalChunks} chunks`);
  }

  private async collectFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentPath: string): Promise<void> {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            const fileStat = await stat(fullPath);
            // Ignora arquivos muito grandes (>500KB)
            if (fileStat.size < 500 * 1024) {
              files.push(fullPath);
            }
          }
        }
      }
    }

    await walk(dirPath);
    return files;
  }

  private async createChunks(filePaths: string[], repoRoot: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];

    for (const filePath of filePaths) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const relativePath = relative(repoRoot, filePath);

        if (content.trim().length === 0) continue;

        // Se o arquivo cabe em um chunk, não divide
        if (content.length <= MAX_CHUNK_SIZE) {
          chunks.push({
            id: `${relativePath}:0`,
            content: this.formatChunk(relativePath, content, 0, 1),
            metadata: {
              filePath: relativePath,
              extension: extname(filePath),
              chunkIndex: 0,
              totalChunks: 1,
              repoPath: repoRoot,
            },
          });
        } else {
          // Divide em chunks preservando linhas (não corta no meio de uma linha)
          const fileChunks = this.splitByLines(content, MAX_CHUNK_SIZE);
          fileChunks.forEach((chunkContent, idx) => {
            chunks.push({
              id: `${relativePath}:${idx}`,
              content: this.formatChunk(relativePath, chunkContent, idx, fileChunks.length),
              metadata: {
                filePath: relativePath,
                extension: extname(filePath),
                chunkIndex: idx,
                totalChunks: fileChunks.length,
                repoPath: repoRoot,
              },
            });
          });
        }
      } catch {
        // Arquivo binário ou encoding inválido — pula silenciosamente
      }
    }

    return chunks;
  }

  // Formata o chunk com metadados no cabeçalho para ajudar o modelo a entender o contexto
  private formatChunk(filePath: string, content: string, idx: number, total: number): string {
    const chunkInfo = total > 1 ? ` (parte ${idx + 1}/${total})` : '';
    return `=== Arquivo: ${filePath}${chunkInfo} ===\n${content}`;
  }

  private splitByLines(content: string, maxSize: number): string[] {
    const lines = content.split('\n');
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      if ((current + line + '\n').length > maxSize && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += line + '\n';
    }

    if (current.trim()) {
      chunks.push(current);
    }

    return chunks;
  }

  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    // Anthropic Voyage embeddings — voyage-code-3 é otimizado para código
    const response = await this.anthropic.beta.messages.create({} as never);
    // NOTA: A API de embeddings da Anthropic usa o cliente separado
    // Veja: https://docs.anthropic.com/en/docs/build-with-claude/embeddings

    // Na prática, use a API de embeddings assim:
    const embeddingResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'embeddings-2024-01-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.EMBEDDING_MODEL,
        input: texts,
        input_type: 'search_document',
      }),
    });

    if (!embeddingResponse.ok) {
      const error = await embeddingResponse.text();
      throw new Error(`Erro na API de embeddings: ${error}`);
    }

    const data = (await embeddingResponse.json()) as {
      embeddings: Array<{ values: number[] }>;
    };

    return data.embeddings.map((e) => e.values);
  }

  getCollectionName(): string {
    return this.collectionName;
  }
}

// ─── Entry point para rodar standalone ─────────────────────────────────────
// Execute: npm run index:repo
if (process.argv[1].endsWith('indexer.ts') || process.argv[1].endsWith('indexer.js')) {
  const indexer = new RepositoryIndexer();
  await indexer.index(env.REPO_LOCAL_PATH);
}
```

**`src/rag/retriever.ts`**
```typescript
import { ChromaClient } from 'chromadb';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface RetrievalResult {
  chunks: Array<{
    content: string;
    filePath: string;
    score: number;
  }>;
  totalTokensEstimate: number;
}

export class RagEngine {
  private chroma: ChromaClient;
  private collectionName: string;

  constructor() {
    this.chroma = new ChromaClient({ path: env.CHROMA_URL });
    this.collectionName = `repo-${env.GITHUB_OWNER}-${env.GITHUB_REPO}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
  }

  async retrieveContext(
    query: string,
    topK: number = 8
  ): Promise<RetrievalResult> {
    logger.debug(`RAG retrieval para query: "${query.substring(0, 80)}..."`);

    // Gera embedding da query
    const queryEmbedding = await this.generateQueryEmbedding(query);

    // Busca no ChromaDB
    const collection = await this.chroma.getCollection({ name: this.collectionName });

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      include: ['documents', 'metadatas', 'distances'],
    });

    const chunks = (results.documents[0] ?? []).map((doc, idx) => {
      const metadata = results.metadatas[0]?.[idx] as Record<string, string> | null;
      const distance = results.distances?.[0]?.[idx] ?? 1;

      return {
        content: doc ?? '',
        filePath: metadata?.['filePath'] ?? 'unknown',
        // Converte distância cosseno em score de similaridade (0-1)
        score: 1 - distance,
      };
    });

    // Filtra chunks com score muito baixo (provavelmente irrelevantes)
    const relevantChunks = chunks.filter((c) => c.score > 0.3);

    const totalTokensEstimate = relevantChunks.reduce(
      (acc, c) => acc + Math.ceil(c.content.length / 4),
      0
    );

    logger.debug(
      `RAG: ${relevantChunks.length} chunks recuperados (~${totalTokensEstimate} tokens)`
    );

    return { chunks: relevantChunks, totalTokensEstimate };
  }

  private async generateQueryEmbedding(text: string): Promise<number[]> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'embeddings-2024-01-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.EMBEDDING_MODEL,
        input: [text],
        // 'search_query' vs 'search_document': embeddings assimétricos
        // Query e documentos têm tipos diferentes para melhor retrieval
        input_type: 'search_query',
      }),
    });

    if (!response.ok) {
      throw new Error(`Erro na API de embeddings: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      embeddings: Array<{ values: number[] }>;
    };

    return data.embeddings[0].values;
  }
}
```

### O que testar

```bash
# Primeiro, suba o ChromaDB
docker run -d -p 8000:8000 --name chromadb chromadb/chroma

# Clone o repositório alvo (ou use um existente)
git clone https://github.com/SEU_USER/SEU_REPO /tmp/test-repo

# Indexe o repositório (vai demorar alguns minutos)
REPO_LOCAL_PATH=/tmp/test-repo npm run index:repo

# Você deve ver logs como:
# Iniciando indexação de: /tmp/test-repo
# Encontrados 47 arquivos para indexar
# Indexados 10/47 arquivos (12 chunks)
# ...
# Indexação concluída. Total: 58 chunks
```

---

### ⚠️ Correções necessárias nas Etapas 1–5 (migração Voyage AI → Ollama)

Se você implementou as etapas anteriores seguindo o plano original, aplique as correções abaixo antes de continuar. O Ollama rodará como container no docker-compose (Etapa 10), mas para testes locais instale-o com `curl -fsSL https://ollama.com/install.sh | sh && ollama pull nomic-embed-text`.

**`src/config/env.ts`**

```typescript
// REMOVER:
ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),
EMBEDDING_MODEL: optionalEnv('EMBEDDING_MODEL', 'voyage-code-3'),

// ADICIONAR no lugar:
OLLAMA_URL: optionalEnv('OLLAMA_URL', 'http://localhost:11434'),
EMBEDDING_MODEL: optionalEnv('EMBEDDING_MODEL', 'nomic-embed-text'),
```

**`.env.example`**

```bash
# REMOVER:
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDING_MODEL=voyage-code-3

# ADICIONAR no lugar:
OLLAMA_URL=http://ollama:11434
EMBEDDING_MODEL=nomic-embed-text
```

**`src/rag/indexer.ts`** — três mudanças:

1. Remova o import e as referências ao SDK da Anthropic:

```typescript
// REMOVER no topo do arquivo:
import Anthropic from '@anthropic-ai/sdk';

// REMOVER no construtor:
private anthropic: Anthropic;
this.anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
```

2. Substitua o método `generateEmbeddings()` inteiro:

```typescript
private async generateEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((text) => this.embedOne(text)));
}

private async embedOne(text: string): Promise<number[]> {
  const response = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding falhou: ${await response.text()}`);
  }
  const data = await response.json() as { embedding: number[] };
  return data.embedding;
}
```

**`src/rag/retriever.ts`** — substitua o método `generateQueryEmbedding()` inteiro:

```typescript
private async generateQueryEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding falhou: ${await response.text()}`);
  }
  const data = await response.json() as { embedding: number[] };
  return data.embedding;
}
```

**`package.json`** — remova a dependência não utilizada:

```bash
npm uninstall @anthropic-ai/sdk
```

---

## Etapa 6 — Prompt Builder: Montando o Contexto do Agente

### Conceito

O prompt é o que o agente vai receber para resolver a issue. Um prompt bem construído é a diferença entre um agente que resolve o problema na primeira tentativa e um que erra ou pede ajuda desnecessariamente.

**Anatomia de um bom prompt de agente de código:**

```
1. SYSTEM PROMPT — identidade e regras fixas
   "Você é um agente de software que..."
   "Sempre que tiver dúvida, pergunte antes de implementar"
   "Commit apenas quando tiver certeza"

2. CONTEXTO DO PROJETO — grounding estático
   Conteúdo do CLAUDE.md (ou README.md) do repositório alvo
   Isso é o "conhecimento de fundo" sobre o projeto

3. CONTEXTO RAG — grounding dinâmico
   Os N arquivos mais relevantes para ESTA issue específica
   Recuperados pela busca vetorial

4. TAREFA — o que fazer
   Título e corpo da issue
   Instrução clara sobre o output esperado (commit + PR)

5. INSTRUÇÕES DE OUTPUT — como terminar
   Como sinalizar sucesso
   Como sinalizar dúvida
```

**Por que separar system prompt de user prompt?**

O system prompt define o "caráter" do agente — comportamentos que não mudam entre issues. O user prompt é a tarefa específica. O Claude Code SDK respeita essa distinção da mesma forma que a API regular do Claude.

### Código

**`src/agent/prompt-builder.ts`**
```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';
import { env } from '../config/env.js';
import { GitHubIssue, GitHubComment } from '../github/client.js';
import { RetrievalResult } from '../rag/retriever.js';
import { logger } from '../utils/logger.js';

export interface AgentPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export class PromptBuilder {
  // Tenta ler o CLAUDE.md do repositório para incluir como grounding.
  // Se não existir, usa o README.md como fallback.
  private async getProjectContext(repoPath: string): Promise<string> {
    const candidates = ['CLAUDE.md', 'README.md', 'CONTRIBUTING.md'];

    for (const filename of candidates) {
      try {
        const content = await readFile(join(repoPath, filename), 'utf-8');
        // Trunca para não dominar o contexto (máx ~2000 tokens)
        const truncated = content.length > 8000 ? content.substring(0, 8000) + '\n...[truncado]' : content;
        logger.debug(`Contexto do projeto carregado de: ${filename}`);
        return `=== ${filename} ===\n${truncated}`;
      } catch {
        // Arquivo não existe, tenta o próximo
      }
    }

    return '(Nenhum arquivo de contexto do projeto encontrado)';
  }

  async buildForNewIssue(
    issue: GitHubIssue,
    ragContext: RetrievalResult,
    repoPath: string,
    branchName: string
  ): Promise<AgentPrompt> {
    const projectContext = await this.getProjectContext(repoPath);
    const ragSection = this.formatRagContext(ragContext);

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt({
      projectContext,
      ragSection,
      issue,
      branchName,
      previousConversation: null,
    });

    return { systemPrompt, userPrompt };
  }

  async buildForResumedIssue(
    issue: GitHubIssue,
    ragContext: RetrievalResult,
    repoPath: string,
    branchName: string,
    humanResponse: string
  ): Promise<AgentPrompt> {
    const projectContext = await this.getProjectContext(repoPath);
    const ragSection = this.formatRagContext(ragContext);

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt({
      projectContext,
      ragSection,
      issue,
      branchName,
      previousConversation: humanResponse,
    });

    return { systemPrompt, userPrompt };
  }

  private buildSystemPrompt(): string {
    return `Você é um agente de engenharia de software especializado em resolver issues do GitHub automaticamente.

## Suas responsabilidades

1. Analisar a issue cuidadosamente
2. Buscar e entender o código relevante no repositório
3. Implementar a correção ou feature solicitada
4. Fazer commit das mudanças com uma mensagem clara
5. NÃO criar Pull Requests — isso será feito automaticamente pelo sistema após você terminar

## Regras críticas

- **Antes de implementar**: leia os arquivos relevantes para entender o padrão do projeto
- **Dúvida genuína**: se a issue for ambígua em algo que vai impactar a implementação, pergunte
- **Não pergunte o óbvio**: inferências razoáveis sobre o código você deve fazer sozinho
- **Commit atômico**: faça um único commit com todas as mudanças necessárias
- **Mensagem de commit**: siga o padrão convencional (feat:, fix:, refactor:) se o projeto usar
- **Escopo cirúrgico**: altere apenas o que é necessário para resolver a issue

## Como sinalizar o resultado

Ao terminar, escreva UMA das seguintes frases EXATAMENTE como mostrado:

- Se implementou e fez commit com sucesso:
  AGENT_STATUS: SUCCESS

- Se precisa de esclarecimento humano antes de prosseguir:
  AGENT_STATUS: NEEDS_CLARIFICATION
  AGENT_QUESTION: [sua pergunta aqui, em uma única linha]

## Observações importantes

- Você está dentro de um container Docker com acesso ao repositório
- A branch já foi criada para você: use git checkout para ir para ela
- dangerouslySkipPermissions está ativo — você pode executar qualquer comando
- O repositório está em: ${env.REPO_LOCAL_PATH}`;
  }

  private buildUserPrompt(params: {
    projectContext: string;
    ragSection: string;
    issue: GitHubIssue;
    branchName: string;
    previousConversation: string | null;
  }): string {
    const { projectContext, ragSection, issue, branchName, previousConversation } = params;

    let prompt = `## Contexto do Projeto

${projectContext}

## Arquivos Relevantes (recuperados por busca semântica)

Os seguintes arquivos foram identificados como mais relevantes para esta issue.
Use-os como ponto de partida, mas leia outros arquivos se necessário.

${ragSection}

## Issue a Resolver

**Repositório:** ${env.GITHUB_OWNER}/${env.GITHUB_REPO}
**Issue #${issue.number}:** ${issue.title}
**URL:** ${issue.htmlUrl}

**Descrição:**
${issue.body ?? '(Sem descrição)'}

## Instruções de Execução

1. Vá para a branch correta:
   \`\`\`bash
   cd ${env.REPO_LOCAL_PATH}
   git checkout ${branchName}
   \`\`\`

2. Leia e entenda os arquivos relevantes listados acima

3. Implemente a solução

4. Faça commit:
   \`\`\`bash
   git add -A
   git commit -m "fix: resolve issue #${issue.number} - ${issue.title}"
   \`\`\`

5. Sinalize o resultado com AGENT_STATUS conforme as instruções do sistema`;

    if (previousConversation) {
      prompt += `

## Contexto da Conversa Anterior

Na iteração anterior, você pediu esclarecimento. O humano respondeu:

${previousConversation}

Use essa informação para retomar e completar a implementação.`;
    }

    return prompt;
  }

  private formatRagContext(ragContext: RetrievalResult): string {
    if (ragContext.chunks.length === 0) {
      return '(Nenhum arquivo relevante encontrado no índice — verifique se o repositório foi indexado)';
    }

    return ragContext.chunks
      .map((chunk, idx) => {
        const scorePercent = (chunk.score * 100).toFixed(0);
        return `### [${idx + 1}] ${chunk.filePath} (relevância: ${scorePercent}%)\n\n\`\`\`\n${chunk.content}\n\`\`\``;
      })
      .join('\n\n');
  }
}
```

### O que testar

```typescript
// src/agent/test-prompt.ts
import { PromptBuilder } from './prompt-builder.js';
import { RagEngine } from '../rag/retriever.js';

const builder = new PromptBuilder();
const rag = new RagEngine();

const fakeIssue = {
  number: 42,
  title: 'Fix: campo de email não valida formato correto',
  body: 'O campo de email aceita valores sem @ como válidos.',
  labels: ['agent-ready'],
  htmlUrl: 'https://github.com/owner/repo/issues/42',
  createdAt: new Date().toISOString(),
};

const ragContext = await rag.retrieveContext(
  `${fakeIssue.title} ${fakeIssue.body}`
);

const prompt = await builder.buildForNewIssue(
  fakeIssue,
  ragContext,
  process.env.REPO_LOCAL_PATH!,
  'agent/issue-42'
);

console.log('=== SYSTEM PROMPT ===');
console.log(prompt.systemPrompt);
console.log('\n=== USER PROMPT (primeiros 2000 chars) ===');
console.log(prompt.userPrompt.substring(0, 2000));
console.log(`\nTotal chars: ${prompt.userPrompt.length}`);
```

```bash
tsx src/agent/test-prompt.ts
```

---

## Etapa 7 — Agent Runner: Claude Code via Subprocess

### Conceito: Como invocar o Claude Code programaticamente

O pacote `@anthropic-ai/claude-code` instalado via npm é apenas um **binário CLI** — não expõe API JavaScript/TypeScript para importar. A forma correta de usá-lo programaticamente é invocá-lo como subprocess com `--output-format stream-json`.

**O tool use loop funciona assim:**

```
Você envia o prompt via stdin do subprocess
    └── claude analisa e decide usar uma ferramenta (ex: Edit)
         └── claude executa a ferramenta localmente
              └── Resultado é injetado de volta no contexto
                   └── claude continua pensando...
                        └── [repete até terminar]
                             └── Retorna stream de JSON no stdout
```

**Flags essenciais do CLI:**

| Flag | Por quê |
|---|---|
| `--print` | Modo não-interativo — processa e sai |
| `--verbose` | Obrigatório junto com `stream-json` |
| `--output-format stream-json` | Cada linha do stdout é um objeto JSON |
| `--dangerously-skip-permissions` | Sem confirmações — seguro só em Docker isolado |
| `--append-system-prompt` | Injeta instruções adicionais no system prompt |

**Formato do stream-json:**

Cada linha do stdout é um JSON com `type`:
- `system` — metadados de inicialização da sessão
- `assistant` — texto e tool_use do Claude (contém `message.content` e `message.usage`)
- `rate_limit_event` — informação de rate limit
- `result` — mensagem final com `subtype: "success"` e custo total

**Autenticação:** o subprocess herda o ambiente do processo pai. Para que o claude use a autenticação OAuth da sessão local (não uma API key), `ANTHROPIC_API_KEY` deve ser removido do ambiente antes de spawnar.

### Código

**`src/agent/rate-limit.ts`**
```typescript
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Rate limit da API Anthropic atingido');
    this.name = 'RateLimitError';
  }
}

export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('overloaded')
  );
}

export function parseRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;

  // Tenta extrair "retry after X seconds" da mensagem de erro
  const match = error.message.match(/retry after (\d+)/i);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }

  return undefined;
}
```

**`src/agent/runner.ts`**
```typescript
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { env } from '../config/env.js';
import { createContextLogger } from '../utils/logger.js';
import { GitHubClient } from '../github/client.js';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RagEngine } from '../rag/retriever.js';
import { PromptBuilder } from './prompt-builder.js';
import { isRateLimitError, parseRetryAfter } from './rate-limit.js';
import { simpleGit, SimpleGit } from 'simple-git';

// Os três possíveis resultados de uma sessão do agente
export type AgentResult =
  | { type: 'success'; prUrl: string }
  | { type: 'needs-clarification'; question: string }
  | { type: 'rate-limit'; retryAfterMs?: number };

export class AgentRunner {
  private github: GitHubClient;
  private ragEngine: RagEngine;
  private promptBuilder: PromptBuilder;

  constructor(github: GitHubClient, ragEngine: RagEngine) {
    this.github = github;
    this.ragEngine = ragEngine;
    this.promptBuilder = new PromptBuilder();
  }

  async processIssue(issue: GitHubIssue): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'process' });

    // 1. Cria a branch no GitHub
    const branchName = await this.github.createBranch(issue.number);
    log.info(`Branch criada: ${branchName}`);

    // 2. Configura o git local para usar a branch
    const git = simpleGit(env.REPO_LOCAL_PATH);
    await git.fetch('origin');
    await git.checkout(branchName);
    log.info('Git local configurado na branch');

    // 3. Recupera contexto RAG
    const query_text = `${issue.title} ${issue.body ?? ''}`;
    const ragContext = await this.ragEngine.retrieveContext(query_text);
    log.info(`RAG: ${ragContext.chunks.length} chunks recuperados`);

    // 4. Monta o prompt
    const prompt = await this.promptBuilder.buildForNewIssue(
      issue,
      ragContext,
      env.REPO_LOCAL_PATH,
      branchName
    );

    // 5. Roda o agente
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt);
  }

  async resumeIssue(issue: GitHubIssue, humanResponse: string): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'resume' });

    const branchName = this.github.getBranchName(issue.number);

    const git = simpleGit(env.REPO_LOCAL_PATH);
    await git.fetch('origin');
    await git.checkout(branchName);

    const queryText = `${issue.title} ${issue.body ?? ''} ${humanResponse}`;
    const ragContext = await this.ragEngine.retrieveContext(queryText);

    const prompt = await this.promptBuilder.buildForResumedIssue(
      issue,
      ragContext,
      env.REPO_LOCAL_PATH,
      branchName,
      humanResponse
    );

    log.info('Retomando issue com contexto da resposta humana');
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt);
  }

  private async runAgentSession(
    issue: GitHubIssue,
    branchName: string,
    systemPrompt: string,
    userPrompt: string
  ): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'agent-session' });

    // Coleta todo o texto gerado pelo agente para análise posterior
    let fullAgentOutput = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      log.info('Iniciando sessão do Claude Code');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        log.warn(`Timeout de ${env.AGENT_TIMEOUT_MS}ms atingido — abortando sessão`);
        controller.abort();
      }, env.AGENT_TIMEOUT_MS);

      try {
        for await (const message of this.spawnClaudeSession({
          userPrompt,
          systemPrompt,
          cwd: env.REPO_LOCAL_PATH,
          abortController: controller,
        })) {
          this.logMessage(message, log);

          if (message.type === 'assistant') {
            const textContent = (message.message?.content ?? [])
              .filter((c: { type: string; text?: string }): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c: { type: 'text'; text: string }) => c.text)
              .join('');
            fullAgentOutput += textContent;
          }

          if (message.message?.usage) {
            totalInputTokens += message.message.usage.input_tokens ?? 0;
            totalOutputTokens += message.message.usage.output_tokens ?? 0;
          }

          if (totalInputTokens + totalOutputTokens > env.MAX_TOKENS_PER_SESSION) {
            log.warn('Limite de tokens atingido — abortando sessão');
            controller.abort();
            break;
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }

      log.info(
        `Sessão concluída. Tokens: ${totalInputTokens} input + ${totalOutputTokens} output`
      );

      // Analisa o output do agente para determinar o resultado
      return await this.parseAgentResult(issue, branchName, fullAgentOutput, log);
    } catch (error) {
      if (isRateLimitError(error)) {
        log.warn('Rate limit detectado durante sessão do agente');
        return {
          type: 'rate-limit',
          retryAfterMs: parseRetryAfter(error),
        };
      }

      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('Sessão abortada por timeout');
        // Trata timeout como rate-limit para retry na próxima iteração
        return { type: 'rate-limit' };
      }

      throw error;
    }
  }

  private async parseAgentResult(
    issue: GitHubIssue,
    branchName: string,
    agentOutput: string,
    log: ReturnType<typeof createContextLogger>
  ): Promise<AgentResult> {
    // Procura pelos sinalizadores de status no output do agente
    if (agentOutput.includes('AGENT_STATUS: SUCCESS')) {
      log.info('Agente sinalizou sucesso — criando PR');

      // Verifica se há commits na branch
      const git = simpleGit(env.REPO_LOCAL_PATH);
      const log_result = await git.log({ from: 'origin/main', to: branchName }).catch(() => null);

      if (!log_result || log_result.total === 0) {
        log.warn('Agente sinalizou sucesso mas não há commits — tratando como clarification');
        return {
          type: 'needs-clarification',
          question:
            '⚠️ Sinalizo que completei a implementação, mas não encontrei commits na branch. ' +
            'Por favor, verifique e me diga se preciso de mais informações.',
        };
      }

      // Faz push da branch
      await git.push('origin', branchName);

      // Cria o PR
      const pr = await this.github.createPullRequest(
        issue.number,
        branchName,
        `fix: ${issue.title} (resolve #${issue.number})`,
        this.buildPrBody(issue, agentOutput)
      );

      return { type: 'success', prUrl: pr.url };
    }

    if (agentOutput.includes('AGENT_STATUS: NEEDS_CLARIFICATION')) {
      // Extrai a pergunta do output
      const questionMatch = agentOutput.match(/AGENT_QUESTION:\s*(.+?)(?:\n|$)/);
      const question = questionMatch?.[1]?.trim() ??
        'Preciso de esclarecimento adicional antes de prosseguir.';

      log.info(`Agente precisa de esclarecimento: "${question}"`);

      return {
        type: 'needs-clarification',
        question: this.formatClarificationComment(question),
      };
    }

    // Output ambíguo — o agente não sinalizou o status corretamente
    log.warn('Agente não sinalizou status corretamente. Output (últimos 500 chars):');
    log.warn(agentOutput.slice(-500));

    return {
      type: 'needs-clarification',
      question:
        '🤖 Processei esta issue mas não consegui determinar se a implementação foi concluída. ' +
        'Por favor, verifique a branch `' + branchName + '` e confirme se devo prosseguir ou se há algo mais a fazer.',
    };
  }

  private buildPrBody(issue: GitHubIssue, agentOutput: string): string {
    return `## Resolução Automática

Este PR foi criado automaticamente pelo agente de issues.

**Issue resolvida:** #${issue.number} — ${issue.title}

## O que foi feito

O agente analisou a issue e implementou as modificações necessárias. 
Por favor, revise as mudanças antes de fazer merge.

## Checklist

- [ ] Revisei as mudanças no diff
- [ ] Os testes passam
- [ ] A implementação resolve o problema descrito na issue

---
*Gerado automaticamente pelo GitHub Agent*`;
  }

  private formatClarificationComment(question: string): string {
    return `🤖 **Agente de Issues — Esclarecimento Necessário**

Analisei esta issue, mas preciso de uma informação antes de prosseguir:

**${question}**

Por favor, responda a este comentário com o esclarecimento e serei retomado automaticamente na próxima iteração.

---
*Este é um comentário automático. Responda aqui para retomar o processamento.*`;
  }

  private async *spawnClaudeSession(params: {
    userPrompt: string;
    systemPrompt: string;
    cwd: string;
    abortController: AbortController;
  }): AsyncIterable<any> {
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

    // Remove ANTHROPIC_API_KEY do ambiente do subprocess — o claude deve usar
    // autenticação OAuth da sessão local, não uma API key do projeto
    const { ANTHROPIC_API_KEY: _removed, ...spawnEnv } = process.env;

    const proc = spawn(claudeBin, [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--append-system-prompt', params.systemPrompt,
    ], {
      cwd: params.cwd,
      env: spawnEnv,
      signal: params.abortController.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Prompt via stdin — evita limite de tamanho de argumento CLI
    proc.stdin!.write(params.userPrompt);
    proc.stdin!.end();

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // linha não-JSON, ignora
      }
    }
  }

  private logMessage(
    message: any,
    log: ReturnType<typeof createContextLogger>
  ): void {
    switch (message.type) {
      case 'system':
        log.debug('system message', { subtype: message.subtype });
        break;

      case 'assistant':
        for (const content of (message.message?.content ?? [])) {
          if (content.type === 'text' && content.text?.length > 0) {
            log.debug(`Claude: ${content.text.substring(0, 200)}${content.text.length > 200 ? '...' : ''}`);
          } else if (content.type === 'tool_use') {
            log.info(`Ferramenta: ${content.name}`, {
              input: JSON.stringify(content.input).substring(0, 200),
            });
          }
        }
        break;

      case 'tool':
        log.debug('Tool result recebido', { toolUseId: message.tool_use_id });
        break;

      default:
        log.debug('Mensagem', { type: message.type });
    }
  }
}
```

### O que testar

**Teste 1 — subprocess funcionando:**

```bash
echo "responda apenas: olá" | claude --print --verbose --output-format stream-json --dangerously-skip-permissions
# Deve retornar linhas JSON com type: "system", "assistant", "result"
```

**Teste 2 — runner completo** (`src/agent/test-runner.ts`):

```typescript
import { GitHubClient } from '../github/client.js';
import { RagEngine } from '../rag/retriever.js';
import { AgentRunner } from './runner.js';

const github = new GitHubClient();
await github.init();

const rag = new RagEngine();
const runner = new AgentRunner(github, rag);

const issue = await github.getIssue(SEU_NUMERO_DE_ISSUE);
const result = await runner.processIssue(issue);

console.log('Resultado:', JSON.stringify(result, null, 2));
```

```bash
tsx src/agent/test-runner.ts
```

Sinais de que está funcionando:
- Logs mostram `Tokens: X input + Y output` com valores > 0
- O `result` retorna `needs-clarification` com a pergunta do agente (esperado — o agente não terá contexto RAG ainda)
- Nenhum erro de autenticação

**Teste 3 — simular rate limit** (adicione temporariamente como primeira linha de `spawnClaudeSession`, remova após o teste):

```typescript
throw new Error('Rate limit exceeded: retry after 10 seconds');
```

O resultado deve ser `{ type: 'rate-limit' }` em vez de `needs-clarification`.

---

## Etapa 8 — Rate Limit Handler: Graceful Degradation

### Conceito

Rate limiting é uma realidade de qualquer sistema que usa APIs externas. A abordagem ingênua é retornar erro e desistir. A abordagem profissional é *graceful degradation*: detectar o rate limit, parar o que estava fazendo de forma limpa, e garantir que o estado do sistema seja consistente para a próxima tentativa.

O estado consistente aqui significa: **a issue deve voltar para `agent-ready`** quando ocorre rate limit. Se deixarmos a issue presa em `agent-processing`, ela nunca será processada novamente.

Já implementamos a detecção no `AgentRunner`. Aqui formalizamos o handler e adicionamos um mecanismo de *exponential backoff* para casos onde o scheduler também está sendo throttled.

### Código

**`src/agent/rate-limit.ts`** (versão completa)
```typescript
import { logger } from '../utils/logger.js';

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Rate limit da API Anthropic atingido');
    this.name = 'RateLimitError';
  }
}

export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('overloaded')
  );
}

export function parseRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/retry after (\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return undefined;
}

// Exponential backoff com jitter para evitar thundering herd
// quando múltiplas instâncias tentam ao mesmo tempo
export function calculateBackoffMs(
  attemptNumber: number,
  baseDelayMs: number = 5000,
  maxDelayMs: number = 5 * 60 * 1000 // máx 5 minutos
): number {
  const exponential = baseDelayMs * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 0.3 * exponential; // 30% de jitter
  return Math.min(exponential + jitter, maxDelayMs);
}

// Estado de rate limit compartilhado entre instâncias do scheduler
// Em produção multi-instância, isso seria no Redis
export class RateLimitState {
  private hitCount = 0;
  private lastHitAt: Date | null = null;
  private cooldownUntil: Date | null = null;

  recordHit(retryAfterMs?: number): void {
    this.hitCount++;
    this.lastHitAt = new Date();

    const cooldownMs = retryAfterMs ?? calculateBackoffMs(this.hitCount);
    this.cooldownUntil = new Date(Date.now() + cooldownMs);

    logger.warn('Rate limit registrado', {
      hitCount: this.hitCount,
      cooldownUntil: this.cooldownUntil.toISOString(),
      cooldownMs,
    });
  }

  isInCooldown(): boolean {
    if (!this.cooldownUntil) return false;
    return new Date() < this.cooldownUntil;
  }

  getCooldownRemainingMs(): number {
    if (!this.cooldownUntil) return 0;
    return Math.max(0, this.cooldownUntil.getTime() - Date.now());
  }

  reset(): void {
    this.hitCount = 0;
    this.lastHitAt = null;
    this.cooldownUntil = null;
    logger.info('Rate limit state resetado');
  }

  getStatus(): object {
    return {
      hitCount: this.hitCount,
      lastHitAt: this.lastHitAt?.toISOString(),
      cooldownUntil: this.cooldownUntil?.toISOString(),
      isInCooldown: this.isInCooldown(),
      cooldownRemainingMs: this.getCooldownRemainingMs(),
    };
  }
}
```

Agora, atualize o scheduler para usar o `RateLimitState`:

**`src/scheduler/loop.ts`** — adicione ao início do `tick()`:
```typescript
// Adicione ao construtor do Scheduler:
private rateLimitState = new RateLimitState();

// Adicione ao início do tick():
private async tick(): Promise<void> {
  if (this.isRunning) {
    logger.warn('Tick pulado: iteração anterior ainda em andamento');
    return;
  }

  // Verifica cooldown de rate limit ANTES de iniciar o tick
  if (this.rateLimitState.isInCooldown()) {
    const remainingSec = Math.ceil(this.rateLimitState.getCooldownRemainingMs() / 1000);
    logger.info(`Tick pulado: em cooldown por rate limit (${remainingSec}s restantes)`);
    return;
  }

  // ... resto do tick
}

// No processIssueWithIsolation, quando result.type === 'rate-limit':
} else if (result.type === 'rate-limit') {
  this.rateLimitState.recordHit(result.retryAfterMs);
  await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
  issueLogger.info('Rate limit atingido — issue devolvida para fila, cooldown ativado');
}
```

### O que testar

```bash
# Simule um rate limit modificando temporariamente o runner para lançar o erro
# Verifique que:
# 1. A issue volta para agent-ready
# 2. O próximo tick é pulado durante o cooldown
# 3. Os logs mostram o estado do rate limit claramente
```

---

## Etapa 9 — Loop de Clarificação: Agente ↔ Humano

### Conceito

Um dos superpoderes dos agentes bem projetados é saber quando NÃO agir. Um agente que tenta implementar qualquer coisa sem entender a especificação vai criar PR ruins, introduzir bugs, e gerar mais trabalho manual do que economizaria.

O loop de clarificação funciona assim:

```
Iteração 1:
  Agente analisa issue
  Agente não tem certeza sobre algo crucial
  Agente posta comentário com a pergunta
  Issue recebe label 'waiting-for-human'

(Humano responde ao comentário no GitHub)

Iteração 2:
  Scheduler detecta: issue waiting-for-human + comentário humano novo
  Issue é retomada com o contexto completo da conversa
  Agente implementa com a informação adicional
```

A chave é o contexto: na segunda iteração, o agente recebe tanto a issue original quanto a resposta do humano. Isso simula uma conversa multi-turno.

**Quando o agente deve perguntar vs. inferir?**

| Situação | Ação recomendada |
|---|---|
| "Bug no módulo X" sem detalhes de reprodução | Analise o código e tente inferir |
| "Adicione feature Y" sem especificação de UX | Inferir baseado nos padrões do projeto |
| "Migre de biblioteca A para B" sem versão alvo | **Pergunte** — versões têm APIs diferentes |
| "Corrija o problema de performance" sem métrica | **Pergunte** — pode ser otimização prematura |
| Ambiguidade que resulte em mudanças de schema | **Pergunte** — irreversível |

O system prompt que escrevemos na Etapa 6 já instrui o agente sobre quando perguntar. Aqui garantimos que o mecanismo funciona end-to-end.

### Código

A lógica de clarificação já está distribuída no código que escrevemos. O que precisamos é de um utilitário para formatar o histórico de conversa de forma rica para o agente:

**`src/agent/conversation.ts`**
```typescript
import { GitHubComment } from '../github/client.js';

export interface ConversationTurn {
  role: 'agent' | 'human';
  content: string;
  createdAt: string;
}

export function buildConversationHistory(comments: GitHubComment[]): ConversationTurn[] {
  return comments.map((comment) => ({
    role: comment.isBot ? 'agent' : 'human',
    content: comment.body,
    createdAt: comment.createdAt,
  }));
}

export function formatConversationForPrompt(turns: ConversationTurn[]): string {
  if (turns.length === 0) return '';

  const formatted = turns
    .map((turn) => {
      const role = turn.role === 'agent' ? '🤖 **Agente**' : '👤 **Humano**';
      return `${role} (${new Date(turn.createdAt).toLocaleString('pt-BR')})\n${turn.content}`;
    })
    .join('\n\n---\n\n');

  return `## Histórico de Conversa\n\n${formatted}`;
}

// Extrai apenas a última pergunta do agente (para o contexto de retomada)
export function extractLastAgentQuestion(turns: ConversationTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'agent') {
      // Extrai a pergunta do formato do comentário de clarificação
      const match = turns[i].content.match(/\*\*(.+?)\*\*/s);
      return match?.[1] ?? turns[i].content;
    }
  }
  return null;
}
```

Atualize o `PromptBuilder` para usar o histórico completo quando retomando:

**Adicione ao `src/agent/prompt-builder.ts`:**
```typescript
import { formatConversationForPrompt, buildConversationHistory } from './conversation.js';
import type { GitHubComment } from '../github/client.js';

// Novo método no PromptBuilder:
async buildForResumedIssueWithHistory(
  issue: GitHubIssue,
  ragContext: RetrievalResult,
  repoPath: string,
  branchName: string,
  allComments: GitHubComment[]
): Promise<AgentPrompt> {
  const projectContext = await this.getProjectContext(repoPath);
  const ragSection = this.formatRagContext(ragContext);
  const conversationHistory = buildConversationHistory(allComments);
  const conversationFormatted = formatConversationForPrompt(conversationHistory);

  const systemPrompt = this.buildSystemPrompt();
  const userPrompt = this.buildUserPrompt({
    projectContext,
    ragSection,
    issue,
    branchName,
    previousConversation: conversationFormatted,
  });

  return { systemPrompt, userPrompt };
}
```

### O que testar

Teste o loop completo end-to-end:

```bash
# 1. Crie uma issue ambígua propositalmente
gh issue create \
  --title "Adicionar nova funcionalidade de relatório" \
  --body "Precisamos de um relatório novo. Pode implementar?" \
  --label "agent-ready"

# 2. Rode uma iteração do scheduler manualmente
tsx src/index.ts --run-once

# 3. Verifique que o agente postou um comentário perguntando detalhes
# e que a label mudou para 'waiting-for-human'

# 4. Responda ao comentário no GitHub com detalhes

# 5. Rode outra iteração
tsx src/index.ts --run-once

# O agente deve retomar e implementar
```

---

## Etapa 10 — Dockerfile + Docker Compose

### Conceito

Containerizar o agente serve a três propósitos:

1. **Isolamento de segurança**: `dangerouslySkipPermissions: true` só é seguro dentro de um container onde o agente não pode afetar a máquina host
2. **Reprodutibilidade**: "funciona na minha máquina" deixa de existir
3. **Deployment simples**: um `docker-compose up -d` e está rodando

**Arquitetura dos containers:**

```
docker-compose.yml
├── chromadb (porta 8000) — vector store para RAG
│   └── volume: ./chroma-data → /chroma/chroma
└── agent (sem porta exposta) — o agente em si
    ├── depende de: chromadb
    ├── volume: ./workspace/repo → /workspace/repo (repositório alvo)
    ├── volume: ./logs → /app/logs
    └── env_file: .env
```

**Por que o repositório é um volume e não clonado dentro do container?**

Clonar dentro do container significa que a cada restart você clona do zero (lento) e o ChromaDB precisa reindexar. Com um volume, o repositório persiste entre restarts e o índice RAG também.

### Código

**`Dockerfile`**
```dockerfile
# Estágio 1: build
FROM node:20-alpine AS builder

WORKDIR /app

# Copia apenas os arquivos de dependências primeiro (cache layer)
COPY package*.json tsconfig.json ./
RUN npm ci

# Copia o código fonte e compila
COPY src ./src
RUN npm run build

# ─────────────────────────────────────────────

# Estágio 2: runtime (imagem menor, sem devDependencies)
FROM node:20-alpine AS runtime

# git é necessário para o agente fazer commits
RUN apk add --no-cache git

WORKDIR /app

# Apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o código compilado do estágio de build
COPY --from=builder /app/dist ./dist

# Cria diretório de logs
RUN mkdir -p logs

# Usuário não-root para segurança adicional
# NOTA: mesmo dentro do container, é boa prática não rodar como root
RUN addgroup -S agent && adduser -S agent -G agent
RUN chown -R agent:agent /app

USER agent

# Configura git para o usuário do container
RUN git config --global user.email "agent@github-bot.local" && \
    git config --global user.name "GitHub Agent"

CMD ["node", "dist/index.js"]
```

**`docker-compose.yml`**
```yaml
version: '3.8'

services:
  chromadb:
    image: chromadb/chroma:latest
    container_name: github-agent-chromadb
    volumes:
      - ./chroma-data:/chroma/chroma
    environment:
      IS_PERSISTENT: "TRUE"
      ANONYMIZED_TELEMETRY: "FALSE"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/v1/heartbeat"]
      interval: 10s
      timeout: 5s
      retries: 3

  ollama:
    image: ollama/ollama:latest
    container_name: github-agent-ollama
    volumes:
      - ./ollama-data:/root/.ollama
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 10s
      timeout: 5s
      retries: 5
    # Para usar GPU NVIDIA, instale o NVIDIA Container Toolkit e descomente:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]

  agent:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
    container_name: github-agent
    depends_on:
      chromadb:
        condition: service_healthy
      ollama:
        condition: service_healthy
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
      CHROMA_URL: http://chromadb:8000
      OLLAMA_URL: http://ollama:11434
    env_file:
      - .env
    volumes:
      # O repositório alvo — clone aqui antes de subir o agente
      - ./workspace/repo:/workspace/repo
      # Logs persistem entre restarts
      - ./logs:/app/logs
    restart: unless-stopped

  # Serviço auxiliar para indexar o repositório (roda uma vez e sai)
  indexer:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
    container_name: github-agent-indexer
    depends_on:
      chromadb:
        condition: service_healthy
      ollama:
        condition: service_healthy
    environment:
      CHROMA_URL: http://chromadb:8000
      OLLAMA_URL: http://ollama:11434
    env_file:
      - .env
    volumes:
      - ./workspace/repo:/workspace/repo
    command: ["node", "dist/rag/indexer.js"]
    profiles:
      - indexer # só sobe quando explicitamente pedido
```

**`src/index.ts`** — entry point final:
```typescript
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { GitHubClient } from './github/client.js';
import { RagEngine } from './rag/retriever.js';
import { AgentRunner } from './agent/runner.js';
import { Scheduler } from './scheduler/loop.js';

async function main(): Promise<void> {
  logger.info('GitHub Agent iniciando...', {
    repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    pollInterval: env.POLL_INTERVAL_MINUTES,
    maxIssuesPerRun: env.MAX_ISSUES_PER_RUN,
  });

  // Inicializa dependências
  const github = new GitHubClient();
  await github.init();

  // Garante que os labels de controle existem no repositório
  await github.ensureLabelsExist();

  const ragEngine = new RagEngine();
  const agentRunner = new AgentRunner(github, ragEngine);

  const scheduler = new Scheduler(github, ragEngine, agentRunner);

  // Graceful shutdown — espera o tick atual terminar
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Sinal ${signal} recebido — aguardando tick atual terminar...`);
    scheduler.stop();
    // Aguarda até 60s para o tick atual terminar
    await new Promise<void>((resolve) => setTimeout(resolve, 60000));
    logger.info('Shutdown concluído');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Suporte a --run-once para testes manuais
  if (process.argv.includes('--run-once')) {
    logger.info('Modo --run-once: executando um único tick');
    scheduler.start();
    // Aguarda o tick terminar (simplificado — em produção use evento)
    await new Promise<void>((resolve) => setTimeout(resolve, 30000));
    scheduler.stop();
    return;
  }

  scheduler.start();
  logger.info('Agent rodando. CTRL+C para parar.');
}

main().catch((error) => {
  logger.error('Erro fatal na inicialização', { error });
  process.exit(1);
});
```

### Comandos de deploy

```bash
# 1. Clone o repositório alvo
mkdir -p workspace
git clone https://TOKEN@github.com/OWNER/REPO workspace/repo

# 2. Configure as variáveis de ambiente
cp .env.example .env
# edite .env com seus valores reais

# 3. Suba o ChromaDB e o Ollama
docker-compose up -d chromadb ollama

# 4. Baixe o modelo de embedding (faz uma vez — fica salvo em ./ollama-data)
docker-compose exec ollama ollama pull nomic-embed-text

# 5. Indexe o repositório
docker-compose --profile indexer run --rm indexer

# 6. Verifique que o índice foi criado
docker-compose exec chromadb curl -s http://localhost:8000/api/v1/collections

# 7. Suba o agente
docker-compose up -d agent

# 8. Acompanhe os logs
docker-compose logs -f agent
```

### O que testar (teste de fumaça completo)

```bash
# Saúde do ChromaDB
curl http://localhost:8000/api/v1/heartbeat
# Esperado: {"nanosecond heartbeat": NUMERO}

# Logs do agente mostrando startup
docker-compose logs agent | head -20
# Esperado: "GitHub Agent iniciando...", "Scheduler iniciado"

# Crie uma issue de teste real e aguarde o próximo tick
gh issue create \
  --title "Test: adicionar linha no .gitignore" \
  --body "Adicione a linha '*.tmp' no final do .gitignore" \
  --label "agent-ready"

# Acompanhe o processamento
docker-compose logs -f agent
```

---

## Resumo da Jornada de Aprendizado

Ao completar estas 10 etapas, você construiu um sistema que demonstra os principais conceitos de agent engineering:

**RAG (Retrieval-Augmented Generation)**
- Indexação semântica de código com embeddings especializados (`nomic-embed-text` via Ollama local)
- Chunking por arquivo com preservação de contexto
- Retrieval por similaridade cosseno para injeção no prompt

**Prompt Engineering**
- Separação clara entre system prompt (identidade) e user prompt (tarefa)
- Grounding com contexto do projeto (CLAUDE.md/README.md)
- Sinalizadores de status explícitos para comunicação estruturada

**Tool Use e Agent Loop**
- Claude Code SDK como executor de ações no filesystem
- `dangerouslySkipPermissions` em ambiente controlado
- Observabilidade via logging de cada ferramenta executada

**Arquitetura de Agentes**
- Idempotência via labels de estado (nunca processa a mesma issue duas vezes)
- Isolamento de falhas com `Promise.allSettled`
- Graceful degradation para rate limits
- Loop de clarificação para ambiguidade genuína

**Infraestrutura**
- Docker multi-stage para imagem de produção enxuta
- ChromaDB como vector store local
- Scheduler com lock para evitar concorrência acidental

