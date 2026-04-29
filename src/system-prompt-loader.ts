/**
 * System prompt loader — 3 fuentes (env / file / url) con cache + fallback.
 * Llamado desde src/index.ts al boot (y opcionalmente con interval de reload).
 */
import { readFile, writeFile } from 'node:fs/promises';

import { log } from './log.js';

export type PromptSource = 'env' | 'file' | 'url';

export interface ResolveOptions {
  source: PromptSource;
  env?: string;
  path?: string;
  url?: string;
  urlAuth?: string;
  cachePath: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function resolveSystemPrompt(opts: ResolveOptions): Promise<string> {
  switch (opts.source) {
    case 'env': {
      if (!opts.env) throw new Error('source=env requires opts.env');
      return opts.env;
    }
    case 'file': {
      if (!opts.path) throw new Error('source=file requires opts.path');
      return readFile(opts.path, 'utf8');
    }
    case 'url': {
      if (!opts.url) throw new Error('source=url requires opts.url');
      try {
        const content = await fetchPrompt(opts);
        await writeFile(opts.cachePath, content, 'utf8');
        return content;
      } catch (err) {
        try {
          const cached = await readFile(opts.cachePath, 'utf8');
          log.warn(`[system-prompt-loader] fetch failed (${(err as Error).message}); using cache`);
          return cached;
        } catch {
          throw new Error(`[system-prompt-loader] fetch failed and no cache available: ${(err as Error).message}`);
        }
      }
    }
  }
}

async function fetchPrompt(opts: ResolveOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (opts.urlAuth) headers.Authorization = opts.urlAuth;
    const res = await fetchImpl(opts.url!, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
