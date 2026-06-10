import { GitHubClient } from '../../github/client.js';
import { RagEngine } from '../../rag/retriever.js';
import { AgentRunner } from '../runner.js';
import { loadProjects, deriveCollectionName } from '../../config/project-config.js';

const [config] = loadProjects();
const github = new GitHubClient(config);
await github.init();

const rag = new RagEngine(deriveCollectionName(config), config.localPath);
const runner = new AgentRunner(github, rag, config);

const issue = await github.getIssue(23);
const result = await runner.processIssue(issue);

console.log('Resultado:', JSON.stringify(result, null, 2));
