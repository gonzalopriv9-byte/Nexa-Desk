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
    .addRoleOption((option) =>
      option
        .setName('rol_staff')
        .setDescription('Rol que NexaDesk mencionara cuando escale un ticket.')
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName('canal_alianzas')
        .setDescription('Canal donde NexaDesk enviara plantillas de alianzas verificadas.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName('plantilla_alianza')
        .setDescription('Plantilla de alianza de este servidor que NexaDesk enviara al usuario.')
        .setMaxLength(1800)
        .setRequired(false)
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
    .setName('musica')
    .setDescription('Musica de alta calidad con cola y autocola IA.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reproducir')
        .setDescription('Busca y reproduce una cancion o enlace.')
        .addStringOption((option) =>
          option
            .setName('consulta')
            .setDescription('Titulo, artista o enlace.')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('buscar')
        .setDescription('Busca canciones rapido antes de reproducir.')
        .addStringOption((option) =>
          option
            .setName('consulta')
            .setDescription('Titulo o artista.')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cola')
        .setDescription('Muestra la cancion actual y la cola.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('saltar')
        .setDescription('Salta la cancion actual.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('parar')
        .setDescription('Para la musica y limpia la cola.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('pausa')
        .setDescription('Pausa la reproduccion actual.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('continuar')
        .setDescription('Reanuda la reproduccion pausada.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('volumen')
        .setDescription('Ajusta el volumen de la musica.')
        .addIntegerOption((option) =>
          option
            .setName('porcentaje')
            .setDescription('Volumen entre 1 y 150.')
            .setMinValue(1)
            .setMaxValue(150)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('autocola')
        .setDescription('Activa o desactiva la autocola con IA.')
        .addBooleanOption((option) =>
          option
            .setName('activo')
            .setDescription('Estado de la autocola IA.')
            .setRequired(true)
        )
    )
    .toJSON(),
  ...buildDirectMusicCommands(),
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
    .setName('diagnostico')
    .setDescription('Audita si NexaDesk esta listo para operar en este servidor.')
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
            .setName('antilinks')
            .setDescription('Revisar links con IA y bloquear phishing, scams o malware.')
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

function buildDirectMusicCommands() {
  return [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Busca en Spotify y reproduce una cancion o enlace.')
      .addStringOption((option) =>
        option
          .setName('query')
          .setDescription('Titulo, artista, enlace de Spotify o enlace de YouTube.')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Busca canciones rapido antes de reproducir.')
      .addStringOption((option) =>
        option
          .setName('query')
          .setDescription('Titulo o artista.')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Muestra la cancion actual y la cola.'),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Salta la cancion actual.'),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Para la musica y limpia la cola.'),
    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('Pausa la reproduccion actual.'),
    new SlashCommandBuilder()
      .setName('continue')
      .setDescription('Reanuda la reproduccion pausada.'),
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Ajusta el volumen de la musica.')
      .addIntegerOption((option) =>
        option
          .setName('percent')
          .setDescription('Volumen entre 1 y 150.')
          .setMinValue(1)
          .setMaxValue(150)
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('autoplay')
      .setDescription('Activa o desactiva la autocola con IA.')
      .addBooleanOption((option) =>
        option
          .setName('enabled')
          .setDescription('Estado de la autocola IA.')
          .setRequired(true)
      )
  ].map((command) => command.toJSON());
}

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
