# ÉLEVÉ × nanoclaw — Customization Map

**Fecha:** 2026-04-28  
**Rama:** fork de `qwibitai/nanoclaw` (upstream completo presente)  
**Propósito:** Guía técnica precisa para implementar la integración ÉLEVÉ. Cubre rutas de archivos, rangos de línea y decisiones de implementación. No modifica código.

---

## Tabla de Contenidos

- [A) Canal adapter pattern](#a-canal-adapter-pattern)
- [B) Outbound a n8n-whatsapp-agent-response](#b-outbound-a-n8n-whatsapp-agent-response)
- [C) MCP over HTTP wiring](#c-mcp-over-http-wiring)
- [D) System prompt 3-source loader](#d-system-prompt-3-source-loader)
- [E) Agent group `monica`](#e-agent-group-monica)
- [F) Env vars a agregar](#f-env-vars-a-agregar)
- [G) Riesgos y desconocidos](#g-riesgos-y-desconocidos)
- [H) Plan 3 — Task breakdown](#h-plan-3--task-breakdown)

---

## A) Canal adapter pattern

### A.1 Interfaz que debe implementar un nuevo adapter

**Archivo:** `src/channels/adapter.ts` (líneas 111–178)

Un adapter debe implementar `ChannelAdapter`:

```typescript
interface ChannelAdapter {
  name: string;          // identificador textual
  channelType: string;   // clave de lookup en el registry (único)
  supportsThreads: boolean;  // false para WhatsApp-style channels

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound — retorna platform message ID si está disponible
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Opcionales
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
}
```

`ChannelSetup` (pasado por el host al llamar `adapter.setup()`):

```typescript
interface ChannelSetup {
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}
```

`InboundMessage` que el adapter pasa a `onInbound`:

```typescript
interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;     // JS object — host lo JSON.stringify antes de escribir a session DB
  timestamp: string;
  isMention?: boolean;  // true para que el router engaje sin regex de nombre
  isGroup?: boolean;
}
```

### A.2 Auto-registro en el registry

**Archivo:** `src/channels/channel-registry.ts` (líneas 21–27)

El registry es un `Map<string, ChannelRegistration>`. Cada adapter llama:

```typescript
registerChannelAdapter('eleve-http', { factory: createAdapter });
```

en su última línea (patrón de `cli.ts` línea 276). Luego se importa desde el barrel:

**Archivo:** `src/channels/index.ts`

```typescript
import './eleve-http.js';  // agregar esta línea
```

### A.3 Ciclo de vida — cómo se inicializa

**Archivo:** `src/index.ts` (líneas 75–127)

```typescript
await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
  return {
    onInbound(platformId, threadId, message) {
      routeInbound({ channelType: adapter.channelType, platformId, threadId, ... });
    },
    onInboundEvent(event) { routeInbound(event); },
    onMetadata(...) { ... },
    onAction(...) { ... },
  };
});
```

`initChannelAdapters` llama `factory()` de cada `ChannelRegistration`, luego `adapter.setup(setup)` con retry en `NetworkError`. Registra el adapter vivo en `activeAdapters` por `channelType`.

### A.4 Cómo los mensajes inbound llegan al router

**Archivo:** `src/router.ts` (función `routeInbound`, línea 144)

El flujo es:
1. `adapter.setup(config)` recibe `config.onInbound`
2. Cuando llega un mensaje HTTP, el adapter llama `config.onInbound(platformId, null, msg)`
3. El host construye un `InboundEvent` con `channelType = adapter.channelType` y llama `routeInbound(event)`
4. El router busca/crea `messaging_group` por `(channel_type, platform_id)`, evalúa `engage_mode`, resuelve sesión, escribe `inbound.db`, llama `wakeContainer`

### A.5 Cómo los replies outbound llegan al adapter

**Archivo:** `src/delivery.ts` (líneas 52–63, 130–150, 354–362)

El host tiene un `ChannelDeliveryAdapter` (líneas 52–63):

```typescript
interface ChannelDeliveryAdapter {
  deliver(channelType, platformId, threadId, kind, content, files?): Promise<string | undefined>;
  setTyping?(channelType, platformId, threadId): Promise<void>;
}
```

En `src/index.ts` (líneas 130–150), el host crea un delivery adapter que despacha a `getChannelAdapter(channelType).deliver(...)`. El polling (`pollActive` cada 1s y `pollSweep` cada 60s) lee `outbound.db`, filtra ya-entregados via `inbound.db/delivered`, y para cada mensaje llama:

```typescript
deliveryAdapter.deliver(msg.channel_type, msg.platform_id, msg.thread_id, msg.kind, msg.content, files)
```

que resuelve al `ChannelAdapter` por `channelType` y llama:

```typescript
adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files })
```

`OutboundMessage` que recibe el adapter `deliver()`:

```typescript
interface OutboundMessage {
  kind: string;
  content: unknown;      // objeto parseado del JSON de messages_out
  files?: OutboundFile[];
}
```

### A.6 Plan concreto para `eleve-http` adapter

**Archivo nuevo:** `src/channels/eleve-http.ts`

**channelType:** `eleve-http` (string único, no colisiona con nada existente)

**Estructura del adapter:**

```typescript
import http from 'http';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const INBOUND_TOKEN = process.env.AGENT_INBOUND_TOKEN;
const PORT = parseInt(process.env.NANOCLAW_PORT || '3001', 10);
const OUTBOUND_URL = process.env.ELEVE_OUTBOUND_URL;
const OUTBOUND_TOKEN = process.env.ELEVE_OUTBOUND_TOKEN;

function createAdapter(): ChannelAdapter | null {
  if (!INBOUND_TOKEN) {
    log.warn('AGENT_INBOUND_TOKEN missing — eleve-http adapter skipped');
    return null;  // retornar null hace que el registry lo salte (línea 57 channel-registry.ts)
  }

  let server: http.Server | null = null;
  let setupConfig: ChannelSetup;

  const adapter: ChannelAdapter = {
    name: 'eleve-http',
    channelType: 'eleve-http',
    supportsThreads: false,   // WhatsApp = no threads; router colapsa threadId a null

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      server = http.createServer(handleRequest);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(PORT, '0.0.0.0', () => {
          log.info('eleve-http adapter listening', { port: PORT });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean { return server !== null; },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      // Llamado por el host delivery poll cuando el agente tiene una respuesta lista.
      // platformId = conversation_id (el mismo que vino en el inbound POST).
      if (!OUTBOUND_URL || !OUTBOUND_TOKEN) {
        log.error('ELEVE_OUTBOUND_URL or ELEVE_OUTBOUND_TOKEN missing — cannot deliver');
        return;
      }
      const content = message.content as Record<string, unknown>;
      const body = {
        conversation_id: platformId,
        message: (content.text as string) || (content.markdown as string) || '',
        action: (content.action as string) || undefined,
        metadata: (content.metadata as Record<string, unknown>) || undefined,
      };
      const resp = await fetch(OUTBOUND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OUTBOUND_TOKEN}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new Error(`ELEVE outbound failed: ${resp.status} ${await resp.text()}`);
      }
      return undefined;
    },
  };

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/messages') {
      res.writeHead(404); res.end(); return;
    }

    // Auth
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== INBOUND_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Responder 202 inmediatamente (fire-and-forget)
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));

    // Leer body y routear
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void processInbound(Buffer.concat(chunks).toString('utf8'));
    });
  }

  async function processInbound(rawBody: string): Promise<void> {
    let payload: { conversation_id: string; message: string; sender?: { phone?: string; name?: string }; metadata?: unknown };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log.warn('eleve-http: ignoring non-JSON inbound body');
      return;
    }

    const { conversation_id, message, sender, metadata } = payload;
    if (!conversation_id || !message) {
      log.warn('eleve-http: missing conversation_id or message');
      return;
    }

    // platformId = conversation_id (se persiste en messaging_groups.platform_id)
    // threadId = null (supportsThreads=false; router lo colapsa igual)
    await setupConfig.onInbound(conversation_id, null, {
      id: `eleve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,   // siempre true: ÉLEVÉ solo manda si ya está dirigido al agente
      isGroup: false,
      content: {
        text: message,
        sender: sender?.name || sender?.phone || 'usuario',
        senderId: sender?.phone ? `phone:${sender.phone}` : `eleve:${conversation_id}`,
        metadata,
      },
    });
  }

  return adapter;
}

