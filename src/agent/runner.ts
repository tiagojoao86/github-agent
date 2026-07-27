import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { env } from '../config/env.js';
import { createContextLogger } from '../utils/logger.js';
import { GitHubClient } from '../github/client.js';
import { RagEngine } from '../rag/retriever.js';
import { PromptBuilder } from './prompt-builder.js';
import { isRateLimitError, parseRetryAfter } from './rate-limit.js';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { PRReviewComment } from '../github/model/pr-review-comment.js';
import { parsePlanMetadata } from '../github/model/plan-metadata.js';
import { simpleGit, SimpleGit } from 'simple-git';
import { eventBus, TokenUsage } from '../ui/event-bus.js';
import { ProjectConfig, DEFAULT_MODELS } from '../config/project-config.js';

function makeGit(config: ProjectConfig): SimpleGit {
  const token = config.githubToken || env.GITHUB_TOKEN;
  const git = simpleGit(config.localPath);
  return token ? git.env({ ...process.env, GITHUB_TOKEN: token }) : git;
}

export type AgentResult =
  | { type: 'success'; prUrl: string }
  | { type: 'needs-clarification'; question: string }
  | { type: 'rate-limit'; retryAfterMs?: number }
  | { type: 'plan-ready' }
  | { type: 'code-review-approved' }
  | { type: 'code-review-rejected'; problems: string };

export class AgentRunner {
  private github: GitHubClient;
  private ragEngine: RagEngine;
  private promptBuilder: PromptBuilder;
  private config: ProjectConfig;

  constructor(github: GitHubClient, ragEngine: RagEngine, config: ProjectConfig) {
    this.github = github;
    this.ragEngine = ragEngine;
    this.config = config;
    this.promptBuilder = new PromptBuilder(config);
  }

