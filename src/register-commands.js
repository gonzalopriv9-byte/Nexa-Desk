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
    .toJSON(),
  new SlashCommandBuilder()
    .setName('seguridad')
    .setDescription('Configura NexaDesk Security Guard para anti-raid y moderacion preventiva.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Muestra la configuracion de seguridad del servidor.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('configurar')
        .setDescription('Activa o ajusta el sistema de seguridad del servidor.')
        .addStringOption((option) =>
          option
            .setName('nivel')
            .setDescription('Nivel de proteccion recomendado.')
            .addChoices(
              { name: 'Bajo', value: 'low' },
              { name: 'Intermedio', value: 'medium' },
              { name: 'Alto', value: 'high' }
            )
            .setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName('canal_logs')
            .setDescription('Canal donde NexaDesk enviara alertas de seguridad.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName('edad_minima_dias')
            .setDescription('Edad minima de cuenta para anti-alts.')
            .setMinValue(0)
            .setMaxValue(90)
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('antiflood')
            .setDescription('Borrar spam rapido y aplicar timeout si se repite.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('antibots')
            .setDescription('Bloquear bots no verificados.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('antialts')
            .setDescription('Bloquear cuentas demasiado nuevas.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('antinuke')
            .setDescription('Vigilar audit logs contra acciones masivas.')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('desactivar')
        .setDescription('Desactiva Security Guard en este servidor.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Gestiona la blacklist global de NexaDesk.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('agregar')
        .setDescription('Agrega un usuario a la blacklist global.')
        .addStringOption((option) =>
          option
            .setName('usuario_id')
            .setDescription('ID del usuario a bloquear globalmente.')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('motivo')
            .setDescription('Motivo que vera el usuario en el MD de baneo.')
            .setRequired(true)
            .setMaxLength(1000)
        )
        .addStringOption((option) =>
          option
            .setName('duracion')
            .setDescription('Ej: permanente, 7d, 30d, 12h.')
            .setRequired(false)
            .setMaxLength(80)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('quitar')
        .setDescription('Desactiva una entrada de blacklist global.')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('ID del usuario o codigo baneo-global-[USER].')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('ver')
        .setDescription('Muestra una entrada de blacklist global.')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('ID del usuario o codigo baneo-global-[USER].')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('listar')
        .setDescription('Lista las entradas activas de blacklist global.')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('adjuntar-pruebas')
    .setDescription('Adjunta pruebas a un baneo global de NexaDesk.')
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('ID del usuario o codigo baneo-global-[USER].')
        .setRequired(true)
    )
    .addAttachmentOption((option) =>
      option
        .setName('archivo')
        .setDescription('Imagen o archivo de prueba.')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('descripcion')
        .setDescription('Descripcion opcional de la prueba.')
        .setRequired(false)
        .setMaxLength(400)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('activarpremium')
    .setDescription('Activa todas las funciones premium para un servidor.')
    .addStringOption((option) =>
      option
        .setName('servidor')
        .setDescription('ID del servidor donde se activara premium.')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('ayuda')
    .setDescription('Abre la guia interactiva de NexaDesk.')
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
