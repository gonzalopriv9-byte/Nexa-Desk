import {
  ActionRowBuilder,
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

  const client = new Client({
    intents
  });

  const activeResponses = new Set();
  const panelCreatedChannels = new Set();

  client.once(Events.ClientReady, (readyClient) => {
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

      await storage.createTicket({
        guildId: interaction.guild.id,
        guildName: interaction.guild.name,
        channelId: channel.id,
        channelName: channel.name,
        categoryId: guildConfig.ticketCategoryId,
        openedBy: interaction.user.id
      });

      const welcome = await channel.send([
        `Hola ${interaction.user}, soy **NexaDesk**.`,
        'Cuéntame qué necesitas y te ayudaré con este ticket. Si hace falta, avisaré al staff con el contexto ordenado.'
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
  });

  client.on(Events.ChannelCreate, async (channel) => {
    try {
      if (!channel.guild || channel.type !== ChannelType.GuildText) return;

      const guildConfig = await storage.getGuildConfig(channel.guild.id);
      if (!guildConfig?.ticketCategoryId || channel.parentId !== guildConfig.ticketCategoryId) return;
      if (panelCreatedChannels.has(channel.id) || await storage.getTicket(channel.id)) return;

      const ticket = await storage.createTicket({
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        channelId: channel.id,
        channelName: channel.name,
        categoryId: channel.parentId
      });

      const welcome = await channel.send([
        'Hola, soy **NexaDesk**.',
        'Voy a ayudarte con este ticket. Cuéntame qué necesitas y, si hace falta, avisaré al staff con un resumen claro.'
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

    const guildConfig = await storage.getGuildConfig(message.guild.id);
    if (!guildConfig) return;

    activeResponses.add(message.channel.id);
    try {
      await saveTranscript(storage, message, 'user');
      await message.channel.sendTyping();
      const answer = await supportAgent.answerTicketMessage({ message, ticket, guildConfig });
      if (answer) {
        const escalation = parseEscalation(answer);
        if (escalation.shouldEscalate) {
          await notifyStaffRole(message, guildConfig, ticket, escalation.reason);
        }

        const reply = await message.reply(escalation.publicAnswer.slice(0, 1900));
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

function parseEscalation(answer) {
  const trimmed = answer.trim();
  if (!trimmed.startsWith('[ESCALATE]')) {
    return { shouldEscalate: false, publicAnswer: trimmed };
  }

  const reason = trimmed.replace('[ESCALATE]', '').trim();
  return {
    shouldEscalate: true,
    reason: reason || 'El ticket requiere revision humana.',
    publicAnswer: reason || 'Voy a avisar al staff para que revise este ticket.'
  };
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
