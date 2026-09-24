import { workspace } from '../demo/workspace.js';
const web = await workspace();
console.log(`Dispatch demo workspace: ${web.url}`);
console.log(`Try this task with your MCP client:\n${web.target().goal}`);
console.log('For a timed autonomous run: npm run demo:run -- --existing-chrome --hold');
console.log('Press Ctrl-C to stop. All data is synthetic and held in memory.');
process.once('SIGINT', () => { void web.close(); });
process.once('SIGTERM', () => { void web.close(); });