registerChannelAdapter('eleve-http', { factory: createAdapter });
```

**Notas clave:**

- `platformId` = `conversation_id` (el UUID de ÉLEVÉ). Se almacena en `messaging_groups.platform_id`. El router busca `(channel_type='eleve-http', platform_id=conversation_id)` para resolver la sesión.
- `supportsThreads: false` hace que el router llame `event = { ...event, threadId: null }` (línea 149 `router.ts`), garantizando una sesión compartida por conversation.
- `isMention: true` es esencial. El router auto-crea un `messaging_group` solo si `isMention=true` (línea 163 `router.ts`). Sin esto, la primera vez que llega un conversation_id desconocido, el mensaje se descarta silenciosamente.
- El adapter retorna `null` si falta `AGENT_INBOUND_TOKEN` — el registry lo salta limpiamente (línea 57 `channel-registry.ts`).

### A.7 Wiring en el host — qué hay que tocar

1. **Agregar import al barrel** `src/channels/index.ts`:
   ```typescript
   import './eleve-http.js';
   ```
   Un adapter habilitado simplemente importándose. No hay registry de enable/disable: el adapter retorna `null` si le faltan credenciales. Equivale a "deshabilitado automáticamente".

2. **No tocar** `src/index.ts`, `src/router.ts`, `src/delivery.ts` — el patrón de auto-registro cubre todo.

3. **Opcionalmente desactivar `cli`**: el adapter CLI siempre está activo si se importa desde `channels/index.ts`. Para una deploy de producción donde no hay terminal local, se puede eliminar `import './cli.js'` del barrel. Sin embargo, el CLI es completamente inofensivo en un container Docker (el socket está en `data/cli.sock` y nadie se conecta). **Recomendación: mantener CLI en el barrel** — facilita debugging sin reiniciar el container.

### A.8 Healthcheck

El spec requiere `GET /health`. Agregar al mismo `createServer`:

```typescript
if (req.method === 'GET' && req.url === '/health') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
  return;
}
```

---

## B) Outbound a n8n-whatsapp-agent-response

### B.1 Cómo fluye el outbound

**Archivo:** `src/delivery.ts`

El ciclo completo:

1. El agente (container) escribe a `outbound.db/messages_out` via `writeMessageOut()` (`container/agent-runner/src/db/messages-out.ts` línea 45).
2. El host lee `outbound.db` cada 1s (`pollActive`) o 60s (`pollSweep`) via `drainSession()` (línea 164).
3. `deliverMessage()` (línea 234) extrae de `messages_out`:
   - `msg.channel_type` — qué adapter usar
   - `msg.platform_id` — destino dentro del adapter
   - `msg.thread_id` — null para eleve-http
   - `msg.content` — JSON del mensaje
4. Llama `deliveryAdapter.deliver(channel_type, platform_id, thread_id, kind, content, files)` (línea 355).
5. La `deliveryAdapter` global (creada en `src/index.ts` línea 130) busca el adapter en el registry y llama `adapter.deliver(platformId, threadId, { kind, content, files })`.

### B.2 Qué datos tiene el adapter al momento de delivery

El `platform_id` que llega a `adapter.deliver()` es exactamente lo que el agente escribió en `messages_out.platform_id`. El agente lo hereda del `messages_in.platform_id` original — que el host escribió cuando recibió el inbound, tomándolo del `deliveryAddr.platformId` del evento (línea 404 `router.ts`). En nuestro caso:

```
ÉLEVÉ POST /messages { conversation_id: "uuid-123" }
  → adapter.setup().onInbound("uuid-123", null, msg)
  → router InboundEvent { channelType: "eleve-http", platformId: "uuid-123", threadId: null }
  → messages_in.platform_id = "uuid-123"
  → (el agente lee messages_in, genera respuesta)
  → messages_out.platform_id = "uuid-123"   ← el agente replica el platform_id del inbound
  → delivery: adapter.deliver("uuid-123", null, outboundMsg)
  → eleve-http.deliver() → POST a ÉLEVÉ { conversation_id: "uuid-123", message: "..." }
