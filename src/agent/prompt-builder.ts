import { readFile } from 'fs/promises';
import { join } from 'path';
import { env } from '../config/env.js';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RetrievalResult } from '../rag/retriever.js';
import { logger } from '../utils/logger.js';
import { buildIssueSystemPrompt, buildPlanSystemPrompt } from './prompt-base.js';
import { execSync } from 'child_process';
import { PlanMetadata } from '../github/model/plan-metadata.js';
import { formatConversationForPrompt, buildConversationHistory } from './conversation.js';
import type { GitHubComment } from '../github/model/github-comment.js';
import type { PRReviewComment } from '../github/model/pr-review-comment.js';
import { ProjectConfig } from '../config/project-config.js';

export interface AgentPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export class PromptBuilder {
  constructor(private config: ProjectConfig) {}

  async buildForPlanCreation(
    issue: GitHubIssue,
    repoPath: string,
    planBranch: string,
    existingPlan: string | null,
    conversationHistory: string
  ): Promise<AgentPrompt> {
    const isRevision = existingPlan !== null;

    let userPrompt = `## ${isRevision ? 'Revisão do Plano' : 'Nova Solicitação de Plano'}

**Issue #${issue.number}:** ${issue.title}
**Branch do plano:** \`${planBranch}\`

**Descrição original:**
${issue.body ?? '(Sem descrição)'}
`;

    if (isRevision) {
      userPrompt += `
## Plano atual (para revisão)

\`\`\`json
${existingPlan}
\`\`\`

## Feedback e pedidos de mudança

${conversationHistory}

## Instruções

Revise o plano levando em conta o feedback acima.
Atualize os arquivos \`.agent-plan.json\` e \`.agent-plan.md\` na branch \`${planBranch}\`.
Sinalize com AGENT_STATUS: PLAN_READY quando terminar.`;
    } else {
      userPrompt += `
## Instruções

1. Analise o que precisa ser implementado
2. Quebre em etapas coesas — cada etapa = uma mudança completa e testável isoladamente
3. Identifique as dependências entre etapas
4. Escreva \`.agent-plan.json\` e \`.agent-plan.md\` na branch \`${planBranch}\`
5. Sinalize com AGENT_STATUS: PLAN_READY`;
    }

    return {
      systemPrompt: buildPlanSystemPrompt(planBranch, repoPath),
      userPrompt,
    };
  }

