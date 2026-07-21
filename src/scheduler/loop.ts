import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { eventBus } from '../ui/event-bus.js';
import { GitHubClient } from '../github/client.js';
import { AgentRunner } from '../agent/runner.js';
import { RagEngine } from '../rag/retriever.js';
import pLimit from 'p-limit';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RateLimitState } from '../agent/rate-limit-state.js';
import { parsePlanMetadata, PlanFile } from '../github/model/plan-metadata.js';

export type ProjectContext = {
  label: string;
  github: GitHubClient;
  ragEngine: RagEngine;
  agentRunner: AgentRunner;
};

// Tempo máximo que um tick pode durar: AGENT_TIMEOUT + 3 min de folga para operações GitHub
const MAX_TICK_DURATION_MS = (parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10)) + 3 * 60 * 1000;

export class Scheduler {
  private isRunning = false;
  private tickStartedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private projects: ProjectContext[];
  private rateLimitState: RateLimitState;

  constructor(projects: ProjectContext[]) {
    this.projects = projects;
    this.rateLimitState = new RateLimitState();
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

  async waitForIdle(): Promise<void> {
    while (this.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async tick(): Promise<void> {
    // Watchdog: se o tick anterior ficou preso (ex: sem internet), força o reset após o timeout máximo
    if (this.isRunning) {
      const stuck = this.tickStartedAt !== null && Date.now() - this.tickStartedAt > MAX_TICK_DURATION_MS;
      if (stuck) {
        logger.error(`Tick anterior preso há ${Math.round((Date.now() - this.tickStartedAt!) / 1000)}s — forçando reset`);
        this.isRunning = false;
        this.tickStartedAt = null;
      } else {
        logger.warn('Tick pulado: iteração anterior ainda em andamento');
        return;
      }
    }

    if (this.rateLimitState.isInCooldown()) {
      const remainingSec = Math.ceil(this.rateLimitState.getCooldownRemaingMs() / 1000);
      logger.info(`Tick pulado: em cooldown por rate limit (${remainingSec}s restantes)`);
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.tickStartedAt = startTime;
    logger.info('=== Início do tick ===');
    eventBus.publish({ type: 'tick_start', timestamp: new Date().toISOString() });

    try {
      for (const project of this.projects) {
        if (this.rateLimitState.isInCooldown()) {
          const remainingSec = Math.ceil(this.rateLimitState.getCooldownRemaingMs() / 1000);
          logger.info(`[${project.label}] Pulando: rate limit ativo (${remainingSec}s restantes)`);
          break;
        }
        logger.info(`=== Projeto: ${project.label} ===`);
        await this.tickForProject(project);
      }
    } catch (error) {
      logger.error('Erro inesperado no tick', { error });
    } finally {
      this.isRunning = false;
      this.tickStartedAt = null;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`=== Fim do tick (${elapsed}s) ===`);
      eventBus.publish({ type: 'tick_end', elapsed: `${elapsed}s`, timestamp: new Date().toISOString() });
    }
  }

  private async tickForProject(project: ProjectContext): Promise<void> {
    await this.processAgentPlanIssues(project);
    await this.processApprovedPlans(project);
    await this.checkQueuedIssues(project);
    await this.checkPlanCompletion(project);
    await this.processReadyIssues(project);
    await this.resumeWaitingForAgentIssues(project);
    await this.processCodeReviewIssues(project);
    await this.processAgentReviewIssues(project);
  }

  // Processa issues marcadas como 'agent-ready'
  private async processReadyIssues(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_READY);

    if (issues.length === 0) {
      logger.debug(`[${label}] Nenhuma issue com agent-ready encontrada`);
      return;
    }

    logger.info(`[${label}] Processando ${issues.length} issue(s) com agent-ready`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) => limit(() => this.processIssueWithIsolation(project, issue)))
    );
  }

  private async resumeWaitingForAgentIssues(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_WAITING_AGENT, 50);

    if (issues.length === 0) {
      logger.debug(`[${label}] Nenhuma issue com waiting-for-agent encontrada`);
      return;
    }

