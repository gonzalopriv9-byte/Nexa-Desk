import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits
} from 'discord.js';

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
    if (interaction.isButton() && interaction.customId === 'nexadesk:create_ticket') {
      const guildConfig = await storage.getGuildConfig(interaction.guildId);
      if (!guildConfig?.ticketCategoryId) {
        await interaction.reply({ content: 'El sistema de tickets todavia no tiene una categoria configurada.', ephemeral: true });
        return;
      }

      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90),
        type: ChannelType.GuildText,
        parent: guildConfig.ticketCategoryId,
        reason: 'NexaDesk panel ticket creation',
        permissionOverwrites: [
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
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      });
      panelCreatedChannels.add(channel.id);

      const ticket = await storage.createTicket({
        guildId: interaction.guild.id,
        guildName: interaction.guild.name,
        channelId: channel.id,
        channelName: channel.name,
        categoryId: guildConfig.ticketCategoryId,
        openedBy: interaction.user.id
      });
      if (ticket.alreadyExists) {
        await interaction.reply({ content: `Ticket creado: ${channel}`, ephemeral: true });
        return;
      }

      const welcome = await channel.send([
        `Hola ${interaction.user}, soy **NexaDesk**.`,
        'Cuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.'
      ].join('\n'));
      await saveTranscript(storage, welcome, 'assistant');

      await interaction.reply({ content: `Ticket creado: ${channel}`, ephemeral: true });
      setTimeout(() => panelCreatedChannels.delete(channel.id), 30_000);
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
        'Hola, soy **NexaDesk**.',
        'Voy a ayudarte con este ticket. Cuentame que necesitas y, si hace falta, avisare al staff con un resumen claro.'
      ].join('\n'));
      await saveTranscript(storage, welcome, 'assistant');

      console.log(`Ticket detected: ${ticket.channelName} (${ticket.channelId})`);
    } catch (error) {
      console.error(`Failed to initialize ticket channel ${channel.id}:`, error);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild || !message.channel) return;
    if (!config.AI_AUTO_REPLY) return;

    const ticket = await storage.getTicket(message.channel.id);
    if (!ticket || activeResponses.has(message.channel.id)) return;
    if (isAiDisabledTicket(ticket)) return;

    // Always reload the latest server context before asking the AI.
    const guildConfig = await storage.getGuildConfig(message.guild.id);
    if (!guildConfig) return;

    activeResponses.add(message.channel.id);
    try {
      await saveTranscript(storage, message, 'user');
      if (isUserRequestingStaff(message.content)) {
        const escalation = {
          shouldEscalate: true,
          reason: 'El usuario solicita asistencia manual de staff.',
          publicAnswer: 'El usuario solicita asistencia manual de staff.'
        };
        const shouldMentionStaff = await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: escalation.reason });
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

function isAiDisabledTicket(ticket) {
  return ticket?.aiDisabled || ticket?.status === 'ai_disabled';
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
    /\bstaff\b/i,
    /\bmoderador(?:es)?\b/i,
    /\bmiembro del staff\b/i,
    /\brequiere(?:\s+de)?\s+(?:un\s+)?(?:staff|moderador|humano)/i,
    /\bnecesito\s+(?:la\s+)?(?:aprobacion|ayuda|intervencion)\s+de\b/i,
    /\bse unira a este ticket\b/i,
    /\bavisar(?:e|é)?\s+al\s+staff\b/i,
    /\bcontactar(?:e|é)?\s+con\s+staff\b/i
  ].some((pattern) => pattern.test(answer));
}

function isUserRequestingStaff(content) {
  return [
    /\bstaff\b/i,
    /\bmoderador(?:es)?\b/i,
    /\bhumano\b/i,
    /\basistencia\s+manual\b/i,
    /\bmenciona(?:s|r)?\b.*\b(staff|moderador(?:es)?)\b/i,
    /\bavisa(?:s|r)?\b.*\b(staff|moderador(?:es)?)\b/i
  ].some((pattern) => pattern.test(content));
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
      `NexaDesk necesita staff en **${guild.name}**.`,
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

export async function createTicketPanel(client, storage, { guildId, channelId, title, description, buttonLabel }) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Panel channel must be a text channel.');
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x4bd8ee)
    .setFooter({ text: 'NexaDesk AI Support' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('nexadesk:create_ticket')
      .setLabel(buttonLabel)
      .setStyle(ButtonStyle.Primary)
  );

  const message = await channel.send({ embeds: [embed], components: [row] });
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

