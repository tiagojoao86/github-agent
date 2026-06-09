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

// Tempo máximo que um tick pode durar: AGENT_TIMEOUT + 3 min de folga para operações GitHub
const MAX_TICK_DURATION_MS = (parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10)) + 3 * 60 * 1000;

export class Scheduler {
  private isRunning = false;
  private tickStartedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private github: GitHubClient;
  private ragEngine: RagEngine;
  private agentRunner: AgentRunner;
  private rateLimitState: RateLimitState;

  constructor(github: GitHubClient,
    ragEngine: RagEngine,
    agentRunner: AgentRunner) {
    this.github = github;
    this.ragEngine = ragEngine;
    this.agentRunner = agentRunner;
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
      await this.processAgentPlanIssues();
      await this.processApprovedPlans();
      await this.checkQueuedIssues();
      await this.checkPlanCompletion();
      await this.processReadyIssues();
      await this.resumeWaitingForAgentIssues();
      await this.processAgentReviewIssues();
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

  // Retoma issues marcadas manualmente com 'waiting-for-agent' após resposta humana.
  // O humano troca o label de 'waiting-for-human' para 'waiting-for-agent' depois de responder,
  // tornando o handoff explícito e eliminando a detecção automática frágil.
  private async resumeWaitingForAgentIssues(): Promise<void> {
    const issues = await this.github.getIssuesWithLabel(env.LABEL_WAITING_AGENT, 50);

    if (issues.length === 0) {
      logger.info('Nenhuma issue com waiting-for-agent encontrada');
      return;
    }

    logger.info(`Retomando ${issues.length} issue(s) com waiting-for-agent`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) =>
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
        await this.github.removeLabel(issue.number, env.LABEL_WAITING).catch(() => {});
        await this.github.removeLabel(issue.number, env.LABEL_WAITING_AGENT).catch(() => {});
        issueLogger.info(`Issue resolvida. PR: ${result.prUrl}`);
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
        issueLogger.info('Agente fez pergunta — aguardando resposta humana');
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
        issueLogger.info('Rate limit atingido — issue devolvida para fila');
      }
    } catch (error) {
      // Em caso de erro inesperado, devolve para agent-ready para nova tentativa
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      issueLogger.error('Erro inesperado no processamento', { message, stack });
      try {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
      } catch {
        // Best-effort
      }
    }
  }

  private async resumeIssueWithIsolation(issue: GitHubIssue): Promise<void> {
    try {
      await this.github.transitionLabel(issue.number, env.LABEL_WAITING_AGENT, env.LABEL_PROCESSING);

      // Lê todos os comentários para dar ao agente o histórico completo da conversa
      const allComments = await this.github.getComments(issue.number);
      const conversationContext = allComments
        .map((c) => `${c.isBot ? '🤖 Agente' : `👤 ${c.author}`}: ${c.body}`)
        .join('\n\n---\n\n');

      const result = await this.agentRunner.resumeIssue(issue, conversationContext);

      if (result.type === 'success') {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_DONE);
        // Remove labels residuais de iterações anteriores
        await this.github.removeLabel(issue.number, env.LABEL_WAITING).catch(() => {});
        await this.github.removeLabel(issue.number, env.LABEL_WAITING_AGENT).catch(() => {});
        logger.info(`Issue #${issue.number} resolvida. PR: ${result.prUrl}`);
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        // Volta para waiting-for-agent: o humano não precisa fazer nada, o agente retomará sozinho
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING_AGENT);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`Erro ao retomar issue #${issue.number}`, { message, stack });
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING_AGENT)
        .catch(() => { });
    }
  }

  private async processAgentPlanIssues(): Promise<void> {
    const issues = await this.github.getIssuesWithLabel(env.LABEL_PLAN);
    if (issues.length === 0) {
      logger.debug('Nenhuma issue com agent-plan encontrada');
      return;
    }
    logger.info(`Criando plano para ${issues.length} issue(s) com agent-plan`);
    const limit = pLimit(1);
    await Promise.allSettled(issues.map(issue => limit(() => this.createPlanWithIsolation(issue))));
  }

  private async createPlanWithIsolation(issue: GitHubIssue): Promise<void> {
    try {
      await this.github.transitionLabel(issue.number, env.LABEL_PLAN, env.LABEL_PROCESSING);
      const result = await this.agentRunner.createPlan(issue);

      if (result.type === 'plan-ready') {
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_REVIEW);
        const planBranch = `agent/plan-${issue.number}`;
        const planMd = await this.github.readFileFromBranch(planBranch, '.agent-plan.md');
        const body =
          `📋 **Plano gerado para revisão**\n\n` +
          (planMd ? planMd : '(ver `.agent-plan.md` na branch `' + planBranch + '`)') +
          `\n\n---\nRevisado o plano:\n- Se estiver correto: adicione o label \`agent-plan-approved\`\n` +
          `- Se quiser mudanças: comente o que alterar e recoloque o label \`agent-plan\``;
        await this.github.postComment(issue.number, body);
        logger.info(`Plano #${issue.number} pronto para revisão`);
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Erro ao criar plano para issue #${issue.number}`, { message });
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_PLAN).catch(() => {});
    }
  }

  private async processApprovedPlans(): Promise<void> {
    const issues = await this.github.getIssuesWithLabel(env.LABEL_PLAN_APPROVED);
    if (issues.length === 0) return;
    logger.info(`Ativando ${issues.length} plano(s) aprovado(s)`);
    const limit = pLimit(1);
    await Promise.allSettled(issues.map(issue => limit(() => this.activatePlanWithIsolation(issue))));
  }

  private async activatePlanWithIsolation(planIssue: GitHubIssue): Promise<void> {
    try {
      await this.github.transitionLabel(planIssue.number, env.LABEL_PLAN_APPROVED, env.LABEL_PROCESSING);

      const planBranch = `agent/plan-${planIssue.number}`;
      const planJson = await this.github.readFileFromBranch(planBranch, '.agent-plan.json');
      if (!planJson) {
        throw new Error(`.agent-plan.json não encontrado na branch ${planBranch}`);
      }

      const plan = JSON.parse(planJson) as PlanFile;
      const stepToIssue = new Map<number, number>();

      // Cria issues filhas em ordem, resolvendo dependências pelo mapa step→issueNumber
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
        const issueNum = await this.github.createIssue(step.title, body, [env.LABEL_QUEUED]);
        stepToIssue.set(step.step, issueNum);
        logger.info(`Issue #${issueNum} criada: ${step.title}`);
      }

      // Ativa as issues sem dependências
      for (const [stepNum, issueNum] of stepToIssue) {
        const step = plan.steps.find(s => s.step === stepNum)!;
        if (step.dependsOn.length === 0) {
          await this.github.transitionLabel(issueNum, env.LABEL_QUEUED, env.LABEL_READY);
          logger.info(`Issue #${issueNum} ativada (sem dependências)`);
        }
      }

      await this.github.transitionLabel(planIssue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_RUNNING);
      await this.github.postComment(
        planIssue.number,
        `🚀 **Plano ativado!** ${plan.steps.length} tarefas criadas.\n\n` +
        `As tarefas sem dependências já estão em \`agent-ready\`. ` +
        `As demais serão ativadas automaticamente à medida que as dependências forem mergeadas.`
      );
      logger.info(`Plano #${planIssue.number} ativado com ${plan.steps.length} tarefas`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Erro ao ativar plano #${planIssue.number}`, { message });
      await this.github.transitionLabel(planIssue.number, env.LABEL_PROCESSING, env.LABEL_PLAN_APPROVED).catch(() => {});
    }
  }

  private async checkQueuedIssues(): Promise<void> {
    const queued = await this.github.getIssuesWithLabel(env.LABEL_QUEUED, 50);
    if (queued.length === 0) return;

    logger.info(`Verificando ${queued.length} issue(s) em fila`);

    for (const issue of queued) {
      const meta = parsePlanMetadata(issue.body ?? '');
      if (!meta || meta.dependsOn.length === 0) continue;

      try {
        const results = await Promise.all(
          meta.dependsOn.map(depNum =>
            this.github.isPRMergedIntoBranch(depNum, meta.planBranch)
          )
        );

        if (results.every(Boolean)) {
          await this.github.transitionLabel(issue.number, env.LABEL_QUEUED, env.LABEL_READY);
          logger.info(`Issue #${issue.number} desbloqueada — todas as dependências mergeadas`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Erro ao verificar dependências da issue #${issue.number}`, { message });
      }
    }
  }

  private async checkPlanCompletion(): Promise<void> {
    const running = await this.github.getIssuesWithLabel(env.LABEL_PLAN_RUNNING, 20);
    if (running.length === 0) return;

    for (const planIssue of running) {
      try {
        const children = await this.github.getChildIssues(planIssue.number);
        if (children.length === 0) continue;

        const allDone = children.every(c => c.labels.includes(env.LABEL_DONE));
        if (!allDone) {
          const done = children.filter(c => c.labels.includes(env.LABEL_DONE)).length;
          logger.debug(`Plano #${planIssue.number}: ${done}/${children.length} etapas concluídas`);
          continue;
        }

        const planBranch = `agent/plan-${planIssue.number}`;

        // Gera o spec final e commita na plan branch antes de criar o PR
        await this.commitPlanSpec(planIssue.number, planBranch, planIssue.title);

        const existingPr = await this.github.findPRForBranch(planBranch).catch(() => null);
        if (existingPr) {
          logger.info(`PR final do plano #${planIssue.number} já existe (#${existingPr.number})`);
          await this.github.transitionLabel(planIssue.number, env.LABEL_PLAN_RUNNING, env.LABEL_DONE);
          continue;
        }

        const pr = await this.github.createPullRequest(
          planIssue.number,
          planBranch,
          `feat: ${planIssue.title} (resolve #${planIssue.number})`,
          this.buildPlanPrBody(planIssue, children),
          env.BASE_BRANCH
        );

        await this.github.transitionLabel(planIssue.number, env.LABEL_PLAN_RUNNING, env.LABEL_DONE);
        await this.github.postComment(
          planIssue.number,
          `✅ **Plano concluído!** Todas as ${children.length} etapas foram implementadas.\n\n` +
          `**PR final:** ${pr.url}\n\n` +
          `O spec completo foi salvo em \`docs/specs/\` e viajará junto com o merge.`
        );
        logger.info(`Plano #${planIssue.number} concluído. PR final: ${pr.url}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Erro ao verificar conclusão do plano #${planIssue.number}`, { message });
      }
    }
  }

  private async commitPlanSpec(planIssueNumber: number, planBranch: string, title: string): Promise<void> {
    const [planMd, contextMd] = await Promise.all([
      this.github.readFileFromBranch(planBranch, '.agent-plan.md'),
      this.github.readFileFromBranch(planBranch, '.agent-context.md'),
    ]);

    if (!planMd && !contextMd) {
      logger.warn(`Plano #${planIssueNumber}: sem .agent-plan.md nem .agent-context.md — spec não gerado`);
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
    await this.github.commitFileToBranch(
      planBranch,
      specPath,
      sections.join('\n\n'),
      `docs: spec da feature "${title}" (#${planIssueNumber})`
    );
    logger.info(`Spec salvo em ${specPath} na branch ${planBranch}`);
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

  private async processAgentReviewIssues(): Promise<void> {
    const issues = await this.github.getIssuesWithLabel(env.LABEL_REVIEW, 50);

    if (issues.length === 0) {
      logger.debug('Nenhuma issue com agent-review encontrada');
      return;
    }

    logger.info(`Aplicando review em ${issues.length} issue(s) com agent-review`);

    const limit = pLimit(1);
    await Promise.allSettled(
      issues.map((issue) => limit(() => this.reviewIssueWithIsolation(issue)))
    );
  }

  private async reviewIssueWithIsolation(issue: GitHubIssue): Promise<void> {
    try {
      await this.github.transitionLabel(issue.number, env.LABEL_REVIEW, env.LABEL_PROCESSING);

      // Encontra o PR associado à branch desta issue
      const branchName = this.github.getBranchName(issue.number);
      const pr = await this.github.findPRForBranch(branchName).catch(() => null);

      if (!pr) {
        logger.warn(`Issue #${issue.number} tem agent-review mas não tem PR aberto — devolvendo label`);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW);
        return;
      }

      // Busca os comentários de review do PR
      const reviewComments = await this.github.getPRReviewComments(pr.number);

      if (reviewComments.length === 0) {
        logger.warn(`PR #${pr.number} não tem comentários de review — removendo label agent-review`);
        await this.github.removeLabel(issue.number, env.LABEL_PROCESSING);
        await this.github.removeLabel(issue.number, env.LABEL_REVIEW).catch(() => {});
        return;
      }

      const result = await this.agentRunner.reviewIssue(issue, pr.number, reviewComments);

      if (result.type === 'success') {
        await this.github.removeLabel(issue.number, env.LABEL_PROCESSING);
        await this.github.addLabel(issue.number, env.LABEL_DONE).catch(() => {});
        logger.info(`Issue #${issue.number} — review aplicado. PR: ${result.prUrl}`);

        // Marca todas as threads do PR como resolvidas
        const threadIds = await this.github.getUnresolvedThreadIds(pr.number).catch(() => []);
        for (const threadId of threadIds) {
          await this.github.resolveReviewThread(threadId).catch(() => {});
        }
        if (threadIds.length > 0) {
          logger.info(`${threadIds.length} thread(s) do PR #${pr.number} marcadas como resolvidas`);
        }
      } else if (result.type === 'needs-clarification') {
        await this.github.postComment(issue.number, result.question);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_WAITING);
      } else if (result.type === 'rate-limit') {
        this.rateLimitState.recordHit(result.retryAfterMs);
        await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`Erro ao aplicar review na issue #${issue.number}`, { message, stack });
      await this.github.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_REVIEW)
        .catch(() => {});
    }
  }
}
