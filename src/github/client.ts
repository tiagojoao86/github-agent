import { Octokit } from "@octokit/rest";
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GitHubIssue } from "./model/gihub-issue.js";
import { GitHubComment } from "./model/github-comment.js";
import { PullRequestResult } from "./model/pull-request-result.js";
import { PRReviewComment } from "./model/pr-review-comment.js";

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private botLogin: string = '';

  constructor() {
    this.octokit = new Octokit({ auth: env.GITHUB_TOKEN, request: { timeout: 30000 } });
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
  }

  async init(): Promise<void> {
    const { data } = await this.octokit.users.getAuthenticated();
    this.botLogin = data.login;
    logger.info(`GitHub Client iniciado. Bot login: ${this.botLogin}`);
  }

  async getIssuesWithLabel(label: string, limit = env.MAX_ISSUES_PER_RUN): Promise<GitHubIssue[]> {
    logger.debug(`Buscando issue com label: ${label}`);
    const response = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: limit,
      sort: 'created',
      direction: 'asc',
    });

    return response.data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
    }));
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const { data } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber
    });

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      labels: data.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
      htmlUrl: data.html_url,
      createdAt: data.created_at
    };
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });

      logger.debug(`Label '${label}' adicionado à issue #${issueNumber}`);
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 442) {
        logger.debug(`Label '${label}' ja exsite na issue #${issueNumber}`);
        return;
      }
      throw error;
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
      logger.debug(`Label '${label}' removido da issue #${issueNumber}`)
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async transitionLabel(issueNumber: number, fromLabel: string, toLabel: string): Promise<void> {
    await this.addLabel(issueNumber, toLabel);
    await this.removeLabel(issueNumber, fromLabel);
  }

  async ensureLabelsExists(): Promise<void> {
    const labelsToCreate = [
      { name: env.LABEL_READY, color: '0075ca', description: 'Pronto para o agente processar' },
      { name: env.LABEL_PROCESSING, color: 'e4e669', description: 'Sendo processdado pelo agente' },
      { name: env.LABEL_WAITING, color: 'd93f0b', description: 'Aguardando resposta humana' },
      { name: env.LABEL_WAITING_AGENT, color: 'f29513', description: 'Humano respondeu — aguardando agente retomar' },
      { name: env.LABEL_DONE, color: '0e8a16', description: 'PR criado pelo agente' },
      { name: env.LABEL_REVIEW,        color: '7057ff', description: 'Revisar comentários do PR' },
      { name: env.LABEL_PLAN,          color: '0057e7', description: 'Criar plano de execução' },
      { name: env.LABEL_PLAN_REVIEW,   color: '5319e7', description: 'Plano aguardando revisão' },
      { name: env.LABEL_PLAN_APPROVED, color: '0e8a16', description: 'Plano aprovado — criar tarefas' },
      { name: env.LABEL_PLAN_RUNNING,  color: 'e6ac00', description: 'Plano em execução' },
      { name: env.LABEL_QUEUED,        color: 'cccccc', description: 'Aguardando dependências' },
    ];

    for (const labelDef of labelsToCreate) {
      try {
        await this.octokit.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          ...labelDef
        });
        logger.info(`Label criado: ${labelDef.name}`);
      } catch (error: unknown) {
        if (isOctokitError(error) && error.status === 422) {
          continue;
        }
        throw error;
      }
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.octokit.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
    logger.debug(`Issue #${issueNumber} fechada`);
  }

  async postComment(issueNumber: number, body: string): Promise<number> {
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: body + '\n<!-- github-agent-bot -->',
    });
    logger.info(`Comentário postado na issue #${issueNumber}`);
    return data.id;
  }

  async getComments(issueNumber: number): Promise<GitHubComment[]> {
    const { data } = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    return data.map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      author: comment.user?.login ?? 'unknown',
      createdAt: comment.created_at,
      isBot: comment.body?.includes('<!-- github-agent-bot -->') ?? false,
    }));
  }

  // Retorna os comentários humanos feitos APÓS o último comentário do bot.
  // Isso indica que o humano respondeu à pergunta do agente.
  async getHumanRepliesAfterBot(issueNumber: number): Promise<GitHubComment[]> {
    const comments = await this.getComments(issueNumber);

    // Encontra o índice do último comentário do bot
    let lastBotIndex = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].isBot) {
        lastBotIndex = i;
        break;
      }
    }

    if (lastBotIndex === -1) return []; // Bot nunca comentou

    // Retorna comentários humanos após o bot
    return comments
      .slice(lastBotIndex + 1)
      .filter((c) => !c.isBot);
  }


  getBranchName(issueNumber: number): string {
    return `agent/issue-${issueNumber}`;
  }

  async createBranch(issueNumber: number, baseBranch = env.BASE_BRANCH): Promise<string> {
    const branchName = this.getBranchName(issueNumber);

    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${baseBranch}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
      logger.info(`Branch criada: ${branchName} a partir de ${baseBranch}`);
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 422) {
        logger.warn(`Branch ${branchName} já existe — reutilizando`);
      } else {
        throw error;
      }
    }

    return branchName;
  }

  async createPlanBranch(planIssueNumber: number): Promise<string> {
    const branchName = `agent/plan-${planIssueNumber}`;

    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${env.BASE_BRANCH}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
      logger.info(`Plan branch criada: ${branchName} a partir de ${env.BASE_BRANCH}`);
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 422) {
        logger.warn(`Plan branch ${branchName} já existe — reutilizando`);
      } else {
        throw error;
      }
    }

    return branchName;
  }

  async readFileFromBranch(branch: string, filePath: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: branch,
      });
      if (Array.isArray(data) || data.type !== 'file') return null;
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const { data } = await this.octokit.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      labels,
    });
    logger.info(`Issue criada: #${data.number} — ${title}`);
    return data.number;
  }

  async getChildIssues(planIssueNumber: number): Promise<GitHubIssue[]> {
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `repo:${this.owner}/${this.repo} "planIssue":${planIssueNumber} is:issue`,
      per_page: 50,
    });
    return data.items.map(issue => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
      htmlUrl: issue.html_url,
      createdAt: issue.created_at,
    }));
  }

  async isPRMergedIntoBranch(issueNumber: number, planBranch: string): Promise<boolean> {
    const branchName = this.getBranchName(issueNumber);
    const { data } = await this.octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${branchName}`,
      base: planBranch,
      state: 'closed',
      per_page: 1,
    });
    return data.length > 0 && data[0].merged_at !== null;
  }

  async commitFileToBranch(branch: string, filePath: string, content: string, message: string): Promise<void> {
    let sha: string | undefined;
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(data) && data.type === 'file') {
        sha = data.sha;
      }
    } catch {
      // arquivo ainda não existe
    }

    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo: this.repo,
      path: filePath,
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha,
    });
    logger.info(`Arquivo ${filePath} commitado na branch ${branch}`);
  }

  async findPRForBranch(branchName: string): Promise<{ number: number; url: string; state: string } | null> {
    const { data } = await this.octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${branchName}`,
      state: 'all',
      per_page: 1,
    });
    if (data.length === 0) return null;
    return { number: data[0].number, url: data[0].html_url, state: data[0].state };
  }

  async resetStuckProcessingIssues(): Promise<void> {
    const stuck = await this.getIssuesWithLabel(env.LABEL_PROCESSING);
    if (stuck.length === 0) return;
    logger.warn(`Recuperando ${stuck.length} issue(s) presas em agent-processing`);
    for (const issue of stuck) {
      await this.transitionLabel(issue.number, env.LABEL_PROCESSING, env.LABEL_READY);
      logger.info(`Issue #${issue.number} voltou para agent-ready`);
    }
  }

  async createPullRequest(
    issueNumber: number,
    branchName: string,
    title: string,
    body: string,
    base = env.BASE_BRANCH
  ): Promise<PullRequestResult> {
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: branchName,
      base,
    });

    logger.info(`PR #${pr.number} criado: ${pr.html_url}`);
    return { number: pr.number, url: pr.html_url };
  }

  async getPRReviewComments(prNumber: number): Promise<PRReviewComment[]> {
    const comments: PRReviewComment[] = [];

    // Comentários inline (em linhas específicas do diff)
    const { data: inlineComments } = await this.octokit.pulls.listReviewComments({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    for (const c of inlineComments) {
      if (c.body.trim()) {
        comments.push({
          id: c.id,
          author: c.user?.login ?? 'unknown',
          body: c.body,
          type: 'inline',
          path: c.path,
          line: c.line ?? c.original_line ?? undefined,
        });
      }
    }

    // Reviews gerais (CHANGES_REQUESTED ou COMMENTED com corpo)
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    for (const r of reviews) {
      if (r.body?.trim() && (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED')) {
        comments.push({
          id: r.id,
          author: r.user?.login ?? 'unknown',
          body: r.body,
          type: 'general',
        });
      }
    }

    return comments;
  }

  async getUnresolvedThreadIds(prNumber: number): Promise<string[]> {
    const result = await this.octokit.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: { nodes: { id: string; isResolved: boolean }[] };
        };
      };
    }>(`
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes { id isResolved }
            }
          }
        }
      }
    `, { owner: this.owner, repo: this.repo, prNumber });

    return result.repository.pullRequest.reviewThreads.nodes
      .filter(t => !t.isResolved)
      .map(t => t.id);
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.octokit.graphql(`
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id }
        }
      }
    `, { threadId });
  }

  async postSuccessComment(
    issueNumber: number,
    summary: string | null,
    prUrl: string,
    filesChanged: string[]
  ): Promise<void> {
    const summarySection = summary ? `\n\n${summary}` : '';

    const fileSection = filesChanged.length > 0
      ? `\n\n**Arquivos alterados (${filesChanged.length}):**\n` +
        filesChanged.map(f => `- \`${f}\``).join('\n')
      : '';

    const body =
      `✅ **Implementação concluída**${summarySection}${fileSection}\n\n` +
      `**PR:** ${prUrl}`;

    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });

    logger.info(`Comentário de conclusão postado na issue #${issueNumber}`);
  }

  async postReviewAppliedComment(
    issueNumber: number,
    summary: string | null,
    prUrl: string,
    filesChanged: string[]
  ): Promise<void> {
    const summarySection = summary ? `\n\n${summary}` : '';

    const fileSection = filesChanged.length > 0
      ? `\n\n**Arquivos alterados (${filesChanged.length}):**\n` +
        filesChanged.map(f => `- \`${f}\``).join('\n')
      : '';

    const body =
      `🔄 **Review aplicado**${summarySection}${fileSection}\n\n` +
      `As correções solicitadas foram aplicadas. Por favor, revisite o PR: ${prUrl}`;

    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });

    logger.info(`Comentário de review aplicado postado na issue #${issueNumber}`);
  }

}


function isOctokitError(error: unknown): error is { status: number; message: string } {
  return typeof error === 'object' && error !== null && 'status' in error;
}
