/**
 * Tests for the eleve-http channel adapter.
 *
 * Uses dynamic ports (port 0) to avoid conflicts between tests.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

// Mock DB modules so auto-wiring doesn't require a real SQLite DB.
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: vi.fn().mockReturnValue(undefined),
  createMessagingGroup: vi.fn(),
  getMessagingGroupAgentByPair: vi.fn().mockReturnValue(undefined),
  createMessagingGroupAgent: vi.fn(),
}));
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroupByFolder: vi.fn().mockReturnValue({
    id: 'ag-monica',
    name: 'Mónica',
    folder: 'monica',
    agent_provider: null,
    created_at: new Date().toISOString(),
  }),
}));

// We import createEleveHttpAdapter after mocks are in place.
const { createEleveHttpAdapter } = await import('./eleve-http.js');

describe('eleve-http adapter', () => {
  let adapter: ReturnType<typeof createEleveHttpAdapter>;

  afterEach(async () => {
    if (adapter) {
      await adapter.teardown();
    }
  });

  test('rejects requests without bearer', async () => {
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'https://eleve.test/out',
      outboundToken: 'out-token',
      port: 0,
    });
    await adapter.setup(setup);
    const port = (adapter as any).port as number;

    const res = await fetch(`http://localhost:${port}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'c1', message: 'hi', sender: { phone: '5215...' } }),
    });
    expect(res.status).toBe(401);
  });

  test('accepts valid bearer and dispatches onInbound', async () => {
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'https://eleve.test/out',
      outboundToken: 'out-token',
      port: 0,
    });
    await adapter.setup(setup);
    const port = (adapter as any).port as number;

    const res = await fetch(`http://localhost:${port}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-1',
        message: 'hola',
        sender: { phone: '5215512345678', name: 'Ana' },
      }),
    });
    expect(res.status).toBe(202);

    // Wait briefly for async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(setup.onInboundCalls).toHaveLength(1);
    expect(setup.onInboundCalls[0].platformId).toBe('conv-1');
    expect(setup.onInboundCalls[0].threadId).toBeNull();
  });

  test('GET /health returns ok regardless of auth', async () => {
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'x',
      outboundToken: 'y',
      port: 0,
    });
    await adapter.setup(setup);
    const port = (adapter as any).port as number;

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('deliver POSTs to outbound URL with bearer and JSON body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'https://eleve.test/n8n-out',
      outboundToken: 'out-token',
      port: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.setup(setup);

    // Real adapter contract: deliver(platformId, threadId, OutboundMessage)
    await adapter.deliver('conv-42', null, {
      kind: 'chat',
      content: { text: 'tu cita está confirmada' },
    });

    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eleve.test/n8n-out');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    expect(headers.get('Authorization')).toBe('Bearer out-token');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ conversation_id: 'conv-42', message: 'tu cita está confirmada' });
  });

  test('deliver throws on non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'https://eleve.test/n8n-out',
      outboundToken: 'out-token',
      port: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.setup(setup);

    await expect(adapter.deliver('conv-42', null, { kind: 'chat', content: { text: 'hi' } })).rejects.toThrow();
  });

  test('returns 404 for unknown paths', async () => {
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'x',
      outboundToken: 'y',
      port: 0,
    });
    await adapter.setup(setup);
    const port = (adapter as any).port as number;

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  test('isConnected returns true after setup and false after teardown', async () => {
    const setup = makeFakeSetup();
    adapter = createEleveHttpAdapter({
      token: 'secret',
      outboundUrl: 'x',
      outboundToken: 'y',
      port: 0,
    });
    expect(adapter.isConnected()).toBe(false);
    await adapter.setup(setup);
    expect(adapter.isConnected()).toBe(true);
    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeSetup(): ChannelSetup & {
  onInboundCalls: Array<{ platformId: string; threadId: string | null; message: unknown }>;
} {
  const onInboundCalls: Array<{ platformId: string; threadId: string | null; message: unknown }> = [];
  return {
    onInboundCalls,
    onInbound(platformId: string, threadId: string | null, message: unknown): void {
      onInboundCalls.push({ platformId, threadId, message });
    },
    onInboundEvent(): void {},
    onMetadata(): void {},
    onAction(): void {},
  } as unknown as ChannelSetup & {
    onInboundCalls: Array<{ platformId: string; threadId: string | null; message: unknown }>;
  };
}