  async processIssue(issue: GitHubIssue): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'process' });

    // Detecta se é issue filha de um plano e ajusta o comportamento
    const planMeta = parsePlanMetadata(issue.body ?? '');
    const baseBranch = planMeta?.planBranch ?? this.config.baseBranch;

    // 1. Cria a branch no GitHub (a partir da plan branch se for filha de plano)
    const branchName = await this.github.createBranch(issue.number, baseBranch);
    log.info(`Branch criada: ${branchName}`);

    // 2. Configura o git local para usar a branch
    const git: SimpleGit = makeGit(this.config);
    await git.fetch('origin');
    await git.checkout(branchName);
    log.info('Git local configurado na branch');

    // 3. Recupera contexto RAG
    const query_text = `${issue.title} ${issue.body ?? ''}`;
    const ragContext = await this.ragEngine.retrieveContext(query_text);
    log.info(`RAG: ${ragContext.chunks.length} chunks recuperados`);

    // 4. Monta o prompt — inclui histórico de comentários se existir (retentativa com feedback)
    const allComments = await this.github.getComments(issue.number);
    const hasHistory = allComments.some(c => c.body?.trim());

    const prompt = hasHistory
      ? await this.promptBuilder.buildForResumedIssueWithHistory(
          issue, ragContext, this.config.localPath, branchName, allComments, planMeta
        )
      : await this.promptBuilder.buildForNewIssue(
          issue, ragContext, this.config.localPath, branchName, planMeta
        );

    // 5. Roda o agente
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt, hasHistory, false, baseBranch, false, this.resolveModel('dev'));
  }

  async createPlan(issue: GitHubIssue): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'plan-creation' });

    const planBranch = await this.github.createPlanBranch(issue.number);
    log.info(`Plan branch: ${planBranch}`);

    const git: SimpleGit = makeGit(this.config);
    await git.fetch('origin');
    await git.checkout(planBranch);

    // Verifica se já existe um plano (modo revisão)
    const existingPlan = await this.github.readFileFromBranch(planBranch, '.agent-plan.json');
    if (existingPlan) {
      log.info('Plano existente detectado — modo revisão');
    }

    // Lê comentários para incluir no contexto (feedback do utilizador)
    const allComments = await this.github.getComments(issue.number);
    const conversationHistory = allComments
      .map(c => `${c.isBot ? '🤖 Agente' : `👤 ${c.author}`}: ${c.body}`)
      .join('\n\n---\n\n');

    const prompt = await this.promptBuilder.buildForPlanCreation(
      issue,
      this.config.localPath,
      planBranch,
      existingPlan,
      conversationHistory
    );

    log.info(existingPlan ? 'Revisando plano' : 'Criando plano');
    return this.runAgentSession(issue, planBranch, prompt.systemPrompt, prompt.userPrompt, false, false, this.config.baseBranch, true, this.resolveModel('plan'));
  }

  async resumeIssue(issue: GitHubIssue, humanResponse: string): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'resume' });

    const planMeta = parsePlanMetadata(issue.body ?? '');
    const baseBranch = planMeta?.planBranch ?? this.config.baseBranch;
    const branchName = this.github.getBranchName(issue.number);

    const git = makeGit(this.config);
    await git.fetch('origin');
    await git.checkout(branchName);

    const queryText = `${issue.title} ${issue.body ?? ''} ${humanResponse}`;
    const ragContext = await this.ragEngine.retrieveContext(queryText);

    const prompt = await this.promptBuilder.buildForResumedIssue(
      issue,
      ragContext,
      this.config.localPath,
      branchName,
      humanResponse,
      planMeta
    );

    log.info('Retomando issue com contexto da resposta humana');
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt, true, false, baseBranch, false, this.resolveModel('dev'));
  }

  async reviewIssue(issue: GitHubIssue, prNumber: number, reviewComments: PRReviewComment[]): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'review' });

    const branchName = this.github.getBranchName(issue.number);

    const git = makeGit(this.config);
    await git.fetch('origin');
    await git.checkout(branchName);

    const queryText = `${issue.title} ${issue.body ?? ''} ${reviewComments.map(c => c.body).join(' ')}`;
    const ragContext = await this.ragEngine.retrieveContext(queryText);

    const prompt = await this.promptBuilder.buildForPRReview(
      issue,
      ragContext,
      this.config.localPath,
      branchName,
      prNumber,
      reviewComments
    );

    log.info(`Aplicando review do PR #${prNumber} (${reviewComments.length} comentários)`);
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt, false, true, undefined, false, this.resolveModel('dev'));
  }

  private resolveModel(stage: 'plan' | 'dev' | 'review'): string {
    return this.config.models?.[stage] ?? DEFAULT_MODELS[stage];
  }

  async codeReviewIssue(issue: GitHubIssue): Promise<AgentResult> {
    const log = createContextLogger({ issueNumber: issue.number, phase: 'code-review' });

    const planMeta = parsePlanMetadata(issue.body ?? '');
    const baseBranch = planMeta?.planBranch ?? this.config.baseBranch;
    const branchName = this.github.getBranchName(issue.number);

    log.info(`Iniciando code review — branch: ${branchName}, base: ${baseBranch}`);

    const branchDiff = await this.github.getBranchDiff(branchName, baseBranch);
    const issueComments = await this.github.getComments(issue.number);
    const prompt = this.promptBuilder.buildForCodeReview(issue, branchDiff, baseBranch, issueComments);
    const model = this.resolveModel('review');

    log.info(`Modelo de review: ${model}`);

    return this.runAgentSession(
      issue, branchName,
      prompt.systemPrompt, prompt.userPrompt,
      false, false, baseBranch, false, model
    );
  }

  private async runAgentSession(
    issue: GitHubIssue,
    branchName: string,
    systemPrompt: string,
    userPrompt: string,
    isResume = false,
    isReview = false,
    prBaseBranch?: string,
    isPlan = false,
    model?: string
  ): Promise<AgentResult> {
    const resolvedBaseBranch = prBaseBranch ?? this.config.baseBranch;
    const log = createContextLogger({ issueNumber: issue.number, phase: 'agent-session' });

    let fullAgentOutput = '';
    const running: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

    const now = () => new Date().toISOString();

    eventBus.publish({ type: 'session_start', issueNumber: issue.number, phase: isResume ? 'resume' : 'process', timestamp: now() });

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
          cwd: this.config.localPath,
          abortController: controller,
          model,
        })) {
          this.logMessage(message, log, issue.number, running);


          // rate_limit_event: só abortar se houver tempo de espera real.
          // Com retryMs: 0 é um evento informativo — o CLI trata internamente e continua.
          if (message.type === 'rate_limit_event') {
            const retryMs = (message.retry_after_ms ?? message.retry_after ?? 0) * 1000;
            log.debug('rate_limit_event recebido', { retryMs, raw: JSON.stringify(message) });
            if (retryMs > 0) {
              log.warn('rate_limit_event com espera real — abortando proactivamente', { retryMs });
              controller.abort();
              break;
            }
            continue;
          }

          if (message.type === 'assistant') {
            const textContent = (message.message?.content ?? [])
              .filter((c: { type: string; text?: string }): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c: { type: 'text'; text: string }) => c.text)
              .join('');
            fullAgentOutput += textContent;
          }

          if (message.message?.usage) {
            const u = message.message.usage;
            const msgUsage: TokenUsage = {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheCreate: u.cache_creation_input_tokens ?? 0,
            };
            running.input    += msgUsage.input;
            running.output   += msgUsage.output;
            running.cacheRead += msgUsage.cacheRead;
            running.cacheCreate += msgUsage.cacheCreate;
            eventBus.publish({
              type: 'agent_tokens',
              issueNumber: issue.number,
              usage: msgUsage,
              runningTotal: { ...running },
              timestamp: now(),
            });
          }

          if (running.input + running.output > env.MAX_TOKENS_PER_SESSION) {
            log.warn('Limite de tokens atingido — abortando sessão');
            controller.abort();
            break;
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // O AbortError do spawn é engolido pelo proc.on('error', () => {}),
      // então o loop termina normalmente. Detectamos o timeout aqui.
      if (controller.signal.aborted) {
        log.warn('Sessão encerrada por timeout — devolvendo para fila');
        eventBus.publish({ type: 'session_end', issueNumber: issue.number, result: 'rate-limit', totalTokens: { ...running }, timestamp: now() });
        return { type: 'rate-limit' };
      }

      log.info('Sessão concluída', {
        tokens: {
          input:       running.input,
          output:      running.output,
          cacheRead:   running.cacheRead,
          cacheCreate: running.cacheCreate,
          newTokens:   running.input + running.output,
          grandTotal:  running.input + running.output + running.cacheRead + running.cacheCreate,
        },
        estimatedCostUSD: (
          (running.input       * 3.00  / 1_000_000) +
          (running.output      * 15.00 / 1_000_000) +
          (running.cacheRead   * 0.30  / 1_000_000) +
          (running.cacheCreate * 3.75  / 1_000_000)
        ).toFixed(4),
      });

      // Analisa o output do agente para determinar o resultado
      const result = await this.parseAgentResult(issue, branchName, fullAgentOutput, log, isResume, isReview, prBaseBranch, isPlan);
      eventBus.publish({ type: 'session_end', issueNumber: issue.number, result: result.type, totalTokens: { ...running }, timestamp: now() });
      return result;
    } catch (error) {
      if (isRateLimitError(error)) {
        log.warn('Rate limit detectado durante sessão do agente');
        eventBus.publish({ type: 'session_end', issueNumber: issue.number, result: 'rate-limit', totalTokens: { ...running }, timestamp: now() });
        return { type: 'rate-limit', retryAfterMs: parseRetryAfter(error) };
      }

      if (error instanceof Error && error.name === 'AbortError') {
        log.warn('Sessão abortada por timeout');
        eventBus.publish({ type: 'session_end', issueNumber: issue.number, result: 'rate-limit', totalTokens: { ...running }, timestamp: now() });
        return { type: 'rate-limit' };
      }

      eventBus.publish({ type: 'session_end', issueNumber: issue.number, result: 'error', totalTokens: { ...running }, timestamp: now() });
      throw error;
    }
  }

  private async parseAgentResult(
    issue: GitHubIssue,
    branchName: string,
    agentOutput: string,
    log: ReturnType<typeof createContextLogger>,
    isResume = false,
    isReview = false,
    prBaseBranch?: string,
    isPlan = false
  ): Promise<AgentResult> {
    const resolvedBaseBranch = prBaseBranch ?? this.config.baseBranch;

    // Code review pelo modelo revisor
    if (agentOutput.includes('REVIEW_STATUS: APPROVED')) {
      log.info('Code review: aprovado');
      return { type: 'code-review-approved' };
    }

    if (agentOutput.includes('REVIEW_STATUS: REJECTED')) {
      const problemsMatch = agentOutput.match(/REVIEW_PROBLEMS:\s*([\s\S]*?)(?:\n\n|$)/);
      const problems = problemsMatch?.[1]?.trim() ?? 'Problemas não especificados pelo revisor.';
      log.info('Code review: rejeitado', { problems });
      return { type: 'code-review-rejected', problems };
    }

    // Plano pronto para revisão
    if (isPlan && agentOutput.includes('AGENT_STATUS: PLAN_READY')) {
      log.info('Plano pronto para revisão');
      return { type: 'plan-ready' };
    }

    // Procura pelos sinalizadores de status no output do agente
    if (agentOutput.includes('AGENT_STATUS: SUCCESS')) {
      log.info('Agente sinalizou sucesso — verificando branch e PR');

      const git = makeGit(this.config);
      const log_result = await git.log({ from: `origin/${resolvedBaseBranch}`, to: branchName }).catch(() => null);

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

      // Ficheiros alterados entre a base e a branch
      const diffOutput = await git
        .diff([`origin/${resolvedBaseBranch}...HEAD`, '--name-only'])
        .catch(() => '');
      const filesChanged = diffOutput.split('\n').map(f => f.trim()).filter(Boolean);

      const summary = this.extractSummary(agentOutput);

      // No modo review o PR já existe — apenas posta comentário e retorna
      if (isReview) {
        const existingPr = await this.github.findPRForBranch(branchName).catch(() => null);
        const prUrl = existingPr?.url ?? `(branch: ${branchName})`;
        log.info(`Review aplicado. PR: ${prUrl}`);
        await this.github.postReviewAppliedComment(issue.number, summary, prUrl, filesChanged)
          .catch(err => log.warn('Falha ao postar comentário de review aplicado', { err }));
        return { type: 'success', prUrl };
      }

      // Se já existe PR para esta branch, reutiliza em vez de criar novo
      const existingPr = await this.github.findPRForBranch(branchName).catch(() => null);
      if (existingPr) {
        log.info(`PR #${existingPr.number} já existe — reutilizando`);
        await this.github.postSuccessComment(issue.number, summary, existingPr.url, filesChanged)
          .catch(err => log.warn('Falha ao postar comentário de conclusão', { err }));
        return { type: 'success', prUrl: existingPr.url };
      }

      const pr = await this.github.createPullRequest(
        issue.number,
        branchName,
        `fix: ${issue.title} (resolve #${issue.number})`,
        this.buildPrBody(issue, agentOutput, filesChanged),
        resolvedBaseBranch
      );

      await this.github.postSuccessComment(issue.number, summary, pr.url, filesChanged)
        .catch(err => log.warn('Falha ao postar comentário de conclusão', { err }));

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

    // Output ambíguo — a sessão terminou sem sinalizar o resultado
    log.warn('Agente não sinalizou status corretamente. Output (últimos 500 chars):');
    log.warn(agentOutput.slice(-500));

    // Trecho final do output para incluir no comentário e dar contexto ao utilizador
    const outputSnippet = agentOutput.slice(-600).trim();
    const snippetBlock = outputSnippet
      ? `\n\n<details><summary>Último output do agente</summary>\n\n${outputSnippet}\n\n</details>`
      : '';

    // Verificar estado real da branch (igual para resume e para processamento inicial)
    // 1. Há PR aberto ou fechado para esta branch?
    const pr = await this.github.findPRForBranch(branchName).catch(() => null);
    if (pr) {
      const stateLabel = pr.state === 'open' ? 'aberto' : 'fechado';
      log.info(`Branch tem PR #${pr.number} (${pr.state}) — sessão foi interrompida após criação`);
      return {
        type: 'needs-clarification',
        question:
          `🤖 A sessão foi interrompida mas encontrei o PR #${pr.number} (${stateLabel}): ${pr.url}\n\n` +
          `Se a implementação estiver correcta, podes fazer merge. Se não estiver, comenta o que falta e coloca o label \`waiting-for-agent\`.` +
          snippetBlock,
      };
    }

    // 2. Há commits na branch?
    const git = makeGit(this.config);
    const commits = await git.log({ from: `origin/${this.config.baseBranch}`, to: branchName }).catch(() => null);
    if (commits && commits.total > 0) {
      const resumeNote = isResume
        ? 'A sessão foi interrompida durante a retoma.'
        : 'A sessão foi interrompida.';
      log.info(`Branch tem ${commits.total} commit(s) mas sem PR — sessão interrompida a meio`);
      return {
        type: 'needs-clarification',
        question:
          `🤖 ${resumeNote} Encontrei ${commits.total} commit(s) na branch \`${branchName}\` mas sem PR.\n\n` +
          `Responda com **"continuar"** para criar o PR com o que foi implementado, ou **"recomeçar"** para que eu reanalise a issue do zero.` +
          snippetBlock,
      };
    }

    // 3. Sem PR e sem commits — nada foi feito
    log.info('Branch sem commits — sessão interrompida antes de qualquer implementação');
    return {
      type: 'needs-clarification',
      question:
        `🤖 A sessão foi interrompida antes de qualquer implementação na branch \`${branchName}\`.\n\n` +
        `Responda com **"recomeçar"** para que eu tente novamente.` +
        snippetBlock,
    };
  }

  private extractSummary(agentOutput: string): string | null {
    const match = agentOutput.match(/AGENT_SUMMARY_START\s*([\s\S]*?)\s*AGENT_SUMMARY_END/);
    return match?.[1]?.trim() ?? null;
  }

  private buildPrBody(issue: GitHubIssue, agentOutput: string, filesChanged: string[]): string {
    const summary = this.extractSummary(agentOutput);

    const summarySection = summary
      ? `## O que foi feito\n\n${summary}\n`
      : `## O que foi feito\n\nO agente analisou a issue e implementou as modificações necessárias.\n`;

    const fileSection = filesChanged.length > 0
      ? `## Arquivos alterados\n\n${filesChanged.map(f => `- \`${f}\``).join('\n')}\n`
      : '';

    return `## Resolução Automática