```

El `conversation_id` llega intacto porque el agente copia `platform_id` de inbound a outbound. Esto lo hace el MCP tool `send_message` en `container/agent-runner/src/mcp-tools/core.ts` (buscar `getRoutingBySeq` que recupera channel_type/platform_id del mensaje inbound más reciente).

### B.3 Contrato de deliver() para eleve-http

```typescript
async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined>
```

- `platformId` = `conversation_id` de ÉLEVÉ
- `message.content` = objeto parseado de `messages_out.content` JSON
- Para mensajes de texto normal: `content.text` o `content.markdown`
- Para mensajes sistema (schedule_task, etc.): `message.kind === 'system'` → manejados por `handleSystemAction` antes de llegar al adapter; el adapter nunca los ve
- La función puede `throw` si el POST falla → el host reintenta hasta 3 veces, luego marca como failed

### B.4 Body del POST outbound

```typescript
POST ${ELEVE_OUTBOUND_URL}
Authorization: Bearer ${ELEVE_OUTBOUND_TOKEN}
Content-Type: application/json

{
  "conversation_id": platformId,          // UUID de whatsapp_conversations
  "message": content.text || content.markdown,
  "action"?: content.action,             // "escalate" | "transfer" | "close" | "schedule_followup"
  "metadata"?: content.metadata
}
```

Para soportar `action` y `metadata`, el agente tendría que escribirlos explícitamente en el `content` de su `send_message`. El MCP tool `send_message` actualmente soporta solo `text` y `markdown`. **Punto de extensión:** si ÉLEVÉ necesita `action`, el agente puede incluirlo en su texto siguiendo un formato estructurado que el adapter parsea, o se extiende el MCP tool `send_message` con campos adicionales.

### B.5 Persistencia de conversation_id

El `conversation_id` se persiste en `messaging_groups.platform_id` (central DB `data/v2.db`). Una vez creado el `messaging_group` para `(channel_type='eleve-http', platform_id='uuid-123')`, ese registro persiste indefinidamente, dando memoria de sesión automática por conversation.

El par `(agent_group_id, messaging_group_id)` define la sesión. Cuando ÉLEVÉ reenvía el mismo `conversation_id`, el router lo resuelve a la misma sesión.

---

## C) MCP over HTTP wiring

### C.1 Estado actual del RunnerConfig.mcpServers

**Archivo:** `container/agent-runner/src/config.ts` (línea 18)

```typescript
mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
```

Actualmente la interfaz solo soporta stdio (command + args + env).

**Archivo:** `container/agent-runner/src/providers/types.ts` (líneas 52–56)

```typescript
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
```

Mismo esquema stdio-only.

**Archivo:** `container/agent-runner/src/index.ts` (líneas 76–87)

```typescript
const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
  nanoclaw: { command: 'bun', args: ['run', mcpServerPath], env: {} },
};
for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
  mcpServers[name] = serverConfig;
}
```

El runner pasa `mcpServers` al `ClaudeProvider` que lo pasa a `sdkQuery()` opción `mcpServers`.

### C.2 El SDK SÍ soporta HTTP MCP

**Archivo:** `docs/SDK_DEEP_DIVE.md` (líneas 132–138)

El `@anthropic-ai/claude-agent-sdk` v0.2.116 (Claude Code 2.1.116) acepta:

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }
```

Ambos `'sse'` (SSE transport — legacy MCP HTTP) y `'http'` (nuevo Streamable HTTP transport de MCP spec) son soportados por el SDK. `mcp-monica` usa `@modelcontextprotocol/sdk`, que por defecto levanta un servidor SSE-compatible.

### C.3 Cambios mínimos necesarios

#### 1. Ampliar RunnerConfig.mcpServers en config.ts

**Archivo:** `container/agent-runner/src/config.ts`

Cambiar la línea 18 de:

```typescript
mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
```

a:

```typescript
mcpServers: Record<string, StdioMcpServer | HttpMcpServer>;
```

Con interfaces:

```typescript
interface StdioMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpMcpServer {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
}
```

#### 2. Ampliar McpServerConfig en types.ts

**Archivo:** `container/agent-runner/src/providers/types.ts`

```typescript
export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> };
```

#### 3. Actualizar index.ts del runner

**Archivo:** `container/agent-runner/src/index.ts` (líneas 76–87)

El tipo del map debe reflejar la unión. El loop `for (const [name, serverConfig] of Object.entries(config.mcpServers))` ya funciona — solo necesita que el tipo sea correcto. El SDK acepta la unión directamente en `mcpServers`.

#### 4. McpServerConfig en container-config.ts (host side)

**Archivo:** `src/container-config.ts` (líneas 17–25)

La interfaz `McpServerConfig` del host-side define qué se escribe en `container.json`:

```typescript
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}
```

Extender a:

```typescript
export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; instructions?: string }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string>; instructions?: string };
```

El host escribe `container.json` con este esquema. El runner lo lee y lo pasa al SDK.

### C.4 Esquema de groups/monica/container.json

```json
{
  "provider": "claude",
  "assistantName": "Mónica",
  "mcpServers": {
    "mcp-monica": {
      "type": "sse",
      "url": "http://mcp-monica:3000/sse",
      "headers": {}
    }
  },
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": ["welcome"]
}
```

**Nota sobre el URL:** En docker-compose, `mcp-monica` es el nombre del servicio. nanoclaw lo resuelve via DNS interno del network `eleve-net`. El path `/sse` es el endpoint estándar del `@modelcontextprotocol/sdk` SSE server. Si `mcp-monica` usa Streamable HTTP (nuevo protocolo MCP), el path sería `/mcp` y el type sería `'http'`.

**`assistantName` en container.json vs container-runner.ts:** El host escribe `assistantName` en `container.json` via `ensureRuntimeFields()` (línea 406 `container-runner.ts`) copiándolo de `agentGroup.name`. Para Mónica, el `agent_groups.name` en la DB debe ser `'Mónica'`. Alternativamente, se puede pre-escribir `container.json` con `assistantName: 'Mónica'` que `ensureRuntimeFields()` sobreescribirá con el nombre de DB — por eso el nombre correcto debe estar en `agent_groups.name`.

### C.5 MCP monica instructions fragment

Si se quiere que el agente tenga instrucciones sobre cómo usar las herramientas de mcp-monica, se puede agregar el campo `instructions` en container.json:

```json
{
  "mcpServers": {
    "mcp-monica": {
      "type": "sse",
      "url": "http://mcp-monica:3000/sse",
      "instructions": "## Herramientas ÉLEVÉ\n\nTienes acceso a las herramientas de negocio de ÉLEVÉ via mcp-monica:\n- `book_appointment`: agendar cita\n- `check_availability`: verificar disponibilidad\n..."
    }
  }
}
```

El host escribe este fragment como `groups/monica/.claude-fragments/mcp-mcp-monica.md` en cada spawn (línea 94 `claude-md-compose.ts`).

