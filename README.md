# NexaDesk

NexaDesk is a Discord support bot that watches ticket categories, joins newly-created ticket channels, and uses AI to moderate and answer support conversations.

## What works in this MVP

- Discord bot using `discord.js`.
- Slash command `/setup category:<category>` to select the ticket category for a server.
- Automatic detection of new channels created inside that category.
- Dashboard actions to create ticket categories and publish ticket panels.
- Ticket panel button that creates private ticket channels.
- AI replies inside ticket channels.
- Simple web dashboard/API ready for Render.
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

The dashboard uses `DASHBOARD_ADMIN_KEY` for configuration changes.

The dashboard can:

- Save server knowledge used by the AI.
- Create a Discord ticket category.
- Publish a ticket panel in a selected text channel.
- Track recent tickets detected or opened from panels.

For production on Render, set the same env vars in the web service settings. For the Raspberry Pi worker, keep `/home/pi/nexadesk/.env` updated separately.

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
https://discord.com/oauth2/authorize?client_id=1497894098722492598&permissions=274878221376&integration_type=0&scope=bot+applications.commands
```

The bot needs access to the test guild before `npm run register` can create guild slash commands.
