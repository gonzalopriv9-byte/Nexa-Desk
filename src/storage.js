import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { normalizeBlacklistEntry, normalizeBlacklistEvidence, normalizeBlacklistLookup } from './blacklist.js';
import { normalizeMaintenanceState } from './maintenance.js';
import { isPremiumEntitled, normalizePremiumConfig } from './premium.js';
import { normalizeSecurityConfig } from './security.js';

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
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.#ensureJson(this.guildsFile, {});
    await this.#ensureJson(this.ticketsFile, {});
    await this.#ensureJson(this.transcriptsFile, {});
    await this.#ensureJson(this.globalSettingsFile, {});
    await this.#ensureJson(this.blacklistFile, {});
    await this.#ensureJson(this.blacklistEvidenceFile, {});
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
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.#writeJson(this.ticketsFile, tickets);
    this.events?.publish('ticket.created', tickets[ticket.channelId]);
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

  async listTranscriptMessages(channelId) {
    const transcripts = await this.#readJson(this.transcriptsFile);
    return transcripts[channelId] ?? [];
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

    return buildStats({ guilds, tickets, transcriptMessages });
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

export class SupabaseStorage {
  constructor({ url, serviceRoleKey, events = null }) {
    this.client = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    this.events = events;
    this.guildCompatibilityOverlay = new Map();
    this.ticketCompatibilityOverlay = new Map();
  }

  async init() {}

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
    if (usedCompatibleTicketSchema) this.#rememberTicketCompatibility(ticket.channelId, next);
    const saved = this.#mergeTicketCompatibility(fromTicketRow(data));
    this.events?.publish('ticket.created', saved);
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
    if (usedCompatibleTicketSchema) this.#rememberTicketCompatibility(channelId, next);
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

  async listTranscriptMessages(channelId) {
    const { data, error } = await this.client
      .from('transcript_messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(fromTranscriptRow);
  }

  async getDashboardStats(guildIds = []) {
    if (!guildIds.length) {
      return buildStats({ guilds: [], tickets: [], transcriptMessages: 0 });
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

    return buildStats({
      guilds: guilds.map((row) => this.#mergeGuildCompatibility(fromGuildRow(row))),
      tickets: tickets.map((row) => this.#mergeTicketCompatibility(fromTicketRow(row))),
      transcriptMessages
    });
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
      throw new Error('Faltan tablas de blacklist en Supabase. Ejecuta el SQL actualizado de supabase/schema.sql.');
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
      throw new Error('Falta global_blacklist_evidence en Supabase. Ejecuta el SQL actualizado de supabase/schema.sql.');
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

  #rememberTicketCompatibility(channelId, ticket) {
    const overlay = pickTicketCompatibilityFields(ticket);
    if (!Object.keys(overlay).length) return;
    this.ticketCompatibilityOverlay.set(channelId, {
      ...(this.ticketCompatibilityOverlay.get(channelId) ?? {}),
      ...overlay
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
}

export function createStorage(config, events) {
  if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('NexaDesk storage backend: Supabase');
    return new SupabaseStorage({
      url: config.SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      events
    });
  }

  console.warn('NexaDesk storage backend: local JSON. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist data in Supabase.');
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
    premium: normalizePremiumConfig(panelStore.premium, {
      plan: row.plan ?? 'free',
      voiceSupportEnabled: row.voice_support_enabled ?? false
    }),
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
    alliance: normalizeAllianceConfig(guild)
  };
}

function fromGuildPanelStore(value) {
  if (Array.isArray(value)) {
    return {
      panels: value,
      components: [],
      security: normalizeSecurityConfig(),
      premium: normalizePremiumConfig(),
      alliance: normalizeAllianceConfig()
    };
  }

  if (value && typeof value === 'object') {
    return {
      panels: Array.isArray(value.panels) ? value.panels : [],
      components: Array.isArray(value.components) ? value.components : [],
      security: normalizeSecurityConfig(value.security),
      premium: normalizePremiumConfig(value.premium),
      alliance: normalizeAllianceConfig(value.alliance)
    };
  }

  return {
    panels: [],
    components: [],
    security: normalizeSecurityConfig(),
    premium: normalizePremiumConfig(),
    alliance: normalizeAllianceConfig()
  };
}

function normalizeAllianceConfig(value = {}) {
  const source = value?.alliance && typeof value.alliance === 'object' ? value.alliance : value;
  return pickDefined({
    channelId: source?.channelId ?? source?.allianceChannelId,
    channelName: source?.channelName ?? source?.allianceChannelName,
    template: source?.template ?? source?.allianceTemplate
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
  return row;
}

function toCompatibleTicketRow(ticket) {
  const row = toTicketRow(ticket);
  delete row.ai_disabled;
  delete row.ai_disabled_by;
  delete row.ai_disabled_at;
  delete row.voice_channel_id;
  delete row.voice_channel_name;
  delete row.voice_created_at;
  return row;
}

function isTicketCompatibilityError(error) {
  return Boolean(error && /ai_disabled|voice_channel_id|voice_channel_name|voice_created_at/i.test(String(error.message ?? '')));
}

function pickTicketCompatibilityFields(ticket) {
  return pickDefined({
    aiDisabled: ticket.aiDisabled,
    aiDisabledBy: ticket.aiDisabledBy,
    aiDisabledAt: ticket.aiDisabledAt,
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

function isMissingBlacklistTableError(error) {
  return Boolean(error && /global_blacklist|global_blacklist_evidence|relation .* does not exist|schema cache/i.test(String(error.message ?? '')));
}

function buildStats({ guilds, tickets, transcriptMessages }) {
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
  const voiceRooms = tickets.filter((ticket) => ticket.status !== 'closed' && ticket.voiceChannelId).length;
  const proGuilds = guilds.filter(isPremiumEntitled).length;

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
    voiceRooms,
    proGuilds
  };
}
