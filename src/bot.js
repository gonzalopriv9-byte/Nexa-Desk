import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { buildPanelActionRow, buildPanelEmbed, normalizePanelOptions, normalizeTicketComponent, panelWelcomeMessage } from './panel-options.js';
import { buildTranscriptFileName, buildTranscriptText } from './transcripts.js';
import { createWelcomeCard } from './welcome-card.js';

const EMOJIS = {
  wifi: '<a:wifi:1499732411829846116>',
  global: '<a:Global:1499728413974593708>'
};
const BOT_INVITE_PERMISSIONS = '322030608';
const PUBLIC_DASHBOARD_URL = 'https://nexa-desk.onrender.com/';
const PREMIUM_ADMIN_USER_ID = '1352652366330986526';

export function createBot({ config, storage, supportAgent, voiceManager = null }) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ];

  if (config.DISCORD_MESSAGE_CONTENT_INTENT) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  if (config.DISCORD_GUILD_MEMBERS_INTENT) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  const presence = buildBotPresence();
  const client = new Client({
    intents,
    presence
  });

  const activeResponses = new Set();
  const panelCreatedChannels = new Set();

  client.once(Events.ClientReady, (readyClient) => {
    applyBotPresence(readyClient);
    console.log(`NexaDesk online as ${readyClient.user.tag}`);
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      await handleGuildJoin({ guild, storage, config });
    } catch (error) {
      console.error(`Failed to send NexaDesk onboarding for guild ${guild.id}:`, error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === 'nexadesk:create_ticket') {
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const panel = findPanelForInteraction(guildConfig, interaction);
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, panelCreatedChannels, config, voiceManager });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:help:')) {
        await handleHelpButton({ interaction, config });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('nexadesk:select_ticket_component')) {
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const panel = findPanelForInteraction(guildConfig, interaction);
        const component = findTicketComponent(guildConfig, interaction.values?.[0]);
        if (!component) {
          await interaction.reply({ content: 'Este componente ya no existe. Actualiza el panel desde la dashboard.', ephemeral: true });
          return;
        }

        refreshPanelSelectMenu(interaction, guildConfig, panel);
        if (component.questions.length) {
          await interaction.showModal(buildTicketComponentModal(component));
          return;
        }

        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, component, panelCreatedChannels, config, voiceManager });
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('nexadesk:ticket_component_modal:')) {
        const componentId = interaction.customId.replace('nexadesk:ticket_component_modal:', '');
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const component = findTicketComponent(guildConfig, componentId);
        if (!component) {
          await interaction.reply({ content: 'Este componente ya no existe. Crea otro ticket desde un panel actualizado.', ephemeral: true });
          return;
        }

        const answers = component.questions.map((question, index) => ({
          question,
          answer: interaction.fields.getTextInputValue(`question_${index}`) || 'Sin respuesta'
        }));
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, component, answers, panelCreatedChannels, config, voiceManager });
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'setup') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: 'Necesitas permiso de Manage Server para configurar NexaDesk.', ephemeral: true });
          return;
        }

        const category = interaction.options.getChannel('category', true);
        if (category.type !== ChannelType.GuildCategory) {
          await interaction.reply({ content: 'Elige una categoria de canales valida.', ephemeral: true });
          return;
        }

        await storage.upsertGuildConfig(interaction.guildId, {
          guildName: interaction.guild.name,
          ticketCategoryId: category.id,
          ticketCategoryName: category.name
        });

        await interaction.reply({
          content: `Listo. NexaDesk vigilara tickets nuevos en la categoria **${category.name}**.`,
          ephemeral: true
        });
      }

      if (interaction.commandName === 'desactivar' && interaction.options.getSubcommand() === 'ia') {
        await handleDisableAiCommand({ interaction, storage });
        return;
      }

      if (interaction.commandName === 'activar' && interaction.options.getSubcommand() === 'ia') {
        await handleEnableAiCommand({ interaction, storage });
        return;
      }

      if (interaction.commandName === 'ticket') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'estado') {
          await handleTicketStatusCommand({ interaction, storage });
          return;
        }
        if (subcommand === 'resumen') {
          await handleTicketSummaryCommand({ interaction, storage, supportAgent });
          return;
        }
        if (subcommand === 'cerrar') {
          await handleCloseTicketCommand({ interaction, storage, client, voiceManager });
          return;
        }
      }

      if (interaction.commandName === 'voz') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'crear') {
          await handleVoiceCreateCommand({ interaction, storage, voiceManager });
          return;
        }
        if (subcommand === 'estado') {
          await handleVoiceStatusCommand({ interaction, storage });
          return;
        }
        if (subcommand === 'cerrar') {
          await handleVoiceCloseCommand({ interaction, storage, voiceManager });
          return;
        }
      }

      if (interaction.commandName === 'transcripcion' && interaction.options.getSubcommand() === 'enviar') {
        await handleSendTranscriptCommand({ interaction, storage });
        return;
      }

      if (interaction.commandName === 'globalstats') {
        await handleGlobalStatsCommand({ interaction, storage, client });
        return;
      }

      if (interaction.commandName === 'activarpremium') {
        await handleActivatePremiumCommand({ interaction, storage, client });
        return;
      }

      if (interaction.commandName === 'ayuda') {
        await handleHelpCommand({ interaction, config });
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      await safeInteractionReply(interaction, buildInteractionErrorMessage(error, config, interaction.guildId));
    }
  });

  client.on(Events.ChannelCreate, async (channel) => {
    try {
      if (!channel.guild || channel.type !== ChannelType.GuildText) return;

      const guildConfig = await storage.getGuildConfig(channel.guild.id);
      if (!guildConfig?.ticketCategoryId || channel.parentId !== guildConfig.ticketCategoryId) return;
      if (panelCreatedChannels.has(channel.id) || await storage.getTicket(channel.id)) return;
      if (await wasCreatedByNexaDeskPanel(channel)) return;

      const ticket = await storage.createTicket({
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        channelId: channel.id,
        channelName: channel.name,
        categoryId: channel.parentId
      });
      if (ticket.alreadyExists) return;

      const welcome = await channel.send([
        `${EMOJIS.global} Hola, soy **NexaDesk**.`,
        'Voy a ayudarte con este ticket. Cuentame que necesitas y, si hace falta, avisare al staff con un resumen claro.'
      ].join('\n'));
      await saveTranscript(storage, welcome, 'assistant');

      console.log(`Ticket detected: ${ticket.channelName} (${ticket.channelId})`);
    } catch (error) {
      console.error(`Failed to initialize ticket channel ${channel.id}:`, error);
    }
  });

  client.on(Events.ChannelDelete, async (channel) => {
    try {
      if (!channel.guild) return;

      if (channel.type === ChannelType.GuildVoice) {
        const ticket = await storage.getTicketByVoiceChannelId?.(channel.id);
        if (!ticket) return;
        voiceManager?.stopSession(channel.guild.id, channel.id);
        await storage.updateTicket(ticket.channelId, {
          voiceChannelId: null,
          voiceChannelName: null,
          voiceCreatedAt: null
        });
        await storage.addTranscriptMessage({
          guildId: ticket.guildId,
          channelId: ticket.channelId,
          messageId: `voice-delete-${Date.now()}`,
          authorId: client.user?.id,
          authorName: client.user?.username ?? 'NexaDesk',
          authorBot: true,
          role: 'system',
          content: `Sala de voz #${channel.name ?? channel.id} eliminada o cerrada.`,
          createdAt: new Date().toISOString()
        });
        return;
      }

      const ticket = await storage.getTicket(channel.id);
      if (!ticket || ticket.status === 'closed') return;

      if (ticket.voiceChannelId) voiceManager?.stopSession(channel.guild.id, ticket.voiceChannelId);
      await finalizeDeletedTicket({ client, storage, channel, ticket, voiceManager });
    } catch (error) {
      console.error(`Failed to finalize deleted ticket channel ${channel.id}:`, error);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild || !message.channel) return;

    const ticket = await storage.getTicket(message.channel.id);
    if (!ticket) return;

    await saveTranscript(storage, message, 'user');
    if (isClosedTicket(ticket)) return;

    // Always reload the latest server context before asking the AI.
    const guildConfig = await storage.getGuildConfig(message.guild.id);
    if (!guildConfig) return;

    if (isTicketCloseRequest(message.content)) {
      await handleNaturalCloseRequest({ client, storage, message, ticket, guildConfig });
      return;
    }

    if (!config.AI_AUTO_REPLY) return;
    if (activeResponses.has(message.channel.id)) return;
    if (isAiDisabledTicket(ticket)) return;

    activeResponses.add(message.channel.id);
    try {
      if (isUserRequestingStaff(message.content)) {
        const escalation = {
          shouldEscalate: true,
          reason: 'El usuario solicita asistencia manual de staff.',
          publicAnswer: 'El usuario solicita asistencia manual de staff.'
        };
        const shouldMentionStaff = await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: escalation.reason });
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket)) return;

        const reply = await message.reply({
          content: buildPublicReply(escalation, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
        return;
      }

      await message.channel.sendTyping();
      const answer = await supportAgent.answerTicketMessage({ message, ticket, guildConfig });
      if (answer) {
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket) || isAiDisabledTicket(latestTicket)) return;

        const escalation = parseEscalation(answer);
        const shouldMentionStaff = escalation.shouldEscalate
          ? await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: escalation.reason })
          : false;

        const reply = await message.reply({
          content: buildPublicReply(escalation, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
      }
    } catch (error) {
      console.error('AI response failed:', error);
      await message.reply('Ahora mismo no puedo consultar la IA. He dejado el ticket preparado para que el staff lo revise.');
    } finally {
      activeResponses.delete(message.channel.id);
    }
  });

  return client;
}

