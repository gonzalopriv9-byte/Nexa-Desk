import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPostgresClient } from './postgres-client.js';
import {
  addDays,
  generateAffiliateCode,
  normalizeAffiliateCode,
  normalizeAffiliateProfile,
  normalizeAffiliateRedemption
} from './affiliates.js';
import { normalizeAiQualitySignal } from './ai-quality.js';
import { normalizeGuildBackupSnapshot } from './backups.js';
import { normalizeBlacklistEntry, normalizeBlacklistEvidence, normalizeBlacklistLookup } from './blacklist.js';
import { buildFeedbackStats, normalizeGrowthConfig, normalizeTicketFeedback } from './growth.js';
import { normalizeMaintenanceState } from './maintenance.js';
import {
  DEFAULT_PREMIUM_MODULES,
  normalizePremiumActivation,
  normalizePremiumPurchase,
  pickAvailablePremiumPurchase,
  summarizePremiumBilling
} from './premium-billing.js';
import { isPremiumEntitled, normalizePremiumConfig } from './premium.js';
import { normalizeSecurityConfig } from './security.js';
import { normalizeWelcomeConfig } from './welcome.js';
import { normalizeDiscoveryConfig } from './server-discovery.js';

const GLOBAL_SETTINGS_GUILD_ID = '__nexadesk_global__';

export class JsonStorage {
  constructor(dataDir, events = null) {
    this.dataDir = dataDir;
    this.events = events;
    this.guildsFile = path.join(dataDir, 'guilds.json');
    this.ticketsFile = path.join(dataDir, 'tickets.json');
    this.transcriptsFile = path.join(dataDir, 'transcripts.json');
    this.globalSettingsFile = path.join(dataDir, 'global-settings.json');
    this.blacklistFile = path.join(dataDir, 'global-blacklist.json');
    this.blacklistEvidenceFile = path.join(dataDir, 'global-blacklist-evidence.json');
    this.feedbackFile = path.join(dataDir, 'ticket-feedback.json');
    this.aiQualitySignalsFile = path.join(dataDir, 'ai-quality-signals.json');
    this.guildLogsFile = path.join(dataDir, 'guild-logs.json');
    this.guildBackupsFile = path.join(dataDir, 'guild-backups.json');
    this.guildBackupRestoresFile = path.join(dataDir, 'guild-backup-restores.json');
    this.premiumPurchasesFile = path.join(dataDir, 'premium-purchases.json');
    this.premiumActivationsFile = path.join(dataDir, 'premium-activations.json');
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.#ensureJson(this.guildsFile, {});
    await this.#ensureJson(this.ticketsFile, {});
    await this.#ensureJson(this.transcriptsFile, {});
    await this.#ensureJson(this.globalSettingsFile, {});
    await this.#ensureJson(this.blacklistFile, {});
    await this.#ensureJson(this.blacklistEvidenceFile, {});
    await this.#ensureJson(this.feedbackFile, {});
    await this.#ensureJson(this.aiQualitySignalsFile, {});
    await this.#ensureJson(this.guildLogsFile, {});
    await this.#ensureJson(this.guildBackupsFile, {});
    await this.#ensureJson(this.guildBackupRestoresFile, {});
    await this.#ensureJson(this.premiumPurchasesFile, {});
    await this.#ensureJson(this.premiumActivationsFile, {});
  }

  async getGuildConfig(guildId) {
    const guilds = await this.#readJson(this.guildsFile);
    return guilds[guildId] ?? null;
  }

  async upsertGuildConfig(guildId, patch) {
    const guilds = await this.#readJson(this.guildsFile);
    const existing = guilds[guildId] ?? {};
    guilds[guildId] = {
      ...existing,
      ...patch,
      guildId,
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.guildsFile, guilds);
    this.events?.publish('guild.updated', guilds[guildId]);
    return guilds[guildId];
  }

  async listGuildConfigs() {
    const guilds = await this.#readJson(this.guildsFile);
    return Object.values(guilds);
  }

  async createTicket(ticket) {
    const tickets = await this.#readJson(this.ticketsFile);
    const existing = tickets[ticket.channelId];
    if (existing) {
      return { ...existing, alreadyExists: true };
    }

    tickets[ticket.channelId] = {
      ...ticket,
      status: ticket.status ?? 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.ticketsFile, tickets);
    this.events?.publish('ticket.created', tickets[ticket.channelId]);
    await this.addGuildLog({
      guildId: tickets[ticket.channelId].guildId,
      guildName: tickets[ticket.channelId].guildName,
      type: 'ticket',
      severity: 'info',
      title: 'Ticket detectado',
      message: `NexaDesk detecto o creo el ticket #${tickets[ticket.channelId].channelName ?? tickets[ticket.channelId].channelId}.`,
      channelId: tickets[ticket.channelId].channelId,
      channelName: tickets[ticket.channelId].channelName,
      targetId: tickets[ticket.channelId].openedBy,
      metadata: { status: tickets[ticket.channelId].status, categoryId: tickets[ticket.channelId].categoryId }
    }).catch(() => {});
    return { ...tickets[ticket.channelId], alreadyExists: false };
  }

  async getTicket(channelId) {
    const tickets = await this.#readJson(this.ticketsFile);
    return tickets[channelId] ?? null;
  }

  async getTicketByVoiceChannelId(voiceChannelId) {
    const tickets = await this.#readJson(this.ticketsFile);
    return Object.values(tickets).find((ticket) => ticket.voiceChannelId === voiceChannelId) ?? null;
  }

  async updateTicket(channelId, patch) {
    const tickets = await this.#readJson(this.ticketsFile);
    const existing = tickets[channelId];
    if (!existing) return null;

    tickets[channelId] = {
      ...existing,
      ...patch,
      channelId,
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.ticketsFile, tickets);
    this.events?.publish('ticket.updated', tickets[channelId]);
    return tickets[channelId];
  }

