import { config } from './config.js';
import { createStorage, JsonStorage } from './storage.js';
import { AppEvents } from './events.js';
import crypto from 'node:crypto';
import os from 'node:os';
import { AkiomaeClient } from './ai/akiomae-client.js';
import { FallbackAiClient, createAiProvider } from './ai/fallback-ai-client.js';
import { GroqClient } from './ai/groq-client.js';
import { LocalSupportClient } from './ai/local-support-client.js';
import { OllamaClient } from './ai/ollama-client.js';
import { OpenAICompatibleClient } from './ai/openai-compatible-client.js';
import { SupportAgent } from './ai/support-agent.js';
import { VisualAnalyzer } from './ai/visual-analyzer.js';
import { VoiceSessionManager } from './voice/voice-session-manager.js';
import { captureGuildBackup, createBot, createTicketCategory, createTicketPanel, deleteTicketPanel, listGuildChannels, listGuildRoles, listInstalledGuildIds, refreshGuildDiscovery, refreshTicketPanels, restoreGuildBackup, sendChannelMessage, updateTicketPanel } from './bot.js';
import { createServer } from './server.js';
import { createDiscordRestActions } from './discord-rest-actions.js';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const events = new AppEvents();
const storage = await createInitializedStorage(config, events);

const aiClient = createAiClient();
const visualAnalyzer = createVisualAnalyzer();
const voiceManager = createVoiceManager();

const supportAgent = new SupportAgent({
  aiClient,
  storage,
  maxHistoryMessages: config.AI_MAX_HISTORY_MESSAGES,
  visualAnalyzer
});

const botGatewayEligible = config.RUN_BOT || config.BOT_HA_ENABLED;
const bot = createBot({ config, storage, supportAgent, voiceManager });
const botActions = botGatewayEligible && !config.BOT_HA_ENABLED
  ? {
      createTicketCategory: (input) => createTicketCategory(bot, storage, input),
      createTicketPanel: (input) => createTicketPanel(bot, storage, input),
      updateTicketPanel: (input) => updateTicketPanel(bot, storage, input),
      deleteTicketPanel: (input) => deleteTicketPanel(bot, storage, input),
      refreshTicketPanels: (input) => refreshTicketPanels(bot, storage, input),
      listGuildRoles: (input) => listGuildRoles(bot, input),
      listGuildChannels: (input) => listGuildChannels(bot, input),
      refreshGuildDiscovery: (input) => refreshGuildDiscovery(bot, storage, input, supportAgent),
      captureGuildBackup: (input) => captureGuildBackup(bot, storage, input),
      restoreGuildBackup: (input) => restoreGuildBackup(bot, storage, input),
      sendChannelMessage: (input) => sendChannelMessage(bot, input),
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
  console.log(`NexaDesk runtime: RUN_BOT=${config.RUN_BOT} BOT_HA_ENABLED=${config.BOT_HA_ENABLED} BOT_GATEWAY_ELIGIBLE=${botGatewayEligible} BOT_INSTANCE_ID=${config.BOT_INSTANCE_ID || 'auto'} KEEPALIVE_ENABLED=${config.KEEPALIVE_ENABLED}`);
});

startKeepAliveLoop(config);

if (config.BOT_HA_ENABLED) {
  startHighAvailabilityBot({ bot, storage, config }).catch((error) => {
    console.error('NexaDesk HA startup failed. Dashboard remains online.', error);
  });
} else if (config.RUN_BOT) {
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
    visualAnalyzer,
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

  if (config.AI_LOCAL_FALLBACK_ENABLED) {
    providers.push(createAiProvider('local-emergency', new LocalSupportClient({
      enabled: config.AI_LOCAL_FALLBACK_ENABLED
    })));
  }

  return new FallbackAiClient(providers, {
    generateTimeoutMs: config.AI_PROVIDER_TIMEOUT_MS
  });
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

async function createInitializedStorage(config, events) {
  const storage = createStorage(config, events);
  try {
    await storage.init();
    if (config.DATABASE_URL) {
      await withStartupTimeout(
        storage.getGlobalSettings(),
        config.DATABASE_CONNECT_TIMEOUT_MS,
        'Database startup check'
      );
    }
    return storage;
  } catch (error) {
    if (!config.DATABASE_URL) throw error;

    console.error('CockroachDB/PostgreSQL is unavailable during startup. Falling back to local JSON storage so NexaDesk can keep running.', compactStartupError(error));
    const fallback = new JsonStorage(config.DATA_DIR, events);
    await fallback.init();
    return fallback;
  }
}

function withStartupTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'startup_timeout';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timeoutId));
}

function compactStartupError(error) {
  return {
    message: error?.message ?? String(error),
    code: error?.code ?? error?.cause?.code ?? '',
    status: error?.status ?? error?.response?.status ?? ''
  };
}

