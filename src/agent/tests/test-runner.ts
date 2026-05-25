import { GitHubClient } from '../../github/client.js';
import { RagEngine } from '../../rag/retriever.js';
import { AgentRunner } from '../runner.js';

const github = new GitHubClient();
await github.init();

const rag = new RagEngine();
const runner = new AgentRunner(github, rag);

const issue = await github.getIssue(23);
const result = await runner.processIssue(issue);

console.log('Resultado:', JSON.stringify(result, null, 2));

