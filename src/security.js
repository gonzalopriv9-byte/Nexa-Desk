import {
  AttachmentBuilder,
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  UserFlagsBitField
} from 'discord.js';
import { DISCORD_EMOJIS as EMOJIS } from './emojis.js';

const TOPGG_CACHE_MS = 1000 * 60 * 60 * 12;
const TOPGG_ERROR_CACHE_MS = 1000 * 60 * 15;
const LOCKDOWN_COOLDOWN_MS = 1000 * 60;
const CHANNEL_CLEANUP_MAX = 12;
const LOCKDOWN_CHANNEL_MAX = 20;
const RAID_EVIDENCE_SNIPPET_MAX = 520;
const CHANNEL_LOCKDOWN_AUDIT_TYPES = new Set([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.IntegrationCreate,
  AuditLogEvent.IntegrationDelete,
  AuditLogEvent.IntegrationUpdate,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.WebhookUpdate
]);
const LOCKDOWN_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildCategory
]);
const DANGEROUS_ROLE_PERMISSIONS = [
  ['Administrator', PermissionFlagsBits.Administrator],
  ['Manage Guild', PermissionFlagsBits.ManageGuild],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Webhooks', PermissionFlagsBits.ManageWebhooks],
  ['Ban Members', PermissionFlagsBits.BanMembers],
  ['Kick Members', PermissionFlagsBits.KickMembers],
  ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Manage Threads', PermissionFlagsBits.ManageThreads],
  ['Moderate Members', PermissionFlagsBits.ModerateMembers]
];

export const SECURITY_LEVELS = {
  low: {
    label: 'Bajo',
    antiFlood: true,
    antiScamLinks: true,
    antiOffensive: true,
    antiBot: true,
    antiAlt: false,
    antiNuke: false,
    minAccountAgeDays: 0,
    floodLimit: 7,
    floodWindowSeconds: 5,
    raidJoinLimit: 12,
    raidWindowSeconds: 30,
    nukeLimit: 5,
    nukeWindowSeconds: 12,
    timeoutMinutes: 5
  },
  medium: {
    label: 'Intermedio',
    antiFlood: true,
    antiScamLinks: true,
    antiOffensive: true,
    antiBot: true,
    antiAlt: true,
    antiNuke: true,
    minAccountAgeDays: 3,
    floodLimit: 5,
    floodWindowSeconds: 4,
    raidJoinLimit: 8,
    raidWindowSeconds: 20,
    nukeLimit: 3,
    nukeWindowSeconds: 8,
    timeoutMinutes: 10
  },
  high: {
    label: 'Alto',
    antiFlood: true,
    antiScamLinks: true,
    antiOffensive: true,
    antiBot: true,
    antiAlt: true,
    antiNuke: true,
    minAccountAgeDays: 7,
    floodLimit: 4,
    floodWindowSeconds: 3,
    raidJoinLimit: 5,
    raidWindowSeconds: 15,
    nukeLimit: 2,
    nukeWindowSeconds: 6,
    timeoutMinutes: 15
  }
};

const DEFAULT_SECURITY = {
  enabled: false,
  level: 'medium',
  logChannelId: null,
  logChannelName: null,
  alertOwner: true,
  disabledAt: null,
  disabledBy: null
};

export function normalizeSecurityLevel(level) {
  const normalized = String(level ?? '').toLowerCase().trim();
  if (['bajo', 'low'].includes(normalized)) return 'low';
  if (['alto', 'high'].includes(normalized)) return 'high';
  if (['intermedio', 'medio', 'medium'].includes(normalized)) return 'medium';
  return 'medium';
}

export function normalizeSecurityConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const level = normalizeSecurityLevel(source.level);
  const defaults = SECURITY_LEVELS[level];

  return {
    ...DEFAULT_SECURITY,
    ...defaults,
    enabled: toBoolean(source.enabled, DEFAULT_SECURITY.enabled),
    level,
    logChannelId: cleanId(source.logChannelId),
    logChannelName: source.logChannelName ? String(source.logChannelName).slice(0, 100) : null,
    antiFlood: toBoolean(source.antiFlood, defaults.antiFlood),
    antiScamLinks: toBoolean(source.antiScamLinks ?? source.antiLinks ?? source.antiPhishing, defaults.antiScamLinks),
    antiOffensive: toBoolean(source.antiOffensive ?? source.antiAutomod ?? source.xnProtectAutomod, defaults.antiOffensive),
    antiBot: toBoolean(source.antiBot, defaults.antiBot),
    antiAlt: toBoolean(source.antiAlt, defaults.antiAlt),
    antiNuke: toBoolean(source.antiNuke, defaults.antiNuke),
    minAccountAgeDays: clampInt(source.minAccountAgeDays, defaults.minAccountAgeDays, 0, 90),
    floodLimit: clampInt(source.floodLimit, defaults.floodLimit, 3, 30),
    floodWindowSeconds: clampInt(source.floodWindowSeconds, defaults.floodWindowSeconds, 2, 60),
    raidJoinLimit: clampInt(source.raidJoinLimit, defaults.raidJoinLimit, 3, 60),
    raidWindowSeconds: clampInt(source.raidWindowSeconds, defaults.raidWindowSeconds, 5, 120),
    nukeLimit: clampInt(source.nukeLimit, defaults.nukeLimit, 2, 30),
    nukeWindowSeconds: clampInt(source.nukeWindowSeconds, defaults.nukeWindowSeconds, 4, 60),
    timeoutMinutes: clampInt(source.timeoutMinutes, defaults.timeoutMinutes, 1, 1440),
    alertOwner: toBoolean(source.alertOwner, DEFAULT_SECURITY.alertOwner),
    disabledAt: source.disabledAt ? String(source.disabledAt).slice(0, 80) : null,
    disabledBy: cleanId(source.disabledBy)
  };
}

export function isSecurityEnabled(guildConfig) {
  return Boolean(resolveSecurityRuntimeConfig(guildConfig).security.enabled);
}

export function resolveSecurityRuntimeConfig(guildConfig) {
  const raw = guildConfig?.security;
  const security = normalizeSecurityConfig(raw);
  const autoArmed = shouldAutoArmConfiguredSecurity(raw, security);
  return {
    security: autoArmed ? { ...security, enabled: true, autoArmed: true } : security,
    autoArmed
  };
}

function shouldAutoArmConfiguredSecurity(raw, security) {
  if (!raw || typeof raw !== 'object') return false;
  if (security.enabled) return false;
  if (security.disabledAt || security.disabledBy) return false;

  const rawLevel = normalizeSecurityLevel(raw.level);
  const hasLogChannel = Boolean(cleanId(raw.logChannelId));
  const highIntent = rawLevel === 'high' || security.nukeLimit <= 2 || security.floodLimit <= 4;
  const hasProtectionIntent = raw.antiNuke === true || raw.antiFlood === true || raw.antiScamLinks === true || raw.antiOffensive === true;
  return highIntent && (hasLogChannel || hasProtectionIntent);
}

export function summarizeSecurityConfig(config = {}) {
  const security = normalizeSecurityConfig(config);
  if (!security.enabled) return 'Desactivada';
  const enabled = [
    security.antiFlood ? 'Anti-flood' : null,
    security.antiScamLinks ? 'Anti-links IA' : null,
    security.antiOffensive ? 'XN Automod' : null,
    security.antiBot ? 'Anti-bots Top.gg' : null,
    security.antiAlt ? 'Anti-alts' : null,
    security.antiNuke ? 'Anti-nuke canales/config/webhooks' : null
  ].filter(Boolean);
  return `${SECURITY_LEVELS[security.level].label}: ${enabled.join(', ') || 'solo logs'}`;
}

export class SecurityManager {
  constructor({ storage, client, supportAgent = null, config = {} }) {
    this.storage = storage;
    this.client = client;
    this.supportAgent = supportAgent;
    this.config = config;
    this.messageBuckets = new Map();
    this.joinBuckets = new Map();
    this.actionBuckets = new Map();
    this.lockdownCooldowns = new Map();
    this.lastFloodWarnings = new Map();
    this.topGgBotCache = new Map();
    this.autoArmWarnings = new Set();
    this.securityLabBotIds = parseIdList(config.SECURITY_LAB_BOT_IDS);
  }

  getRuntimeSecurity(guildConfig, guild = null) {
    const runtime = resolveSecurityRuntimeConfig(guildConfig);
    if (runtime.autoArmed && guild?.id && !this.autoArmWarnings.has(guild.id)) {
      this.autoArmWarnings.add(guild.id);
      console.warn(`NexaDesk Security Guard auto-armed ${guild.name ?? guild.id}: high-risk configuration was present but enabled=false without manual disable marker.`);
    }
    return runtime.security;
  }

