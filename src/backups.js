import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits, Routes } from 'discord.js';

export const BACKUP_VERSION = 1;
const MAX_BACKUP_ROLES = 240;
const MAX_BACKUP_CHANNELS = 500;
const RESTORABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

export function normalizeGuildBackupSnapshot(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const snapshot = source.snapshot && typeof source.snapshot === 'object' ? source.snapshot : source;
  const guild = snapshot.guild && typeof snapshot.guild === 'object' ? snapshot.guild : {};
  const roles = Array.isArray(snapshot.roles) ? snapshot.roles.map(normalizeBackupRole).filter(Boolean) : [];
  const channels = Array.isArray(snapshot.channels) ? snapshot.channels.map(normalizeBackupChannel).filter(Boolean) : [];
  const capturedAt = source.capturedAt ?? source.captured_at ?? snapshot.capturedAt ?? new Date().toISOString();
  const sourceGuildId = String(source.guildId ?? source.guild_id ?? snapshot.guildId ?? guild.id ?? '');
  const sourceGuildName = String(source.guildName ?? source.guild_name ?? snapshot.guildName ?? guild.name ?? 'Servidor').slice(0, 160);
  const summary = normalizeBackupSummary(source.summary, { roles, channels });
  return {
    id: source.id ? String(source.id) : `backup-${sourceGuildId || 'guild'}-${Date.now()}-${crypto.randomUUID()}`,
    version: Number(source.version ?? snapshot.version ?? BACKUP_VERSION) || BACKUP_VERSION,
    guildId: sourceGuildId,
    guildName: sourceGuildName,
    capturedAt,
    source: String(source.source ?? snapshot.source ?? 'scheduled').slice(0, 80),
    summary,
    snapshot: {
      version: Number(snapshot.version ?? BACKUP_VERSION) || BACKUP_VERSION,
      guildId: sourceGuildId,
      guildName: sourceGuildName,
      capturedAt,
      guild: {
        id: String(guild.id ?? sourceGuildId),
        name: String(guild.name ?? sourceGuildName).slice(0, 160),
        description: guild.description ? String(guild.description).slice(0, 1024) : null,
        preferredLocale: guild.preferredLocale ?? guild.preferred_locale ?? null,
        verificationLevel: guild.verificationLevel ?? guild.verification_level ?? null,
        explicitContentFilter: guild.explicitContentFilter ?? guild.explicit_content_filter ?? null,
        defaultMessageNotifications: guild.defaultMessageNotifications ?? guild.default_message_notifications ?? null,
        afkTimeout: guild.afkTimeout ?? guild.afk_timeout ?? null
      },
      roles,
      channels,
      meta: {
        ...(snapshot.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {}),
        roleCount: roles.length,
        channelCount: channels.length
      }
    },
    createdAt: source.createdAt ?? source.created_at ?? capturedAt
  };
}

export async function buildGatewayGuildBackupSnapshot(guild, { source = 'scheduled' } = {}) {
  const [channels, roles] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch()
  ]);

  return normalizeGuildBackupSnapshot({
    guildId: guild.id,
    guildName: guild.name,
    source,
    capturedAt: new Date().toISOString(),
    snapshot: {
      version: BACKUP_VERSION,
      guildId: guild.id,
      guildName: guild.name,
      source,
      capturedAt: new Date().toISOString(),
      guild: serializeGatewayGuild(guild),
      roles: [...roles.values()]
        .map(serializeGatewayRole)
        .filter(Boolean)
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .slice(0, MAX_BACKUP_ROLES),
      channels: [...channels.values()]
        .map(serializeGatewayChannel)
        .filter(Boolean)
        .sort(compareBackupChannels)
        .slice(0, MAX_BACKUP_CHANNELS)
    }
  });
}

export function buildRestGuildBackupSnapshot({ guild, channels = [], roles = [], source = 'dashboard' }) {
  const capturedAt = new Date().toISOString();
  return normalizeGuildBackupSnapshot({
    guildId: guild.id,
    guildName: guild.name,
    source,
    capturedAt,
    snapshot: {
      version: BACKUP_VERSION,
      guildId: guild.id,
      guildName: guild.name,
      source,
      capturedAt,
      guild: serializeRestGuild(guild),
      roles: roles
        .map(serializeRestRole)
        .filter(Boolean)
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .slice(0, MAX_BACKUP_ROLES),
      channels: channels
        .map(serializeRestChannel)
        .filter(Boolean)
        .sort(compareBackupChannels)
        .slice(0, MAX_BACKUP_CHANNELS)
    }
  });
}

