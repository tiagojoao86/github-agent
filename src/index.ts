import { env } from "./config/env.js";
import { GitHubClient } from "./github/client.js";
import { RagEngine } from "./rag/retriever.js";
import { AgentRunner } from "./agent/runner.js";
import { Scheduler } from "./scheduler/loop.js";
import { logger } from "./utils/logger.js";
import { startUIServer } from "./ui/server.js";

async function main(): Promise<void> {
  startUIServer(env.UI_PORT);

  logger.info('Github Agent iniciando...', {
    repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    pollInterval: env.POLL_INTERVAL_MINUTES,
    maxIssuesPerRun: env.MAX_ISSUES_PER_RUN
  });

  const github = new GitHubClient();
  await github.init();

  await github.ensureLabelsExists();
  await github.resetStuckProcessingIssues();

  const ragEngine = new RagEngine();
  const agentRunner = new AgentRunner(github, ragEngine);

  const scheduler = new Scheduler(github, ragEngine, agentRunner);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Sinal ${signal} recebido - aguardando tick atual terminar...`);
    scheduler.stop();
    await scheduler.waitForIdle();
    logger.info('Shutdown concluído');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (process.argv.includes('--run-once')) {
    logger.info('Modo --run-once: executando um único tick');
    scheduler.start();

    await new Promise<void>((resolve) => setTimeout(resolve, 30000));
    scheduler.stop();
    return;
  }

  scheduler.start();
  logger.info('Agent rodando. CTRL+C para parar.');

}

main().catch((error) => {
  logger.error('Erro fatal na inicialização', { error });
  process.exit(1);
});
