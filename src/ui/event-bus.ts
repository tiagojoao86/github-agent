import { EventEmitter } from 'events';

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

export type UIEvent =
  | { type: 'log'; level: string; message: string; meta: Record<string, unknown>; issueNumber?: number; timestamp: string }
  | { type: 'agent_tool'; issueNumber: number; name: string; input: unknown; timestamp: string }
  | { type: 'agent_tool_result'; issueNumber: number; toolUseId: string; content: string; timestamp: string }
  | { type: 'agent_text'; issueNumber: number; text: string; timestamp: string }
  | { type: 'agent_thinking'; issueNumber: number; thinking: string; tokens: number; timestamp: string }
  | { type: 'agent_tokens'; issueNumber: number; usage: TokenUsage; runningTotal: TokenUsage; timestamp: string }
  | { type: 'session_start'; issueNumber: number; phase: string; timestamp: string }
  | { type: 'session_end'; issueNumber: number; result: string; totalTokens: TokenUsage; timestamp: string }
  | { type: 'tick_start'; timestamp: string }
  | { type: 'tick_end'; elapsed: string; timestamp: string };

class EventBus extends EventEmitter {
  publish(event: UIEvent): void {
    this.emit('ui_event', event);
  }
}

export const eventBus = new EventBus();
