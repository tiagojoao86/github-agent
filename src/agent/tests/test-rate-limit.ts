import { RateLimitState } from '../rate-limit-state.js';
import { calculateBackoffMs } from '../rate-limit.js';

// Testa o backoff exponencial
console.log('=== Backoff Exponencial ===');
for (let i = 0; i < 5; i++) {
  console.log(`Tentativa ${i}: ${(calculateBackoffMs(i) / 1000).toFixed(1)}s`);
}

// Testa o RateLimitState
console.log('\n=== RateLimitState ===');
const state = new RateLimitState();

console.log('Em cooldown antes do hit?', state.isInCooldown()); // false

state.recordHit(5000); // simula cooldown de 5s
console.log('Em cooldown após hit?', state.isInCooldown()); // true
console.log('Status:', state.getStatus());

// Aguarda o cooldown passar
await new Promise(resolve => setTimeout(resolve, 6000));
console.log('Em cooldown após 6s?', state.isInCooldown()); // false
