export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('overloaded')
  );
}

export function parseRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;

  // Tenta extrair "retry after X seconds" da mensagem de erro
  const match = error.message.match(/retry after (\d+)/i);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }

  return undefined;
}

export function calculateBackoffMs(
  attemptNumber: number,
  baseDelayMs: number = 5000,
  maxDelayMs: number = 5 * 60 * 1000
): number {
  const exponencial = baseDelayMs * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 0.3 * exponencial; // 30% de jitter

  return Math.min(exponencial + jitter, maxDelayMs);
}

