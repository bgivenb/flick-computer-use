import { spawn } from 'node:child_process';
import { z } from 'zod';

const resultSchema = z.object({
  width: z.number().positive(), height: z.number().positive(),
  lines: z.array(z.object({ text: z.string(), confidence: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() })),
});

// Apple Vision reads the screenshot locally. Only recognized text and coordinates enter the task observation.
export async function recognizeImage(path: string, png: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error, value?: z.infer<typeof resultSchema>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => { child.kill(); finish(new Error('OCR scan cancelled.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('OCR scan timed out.')); }, 8000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) { child.kill(); finish(new Error('OCR result was too large.')); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Never echo screenshot-derived text in diagnostics.
    child.on('error', () => finish(new Error('Could not start the local OCR helper. Run npm run build:native.')));
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error('Local OCR scan failed.');
        finish(undefined, resultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch { finish(new Error('Local OCR scan failed.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(png);
    if (signal?.aborted) abort();
  });
}