async function safeInteractionReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
      return;
    }

    await interaction.reply({ content, ephemeral: true });
  } catch (error) {
    console.error('Failed to report interaction error:', error);
  }
}

async function handleGuildJoin({ guild, storage, config }) {
  await storage.upsertGuildConfig(guild.id, {
    guildName: guild.name
  }).catch((error) => {
    console.error(`Failed to persist joined guild ${guild.id}:`, error);
  });

  const ownerMember = await guild.fetchOwner().catch(() => null);
  const ownerUser = ownerMember?.user;
  if (!ownerUser) {
    console.warn(`NexaDesk joined ${guild.name} (${guild.id}) but owner could not be fetched.`);
    return;
  }

  const embed = buildOwnerOnboardingEmbed({ guild, config });
  const components = buildOwnerOnboardingComponents(config);
  const welcomeCard = new AttachmentBuilder(createWelcomeCard({ guildName: guild.name }), {
    name: 'nexadesk-welcome.png'
  });
  await ownerUser.send({
    content: `Gracias de verdad por confiar en **NexaDesk** para **${guild.name}**.`,
    embeds: [embed],
    files: [welcomeCard],
    components
  });
  console.log(`Sent NexaDesk onboarding DM to owner ${ownerUser.tag} for ${guild.name} (${guild.id}).`);
}

function buildOwnerOnboardingEmbed({ guild }) {
  return new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.global} Gracias por confiar en NexaDesk`)
    .setImage('attachment://nexadesk-welcome.png')
    .setDescription([
      `Me acabo de unir a **${guild.name}**. Gracias muchisimo por darme un hueco en tu servidor.`,
      'NexaDesk esta pensado para que no tengas que cambiar tu sistema de tickets: puede trabajar con tus paneles actuales, con paneles propios y con IA para atender, ordenar y escalar casos al staff humano cuando haga falta.'
    ].join('\n\n'))
    .addFields(
      {
        name: '1. Primer setup',
        value: [
          `Abre la dashboard: ${PUBLIC_DASHBOARD_URL}`,
          'Elige este servidor, selecciona la categoria donde se crean tickets y configura el rol de staff.',
          'Si usas otro bot de tickets, pon la categoria donde ese bot crea los canales.',
          'Tambien puedes usar `/setup category:<categoria>` como configuracion rapida.'
        ].join('\n')
      },
      {
        name: '2. Que decirle a tu staff',
        value: [
          'Que NexaDesk respondera al usuario primero, pedira datos y escalara si detecta que hace falta una persona.',
          'Cuando un staff entre al ticket puede usar `/desactivar ia` para que la IA deje de escuchar y responder en ese canal.',
          'Para cerrar con transcript puede usar `/ticket cerrar`; para contexto rapido, `/ticket resumen`.'
        ].join('\n')
      },
      {
        name: '3. Como funciona NexaDesk',
        value: [
          'Lee el contexto del servidor guardado en la dashboard antes de responder.',
          'Guarda configuracion, paneles, tickets y transcripciones en Supabase para que puedas consultarlo desde la dashboard.',
          'Si activas Pro Voice, crea salas privadas vinculadas al ticket, transcribe voz y responde con TTS.'
        ].join('\n')
      },
      {
        name: '4. Datos y soporte',
        value: [
          'Los datos operativos del servidor se guardan para que NexaDesk recuerde configuracion, transcripciones y contexto.',
          'Si en cualquier momento necesitas ayuda, entra al soporte oficial:',
          'https://discord.gg/vVXbq7ePEZ'
        ].join('\n')
      }
    )
    .setFooter({ text: 'NexaDesk - AI support for every ticket' })
    .setTimestamp(new Date());
}

function buildOwnerOnboardingComponents(config) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Abrir dashboard')
        .setURL(PUBLIC_DASHBOARD_URL),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Soporte oficial')
        .setURL('https://discord.gg/vVXbq7ePEZ')
    )
  ];
}

function buildInteractionErrorMessage(error, config, guildId) {
  if (error?.code === 50013) {
    const inviteUrl = buildBotInviteUrl(config, guildId);
    return [
      'Discord no me deja completar esta accion por falta de permisos.',
      'Para crear tickets privados necesito **Manage Channels** y **Manage Roles** en la categoria configurada.',
      `Actualiza permisos aqui: ${inviteUrl}`,
      'Si ya lo hiciste, revisa que el rol de NexaDesk este por encima del rol de staff.'
    ].join('\n');
  }

  return 'Ha fallado esta accion. Ya he dejado el error en logs para revisarlo, prueba de nuevo en unos segundos.';
}

async function handleDisableAiCommand({ interaction, storage }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  const [ticket, guildConfig] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId)
  ]);

  if (!ticket) {
    await interaction.reply({ content: 'Este canal no esta registrado como ticket de NexaDesk.', ephemeral: true });
    return;
  }

  if (!guildConfig?.staffRoleId) {
    await interaction.reply({ content: 'Primero configura el rol de staff desde la dashboard.', ephemeral: true });
    return;
  }

  if (!memberHasRole(interaction.member, guildConfig.staffRoleId)) {
    await interaction.reply({ content: 'Solo el staff configurado para este servidor puede desactivar la IA.', ephemeral: true });
    return;
  }

  if (ticket.aiDisabled) {
    await interaction.reply({ content: 'La IA ya estaba desactivada en este ticket.', ephemeral: true });
    return;
  }

  const updated = await storage.updateTicket(interaction.channelId, {
    status: 'ai_disabled',
    aiDisabled: true,
    aiDisabledBy: interaction.user.id,
    aiDisabledAt: new Date().toISOString()
  });

  if (!updated) {
    await interaction.reply({ content: 'No pude actualizar este ticket. Intentalo de nuevo.', ephemeral: true });
    return;
  }

  await storage.addTranscriptMessage({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: interaction.id,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    authorBot: false,
    role: 'system',
    content: `IA desactivada por ${interaction.user.username}. El ticket pasa a atencion manual del staff.`,
    createdAt: new Date().toISOString()
  });

  await interaction.reply({
    content: 'IA desactivada en este ticket. NexaDesk dejara de escuchar y responder en este canal para que el staff lo atienda manualmente.'
  });
}

async function handleEnableAiCommand({ interaction, storage }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  const [ticket, guildConfig] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId)
  ]);

  if (!ticket) {
    await interaction.reply({ content: 'Este canal no esta registrado como ticket de NexaDesk.', ephemeral: true });
    return;
  }

  if (!guildConfig?.staffRoleId) {
    await interaction.reply({ content: 'Primero configura el rol de staff desde la dashboard.', ephemeral: true });
    return;
  }

  if (!memberHasRole(interaction.member, guildConfig.staffRoleId)) {
    await interaction.reply({ content: 'Solo el staff configurado para este servidor puede reactivar la IA.', ephemeral: true });
    return;
  }

  if (!isAiDisabledTicket(ticket)) {
    await interaction.reply({ content: 'La IA ya estaba activa en este ticket.', ephemeral: true });
    return;
  }

  const updated = await storage.updateTicket(interaction.channelId, {
    status: 'open',
    aiDisabled: false,
    aiDisabledBy: null,
    aiDisabledAt: null
  });

  if (!updated) {
    await interaction.reply({ content: 'No pude actualizar este ticket. Intentalo de nuevo.', ephemeral: true });
    return;
  }

  await storage.addTranscriptMessage({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: interaction.id,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    authorBot: false,
    role: 'system',
    content: `IA reactivada por ${interaction.user.username}. NexaDesk vuelve a atender este ticket.`,
    createdAt: new Date().toISOString()
  });

  await interaction.reply({
    content: `${EMOJIS.global} IA reactivada. NexaDesk vuelve a escuchar y responder en este ticket.`
  });
}

async function handleTicketStatusCommand({ interaction, storage }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  const [ticket, guildConfig, messages] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId),
    storage.listTranscriptMessages(interaction.channelId)
  ]);

  if (!ticket) {
    await interaction.reply({ content: 'Este canal no esta registrado como ticket de NexaDesk.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(ticket.status === 'closed' ? 0x777777 : isAiDisabledTicket(ticket) ? 0xffcc00 : 0xffffff)
    .setTitle(`${EMOJIS.global} Estado del ticket`)
    .setDescription(`Vista rapida de **#${ticket.channelName ?? interaction.channel?.name ?? interaction.channelId}**.`)
    .addFields(
      { name: 'Estado', value: ticket.status ?? 'open', inline: true },
      { name: 'IA', value: isAiDisabledTicket(ticket) ? 'Desactivada por staff' : 'Activa', inline: true },
      { name: 'Staff', value: guildConfig?.staffRoleId ? `<@&${guildConfig.staffRoleId}>` : 'Sin rol configurado', inline: true },
      { name: 'Transcripcion', value: `${messages.length} mensajes guardados`, inline: true },
      { name: 'Creado', value: ticket.createdAt ? `<t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>` : 'Sin fecha', inline: true },
      { name: 'Opener', value: ticket.openedBy ? `<@${ticket.openedBy}>` : 'No detectado', inline: true }
    )
    .setFooter({ text: 'Usa /ticket resumen para entregar contexto al staff.' })
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { roles: [], users: [] } });
}