  async listTickets() {
    const tickets = await this.#readJson(this.ticketsFile);
    return Object.values(tickets).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addTranscriptMessage(message) {
    const transcripts = await this.#readJson(this.transcriptsFile);
    const channelMessages = transcripts[message.channelId] ?? [];
    const saved = {
      ...message,
      createdAt: message.createdAt ?? new Date().toISOString()
    };
    transcripts[message.channelId] = [...channelMessages, saved].slice(-500);
    await this.#writeJson(this.transcriptsFile, transcripts);
    this.events?.publish('transcript.message', saved);
    return saved;
  }

  async listTranscriptMessages(channelId, { limit = null } = {}) {
    const transcripts = await this.#readJson(this.transcriptsFile);
    const messages = transcripts[channelId] ?? [];
    const normalizedLimit = Number.parseInt(limit, 10);
    return Number.isInteger(normalizedLimit) && normalizedLimit > 0
      ? messages.slice(-normalizedLimit)
      : messages;
  }

  async searchGuildTranscriptMessages(guildId, terms = [], { limit = 10, scanLimit = 400 } = {}) {
    const transcripts = await this.#readJson(this.transcriptsFile);
    const tickets = await this.#readJson(this.ticketsFile);
    const candidates = [];

    for (const [channelId, messages] of Object.entries(transcripts)) {
      const ticket = tickets[channelId];
      for (const message of [...messages].slice(-scanLimit)) {
        if (message.guildId !== guildId && ticket?.guildId !== guildId) continue;
        const score = scoreTranscriptMessageForTerms(message, terms);
        if (score <= 0) continue;
        candidates.push({
          ...message,
          guildId: message.guildId ?? ticket?.guildId,
          channelId,
          channelName: ticket?.channelName,
          score
        });
      }
    }

    return candidates
      .sort((a, b) => (b.score - a.score) || ((Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)))
      .slice(0, limit);
  }

  async getDashboardStats(guildIds = []) {
    const guildIdSet = new Set(guildIds);
    const guilds = Object.values(await this.#readJson(this.guildsFile))
      .filter((guild) => guildIdSet.has(guild.guildId));
    const tickets = Object.values(await this.#readJson(this.ticketsFile))
      .filter((ticket) => guildIdSet.has(ticket.guildId));
    const transcripts = await this.#readJson(this.transcriptsFile);
    const ticketIds = new Set(tickets.map((ticket) => ticket.channelId));
    const transcriptMessages = Object.entries(transcripts)
      .filter(([channelId]) => ticketIds.has(channelId))
      .reduce((total, [, messages]) => total + messages.length, 0);

    const feedback = Object.values(await this.#readJson(this.feedbackFile))
      .filter((item) => guildIdSet.has(item.guildId))
      .map(normalizeTicketFeedback);

    return buildStats({ guilds, tickets, transcriptMessages, feedback });
  }

  async addTicketFeedback(feedback) {
    const feedbackById = await this.#readJson(this.feedbackFile);
    const normalized = normalizeTicketFeedback(feedback);
    feedbackById[normalized.id] = normalized;
    await this.#writeJson(this.feedbackFile, feedbackById);
    this.events?.publish('ticket.feedback', normalized);
    return normalized;
  }

  async getTicketFeedback(id) {
    const feedbackById = await this.#readJson(this.feedbackFile);
    const feedback = feedbackById[id];
    return feedback ? normalizeTicketFeedback(feedback) : null;
  }

  async listTicketFeedback(guildIds = []) {
    const guildIdSet = new Set(guildIds);
    const feedback = Object.values(await this.#readJson(this.feedbackFile)).map(normalizeTicketFeedback);
    return feedback
      .filter((item) => !guildIdSet.size || guildIdSet.has(item.guildId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addAiQualitySignal(signal) {
    const signals = await this.#readJson(this.aiQualitySignalsFile);
    const normalized = normalizeAiQualitySignal(signal);
    signals[normalized.id] = normalized;
    await this.#writeJson(this.aiQualitySignalsFile, signals);
    this.events?.publish('ai.quality.signal', normalized);
    return normalized;
  }

  async listAiQualitySignals(guildIds = []) {
    const guildIdSet = new Set(guildIds);
    const signals = Object.values(await this.#readJson(this.aiQualitySignalsFile)).map(normalizeAiQualitySignal);
    return signals
      .filter((item) => !guildIdSet.size || guildIdSet.has(item.guildId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addGuildLog(entry) {
    const logs = await this.#readJson(this.guildLogsFile);
    const normalized = normalizeGuildLog(entry);
    const guildLogs = logs[normalized.guildId] ?? [];
    logs[normalized.guildId] = [normalized, ...guildLogs].slice(0, 1000);
    await this.#writeJson(this.guildLogsFile, logs);
    this.events?.publish('guild.log.created', normalized);
    return normalized;
  }

  async listGuildLogs(guildId, { limit = 150 } = {}) {
    const logs = await this.#readJson(this.guildLogsFile);
    return (logs[String(guildId)] ?? [])
      .map(normalizeGuildLog)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, clampNumber(limit, 1, 500));
  }

  async saveGuildBackupSnapshot(snapshot) {
    const backups = await this.#readJson(this.guildBackupsFile);
    const normalized = normalizeGuildBackupSnapshot(snapshot);
    backups[normalized.id] = normalized;

    const byGuild = Object.values(backups)
      .map(normalizeGuildBackupSnapshot)
      .filter((item) => item.guildId === normalized.guildId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    for (const oldBackup of byGuild.slice(30)) {
      delete backups[oldBackup.id];
    }

    await this.#writeJson(this.guildBackupsFile, backups);
    this.events?.publish('guild.backup.saved', normalized);
    return normalized;
  }

  async listGuildBackupSnapshots(guildIds = [], { limit = 100 } = {}) {
    const allowed = new Set(guildIds.map(String).filter(Boolean));
    const backups = Object.values(await this.#readJson(this.guildBackupsFile))
      .map(normalizeGuildBackupSnapshot)
      .filter((snapshot) => !allowed.size || allowed.has(snapshot.guildId))
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return backups.slice(0, clampNumber(limit, 1, 500));
  }

  async getGuildBackupSnapshot(id) {
    const backups = await this.#readJson(this.guildBackupsFile);
    return backups[id] ? normalizeGuildBackupSnapshot(backups[id]) : null;
  }

  async recordGuildBackupRestore(entry) {
    const restores = await this.#readJson(this.guildBackupRestoresFile);
    const normalized = normalizeGuildBackupRestoreEntry(entry);
    restores[normalized.id] = normalized;
    await this.#writeJson(this.guildBackupRestoresFile, restores);
    this.events?.publish('guild.backup.restored', normalized);
    return normalized;
  }

  async listGuildBackupRestores(guildIds = [], { limit = 100 } = {}) {
    const allowed = new Set(guildIds.map(String).filter(Boolean));
    const restores = Object.values(await this.#readJson(this.guildBackupRestoresFile))
      .map(normalizeGuildBackupRestoreEntry)
      .filter((entry) => !allowed.size || allowed.has(entry.sourceGuildId) || allowed.has(entry.targetGuildId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return restores.slice(0, clampNumber(limit, 1, 500));
  }

  async recordPremiumPurchase(purchase) {
    const normalized = normalizePremiumPurchase(purchase);
    const purchases = await this.#readJson(this.premiumPurchasesFile);
    purchases[normalized.id] = {
      ...(purchases[normalized.id] ?? {}),
      ...normalized,
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.premiumPurchasesFile, purchases);
    this.events?.publish('premium.purchase.recorded', purchases[normalized.id]);
    return normalizePremiumPurchase(purchases[normalized.id]);
  }

  async listPremiumPurchases(discordUserId) {
    const purchases = Object.values(await this.#readJson(this.premiumPurchasesFile)).map(normalizePremiumPurchase);
    return purchases
      .filter((purchase) => purchase.discordUserId === String(discordUserId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listPremiumActivations(discordUserId) {
    const activations = Object.values(await this.#readJson(this.premiumActivationsFile)).map(normalizePremiumActivation);
    return activations
      .filter((activation) => activation.discordUserId === String(discordUserId) && activation.active)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPremiumBillingAccount(discordUserId) {
    const [purchases, activations] = await Promise.all([
      this.listPremiumPurchases(discordUserId),
      this.listPremiumActivations(discordUserId)
    ]);
    return summarizePremiumBilling({ purchases, activations });
  }

  async getOrCreateAffiliateProfile({ discordUserId, username, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const settings = await this.getGlobalSettings();
    const store = normalizeAffiliateStore(settings.affiliates);
    const userId = String(discordUserId);
    const usedCodes = new Set(Object.values(store.profiles)
      .map((profile) => normalizeAffiliateProfile(profile))
      .filter((profile) => profile.discordUserId !== userId)
      .map((profile) => normalizeAffiliateCode(profile.code)));
    const existing = Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((profile) => profile.discordUserId === userId);
    if (existing) {
      const nextCode = buildAffiliateProfileCode({ username, userId, usedCodes, currentCode: existing.code });
      const updated = normalizeAffiliateProfile({
        ...existing,
        username: username ?? existing.username,
        code: nextCode,
        rewardThreshold,
        rewardSlots,
        rewardDays,
        updatedAt: new Date().toISOString()
      });
      store.profiles[updated.discordUserId] = updated;
      await this.updateGlobalSettings({ affiliates: store });
      return updated;
    }

    const code = buildAffiliateProfileCode({ username, userId, usedCodes });
    const profile = normalizeAffiliateProfile({
      discordUserId: userId,
      username,
      code,
      rewardThreshold,
      rewardSlots,
      rewardDays
    });
    store.profiles[profile.discordUserId] = profile;
    await this.updateGlobalSettings({ affiliates: store });
    return profile;
  }

  async getAffiliateProfileByCode(code) {
    const settings = await this.getGlobalSettings();
    const store = normalizeAffiliateStore(settings.affiliates);
    const normalizedCode = normalizeAffiliateCode(code);
    return Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((profile) => profile.code === normalizedCode || normalizeAffiliateCode(profile.username) === normalizedCode) ?? null;
  }

  async getAffiliateRedemptionByGuild(guildId) {
    const settings = await this.getGlobalSettings();
    const store = normalizeAffiliateStore(settings.affiliates);
    return Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .find((redemption) => redemption.guildId === String(guildId)) ?? null;
  }

  async recordAffiliateRedemption({ code, guildId, guildName, redeemedByUserId, redeemedByUsername, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const settings = await this.getGlobalSettings();
    const store = normalizeAffiliateStore(settings.affiliates);
    const normalizedCode = normalizeAffiliateCode(code);
    const existing = Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .find((redemption) => redemption.guildId === String(guildId));
    if (existing) {
      return {
        alreadyRedeemed: true,
        redemption: existing,
        profile: Object.values(store.profiles).map(normalizeAffiliateProfile).find((profile) => profile.discordUserId === existing.ownerDiscordUserId) ?? null,
        rewardPurchase: null
      };
    }

    const profile = Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((item) => item.code === normalizedCode || normalizeAffiliateCode(item.username) === normalizedCode);
    if (!profile) throw new Error('Usuario de afiliado no encontrado.');
    if (profile.discordUserId === String(redeemedByUserId)) {
      throw new Error('No puedes registrar tu propio usuario como afiliado.');
    }

    const now = new Date().toISOString();
    const existingOwnerRedemptions = Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .filter((redemption) => redemption.ownerDiscordUserId === profile.discordUserId).length;
    const nextTotal = existingOwnerRedemptions + 1;
    const rewardGranted = nextTotal % rewardThreshold === 0;
    const nextProfile = normalizeAffiliateProfile({
      ...profile,
      username: profile.username,
      rewardThreshold,
      rewardSlots,
      rewardDays,
      totalRedemptions: nextTotal,
      rewardsEarned: Math.floor(nextTotal / Math.max(1, rewardThreshold)),
      updatedAt: now
    });
    const redemption = normalizeAffiliateRedemption({
      id: `affiliate-${guildId}-${Date.now()}`,
      code: normalizedCode,
      ownerDiscordUserId: profile.discordUserId,
      guildId,
      guildName,
      redeemedByUserId,
      redeemedByUsername,
      rewardGranted,
      createdAt: now
    });
    store.profiles[nextProfile.discordUserId] = nextProfile;
    store.redemptions[redemption.id] = redemption;
    await this.updateGlobalSettings({ affiliates: store });

    let rewardPurchase = null;
    if (rewardGranted) {
      const cycle = Math.floor(nextTotal / rewardThreshold);
      const expiresAt = addDays(now, rewardDays);
      rewardPurchase = await this.recordPremiumPurchase({
        id: `affiliate-reward-${profile.discordUserId}-${cycle}-${Date.now()}`,
        discordUserId: profile.discordUserId,
        buyerUsername: profile.username,
        provider: 'affiliate',
        providerSessionId: `affiliate-${profile.discordUserId}-${cycle}`,
        amountTotal: 0,
        currency: 'eur',
        slotsPurchased: rewardSlots,
        slotsUsed: 0,
        status: 'paid',
        expiresAt,
        metadata: {
          type: 'affiliate_reward',
          threshold: rewardThreshold,
          rewardDays,
          rewardSlots,
          cycle,
          expiresAt
        },
        createdAt: now,
        updatedAt: now
      });
    }

    return { alreadyRedeemed: false, redemption, profile: nextProfile, rewardPurchase };
  }

  async activatePremiumSlot({ discordUserId, guildId, guildName, activatedBy }) {
    const activations = await this.#readJson(this.premiumActivationsFile);
    const existing = Object.values(activations)
      .map(normalizePremiumActivation)
      .find((activation) => activation.guildId === String(guildId) && activation.active);
    if (existing) {
      return {
        activation: existing,
        alreadyActive: true,
        account: await this.getPremiumBillingAccount(discordUserId)
      };
    }

    const purchases = await this.listPremiumPurchases(discordUserId);
    const userActivations = await this.listPremiumActivations(discordUserId);
    const purchase = pickAvailablePremiumPurchase({ purchases, activations: userActivations });
    if (!purchase) {
      throw new Error('No tienes slots premium disponibles. Compra un pack para activar mas servidores.');
    }

    const now = new Date().toISOString();
    const activation = normalizePremiumActivation({
      id: `activation-${guildId}-${Date.now()}`,
      purchaseId: purchase.id,
      discordUserId,
      guildId,
      guildName,
      activatedBy,
      active: true,
      expiresAt: purchase.expiresAt,
      createdAt: now,
      updatedAt: now
    });
    activations[activation.id] = activation;
    await this.#writeJson(this.premiumActivationsFile, activations);

    const allPurchases = await this.#readJson(this.premiumPurchasesFile);
    allPurchases[purchase.id] = {
      ...(allPurchases[purchase.id] ?? purchase),
      slotsUsed: (userActivations.filter((item) => item.purchaseId === purchase.id).length + 1),
      updatedAt: now
    };
    await this.#writeJson(this.premiumPurchasesFile, allPurchases);

    await this.upsertGuildConfig(guildId, {
      guildName,
      plan: 'pro',
      voiceSupportEnabled: true,
      premium: normalizePremiumConfig({ ...DEFAULT_PREMIUM_MODULES, expiresAt: purchase.expiresAt }, { plan: 'pro', voiceSupportEnabled: true })
    });
    this.events?.publish('premium.activation.created', activation);
    return {
      activation,
      alreadyActive: false,
      account: await this.getPremiumBillingAccount(discordUserId)
    };
  }

  async getGlobalSettings() {
    return this.#readJson(this.globalSettingsFile);
  }

  async updateGlobalSettings(patch) {
    const existing = await this.getGlobalSettings();
    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.globalSettingsFile, next);
    this.events?.publish('global.settings.updated', next);
    return next;
  }

  async getMaintenanceState() {
    const settings = await this.getGlobalSettings();
    return normalizeMaintenanceState(settings.maintenance);
  }

  async setMaintenanceState(patch) {
    const current = await this.getMaintenanceState();
    const maintenance = normalizeMaintenanceState({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    });
    const settings = await this.updateGlobalSettings({ maintenance });
    this.events?.publish('maintenance.updated', settings.maintenance);
    return normalizeMaintenanceState(settings.maintenance);
  }

  async getBlacklistEntry(value) {
    const { userId } = normalizeBlacklistLookup(value);
    const entries = await this.#readJson(this.blacklistFile);
    return entries[userId] ? normalizeBlacklistEntry(entries[userId]) : null;
  }

  async listBlacklistEntries() {
    const entries = await this.#readJson(this.blacklistFile);
    return Object.values(entries).map(normalizeBlacklistEntry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsertBlacklistEntry(entry) {
    const normalized = normalizeBlacklistEntry(entry);
    const entries = await this.#readJson(this.blacklistFile);
    entries[normalized.userId] = {
      ...(entries[normalized.userId] ?? {}),
      ...normalized,
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.blacklistFile, entries);
    this.events?.publish('blacklist.updated', entries[normalized.userId]);
    return normalizeBlacklistEntry(entries[normalized.userId]);
  }

  async deactivateBlacklistEntry(value, updatedBy = null) {
    const existing = await this.getBlacklistEntry(value);
    if (!existing) return null;
    return this.upsertBlacklistEntry({
      ...existing,
      active: false,
      updatedBy
    });
  }

  async addBlacklistEvidence(evidence) {
    const normalized = normalizeBlacklistEvidence(evidence);
    const allEvidence = await this.#readJson(this.blacklistEvidenceFile);
    const list = allEvidence[normalized.userId] ?? [];
    const saved = {
      ...normalized,
      id: normalized.id ?? `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString()
    };
    allEvidence[normalized.userId] = [...list, saved];
    await this.#writeJson(this.blacklistEvidenceFile, allEvidence);
    this.events?.publish('blacklist.evidence.created', saved);
    return normalizeBlacklistEvidence(saved);
  }

  async listBlacklistEvidence(value) {
    const { userId } = normalizeBlacklistLookup(value);
    const allEvidence = await this.#readJson(this.blacklistEvidenceFile);
    return (allEvidence[userId] ?? []).map(normalizeBlacklistEvidence).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async #ensureJson(filePath, defaultValue) {
    try {
      await fs.access(filePath);
    } catch {
      await this.#writeJson(filePath, defaultValue);
    }
  }

  async #readJson(filePath) {
    return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
  }

  async #writeJson(filePath, value) {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export class PostgresStorage {
  constructor({ connectionString, poolMax = 5, connectTimeoutMs = 8000, events = null }) {
    this.client = createPostgresClient(connectionString, {
      max: poolMax,
      connectionTimeoutMillis: connectTimeoutMs
    });
    this.events = events;
    this.guildCompatibilityOverlay = new Map();
    this.ticketCompatibilityOverlay = new Map();
  }

  async init() {
    await this.client.query('SELECT 1');
    await this.#loadTicketCompatibilityFallback().catch((error) => {
      console.warn('Could not load ticket compatibility fallback:', error?.message ?? error);
    });
  }

  async getGlobalSettings() {
    const { data, error } = await this.client
      .from('guild_configs')
      .select('guild_id, panels, updated_at')
      .eq('guild_id', GLOBAL_SETTINGS_GUILD_ID)
      .maybeSingle();
    if (error) throw error;
    return data?.panels?.globalSettings && typeof data.panels.globalSettings === 'object'
      ? data.panels.globalSettings
      : {};
  }

  async updateGlobalSettings(patch) {
    const existing = await this.getGlobalSettings();
    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    const { data, error } = await this.client
      .from('guild_configs')
      .upsert({
        guild_id: GLOBAL_SETTINGS_GUILD_ID,
        guild_name: 'NexaDesk Global Settings',
        panels: { globalSettings: next },
        updated_at: next.updatedAt
      }, { onConflict: 'guild_id' })
      .select('guild_id, panels, updated_at')
      .single();
    if (error) throw error;
    const saved = data?.panels?.globalSettings ?? next;
    this.events?.publish('global.settings.updated', saved);
    return saved;
  }

  async getMaintenanceState() {
    const settings = await this.getGlobalSettings();
    return normalizeMaintenanceState(settings.maintenance);
  }

  async setMaintenanceState(patch) {
    const current = await this.getMaintenanceState();
    const maintenance = normalizeMaintenanceState({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    });
    const settings = await this.updateGlobalSettings({ maintenance });
    this.events?.publish('maintenance.updated', settings.maintenance);
    return normalizeMaintenanceState(settings.maintenance);
  }

  async getGuildConfig(guildId) {
    const { data, error } = await this.client
      .from('guild_configs')
      .select('*')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) throw error;
    return data ? this.#mergeGuildCompatibility(fromGuildRow(data)) : null;
  }

  async upsertGuildConfig(guildId, patch) {
    const existing = await this.getGuildConfig(guildId);
    const next = {
      ...(existing ?? {}),
      ...patch,
      guildId,
      updatedAt: new Date().toISOString()
    };

    let { data, error } = await this.client
      .from('guild_configs')
      .upsert(toGuildRow(next), { onConflict: 'guild_id' })
      .select()
      .single();
    const usedCompatibleGuildSchema = error && /plan|voice_support_enabled|voice_category/i.test(String(error.message ?? ''));
    if (usedCompatibleGuildSchema) {
      const compatibleRow = toGuildRow(next);
      delete compatibleRow.plan;
      delete compatibleRow.voice_support_enabled;
      delete compatibleRow.voice_category_id;
      delete compatibleRow.voice_category_name;
      const retry = await this.client
        .from('guild_configs')
        .upsert(compatibleRow, { onConflict: 'guild_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    if (usedCompatibleGuildSchema) this.#rememberGuildCompatibility(guildId, next);
    const saved = this.#mergeGuildCompatibility(fromGuildRow(data));
    this.events?.publish('guild.updated', saved);
    return saved;
  }

  async listGuildConfigs() {
    const { data, error } = await this.client
      .from('guild_configs')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data
      .filter((row) => row.guild_id !== GLOBAL_SETTINGS_GUILD_ID)
      .map((row) => this.#mergeGuildCompatibility(fromGuildRow(row)));
  }

  async createTicket(ticket) {
    const existing = await this.getTicket(ticket.channelId);
    if (existing) {
      return { ...existing, alreadyExists: true };
    }

    const now = new Date().toISOString();
    const next = {
      ...ticket,
      status: ticket.status ?? 'open',
      createdAt: ticket.createdAt ?? now,
      updatedAt: now
    };
    let { data, error } = await this.client
      .from('tickets')
      .upsert(toTicketRow(next), { onConflict: 'channel_id' })
      .select()
      .single();
    const usedCompatibleTicketSchema = isTicketCompatibilityError(error);
    if (usedCompatibleTicketSchema) {
      const compatibleRow = toCompatibleTicketRow(next);
      const retry = await this.client
        .from('tickets')
        .upsert(compatibleRow, { onConflict: 'channel_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    if (usedCompatibleTicketSchema) await this.#rememberTicketCompatibility(ticket.channelId, next);
    const saved = this.#mergeTicketCompatibility(fromTicketRow(data));
    this.events?.publish('ticket.created', saved);
    await this.addGuildLog({
      guildId: saved.guildId,
      guildName: saved.guildName,
      type: 'ticket',
      severity: 'info',
      title: 'Ticket detectado',
      message: `NexaDesk detecto o creo el ticket #${saved.channelName ?? saved.channelId}.`,
      channelId: saved.channelId,
      channelName: saved.channelName,
      targetId: saved.openedBy,
      metadata: { status: saved.status, categoryId: saved.categoryId }
    }).catch(() => {});
    return { ...saved, alreadyExists: false };
  }

  async getTicket(channelId) {
    const { data, error } = await this.client
      .from('tickets')
      .select('*')
      .eq('channel_id', channelId)
      .maybeSingle();
    if (error) throw error;
    return data ? this.#mergeTicketCompatibility(fromTicketRow(data)) : null;
  }

  async getTicketByVoiceChannelId(voiceChannelId) {
    const { data, error } = await this.client
      .from('tickets')
      .select('*')
      .eq('voice_channel_id', voiceChannelId)
      .maybeSingle();
    if (error && /voice_channel_id/i.test(String(error.message ?? ''))) {
      return this.#findTicketCompatibilityByVoiceChannelId(voiceChannelId);
    }
    if (error) throw error;
    return data ? this.#mergeTicketCompatibility(fromTicketRow(data)) : null;
  }

  async updateTicket(channelId, patch) {
    const existing = await this.getTicket(channelId);
    if (!existing) return null;

    const next = {
      ...existing,
      ...patch,
      channelId,
      updatedAt: new Date().toISOString()
    };
    let { data, error } = await this.client
      .from('tickets')
      .update(toTicketRow(next))
      .eq('channel_id', channelId)
      .select()
      .single();
    const usedCompatibleTicketSchema = isTicketCompatibilityError(error);
    if (usedCompatibleTicketSchema) {
      const compatibleRow = toCompatibleTicketRow(next);
      const retry = await this.client
        .from('tickets')
        .update(compatibleRow)
        .eq('channel_id', channelId)
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    if (usedCompatibleTicketSchema) await this.#rememberTicketCompatibility(channelId, next);
    const saved = this.#mergeTicketCompatibility(fromTicketRow(data));
    this.events?.publish('ticket.updated', saved);
    return saved;
  }

  async listTickets() {
    const { data, error } = await this.client
      .from('tickets')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data.map((row) => this.#mergeTicketCompatibility(fromTicketRow(row)));
  }

  async addTranscriptMessage(message) {
    const { data, error } = await this.client
      .from('transcript_messages')
      .insert(toTranscriptRow(message))
      .select()
      .single();
    if (error) throw error;
    const saved = fromTranscriptRow(data);
    this.events?.publish('transcript.message', saved);
    return saved;
  }

  async listTranscriptMessages(channelId, { limit = null } = {}) {
    const normalizedLimit = Number.parseInt(limit, 10);
    const hasLimit = Number.isInteger(normalizedLimit) && normalizedLimit > 0;
    const query = this.client
      .from('transcript_messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: !hasLimit });
    if (hasLimit) query.limit(normalizedLimit);
    const { data, error } = await query;
    if (error) throw error;
    const messages = data.map(fromTranscriptRow);
    return hasLimit ? messages.reverse() : messages;
  }

  async searchGuildTranscriptMessages(guildId, terms = [], { limit = 10, scanLimit = 400 } = {}) {
    const { data, error } = await this.client
      .from('transcript_messages')
      .select('*')
      .eq('guild_id', guildId)
      .order('created_at', { ascending: false })
      .limit(scanLimit);
    if (error) throw error;

    return data
      .map((row) => {
        const message = fromTranscriptRow(row);
        const score = scoreTranscriptMessageForTerms(message, terms);
        return {
          ...message,
          score
        };
      })
      .filter((message) => message.score > 0)
      .sort((a, b) => (b.score - a.score) || ((Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)))
      .slice(0, limit);
  }

  async getDashboardStats(guildIds = []) {
    if (!guildIds.length) {
      return buildStats({ guilds: [], tickets: [], transcriptMessages: 0, feedback: [] });
    }

    const [{ data: guilds, error: guildsError }, { data: tickets, error: ticketsError }] = await Promise.all([
      this.client
        .from('guild_configs')
        .select('*')
        .in('guild_id', guildIds),
      this.client
        .from('tickets')
        .select('*')
        .in('guild_id', guildIds)
    ]);
    if (guildsError) throw guildsError;
    if (ticketsError) throw ticketsError;

    const channelIds = tickets.map((ticket) => ticket.channel_id);
    let transcriptMessages = 0;
    if (channelIds.length) {
      const { count, error } = await this.client
        .from('transcript_messages')
        .select('id', { count: 'exact', head: true })
        .in('channel_id', channelIds);
      if (error) throw error;
      transcriptMessages = count ?? 0;
    }

    const feedback = await this.listTicketFeedback(guildIds);

    return buildStats({
      guilds: guilds.map((row) => this.#mergeGuildCompatibility(fromGuildRow(row))),
      tickets: tickets.map((row) => this.#mergeTicketCompatibility(fromTicketRow(row))),
      transcriptMessages,
      feedback
    });
  }

  async addTicketFeedback(feedback) {
    const normalized = normalizeTicketFeedback(feedback);
    const { data, error } = await this.client
      .from('ticket_feedback')
      .upsert(toFeedbackRow(normalized), { onConflict: 'id' })
      .select()
      .single();
    if (isMissingFeedbackTableError(error)) {
      console.warn('ticket_feedback table missing; feedback not persisted. Run el esquema de PostgreSQL.');
      return { ...normalized, notPersisted: true };
    }
    if (error) throw error;
    const saved = fromFeedbackRow(data);
    this.events?.publish('ticket.feedback', saved);
    return saved;
  }

  async getTicketFeedback(id) {
    const { data, error } = await this.client
      .from('ticket_feedback')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (isMissingFeedbackTableError(error)) return null;
    if (error) throw error;
    return data ? fromFeedbackRow(data) : null;
  }

  async listTicketFeedback(guildIds = []) {
    let query = this.client
      .from('ticket_feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(250);
    if (guildIds.length) query = query.in('guild_id', guildIds);
    const { data, error } = await query;
    if (isMissingFeedbackTableError(error)) return [];
    if (error) throw error;
    return data.map(fromFeedbackRow);
  }

  async addAiQualitySignal(signal) {
    const normalized = normalizeAiQualitySignal(signal);
    const { data, error } = await this.client
      .from('ai_quality_signals')
      .upsert(toAiQualitySignalRow(normalized), { onConflict: 'id' })
      .select()
      .single();
    if (isMissingAiQualitySignalTableError(error)) {
      console.warn('ai_quality_signals table missing; quality signal not persisted. Run el esquema de PostgreSQL.');
      return { ...normalized, notPersisted: true };
    }
    if (error) throw error;
    const saved = fromAiQualitySignalRow(data);
    this.events?.publish('ai.quality.signal', saved);
    return saved;
  }

  async listAiQualitySignals(guildIds = []) {
    let query = this.client
      .from('ai_quality_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (guildIds.length) query = query.in('guild_id', guildIds);
    const { data, error } = await query;
    if (isMissingAiQualitySignalTableError(error)) return [];
    if (error) throw error;
    return data.map(fromAiQualitySignalRow);
  }

  async addGuildLog(entry) {
    const normalized = normalizeGuildLog(entry);
    const { data, error } = await this.client
      .from('guild_logs')
      .insert(toGuildLogRow(normalized))
      .select()
      .single();
    if (isMissingGuildLogsTableError(error)) {
      console.warn('guild_logs table missing; persisting server log in PostgreSQL fallback store. Run el esquema de PostgreSQL for full indexes.');
      return this.#addGuildLogFallback(normalized);
    }
    if (error) throw error;
    const saved = fromGuildLogRow(data);
    this.events?.publish('guild.log.created', saved);
    return saved;
  }

  async listGuildLogs(guildId, { limit = 150 } = {}) {
    const { data, error } = await this.client
      .from('guild_logs')
      .select('*')
      .eq('guild_id', String(guildId))
      .order('created_at', { ascending: false })
      .limit(clampNumber(limit, 1, 500));
    if (isMissingGuildLogsTableError(error)) {
      return this.#listGuildLogsFallback(guildId, { limit });
    }
    if (error) throw error;
    return data.map(fromGuildLogRow);
  }

  async #addGuildLogFallback(entry) {
    const normalized = normalizeGuildLog(entry);
    const settings = await this.getGlobalSettings();
    const source = settings.guildLogsFallback && typeof settings.guildLogsFallback === 'object'
      ? settings.guildLogsFallback
      : {};
    const guildId = String(normalized.guildId);
    const guildLogs = Array.isArray(source[guildId]) ? source[guildId].map(normalizeGuildLog) : [];
    const nextLogs = [normalized, ...guildLogs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 500);
    await this.updateGlobalSettings({
      guildLogsFallback: {
        ...source,
        [guildId]: nextLogs
      }
    });
    this.events?.publish('guild.log.created', normalized);
    return { ...normalized, fallback: true };
  }

  async #listGuildLogsFallback(guildId, { limit = 150 } = {}) {
    const settings = await this.getGlobalSettings();
    const source = settings.guildLogsFallback && typeof settings.guildLogsFallback === 'object'
      ? settings.guildLogsFallback
      : {};
    return (Array.isArray(source[String(guildId)]) ? source[String(guildId)] : [])
      .map(normalizeGuildLog)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, clampNumber(limit, 1, 500));
  }

  async saveGuildBackupSnapshot(snapshot) {
    const normalized = normalizeGuildBackupSnapshot(snapshot);
    const { data, error } = await this.client
      .from('guild_backups')
      .upsert(toGuildBackupRow(normalized), { onConflict: 'id' })
      .select()
      .single();
    if (isMissingGuildBackupsTableError(error)) {
      console.warn('guild_backups table missing; persisting backup in PostgreSQL fallback store. Run el esquema de PostgreSQL for indexed backups.');
      return this.#saveGuildBackupSnapshotFallback(normalized);
    }
    if (error) throw error;
    const saved = fromGuildBackupRow(data);
    this.events?.publish('guild.backup.saved', saved);
    return saved;
  }

  async listGuildBackupSnapshots(guildIds = [], { limit = 100 } = {}) {
    let query = this.client
      .from('guild_backups')
      .select('*')
      .order('captured_at', { ascending: false })
      .limit(clampNumber(limit, 1, 500));
    if (guildIds.length) query = query.in('guild_id', guildIds.map(String));
    const { data, error } = await query;
    if (isMissingGuildBackupsTableError(error)) {
      return this.#listGuildBackupSnapshotsFallback(guildIds, { limit });
    }
    if (error) throw error;
    return data.map(fromGuildBackupRow);
  }

  async getGuildBackupSnapshot(id) {
    const { data, error } = await this.client
      .from('guild_backups')
      .select('*')
      .eq('id', String(id))
      .maybeSingle();
    if (isMissingGuildBackupsTableError(error)) {
      return this.#getGuildBackupSnapshotFallback(id);
    }
    if (error) throw error;
    return data ? fromGuildBackupRow(data) : null;
  }

  async recordGuildBackupRestore(entry) {
    const normalized = normalizeGuildBackupRestoreEntry(entry);
    const { data, error } = await this.client
      .from('guild_backup_restores')
      .upsert(toGuildBackupRestoreRow(normalized), { onConflict: 'id' })
      .select()
      .single();
    if (isMissingGuildBackupsTableError(error)) {
      console.warn('guild_backup_restores table missing; persisting restore record in PostgreSQL fallback store. Run el esquema de PostgreSQL.');
      return this.#recordGuildBackupRestoreFallback(normalized);
    }
    if (error) throw error;
    const saved = fromGuildBackupRestoreRow(data);
    this.events?.publish('guild.backup.restored', saved);
    return saved;
  }

  async listGuildBackupRestores(guildIds = [], { limit = 100 } = {}) {
    const query = this.client
      .from('guild_backup_restores')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(clampNumber(limit, 1, 500) * (guildIds.length ? 3 : 1));
    const { data, error } = await query;
    if (isMissingGuildBackupsTableError(error)) {
      return this.#listGuildBackupRestoresFallback(guildIds, { limit });
    }
    if (error) throw error;
    const allowed = new Set(guildIds.map(String).filter(Boolean));
    return data
      .map(fromGuildBackupRestoreRow)
      .filter((entry) => !allowed.size || allowed.has(entry.sourceGuildId) || allowed.has(entry.targetGuildId))
      .slice(0, clampNumber(limit, 1, 500));
  }

  async #saveGuildBackupSnapshotFallback(snapshot) {
    const normalized = normalizeGuildBackupSnapshot(snapshot);
    const settings = await this.getGlobalSettings();
    const store = normalizeGuildBackupsFallbackStore(settings.guildBackupsFallback);
    store.snapshots[normalized.id] = normalized;
    const latest = Object.values(store.snapshots)
      .map(normalizeGuildBackupSnapshot)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    store.snapshots = Object.fromEntries(latest.slice(0, 500).map((item) => [item.id, item]));
    await this.updateGlobalSettings({ guildBackupsFallback: store });
    this.events?.publish('guild.backup.saved', normalized);
    return { ...normalized, fallback: true };
  }

  async #listGuildBackupSnapshotsFallback(guildIds = [], { limit = 100 } = {}) {
    const settings = await this.getGlobalSettings();
    const store = normalizeGuildBackupsFallbackStore(settings.guildBackupsFallback);
    const allowed = new Set(guildIds.map(String).filter(Boolean));
    return Object.values(store.snapshots)
      .map(normalizeGuildBackupSnapshot)
      .filter((snapshot) => !allowed.size || allowed.has(snapshot.guildId))
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .slice(0, clampNumber(limit, 1, 500));
  }

  async #getGuildBackupSnapshotFallback(id) {
    const settings = await this.getGlobalSettings();
    const store = normalizeGuildBackupsFallbackStore(settings.guildBackupsFallback);
    return store.snapshots[String(id)] ? normalizeGuildBackupSnapshot(store.snapshots[String(id)]) : null;
  }

  async #recordGuildBackupRestoreFallback(entry) {
    const normalized = normalizeGuildBackupRestoreEntry(entry);
    const settings = await this.getGlobalSettings();
    const store = normalizeGuildBackupsFallbackStore(settings.guildBackupsFallback);
    store.restores[normalized.id] = normalized;
    const latest = Object.values(store.restores)
      .map(normalizeGuildBackupRestoreEntry)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    store.restores = Object.fromEntries(latest.slice(0, 250).map((item) => [item.id, item]));
    await this.updateGlobalSettings({ guildBackupsFallback: store });
    this.events?.publish('guild.backup.restored', normalized);
    return { ...normalized, fallback: true };
  }

  async #listGuildBackupRestoresFallback(guildIds = [], { limit = 100 } = {}) {
    const settings = await this.getGlobalSettings();
    const store = normalizeGuildBackupsFallbackStore(settings.guildBackupsFallback);
    const allowed = new Set(guildIds.map(String).filter(Boolean));
    return Object.values(store.restores)
      .map(normalizeGuildBackupRestoreEntry)
      .filter((entry) => !allowed.size || allowed.has(entry.sourceGuildId) || allowed.has(entry.targetGuildId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, clampNumber(limit, 1, 500));
  }

  async getBlacklistEntry(value) {
    const { userId, banCode } = normalizeBlacklistLookup(value);
    const { data, error } = await this.client
      .from('global_blacklist')
      .select('*')
      .or(`user_id.eq.${userId},ban_code.eq.${banCode}`)
      .maybeSingle();
    if (isMissingBlacklistTableError(error)) return null;
    if (error) throw error;
    return data ? fromBlacklistRow(data) : null;
  }

  async listBlacklistEntries() {
    const { data, error } = await this.client
      .from('global_blacklist')
      .select('*')
      .order('updated_at', { ascending: false });
    if (isMissingBlacklistTableError(error)) return [];
    if (error) throw error;
    return data.map(fromBlacklistRow);
  }

  async upsertBlacklistEntry(entry) {
    const normalized = normalizeBlacklistEntry(entry);
    const { data, error } = await this.client
      .from('global_blacklist')
      .upsert(toBlacklistRow(normalized), { onConflict: 'user_id' })
      .select()
      .single();
    if (isMissingBlacklistTableError(error)) {
      throw new Error('Faltan tablas de blacklist en PostgreSQL. Ejecuta el SQL actualizado del esquema de PostgreSQL.');
    }
    if (error) throw error;
    const saved = fromBlacklistRow(data);
    this.events?.publish('blacklist.updated', saved);
    return saved;
  }

  async deactivateBlacklistEntry(value, updatedBy = null) {
    const existing = await this.getBlacklistEntry(value);
    if (!existing) return null;
    return this.upsertBlacklistEntry({
      ...existing,
      active: false,
      updatedBy
    });
  }

  async addBlacklistEvidence(evidence) {
    const normalized = normalizeBlacklistEvidence(evidence);
    const { data, error } = await this.client
      .from('global_blacklist_evidence')
      .insert(toBlacklistEvidenceRow(normalized))
      .select()
      .single();
    if (isMissingBlacklistTableError(error)) {
      throw new Error('Falta global_blacklist_evidence en PostgreSQL. Ejecuta el SQL actualizado del esquema de PostgreSQL.');
    }
    if (error) throw error;
    const saved = fromBlacklistEvidenceRow(data);
    this.events?.publish('blacklist.evidence.created', saved);
    return saved;
  }

  async listBlacklistEvidence(value) {
    const { userId, banCode } = normalizeBlacklistLookup(value);
    const { data, error } = await this.client
      .from('global_blacklist_evidence')
      .select('*')
      .or(`user_id.eq.${userId},ban_code.eq.${banCode}`)
      .order('created_at', { ascending: true });
    if (isMissingBlacklistTableError(error)) return [];
    if (error) throw error;
    return data.map(fromBlacklistEvidenceRow);
  }

  async recordPremiumPurchase(purchase) {
    const normalized = normalizePremiumPurchase(purchase);
    let { data, error } = await this.client
      .from('premium_purchases')
      .upsert(toPremiumPurchaseRow(normalized), { onConflict: 'id' })
      .select()
      .single();
    if (error && /expires_at/i.test(String(error.message ?? ''))) {
      const compatibleRow = toPremiumPurchaseRow(normalized);
      delete compatibleRow.expires_at;
      const retry = await this.client
        .from('premium_purchases')
        .upsert(compatibleRow, { onConflict: 'id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (isMissingPremiumBillingTableError(error)) return this.#recordPremiumPurchaseFallback(normalized);
    if (error) throw error;
    const saved = fromPremiumPurchaseRow(data);
    this.events?.publish('premium.purchase.recorded', saved);
    return saved;
  }

  async listPremiumPurchases(discordUserId) {
    const { data, error } = await this.client
      .from('premium_purchases')
      .select('*')
      .eq('discord_user_id', String(discordUserId))
      .order('created_at', { ascending: false });
    if (isMissingPremiumBillingTableError(error)) return this.#listPremiumPurchasesFallback(discordUserId);
    if (error) throw error;
    return data.map(fromPremiumPurchaseRow);
  }

  async listPremiumActivations(discordUserId) {
    const { data, error } = await this.client
      .from('premium_slot_activations')
      .select('*')
      .eq('discord_user_id', String(discordUserId))
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (isMissingPremiumBillingTableError(error)) return this.#listPremiumActivationsFallback(discordUserId);
    if (error) throw error;
    return data.map(fromPremiumActivationRow);
  }

  async getPremiumBillingAccount(discordUserId) {
    const [purchases, activations] = await Promise.all([
      this.listPremiumPurchases(discordUserId),
      this.listPremiumActivations(discordUserId)
    ]);
    return summarizePremiumBilling({ purchases, activations });
  }

  async getOrCreateAffiliateProfile({ discordUserId, username, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const userId = String(discordUserId);
    const existing = await this.#getAffiliateProfileByUserId(userId);
    if (existing) {
      const totalRedemptions = await this.#countAffiliateRedemptionsForOwner(userId)
        .catch(() => existing.totalRedemptions);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const next = normalizeAffiliateProfile({
          ...existing,
          username: username ?? existing.username,
          code: generateAffiliateCode(username ?? existing.username ?? userId, userId, attempt),
          rewardThreshold,
          rewardSlots,
          rewardDays,
          totalRedemptions,
          rewardsEarned: Math.floor(totalRedemptions / Math.max(1, rewardThreshold)),
          updatedAt: new Date().toISOString()
        });
        const { data, error } = await this.client
          .from('affiliate_profiles')
          .upsert(toAffiliateProfileRow(next), { onConflict: 'discord_user_id' })
          .select()
          .single();
        if (isMissingAffiliateTableError(error)) return this.#getOrCreateAffiliateProfileFallback({ discordUserId, username, rewardThreshold, rewardSlots, rewardDays });
        if (error && /duplicate key|unique/i.test(String(error.message ?? ''))) continue;
        if (error) throw error;
        return fromAffiliateProfileRow(data);
      }
      throw new Error('No pude actualizar tu nombre de afiliado. Pruebalo otra vez.');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const profile = normalizeAffiliateProfile({
        discordUserId: userId,
        username,
        code: generateAffiliateCode(username ?? userId, userId, attempt),
        rewardThreshold,
        rewardSlots,
        rewardDays
      });
      const { data, error } = await this.client
        .from('affiliate_profiles')
        .insert(toAffiliateProfileRow(profile))
        .select()
        .single();
      if (isMissingAffiliateTableError(error)) return this.#getOrCreateAffiliateProfileFallback({ discordUserId, username, rewardThreshold, rewardSlots, rewardDays });
      if (error && /duplicate key|unique/i.test(String(error.message ?? ''))) continue;
      if (error) throw error;
      return fromAffiliateProfileRow(data);
    }
    throw new Error('No pude generar un nombre de afiliado unico. Pruebalo otra vez.');
  }

  async getAffiliateProfileByCode(code) {
    const normalizedCode = normalizeAffiliateCode(code);
    const { data, error } = await this.client
      .from('affiliate_profiles')
      .select('*')
      .eq('code', normalizedCode)
      .maybeSingle();
    if (isMissingAffiliateTableError(error)) return this.#getAffiliateProfileByCodeFallback(code);
    if (error) throw error;
    if (data) return fromAffiliateProfileRow(data);

    const { data: rows, error: listError } = await this.client
      .from('affiliate_profiles')
      .select('*')
      .limit(500);
    if (isMissingAffiliateTableError(listError)) return this.#getAffiliateProfileByCodeFallback(code);
    if (listError) throw listError;
    const match = rows
      ?.map(fromAffiliateProfileRow)
      .find((profile) => normalizeAffiliateCode(profile.username) === normalizedCode) ?? null;
    return match;
  }

  async getAffiliateRedemptionByGuild(guildId) {
    const { data, error } = await this.client
      .from('affiliate_redemptions')
      .select('*')
      .eq('guild_id', String(guildId))
      .maybeSingle();
    if (isMissingAffiliateTableError(error)) return this.#getAffiliateRedemptionByGuildFallback(guildId);
    if (error) throw error;
    return data ? fromAffiliateRedemptionRow(data) : null;
  }

  async recordAffiliateRedemption({ code, guildId, guildName, redeemedByUserId, redeemedByUsername, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const existing = await this.getAffiliateRedemptionByGuild(guildId);
    if (existing) {
      return {
        alreadyRedeemed: true,
        redemption: existing,
        profile: await this.#getAffiliateProfileByUserId(existing.ownerDiscordUserId),
        rewardPurchase: null
      };
    }

    const profile = await this.getAffiliateProfileByCode(code);
    if (!profile) throw new Error('Usuario de afiliado no encontrado.');
    if (profile.discordUserId === String(redeemedByUserId)) {
      throw new Error('No puedes registrar tu propio usuario como afiliado.');
    }

    const now = new Date().toISOString();
    const redemption = normalizeAffiliateRedemption({
      id: `affiliate-${guildId}-${Date.now()}`,
      code: profile.code,
      ownerDiscordUserId: profile.discordUserId,
      guildId,
      guildName,
      redeemedByUserId,
      redeemedByUsername,
      rewardGranted: false,
      createdAt: now
    });

    const insert = await this.client
      .from('affiliate_redemptions')
      .insert(toAffiliateRedemptionRow(redemption))
      .select()
      .single();
    if (isMissingAffiliateTableError(insert.error)) return this.#recordAffiliateRedemptionFallback({ code, guildId, guildName, redeemedByUserId, redeemedByUsername, rewardThreshold, rewardSlots, rewardDays });
    if (insert.error && /duplicate key|unique/i.test(String(insert.error.message ?? ''))) {
      return {
        alreadyRedeemed: true,
        redemption: await this.getAffiliateRedemptionByGuild(guildId),
        profile,
        rewardPurchase: null
      };
    }
    if (insert.error) throw insert.error;

    const nextTotal = await this.#countAffiliateRedemptionsForOwner(profile.discordUserId)
      .catch(() => profile.totalRedemptions + 1);
    const rewardGranted = nextTotal > 0 && nextTotal % rewardThreshold === 0;
    const nextProfile = normalizeAffiliateProfile({
      ...profile,
      rewardThreshold,
      rewardSlots,
      rewardDays,
      totalRedemptions: nextTotal,
      rewardsEarned: Math.floor(nextTotal / Math.max(1, rewardThreshold)),
      updatedAt: now
    });

    const update = await this.client
      .from('affiliate_profiles')
      .update({
        username: nextProfile.username,
        reward_threshold: nextProfile.rewardThreshold,
        reward_slots: nextProfile.rewardSlots,
        reward_days: nextProfile.rewardDays,
        total_redemptions: nextProfile.totalRedemptions,
        rewards_earned: nextProfile.rewardsEarned,
        updated_at: now
      })
      .eq('discord_user_id', profile.discordUserId)
      .select()
      .single();
    if (update.error) throw update.error;

    let rewardPurchase = null;
    let savedRedemption = fromAffiliateRedemptionRow(insert.data);
    if (rewardGranted) {
      const cycle = Math.floor(nextTotal / rewardThreshold);
      const expiresAt = addDays(now, rewardDays);
      rewardPurchase = await this.recordPremiumPurchase({
        id: `affiliate-reward-${profile.discordUserId}-${cycle}-${Date.now()}`,
        discordUserId: profile.discordUserId,
        buyerUsername: profile.username,
        provider: 'affiliate',
        providerSessionId: `affiliate-${profile.discordUserId}-${cycle}`,
        amountTotal: 0,
        currency: 'eur',
        slotsPurchased: rewardSlots,
        slotsUsed: 0,
        status: 'paid',
        expiresAt,
        metadata: {
          type: 'affiliate_reward',
          threshold: rewardThreshold,
          rewardDays,
          rewardSlots,
          cycle,
          expiresAt
        },
        createdAt: now,
        updatedAt: now
      });
      const patch = await this.client
        .from('affiliate_redemptions')
        .update({ reward_purchase_id: rewardPurchase.id, reward_granted: true })
        .eq('id', savedRedemption.id)
        .select()
        .single();
      if (!patch.error && patch.data) savedRedemption = fromAffiliateRedemptionRow(patch.data);
    }

    return {
      alreadyRedeemed: false,
      redemption: savedRedemption,
      profile: fromAffiliateProfileRow(update.data),
      rewardPurchase
    };
  }

  async activatePremiumSlot({ discordUserId, guildId, guildName, activatedBy }) {
    const existing = await this.#getActivePremiumActivationForGuild(guildId);
    if (existing) {
      return {
        activation: existing,
        alreadyActive: true,
        account: await this.getPremiumBillingAccount(discordUserId)
      };
    }

    const account = await this.getPremiumBillingAccount(discordUserId);
    const purchase = pickAvailablePremiumPurchase(account);
    if (!purchase) {
      throw new Error('No tienes slots premium disponibles. Compra un pack para activar mas servidores.');
    }

    const now = new Date().toISOString();
    const activation = normalizePremiumActivation({
      id: `activation-${guildId}-${Date.now()}`,
      purchaseId: purchase.id,
      discordUserId,
      guildId,
      guildName,
      activatedBy,
      active: true,
      expiresAt: purchase.expiresAt,
      createdAt: now,
      updatedAt: now
    });

    let { data, error } = await this.client
      .from('premium_slot_activations')
      .insert(toPremiumActivationRow(activation))
      .select()
      .single();
    if (error && /expires_at/i.test(String(error.message ?? ''))) {
      const compatibleRow = toPremiumActivationRow(activation);
      delete compatibleRow.expires_at;
      const retry = await this.client
        .from('premium_slot_activations')
        .insert(compatibleRow)
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (isMissingPremiumBillingTableError(error)) {
      return this.#activatePremiumSlotFallback({ discordUserId, guildId, guildName, activatedBy });
    }
    if (error && /duplicate key|unique/i.test(String(error.message ?? ''))) {
      const existingAfterConflict = await this.#getActivePremiumActivationForGuild(guildId);
      if (existingAfterConflict) {
        return {
          activation: existingAfterConflict,
          alreadyActive: true,
          account: await this.getPremiumBillingAccount(discordUserId)
        };
      }
    }
    if (error) throw error;

    const savedActivation = fromPremiumActivationRow(data);
    const usedByPurchase = account.activations.filter((item) => item.purchaseId === purchase.id).length + 1;
    await this.client
      .from('premium_purchases')
      .update({ slots_used: usedByPurchase, updated_at: now })
      .eq('id', purchase.id);

    await this.upsertGuildConfig(guildId, {
      guildName,
      plan: 'pro',
      voiceSupportEnabled: true,
      premium: normalizePremiumConfig({ ...DEFAULT_PREMIUM_MODULES, expiresAt: purchase.expiresAt }, { plan: 'pro', voiceSupportEnabled: true })
    });
    this.events?.publish('premium.activation.created', savedActivation);
    return {
      activation: savedActivation,
      alreadyActive: false,
      account: await this.getPremiumBillingAccount(discordUserId)
    };
  }

  #mergeGuildCompatibility(guild) {
    if (!guild) return guild;
    return {
      ...guild,
      ...(this.guildCompatibilityOverlay.get(guild.guildId) ?? {})
    };
  }

  #rememberGuildCompatibility(guildId, guild) {
    const overlay = pickDefined({
      plan: guild.plan,
      voiceSupportEnabled: guild.voiceSupportEnabled,
      voiceCategoryId: guild.voiceCategoryId,
      voiceCategoryName: guild.voiceCategoryName
    });
    if (!Object.keys(overlay).length) return;
    this.guildCompatibilityOverlay.set(guildId, {
      ...(this.guildCompatibilityOverlay.get(guildId) ?? {}),
      ...overlay
    });
  }

  #mergeTicketCompatibility(ticket) {
    if (!ticket) return ticket;
    return {
      ...ticket,
      ...(this.ticketCompatibilityOverlay.get(ticket.channelId) ?? {})
    };
  }

  async #rememberTicketCompatibility(channelId, ticket) {
    const overlay = pickTicketCompatibilityFields(ticket);
    if (!Object.keys(overlay).length) return;
    this.ticketCompatibilityOverlay.set(channelId, {
      ...(this.ticketCompatibilityOverlay.get(channelId) ?? {}),
      ...overlay
    });
    await this.#saveTicketCompatibilityFallback().catch((error) => {
      console.warn('Could not persist ticket compatibility fallback:', error?.message ?? error);
    });
  }

  async #findTicketCompatibilityByVoiceChannelId(voiceChannelId) {
    for (const [channelId, overlay] of this.ticketCompatibilityOverlay.entries()) {
      if (overlay.voiceChannelId === voiceChannelId) {
        return this.getTicket(channelId);
      }
    }
    return null;
  }

  async #loadTicketCompatibilityFallback() {
    const settings = await this.getGlobalSettings();
    const source = settings.ticketCompatibilityOverlay && typeof settings.ticketCompatibilityOverlay === 'object'
      ? settings.ticketCompatibilityOverlay.entries
      : {};
    if (!source || typeof source !== 'object') return;
    for (const [channelId, overlay] of Object.entries(source)) {
      if (!channelId || !overlay || typeof overlay !== 'object') continue;
      this.ticketCompatibilityOverlay.set(channelId, overlay);
    }
  }

  async #saveTicketCompatibilityFallback() {
    const entries = Object.fromEntries([...this.ticketCompatibilityOverlay.entries()].slice(-750));
    return this.updateGlobalSettings({
      ticketCompatibilityOverlay: {
        entries,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async #getActivePremiumActivationForGuild(guildId) {
    const { data, error } = await this.client
      .from('premium_slot_activations')
      .select('*')
      .eq('guild_id', String(guildId))
      .eq('active', true)
      .maybeSingle();
    if (isMissingPremiumBillingTableError(error)) {
      const store = await this.#getPremiumBillingFallbackStore();
      return Object.values(store.activations)
        .map(normalizePremiumActivation)
        .find((activation) => activation.guildId === String(guildId) && activation.active && !isExpiredDate(activation.expiresAt)) ?? null;
    }
    if (error) throw error;
    const activation = data ? fromPremiumActivationRow(data) : null;
    return activation && !isExpiredDate(activation.expiresAt) ? activation : null;
  }

  async #recordPremiumPurchaseFallback(purchase) {
    const normalized = normalizePremiumPurchase(purchase);
    const store = await this.#getPremiumBillingFallbackStore();
    store.purchases[normalized.id] = {
      ...(store.purchases[normalized.id] ?? {}),
      ...normalized,
      updatedAt: new Date().toISOString()
    };
    await this.#savePremiumBillingFallbackStore(store);
    const saved = normalizePremiumPurchase(store.purchases[normalized.id]);
    this.events?.publish('premium.purchase.recorded', saved);
    return saved;
  }

  async #listPremiumPurchasesFallback(discordUserId) {
    const store = await this.#getPremiumBillingFallbackStore();
    return Object.values(store.purchases)
      .map(normalizePremiumPurchase)
      .filter((purchase) => purchase.discordUserId === String(discordUserId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async #listPremiumActivationsFallback(discordUserId) {
    const store = await this.#getPremiumBillingFallbackStore();
    return Object.values(store.activations)
      .map(normalizePremiumActivation)
      .filter((activation) => activation.discordUserId === String(discordUserId) && activation.active)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async #activatePremiumSlotFallback({ discordUserId, guildId, guildName, activatedBy }) {
    const store = await this.#getPremiumBillingFallbackStore();
    const existing = Object.values(store.activations)
      .map(normalizePremiumActivation)
      .find((activation) => activation.guildId === String(guildId) && activation.active);
    if (existing) {
      return {
        activation: existing,
        alreadyActive: true,
        account: await this.getPremiumBillingAccount(discordUserId)
      };
    }

    const purchases = Object.values(store.purchases)
      .map(normalizePremiumPurchase)
      .filter((purchase) => purchase.discordUserId === String(discordUserId));
    const activations = Object.values(store.activations)
      .map(normalizePremiumActivation)
      .filter((activation) => activation.discordUserId === String(discordUserId) && activation.active);
    const purchase = pickAvailablePremiumPurchase({ purchases, activations });
    if (!purchase) {
      throw new Error('No tienes slots premium disponibles. Compra un pack para activar mas servidores.');
    }

    const now = new Date().toISOString();
    const activation = normalizePremiumActivation({
      id: `activation-${guildId}-${Date.now()}`,
      purchaseId: purchase.id,
      discordUserId,
      guildId,
      guildName,
      activatedBy,
      active: true,
      expiresAt: purchase.expiresAt,
      createdAt: now,
      updatedAt: now
    });
    store.activations[activation.id] = activation;
    store.purchases[purchase.id] = {
      ...(store.purchases[purchase.id] ?? purchase),
      slotsUsed: activations.filter((item) => item.purchaseId === purchase.id).length + 1,
      updatedAt: now
    };
    await this.#savePremiumBillingFallbackStore(store);

    await this.upsertGuildConfig(guildId, {
      guildName,
      plan: 'pro',
      voiceSupportEnabled: true,
      premium: normalizePremiumConfig({ ...DEFAULT_PREMIUM_MODULES, expiresAt: purchase.expiresAt }, { plan: 'pro', voiceSupportEnabled: true })
    });
    this.events?.publish('premium.activation.created', activation);
    return {
      activation,
      alreadyActive: false,
      account: await this.getPremiumBillingAccount(discordUserId)
    };
  }

  async #getPremiumBillingFallbackStore() {
    const settings = await this.getGlobalSettings();
    const source = settings.premiumBilling && typeof settings.premiumBilling === 'object'
      ? settings.premiumBilling
      : {};
    return {
      purchases: source.purchases && typeof source.purchases === 'object' ? source.purchases : {},
      activations: source.activations && typeof source.activations === 'object' ? source.activations : {}
    };
  }

  async #savePremiumBillingFallbackStore(store) {
    return this.updateGlobalSettings({
      premiumBilling: {
        purchases: store.purchases ?? {},
        activations: store.activations ?? {},
        updatedAt: new Date().toISOString()
      }
    });
  }

  async #getAffiliateProfileByUserId(discordUserId) {
    const { data, error } = await this.client
      .from('affiliate_profiles')
      .select('*')
      .eq('discord_user_id', String(discordUserId))
      .maybeSingle();
    if (isMissingAffiliateTableError(error)) {
      const store = await this.#getAffiliateFallbackStore();
      return Object.values(store.profiles)
        .map(normalizeAffiliateProfile)
        .find((profile) => profile.discordUserId === String(discordUserId)) ?? null;
    }
    if (error) throw error;
    return data ? fromAffiliateProfileRow(data) : null;
  }

  async #countAffiliateRedemptionsForOwner(discordUserId) {
    const ownerId = String(discordUserId);
    const { count, error } = await this.client
      .from('affiliate_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('owner_discord_user_id', ownerId);
    if (isMissingAffiliateTableError(error)) {
      const store = await this.#getAffiliateFallbackStore();
      return Object.values(store.redemptions)
        .map(normalizeAffiliateRedemption)
        .filter((redemption) => redemption.ownerDiscordUserId === ownerId).length;
    }
    if (error) throw error;
    return Number(count ?? 0);
  }

  async #getOrCreateAffiliateProfileFallback({ discordUserId, username, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const store = await this.#getAffiliateFallbackStore();
    const userId = String(discordUserId);
    const usedCodes = new Set(Object.values(store.profiles)
      .map((profile) => normalizeAffiliateProfile(profile))
      .filter((profile) => profile.discordUserId !== userId)
      .map((profile) => normalizeAffiliateCode(profile.code)));
    const existing = Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((profile) => profile.discordUserId === userId);
    if (existing) {
      const nextCode = buildAffiliateProfileCode({ username, userId, usedCodes, currentCode: existing.code });
      const updated = normalizeAffiliateProfile({
        ...existing,
        username: username ?? existing.username,
        code: nextCode,
        rewardThreshold,
        rewardSlots,
        rewardDays,
        updatedAt: new Date().toISOString()
      });
      store.profiles[updated.discordUserId] = updated;
      await this.#saveAffiliateFallbackStore(store);
      return updated;
    }

    const code = buildAffiliateProfileCode({ username, userId, usedCodes });
    const profile = normalizeAffiliateProfile({
      discordUserId: userId,
      username,
      code,
      rewardThreshold,
      rewardSlots,
      rewardDays
    });
    store.profiles[profile.discordUserId] = profile;
    await this.#saveAffiliateFallbackStore(store);
    return profile;
  }

  async #getAffiliateProfileByCodeFallback(code) {
    const store = await this.#getAffiliateFallbackStore();
    const normalizedCode = normalizeAffiliateCode(code);
    return Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((profile) => profile.code === normalizedCode || normalizeAffiliateCode(profile.username) === normalizedCode) ?? null;
  }

  async #getAffiliateRedemptionByGuildFallback(guildId) {
    const store = await this.#getAffiliateFallbackStore();
    return Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .find((redemption) => redemption.guildId === String(guildId)) ?? null;
  }

  async #recordAffiliateRedemptionFallback({ code, guildId, guildName, redeemedByUserId, redeemedByUsername, rewardThreshold = 7, rewardSlots = 1, rewardDays = 30 }) {
    const store = await this.#getAffiliateFallbackStore();
    const existing = Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .find((redemption) => redemption.guildId === String(guildId));
    if (existing) {
      return {
        alreadyRedeemed: true,
        redemption: existing,
        profile: Object.values(store.profiles).map(normalizeAffiliateProfile).find((profile) => profile.discordUserId === existing.ownerDiscordUserId) ?? null,
        rewardPurchase: null
      };
    }

    const profile = Object.values(store.profiles)
      .map(normalizeAffiliateProfile)
      .find((item) => item.code === normalizeAffiliateCode(code) || normalizeAffiliateCode(item.username) === normalizeAffiliateCode(code));
    if (!profile) throw new Error('Usuario de afiliado no encontrado.');
    if (profile.discordUserId === String(redeemedByUserId)) {
      throw new Error('No puedes registrar tu propio usuario como afiliado.');
    }

    const now = new Date().toISOString();
    const existingOwnerRedemptions = Object.values(store.redemptions)
      .map(normalizeAffiliateRedemption)
      .filter((redemption) => redemption.ownerDiscordUserId === profile.discordUserId).length;
    const nextTotal = existingOwnerRedemptions + 1;
    const rewardGranted = nextTotal % rewardThreshold === 0;
    const nextProfile = normalizeAffiliateProfile({
      ...profile,
      rewardThreshold,
      rewardSlots,
      rewardDays,
      totalRedemptions: nextTotal,
      rewardsEarned: Math.floor(nextTotal / Math.max(1, rewardThreshold)),
      updatedAt: now
    });
    const redemption = normalizeAffiliateRedemption({
      id: `affiliate-${guildId}-${Date.now()}`,
      code: profile.code,
      ownerDiscordUserId: profile.discordUserId,
      guildId,
      guildName,
      redeemedByUserId,
      redeemedByUsername,
      rewardGranted,
      createdAt: now
    });
    store.profiles[nextProfile.discordUserId] = nextProfile;
    store.redemptions[redemption.id] = redemption;
    await this.#saveAffiliateFallbackStore(store);

    let rewardPurchase = null;
    if (rewardGranted) {
      const cycle = Math.floor(nextTotal / rewardThreshold);
      const expiresAt = addDays(now, rewardDays);
      rewardPurchase = await this.recordPremiumPurchase({
        id: `affiliate-reward-${profile.discordUserId}-${cycle}-${Date.now()}`,
        discordUserId: profile.discordUserId,
        buyerUsername: profile.username,
        provider: 'affiliate',
        providerSessionId: `affiliate-${profile.discordUserId}-${cycle}`,
        amountTotal: 0,
        currency: 'eur',
        slotsPurchased: rewardSlots,
        slotsUsed: 0,
        status: 'paid',
        expiresAt,
        metadata: {
          type: 'affiliate_reward',
          threshold: rewardThreshold,
          rewardDays,
          rewardSlots,
          cycle,
          expiresAt
        },
        createdAt: now,
        updatedAt: now
      });
    }
    return { alreadyRedeemed: false, redemption, profile: nextProfile, rewardPurchase };
  }

  async #getAffiliateFallbackStore() {
    const settings = await this.getGlobalSettings();
    return normalizeAffiliateStore(settings.affiliates);
  }

  async #saveAffiliateFallbackStore(store) {
    return this.updateGlobalSettings({
      affiliates: {
        profiles: store.profiles ?? {},
        redemptions: store.redemptions ?? {},
        updatedAt: new Date().toISOString()
      }
    });
  }
}

export function createStorage(config, events) {
  const databaseUrl = config.DATABASE_URL;
  if (databaseUrl) {
    console.log('NexaDesk storage backend: PostgreSQL');
    return new PostgresStorage({
      connectionString: databaseUrl,
      poolMax: config.DATABASE_POOL_MAX,
      connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT_MS,
      events
    });
  }

  console.warn('NexaDesk storage backend: local JSON. Set DATABASE_URL to persist data in PostgreSQL.');
  return new JsonStorage(config.DATA_DIR, events);
}

function toGuildRow(guild) {
  const panelStore = toGuildPanelStore(guild);
  return {
    guild_id: guild.guildId,
    guild_name: guild.guildName,
    ticket_category_id: guild.ticketCategoryId,
    ticket_category_name: guild.ticketCategoryName,
    staff_role_id: guild.staffRoleId,
    server_prompt: guild.serverPrompt,
    server_info: guild.serverInfo,
    plan: guild.plan ?? 'free',
    voice_support_enabled: guild.voiceSupportEnabled ?? false,
    voice_category_id: guild.voiceCategoryId,
    voice_category_name: guild.voiceCategoryName,
    panels: panelStore,
    updated_at: guild.updatedAt
  };
}

function fromGuildRow(row) {
  const panelStore = fromGuildPanelStore(row.panels);
  return {
    guildId: row.guild_id,
    guildName: row.guild_name,
    ticketCategoryId: row.ticket_category_id,
    ticketCategoryName: row.ticket_category_name,
    staffRoleId: row.staff_role_id,
    serverPrompt: row.server_prompt,
    serverInfo: row.server_info,
    plan: row.plan ?? 'free',
    voiceSupportEnabled: row.voice_support_enabled ?? false,
    voiceCategoryId: row.voice_category_id,
    voiceCategoryName: row.voice_category_name,
    allianceChannelId: panelStore.alliance.channelId,
    allianceChannelName: panelStore.alliance.channelName,
    allianceTemplate: panelStore.alliance.template,
    allianceDetection: panelStore.allianceDetection,
    addedByUserId: panelStore.install.addedByUserId,
    addedByUsername: panelStore.install.addedByUsername,
    addedAt: panelStore.install.addedAt,
    addedByDetectedAt: panelStore.install.detectedAt,
    growth: panelStore.growth,
    welcome: panelStore.welcome,
    premium: normalizePremiumConfig(panelStore.premium, {
      plan: row.plan ?? 'free',
      voiceSupportEnabled: row.voice_support_enabled ?? false
    }),
    autoConfig: panelStore.autoConfig,
    discovery: panelStore.discovery,
    announcementChannelId: panelStore.discovery.announcementChannelId,
    announcementChannelName: panelStore.discovery.announcementChannelName,
    watchedTicketCategories: normalizeWatchedTicketCategories(panelStore.watchedTicketCategories, {
      ticketCategoryId: row.ticket_category_id,
      ticketCategoryName: row.ticket_category_name
    }),
    ticketClosePolicy: panelStore.ticketClosePolicy,
    scheduledAnnouncements: panelStore.scheduledAnnouncements,
    panels: panelStore.panels,
    components: panelStore.components,
    security: panelStore.security,
    updatedAt: row.updated_at
  };
}

function toGuildPanelStore(guild) {
  return {
    panels: guild.panels ?? [],
    components: guild.components ?? [],
    security: normalizeSecurityConfig(guild.security),
    premium: normalizePremiumConfig(guild.premium, guild),
    autoConfig: normalizeAutoConfig(guild.autoConfig),
    growth: normalizeGrowthConfig(guild.growth),
    welcome: normalizeWelcomeConfig(guild.welcome),
    alliance: normalizeAllianceConfig(guild),
    allianceDetection: normalizeAllianceDetection(guild.allianceDetection),
    install: normalizeInstallMetadata(guild),
    discovery: normalizeDiscoveryConfig(guild.discovery ?? guild),
    watchedTicketCategories: normalizeWatchedTicketCategories(guild.watchedTicketCategories, guild),
    ticketClosePolicy: normalizeTicketClosePolicy(guild.ticketClosePolicy),
    scheduledAnnouncements: normalizeScheduledAnnouncements(guild.scheduledAnnouncements)
  };
}

function fromGuildPanelStore(value) {
  if (Array.isArray(value)) {
    return {
      panels: value,
      components: [],
      security: normalizeSecurityConfig(),
      premium: normalizePremiumConfig(),
      autoConfig: normalizeAutoConfig(),
      growth: normalizeGrowthConfig(),
      welcome: normalizeWelcomeConfig(),
      alliance: normalizeAllianceConfig(),
      allianceDetection: normalizeAllianceDetection(),
      install: normalizeInstallMetadata(),
      discovery: normalizeDiscoveryConfig(),
      watchedTicketCategories: normalizeWatchedTicketCategories(),
      ticketClosePolicy: normalizeTicketClosePolicy(),
      scheduledAnnouncements: normalizeScheduledAnnouncements()
    };
  }

  if (value && typeof value === 'object') {
    return {
      panels: Array.isArray(value.panels) ? value.panels : [],
      components: Array.isArray(value.components) ? value.components : [],
      security: normalizeSecurityConfig(value.security),
      premium: normalizePremiumConfig(value.premium),
      autoConfig: normalizeAutoConfig(value.autoConfig),
      growth: normalizeGrowthConfig(value.growth),
      welcome: normalizeWelcomeConfig(value.welcome),
      alliance: normalizeAllianceConfig(value.alliance),
      allianceDetection: normalizeAllianceDetection(value.allianceDetection),
      install: normalizeInstallMetadata(value.install),
      discovery: normalizeDiscoveryConfig(value.discovery),
      watchedTicketCategories: normalizeWatchedTicketCategories(value.watchedTicketCategories),
      ticketClosePolicy: normalizeTicketClosePolicy(value.ticketClosePolicy),
      scheduledAnnouncements: normalizeScheduledAnnouncements(value.scheduledAnnouncements)
    };
  }

  return {
    panels: [],
    components: [],
    security: normalizeSecurityConfig(),
    premium: normalizePremiumConfig(),
    autoConfig: normalizeAutoConfig(),
    growth: normalizeGrowthConfig(),
    welcome: normalizeWelcomeConfig(),
    alliance: normalizeAllianceConfig(),
    allianceDetection: normalizeAllianceDetection(),
    install: normalizeInstallMetadata(),
    discovery: normalizeDiscoveryConfig(),
    watchedTicketCategories: normalizeWatchedTicketCategories(),
    ticketClosePolicy: normalizeTicketClosePolicy(),
    scheduledAnnouncements: normalizeScheduledAnnouncements()
  };
}

function normalizeWatchedTicketCategories(value = [], guild = {}) {
  const candidates = [];
  if (guild?.ticketCategoryId) {
    candidates.push({
      id: guild.ticketCategoryId,
      name: guild.ticketCategoryName,
      primary: true
    });
  }
  const raw = Array.isArray(value)
    ? value
    : value?.id
      ? [value]
      : [];
  for (const item of raw) {
    const id = String(item?.id ?? item?.categoryId ?? item ?? '').trim();
    if (!id || candidates.some((candidate) => candidate.id === id)) continue;
    candidates.push({
      id,
      name: item?.name ? String(item.name).slice(0, 120) : undefined,
      primary: Boolean(item?.primary)
    });
  }
  return candidates
    .filter((item) => item.id)
    .slice(0, 2)
    .map((item, index) => ({
      id: item.id,
      name: item.name ?? null,
      primary: index === 0 || Boolean(item.primary)
    }));
}

function normalizeTicketClosePolicy(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'staff_only' || source.usersCanClose === false
    ? 'staff_only'
    : 'opener_and_staff';
  return {
    mode,
    usersCanClose: mode !== 'staff_only',
    updatedAt: source.updatedAt ? String(source.updatedAt) : null
  };
}

function normalizeScheduledAnnouncements(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).map((item) => {
    const intervalHours = Math.max(1, Math.min(24 * 30, Number(item?.intervalHours ?? 24) || 24));
    const scheduleType = item?.scheduleType === 'once' ? 'once' : 'interval';
    const now = new Date().toISOString();
    return {
      id: String(item?.id ?? `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 80),
      enabled: item?.enabled !== false,
      name: String(item?.name ?? 'Anuncio programado').slice(0, 90),
      channelId: item?.channelId ? String(item.channelId) : null,
      channelName: item?.channelName ? String(item.channelName).slice(0, 120) : null,
      content: item?.content ? String(item.content).slice(0, 1800) : '',
      scheduleType,
      intervalHours,
      nextRunAt: item?.nextRunAt ? String(item.nextRunAt) : now,
      lastRunAt: item?.lastRunAt ? String(item.lastRunAt) : null,
      runCount: Math.max(0, Number(item?.runCount ?? 0) || 0),
      embed: {
        title: String(item?.embed?.title ?? item?.title ?? 'Anuncio').slice(0, 256),
        description: String(item?.embed?.description ?? item?.description ?? '').slice(0, 3800),
        color: String(item?.embed?.color ?? item?.color ?? '#ffffff').slice(0, 16),
        imageUrl: item?.embed?.imageUrl ? String(item.embed.imageUrl).slice(0, 500) : null,
        footerText: item?.embed?.footerText ? String(item.embed.footerText).slice(0, 200) : null
      },
      createdAt: item?.createdAt ? String(item.createdAt) : now,
      updatedAt: item?.updatedAt ? String(item.updatedAt) : now
    };
  }).filter((item) => item.channelId && (item.embed.title || item.embed.description));
}

function normalizeAutoConfig(value = {}) {
  const source = value?.autoConfig && typeof value.autoConfig === 'object' ? value.autoConfig : value;
  const pending = Array.isArray(source?.pending)
    ? source.pending.map((item) => ({
      type: item?.type ? String(item.type).slice(0, 40) : undefined,
      label: item?.label ? String(item.label).slice(0, 120) : undefined,
      reason: item?.reason ? String(item.reason).slice(0, 500) : undefined,
      askedAt: item?.askedAt ? String(item.askedAt) : undefined,
      candidates: Array.isArray(item?.candidates)
        ? item.candidates.slice(0, 5).map((candidate) => ({
          id: candidate?.id ? String(candidate.id) : undefined,
          name: candidate?.name ? String(candidate.name).slice(0, 100) : undefined,
          confidence: Number.isFinite(Number(candidate?.confidence)) ? Math.round(Number(candidate.confidence)) : undefined,
          reason: candidate?.reason ? String(candidate.reason).slice(0, 300) : undefined
        })).filter((candidate) => candidate.id && candidate.name)
        : []
    })).filter((item) => item.type && item.candidates.length)
    : [];

  return pickDefined({
    status: source?.status ? String(source.status).slice(0, 40) : undefined,
    scannedAt: source?.scannedAt ? String(source.scannedAt) : undefined,
    askedAt: source?.askedAt ? String(source.askedAt) : undefined,
    resolvedAt: source?.resolvedAt ? String(source.resolvedAt) : undefined,
    resolvedByUserId: source?.resolvedByUserId ? String(source.resolvedByUserId) : undefined,
    resolvedByUsername: source?.resolvedByUsername ? String(source.resolvedByUsername).slice(0, 120) : undefined,
    summary: source?.summary ? String(source.summary).slice(0, 700) : undefined,
    pending
  });
}

function normalizeAllianceConfig(value = {}) {
  const source = value?.alliance && typeof value.alliance === 'object' ? value.alliance : value;
  return pickDefined({
    channelId: source?.channelId ?? source?.allianceChannelId,
    channelName: source?.channelName ?? source?.allianceChannelName,
    template: source?.template ?? source?.allianceTemplate
  });
}

function normalizeAllianceDetection(value = {}) {
  const source = value?.allianceDetection && typeof value.allianceDetection === 'object' ? value.allianceDetection : value;
  return pickDefined({
    status: source?.status ? String(source.status).slice(0, 40) : undefined,
    channelId: source?.channelId ? String(source.channelId) : undefined,
    channelName: source?.channelName ? String(source.channelName).slice(0, 100) : undefined,
    confidence: Number.isFinite(Number(source?.confidence)) ? Math.round(Number(source.confidence)) : undefined,
    reason: source?.reason ? String(source.reason).slice(0, 500) : undefined,
    askedAt: source?.askedAt ? String(source.askedAt) : undefined,
    scannedAt: source?.scannedAt ? String(source.scannedAt) : undefined
  });
}

function normalizeInstallMetadata(value = {}) {
  const source = value?.install && typeof value.install === 'object' ? value.install : value;
  const detectedAt = source?.detectedAt ?? source?.addedByDetectedAt;
  return pickDefined({
    addedByUserId: source?.addedByUserId ? String(source.addedByUserId) : undefined,
    addedByUsername: source?.addedByUsername ? String(source.addedByUsername).slice(0, 120) : undefined,
    addedAt: source?.addedAt ? String(source.addedAt) : undefined,
    detectedAt: detectedAt ? String(detectedAt) : undefined
  });
}

function toTicketRow(ticket) {
  const row = {
    channel_id: ticket.channelId,
    guild_id: ticket.guildId,
    guild_name: ticket.guildName,
    channel_name: ticket.channelName,
    category_id: ticket.categoryId,
    opened_by: ticket.openedBy,
    voice_channel_id: ticket.voiceChannelId,
    voice_channel_name: ticket.voiceChannelName,
    voice_created_at: ticket.voiceCreatedAt,
    status: ticket.status,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt
  };
  if ('aiDisabled' in ticket) row.ai_disabled = ticket.aiDisabled ?? false;
  if ('aiDisabledBy' in ticket) row.ai_disabled_by = ticket.aiDisabledBy;
  if ('aiDisabledAt' in ticket) row.ai_disabled_at = ticket.aiDisabledAt;
  if ('examState' in ticket) row.exam_state = ticket.examState ?? null;
  return row;
}

function toCompatibleTicketRow(ticket) {
  const row = toTicketRow(ticket);
  delete row.ai_disabled;
  delete row.ai_disabled_by;
  delete row.ai_disabled_at;
  delete row.exam_state;
  delete row.voice_channel_id;
  delete row.voice_channel_name;
  delete row.voice_created_at;
  return row;
}

function isTicketCompatibilityError(error) {
  return Boolean(error && /ai_disabled|exam_state|voice_channel_id|voice_channel_name|voice_created_at/i.test(String(error.message ?? '')));
}

function pickTicketCompatibilityFields(ticket) {
  return pickDefined({
    aiDisabled: ticket.aiDisabled,
    aiDisabledBy: ticket.aiDisabledBy,
    aiDisabledAt: ticket.aiDisabledAt,
    examState: ticket.examState,
    voiceChannelId: ticket.voiceChannelId,
    voiceChannelName: ticket.voiceChannelName,
    voiceCreatedAt: ticket.voiceCreatedAt
  });
}

function pickDefined(value) {
  return Object.entries(value).reduce((result, [key, entry]) => {
    if (entry !== undefined) result[key] = entry;
    return result;
  }, {});
}

function fromTicketRow(row) {
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelName: row.channel_name,
    categoryId: row.category_id,
    openedBy: row.opened_by,
    voiceChannelId: row.voice_channel_id,
    voiceChannelName: row.voice_channel_name,
    voiceCreatedAt: row.voice_created_at,
    status: row.status,
    aiDisabled: row.ai_disabled ?? row.status === 'ai_disabled',
    aiDisabledBy: row.ai_disabled_by,
    aiDisabledAt: row.ai_disabled_at,
    examState: row.exam_state ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTranscriptRow(message) {
  return {
    channel_id: message.channelId,
    guild_id: message.guildId,
    message_id: message.messageId,
    author_id: message.authorId,
    author_name: message.authorName,
    author_bot: message.authorBot ?? false,
    role: message.role,
    content: message.content,
    created_at: message.createdAt ?? new Date().toISOString()
  };
}

function fromTranscriptRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    messageId: row.message_id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorBot: row.author_bot,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

function toFeedbackRow(feedback) {
  const normalized = normalizeTicketFeedback(feedback);
  return {
    id: normalized.id,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    channel_id: normalized.channelId,
    channel_name: normalized.channelName,
    user_id: normalized.userId,
    username: normalized.username,
    rating: normalized.rating,
    comment: normalized.comment,
    source: normalized.source,
    public_review_posted: normalized.publicReviewPosted,
    created_at: normalized.createdAt
  };
}

function fromFeedbackRow(row) {
  return normalizeTicketFeedback({
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    userId: row.user_id,
    username: row.username,
    rating: row.rating,
    comment: row.comment,
    source: row.source,
    publicReviewPosted: row.public_review_posted,
    createdAt: row.created_at
  });
}

function toAiQualitySignalRow(signal) {
  const normalized = normalizeAiQualitySignal(signal);
  return {
    id: normalized.id,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    channel_id: normalized.channelId,
    channel_name: normalized.channelName,
    message_id: normalized.messageId,
    user_id: normalized.userId,
    username: normalized.username,
    category: normalized.category,
    severity: normalized.severity,
    sentiment: normalized.sentiment,
    confidence: normalized.confidence,
    reason: normalized.reason,
    user_message: normalized.userMessage,
    previous_ai_message: normalized.previousAiMessage,
    detected_by: normalized.detectedBy,
    resolved: normalized.resolved,
    created_at: normalized.createdAt
  };
}

function fromAiQualitySignalRow(row) {
  return normalizeAiQualitySignal({
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    messageId: row.message_id,
    userId: row.user_id,
    username: row.username,
    category: row.category,
    severity: row.severity,
    sentiment: row.sentiment,
    confidence: row.confidence,
    reason: row.reason,
    userMessage: row.user_message,
    previousAiMessage: row.previous_ai_message,
    detectedBy: row.detected_by,
    resolved: row.resolved,
    createdAt: row.created_at
  });
}

function normalizeGuildLog(entry = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const metadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
  return {
    id: source.id ? String(source.id) : `log-${Date.now()}-${crypto.randomUUID()}`,
    guildId: String(source.guildId ?? source.guild_id ?? ''),
    guildName: source.guildName ? String(source.guildName).slice(0, 120) : null,
    type: normalizeLogType(source.type),
    severity: normalizeLogSeverity(source.severity),
    title: String(source.title ?? 'Evento NexaDesk').slice(0, 160),
    message: String(source.message ?? source.description ?? '').slice(0, 3000),
    actorId: source.actorId ? String(source.actorId) : null,
    actorName: source.actorName ? String(source.actorName).slice(0, 120) : null,
    targetId: source.targetId ? String(source.targetId) : null,
    targetName: source.targetName ? String(source.targetName).slice(0, 160) : null,
    channelId: source.channelId ? String(source.channelId) : null,
    channelName: source.channelName ? String(source.channelName).slice(0, 120) : null,
    metadata,
    createdAt: source.createdAt ?? source.created_at ?? new Date().toISOString()
  };
}

function toGuildLogRow(entry) {
  const normalized = normalizeGuildLog(entry);
  return {
    id: normalized.id,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    type: normalized.type,
    severity: normalized.severity,
    title: normalized.title,
    message: normalized.message,
    actor_id: normalized.actorId,
    actor_name: normalized.actorName,
    target_id: normalized.targetId,
    target_name: normalized.targetName,
    channel_id: normalized.channelId,
    channel_name: normalized.channelName,
    metadata: normalized.metadata,
    created_at: normalized.createdAt
  };
}

function fromGuildLogRow(row) {
  return normalizeGuildLog({
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    type: row.type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    actorId: row.actor_id,
    actorName: row.actor_name,
    targetId: row.target_id,
    targetName: row.target_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    metadata: row.metadata,
    createdAt: row.created_at
  });
}

function normalizeLogType(value) {
  const normalized = String(value ?? '').toLowerCase().trim();
  if (['security', 'ticket', 'config', 'panel', 'component', 'premium', 'growth', 'owner_message', 'system'].includes(normalized)) return normalized;
  return 'system';
}

function normalizeLogSeverity(value) {
  const normalized = String(value ?? '').toLowerCase().trim();
  if (['debug', 'info', 'success', 'warning', 'critical'].includes(normalized)) return normalized;
  if (['warn', 'medium'].includes(normalized)) return 'warning';
  if (['error', 'danger', 'high'].includes(normalized)) return 'critical';
  return 'info';
}

function toBlacklistRow(entry) {
  const normalized = normalizeBlacklistEntry(entry);
  return {
    user_id: normalized.userId,
    ban_code: normalized.banCode,
    reason: normalized.reason,
    duration: normalized.duration,
    expires_at: normalized.expiresAt,
    active: normalized.active,
    created_by: normalized.createdBy,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt ?? new Date().toISOString()
  };
}

function fromBlacklistRow(row) {
  return normalizeBlacklistEntry({
    userId: row.user_id,
    banCode: row.ban_code,
    reason: row.reason,
    duration: row.duration,
    expiresAt: row.expires_at,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toBlacklistEvidenceRow(evidence) {
  const normalized = normalizeBlacklistEvidence(evidence);
  return {
    user_id: normalized.userId,
    ban_code: normalized.banCode,
    attachment_url: normalized.attachmentUrl,
    proxy_url: normalized.proxyUrl,
    file_name: normalized.fileName,
    content_type: normalized.contentType,
    description: normalized.description,
    created_by: normalized.createdBy,
    created_at: normalized.createdAt
  };
}

function fromBlacklistEvidenceRow(row) {
  return normalizeBlacklistEvidence({
    id: row.id,
    userId: row.user_id,
    banCode: row.ban_code,
    attachmentUrl: row.attachment_url,
    proxyUrl: row.proxy_url,
    fileName: row.file_name,
    contentType: row.content_type,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at
  });
}

function toPremiumPurchaseRow(purchase) {
  const normalized = normalizePremiumPurchase(purchase);
  return {
    id: normalized.id,
    discord_user_id: normalized.discordUserId,
    buyer_username: normalized.buyerUsername,
    provider: normalized.provider,
    provider_session_id: normalized.providerSessionId,
    provider_payment_intent_id: normalized.providerPaymentIntentId,
    amount_total: normalized.amountTotal,
    currency: normalized.currency,
    slots_purchased: normalized.slotsPurchased,
    slots_used: normalized.slotsUsed,
    status: normalized.status,
    metadata: normalized.metadata,
    expires_at: normalized.expiresAt,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt
  };
}

function fromPremiumPurchaseRow(row) {
  return normalizePremiumPurchase({
    id: row.id,
    discordUserId: row.discord_user_id,
    buyerUsername: row.buyer_username,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    providerPaymentIntentId: row.provider_payment_intent_id,
    amountTotal: row.amount_total,
    currency: row.currency,
    slotsPurchased: row.slots_purchased,
    slotsUsed: row.slots_used,
    status: row.status,
    metadata: row.metadata,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toPremiumActivationRow(activation) {
  const normalized = normalizePremiumActivation(activation);
  return {
    id: normalized.id,
    purchase_id: normalized.purchaseId,
    discord_user_id: normalized.discordUserId,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    activated_by: normalized.activatedBy,
    active: normalized.active,
    expires_at: normalized.expiresAt,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt
  };
}

function fromPremiumActivationRow(row) {
  return normalizePremiumActivation({
    id: row.id,
    purchaseId: row.purchase_id,
    discordUserId: row.discord_user_id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    activatedBy: row.activated_by,
    active: row.active,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toAffiliateProfileRow(profile) {
  const normalized = normalizeAffiliateProfile(profile);
  return {
    discord_user_id: normalized.discordUserId,
    username: normalized.username,
    code: normalized.code,
    reward_threshold: normalized.rewardThreshold,
    reward_slots: normalized.rewardSlots,
    reward_days: normalized.rewardDays,
    total_redemptions: normalized.totalRedemptions,
    rewards_earned: normalized.rewardsEarned,
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt
  };
}

function fromAffiliateProfileRow(row) {
  return normalizeAffiliateProfile({
    discordUserId: row.discord_user_id,
    username: row.username,
    code: row.code,
    rewardThreshold: row.reward_threshold,
    rewardSlots: row.reward_slots,
    rewardDays: row.reward_days,
    totalRedemptions: row.total_redemptions,
    rewardsEarned: row.rewards_earned,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function toAffiliateRedemptionRow(redemption) {
  const normalized = normalizeAffiliateRedemption(redemption);
  return {
    id: normalized.id,
    code: normalized.code,
    owner_discord_user_id: normalized.ownerDiscordUserId,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    redeemed_by_user_id: normalized.redeemedByUserId,
    redeemed_by_username: normalized.redeemedByUsername,
    reward_granted: normalized.rewardGranted,
    reward_purchase_id: normalized.rewardPurchaseId,
    created_at: normalized.createdAt
  };
}

function fromAffiliateRedemptionRow(row) {
  return normalizeAffiliateRedemption({
    id: row.id,
    code: row.code,
    ownerDiscordUserId: row.owner_discord_user_id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedByUsername: row.redeemed_by_username,
    rewardGranted: row.reward_granted,
    rewardPurchaseId: row.reward_purchase_id,
    createdAt: row.created_at
  });
}

function buildAffiliateProfileCode({ username, userId, usedCodes = new Set(), currentCode = '' }) {
  const current = normalizeAffiliateCode(currentCode);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateAffiliateCode(username ?? userId, userId, attempt);
    if (!candidate) continue;
    if (!usedCodes.has(candidate) || candidate === current) return candidate;
  }
  return generateAffiliateCode(userId, userId, 5);
}

function toGuildBackupRow(snapshot) {
  const normalized = normalizeGuildBackupSnapshot(snapshot);
  return {
    id: normalized.id,
    guild_id: normalized.guildId,
    guild_name: normalized.guildName,
    captured_at: normalized.capturedAt,
    source: normalized.source,
    summary: normalized.summary,
    snapshot: normalized.snapshot,
    created_at: normalized.createdAt
  };
}

function fromGuildBackupRow(row) {
  return normalizeGuildBackupSnapshot({
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    capturedAt: row.captured_at,
    source: row.source,
    summary: row.summary,
    snapshot: row.snapshot,
    createdAt: row.created_at
  });
}

function toGuildBackupRestoreRow(entry) {
  const normalized = normalizeGuildBackupRestoreEntry(entry);
  return {
    id: normalized.id,
    backup_id: normalized.backupId,
    source_guild_id: normalized.sourceGuildId,
    source_guild_name: normalized.sourceGuildName,
    target_guild_id: normalized.targetGuildId,
    target_guild_name: normalized.targetGuildName,
    requested_by: normalized.requestedBy,
    status: normalized.status,
    summary: normalized.summary,
    created_at: normalized.createdAt,
    completed_at: normalized.completedAt
  };
}

function fromGuildBackupRestoreRow(row) {
  return normalizeGuildBackupRestoreEntry({
    id: row.id,
    backupId: row.backup_id,
    sourceGuildId: row.source_guild_id,
    sourceGuildName: row.source_guild_name,
    targetGuildId: row.target_guild_id,
    targetGuildName: row.target_guild_name,
    requestedBy: row.requested_by,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    completedAt: row.completed_at
  });
}

function normalizeGuildBackupRestoreEntry(entry = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const createdAt = value.createdAt ?? value.created_at ?? value.startedAt ?? new Date().toISOString();
  const requestedBy = value.requestedBy ?? value.requested_by;
  return {
    id: String(value.id ?? `restore-${value.targetGuildId ?? value.target_guild_id ?? 'guild'}-${Date.now()}-${crypto.randomUUID()}`),
    backupId: String(value.backupId ?? value.backup_id ?? ''),
    sourceGuildId: String(value.sourceGuildId ?? value.source_guild_id ?? ''),
    sourceGuildName: String(value.sourceGuildName ?? value.source_guild_name ?? 'Servidor origen').slice(0, 160),
    targetGuildId: String(value.targetGuildId ?? value.target_guild_id ?? ''),
    targetGuildName: String(value.targetGuildName ?? value.target_guild_name ?? 'Servidor destino').slice(0, 160),
    requestedBy: requestedBy ? String(requestedBy) : null,
    status: ['completed', 'partial', 'failed'].includes(value.status) ? value.status : 'completed',
    summary: value.summary && typeof value.summary === 'object' ? value.summary : {},
    createdAt,
    completedAt: value.completedAt ?? value.completed_at ?? createdAt
  };
}

function normalizeGuildBackupsFallbackStore(source = {}) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    snapshots: value.snapshots && typeof value.snapshots === 'object' ? value.snapshots : {},
    restores: value.restores && typeof value.restores === 'object' ? value.restores : {}
  };
}

function normalizeAffiliateStore(source = {}) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    profiles: value.profiles && typeof value.profiles === 'object' ? value.profiles : {},
    redemptions: value.redemptions && typeof value.redemptions === 'object' ? value.redemptions : {}
  };
}

function isMissingBlacklistTableError(error) {
  return Boolean(error && /global_blacklist|global_blacklist_evidence|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingFeedbackTableError(error) {
  return Boolean(error && /ticket_feedback|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingAiQualitySignalTableError(error) {
  return Boolean(error && /ai_quality_signals|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingGuildLogsTableError(error) {
  return Boolean(error && /guild_logs|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingGuildBackupsTableError(error) {
  return Boolean(error && /guild_backups|guild_backup_restores|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingPremiumBillingTableError(error) {
  return Boolean(error && /premium_purchases|premium_slot_activations|expires_at|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isMissingAffiliateTableError(error) {
  return Boolean(error && /affiliate_profiles|affiliate_redemptions|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function isExpiredDate(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function scoreTranscriptMessageForTerms(message, terms = []) {
  const content = normalizeTranscriptSearchText([
    message.authorName,
    message.role,
    message.content
  ].join(' '));
  if (!content) return 0;

  let score = 0;
  for (const term of terms) {
    const normalizedTerm = normalizeTranscriptSearchText(term);
    if (!normalizedTerm || normalizedTerm.length < 3) continue;
    if (content.includes(normalizedTerm)) score += PRIORITY_TRANSCRIPT_TERMS.has(normalizedTerm) ? 5 : 2;
  }

  if (message.authorBot) score -= 2;
  if (/\b(resultado|resultados|postulacion|formulario|nota|staff|alianza|normas|anuncios|dashboard|premium)\b/iu.test(content)) score += 4;
  if (/\b(actualizacion|actualizaciones|version|versiones|changelog|novedad|novedades|cambios|update|updates|release)\b/iu.test(content)) score += 7;
  if (/\b(token|service_role|client_secret|password|contrasena|contraseña|blacklist|globalban|sancion|api key|apikey|secret)\b/iu.test(content)) score -= 5;

  return score;
}

const PRIORITY_TRANSCRIPT_TERMS = new Set([
  'resultado',
  'resultados',
  'postulacion',
  'postulaciones',
  'staff',
  'formulario',
  'formularios',
  'alianza',
  'alianzas',
  'normas',
  'reglas',
  'anuncios',
  'dashboard',
  'premium',
  'actualizacion',
  'actualizaciones',
  'version',
  'versiones',
  'changelog',
  'novedad',
  'novedades',
  'cambios',
  'update',
  'updates',
  'release'
]);

function normalizeTranscriptSearchText(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#@_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildStats({ guilds, tickets, transcriptMessages, feedback = [] }) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const panels = guilds.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0);
  const configuredGuilds = guilds.filter((guild) => guild.ticketCategoryId).length;
  const openTickets = tickets.filter((ticket) => ticket.status !== 'closed').length;
  const ticketsToday = tickets.filter((ticket) => now - new Date(ticket.createdAt).getTime() <= dayMs).length;
  const ticketsThisWeek = tickets.filter((ticket) => now - new Date(ticket.createdAt).getTime() <= weekMs).length;
  const escalationReadyGuilds = guilds.filter((guild) => guild.staffRoleId).length;
  const aiReadyGuilds = guilds.filter((guild) => guild.serverPrompt || guild.serverInfo).length;
  const securityReadyGuilds = guilds.filter((guild) => normalizeSecurityConfig(guild.security).enabled).length;
  const growthReadyGuilds = guilds.filter((guild) => normalizeGrowthConfig(guild.growth).enabled).length;
  const voiceRooms = tickets.filter((ticket) => ticket.status !== 'closed' && ticket.voiceChannelId).length;
  const proGuilds = guilds.filter(isPremiumEntitled).length;
  const feedbackStats = buildFeedbackStats(feedback);

  return {
    totalGuilds: guilds.length,
    configuredGuilds,
    unconfiguredGuilds: Math.max(guilds.length - configuredGuilds, 0),
    totalTickets: tickets.length,
    openTickets,
    closedTickets: tickets.filter((ticket) => ticket.status === 'closed').length,
    ticketsToday,
    ticketsThisWeek,
    panels,
    transcriptMessages,
    escalationReadyGuilds,
    aiReadyGuilds,
    securityReadyGuilds,
    growthReadyGuilds,
    voiceRooms,
    proGuilds,
    ...feedbackStats
  };
}
