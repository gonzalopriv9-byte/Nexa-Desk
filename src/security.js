import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  UserFlagsBitField
} from 'discord.js';

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
  alertOwner: true
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
    alertOwner: toBoolean(source.alertOwner, DEFAULT_SECURITY.alertOwner)
  };
}

export function isSecurityEnabled(guildConfig) {
  return Boolean(normalizeSecurityConfig(guildConfig?.security).enabled);
}

export function summarizeSecurityConfig(config = {}) {
  const security = normalizeSecurityConfig(config);
  if (!security.enabled) return 'Desactivada';
  const enabled = [
    security.antiFlood ? 'Anti-flood' : null,
    security.antiScamLinks ? 'Anti-links IA' : null,
    security.antiOffensive ? 'XN Automod' : null,
    security.antiBot ? 'Anti-bots' : null,
    security.antiAlt ? 'Anti-alts' : null,
    security.antiNuke ? 'Anti-nuke' : null
  ].filter(Boolean);
  return `${SECURITY_LEVELS[security.level].label}: ${enabled.join(', ') || 'solo logs'}`;
}

export class SecurityManager {
  constructor({ storage, client, supportAgent = null }) {
    this.storage = storage;
    this.client = client;
    this.supportAgent = supportAgent;
    this.messageBuckets = new Map();
    this.joinBuckets = new Map();
    this.actionBuckets = new Map();
    this.lastFloodWarnings = new Map();
  }