async function handleTicketSummaryCommand({ interaction, storage, supportAgent }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [ticket, guildConfig, messages] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId),
    storage.listTranscriptMessages(interaction.channelId)
  ]);

  if (!ticket) {
    await interaction.editReply('Este canal no esta registrado como ticket de NexaDesk.');
    return;
  }

  if (!canManageTicketTranscripts(interaction, guildConfig)) {
    await interaction.editReply('Solo staff o usuarios con Manage Server pueden generar resumenes del ticket.');
    return;
  }

  const summary = await supportAgent.summarizeTicket({ ticket, guildConfig, messages });
  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.wifi} Briefing para staff`)
    .setDescription(summary)
    .addFields(
      { name: 'Ticket', value: `#${ticket.channelName ?? interaction.channel?.name ?? ticket.channelId}`, inline: true },
      { name: 'Mensajes guardados', value: String(messages.length), inline: true },
      { name: 'Estado', value: ticket.status ?? 'open', inline: true }
    )
    .setFooter({ text: 'NexaDesk Staff Handoff' })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed], allowedMentions: { roles: [], users: [] } });
}

async function handleCloseTicketCommand({ interaction, storage, client, voiceManager = null }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  const [ticket, guildConfig] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId)
  ]);

  if (!ticket) {
    await interaction.reply({ content: 'Este canal no esta registrado como ticket de NexaDesk.', ephemeral: true });
    return;
  }

  if (!canCloseTicketFromInteraction(interaction, ticket, guildConfig)) {
    await interaction.reply({ content: 'Solo quien abrio este ticket, el staff configurado o alguien con Manage Server puede cerrarlo.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: [
      `${EMOJIS.global} Ticket cerrado.`,
      'Estoy preparando la transcripcion y eliminare este canal en unos segundos.'
    ].join('\n')
  });

  const closingReply = await interaction.fetchReply();
  await closeTicketWithTranscript({
    client,
    storage,
    voiceManager,
    channel: interaction.channel,
    guild: interaction.guild,
    ticket,
    requestedBy: interaction.user,
    requestId: interaction.id,
    closingReply,
    fallbackUser: interaction.user,
    reason: `NexaDesk slash close requested by ${interaction.user.tag}`
  });
}

async function handleVoiceCreateCommand({ interaction, storage, voiceManager = null }) {
  const context = await getVoiceCommandContext({ interaction, storage });
  if (!context) return;
  const { ticket, guildConfig } = context;

  const existingChannel = ticket.voiceChannelId
    ? await interaction.guild.channels.fetch(ticket.voiceChannelId).catch(() => null)
    : null;
  if (existingChannel) {
    await interaction.reply({
      content: `${EMOJIS.wifi} Este ticket ya tiene sala de voz: ${existingChannel}`,
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  const result = await createVoiceRoomForTicket({
    interaction,
    storage,
    voiceManager,
    ticket,
    guildConfig,
    textChannel: interaction.channel,
    requestedName: interaction.options.getString('nombre') || ticket.channelName || interaction.user.username,
    requestId: interaction.id
  });

  if (!result.ready) {
    await interaction.editReply([
      'La sala de voz no se pudo activar porque faltan columnas Pro Voice en Supabase.',
      'Ejecuta la migracion de `supabase/schema.sql` y vuelve a intentarlo.'
    ].join('\n'));
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.wifi} Soporte por voz Pro`)
    .setDescription([
      `Sala creada: ${result.channel}`,
      'El usuario del ticket y el staff configurado pueden entrar.',
      result.session?.started
        ? 'STT/TTS activo: NexaDesk escuchara la sala, transcribira y respondera por voz.'
        : `STT/TTS no activo: ${result.session?.reason ?? 'motor de voz no disponible.'}`
    ].join('\n'))
    .setFooter({ text: 'NexaDesk Pro Voice Rooms' })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

async function createVoiceRoomForTicket({ interaction, storage, voiceManager = null, ticket, guildConfig, textChannel, requestedName, requestId }) {
  const voiceName = buildVoiceChannelName(requestedName || ticket.channelName || interaction.user.username);
  const parentId = await resolveVoiceParentId(interaction, guildConfig, ticket);
  const channelOptions = {
    name: voiceName,
    type: ChannelType.GuildVoice,
    userLimit: 8,
    permissionOverwrites: buildVoicePermissionOverwrites({ interaction, guildConfig, ticket }),
    reason: `NexaDesk Pro voice support for ticket ${ticket.channelId}`
  };
  if (parentId) channelOptions.parent = parentId;

  const channel = await interaction.guild.channels.create(channelOptions);
  const updated = await storage.updateTicket(ticket.channelId, {
    voiceChannelId: channel.id,
    voiceChannelName: channel.name,
    voiceCreatedAt: new Date().toISOString()
  });

  if (updated?.voiceChannelId !== channel.id) {
    await channel.delete('NexaDesk voice schema is not ready').catch(() => {});
    return { ready: false, channel: null, session: null };
  }

  await storage.addTranscriptMessage({
    guildId: interaction.guildId,
    channelId: ticket.channelId,
    messageId: `voice-create-${requestId}`,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    authorBot: false,
    role: 'system',
    content: `Sala de voz Pro creada: #${channel.name} (${channel.id}).`,
    createdAt: new Date().toISOString()
  });

  let session = { started: false, reason: 'VOICE_STT_ENABLED esta desactivado o Groq no esta configurado.' };
  if (voiceManager) {
    session = await voiceManager.startTicketSession({
      guild: interaction.guild,
      textChannel,
      voiceChannel: channel,
      ticket: updated,
      guildConfig
    }).catch((error) => {
      console.error('Failed to start NexaDesk voice AI session:', error);
      return { started: false, reason: 'No pude conectarme a la sala de voz.' };
    });
  }

  return { ready: true, channel, ticket: updated, session };
}

async function handleVoiceStatusCommand({ interaction, storage }) {
  const context = await getVoiceCommandContext({ interaction, storage, allowFreeStatus: true });
  if (!context) return;
  const { ticket, guildConfig } = context;

  const voiceChannel = ticket.voiceChannelId
    ? await interaction.guild.channels.fetch(ticket.voiceChannelId).catch(() => null)
    : null;

  const embed = new EmbedBuilder()
    .setColor(isVoiceSupportEnabled(guildConfig) ? 0xffffff : 0x777777)
    .setTitle(`${EMOJIS.wifi} Estado de voz`)
    .setDescription(isVoiceSupportEnabled(guildConfig)
      ? 'Soporte por voz Pro disponible para este servidor.'
      : 'Soporte por voz bloqueado. Activa plan Pro o `voice_support_enabled` en Supabase.')
    .addFields(
      { name: 'Plan', value: guildConfig?.plan ?? 'free', inline: true },
      { name: 'Voice enabled', value: String(Boolean(guildConfig?.voiceSupportEnabled)), inline: true },
      { name: 'Sala actual', value: voiceChannel ? `${voiceChannel}` : 'Sin sala activa', inline: false }
    )
    .setTimestamp(new Date());

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleVoiceCloseCommand({ interaction, storage, voiceManager = null }) {
  const context = await getVoiceCommandContext({ interaction, storage });
  if (!context) return;
  const { ticket, guildConfig } = context;

  if (!canManageVoiceSupport(interaction, ticket, guildConfig)) {
    await interaction.reply({ content: 'Solo el opener, el staff configurado o alguien con Manage Server puede cerrar la sala de voz.', ephemeral: true });
    return;
  }

  const voiceChannel = ticket.voiceChannelId
    ? await interaction.guild.channels.fetch(ticket.voiceChannelId).catch(() => null)
    : null;

  if (!voiceChannel) {
    if (ticket.voiceChannelId) voiceManager?.stopSession(interaction.guildId, ticket.voiceChannelId);
    await storage.updateTicket(ticket.channelId, {
      voiceChannelId: null,
      voiceChannelName: null,
      voiceCreatedAt: null
    });
    await interaction.reply({ content: 'Este ticket no tiene una sala de voz activa.', ephemeral: true });
    return;
  }

  voiceManager?.stopSession(interaction.guildId, voiceChannel.id);
  await voiceChannel.delete(`NexaDesk Pro voice closed by ${interaction.user.tag}`);
  await storage.updateTicket(ticket.channelId, {
    voiceChannelId: null,
    voiceChannelName: null,
    voiceCreatedAt: null
  });
  await storage.addTranscriptMessage({
    guildId: interaction.guildId,
    channelId: ticket.channelId,
    messageId: `voice-close-${interaction.id}`,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    authorBot: false,
    role: 'system',
    content: `Sala de voz Pro cerrada por ${interaction.user.username}.`,
    createdAt: new Date().toISOString()
  });

  await interaction.reply({ content: `${EMOJIS.global} Sala de voz cerrada y desvinculada del ticket.` });
}

async function getVoiceCommandContext({ interaction, storage, allowFreeStatus = false }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return null;
  }

  const [ticket, guildConfig] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId)
  ]);

  if (!ticket) {
    await interaction.reply({ content: 'Este canal no esta registrado como ticket de NexaDesk.', ephemeral: true });
    return null;
  }

  if (!guildConfig) {
    await interaction.reply({ content: 'Configura primero este servidor desde la dashboard.', ephemeral: true });
    return null;
  }

  if (!allowFreeStatus && !isVoiceSupportEnabled(guildConfig)) {
    await interaction.reply({
      content: [
        'Soporte por voz es una funcion **Pro**.',
        'Activalo manualmente en Supabase con `plan = pro` o `voice_support_enabled = true` para este `guild_id`.'
      ].join('\n'),
      ephemeral: true
    });
    return null;
  }

  if (!allowFreeStatus && !canManageVoiceSupport(interaction, ticket, guildConfig)) {
    await interaction.reply({ content: 'Solo el opener, el staff configurado o alguien con Manage Server puede usar soporte por voz en este ticket.', ephemeral: true });
    return null;
  }

  return { ticket, guildConfig };
}

