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
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
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
    .setName('crecimiento')
    .setDescription('Gestiona Growth Engine: feedback, reviews y alertas premium.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Muestra metricas y configuracion de crecimiento del servidor.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('configurar')
        .setDescription('Configura feedback post-ticket, reviews publicas y Churn Radar.')
        .addChannelOption((option) =>
          option
            .setName('canal_reviews')
            .setDescription('Canal donde publicar reviews y alertas de Growth Engine.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('activo')
            .setDescription('Activa o pausa Growth Engine.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('pedir_feedback')
            .setDescription('Pedir valoracion por MD al cerrar tickets.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('reviews_publicas')
            .setDescription('Publicar automaticamente reviews positivas en el canal configurado. Premium.')
            .setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName('rating_publico_min')
            .setDescription('Rating minimo para publicar review publica.')
            .setMinValue(4)
            .setMaxValue(5)
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('alertas_bajas')
            .setDescription('Avisar al staff cuando un ticket reciba baja valoracion. Premium.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('cta_invitar')
            .setDescription('Preparar llamadas a la accion para convertir buen soporte en crecimiento.')
            .setRequired(false)
        )
    )
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
            .setName('automod')
            .setDescription('Revisar contenido ofensivo/malicioso con XN Protect Automod.')
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName('antibots')
            .setDescription('Bloquear solo bots que no aparezcan listados en Top.gg.')
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
    .setName('dmowner')
    .setDescription('Reenvia el MD de bienvenida al owner y al usuario que agrego NexaDesk.')
    .addStringOption((option) =>
      option
        .setName('servidor')
        .setDescription('ID del servidor al que se enviara el onboarding.')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Genera un codigo temporal de un solo uso para entrar a /admin.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mantenimiento')
    .setDescription('Controla el modo mantenimiento global de NexaDesk.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Muestra si el modo mantenimiento global esta activo.')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('activar')
        .setDescription('Activa mantenimiento para servidores Free.')
        .addStringOption((option) =>
          option
            .setName('mensaje')
            .setDescription('Mensaje publico opcional que se mostrara al abrir tickets Free.')
            .setMaxLength(500)
            .setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName('delay_segundos')
            .setDescription('Ralentizacion de IA para Free. Recomendado: 3 a 5 segundos.')
            .setMinValue(1)
            .setMaxValue(15)
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('desactivar')
        .setDescription('Desactiva el modo mantenimiento global.')
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
  if (!useGuildScope) {
    process.exit(0);
  }
}

await rest.put(route, { body: commands });

console.log(`Registered NexaDesk slash commands ${useGuildScope ? 'for guild' : 'globally'}.`);
