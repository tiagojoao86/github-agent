import { ChromaClient, Collection } from 'chromadb';
import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Extensões de arquivo que vamos indexar
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.java', '.py', '.go', '.rs',
  '.sql', '.md', '.json',
  '.yaml', '.yml', '.sh', '.html'
]);

// Pastas que vamos ignorar (evita indexar node_modules, etc.)
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target',
  '.next', '__pycache__', '.gradle', 'vendor',
]);

// Tamanho máximo por chunk em caracteres (~4 chars por token)
// 2000 tokens * 4 = ~8000 chars por chunk
const MAX_CHUNK_SIZE = 8000;

interface CodeChunk {
  id: string;
  content: string;
  metadata: {
    filePath: string;
    extension: string;
    chunkIndex: number;
    totalChunks: number;
    repoPath: string;
  };
}

export class RepositoryIndexer {
  private chroma: ChromaClient;
  private collectionName: string;

  constructor() {
    this.chroma = new ChromaClient({ path: env.CHROMA_URL });
    this.collectionName = `repo-${env.GITHUB_OWNER}-${env.GITHUB_REPO}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  async index(repoPath: string): Promise<void> {
    logger.info(`Iniciando indexação de: ${repoPath}`);

    // Coleta todos os arquivos indexáveis
    const files = await this.collectFiles(repoPath);
    logger.info(`Encontrados ${files.length} arquivos para indexar`);

    // Cria ou recria a collection no ChromaDB
    // Usamos "get_or_create" para ser idempotente
    let collection: Collection;
    try {
      collection = await this.chroma.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction: { generate: async (_: string[]): Promise<number[][]> => [] },
        metadata: {
          'hnsw:space': 'cosine',
          repoPath,
          indexedAt: new Date().toISOString(),
        },
      });
      logger.info(`Collection ChromaDB: ${this.collectionName}`);
    } catch (error) {
      logger.error('Erro ao criar collection no ChromaDB', { error });
      throw error;
    }

    // Processa em batches para não explodir a memória
    const BATCH_SIZE = 10;
    let totalChunks = 0;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const chunks = await this.createChunks(batch, repoPath);

      if (chunks.length === 0) continue;

      // Gera embeddings para o batch
      const embeddings = await this.generateEmbeddings(chunks.map((c) => c.content));

      // Insere no ChromaDB
      await collection.upsert({
        ids: chunks.map((c) => c.id),
        embeddings,
        documents: chunks.map((c) => c.content),
        metadatas: chunks.map((c) => c.metadata),
      });

      totalChunks += chunks.length;
      logger.info(
        `Indexados ${i + batch.length}/${files.length} arquivos (${totalChunks} chunks)`
      );
    }

    logger.info(`Indexação concluída. Total: ${totalChunks} chunks`);
  }

  private async collectFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentPath: string): Promise<void> {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            const fileStat = await stat(fullPath);
            // Ignora arquivos muito grandes (>500KB)
            if (fileStat.size < 500 * 1024) {
              files.push(fullPath);
            }
          }
        }
      }
    }

    await walk(dirPath);
    return files;
  }

  private async createChunks(filePaths: string[], repoRoot: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];

    for (const filePath of filePaths) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const relativePath = relative(repoRoot, filePath);

        if (content.trim().length === 0) continue;

        // Se o arquivo cabe em um chunk, não divide
        if (content.length <= MAX_CHUNK_SIZE) {
          chunks.push({
            id: `${relativePath}:0`,
            content: this.formatChunk(relativePath, content, 0, 1),
            metadata: {
              filePath: relativePath,
              extension: extname(filePath),
              chunkIndex: 0,
              totalChunks: 1,
              repoPath: repoRoot,
            },
          });
        } else {
          // Divide em chunks preservando linhas (não corta no meio de uma linha)
          const fileChunks = this.splitByLines(content, MAX_CHUNK_SIZE);
          fileChunks.forEach((chunkContent, idx) => {
            chunks.push({
              id: `${relativePath}:${idx}`,
              content: this.formatChunk(relativePath, chunkContent, idx, fileChunks.length),
              metadata: {
                filePath: relativePath,
                extension: extname(filePath),
                chunkIndex: idx,
                totalChunks: fileChunks.length,
                repoPath: repoRoot,
              },
            });
          });
        }
      } catch {
        // Arquivo binário ou encoding inválido — pula silenciosamente
      }
    }

    return chunks;
  }

  // Formata o chunk com metadados no cabeçalho para ajudar o modelo a entender o contexto
  private formatChunk(filePath: string, content: string, idx: number, total: number): string {
    const chunkInfo = total > 1 ? ` (parte ${idx + 1}/${total})` : '';
    return `=== Arquivo: ${filePath}${chunkInfo} ===\n${content}`;
  }

  private splitByLines(content: string, maxSize: number): string[] {
    const lines = content.split('\n');
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      if ((current + line + '\n').length > maxSize && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += line + '\n';
    }

    if (current.trim()) {
      chunks.push(current);
    }

    return chunks;
  }

  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedOne(text)));
  }


  private async embedOne(text: string): Promise<number[]> {
    // Trunca para 2000 chars (~500 tokens) — seguro para qualquer variante do modelo
    const safeText = text.length > 2000 ? text.slice(0, 2000) : text;
    const response = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, prompt: safeText }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (errorText.includes('not found')) {
        await this.pullModel();
        return this.embedOne(text);
      }
      throw new Error(`Ollama embedding falhou: ${errorText}`);
    }
    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  private async pullModel(): Promise<void> {
    logger.info(`Modelo "${env.EMBEDDING_MODEL}" não encontrado — fazendo pull no Ollama...`);
    const response = await fetch(`${env.OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: env.EMBEDDING_MODEL, stream: false }),
    });
    if (!response.ok) throw new Error(await response.text());
    logger.info(`Pull do modelo "${env.EMBEDDING_MODEL}" concluído.`);
  }

  getCollectionName(): string {
    return this.collectionName;
  }
}

if (process.argv[1].endsWith('indexer.ts') || process.argv[1].endsWith('indexer.js')) {
  const indexer = new RepositoryIndexer();
  await indexer.index(env.REPO_LOCAL_PATH);
}