async function handleSendTranscriptCommand({ interaction, storage }) {
  if (!interaction.inGuild() || !interaction.channelId) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un ticket del servidor.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [ticket, guildConfig] = await Promise.all([
    storage.getTicket(interaction.channelId),
    storage.getGuildConfig(interaction.guildId)
  ]);

  if (!ticket) {
    await interaction.editReply('Este canal no esta registrado como ticket de NexaDesk.');
    return;
  }

  if (!canManageTicketTranscripts(interaction, guildConfig)) {
    await interaction.editReply('Solo staff o usuarios con Manage Server pueden enviar transcripciones.');
    return;
  }

  const messages = await storage.listTranscriptMessages(interaction.channelId);
  const targetUser = interaction.options.getUser('usuario') ?? await resolveTranscriptRecipient(interaction.client, ticket, messages);
  if (!targetUser) {
    await interaction.editReply('No pude detectar a quien enviar la transcripcion. Usa `/transcripcion enviar usuario:@usuario`.');
    return;
  }

  try {
    await sendTranscriptDm({
      targetUser,
      ticket,
      messages,
      guildName: interaction.guild.name
    });
  } catch (error) {
    console.error('Failed to DM ticket transcript:', error);
    await interaction.editReply(`No pude enviar MD a ${targetUser.tag}. Puede tener los mensajes directos cerrados.`);
    return;
  }

  await storage.addTranscriptMessage({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: interaction.id,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    authorBot: false,
    role: 'system',
    content: `Transcripcion enviada por MD a ${targetUser.tag}.`,
    createdAt: new Date().toISOString()
  });

  await interaction.editReply(`Transcripcion enviada por MD a **${targetUser.tag}**.`);
}