---

## D) System prompt 3-source loader

### D.1 Cómo funciona el system prompt actualmente

**Archivo:** `src/claude-md-compose.ts` (función `composeGroupClaudeMd`, líneas 42–130)

Actualmente, en cada spawn de container, el host regenera `groups/<folder>/CLAUDE.md` con:

1. Una referencia `@./.claude-shared.md` (symlink a `/app/CLAUDE.md` — el container/CLAUDE.md compartido)
2. Fragments de skills con `instructions.md`
3. Fragments de MCP tools built-in
4. Fragments de MCP servers externos (campo `instructions` en container.json)
5. La memoria por grupo vive en `CLAUDE.local.md` (RW, auto-loaded por Claude Code)

El CLAUDE.md compuesto es un archivo de imports `@path` — Claude Code lo carga y sigue los `@` references. El system prompt real del agente es la composición de todos estos archivos.

**El "system prompt de Mónica" NO es el CLAUDE.md.** El CLAUDE.md es leído por Claude Code como contexto de proyecto (cargado via `settingSources: ['project', 'user']` en `claude.ts` línea 276). El system prompt del SDK se inyecta via la opción `systemPrompt` (línea 275): `{ type: 'preset', preset: 'claude_code', append: instructions }` donde `instructions` es solo el addendum de identidad y destinos (línea 54 `index.ts` del runner).

**Conclusión crítica:** Para Mónica, el "system prompt" en el sentido del spec (las instrucciones de negocio de la asistente) debe ir en `groups/monica/CLAUDE.local.md` o en `groups/monica/CLAUDE.md` — este último regenerado en cada spawn. La forma más limpia es escribirlo en `CLAUDE.local.md` (RW persistente, auto-loaded, no sobreescrito por el compositor).

### D.2 Dónde insertar el loader

El loader debe correr **antes de cada spawn de container** (o una vez al arrancar el host si el contenido no cambia).

**Hook más limpio:** Agregar una llamada al loader en `container-runner.ts/buildMounts()` (línea 230), justo antes de que se llame a `composeGroupClaudeMd(agentGroup)` en la línea 249.

Alternativamente para simplificar: correr en `src/index.ts` al arrancar, antes de inicializar los adapters, y solo si `AGENT_SYSTEM_PROMPT_RELOAD_INTERVAL=0` (default). Si `RELOAD_INTERVAL > 0`, correr periódicamente.

**Archivo nuevo:** `src/system-prompt-loader.ts`

```typescript
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

const SOURCE = process.env.AGENT_SYSTEM_PROMPT_SOURCE || 'env';
const PROMPT_ENV = process.env.AGENT_SYSTEM_PROMPT || '';
const PROMPT_PATH = process.env.AGENT_SYSTEM_PROMPT_PATH || '';
const PROMPT_URL = process.env.AGENT_SYSTEM_PROMPT_URL || '';
const PROMPT_URL_AUTH = process.env.AGENT_SYSTEM_PROMPT_URL_AUTH || '';
const CACHE_PATH = process.env.AGENT_SYSTEM_PROMPT_CACHE_PATH || '/data/system-prompt.cache.md';
const GROUP_FOLDER = process.env.AGENT_GROUP || 'monica';

const TARGET_FILE = path.join(GROUPS_DIR, GROUP_FOLDER, 'CLAUDE.local.md');

export async function loadSystemPrompt(): Promise<void> {
  let content: string | null = null;

  switch (SOURCE) {
    case 'env': {
      if (!PROMPT_ENV) throw new Error('AGENT_SYSTEM_PROMPT_SOURCE=env but AGENT_SYSTEM_PROMPT is empty');
      content = PROMPT_ENV;
      break;
    }
    case 'file': {
      if (!PROMPT_PATH) throw new Error('AGENT_SYSTEM_PROMPT_SOURCE=file but AGENT_SYSTEM_PROMPT_PATH is empty');
      content = fs.readFileSync(PROMPT_PATH, 'utf-8');
      break;
    }
    case 'url': {
      if (!PROMPT_URL) throw new Error('AGENT_SYSTEM_PROMPT_SOURCE=url but AGENT_SYSTEM_PROMPT_URL is empty');
      content = await fetchPromptFromUrl();
      break;
    }
    default:
      throw new Error(`Unknown AGENT_SYSTEM_PROMPT_SOURCE: ${SOURCE}`);
  }

  // Escribir al CLAUDE.local.md del grupo — auto-loaded por Claude Code
  const groupDir = path.join(GROUPS_DIR, GROUP_FOLDER);
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(TARGET_FILE, content + '\n');
  log.info('System prompt written', { source: SOURCE, target: TARGET_FILE, bytes: content.length });
}

async function fetchPromptFromUrl(): Promise<string> {
  const headers: Record<string, string> = { 'Accept': 'text/plain, text/markdown' };
  if (PROMPT_URL_AUTH) headers['Authorization'] = PROMPT_URL_AUTH;

  try {
    const resp = await fetch(PROMPT_URL, { headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    // Cache exitoso
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, text);
    log.info('System prompt fetched from URL and cached', { url: PROMPT_URL });
    return text;
  } catch (err) {
    log.warn('Failed to fetch system prompt URL, trying cache', { url: PROMPT_URL, err });
    if (!fs.existsSync(CACHE_PATH)) {
      throw new Error(`System prompt URL fetch failed and no cache at ${CACHE_PATH}. Container cannot start.`);
    }
    const cached = fs.readFileSync(CACHE_PATH, 'utf-8');
    log.warn('Using cached system prompt', { cachePath: CACHE_PATH });
    return cached;
  }
}
```

### D.3 Wiring en src/index.ts

En `src/index.ts`, antes de `initChannelAdapters`:

```typescript
// 0.5 Load system prompt (runs before adapters so first message has current prompt)
import { loadSystemPrompt } from './system-prompt-loader.js';
await loadSystemPrompt();
```

Para hot-reload opcional:

```typescript
const RELOAD_INTERVAL = parseInt(process.env.AGENT_SYSTEM_PROMPT_RELOAD_INTERVAL || '0', 10);
if (RELOAD_INTERVAL > 0) {
  setInterval(() => {
    void loadSystemPrompt().catch((err) => log.error('System prompt reload failed', { err }));
  }, RELOAD_INTERVAL * 1000);
}
```

### D.4 Por qué CLAUDE.local.md y no CLAUDE.md

