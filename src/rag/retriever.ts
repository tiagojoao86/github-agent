import { ChromaClient } from 'chromadb';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

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

  constructor() {
    this.chroma = new ChromaClient({ path: env.CHROMA_URL });
    this.collectionName = `repo-${env.GITHUB_OWNER}-${env.GITHUB_REPO}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
  }

  async retrieveContext(
    query: string,
    topK: number = 8
  ): Promise<RetrievalResult> {
    logger.debug(`RAG retrieval para query: "${query.substring(0, 80)}..."`);

    // Gera embedding da query
    const queryEmbedding = await this.generateQueryEmbedding(query);

    // Busca no ChromaDB
    const collection = await this.chroma.getCollection({ name: this.collectionName });

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

    // Filtra chunks com score muito baixo (provavelmente irrelevantes)
    const relevantChunks = chunks.filter((c) => c.score > 0.3);

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
    const response = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding falhou: ${await response.text()}`);
    }
    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }
}

