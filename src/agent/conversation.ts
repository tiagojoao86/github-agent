import { GitHubComment } from "../github/model/github-comment";

export interface ConversationTurn {
  role: 'agent' | 'human';
  content: string;
  createdAt: string;
}

export function buildConversationHistory(comments: GitHubComment[]): ConversationTurn[] {
  return comments.map((comment) => ({
    role: comment.isBot ? 'agent' : 'human',
    content: comment.body ? comment.body : '',
    createdAt: comment.createdAt
  }));
}

export function formatConversationForPrompt(turns: ConversationTurn[]): string {
  if (turns.length === 0) return '';

  const formatted = turns.map((turn) => {
    const role = turn.role === 'agent' ? '🤖 **Agente**' : '👤 **Humano**';
    return `${role} (${new Date(turn.createdAt).toLocaleString('pt-BR')}\n${turn.content}`;
  });

  return `## Histórico de Conversa\n\n${formatted}`;
}

export function extractLastAgentQuestion(turns: ConversationTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'agent') {
      const match = turns[i].content.match(/\*\*(.+?)\*\*/s);
      return match?.[1] ?? turns[i].content;
    }
  }
  return null;
}