  async handleMessageCreate(message) {
    if (!message.guild || message.author?.id === this.client.user?.id) return false;

    const guildConfig = await this.storage.getGuildConfig(message.guild.id);
    const security = this.getRuntimeSecurity(guildConfig, message.guild);
    if (!security.enabled) return false;

    if (message.webhookId) {
      return this.handleWebhookMessageCreate({ message, guildConfig, security });
    }

    if (isExternalApplicationMessage(message)) {
      return this.handleExternalApplicationMessageCreate({ message, guildConfig, security });
    }

    const urls = extractMessageUrls(message);
    if (security.antiScamLinks && urls.length) {
      const handledLinkThreat = await this.handleMessageLinks({ message, guildConfig, security, urls });
      if (handledLinkThreat) return true;
    }

    if (security.antiOffensive && message.content && !shouldSkipAutomodContent(message.content)) {
      const handledOffensiveContent = await this.handleOffensiveContent({ message, security });
      if (handledOffensiveContent) return true;
    }

    if (security.antiFlood && isMassMentionMessage(message)) {
      const handledMentionSpam = await this.handleMentionSpam({ message, security });
      if (handledMentionSpam) return true;
    }

    if (security.antiFlood && shouldReviewSpamContent(message)) {
      const handledSpamContent = await this.handleSpamContent({ message, guildConfig, security });
      if (handledSpamContent) return true;
    }

    if (!security.antiFlood) return false;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const windowMs = security.floodWindowSeconds * 1000;
    const bucket = (this.messageBuckets.get(key) ?? []).filter((entry) => now - entry.at <= windowMs);
    const content = normalizeContent(message.content);
    bucket.push({ at: now, content, messageId: message.id, channelId: message.channelId });
    this.messageBuckets.set(key, bucket);

    const repeated = content && bucket.filter((entry) => entry.content === content).length >= Math.max(3, Math.ceil(security.floodLimit / 2));
    const flooding = bucket.length >= security.floodLimit;
    if (!flooding && !repeated) return false;

    const deleted = await this.deleteFloodBurstMessages(message, bucket, security);
    const warningKey = `${key}:${message.channelId}`;
    const warnedAt = this.lastFloodWarnings.get(warningKey) ?? 0;
    const repeatWarning = now - warnedAt < 120000;
    this.lastFloodWarnings.set(warningKey, now);

    const raidReason = repeated
      ? 'Rafaga de mensajes repetidos compatible con bot personal/selfbot.'
      : 'Flood de mensajes compatible con raid o automatizacion externa.';
    const lockdownResult = await this.applyEmergencyLockdown({
      guild: message.guild,
      channelIds: [message.channelId],
      reason: `NexaDesk Security Guard: ${raidReason}`
    });
    const evidence = buildRaidEvidence({
      guild: message.guild,
      channel: message.channel,
      sourceLabel: message.author.bot ? 'Bot instalado o app externa' : 'Cuenta de usuario / posible selfbot',
      responsible: message.author,
      reason: raidReason,
      bucket,
      message,
      actionSummary: `${deleted} mensajes borrados. ${lockdownResult}.`
    });
    const isolation = await this.isolateSensitiveExecutor({
      guild: message.guild,
      executor: message.author,
      security,
      reason: `NexaDesk Security Guard: ${raidReason}`,
      banResponsible: true,
      evidence,
      incidentSummary: `${message.author.tag} envio ${bucket.length} mensajes en ${security.floodWindowSeconds}s en #${message.channel?.name ?? message.channelId}.`
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Anti-flood/anti-raid activado',
      description: `${message.author} envio demasiados mensajes en poco tiempo. NexaDesk limpio la rafaga, bloqueo el canal e intento sancionar al responsable.`,
      fields: [
        { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Mensajes detectados', value: `${bucket.length}/${security.floodLimit}`, inline: true },
        { name: 'Borrados', value: String(deleted), inline: true },
        { name: 'Lockdown', value: lockdownResult, inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true,
      evidence
    });

    return true;
  }

  async handleWebhookMessageCreate({ message, guildConfig, security }) {
    if (!security.antiFlood && !security.antiScamLinks && !security.antiOffensive) return false;

    const key = `${message.guild.id}:webhook:${message.webhookId}`;
    const now = Date.now();
    const windowMs = security.floodWindowSeconds * 1000;
    const bucket = (this.messageBuckets.get(key) ?? []).filter((entry) => now - entry.at <= windowMs);
    const content = normalizeContent(message.content);
    bucket.push({
      at: now,
      content,
      messageId: message.id,
      channelId: message.channelId,
      webhookId: message.webhookId
    });
    this.messageBuckets.set(key, bucket);

    const repeated = Boolean(content && bucket.filter((entry) => entry.content === content).length >= 2);
    const flooding = bucket.length >= Math.max(3, Math.min(security.floodLimit, 4));
    const massMention = security.antiFlood && isMassMentionMessage(message);
    const urls = extractMessageUrls(message);

    let linkAnalysis = null;
    if (security.antiScamLinks && urls.length) {
      linkAnalysis = await this.reviewMessageLinks({ message, guildConfig, urls });
    }

    let offensiveAnalysis = null;
    if (security.antiOffensive && message.content && !shouldSkipAutomodContent(message.content)) {
      offensiveAnalysis = await reviewXnProtectAutomod(message.content);
    }

    let spamAnalysis = null;
    if (security.antiFlood && (shouldReviewSpamContent(message) || repeated || flooding || massMention)) {
      spamAnalysis = await this.reviewSpamContent({ message, guildConfig });
    }

    const risky = Boolean(
      massMention
      || repeated
      || flooding
      || shouldBlockLinkThreat(linkAnalysis)
      || offensiveAnalysis?.malicious
      || shouldBlockSpamThreat(spamAnalysis)
    );
    if (!risky) return false;

    const threatReason = buildWebhookThreatReason({ massMention, repeated, flooding, linkAnalysis, offensiveAnalysis, spamAnalysis });
    const responsible = await this.resolveWebhookResponsible(message);
    const deleted = await this.deleteWebhookBurstMessages(message, bucket, security);
    const webhookAction = await this.deleteWebhookSource(
      message,
      `NexaDesk Security Guard: webhook usado para ${massMention ? 'mention spam' : 'spam/raid'}`
    );
    const lockdownResult = await this.applyEmergencyLockdown({
      guild: message.guild,
      channelIds: [message.channelId],
      reason: 'NexaDesk Security Guard: canal bloqueado por raid desde webhook/app externa'
    });
    const evidence = buildRaidEvidence({
      guild: message.guild,
      channel: message.channel,
      sourceLabel: `Webhook ${message.webhookId}`,
      responsible: responsible.user,
      reason: threatReason,
      bucket,
      message,
      actionSummary: `${deleted} mensajes borrados. ${webhookAction}. ${lockdownResult}.`
    });
    const isolation = responsible.user && !this.isTrustedExecutor(message.guild, responsible.user.id)
      ? await this.isolateSensitiveExecutor({
          guild: message.guild,
          executor: responsible.user,
          security,
          reason: `NexaDesk Security Guard: webhook/app externa usada para raid. ${threatReason}`,
          topGgDecision: responsible.user.bot ? await this.shouldBanBotBecauseMissingTopGg(responsible.user) : null,
          banResponsible: true,
          evidence,
          incidentSummary: `Se detecto actividad de raid desde un webhook/app externa en #${message.channel?.name ?? message.channelId}. Motivo: ${threatReason}`
        })
      : 'No pude identificar al responsable humano en webhook/audit logs. Webhook neutralizado y canal bloqueado si Discord lo permitio.';

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Webhook o app externa bloqueada',
      description: `${message.author?.tag ?? 'Webhook'} publico contenido sospechoso usando webhook/app externa. NexaDesk limpio la rafaga e intento neutralizar el origen.`,
      fields: [
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Webhook', value: `${message.webhookId}`, inline: true },
        responsible.user ? { name: 'Responsable', value: `${responsible.user.tag} (${responsible.user.id})`, inline: true } : null,
        { name: 'Rastro', value: responsible.source || 'Sin rastro claro en integraciones/audit logs.', inline: true },
        { name: 'Motivo', value: threatReason },
        { name: 'Mensajes borrados', value: String(deleted), inline: true },
        { name: 'Webhook', value: webhookAction, inline: true },
        { name: 'Lockdown', value: lockdownResult, inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true,
      evidence
    });

    return true;
  }

  async handleExternalApplicationMessageCreate({ message, guildConfig, security }) {
    if (!security.antiFlood && !security.antiScamLinks && !security.antiOffensive) return false;

    const sourceId = message.applicationId ?? message.author?.id ?? 'unknown';
    const key = `${message.guild.id}:external-app:${sourceId}`;
    const now = Date.now();
    const windowMs = security.floodWindowSeconds * 1000;
    const bucket = (this.messageBuckets.get(key) ?? []).filter((entry) => now - entry.at <= windowMs);
    const content = normalizeContent(message.content);
    bucket.push({
      at: now,
      content,
      messageId: message.id,
      channelId: message.channelId,
      applicationId: message.applicationId ?? null
    });
    this.messageBuckets.set(key, bucket);

    const repeated = Boolean(content && bucket.filter((entry) => entry.content === content).length >= 2);
    const flooding = bucket.length >= Math.max(3, Math.min(security.floodLimit, 4));
    const massMention = security.antiFlood && isMassMentionMessage(message);
    const urls = extractMessageUrls(message);

    let linkAnalysis = null;
    if (security.antiScamLinks && urls.length) {
      linkAnalysis = await this.reviewMessageLinks({ message, guildConfig, urls });
    }

    let offensiveAnalysis = null;
    if (security.antiOffensive && message.content && !shouldSkipAutomodContent(message.content)) {
      offensiveAnalysis = await reviewXnProtectAutomod(message.content);
    }

    let spamAnalysis = null;
    if (security.antiFlood && (shouldReviewSpamContent(message) || repeated || flooding || massMention)) {
      spamAnalysis = await this.reviewSpamContent({ message, guildConfig });
    }

    const risky = Boolean(
      massMention
      || repeated
      || flooding
      || shouldBlockLinkThreat(linkAnalysis)
      || offensiveAnalysis?.malicious
      || shouldBlockSpamThreat(spamAnalysis)
    );
    if (!risky) return false;

    const threatReason = buildWebhookThreatReason({ massMention, repeated, flooding, linkAnalysis, offensiveAnalysis, spamAnalysis });
    const responsible = await this.resolveExternalApplicationResponsible(message);
    const deleted = await this.deleteFloodBurstMessages(message, bucket, security);
    const lockdownResult = await this.applyEmergencyLockdown({
      guild: message.guild,
      channelIds: [message.channelId],
      reason: 'NexaDesk Security Guard: canal bloqueado por raid desde app externa'
    });
    const evidence = buildRaidEvidence({
      guild: message.guild,
      channel: message.channel,
      sourceLabel: `App externa ${sourceId}`,
      responsible: responsible.user,
      reason: threatReason,
      bucket,
      message,
      actionSummary: `${deleted} mensajes borrados. ${lockdownResult}.`
    });
    const isolation = responsible.user && !this.isTrustedExecutor(message.guild, responsible.user.id)
      ? await this.isolateSensitiveExecutor({
          guild: message.guild,
          executor: responsible.user,
          security,
          reason: `NexaDesk Security Guard: app externa usada para raid. ${threatReason}`,
          topGgDecision: responsible.user.bot ? await this.shouldBanBotBecauseMissingTopGg(responsible.user) : null,
          banResponsible: true,
          evidence,
          incidentSummary: `Se detecto actividad de raid desde una app externa en #${message.channel?.name ?? message.channelId}. Motivo: ${threatReason}`
        })
      : 'No pude identificar al responsable humano en interaction metadata/audit logs. Canal bloqueado y mensajes limpiados si Discord lo permitio.';

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'App externa bloqueada',
      description: `${message.author?.tag ?? 'App externa'} publico contenido sospechoso sin estar como miembro normal del servidor.`,
      fields: [
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Aplicacion', value: `${sourceId}`, inline: true },
        responsible.user ? { name: 'Responsable', value: `${responsible.user.tag} (${responsible.user.id})`, inline: true } : null,
        { name: 'Rastro', value: responsible.source || 'Sin rastro claro en metadata/audit logs.', inline: true },
        { name: 'Motivo', value: threatReason },
        { name: 'Mensajes borrados', value: String(deleted), inline: true },
        { name: 'Lockdown', value: lockdownResult, inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true,
      evidence
    });

    return true;
  }

  async handleMessageLinks({ message, guildConfig, security, urls }) {
    const analysis = await this.reviewMessageLinks({ message, guildConfig, urls });
    if (!shouldBlockLinkThreat(analysis)) {
      if (analysis.verdict === 'suspicious') {
        await this.sendSecurityLog({
          guild: message.guild,
          config: security,
          title: 'Link sospechoso permitido',
          description: 'La IA marco el link como sospechoso, pero no con suficiente confianza para aislar automaticamente.',
          fields: buildLinkThreatFields({ message, urls, analysis }),
          important: false
        });
      }
      return false;
    }

    const deleted = await message.delete().then(() => true).catch(() => false);
    const isolation = await this.isolateFloodActor(message, security, {
      repeated: true,
      flooding: true,
      repeatWarning: true,
      reasonOverride: 'NexaDesk Security Guard: link malicioso, phishing o estafa'
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Link malicioso bloqueado',
      description: `${message.author} envio un link que la IA clasifico como phishing, estafa o riesgo alto. NexaDesk elimino el mensaje y aislo al autor si tenia permisos suficientes.`,
      fields: [
        ...buildLinkThreatFields({ message, urls, analysis }),
        { name: 'Mensaje borrado', value: deleted ? 'Si' : 'No pude borrarlo por permisos o antiguedad', inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true
    });

    return true;
  }

  async reviewMessageLinks({ message, guildConfig, urls }) {
    if (this.supportAgent?.analyzeMessageLinks) {
      try {
        return normalizeLinkThreatAnalysis(await this.supportAgent.analyzeMessageLinks({
          message,
          guildConfig,
          urls
        }));
      } catch (error) {
        console.error(`AI link threat analysis failed in ${message.guild.id}:`, error);
      }
    }

    return heuristicLinkThreatAnalysis({ content: message.content, urls });
  }

  async handleSpamContent({ message, guildConfig, security }) {
    const analysis = await this.reviewSpamContent({ message, guildConfig });
    if (!shouldBlockSpamThreat(analysis)) return false;

    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const bucket = (this.messageBuckets.get(key) ?? [])
      .filter((entry) => now - entry.at <= Math.max(security.floodWindowSeconds * 1000, 8000));
    const content = normalizeContent(message.content);
    bucket.push({ at: now, content, messageId: message.id, channelId: message.channelId });
    this.messageBuckets.set(key, bucket);

    const deleted = await this.deleteFloodBurstMessages(message, bucket, security);
    const lockdownResult = await this.applyEmergencyLockdown({
      guild: message.guild,
      channelIds: [message.channelId],
      reason: `NexaDesk Security Guard: ${analysis.reason || 'spam/raid detectado por IA'}`
    });
    const evidence = buildRaidEvidence({
      guild: message.guild,
      channel: message.channel,
      sourceLabel: message.author.bot ? 'Bot/app de spam' : 'Cuenta de usuario / posible selfbot',
      responsible: message.author,
      reason: analysis.reason || 'Spam o raid detectado por IA',
      bucket,
      message,
      actionSummary: `${deleted} mensajes borrados. ${lockdownResult}.`
    });
    const isolation = await this.isolateSensitiveExecutor({
      guild: message.guild,
      executor: message.author,
      security,
      reason: `NexaDesk Security Guard: ${analysis.reason || 'spam detectado por IA'}`,
      banResponsible: true,
      evidence,
      incidentSummary: `${message.author.tag} publico contenido clasificado como spam/raid en #${message.channel?.name ?? message.channelId}.`
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Spam IA / raid bloqueado',
      description: `${message.author} envio contenido clasificado como spam, raid o promocion fraudulenta. NexaDesk limpio la rafaga, bloqueo el canal e intento sancionar al responsable.`,
      fields: [
        ...buildSpamThreatFields({ message, analysis }),
        { name: 'Mensajes borrados', value: String(deleted), inline: true },
        { name: 'Lockdown', value: lockdownResult, inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true,
      evidence
    });

    return true;
  }

  async reviewSpamContent({ message, guildConfig }) {
    const heuristic = heuristicSpamThreatAnalysis({ content: message.content, message });
    if (heuristic.spam && heuristic.confidence >= 94) return heuristic;

    if (this.supportAgent?.analyzeSpamMessage) {
      try {
        return normalizeSpamThreatAnalysis(await this.supportAgent.analyzeSpamMessage({
          message,
          guildConfig,
          heuristic
        }));
      } catch (error) {
        console.error(`AI spam analysis failed in ${message.guild.id}:`, error);
      }
    }

    return heuristic;
  }

  async handleOffensiveContent({ message, security }) {
    const analysis = await reviewXnProtectAutomod(message.content);
    if (!analysis.malicious) return false;

    const deleted = await message.delete().then(() => true).catch(() => false);
    const isolation = await this.isolateFloodActor(message, security, {
      repeated: true,
      flooding: true,
      repeatWarning: true,
      reasonOverride: `NexaDesk Security Guard: ${analysis.reason || 'contenido ofensivo o malicioso'}`
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Contenido ofensivo bloqueado',
      description: `${message.author} envio contenido marcado como ofensivo o malicioso por XN Protect Automod.`,
      fields: [
        { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Motivo', value: analysis.reason || 'No indicado.' },
        { name: 'Palabras detectadas', value: analysis.words.length ? analysis.words.join(', ').slice(0, 700) : 'No indicadas.' },
        { name: 'Mensaje borrado', value: deleted ? 'Si' : 'No pude borrarlo por permisos o antiguedad', inline: true },
        { name: 'Aislamiento', value: isolation },
        { name: 'Fuente', value: 'XN Protect Automod API. Derechos reservados por XN Protect.' }
      ],
      important: true
    });

    return true;
  }

  async handleMentionSpam({ message, security }) {
    const deleted = await message.delete().then(() => true).catch(() => false);
    const lockdownResult = await this.applyEmergencyLockdown({
      guild: message.guild,
      channelIds: [message.channelId],
      reason: 'NexaDesk Security Guard: mention spam o ping masivo'
    });
    const evidence = buildRaidEvidence({
      guild: message.guild,
      channel: message.channel,
      sourceLabel: message.author.bot ? 'Bot/app con mention spam' : 'Cuenta de usuario / posible selfbot',
      responsible: message.author,
      reason: 'Mention spam o ping masivo',
      bucket: [{ at: Date.now(), content: message.content, channelId: message.channelId, messageId: message.id }],
      message,
      actionSummary: `${deleted ? 1 : 0} mensajes borrados. ${lockdownResult}.`
    });
    const isolation = await this.isolateSensitiveExecutor({
      guild: message.guild,
      executor: message.author,
      security,
      reason: 'NexaDesk Security Guard: mention spam o ping masivo',
      banResponsible: true,
      evidence,
      incidentSummary: `${message.author.tag} envio mention spam en #${message.channel?.name ?? message.channelId}.`
    });

    const mentionStats = getMentionStats(message);
    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Mention spam bloqueado',
      description: `${message.author} envio una rafaga de menciones sospechosa. NexaDesk elimino el mensaje y aislo al autor si tenia permisos suficientes.`,
      fields: [
        { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Menciones', value: `everyone/here: ${mentionStats.everyone ? 'si' : 'no'} | roles: ${mentionStats.roles} | usuarios: ${mentionStats.users}` },
        { name: 'Mensaje borrado', value: deleted ? 'Si' : 'No pude borrarlo por permisos o antiguedad', inline: true },
        { name: 'Lockdown', value: lockdownResult, inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true,
      evidence
    });

    return true;
  }

  async deleteFloodBurstMessages(message, bucket, security) {
    const windowMs = Math.max(security.floodWindowSeconds * 1000, 8000);
    const cutoff = Date.now() - windowMs;
    const channelIds = new Set([
      message.channelId,
      ...bucket.map((entry) => entry.channelId).filter(Boolean)
    ]);

    let deleted = 0;
    for (const channelId of channelIds) {
      const channel = await message.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) continue;

      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!recent?.size) continue;

      const targets = recent.filter((item) => (
        item.author?.id === message.author.id
        && item.createdTimestamp >= cutoff
        && item.deletable
      ));
      if (!targets.size) continue;

      if (channel.bulkDelete && targets.size > 1) {
        const removed = await channel.bulkDelete(targets, true).catch(() => null);
        if (removed?.size) {
          deleted += removed.size;
          continue;
        }
      }

      const results = await Promise.allSettled([...targets.values()].map((item) => item.delete()));
      deleted += results.filter((result) => result.status === 'fulfilled').length;
    }

    return deleted;
  }

  async deleteWebhookBurstMessages(message, bucket, security) {
    const windowMs = Math.max(security.floodWindowSeconds * 1000, 8000);
    const cutoff = Date.now() - windowMs;
    const channelIds = new Set([
      message.channelId,
      ...bucket.map((entry) => entry.channelId).filter(Boolean)
    ]);

    let deleted = 0;
    for (const channelId of channelIds) {
      const channel = await message.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) continue;

      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!recent?.size) continue;

      const targets = recent.filter((item) => (
        item.webhookId === message.webhookId
        && item.createdTimestamp >= cutoff
        && item.deletable
      ));
      if (!targets.size) continue;

      if (channel.bulkDelete && targets.size > 1) {
        const removed = await channel.bulkDelete(targets, true).catch(() => null);
        if (removed?.size) {
          deleted += removed.size;
          continue;
        }
      }

      const results = await Promise.allSettled([...targets.values()].map((item) => item.delete()));
      deleted += results.filter((result) => result.status === 'fulfilled').length;
    }

    return deleted;
  }

  async deleteWebhookSource(message, reason) {
    if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
      return 'No pude eliminarlo: falta Manage Webhooks.';
    }
    const webhook = await message.fetchWebhook?.().catch(() => null);
    if (!webhook) return 'No pude obtener el webhook desde Discord.';
    const deleted = await webhook.delete(reason).then(() => true).catch(() => false);
    return deleted ? 'Webhook eliminado.' : 'No pude eliminar el webhook por permisos o propiedad.';
  }

  async isolateFloodActor(message, security, { repeated, flooding, repeatWarning, reasonOverride = null }) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const timeoutMs = security.timeoutMinutes * 60 * 1000;
    const reason = reasonOverride ?? `NexaDesk Security Guard: ${message.author.bot ? 'bot' : 'usuario'} enviando flood/spam`;

    if (!member) return 'No pude obtener el miembro para aislarlo.';

    if (this.isSecurityLabBot(message.author.id)) {
      return 'Simulacion detectada: bot de laboratorio autorizado. Mensaje gestionado sin ban/kick/timeout para que pueda seguir probando.';
    }

    if (member.moderatable && message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      const timedOut = await member.timeout(timeoutMs, reason).then(() => true).catch(() => false);
      if (timedOut) return `Timeout aplicado ${security.timeoutMinutes} min.`;
    }

    const topGgDecision = message.author.bot
      ? await this.shouldBanBotBecauseMissingTopGg(message.author)
      : { shouldBan: false, lookup: null };

    if (message.author.bot && !topGgDecision.shouldBan) {
      return `Timeout no aplicado. Bot no baneado: ${describeTopGgLookup(topGgDecision.lookup)}.`;
    }

    if (message.author.bot && member.bannable && message.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      const banned = await member.ban({ reason }).then(() => true).catch(() => false);
      if (banned) return 'Bot baneado preventivamente porque no se pudo aplicar timeout.';
    }

    if (message.author.bot && member.kickable && message.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
      const kicked = await member.kick(reason).then(() => true).catch(() => false);
      if (kicked) return 'Bot expulsado preventivamente porque no se pudo aplicar timeout.';
    }

    if (repeatWarning || repeated || flooding) {
      return 'No pude aislarlo por jerarquia o falta de permisos. Revisa Moderate Members y la posicion del rol de NexaDesk.';
    }

    return 'Aviso registrado.';
  }

  async handleMemberAdd(member) {
    if (!member.guild) return;
    const guildConfig = await this.storage.getGuildConfig(member.guild.id);
    const security = this.getRuntimeSecurity(guildConfig, member.guild);
    if (!security.enabled) return;

    await this.trackJoinRaid(member.guild, security);

    if (security.antiBot && member.user.bot) {
      if (this.isSecurityLabBot(member.user.id)) {
        await this.sendSecurityLog({
          guild: member.guild,
          config: security,
          title: 'Security Lab autorizado',
          description: `${member.user.tag} esta en SECURITY_LAB_BOT_IDS. NexaDesk lo permite para pruebas controladas sin desactivar la proteccion real.`,
          fields: [
            { name: 'Bot', value: `${member.user.tag} (${member.user.id})`, inline: true },
            { name: 'Accion', value: 'Permitido por allowlist de laboratorio.' }
          ],
          important: false
        });
        return;
      }

      const topGgDecision = await this.shouldBanBotBecauseMissingTopGg(member.user);
      if (!topGgDecision.shouldBan) {
        if (topGgDecision.lookup?.status !== 'listed') {
          const discordVerified = topGgDecision.lookup?.status === 'discord_verified';
          await this.sendSecurityLog({
            guild: member.guild,
            config: security,
            title: discordVerified ? 'Bot verificado por Discord permitido' : 'Anti-bots sin verificacion Top.gg',
            description: discordVerified
              ? `Ha entrado el bot verificado ${member.user.tag}. Top.gg puede devolver falsos negativos en bots grandes, asi que NexaDesk no lo sanciona.`
              : `Ha entrado el bot ${member.user.tag}, pero NexaDesk no pudo confirmar su estado en Top.gg. No se banea sin certeza.`,
            fields: [
              { name: 'Bot', value: `${member.user.tag} (${member.user.id})`, inline: true },
              { name: 'Top.gg', value: describeTopGgLookup(topGgDecision.lookup) },
              { name: 'Accion', value: discordVerified ? 'Permitido: verificado por Discord.' : 'Permitido temporalmente. Revisa manualmente si no reconoces este bot.' }
            ],
            important: false
          });
        }
        return;
      }

      await this.sendSecurityLog({
        guild: member.guild,
        config: security,
        title: 'Bot no listado en Top.gg bloqueado',
        description: `Se detecto un bot que no aparece listado en Top.gg entrando al servidor: ${member.user.tag}.`,
        fields: [
          { name: 'Bot', value: `${member.user.tag} (${member.user.id})`, inline: true },
          { name: 'Top.gg', value: describeTopGgLookup(topGgDecision.lookup) },
          { name: 'Accion', value: member.bannable ? 'Ban aplicado' : 'No pude banearlo por jerarquia/permisos' }
        ],
        important: true
      });
      if (member.bannable) {
        await member.ban({ reason: 'NexaDesk Security Guard: bot no listado en Top.gg' }).catch(() => null);
      }
      return;
    }

    if (security.antiAlt && !member.user.bot) {
      const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
      if (accountAgeDays < security.minAccountAgeDays) {
        await member.send([
          `NexaDesk Security Guard ha bloqueado tu entrada en **${member.guild.name}**.`,
          `Tu cuenta tiene ${accountAgeDays} dias y el servidor exige minimo ${security.minAccountAgeDays}.`
        ].join('\n')).catch(() => null);
        await this.sendSecurityLog({
          guild: member.guild,
          config: security,
          title: 'Cuenta nueva bloqueada',
          description: `${member.user.tag} no supera la edad minima de cuenta.`,
          fields: [
            { name: 'Edad de cuenta', value: `${accountAgeDays} dias`, inline: true },
            { name: 'Minimo', value: `${security.minAccountAgeDays} dias`, inline: true },
            { name: 'Accion', value: member.kickable ? 'Kick aplicado' : 'No pude expulsarlo por jerarquia/permisos' }
          ]
        });
        if (member.kickable) {
          await member.kick('NexaDesk Security Guard: cuenta demasiado nueva').catch(() => null);
        }
      }
    }
  }

  async handleChannelCreate(channel) {
    await this.handleAuditAction(channel?.guild, {
      targetId: channel?.id,
      auditType: AuditLogEvent.ChannelCreate,
      label: `creacion de canal #${channel?.name ?? channel?.id}`,
      severity: 'high',
      targetName: channel?.name ?? null
    });
  }

  async handleChannelDelete(channel) {
    await this.handleAuditAction(channel?.guild, {
      targetId: channel?.id,
      auditType: AuditLogEvent.ChannelDelete,
      label: `eliminacion de canal #${channel?.name ?? channel?.id}`,
      severity: 'high',
      targetName: channel?.name ?? null
    });
  }

  async handleChannelUpdate(oldChannel, newChannel) {
    if (!newChannel?.guild) return;
    const changed = describeChannelChanges(oldChannel, newChannel);
    if (!changed.length) return;
    await this.handleAuditAction(newChannel.guild, {
      targetId: newChannel.id,
      auditType: AuditLogEvent.ChannelUpdate,
      label: `cambio de configuracion de canal #${newChannel.name ?? newChannel.id}: ${changed.join(', ')}`,
      severity: changed.some((item) => item.includes('permisos')) ? 'critical' : 'high',
      targetName: newChannel.name ?? null
    });
  }

  async handleGuildUpdate(oldGuild, newGuild) {
    if (!newGuild) return;
    const changed = describeGuildChanges(oldGuild, newGuild);
    if (!changed.length) return;
    await this.handleAuditAction(newGuild, {
      targetId: newGuild.id,
      auditType: AuditLogEvent.GuildUpdate,
      label: `cambio de configuracion del servidor: ${changed.join(', ')}`,
      severity: 'critical',
      targetName: newGuild.name ?? null
    });
  }

  async handleRoleCreate(role) {
    await this.handleAuditAction(role?.guild, {
      targetId: role?.id,
      auditType: AuditLogEvent.RoleCreate,
      label: `creacion de rol ${role?.name ?? role?.id}`,
      severity: 'medium'
    });
  }

  async handleRoleDelete(role) {
    await this.handleAuditAction(role?.guild, {
      targetId: role?.id,
      auditType: AuditLogEvent.RoleDelete,
      label: `eliminacion de rol ${role?.name ?? role?.id}`,
      severity: 'high'
    });
  }

  async handleRoleUpdate(oldRole, newRole) {
    if (!newRole?.guild) return;
    const dangerousGains = describeDangerousPermissionGains(oldRole?.permissions, newRole.permissions);
    if (!dangerousGains.length) return;

    const guildConfig = await this.storage.getGuildConfig(newRole.guild.id);
    const security = this.getRuntimeSecurity(guildConfig, newRole.guild);
    if (!security.enabled || !security.antiNuke) return;

    const entry = await this.findRecentAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const executor = entry?.executor;
    if (!executor || this.isTrustedExecutor(newRole.guild, executor.id)) return;

    const updatedPermissions = removeDangerousPermissionGains(oldRole?.permissions, newRole.permissions);
    if (newRole.editable) {
      await newRole.setPermissions(updatedPermissions, 'NexaDesk Security Guard: permiso peligroso retirado').catch(() => null);
    }

    const topGgDecision = executor.bot ? await this.shouldBanBotBecauseMissingTopGg(executor) : null;
    const isolation = await this.isolateSensitiveExecutor({
      guild: newRole.guild,
      executor,
      security,
      reason: `NexaDesk Security Guard: elevacion de permisos en ${newRole.name}`,
      topGgDecision
    });

    await this.sendSecurityLog({
      guild: newRole.guild,
      config: security,
      title: 'Elevacion de permisos bloqueada',
      description: `${executor.tag} intento anadir permisos peligrosos al rol ${newRole.name}.`,
      fields: [
        { name: 'Rol', value: `${newRole.name} (${newRole.id})`, inline: true },
        { name: 'Permisos', value: dangerousGains.join(', ').slice(0, 900) },
        executor.bot ? { name: 'Top.gg', value: describeTopGgLookup(topGgDecision?.lookup) } : null,
        { name: 'Respuesta', value: `${newRole.editable ? 'Permisos peligrosos retirados' : 'No pude editar el rol por jerarquia/permisos'} / ${isolation}` }
      ],
      important: true
    });
  }

  async handleWebhooksUpdate(channel) {
    if (!channel?.guild) return;
    for (const auditType of [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate]) {
      const handled = await this.handleAuditAction(channel.guild, {
        targetId: null,
        channelId: channel.id,
        auditType,
        label: `cambio de webhook en #${channel.name ?? channel.id}`,
        severity: 'high',
        targetName: channel.name ?? null
      });
      if (handled) return;
    }
  }

  async handleGuildIntegrationsUpdate(guild) {
    if (!guild) return;
    for (const auditType of [AuditLogEvent.IntegrationCreate, AuditLogEvent.IntegrationUpdate, AuditLogEvent.IntegrationDelete]) {
      const handled = await this.handleAuditAction(guild, {
        targetId: null,
        channelId: null,
        auditType,
        label: 'cambio de integracion/app externa del servidor',
        severity: 'critical',
        targetName: guild.name ?? null
      });
      if (handled) return;
    }
  }

  async handleGuildBanAdd(ban) {
    await this.handleAuditAction(ban?.guild, {
      targetId: ban?.user?.id,
      auditType: AuditLogEvent.MemberBanAdd,
      label: `ban de ${ban?.user?.tag ?? ban?.user?.id}`,
      severity: 'high'
    });
  }

  async handleMemberRemove(member) {
    if (!member?.guild) return;
    await this.handleAuditAction(member.guild, {
      targetId: member.user?.id,
      auditType: AuditLogEvent.MemberKick,
      label: `kick de ${member.user?.tag ?? member.user?.id}`,
      severity: 'high'
    });
  }

  async trackJoinRaid(guild, security) {
    const now = Date.now();
    const windowMs = security.raidWindowSeconds * 1000;
    const joins = (this.joinBuckets.get(guild.id) ?? []).filter((entry) => now - entry <= windowMs);
    joins.push(now);
    this.joinBuckets.set(guild.id, joins);
    if (joins.length !== security.raidJoinLimit) return;

    await this.sendSecurityLog({
      guild,
      config: security,
      title: 'Posible raid de entradas',
      description: `Han entrado ${joins.length} miembros en ${security.raidWindowSeconds}s.`,
      fields: [{ name: 'Accion recomendada', value: 'Activa verificacion alta en Discord y revisa miembros recientes.' }]
    });
  }

  async handleAuditAction(guild, { auditType, targetId, label, severity = 'medium', targetName = null, channelId = null }) {
    if (!guild) return false;
    const guildConfig = await this.storage.getGuildConfig(guild.id);
    const security = this.getRuntimeSecurity(guildConfig, guild);
    if (!security.enabled || !security.antiNuke) return false;
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return false;

    const entry = await this.findRecentAuditEntry(guild, auditType, targetId);
    const executor = entry?.executor;
    if (!executor || this.isTrustedExecutor(guild, executor.id)) return false;
    const botTopGgDecision = executor.bot
      ? await this.shouldBanBotBecauseMissingTopGg(executor)
      : null;

    // Ticket systems often create channels legitimately. Only treat bot channel creation
    // as nuke-like when Top.gg confirms the bot is not listed.
    if (
      auditType === AuditLogEvent.ChannelCreate
      && executor.bot
      && !botTopGgDecision?.shouldBan
      && !this.isSecurityLabBot(executor.id)
    ) return false;

    const risk = classifySensitiveAuditRisk({ auditType, entry, baseSeverity: severity, security, label });
    severity = risk.severity;
    const now = Date.now();
    const key = `${guild.id}:${executor.id}`;
    const windowMs = security.nukeWindowSeconds * 1000;
    const bucket = (this.actionBuckets.get(key) ?? []).filter((item) => now - item.at <= windowMs);
    const lockdownChannelId = channelId ?? (CHANNEL_LOCKDOWN_AUDIT_TYPES.has(auditType) ? targetId : null);
    bucket.push({ at: now, auditType, label, targetId, targetName, severity, channelId: lockdownChannelId, riskReason: risk.reason });
    this.actionBuckets.set(key, bucket);
    const limit = risk.limit ?? getSensitiveActionLimit(security, auditType, severity);

    await this.sendSecurityLog({
      guild,
      config: security,
      title: 'Accion sensible detectada',
      description: `${executor.tag} ejecuto ${label}.`,
      fields: [
        { name: 'Executor', value: `${executor.tag} (${executor.id})`, inline: true },
        { name: 'Acciones recientes', value: `${bucket.length}/${limit}`, inline: true },
        { name: 'Riesgo', value: severity, inline: true },
        risk.reason ? { name: 'Senal', value: risk.reason } : null
      ]
    });

    if (bucket.length < limit) return true;

    const isLabSimulation = this.isSecurityLabBot(executor.id);
    const lockdownTargetIds = collectLockdownTargetChannelIds(bucket);
    const evidence = buildRaidEvidence({
      guild,
      channel: lockdownTargetIds[0] ? await guild.channels.fetch(lockdownTargetIds[0]).catch(() => null) : null,
      sourceLabel: 'Anti-nuke audit logs',
      responsible: executor,
      reason: bucket.map((item) => item.riskReason || item.label).slice(-6).join(' | '),
      bucket,
      actionSummary: `Limite superado: ${bucket.length}/${limit} acciones sensibles.`
    });
    const isolation = await this.isolateSensitiveExecutor({
      guild,
      executor,
      security,
      reason: `NexaDesk Security Guard: ${bucket.length} acciones sensibles en ${security.nukeWindowSeconds}s`,
      topGgDecision: botTopGgDecision,
      banResponsible: true,
      evidence,
      incidentSummary: `${executor.tag} supero el limite anti-nuke con ${bucket.length} acciones sensibles en ${security.nukeWindowSeconds}s.`
    });

    const cleanupResult = auditType === AuditLogEvent.ChannelCreate
      ? await this.deleteRecentCreatedChannels({
        guild,
        bucket,
        reason: `NexaDesk Security Guard: limpieza de canales por ${executor.tag}`
      })
      : null;
    const lockdownResult = shouldApplyEmergencyLockdown(severity, bucket, lockdownTargetIds)
      ? isLabSimulation
        ? 'Simulacion detectada: lockdown omitido para no interferir con pruebas controladas.'
        : await this.applyEmergencyLockdown({
          guild,
          channelIds: lockdownTargetIds,
          reason: `NexaDesk Security Guard: lockdown por ${executor.tag}`
        })
      : null;

    await this.sendSecurityLog({
      guild,
      config: security,
      title: 'Anti-nuke disparado',
      description: `${executor.tag} supero el limite de acciones sensibles.`,
      fields: [
        { name: 'Acciones', value: bucket.map((item) => `- ${item.label}`).slice(-8).join('\n') || label },
        executor.bot ? { name: 'Top.gg', value: describeTopGgLookup(botTopGgDecision?.lookup) } : null,
        cleanupResult ? { name: 'Limpieza de canales', value: cleanupResult } : null,
        lockdownResult ? { name: 'Lockdown rapido', value: lockdownResult } : null,
        { name: 'Respuesta', value: isLabSimulation ? 'Simulacion registrada. Bot de laboratorio no aislado ni bloqueado.' : isolation }
      ],
      important: true,
      evidence
    });
    return true;
  }

  async resolveWebhookResponsible(message) {
    const webhook = await message.fetchWebhook?.().catch(() => null);
    const owner = normalizeResponsibleUser(webhook?.owner);
    if (owner && !this.isTrustedExecutor(message.guild, owner.id)) {
      return { user: owner, source: 'webhook.owner' };
    }

    const auditEntry = await this.findRecentWebhookAuditEntry(message);
    if (auditEntry?.executor) {
      return { user: auditEntry.executor, source: `audit:${auditEntry.action ?? 'webhook'}` };
    }

    const integrationEntry = await this.findRecentIntegrationAuditEntry(message.guild);
    if (integrationEntry?.executor) {
      return { user: integrationEntry.executor, source: `audit:${integrationEntry.action ?? 'integration'}` };
    }

    return { user: null, source: 'No encontrado en webhook.owner, webhooks audit logs ni integrations audit logs.' };
  }

  async resolveExternalApplicationResponsible(message) {
    const metadataUser = normalizeResponsibleUser(
      message.interactionMetadata?.user
      ?? message.interaction?.user
      ?? message.interactionMetadata?.authorizingIntegrationOwners?.user
    );
    if (metadataUser && !this.isTrustedExecutor(message.guild, metadataUser.id)) {
      return { user: metadataUser, source: 'interaction metadata' };
    }

    const integrationEntry = await this.findRecentIntegrationAuditEntry(message.guild, message.applicationId ?? message.author?.id);
    if (integrationEntry?.executor) {
      return { user: integrationEntry.executor, source: `audit:${integrationEntry.action ?? 'integration'}` };
    }

    return { user: null, source: 'No encontrado en interaction metadata ni integrations audit logs.' };
  }

  async findRecentWebhookAuditEntry(message) {
    await sleep(650);
    const auditTypes = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete];
    const now = Date.now();
    for (const auditType of auditTypes) {
      const logs = await message.guild.fetchAuditLogs({ type: auditType, limit: 10 }).catch(() => null);
      const entry = logs?.entries?.find((item) => {
        if (now - item.createdTimestamp > 1000 * 60 * 20) return false;
        const targetId = item.target?.id ?? item.targetId;
        const channelId = item.target?.channelId ?? item.extra?.channel?.id ?? item.extra?.channelId;
        return targetId === message.webhookId || channelId === message.channelId || !targetId;
      });
      if (entry) return entry;
    }
    return null;
  }

  async findRecentIntegrationAuditEntry(guild, applicationId = null) {
    await sleep(650);
    const auditTypes = [AuditLogEvent.IntegrationCreate, AuditLogEvent.IntegrationUpdate, AuditLogEvent.IntegrationDelete];
    const now = Date.now();
    for (const auditType of auditTypes) {
      const logs = await guild.fetchAuditLogs({ type: auditType, limit: 10 }).catch(() => null);
      const entry = logs?.entries?.find((item) => {
        if (now - item.createdTimestamp > 1000 * 60 * 20) return false;
        if (!applicationId) return true;
        const targetId = item.target?.id ?? item.targetId;
        const appId = item.target?.applicationId ?? item.extra?.applicationId;
        return targetId === applicationId || appId === applicationId || !targetId;
      });
      if (entry) return entry;
    }
    return null;
  }

  async isolateSensitiveExecutor({ guild, executor, security, reason, topGgDecision = null, banResponsible = false, evidence = null, incidentSummary = '' }) {
    if (!executor?.id) return 'No hay executor identificable.';
    if (this.isTrustedExecutor(guild, executor.id)) return 'Executor confiable: no se aplica aislamiento automatico.';
    if (this.isSecurityLabBot(executor.id)) {
      return 'Simulacion detectada: bot de laboratorio autorizado. Accion registrada sin ban/kick/timeout.';
    }

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return 'No pude obtener el miembro ejecutor. Puede haber salido del servidor.';

    const actions = [];
    if (!member.user.bot) {
      actions.push(await this.stripDangerousMemberRoles(member, reason));
    }

    if (banResponsible && !member.user.bot) {
      if (member.bannable && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        await this.notifyRaidResponsible({
          member,
          guild,
          reason,
          evidence,
          incidentSummary,
          actionLabel: 'baneado'
        });
        const banned = await member.ban({ reason }).then(() => true).catch(() => false);
        actions.push(banned ? 'Responsable humano baneado preventivamente.' : 'No pude banear al responsable humano.');
        if (banned) return compactActionSummary(actions);
      } else {
        actions.push('No pude banear al responsable humano por permisos o jerarquia.');
      }
    }

    if (member.moderatable && guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      const timedOut = await member.timeout(security.timeoutMinutes * 60 * 1000, reason).then(() => true).catch(() => false);
      actions.push(timedOut
        ? `Timeout aplicado ${security.timeoutMinutes} min.`
        : 'No pude aplicar timeout por jerarquia/permisos.');
    } else {
      actions.push('Timeout no aplicado: falta Moderate Members o jerarquia suficiente.');
    }

    if (member.user.bot) {
      const decision = topGgDecision ?? await this.shouldBanBotBecauseMissingTopGg(member.user);
      if (!decision.shouldBan) {
        actions.push(`Bot no baneado: ${describeTopGgLookup(decision.lookup)}.`);
        return compactActionSummary(actions);
      }
      if (member.bannable && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        await this.notifyRaidResponsible({
          member,
          guild,
          reason,
          evidence,
          incidentSummary,
          actionLabel: 'baneado'
        });
        const banned = await member.ban({ reason }).then(() => true).catch(() => false);
        actions.push(banned ? 'Bot baneado preventivamente.' : 'No pude banear el bot.');
      } else if (member.kickable && guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
        const kicked = await member.kick(reason).then(() => true).catch(() => false);
        actions.push(kicked ? 'Bot expulsado preventivamente.' : 'No pude expulsar el bot.');
      } else {
        actions.push('No pude banear/expulsar el bot por permisos o jerarquia.');
      }
    }

    return compactActionSummary(actions);
  }

  async notifyRaidResponsible({ member, guild, reason, evidence = null, incidentSummary = '', actionLabel = 'sancionado' }) {
    const lines = [
      `NexaDesk Security Guard ha detectado actividad compatible con raid en **${guild.name}**.`,
      `Tu cuenta/bot ha sido ${actionLabel} preventivamente.`,
      '',
      `Motivo: ${String(reason ?? 'actividad de raid').slice(0, 1300)}`,
      incidentSummary ? `Resumen: ${String(incidentSummary).slice(0, 1300)}` : null,
      '',
      'Si crees que es un error, contacta con el staff del servidor y aporta contexto.'
    ].filter(Boolean);
    const payload = { content: lines.join('\n') };
    if (evidence) payload.files = [createEvidenceAttachment(evidence)];
    await member.send(payload).catch(() => null);
  }

  async stripDangerousMemberRoles(member, reason) {
    if (member.id === member.guild.ownerId) return 'No retiro roles al owner del servidor.';
    if (!member.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return 'No pude retirar roles peligrosos: falta Manage Roles.';
    }

    const dangerousRoles = member.roles.cache.filter((role) => (
      role.id !== member.guild.id
      && !role.managed
      && role.editable
      && hasDangerousPermissions(role.permissions)
    ));
    if (!dangerousRoles.size) return 'No encontre roles peligrosos manejables para retirar.';

    const removed = await member.roles.remove([...dangerousRoles.keys()], reason).then(() => true).catch(() => false);
    if (!removed) return 'No pude retirar roles peligrosos por jerarquia/permisos.';
    return `Roles peligrosos retirados: ${[...dangerousRoles.values()].map((role) => role.name).slice(0, 6).join(', ')}.`;
  }

  async deleteRecentCreatedChannels({ guild, bucket, reason }) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return 'No pude borrar canales: falta Manage Channels.';
    }

    const targetIds = [...new Set(bucket
      .filter((item) => item.auditType === AuditLogEvent.ChannelCreate)
      .map((item) => item.targetId)
      .filter(Boolean))]
      .slice(-CHANNEL_CLEANUP_MAX);

    if (!targetIds.length) return 'No habia canales nuevos identificables para limpiar.';

    let deleted = 0;
    let skipped = 0;
    for (const channelId of targetIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.deleted) {
        skipped += 1;
        continue;
      }
      const ageMs = Date.now() - Number(channel.createdTimestamp ?? Date.now());
      if (ageMs > 1000 * 60 * 3) {
        skipped += 1;
        continue;
      }
      const ok = await channel.delete(reason).then(() => true).catch(() => false);
      if (ok) deleted += 1;
      else skipped += 1;
    }

