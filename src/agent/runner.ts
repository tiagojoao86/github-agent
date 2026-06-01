import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { env } from '../config/env.js';
import { createContextLogger } from '../utils/logger.js';
import { GitHubClient } from '../github/client.js';
import { RagEngine } from '../rag/retriever.js';
import { PromptBuilder } from './prompt-builder.js';
import { isRateLimitError, parseRetryAfter } from './rate-limit.js';
import { GitHubIssue } from '../github/model/gihub-issue.js';
import { simpleGit, SimpleGit } from 'simple-git';
import { eventBus, TokenUsage } from '../ui/event-bus.js';

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
    const git: SimpleGit = simpleGit(env.REPO_LOCAL_PATH);
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
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt, false);
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
    return this.runAgentSession(issue, branchName, prompt.systemPrompt, prompt.userPrompt, true);
  }

  private async runAgentSession(
    issue: GitHubIssue,
    branchName: string,
    systemPrompt: string,
    userPrompt: string,
    isResume = false
  ): Promise<AgentResult> {
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
          cwd: env.REPO_LOCAL_PATH,
          abortController: controller,
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

      log.info(
        `Sessão concluída. Tokens: ${running.input} input + ${running.output} output`
      );

      // Analisa o output do agente para determinar o resultado
      const result = await this.parseAgentResult(issue, branchName, fullAgentOutput, log, isResume);
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
    isResume = false
  ): Promise<AgentResult> {
    // Procura pelos sinalizadores de status no output do agente
    if (agentOutput.includes('AGENT_STATUS: SUCCESS')) {
      log.info('Agente sinalizou sucesso — verificando branch e PR');

      const git = simpleGit(env.REPO_LOCAL_PATH);
      const log_result = await git.log({ from: `origin/${env.BASE_BRANCH}`, to: branchName }).catch(() => null);

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

      // Se já existe PR para esta branch, reutiliza em vez de criar novo
      const existingPr = await this.github.findPRForBranch(branchName).catch(() => null);
      if (existingPr) {
        log.info(`PR #${existingPr.number} já existe — reutilizando`);
        return { type: 'success', prUrl: existingPr.url };
      }

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
    const git = simpleGit(env.REPO_LOCAL_PATH);
    const commits = await git.log({ from: `origin/${env.BASE_BRANCH}`, to: branchName }).catch(() => null);
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

## Solicitar alterações

Se a implementação não estiver correcta:
1. Comente na **issue #${issue.number}** explicando o que está errado
2. Remova o label \`agent-done\` da issue
3. Adicione o label \`waiting-for-human\`

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
  }): AsyncIterable<any> {
    const claudeBin = process.env.CLAUDE_BIN ?? '/app/node_modules/.bin/claude';

    const spawnEnv = { ...process.env };

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
