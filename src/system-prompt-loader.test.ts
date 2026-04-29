import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSystemPrompt } from './system-prompt-loader.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sp-loader-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('resolveSystemPrompt', () => {
  test('source=env returns the env value', async () => {
    const out = await resolveSystemPrompt({
      source: 'env',
      env: 'You are Mónica.',
      cachePath: join(tmpDir, 'cache.md'),
    });
    expect(out).toBe('You are Mónica.');
  });

  test('source=file reads from disk', async () => {
    const path = join(tmpDir, 'prompt.md');
    await writeFile(path, '# Mónica\n');
    const out = await resolveSystemPrompt({
      source: 'file',
      path,
      cachePath: join(tmpDir, 'cache.md'),
    });
    expect(out).toContain('Mónica');
  });

  test('source=url fetches and writes to cache on success', async () => {
    const cachePath = join(tmpDir, 'cache.md');
    const fetchImpl = vi.fn(async () =>
      new Response('PROMPT FROM URL', { status: 200 }),
    ) as typeof fetch;
    const out = await resolveSystemPrompt({
      source: 'url',
      url: 'https://example.com/prompt',
      cachePath,
      fetchImpl,
    });
    expect(out).toBe('PROMPT FROM URL');
    expect(await readFile(cachePath, 'utf8')).toBe('PROMPT FROM URL');
  });

  test('source=url falls back to cache on fetch failure', async () => {
    const cachePath = join(tmpDir, 'cache.md');
    await writeFile(cachePath, 'CACHED PROMPT');
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const out = await resolveSystemPrompt({
      source: 'url',
      url: 'https://example.com/prompt',
      cachePath,
      fetchImpl,
    });
    expect(out).toBe('CACHED PROMPT');
  });

  test('source=url throws if no cache and fetch fails', async () => {
    const cachePath = join(tmpDir, 'cache-none.md');
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      resolveSystemPrompt({ source: 'url', url: 'https://example.com', cachePath, fetchImpl }),
    ).rejects.toThrow();
  });
});