    if (!deleted) return `No pude borrar los canales detectados (${skipped} omitidos/no accesibles).`;
    return `Borre ${deleted} canales creados en la rafaga${skipped ? ` (${skipped} omitidos/no accesibles)` : ''}.`;
  }

  async applyEmergencyLockdown({ guild, channelIds = [], reason }) {
    const now = Date.now();
    const targetIds = [...new Set(channelIds.map(String).filter((id) => /^\d{17,20}$/.test(id)))]
      .slice(-LOCKDOWN_CHANNEL_MAX);
    if (!targetIds.length) return 'Lockdown omitido: no hay canal objetivo identificable.';

    const cooldownKey = `${guild.id}:${[...targetIds].sort().join(',')}`;
    const lastLockdown = this.lockdownCooldowns.get(cooldownKey) ?? 0;
    if (now - lastLockdown < LOCKDOWN_COOLDOWN_MS) {
      return 'Lockdown ya aplicado hace menos de 60s sobre el canal objetivo; evito repetir cambios.';
    }
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return 'No pude aplicar lockdown: falta Manage Channels.';
    }

    const targetChannels = [];
    for (const channelId of targetIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel && LOCKDOWN_CHANNEL_TYPES.has(channel.type)) targetChannels.push(channel);
    }
    if (!targetChannels.length) return 'Lockdown omitido: los canales objetivo ya no existen o no son bloqueables.';

    let locked = 0;
    let roleLocks = 0;
    let failed = 0;
    for (const channel of targetChannels) {
      const ok = await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: false
      }, { reason }).then(() => true).catch(() => false);
      if (ok) locked += 1;
      else failed += 1;

      const explicitRoleOverwrites = [...(channel.permissionOverwrites?.cache?.values?.() ?? [])]
        .filter((overwrite) => overwrite.id !== guild.roles.everyone.id && guild.roles.cache.has(overwrite.id))
        .filter((overwrite) => (
          overwrite.allow?.has?.(PermissionFlagsBits.SendMessages)
          || overwrite.allow?.has?.(PermissionFlagsBits.CreatePublicThreads)
          || overwrite.allow?.has?.(PermissionFlagsBits.CreatePrivateThreads)
          || overwrite.allow?.has?.(PermissionFlagsBits.AddReactions)
        ))
        .slice(0, 25);

      for (const overwrite of explicitRoleOverwrites) {
        const roleOk = await channel.permissionOverwrites.edit(overwrite.id, {
          SendMessages: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false
        }, { reason }).then(() => true).catch(() => false);
        if (roleOk) roleLocks += 1;
        else failed += 1;
      }
    }

    this.lockdownCooldowns.set(cooldownKey, now);
    if (!locked) return `No pude bloquear el canal objetivo (${failed} fallidos).`;
    return `Lockdown aplicado en ${locked} canal(es) objetivo${roleLocks ? ` y ${roleLocks} permisos de rol explicitos` : ''}${failed ? ` (${failed} fallidos)` : ''}.`;
  }

  async findRecentAuditEntry(guild, auditType, targetId) {
    await sleep(650);
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 }).catch(() => null);
    if (!logs) return null;
    const now = Date.now();
    return logs.entries.find((entry) => {
      if (now - entry.createdTimestamp > 10000) return false;
      if (!targetId) return true;
      const entryTargetId = entry.target?.id ?? entry.targetId;
      return entryTargetId === targetId;
    }) ?? null;
  }

  isTrustedExecutor(guild, userId) {
    if (!userId) return true;
    if (userId === this.client.user?.id) return true;
    if (userId === guild.ownerId) return true;
    return false;
  }

  async shouldBanBotBecauseMissingTopGg(user) {
    if (!user?.bot) return { shouldBan: false, lookup: null };
    if (this.isSecurityLabBot(user.id)) {
      return {
        shouldBan: false,
        lookup: {
          status: 'lab_allowlisted',
          reason: 'Bot incluido en SECURITY_LAB_BOT_IDS para simulaciones controladas.'
        }
      };
    }
    const verifiedLookup = await this.lookupDiscordVerifiedBot(user);
    if (verifiedLookup.status === 'discord_verified') {
      return {
        shouldBan: false,
        lookup: verifiedLookup
      };
    }
    const lookup = await this.lookupTopGgBot(user.id);
    return {
      shouldBan: lookup.status === 'not_listed',
      lookup
    };
  }

  isSecurityLabBot(userId) {
    return Boolean(userId && this.securityLabBotIds.has(String(userId)));
  }

  async lookupDiscordVerifiedBot(user) {
    const fetched = await user.fetch(true).catch(() => user);
    const flags = fetched?.flags ?? user?.flags;
    const isVerified = Boolean(
      flags?.has?.(UserFlagsBitField.Flags.VerifiedBot)
      || (Number(flags?.bitfield ?? 0) & UserFlagsBitField.Flags.VerifiedBot)
    );
    return isVerified
      ? {
          status: 'discord_verified',
          reason: 'Bot verificado por Discord. Top.gg puede devolver falsos 404 en bots grandes; NexaDesk no banea sin riesgo real.'
        }
      : { status: 'not_discord_verified', reason: 'Bot no verificado por Discord.' };
  }

  async lookupTopGgBot(botId) {
    const token = String(this.config.TOPGG_API_TOKEN ?? '').trim();
    if (!token) {
      return {
        status: 'unknown',
        reason: 'TOPGG_API_TOKEN no configurado. NexaDesk no banea bots sin poder comprobar Top.gg.'
      };
    }

    const cached = this.topGgBotCache.get(botId);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.config.TOPGG_LOOKUP_TIMEOUT_MS ?? 4500));
    try {
      const baseUrl = String(this.config.TOPGG_API_BASE_URL ?? 'https://top.gg/api').replace(/\/+$/g, '');
      const response = await fetch(`${baseUrl}/bots/${encodeURIComponent(botId)}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: token
        },
        signal: controller.signal
      });

      if (response.status === 200) {
        const body = await response.json().catch(() => ({}));
        return this.cacheTopGgLookup(botId, {
          status: 'listed',
          reason: `Listado en Top.gg${body?.username ? ` como ${String(body.username).slice(0, 80)}` : ''}.`
        }, TOPGG_CACHE_MS);
      }

      if (response.status === 404) {
        return this.cacheTopGgLookup(botId, {
          status: 'not_listed',
          reason: 'Top.gg devolvio 404: bot no listado.'
        }, TOPGG_CACHE_MS);
      }

      return this.cacheTopGgLookup(botId, {
        status: 'unknown',
        reason: `Top.gg no pudo confirmar el bot. HTTP ${response.status}.`
      }, TOPGG_ERROR_CACHE_MS);
    } catch (error) {
      return this.cacheTopGgLookup(botId, {
        status: 'unknown',
        reason: error?.name === 'AbortError'
          ? 'Timeout consultando Top.gg.'
          : `Error consultando Top.gg: ${error?.message ?? 'desconocido'}.`
      }, TOPGG_ERROR_CACHE_MS);
    } finally {
      clearTimeout(timeout);
    }
  }

  cacheTopGgLookup(botId, result, ttlMs) {
    this.topGgBotCache.set(botId, {
      result,
      expiresAt: Date.now() + ttlMs
    });
    return result;
  }

  async sendSecurityLog({ guild, config, title, description, fields = [], important = false, evidence = null }) {
    const embed = new EmbedBuilder()
      .setColor(0xffffff)
      .setTitle(`${EMOJIS.wifi} NexaDesk Security Guard - ${title}`)
      .setDescription(description)
      .addFields(fields.filter((field) => field?.name && field?.value).slice(0, 8))
      .setTimestamp(new Date());
    if (evidence?.fileName) embed.setImage(`attachment://${evidence.fileName}`);

    const files = evidence ? [createEvidenceAttachment(evidence)] : [];

    const channel = config.logChannelId
      ? await guild.channels.fetch(config.logChannelId).catch(() => null)
      : null;
    if (channel?.type === ChannelType.GuildText || channel?.isTextBased?.()) {
      await channel.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => null);
    }

    if (important || config.alertOwner) {
      const owner = await guild.fetchOwner().catch(() => null);
      await owner?.send({ embeds: [embed], files: evidence ? [createEvidenceAttachment(evidence)] : [] }).catch(() => null);
    }

    await this.storage.addGuildLog?.({
      guildId: guild.id,
      guildName: guild.name,
      type: 'security',
      severity: important ? 'critical' : 'warning',
      title,
      message: description,
      metadata: {
        fields: fields.filter((field) => field?.name && field?.value).slice(0, 8),
        logChannelId: config.logChannelId || null,
        evidenceFileName: evidence?.fileName ?? null
      }
    }).catch((error) => {
      console.warn(`Could not persist security log for ${guild.id}:`, error?.message ?? error);
    });
  }
}

