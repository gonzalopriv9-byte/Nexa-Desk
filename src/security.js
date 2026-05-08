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
    security.antiBot ? 'Anti-bots' : null,
    security.antiAlt ? 'Anti-alts' : null,
    security.antiNuke ? 'Anti-nuke' : null
  ].filter(Boolean);
  return `${SECURITY_LEVELS[security.level].label}: ${enabled.join(', ') || 'solo logs'}`;
}

export class SecurityManager {
  constructor({ storage, client }) {
    this.storage = storage;
    this.client = client;
    this.messageBuckets = new Map();
    this.joinBuckets = new Map();
    this.actionBuckets = new Map();
    this.lastFloodWarnings = new Map();
  }

  async handleMessageCreate(message) {
    if (!message.guild || message.webhookId || message.author?.id === this.client.user?.id) return false;

    const guildConfig = await this.storage.getGuildConfig(message.guild.id);
    const security = normalizeSecurityConfig(guildConfig?.security);
    if (!security.enabled || !security.antiFlood) return false;

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

  async isolateFloodActor(message, security, { repeated, flooding, repeatWarning }) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const timeoutMs = security.timeoutMinutes * 60 * 1000;
    const reason = `NexaDesk Security Guard: ${message.author.bot ? 'bot' : 'usuario'} enviando flood/spam`;

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
