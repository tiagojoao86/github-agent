import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GitHubClient } from '../github/client.js';
import { AgentRunner } from '../agent/runner.js';
import { RagEngine } from '../rag/retriever.js';
import pLimit from 'p-limit';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { RateLimitState } from '../agent/rate-limit-state.js';

export class Scheduler {
  private isRunning = false;
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

  private async tick(): Promise<void> {
    // Lock simples: não inicia nova iteração se ainda está processando
    if (this.isRunning) {
      logger.warn('Tick pulado: iteração anterior ainda em andamento');
      return;
    }

    if (this.rateLimitState.isInCooldown()) {
      const remainingSec = Math.ceil(this.rateLimitState.getCooldownRemaingMs() / 1000);
      logger.info(`Tick pulado: em cooldown por rate limit (${remainingSec}s restantes)`);
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
        this.rateLimitState.recordHit(result.retryAfterMs);
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
        .catch(() => { });
    }
  }
}