function normalizeContent(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function extractUrls(content = '') {
  const text = String(content ?? '');
  const matches = text.match(/\b(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)[^\s<>()]+/giu) ?? [];
  return [...new Set(matches
    .map(cleanUrl)
    .filter(Boolean))]
    .slice(0, 6);
}

function describeTopGgLookup(lookup) {
  if (!lookup) return 'No aplica.';
  if (lookup.status === 'listed') return lookup.reason || 'Bot listado en Top.gg.';
  if (lookup.status === 'not_listed') return lookup.reason || 'Bot no listado en Top.gg.';
  if (lookup.status === 'lab_allowlisted') return lookup.reason || 'Bot de laboratorio autorizado.';
  if (lookup.status === 'discord_verified') return lookup.reason || 'Bot verificado por Discord.';
  return lookup.reason || 'Estado Top.gg desconocido.';
}

function getSensitiveActionLimit(security, auditType, severity) {
  const base = Math.max(2, Number(security.nukeLimit ?? 3));
  if (auditType === AuditLogEvent.GuildUpdate) return 2;
  if (auditType === AuditLogEvent.ChannelCreate) return Math.max(2, base - 1);
  if (auditType === AuditLogEvent.ChannelUpdate) return Math.max(2, base - 1);
  if (severity === 'critical') return Math.max(2, base - 1);
  return base;
}

function shouldApplyEmergencyLockdown(severity, bucket, targetChannelIds = collectLockdownTargetChannelIds(bucket)) {
  if (!targetChannelIds.length) return false;
  if (severity === 'critical') return true;
  const channelCreates = bucket.filter((item) => item.auditType === AuditLogEvent.ChannelCreate).length;
  const channelUpdates = bucket.filter((item) => item.auditType === AuditLogEvent.ChannelUpdate).length;
  const webhookUpdates = bucket.filter((item) => [
    AuditLogEvent.WebhookCreate,
    AuditLogEvent.WebhookDelete,
    AuditLogEvent.WebhookUpdate
  ].includes(item.auditType)).length;
  return channelCreates >= 2 || channelUpdates >= 2 || webhookUpdates >= 2;
}

function collectLockdownTargetChannelIds(bucket = []) {
  return [...new Set(bucket
    .filter((item) => CHANNEL_LOCKDOWN_AUDIT_TYPES.has(item.auditType))
    .map((item) => item.channelId ?? item.targetId)
    .filter((id) => /^\d{17,20}$/.test(String(id))))].slice(-LOCKDOWN_CHANNEL_MAX);
}

function describeChannelChanges(oldChannel, newChannel) {
  const changes = [];
  if (!oldChannel || !newChannel) return changes;
  if (oldChannel.name !== newChannel.name) changes.push('nombre');
  if (oldChannel.parentId !== newChannel.parentId) changes.push('categoria');
  if (oldChannel.topic !== newChannel.topic) changes.push('topic');
  if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push('slowmode');
  if (oldChannel.nsfw !== newChannel.nsfw) changes.push('nsfw');
  if (oldChannel.type !== newChannel.type) changes.push('tipo');
  if (permissionOverwriteSignature(oldChannel) !== permissionOverwriteSignature(newChannel)) changes.push('permisos');
  return changes.slice(0, 8);
}

function describeGuildChanges(oldGuild, newGuild) {
  const changes = [];
  if (!oldGuild || !newGuild) return changes;
  const watched = [
    ['name', 'nombre'],
    ['icon', 'icono'],
    ['verificationLevel', 'verificacion'],
    ['explicitContentFilter', 'filtro de contenido'],
    ['defaultMessageNotifications', 'notificaciones'],
    ['mfaLevel', 'mfa'],
    ['systemChannelId', 'canal sistema'],
    ['rulesChannelId', 'canal normas'],
    ['publicUpdatesChannelId', 'canal updates'],
    ['afkChannelId', 'canal afk'],
    ['preferredLocale', 'idioma']
  ];
  for (const [key, label] of watched) {
    if (oldGuild[key] !== newGuild[key]) changes.push(label);
  }
  return changes.slice(0, 8);
}

function permissionOverwriteSignature(channel) {
  return [...(channel?.permissionOverwrites?.cache?.values?.() ?? [])]
    .map((overwrite) => `${overwrite.id}:${overwrite.type}:${String(overwrite.allow?.bitfield ?? '')}:${String(overwrite.deny?.bitfield ?? '')}`)
    .sort()
    .join('|');
}

function classifySensitiveAuditRisk({ auditType, entry, baseSeverity, security, label = '' }) {
  const changes = getAuditChangeKeys(entry);
  const labelText = String(label ?? '').toLowerCase();
  const highMode = security?.level === 'high';

  if (auditType === AuditLogEvent.GuildUpdate) {
    return {
      severity: 'critical',
      limit: 1,
      reason: 'Cambio directo de configuracion del servidor.'
    };
  }

  if (
    auditType === AuditLogEvent.WebhookCreate
    || auditType === AuditLogEvent.WebhookUpdate
    || auditType === AuditLogEvent.WebhookDelete
    || auditType === AuditLogEvent.IntegrationCreate
    || auditType === AuditLogEvent.IntegrationUpdate
    || auditType === AuditLogEvent.IntegrationDelete
  ) {
    return {
      severity: 'critical',
      limit: highMode ? 1 : 2,
      reason: 'Cambio de webhook/integracion. Puede ser usado por bots personales o apps externas sin estar instaladas como bot.'
    };
  }

  if (
    auditType === AuditLogEvent.ChannelUpdate
    && (changes.some((key) => key.includes('permission')) || labelText.includes('permiso'))
  ) {
    return {
      severity: 'critical',
      limit: 1,
      reason: 'Cambio de permisos de canal detectado.'
    };
  }

  if (auditType === AuditLogEvent.RoleUpdate && changes.includes('permissions')) {
    return {
      severity: 'critical',
      limit: 1,
      reason: 'Cambio de permisos de rol detectado.'
    };
  }

  if (auditType === AuditLogEvent.ChannelDelete || auditType === AuditLogEvent.RoleDelete) {
    return {
      severity: 'critical',
      limit: highMode ? 1 : Math.max(2, Number(security?.nukeLimit ?? 3) - 1),
      reason: 'Eliminacion sensible detectada.'
    };
  }

  return {
    severity: baseSeverity,
    limit: null,
    reason: null
  };
}

function getAuditChangeKeys(entry) {
  const changes = Array.isArray(entry?.changes)
    ? entry.changes
    : [...(entry?.changes?.values?.() ?? [])];
  return changes
    .map((change) => String(change?.key ?? '').toLowerCase())
    .filter(Boolean);
}

function hasDangerousPermissions(permissions) {
  return DANGEROUS_ROLE_PERMISSIONS.some(([, flag]) => permissions?.has?.(flag));
}

function describeDangerousPermissionGains(oldPermissions, newPermissions) {
  return DANGEROUS_ROLE_PERMISSIONS
    .filter(([, flag]) => newPermissions?.has?.(flag) && !oldPermissions?.has?.(flag))
    .map(([label]) => label);
}

function removeDangerousPermissionGains(oldPermissions, newPermissions) {
  const gainedFlags = DANGEROUS_ROLE_PERMISSIONS
    .filter(([, flag]) => newPermissions?.has?.(flag) && !oldPermissions?.has?.(flag))
    .map(([, flag]) => flag);
  return gainedFlags.length ? newPermissions.remove(...gainedFlags) : newPermissions;
}

function buildWebhookThreatReason({ massMention, repeated, flooding, linkAnalysis, offensiveAnalysis, spamAnalysis }) {
  const reasons = [];
  if (massMention) reasons.push('mentions masivas');
  if (repeated) reasons.push('mensajes repetidos');
  if (flooding) reasons.push('flood por webhook');
  if (shouldBlockLinkThreat(linkAnalysis)) reasons.push(`link ${linkAnalysis.verdict} (${linkAnalysis.confidence}%)`);
  if (offensiveAnalysis?.malicious) reasons.push(offensiveAnalysis.reason || 'contenido ofensivo/malicioso');
  if (shouldBlockSpamThreat(spamAnalysis)) reasons.push(spamAnalysis.reason || 'spam detectado por IA');
  return reasons.join(' | ').slice(0, 900) || 'Patron sospechoso por webhook.';
}

function compactActionSummary(actions = []) {
  return actions
    .filter(Boolean)
    .filter((item, index, source) => source.indexOf(item) === index)
    .join(' ');
}

function isExternalApplicationMessage(message) {
  if (!message?.guild || message.webhookId) return false;
  if (!message.author?.bot) return false;
  if (message.member) return false;
  return Boolean(message.applicationId || message.interactionMetadata || message.interaction || message.author?.id);
}

function normalizeResponsibleUser(user) {
  if (!user?.id) return null;
  return {
    id: String(user.id),
    tag: user.tag ?? user.username ?? String(user.id),
    username: user.username ?? user.tag ?? String(user.id),
    bot: Boolean(user.bot),
    send: typeof user.send === 'function' ? user.send.bind(user) : null,
    fetch: typeof user.fetch === 'function' ? user.fetch.bind(user) : null,
    flags: user.flags
  };
}

function buildRaidEvidence({ guild, channel = null, sourceLabel = 'Security Guard', responsible = null, reason = '', bucket = [], message = null, actionSummary = '' }) {
  const fileName = `nexadesk-raid-proof-${guild?.id ?? 'guild'}-${Date.now()}.svg`;
  const detectedAt = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const snippets = [
    message ? formatEvidenceMessage({
      at: message.createdTimestamp ?? Date.now(),
      author: message.author?.tag ?? message.author?.username ?? 'Origen desconocido',
      content: message.content || '[Sin texto visible]'
    }) : null,
    ...bucket.slice(-6).map((item) => formatEvidenceMessage({
      at: item.at,
      author: responsible?.tag ?? 'Origen detectado',
      content: item.content || item.label || item.riskReason || `Evento ${item.auditType ?? 'desconocido'}`
    }))
  ].filter(Boolean);

  const rows = [
    ['Servidor', guild?.name ?? guild?.id ?? 'Desconocido'],
    ['Canal', channel ? `#${channel.name ?? channel.id}` : 'No identificado'],
    ['Origen', sourceLabel],
    ['Responsable', responsible ? `${responsible.tag ?? responsible.username ?? responsible.id} (${responsible.id})` : 'No identificado'],
    ['Detectado', detectedAt],
    ['Motivo', reason || 'Patron de raid detectado'],
    ['Acciones', actionSummary || 'Security Guard activo']
  ];

  const svg = buildRaidEvidenceSvg({ rows, snippets });
  return {
    fileName,
    buffer: Buffer.from(svg, 'utf8')
  };
}

function createEvidenceAttachment(evidence) {
  return new AttachmentBuilder(Buffer.from(evidence.buffer), {
    name: evidence.fileName,
    description: 'Prueba visual generada automaticamente por NexaDesk Security Guard.'
  });
}

function formatEvidenceMessage({ at, author, content }) {
  const timestamp = new Date(Number(at) || Date.now()).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Madrid'
  });
  return `[${timestamp}] ${author}: ${String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, RAID_EVIDENCE_SNIPPET_MAX)}`;
}