export async function restoreGuildBackupWithRest({ rest, backup, targetGuildId, targetGuild, requestedBy = null }) {
  const normalized = normalizeGuildBackupSnapshot(backup);
  const source = normalized.snapshot;
  const startedAt = new Date().toISOString();
  const roleMap = new Map([[source.guildId, targetGuildId]]);
  const channelMap = new Map();
  const createdRoles = [];
  const createdChannels = [];
  const skipped = [];
  const errors = [];

  const restorableRoles = source.roles
    .filter((role) => role.name !== '@everyone' && !role.managed)
    .filter((role) => !isAdministratorPermission(role.permissions))
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

  for (const role of restorableRoles) {
    try {
      const created = await rest.post(Routes.guildRoles(targetGuildId), {
        body: {
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: role.permissions
        },
        reason: buildRestoreReason(normalized, requestedBy)
      });
      roleMap.set(role.id, created.id);
      createdRoles.push({ sourceId: role.id, targetId: created.id, name: created.name ?? role.name });
    } catch (error) {
      skipped.push(`Rol ${role.name}: ${error?.message ?? 'no creado'}`);
      errors.push({ type: 'role', name: role.name, message: error?.message ?? String(error) });
    }
  }

  await updateRolePositions(rest, targetGuildId, createdRoles, source.roles).catch((error) => {
    skipped.push(`No pude ordenar todos los roles: ${error?.message ?? error}`);
  });

  const categories = source.channels.filter((channel) => channel.type === ChannelType.GuildCategory);
  const children = source.channels.filter((channel) => channel.type !== ChannelType.GuildCategory);
  for (const channel of [...categories, ...children]) {
    if (!RESTORABLE_CHANNEL_TYPES.has(channel.type)) {
      skipped.push(`Canal ${channel.name}: tipo no restaurable (${channel.type}).`);
      continue;
    }
    try {
      const body = buildCreateChannelBody(channel, { roleMap, channelMap, sourceGuildId: source.guildId, targetGuildId });
      const created = await rest.post(Routes.guildChannels(targetGuildId), {
        body,
        reason: buildRestoreReason(normalized, requestedBy)
      });
      channelMap.set(channel.id, created.id);
      createdChannels.push({ sourceId: channel.id, targetId: created.id, name: created.name ?? channel.name, type: channel.type });
    } catch (error) {
      skipped.push(`Canal ${channel.name}: ${error?.message ?? 'no creado'}`);
      errors.push({ type: 'channel', name: channel.name, message: error?.message ?? String(error) });
    }
  }

  return {
    id: `restore-${targetGuildId}-${Date.now()}-${crypto.randomUUID()}`,
    backupId: normalized.id,
    sourceGuildId: normalized.guildId,
    sourceGuildName: normalized.guildName,
    targetGuildId,
    targetGuildName: targetGuild?.name ?? targetGuildId,
    requestedBy,
    status: errors.length ? 'partial' : 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    summary: {
      rolesCreated: createdRoles.length,
      channelsCreated: createdChannels.length,
      skipped: skipped.slice(0, 25),
      errors: errors.slice(0, 25)
    },
    roleMap: Object.fromEntries(roleMap),
    channelMap: Object.fromEntries(channelMap)
  };
}

export function summarizeBackup(snapshot) {
  const normalized = normalizeGuildBackupSnapshot(snapshot);
  return normalized.summary;
}

function serializeGatewayGuild(guild) {
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description ?? null,
    preferredLocale: guild.preferredLocale ?? null,
    verificationLevel: guild.verificationLevel ?? null,
    explicitContentFilter: guild.explicitContentFilter ?? null,
    defaultMessageNotifications: guild.defaultMessageNotifications ?? null,
    afkTimeout: guild.afkTimeout ?? null
  };
}

