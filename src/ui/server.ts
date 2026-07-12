import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { eventBus, UIEvent } from './event-bus.js';
import { logger } from '../utils/logger.js';
import { loadProjectsFromFile, saveProjects, loadProjects, ProjectConfig } from '../config/project-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startUIServer(port: number): void {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // ── API de configuração de projetos ──────────────────────────────────────────

  app.get('/api/projects', (_req, res) => {
    try {
      res.json(loadProjects());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/projects', (req, res) => {
    try {
      const project = req.body as ProjectConfig;
      if (!project.owner || !project.repo || !project.localPath || !project.baseBranch) {
        return res.status(400).json({ error: 'Campos obrigatórios: owner, repo, localPath, baseBranch' });
      }
      const projects = loadProjects();
      if (projects.some(p => p.owner === project.owner && p.repo === project.repo)) {
        return res.status(409).json({ error: `Projeto ${project.owner}/${project.repo} já existe` });
      }
      projects.push(project);
      saveProjects(projects);
      logger.info(`[Config] Projeto adicionado: ${project.owner}/${project.repo}`);
      res.status(201).json(project);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/projects/:owner/:repo', (req, res) => {
    try {
      const { owner, repo } = req.params;
      const updated = req.body as ProjectConfig;
      const projects = loadProjects();
      const idx = projects.findIndex(p => p.owner === owner && p.repo === repo);
      if (idx === -1) return res.status(404).json({ error: 'Projeto não encontrado' });
      projects[idx] = { ...projects[idx], ...updated };
      saveProjects(projects);
      logger.info(`[Config] Projeto atualizado: ${owner}/${repo}`);
      res.json(projects[idx]);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/projects/:owner/:repo', (req, res) => {
    try {
      const { owner, repo } = req.params;
      const projects = loadProjects();
      const filtered = projects.filter(p => !(p.owner === owner && p.repo === repo));
      if (filtered.length === projects.length) return res.status(404).json({ error: 'Projeto não encontrado' });
      saveProjects(filtered);
      logger.info(`[Config] Projeto removido: ${owner}/${repo}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Ring buffer: last 500 events for replay on new connections
  const history: UIEvent[] = [];
  const MAX_HISTORY = 500;

  const clients = new Set<WebSocket>();

  eventBus.on('ui_event', (event: UIEvent) => {
    history.push(event);
    if (history.length > MAX_HISTORY) history.shift();

    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    for (const event of history) {
      ws.send(JSON.stringify(event));
    }
    ws.on('close', () => clients.delete(ws));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    logger.info(`UI Dashboard: http://0.0.0.0:${port}`);
  });
}
