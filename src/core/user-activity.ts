import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Driver } from './types.js';

export type UserActivityKind = 'mouse' | 'keyboard' | 'scroll';
export class UserActivityError extends Error {
  constructor(readonly kind: UserActivityKind, readonly detectedAt = Date.now()) {
    super('Paused because you used the mouse or keyboard. Your plan and saved text are retained. Press Continue when you are ready.');
    this.name = 'UserActivityError';
  }
}
export class UserActivityMonitorError extends Error {
  constructor(message: string) { super(message); this.name = 'UserActivityMonitorError'; }
}
export type ActivityWatch = (driver: Pick<Driver,'kind' | 'userActivityScope'>, signal: AbortSignal, interrupt: (reason: Error) => void) => Promise<() => void>;

/** Passive metadata-only macOS watcher. The child never reports keys, pointer positions or app text. */
export function watchUserActivity(path: string, signal: AbortSignal, interrupt: (reason: Error) => void): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], {stdio:['pipe','pipe','ignore']});
    const lines = createInterface({input:child.stdout});
    child.stdin.on('error',()=>{});
    let ready = false, stopped = false, interrupted = false;
    const timer = setTimeout(() => fail(new UserActivityMonitorError('User-input monitoring did not start. Rebuild with npm run build:native and check macOS Input Monitoring permission.')), 4000);
    const stop = () => {
      if(stopped) return;
      stopped = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      lines.close(); child.stdin.end(); child.kill('SIGTERM');
    };
    const abort = () => { if(!ready) reject(signal.reason); stop(); };
    const fail = (error: Error) => {
      if(stopped || interrupted) return;
      if(ready) interrupt(error); else reject(error);
      stop();
    };
    signal.addEventListener('abort',abort,{once:true});
    // Abort may have happened synchronously during setup by an injected caller.
    if(signal.aborted) { abort(); return; }
    child.on('error', () => fail(new UserActivityMonitorError('User-input monitoring helper is unavailable. Run npm run build:native.')));
    child.on('close', () => {
      if(!stopped && !interrupted) fail(new UserActivityMonitorError('User-input monitoring stopped unexpectedly. Flick paused before continuing.'));
    });
    lines.on('line', line => {
      if(stopped || interrupted) return;
      if(line.length > 4096) { fail(new UserActivityMonitorError('User-input monitor returned an invalid message.'));return; }
      let message:unknown;
      try { message=JSON.parse(line); } catch { fail(new UserActivityMonitorError('User-input monitor returned an invalid message.')); return; }
      if(!message || typeof message!=='object') { fail(new UserActivityMonitorError('User-input monitor returned an invalid message.'));return; }
      const event=message as Record<string,unknown>;
      if(event.type==='ready') {
        if(!ready) { ready=true;clearTimeout(timer);resolve(stop); }
      } else if(event.type==='activity' && ['mouse','keyboard','scroll'].includes(String(event.kind))) {
        interrupted=true;
        const reason=new UserActivityError(event.kind as UserActivityKind);
        if(!ready) reject(reason);
        interrupt(reason);stop();
      } else if(event.type==='error') {
        fail(new UserActivityMonitorError(event.code==='permission_required'
          ? 'Allow Flick’s input monitor in macOS System Settings → Privacy & Security → Input Monitoring, then Continue. No computer actions were started without monitoring.'
          : 'User-input monitoring is unavailable. Check macOS Input Monitoring permission and rebuild the native helper.'));
      } else fail(new UserActivityMonitorError('User-input monitor returned an unknown message.'));
    });
  });
}
export function desktopActivityWatch(path: string): ActivityWatch {
  return (driver,signal,interrupt) => {
    if(driver.userActivityScope==='headless') return Promise.resolve(()=>{});
    if(driver.userActivityScope==='desktop' || driver.kind==='macos' || driver.kind==='desktop')
      return watchUserActivity(path,signal,interrupt);
    return Promise.resolve(()=>{});
  };
}
