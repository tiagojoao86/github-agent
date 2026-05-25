export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  htmlUrl: string;
  createdAt: string;
}