- `CLAUDE.md` es sobreescrito en cada spawn por `composeGroupClaudeMd()` (línea 124 `claude-md-compose.ts`) — si escribimos ahí, se pierde en el próximo spawn
- `CLAUDE.local.md` es el archivo de memoria por grupo — creado vacío por `initGroupFilesystem()` si no existe, nunca sobreescrito por el compositor
- Claude Code auto-carga `CLAUDE.local.md` (comentario línea 48 `group-init.ts`: "auto-loaded by Claude Code")
- El system prompt de Mónica (instrucciones de negocio) es exactamente el tipo de contenido que pertenece en `CLAUDE.local.md`

**Alternativa:** Si se quiere separar claramente el system prompt del estado de memoria del agente, escribir a un archivo separado como `groups/monica/system-prompt.md` e importarlo desde `CLAUDE.local.md` con `@./system-prompt.md`. Pero para v1, escribir directamente a `CLAUDE.local.md` es más simple.

---

## E) Agent group `monica`

### E.1 Estructura de referencia: groups/main/ y groups/global/

`groups/main/CLAUDE.md` (archivo existente):
- Empieza con `@./.claude-global.md` (importación del global)
- Luego las instrucciones del agente Main

`groups/global/CLAUDE.md` (archivo existente):
- Instrucciones globales compartidas por todos los grupos

**Nota importante:** `migrateGroupsToClaudeLocal()` en `claude-md-compose.ts` (línea 146) **elimina** `groups/global/` en la primera ejecución del host actualizado. Esto es una migración one-time del upstream v2. Si estos archivos existen, van a ser eliminados por el host al arrancar.

### E.2 Estructura de groups/monica/

```
groups/monica/
├── CLAUDE.md           # Generado en cada spawn por composeGroupClaudeMd()
│                       # Contenido: imports @references — no editar a mano
├── CLAUDE.local.md     # Sobreescrito por system-prompt-loader.ts al arrancar
│                       # (o en cada spawn si se usa modo per-wake)
│                       # En v1: contiene el system prompt de Mónica
└── container.json      # Config del agent group
```

### E.3 Placeholder de CLAUDE.local.md

Al primer arranque sin loader (o si `AGENT_SYSTEM_PROMPT_SOURCE` no está seteado), se puede tener un placeholder:

```markdown
# Mónica

Eres Mónica, la asistente virtual de ÉLEVÉ.

[System prompt cargado en runtime via AGENT_SYSTEM_PROMPT_SOURCE]
```

El loader lo sobreescribe al arrancar.

### E.4 container.json de monica

```json
{
  "provider": "claude",
  "assistantName": "Mónica",
  "mcpServers": {
    "mcp-monica": {
      "type": "sse",
      "url": "http://mcp-monica:3000/sse"
    }
  },
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": ["welcome"]
}
```

**El campo `assistantName` será sobreescrito** por `ensureRuntimeFields()` en `container-runner.ts` (línea 393) con el valor de `agent_groups.name` en la DB. Para que Mónica aparezca como `'Mónica'`, hay que insertar el agent group con `name = 'Mónica'` en la central DB.

### E.5 Bootstrapping del agent group en la DB

No hay una migración automática que crea el agent group `monica` — hay que seederlo. Opciones:

**Opción A (recomendada para production):** Script de bootstrap similar a `scripts/init-first-agent.ts`, pero para HTTP adapter:

```bash
pnpm exec tsx scripts/init-monica-agent.ts
```

El script debe:
1. Llamar `createAgentGroup({ id, name: 'Mónica', folder: 'monica', ... })`
2. Llamar `initGroupFilesystem(agentGroup)`
3. NO crear messaging_group ni wiring — el adapter los crea automáticamente cuando llega el primer mensaje

**Opción B:** El adapter `eleve-http` puede auto-crear el agent group al arrancar si no existe. Más acoplamiento pero menos setup manual.

**Opción C:** Migración SQL en `src/db/migrations/` — limpio pero requiere número de migración único.

### E.6 Wiring automático de messaging groups

Cuando llega el primer `POST /messages` con un `conversation_id` nuevo:

1. Router llama `getMessagingGroupWithAgentCount('eleve-http', conversationId)` → null (no existe)
2. Como `isMention=true`, auto-crea `messaging_group` (línea 167 `router.ts`)
3. `agentCount = 0` → ningún agente wired → llama `channelRequestGate` (si está registrado por el módulo de permisos)

**Problema:** El router NO auto-wira agents. `channelRequestGate` escala al owner para aprobación. Sin el módulo de permisos, simplemente descarta el mensaje con log warning.

**Solución para ÉLEVÉ:** El adapter eleve-http debe auto-wirear la messaging_group al agent group `monica` al crear la primera sesión. Dos formas:

**Forma 1 (limpia):** Después de `config.onInbound(...)`, si es la primera vez que se ve este conversation_id, llamar `createMessagingGroupAgent()` desde el adapter antes de `onInbound`. Esto requiere que el adapter tenga acceso a la DB (importar `src/db/`).

**Forma 2 (alternativa):** Crear un script de setup que pre-registre el adapter como "wired to monica for all conversations" usando un wildcard, si el router lo soporta. No existe tal mecanismo en upstream.

**Forma 3 (recomendada):** En el adapter `eleve-http.processInbound()`, antes de llamar `config.onInbound()`, verificar si existe el `messaging_group` y si tiene el wiring a `monica`. Si no, crearlo programáticamente:

```typescript
import { getMessagingGroupByPlatform, createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgentByPair } from '../db/messaging-groups.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
// ...

async function ensureWiring(conversationId: string): Promise<void> {
  const ag = getAgentGroupByFolder('monica');
  if (!ag) { log.error('Agent group monica not found'); return; }

  let mg = getMessagingGroupByPlatform('eleve-http', conversationId);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: mgId, channel_type: 'eleve-http', platform_id: conversationId,
      name: null, is_group: 0, unknown_sender_policy: 'strict', created_at: new Date().toISOString()
    });
    mg = getMessagingGroupByPlatform('eleve-http', conversationId)!;
  }
  const existingWire = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existingWire) {
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id, agent_group_id: ag.id,
      engage_mode: 'pattern', engage_pattern: '.',
      sender_scope: 'all', ignored_message_policy: 'drop',
      session_mode: 'shared', priority: 0, created_at: new Date().toISOString()
    });
    log.info('Auto-wired conversation to monica', { conversationId });
  }
}
```