async function handleActivatePremiumCommand({ interaction, storage, client }) {
  if (interaction.user.id !== PREMIUM_ADMIN_USER_ID) {
    await interaction.reply({
      content: 'Este comando solo puede usarlo el owner autorizado de NexaDesk.',
      ephemeral: true
    });
    return;
  }

  const guildId = interaction.options.getString('servidor', true).trim();
  if (!/^\d{17,20}$/.test(guildId)) {
    await interaction.reply({ content: 'Pon un ID de servidor valido.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const targetGuild = await client.guilds.fetch(guildId).catch(() => null);
  const existing = await storage.getGuildConfig(guildId).catch(() => null);
  const updated = await storage.upsertGuildConfig(guildId, {
    guildName: targetGuild?.name ?? existing?.guildName ?? `Servidor ${guildId}`,
    plan: 'pro',
    voiceSupportEnabled: true
  });

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.global} Premium activado`)
    .setDescription(`Todas las funciones premium quedan activas para **${updated.guildName ?? guildId}**.`)
    .addFields(
      { name: 'Servidor', value: guildId, inline: true },
      { name: 'Plan', value: updated.plan ?? 'pro', inline: true },
      { name: 'Voz Pro', value: updated.voiceSupportEnabled ? 'Activa' : 'Pendiente', inline: true },
      { name: 'Incluye', value: 'Paneles Pro, tickets de voz, STT/TTS, transcripciones y futuras funciones premium del servidor.' }
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand({ interaction, config }) {
  await interaction.reply({
    embeds: [buildHelpEmbed({ view: 'home', config, guild: interaction.guild })],
    components: buildHelpComponents({ view: 'home', config }),
    ephemeral: true
  });
}

async function handleHelpButton({ interaction, config }) {
  const view = interaction.customId.replace('nexadesk:help:', '') || 'home';
  await interaction.update({
    embeds: [buildHelpEmbed({ view, config, guild: interaction.guild })],
    components: buildHelpComponents({ view, config })
  });
}

function buildHelpEmbed({ view, config, guild }) {
  const base = new EmbedBuilder()
    .setColor(0xffffff)
    .setFooter({ text: 'NexaDesk - ayuda interactiva' })
    .setTimestamp(new Date());

  if (view === 'create_ticket') {
    return base
      .setTitle(`${EMOJIS.global} Como creo un ticket?`)
      .setDescription('Los tickets se crean desde los paneles publicados por el servidor. NexaDesk puede abrir tickets de texto, menus con preguntas previas y tickets de voz Pro si el servidor lo tiene activo.')
      .addFields(
        {
          name: 'Para miembros',
          value: [
            'Busca el canal de soporte del servidor.',
            'Pulsa el boton del panel o elige una opcion del menu desplegable.',
            'Responde las preguntas previas si aparecen.',
            'Explica el problema con detalle y adjunta capturas o videos si ayudan.'
          ].join('\n')
        },
        {
          name: 'Que hara NexaDesk',
          value: [
            'Leera el contexto configurado del servidor.',
            'Te pedira datos si falta informacion.',
            'Si detecta que hace falta una persona, avisara al rol de staff configurado con el resumen del caso.'
          ].join('\n')
        },
        {
          name: 'Atajo util',
          value: 'Si necesitas una persona directamente, dilo claro dentro del ticket: "necesito asistencia manual".'
        }
      );
  }

  if (view === 'setup') {
    return base
      .setTitle(`${EMOJIS.wifi} Como configuro el servidor?`)
      .setDescription(`Servidor actual: **${guild?.name ?? 'tu servidor'}**. La configuracion completa vive en la dashboard.`)
      .addFields(
        {
          name: 'Setup recomendado',
          value: [
            `1. Abre la dashboard: ${PUBLIC_DASHBOARD_URL}`,
            '2. Inicia sesion con Discord y selecciona el servidor.',
            '3. Elige la categoria donde se abren tickets.',
            '4. Selecciona el rol de staff.',
            '5. Escribe el prompt/contexto del servidor para que la IA responda con criterio.',
            '6. Crea componentes y publica paneles de boton o menu.'
          ].join('\n')
        },
        {
          name: 'Si ya usas otro bot de tickets',
          value: 'No tienes que cambiar de sistema. Configura la categoria donde ese bot crea los canales y NexaDesk detectara los tickets nuevos.'
        },
        {
          name: 'Staff',
          value: [
            'Mueve el rol de NexaDesk por encima del rol de staff para poder crear tickets privados.',
            'Diles que usen `/desactivar ia` cuando entren a atender manualmente.',
            'Diles que usen `/ticket resumen` para leer el caso rapido y `/ticket cerrar` para cerrar con transcripcion.'
          ].join('\n')
        }
      );
  }

  if (view === 'data') {
    return base
      .setTitle('Datos, transcripciones y privacidad')
      .setDescription('NexaDesk guarda lo necesario para que el soporte sea continuo, auditable y facil de revisar desde la dashboard.')
      .addFields(
        {
          name: 'Que se guarda',
          value: [
            'Configuracion del servidor: categoria, rol staff, prompt, contexto, paneles y componentes.',
            'Tickets detectados o creados desde paneles.',
            'Transcripciones de mensajes del ticket y eventos importantes como escalados, voz o cierre.'
          ].join('\n')
        },
        {
          name: 'Donde se guarda',
          value: 'En Supabase, para que la dashboard pueda mostrar historial, estadisticas y transcripciones por servidor.'
        },
        {
          name: 'Quien puede verlo',
          value: 'La dashboard filtra servidores usando Discord OAuth. Solo aparecen servidores donde el usuario tiene permisos de owner, Administrator o Manage Server.'
        }
      );
  }

  return base
    .setTitle(`${EMOJIS.global} Centro de ayuda NexaDesk`)
    .setDescription([
      'Elige una categoria para ver la guia exacta.',
      'NexaDesk funciona como moderador de soporte con IA: atiende tickets, pide informacion, escala al staff cuando hace falta y guarda transcripciones para revisarlas desde la dashboard.'
    ].join('\n\n'))
    .addFields(
      {
        name: 'Categorias disponibles',
        value: [
          'Como creo un ticket?',
          'Como configuro el servidor?',
          'Datos y transcripciones'
        ].join('\n')
      },
      {
        name: 'Soporte oficial',
        value: 'Si necesitas ayuda humana con NexaDesk: https://discord.gg/vVXbq7ePEZ'
      }
    );
}

function buildHelpComponents({ view, config }) {
  const current = String(view ?? 'home');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('nexadesk:help:create_ticket')
        .setLabel('Como creo un ticket?')
        .setStyle(current === 'create_ticket' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('nexadesk:help:setup')
        .setLabel('Configurar servidor')
        .setStyle(current === 'setup' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('nexadesk:help:data')
        .setLabel('Datos')
        .setStyle(current === 'data' ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Dashboard')
        .setURL(PUBLIC_DASHBOARD_URL),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Soporte oficial')
        .setURL('https://discord.gg/vVXbq7ePEZ')
    )
  ];
}

async function createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel = null, component = null, answers = [], panelCreatedChannels, config, voiceManager = null }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Los tickets solo se pueden abrir dentro de un servidor.', ephemeral: true });
    return;
  }

  const normalizedPanel = panel ? normalizePanelOptions(panel) : null;
  const normalizedComponent = component ? normalizeTicketComponent(component) : null;
  const ticketMode = normalizedComponent?.ticketMode || normalizedPanel?.ticketMode || 'text';
  const staffRoleIssue = getStaffRoleOverwriteIssue(interaction, guildConfig);
  if (staffRoleIssue) {
    await interaction.reply({ content: staffRoleIssue, ephemeral: true });
    return;
  }

  if (ticketMode === 'voice' && !isVoiceSupportEnabled(guildConfig)) {
    await interaction.reply({
      content: [
        `${EMOJIS.wifi} Este panel abre tickets de voz, pero este servidor no tiene Pro Voice activo.`,
        'Activa `plan = pro` o `voice_support_enabled = true` en Supabase para este servidor.'
      ].join('\n'),
      ephemeral: true
    });
    return;
  }

  const ticketCategoryId = normalizedComponent?.ticketCategoryId || normalizedPanel?.ticketCategoryId || guildConfig?.ticketCategoryId;
  const categoryResolution = await resolveTicketCategoryForPanel({
    interaction,
    storage,
    guildConfig,
    ticketCategoryId,
    config
  });
  if (!categoryResolution) return;

  let { ticketCategory, fallbackReason } = categoryResolution;
  let channel;
  try {
    channel = await createTicketChannel({
      interaction,
      guildConfig,
      ticketCategory,
      label: normalizedComponent?.label
    });
  } catch (error) {
    if (isMissingPermissionError(error) && !fallbackReason) {
      const fallbackCategory = await createManagedTicketCategory({
        interaction,
        storage,
        guildConfig
      });
      ticketCategory = fallbackCategory;
      fallbackReason = 'la categoria configurada bloqueo la creacion del canal';
      channel = await createTicketChannel({
        interaction,
        guildConfig,
        ticketCategory,
        label: normalizedComponent?.label
      });
    } else {
      throw error;
    }
  }
  panelCreatedChannels.add(channel.id);

  const ticket = await storage.createTicket({
    guildId: interaction.guild.id,
    guildName: interaction.guild.name,
    channelId: channel.id,
    channelName: channel.name,
    categoryId: ticketCategory.id,
    openedBy: interaction.user.id
  });

  if (ticket.alreadyExists) {
    await interaction.reply({ content: `Ticket creado: ${channel}`, ephemeral: true });
    return;
  }

  const welcome = await channel.send(buildTicketWelcomeMessage({ panel: normalizedPanel, component: normalizedComponent, answers, userMention: `${interaction.user}` }));
  await saveTranscript(storage, welcome, 'assistant');

  const voiceStatus = [];
  if (ticketMode === 'voice') {
    try {
      const result = await createVoiceRoomForTicket({
        interaction,
        storage,
        voiceManager,
        ticket,
        guildConfig,
        textChannel: channel,
        requestedName: normalizedComponent?.label || normalizedPanel?.buttonLabel || channel.name,
        requestId: interaction.id
      });
      if (result.ready) {
        const voiceNotice = await channel.send([
          `${EMOJIS.wifi} Sala de voz vinculada: ${result.channel}`,
          result.session?.started
            ? 'STT/TTS activo. Habla en la sala y NexaDesk respondera por voz y dejara transcripcion aqui.'
            : `Sala creada, pero STT/TTS no esta activo: ${result.session?.reason ?? 'motor no disponible.'}`
        ].join('\n'));
        await saveTranscript(storage, voiceNotice, 'assistant');
        voiceStatus.push(`Sala de voz: ${result.channel}`);
      } else {
        const voiceNotice = await channel.send([
          `${EMOJIS.wifi} No pude vincular la sala de voz porque Supabase no tiene las columnas Pro Voice aplicadas.`,
          'Ejecuta la migracion de `supabase/schema.sql` y vuelve a publicar o crear el ticket.'
        ].join('\n'));
        await saveTranscript(storage, voiceNotice, 'assistant');
        voiceStatus.push('Sala de voz pendiente: falta migracion de Supabase.');
      }
    } catch (error) {
      console.error('Panel voice ticket failed:', error);
      const inviteUrl = buildBotInviteUrl(config, interaction.guildId);
      const voiceNotice = await channel.send([
        `${EMOJIS.wifi} El ticket se creo, pero no pude crear la sala de voz.`,
        isMissingPermissionError(error)
          ? `Actualiza permisos aqui: ${inviteUrl}`
          : 'Revisa logs y vuelve a intentarlo con `/voz crear` dentro de este ticket.'
      ].join('\n'));
      await saveTranscript(storage, voiceNotice, 'assistant');
      voiceStatus.push('No pude crear la sala de voz; he dejado el aviso dentro del ticket.');
    }
  }

  await interaction.reply({
    content: [
      `Ticket creado: ${channel}`,
      ...voiceStatus,
      fallbackReason ? `He usado **${ticketCategory.name}** porque ${fallbackReason}.` : ''
    ].filter(Boolean).join('\n'),
    ephemeral: true
  });
  setTimeout(() => panelCreatedChannels.delete(channel.id), 30_000);
}

async function resolveTicketCategoryForPanel({ interaction, storage, guildConfig, ticketCategoryId, config }) {
  if (!ticketCategoryId) {
    try {
      const fallbackCategory = await createManagedTicketCategory({ interaction, storage, guildConfig });
      return {
        ticketCategory: fallbackCategory,
        fallbackReason: 'no habia ninguna categoria configurada'
      };
    } catch (error) {
      await replyTicketPermissionProblem({ interaction, config, error });
      return null;
    }
  }

  const ticketCategory = await fetchTicketCategory(interaction, ticketCategoryId);
  const missingPermissions = ticketCategory
    ? getMissingTicketCreationPermissions(interaction, ticketCategory)
    : ['View Channel'];

  if (!ticketCategory || missingPermissions.length) {
    try {
      const fallbackCategory = await createManagedTicketCategory({ interaction, storage, guildConfig });
      return {
        ticketCategory: fallbackCategory,
        fallbackReason: ticketCategory
          ? `la categoria **${ticketCategory.name}** no permite: ${missingPermissions.join(', ')}`
          : 'la categoria configurada no es accesible para NexaDesk'
      };
    } catch (error) {
      await replyTicketPermissionProblem({
        interaction,
        config,
        error,
        categoryName: ticketCategory?.name,
        missingPermissions
      });
      return null;
    }
  }

  return { ticketCategory, fallbackReason: null };
}

async function createManagedTicketCategory({ interaction, storage, guildConfig }) {
  const existingCategory = interaction.guild.channels.cache.find((channel) =>
    channel?.type === ChannelType.GuildCategory
    && channel.name.toLowerCase() === 'nexadesk tickets'
    && !getMissingTicketCreationPermissions(interaction, channel).length
  );

  const category = existingCategory ?? await interaction.guild.channels.create({
    name: 'NexaDesk Tickets',
    type: ChannelType.GuildCategory,
    reason: 'NexaDesk managed ticket category'
  });

  await storage.upsertGuildConfig(interaction.guild.id, {
    guildName: interaction.guild.name,
    ticketCategoryId: category.id,
    ticketCategoryName: category.name,
    staffRoleId: guildConfig?.staffRoleId,
    serverPrompt: guildConfig?.serverPrompt,
    serverInfo: guildConfig?.serverInfo
  });

  return category;
}

async function createTicketChannel({ interaction, guildConfig, ticketCategory, label }) {
  return interaction.guild.channels.create({
    name: buildTicketChannelName(interaction.user.username, label),
    type: ChannelType.GuildText,
    parent: ticketCategory.id,
    reason: 'NexaDesk panel ticket creation',
    permissionOverwrites: buildTicketPermissionOverwrites(interaction, guildConfig)
  });
}

async function replyTicketPermissionProblem({ interaction, config, error, categoryName = null, missingPermissions = [] }) {
  const inviteUrl = buildBotInviteUrl(config, interaction.guildId);
  const reason = isMissingPermissionError(error)
    ? 'Discord sigue bloqueando la creacion de canales por permisos efectivos.'
    : 'No he podido preparar una categoria propia para NexaDesk.';

  await interaction.reply({
    content: [
      'No puedo crear el canal del ticket todavia.',
      categoryName ? `Categoria: **${categoryName}**` : '',
      missingPermissions.length ? `Permisos bloqueados en la categoria: **${missingPermissions.join(', ')}**` : '',
      reason,
      `Actualiza permisos aqui: ${inviteUrl}`,
      'Si ya actualizaste permisos, revisa los overrides de la categoria o crea una categoria nueva desde la dashboard.'
    ].filter(Boolean).join('\n'),
    ephemeral: true
  });
}

async function fetchTicketCategory(interaction, ticketCategoryId) {
  const cached = interaction.guild.channels.cache.get(ticketCategoryId);
  const channel = cached ?? await interaction.guild.channels.fetch(ticketCategoryId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildCategory) return null;
  return channel;
}

function getMissingTicketCreationPermissions(interaction, ticketCategory) {
  const botMember = interaction.guild.members.me;
  const permissions = botMember?.permissionsIn(ticketCategory);
  if (!permissions) return ['Manage Channels', 'Manage Roles'];

  const required = [
    { label: 'View Channel', flag: PermissionFlagsBits.ViewChannel },
    { label: 'Manage Channels', flag: PermissionFlagsBits.ManageChannels },
    { label: 'Manage Roles', flag: PermissionFlagsBits.ManageRoles }
  ];
  return required
    .filter((permission) => !permissions.has(permission.flag))
    .map((permission) => permission.label);
}

function getStaffRoleOverwriteIssue(interaction, guildConfig) {
  if (!guildConfig?.staffRoleId) return null;

  const staffRole = interaction.guild.roles.cache.get(guildConfig.staffRoleId);
  if (!staffRole) {
    return 'El rol de staff configurado ya no existe en este servidor. Cambialo desde la dashboard antes de crear tickets privados.';
  }

  const botMember = interaction.guild.members.me;
  if (!botMember) return 'No pude leer mi rol dentro del servidor. Reintentalo en unos segundos.';

  if (botMember.roles.highest.comparePositionTo(staffRole) <= 0) {
    return [
      'No puedo dar acceso al rol de staff en el ticket porque mi rol esta por debajo o al mismo nivel que el rol de staff.',
      `Rol staff: **${staffRole.name}**`,
      'Solucion rapida: mueve el rol de NexaDesk por encima del rol de staff en Ajustes del servidor > Roles.'
    ].join('\n');
  }

  return null;
}

function buildTicketPermissionOverwrites(interaction, guildConfig) {
  const overwrites = [
    {
      id: interaction.guild.roles.everyone,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  if (guildConfig?.staffRoleId && interaction.guild.roles.cache.has(guildConfig.staffRoleId)) {
    overwrites.push({
      id: guildConfig.staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  return overwrites;
}

function buildBotInviteUrl(config, guildId) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.DISCORD_CLIENT_ID);
  url.searchParams.set('permissions', BOT_INVITE_PERMISSIONS);
  url.searchParams.set('scope', 'bot applications.commands');
  if (guildId) {
    url.searchParams.set('guild_id', guildId);
    url.searchParams.set('disable_guild_select', 'true');
  }
  return url.toString();
}

function isMissingPermissionError(error) {
  return error?.code === 50013 || /Missing Permissions/i.test(String(error?.message ?? error));
}

function buildTicketComponentModal(component) {
  const normalized = normalizeTicketComponent(component);
  const modal = new ModalBuilder()
    .setCustomId(`nexadesk:ticket_component_modal:${normalized.id}`)
    .setTitle(normalized.label.slice(0, 45));

  for (const [index, question] of normalized.questions.entries()) {
    const input = new TextInputBuilder()
      .setCustomId(`question_${index}`)
      .setLabel(question.slice(0, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(900);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

function buildTicketWelcomeMessage({ panel, component, answers, userMention }) {
  const baseMessage = component
    ? formatWelcomeTemplate(component.welcomeMessage, userMention)
    : panelWelcomeMessage(panel, userMention);

  const answerBlock = answers.length
    ? [
        '',
        '**Respuestas previas:**',
        ...answers.map((item) => `**${item.question}**\n${item.answer}`)
      ].join('\n')
    : '';

  return `${EMOJIS.global} ${baseMessage}${answerBlock}`;
}

function formatWelcomeTemplate(template, userMention) {
  return String(template ?? '')
    .replaceAll('{user}', userMention)
    .replaceAll('{bot}', 'NexaDesk');
}

function buildTicketChannelName(username, componentLabel) {
  const prefix = componentLabel ? `ticket-${componentLabel}-${username}` : `ticket-${username}`;
  return prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90);
}

async function handleNaturalCloseRequest({ client, storage, message, ticket, guildConfig }) {
  if (!canCloseTicketFromMessage(message, ticket, guildConfig)) {
    const reply = await message.reply({
      content: 'Solo quien abrio este ticket, el staff configurado o alguien con Manage Server puede cerrarlo.',
      allowedMentions: { repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return;
  }

  const closingReply = await message.reply({
    content: [
      `${EMOJIS.global} Ticket cerrado.`,
      'Estoy preparando la transcripcion y eliminare este canal en unos segundos.'
    ].join('\n'),
    allowedMentions: { repliedUser: false }
  });

  await closeTicketWithTranscript({
    client,
    storage,
    channel: message.channel,
    guild: message.guild,
    ticket,
    requestedBy: message.author,
    requestId: message.id,
    closingReply,
    fallbackUser: message.author,
    reason: `NexaDesk natural close requested by ${message.author.tag}`
  });
}

async function closeTicketWithTranscript({ client, storage, voiceManager = null, channel, guild, ticket, requestedBy, requestId, closingReply, fallbackUser = null, reason }) {
  const requestedAt = new Date().toISOString();
  await storage.addTranscriptMessage({
    guildId: guild.id,
    channelId: channel.id,
    messageId: `close-request-${requestId}`,
    authorId: requestedBy.id,
    authorName: requestedBy.username,
    authorBot: requestedBy.bot ?? false,
    role: 'system',
    content: `Cierre solicitado por ${requestedBy.username}.`,
    createdAt: requestedAt
  });

  await channel.sendTyping().catch(() => {});
  await saveTranscript(storage, closingReply, 'assistant');

  const closedAt = new Date().toISOString();
  const closedTicket = {
    ...ticket,
    status: 'closed',
    updatedAt: closedAt
  };
  const messages = await storage.listTranscriptMessages(channel.id);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages) ?? fallbackUser;
  let dmStatus = 'No se pudo detectar usuario para enviar la transcripcion por MD.';

  if (targetUser) {
    try {
      await sendTranscriptDm({
        targetUser,
        ticket: closedTicket,
        messages,
        guildName: guild.name
      });
      dmStatus = `Transcripcion enviada automaticamente por MD a ${targetUser.tag}.`;
    } catch (error) {
      console.error('Failed to DM transcript for ticket close:', error);
      dmStatus = `No se pudo enviar la transcripcion por MD a ${targetUser.tag}. Puede tener los MD cerrados.`;
    }
  }

  await storage.addTranscriptMessage({
    guildId: guild.id,
    channelId: channel.id,
    messageId: `close-dm-${requestId}`,
    authorId: client.user?.id,
    authorName: client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: dmStatus,
    createdAt: new Date().toISOString()
  });

  await storage.updateTicket(channel.id, {
    status: 'closed',
    aiDisabled: false
  });
  await closeLinkedVoiceRoom({ guild, ticket, voiceManager, reason: `NexaDesk ticket closed by ${requestedBy.tag}` });

  try {
    await closingReply.edit([
      `${EMOJIS.global} Ticket cerrado.`,
      dmStatus,
      'Este canal se eliminara en 8 segundos.'
    ].join('\n'));
  } catch {
    // The channel may already be gone if another ticket bot deleted it first.
  }

  setTimeout(async () => {
    try {
      const freshChannel = await guild.channels.fetch(channel.id).catch(() => null);
      if (freshChannel?.deletable) {
        await freshChannel.delete(reason);
      } else if (freshChannel) {
        await freshChannel.send('No tengo permisos suficientes para eliminar este canal. El ticket ya quedo cerrado en NexaDesk.');
      }
    } catch (error) {
      console.error(`Failed to delete closed ticket channel ${channel.id}:`, error);
    }
  }, 8_000);
}

async function finalizeDeletedTicket({ client, storage, channel, ticket, voiceManager = null }) {
  const closedAt = new Date().toISOString();
  const closedTicket = {
    ...ticket,
    status: 'closed',
    updatedAt: closedAt
  };

  await storage.addTranscriptMessage({
    guildId: ticket.guildId,
    channelId: ticket.channelId,
    messageId: `channel-delete-${Date.now()}`,
    authorId: client.user?.id,
    authorName: client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `Ticket cerrado automaticamente porque el canal #${ticket.channelName ?? channel.id} fue eliminado.`,
    createdAt: closedAt
  });

  const messages = await storage.listTranscriptMessages(ticket.channelId);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages);
  let dmStatus = 'No se pudo detectar usuario para enviar la transcripcion por MD.';

  if (targetUser) {
    try {
      await sendTranscriptDm({
        targetUser,
        ticket: closedTicket,
        messages,
        guildName: channel.guild?.name
      });
      dmStatus = `Transcripcion enviada automaticamente por MD a ${targetUser.tag}.`;
    } catch (error) {
      console.error('Failed to auto DM deleted ticket transcript:', error);
      dmStatus = `No se pudo enviar la transcripcion por MD a ${targetUser.tag}. Puede tener los MD cerrados.`;
    }
  }

  await storage.addTranscriptMessage({
    guildId: ticket.guildId,
    channelId: ticket.channelId,
    messageId: `transcript-auto-${Date.now()}`,
    authorId: client.user?.id,
    authorName: client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: dmStatus,
    createdAt: new Date().toISOString()
  });

  await storage.updateTicket(ticket.channelId, {
    status: 'closed'
  });
  await closeLinkedVoiceRoom({ guild: channel.guild, ticket, voiceManager, reason: 'NexaDesk ticket text channel deleted' });

  console.log(`Ticket closed from deleted channel: ${ticket.channelName} (${ticket.channelId}). ${dmStatus}`);
}

