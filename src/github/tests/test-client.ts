import { GitHubClient } from '../client.js';
import { loadProjects } from '../../config/project-config.js';

const [config] = loadProjects();
const client = new GitHubClient(config);
await client.init();
await client.ensureLabelsExists();

const issues = await client.getIssuesWithLabel('agent-ready');
console.log(`Issues com 'agent-ready': ${issues.length}`);
console.log(JSON.stringify(issues, null, 2));
