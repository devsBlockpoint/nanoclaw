# Mónica — placeholder

Este archivo se sobreescribe en runtime por `src/system-prompt-loader.ts` antes de cada wake del container, según la fuente configurada en `AGENT_SYSTEM_PROMPT_SOURCE` (env/file/url).

Si ves este texto en un container vivo, el loader no corrió o falló sin cache de fallback. Revisar logs del host: `logs/nanoclaw.log` busca `[system-prompt-loader]`.
