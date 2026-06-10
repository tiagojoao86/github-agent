import { env } from "./config/env.js";
import { loadProjects, deriveCollectionName, projectLabel } from "./config/project-config.js";
import { GitHubClient } from "./github/client.js";
import { RagEngine } from "./rag/retriever.js";
import { AgentRunner } from "./agent/runner.js";
import { Scheduler, ProjectContext } from "./scheduler/loop.js";
import { logger } from "./utils/logger.js";
import { startUIServer } from "./ui/server.js";

async function main(): Promise<void> {
  startUIServer(env.UI_PORT);

  const projectConfigs = loadProjects();
  logger.info(`Github Agent iniciando com ${projectConfigs.length} projeto(s)`, {
    projects: projectConfigs.map(p => projectLabel(p)),
    pollInterval: env.POLL_INTERVAL_MINUTES,
  });

  const projects: ProjectContext[] = [];

  for (const config of projectConfigs) {
    const label = projectLabel(config);
    logger.info(`[${label}] Inicializando...`);

    const github = new GitHubClient(config);
    await github.init();
    await github.ensureLabelsExists();
    await github.resetStuckProcessingIssues();

    const collectionName = deriveCollectionName(config);
    const ragEngine = new RagEngine(collectionName, config.localPath);
    const agentRunner = new AgentRunner(github, ragEngine, config);

    projects.push({ label, github, ragEngine, agentRunner });
    logger.info(`[${label}] Pronto`);
  }

  const scheduler = new Scheduler(projects);

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
