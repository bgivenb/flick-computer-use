import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function desktopLock() {
  const path = join(tmpdir(), `jev-local-mcp-desktop-${process.getuid?.() ?? 'user'}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; }
      catch { throw new Error('A native desktop lock exists but cannot be read. Close other Jev servers before retrying.'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid desktop lock. Close other Jev servers before retrying.');
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { try { unlinkSync(path); } catch {} continue; }
      }
      throw new Error('Another Jev session owns the desktop. Close its native session before connecting.');
    }
  }
  throw new Error('Could not acquire the native desktop lock.');
}
