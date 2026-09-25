import { loadEnvFile } from 'node:process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig() {
  const envPath = process.env.JEV_ENV_FILE || resolve(root, '.env.local');
  if (existsSync(envPath)) loadEnvFile(envPath);
  const localDir = resolve(process.env.JEV_DATA_DIR || resolve(root, '.local'));
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  return {
    apiKey: process.env.TYPESAFE_API_KEY,
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    cerebrasApiKey: process.env.CEREBRAS_API_KEY,
    cerebrasModel: process.env.CEREBRAS_MODEL || 'qwen-3.8-27b',
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-6-luna',
    localDir,
    nativePath: resolve(root, '.local/bin/jev-macos'),
    ocrImagePath: resolve(root, '.local/bin/flick-ocr-image'),
  };
}
