export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Rate limit da API Anthropic atingido');
    this.name = 'RateLimitError';
  }
}