  private async getPlanContext(repoPath: string, planBranch: string): Promise<string | null> {
    try {
      const content = execSync(
        `git -C "${repoPath}" show "origin/${planBranch}:.agent-context.md"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return `=== Contexto do Plano (.agent-context.md da branch ${planBranch}) ===\n${content}`;
    } catch {
      return null;
    }
  }

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
    branchName: string,
    planMeta?: PlanMetadata | null
  ): Promise<AgentPrompt> {
    const projectContext = await this.getProjectContext(repoPath);
    const ragSection = this.formatRagContext(ragContext);
    const planContext = planMeta ? await this.getPlanContext(repoPath, planMeta.planBranch) : null;

    const userPrompt = this.buildUserPrompt({
      projectContext,
      ragSection,
      issue,
      branchName,
      previousConversation: null,
      planContext,
      planMeta,
    });

    return { systemPrompt: this.buildSystemPrompt(), userPrompt };
  }

  async buildForResumedIssue(
    issue: GitHubIssue,
    ragContext: RetrievalResult,
    repoPath: string,
    branchName: string,
    humanResponse: string,
    planMeta?: PlanMetadata | null
  ): Promise<AgentPrompt> {
    const projectContext = await this.getProjectContext(repoPath);
    const ragSection = this.formatRagContext(ragContext);
    const planContext = planMeta ? await this.getPlanContext(repoPath, planMeta.planBranch) : null;

    const userPrompt = this.buildUserPrompt({
      projectContext,
      ragSection,
      issue,
      branchName,
      previousConversation: humanResponse,
      planContext,
      planMeta,
    });

    return { systemPrompt: this.buildSystemPrompt(), userPrompt };
  }

  async buildForPRReview(
    issue: GitHubIssue,
    ragContext: RetrievalResult,
    repoPath: string,
    branchName: string,
    prNumber: number,
    reviewComments: PRReviewComment[]
  ): Promise<AgentPrompt> {
    const projectContext = await this.getProjectContext(repoPath);
    const ragSection = this.formatRagContext(ragContext);
    const reviewSection = this.formatReviewComments(reviewComments);

    const userPrompt = `## Contexto do Projeto

${projectContext}

## Arquivos Relevantes (recuperados por busca semântica)

${ragSection}

## Issue Original

**Issue #${issue.number}:** ${issue.title}
**Descrição:** ${issue.body ?? '(Sem descrição)'}

## Instruções de Execução

O PR #${prNumber} já existe para esta issue. A tua tarefa é **aplicar as correções pedidas nos comentários de review** abaixo.

1. Vá para a branch correta:
   \`\`\`bash
   cd ${this.config.localPath}
   git checkout ${branchName}
   \`\`\`

2. Leia os arquivos mencionados nos comentários e aplica as correções

3. Faça commit das alterações:
   \`\`\`bash
   git add -A
   git commit -m "fix: apply PR review feedback for issue #${issue.number}"
   \`\`\`

4. **Não cries um novo PR** — o PR #${prNumber} já existe e será atualizado automaticamente com o push.

5. Sinaliza o resultado com AGENT_STATUS conforme as instruções do sistema.

## Comentários de Review a Aplicar

${reviewSection}`;

    return { systemPrompt: this.buildSystemPrompt(), userPrompt };
  }

  private formatReviewComments(comments: PRReviewComment[]): string {
    if (comments.length === 0) {
      return '(Nenhum comentário de review encontrado)';
    }

    const inline = comments.filter(c => c.type === 'inline');
    const general = comments.filter(c => c.type === 'general');
    const sections: string[] = [];

    if (inline.length > 0) {
      sections.push('### Comentários inline (por arquivo)');
      for (const c of inline) {
        const location = c.line ? `\`${c.path}\` linha ${c.line}` : `\`${c.path}\``;
        sections.push(`**${location}** — *${c.author}*\n> ${c.body.replace(/\n/g, '\n> ')}`);
      }
    }

    if (general.length > 0) {
      sections.push('### Comentários gerais');
      for (const c of general) {
        sections.push(`**${c.author}:**\n> ${c.body.replace(/\n/g, '\n> ')}`);
      }
    }

    return sections.join('\n\n');
  }

  private buildSystemPrompt(): string {
    return buildIssueSystemPrompt(this.config.localPath);
  }

  private buildUserPrompt(params: {
    projectContext: string;
    ragSection: string;
    issue: GitHubIssue;
    branchName: string;
    previousConversation: string | null;
    planContext?: string | null;
    planMeta?: PlanMetadata | null;
  }): string {
    const { projectContext, ragSection, issue, branchName, previousConversation, planContext, planMeta } = params;

    let prompt = `## Contexto do Projeto

${projectContext}
`;

    if (planContext) {
      prompt += `
## Contexto do Plano de Execução

Esta issue faz parte de um plano multi-etapa (issue pai #${planMeta!.planIssue}).
Etapa ${planMeta!.step} de ${planMeta!.totalSteps}.

${planContext}

**Importante:** implemente APENAS o que está descrito nesta etapa. Não antecipe o trabalho das próximas etapas.

`;
    }

    prompt += `## Arquivos Relevantes (recuperados por busca semântica)

Os seguintes arquivos foram identificados como mais relevantes para esta issue.
Use-os como ponto de partida, mas leia outros arquivos se necessário.

${ragSection}

## Issue a Resolver

**Repositório:** ${this.config.owner}/${this.config.repo}
**Issue #${issue.number}:** ${issue.title}
**URL:** ${issue.htmlUrl}

**Descrição:**
${issue.body ?? '(Sem descrição)'}

## Instruções de Execução

1. Vá para a branch correta:
   \`\`\`bash
   cd ${this.config.localPath}
   git checkout ${branchName}
   \`\`\`

2. Leia e entenda os arquivos relevantes listados acima

3. Implemente a solução

4. Faça commit:
   \`\`\`bash
   git add -A
   git commit -m "fix: resolve issue #${issue.number} - ${issue.title}"
   \`\`\`
`;

    if (planMeta) {
      prompt += `
5. Atualize o .agent-context.md na branch \`${planMeta.planBranch}\` com o que foi implementado:
   \`\`\`bash
   git fetch origin
   git show origin/${planMeta.planBranch}:.agent-context.md > /tmp/ctx.md
   # Adicione no final do ficheiro uma secção "### ✅ Etapa ${planMeta.step} — ${issue.title}"
   # com o que foi implementado
   git stash
   git checkout ${planMeta.planBranch}
   # edite .agent-context.md
   git add .agent-context.md && git commit -m "chore: atualiza contexto etapa ${planMeta.step}"
   git push origin ${planMeta.planBranch}
   git checkout ${branchName}
   git stash pop 2>/dev/null || true
   \`\`\`

6. Sinalize o resultado com AGENT_STATUS conforme as instruções do sistema`;
    } else {
      prompt += `
5. Sinalize o resultado com AGENT_STATUS conforme as instruções do sistema`;
    }

    if (previousConversation) {
      prompt += `

## Histórico da Conversa e Feedback

Esta issue já foi processada anteriormente. O histórico completo de comentários está abaixo.
Lê com atenção — pode conter feedback sobre o que está errado na implementação atual ou
instruções adicionais do utilizador que ainda não foram aplicadas.

A branch \`${branchName}\` pode já ter commits ou até um PR aberto. O teu trabalho é
**aplicar o feedback do utilizador** fazendo novos commits nessa branch.

${previousConversation}

Após aplicar as alterações pedidas, faz commit e sinaliza AGENT_STATUS: SUCCESS.`;
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