Llamar `await ensureWiring(conversationId)` antes de `config.onInbound(...)` en `processInbound()`.

### E.7 Mantener o eliminar groups/main/ y groups/global/

**Recomendación: mantener `groups/main/` pero no crear `groups/global/`**

- `groups/global/` es eliminado automáticamente por `migrateGroupsToClaudeLocal()` al primer arranque del host v2 (comportamiento upstream no modificado). No hay que hacer nada.
- `groups/main/` es el agent group de la CLI. Puede usarse para control administrativo local. No interfiere con el adapter eleve-http. Mantenerlo es inofensivo.
- Si se quiere un deploy minimalista, se puede omitir seed de `main` — el adapter CLI funcionará sin messaging_group pre-existente si el operador inicia chat via `scripts/chat.ts`.

---

## F) Env vars a agregar

### F.1 Listado exhaustivo

| Variable | Leída en | Default / Fallback | Falla si falta |
|---|---|---|---|
| `AGENT_INBOUND_TOKEN` | `src/channels/eleve-http.ts` | — | Adapter retorna `null` → no se inicia, nanoclaw no recibe mensajes |
| `NANOCLAW_PORT` | `src/channels/eleve-http.ts` | `3001` | Usa 3001 (safe) |
| `AGENT_SYSTEM_PROMPT_SOURCE` | `src/system-prompt-loader.ts` | `env` | Usa `env` como default |
| `AGENT_SYSTEM_PROMPT` | `src/system-prompt-loader.ts` | — | Fatal si `SOURCE=env` y está vacío |
| `AGENT_SYSTEM_PROMPT_PATH` | `src/system-prompt-loader.ts` | — | Fatal si `SOURCE=file` |
| `AGENT_SYSTEM_PROMPT_URL` | `src/system-prompt-loader.ts` | — | Fatal si `SOURCE=url` |
| `AGENT_SYSTEM_PROMPT_URL_AUTH` | `src/system-prompt-loader.ts` | — | OK si falta (URL pública) |
| `AGENT_SYSTEM_PROMPT_RELOAD_INTERVAL` | `src/index.ts` | `0` (off) | Usa 0 (safe) |
| `AGENT_SYSTEM_PROMPT_CACHE_PATH` | `src/system-prompt-loader.ts` | `/data/system-prompt.cache.md` | Usa default |
| `AGENT_GROUP` | `src/system-prompt-loader.ts` | `monica` | Usa `monica` |
| `ELEVE_OUTBOUND_URL` | `src/channels/eleve-http.ts` (deliver) | — | deliver() falla, mensajes marcados como failed |
| `ELEVE_OUTBOUND_TOKEN` | `src/channels/eleve-http.ts` (deliver) | — | deliver() falla, mensajes marcados como failed |
| `MCP_MONICA_URL` | `groups/monica/container.json` (template) | — | El agente no tiene herramientas de negocio |
| `ANTHROPIC_API_KEY` | Claude Code CLI (via OneCLI vault) | — | El container no puede llamar a Claude |

**Sobre `MCP_MONICA_URL`:** El `container.json` es un archivo estático en el filesystem. Para que el URL sea env-driven, el host debe sustituirlo al escribir el archivo. Opciones:
- El `container.json` se genera como template durante el deploy (CI/CD o script de init)
- O el loader de system prompt también escribe `container.json` con el URL correcto
- O se hardcodea `http://mcp-monica:3000/sse` (nombre de servicio docker-compose) que es estable

**Recomendación:** Hardcodear en `groups/monica/container.json` el URL interno de docker-compose (`http://mcp-monica:3000/sse`). Si se necesita flexibilidad, agregar un loader de container.json similar al de system prompt.

### F.2 Archivo .env.example sugerido para nanoclaw

```bash
# ── ÉLEVÉ bridge ──────────────────────────────────────────
# Token que ÉLEVÉ envía en Authorization: Bearer <token>
AGENT_INBOUND_TOKEN=

# Puerto en que nanoclaw escucha mensajes inbound de ÉLEVÉ
NANOCLAW_PORT=3001

# Endpoint de salida hacia ÉLEVÉ (n8n-whatsapp-agent-response)
ELEVE_OUTBOUND_URL=https://<project>.supabase.co/functions/v1/n8n-whatsapp-agent-response
ELEVE_OUTBOUND_TOKEN=

# ── System prompt ─────────────────────────────────────────
# Fuente del system prompt: env | file | url
AGENT_SYSTEM_PROMPT_SOURCE=env

# Si SOURCE=env: texto completo del prompt
AGENT_SYSTEM_PROMPT=

# Si SOURCE=file: path al archivo montado en el container
AGENT_SYSTEM_PROMPT_PATH=/data/system-prompt.md

# Si SOURCE=url: URL pública o privada del prompt (ej. Google Drive export)
AGENT_SYSTEM_PROMPT_URL=
# Auth opcional para el URL (ej. "Bearer <token>")
AGENT_SYSTEM_PROMPT_URL_AUTH=

# Intervalo de recarga en segundos (0 = solo al arrancar)
AGENT_SYSTEM_PROMPT_RELOAD_INTERVAL=0

# Path del cache local del prompt (SOURCE=url)
AGENT_SYSTEM_PROMPT_CACHE_PATH=/data/system-prompt.cache.md

# Nombre del agent group a usar (debe existir en la DB)
AGENT_GROUP=monica

# ── Claude / Anthropic ────────────────────────────────────
# API key de Anthropic (gestionada via OneCLI vault en producción)
ANTHROPIC_API_KEY=

# ── OneCLI ───────────────────────────────────────────────
ONECLI_URL=http://127.0.0.1:10254
ONECLI_API_KEY=

# ── Container ────────────────────────────────────────────
TZ=America/Mexico_City
```

---

## G) Riesgos y desconocidos

### G.1 Auto-wiring vs módulo de permisos — RIESGO ALTO

**Problema:** El router upstream nunca auto-wira un `messaging_group` a un `agent_group`. Depende de que el operador ejecute un script de setup (como `scripts/init-first-agent.ts`) o del `channelRequestGate` que escala al owner.

Para ÉLEVÉ, cada `conversation_id` nuevo representa un usuario de WhatsApp que nunca ha hablado con Mónica antes. El setup manual por conversation es inviable.

