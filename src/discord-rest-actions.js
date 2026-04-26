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
    }
  };
}
