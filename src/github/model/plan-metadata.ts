export type PlanMetadata = {
  planIssue: number;
  planBranch: string;
  dependsOn: number[];   // números de issue do GitHub (resolvidos)
  step: number;
  totalSteps: number;
};

// Estrutura do .agent-plan.json commitado na plan branch
export type PlanStep = {
  step: number;
  title: string;
  body: string;
  dependsOn: number[];   // índices de step (1-based), resolvidos para issue numbers na ativação
  testInstructions: string;
};

export type PlanFile = {
  overview: string;
  steps: PlanStep[];
};

export function parsePlanMetadata(issueBody: string): PlanMetadata | null {
  const match = issueBody.match(/<!--\s*agent-plan-meta:\s*(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as PlanMetadata;
  } catch {
    return null;
  }
}
