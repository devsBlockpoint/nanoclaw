/**
 * Bootstrap idempotente del agent group `monica`.
 *
 * Crea (o reutiliza) la fila en `agent_groups` con name='Mónica',
 * folder='monica', e inicializa el filesystem del grupo.
 *
 * IMPORTANTE: el campo `name` debe ser exactamente 'Mónica' (con acento y M
 * mayúscula) porque `ensureRuntimeFields()` en container-runner.ts sobreescribe
 * `container.json.assistantName` con `agent_groups.name` en cada spawn.
 *
 * Run: pnpm exec tsx scripts/init-monica-agent.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotente

  const now = new Date().toISOString();

  // 1. Agent group — idempotente: reutiliza si folder='monica' ya existe.
  let ag = getAgentGroupByFolder('monica');
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: 'Mónica',
      folder: 'monica',
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder('monica')!;
    console.log(`Created agent group: ${ag.id} (monica)`);
  } else {
    console.log(`Agent group already exists: ${ag.id} (${ag.folder}) — skipping create`);
  }

  // 2. Filesystem del grupo — idempotente: cada paso comprueba si ya existe.
  //    Inicializa groups/monica/, CLAUDE.local.md, container.json esqueleto,
  //    y data/v2-sessions/<id>/.claude-shared/ con settings.json y skills/.
  initGroupFilesystem(ag, {
    instructions:
      '# Mónica\n\n' +
      'Eres Mónica, la asistente virtual de ÉLEVÉ.\n\n' +
      '[System prompt cargado en runtime via AGENT_SYSTEM_PROMPT_SOURCE]\n',
  });

  // 3. Instrucciones para el operador.
  console.log('');
  console.log('Bootstrap complete.');
  console.log(`  agent group id : ${ag.id}`);
  console.log(`  name           : ${ag.name}`);
  console.log(`  folder         : groups/${ag.folder}/`);
  console.log('');
  console.log('Next steps:');
  console.log('');
  console.log('  1. Set OneCLI secret mode so the container can reach Anthropic:');
  console.log('');
  console.log('       onecli agents list');
  console.log(`       onecli agents set-secret-mode --id <agent-id> --mode all`);
  console.log('');
  console.log('     The agent-id is assigned by OneCLI the first time the host spawns');
  console.log('     a container for this group (identifier = agent group id above).');
  console.log('     Run "onecli agents list" after the first inbound message to find it.');
  console.log('');
  console.log('  2. Messaging-group → agent-group wiring is automatic:');
  console.log('     The eleve-http adapter auto-wires each new conversation_id to');
  console.log('     this agent group on the first inbound POST /messages.');
  console.log('     No manual setup per WhatsApp conversation is required.');
  console.log('');
  console.log('  3. Ensure env vars are set before starting nanoclaw:');
  console.log('     AGENT_INBOUND_TOKEN, ELEVE_OUTBOUND_URL, ELEVE_OUTBOUND_TOKEN,');
  console.log('     AGENT_SYSTEM_PROMPT_SOURCE (+ AGENT_SYSTEM_PROMPT if source=env).');
  console.log('');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