Este PR foi criado automaticamente pelo agente de issues.

Closes #${issue.number}

${summarySection}
${fileSection}
## Checklist

- [ ] Revisei as mudanças no diff
- [ ] Os testes passam
- [ ] A implementação resolve o problema descrito na issue

## Solicitar alterações

Se a implementação não estiver correcta:
1. Comente na **issue #${issue.number}** explicando o que está errado
2. Remova o label \`agent-done\` da issue
3. Adicione o label \`waiting-for-agent\`

O agente retomará com o contexto do seu feedback e actualizará este PR.

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
    model?: string;
  }): AsyncIterable<any> {
    const claudeBin = process.env.CLAUDE_BIN ?? '/app/node_modules/.bin/claude';

    const spawnEnv = { ...process.env };

    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--append-system-prompt', params.systemPrompt,
    ];

    if (params.model) {
      args.push('--model', params.model);
    }

    const proc = spawn(claudeBin, args, {
      cwd: params.cwd,
      env: spawnEnv,
      signal: params.abortController.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Previne crash por unhandled error — AbortError e ENOENT são tratados no caller
    proc.on('error', () => {});

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
    log: ReturnType<typeof createContextLogger>,
    issueNumber: number,
    _running: TokenUsage,
  ): void {
    const now = () => new Date().toISOString();

    switch (message.type) {
      case 'system':
        log.debug('system message', { subtype: message.subtype });
        break;

      case 'assistant':
        for (const content of (message.message?.content ?? [])) {
          if (content.type === 'thinking' && content.thinking?.length > 0) {
            log.debug(`Thinking (${content.thinking.length} chars)`);
            eventBus.publish({
              type: 'agent_thinking',
              issueNumber,
              thinking: content.thinking,
              tokens: Math.ceil(content.thinking.length / 4),
              timestamp: now(),
            });
          } else if (content.type === 'text' && content.text?.length > 0) {
            log.debug(`Claude: ${content.text.substring(0, 200)}${content.text.length > 200 ? '...' : ''}`);
            eventBus.publish({
              type: 'agent_text',
              issueNumber,
              text: content.text,
              timestamp: now(),
            });
          } else if (content.type === 'tool_use') {
            log.info(`Ferramenta: ${content.name}`, {
              input: JSON.stringify(content.input).substring(0, 200),
            });
            eventBus.publish({
              type: 'agent_tool',
              issueNumber,
              name: content.name,
              input: content.input,
              timestamp: now(),
            });
          }
        }
        break;

      case 'tool': {
        const rawContent = message.content;
        const contentStr = Array.isArray(rawContent)
          ? rawContent.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
          : typeof rawContent === 'string'
          ? rawContent
          : JSON.stringify(rawContent ?? '');
        log.debug('Tool result recebido', { toolUseId: message.tool_use_id, preview: contentStr.substring(0, 100) });
        eventBus.publish({
          type: 'agent_tool_result',
          issueNumber,
          toolUseId: message.tool_use_id ?? '',
          content: contentStr,
          timestamp: now(),
        });
        break;
      }

      default:
        log.debug('Mensagem', { type: message.type });
    }
  }
}
