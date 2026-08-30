# NexaDesk

NexaDesk is a Discord support bot that watches ticket categories, joins newly-created ticket channels, and uses AI to moderate and answer support conversations.

NexaDesk is not trying to replace every ticket bot. Its strongest position is being the AI support layer that works on top of the systems a server already uses: Ticket King, XN Tickets, Guild Manager, custom ticket categories, or NexaDesk panels.

## What works in this MVP

- Discord bot using `discord.js`.
- Slash command `/setup category:<category>` to select the ticket category for a server.
- Automatic detection of new channels created inside that category.
- External ticket compatibility layer for Ticket King, XN Tickets, Guild Manager-style ticket messages, and numbered `ticket-[number]` channels.
- Dashboard actions to create ticket categories and publish ticket panels.
- Ticket panel button that creates private ticket channels.
- AI replies inside ticket channels.
- Discord OAuth dashboard/API ready for Render.
- Direct bot invite flow from the server selector when NexaDesk is not installed yet.
- Staff escalation with `/desactivar ia`, `/activar ia`, ticket status, AI summaries, and saved transcripts per server.
- Transcript delivery by DM with `/transcripcion enviar`.
- Professional ticket close flow with `/ticket cerrar`.
- Owner onboarding DM when NexaDesk joins a new server.
- Interactive `/ayuda` guide with buttons for users, staff, setup and data.
- Pro voice support rooms with `/voz crear` or dashboard panels/components, gated per server from PostgreSQL.
- Voice tickets can use Groq STT/TTS to transcribe users, answer in voice, and save the conversation in transcripts.
- Automatic transcript delivery when another ticket bot closes a ticket by deleting the channel.
- Global bot metrics with `/globalstats`.
- Growth Engine with post-ticket ratings, dashboard satisfaction metrics, premium public reviews, and Churn Radar alerts.
- Owner-only release control at `/owner`: new commands can stay owner-only and new dashboard sections can show a public "we are working on this" placeholder until the owner launches the update.
- V1.5 Launch Pack: dashboard section `#v15` and `/novedades` command prepared behind release control for launch/video material.
- Optional visual-proof analysis for images and sampled video frames when the server AI prompt asks for visual evidence.
- Local JSON storage for fast development.
- Ollama-compatible AI client prepared for a Raspberry Pi.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and fill the values.

3. Register slash commands for a test server:

   ```bash
   npm run register
   ```

4. Start the bot and dashboard:

   ```bash
   npm run dev
   ```

## Dashboard

Open:

```text
http://localhost:3000
```

The dashboard uses Discord OAuth. Users only see servers where they are owner, Administrator, or have Manage Server.

The dashboard can:

- Save server knowledge used by the AI.
- Create a Discord ticket category.
- Publish a ticket panel in a selected text channel.
- Track recent tickets detected or opened from panels.
- View and download ticket transcripts as TXT files.
- Configure Growth Engine: feedback DM, review channel, public review threshold, and low-rating alerts.
- Receive live ticket/config updates through Server-Sent Events.
- Open a direct Discord invite for manageable servers where the bot is not installed.

Public status page:

```text
https://your-render-service.onrender.com/status
```

Owner release center:

```text
https://your-render-service.onrender.com/owner
```

New public-facing work should be declared in `src/release-gates.js`. Until the owner launches the update from `/owner`, matching commands stay restricted to the global owner and dashboard sections tagged with `data-release-feature="<feature-id>"` render a work-in-progress screen for normal users.

The V1.5 launch pack is declared as `v15-launch-pack`. Before launch, only the global owner can use `/novedades` and see the full `#v15` dashboard section. After launching from `/owner`, both become public.

`/status` shows bot health, Discord/runtime metrics, HA leader state, components, and owner messages in real time. It is public for users, but only the global owner through Discord OAuth or an active `/admin` rotating-code session can edit the status and publish messages. Status edits are stored in global settings and broadcast through Server-Sent Events.

For production on Render, set the same env vars in the web service settings. For the Raspberry Pi worker, keep `/home/pi/nexadesk/.env` updated separately.

