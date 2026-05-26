import { readFile } from 'fs/promises';
import { join } from 'path';
import { env } from '../config/env.js';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RetrievalResult } from '../rag/retriever.js';
import { logger } from '../utils/logger.js';
import { systemPrompt } from './prompt-base.js';
import { formatConversationForPrompt, buildConversationHistory } from './conversation.js';
import type { GitHubComment } from '../github/model/github-comment.js';

export interface AgentPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export class PromptBuilder {

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
      projectContext, ragSection, issue, branchName, previousConversation: conversationFormatted,
    });

    return { systemPrompt, userPrompt };
  }

  // Tenta ler o CLAUDE.md do repositório para incluir como grounding.
  // Se não existir, usa o README.md como fallback.
  private async getProjectContext(repoPath: string): Promise<string> {
    const candidates = ['CLAUDE.md', 'README.md', 'CONTRIBUTING.md'];

    for (const filename of candidates) {
      try {
        const content = await readFile(join(repoPath, filename), 'utf-8');
        // Trunca para não dominar o contexto (máx ~2000 tokens)
        const truncated = content.length > 3000 ? content.substring(0, 3000) + '\n...[leia o arquivo completo se necessário]' : content;
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
    return systemPrompt;
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
        // Mostra apenas o início — o agente lê o arquivo completo quando necessário
        const preview = chunk.content.length > 1500
          ? chunk.content.slice(0, 1500) + '\n... [arquivo truncado — leia completo se necessário]'
          : chunk.content;
        return `### [${idx + 1}] ${chunk.filePath} (relevância: ${scorePercent}%)\n\n\`\`\`\n${preview}\n\`\`\``;
      })
      .join('\n\n');
  }
}