async function closeLinkedVoiceRoom({ guild, ticket, voiceManager = null, reason }) {
  if (!guild || !ticket?.voiceChannelId) return;
  voiceManager?.stopSession(guild.id, ticket.voiceChannelId);

  const voiceChannel = await guild.channels.fetch(ticket.voiceChannelId).catch(() => null);
  if (voiceChannel?.deletable) {
    await voiceChannel.delete(reason).catch((error) => {
      console.error(`Failed to delete linked voice room ${ticket.voiceChannelId}:`, error);
    });
  }
}

async function sendTranscriptDm({ targetUser, ticket, messages, guildName }) {
  const transcriptText = buildTranscriptText({ ticket, messages });
  const fileName = buildTranscriptFileName(ticket);
  const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: fileName });

  await targetUser.send({
    content: [
      `${EMOJIS.global} Aqui tienes la transcripcion de tu ticket en **${ticket.guildName ?? guildName ?? 'el servidor'}**.`,
      `Canal: **#${ticket.channelName ?? ticket.channelId}**`,
      'Si necesitas volver a contactar con el staff, abre un nuevo ticket.'
    ].join('\n'),
    files: [attachment]
  });
}

async function handleGlobalStatsCommand({ interaction, storage, client }) {
  await interaction.deferReply();

  const installedGuildIds = new Set(client.guilds.cache.keys());
  const [tickets, guildConfigs] = await Promise.all([
    storage.listTickets(),
    storage.listGuildConfigs()
  ]);
  const botTickets = tickets.filter((ticket) => installedGuildIds.has(ticket.guildId));
  const activeTickets = botTickets.filter((ticket) => ticket.status !== 'closed');
  const voiceRooms = botTickets.filter((ticket) => ticket.voiceChannelId).length;
  const panels = guildConfigs.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0);
  const proGuilds = guildConfigs.filter(isVoiceSupportEnabled).length;
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.global} NexaDesk Global Stats`)
    .setDescription('Estado en vivo del bot y su sistema de tickets.')
    .addFields(
      { name: `${EMOJIS.wifi} Ping`, value: `${Math.max(Math.round(client.ws.ping), 0)} ms`, inline: true },
      { name: `${EMOJIS.global} Servers`, value: String(client.guilds.cache.size), inline: true },
      { name: 'Canales activos', value: String(activeTickets.length), inline: true },
      {
        name: 'Tickets',
        value: [
          `Total: **${botTickets.length}**`,
          `Abiertos: **${botTickets.filter((ticket) => ticket.status === 'open').length}**`,
          `Escalados: **${botTickets.filter((ticket) => ticket.status === 'escalated').length}**`,
          `IA desactivada: **${botTickets.filter((ticket) => isAiDisabledTicket(ticket)).length}**`,
          `Cerrados: **${botTickets.filter((ticket) => ticket.status === 'closed').length}**`
        ].join('\n'),
        inline: true
      },
      {
        name: 'Dashboard',
        value: [
          `Servidores configurados: **${guildConfigs.length}**`,
          `Servidores Pro Voice: **${proGuilds}**`,
          `Paneles publicados: **${panels}**`,
          `Salas de voz activas: **${voiceRooms}**`,
          `Canales cacheados: **${client.channels.cache.size}**`
        ].join('\n'),
        inline: true
      },
      {
        name: 'Runtime',
        value: [
          `Uptime: **${formatDuration(client.uptime ?? 0)}**`,
          `RAM: **${memoryMb} MB**`,
          `Node: **${process.version}**`
        ].join('\n'),
        inline: true
      }
    )
    .setFooter({ text: 'NexaDesk AI Support' })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

function isAiDisabledTicket(ticket) {
  return ticket?.aiDisabled || ticket?.status === 'ai_disabled';
}

function isClosedTicket(ticket) {
  return ticket?.status === 'closed';
}

function isTicketEscalated(ticket) {
  return ticket?.status === 'escalated' || isAiDisabledTicket(ticket);
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  if (Array.isArray(member.roles)) return member.roles.includes(roleId);
  if (member.roles?.cache) return member.roles.cache.has(roleId);
  if (member.roles?.valueOf) {
    const roles = member.roles.valueOf();
    if (Array.isArray(roles)) return roles.includes(roleId);
  }
  return false;
}

function canManageTicketTranscripts(interaction, guildConfig) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(guildConfig?.staffRoleId && memberHasRole(interaction.member, guildConfig.staffRoleId));
}

function canCloseTicketFromMessage(message, ticket, guildConfig) {
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(message.member, guildConfig.staffRoleId)) return true;
  if (ticket.openedBy) return ticket.openedBy === message.author.id;
  return true;
}

function canCloseTicketFromInteraction(interaction, ticket, guildConfig) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(interaction.member, guildConfig.staffRoleId)) return true;
  if (ticket.openedBy) return ticket.openedBy === interaction.user.id;
  return true;
}

function canManageVoiceSupport(interaction, ticket, guildConfig) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(interaction.member, guildConfig.staffRoleId)) return true;
  if (ticket.openedBy) return ticket.openedBy === interaction.user.id;
  return true;
}

function isVoiceSupportEnabled(guildConfig) {
  const plan = String(guildConfig?.plan ?? 'free').toLowerCase();
  return Boolean(guildConfig?.voiceSupportEnabled || ['pro', 'enterprise', 'premium'].includes(plan));
}

function buildVoicePermissionOverwrites({ interaction, guildConfig, ticket }) {
  const allowVoice = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.UseVAD
  ];
  const overwrites = [
    {
      id: interaction.guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
    },
    {
      id: interaction.client.user.id,
      allow: [
        ...allowVoice,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers
      ]
    }
  ];

  if (ticket.openedBy) {
    overwrites.push({
      id: ticket.openedBy,
      allow: allowVoice
    });
  }

  if (guildConfig.staffRoleId) {
    overwrites.push({
      id: guildConfig.staffRoleId,
      allow: [
        ...allowVoice,
        PermissionFlagsBits.MoveMembers
      ]
    });
  }

  return overwrites;
}

async function resolveVoiceParentId(interaction, guildConfig, ticket) {
  const candidates = [
    guildConfig.voiceCategoryId,
    ticket.categoryId,
    guildConfig.ticketCategoryId
  ].filter(Boolean);

  for (const channelId of candidates) {
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildCategory) return channel.id;
  }

  return null;
}

function buildVoiceChannelName(value) {
  const cleaned = String(value ?? 'ticket')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

  return `voz-${cleaned || 'ticket'}`.slice(0, 90);
}

async function resolveTranscriptRecipient(client, ticket, messages) {
  const userId = ticket.openedBy || messages.find((message) => message.role === 'user' && !message.authorBot)?.authorId;
  if (!userId) return null;

  try {
    return await client.users.fetch(userId);
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    seconds || (!days && !hours && !minutes) ? `${seconds}s` : ''
  ].filter(Boolean).join(' ');
}

function applyBotPresence(client) {
  try {
    const presence = buildBotPresence();
    client.user.setPresence(presence);
    console.log(`NexaDesk presence set to ${presence.status}.`);
  } catch (error) {
    console.error('Failed to set NexaDesk presence:', error);
  }
}

function buildBotPresence() {
  return {
    status: 'online',
    afk: false,
    activities: [
      {
        name: 'How can I help you today?',
        type: ActivityType.Playing
      }
    ]
  };
}

async function wasCreatedByNexaDeskPanel(channel) {
  try {
    const logs = await channel.guild.fetchAuditLogs({
      type: 10,
      limit: 5
    });
    const entry = logs.entries.find((item) => item.target?.id === channel.id);
    return entry?.reason === 'NexaDesk panel ticket creation';
  } catch {
    return false;
  }
}

function findPanelForInteraction(guildConfig, interaction) {
  const panels = guildConfig?.panels ?? [];
  return panels.find((panel) => panel.messageId === interaction.message?.id)
    ?? panels.find((panel) => panel.channelId === interaction.channelId)
    ?? null;
}

function findTicketComponent(guildConfig, componentId) {
  const component = (guildConfig?.components ?? []).find((item) => item.id === componentId);
  return component ? normalizeTicketComponent(component) : null;
}

function refreshPanelSelectMenu(interaction, guildConfig, panel) {
  if (!panel || panel.panelType !== 'menu' || !interaction.message?.editable) return;

  interaction.message.edit({
    components: [buildPanelActionRow(panel, guildConfig?.components ?? [])]
  }).catch((error) => {
    console.error('Failed to refresh ticket select menu:', error);
  });
}

function parseEscalation(answer) {
  const trimmed = cleanBotAnswer(answer);
  const escalateMatch = trimmed.match(/^\[ESCALATE\]\s*/i);
  if (!escalateMatch && !looksLikeEscalation(trimmed)) {
    return { shouldEscalate: false, publicAnswer: trimmed };
  }

  const reason = trimmed.replace(/^\[ESCALATE\]\s*/i, '').trim();
  return {
    shouldEscalate: true,
    reason: reason || 'El ticket requiere revision humana.',
    publicAnswer: reason || 'Voy a avisar al staff para que revise este ticket.'
  };
}

function looksLikeEscalation(answer) {
  return [
    /\bnecesito\s+(?:involucrar|avisar|contactar|derivar|escalar)\s+(?:a|al|con)\s+(?:un\s+)?(?:staff|moderador|humano|responsable)\b/i,
    /\b(?:voy|debo|tengo)\s+(?:a\s+)?(?:avisar|contactar|involucrar|derivar|escalar)\s+(?:a|al|con)\s+(?:un\s+)?(?:staff|moderador|humano|responsable)\b/i,
    /\b(?:requires?|needs?)\s+(?:human|staff|moderator)\s+(?:review|intervention|support|assistance)\b/i,
    /\b(?:i\s+need|i'll|i\s+will)\s+(?:to\s+)?(?:notify|contact|escalate|involve)\s+(?:the\s+)?(?:staff|moderator|human team)\b/i
  ].some((pattern) => pattern.test(answer));
}

function isUserRequestingStaff(content) {
  return [
    /\basistencia\s+manual\b/i,
    /\b(?:necesito|podria|puedes|podrias|quiero\s+hablar\s+con|pasame\s+con)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/i,
    /\b(?:menciona(?:s|r)?|avisa(?:s|r)?|llama(?:s|r)?|contacta(?:s|r)?)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/i,
    /\b(?:staff|moderador(?:es)?|humano|responsable)\b.*\b(?:por\s+favor|porfa|urgente|ayuda|venir|venga|atienda)\b/i,
    /\bmanual\s+(?:support|assistance|help)\b/i,
    /\b(?:need|want|call|notify|contact|bring|get)\b.*\b(staff|moderator|human|admin)\b/i,
    /\b(?:staff|moderator|human|admin)\b.*\b(?:please|help|needed|urgent)\b/i
  ].some((pattern) => pattern.test(content));
}

function isTicketCloseRequest(content) {
  const normalized = normalizeText(content);
  return [
    /\b(?:cierra|cierralo|cierra\s+el|cierra\s+este|cerrar|cerrad)\s+(?:el\s+|este\s+)?(?:ticket|canal)\b/,
    /\b(?:puedes|podrias|pueden|quiero|necesito|toca|dale)\s+(?:cerrar|cerrarlo|cerrar\s+el|cerrar\s+este)\b/,
    /\b(?:no|si|vale|ok|perfecto|gracias)[,\s]+(?:cierralo|cerralo|cerrar(?:lo)?|cierra(?:lo)?)\b/,
    /\b(?:cerralo|cierralo|cierrenlo)\b/,
    /\b(?:close|delete|shut)\s+(?:the\s+|this\s+)?ticket\b/,
    /\b(?:please|pls|ok|yes|thanks|thank\s+you)[,\s]+(?:close|delete)\s+(?:it|the\s+ticket|this\s+ticket)?\b/,
    /\byou\s+can\s+(?:close|delete)\s+(?:it|the\s+ticket|this\s+ticket)?\b/
  ].some((pattern) => pattern.test(normalized));
}

function buildPublicReply(escalation, guildConfig, { mentionStaff = false } = {}) {
  const publicAnswer = cleanStaffMentions(escalation.publicAnswer, guildConfig);
  if (!escalation.shouldEscalate) return publicAnswer;

  if (!mentionStaff) return publicAnswer;

  const mention = guildConfig.staffRoleId ? `<@&${guildConfig.staffRoleId}> ` : 'No hay rol staff configurado. ';
  return `${mention}${publicAnswer}`;
}

function cleanBotAnswer(answer) {
  let cleaned = answer.trim();
  for (let i = 0; i < 6; i += 1) {
    const before = cleaned;
    cleaned = cleaned.replace(/^(AI SUPPORT|NexaDesk)\s*:\s*/i, '').trim();
    if (before === cleaned) break;
  }
  return cleaned;
}

function cleanStaffMentions(answer, guildConfig) {
  let cleaned = answer.trim();
  if (guildConfig.staffRoleId) {
    cleaned = cleaned.replace(new RegExp(`<@&${escapeRegExp(guildConfig.staffRoleId)}>`, 'g'), '');
  }
  cleaned = cleaned
    .replace(/@Staff\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || 'Voy a dejar el ticket preparado para que lo revise el staff.';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function registerTicketEscalation({ storage, message, guildConfig, ticket, reason }) {
  if (isTicketEscalated(ticket)) return false;

  if (guildConfig.staffRoleId) {
    await notifyStaffRole(message, guildConfig, ticket, reason);
  }

  await storage.updateTicket(ticket.channelId, {
    status: 'escalated'
  });

  return Boolean(guildConfig.staffRoleId);
}

async function notifyStaffRole(message, guildConfig, ticket, reason) {
  if (!guildConfig.staffRoleId) return;

  try {
    const guild = message.guild;
    const members = await guild.members.fetch();
    const staffMembers = members.filter((member) => member.roles.cache.has(guildConfig.staffRoleId) && !member.user.bot);
    const body = [
      `${EMOJIS.wifi} NexaDesk necesita staff en **${guild.name}**.`,
      `Ticket: #${ticket.channelName} (${message.channel.url})`,
      `Motivo: ${reason}`
    ].join('\n');

    await Promise.allSettled(
      [...staffMembers.values()].slice(0, 10).map((member) => member.send(body))
    );
  } catch (error) {
    console.error('Failed to notify staff role:', error);
  }
}

