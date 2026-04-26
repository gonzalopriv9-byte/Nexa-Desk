import { config } from './config.js';
import { JsonStorage } from './storage.js';
import { GroqClient } from './ai/groq-client.js';
import { OllamaClient } from './ai/ollama-client.js';
import { OpenAICompatibleClient } from './ai/openai-compatible-client.js';
import { SupportAgent } from './ai/support-agent.js';
import { createBot, createTicketCategory, createTicketPanel } from './bot.js';
import { createServer } from './server.js';

const storage = new JsonStorage(config.DATA_DIR);
await storage.init();

const aiClient = createAiClient();

const supportAgent = new SupportAgent({
  aiClient,
  storage,
  maxHistoryMessages: config.AI_MAX_HISTORY_MESSAGES
});

const bot = createBot({ config, storage, supportAgent });
const app = createServer({
  config,
  storage,
  bot: {
    createTicketCategory: (input) => createTicketCategory(bot, storage, input),
    createTicketPanel: (input) => createTicketPanel(bot, storage, input)
  }
});
app.listen(config.PORT, () => {
  console.log(`NexaDesk dashboard listening on http://localhost:${config.PORT}`);
});

await bot.login(config.DISCORD_TOKEN);

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
