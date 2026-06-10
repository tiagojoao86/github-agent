import { ChromaClient } from 'chromadb';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RepositoryIndexer } from './indexer.js';

export interface RetrievalResult {
  chunks: Array<{
    content: string;
    filePath: string;
    score: number;
  }>;
  totalTokensEstimate: number;
}

export class RagEngine {
  private chroma: ChromaClient;
  private collectionName: string;
  private localPath: string;
  private static indexingPromises = new Map<string, Promise<void>>();

  constructor(collectionName: string, localPath: string) {
    this.chroma = new ChromaClient({ path: env.CHROMA_URL });
    this.collectionName = collectionName;
    this.localPath = localPath;
  }

  private async ensureIndexed(): Promise<void> {
    const existing = RagEngine.indexingPromises.get(this.collectionName);
    if (existing) {
      logger.info(`[${this.collectionName}] Indexação já em curso — aguardando...`);
      await existing;
      return;
    }

    logger.info(`[${this.collectionName}] Coleção RAG não encontrada — iniciando indexação de ${this.localPath}...`);
    const promise = new RepositoryIndexer(this.collectionName)
      .index(this.localPath)
      .finally(() => { RagEngine.indexingPromises.delete(this.collectionName); });

    RagEngine.indexingPromises.set(this.collectionName, promise);
    await promise;
    logger.info(`[${this.collectionName}] Indexação automática concluída — retomando RAG.`);
  }

  async retrieveContext(
    query: string,
    topK: number = 5
  ): Promise<RetrievalResult> {
    logger.debug(`RAG retrieval para query: "${query.substring(0, 80)}..."`);

    // Gera embedding da query
    const queryEmbedding = await this.generateQueryEmbedding(query);

    // Versões recentes do chromadb requerem uma embeddingFunction mesmo quando passamos
    // queryEmbeddings diretamente — usamos um no-op para satisfazer o contrato sem
    // depender do @chroma-core/default-embed que não está instalado.
    const noopEmbeddingFn = {
      generate: async (_texts: string[]): Promise<number[][]> => [],
    };

    // Busca no ChromaDB
    let collection;
    try {
      collection = await this.chroma.getCollection({
        name: this.collectionName,
        embeddingFunction: noopEmbeddingFn,
      });
    } catch (error: any) {
      if (error?.name === 'ChromaNotFoundError' || error?.message?.includes('could not be found')) {
        await this.ensureIndexed();
        collection = await this.chroma.getCollection({
          name: this.collectionName,
          embeddingFunction: noopEmbeddingFn,
        });
      } else {
        throw error;
      }
    }

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      include: ['documents', 'metadatas', 'distances'],
    });

    const chunks = (results.documents[0] ?? []).map((doc, idx) => {
      const metadata = results.metadatas[0]?.[idx] as Record<string, string> | null;
      const distance = results.distances?.[0]?.[idx] ?? 1;

      return {
        content: doc ?? '',
        filePath: metadata?.['filePath'] ?? 'unknown',
        // Converte distância cosseno em score de similaridade (0-1)
        score: 1 - distance,
      };
    });

    // Filtra chunks com score baixo (aumentado de 0.3 para 0.45 para menos ruído)
    const relevantChunks = chunks.filter((c) => c.score > 0.45);

    const totalTokensEstimate = relevantChunks.reduce(
      (acc, c) => acc + Math.ceil(c.content.length / 4),
      0
    );

    logger.debug(
      `RAG: ${relevantChunks.length} chunks recuperados (~${totalTokensEstimate} tokens)`
    );

    return { chunks: relevantChunks, totalTokensEstimate };
  }

  private async generateQueryEmbedding(text: string): Promise<number[]> {
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
        return this.generateQueryEmbedding(text);
      }
      throw new Error(`Ollama embedding falhou: ${errorText}`);
    }
    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  private static pullingModel = false;

  private async pullModel(): Promise<void> {
    if (RagEngine.pullingModel) return;
    RagEngine.pullingModel = true;
    logger.info(`Modelo "${env.EMBEDDING_MODEL}" não encontrado — fazendo pull no Ollama...`);
    try {
      const response = await fetch(`${env.OLLAMA_URL}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: env.EMBEDDING_MODEL, stream: false }),
      });
      if (!response.ok) throw new Error(await response.text());
      logger.info(`Pull do modelo "${env.EMBEDDING_MODEL}" concluído.`);
    } finally {
      RagEngine.pullingModel = false;
    }
  }
}

