import { REST, Routes, ChannelType } from 'discord.js';
import { buildRestGuildBackupSnapshot, restoreGuildBackupWithRest } from './backups.js';
import { buildPanelActionRow, buildPanelEmbed, normalizePanelOptions } from './panel-options.js';
import { analyzeGuildChannelsForDiscovery } from './server-discovery.js';

export function createDiscordRestActions({ config, storage }) {
  const botToken = config.DISCORD_TOKEN?.trim();
  const rest = new REST({ version: '10' });
  if (botToken) {
    rest.setToken(botToken);
  }

  return {
    async createTicketCategory({ guildId, name }) {
      requireBotToken(botToken);
      const guild = await rest.get(Routes.guild(guildId));
      const category = await rest.post(Routes.guildChannels(guildId), {
        body: {
          name,
          type: ChannelType.GuildCategory
        }
      });

      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        ticketCategoryId: category.id,
        ticketCategoryName: category.name
      });
    },

    async createTicketPanel({ guildId, channelId, ...panelInput }) {
      requireBotToken(botToken);
      const guild = await rest.get(Routes.guild(guildId));
      const panel = normalizePanelOptions(panelInput);
      const existing = await storage.getGuildConfig(guildId);
      const message = await rest.post(Routes.channelMessages(channelId), {
        body: {
          embeds: [buildPanelEmbed(panel)],
          components: [buildPanelActionRow(panel, existing?.components ?? [])]
        }
      });

      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        panels: [
          ...(existing?.panels ?? []),
          {
            channelId,
            channelName: panelInput.channelName,
            messageId: message.id,
            ...panel,
            createdAt: new Date().toISOString()
          }
        ]
      });
    },

    async updateTicketPanel({ guildId, messageId, ...panelInput }) {
      requireBotToken(botToken);
      const guild = await rest.get(Routes.guild(guildId));
      const existing = await storage.getGuildConfig(guildId);
      const currentPanel = existing?.panels?.find((panel) => panel.messageId === messageId);
      if (!currentPanel) throw new Error('No encuentro ese panel en la configuracion guardada.');

      const channelId = currentPanel.channelId;
      const panel = normalizePanelOptions({
        ...currentPanel,
        ...panelInput,
        channelId,
        channelName: currentPanel.channelName
      });
      await rest.patch(Routes.channelMessage(channelId, messageId), {
        body: {
          embeds: [buildPanelEmbed(panel)],
          components: [buildPanelActionRow(panel, existing?.components ?? [])]
        }
      });

      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        panels: (existing?.panels ?? []).map((item) => item.messageId === messageId
          ? {
              ...item,
              ...panel,
              channelId,
              channelName: currentPanel.channelName,
              messageId,
              updatedAt: new Date().toISOString()
            }
          : item)
      });
    },

    async deleteTicketPanel({ guildId, messageId }) {
      requireBotToken(botToken);
      const guild = await rest.get(Routes.guild(guildId));
      const existing = await storage.getGuildConfig(guildId);
      const currentPanel = existing?.panels?.find((panel) => panel.messageId === messageId);
      if (!currentPanel) throw new Error('No encuentro ese panel en la configuracion guardada.');

      await rest.delete(Routes.channelMessage(currentPanel.channelId, messageId)).catch((error) => {
        console.warn(`Could not delete panel message ${messageId}:`, error?.message ?? error);
      });

      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        panels: (existing?.panels ?? []).filter((item) => item.messageId !== messageId)
      });
    },

    async refreshTicketPanels({ guildId }) {
      requireBotToken(botToken);
      const guild = await rest.get(Routes.guild(guildId));
      const existing = await storage.getGuildConfig(guildId);
      const panels = existing?.panels ?? [];
      const refreshedAt = new Date().toISOString();

      for (const panel of panels) {
        await rest.patch(Routes.channelMessage(panel.channelId, panel.messageId), {
          body: {
            embeds: [buildPanelEmbed(panel)],
            components: [buildPanelActionRow(panel, existing?.components ?? [])]
          }
        }).catch((error) => {
          console.warn(`Could not refresh panel ${panel.messageId}:`, error?.message ?? error);
        });
      }

      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        panels: panels.map((panel) => ({ ...panel, refreshedAt }))
      });
    },

    async listGuildRoles({ guildId }) {
      requireBotToken(botToken);
      const roles = await rest.get(Routes.guildRoles(guildId));
      return roles
        .filter((role) => role.name !== '@everyone')
        .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0))
        .map((role) => ({
          id: role.id,
          name: role.name,
          color: role.color,
          position: role.position
        }));
    },

    async listGuildChannels({ guildId }) {
      requireBotToken(botToken);
      const channels = await rest.get(Routes.guildChannels(guildId));
      return channels
        .filter((channel) => (
          channel.type === ChannelType.GuildText
          || channel.type === ChannelType.GuildAnnouncement
          || channel.type === ChannelType.GuildForum
          || channel.type === ChannelType.GuildCategory
        ))
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parent_id
        }));
    },

    async refreshGuildDiscovery({ guildId, reason = 'dashboard' }) {
      requireBotToken(botToken);
      const [guild, channels] = await Promise.all([
        rest.get(Routes.guild(guildId)),
        rest.get(Routes.guildChannels(guildId))
      ]);
      const discovery = analyzeGuildChannelsForDiscovery(channels);
      const existing = await storage.getGuildConfig(guildId).catch(() => null);
      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        discovery: {
          ...(existing?.discovery ?? {}),
          ...discovery,
          reason
        }
      });
    },

    async captureGuildBackup({ guildId, source = 'dashboard' }) {
      requireBotToken(botToken);
      const [guild, channels, roles] = await Promise.all([
        rest.get(Routes.guild(guildId)),
        rest.get(Routes.guildChannels(guildId)),
        rest.get(Routes.guildRoles(guildId))
      ]);
      const snapshot = buildRestGuildBackupSnapshot({ guild, channels, roles, source });
      const saved = await storage.saveGuildBackupSnapshot(snapshot);
      await storage.addGuildLog?.({
        guildId,
        guildName: saved.guildName,
        type: 'security',
        severity: 'success',
        title: 'Backup capturado',
        message: `Snapshot guardado con ${saved.summary.roles} roles y ${saved.summary.channels} canales.`,
        metadata: { backupId: saved.id, source: saved.source, summary: saved.summary }
      }).catch(() => {});
      return saved;
    },

    async restoreGuildBackup({ backupId, targetGuildId, requestedBy = null }) {
      requireBotToken(botToken);
      const backup = await storage.getGuildBackupSnapshot(backupId);
      if (!backup) throw new Error('No encuentro ese backup en Supabase.');
      const targetGuild = await rest.get(Routes.guild(targetGuildId));
      const result = await restoreGuildBackupWithRest({
        rest,
        backup,
        targetGuildId,
        targetGuild,
        requestedBy
      });
      const saved = await storage.recordGuildBackupRestore?.(result);
      await storage.addGuildLog?.({
        guildId: targetGuildId,
        guildName: result.targetGuildName,
        type: 'security',
        severity: result.status === 'completed' ? 'success' : 'warning',
        title: 'Backup restaurado',
        message: `Restaurado desde ${result.sourceGuildName}: ${result.summary.rolesCreated} roles y ${result.summary.channelsCreated} canales creados.`,
        metadata: { backupId, restoreId: result.id, summary: result.summary, requestedBy }
      }).catch(() => {});
      return saved ?? result;
    },

    async listInstalledGuildIds() {
      requireBotToken(botToken);
      const guilds = await rest.get(Routes.userGuilds());
      return guilds.map((guild) => guild.id);
    },

    async sendChannelMessage({ channelId, payload }) {
      requireBotToken(botToken);
      return rest.post(Routes.channelMessages(channelId), {
        body: payload
      });
    }
  };
}

function requireBotToken(botToken) {
  if (!botToken) {
    throw new Error('Falta DISCORD_TOKEN en Render. Pon el token actual del bot en Environment y redeploy para cargar roles, canales y paneles.');
  }
}
