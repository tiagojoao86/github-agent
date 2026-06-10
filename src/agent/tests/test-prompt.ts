import { PromptBuilder } from '../prompt-builder.js';
import { RagEngine } from '../../rag/retriever.js';
import { loadProjects, deriveCollectionName } from '../../config/project-config.js';

const [config] = loadProjects();
const builder = new PromptBuilder(config);
const rag = new RagEngine(deriveCollectionName(config), config.localPath);

const fakeIssue = {
  number: 42,
  title: 'Fix: campo de email não valida formato correto',
  body: 'O campo de email aceita valores sem @ como válidos.',
  labels: ['agent-ready'],
  htmlUrl: 'https://github.com/owner/repo/issues/42',
  createdAt: new Date().toISOString(),
};

const ragContext = await rag.retrieveContext(
  `${fakeIssue.title} ${fakeIssue.body}`
);

const prompt = await builder.buildForNewIssue(
  fakeIssue,
  ragContext,
  config.localPath,
  'agent/issue-42'
);

console.log('=== SYSTEM PROMPT ===');
console.log(prompt.systemPrompt);
console.log('\n=== USER PROMPT (primeiros 2000 chars) ===');
console.log(prompt.userPrompt.substring(0, 2000));
console.log(`\nTotal chars: ${prompt.userPrompt.length}`);