async function startHighAvailabilityBot({ bot, storage, config }) {
  const instanceId = config.BOT_INSTANCE_ID?.trim() || `${os.hostname()}-${process.pid}`;
  const primaryInstanceId = String(config.BOT_PRIMARY_INSTANCE_ID || '').trim();
  const isPrimaryInstance = Boolean(primaryInstanceId && instanceId === primaryInstanceId);
  let leaseToken = '';
  let loggedIn = false;
  let loginPromise = null;
  let renewTimer = null;
  let pollTimer = null;
  let lastStandbyLogAt = 0;
  let leaseCheckInFlight = false;
  console.log(`NexaDesk HA starting on ${instanceId}. Primary=${primaryInstanceId || 'none'} Lease TTL=${config.BOT_LEASE_TTL_MS}ms renew=${config.BOT_LEASE_RENEW_MS}ms poll=${config.BOT_FAILOVER_POLL_MS}ms.`);

  async function readLease() {
    const settings = await storage.getGlobalSettings();
    const lease = settings?.botLease && typeof settings.botLease === 'object' ? settings.botLease : {};
    const expiresAt = Date.parse(lease.expiresAt ?? '');
    const primaryLastSeenAt = Date.parse(lease.primaryLastSeenAt ?? '');
    return {
      ownerId: lease.ownerId ? String(lease.ownerId) : '',
      claimToken: lease.claimToken ? String(lease.claimToken) : '',
      updatedAt: lease.updatedAt ?? null,
      primaryLastSeenAt: Number.isFinite(primaryLastSeenAt) ? primaryLastSeenAt : 0,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      raw: lease
    };
  }

  async function writeLease(previous = {}, token = leaseToken || crypto.randomUUID()) {
    leaseToken = token;
    const now = Date.now();
    return storage.updateGlobalSettings({
      botLease: {
        ...previous,
        ownerId: instanceId,
        claimToken: token,
        primaryInstanceId: primaryInstanceId || previous.primaryInstanceId || '',
        primaryLastSeenAt: isPrimaryInstance ? new Date(now).toISOString() : previous.primaryLastSeenAt,
        hostname: os.hostname(),
        pid: process.pid,
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + config.BOT_LEASE_TTL_MS).toISOString()
      }
    });
  }

  async function claimLease(previous = {}) {
    const token = crypto.randomUUID();
    await writeLease(previous, token);
    await wait(config.BOT_LEASE_CLAIM_SETTLE_MS);
    const confirmed = await readLease();
    return confirmed.ownerId === instanceId && confirmed.claimToken === token ? confirmed : null;
  }

  async function ensureLoggedIn() {
    if (loggedIn || bot.isReady?.()) return;
    if (!loginPromise) {
      loginPromise = bot.login(config.DISCORD_TOKEN)
        .then(() => {
          loggedIn = true;
          console.log(`NexaDesk HA leader active on ${instanceId}.`);
        })
        .finally(() => {
          loginPromise = null;
        });
    }
    await loginPromise;
    const lease = await readLease();
    if (lease.ownerId !== instanceId || lease.claimToken !== leaseToken) {
      await releaseLocalBot(`lease changed after login to ${lease.ownerId || 'none'}`);
      throw new Error(`Lost NexaDesk HA leadership after login; current leader is ${lease.ownerId || 'none'}.`);
    }
  }

  async function releaseLocalBot(reason) {
    if (!loggedIn && !bot.isReady?.()) return;
    console.warn(`NexaDesk HA instance ${instanceId} lost leadership: ${reason}. Disconnecting bot gateway.`);
    loggedIn = false;
    await bot.destroy();
  }

  async function renewLeadership() {
    const lease = await readLease();
    if (!isPrimaryInstance && primarySeenRecently(lease)) {
      await releaseLocalBot(`primary ${primaryInstanceId} is alive`);
      if (lease.ownerId === instanceId) {
        await releaseStandbyLeaseForPrimary(lease.raw);
      }
      return;
    }
    if (lease.ownerId && lease.ownerId !== instanceId && lease.expiresAt > Date.now()) {
      await releaseLocalBot(`lease owned by ${lease.ownerId}`);
      return;
    }
    const confirmed = await claimLease(lease.raw);
    if (!confirmed) {
      await releaseLocalBot(`lease claim was taken by another instance`);
      return;
    }
    try {
      await ensureLoggedIn();
    } catch (error) {
      await releaseLeaseAfterFailedLogin(lease.raw, error);
      throw error;
    }
  }

  async function tryBecomeLeader() {
    const lease = await readLease();
    const expired = !lease.ownerId || lease.expiresAt <= Date.now();
    const ownsLease = lease.ownerId === instanceId;
    const canRecoverFromStandby = isPrimaryInstance && lease.ownerId && lease.ownerId !== instanceId && lease.ownerId !== primaryInstanceId;
    if (!isPrimaryInstance && primarySeenRecently(lease)) {
      if (ownsLease) {
        await releaseLocalBot(`primary ${primaryInstanceId} is alive`);
        await releaseStandbyLeaseForPrimary(lease.raw);
      }
      return;
    }
    if (ownsLease && renewTimer) return;
    if (ownsLease || expired || canRecoverFromStandby) {
      if (expired && lease.ownerId && lease.ownerId !== instanceId) {
        console.warn(`NexaDesk HA lease expired for ${lease.ownerId}; ${instanceId} attempting takeover.`);
      }
      if (canRecoverFromStandby) {
        console.warn(`NexaDesk HA primary ${instanceId} is recovering leadership from standby ${lease.ownerId}.`);
      }
      const confirmed = await claimLease(lease.raw);
      if (!confirmed) return;
      try {
        await ensureLoggedIn();
      } catch (error) {
        await releaseLeaseAfterFailedLogin(lease.raw, error);
        throw error;
      }
      if (!renewTimer) {
        renewTimer = setInterval(() => {
          runLeaseCheck(renewLeadership).catch((error) => console.error('NexaDesk HA lease renewal failed:', error));
        }, config.BOT_LEASE_RENEW_MS);
        renewTimer.unref?.();
      }
      return;
    }

    if (Date.now() - lastStandbyLogAt > 30000) {
      console.log(`NexaDesk HA standby on ${instanceId}. Current leader: ${lease.ownerId}, expires ${new Date(lease.expiresAt).toISOString()}.`);
      lastStandbyLogAt = Date.now();
    }
  }

  async function runLeaseCheck(action) {
    if (leaseCheckInFlight) return;
    leaseCheckInFlight = true;
    try {
      await action();
    } finally {
      leaseCheckInFlight = false;
    }
  }

  async function releaseLeaseAfterFailedLogin(previous, error) {
    await storage.updateGlobalSettings({
      botLease: {
        ...previous,
        ownerId: '',
        releasedBy: instanceId,
        releasedAt: new Date().toISOString(),
        releaseReason: `login_failed:${error?.message ?? 'unknown'}`,
        expiresAt: new Date().toISOString()
      }
    }).catch(() => {});
  }

  function primarySeenRecently(lease) {
    if (!primaryInstanceId || isPrimaryInstance) return false;
    if (lease.ownerId === primaryInstanceId && lease.expiresAt > Date.now()) return true;
    const graceMs = Math.max(config.BOT_LEASE_TTL_MS * 3, 45000);
    return lease.primaryLastSeenAt > 0 && Date.now() - lease.primaryLastSeenAt < graceMs;
  }

  async function releaseStandbyLeaseForPrimary(previous = {}) {
    await storage.updateGlobalSettings({
      botLease: {
        ...previous,
        ownerId: '',
        releasedBy: instanceId,
        releasedAt: new Date().toISOString(),
        releaseReason: `primary_alive:${primaryInstanceId}`,
        expiresAt: new Date().toISOString()
      }
    }).catch(() => {});
  }

  await runLeaseCheck(tryBecomeLeader);
  pollTimer = setInterval(() => {
    runLeaseCheck(tryBecomeLeader).catch((error) => console.error('NexaDesk HA failover poll failed:', error));
  }, config.BOT_FAILOVER_POLL_MS);
  pollTimer.unref?.();

  async function shutdown() {
    if (renewTimer) clearInterval(renewTimer);
    if (pollTimer) clearInterval(pollTimer);
    const lease = await readLease().catch(() => null);
    if (lease?.ownerId === instanceId) {
      await storage.updateGlobalSettings({
        botLease: {
          ...lease.raw,
          ownerId: '',
          releasedBy: instanceId,
          releasedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString()
        }
      }).catch(() => {});
    }
  }

  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

function startKeepAliveLoop(config) {
  if (!config.KEEPALIVE_ENABLED) return;
  const url = config.KEEPALIVE_URL || (config.DASHBOARD_PUBLIC_URL ? `${String(config.DASHBOARD_PUBLIC_URL).replace(/\/+$/g, '')}/health` : '');
  if (!url) {
    console.warn('NexaDesk keepalive enabled but KEEPALIVE_URL/DASHBOARD_PUBLIC_URL is not configured.');
    return;
  }

  const ping = async () => {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'NexaDesk-HA-KeepAlive/1.0'
        }
      });
      console.log(`NexaDesk keepalive ${response.status} ${url} (${Date.now() - startedAt}ms).`);
    } catch (error) {
      console.warn(`NexaDesk keepalive failed for ${url}:`, error?.message ?? error);
    }
  };

  setTimeout(ping, 10_000).unref?.();
  const timer = setInterval(ping, config.KEEPALIVE_INTERVAL_MS);
  timer.unref?.();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