function buildRaidEvidenceSvg({ rows, snippets }) {
  const rowLines = rows.flatMap(([label, value]) => wrapSvgLines(`${label}: ${value}`, 82));
  const snippetLines = snippets.length
    ? snippets.flatMap((line) => wrapSvgLines(line, 88)).slice(0, 12)
    : ['Sin mensajes recientes disponibles.'];
  const height = Math.max(760, 250 + (rowLines.length + snippetLines.length) * 30);
  const rowText = rowLines.map((line, index) => svgText(line, 70, 205 + index * 30, '24', '#f4f4f4')).join('\n');
  const snippetStart = 245 + rowLines.length * 30;
  const snippetText = snippetLines.map((line, index) => svgText(line, 70, snippetStart + 70 + index * 28, '21', '#cfcfcf')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${height}" viewBox="0 0 1400 ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#050505"/>
      <stop offset="55%" stop-color="#151515"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse">
      <path d="M 56 0 L 0 0 0 56" fill="none" stroke="#262626" stroke-width="1"/>
    </pattern>
    <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1400" height="${height}" fill="url(#bg)"/>
  <rect width="1400" height="${height}" fill="url(#grid)" opacity=".45"/>
  <rect x="42" y="42" width="1316" height="${height - 84}" rx="34" fill="#101010" stroke="#ffffff" stroke-opacity=".18"/>
  <circle cx="118" cy="118" r="42" fill="#ffffff" filter="url(#glow)"/>
  <text x="180" y="108" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="900" fill="#ffffff">NexaDesk Security Guard</text>
  <text x="180" y="148" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#bdbdbd">Prueba automatica de raid / anti-nuke</text>
  <text x="108" y="132" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="900" fill="#050505">!</text>
  <line x1="70" y1="176" x2="1330" y2="176" stroke="#ffffff" stroke-opacity=".2"/>
  ${rowText}
  <rect x="62" y="${snippetStart + 30}" width="1276" height="${Math.max(220, snippetLines.length * 28 + 65)}" rx="24" fill="#050505" stroke="#ffffff" stroke-opacity=".14"/>
  <text x="86" y="${snippetStart + 66}" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="900" fill="#ffffff">Mensajes/eventos usados como prueba</text>
  ${snippetText}
  <text x="70" y="${height - 58}" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#8f8f8f">Generado automaticamente. Revisa audit logs y permisos antes de revertir sanciones.</text>
</svg>`;
}

function wrapSvgLines(value, maxLength) {
  const words = String(value ?? '').split(/\s+/g).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function svgText(value, x, y, size, color) {
  return `<text x="${x}" y="${y}" font-family="Consolas, 'Courier New', monospace" font-size="${size}" fill="${color}">${escapeXml(value)}</text>`;
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseIdList(value = '') {
  return new Set(String(value ?? '')
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => /^\d{17,20}$/.test(entry)));
}

function getMentionStats(message) {
  return {
    everyone: Boolean(message.mentions?.everyone || /@(?:everyone|here)\b/i.test(message.content ?? '')),
    roles: message.mentions?.roles?.size ?? 0,
    users: message.mentions?.users?.size ?? 0
  };
}

function isMassMentionMessage(message) {
  const stats = getMentionStats(message);
  const total = stats.roles + stats.users + (stats.everyone ? 2 : 0);
  if (message.author?.bot && (stats.everyone || stats.roles >= 3 || total >= 5)) return true;
  if (stats.everyone && total >= 8) return true;
  return total >= 10;
}

function extractMessageUrls(message) {
  const parts = [message.content ?? ''];
  for (const embed of message.embeds ?? []) {
    parts.push(embed.url, embed.title, embed.description);
    for (const field of embed.fields ?? []) {
      parts.push(field.name, field.value);
    }
  }
  return extractUrls(parts.filter(Boolean).join('\n'));
}

function cleanUrl(rawUrl = '') {
  const cleaned = String(rawUrl)
    .trim()
    .replace(/[),.;!?]+$/g, '');
  if (!cleaned) return '';
  if (/^https?:\/\//iu.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function normalizeLinkThreatAnalysis(input) {
  const source = input && typeof input === 'object' ? input : {};
  const rawVerdict = String(source.verdict ?? '').toLowerCase().trim();
  const verdict = ['safe', 'suspicious', 'malicious'].includes(rawVerdict)
    ? rawVerdict
    : 'suspicious';
  const confidence = clampInt(source.confidence, verdict === 'malicious' ? 90 : 60, 0, 100);
  const riskSignals = Array.isArray(source.riskSignals)
    ? source.riskSignals.map((item) => String(item).slice(0, 140)).filter(Boolean).slice(0, 5)
    : [];

  return {
    verdict,
    confidence,
    reason: String(source.reason ?? 'La IA no devolvio una razon clara.').slice(0, 700),
    recommendedAction: String(source.recommendedAction ?? '').toLowerCase(),
    riskSignals,
    source: source.source ?? 'ai'
  };
}

function shouldBlockLinkThreat(analysis) {
  const verdict = String(analysis?.verdict ?? '').toLowerCase();
  const confidence = Number(analysis?.confidence ?? 0);
  const action = String(analysis?.recommendedAction ?? '').toLowerCase();
  return verdict === 'malicious'
    || action.includes('delete')
    || action.includes('isolate')
    || action.includes('block')
    || (verdict === 'suspicious' && confidence >= 82);
}

function buildLinkThreatFields({ message, urls, analysis }) {
  return [
    { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
    { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
    { name: 'Canal', value: `${message.channel}`, inline: true },
    { name: 'Veredicto', value: `${analysis.verdict} (${analysis.confidence}%)`, inline: true },
    { name: 'Accion sugerida', value: analysis.recommendedAction || 'allow/review', inline: true },
    { name: 'Links', value: urls.map(defangUrl).join('\n').slice(0, 1000) || 'Sin URL parseable' },
    { name: 'Motivo', value: analysis.reason || 'Sin motivo.' },
    analysis.riskSignals?.length
      ? { name: 'Senales', value: analysis.riskSignals.map((item) => `- ${item}`).join('\n').slice(0, 900) }
      : null
  ].filter(Boolean);
}

function normalizeSpamThreatAnalysis(input) {
  const source = input && typeof input === 'object' ? input : {};
  const rawAction = String(source.recommendedAction ?? source.action ?? '').toLowerCase().trim();
  const signals = Array.isArray(source.signals)
    ? source.signals.map((item) => String(item).slice(0, 140)).filter(Boolean).slice(0, 5)
    : [];

  return {
    spam: Boolean(source.spam),
    confidence: clampInt(source.confidence, source.spam ? 85 : 55, 0, 100),
    reason: String(source.reason ?? 'La IA no devolvio una razon clara.').slice(0, 700),
    recommendedAction: rawAction || (source.spam ? 'delete' : 'allow'),
    signals,
    source: source.source ?? 'ai'
  };
}

function shouldBlockSpamThreat(analysis) {
  if (!analysis?.spam) return false;
  const confidence = Number(analysis.confidence ?? 0);
  const action = String(analysis.recommendedAction ?? '').toLowerCase();
  return confidence >= 82
    || action.includes('delete')
    || action.includes('isolate')
    || action.includes('block');
}

function buildSpamThreatFields({ message, analysis }) {
  return [
    { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
    { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
    { name: 'Canal', value: `${message.channel}`, inline: true },
    { name: 'Confianza', value: `${analysis.confidence}%`, inline: true },
    { name: 'Accion sugerida', value: analysis.recommendedAction || 'delete/review', inline: true },
    { name: 'Fuente', value: analysis.source === 'heuristic' ? 'Filtro rapido de laboratorio/fallback' : 'IA Security Guard', inline: true },
    { name: 'Motivo', value: analysis.reason || 'Sin motivo.' },
    analysis.signals?.length
      ? { name: 'Senales', value: analysis.signals.map((item) => `- ${item}`).join('\n').slice(0, 900) }
      : null
  ].filter(Boolean);
}

function shouldReviewSpamContent(message) {
  const text = String(message.content ?? '').trim();
  if (!text) return false;
  if (/\[NEXADESK LAB (?:FLOOD|JOIN|CHANNEL RAID|SCAM LINK|MENTIONS)/i.test(text)) return true;
  if (text.length > 500) return true;

  const normalized = normalizeContent(text);
  return [
    /\b(?:free|gratis|nitro|robux|claim|giveaway|premio|regalo|airdrop|crypto|wallet)\b/i,
    /\b(?:raid|spam|flood|join fast|mass dm|server nuker|token grabber)\b/i,
    /\b(?:buy now|click here|verify now|verifica ahora|entra ya|unete ya)\b/i,
    /(.)\1{9,}/,
    /(?:https?:\/\/|discord\.gg\/).*(?:https?:\/\/|discord\.gg\/)/i
  ].some((pattern) => pattern.test(normalized));
}

function heuristicSpamThreatAnalysis({ content, message }) {
  const text = String(content ?? '');
  const normalized = normalizeContent(text);
  const signals = [];

  if (/\[NEXADESK LAB (?:FLOOD|JOIN|CHANNEL RAID|SCAM LINK|MENTIONS)/i.test(text)) {
    signals.push('Mensaje generado por el laboratorio de seguridad de NexaDesk.');
  }
  if (message?.author?.bot && /\b(?:free|gratis|nitro|robux|claim|giveaway|premio|regalo)\b/i.test(text)) {
    signals.push('Bot promocionando regalos o recompensas falsas.');
  }
  if (/\b(?:claim now|verify now|click here|buy now|free nitro|nitro gratis|robux gratis|premio gratis|verifica ahora|entra ya)\b/i.test(text)) {
    signals.push('Llamada a la accion tipica de spam o estafa.');
  }
  if (/\b(?:raid|spam|flood|mass dm|server nuker|token grabber)\b/i.test(text)) {
    signals.push('Terminologia asociada a raid, flood o robo de tokens.');
  }
  if (/(.)\1{9,}/.test(normalized)) {
    signals.push('Caracteres repetidos de forma anormal.');
  }
  if ((text.match(/(?:https?:\/\/|discord\.gg\/)/gi) ?? []).length >= 2) {
    signals.push('Multiples enlaces en un unico mensaje sospechoso.');
  }

  if (signals.length >= 2 || signals.some((signal) => signal.includes('laboratorio'))) {
    return {
      spam: true,
      confidence: signals.some((signal) => signal.includes('laboratorio')) ? 96 : 88,
      reason: 'Contenido con patrones de spam, raid o prueba controlada de Security Guard.',
      recommendedAction: 'delete_and_isolate',
      signals,
      source: 'heuristic'
    };
  }

  if (signals.length === 1) {
    return {
      spam: true,
      confidence: 72,
      reason: 'Hay una senal de spam, pero no suficiente para bloqueo automatico sin IA.',
      recommendedAction: 'review',
      signals,
      source: 'heuristic'
    };
  }

  return {
    spam: false,
    confidence: 45,
    reason: 'No se detectaron senales claras de spam en el filtro rapido.',
    recommendedAction: 'allow',
    signals: [],
    source: 'heuristic'
  };
}

function heuristicLinkThreatAnalysis({ content, urls }) {
  const text = `${content ?? ''}\n${urls.join('\n')}`.toLowerCase();
  const suspiciousSignals = [
    /\b(free|gratis|nitro|robux|steam|gift|airdrop|crypto|giveaway|premio|claim|regalo)\b/i,
    /\b(login|verify|verification|verificar|soporte|support|password|contrasena|wallet|seed|2fa|token)\b/i,
    /discord(?:-|_)?(?:gift|nitro|steam|airdrop|verify)|d[i1]sc[o0]rd|steamcommunit|steancommunity/i,
    /(?:bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rebrand\.ly|shorturl\.at|rb\.gy)\//i,
    /https?:\/\/[^/\s]+@/i,
    /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/i,
    /xn--/i
  ];
  const hits = suspiciousSignals.filter((pattern) => pattern.test(text)).length;
  if (hits >= 2) {
    return {
      verdict: 'malicious',
      confidence: 88,
      reason: 'Fallback heuristico: el link combina senales tipicas de phishing, regalo falso, verificacion falsa o ocultacion de destino.',
      recommendedAction: 'delete_and_isolate',
      riskSignals: ['Patrones de scam/phishing detectados sin respuesta IA.'],
      source: 'heuristic'
    };
  }
  if (hits === 1) {
    return {
      verdict: 'suspicious',
      confidence: 68,
      reason: 'Fallback heuristico: hay una senal de riesgo, pero no suficiente para bloqueo automatico sin IA.',
      recommendedAction: 'review',
      riskSignals: ['Una senal de riesgo detectada sin respuesta IA.'],
      source: 'heuristic'
    };
  }
  return {
    verdict: 'safe',
    confidence: 55,
    reason: 'Fallback heuristico: no se detectaron senales obvias de scam.',
    recommendedAction: 'allow',
    riskSignals: [],
    source: 'heuristic'
  };
}

async function reviewXnProtectAutomod(content = '') {
  const safeContent = String(content ?? '').trim().slice(0, 1200);
  if (!safeContent) return { malicious: false, words: [], reason: '', source: 'empty' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5500);
  try {
    const url = new URL('https://apis.ebixcloud.com/apis/xnprotect/automod/query');
    url.searchParams.set('content', safeContent);
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      return { malicious: false, words: [], reason: '', source: 'xnprotect-error' };
    }
    const result = body?.response && typeof body.response === 'object' ? body.response : {};
    const words = Array.isArray(result.palabras_maliciosas)
      ? result.palabras_maliciosas.map((item) => String(item).slice(0, 80)).filter(Boolean).slice(0, 12)
      : [];
    return {
      malicious: result.malicioso === true,
      words,
      reason: String(result.reason ?? '').slice(0, 700),
      source: 'xnprotect'
    };
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('XN Protect automod query failed:', error);
    }
    return { malicious: false, words: [], reason: '', source: 'xnprotect-unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldSkipAutomodContent(content = '') {
  const normalized = normalizeContent(content);
  return /\b(?:suicid|matarme|quitarme la vida|tirar(?:me)? por la ventana|kill myself|end my life|self harm|autolesion|自杀|輕生)\b/i.test(normalized);
}

function defangUrl(url = '') {
  return String(url)
    .replace(/^http/iu, 'hxxp')
    .replace(/\./g, '[.]')
    .replace(/:/g, '[:]');
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function cleanId(value) {
  const id = String(value ?? '').trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