Visual analysis uses Groq vision models for images. Video support samples frames through `ffmpeg`; install `ffmpeg` on the worker machine if you want videos to be interpreted instead of only recorded as attachments.

Voice support uses Groq speech-to-text and text-to-speech, plus `ffmpeg` to play generated audio in Discord voice channels. Install `ffmpeg` on the worker machine and keep only one AI voice room active per Discord server at a time.

If you only want Render to serve the dashboard, set:

```text
RUN_BOT=false
```

Render still needs `DISCORD_TOKEN` even with `RUN_BOT=false`, because the dashboard uses the bot token to read roles/channels and create categories or panels. If Discord resets the token, update it both on the Pi and in Render.

## High availability worker

NexaDesk can run a safe active/standby worker pair. Keep one instance on the Raspberry Pi and a second instance in Render with the same Discord environment and a shared PostgreSQL connection. Enable the lease so only one gateway session responds at a time:

```text
RUN_BOT=true
BOT_HA_ENABLED=true
BOT_INSTANCE_ID=pi-main
BOT_LEASE_TTL_MS=12000
BOT_LEASE_RENEW_MS=4000
BOT_FAILOVER_POLL_MS=2500
```

Use a different `BOT_INSTANCE_ID` on the standby, for example `oci-standby`. The lease is stored in PostgreSQL global settings. This avoids active-active duplicate Discord replies while allowing a standby worker to take over within seconds if the Pi loses power.

Preferred standby target for this repo: the Render dashboard service. Set `RUN_BOT=true`, `BOT_HA_ENABLED=true`, and `BOT_INSTANCE_ID=render-dashboard-standby` there. Keep the Raspberry Pi as `BOT_INSTANCE_ID=pi-main`.

Render Free web services can sleep after idle time, so the standby must receive periodic HTTP traffic or the Discord gateway will not be alive when the Pi drops. For the Render standby, set:

```text
KEEPALIVE_ENABLED=true
KEEPALIVE_URL=https://your-render-service.onrender.com/health
KEEPALIVE_INTERVAL_MS=300000
```

Verify standby readiness from:

```text
https://your-render-service.onrender.com/health/ha
```

When the Pi is leader, this endpoint should show `leader.ownerId = pi-main`. After unplugging the Pi, it should change to `render-dashboard-standby` after the lease expires.

The repository also includes `.github/workflows/render-keepalive.yml`, which pings Render every 5 minutes from GitHub Actions. Keep Actions enabled on GitHub so the standby stays awake even when the Pi is healthy.

If `/health/ha` shows `runtime.botGatewayEligible = "false"` or `runtime.haEnabled = "false"` on Render, the standby is disabled regardless of `render.yaml`. Set these Render environment variables manually and redeploy:

```text
BOT_HA_ENABLED=true
BOT_INSTANCE_ID=render-dashboard-standby
KEEPALIVE_ENABLED=true
KEEPALIVE_URL=https://nexa-desk.onrender.com/health
```

`RUN_BOT=true` is still recommended on Render for clarity, but HA standby now starts whenever `BOT_HA_ENABLED=true`.

## Private docs vault

Open the private internal docs manually at:

```text
https://your-render-service.onrender.com/docs
```

Open the hidden admin command room manually at:

```text
https://your-render-service.onrender.com/admin
```

Both routes are intentionally not linked from the dashboard. `/docs` contains the internal vault and requires the Google Authenticator compatible TOTP secret. `/admin` shows global live data plus maintenance controls and uses a rotating one-time code generated with `/code` in Discord by users with the configured admin-code role.

Generate a secret:

```bash
npm run docs:totp-secret
```

Set the printed `DOCS_TOTP_SECRET` in Render and in the Raspberry Pi `.env`, then add the printed `otpauth_uri` manually to Google Authenticator. Docs use no-cache headers, noindex, short signed sessions, anti-copy/print guards, and persistent watermarks. Admin uses the same security headers but authenticates through `/code`, stored hashed, encrypted for same-user reuse while active, and invalidated after first use. Set the same `ADMIN_CODE_SECRET` in Render and Pi for the cleanest setup; if it is missing, NexaDesk falls back to shared bot secrets so Pi-generated codes still validate on Render. Browser code cannot fully prevent operating-system screenshots, so treat the watermark, TOTP, and rotating admin codes as defense-in-depth, not magic DRM.

