import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits
} from 'discord.js';
import { DISCORD_EMOJIS as EMOJIS } from './emojis.js';

const TOPGG_CACHE_MS = 1000 * 60 * 60 * 12;
const TOPGG_ERROR_CACHE_MS = 1000 * 60 * 15;

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
    security.antiBot ? 'Anti-bots Top.gg' : null,
    security.antiAlt ? 'Anti-alts' : null,
    security.antiNuke ? 'Anti-nuke' : null
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
    this.lastFloodWarnings = new Map();
    this.topGgBotCache = new Map();
    this.securityLabBotIds = parseIdList(config.SECURITY_LAB_BOT_IDS);
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
    const isolation = await this.isolateFloodActor(message, security, {
      repeated: true,
      flooding: true,
      repeatWarning: true,
      reasonOverride: `NexaDesk Security Guard: ${analysis.reason || 'spam detectado por IA'}`
    });

    await this.sendSecurityLog({
      guild: message.guild,
      config: security,
      title: 'Spam IA bloqueado',
      description: `${message.author} envio contenido clasificado como spam, raid o promocion fraudulenta. NexaDesk limpio la rafaga reciente del autor.`,
      fields: [
        ...buildSpamThreatFields({ message, analysis }),
        { name: 'Mensajes borrados', value: String(deleted), inline: true },
        { name: 'Aislamiento', value: isolation }
      ],
      important: true
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
    const isolation = await this.isolateFloodActor(message, security, {
      repeated: true,
      flooding: true,
      repeatWarning: true,
      reasonOverride: 'NexaDesk Security Guard: mention spam o ping masivo'
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
    const security = normalizeSecurityConfig(guildConfig?.security);
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
          await this.sendSecurityLog({
            guild: member.guild,
            config: security,
            title: 'Anti-bots sin verificacion Top.gg',
            description: `Ha entrado el bot ${member.user.tag}, pero NexaDesk no pudo confirmar su estado en Top.gg. No se banea sin certeza.`,
            fields: [
              { name: 'Bot', value: `${member.user.tag} (${member.user.id})`, inline: true },
              { name: 'Top.gg', value: describeTopGgLookup(topGgDecision.lookup) },
              { name: 'Accion', value: 'Permitido temporalmente. Revisa manualmente si no reconoces este bot.' }
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
    const topGgDecision = await this.shouldBanBotBecauseMissingTopGg(executor);
    const updatedPermissions = newRole.permissions.remove(PermissionFlagsBits.Administrator);
    if (newRole.editable) {
      await newRole.setPermissions(updatedPermissions, 'NexaDesk Security Guard: bot gave Administrator').catch(() => null);
    }
    if (topGgDecision.shouldBan && botMember?.bannable) {
      await botMember.ban({ reason: 'NexaDesk Security Guard: bot gave Administrator permissions' }).catch(() => null);
    }

    await this.sendSecurityLog({
      guild: newRole.guild,
      config: security,
      title: 'Bot elevando permisos',
      description: `${executor.tag} intento dar Administrator al rol ${newRole.name}.`,
      fields: [
        { name: 'Rol', value: `${newRole.name} (${newRole.id})`, inline: true },
        { name: 'Top.gg', value: describeTopGgLookup(topGgDecision.lookup) },
        { name: 'Respuesta', value: `${newRole.editable ? 'Permiso Administrator retirado' : 'No pude editar el rol'} / ${topGgDecision.shouldBan && botMember?.bannable ? 'bot baneado' : 'bot no baneado por politica Top.gg o permisos'}` }
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
    const topGgDecision = member?.user?.bot
      ? (botTopGgDecision ?? await this.shouldBanBotBecauseMissingTopGg(member.user))
      : { shouldBan: true, lookup: null };
    const canBan = Boolean(
      member?.bannable
      && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)
      && (!member.user.bot || topGgDecision.shouldBan)
      && !this.isSecurityLabBot(member.user.id)
    );
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
        member?.user?.bot ? { name: 'Top.gg', value: describeTopGgLookup(topGgDecision.lookup) } : null,
        { name: 'Respuesta', value: this.isSecurityLabBot(member?.user?.id) ? 'Simulacion registrada. Bot de laboratorio no aislado.' : canBan ? 'Ban preventivo aplicado' : 'No pude banear por permisos, jerarquia o politica Top.gg' }
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
    const lookup = await this.lookupTopGgBot(user.id);
    return {
      shouldBan: lookup.status === 'not_listed',
      lookup
    };
  }

  isSecurityLabBot(userId) {
    return Boolean(userId && this.securityLabBotIds.has(String(userId)));
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

  async sendSecurityLog({ guild, config, title, description, fields = [], important = false }) {
    const embed = new EmbedBuilder()
      .setColor(0xffffff)
      .setTitle(`${EMOJIS.wifi} NexaDesk Security Guard - ${title}`)
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
  return lookup.reason || 'Estado Top.gg desconocido.';
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
