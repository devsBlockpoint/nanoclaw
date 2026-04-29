/**
 * eleve-http channel adapter.
 *
 * Inbound: POST /messages with Bearer {AGENT_INBOUND_TOKEN}
 * Outbound: POST {ELEVE_OUTBOUND_URL} with Bearer {ELEVE_OUTBOUND_TOKEN}
 * Health: GET /health → { status: 'ok' }
 *
 * Auto-wiring: on first inbound from a conversation_id, finds or creates the
 * messaging_group (channel_type='eleve-http', platform_id=conversation_id)
 * and wires it to the 'monica' agent group via messaging_group_agents.
 *
 * Self-registers on import via registerChannelAdapter. Returns null from
 * factory if AGENT_INBOUND_TOKEN is not set (adapter disabled gracefully).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface EleveHttpConfig {
  token: string;
  outboundUrl: string;
  outboundToken: string;
  /** HTTP port to listen on. Pass 0 to let Node assign a free port. */
  port?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an EleveHttp adapter instance. Returns a ChannelAdapter augmented
 * with a `port` getter that resolves to the actual bound port after `setup()`.
 */
export function createEleveHttpAdapter(config: EleveHttpConfig): ChannelAdapter & { port: number } {
  const fetchImpl: typeof fetch = config.fetchImpl ?? globalThis.fetch;
  let server: ReturnType<typeof createServer> | null = null;
  let boundPort = 0;
  let setupConfig: ChannelSetup | null = null;

  const adapter: ChannelAdapter & { port: number } = {
    name: 'eleve-http',
    channelType: 'eleve-http',
    supportsThreads: false,

    get port(): number {
      return boundPort;
    },

    async setup(cfg: ChannelSetup): Promise<void> {
      setupConfig = cfg;
      server = createServer(handleRequest);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(config.port ?? 3001, '0.0.0.0', () => {
          const addr = server!.address() as AddressInfo;
          boundPort = addr.port;
          log.info('eleve-http adapter listening', { port: boundPort });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      setupConfig = null;
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
        boundPort = 0;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!config.outboundUrl) {
        log.error('eleve-http: ELEVE_OUTBOUND_URL not set — cannot deliver');
        throw new Error('ELEVE_OUTBOUND_URL not configured');
      }
      const content = message.content as Record<string, unknown> | null | undefined;
      let text = '';
      if (content) {
        text =
          typeof content.text === 'string'
            ? content.text
            : typeof content.markdown === 'string'
              ? content.markdown
              : '';
      }
      const body: Record<string, unknown> = {
        conversation_id: platformId,
        message: text,
      };
      if (content?.action !== undefined) body.action = content.action;
      if (content?.metadata !== undefined) body.metadata = content.metadata;

      const resp = await fetchImpl(config.outboundUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.outboundToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`eleve-http outbound failed: ${resp.status} ${errText}`);
      }

      return undefined;
    },
  };

  // ── Request handler ──────────────────────────────────────────────────────

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health endpoint — no auth required
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Only POST /messages beyond this point
    if (req.method !== 'POST' || req.url !== '/messages') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    // Bearer auth BEFORE body parsing
    const authHeader = req.headers['authorization'] ?? '';
    const expected = `Bearer ${config.token}`;
    if (authHeader !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Respond 202 immediately (fire-and-forget)
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));

    // Read body asynchronously and process
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void processInbound(Buffer.concat(chunks).toString('utf8'));
    });
  }

  // ── Inbound processing ───────────────────────────────────────────────────

  async function processInbound(rawBody: string): Promise<void> {
    let payload: {
      conversation_id?: unknown;
      message?: unknown;
      sender?: { phone?: string; name?: string };
      metadata?: unknown;
    };

    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      log.warn('eleve-http: ignoring non-JSON inbound body');
      return;
    }

    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
    const messageText = typeof payload.message === 'string' ? payload.message : null;

    if (!conversationId || !messageText) {
      log.warn('eleve-http: missing conversation_id or message in inbound payload');
      return;
    }

    // Auto-wire this conversation to the 'monica' agent group if not already wired
    try {
      await ensureMessagingGroupWired(conversationId);
    } catch (err) {
      log.error('eleve-http: auto-wiring failed', { conversationId, err });
      // Continue anyway — the router will handle the unwired case
    }

    if (!setupConfig) {
      log.warn('eleve-http: processInbound called but setupConfig is null');
      return;
    }

    const { sender, metadata } = payload;

    try {
      await setupConfig.onInbound(conversationId, null, {
        id: `eleve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        // isMention=true: ÉLEVÉ only calls us when the message is directed at the agent
        isMention: true,
        isGroup: false,
        content: {
          text: messageText,
          sender: sender?.name ?? sender?.phone ?? 'usuario',
          senderId: sender?.phone ? `phone:${sender.phone}` : `eleve:${conversationId}`,
          metadata,
        },
      });
    } catch (err) {
      log.error('eleve-http: onInbound threw', { conversationId, err });
    }
  }

  return adapter;
}

// ── Auto-wiring helper ────────────────────────────────────────────────────────

/**
 * Ensure a messaging_group exists for this conversation and is wired to the
 * 'monica' agent group. Idempotent — safe to call on every inbound message.
 *
 * This is a boundary violation (adapter importing DB layer) but is the only
 * viable approach without modifying the upstream router. Tracked in
 * customizations.md section G.1 for future refactor.
 */
async function ensureMessagingGroupWired(conversationId: string): Promise<void> {
  const agentGroup = getAgentGroupByFolder('monica');
  if (!agentGroup) {
    log.warn('eleve-http: agent group "monica" not found in DB — skipping auto-wiring');
    return;
  }

  let mg = getMessagingGroupByPlatform('eleve-http', conversationId);

  if (!mg) {
    const mgId = `mg-eleve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    createMessagingGroup({
      id: mgId,
      channel_type: 'eleve-http',
      platform_id: conversationId,
      name: null,
      is_group: 0,
      // Public: ÉLEVÉ trusts the upstream Supabase webhook; every WhatsApp sender
      // is unknown by definition (new patient = new phone). The bearer at the
      // adapter boundary is what authenticates inbound; sender-level gating is
      // not appropriate for this channel.
      unknown_sender_policy: 'public',
      created_at: now,
    });
    // Refresh after creation
    mg = getMessagingGroupByPlatform('eleve-http', conversationId);
    if (!mg) {
      log.error('eleve-http: messaging_group creation failed', { conversationId });
      return;
    }
    log.info('eleve-http: created messaging_group', { conversationId, mgId });
  }

  const existingWire = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
  if (!existingWire) {
    const mgaId = `mga-eleve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    log.info('eleve-http: auto-wired conversation to monica', { conversationId, mgaId });
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

registerChannelAdapter('eleve-http', {
  factory: () => {
    const token = process.env.AGENT_INBOUND_TOKEN;
    if (!token) {
      log.warn('[eleve-http] AGENT_INBOUND_TOKEN not set — adapter disabled');
      return null;
    }
    return createEleveHttpAdapter({
      token,
      outboundUrl: process.env.ELEVE_OUTBOUND_URL ?? '',
      outboundToken: process.env.ELEVE_OUTBOUND_TOKEN ?? '',
      port: Number(process.env.NANOCLAW_PORT ?? '3001'),
    });
  },
});