**Solución propuesta:** El adapter `eleve-http` debe hacer el wiring automático en `processInbound()` (ver sección E.6, Forma 3). Esto requiere que el adapter importe módulos de la DB host (`src/db/messaging-groups.ts`, `src/db/agent-groups.ts`), lo que es un acoplamiento inusual para un adapter (los otros adapters no importan DB directamente). Sin embargo es la única opción limpia sin modificar el router.

**Alternativa más limpia pero más invasiva:** Agregar un hook en `src/router.ts` similar a `channelRequestGate` pero que permita al adapter registrar una función "auto-wire" que el router llame antes de la lógica de agentCount.

### G.2 McpServerConfig union type — RIESGO MEDIO

**Problema:** El runner actual tiene `McpServerConfig` como solo-stdio en `container/agent-runner/src/providers/types.ts` (línea 52) Y en `container/agent-runner/src/config.ts` (línea 18). Hay que modificar ambos archivos y el `container/agent-runner/src/index.ts`. Si no se hace con cuidado, TypeScript dará errores de tipo en el build del runner.

El host-side `src/container-config.ts` (línea 17) también tiene la interfaz solo-stdio. Hay que extenderla para que el host pueda escribir un `container.json` con `{ type: 'sse', url }` válido.

**Mitigación:** Usar `unknown` / `Record<string, unknown>` como tipo intermedio temporalmente. El SDK acepta el objeto directamente — TypeScript solo es para el developer experience.

### G.3 assistantName sobreescrito por ensureRuntimeFields — RIESGO BAJO

**Problema:** `ensureRuntimeFields()` en `container-runner.ts` (línea 393–413) sobreescribe `container.json.assistantName` con `agentGroup.name` de la DB:

```typescript
if (containerConfig.assistantName !== agentGroup.name) {
  containerConfig.assistantName = agentGroup.name;
  dirty = true;
}
```

Si el `agent_groups.name` en la DB es `'monica'` (lowercase) en lugar de `'Mónica'` (con acento y M mayúscula), el assistantName en container.json quedará mal.

**Mitigación:** Asegurar que el script de seed del agent group inserte `name = 'Mónica'`.

### G.4 SSE vs Streamable HTTP en mcp-monica — RIESGO BAJO

**Problema:** El spec diseña `mcp-monica` como HTTP/SSE. El SDK de nanoclaw soporta `type: 'sse'` y `type: 'http'`. El `@modelcontextprotocol/sdk` que usará `mcp-monica` puede levantar cualquiera de los dos transports.

**MCP SDK transport default:** `@modelcontextprotocol/sdk` 1.x levanta por defecto un servidor SSE en `/sse`. La versión 2.x (nueva spec) usa Streamable HTTP en `/mcp`. El `bun.lock` del runner muestra `"@modelcontextprotocol/sdk": "^1.12.1"` en sus dependencias, y `mcp-monica` usará la misma o similar versión.

**Mitigación:** Usar `type: 'sse'` en `container.json` de monica. Si `mcp-monica` levanta en `/sse`, funciona. Si migra a Streamable HTTP, cambiar a `type: 'http'` y `/mcp`.

### G.5 OneCLI y ANTHROPIC_API_KEY — RIESGO ALTO (setup)

**Problema:** El container usa OneCLI para credenciales. Al crear un nuevo agent group, el agente se crea en modo `selective` (sin secrets asignados por defecto — CLAUDE.md upstream, sección "Gotcha: auto-created agents start in `selective` secret mode"). El container arrancará, intentará llamar a Claude, y recibirá 401.

**Mitigación:** Después de crear el agent group `monica`, ejecutar:
```bash
onecli agents list  # encontrar el ID del agente monica
onecli agents set-secret-mode --id <agent-id> --mode all
# O asignar el secret específico
onecli secrets list
onecli agents set-secrets --id <agent-id> --secret-ids <anthropic-key-id>
```

Sin OneCLI (deploy sin vault), pasar `ANTHROPIC_API_KEY` directamente — el container lo toma del env si no hay proxy OneCLI. Ver `container/agent-runner/src/providers/claude.ts` línea 251: `env: { ...(options.env ?? {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW }` — el env del container incluye `process.env`.

### G.6 permissions module — RIESGO BAJO

**Problema:** El módulo de permisos (`src/modules/permissions/`) registra `accessGate`, `senderResolver`, etc. Sin él, el router usa allow-all (línea 265 `router.ts`: `(!accessGate || accessGate(...).allowed)`). Para ÉLEVÉ en v1, allow-all es correcto (la auth ocurre en el bearer del inbound HTTP, no en el router).

**Mitigación:** No instalar el módulo de permisos inicialmente. El adapter eleve-http verifica el bearer, el router deja pasar todo. Si se necesita control granular en el futuro, se instala el módulo.

### G.7 deliver() retry y mensajes perdidos — RIESGO BAJO

**Problema:** Si el POST a `n8n-whatsapp-agent-response` falla 3 veces (`MAX_DELIVERY_ATTEMPTS`), el mensaje se marca como failed en `inbound.db/delivered` y no se reintenta más. El usuario nunca recibe la respuesta.

**Mitigación del spec:** El spec menciona retry con backoff exponencial. Implementarlo en `deliver()`:
- 3 intentos
- Delays: 0s, 2s, 4s (base 2s)
- Si falla: loguear error, marcar como failed, ¿notificar? (v1: solo log)

El sistema de 3 retries ya está en el delivery loop del host (`MAX_DELIVERY_ATTEMPTS = 3` línea 33 `delivery.ts`). El adapter `deliver()` solo necesita implementar los delays internos si quiere hacer retry a nivel de HTTP request (antes de que el host cuente el intent).

---

## H) Plan 3 — Task breakdown

Basado en los hallazgos anteriores, las tareas ordenadas por dependencias:

### H.1 Lista de tareas

**Tarea 1: Bootstrap script del agent group monica** [haiku]  
Crear `scripts/init-monica-agent.ts` que inserta en `data/v2.db` el agent group `{ name: 'Mónica', folder: 'monica' }`, inicializa `groups/monica/` filesystem, y crea el `container.json` base. Idempotente. Instrucciones para OneCLI secret mode.

**Tarea 2: Ampliar McpServerConfig para HTTP MCP** [haiku]  
Extender la union type en 4 archivos: `src/container-config.ts`, `container/agent-runner/src/config.ts`, `container/agent-runner/src/providers/types.ts`, y ajustar `container/agent-runner/src/index.ts`. Agregar type guard. Sin lógica nueva.

