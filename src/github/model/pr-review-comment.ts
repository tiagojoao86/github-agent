export type PRReviewComment = {
  id: number;
  author: string;
  body: string;
  type: 'inline' | 'general';
  // Apenas para comentários inline
  path?: string;
  line?: number;
};
