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

    // Output ambíguo — verificar estado real da branch antes de pedir ajuda
    log.warn('Agente não sinalizou status corretamente. Output (últimos 500 chars):');
    log.warn(agentOutput.slice(-500));

    // 1. Há PR aberto ou fechado para esta branch?
    const pr = await this.github.findPRForBranch(branchName).catch(() => null);
    if (pr) {
      const stateLabel = pr.state === 'open' ? 'aberto' : 'fechado';
      log.info(`Branch tem PR #${pr.number} (${pr.state}) — sessão foi interrompida após criação`);
      return {
        type: 'needs-clarification',
        question:
          `🤖 A sessão foi interrompida mas encontrei o PR #${pr.number} (${stateLabel}): ${pr.url}\n\n` +
          `Por favor, verifique se a implementação está correcta e faça merge se estiver.`,
      };
    }

    // 2. Há commits na branch?
    const git = simpleGit(env.REPO_LOCAL_PATH);
    const commits = await git.log({ from: 'origin/main', to: branchName }).catch(() => null);
    if (commits && commits.total > 0) {
      log.info(`Branch tem ${commits.total} commit(s) mas sem PR — sessão interrompida a meio`);
      return {
        type: 'needs-clarification',
        question:
          `🤖 A sessão foi interrompida. Encontrei ${commits.total} commit(s) na branch \`${branchName}\` mas sem PR.\n\n` +
          `Responda com **"continuar"** para criar o PR com o que foi implementado, ou **"recomeçar"** para que eu reanalise a issue do zero.`,
      };
    }

    // 3. Sem PR e sem commits — nada foi feito
    log.info('Branch sem commits — sessão interrompida antes de qualquer implementação');
    return {
      type: 'needs-clarification',
      question:
        `🤖 A sessão foi interrompida antes de qualquer implementação na branch \`${branchName}\`.\n\n` +
        `Responda com **"recomeçar"** para que eu tente novamente.`,
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
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

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
