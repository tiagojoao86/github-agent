export type ProjectConfig = {
  owner: string;
  repo: string;
  localPath: string;
  baseBranch: string;
  githubToken?: string;
};

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
  // Backward compat: projeto único a partir das variáveis existentes
  return [{
    owner: requireEnv('GITHUB_OWNER'),
    repo: requireEnv('GITHUB_REPO'),
    localPath: requireEnv('REPO_LOCAL_PATH'),
    baseBranch: process.env.BASE_BRANCH ?? 'dev',
  }];
}