function serializeRestGuild(guild) {
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description ?? null,
    preferredLocale: guild.preferred_locale ?? guild.preferredLocale ?? null,
    verificationLevel: guild.verification_level ?? guild.verificationLevel ?? null,
    explicitContentFilter: guild.explicit_content_filter ?? guild.explicitContentFilter ?? null,
    defaultMessageNotifications: guild.default_message_notifications ?? guild.defaultMessageNotifications ?? null,
    afkTimeout: guild.afk_timeout ?? guild.afkTimeout ?? null
  };
}

function serializeGatewayRole(role) {
  if (!role?.id || role.name === '@everyone') return null;
  return normalizeBackupRole({
    id: role.id,
    name: role.name,
    color: role.color ?? 0,
    hoist: role.hoist ?? false,
    mentionable: role.mentionable ?? false,
    managed: role.managed ?? false,
    position: role.position ?? 0,
    permissions: role.permissions?.bitfield?.toString?.() ?? String(role.permissions ?? '0')
  });
}

function serializeRestRole(role) {
  if (!role?.id || role.name === '@everyone') return null;
  return normalizeBackupRole({
    id: role.id,
    name: role.name,
    color: role.color ?? 0,
    hoist: role.hoist ?? false,
    mentionable: role.mentionable ?? false,
    managed: role.managed ?? false,
    position: role.position ?? 0,
    permissions: String(role.permissions ?? '0')
  });
}

function serializeGatewayChannel(channel) {
  if (!channel?.id || !RESTORABLE_CHANNEL_TYPES.has(channel.type)) return null;
  return normalizeBackupChannel({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: channel.rawPosition ?? channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? null,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    rtcRegion: channel.rtcRegion ?? null,
    videoQualityMode: channel.videoQualityMode ?? null,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
    permissionOverwrites: [...(channel.permissionOverwrites?.cache?.values?.() ?? [])].map((overwrite) => ({
      id: overwrite.id,
      type: Number(overwrite.type),
      allow: overwrite.allow?.bitfield?.toString?.() ?? '0',
      deny: overwrite.deny?.bitfield?.toString?.() ?? '0'
    }))
  });
}

function serializeRestChannel(channel) {
  if (!channel?.id || !RESTORABLE_CHANNEL_TYPES.has(channel.type)) return null;
  return normalizeBackupChannel({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parent_id ?? channel.parentId ?? null,
    position: channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rate_limit_per_user ?? channel.rateLimitPerUser ?? null,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.user_limit ?? channel.userLimit ?? null,
    rtcRegion: channel.rtc_region ?? channel.rtcRegion ?? null,
    videoQualityMode: channel.video_quality_mode ?? channel.videoQualityMode ?? null,
    defaultAutoArchiveDuration: channel.default_auto_archive_duration ?? channel.defaultAutoArchiveDuration ?? null,
    permissionOverwrites: Array.isArray(channel.permission_overwrites)
      ? channel.permission_overwrites
      : (Array.isArray(channel.permissionOverwrites) ? channel.permissionOverwrites : [])
  });
}

function normalizeBackupRole(role = {}) {
  if (!role?.id || !role?.name) return null;
  return {
    id: String(role.id),
    name: String(role.name).slice(0, 100),
    color: Number(role.color ?? 0) || 0,
    hoist: Boolean(role.hoist),
    mentionable: Boolean(role.mentionable),
    managed: Boolean(role.managed),
    position: Number(role.position ?? 0) || 0,
    permissions: String(role.permissions ?? '0')
  };
}

function normalizeBackupChannel(channel = {}) {
  if (!channel?.id || !channel?.name) return null;
  const parent = channel.parentId ?? channel.parent_id;
  return {
    id: String(channel.id),
    name: String(channel.name).slice(0, 100),
    type: Number(channel.type),
    parentId: parent ? String(parent) : null,
    position: Number(channel.position ?? 0) || 0,
    topic: channel.topic ? String(channel.topic).slice(0, 1024) : null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: nullableNumber(channel.rateLimitPerUser ?? channel.rate_limit_per_user),
    bitrate: nullableNumber(channel.bitrate),
    userLimit: nullableNumber(channel.userLimit ?? channel.user_limit),
    rtcRegion: channel.rtcRegion ?? channel.rtc_region ?? null,
    videoQualityMode: nullableNumber(channel.videoQualityMode ?? channel.video_quality_mode),
    defaultAutoArchiveDuration: nullableNumber(channel.defaultAutoArchiveDuration ?? channel.default_auto_archive_duration),
    permissionOverwrites: normalizePermissionOverwrites(channel.permissionOverwrites ?? channel.permission_overwrites)
  };
}