## Discord OAuth

Add this redirect URL in the Discord Developer Portal:

```text
https://your-render-service.onrender.com/auth/discord/callback
```

Set:

```text
DISCORD_CLIENT_SECRET=...
DASHBOARD_PUBLIC_URL=https://your-render-service.onrender.com
SESSION_SECRET=long_random_secret
```

Enable these privileged intents for production support replies and staff DM escalation:

```text
MESSAGE CONTENT INTENT
SERVER MEMBERS INTENT
```

Then set:

```text
DISCORD_MESSAGE_CONTENT_INTENT=true
DISCORD_GUILD_MEMBERS_INTENT=true
```

## PostgreSQL local

NexaDesk usa PostgreSQL local como almacenamiento de producción en la Raspberry Pi. No depende de créditos, Request Units ni límites mensuales de un proveedor externo; el límite práctico es el disco y los recursos de la propia Pi.

Instala PostgreSQL y aplica el esquema desde la raíz del repositorio:

```bash
npm run db:setup
```

El instalador crea la base de datos `nexadesk`, el usuario `nexa`, aplica [postgres/schema.sql](./postgres/schema.sql) y muestra la variable de conexión. Déjala en el `.env` de la Raspberry Pi:

```text
DATABASE_URL=postgresql://nexa:TU_PASSWORD@127.0.0.1:5432/nexadesk?sslmode=disable
DATABASE_POOL_MAX=5
DATABASE_CONNECT_TIMEOUT_MS=8000
```

Comprueba la instalación con:

```bash
npm run test:database
```

Si NexaDesk tenía datos en el almacenamiento JSON de fallback, mígralos antes de retirar esos archivos:

```bash
npm run db:migrate:json
```

El arranque correcto debe mostrar:

```text
NexaDesk storage backend: PostgreSQL
```

Si `DATABASE_URL` falta o PostgreSQL no está disponible, NexaDesk conserva un fallback JSON para desarrollo y arranque de emergencia; no lo uses como almacenamiento de producción con varios procesos.

Crea backups periódicos con:

```bash
npm run db:backup
```

El backup usa `pg_dump` en formato comprimido y conserva por defecto 14 días. Cambia `BACKUP_DIR` o `BACKUP_RETENTION_DAYS` si necesitas otra ubicación o retención.
## Top.gg Anti-Bots

Security Guard can use Top.gg as a safe-list before banning new bots. Get the token from your Top.gg bot dashboard under `Integrations & API`, then set it on the Pi:

```text
TOPGG_API_TOKEN=...
```

If this variable is missing or Top.gg times out, NexaDesk does not ban bots blindly. It only bans when Top.gg confirms the bot is not listed.

## Groq AI

NexaDesk is configured to use Groq by default:

```text
AI_PROVIDER=groq
GROQ_MODEL=llama-3.1-8b-instant
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_STT_MODEL=whisper-large-v3-turbo
GROQ_TTS_MODEL=canopylabs/orpheus-v1-english
GROQ_TTS_VOICE=hannah
AI_VISUAL_ANALYSIS=true
AI_VIDEO_FRAME_COUNT=3
AI_VIDEO_MAX_BYTES=25000000
VOICE_STT_ENABLED=true
VOICE_TTS_ENABLED=true
```

This model is a good default for support tickets because it is fast, low-cost, and has enough context for ticket history plus server information.

## Raspberry Pi AI

The current Pi detected in this project is `armv7l`, 32-bit, with roughly 425 MB RAM. Ollama does not support this architecture, and normal support models such as `llama3.2:3b` will not fit in memory.

For a Pi 4/5 with 64-bit OS and 4 GB+ RAM, use:

```bash
scripts/pi-ollama-setup.sh llama3.2:3b
```

Set:

```text
OLLAMA_BASE_URL=http://192.168.1.52:11434
OLLAMA_MODEL=llama3.2:3b
```

For production, expose the Pi with Tailscale or Cloudflare Tunnel instead of opening Ollama directly to the internet.

For this current 32-bit Pi, the project also supports OpenAI-compatible local servers such as `llama.cpp`:

```bash
scripts/pi-llamacpp-setup.sh
```

Then set:

```text
AI_PROVIDER=openai-compatible
OPENAI_COMPAT_BASE_URL=http://192.168.1.52:8080/v1
OPENAI_COMPAT_MODEL=local
```

## Discord invite

Invite NexaDesk with:

```text
https://discord.com/oauth2/authorize?client_id=1497894098722492598&permissions=1099780451478&scope=bot%20applications.commands
```

The invite includes Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Connect, Speak, Move Members, and Use Voice Activity.

Recommended launch check:

```bash
npm audit --omit=dev --audit-level=high
npm run register
```

If commands appear duplicated in a server, clear the fast guild-scoped copy and keep only the global commands:

```bash
DISCORD_GUILD_ID=your_server_id npm run register -- --clear-guild
```

## Slash commands

```text
/setup category:<category>
/desactivar ia
/activar ia
/ticket estado
/ticket resumen
/ticket prioridad
/ticket cerrar
/voz crear [nombre]
/voz estado
/voz cerrar
/transcripcion enviar [usuario]
/globalstats
/crecimiento estado
/crecimiento configurar [canal_reviews] [reviews_publicas] [rating_publico_min]
/premium
/code
/ayuda
```

`/transcripcion enviar` sends the current ticket transcript by DM to the ticket opener. If the ticket was created by another bot and NexaDesk cannot detect the opener, pass `usuario`.

`/ticket resumen` gives staff a concise AI handoff, `/ticket prioridad` calculates risk, SLA and next action, `/ticket estado` shows the operational state of the current ticket, and `/ticket cerrar` closes the ticket, sends the transcript by DM, and deletes the channel after a short delay.

Premium monetization is built into the dashboard. Configure `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE=live`, `PREMIUM_PACK_PRICE_CENTS=300`, `PREMIUM_PACK_SLOTS=3`, and `PREMIUM_PACK_CURRENCY=eur` for automatic PayPal Checkout. If you need to start selling before PayPal API verification is complete, set `PREMIUM_PAYMENT_URL` to a manual PayPal/payment link; the dashboard will open that link and record a pending manual intent in PostgreSQL for validation through support. Users can run `/premium` to see the price, features, dashboard checkout, and support link.

Voice support is a Pro feature activated by Premium slots, `/activarpremium`, or manually from PostgreSQL. For a server, set either `plan = 'pro'` or `voice_support_enabled = true` in `guild_configs`. Optional columns `voice_category_id` and `voice_category_name` let you choose where Pro voice rooms should be created. In the dashboard, set a panel button or menu component to `Voz Pro + STT/TTS` to open a normal private text ticket with a linked private voice room.

When a ticket channel registered by NexaDesk is deleted by another ticket bot, NexaDesk marks the ticket as closed, keeps the transcript available in the dashboard, and tries to DM the transcript to the opener automatically.

## Competitive positioning

Use this when announcing or listing NexaDesk:

```text
NexaDesk is the AI support layer for Discord tickets.

Keep Ticket King, XN Tickets, Guild Manager, or your current panels. NexaDesk joins the ticket, understands server context, helps the user, escalates to staff with a clean summary, saves transcripts, and adds security signals without forcing a migration.
```

Short pitch:

```text
XN Protect protects your server. NexaDesk supports your users.
Your ticket bot opens the channel. NexaDesk handles the conversation.
```

Growth Engine asks for a rating by DM when a ticket closes. Free servers get internal ratings and dashboard metrics. Premium servers can publish high ratings to a configured review channel and alert staff when low ratings indicate a user may leave.

When NexaDesk joins a new server, it sends the owner a private onboarding message with setup steps, staff instructions, data/transcript details, dashboard link, and the official support server.