**Tarea 3: Escribir groups/monica/container.json** [haiku]  
Crear el archivo `groups/monica/container.json` con `provider: 'claude'`, `mcpServers.mcp-monica` con `type: 'sse'` y `url: 'http://mcp-monica:3000/sse'`, y `assistantName: 'Mónica'`. El archivo existe en el repo (no en runtime data).

**Tarea 4: Implementar src/system-prompt-loader.ts** [sonnet]  
Módulo de carga del system prompt desde 3 fuentes (env/file/url) con cache y fallback. Lógica de fetch con timeout 5s, escritura a `CLAUDE.local.md`, log de warnings. Wiring en `src/index.ts`.

**Tarea 5: Implementar src/channels/eleve-http.ts** [sonnet]  
Adapter HTTP completo: servidor Node `http.createServer` en `NANOCLAW_PORT`, verificación de bearer `AGENT_INBOUND_TOKEN`, parsing del body `{ conversation_id, message, sender, metadata }`, respuesta 202, llamada a `onInbound`. Incluir `healthcheck GET /health`. Registrarse en el channel registry.

**Tarea 6: Auto-wiring en eleve-http adapter** [sonnet]  
Dentro de `processInbound()`, verificar si existe `messaging_group` + wiring al agent group `monica`. Si no, crearlos. Importar `src/db/messaging-groups.ts` y `src/db/agent-groups.ts` desde el adapter. Manejar race conditions (el host es single-threaded async, pero defensivo).

**Tarea 7: Implementar deliver() en eleve-http** [haiku]  
En el adapter, el método `deliver()` que hace POST a `ELEVE_OUTBOUND_URL` con bearer `ELEVE_OUTBOUND_TOKEN`. Body: `{ conversation_id, message, action?, metadata? }`. Throw en error para activar el retry del host. Log de éxito/fallo.

**Tarea 8: Registrar eleve-http en el barrel** [haiku]  
Agregar `import './eleve-http.js'` a `src/channels/index.ts`. Verificar que no rompe build existente (el adapter retorna null si falta AGENT_INBOUND_TOKEN, el registry lo salta).

**Tarea 9: Dockerfile y docker-compose** [sonnet]  
Adaptar `Dockerfile` de nanoclaw para producción ÉLEVÉ (si se necesita). Crear `docker-compose.yml` en raíz del monorepo `eleve-nanoclaw/` con servicios `nanoclaw` y `mcp-monica`, volumen persistente `/data`, red interna. Variables de entorno via `env_file`. Healthcheck en nanoclaw.

**Tarea 10: .env.example y documentación operacional** [haiku]  
Escribir `.env.example` en `nanoclaw/` con todas las variables nuevas documentadas. Crear `docs/bridge-eleve.md` con el contrato HTTP completo (inbound/outbound, auth, retry, errores).

### H.2 Tabla de dependencias y complejidad

| Tarea | Depende de | Tipo | Complejidad |
|---|---|---|---|
| T1: Bootstrap monica | — | sonnet (juicio de seed) | Media |
| T2: McpServerConfig union | — | haiku | Baja |
| T3: container.json monica | T2 | haiku | Mínima |
| T4: system-prompt-loader | T1 (folder existe) | sonnet | Media |
| T5: eleve-http adapter básico | — | sonnet | Media |
| T6: auto-wiring en adapter | T1, T5 | sonnet | Alta |
| T7: deliver() outbound | T5 | haiku | Baja |
| T8: barrel import | T5, T7 | haiku | Mínima |
| T9: docker-compose | T1-T8 | sonnet | Media |
| T10: docs | T1-T9 | haiku | Baja |

**Orden de ejecución sugerido:**
1. T2 (tipos) → T3 (container.json)
2. T1 (bootstrap) en paralelo con T2
3. T4 (loader) + T5 (adapter básico) en paralelo, ambos dependen de T1
4. T6 (auto-wiring) depende de T5
5. T7 (deliver) en paralelo con T6
6. T8 (barrel) cuando T5+T7 listos
7. T9 (docker-compose) cuando T1-T8 listos
8. T10 (docs) al final

---

## Apéndice: Rutas de archivos clave

| Archivo | Propósito |
|---|---|
| `src/channels/adapter.ts` | Interfaz `ChannelAdapter`, `ChannelSetup`, `InboundEvent`, `OutboundMessage` |
| `src/channels/channel-registry.ts` | `registerChannelAdapter`, `initChannelAdapters`, `getChannelAdapter` |
| `src/channels/cli.ts` | Ejemplo de adapter completo (Unix socket) |
| `src/channels/index.ts` | Barrel de auto-registro — agregar import aquí |
| `src/router.ts` | `routeInbound` — lógica de routing inbound |
| `src/delivery.ts` | Delivery poll, `drainSession`, `deliverMessage` |
| `src/group-init.ts` | `initGroupFilesystem` — crea dirs y archivos iniciales |
| `src/claude-md-compose.ts` | `composeGroupClaudeMd` — regenera CLAUDE.md en cada spawn |
| `src/container-runner.ts` | `wakeContainer`, `spawnContainer`, `buildMounts` — ciclo de spawn |
| `src/container-config.ts` | `McpServerConfig`, `ContainerConfig`, `readContainerConfig` |
| `src/config.ts` | `DATA_DIR`, `GROUPS_DIR`, env vars del host |
| `src/index.ts` | Entry point del host — wiring de adapters, delivery, sweep |
| `container/agent-runner/src/config.ts` | `RunnerConfig`, `loadConfig` — configuración del runner |
| `container/agent-runner/src/index.ts` | Entry del runner — MCP servers, provider setup |
| `container/agent-runner/src/providers/claude.ts` | `ClaudeProvider.query()` — pasa `mcpServers` al SDK |
| `container/agent-runner/src/providers/types.ts` | `McpServerConfig`, `ProviderOptions` |
| `container/agent-runner/src/db/messages-out.ts` | `writeMessageOut` — cómo el agente escribe outbound |
| `docs/SDK_DEEP_DIVE.md:130-138` | `McpServerConfig` union type del SDK (incluyendo `sse` y `http`) |
| `groups/main/CLAUDE.md` | Referencia de system prompt existente |
| `groups/monica/container.json` | A crear — config del agent group monica |
| `groups/monica/CLAUDE.local.md` | A crear — system prompt runtime de Mónica |
| `scripts/init-first-agent.ts` | Referencia de seed de agent group |

---

*Documento generado 2026-04-28. No ejecutar ningún cambio de código directamente.*
