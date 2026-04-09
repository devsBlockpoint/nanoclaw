/**
 * NanoClaw v2 — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getMessagingGroupsByChannel, getMessagingGroupAgents } from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import {
  getPendingQuestion,
  deletePendingQuestion,
  getPendingApproval,
  deletePendingApproval,
  getSession,
} from './db/sessions.js';
import { getAgentGroup, updateAgentGroup } from './db/agent-groups.js';
import { writeSessionMessage, writeSystemResponse } from './session-manager.js';
import { wakeContainer, buildAgentGroupImage } from './container-runner.js';
import { log } from './log.js';

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

import type { ChannelAdapter, ChannelSetup, ConversationConfig } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw v2 starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    const conversations = buildConversationConfigs(adapter.channelType);
    return {
      conversations,
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        handleQuestionResponse(questionId, selectedOption, userId).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content, files) {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType, platformId, threadId) {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  });

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw v2 running');
}

/** Build ConversationConfig[] for a channel type from the central DB. */
function buildConversationConfigs(channelType: string): ConversationConfig[] {
  const groups = getMessagingGroupsByChannel(channelType);
  const configs: ConversationConfig[] = [];

  for (const mg of groups) {
    const agents = getMessagingGroupAgents(mg.id);
    for (const agent of agents) {
      const triggerRules = agent.trigger_rules ? JSON.parse(agent.trigger_rules) : null;
      configs.push({
        platformId: mg.platform_id,
        agentGroupId: agent.agent_group_id,
        triggerPattern: triggerRules?.pattern,
        requiresTrigger: triggerRules?.requiresTrigger ?? false,
        sessionMode: agent.session_mode,
      });
    }
  }

  return configs;
}

/** Handle a user's response to an ask_user_question card or an approval card. */
async function handleQuestionResponse(questionId: string, selectedOption: string, userId: string): Promise<void> {
  // Check if this is a pending approval (install_packages, request_rebuild)
  const approval = getPendingApproval(questionId);
  if (approval) {
    await handleApprovalResponse(approval, selectedOption, userId);
    return;
  }

  const pq = getPendingQuestion(questionId);
  if (!pq) {
    log.warn('Pending question not found (may have expired)', { questionId });
    return;
  }

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId, sessionId: pq.session_id });
    deletePendingQuestion(questionId);
    return;
  }

  // Write the response to the session DB as a system message
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId,
      selectedOption,
      userId,
    }),
  });

  deletePendingQuestion(questionId);
  log.info('Question response routed', { questionId, selectedOption, sessionId: session.id });

  // Wake the container so the MCP tool's poll picks up the response
  await wakeContainer(session);
}

/** Handle an admin's response to an approval card. */
async function handleApprovalResponse(
  approval: import('./types.js').PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  if (selectedOption === 'Approve') {
    const payload = JSON.parse(approval.payload);

    if (approval.action === 'install_packages') {
      const agentGroup = getAgentGroup(session.agent_group_id);
      const containerConfig = agentGroup?.container_config ? JSON.parse(agentGroup.container_config) : {};
      if (!containerConfig.packages) containerConfig.packages = { apt: [], npm: [] };
      if (payload.apt) containerConfig.packages.apt.push(...payload.apt);
      if (payload.npm) containerConfig.packages.npm.push(...payload.npm);

      updateAgentGroup(session.agent_group_id, { container_config: JSON.stringify(containerConfig) });

      writeSystemResponse(session.agent_group_id, session.id, approval.request_id, 'success', {
        message: 'Packages approved. Run request_rebuild to apply.',
        approved: { apt: payload.apt, npm: payload.npm },
      });

      log.info('Package install approved', { approvalId: approval.approval_id, userId });
    } else if (approval.action === 'request_rebuild') {
      try {
        await buildAgentGroupImage(session.agent_group_id);
        writeSystemResponse(session.agent_group_id, session.id, approval.request_id, 'success', {
          message: 'Container image rebuilt. Changes will take effect on next container start.',
        });
        log.info('Container rebuild approved and completed', { approvalId: approval.approval_id, userId });
      } catch (e) {
        writeSystemResponse(session.agent_group_id, session.id, approval.request_id, 'error', {
          error: `Rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        log.error('Container rebuild failed', { approvalId: approval.approval_id, err: e });
      }
    }
  } else {
    // Rejected
    writeSystemResponse(session.agent_group_id, session.id, approval.request_id, 'error', {
      error: `Request rejected by admin (${userId})`,
    });
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
  }

  deletePendingApproval(approval.approval_id);

  // Wake container so the agent's polling MCP tool picks up the response
  if (session) {
    await wakeContainer(session);
  }
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  stopDeliveryPolls();
  stopHostSweep();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
