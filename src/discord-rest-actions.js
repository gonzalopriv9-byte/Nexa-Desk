import { REST, Routes, ChannelType } from 'discord.js';
import { buildPanelActionRow, buildPanelEmbed, normalizePanelOptions } from './panel-options.js';

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
        .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildCategory)
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parent_id
        }));
    },

    async listInstalledGuildIds() {
      requireBotToken(botToken);
      const guilds = await rest.get(Routes.userGuilds());
      return guilds.map((guild) => guild.id);
    }
  };
}

function requireBotToken(botToken) {
  if (!botToken) {
    throw new Error('Falta DISCORD_TOKEN en Render. Pon el token actual del bot en Environment y redeploy para cargar roles, canales y paneles.');
  }
}
