import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
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

const EMOJIS = {
  wifi: '<a:wifi:1499732411829846116>',
  global: '<a:Global:1499728413974593708>'
};
const BOT_INVITE_PERMISSIONS = '268684304';

export function createBot({ config, storage, supportAgent }) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
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

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === 'nexadesk:create_ticket') {
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const panel = findPanelForInteraction(guildConfig, interaction);
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, panelCreatedChannels, config });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'nexadesk:select_ticket_component') {
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const component = findTicketComponent(guildConfig, interaction.values?.[0]);
        if (!component) {
          await interaction.reply({ content: 'Este componente ya no existe. Actualiza el panel desde la dashboard.', ephemeral: true });
          return;
        }

        if (component.questions.length) {
          await interaction.showModal(buildTicketComponentModal(component));
          return;
        }

        const panel = findPanelForInteraction(guildConfig, interaction);
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, component, panelCreatedChannels, config });
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
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, component, answers, panelCreatedChannels, config });
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

      if (interaction.commandName === 'transcripcion' && interaction.options.getSubcommand() === 'enviar') {
        await handleSendTranscriptCommand({ interaction, storage });
        return;
      }

      if (interaction.commandName === 'globalstats') {
        await handleGlobalStatsCommand({ interaction, storage, client });
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

      const ticket = await storage.getTicket(channel.id);
      if (!ticket || ticket.status === 'closed') return;

      await finalizeDeletedTicket({ client, storage, channel, ticket });
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

async function createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel = null, component = null, answers = [], panelCreatedChannels, config }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Los tickets solo se pueden abrir dentro de un servidor.', ephemeral: true });
    return;
  }

  const normalizedComponent = component ? normalizeTicketComponent(component) : null;
  const staffRoleIssue = getStaffRoleOverwriteIssue(interaction, guildConfig);
  if (staffRoleIssue) {
    await interaction.reply({ content: staffRoleIssue, ephemeral: true });
    return;
  }

  const ticketCategoryId = normalizedComponent?.ticketCategoryId || panel?.ticketCategoryId || guildConfig?.ticketCategoryId;
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

  const welcome = await channel.send(buildTicketWelcomeMessage({ panel, component: normalizedComponent, answers, userMention: `${interaction.user}` }));
  await saveTranscript(storage, welcome, 'assistant');

  await interaction.reply({
    content: [
      `Ticket creado: ${channel}`,
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

  const requestedAt = new Date().toISOString();
  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `close-request-${message.id}`,
    authorId: message.author.id,
    authorName: message.author.username,
    authorBot: false,
    role: 'system',
    content: `Cierre solicitado por ${message.author.username}.`,
    createdAt: requestedAt
  });

  await message.channel.sendTyping();

  const closingReply = await message.reply({
    content: [
      `${EMOJIS.global} Ticket cerrado.`,
      'Estoy preparando la transcripcion y eliminare este canal en unos segundos.'
    ].join('\n'),
    allowedMentions: { repliedUser: false }
  });
  await saveTranscript(storage, closingReply, 'assistant');

  const closedAt = new Date().toISOString();
  const closedTicket = {
    ...ticket,
    status: 'closed',
    updatedAt: closedAt
  };
  const messages = await storage.listTranscriptMessages(message.channel.id);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages) ?? message.author;
  let dmStatus = 'Transcripcion enviada automaticamente por MD.';

  try {
    await sendTranscriptDm({
      targetUser,
      ticket: closedTicket,
      messages,
      guildName: message.guild.name
    });
    dmStatus = `Transcripcion enviada automaticamente por MD a ${targetUser.tag}.`;
  } catch (error) {
    console.error('Failed to DM transcript for natural close:', error);
    dmStatus = `No se pudo enviar la transcripcion por MD a ${targetUser.tag}. Puede tener los MD cerrados.`;
  }

  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `close-dm-${message.id}`,
    authorId: client.user?.id,
    authorName: client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: dmStatus,
    createdAt: new Date().toISOString()
  });

  await storage.updateTicket(message.channel.id, {
    status: 'closed'
  });

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
      const freshChannel = await message.guild.channels.fetch(message.channel.id).catch(() => null);
      if (freshChannel?.deletable) {
        await freshChannel.delete(`NexaDesk ticket close requested by ${message.author.tag}`);
      } else if (freshChannel) {
        await freshChannel.send('No tengo permisos suficientes para eliminar este canal. El ticket ya quedo cerrado en NexaDesk.');
      }
    } catch (error) {
      console.error(`Failed to delete closed ticket channel ${message.channel.id}:`, error);
    }
  }, 8_000);
}

async function finalizeDeletedTicket({ client, storage, channel, ticket }) {
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

  console.log(`Ticket closed from deleted channel: ${ticket.channelName} (${ticket.channelId}). ${dmStatus}`);
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
  const panels = guildConfigs.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0);
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
          `Paneles publicados: **${panels}**`,
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
  if (!message.content?.trim()) return;

  await storage.addTranscriptMessage({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    authorBot: message.author.bot,
    role,
    content: message.content,
    createdAt: message.createdAt?.toISOString?.() ?? new Date().toISOString()
  });
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

