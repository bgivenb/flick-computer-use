import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

export function scenario(index = 0) {
  const variants = [
    { project: 'Website launch', owner: 'Maya Chen', title: 'Prepare the launch brief', priority: 'High', due: '2026-10-02', notes: 'Include the final copy, assets, and launch checklist.', email: 'launch@example.com' },
    { project: 'Customer research', owner: 'Jordan Lee', title: 'Schedule customer interviews', priority: 'Medium', due: '2026-10-07', notes: 'Invite five customers and prepare the interview guide.', email: 'research@example.com' },
    { project: 'Product updates', owner: 'Alex Rivera', title: 'Review the release notes', priority: 'Low', due: '2026-10-12', notes: 'Check screenshots and confirm the feature descriptions.', email: 'product@example.com' },
  ];
  const value = variants[index % variants.length];
  return { ...value, notify: true, format: 'csv', headers: true,
    goal: `Create a task titled ${JSON.stringify(value.title)} in ${JSON.stringify(value.project)}, assigned to ${value.owner}, with ${value.priority.toLowerCase()} priority and due date ${value.due}. Use the supplied notes and enable Notify assignee. Save the task. Then open Reports and save a CSV export with column headers, using the supplied export email.`,
    inputs: { title: value.title, due_date: value.due, notes: value.notes, export_email: value.email } };
}
export type Scenario = ReturnType<typeof scenario>;
export type WorkspaceState = { tasks: Array<{ title: string; project: string; owner: string; priority: string; due: string; notes: string; notify: boolean }>; export: { email: string; format: string; headers: boolean } | null };

export function verifyWorkspace(state: WorkspaceState, target: Scenario) {
  const task = state.tasks.at(-1);
  const checks = Object.fromEntries(['title', 'project', 'owner', 'priority', 'due', 'notes', 'notify'].map(key =>
    [`task.${key}`, task?.[key as keyof typeof task] === target[key as keyof Scenario]]));
  return { ...checks, 'task.count': state.tasks.length === 1,
    'export.email': state.export?.email === target.email, 'export.format': state.export?.format === target.format, 'export.headers': state.export?.headers === target.headers };
}

export async function workspace() {
  const html = await readFile(new URL('./workspace.html', import.meta.url), 'utf8');
  let target = scenario();
  let state: WorkspaceState = { tasks: [], export: null };
  let telemetry: Record<string, unknown> = { status: 'ready', goal: target.goal, events: [] };
  const streams = new Set<ServerResponse>();
  const broadcast = (kind: string, data: unknown) => {
    for (const response of streams) response.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const json = (response: ServerResponse, data: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data));
  };
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(`event: state\ndata: ${JSON.stringify({ target, state, telemetry })}\n\n`);
        streams.add(response); request.on('close', () => streams.delete(response)); return;
      }
      if (request.method === 'GET' && path === '/state') { json(response, state); return; }
      if (request.method === 'POST' && ['/tasks', '/export'].includes(path)) {
        // This is an ordinary local app endpoint. Only the browser form calls it during an agent run.
        if (request.headers.origin !== `http://${request.headers.host}`) { json(response, { error: 'Invalid origin' }, 403); return; }
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 20000) throw new Error('Request too large'); }
        const value = JSON.parse(body);
        if (path === '/tasks') {
          if (typeof value.title !== 'string' || !value.title.trim() || typeof value.notes !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.due) ||
            !['Website launch', 'Customer research', 'Product updates'].includes(value.project) || !['Maya Chen', 'Jordan Lee', 'Alex Rivera'].includes(value.owner) ||
            !['High', 'Medium', 'Low'].includes(value.priority) || typeof value.notify !== 'boolean') throw new Error('Invalid task');
          state.tasks.push({ title: value.title, project: value.project, owner: value.owner, priority: value.priority, due: value.due, notes: value.notes, notify: value.notify });
        } else {
          if (typeof value.email !== 'string' || !value.email.includes('@') || !['csv', 'json'].includes(value.format) || typeof value.headers !== 'boolean') throw new Error('Invalid export');
          state.export = { email: value.email, format: value.format, headers: value.headers };
        }
        json(response, { saved: true }); broadcast('saved', state); return;
      }
      if (request.method !== 'GET' || path !== '/') { json(response, { error: 'Not found' }, 404); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html);
    } catch (error) { json(response, { error: error instanceof Error ? error.message : 'Invalid request' }, 400); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state: () => structuredClone(state), target: () => structuredClone(target),
    reset(index: number) { target = scenario(index); state = { tasks: [], export: null }; telemetry = { status: 'ready', goal: target.goal, events: [] }; broadcast('reset', { target, state, telemetry }); },
    publish(data: Record<string, unknown>) { telemetry = { ...telemetry, ...data }; broadcast('telemetry', telemetry); },
    close: () => new Promise<void>((resolve, reject) => { for (const stream of streams) stream.end(); server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
