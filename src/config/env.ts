import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[Config] Variável de ambiente obrigatória não definida: ${name}
       Copie .env.example para .env e preencha os valores`
    );
  }

  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  OLLAMA_URL: optionalEnv('OLLAMA_URL', 'http://localhost:11434'),


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
  EMBEDDING_MODEL: optionalEnv('EMBEDDING_MODEL', 'nomic-embed-text'),

  // UI Dashboard
  UI_PORT: parseInt(optionalEnv('UI_PORT', '3000'), 10),

  // Branch base para criação de branches e PRs
  BASE_BRANCH: optionalEnv('BASE_BRANCH', 'dev'),

  // Labels de controle (não mude sem atualizar o GitHub também)
  LABEL_READY: 'agent-ready',
  LABEL_PROCESSING: 'agent-processing',
  LABEL_WAITING: 'waiting-for-human',
  LABEL_WAITING_AGENT: 'waiting-for-agent',
  LABEL_DONE: 'agent-done',
} as const;

if (env.POLL_INTERVAL_MINUTES < 1) {
  throw new Error('[Config] POLL_INTERVAL_MINUTES deve ser >= 1');
}

if (env.MAX_ISSUES_PER_RUN < 1 || env.MAX_ISSUES_PER_RUN > 10) {
  throw new Error('[Config] MAX_ISSUES_PER_RUN deve ser >= 1');
}

