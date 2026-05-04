# NexaDesk

NexaDesk is a Discord support bot that watches ticket categories, joins newly-created ticket channels, and uses AI to moderate and answer support conversations.

## What works in this MVP

- Discord bot using `discord.js`.
- Slash command `/setup category:<category>` to select the ticket category for a server.
- Automatic detection of new channels created inside that category.
- Dashboard actions to create ticket categories and publish ticket panels.
- Ticket panel button that creates private ticket channels.
- AI replies inside ticket channels.
- Discord OAuth dashboard/API ready for Render.
- Direct bot invite flow from the server selector when NexaDesk is not installed yet.
- Staff escalation with `/desactivar ia`, `/activar ia`, ticket status, AI summaries, and saved transcripts per server.
- Transcript delivery by DM with `/transcripcion enviar`.
- Professional ticket close flow with `/ticket cerrar`.
- Pro voice support rooms with `/voz crear`, gated per server from Supabase.
- Automatic transcript delivery when another ticket bot closes a ticket by deleting the channel.
- Global bot metrics with `/globalstats`.
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
- Receive live ticket/config updates through Server-Sent Events.
- Open a direct Discord invite for manageable servers where the bot is not installed.

For production on Render, set the same env vars in the web service settings. For the Raspberry Pi worker, keep `/home/pi/nexadesk/.env` updated separately.

Visual analysis uses Groq vision models for images. Video support samples frames through `ffmpeg`; install `ffmpeg` on the worker machine if you want videos to be interpreted instead of only recorded as attachments.

If the bot is running on the Raspberry Pi, set this in Render so the web service only serves the dashboard:

```text
RUN_BOT=false
```

Render still needs `DISCORD_TOKEN` even with `RUN_BOT=false`, because the dashboard uses the bot token to read roles/channels and create categories or panels. If Discord resets the token, update it both on the Pi and in Render.

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

## Supabase

Run [supabase/schema.sql](./supabase/schema.sql) in the Supabase SQL editor, then set:

```text
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

If Supabase vars are missing, NexaDesk falls back to local JSON storage for development.

The bot logs the active storage backend on startup. Production should say:

```text
NexaDesk storage backend: Supabase
```

If the Pi previously ran without Supabase vars, migrate the local JSON data after setting the Supabase env vars:

```bash
npm run migrate:supabase
```

## Groq AI

NexaDesk is configured to use Groq by default:

```text
AI_PROVIDER=groq
GROQ_MODEL=llama-3.1-8b-instant
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
AI_VISUAL_ANALYSIS=true
AI_VIDEO_FRAME_COUNT=3
AI_VIDEO_MAX_BYTES=25000000
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
https://discord.com/oauth2/authorize?client_id=1497894098722492598&permissions=305384464&scope=bot%20applications.commands
```

The invite includes Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Mention Everyone, Connect, Speak, and Use Voice Activity.

Recommended launch check:

```bash
npm audit --omit=dev --audit-level=high
npm run register
```

## Slash commands

```text
/setup category:<category>
/desactivar ia
/activar ia
/ticket estado
/ticket resumen
/ticket cerrar
/voz crear [nombre]
/voz estado
/voz cerrar
/transcripcion enviar [usuario]
/globalstats
```

`/transcripcion enviar` sends the current ticket transcript by DM to the ticket opener. If the ticket was created by another bot and NexaDesk cannot detect the opener, pass `usuario`.

`/ticket resumen` gives staff a concise AI handoff, `/ticket estado` shows the operational state of the current ticket, and `/ticket cerrar` closes the ticket, sends the transcript by DM, and deletes the channel after a short delay.

Voice support is a Pro feature controlled manually from Supabase. For a server, set either `plan = 'pro'` or `voice_support_enabled = true` in `guild_configs`. Optional columns `voice_category_id` and `voice_category_name` let you choose where Pro voice rooms should be created.

When a ticket channel registered by NexaDesk is deleted by another ticket bot, NexaDesk marks the ticket as closed, keeps the transcript available in the dashboard, and tries to DM the transcript to the opener automatically.
