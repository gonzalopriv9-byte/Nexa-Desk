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
- Staff escalation with `/desactivar ia` and saved transcripts per server.
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
- Receive live ticket/config updates through Server-Sent Events.
- Open a direct Discord invite for manageable servers where the bot is not installed.

For production on Render, set the same env vars in the web service settings. For the Raspberry Pi worker, keep `/home/pi/nexadesk/.env` updated separately.

If the bot is running on the Raspberry Pi, set this in Render so the web service only serves the dashboard:

```text
RUN_BOT=false
```

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

## Groq AI

NexaDesk is configured to use Groq by default:

```text
AI_PROVIDER=groq
GROQ_MODEL=llama-3.1-8b-instant
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
https://discord.com/oauth2/authorize?client_id=1497894098722492598&permissions=216080&scope=bot%20applications.commands
```

The bot needs access to the test guild before `npm run register` can create guild slash commands.

Recommended launch check:

```bash
npm audit --omit=dev --audit-level=high
npm run register
```
