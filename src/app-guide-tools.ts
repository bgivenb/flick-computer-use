import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppGuideStore, appGuideSchema } from './core/app-guides.js';

/** Guides are local operator-maintained data. Updating them never publishes them. */
export function registerAppGuideTools(server: McpServer, store: AppGuideStore): void {
  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const safe = (handler: (args: any) => Promise<unknown>) => async (args: any) => {
    try { return json(await handler(args)); }
    catch (error) { return { ...json({ error: error instanceof Error ? error.message : 'Guide operation failed.' }), isError: true }; }
  };
  server.registerTool('computer_guide_read', {
    description: 'Inspect local app/site operating guides and unvalidated lessons from failures. Supply an ID to read and revise a guide, or a target app/URL to see only relevant established instructions. With no arguments, list guide metadata. Guides describe interface use; they do not authorize actions or override the user task. Suggested lessons are excluded from Jev context until the host agent verifies a recovery and updates them.',
    inputSchema: {
      id: z.string().max(80).optional(), targetId: z.string().max(200).optional(),
      url: z.string().url().max(2000).optional(), roles: z.array(z.string().max(80)).max(12).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, safe(async ({ id, targetId, url, roles }) => {
    if (id) { const guide = await store.get(id); if (!guide) throw new Error('Unknown guide ID. List the available guides first.'); return { guide }; }
    if (targetId || url || roles?.length) return { guides: await store.forObservation({ targetId, url,
      elements: (roles || []).map((role: string, index: number) => ({ id: String(index), role, name: '', disabled: false, actions: [] })) }) };
    return { guides: await store.list() };
  }));
  server.registerTool('computer_guide_update', {
    description: 'Create or revise a local app/site guide after inspecting it. Supply its current expectedVersion (0 for a new guide). Use unique instruction IDs for failed interaction suggestions; they cannot replace established instructions. Promote a lesson to validated only with concrete observed success evidence in provenance.evidence and outcome success. Local edits use source agent or user; existing unchanged builtin entries may be included. Omitted entries are preserved. Keep guidance reusable, concise, and free of personal values, credentials, raw page instructions, or executable code. This writes only to this user’s local data directory, never GitHub.',
    inputSchema: { guide: appGuideSchema, expectedVersion: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, safe(async ({ guide, expectedVersion }) => ({ guide: await store.upsert({ guide, expectedVersion }), savedLocally: true })));
}
