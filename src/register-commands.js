import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import { config } from './config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configura la categoria donde se crean los tickets.')
    .addChannelOption((option) =>
      option
        .setName('category')
        .setDescription('Categoria donde otros bots crean tickets.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

const useGuildScope = process.argv.includes('--guild');
const route = useGuildScope && config.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
  : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

if (useGuildScope && !config.DISCORD_GUILD_ID) {
  throw new Error('Set DISCORD_GUILD_ID in .env or register global commands without --guild.');
}

await rest.put(route, { body: commands });

console.log(`Registered NexaDesk slash commands ${useGuildScope ? 'for guild' : 'globally'}.`);
