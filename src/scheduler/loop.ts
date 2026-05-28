import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GitHubClient } from '../github/client.js';
import { AgentRunner } from '../agent/runner.js';
import { RagEngine } from '../rag/retriever.js';
import pLimit from 'p-limit';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RateLimitState } from '../agent/rate-limit-state.js';

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

    try {
      await this.processReadyIssues();
      await this.resumeWaitingForAgentIssues();
    } catch (error) {
      logger.error('Erro inesperado no tick', { error });
    } finally {
      this.isRunning = false;
      this.tickStartedAt = null;
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
}
