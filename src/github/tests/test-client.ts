import { GitHubClient } from '../client.js';

const client = new GitHubClient();
await client.init();
await client.ensureLabelsExists();

const issues = await client.getIssuesWithLabel('agent-ready');
console.log(`Issues com 'agent-ready': ${issues.length}`);
console.log(JSON.stringify(issues, null, 2));