async function saveTranscript(storage, message, role) {
  const content = buildTranscriptMessageContent(message);
  if (!content.trim()) return;

  await storage.addTranscriptMessage({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    authorBot: message.author.bot,
    role,
    content,
    createdAt: message.createdAt?.toISOString?.() ?? new Date().toISOString()
  });
}

function buildTranscriptMessageContent(message) {
  const attachments = [...(message.attachments?.values?.() ?? [])]
    .map((attachment) => `[Adjunto: ${attachment.name ?? 'archivo'} | ${attachment.contentType ?? 'tipo desconocido'} | ${attachment.url ?? attachment.proxyURL ?? 'sin url'}]`);

  return [
    message.content?.trim() ?? '',
    ...attachments
  ].filter(Boolean).join('\n');
}

export async function createTicketCategory(client, storage, { guildId, name }) {
  const guild = await client.guilds.fetch(guildId);
  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: 'NexaDesk dashboard category creation'
  });

  return storage.upsertGuildConfig(guildId, {
    guildName: guild.name,
    ticketCategoryId: category.id,
    ticketCategoryName: category.name
  });
}

export async function createTicketPanel(client, storage, { guildId, channelId, ...panelInput }) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Panel channel must be a text channel.');
  }

  const panel = normalizePanelOptions(panelInput);
  const existing = await storage.getGuildConfig(guildId);
  const embed = new EmbedBuilder(buildPanelEmbed(panel));
  const row = buildPanelActionRow(panel, existing?.components ?? []);

  const message = await channel.send({ embeds: [embed], components: [row] });
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
}

