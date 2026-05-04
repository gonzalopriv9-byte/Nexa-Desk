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
    .toJSON(),
  new SlashCommandBuilder()
    .setName('desactivar')
    .setDescription('Desactiva funciones de NexaDesk en el ticket actual.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('ia')
        .setDescription('Desactiva la IA en este ticket para que el staff lo atienda manualmente.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('activar')
    .setDescription('Reactiva funciones de NexaDesk en el ticket actual.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('ia')
        .setDescription('Reactiva la IA en este ticket si el staff quiere devolverlo a NexaDesk.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Herramientas profesionales para gestionar el ticket actual.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Muestra estado, IA, staff y transcripcion del ticket actual.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('resumen')
        .setDescription('Genera un briefing del ticket para que el staff entre con contexto.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cerrar')
        .setDescription('Cierra el ticket, envia transcripcion por MD y elimina el canal.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voz')
    .setDescription('Soporte por voz privado para servidores Pro.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('crear')
        .setDescription('Crea una sala de voz privada vinculada al ticket actual.')
        .addStringOption((option) =>
          option
            .setName('nombre')
            .setDescription('Nombre opcional para la sala de voz.')
            .setMaxLength(60)
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Muestra la sala de voz vinculada al ticket actual.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cerrar')
        .setDescription('Cierra la sala de voz vinculada al ticket actual.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('transcripcion')
    .setDescription('Gestiona transcripciones de tickets.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enviar')
        .setDescription('Envia la transcripcion del ticket por MD al usuario.')
        .addUserOption((option) =>
          option
            .setName('usuario')
            .setDescription('Usuario al que se enviara la transcripcion. Si se omite, se usa el opener del ticket.')
            .setRequired(false)
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('globalstats')
    .setDescription('Muestra estadisticas globales de NexaDesk.')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

const useGuildScope = process.argv.includes('--guild');
const clearGuildScope = process.argv.includes('--clear-guild');
const route = useGuildScope && config.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
  : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

if ((useGuildScope || clearGuildScope) && !config.DISCORD_GUILD_ID) {
  throw new Error('Set DISCORD_GUILD_ID in .env before using --guild or --clear-guild.');
}

if (clearGuildScope) {
  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
    { body: [] }
  );
  console.log('Cleared NexaDesk guild slash commands.');
}

await rest.put(route, { body: commands });

console.log(`Registered NexaDesk slash commands ${useGuildScope ? 'for guild' : 'globally'}.`);
