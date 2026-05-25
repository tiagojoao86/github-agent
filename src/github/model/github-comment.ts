export interface GitHubComment {
  id: number;
  body: string | null;
  author: string;
  createdAt: string;
  isBot: boolean;
}