export async function updateTicketPanel(client, storage, { guildId, messageId, ...panelInput }) {
  const guild = await client.guilds.fetch(guildId);
  const existing = await storage.getGuildConfig(guildId);
  const currentPanel = existing?.panels?.find((panel) => panel.messageId === messageId);
  if (!currentPanel) throw new Error('No encuentro ese panel en la configuracion guardada.');

  const channel = await guild.channels.fetch(currentPanel.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('El canal original del panel ya no existe o no es de texto.');
  }

  const panel = normalizePanelOptions({
    ...currentPanel,
    ...panelInput,
    channelId: currentPanel.channelId,
    channelName: currentPanel.channelName
  });
  const message = await channel.messages.fetch(messageId);
  await message.edit({
    embeds: [new EmbedBuilder(buildPanelEmbed(panel))],
    components: [buildPanelActionRow(panel, existing?.components ?? [])]
  });

  return storage.upsertGuildConfig(guildId, {
    guildName: guild.name,
    panels: (existing?.panels ?? []).map((item) => item.messageId === messageId
      ? {
          ...item,
          ...panel,
          channelId: currentPanel.channelId,
          channelName: currentPanel.channelName,
          messageId,
          updatedAt: new Date().toISOString()
        }
      : item)
  });
}

export async function listGuildRoles(client, { guildId }) {
  const guild = await client.guilds.fetch(guildId);
  const roles = await guild.roles.fetch();
  return [...roles.values()]
    .filter((role) => role.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position
    }));
}

export async function listGuildChannels(client, { guildId }) {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  return [...channels.values()]
    .filter((channel) => channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildCategory))
    .sort((a, b) => a.position - b.position)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId
    }));
}

export async function listInstalledGuildIds(client) {
  await waitForClientReady(client);
  return [...client.guilds.cache.keys()];
}

async function waitForClientReady(client, timeoutMs = 3000) {
  if (client.isReady()) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

