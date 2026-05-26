import { Octokit } from "@octokit/rest";
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GitHubIssue } from "./model/gihub-issue.js";
import { GitHubComment } from "./model/github-comment.js";
import { PullRequestResult } from "./model/pull-request-result.js";

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private botLogin: string = '';

  constructor() {
    this.octokit = new Octokit({ auth: env.GITHUB_TOKEN });
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
  }

  async init(): Promise<void> {
    const { data } = await this.octokit.users.getAuthenticated();
    this.botLogin = data.login;
    logger.info(`GitHub Client iniciado. Bot login: ${this.botLogin}`);
  }

  async getIssuesWithLabel(label: string): Promise<GitHubIssue[]> {
    logger.debug(`Buscando issue com label: ${label}`);
    const response = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: env.MAX_ISSUES_PER_RUN,
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
      { name: env.LABEL_DONE, color: '0e8a16', description: 'PR ceriado pelo agente' },
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

  async createBranch(issueNumber: number): Promise<string> {
    const branchName = this.getBranchName(issueNumber);

    // Obtém o SHA do HEAD da branch default (main/master)
    const { data: repo } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    const defaultBranch = repo.default_branch;

    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${defaultBranch}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
      logger.info(`Branch criada: ${branchName} a partir de ${defaultBranch}`);
    } catch (error: unknown) {
      if (isOctokitError(error) && error.status === 422) {
        logger.warn(`Branch ${branchName} já existe — reutilizando`);
      } else {
        throw error;
      }
    }

    return branchName;
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
    body: string
  ): Promise<PullRequestResult> {
    const { data: repo } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });

    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: branchName,
      base: repo.default_branch,
    });

    logger.info(`PR #${pr.number} criado: ${pr.html_url}`);
    return { number: pr.number, url: pr.html_url };
  }

}


function isOctokitError(error: unknown): error is { status: number; message: string } {
  return typeof error === 'object' && error !== null && 'status' in error;
}