  async handleMessageCreate(message) {
    if (!message.guild || message.webhookId || message.author?.id === this.client.user?.id) return false;

    const guildConfig = await this.storage.getGuildConfig(message.guild.id);
    const security = normalizeSecurityConfig(guildConfig?.security);
    if (!security.enabled) return false;

    const urls = extractMessageUrls(message);
    if (security.antiScamLinks && urls.length) {
      const handledLinkThreat = await this.handleMessageLinks({ message, guildConfig, security, urls });
      if (handledLinkThreat) return true;
    }

    if (security.antiOffensive && message.content && !shouldSkipAutomodContent(message.content)) {
      const handledOffensiveContent = await this.handleOffensiveContent({ message, security });
      if (handledOffensiveContent) return true;
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

    const isolation = await this.isolateFloodActor(message, security, {
      repeated,
      flooding,
      repeatWarning
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Anti-flood activado',
      description: `${message.author} envio demasiados mensajes en poco tiempo. NexaDesk limpio la rafaga y aislo al autor si tenia permisos suficientes.`,
      fields: [
        { name: 'Usuario', value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: 'Tipo', value: message.author.bot ? 'Bot' : 'Usuario', inline: true },
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Mensajes detectados', value: `${bucket.length}/${security.floodLimit}`, inline: true },
        { name: 'Borrados', value: String(deleted), inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true
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

  async isolateFloodActor(message, security, { repeated, flooding, repeatWarning, reasonOverride = null }) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const timeoutMs = security.timeoutMinutes * 60 * 1000;
    const reason = reasonOverride ?? `NexaDesk Security Guard: ${message.author.bot ? 'bot' : 'usuario'} enviando flood/spam`;

    if (!member) return 'No pude obtener el miembro para aislarlo.';

    if (member.moderatable && message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      const timedOut = await member.timeout(timeoutMs, reason).then(() => true).catch(() => false);
      if (timedOut) return `Timeout aplicado ${security.timeoutMinutes} min.`;
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
    const security = normalizeSecurityConfig(guildConfig?.security);
    if (!security.enabled) return;

    await this.trackJoinRaid(member.guild, security);

    if (security.antiBot && member.user.bot && !isVerifiedBot(member.user)) {
      await this.sendSecurityLog({
        guild: member.guild,
        config: security,
        title: 'Bot bloqueado',
        description: `Se detecto un bot no verificado entrando al servidor: ${member.user.tag}.`,
        fields: [{ name: 'Accion', value: member.bannable ? 'Ban aplicado' : 'No pude banearlo por jerarquia/permisos' }]
      });
      if (member.bannable) {
        await member.ban({ reason: 'NexaDesk Security Guard: bot no verificado' }).catch(() => null);
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
      severity: 'medium'
    });
  }

  async handleChannelDelete(channel) {
    await this.handleAuditAction(channel?.guild, {
      targetId: channel?.id,
      auditType: AuditLogEvent.ChannelDelete,
      label: `eliminacion de canal #${channel?.name ?? channel?.id}`,
      severity: 'high'
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
    const hadAdmin = oldRole?.permissions?.has(PermissionFlagsBits.Administrator);
    const hasAdmin = newRole.permissions?.has(PermissionFlagsBits.Administrator);
    if (hadAdmin || !hasAdmin) return;

    const guildConfig = await this.storage.getGuildConfig(newRole.guild.id);
    const security = normalizeSecurityConfig(guildConfig?.security);
    if (!security.enabled || (!security.antiBot && !security.antiNuke)) return;

    const entry = await this.findRecentAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const executor = entry?.executor;
    if (!executor || this.isTrustedExecutor(newRole.guild, executor.id) || !executor.bot) return;

    const botMember = await newRole.guild.members.fetch(executor.id).catch(() => null);
    const updatedPermissions = newRole.permissions.remove(PermissionFlagsBits.Administrator);
    if (newRole.editable) {
      await newRole.setPermissions(updatedPermissions, 'NexaDesk Security Guard: bot gave Administrator').catch(() => null);
    }
    if (botMember?.bannable) {
      await botMember.ban({ reason: 'NexaDesk Security Guard: bot gave Administrator permissions' }).catch(() => null);
    }

    await this.sendSecurityLog({
      guild: newRole.guild,
      config: security,
      title: 'Bot elevando permisos',
      description: `${executor.tag} intento dar Administrator al rol ${newRole.name}.`,
      fields: [
        { name: 'Rol', value: `${newRole.name} (${newRole.id})`, inline: true },
        { name: 'Respuesta', value: `${newRole.editable ? 'Permiso Administrator retirado' : 'No pude editar el rol'} / ${botMember?.bannable ? 'bot baneado' : 'bot no baneable'}` }
      ],
      important: true
    });
  }

  async handleWebhooksUpdate(channel) {
    if (!channel?.guild) return;
    for (const auditType of [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate]) {
      const handled = await this.handleAuditAction(channel.guild, {
        targetId: null,
        auditType,
        label: `cambio de webhook en #${channel.name ?? channel.id}`,
        severity: 'high'
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

  async handleAuditAction(guild, { auditType, targetId, label, severity = 'medium' }) {
    if (!guild) return false;
    const guildConfig = await this.storage.getGuildConfig(guild.id);
    const security = normalizeSecurityConfig(guildConfig?.security);
    if (!security.enabled || !security.antiNuke) return false;
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return false;

    const entry = await this.findRecentAuditEntry(guild, auditType, targetId);
    const executor = entry?.executor;
    if (!executor || this.isTrustedExecutor(guild, executor.id)) return false;
    // Ticket systems often create channels legitimately; do not punish helper bots for that.
    if (auditType === AuditLogEvent.ChannelCreate && executor.bot) return false;

    const now = Date.now();
    const key = `${guild.id}:${executor.id}`;
    const windowMs = security.nukeWindowSeconds * 1000;
    const bucket = (this.actionBuckets.get(key) ?? []).filter((item) => now - item.at <= windowMs);
    bucket.push({ at: now, auditType, label });
    this.actionBuckets.set(key, bucket);

    await this.sendSecurityLog({
      guild,
      config: security,
      title: 'Accion sensible detectada',
      description: `${executor.tag} ejecuto ${label}.`,
      fields: [
        { name: 'Executor', value: `${executor.tag} (${executor.id})`, inline: true },
        { name: 'Acciones recientes', value: `${bucket.length}/${security.nukeLimit}`, inline: true },
        { name: 'Riesgo', value: severity, inline: true }
      ]
    });

    if (bucket.length < security.nukeLimit) return true;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    const canBan = Boolean(member?.bannable && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers));
    if (canBan) {
      await member.ban({ reason: `NexaDesk Security Guard: ${bucket.length} acciones sensibles en ${security.nukeWindowSeconds}s` }).catch(() => null);
    }

    await this.sendSecurityLog({
      guild,
      config: security,
      title: 'Anti-nuke disparado',
      description: `${executor.tag} supero el limite de acciones sensibles.`,
      fields: [
        { name: 'Acciones', value: bucket.map((item) => `- ${item.label}`).slice(-8).join('\n') || label },
        { name: 'Respuesta', value: canBan ? 'Ban preventivo aplicado' : 'No pude banear por permisos o jerarquia' }
      ],
      important: true
    });
    return true;
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
      return !entryTargetId || entryTargetId === targetId;
    }) ?? null;
  }

  isTrustedExecutor(guild, userId) {
    if (!userId) return true;
    if (userId === this.client.user?.id) return true;
    if (userId === guild.ownerId) return true;
    return false;
  }

  async sendSecurityLog({ guild, config, title, description, fields = [], important = false }) {
    const embed = new EmbedBuilder()
      .setColor(0xffffff)
      .setTitle(`NexaDesk Security Guard - ${title}`)
      .setDescription(description)
      .addFields(fields.filter((field) => field?.name && field?.value).slice(0, 8))
      .setTimestamp(new Date());

    const channel = config.logChannelId
      ? await guild.channels.fetch(config.logChannelId).catch(() => null)
      : null;
    if (channel?.type === ChannelType.GuildText || channel?.isTextBased?.()) {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    }

    if (important || config.alertOwner) {
      const owner = await guild.fetchOwner().catch(() => null);
      await owner?.send({ embeds: [embed] }).catch(() => null);
    }
  }
}

function isVerifiedBot(user) {
  if (!user?.bot) return false;
  return Boolean(user.flags?.has?.(UserFlagsBitField.Flags.VerifiedBot));
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
