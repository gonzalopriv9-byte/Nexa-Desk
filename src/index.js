import { config } from './config.js';
import { createStorage } from './storage.js';
import { AppEvents } from './events.js';
import { AkiomaeClient } from './ai/akiomae-client.js';
import { FallbackAiClient, createAiProvider } from './ai/fallback-ai-client.js';
import { GroqClient } from './ai/groq-client.js';
import { OllamaClient } from './ai/ollama-client.js';
import { OpenAICompatibleClient } from './ai/openai-compatible-client.js';
import { SupportAgent } from './ai/support-agent.js';
import { VisualAnalyzer } from './ai/visual-analyzer.js';
import { VoiceSessionManager } from './voice/voice-session-manager.js';
import { createBot, createTicketCategory, createTicketPanel, listGuildChannels, listGuildRoles, listInstalledGuildIds, refreshGuildDiscovery, updateTicketPanel } from './bot.js';
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
const visualAnalyzer = createVisualAnalyzer();
const voiceManager = createVoiceManager();

const supportAgent = new SupportAgent({
  aiClient,
  storage,
  maxHistoryMessages: config.AI_MAX_HISTORY_MESSAGES,
  visualAnalyzer
});

const bot = createBot({ config, storage, supportAgent, voiceManager });
const botActions = config.RUN_BOT
  ? {
      createTicketCategory: (input) => createTicketCategory(bot, storage, input),
      createTicketPanel: (input) => createTicketPanel(bot, storage, input),
      updateTicketPanel: (input) => updateTicketPanel(bot, storage, input),
      listGuildRoles: (input) => listGuildRoles(bot, input),
      listGuildChannels: (input) => listGuildChannels(bot, input),
      refreshGuildDiscovery: (input) => refreshGuildDiscovery(bot, storage, input),
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
    return createGroqFallbackClient();
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

function createVisualAnalyzer() {
  if (!config.AI_VISUAL_ANALYSIS || !hasGroqProvider()) return null;

  return new VisualAnalyzer({
    visionClient: createGroqFallbackClient(),
    enabled: config.AI_VISUAL_ANALYSIS,
    videoFrameCount: config.AI_VIDEO_FRAME_COUNT,
    videoMaxBytes: config.AI_VIDEO_MAX_BYTES
  });
}

function createVoiceManager() {
  if (!config.VOICE_STT_ENABLED || config.AI_PROVIDER !== 'groq' || !hasGroqProvider()) {
    return null;
  }

  return new VoiceSessionManager({
    storage,
    aiClient: createGroqFallbackClient(),
    config
  });
}

function createGroqFallbackClient() {
  const providers = [];
  if (config.GROQ_API_KEY) {
    providers.push(createAiProvider('groq-primary', new GroqClient({
      apiKey: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
      visionModel: config.GROQ_VISION_MODEL
    })));
  }

  for (const [index, apiKey] of parseFallbackKeys(config.GROQ_FALLBACK_API_KEYS).entries()) {
    providers.push(createAiProvider(`groq-backup-${index + 1}`, new GroqClient({
      apiKey,
      model: config.GROQ_MODEL,
      visionModel: config.GROQ_VISION_MODEL
    })));
  }

  if (config.AKIOMAE_API_KEY) {
    providers.push(createAiProvider('akiomae', new AkiomaeClient({
      apiKey: config.AKIOMAE_API_KEY,
      baseUrl: config.AKIOMAE_BASE_URL
    })));
  }

  return new FallbackAiClient(providers);
}

function parseFallbackKeys(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasGroqProvider() {
  return Boolean(config.GROQ_API_KEY || parseFallbackKeys(config.GROQ_FALLBACK_API_KEYS).length);
}
