# ÉLEVÉ ↔ nanoclaw HTTP bridge contract

Documento del contrato entre ÉLEVÉ Supabase y nanoclaw, implementado por el `eleve-http` channel adapter (`src/channels/eleve-http.ts`).

## Diagrama

```
WhatsApp (Meta)
  │
  ▼  webhook entrante
ÉLEVÉ Supabase: whatsapp-webhook
  │
  ▼  HTTP POST + bearer (AGENT_INBOUND_TOKEN)
nanoclaw: POST /messages
  │  ├─ eleve-http channel adapter
  │  ├─ auto-wiring → agent group "monica"
  │  └─ inbound.db / outbound.db
  │
  ▼  agente procesa (con MCP a mcp-monica)
  ▼
nanoclaw: outbound.db
  │
  ▼  HTTP POST + bearer (ELEVE_OUTBOUND_TOKEN)
ÉLEVÉ Supabase: n8n-whatsapp-agent-response
  │
  ▼
WhatsApp (Meta) → usuario
```

## Inbound: ÉLEVÉ → nanoclaw

`POST {NANOCLAW_PUBLIC_URL}/messages`

**Headers:**
```
Authorization: Bearer {AGENT_INBOUND_TOKEN}
Content-Type: application/json
```

**Body:**
```json
{
  "conversation_id": "uuid de whatsapp_conversations en ÉLEVÉ",
  "message": "texto del usuario",
  "sender": {
    "phone": "5215512345678",
    "name": "Ana"
  },
  "metadata": { "any": "extra context" }
}
```

**Response:** `202 Accepted` (cuerpo vacío). Procesamiento asíncrono.

**Auth:** bearer estático compartido. Sin firma HMAC en v1.

**Errores:**
- `401 Unauthorized` — bearer ausente o inválido.
- `400 Bad Request` — body malformado, falta `conversation_id` o `message`.
- `405 Method Not Allowed` — para no-POST en `/messages`.

## Outbound: nanoclaw → ÉLEVÉ

`POST {ELEVE_OUTBOUND_URL}` (= `n8n-whatsapp-agent-response` de Supabase).

**Headers:**
```
Authorization: Bearer {ELEVE_OUTBOUND_TOKEN}
Content-Type: application/json
```

**Body:**
```json
{
  "conversation_id": "...",
  "message": "respuesta del agente",
  "action": "escalate | transfer | close | schedule_followup",
  "metadata": { ... }
}
```

`action` es opcional; si está, ÉLEVÉ aplica las semánticas documentadas en `mcp-monica/mcp/_pipeline.md`.

**Retry:** el host de nanoclaw reintenta automáticamente si `deliver()` lanza error. La política de backoff la maneja `src/delivery.ts`.

## Auto-wiring

La primera vez que un `conversation_id` aparece, el adapter crea automáticamente el `messaging_group` (con `channel_type='eleve-http'` y `platform_id=conversation_id`) y lo wirea al agent group `monica`. No hay paso manual de "registrar conversación".

> **Pre-requisito**: el agent group `monica` debe existir en la DB. Correr `pnpm exec tsx scripts/init-monica-agent.ts` una vez al setup. Es idempotente.

## Sesión

Cada `conversation_id` distinto = una sesión nanoclaw distinta = pareja `inbound.db`/`outbound.db` propios. Memoria persistente automática por contacto.

## Health

`GET /health` → `200 {"status":"ok"}`. No requiere auth. Lo usa el healthcheck del docker-compose y monitoreo externo.

## System prompt

El system prompt de `monica` se carga al boot del host desde una de tres fuentes (env var `AGENT_SYSTEM_PROMPT_SOURCE`):

- `env` (default) — `AGENT_SYSTEM_PROMPT=...`
- `file` — `AGENT_SYSTEM_PROMPT_PATH=/path/to/prompt.md`
- `url` — `AGENT_SYSTEM_PROMPT_URL=...` (con cache local de fallback en `groups/monica/.system-prompt.cache.md` o equivalente del loader)

El contenido se escribe a `groups/monica/CLAUDE.local.md` (gitignored, regenerado en cada boot). Detalles: `src/system-prompt-loader.ts`.

## OneCLI

El agent group `monica` (creado por `scripts/init-monica-agent.ts`) inicia en `selective` secret mode. Antes del primer mensaje, hay que correr:

```bash
onecli agents set-secret-mode --id <agent-group-id> --mode all
```

Sin esto, el container booteará pero las llamadas a Anthropic devolverán `401 Unauthorized`. El bootstrap script imprime las instrucciones exactas al final.

## Verified

Smoke E2E local 2026-04-29 (nanoclaw host + mcp-monica:dev container + mock outbound):

- ✅ `GET /health` → 200.
- ✅ `POST /messages` sin auth → 401; con bearer → 202 + body `{"status":"accepted"}`.
- ✅ system-prompt-loader carga prompt desde env y lo escribe a `groups/monica/CLAUDE.local.md`.
- ✅ Auto-wiring: la primera llamada con un `conversation_id` nuevo crea `messaging_group` (`channel_type=eleve-http`, `unknown_sender_policy=public`) y lo wirea al agent group `monica`.
- ✅ Session created por router, `agentGroupName="Mónica"` (acento preservado).
- ✅ Message routed con `engage_mode=pattern, sender_scope=all`.
- ✅ Container spawn dispara correctamente (intent verificado por logs).
- ⏸️ Container exit code 125 por OneCLI 401 — esperado sin OneCLI auth real. El último tramo de la cadena (Anthropic → MCP → outbound) requiere setup de secrets que vive en Plan 4 / Easypanel.

## Gotcha: `unknown_sender_policy = 'public'`

El adapter setea `unknown_sender_policy: 'public'` al crear el messaging_group. Razón: cada conversación de WhatsApp viene de un `phone:<num>` que NO está en la base de usuarios; con `'strict'` (default upstream) cada mensaje cae con `MESSAGE DROPPED — unknown sender`. En `eleve-http` la auth real la da el bearer `AGENT_INBOUND_TOKEN` en el boundary; sender-level gating no es apropiado para este canal.

## Runtime files en `groups/monica/`

`groups/monica/CLAUDE.md` y `groups/monica/container.json` son **regenerados por el composer del host en cada spawn** del container. Los archivos commiteados son la base que el host completa con `agentGroupId`, `groupName` y fragments de skills. La fuente de verdad del prompt vive en `CLAUDE.local.md` (gitignored, escrito por el system-prompt-loader).
