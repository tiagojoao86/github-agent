import { readFileSync, writeFileSync, existsSync } from 'fs';

export type ProjectModels = {
  plan?: string;
  dev?: string;
  review?: string;
};

export const DEFAULT_MODELS: Required<ProjectModels> = {
  plan: 'claude-opus-4-8',
  dev: 'claude-sonnet-4-6',
  review: 'claude-opus-4-8',
};

export type ProjectConfig = {
  owner: string;
  repo: string;
  localPath: string;
  baseBranch: string;
  githubToken?: string;
  models?: ProjectModels;
};

export const PROJECTS_FILE = process.env.PROJECTS_FILE ?? '/app/projects.json';

export function loadProjectsFromFile(): ProjectConfig[] | null {
  if (!existsSync(PROJECTS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8')) as ProjectConfig[];
  } catch {
    return null;
  }
}

export function saveProjects(projects: ProjectConfig[]): void {
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
}

export function deriveCollectionName(config: ProjectConfig): string {
  return `repo-${config.owner}-${config.repo}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

export function projectLabel(config: ProjectConfig): string {
  return `${config.owner}/${config.repo}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[Config] Variável obrigatória não definida: ${name}`);
  return value;
}

export function loadProjects(): ProjectConfig[] {
  // Ficheiro projects.json tem prioridade (gerido pela UI)
  const fromFile = loadProjectsFromFile();
  if (fromFile && fromFile.length > 0) return fromFile;

  // Fallback: variável de ambiente PROJECTS (JSON array)
  const raw = process.env.PROJECTS;
  if (raw) {
    try {
      const projects = JSON.parse(raw) as ProjectConfig[];
      if (!Array.isArray(projects) || projects.length === 0) {
        throw new Error('[Config] PROJECTS deve ser um array JSON não-vazio');
      }
      return projects;
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('[Config] PROJECTS não é um JSON válido');
      throw e;
    }
  }

  // Backward compat: projeto único a partir das variáveis individuais
  return [{
    owner: requireEnv('GITHUB_OWNER'),
    repo: requireEnv('GITHUB_REPO'),
    localPath: requireEnv('REPO_LOCAL_PATH'),
    baseBranch: process.env.BASE_BRANCH ?? 'dev',
  }];
}
