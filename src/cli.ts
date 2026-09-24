#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { NativeBridge } from './drivers/macos.js';

const config = loadConfig();
if (process.argv[2] === 'doctor') {
  const browserInstalled = existsSync(chromium.executablePath());
  const report: Record<string, unknown> = { node: process.version, apiKeyConfigured: Boolean(config.apiKey), model: config.model,
    chromiumInstalled: browserInstalled, nativeHelperBuilt: existsSync(config.nativePath), transport: 'stdio' };
  if (process.platform === 'darwin' && existsSync(config.nativePath)) {
    const bridge = new NativeBridge(config.nativePath);
    try { report.native = await bridge.request('health'); } catch (error) { report.native = { error: error instanceof Error ? error.message : 'Unavailable' }; }
    finally { bridge.close(); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!browserInstalled) console.log('Install Chromium: npx playwright install chromium');
  console.log('Native control: allow the launching app under System Settings > Privacy & Security > Accessibility. Window screenshots also need Screen Recording.');
} else if (process.argv[2] && process.argv[2] !== 'serve') {
  console.error('Usage: flick [serve|doctor]'); process.exitCode = 1;
} else {
  const runtime = createServer(config);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    const forceExit = setTimeout(() => process.exit(1), 12000); forceExit.unref();
    await runtime.close(); await runtime.server.close(); clearTimeout(forceExit);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.stdin.once('end', () => { void shutdown(); });
  runtime.server.server.onclose = () => { void shutdown(); };
  await runtime.server.connect(new StdioServerTransport());
}
