/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import {
  getRunningSessions,
  getActiveSessions,
  createPendingQuestion,
  getSession,
  createPendingApproval,
} from './db/sessions.js';
import { getAgentGroup, getAdminAgentGroup, createAgentGroup, updateAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from './db/messaging-groups.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  sessionDir,
  inboundDbPath,
  resolveSession,
  writeSessionMessage,
  writeSystemResponse,
} from './session-manager.js';
import { resetContainerIdleTimer, wakeContainer } from './container-runner.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
}

/** Show typing indicator on a channel. Called when a message is routed to the agent. */
export async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await deliveryAdapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't fail routing if it errors
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

async function deliverSessionMessages(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = outDb
      .prepare(
        `SELECT * FROM messages_out
         WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
         ORDER BY timestamp ASC`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;

    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const deliveredIds = new Set(
      (inDb.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
        (r) => r.message_out_id,
      ),
    );
    const undelivered = allDue.filter((m) => !deliveredIds.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        inDb
          .prepare(
            "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', datetime('now'))",
          )
          .run(msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);
        resetContainerIdleTimer(session.id);
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          inDb
            .prepare(
              "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', datetime('now'))",
            )
            .run(msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session
  if (msg.channel_type === 'agent') {
    await routeAgentMessage(msg, session);
    return;
  }

  // Track pending questions for ask_user_question flow
  if (content.type === 'ask_question' && content.questionId) {
    createPendingQuestion({
      question_id: content.questionId,
      session_id: session.id,
      message_out_id: msg.id,
      platform_id: msg.platform_id,
      channel_type: msg.channel_type,
      thread_id: msg.thread_id,
      created_at: new Date().toISOString(),
    });
    log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files
  let files: OutboundFile[] | undefined;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', msg.id);
  if (Array.isArray(content.files) && content.files.length > 0 && fs.existsSync(outboxDir)) {
    files = [];
    for (const filename of content.files as string[]) {
      const filePath = path.join(outboxDir, filename);
      if (fs.existsSync(filePath)) {
        files.push({ filename, data: fs.readFileSync(filePath) });
      } else {
        log.warn('Outbox file not found', { messageId: msg.id, filename });
      }
    }
    if (files.length === 0) files = undefined;
  }

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // Clean up outbox directory after successful delivery
  if (fs.existsSync(outboxDir)) {
    fs.rmSync(outboxDir, { recursive: true, force: true });
  }

  return platformMsgId;
}

/** Route an agent-to-agent message to the target agent's session. */
async function routeAgentMessage(
  msg: { id: string; platform_id: string | null; content: string },
  sourceSession: Session,
): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    log.warn('Agent message missing target agent group ID', { id: msg.id });
    return;
  }

  const targetGroup = getAgentGroup(targetAgentGroupId);
  if (!targetGroup) {
    log.warn('Target agent group not found', { id: msg.id, targetAgentGroupId });
    return;
  }

  const sourceGroup = getAgentGroup(sourceSession.agent_group_id);
  const sourceAgentName = sourceGroup?.name || sourceSession.agent_group_id;

  // Find or create a session for the target agent
  const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');

  // Enrich content with sender info
  const content = JSON.parse(msg.content);
  const enrichedContent = JSON.stringify({
    text: content.text,
    sender: sourceAgentName,
    senderId: sourceSession.agent_group_id,
  });

  const messageId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: sourceSession.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: enrichedContent,
  });

  log.info('Agent message routed', {
    from: sourceSession.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
  });

  const freshSession = getSession(targetSession.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}

/** Ensure the delivered table has new columns (migration for existing sessions). */
function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  switch (action) {
    case 'schedule_task': {
      const taskId = content.taskId as string;
      const prompt = content.prompt as string;
      const script = content.script as string | null;
      const processAfter = content.processAfter as string;
      const recurrence = (content.recurrence as string) || null;

      // Compute next even seq for host-owned inbound.db
      const maxSeq = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
      const nextSeq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content)
           VALUES (@id, @seq, datetime('now'), 'pending', 0, @process_after, @recurrence, 'task', @platform_id, @channel_type, @thread_id, @content)`,
        )
        .run({
          id: taskId,
          seq: nextSeq,
          process_after: processAfter,
          recurrence,
          platform_id: content.platformId ?? null,
          channel_type: content.channelType ?? null,
          thread_id: content.threadId ?? null,
          content: JSON.stringify({ prompt, script }),
        });
      log.info('Scheduled task created', { taskId, processAfter, recurrence });
      break;
    }

    case 'cancel_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare(
          "UPDATE messages_in SET status = 'completed' WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')",
        )
        .run(taskId);
      log.info('Task cancelled', { taskId });
      break;
    }

    case 'pause_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare("UPDATE messages_in SET status = 'paused' WHERE id = ? AND kind = 'task' AND status = 'pending'")
        .run(taskId);
      log.info('Task paused', { taskId });
      break;
    }

    case 'resume_task': {
      const taskId = content.taskId as string;
      inDb
        .prepare("UPDATE messages_in SET status = 'pending' WHERE id = ? AND kind = 'task' AND status = 'paused'")
        .run(taskId);
      log.info('Task resumed', { taskId });
      break;
    }

    case 'create_agent': {
      const requestId = content.requestId as string;
      const name = content.name as string;
      let folder =
        (content.folder as string) ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '_')
          .replace(/_+/g, '_');
      const instructions = content.instructions as string | null;

      try {
        // Avoid duplicate folders
        const { getAgentGroupByFolder } = await import('./db/agent-groups.js');
        if (getAgentGroupByFolder(folder)) {
          folder = `${folder}_${Date.now()}`;
        }

        const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        createAgentGroup({
          id: agentGroupId,
          name,
          folder,
          is_admin: 0,
          agent_provider: null,
          container_config: null,
          created_at: new Date().toISOString(),
        });

        const groupPath = path.join(GROUPS_DIR, folder);
        fs.mkdirSync(groupPath, { recursive: true });

        if (instructions) {
          fs.writeFileSync(path.join(groupPath, 'CLAUDE.md'), instructions);
        }

        writeSystemResponse(session.agent_group_id, session.id, requestId, 'success', {
          agentGroupId,
          name,
          folder,
        });

        log.info('Agent group created via system action', { agentGroupId, name, folder });
      } catch (e) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'add_mcp_server': {
      const requestId = content.requestId as string;
      const serverName = content.name as string;
      const command = content.command as string;
      const serverArgs = content.args as string[];
      const serverEnv = content.env as Record<string, string>;

      try {
        const agentGroup = getAgentGroup(session.agent_group_id);
        if (!agentGroup) throw new Error('Agent group not found');

        const containerConfig = agentGroup.container_config ? JSON.parse(agentGroup.container_config) : {};
        if (!containerConfig.mcpServers) containerConfig.mcpServers = {};
        containerConfig.mcpServers[serverName] = { command, args: serverArgs || [], env: serverEnv || {} };

        updateAgentGroup(session.agent_group_id, { container_config: JSON.stringify(containerConfig) });

        writeSystemResponse(session.agent_group_id, session.id, requestId, 'success', {
          message: `MCP server "${serverName}" added. Will take effect on next container restart.`,
        });

        log.info('MCP server added', { agentGroupId: session.agent_group_id, name: serverName });
      } catch (e) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'install_packages': {
      const requestId = content.requestId as string;
      const apt = (content.apt as string[]) || [];
      const npm = (content.npm as string[]) || [];
      const reason = content.reason as string;

      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', { error: 'Agent group not found' });
        break;
      }

      // Find admin channel for approval card
      const adminGroup = getAdminAgentGroup();
      let approvalChannelType: string | null = null;
      let approvalPlatformId: string | null = null;

      if (adminGroup) {
        const adminMGs = getMessagingGroupsByAgentGroup(adminGroup.id);
        if (adminMGs.length > 0) {
          approvalChannelType = adminMGs[0].channel_type;
          approvalPlatformId = adminMGs[0].platform_id;
        }
      }

      if (!approvalChannelType || !approvalPlatformId) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
          error: 'No admin channel found for approval',
        });
        break;
      }

      const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      createPendingApproval({
        approval_id: approvalId,
        session_id: session.id,
        request_id: requestId,
        action: 'install_packages',
        payload: JSON.stringify({ apt, npm, reason }),
        created_at: new Date().toISOString(),
      });

      const packageList = [...apt.map((p: string) => `apt: ${p}`), ...npm.map((p: string) => `npm: ${p}`)].join(', ');
      if (deliveryAdapter) {
        await deliveryAdapter.deliver(
          approvalChannelType,
          approvalPlatformId,
          null,
          'chat-sdk',
          JSON.stringify({
            type: 'ask_question',
            questionId: approvalId,
            question: `Agent "${agentGroup.name}" requests package installation:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
            options: ['Approve', 'Reject'],
          }),
        );
      }

      log.info('Package install approval requested', { approvalId, agentGroup: agentGroup.name, apt, npm });
      break;
    }

    case 'request_rebuild': {
      const requestId = content.requestId as string;
      const reason = content.reason as string;

      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', { error: 'Agent group not found' });
        break;
      }

      // Find admin channel for approval card
      const adminGroup2 = getAdminAgentGroup();
      let rebuildChannelType: string | null = null;
      let rebuildPlatformId: string | null = null;

      if (adminGroup2) {
        const adminMGs2 = getMessagingGroupsByAgentGroup(adminGroup2.id);
        if (adminMGs2.length > 0) {
          rebuildChannelType = adminMGs2[0].channel_type;
          rebuildPlatformId = adminMGs2[0].platform_id;
        }
      }

      if (!rebuildChannelType || !rebuildPlatformId) {
        writeSystemResponse(session.agent_group_id, session.id, requestId, 'error', {
          error: 'No admin channel found for approval',
        });
        break;
      }

      const rebuildApprovalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      createPendingApproval({
        approval_id: rebuildApprovalId,
        session_id: session.id,
        request_id: requestId,
        action: 'request_rebuild',
        payload: JSON.stringify({ reason }),
        created_at: new Date().toISOString(),
      });

      if (deliveryAdapter) {
        await deliveryAdapter.deliver(
          rebuildChannelType,
          rebuildPlatformId,
          null,
          'chat-sdk',
          JSON.stringify({
            type: 'ask_question',
            questionId: rebuildApprovalId,
            question: `Agent "${agentGroup.name}" requests a container rebuild.${reason ? `\nReason: ${reason}` : ''}`,
            options: ['Approve', 'Reject'],
          }),
        );
      }

      log.info('Container rebuild approval requested', { approvalId: rebuildApprovalId, agentGroup: agentGroup.name });
      break;
    }

    default:
      log.warn('Unknown system action', { action });
  }
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