function normalizePermissionOverwrites(overwrites = []) {
  if (!Array.isArray(overwrites)) return [];
  return overwrites
    .map((overwrite) => ({
      id: overwrite?.id ? String(overwrite.id) : '',
      type: Number(overwrite?.type ?? 0),
      allow: String(overwrite?.allow ?? '0'),
      deny: String(overwrite?.deny ?? '0')
    }))
    .filter((overwrite) => overwrite.id && [0, 1].includes(overwrite.type))
    .slice(0, 120);
}

function normalizeBackupSummary(summary, { roles, channels }) {
  const source = summary && typeof summary === 'object' ? summary : {};
  const categories = channels.filter((channel) => channel.type === ChannelType.GuildCategory).length;
  const textChannels = channels.filter((channel) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)).length;
  const voiceChannels = channels.filter((channel) => [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)).length;
  return {
    roles: Number(source.roles ?? roles.length) || roles.length,
    channels: Number(source.channels ?? channels.length) || channels.length,
    categories: Number(source.categories ?? categories) || categories,
    textChannels: Number(source.textChannels ?? textChannels) || textChannels,
    voiceChannels: Number(source.voiceChannels ?? voiceChannels) || voiceChannels
  };
}

function compareBackupChannels(a, b) {
  const typeRank = (channel) => channel.type === ChannelType.GuildCategory ? 0 : 1;
  return (typeRank(a) - typeRank(b)) || ((a.position ?? 0) - (b.position ?? 0));
}

function buildCreateChannelBody(channel, { roleMap, channelMap, sourceGuildId, targetGuildId }) {
  const body = {
    name: channel.name,
    type: channel.type,
    permission_overwrites: mapPermissionOverwrites(channel.permissionOverwrites, {
      roleMap,
      sourceGuildId,
      targetGuildId
    })
  };
  if (channel.type !== ChannelType.GuildCategory && channel.parentId && channelMap.has(channel.parentId)) {
    body.parent_id = channelMap.get(channel.parentId);
  }
  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
    if (channel.topic) body.topic = channel.topic;
    body.nsfw = Boolean(channel.nsfw);
    if (channel.rateLimitPerUser !== null) body.rate_limit_per_user = channel.rateLimitPerUser;
    if (channel.defaultAutoArchiveDuration !== null) body.default_auto_archive_duration = channel.defaultAutoArchiveDuration;
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
    if (channel.bitrate !== null) body.bitrate = channel.bitrate;
    if (channel.userLimit !== null) body.user_limit = channel.userLimit;
    if (channel.rtcRegion) body.rtc_region = channel.rtcRegion;
    if (channel.videoQualityMode !== null) body.video_quality_mode = channel.videoQualityMode;
  }
  return body;
}

function mapPermissionOverwrites(overwrites, { roleMap, sourceGuildId, targetGuildId }) {
  return (overwrites ?? [])
    .map((overwrite) => {
      if (overwrite.type !== 0) return null;
      const mappedId = overwrite.id === sourceGuildId
        ? targetGuildId
        : roleMap.get(overwrite.id);
      if (!mappedId) return null;
      return {
        id: mappedId,
        type: 0,
        allow: overwrite.allow,
        deny: overwrite.deny
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

async function updateRolePositions(rest, targetGuildId, createdRoles, sourceRoles) {
  if (!createdRoles.length) return;
  const sourceById = new Map(sourceRoles.map((role) => [role.id, role]));
  const body = createdRoles
    .map((role) => ({
      id: role.targetId,
      position: Number(sourceById.get(role.sourceId)?.position ?? 1)
    }))
    .filter((item) => item.id && Number.isFinite(item.position));
  if (!body.length) return;
  await rest.patch(Routes.guildRoles(targetGuildId), {
    body,
    reason: 'NexaDesk backup restore role ordering'
  });
}

function buildRestoreReason(backup, requestedBy) {
  return `NexaDesk backup restore from ${backup.guildName} (${backup.guildId})${requestedBy ? ` requested by ${requestedBy}` : ''}`.slice(0, 512);
}

function isAdministratorPermission(permissions) {
  try {
    return (BigInt(String(permissions ?? '0')) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
  } catch {
    return false;
  }
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