    logger.info(`[${label}] Retomando ${issues.length} issue(s) com waiting-for-agent`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) => limit(() => this.resumeIssueWithIsolation(project, issue)))
    );
  }

  private async processIssueWithIsolation(project: ProjectContext, issue: GitHubIssue): Promise<void> {
    const { github, agentRunner, label } = project;
    const ctx = { issueNumber: issue.number, project: label };

    try {
      logger.info(`[${label}] Iniciando: #${issue.number} "${issue.title}"`);
      await github.transitionLabel(issue.number, env.LABEL_READY, env.LABEL_PROCESSING);

      const result = await agentRunner.processIssue(issue);

      if (result.type === 'success') {
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_CODE_REVIEW);
        await github.removeLabel(issue.number, env.LABEL_WAITING).catch(() => {});
        await github.removeLabel(issue.number, env.LABEL_WAITING_AGENT).catch(() => {});
        logger.info(`[${label}] Issue #${issue.number} implementada — aguardando code review. PR: ${result.prUrl}`);
      } else if (result.type === 'needs-clarification') {
        await github.postComment(issue.number, result.question);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
        logger.info(`[${label}] Issue #${issue.number}: agente fez pergunta — aguardando resposta`);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
        logger.info(`[${label}] Issue #${issue.number}: rate limit — devolvida para fila`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${label}] Erro inesperado na issue #${issue.number}`, { message, stack, ...ctx });
      await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY).catch(() => {});
    }
  }

  private async resumeIssueWithIsolation(project: ProjectContext, issue: GitHubIssue): Promise<void> {
    const { github, agentRunner, label } = project;
    try {
      await github.transitionLabel(issue.number, env.LABEL_WAITING_AGENT, env.LABEL_PROCESSING);

      const allComments = await github.getComments(issue.number);
      const conversationContext = allComments
        .map((c) => `${c.isBot ? '🤖 Agente' : `👤 ${c.author}`}: ${c.body}`)
        .join('\n\n---\n\n');

      const result = await agentRunner.resumeIssue(issue, conversationContext);

      if (result.type === 'success') {
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_CODE_REVIEW);
        await github.removeLabel(issue.number, env.LABEL_WAITING).catch(() => {});
        await github.removeLabel(issue.number, env.LABEL_WAITING_AGENT).catch(() => {});
        logger.info(`[${label}] Issue #${issue.number} retomada e implementada — aguardando code review. PR: ${result.prUrl}`);
      } else if (result.type === 'needs-clarification') {
        await github.postComment(issue.number, result.question);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING_AGENT);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${label}] Erro ao retomar issue #${issue.number}`, { message, stack });
      await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING_AGENT).catch(() => {});
    }
  }

  private async processAgentPlanIssues(project: ProjectContext): Promise<void> {
    const { github, agentRunner, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_PLAN);
    if (issues.length === 0) {
      logger.debug(`[${label}] Nenhuma issue com agent-plan encontrada`);
      return;
    }
    logger.info(`[${label}] Criando plano para ${issues.length} issue(s)`);
    const limit = pLimit(1);
    await Promise.allSettled(issues.map(issue => limit(() => this.createPlanWithIsolation(project, issue))));
  }

  private async createPlanWithIsolation(project: ProjectContext, issue: GitHubIssue): Promise<void> {
    const { github, agentRunner, label } = project;
    try {
      await github.transitionLabel(issue.number, env.LABEL_PLAN, env.LABEL_PROCESSING);
      const result = await agentRunner.createPlan(issue);

      if (result.type === 'plan-ready') {
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_REVIEW);
        const planBranch = `agent/plan-${issue.number}`;
        const planMd = await github.readFileFromBranch(planBranch, '.agent-plan.md');
        const body =
          `📋 **Plano gerado para revisão**\n\n` +
          (planMd ? planMd : '(ver `.agent-plan.md` na branch `' + planBranch + '`)') +
          `\n\n---\nRevisado o plano:\n- Se estiver correto: adicione o label \`agent-plan-approved\`\n` +
          `- Se quiser mudanças: comente o que alterar e recoloque o label \`agent-plan\``;
        await github.postComment(issue.number, body);
        logger.info(`[${label}] Plano #${issue.number} pronto para revisão`);
      } else if (result.type === 'needs-clarification') {
        await github.postComment(issue.number, result.question);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${label}] Erro ao criar plano #${issue.number}`, { message });
      await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN).catch(() => {});
    }
  }

  private async processApprovedPlans(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_PLAN_APPROVED);
    if (issues.length === 0) return;
    logger.info(`[${label}] Ativando ${issues.length} plano(s) aprovado(s)`);
    const limit = pLimit(1);
    await Promise.allSettled(issues.map(issue => limit(() => this.activatePlanWithIsolation(project, issue))));
  }

  private async activatePlanWithIsolation(project: ProjectContext, planIssue: GitHubIssue): Promise<void> {
    const { github, label } = project;
    try {
      await github.transitionLabel(planIssue.number, env.LABEL_PLAN_APPROVED, env.LABEL_PROCESSING);

      const planBranch = `agent/plan-${planIssue.number}`;
      const planJson = await github.readFileFromBranch(planBranch, '.agent-plan.json');
      if (!planJson) {
        throw new Error(`.agent-plan.json não encontrado na branch ${planBranch}`);
      }

      const plan = JSON.parse(planJson) as PlanFile;
      const stepToIssue = new Map<number, number>();

      for (const step of plan.steps) {
        const resolvedDeps = step.dependsOn
          .map(s => stepToIssue.get(s))
          .filter((n): n is number => n !== undefined);

        const metadata = JSON.stringify({
          planIssue: planIssue.number,
          planBranch,
          dependsOn: resolvedDeps,
          step: step.step,
          totalSteps: plan.steps.length,
        });

        const testSection = step.testInstructions
          ? `\n\n## Como testar\n\n${step.testInstructions}`
          : '';
        const body = `${step.body}${testSection}\n\n<!-- agent-plan-meta: ${metadata} -->`;
        const issueNum = await github.createIssue(step.title, body, [env.LABEL_QUEUED]);
        stepToIssue.set(step.step, issueNum);
        logger.info(`[${label}] Issue #${issueNum} criada: ${step.title}`);
      }

      for (const [stepNum, issueNum] of stepToIssue) {
        const step = plan.steps.find(s => s.step === stepNum)!;
        if (step.dependsOn.length === 0) {
          await github.transitionLabel(issueNum, env.LABEL_QUEUED, env.LABEL_READY);
          logger.info(`[${label}] Issue #${issueNum} ativada (sem dependências)`);
        }
      }

      await github.transitionLabel(planIssue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_RUNNING);
      await github.postComment(
        planIssue.number,
        `🚀 **Plano ativado!** ${plan.steps.length} tarefas criadas.\n\n` +
        `As tarefas sem dependências já estão em \`agent-ready\`. ` +
        `As demais serão ativadas automaticamente à medida que as dependências forem mergeadas.`
      );
      logger.info(`[${label}] Plano #${planIssue.number} ativado com ${plan.steps.length} tarefas`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${label}] Erro ao ativar plano #${planIssue.number}`, { message });
      await github.transitionLabel(planIssue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_APPROVED).catch(() => {});
    }
  }

  private async checkQueuedIssues(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const queued = await github.getIssuesWithLabel(env.LABEL_QUEUED, 50);
    if (queued.length === 0) return;

    logger.info(`[${label}] Verificando ${queued.length} issue(s) em fila`);

    for (const issue of queued) {
      const meta = parsePlanMetadata(issue.body ?? '');
      if (!meta || meta.dependsOn.length === 0) continue;

      try {
        const results = await Promise.all(
          meta.dependsOn.map(depNum => github.isPRMergedIntoBranch(depNum, meta.planBranch))
        );

        if (results.every(Boolean)) {
          await github.transitionLabel(issue.number, env.LABEL_QUEUED, env.LABEL_READY);
          logger.info(`[${label}] Issue #${issue.number} desbloqueada — todas as dependências mergeadas`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${label}] Erro ao verificar dependências da issue #${issue.number}`, { message });
      }
    }
  }

  private async checkPlanCompletion(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const running = await github.getIssuesWithLabel(env.LABEL_PLAN_RUNNING, 20);
    if (running.length === 0) return;

    for (const planIssue of running) {
      try {
        const children = await github.getChildIssues(planIssue.number);
        if (children.length === 0) continue;

        const allDone = children.every(c => c.labels.includes(env.LABEL_DONE));
        if (!allDone) {
          const done = children.filter(c => c.labels.includes(env.LABEL_DONE)).length;
          logger.debug(`[${label}] Plano #${planIssue.number}: ${done}/${children.length} etapas concluídas`);
          continue;
        }

        const planBranch = `agent/plan-${planIssue.number}`;
        await this.commitPlanSpec(github, label, planIssue.number, planBranch, planIssue.title);

        const existingPr = await github.findPRForBranch(planBranch).catch(() => null);
        if (existingPr) {
          logger.info(`[${label}] PR final do plano #${planIssue.number} já existe (#${existingPr.number})`);
          await github.transitionLabel(planIssue.number, env.LABEL_PLAN_RUNNING, env.LABEL_DONE);
          continue;
        }

        const pr = await github.createPullRequest(
          planIssue.number,
          planBranch,
          `feat: ${planIssue.title} (resolve #${planIssue.number})`,
          this.buildPlanPrBody(planIssue, children),
          github.config.baseBranch
        );

        await github.transitionLabel(planIssue.number, env.LABEL_PLAN_RUNNING, env.LABEL_DONE);
        await github.postComment(
          planIssue.number,
          `✅ **Plano concluído!** Todas as ${children.length} etapas foram implementadas.\n\n` +
          `**PR final:** ${pr.url}\n\n` +
          `O spec completo foi salvo em \`docs/specs/\` e viajará junto com o merge.`
        );
        logger.info(`[${label}] Plano #${planIssue.number} concluído. PR final: ${pr.url}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${label}] Erro ao verificar conclusão do plano #${planIssue.number}`, { message });
      }
    }
  }

  private async commitPlanSpec(github: GitHubClient, label: string, planIssueNumber: number, planBranch: string, title: string): Promise<void> {
    const [planMd, contextMd] = await Promise.all([
      github.readFileFromBranch(planBranch, '.agent-plan.md'),
      github.readFileFromBranch(planBranch, '.agent-context.md'),
    ]);

    if (!planMd && !contextMd) {
      logger.warn(`[${label}] Plano #${planIssueNumber}: sem .agent-plan.md nem .agent-context.md — spec não gerado`);
      return;
    }

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    const sections: string[] = [
      `# Spec: ${title}\n\n_Issue de plano: #${planIssueNumber}_`,
    ];
    if (planMd) sections.push(`## Plano original\n\n${planMd}`);
    if (contextMd) sections.push(`## Histórico de implementação\n\n${contextMd}`);

    const specPath = `docs/specs/plan-${planIssueNumber}-${slug}.md`;
    await github.commitFileToBranch(planBranch, specPath, sections.join('\n\n'), `docs: spec da feature "${title}" (#${planIssueNumber})`);
    logger.info(`[${label}] Spec salvo em ${specPath}`);
  }

  private buildPlanPrBody(planIssue: GitHubIssue, children: GitHubIssue[]): string {
    const childList = children
      .map(c => `- Closes #${c.number} — ${c.title}`)
      .join('\n');

    return `## Resolução Automática — Plano Multi-etapa

Este PR consolida as implementações de todas as etapas do plano.

Closes #${planIssue.number}

## Etapas implementadas

${childList}

## Spec

O spec completo deste plano foi salvo em \`docs/specs/\` neste PR e ficará disponível para consulta futura pelo RAG.

---
*Gerado automaticamente pelo GitHub Agent*`;
  }

  private async processCodeReviewIssues(project: ProjectContext): Promise<void> {
    const { github, agentRunner, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_CODE_REVIEW, 50);

    if (issues.length === 0) {
      logger.debug(`[${label}] Nenhuma issue com agent-code-review encontrada`);
      return;
    }

    logger.info(`[${label}] Iniciando code review de ${issues.length} issue(s)`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) => limit(() => this.codeReviewWithIsolation(project, issue)))
    );
  }

  private async codeReviewWithIsolation(project: ProjectContext, issue: GitHubIssue): Promise<void> {
    const { github, agentRunner, label } = project;
    try {
      await github.transitionLabel(issue.number, env.LABEL_CODE_REVIEW, env.LABEL_PROCESSING);

      const result = await agentRunner.codeReviewIssue(issue);

      if (result.type === 'code-review-approved') {
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_DONE);
        await github.postComment(
          issue.number,
          `✅ **Code review aprovado pelo agente revisor.**\n\nA implementação resolve corretamente os requisitos da issue. O PR está pronto para revisão humana.`
        );
        logger.info(`[${label}] Issue #${issue.number}: code review aprovado → agent-done`);
      } else if (result.type === 'code-review-rejected') {
        const allComments = await github.getComments(issue.number);
        const rejectionCount = allComments.filter(c =>
          c.body?.includes('🔴 **Code review rejeitado')
        ).length;

        await github.postComment(
          issue.number,
          `🔴 **Code review rejeitado pelo agente revisor.**\n\nForam encontrados os seguintes problemas:\n\n${result.problems}\n\nA issue foi devolvida para reimplementação.`
        );

        if (rejectionCount >= 2) {
          await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
          await github.postComment(
            issue.number,
            `⚠️ **Intervenção humana necessária.**\n\nO agente rejeitou esta implementação ${rejectionCount + 1} vezes consecutivas sem conseguir resolver os problemas. Por favor, revise manualmente os comentários de rejeição acima, ajuste os requisitos na issue se necessário, e aplique a label \`agent-ready\` para tentar novamente.`
          );
          logger.info(`[${label}] Issue #${issue.number}: code review rejeitado ${rejectionCount + 1}x → escalado para humano`);
        } else {
          await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
          logger.info(`[${label}] Issue #${issue.number}: code review rejeitado (tentativa ${rejectionCount + 1}) → agent-ready`);
        }
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_CODE_REVIEW);
        logger.info(`[${label}] Issue #${issue.number}: rate limit durante code review — devolvida`);
      } else {
        // resultado inesperado — devolve para code review para tentar novamente
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_CODE_REVIEW);
        logger.warn(`[${label}] Issue #${issue.number}: resultado inesperado no code review: ${result.type}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${label}] Erro no code review da issue #${issue.number}`, { message });
      await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_CODE_REVIEW).catch(() => {});
    }
  }

  private async processAgentReviewIssues(project: ProjectContext): Promise<void> {
    const { github, label } = project;
    const issues = await github.getIssuesWithLabel(env.LABEL_REVIEW, 50);

    if (issues.length === 0) {
      logger.debug(`[${label}] Nenhuma issue com agent-review encontrada`);
      return;
    }

    logger.info(`[${label}] Aplicando review em ${issues.length} issue(s)`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) => limit(() => this.reviewIssueWithIsolation(project, issue)))
    );
  }

  private async reviewIssueWithIsolation(project: ProjectContext, issue: GitHubIssue): Promise<void> {
    const { github, agentRunner, label } = project;
    try {
      await github.transitionLabel(issue.number, env.LABEL_REVIEW, env.LABEL_PROCESSING);

      const branchName = github.getBranchName(issue.number);
      const pr = await github.findPRForBranch(branchName).catch(() => null);

      if (!pr) {
        logger.warn(`[${label}] Issue #${issue.number} tem agent-review mas não tem PR — devolvendo label`);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW);
        return;
      }

      const reviewComments = await github.getPRReviewComments(pr.number);

      if (reviewComments.length === 0) {
        logger.warn(`[${label}] PR #${pr.number} sem comentários de review — removendo label`);
        await github.removeLabel(issue.number, env.LABEL_PROCESSING);
        await github.removeLabel(issue.number, env.LABEL_REVIEW).catch(() => {});
        return;
      }

      const result = await agentRunner.reviewIssue(issue, pr.number, reviewComments);

      if (result.type === 'success') {
        await github.addLabel(issue.number, env.LABEL_CODE_REVIEW).catch(() => {});
        await github.removeLabel(issue.number, env.LABEL_PROCESSING).catch(() => {});
        logger.info(`[${label}] Issue #${issue.number} — review aplicado, enviando para code review automático. PR: ${result.prUrl}`);

        const threadIds = await github.getUnresolvedThreadIds(pr.number).catch(() => []);
        for (const threadId of threadIds) {
          await github.resolveReviewThread(threadId).catch(() => {});
        }
        if (threadIds.length > 0) {
          logger.info(`[${label}] ${threadIds.length} thread(s) do PR #${pr.number} resolvidas`);
        }
      } else if (result.type === 'needs-clarification') {
        await github.postComment(issue.number, result.question);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`[${label}] Erro ao aplicar review na issue #${issue.number}`, { message, stack });
      await github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW).catch(() => {});
    }
  }
}
