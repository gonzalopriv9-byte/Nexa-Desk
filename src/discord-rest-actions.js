import { REST, Routes, ChannelType } from 'discord.js';

export function createDiscordRestActions({ config, storage }) {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  return {
    async createTicketCategory({ guildId, name }) {
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

    async createTicketPanel({ guildId, channelId, title, description, buttonLabel }) {
      const guild = await rest.get(Routes.guild(guildId));
      const message = await rest.post(Routes.channelMessages(channelId), {
        body: {
          embeds: [
            {
              title,
              description,
              color: 0x4bd8ee,
              footer: { text: 'NexaDesk AI Support' }
            }
          ],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  custom_id: 'nexadesk:create_ticket',
                  label: buttonLabel
                }
              ]
            }
          ]
        }
      });

      const existing = await storage.getGuildConfig(guildId);
      return storage.upsertGuildConfig(guildId, {
        guildName: guild.name,
        panels: [
          ...(existing?.panels ?? []),
          {
            channelId,
            messageId: message.id,
            title,
            buttonLabel,
            createdAt: new Date().toISOString()
          }
        ]
      });
    },

    async listGuildRoles({ guildId }) {
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
      const guilds = await rest.get(Routes.userGuilds());
      return guilds.map((guild) => guild.id);
    }
  };
}
