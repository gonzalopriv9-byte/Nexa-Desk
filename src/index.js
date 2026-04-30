import { config } from './config.js';
import { createStorage } from './storage.js';
import { AppEvents } from './events.js';
import { GroqClient } from './ai/groq-client.js';
import { OllamaClient } from './ai/ollama-client.js';
import { OpenAICompatibleClient } from './ai/openai-compatible-client.js';
import { SupportAgent } from './ai/support-agent.js';
import { createBot, createTicketCategory, createTicketPanel, listGuildChannels, listGuildRoles, listInstalledGuildIds } from './bot.js';
import { createServer } from './server.js';
import { createDiscordRestActions } from './discord-rest-actions.js';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const events = new AppEvents();
const storage = createStorage(config, events);
await storage.init();

const aiClient = createAiClient();

const supportAgent = new SupportAgent({
  aiClient,
  storage,
  maxHistoryMessages: config.AI_MAX_HISTORY_MESSAGES
});

const bot = createBot({ config, storage, supportAgent });
const botActions = config.RUN_BOT
  ? {
      createTicketCategory: (input) => createTicketCategory(bot, storage, input),
      createTicketPanel: (input) => createTicketPanel(bot, storage, input),
      listGuildRoles: (input) => listGuildRoles(bot, input),
      listGuildChannels: (input) => listGuildChannels(bot, input),
      listInstalledGuildIds: () => listInstalledGuildIds(bot)
    }
  : createDiscordRestActions({ config, storage });

const app = createServer({
  config,
  storage,
  bot: botActions,
  events
});
app.listen(config.PORT, () => {
  console.log(`NexaDesk dashboard listening on http://localhost:${config.PORT}`);
});

if (config.RUN_BOT) {
  try {
    await bot.login(config.DISCORD_TOKEN);
  } catch (error) {
    console.error('NexaDesk bot login failed. Dashboard remains online. Update DISCORD_TOKEN and restart the service.', error);
  }
} else {
  console.log('NexaDesk bot login skipped because RUN_BOT=false.');
}

function createAiClient() {
  if (config.AI_PROVIDER === 'groq') {
    return new GroqClient({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL });
  }

  if (config.AI_PROVIDER === 'ollama') {
    return new OllamaClient({ baseUrl: config.OLLAMA_BASE_URL, model: config.OLLAMA_MODEL });
  }

  if (config.AI_PROVIDER === 'openai-compatible') {
    return new OpenAICompatibleClient({
      baseUrl: config.OPENAI_COMPAT_BASE_URL,
      model: config.OPENAI_COMPAT_MODEL,
      apiKey: config.OPENAI_COMPAT_API_KEY
    });
  }

  return { generate: async () => 'La IA esta desactivada por configuracion.' };
}
