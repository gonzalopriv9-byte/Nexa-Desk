import {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import {
  buildAffiliateProgress,
  normalizeAffiliateCode,
  normalizeAffiliateProfile,
  normalizeAffiliateRedemption
} from './affiliates.js';
import {
  GLOBAL_BLACKLIST_ADMIN_USER_ID,
  SUPPORT_SERVER_URL,
  buildGlobalBanCode,
  isBlacklistEntryActive,
  parseBlacklistDuration
} from './blacklist.js';
import {
  ADMIN_CODE_ROLE_ID,
  buildAdminAccessCode,
  canReuseAdminAccessCode,
  generateAdminCode,
  getAdminAccessCodeValue
} from './admin-code.js';
import {
  buildMaintenanceNoticeText,
  getMaintenanceDelayMs,
  normalizeMaintenanceState,
  shouldApplyMaintenanceToGuild
} from './maintenance.js';
import { buildPanelActionRow, buildPanelEmbed, normalizePanelOptions, normalizeTicketComponent, panelWelcomeMessage } from './panel-options.js';
import { DISCORD_EMOJIS as EMOJIS } from './emojis.js';
import {
  buildExamAnswerRecord,
  buildExamQuestionPrompt,
  formatExamEvaluation,
  isExamCancelRequest,
  isExamReviewRequest,
  isExamTicketMode,
  normalizeExamConfig,
  normalizeExamState
} from './exam-mode.js';
import { buildFeedbackStats, formatRatingStars, normalizeGrowthConfig } from './growth.js';
import { DEFAULT_PREMIUM_MODULES, PREMIUM_SALES_FEATURES, getPremiumCheckoutConfig } from './premium-billing.js';
import { isPremiumEntitled, normalizePremiumConfig } from './premium.js';
import { SecurityManager, SECURITY_LEVELS, normalizeSecurityConfig, normalizeSecurityLevel, summarizeSecurityConfig } from './security.js';
import { analyzeGuildChannelsForDiscovery, hasUsefulDiscovery, normalizeChannelNameForDiscovery, normalizeDiscoveryConfig } from './server-discovery.js';
import { buildTranscriptFileName, buildTranscriptText } from './transcripts.js';
import { createTicketFlowCard } from './welcome-card.js';
import { XNPROTECT_BLACKLIST_CREDIT, checkXnProtectGlobalBan } from './xnprotect-blacklist.js';

const BOT_INVITE_PERMISSIONS = '1099780451478';
const PUBLIC_DASHBOARD_URL = 'https://nexa-desk.onrender.com/';
const PREMIUM_ADMIN_USER_ID = '1352652366330986526';
const ALLIANCE_MARKER = '[NexaDesk alliance]';
const CRISIS_MARKER = '[NexaDesk crisis]';
const STAFF_HANDOFF_MARKER = '[NexaDesk staff handoff]';

export function createBot({ config, storage, supportAgent, voiceManager = null }) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
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
    presence,
    partials: [Partials.Channel]
  });

  const activeResponses = new Set();
  const panelCreatedChannels = new Set();
  const blacklistAlertedChannels = new Set();
  const ticketWelcomeChannels = new Set();
  const managedTimers = new Set();
  const securityManager = new SecurityManager({ storage, client, supportAgent, config });
  const leadershipGate = createHaLeadershipGate({ storage, config });

  const originalDestroy = client.destroy.bind(client);
  client.destroy = async (...args) => {
    clearManagedTimers(managedTimers);
    return originalDestroy(...args);
  };

  client.on(Events.ClientReady, (readyClient) => {
    clearManagedTimers(managedTimers);
    applyBotPresence(readyClient);
    trackManagedInterval(managedTimers, () => {
      if (!isClientReadyForDiscordRest(readyClient)) return;
      applyBotPresence(readyClient);
    }, 1000 * 60 * 5);
    trackManagedTimeout(managedTimers, () => {
      if (!isClientReadyForDiscordRest(readyClient)) return;
      scanInstalledGuildsForDiscovery({ client: readyClient, storage, supportAgent }).catch((error) => {
        console.error('Initial smart discovery failed:', error);
      });
    }, 12_000);
    trackManagedInterval(managedTimers, () => {
      if (!isClientReadyForDiscordRest(readyClient)) return;
      scanInstalledGuildsForDiscovery({ client: readyClient, storage, supportAgent }).catch((error) => {
        console.error('Scheduled smart discovery failed:', error);
      });
    }, 1000 * 60 * 60 * 6);
    console.log(`NexaDesk online as ${readyClient.user.tag}`);
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      if (!await leadershipGate.isActive()) return;
      applyBotPresence(client);
      await handleGuildJoin({ guild, storage, config });
      await refreshGuildDiscovery(client, storage, { guildId: guild.id, reason: 'guild_join' }, supportAgent);
    } catch (error) {
      console.error(`Failed to send NexaDesk onboarding for guild ${guild.id}:`, error);
    }
  });

  client.on(Events.GuildDelete, () => {
    if (!leadershipGate.isProbablyActive()) return;
    applyBotPresence(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!await leadershipGate.isActive()) return;
      if (interaction.isButton() && interaction.customId === 'nexadesk:create_ticket') {
        const guildConfig = await storage.getGuildConfig(interaction.guildId);
        const panel = findPanelForInteraction(guildConfig, interaction);
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, panelCreatedChannels, blacklistAlertedChannels, config, voiceManager, supportAgent });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:help:')) {
        await handleHelpButton({ interaction, config });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:alliance_autoset:')) {
        await handleAllianceAutosetButton({ interaction, storage });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:autoconfig:')) {
        await handleAutoConfigButton({ interaction, storage });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:feedback:')) {
        await handleTicketFeedbackButton({ interaction, storage, client });
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
        if (!isExamTicketMode(component.ticketMode) && component.questions.length) {
          await interaction.showModal(buildTicketComponentModal(component));
          return;
        }

        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel, component, panelCreatedChannels, blacklistAlertedChannels, config, voiceManager, supportAgent });
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
        await createTicketFromConfiguredSource({ interaction, storage, guildConfig, component, answers, panelCreatedChannels, blacklistAlertedChannels, config, voiceManager, supportAgent });
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

        const staffRole = interaction.options.getRole('rol_staff');
        const allianceChannel = interaction.options.getChannel('canal_alianzas');
        const allianceTemplate = interaction.options.getString('plantilla_alianza');
        const patch = {
          guildName: interaction.guild.name,
          ticketCategoryId: category.id,
          ticketCategoryName: category.name
        };
        if (staffRole) patch.staffRoleId = staffRole.id;
        if (allianceChannel) {
          if (!isAlliancePublishChannel(allianceChannel)) {
            await interaction.reply({ content: 'El canal de alianzas debe ser un canal de texto o anuncios.', ephemeral: true });
            return;
          }
          patch.allianceChannelId = allianceChannel.id;
          patch.allianceChannelName = allianceChannel.name;
        }
        if (allianceTemplate?.trim()) patch.allianceTemplate = allianceTemplate.trim();
        await storage.upsertGuildConfig(interaction.guildId, patch);

        await interaction.reply({
          content: [
            `Listo. NexaDesk vigilara tickets nuevos en la categoria **${category.name}**.`,
            staffRole ? `Rol staff configurado: ${staffRole}.` : 'Rol staff sin cambiar. Puedes configurarlo luego en dashboard o con `/setup rol_staff:`.',
            allianceChannel ? `Canal de alianzas configurado: ${allianceChannel}.` : 'Canal de alianzas sin cambiar.',
            allianceTemplate?.trim() ? 'Plantilla de alianza del servidor guardada.' : 'Plantilla de alianza sin cambiar.'
          ].join('\n'),
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
        if (subcommand === 'prioridad') {
          await handleTicketPriorityCommand({ interaction, storage });
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

      if (interaction.commandName === 'diagnostico') {
        await handleDiagnosticsCommand({ interaction, storage, client, supportAgent });
        return;
      }

      if (interaction.commandName === 'crecimiento') {
        await handleGrowthCommand({ interaction, storage, client });
        return;
      }

      if (interaction.commandName === 'seguridad') {
        await handleSecurityCommand({ interaction, storage });
        return;
      }

      if (interaction.commandName === 'activarpremium') {
        await handleActivatePremiumCommand({ interaction, storage, client });
        return;
      }

      if (interaction.commandName === 'premium') {
        await handlePremiumCommand({ interaction, storage, config });
        return;
      }

      if (interaction.commandName === 'afiliado') {
        await handleAffiliateCommand({ interaction, storage, config, client });
        return;
      }

      if (interaction.commandName === 'dmowner') {
        await handleDmOwnerCommand({ interaction, storage, client, config });
        return;
      }

      if (interaction.commandName === 'code') {
        await handleAdminCodeCommand({ interaction, storage, config });
        return;
      }

      if (interaction.commandName === 'mantenimiento') {
        await handleMaintenanceCommand({ interaction, storage });
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
      if (!await leadershipGate.isActive()) return;
      await securityManager.handleChannelCreate(channel);
      if (!channel.guild || channel.type !== ChannelType.GuildText) return;

      const guildConfig = await storage.getGuildConfig(channel.guild.id);
      if (!isConfiguredTicketCategory(channel, guildConfig)) return;
      if (isTicketKingChannel(channel)) return;
      if (panelCreatedChannels.has(channel.id) || await storage.getTicket(channel.id)) return;
      if (await wasCreatedByNexaDeskPanel(channel)) return;

      const ticket = await createDetectedTicketRecord({ storage, channel });
      if (ticket.alreadyExists) return;

      const welcome = await channel.send([
        `${EMOJIS.nexalogo} Hola, soy **NexaDesk**.`,
        'Voy a ayudarte con este ticket. Cuentame que necesitas y, si hace falta, avisare al staff con un resumen claro.'
      ].join('\n'));
      await saveTranscript(storage, welcome, 'assistant');
      await sendMaintenanceTicketNotice({ storage, channel, guildConfig });

      console.log(`Ticket detected: ${ticket.channelName} (${ticket.channelId})`);
    } catch (error) {
      console.error(`Failed to initialize ticket channel ${channel.id}:`, error);
    }
  });

  client.on(Events.ChannelDelete, async (channel) => {
    try {
      if (!await leadershipGate.isActive()) return;
      if (!channel.guild) return;
      await securityManager.handleChannelDelete(channel);

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

  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleChannelUpdate(oldChannel, newChannel).catch((error) => {
      console.error(`Security channel update guard failed in ${newChannel?.guild?.id ?? 'unknown'}:`, error);
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!await leadershipGate.isActive()) return;
    if (!message.guild || !message.channel) return;
    const guildId = message.guildId;
    const channelId = message.channelId;
    if (!guildId || !channelId) return;
    if (await maybeMirrorGlobalAnnouncement({ client, storage, config, message })) return;

    const handledBySecurity = await securityManager.handleMessageCreate(message).catch((error) => {
      console.error(`Security message guard failed in ${guildId}:`, error);
      return false;
    });
    if (handledBySecurity) return;

    let [ticket, guildConfig] = await Promise.all([
      storage.getTicket(channelId),
      storage.getGuildConfig(guildId)
    ]);

    const ticketKingDetected = (!ticket || !ticket.openedBy) && await shouldDetectTicketKingChannel(message);
    const ticketKingOpenerId = ticketKingDetected ? await resolveTicketKingOpenerId(message) : null;
    let ticketKingBlacklistChecked = false;
    if (ticketKingDetected && !guildConfig) {
      guildConfig = await storage.upsertGuildConfig(message.guild.id, {
        guildName: message.guild.name
      });
    }

    if (!ticket && (isConfiguredTicketCategory(message.channel, guildConfig) || ticketKingDetected)) {
      ticket = await createDetectedTicketRecord({ storage, channel: message.channel, openedBy: ticketKingOpenerId });
      if (ticketKingDetected && !ticket.alreadyExists && message.author.bot) {
        await sendTicketKingWelcomeOnce({ storage, message, guildConfig, ticketWelcomeChannels });

        ticket = await maybeAlertTicketOpenerXnProtect({
          storage,
          channel: message.channel,
          guildConfig,
          ticket,
          openerId: ticketKingOpenerId,
          blacklistAlertedChannels
        });
        ticketKingBlacklistChecked = true;
      }
    }

    if (ticketKingDetected && ticket && ticketKingOpenerId && !ticket.openedBy) {
      const updatedTicket = await storage.updateTicket(ticket.channelId, { openedBy: ticketKingOpenerId });
      ticket = updatedTicket ?? ticket;
    }

    if (ticketKingDetected && ticket && !ticketKingBlacklistChecked) {
      ticket = await maybeAlertTicketOpenerXnProtect({
        storage,
        channel: message.channel,
        guildConfig,
        ticket,
        openerId: ticketKingOpenerId,
        blacklistAlertedChannels
      });
    }

    if (message.author.bot) return;
    if (!ticket) return;

    await saveTranscript(storage, message, 'user');
    void maybeRecordAiQualitySignal({ storage, supportAgent, message, ticket, guildConfig }).catch((error) => {
      console.warn(`AI quality signal capture failed in ${message.channelId}:`, error?.message ?? error);
    });
    if (isClosedTicket(ticket)) return;

    // Always reload the latest server context before asking the AI.
    if (!guildConfig) return;

    if (isCrisisRiskMessage(message.content)) {
      await handleCrisisRiskMessage({ storage, message, guildConfig, ticket });
      return;
    }

    if (shouldCheckTicketAuthorWithXnProtect({ message, ticket, guildConfig })) {
      if (!ticket.openedBy) {
        const updatedTicket = await storage.updateTicket(ticket.channelId, { openedBy: message.author.id });
        ticket = updatedTicket ?? ticket;
      }

      const checkedTicket = await maybeAlertXnProtectBlacklist({
        storage,
        channel: message.channel,
        guildConfig,
        ticket,
        user: message.author,
        blacklistAlertedChannels
      });
      ticket = checkedTicket ?? ticket;
    }

    if (isTicketCloseRequest(message.content)) {
      await handleNaturalCloseRequest({ client, storage, message, ticket, guildConfig });
      return;
    }

    const examHandled = await handleExamModeMessage({
      storage,
      supportAgent,
      message,
      ticket,
      guildConfig
    });
    if (examHandled) return;

    const staffHandoff = await handleStaffHandoffMessage({ storage, message, ticket, guildConfig, client });
    if (staffHandoff.ticket) ticket = staffHandoff.ticket;
    if (staffHandoff.handled) return;

    if (!config.AI_AUTO_REPLY) return;
    const activeResponseKey = message.channelId;
    if (activeResponses.has(activeResponseKey)) return;
    if (isAiDisabledTicket(ticket)) return;
    if (await shouldStaySilentInTicket({ storage, message, ticket, guildConfig, client })) return;

    activeResponses.add(activeResponseKey);
    try {
      const allianceFlow = await resolveAllianceTicketFlow({ message, storage, guildConfig, ticket, supportAgent });
      if (allianceFlow.type === 'reply' || allianceFlow.type === 'ask_template') {
        await sendFlowMessages({ message, storage, flow: allianceFlow });
        return;
      }

      if (allianceFlow.type === 'escalate') {
        const shouldMentionStaff = await registerTicketEscalation({
          storage,
          message,
          guildConfig,
          ticket,
          reason: allianceFlow.reason
        });
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket)) return;

        const reply = await sendTicketResponse(message, {
          content: buildPublicReply(
            { shouldEscalate: true, reason: allianceFlow.reason, publicAnswer: allianceFlow.publicAnswer },
            guildConfig,
            { mentionStaff: shouldMentionStaff }
          ).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
        return;
      }

      if (isUserRequestingStaff(message.content)) {
        const escalation = {
          shouldEscalate: true,
          reason: 'El usuario solicita asistencia manual de staff.',
          publicAnswer: 'El usuario solicita asistencia manual de staff.'
        };
        const shouldMentionStaff = await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: escalation.reason });
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket)) return;

        const reply = await sendTicketResponse(message, {
          content: buildPublicReply(escalation, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
        return;
      }

      await applyMaintenanceThrottle({ storage, message, guildConfig });
      const typing = createTypingHeartbeat(message.channel, {
        intervalMs: config.AI_TYPING_INTERVAL_MS,
        label: `ticket ${message.channel.id}`
      });
      typing.start();
      let answer = '';
      let elapsedMs = 0;
      try {
        answer = await withTimeout(
          supportAgent.answerTicketMessage({ message, ticket, guildConfig }),
          config.AI_REPLY_TIMEOUT_MS,
          'La IA ha tardado demasiado en responder.'
        );
      } finally {
        elapsedMs = typing.stop();
        if (elapsedMs >= config.AI_SLOW_LOG_MS) {
          console.warn(`Slow AI ticket reply in ${message.guild?.name ?? message.guildId}/${message.channel?.name ?? message.channelId}: ${elapsedMs}ms`);
        }
      }
      if (answer) {
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket) || isAiDisabledTicket(latestTicket)) return;

        const escalation = parseEscalation(answer);
        const shouldMentionStaff = escalation.shouldEscalate
          ? await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: escalation.reason })
          : false;

        const reply = await sendTicketResponse(message, {
          content: buildPublicReply(escalation, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
      }
    } catch (error) {
      console.error(`AI response failed in ${message.guild?.name ?? message.guildId}/${message.channel?.name ?? message.channelId} for ${message.author?.tag ?? message.author?.id}: ${compactRuntimeError(error)}`);
      const emergencyAnswer = await supportAgent.buildEmergencyTicketReply?.({ message, ticket, guildConfig }).catch((fallbackError) => {
        console.error(`Local AI emergency fallback failed in ${message.channelId}: ${compactRuntimeError(fallbackError)}`);
        return '';
      });

      const failureNotice = emergencyAnswer
        ? await sendTicketResponse(message, emergencyAnswer.slice(0, 1900)).catch((sendError) => {
          console.error(`Failed to send local AI emergency fallback in ${message.channelId}: ${compactRuntimeError(sendError)}`);
          return null;
        })
        : await sendAiFailureNotice(message);
      if (failureNotice) await saveTranscript(storage, failureNotice, 'assistant');
    } finally {
      activeResponses.delete(activeResponseKey);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleMemberAdd(member).catch((error) => {
      console.error(`Security member join guard failed in ${member.guild.id}:`, error);
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleMemberRemove(member).catch((error) => {
      console.error(`Security member remove guard failed in ${member.guild.id}:`, error);
    });
  });

  client.on(Events.GuildRoleCreate, async (role) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleRoleCreate(role).catch((error) => {
      console.error(`Security role create guard failed in ${role.guild.id}:`, error);
    });
  });

  client.on(Events.GuildRoleDelete, async (role) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleRoleDelete(role).catch((error) => {
      console.error(`Security role delete guard failed in ${role.guild.id}:`, error);
    });
  });

  client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleRoleUpdate(oldRole, newRole).catch((error) => {
      console.error(`Security role update guard failed in ${newRole.guild.id}:`, error);
    });
  });

  client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleGuildUpdate(oldGuild, newGuild).catch((error) => {
      console.error(`Security guild update guard failed in ${newGuild?.id ?? 'unknown'}:`, error);
    });
  });

  client.on(Events.WebhooksUpdate, async (channel) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleWebhooksUpdate(channel).catch((error) => {
      console.error(`Security webhook guard failed in ${channel.guild?.id ?? 'unknown'}:`, error);
    });
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleGuildBanAdd(ban).catch((error) => {
      console.error(`Security ban guard failed in ${ban.guild.id}:`, error);
    });
  });

  return client;
}

function isClientReadyForDiscordRest(client) {
  return Boolean(client?.isReady?.() && client?.token);
}

function createHaLeadershipGate({ storage, config }) {
  const instanceId = String(config.BOT_INSTANCE_ID || '').trim();
  let cache = {
    checkedAt: 0,
    active: !config.BOT_HA_ENABLED,
    warnedAt: 0
  };

  const isProbablyActive = () => !config.BOT_HA_ENABLED || cache.active;

  const isActive = async () => {
    if (!config.BOT_HA_ENABLED) return true;
    if (!instanceId) return false;

    const now = Date.now();
    if (now - cache.checkedAt < 750) return cache.active;

    try {
      const settings = await storage.getGlobalSettings();
      const lease = settings?.botLease && typeof settings.botLease === 'object' ? settings.botLease : {};
      const expiresAt = Date.parse(lease.expiresAt ?? '');
      cache = {
        checkedAt: now,
        active: lease.ownerId === instanceId && Number.isFinite(expiresAt) && expiresAt > now,
        warnedAt: cache.warnedAt
      };
      return cache.active;
    } catch (error) {
      cache = { ...cache, checkedAt: now, active: false };
      if (now - cache.warnedAt > 30_000) {
        console.warn('NexaDesk HA event gate could not verify leadership; ignoring Discord event to avoid duplicates:', error?.message ?? error);
        cache.warnedAt = now;
      }
      return false;
    }
  };

  return { isActive, isProbablyActive };
}

function trackManagedTimeout(timers, callback, delayMs) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delayMs);
  timer.unref?.();
  timers.add(timer);
  return timer;
}

function trackManagedInterval(timers, callback, intervalMs) {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  timers.add(timer);
  return timer;
}

function clearManagedTimers(timers) {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.clear();
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

async function deferEphemeralInteraction(interaction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ ephemeral: true });
}

async function replyOrEditEphemeral(interaction, payload) {
  const next = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (interaction.deferred) {
    const { ephemeral: _ephemeral, ...editPayload } = next;
    await interaction.editReply(editPayload);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ ...next, ephemeral: true });
    return;
  }
  await interaction.reply({ ...next, ephemeral: true });
}

async function handleGuildJoin({ guild, storage, config }) {
  const installer = await fetchBotInstallerInfo(guild).catch((error) => {
    console.warn(`Could not resolve installer for ${guild.name} (${guild.id}):`, error?.message ?? error);
    return null;
  });
  await storage.upsertGuildConfig(guild.id, {
    guildName: guild.name,
    ...(installer ? {
      addedByUserId: installer.userId,
      addedByUsername: installer.username,
      addedAt: installer.addedAt,
      addedByDetectedAt: new Date().toISOString()
    } : {})
  }).catch((error) => {
    console.error(`Failed to persist joined guild ${guild.id}:`, error);
  });

  const ownerMember = await guild.fetchOwner().catch(() => null);
  const ownerUser = ownerMember?.user;
  if (!ownerUser) {
    console.warn(`NexaDesk joined ${guild.name} (${guild.id}) but owner could not be fetched.`);
    return;
  }

  const sent = await sendOwnerOnboardingDm({
    user: ownerUser,
    guild,
    config,
    prefix: `${EMOJIS.nexalogo} Gracias por confiar en **NexaDesk** para **${guild.name}**.`
  }).then(() => true).catch((error) => {
    console.warn(`Could not send NexaDesk onboarding DM to ${ownerUser.tag} for ${guild.name} (${guild.id}): ${error?.code ?? ''} ${error?.message ?? error}`);
    return false;
  });
  if (sent) {
    console.log(`Sent NexaDesk onboarding DM to owner ${ownerUser.tag} for ${guild.name} (${guild.id}).`);
  }
  await sendAffiliateWelcomeDm({ user: ownerUser, guild, config })
    .catch((error) => console.warn(`Could not send affiliate DM to owner ${ownerUser.tag}:`, error?.message ?? error));

  if (installer?.userId && installer.userId !== ownerUser.id) {
    const installerUser = await guild.client.users.fetch(installer.userId).catch(() => null);
    if (installerUser) {
      await sendOwnerOnboardingDm({ user: installerUser, guild, config, prefix: `${EMOJIS.check} Gracias por agregar **NexaDesk** a **${guild.name}**.` })
        .catch((error) => console.warn(`Could not send installer onboarding DM to ${installerUser.tag}:`, error?.message ?? error));
      await sendAffiliateWelcomeDm({ user: installerUser, guild, config })
        .catch((error) => console.warn(`Could not send affiliate DM to installer ${installerUser.tag}:`, error?.message ?? error));
    }
  }
}

async function sendOwnerOnboardingDm({ user, guild, config, prefix }) {
  const embeds = buildOwnerOnboardingEmbeds({ guild });
  const components = buildOwnerOnboardingComponents(config);
  const flowCard = new AttachmentBuilder(createTicketFlowCard({ guildName: guild.name }), {
    name: 'nexadesk-ticket-flow.png'
  });
  return user.send({
    content: prefix,
    embeds,
    files: [flowCard],
    components
  });
}

async function sendAffiliateWelcomeDm({ user, guild, config }) {
  const threshold = config.AFFILIATE_REWARD_SERVER_COUNT ?? 7;
  const rewardDays = config.AFFILIATE_REWARD_DAYS ?? 30;
  const dashboardUrl = config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL;
  const embed = new EmbedBuilder()
    .setColor(0xf4c95d)
    .setTitle(`${EMOJIS.global} ¿Tienes un amigo que te ha hablado de NexaDesk?`)
    .setDescription([
      `Si alguien te recomendo NexaDesk para **${guild.name}**, dile que te pase su codigo de afiliado.`,
      '',
      `Usalo dentro del servidor con: \`/afiliado server codigo:<CODIGO>\``,
      '',
      `Cuando lo registres, ambos ayudais al crecimiento de NexaDesk. Cada **${threshold} servidores** que usen un codigo, ese afiliado gana **1 slot Premium durante ${rewardDays} dias**.`
    ].join('\n'))
    .addFields(
      {
        name: `${EMOJIS.check} Si tu quieres invitar servidores`,
        value: 'Ejecuta `/afiliado codigo` y comparte tu codigo. Es una forma directa de conseguir Premium sin pagar.'
      },
      {
        name: `${EMOJIS.nexalogo} Importante`,
        value: 'Cada servidor solo puede registrar un codigo de afiliado una vez. Elegidlo bien antes de usarlo.'
      }
    )
    .setFooter({ text: 'NexaDesk Affiliates - crecimiento con recompensa real' })
    .setTimestamp(new Date());

  return user.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Abrir dashboard')
          .setURL(dashboardUrl),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Soporte oficial')
          .setURL('https://discord.gg/vVXbq7ePEZ')
      )
    ]
  });
}

async function fetchBotInstallerInfo(guild) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) return null;

  const logs = await guild.fetchAuditLogs({
    type: AuditLogEvent.BotAdd,
    limit: 8
  });
  const entry = logs.entries.find((item) => {
    const targetId = item.targetId ?? item.target?.id;
    return targetId === guild.client.user?.id;
  });
  if (!entry?.executor) return null;
  return {
    userId: entry.executor.id,
    username: entry.executor.tag ?? entry.executor.username,
    addedAt: entry.createdAt?.toISOString?.() ?? new Date().toISOString()
  };
}

function buildOwnerOnboardingEmbeds({ guild }) {
  const intro = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.nexalogo} Gracias por confiar en NexaDesk`)
    .setImage('attachment://nexadesk-ticket-flow.png')
    .setDescription([
      `Ya estoy dentro de **${guild.name}**. Gracias de verdad por dejar que NexaDesk cuide tus tickets.`,
      '',
      'Estoy revisando canales y roles para autoconfigurar lo maximo posible. Si algo no esta claro, te preguntare por MD a ti y a quien haya agregado el bot.'
    ].join('\n\n'))
    .addFields(
      {
        name: `${EMOJIS.check} Haz esto ahora`,
        value: [
          `1. Abre la dashboard: ${PUBLIC_DASHBOARD_URL}`,
          '2. Revisa categoria de tickets, rol staff y prompt IA del servidor.',
          '3. Asegurate de que el rol de NexaDesk este por encima del staff y tenga Manage Channels, Manage Roles, Manage Messages, View Audit Log y Moderate Members.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.server} Dile esto a tu staff`,
        value: [
          'NexaDesk responde al usuario hasta que un staff entre claramente al ticket.',
          'Si un humano se encarga, puede escribir algo como "Nexa, me encargo yo" o usar `/desactivar ia`.',
          'Cuando termine, puede decir "Nexa, he terminado" o usar `/activar ia` para devolver el ticket a la IA.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.global} Lo esencial que hace`,
        value: [
          'Funciona con paneles propios o con otros bots de tickets.',
          'Usa IA con contexto del servidor, lee capturas cuando haga falta, escala a staff y guarda transcripciones.',
          'Security Guard protege contra spam, links sospechosos, bots no verificados, alts y acciones peligrosas.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.check} Si quieres ir a nivel Pro`,
        value: [
          'Premium desbloquea Voz Pro, Modo examen, IA prioritaria, transcripciones inteligentes, Security Plus, SLA Radar, Growth Engine, Alianzas Pro, Team Assist y Affiliate Boost.',
          `Se activa desde la dashboard en **Premium**: ${PUBLIC_DASHBOARD_URL}#premium`
        ].join('\n')
      }
    )
    .setFooter({ text: 'Si necesitas ayuda: /ayuda o https://discord.gg/vVXbq7ePEZ' })
    .setTimestamp(new Date());

  return [intro];
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
        .setLabel('Ver Premium')
        .setURL(`${PUBLIC_DASHBOARD_URL}#premium`),
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
      'Para tickets privados y seguridad necesito **Manage Channels**, **Manage Roles**, **Manage Messages**, **View Audit Log**, **Moderate Members**, **Kick Members** y **Ban Members**.',
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
    content: `${EMOJIS.check} IA reactivada. NexaDesk vuelve a escuchar y responder en este ticket.`
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
    .setTitle(`${EMOJIS.nexalogo} Estado del ticket`)
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

async function handleTicketPriorityCommand({ interaction, storage }) {
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
    await interaction.editReply('Solo staff o usuarios con Manage Server pueden calcular prioridad del ticket.');
    return;
  }

  const priority = analyzeTicketPriority({ ticket, messages });
  const embed = new EmbedBuilder()
    .setColor(priority.color)
    .setTitle(`${EMOJIS.wifi} Triage inteligente del ticket`)
    .setDescription(`Prioridad **${priority.label}** con score **${priority.score}/100**.`)
    .addFields(
      { name: 'Siguiente accion', value: priority.action.slice(0, 1024) },
      { name: 'SLA recomendado', value: priority.sla, inline: true },
      { name: 'Estado actual', value: ticket.status ?? 'open', inline: true },
      { name: 'Senales detectadas', value: priority.signals.length ? priority.signals.slice(0, 8).join('\n') : 'Sin senales de riesgo fuerte.' }
    )
    .setFooter({ text: 'NexaDesk Ticket Triage' })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed], allowedMentions: { roles: [], users: [] } });
}

function analyzeTicketPriority({ ticket, messages = [] }) {
  const signals = [];
  let score = 0;
  let primary = 'normal';
  const userMessages = messages.filter((item) => item.role === 'user' || (!item.authorBot && item.role !== 'assistant' && item.role !== 'system'));
  const fullText = userMessages.map((item) => item.content ?? '').join('\n').slice(-9000);
  const normalized = normalizeText(fullText);
  const latestUser = [...userMessages].reverse().find((item) => item.content?.trim());
  const latestAssistant = [...messages].reverse().find((item) => item.role === 'assistant' || item.authorBot);
  const openedAt = Date.parse(ticket.createdAt ?? '') || Date.now();
  const updatedAt = Date.parse(ticket.updatedAt ?? ticket.createdAt ?? '') || openedAt;
  const ageHours = Math.max(0, (Date.now() - openedAt) / 3600000);
  const idleHours = Math.max(0, (Date.now() - updatedAt) / 3600000);

  const add = (points, label, key = null) => {
    score += points;
    signals.push(`${EMOJIS.rightArrow} ${label}`);
    if (key) primary = key;
  };

  if (userMessages.some((item) => isCrisisRiskMessage(item.content))) {
    add(100, 'Riesgo de autolesion o crisis: staff inmediato.', 'crisis');
  }
  if (/\b(?:amenaza|amenazado|acoso|acosar|dox|doxing|revelacion de secretos|chantaje|extorsion|suplantacion)\b/.test(normalized)) {
    add(38, 'Caso sensible de seguridad/comunidad.', primary === 'crisis' ? null : 'safety');
  }
  if (/\b(?:scam|estafa|phishing|token|malware|nitro gratis|robux gratis|link sospechoso)\b/.test(normalized)) {
    add(34, 'Posible fraude, scam o link malicioso.', primary === 'crisis' ? null : 'fraud');
  }
  if (/\b(?:blacklist|globalban|xn protect|aviso de blacklist global)\b/.test(normalized)) {
    add(28, 'Hay senales de blacklist o revision XN Protect.', primary === 'crisis' ? null : 'blacklist');
  }
  if (latestUser && isUserRequestingStaff(latestUser.content)) {
    add(24, 'El usuario ha pedido asistencia humana.', primary === 'normal' ? 'staff' : null);
  }
  if (/\b(?:alianza|partner|partnership|plantilla)\b/.test(normalized)) {
    add(14, 'Flujo de alianza detectado.', primary === 'normal' ? 'alliance' : null);
  }
  if (/\[adjunto:|captura|imagen|foto|video|prueba|evidencia/.test(normalized)) {
    add(10, 'Incluye o solicita pruebas visuales.');
  }
  if (latestUser && (!latestAssistant || (Date.parse(latestUser.createdAt ?? '') || 0) > (Date.parse(latestAssistant.createdAt ?? '') || 0))) {
    add(16, 'El ultimo mensaje guardado es del usuario.');
  }
  if (['escalated', 'staff_waiting', 'staff_active'].includes(ticket.status)) {
    add(18, 'El ticket ya esta marcado para staff.');
  }
  if (ageHours >= 24) add(22, 'Ticket abierto desde hace mas de 24h.');
  else if (ageHours >= 6) add(10, 'Ticket abierto desde hace mas de 6h.');
  if (idleHours >= 12) add(10, 'Ticket sin actividad reciente relevante.');

  score = Math.min(100, Math.max(0, score));
  const level = score >= 90
    ? { label: 'CRITICA', color: 0xff3333, sla: 'Ahora mismo' }
    : score >= 65
      ? { label: 'ALTA', color: 0xff9900, sla: '< 15 min' }
      : score >= 35
        ? { label: 'MEDIA', color: 0xffcc00, sla: '< 1 h' }
        : { label: 'BAJA', color: 0xffffff, sla: '< 6 h' };

  return {
    score,
    label: level.label,
    color: level.color,
    sla: level.sla,
    signals: dedupeSignals(signals),
    action: buildTicketPriorityAction(primary, { ticket, latestUser })
  };
}

function dedupeSignals(signals = []) {
  return [...new Set(signals)].slice(0, 10);
}

function buildTicketPriorityAction(primary, { ticket, latestUser }) {
  if (primary === 'crisis') {
    return 'Entrar ya al ticket, mantener al usuario acompanado y activar el protocolo humano del servidor. No dejarlo solo con la IA.';
  }
  if (primary === 'safety') {
    return 'Que un staff revise pruebas, usuarios implicados y contexto antes de cerrar. Si hay amenaza/acoso, conservar transcripcion.';
  }
  if (primary === 'fraud') {
    return 'Revisar links/pruebas, borrar contenido peligroso si procede y dejar constancia para Security Guard.';
  }
  if (primary === 'blacklist') {
    return 'No banear automaticamente: revisar el aviso XN Protect, motivo, prueba y decidir manualmente.';
  }
  if (primary === 'staff') {
    return `Responder como staff a ${ticket.openedBy ? `<@${ticket.openedBy}>` : 'la persona del ticket'} y decidir si NexaDesk debe pausar la IA.`;
  }
  if (primary === 'alliance') {
    return 'Continuar el flujo de alianza: pedir plantilla, confirmar que es la correcta, enviar plantilla del servidor, pedir captura de verificacion y publicar en el canal configurado.';
  }
  if (latestUser?.content) {
    return 'NexaDesk puede seguir atendiendo. Si el staff entra, conviene usar /ticket resumen antes de responder.';
  }
  return 'Sin mensajes de usuario suficientes. Revisa que el ticket se haya creado correctamente y que la transcripcion este activa.';
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
      `${EMOJIS.check} Ticket cerrado.`,
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
      : `Soporte por voz bloqueado. Activa Premium desde ${PUBLIC_DASHBOARD_URL}#premium.`)
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
        `Activalo desde ${PUBLIC_DASHBOARD_URL}#premium o abre ticket en soporte para validacion manual.`
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
    voiceSupportEnabled: true,
    premium: normalizePremiumConfig(DEFAULT_PREMIUM_MODULES, { plan: 'pro', voiceSupportEnabled: true })
  });

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.check} Premium activado`)
    .setDescription(`Todas las funciones premium quedan activas para **${updated.guildName ?? guildId}**.`)
    .addFields(
      { name: 'Servidor', value: guildId, inline: true },
      { name: 'Plan', value: updated.plan ?? 'pro', inline: true },
      { name: 'Voz Pro', value: updated.voiceSupportEnabled ? 'Activa' : 'Pendiente', inline: true },
      { name: 'Incluye', value: 'Voz Pro, Modo examen, IA prioritaria, transcripciones inteligentes, Security Plus, branding propio, informes, Growth Engine, Churn Radar, SLA Radar, Auto-config Pro, Alianzas Pro, Team Assist y analitica premium.' }
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

async function handlePremiumCommand({ interaction, storage, config }) {
  const guildConfig = interaction.guildId
    ? await storage.getGuildConfig(interaction.guildId).catch(() => null)
    : null;
  const checkout = getPremiumCheckoutConfig(config);
  const premiumActive = isPremiumEntitled(guildConfig ?? {});
  const dashboardPremiumUrl = new URL('/#premium', config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL).toString();
  const featureText = PREMIUM_SALES_FEATURES
    .map((feature) => `**${feature.title}:** ${feature.description}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(premiumActive ? 0xf4c95d : 0xffffff)
    .setTitle(`${EMOJIS.check} NexaDesk Premium`)
    .setDescription(premiumActive
      ? `Este servidor ya tiene Premium activo. Puedes ajustar modulos desde la dashboard.`
      : `${checkout.slots} servidores Premium por **${checkout.displayPrice}**. Pensado para vender soporte serio sin cambiar tu sistema de tickets.`)
    .addFields(
      { name: `${EMOJIS.global} Incluye`, value: featureText },
      {
        name: `${EMOJIS.wifi} Por que se paga solo`,
        value: [
          'Reduce tickets repetitivos y espera de usuarios.',
          'Da voz, examenes, transcripciones y seguridad avanzada como valor visible.',
          'Convierte tickets bien resueltos en reviews y confianza para crecer.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.server} Estado`,
        value: [
          `Servidor: **${interaction.guild?.name ?? 'DM'}**`,
          `Plan actual: **${premiumActive ? 'Premium activo' : 'Free'}**`,
          `Pago: **${checkout.providerLabel}**`
        ].join('\n')
      }
    )
    .setFooter({ text: 'NexaDesk Premium - 3 servidores por pack' })
    .setTimestamp(new Date());

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(premiumActive ? 'Gestionar Premium' : 'Comprar Premium')
        .setURL(dashboardPremiumUrl),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Soporte y activacion')
        .setURL(checkout.supportUrl || SUPPORT_SERVER_URL)
    )
  ];

  await interaction.reply({ embeds: [embed], components, ephemeral: true });
}

async function handleAffiliateCommand({ interaction, storage, config, client }) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'codigo') {
    await interaction.deferReply({ ephemeral: true });
    const profile = await storage.getOrCreateAffiliateProfile({
      discordUserId: interaction.user.id,
      username: interaction.user.tag ?? interaction.user.username,
      rewardThreshold: config.AFFILIATE_REWARD_SERVER_COUNT,
      rewardSlots: config.AFFILIATE_REWARD_SLOTS,
      rewardDays: config.AFFILIATE_REWARD_DAYS
    });
    const progress = buildAffiliateProgress(profile);
    const embed = new EmbedBuilder()
      .setColor(0xf4c95d)
      .setTitle(`${EMOJIS.global} Tu codigo de afiliado NexaDesk`)
      .setDescription([
        `Tu codigo es: \`${profile.code}\``,
        '',
        'Compártelo con owners que vayan a invitar NexaDesk. Cuando el bot entre a su servidor, ellos deben usar:',
        `\`/afiliado server codigo:${profile.code}\``
      ].join('\n'))
      .addFields(
        { name: 'Progreso', value: `${progress.totalRedemptions}/${progress.rewardThreshold} servidores registrados en el ciclo actual.`, inline: true },
        { name: 'Recompensa', value: `${profile.rewardSlots} slot Premium durante ${profile.rewardDays} dias cada ${profile.rewardThreshold} servidores.`, inline: true },
        { name: 'Te faltan', value: `${progress.remainingForNextReward || profile.rewardThreshold} servidores para el siguiente slot.`, inline: true }
      )
      .setFooter({ text: 'Cada servidor solo puede registrar un codigo una vez.' })
      .setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (subcommand === 'server') {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Este comando debe usarse dentro del servidor que quiere registrar el codigo.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Necesitas Manage Server para registrar un codigo de afiliado en este servidor.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const code = normalizeAffiliateCode(interaction.options.getString('codigo', true));
    const result = await storage.recordAffiliateRedemption({
      code,
      guildId: interaction.guildId,
      guildName: interaction.guild?.name ?? `Servidor ${interaction.guildId}`,
      redeemedByUserId: interaction.user.id,
      redeemedByUsername: interaction.user.tag ?? interaction.user.username,
      rewardThreshold: config.AFFILIATE_REWARD_SERVER_COUNT,
      rewardSlots: config.AFFILIATE_REWARD_SLOTS,
      rewardDays: config.AFFILIATE_REWARD_DAYS
    });

    if (result.alreadyRedeemed) {
      const redemption = normalizeAffiliateRedemption(result.redemption);
      await interaction.editReply([
        `${EMOJIS.wifi} Este servidor ya tiene un codigo de afiliado registrado.`,
        `Codigo usado: \`${redemption.code}\``,
        'Por seguridad y para evitar abuso, no se puede cambiar desde Discord.'
      ].join('\n'));
      return;
    }

    const profile = normalizeAffiliateProfile(result.profile);
    const progress = buildAffiliateProgress(profile);
    await notifyAffiliateOwner({ client, profile, guildName: interaction.guild?.name ?? interaction.guildId, rewardPurchase: result.rewardPurchase }).catch((error) => {
      console.warn(`Could not notify affiliate owner ${profile.discordUserId}:`, error?.message ?? error);
    });

    const embed = new EmbedBuilder()
      .setColor(0xf4c95d)
      .setTitle(`${EMOJIS.check} Codigo de afiliado registrado`)
      .setDescription([
        `Servidor registrado correctamente con el codigo \`${profile.code}\`.`,
        '',
        `El afiliado recibio un aviso por MD. Le faltan **${progress.remainingForNextReward || profile.rewardThreshold} servidores** para su siguiente recompensa.`
      ].join('\n'))
      .addFields(
        { name: 'Servidor', value: interaction.guild?.name ?? interaction.guildId, inline: true },
        { name: 'Recompensa', value: result.rewardPurchase ? 'Slot Premium generado.' : `Cada ${profile.rewardThreshold} servidores = ${profile.rewardSlots} slot Premium / ${profile.rewardDays} dias.`, inline: true }
      )
      .setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
  }
}

async function notifyAffiliateOwner({ client, profile, guildName, rewardPurchase }) {
  const user = await client.users.fetch(profile.discordUserId).catch(() => null);
  if (!user) return;
  const progress = buildAffiliateProgress(profile);
  const remaining = progress.remainingForNextReward || profile.rewardThreshold;
  const lines = [
    `${EMOJIS.global} **ALGUIEN HA UTILIZADO TU CODIGO DE AFILIADO**`,
    '',
    `Tu codigo \`${profile.code}\` ha sido registrado en **${guildName}**.`,
    `Te quedan **${remaining} servidores** para conseguir **1 servidor Premium**.`
  ];
  if (rewardPurchase) {
    lines.push('', `${EMOJIS.check} Acabas de desbloquear **${rewardPurchase.slotsPurchased} slot Premium durante ${profile.rewardDays} dias**. Entra en la dashboard y activalo en el servidor que quieras.`);
  }
  await user.send(lines.join('\n'));
}

async function handleDmOwnerCommand({ interaction, storage, client, config }) {
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
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    await interaction.editReply('No encuentro ese servidor. Comprueba que NexaDesk siga dentro y que el ID sea correcto.');
    return;
  }

  const existing = await storage.getGuildConfig(guildId).catch(() => null);
  const installer = await fetchBotInstallerInfo(guild).catch(() => null);
  if (installer) {
    await storage.upsertGuildConfig(guildId, {
      guildName: guild.name,
      addedByUserId: installer.userId,
      addedByUsername: installer.username,
      addedAt: installer.addedAt,
      addedByDetectedAt: new Date().toISOString()
    }).catch(() => {});
  }

  const ownerMember = await guild.fetchOwner().catch(() => null);
  const targets = new Map();
  if (ownerMember?.user) targets.set(ownerMember.user.id, { user: ownerMember.user, label: 'owner' });
  const installerId = installer?.userId ?? existing?.addedByUserId;
  if (installerId && !targets.has(installerId)) {
    const installerUser = await client.users.fetch(installerId).catch(() => null);
    if (installerUser) targets.set(installerUser.id, { user: installerUser, label: 'instalador' });
  }

  if (!targets.size) {
    await interaction.editReply('No pude resolver ni owner ni instalador para mandar el MD.');
    return;
  }

  const results = [];
  for (const { user, label } of targets.values()) {
    const sent = await sendOwnerOnboardingDm({
      user,
      guild,
      config,
      prefix: `${EMOJIS.nexalogo} Reenvio manual del setup de **NexaDesk** para **${guild.name}**. Rol detectado: **${label}**.`
    }).then(() => true).catch((error) => {
      results.push(`${label}: fallo (${error?.code ?? error?.message ?? 'DM cerrado'})`);
      return false;
    });
    if (sent) results.push(`${label}: enviado a ${user.tag ?? user.username}`);
  }

  await interaction.editReply([
    `${EMOJIS.check} Onboarding reenviado para **${guild.name}**.`,
    ...results.map((line) => `- ${line}`)
  ].join('\n'));
}

async function handleAdminCodeCommand({ interaction, storage, config }) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Este comando solo se puede usar dentro del servidor autorizado.',
      ephemeral: true
    });
    return;
  }

  const allowedRoleId = config.ADMIN_CODE_ROLE_ID || ADMIN_CODE_ROLE_ID;
  if (!interaction.member?.roles?.cache?.has(allowedRoleId)) {
    await interaction.reply({
      content: 'No tienes el rol autorizado para generar codigos de /admin.',
      ephemeral: true
    });
    return;
  }

  const settings = await storage.getGlobalSettings();
  const currentRecord = settings?.adminAccessCode;
  const canReuse = canReuseAdminAccessCode({
    record: currentRecord,
    config,
    createdBy: interaction.user.id
  });
  const code = canReuse ? getAdminAccessCodeValue({ record: currentRecord, config }) : generateAdminCode();
  const record = canReuse
    ? currentRecord
    : buildAdminAccessCode({
      code,
      config,
      createdBy: interaction.user.id,
      createdByTag: interaction.user.tag ?? interaction.user.username,
      guildId: interaction.guildId
    });
  if (!canReuse) {
    await storage.updateGlobalSettings({ adminAccessCode: record });
  }

  const expiresAt = Math.round(Date.parse(record.expiresAt) / 1000);
  await interaction.reply({
    content: [
      `${EMOJIS.check} ${canReuse ? 'Codigo activo' : 'Codigo nuevo'} para **/admin**: \`${code}\``,
      `Caduca <t:${expiresAt}:R> y se invalida al primer uso.`,
      `Ruta: ${new URL('/admin', PUBLIC_DASHBOARD_URL).toString()}`,
      canReuse
        ? 'Te he devuelto el mismo codigo activo para evitar invalidarlo por pedirlo varias veces.'
        : 'Si lo pides otra vez antes de usarlo, te devolvere este mismo codigo mientras siga activo.'
    ].join('\n'),
    ephemeral: true
  });
}

async function handleMaintenanceCommand({ interaction, storage }) {
  if (interaction.user.id !== PREMIUM_ADMIN_USER_ID) {
    await interaction.reply({
      content: 'Este comando solo puede usarlo el owner global de NexaDesk.',
      ephemeral: true
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'estado') {
    const maintenance = await storage.getMaintenanceState();
    await interaction.reply({
      embeds: [buildMaintenanceStatusEmbed(maintenance)],
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const now = new Date().toISOString();
  if (subcommand === 'activar') {
    const message = interaction.options.getString('mensaje')?.trim();
    const delaySeconds = interaction.options.getInteger('delay_segundos');
    const maintenance = await storage.setMaintenanceState({
      enabled: true,
      message: message || undefined,
      delayMs: delaySeconds ? delaySeconds * 1000 : undefined,
      enabledBy: interaction.user.id,
      enabledAt: now,
      disabledBy: null,
      disabledAt: null
    });
    await interaction.editReply({
      embeds: [buildMaintenanceStatusEmbed(maintenance).setDescription('Modo mantenimiento global activado para servidores Free.')]
    });
    return;
  }

  if (subcommand === 'desactivar') {
    const maintenance = await storage.setMaintenanceState({
      enabled: false,
      disabledBy: interaction.user.id,
      disabledAt: now
    });
    await interaction.editReply({
      embeds: [buildMaintenanceStatusEmbed(maintenance).setDescription('Modo mantenimiento global desactivado.')]
    });
  }
}

function buildMaintenanceStatusEmbed(value = {}) {
  const maintenance = normalizeMaintenanceState(value);
  return new EmbedBuilder()
    .setColor(maintenance.enabled ? 0xffcc00 : 0xffffff)
    .setTitle(`${EMOJIS.wifi} Modo mantenimiento NexaDesk`)
    .setDescription(maintenance.enabled ? 'Activo para servidores Free.' : 'Inactivo. Todos los servidores responden con velocidad normal.')
    .addFields(
      { name: 'Estado', value: maintenance.enabled ? 'Activo' : 'Inactivo', inline: true },
      { name: 'Delay Free', value: `${Math.round(getMaintenanceDelayMs(maintenance) / 1000)}s`, inline: true },
      { name: 'Premium', value: 'Sin ralentizacion', inline: true },
      { name: 'Mensaje publico', value: buildMaintenanceNoticeText(maintenance).slice(0, 1024) }
    )
    .setTimestamp(new Date());
}

async function handleSecurityCommand({ interaction, storage }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Este comando solo se puede usar dentro de un servidor.', ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Necesitas permiso de Manage Server para configurar la seguridad.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const guildConfig = await storage.getGuildConfig(interaction.guildId);
  const current = normalizeSecurityConfig(guildConfig?.security);

  if (subcommand === 'estado') {
    await interaction.reply({
      embeds: [buildSecurityStatusEmbed({ guild: interaction.guild, security: current })],
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'desactivar') {
    const updated = await storage.upsertGuildConfig(interaction.guildId, {
      guildName: interaction.guild.name,
      security: normalizeSecurityConfig({ ...current, enabled: false })
    });
    await interaction.reply({
      embeds: [buildSecurityStatusEmbed({ guild: interaction.guild, security: updated.security })],
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'configurar') {
    const level = normalizeSecurityLevel(interaction.options.getString('nivel') ?? current.level);
    const logChannel = interaction.options.getChannel('canal_logs', false);
    const next = normalizeSecurityConfig({
      level,
      enabled: true,
      logChannelId: logChannel?.id ?? current.logChannelId,
      logChannelName: logChannel?.name ?? current.logChannelName
    });

    for (const [optionName, key] of [
      ['antiflood', 'antiFlood'],
      ['antilinks', 'antiScamLinks'],
      ['automod', 'antiOffensive'],
      ['antibots', 'antiBot'],
      ['antialts', 'antiAlt'],
      ['antinuke', 'antiNuke']
    ]) {
      const value = interaction.options.getBoolean(optionName);
      if (value !== null) next[key] = value;
    }

    const minAge = interaction.options.getInteger('edad_minima_dias');
    if (minAge !== null) next.minAccountAgeDays = minAge;

    const updated = await storage.upsertGuildConfig(interaction.guildId, {
      guildName: interaction.guild.name,
      security: normalizeSecurityConfig(next)
    });

    await interaction.reply({
      content: 'Security Guard actualizado. Si quieres proteccion completa, re-invita NexaDesk desde la dashboard para aplicar los permisos nuevos.',
      embeds: [buildSecurityStatusEmbed({ guild: interaction.guild, security: updated.security })],
      ephemeral: true
    });
  }
}

function buildSecurityStatusEmbed({ guild, security }) {
  const config = normalizeSecurityConfig(security);
  const level = SECURITY_LEVELS[config.level];
  return new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.wifi} Security Guard`)
    .setDescription(`Estado de seguridad para **${guild?.name ?? 'este servidor'}**.`)
    .addFields(
      { name: `${EMOJIS.check} Estado`, value: config.enabled ? 'Activo' : 'Desactivado', inline: true },
      { name: `${EMOJIS.server} Nivel`, value: level.label, inline: true },
      { name: `${EMOJIS.nexalogo} Resumen`, value: summarizeSecurityConfig(config) },
      {
        name: `${EMOJIS.rightArrow} Modulos`,
        value: [
          `Anti-flood: **${config.antiFlood ? 'on' : 'off'}** (${config.floodLimit} mensajes/${config.floodWindowSeconds}s)`,
          `Anti-links IA: **${config.antiScamLinks ? 'on' : 'off'}**`,
          `XN Protect Automod: **${config.antiOffensive ? 'on' : 'off'}**`,
          `Anti-bots Top.gg: **${config.antiBot ? 'on' : 'off'}**`,
          `Anti-alts: **${config.antiAlt ? 'on' : 'off'}** (${config.minAccountAgeDays} dias)`,
          `Anti-nuke: **${config.antiNuke ? 'on' : 'off'}** (${config.nukeLimit} acciones/${config.nukeWindowSeconds}s)`,
          `Canales/config: **${config.antiNuke ? 'vigilado' : 'off'}** (creaciones masivas, permisos y cambios del servidor)`
        ].join('\n')
      },
      { name: `${EMOJIS.wifi} Logs`, value: config.logChannelId ? `<#${config.logChannelId}>` : 'Sin canal de logs. Se avisara al owner por MD cuando sea importante.', inline: true },
      { name: `${EMOJIS.ban} Permisos recomendados`, value: 'View Audit Log, Manage Messages, Moderate Members, Kick Members y Ban Members.' }
    )
    .setFooter({ text: 'NexaDesk Security Guard' })
    .setTimestamp(new Date());
}

async function handleBlacklistCommand({ interaction, storage }) {
  if (!isGlobalBlacklistAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Este comando solo puede usarlo el owner autorizado de NexaDesk.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'agregar') {
    const userId = interaction.options.getString('usuario_id', true).trim();
    if (!isDiscordSnowflake(userId)) {
      await interaction.reply({ content: 'Pon un ID de usuario valido.', ephemeral: true });
      return;
    }

    const reason = interaction.options.getString('motivo', true).trim();
    const durationInput = interaction.options.getString('duracion') || 'permanente';
    const duration = parseBlacklistDuration(durationInput);
    const entry = await storage.upsertBlacklistEntry({
      userId,
      banCode: buildGlobalBanCode(userId),
      reason,
      duration: duration.duration,
      expiresAt: duration.expiresAt,
      active: true,
      createdBy: interaction.user.id
    });

    await interaction.reply({
      embeds: [buildBlacklistEntryEmbed(entry, [])],
      content: `Usuario agregado a blacklist global con codigo \`${entry.banCode}\`.`,
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'quitar') {
    const id = interaction.options.getString('id', true).trim();
    const updated = await storage.deactivateBlacklistEntry(id, interaction.user.id);
    await interaction.reply({
      content: updated
        ? `Blacklist desactivada para \`${updated.userId}\` (${updated.banCode}).`
        : 'No encontre esa entrada de blacklist.',
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'ver') {
    const id = interaction.options.getString('id', true).trim();
    const entry = await storage.getBlacklistEntry(id);
    if (!entry) {
      await interaction.reply({ content: 'No encontre esa entrada de blacklist.', ephemeral: true });
      return;
    }
    const evidence = await storage.listBlacklistEvidence(entry.userId);
    await interaction.reply({
      embeds: [buildBlacklistEntryEmbed(entry, evidence)],
      ephemeral: true
    });
    return;
  }

  if (subcommand === 'listar') {
    const entries = await storage.listBlacklistEntries();
    const active = entries.filter((entry) => isBlacklistEntryActive(entry));
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffffff)
          .setTitle(`${EMOJIS.ban} Blacklist global`)
          .setDescription(active.length
            ? active.slice(0, 15).map((entry) => `\`${entry.banCode}\` - <@${entry.userId}> - ${entry.reason}`).join('\n')
            : 'No hay usuarios activos en blacklist global.')
          .setFooter({ text: `${active.length} entradas activas` })
          .setTimestamp(new Date())
      ],
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }
}

async function handleAttachBlacklistEvidenceCommand({ interaction, storage }) {
  if (!isGlobalBlacklistAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Este comando solo puede usarlo el owner autorizado de NexaDesk.', ephemeral: true });
    return;
  }

  const id = interaction.options.getString('id', true).trim();
  const file = interaction.options.getAttachment('archivo', true);
  const description = interaction.options.getString('descripcion') ?? '';
  const entry = await storage.getBlacklistEntry(id);
  if (!entry) {
    await interaction.reply({ content: 'No existe esa entrada de blacklist. Creala primero con `/blacklist agregar`.', ephemeral: true });
    return;
  }

  const evidence = await storage.addBlacklistEvidence({
    userId: entry.userId,
    banCode: entry.banCode,
    attachmentUrl: file.url,
    proxyUrl: file.proxyURL,
    fileName: file.name,
    contentType: file.contentType,
    description,
    createdBy: interaction.user.id
  });

  await interaction.reply({
    content: `Prueba adjuntada a \`${entry.banCode}\`: ${evidence.fileName ?? evidence.attachmentUrl}`,
    ephemeral: true
  });
}

async function handleGlobalBlacklistMemberJoin({ member, storage }) {
  const entry = await storage.getBlacklistEntry(member.user.id);
  if (!entry || !isBlacklistEntryActive(entry)) return false;

  const evidence = await storage.listBlacklistEvidence(entry.userId).catch(() => []);
  await sendGlobalBlacklistDm({ user: member.user, guild: member.guild, entry, evidence }).catch((error) => {
    console.warn(`Could not DM global blacklist notice to ${member.user.tag}:`, error?.message ?? error);
  });

  if (member.bannable) {
    await member.ban({
      reason: `NexaDesk global blacklist ${entry.banCode}: ${entry.reason}`.slice(0, 500)
    });
    console.log(`Global blacklist banned ${member.user.tag} (${member.user.id}) in ${member.guild.name}.`);
  } else {
    console.warn(`Global blacklist match ${member.user.tag} in ${member.guild.name}, but member is not bannable.`);
  }

  return true;
}

async function sendGlobalBlacklistDm({ user, guild, entry, evidence = [] }) {
  const activeEvidence = evidence.filter((item) => item.attachmentUrl || item.proxyUrl);
  const mainEmbed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.ban} Baneo global NexaDesk`)
    .setDescription(`Has sido baneado automaticamente al entrar en **${guild.name}** porque estas en la blacklist global de NexaDesk.`)
    .addFields(
      { name: 'Motivo', value: entry.reason || 'Sin motivo especificado' },
      { name: 'Duracion', value: entry.duration || 'permanente', inline: true },
      { name: 'Codigo de baneo', value: `\`${entry.banCode}\``, inline: true },
      { name: 'Apelacion', value: `Puedes apelar en el servidor de soporte: ${SUPPORT_SERVER_URL}` },
      { name: 'Pruebas adjuntas', value: activeEvidence.length ? `${activeEvidence.length} archivo(s) adjunto(s) abajo.` : 'No hay pruebas por imagen adjuntas aun.' }
    )
    .setFooter({ text: 'NexaDesk Global Safety' })
    .setTimestamp(new Date());

  const evidenceEmbeds = activeEvidence
    .filter((item) => isImageEvidence(item))
    .slice(0, 4)
    .map((item, index) => new EmbedBuilder()
      .setColor(0xffffff)
      .setTitle(`Prueba ${index + 1}`)
      .setDescription(item.description || item.fileName || 'Imagen adjunta como prueba.')
      .setImage(item.proxyUrl || item.attachmentUrl));

  const links = activeEvidence
    .filter((item) => !isImageEvidence(item))
    .slice(0, 8)
    .map((item, index) => `${index + 1}. ${item.fileName || 'Archivo'}: ${item.attachmentUrl}`)
    .join('\n');

  await user.send({
    content: links ? `Archivos de prueba no embebidos:\n${links}` : undefined,
    embeds: [mainEmbed, ...evidenceEmbeds]
  });
}

function buildBlacklistEntryEmbed(entry, evidence = []) {
  return new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.ban} ${entry.banCode}`)
    .setDescription(entry.active ? 'Entrada activa en blacklist global.' : 'Entrada desactivada.')
    .addFields(
      { name: 'Usuario', value: `<@${entry.userId}> (${entry.userId})`, inline: true },
      { name: 'Duracion', value: entry.duration || 'permanente', inline: true },
      { name: 'Expira', value: entry.expiresAt ? new Date(entry.expiresAt).toLocaleString() : 'No expira', inline: true },
      { name: 'Motivo', value: entry.reason || 'Sin motivo especificado' },
      { name: 'Pruebas', value: evidence.length ? evidence.map((item) => `- ${item.fileName || item.attachmentUrl}`).slice(0, 10).join('\n') : 'Sin pruebas adjuntas' }
    )
    .setFooter({ text: 'NexaDesk Global Safety' })
    .setTimestamp(new Date(entry.updatedAt ?? Date.now()));
}

function isGlobalBlacklistAdmin(userId) {
  return userId === GLOBAL_BLACKLIST_ADMIN_USER_ID;
}

function isDiscordSnowflake(value) {
  return /^\d{17,20}$/.test(String(value ?? '').trim());
}

function isImageEvidence(evidence) {
  if (String(evidence.contentType ?? '').startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(String(evidence.attachmentUrl ?? evidence.proxyUrl ?? ''));
}

function shouldCheckTicketAuthorWithXnProtect({ message, ticket, guildConfig }) {
  if (!message?.author || message.author.bot) return false;
  if (ticket.openedBy) return ticket.openedBy === message.author.id;
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return false;
  if (guildConfig?.staffRoleId && memberHasRole(message.member, guildConfig.staffRoleId)) return false;
  return true;
}

async function maybeAlertXnProtectBlacklist({ storage, channel, guildConfig, ticket, user, blacklistAlertedChannels }) {
  if (!user?.id || user.bot) return ticket;
  const alertKey = `${channel.id}:${user.id}`;
  if (blacklistAlertedChannels?.has(alertKey)) return ticket;

  const alreadyAlerted = await hasXnProtectAlertTranscript(storage, channel.id, user.id);
  if (alreadyAlerted) {
    blacklistAlertedChannels?.add(alertKey);
    return ticket;
  }

  const result = await checkXnProtectGlobalBan(user.id);
  if (!result.checked) {
    console.warn(`XN Protect blacklist check failed for ${user.id}: ${result.error}`);
    return ticket;
  }
  if (!result.blacklisted) return ticket;

  blacklistAlertedChannels?.add(alertKey);
  const alert = buildXnProtectBlacklistAlert({ user, guildConfig, result });
  const sent = await channel.send(alert).catch((error) => {
    console.error(`Failed to send XN Protect blacklist alert in ${channel.id}:`, error);
    return null;
  });
  if (!sent) return ticket;

  await saveTranscript(storage, sent, 'assistant').catch((error) => {
    console.error(`Failed to save XN Protect blacklist alert transcript in ${channel.id}:`, error);
  });
  await storage.addTranscriptMessage({
    guildId: channel.guild?.id,
    channelId: channel.id,
    messageId: `xnprotect-alert-${user.id}-${Date.now()}`,
    authorId: sent.author.id,
    authorName: sent.author.username,
    authorBot: true,
    role: 'system',
    content: `XN Protect globalban alert for ${user.id}: ${result.reason || 'sin motivo'}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save XN Protect blacklist alert marker in ${channel.id}:`, error);
  });

  if (!isClosedTicket(ticket) && ticket.status !== 'escalated') {
    return storage.updateTicket(ticket.channelId, { status: 'escalated' }).catch((error) => {
      console.error(`Failed to mark XN Protect ticket ${ticket.channelId} as escalated:`, error);
      return ticket;
    });
  }

  return ticket;
}

async function maybeAlertTicketOpenerXnProtect({ storage, channel, guildConfig, ticket, openerId, blacklistAlertedChannels }) {
  if (!openerId) {
    console.warn(`Ticket ${channel.id} detected from Ticket King, but opener could not be resolved for XN Protect check.`);
    return ticket;
  }

  const user = await channel.client.users.fetch(openerId).catch(() => ({
    id: openerId,
    bot: false,
    username: `Usuario ${openerId}`
  }));

  return maybeAlertXnProtectBlacklist({
    storage,
    channel,
    guildConfig,
    ticket,
    user,
    blacklistAlertedChannels
  });
}

async function hasXnProtectAlertTranscript(storage, channelId, userId) {
  try {
    const messages = await storage.listTranscriptMessages(channelId);
    return messages.some((message) => String(message.content ?? '').includes(`XN Protect globalban alert for ${userId}`));
  } catch {
    return false;
  }
}

function buildXnProtectBlacklistAlert({ user, guildConfig, result }) {
  const staffMention = guildConfig?.staffRoleId ? `<@&${guildConfig.staffRoleId}> ` : '';
  const proofUrl = result.proof || '';
  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.ban} Aviso de blacklist global`)
    .setDescription([
      `Usuario detectado: <@${user.id}> (\`${user.id}\`)`,
      'NexaDesk **no ha baneado** al usuario. Solo deja este aviso para revision manual del staff.'
    ].join('\n'))
    .addFields(
      { name: `${EMOJIS.global} Fuente`, value: XNPROTECT_BLACKLIST_CREDIT },
      { name: `${EMOJIS.ban} Motivo`, value: result.reason || 'XN Protect no devolvio motivo.' },
      { name: `${EMOJIS.server} Desde`, value: formatXnProtectTimestamp(result.since), inline: true },
      { name: `${EMOJIS.server} Expira`, value: formatXnProtectTimestamp(result.expires), inline: true },
      { name: `${EMOJIS.wifi} Prueba`, value: proofUrl ? proofUrl : 'No hay prueba publica en la respuesta de la API.' }
    )
    .setFooter({ text: 'Revision manual recomendada antes de continuar el ticket.' })
    .setTimestamp(new Date());

  if (isImageUrl(proofUrl)) {
    embed.setImage(proofUrl);
  }

  return {
    content: `${EMOJIS.ban} ${staffMention}Aviso para staff: este usuario aparece en la blacklist global de XN Protect. Revisad el caso antes de continuar.`,
    embeds: [embed],
    allowedMentions: {
      roles: guildConfig?.staffRoleId ? [guildConfig.staffRoleId] : [],
      users: [],
      repliedUser: false
    }
  };
}

function formatXnProtectTimestamp(value) {
  if (!value) return 'No indicado';
  const date = parseXnProtectDate(value);
  if (!date) return String(value);
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

function parseXnProtectDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isImageUrl(value) {
  return /^https?:\/\/.+\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(String(value ?? ''));
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

async function handleAllianceAutosetButton({ interaction, storage }) {
  const [, , guildId, channelId] = interaction.customId.split(':');
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) {
    await interaction.reply({ content: 'No puedo leer esta confirmacion. Repite el diagnostico desde NexaDesk.', ephemeral: true });
    return;
  }

  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!guild || !channel || !isAlliancePublishChannel(channel)) {
    await interaction.reply({ content: 'Ese canal ya no existe o no es de texto/anuncios.', ephemeral: true });
    return;
  }

  const config = await storage.getGuildConfig(guildId).catch(() => null);
  const allowed = interaction.user.id === PREMIUM_ADMIN_USER_ID
    || interaction.user.id === config?.addedByUserId
    || interaction.user.id === guild.ownerId;
  if (!allowed) {
    await interaction.reply({ content: 'Solo el owner del servidor, quien agrego NexaDesk o el owner global puede confirmar esto.', ephemeral: true });
    return;
  }

  await storage.upsertGuildConfig(guildId, {
    guildName: guild.name,
    allianceChannelId: channel.id,
    allianceChannelName: channel.name,
    allianceDetection: {
      status: 'confirmed_by_dm',
      channelId: channel.id,
      channelName: channel.name,
      confidence: 100,
      reason: `Confirmado por ${interaction.user.tag ?? interaction.user.username}`,
      scannedAt: new Date().toISOString()
    }
  });

  await notifyOtherSetupContacts({
    guild,
    guildConfig: config,
    resolver: interaction.user,
    topic: `el canal de alianzas (${channel})`
  });

  await interaction.update({
    content: `${EMOJIS.check} Canal de alianzas confirmado para **${guild.name}**: ${channel}.`,
    embeds: [],
    components: []
  });
}

async function handleAutoConfigButton({ interaction, storage }) {
  const [, , guildId, type, targetId] = interaction.customId.split(':');
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(targetId)) {
    await interaction.reply({ content: 'No puedo leer esta respuesta. Ejecuta `/diagnostico` o reescanea desde la dashboard.', ephemeral: true });
    return;
  }

  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    await interaction.reply({ content: 'Ya no puedo acceder a ese servidor.', ephemeral: true });
    return;
  }

  const config = await storage.getGuildConfig(guildId).catch(() => null);
  const allowed = interaction.user.id === PREMIUM_ADMIN_USER_ID
    || interaction.user.id === config?.addedByUserId
    || interaction.user.id === guild.ownerId;
  if (!allowed) {
    await interaction.reply({ content: 'Solo el owner del servidor, quien agrego NexaDesk o el owner global puede responder esta duda.', ephemeral: true });
    return;
  }

  const patch = {
    guildName: guild.name,
    autoConfig: {
      ...(config?.autoConfig ?? {}),
      status: 'resolved_by_dm',
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: interaction.user.id,
      resolvedByUsername: interaction.user.tag ?? interaction.user.username
    }
  };
  let topic = '';
  let response = '';

  if (type === 'ticket_category') {
    const channel = await guild.channels.fetch(targetId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildCategory) {
      await interaction.reply({ content: 'Esa categoria ya no existe.', ephemeral: true });
      return;
    }
    patch.ticketCategoryId = channel.id;
    patch.ticketCategoryName = channel.name;
    topic = `la categoria de tickets (${channel.name})`;
    response = `${EMOJIS.check} Perfecto. Categoria de tickets configurada en **${guild.name}**: **${channel.name}**.`;
  } else if (type === 'staff_role') {
    const role = await guild.roles.fetch(targetId).catch(() => null);
    if (!role || role.managed || role.name === '@everyone') {
      await interaction.reply({ content: 'Ese rol ya no existe o no se puede usar como staff.', ephemeral: true });
      return;
    }
    patch.staffRoleId = role.id;
    topic = `el rol staff (${role.name})`;
    response = `${EMOJIS.check} Perfecto. Rol staff configurado en **${guild.name}**: **${role.name}**.`;
  } else {
    await interaction.reply({ content: 'No reconozco este tipo de autoconfiguracion.', ephemeral: true });
    return;
  }

  await storage.upsertGuildConfig(guildId, patch);
  await notifyOtherSetupContacts({ guild, guildConfig: config, resolver: interaction.user, topic });
  await interaction.update({ content: response, embeds: [], components: [] });
}

function buildHelpEmbed({ view, config, guild }) {
  const base = new EmbedBuilder()
    .setColor(0xffffff)
    .setFooter({ text: 'NexaDesk - ayuda interactiva' })
    .setTimestamp(new Date());

  if (view === 'create_ticket') {
    return base
      .setTitle(`${EMOJIS.server} Como creo un ticket?`)
      .setDescription('Los tickets se crean desde los paneles publicados por el servidor. NexaDesk puede abrir tickets de texto, menus con preguntas previas, tickets de voz Pro y paneles de Modo examen si el servidor lo configura.')
      .addFields(
        {
          name: `${EMOJIS.rightArrow} Para miembros`,
          value: [
            'Busca el canal de soporte del servidor.',
            'Pulsa el boton del panel o elige una opcion del menu desplegable.',
            'Responde las preguntas previas si aparecen.',
            'Explica el problema con detalle y adjunta capturas o videos si ayudan.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.nexalogo} Que hara NexaDesk`,
          value: [
            'Leera el contexto configurado del servidor.',
            'Te pedira datos si falta informacion.',
            'Si detecta que hace falta una persona, avisara al rol de staff configurado con el resumen del caso.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.check} Atajo util`,
          value: 'Si necesitas una persona directamente, dilo claro dentro del ticket: "necesito asistencia manual".'
        }
      );
  }

  if (view === 'setup') {
    return base
      .setTitle(`${EMOJIS.rightArrow} Como configuro el servidor?`)
      .setDescription(`Servidor actual: **${guild?.name ?? 'tu servidor'}**. La configuracion completa vive en la dashboard.`)
      .addFields(
        {
          name: `${EMOJIS.check} Setup recomendado`,
          value: [
            `1. Abre la dashboard: ${PUBLIC_DASHBOARD_URL}`,
            '2. Inicia sesion con Discord y selecciona el servidor.',
            '3. Elige la categoria donde se abren tickets.',
            '4. Selecciona el rol de staff.',
            '5. Escribe el prompt/contexto del servidor para que la IA responda con criterio.',
            '6. Crea componentes y publica paneles de boton o menu.',
            '7. Ejecuta `/diagnostico` para ver el NexaScore y lo que falta.',
            '8. Entra en Crecimiento para activar valoraciones post-ticket y preparar reviews publicas.',
            '9. Si el servidor tiene Pro, entra en Premium y activa los modulos que quieras ofrecer.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.server} Si ya usas otro bot de tickets`,
          value: 'No tienes que cambiar de sistema. Configura la categoria donde ese bot crea los canales y NexaDesk detectara los tickets nuevos.'
        },
        {
          name: `${EMOJIS.wifi} Staff`,
          value: [
            'Mueve el rol de NexaDesk por encima del rol de staff para poder crear tickets privados.',
            'Diles que usen `/desactivar ia` cuando entren a atender manualmente.',
            'Diles que usen `/ticket prioridad` para ver riesgo/SLA, `/ticket resumen` para leer el caso rapido y `/ticket cerrar` para cerrar con transcripcion.'
          ].join('\n')
        }
      );
  }

  if (view === 'data') {
    return base
      .setTitle(`${EMOJIS.server} Datos, transcripciones y privacidad`)
      .setDescription('NexaDesk guarda lo necesario para que el soporte sea continuo, auditable y facil de revisar desde la dashboard.')
      .addFields(
        {
          name: `${EMOJIS.check} Que se guarda`,
          value: [
            'Configuracion del servidor: categoria, rol staff, prompt, contexto, paneles y componentes.',
            'Tickets detectados o creados desde paneles.',
            'Transcripciones de mensajes del ticket y eventos importantes como escalados, voz o cierre.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.global} Donde se guarda`,
          value: 'En Supabase, para que la dashboard pueda mostrar historial, estadisticas y transcripciones por servidor.'
        },
        {
          name: `${EMOJIS.rightArrow} Quien puede verlo`,
          value: 'La dashboard filtra servidores usando Discord OAuth. Solo aparecen servidores donde el usuario tiene permisos de owner, Administrator o Manage Server.'
        }
      );
  }

  if (view === 'premium') {
    const checkout = getPremiumCheckoutConfig(config);
    return base
      .setTitle(`${EMOJIS.check} Premium de NexaDesk`)
      .setDescription(`Premium esta pensado para servidores que quieren soporte mas rapido, mas humano y mas facil de vender como experiencia profesional. Pack actual: **${checkout.slots} servidores por ${checkout.displayPrice}**.`)
      .addFields(
        {
          name: `${EMOJIS.nexalogo} Funciones incluidas`,
          value: [
            'Voz Pro con STT/TTS y salas privadas vinculadas al ticket.',
            'Modo examen para oposiciones: preguntas automaticas, nota provisional y revision Premium con formulario/sala.',
            'IA prioritaria con respuestas menos genericas y mejores escalados.',
            'Transcripciones inteligentes para staff, dashboard y MD al usuario.',
            'Security Plus para links sospechosos, flood, blacklist y avisos reforzados.',
            'Growth Engine con feedback post-ticket, reviews publicas y Churn Radar.',
            'SLA Radar para tickets frios, usuarios frustrados y tiempos de espera peligrosos.',
            'Auto-config Pro, Alianzas Pro y Team Assist para que el staff trabaje con contexto real.',
            'Branding propio, Affiliate Boost, conversion insights e informes semanales para demostrar valor al owner.',
            'Prioridad normal incluso si el modo mantenimiento global esta activo para servidores Free.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.rightArrow} Como se activa`,
          value: [
            `1. Entra en la dashboard: ${PUBLIC_DASHBOARD_URL}#premium`,
            `2. Compra el pack con ${checkout.providerLabel}.`,
            '3. Vuelve a Premium y elige en que servidores activar tus slots.',
            '4. Si necesitas validacion manual, abre ticket en soporte oficial.',
            'El owner autorizado tambien puede activar casos especiales con `/activarpremium servidor:<ID>`.'
          ].join('\n')
        }
      );
  }

  if (view === 'security') {
    return base
      .setTitle(`${EMOJIS.wifi} Seguridad del servidor`)
      .setDescription('NexaDesk Security Guard protege el servidor sin sustituir tu sistema de tickets. Actua como capa preventiva alrededor del soporte.')
      .addFields(
        {
          name: `${EMOJIS.ban} Que protege`,
          value: [
            'Anti-flood: borra spam rapido y puede aplicar timeout.',
            'Anti-links IA: revisa enlaces con IA para bloquear phishing, estafas, malware y regalos falsos.',
            'XN Protect Automod: borra contenido ofensivo/malicioso y avisa al staff con motivo y palabras detectadas.',
            'Anti-bots Top.gg: solo banea bots que no aparezcan listados en Top.gg; si Top.gg no responde, no banea a ciegas.',
            'Anti-alts: expulsa cuentas demasiado nuevas si lo activas.',
            'Anti-nuke: mira audit logs y reacciona ante acciones masivas en canales, permisos, config del servidor, roles, webhooks, kicks y bans.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.rightArrow} Como se configura`,
          value: [
            `1. Dashboard: ${PUBLIC_DASHBOARD_URL}`,
            '2. Ve a Configuracion > Security Guard.',
            '3. Elige nivel bajo, intermedio o alto y un canal de logs.',
            '4. Actualiza permisos desde el boton de invitacion si Discord bloquea auditoria o moderacion.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.ban} Blacklist global XN Protect`,
          value: [
            'Al abrirse un ticket, NexaDesk consulta si el opener tiene globalban en XN Protect.',
            'Si aparece marcado, **no lo banea**: publica un aviso con motivo, fechas y prueba para que el staff decida manualmente.',
            XNPROTECT_BLACKLIST_CREDIT
          ].join('\n')
        },
        {
          name: `${EMOJIS.check} Comando rapido`,
          value: '`/seguridad configurar nivel:intermedio canal_logs:#logs antilinks:true automod:true`\n`/seguridad estado`\n`/seguridad desactivar`'
        }
      );
  }

  if (view === 'growth') {
    return base
      .setTitle(`${EMOJIS.global} Crecimiento y reviews`)
      .setDescription('Growth Engine transforma tickets bien atendidos en confianza publica, metricas y oportunidades para que el servidor crezca.')
      .addFields(
        {
          name: `${EMOJIS.check} Que desbloquea`,
          value: [
            'Feedback por MD al cerrar tickets.',
            'Rating medio y promotores visibles en dashboard.',
            'Reviews publicas en un canal elegido cuando el rating es alto.',
            'Churn Radar: alerta al staff si alguien queda insatisfecho.'
          ].join('\n')
        },
        {
          name: `${EMOJIS.rightArrow} Como se configura`,
          value: [
            `1. Dashboard: ${PUBLIC_DASHBOARD_URL}`,
            '2. Ve a Crecimiento y elige canal de reviews.',
            '3. Activa pedir feedback por MD.',
            '4. Si el servidor tiene Premium, activa Reviews publicas y Churn Radar.',
            '5. Alternativa por Discord: `/crecimiento configurar canal_reviews:#reviews reviews_publicas:true`.'
          ].join('\n')
        }
      );
  }

  return base
    .setTitle(`${EMOJIS.nexalogo} Centro de ayuda NexaDesk`)
    .setDescription([
      'Elige una categoria para ver la guia exacta.',
      'NexaDesk funciona como moderador de soporte con IA: atiende tickets, pide informacion, escala al staff cuando hace falta y guarda transcripciones para revisarlas desde la dashboard.'
    ].join('\n\n'))
    .addFields(
      {
        name: `${EMOJIS.rightArrow} Categorias disponibles`,
        value: [
          `${EMOJIS.server} Como creo un ticket?`,
          `${EMOJIS.rightArrow} Como configuro el servidor?`,
          `${EMOJIS.ban} Seguridad del servidor`,
          `${EMOJIS.global} Crecimiento y reviews`,
          `${EMOJIS.check} Premium`,
          `${EMOJIS.global} Datos y transcripciones`,
          `${EMOJIS.nexalogo} Comando util: \`/diagnostico\` para auditar el setup actual.`
        ].join('\n')
      },
      {
        name: `${EMOJIS.wifi} Soporte oficial`,
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
        .setCustomId('nexadesk:help:security')
        .setLabel('Seguridad')
        .setStyle(current === 'security' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('nexadesk:help:growth')
        .setLabel('Crecimiento')
        .setStyle(current === 'growth' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('nexadesk:help:premium')
        .setLabel('Premium')
        .setStyle(current === 'premium' ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('nexadesk:help:data')
        .setLabel('Datos')
        .setStyle(current === 'data' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(current === 'premium' ? 'Comprar Premium' : 'Dashboard')
        .setURL(current === 'premium' ? `${PUBLIC_DASHBOARD_URL}#premium` : PUBLIC_DASHBOARD_URL),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Soporte oficial')
        .setURL('https://discord.gg/vVXbq7ePEZ')
    )
  ];
}

async function createTicketFromConfiguredSource({ interaction, storage, guildConfig, panel = null, component = null, answers = [], panelCreatedChannels, blacklistAlertedChannels, config, voiceManager = null, supportAgent = null }) {
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
        `Activa Premium desde ${PUBLIC_DASHBOARD_URL}#premium o abre ticket en soporte si quieres validacion manual.`
      ].join('\n'),
      ephemeral: true
    });
    return;
  }

  const examConfig = isExamTicketMode(ticketMode)
    ? getExamConfigForTicketSource(normalizedPanel, normalizedComponent)
    : null;
  const canUsePremiumExamReview = isExamTicketMode(ticketMode)
    && isPremiumEntitled(guildConfig)
    && examConfig?.reviewEnabled
    && Boolean(examConfig?.formUrl);
  if (isExamTicketMode(ticketMode) && !canUsePremiumExamReview && !examConfig?.questions?.length) {
    await interaction.reply({
      content: [
        `${EMOJIS.nexalogo} Este panel esta en Modo examen, pero no tiene preguntas ni formulario configurado.`,
        'Editalo desde la dashboard y anade preguntas en formato `P: ...`. La revision con formulario externo solo funciona en servidores Premium y con "revision" activada.'
      ].join('\n'),
      ephemeral: true
    });
    return;
  }

  await deferEphemeralInteraction(interaction);

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

  let ticket = await storage.createTicket({
    guildId: interaction.guild.id,
    guildName: interaction.guild.name,
    channelId: channel.id,
    channelName: channel.name,
    categoryId: ticketCategory.id,
    openedBy: interaction.user.id
  });

  if (ticket.alreadyExists) {
    await replyOrEditEphemeral(interaction, { content: `Ticket creado: ${channel}` });
    return;
  }

  const welcome = await channel.send(buildTicketWelcomeMessage({ panel: normalizedPanel, component: normalizedComponent, answers, userMention: `${interaction.user}` }));
  await saveTranscript(storage, welcome, 'assistant');
  if (isExamTicketMode(ticketMode)) {
    const startedExamTicket = await startExamTicket({
      interaction,
      storage,
      channel,
      ticket,
      guildConfig,
      panel: normalizedPanel,
      component: normalizedComponent,
      examConfig,
      config,
      voiceManager
    });
    ticket = startedExamTicket ?? ticket;
  } else {
    await sendContextualTicketOpening({
      storage,
      supportAgent,
      channel,
      ticket,
      guildConfig,
      panel: normalizedPanel,
      component: normalizedComponent,
      answers,
      user: interaction.user
    });
  }
  await sendMaintenanceTicketNotice({ storage, channel, guildConfig });

  await maybeAlertXnProtectBlacklist({
    storage,
    channel,
    guildConfig,
    ticket,
    user: interaction.user,
    blacklistAlertedChannels
  });

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

  await replyOrEditEphemeral(interaction, {
    content: [
      `Ticket creado: ${channel}`,
      ...voiceStatus,
      fallbackReason ? `He usado **${ticketCategory.name}** porque ${fallbackReason}.` : ''
    ].filter(Boolean).join('\n'),
  });
  setTimeout(() => panelCreatedChannels.delete(channel.id), 30_000);
}

function getExamConfigForTicketSource(panel, component) {
  const source = component && isExamTicketMode(component.ticketMode) ? component : panel;
  return normalizeExamConfig(source);
}

async function startExamTicket({ interaction, storage, channel, ticket, guildConfig, panel, component, examConfig, config, voiceManager = null }) {
  const premium = isPremiumEntitled(guildConfig);
  const reviewEnabled = premium && examConfig.reviewEnabled && Boolean(examConfig.formUrl);
  const now = new Date().toISOString();
  const state = normalizeExamState({
    enabled: true,
    mode: reviewEnabled ? 'premium_review' : 'free_questions',
    status: reviewEnabled ? 'awaiting_screen_share' : 'questioning',
    questions: examConfig.questions,
    currentIndex: 0,
    answers: [],
    formUrl: examConfig.formUrl,
    reviewEnabled,
    passScore: examConfig.passScore,
    startedAt: now,
    lastQuestionAt: reviewEnabled ? null : now,
    warnings: reviewEnabled && !voiceManager ? ['Revision por voz sin STT/TTS activo en runtime.'] : []
  });

  let updated = await storage.updateTicket(ticket.channelId, {
    openedBy: ticket.openedBy || interaction.user.id,
    status: reviewEnabled ? 'exam_review' : 'exam',
    examState: state
  });

  if (reviewEnabled) {
    const intro = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffffff)
          .setTitle(`${EMOJIS.nexalogo} Modo examen con revision Premium`)
          .setDescription([
            `${interaction.user}, he preparado el examen supervisado.`,
            `Formulario: ${examConfig.formUrl}`,
            '',
            'Entra a la sala de voz, abre el formulario y comparte pantalla para que el staff pueda supervisar.',
            'Importante: Discord no permite a los bots leer directamente la imagen de una pantalla compartida. NexaDesk deja la sala, la guia por voz y el aviso al staff; la supervision visual la confirma una persona.'
          ].join('\n'))
          .addFields(
            { name: 'Regla del examen', value: 'Si sales del formulario, cambias de ventana o usas ayuda externa, el staff puede anular la prueba.', inline: false },
            { name: 'Cuando empiece', value: 'Cuando staff confirme que ve el formulario, puedes comenzar. Si prefieres correccion automatica, usa preguntas dentro de NexaDesk.', inline: false }
          )
          .setFooter({ text: 'NexaDesk Exam Mode' })
          .setTimestamp(new Date())
      ],
      allowedMentions: { users: [interaction.user.id] }
    });
    await saveTranscript(storage, intro, 'assistant');

    const shouldMentionStaff = await registerTicketEscalation({
      storage,
      message: { guild: interaction.guild, channel, channelId: channel.id },
      guildConfig,
      ticket: updated ?? ticket,
      reason: 'Modo examen Premium requiere supervision humana de pantalla.'
    });
    if (shouldMentionStaff && guildConfig.staffRoleId) {
      const staffNotice = await channel.send({
        content: `<@&${guildConfig.staffRoleId}> Examen supervisado iniciado para ${interaction.user}. Revisad pantalla compartida antes de aprobar la postulacion.`,
        allowedMentions: { roles: [guildConfig.staffRoleId], users: [interaction.user.id] }
      });
      await saveTranscript(storage, staffNotice, 'assistant');
    }

    try {
      const voiceResult = await createVoiceRoomForTicket({
        interaction,
        storage,
        voiceManager,
        ticket: updated ?? ticket,
        guildConfig,
        textChannel: channel,
        requestedName: `examen-${interaction.user.username}`,
        requestId: `exam-${interaction.id}`
      });
      if (voiceResult.ready) {
        updated = voiceResult.ticket ?? updated;
        await tryMoveExamCandidateToVoice(interaction, voiceResult.channel);
        const voiceNotice = await channel.send(`${EMOJIS.wifi} Sala de examen vinculada: ${voiceResult.channel}.`);
        await saveTranscript(storage, voiceNotice, 'assistant');
        await voiceManager?.speakToTicket?.(
          interaction.guildId,
          'El examen comenzara en breves momentos. Por favor, ingresa al formulario y comparte pantalla.'
        ).catch((error) => console.warn('Exam opening TTS failed:', error?.message ?? error));
      }
    } catch (error) {
      console.error('Exam premium voice setup failed:', error);
      const notice = await channel.send([
        `${EMOJIS.wifi} No pude crear la sala de voz del examen.`,
        isMissingPermissionError(error)
          ? `Actualiza permisos para Move Members y Manage Channels: ${buildBotInviteUrl(config, interaction.guildId)}`
          : 'El examen queda abierto por texto y staff puede supervisarlo manualmente.'
      ].join('\n')).catch(() => null);
      if (notice) await saveTranscript(storage, notice, 'assistant');
    }

    return updated;
  }

  const freeNotice = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xffffff)
        .setTitle(`${EMOJIS.nexalogo} Modo examen`)
        .setDescription([
          `${interaction.user}, voy a hacerte **${state.questions.length} preguntas** dentro de este ticket.`,
          'Responde con sinceridad y sin ayuda externa. Al terminar, NexaDesk corregira y dara una nota provisional.',
          'Si no estas de acuerdo con la nota, podras pedir revision humana escribiendo **solicito revision**.'
        ].join('\n'))
        .setFooter({ text: 'Los servidores Premium pueden activar revision supervisada con voz.' })
        .setTimestamp(new Date())
    ],
    allowedMentions: { users: [interaction.user.id] }
  });
  await saveTranscript(storage, freeNotice, 'assistant');
  const firstQuestion = await channel.send(buildExamQuestionPrompt(state));
  await saveTranscript(storage, firstQuestion, 'assistant');
  return updated;
}

async function tryMoveExamCandidateToVoice(interaction, voiceChannel) {
  const member = interaction.member;
  if (!member?.voice?.channelId || !voiceChannel) return false;
  await member.voice.setChannel(voiceChannel, 'NexaDesk exam mode voice room').catch((error) => {
    console.warn(`Could not move exam candidate ${interaction.user.id} to voice:`, error?.message ?? error);
  });
  return true;
}

async function handleExamModeMessage({ storage, supportAgent, message, ticket, guildConfig }) {
  const state = normalizeExamState(ticket.examState);
  if (!state.enabled || state.status === 'idle') return false;

  if (ticket.openedBy && message.author.id !== ticket.openedBy) return false;
  if (!ticket.openedBy) {
    ticket = await storage.updateTicket(ticket.channelId, { openedBy: message.author.id }) ?? ticket;
  }

  if (isExamCancelRequest(message.content)) {
    const nextState = { ...state, status: 'cancelled', completedAt: new Date().toISOString() };
    const shouldMentionStaff = await registerTicketEscalation({
      storage,
      message,
      guildConfig,
      ticket,
      reason: 'El candidato ha cancelado o anulado el examen.'
    });
    await storage.updateTicket(ticket.channelId, {
      status: 'escalated',
      aiDisabled: true,
      aiDisabledBy: message.author.id,
      aiDisabledAt: new Date().toISOString(),
      examState: nextState
    });
    const reply = await sendTicketResponse(message, {
      content: buildPublicReply({
        shouldEscalate: true,
        reason: 'Examen cancelado por el candidato.',
        publicAnswer: 'He dejado el examen cancelado y lo paso a revision humana.'
      }, guildConfig, { mentionStaff: shouldMentionStaff }),
      allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
    });
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  if (state.status === 'completed' && isExamReviewRequest(message.content)) {
    await requestExamManualReview({ storage, message, ticket, guildConfig, state });
    return true;
  }

  if (state.mode === 'premium_review') {
    const reply = await sendTicketResponse(message, [
      'Estoy en modo examen supervisado.',
      state.formUrl ? `Formulario configurado: ${state.formUrl}` : '',
      'Comparte pantalla en la sala de voz y espera confirmacion del staff. NexaDesk no puede leer video de pantalla compartida directamente desde Discord.'
    ].filter(Boolean).join('\n'));
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  if (state.status !== 'questioning') return false;

  const question = state.questions[state.currentIndex];
  if (!question) return false;

  const answerRecord = buildExamAnswerRecord({
    question,
    answer: message.content,
    askedAt: state.lastQuestionAt
  });
  const answers = [...state.answers, answerRecord];
  const warnings = [...state.warnings, ...(answerRecord.flags ?? [])].slice(0, 20);
  const nextIndex = state.currentIndex + 1;

  if (nextIndex < state.questions.length) {
    const nextState = {
      ...state,
      answers,
      warnings,
      currentIndex: nextIndex,
      lastQuestionAt: new Date().toISOString()
    };
    await storage.updateTicket(ticket.channelId, { examState: nextState });
    const reply = await sendTicketResponse(message, buildExamQuestionPrompt(nextState));
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  const completedState = {
    ...state,
    answers,
    warnings,
    currentIndex: nextIndex,
    status: 'grading',
    completedAt: new Date().toISOString()
  };
  await storage.updateTicket(ticket.channelId, { examState: completedState });
  await message.channel.sendTyping().catch(() => {});

  let evaluation;
  try {
    evaluation = await supportAgent.gradeExamAnswers({
      ticket,
      guildConfig,
      examState: completedState,
      userTag: message.author.tag ?? message.author.username
    });
  } catch (error) {
    console.error('Exam grading failed:', error);
    evaluation = {
      score: 0,
      passed: false,
      summary: 'No pude corregir automaticamente por un fallo temporal de IA.',
      strengths: [],
      concerns: ['Solicita revision manual.'],
      manualReviewRecommended: true,
      aiGeneratedSuspicion: 0,
      perQuestion: []
    };
  }

  const finalState = {
    ...completedState,
    status: 'completed',
    evaluation
  };
  await storage.updateTicket(ticket.channelId, {
    status: evaluation.manualReviewRecommended ? 'exam_review_recommended' : 'exam_completed',
    examState: finalState
  });
  const reply = await sendTicketResponse(message, formatExamEvaluation(evaluation, finalState));
  await saveTranscript(storage, reply, 'assistant');
  return true;
}

async function requestExamManualReview({ storage, message, ticket, guildConfig, state }) {
  const nextState = {
    ...state,
    status: 'manual_review_requested',
    reviewRequestedAt: new Date().toISOString()
  };
  const shouldMentionStaff = await registerTicketEscalation({
    storage,
    message,
    guildConfig,
    ticket,
    reason: 'El candidato solicita revision humana del examen.'
  });
  await storage.updateTicket(ticket.channelId, {
    status: 'escalated',
    aiDisabled: true,
    aiDisabledBy: message.author.id,
    aiDisabledAt: new Date().toISOString(),
    examState: nextState
  });
  const reply = await sendTicketResponse(message, {
    content: buildPublicReply({
      shouldEscalate: true,
      reason: 'Revision humana solicitada.',
      publicAnswer: 'He solicitado revision humana del examen y he desactivado la IA en este ticket.'
    }, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
    allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
  });
  await saveTranscript(storage, reply, 'assistant');
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

  await replyOrEditEphemeral(interaction, {
    content: [
      'No puedo crear el canal del ticket todavia.',
      categoryName ? `Categoria: **${categoryName}**` : '',
      missingPermissions.length ? `Permisos bloqueados en la categoria: **${missingPermissions.join(', ')}**` : '',
      reason,
      `Actualiza permisos aqui: ${inviteUrl}`,
      'Si ya actualizaste permisos, revisa los overrides de la categoria o crea una categoria nueva desde la dashboard.'
    ].filter(Boolean).join('\n')
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

async function createDetectedTicketRecord({ storage, channel, openedBy = null }) {
  const ticket = {
    guildId: channel.guild.id,
    guildName: channel.guild.name,
    channelId: channel.id,
    channelName: channel.name,
    categoryId: channel.parentId
  };
  if (openedBy) ticket.openedBy = openedBy;
  return storage.createTicket(ticket);
}

async function sendTicketKingWelcomeOnce({ storage, message, guildConfig, ticketWelcomeChannels }) {
  if (ticketWelcomeChannels.has(message.channel.id)) return null;
  ticketWelcomeChannels.add(message.channel.id);

  const transcript = await storage.listTranscriptMessages(message.channel.id).catch(() => []);
  if (transcript.some((item) => isTicketKingWelcomeContent(item.content))) return null;

  const welcome = await message.channel.send([
    `${EMOJIS.nexalogo} Hola, soy **NexaDesk**.`,
    'He detectado este ticket de Ticket King y voy a ayudarte aqui. Cuentame que necesitas y, si hace falta, avisare al staff con un resumen claro.'
  ].join('\n'));
  await saveTranscript(storage, welcome, 'assistant');
  await sendMaintenanceTicketNotice({ storage, channel: message.channel, guildConfig });
  return welcome;
}

async function sendMaintenanceTicketNotice({ storage, channel, guildConfig }) {
  const maintenance = await storage.getMaintenanceState?.().catch((error) => {
    console.error('Failed to read maintenance state:', error);
    return null;
  });
  if (!shouldApplyMaintenanceToGuild({ maintenance, guildConfig })) return null;

  const notice = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xffcc00)
        .setTitle(`${EMOJIS.wifi} Modo mantenimiento activo`)
        .setDescription(buildMaintenanceNoticeText(maintenance))
        .setFooter({ text: 'Los servidores Premium mantienen prioridad normal.' })
        .setTimestamp(new Date())
    ],
    allowedMentions: { parse: [] }
  }).catch((error) => {
    console.error(`Failed to send maintenance notice in ${channel.id}:`, error);
    return null;
  });
  if (notice) await saveTranscript(storage, notice, 'assistant');
  return notice;
}

async function applyMaintenanceThrottle({ storage, message, guildConfig }) {
  const maintenance = await storage.getMaintenanceState?.().catch((error) => {
    console.error('Failed to read maintenance state before AI reply:', error);
    return null;
  });
  if (!shouldApplyMaintenanceToGuild({ maintenance, guildConfig })) return false;

  const delayMs = getMaintenanceDelayMs(maintenance);
  if (delayMs <= 0) return false;
  await sleep(delayMs);
  await message.channel.sendTyping().catch(() => {});
  return true;
}

function isTicketKingWelcomeContent(content) {
  return /he\s+detectado\s+este\s+ticket\s+de\s+ticket\s+king/i.test(String(content ?? ''));
}

function isConfiguredTicketCategory(channel, guildConfig) {
  return Boolean(channel && guildConfig?.ticketCategoryId && channel.parentId === guildConfig.ticketCategoryId);
}

async function shouldDetectTicketKingChannel(message) {
  if (!isTicketKingChannel(message.channel)) return false;
  if (isTicketKingSeedMessage(message)) return true;
  if (message.author.bot) return false;
  return hasRecentTicketKingMessage(message.channel);
}

function isTicketKingChannel(channel) {
  return /^ticket-\d+$/i.test(channel?.name ?? '');
}

function isTicketKingSeedMessage(message) {
  return isTicketKingChannel(message.channel) && isTicketKingBotUser(message.author);
}

async function hasRecentTicketKingMessage(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 25 });
    return messages.some((item) => isTicketKingBotUser(item.author));
  } catch {
    return false;
  }
}

async function resolveTicketKingOpenerId(message) {
  if (isTicketKingSeedMessage(message)) {
    return extractTicketOpenerIdFromBotMessage(message);
  }

  try {
    const messages = await message.channel.messages.fetch({ limit: 25 });
    const seedMessage = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .find((item) => isTicketKingSeedMessage(item));
    return seedMessage ? extractTicketOpenerIdFromBotMessage(seedMessage) : null;
  } catch {
    return null;
  }
}

function extractTicketOpenerIdFromBotMessage(message) {
  const mentionedUser = [...(message.mentions?.users?.values?.() ?? [])]
    .find((user) => !user.bot);
  if (mentionedUser) return mentionedUser.id;

  const text = buildMessageSearchText(message);
  const mentionMatch = text.match(/<@!?(\d{17,20})>/);
  if (mentionMatch) return mentionMatch[1];

  const createdTicketMatch = text.match(/(\d{17,20}).{0,120}(?:ha\s+creado|creo|abierto|opened|created)/i);
  return createdTicketMatch?.[1] ?? null;
}

function buildMessageSearchText(message) {
  const embedText = (message.embeds ?? []).flatMap((embed) => [
    embed.title,
    embed.description,
    embed.footer?.text,
    embed.author?.name,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])
  ]);

  return [
    message.content,
    ...embedText
  ]
    .filter(Boolean)
    .join('\n');
}

function isTicketKingBotUser(user) {
  if (!user?.bot) return false;
  const haystack = [
    user.username,
    user.globalName,
    user.tag,
    user.displayName
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[-_]/g, ' ');

  return /\bticket\s*king\b/.test(haystack) || haystack.includes('ticketking');
}

function isMissingPermissionError(error) {
  return error?.code === 50013 || /Missing Permissions/i.test(String(error?.message ?? error));
}

function isMissingAccessError(error) {
  return error?.code === 50001 || /Missing Access/i.test(String(error?.message ?? error));
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

  return `${EMOJIS.nexalogo} ${baseMessage}${answerBlock}`;
}

async function sendContextualTicketOpening({ storage, supportAgent, channel, ticket, guildConfig, panel, component, answers = [], user }) {
  if (!supportAgent || !answers.length) return null;

  const opening = await supportAgent.buildTicketOpening({
    ticket,
    guildConfig,
    panel,
    component,
    answers,
    userTag: user?.tag ?? user?.username ?? user?.id
  });

  if (!opening) return null;

  const sent = await channel.send({
    content: opening.slice(0, 1900),
    allowedMentions: { parse: [] }
  }).catch((error) => {
    console.error(`Failed to send contextual ticket opening in ${channel.id}:`, error);
    return null;
  });

  if (sent) await saveTranscript(storage, sent, 'assistant');
  return sent;
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
      `${EMOJIS.check} Ticket cerrado.`,
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
  const guildConfig = await storage.getGuildConfig(guild.id).catch(() => null);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages) ?? fallbackUser;
  let dmStatus = 'No se pudo detectar usuario para enviar la transcripcion por MD.';

  if (targetUser) {
    try {
      await sendTranscriptDm({
        targetUser,
        ticket: closedTicket,
        messages,
        guildName: guild.name,
        guildConfig
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
      `${EMOJIS.check} Ticket cerrado.`,
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
        await freshChannel.send('No tengo permisos suficientes para eliminar este canal. El ticket ya quedo cerrado en NexaDesk.').catch((sendError) => {
          if (isMissingAccessError(sendError) || isMissingPermissionError(sendError)) return;
          throw sendError;
        });
      }
    } catch (error) {
      console.error(`Failed to delete closed ticket channel ${channel.id}:`, error);
    }
  }, 8_000).unref?.();
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
  const guildConfig = await storage.getGuildConfig(ticket.guildId).catch(() => null);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages);
  let dmStatus = 'No se pudo detectar usuario para enviar la transcripcion por MD.';

  if (targetUser) {
    try {
      await sendTranscriptDm({
        targetUser,
        ticket: closedTicket,
        messages,
        guildName: channel.guild?.name,
        guildConfig
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

async function sendTranscriptDm({ targetUser, ticket, messages, guildName, guildConfig = null }) {
  const transcriptText = buildTranscriptText({ ticket, messages });
  const fileName = buildTranscriptFileName(ticket);
  const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: fileName });
  const growth = normalizeGrowthConfig(guildConfig?.growth);
  const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {});
  const shouldAskFeedback = growth.enabled && growth.feedbackDm;
  const content = [
    `${EMOJIS.server} Aqui tienes la transcripcion de tu ticket en **${ticket.guildName ?? guildName ?? 'el servidor'}**.`,
    `Canal: **#${ticket.channelName ?? ticket.channelId}**`,
    'Si necesitas volver a contactar con el staff, abre un nuevo ticket.'
  ];
  if (shouldAskFeedback) {
    content.push('');
    content.push(`${EMOJIS.check} Tu opinion ayuda a este servidor a mejorar. Valora la atencion de este ticket:`);
    if (!isPremiumEntitled(guildConfig ?? {}) || !premium.growthEngine) {
      content.push('La valoracion se guarda internamente. Con Premium, el servidor puede activar Growth Engine para reviews publicas y alertas de riesgo.');
    }
  }

  await targetUser.send({
    content: content.join('\n'),
    files: [attachment],
    components: shouldAskFeedback ? buildFeedbackComponents(ticket.channelId) : []
  });
}

function buildFeedbackComponents(channelId) {
  return [
    new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((rating) =>
        new ButtonBuilder()
          .setCustomId(`nexadesk:feedback:${channelId}:${rating}`)
          .setLabel(String(rating))
          .setStyle(rating >= 4 ? ButtonStyle.Success : rating <= 2 ? ButtonStyle.Danger : ButtonStyle.Secondary)
      )
    )
  ];
}

async function handleTicketFeedbackButton({ interaction, storage, client }) {
  const [, , channelId, ratingValue] = interaction.customId.split(':');
  const rating = Number.parseInt(ratingValue, 10);
  const ticket = await storage.getTicket(channelId).catch(() => null);
  if (!ticket) {
    await replyToFeedbackInteraction(interaction, 'No encuentro el ticket asociado a esta valoracion.');
    return;
  }

  if (ticket.openedBy && interaction.user.id !== ticket.openedBy) {
    await replyToFeedbackInteraction(interaction, 'Solo la persona que abrio el ticket puede valorar esta atencion.');
    return;
  }

  const guildConfig = await storage.getGuildConfig(ticket.guildId).catch(() => null);
  const feedback = await storage.addTicketFeedback({
    id: `feedback-${channelId}-${interaction.user.id}`,
    guildId: ticket.guildId,
    guildName: ticket.guildName ?? guildConfig?.guildName,
    channelId,
    channelName: ticket.channelName,
    userId: interaction.user.id,
    username: interaction.user.username,
    rating,
    source: 'dm_rating'
  });

  await replyToFeedbackInteraction(interaction, `${EMOJIS.check} Gracias. Valoracion guardada: ${formatRatingStars(feedback.rating)}.`);
  await maybePublishFeedbackReview({ client, storage, feedback, ticket, guildConfig });
}

async function replyToFeedbackInteraction(interaction, content) {
  const payload = interaction.inGuild?.() ? { content, ephemeral: true } : { content };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

async function maybePublishFeedbackReview({ client, storage, feedback, ticket, guildConfig }) {
  const growth = normalizeGrowthConfig(guildConfig?.growth);
  const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {});
  const entitled = isPremiumEntitled(guildConfig ?? {});
  if (!growth.enabled) return;

  if (feedback.rating <= 2 && growth.lowRatingAlerts && entitled && premium.churnRadar) {
    await sendLowRatingGrowthAlert({ client, feedback, ticket, guildConfig }).catch((error) => {
      console.error('Failed to publish low rating growth alert:', error);
    });
  }

  const canPublishReview = entitled
    && premium.growthEngine
    && premium.publicReviews
    && growth.publicReviews
    && growth.reviewChannelId
    && feedback.rating >= growth.testimonialMinRating
    && !feedback.publicReviewPosted;
  if (!canPublishReview) return;

  const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
  const channel = guild ? await guild.channels.fetch(growth.reviewChannelId).catch(() => null) : null;
  if (!channel?.isTextBased?.()) return;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xffffff)
        .setTitle(`${EMOJIS.check} Nueva review de soporte`)
        .setDescription([
          `${formatRatingStars(feedback.rating)}`,
          `Un usuario valoro positivamente un ticket atendido con **NexaDesk**.`,
          '',
          'Review automatica: muestra confianza sin exponer datos privados del ticket.'
        ].join('\n'))
        .addFields(
          { name: 'Servidor', value: feedback.guildName ?? guild?.name ?? ticket.guildName ?? 'Servidor', inline: true },
          { name: 'Ticket', value: `#${ticket.channelName ?? ticket.channelId}`, inline: true }
        )
        .setFooter({ text: 'NexaDesk Growth Engine' })
        .setTimestamp(new Date())
    ],
    allowedMentions: { roles: [], users: [] }
  });

  await storage.addTicketFeedback({ ...feedback, publicReviewPosted: true }).catch((error) => {
    console.error('Failed to mark feedback review as posted:', error);
  });
}

async function sendLowRatingGrowthAlert({ client, feedback, ticket, guildConfig }) {
  const growth = normalizeGrowthConfig(guildConfig?.growth);
  const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
  const channel = guild && growth.reviewChannelId
    ? await guild.channels.fetch(growth.reviewChannelId).catch(() => null)
    : null;
  if (!channel?.isTextBased?.()) return;

  const staffMention = guildConfig?.staffRoleId ? `<@&${guildConfig.staffRoleId}> ` : '';
  await channel.send({
    content: `${EMOJIS.ban} ${staffMention}Churn Radar: una valoracion baja necesita revision humana.`,
    embeds: [
      new EmbedBuilder()
        .setColor(0xffcc00)
        .setTitle(`${EMOJIS.ban} Riesgo de perdida detectado`)
        .setDescription('Un usuario valoro bajo el soporte. Revisad la transcripcion y, si procede, contactad para recuperar confianza.')
        .addFields(
          { name: 'Rating', value: formatRatingStars(feedback.rating), inline: true },
          { name: 'Ticket', value: `#${ticket.channelName ?? ticket.channelId}`, inline: true },
          { name: 'Usuario', value: feedback.userId ? `<@${feedback.userId}>` : feedback.username ?? 'No detectado', inline: true }
        )
        .setFooter({ text: 'NexaDesk Growth Engine - Churn Radar' })
        .setTimestamp(new Date())
    ],
    allowedMentions: {
      roles: guildConfig?.staffRoleId ? [guildConfig.staffRoleId] : [],
      users: feedback.userId ? [feedback.userId] : []
    }
  });
}

async function handleGrowthCommand({ interaction, storage, client }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Este comando solo funciona dentro de un servidor.', ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Necesitas permiso **Manage Server** para gestionar Growth Engine.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'configurar') {
    await interaction.deferReply({ ephemeral: true });
    const existing = await storage.getGuildConfig(interaction.guildId);
    const current = normalizeGrowthConfig(existing?.growth);
    const reviewChannel = interaction.options.getChannel('canal_reviews');
    if (reviewChannel && reviewChannel.type !== ChannelType.GuildText) {
      await interaction.editReply('El canal de reviews debe ser un canal de texto.');
      return;
    }

    const next = normalizeGrowthConfig({
      ...current,
      enabled: interaction.options.getBoolean('activo') ?? current.enabled,
      feedbackDm: interaction.options.getBoolean('pedir_feedback') ?? current.feedbackDm,
      publicReviews: interaction.options.getBoolean('reviews_publicas') ?? current.publicReviews,
      lowRatingAlerts: interaction.options.getBoolean('alertas_bajas') ?? current.lowRatingAlerts,
      inviteCta: interaction.options.getBoolean('cta_invitar') ?? current.inviteCta,
      testimonialMinRating: interaction.options.getInteger('rating_publico_min') ?? current.testimonialMinRating,
      reviewChannelId: reviewChannel?.id ?? current.reviewChannelId,
      reviewChannelName: reviewChannel?.name ?? current.reviewChannelName
    });

    const updated = await storage.upsertGuildConfig(interaction.guildId, {
      guildName: interaction.guild.name,
      growth: next
    });
    const premium = normalizePremiumConfig(updated.premium, updated);
    await interaction.editReply({
      embeds: [
        buildGrowthStatusEmbed({
          guild: interaction.guild,
          guildConfig: updated,
          growth: next,
          premium,
          feedback: await storage.listTicketFeedback([interaction.guildId]).catch(() => [])
        })
      ]
    });
    return;
  }

  const [guildConfig, feedback] = await Promise.all([
    storage.getGuildConfig(interaction.guildId),
    storage.listTicketFeedback([interaction.guildId]).catch(() => [])
  ]);
  await interaction.reply({
    embeds: [
      buildGrowthStatusEmbed({
        guild: interaction.guild,
        guildConfig,
        growth: normalizeGrowthConfig(guildConfig?.growth),
        premium: normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {}),
        feedback
      })
    ],
    ephemeral: true
  });
}

function buildGrowthStatusEmbed({ guild, guildConfig, growth, premium, feedback }) {
  const stats = buildFeedbackStats(feedback);
  const entitled = isPremiumEntitled(guildConfig ?? {});
  return new EmbedBuilder()
    .setColor(entitled ? 0xf4c95d : 0xffffff)
    .setTitle(`${EMOJIS.global} Growth Engine`)
    .setDescription(entitled && premium.growthEngine
      ? 'Sistema de crecimiento activo: feedback post-ticket, reviews publicas y radar de perdida.'
      : 'Puedes preparar la configuracion. Las reviews publicas y Churn Radar requieren Premium activo.')
    .addFields(
      { name: 'Servidor', value: guild?.name ?? guildConfig?.guildName ?? 'Servidor', inline: true },
      { name: 'Plan', value: entitled ? String(guildConfig?.plan ?? 'pro').toUpperCase() : 'FREE', inline: true },
      { name: 'Feedback DM', value: growth.feedbackDm ? 'Activo' : 'Pausado', inline: true },
      { name: 'Reviews publicas', value: growth.publicReviews && premium.publicReviews && entitled ? 'Activas' : 'No activas', inline: true },
      { name: 'Canal reviews', value: growth.reviewChannelId ? `<#${growth.reviewChannelId}>` : 'Sin configurar', inline: true },
      { name: 'Churn Radar', value: growth.lowRatingAlerts && premium.churnRadar && entitled ? 'Activo' : 'No activo', inline: true },
      {
        name: `${EMOJIS.check} Metricas`,
        value: [
          `Valoraciones: **${stats.feedbackCount}**`,
          `Rating medio: **${stats.averageRating}/5**`,
          `Promotores: **${stats.promoterRate}%**`,
          `Detractores: **${stats.detractors}**`
        ].join('\n'),
        inline: false
      }
    )
    .setFooter({ text: 'Tip: canal_reviews puede ser #reviews, #vouches o #opiniones para convertir buen soporte en prueba social.' })
    .setTimestamp(new Date());
}

async function handleGlobalStatsCommand({ interaction, storage, client }) {
  await interaction.deferReply();

  const installedGuildIds = new Set(client.guilds.cache.keys());
  const [tickets, guildConfigs, maintenance, feedback] = await Promise.all([
    storage.listTickets(),
    storage.listGuildConfigs(),
    storage.getMaintenanceState?.().catch(() => normalizeMaintenanceState()),
    storage.listTicketFeedback?.().catch(() => [])
  ]);
  const botTickets = tickets.filter((ticket) => installedGuildIds.has(ticket.guildId));
  const activeTickets = botTickets.filter((ticket) => ticket.status !== 'closed');
  const voiceRooms = botTickets.filter((ticket) => ticket.voiceChannelId).length;
  const panels = guildConfigs.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0);
  const proGuilds = guildConfigs.filter(isPremiumEntitled).length;
  const protectedGuilds = guildConfigs.filter((guild) => normalizeSecurityConfig(guild.security).enabled).length;
  const staleTickets = activeTickets.filter((ticket) => {
    const date = new Date(ticket.updatedAt || ticket.createdAt || 0);
    return date.getTime() && Date.now() - date.getTime() > 1000 * 60 * 60 * 24;
  }).length;
  const staffTickets = activeTickets.filter((ticket) => ['staff_waiting', 'staff_active', 'escalated'].includes(ticket.status)).length;
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const totalUsers = [...client.guilds.cache.values()].reduce((total, guild) => (
    total + (Number.isFinite(guild.memberCount) ? guild.memberCount : guild.members.cache.size)
  ), 0);
  const feedbackStats = buildFeedbackStats((feedback ?? []).filter((item) => installedGuildIds.has(item.guildId)));

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.global} NexaDesk Global Stats`)
    .setDescription('Estado en vivo del bot y su sistema de tickets.')
    .addFields(
      { name: `${EMOJIS.wifi} Ping`, value: `${Math.max(Math.round(client.ws.ping), 0)} ms`, inline: true },
      { name: `${EMOJIS.server} SERVIDORES`, value: String(client.guilds.cache.size), inline: true },
      { name: `${EMOJIS.global} USUARIOS`, value: String(totalUsers), inline: true },
      { name: `${EMOJIS.nexalogo} Canales activos`, value: String(activeTickets.length), inline: true },
      {
        name: `${EMOJIS.rightArrow} Tickets`,
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
        name: `${EMOJIS.global} Dashboard`,
        value: [
          `Servidores configurados: **${guildConfigs.length}**`,
          `Servidores Premium: **${proGuilds}**`,
          `Servidores protegidos: **${protectedGuilds}**`,
          `Paneles publicados: **${panels}**`,
          `Salas de voz activas: **${voiceRooms}**`,
          `Canales cacheados: **${client.channels.cache.size}**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.check} Atencion operativa`,
        value: [
          `Tickets esperando staff: **${staffTickets}**`,
          `Tickets +24h abiertos: **${staleTickets}**`,
          `Cobertura Security: **${client.guilds.cache.size ? Math.round((protectedGuilds / client.guilds.cache.size) * 100) : 0}%**`,
          `Rating soporte: **${feedbackStats.averageRating}/5**`,
          `Promotores: **${feedbackStats.promoterRate}%**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.wifi} Runtime`,
        value: [
          `Uptime: **${formatDuration(client.uptime ?? 0)}**`,
          `RAM: **${memoryMb} MB**`,
          `Node: **${process.version}**`,
          `Mantenimiento: **${maintenance?.enabled ? 'Activo Free' : 'Inactivo'}**`
        ].join('\n'),
        inline: true
      }
    )
    .setFooter({ text: 'NexaDesk AI Support' })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

async function handleDiagnosticsCommand({ interaction, storage, client, supportAgent = null }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Este diagnostico solo funciona dentro de un servidor.', ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Necesitas permiso **Manage Server** para ejecutar el diagnostico de NexaDesk.',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await refreshGuildDiscovery(client, storage, { guildId: interaction.guildId, reason: 'diagnostics' }, supportAgent).catch((error) => {
    console.error(`Diagnostics smart discovery failed in ${interaction.guildId}:`, error);
  });

  const [guildConfig, tickets] = await Promise.all([
    storage.getGuildConfig(interaction.guildId),
    storage.listTickets().catch(() => [])
  ]);
  const operational = buildGuildOperationalScore(guildConfig, { installed: true });
  const guildTickets = tickets.filter((ticket) => ticket.guildId === interaction.guildId);
  const activeTickets = guildTickets.filter((ticket) => ticket.status !== 'closed');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTickets = guildTickets.filter((ticket) => {
    const createdAt = new Date(ticket.createdAt || 0);
    return createdAt.getTime() >= todayStart.getTime();
  }).length;
  const escalatedTickets = activeTickets.filter((ticket) => ['staff_waiting', 'staff_active', 'escalated'].includes(ticket.status)).length;
  const nextActions = operational.missing.slice(0, 4);
  const security = normalizeSecurityConfig(guildConfig?.security);
  const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {});
  const discovery = normalizeDiscoveryConfig(guildConfig?.discovery);

  const embed = new EmbedBuilder()
    .setColor(operational.score >= 80 ? 0xffffff : operational.score >= 55 ? 0xffcc00 : 0xff5f57)
    .setTitle(`${EMOJIS.global} Diagnostico NexaDesk`)
    .setDescription([
      `Servidor: **${interaction.guild.name}**`,
      `NexaScore operativo: **${operational.score}%**`,
      operational.summary
    ].join('\n'))
    .addFields(
      {
        name: `${EMOJIS.check} Checklist`,
        value: operational.checks.map((item) => `${item.done ? EMOJIS.check : EMOJIS.rightArrow} ${item.label}`).join('\n'),
        inline: false
      },
      {
        name: `${EMOJIS.server} Tickets`,
        value: [
          `Abiertos: **${activeTickets.length}**`,
          `Creados hoy: **${todayTickets}**`,
          `Esperando staff: **${escalatedTickets}**`,
          `Con voz: **${activeTickets.filter((ticket) => ticket.voiceChannelId).length}**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.nexalogo} Modulos`,
        value: [
          `IA: **${guildConfig?.serverPrompt || guildConfig?.serverInfo ? 'Con contexto' : 'Sin contexto'}**`,
          `Security Guard: **${security.enabled ? 'Activo' : 'Off'}**`,
          `Premium: **${isPremiumEntitled(guildConfig ?? {}) ? 'Pro' : 'Free'}**`,
          `Voz Pro: **${premium.voiceSupport && isPremiumEntitled(guildConfig ?? {}) ? 'Activa' : 'No activa'}**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.global} Descubrimiento inteligente`,
        value: [
          `Anuncios: **${discovery.announcementChannelName ? `#${discovery.announcementChannelName}` : 'No detectado'}**`,
          `Normas: **${discovery.rulesChannelName ? `#${discovery.rulesChannelName}` : 'No detectado'}**`,
          `FAQ/info: **${discovery.faqChannelName ? `#${discovery.faqChannelName}` : 'No detectado'}**`,
          `Categoria sugerida: **${discovery.suggestedTicketCategoryName ?? 'No detectada'}**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.rightArrow} Siguiente mejor accion`,
        value: nextActions.length
          ? nextActions.map((item) => `- ${item.action}`).join('\n')
          : 'El servidor esta listo. Revisa transcripciones y estadisticas para optimizar tiempos de respuesta.',
        inline: false
      }
    )
    .setFooter({ text: `Ping ${Math.max(Math.round(client.ws.ping), 0)} ms - /globalstats para vision global` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Abrir dashboard')
      .setURL(PUBLIC_DASHBOARD_URL),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Soporte oficial')
      .setURL(SUPPORT_SERVER_URL)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

function buildGuildOperationalScore(guildConfig, { installed = false } = {}) {
  const security = normalizeSecurityConfig(guildConfig?.security);
  const checks = [
    {
      key: 'installed',
      label: 'Bot instalado',
      done: installed,
      weight: 10,
      action: 'Invita NexaDesk con permisos recomendados desde la dashboard.'
    },
    {
      key: 'category',
      label: 'Categoria de tickets',
      done: Boolean(guildConfig?.ticketCategoryId),
      weight: 15,
      action: 'Selecciona la categoria donde se crean los tickets.'
    },
    {
      key: 'staff',
      label: 'Rol staff',
      done: Boolean(guildConfig?.staffRoleId),
      weight: 15,
      action: 'Configura el rol que recibira escalados y avisos.'
    },
    {
      key: 'context',
      label: 'Contexto IA',
      done: Boolean(guildConfig?.serverPrompt || guildConfig?.serverInfo),
      weight: 20,
      action: 'Escribe un prompt con normas, tono, FAQ y cuando pedir pruebas.'
    },
    {
      key: 'security',
      label: 'Security Guard',
      done: Boolean(security.enabled),
      weight: 15,
      action: 'Activa Security Guard para anti-flood, links sospechosos y audit logs.'
    },
    {
      key: 'announcements',
      label: 'Canal de anuncios detectado',
      done: Boolean(guildConfig?.discovery?.announcementChannelId),
      weight: 5,
      action: 'Deja que NexaDesk detecte el canal de anuncios para futuras notificaciones y contexto.'
    },
    {
      key: 'components',
      label: 'Componentes o menu',
      done: Boolean(guildConfig?.components?.length),
      weight: 10,
      action: 'Crea componentes con preguntas previas para tickets mas claros.'
    },
    {
      key: 'panels',
      label: 'Panel publicado',
      done: Boolean(guildConfig?.panels?.length),
      weight: 15,
      action: 'Publica un panel de tickets para que los usuarios abran casos.'
    }
  ];
  const total = checks.reduce((sum, item) => sum + item.weight, 0);
  const done = checks.reduce((sum, item) => sum + (item.done ? item.weight : 0), 0);
  const score = total ? Math.round((done / total) * 100) : 0;
  const missing = checks.filter((item) => !item.done);
  const summary = score >= 85
    ? 'Listo para operar con una experiencia muy solida.'
    : score >= 60
      ? 'Ya puede operar, pero aun hay mejoras importantes antes de venderlo como setup completo.'
      : 'Necesita setup basico antes de confiarle soporte real.';

  return { score, checks, missing, summary };
}

async function sendFlowMessages({ message, storage, flow }) {
  const items = Array.isArray(flow.messages) && flow.messages.length
    ? flow.messages
    : [{ mode: 'reply', content: flow.publicAnswer }];
  let sentAny = false;

  for (const item of items) {
    const chunks = splitDiscordText(item.content, item.maxLength ?? 1900);
    for (const chunk of chunks) {
      const payload = {
        content: chunk,
        allowedMentions: item.allowedMentions ?? { parse: [] }
      };
      const shouldReply = item.mode !== 'send' && !sentAny;
      const sent = shouldReply ? await message.reply(payload) : await message.channel.send(payload);
      await saveTranscript(storage, sent, 'assistant');
      sentAny = true;
    }
  }
}

function splitDiscordText(content, maxLength = 1900) {
  let remaining = String(content ?? '').trim();
  if (!remaining) return [];
  const chunks = [];

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.45)) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < Math.floor(maxLength * 0.45)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
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

async function shouldStaySilentInTicket({ storage, message, ticket, guildConfig, client }) {
  const mentionedBot = getMentionedExternalBot(message, client);
  if (mentionedBot) {
    await pauseAiForHumanTakeover({
      storage,
      message,
      ticket,
      reason: `Se menciono a otro bot en el ticket: ${mentionedBot.tag ?? mentionedBot.username ?? mentionedBot.id}.`,
      actorId: message.author.id
    });
    return true;
  }

  const handoffState = await getStaffHandoffState(storage, message.channel.id);
  if (handoffState.active) return true;

  if (handoffState.pending || handoffState.waitingFinish) {
    return !isMessageAddressedToNexaDesk(message, client);
  }

  if (isTicketOpener(message, ticket)) return false;

  if (isMessageAddressedToNexaDesk(message, client)) return false;

  const recentMessages = await fetchRecentChannelMessages(message.channel, 12);
  const recentStaffMessage = findRecentStaffHumanMessage(recentMessages, message, guildConfig, ticket);
  if (recentStaffMessage) {
    return true;
  }

  return false;
}

async function handleStaffHandoffMessage({ storage, message, ticket, guildConfig, client }) {
  if (!isConfiguredStaffMember(message.member, message.author, guildConfig)) return { handled: false };
  if (isTicketOpener(message, ticket)) return { handled: false };

  const handoffState = await getStaffHandoffState(storage, message.channel.id);
  if (isStaffHandoffFinish(message.content) && (handoffState.pending || handoffState.active || handoffState.waitingFinish)) {
    await markStaffHandoffState(storage, message, 'finished', message.author.id);
    const updatedTicket = await storage.updateTicket(ticket.channelId, {
      status: 'open',
      aiDisabled: false,
      aiDisabledBy: null,
      aiDisabledAt: null
    }).catch((error) => {
      console.error(`Failed to resume AI after staff handoff in ${ticket.channelId}:`, error);
      return null;
    });
    const reply = await message.reply({
      content: `${EMOJIS.check} Perfecto <@${message.author.id}>, vuelvo a atender el ticket.`,
      allowedMentions: { users: [message.author.id], repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return { handled: true, ticket: updatedTicket ?? ticket };
  }

  if (isStaffTakeoverDirective(message.content)) {
    const updatedTicket = await activateStaffTakeover({ storage, message, ticket });
    return { handled: true, ticket: updatedTicket ?? ticket };
  }

  if (handoffState.pending) {
    if (isStaffHandoffYes(message.content)) {
      const updatedTicket = await activateStaffTakeover({ storage, message, ticket });
      return { handled: true, ticket: updatedTicket ?? ticket };
    }

    if (isStaffHandoffNo(message.content)) {
      await markStaffHandoffState(storage, message, 'finished', message.author.id);
      const updatedTicket = await storage.updateTicket(ticket.channelId, {
        status: 'open',
        aiDisabled: false,
        aiDisabledBy: null,
        aiDisabledAt: null
      }).catch((error) => {
        console.error(`Failed to resume AI after staff declined handoff in ${ticket.channelId}:`, error);
        return null;
      });
      const staffReply = await message.reply({
        content: `Vale <@${message.author.id}>. Entonces, por favor, dejame atender al usuario y continuo con el ticket.`,
        allowedMentions: { users: [message.author.id], repliedUser: false }
      });
      await saveTranscript(storage, staffReply, 'assistant');

      const openerId = ticket.openedBy;
      if (openerId) {
        const userReply = await message.channel.send({
          content: `<@${openerId}>, sigo contigo. Cuentame que necesitas ahora o pasame el ultimo detalle/captura y lo reviso.`,
          allowedMentions: { users: [openerId] }
        });
        await saveTranscript(storage, userReply, 'assistant');
      }

      return { handled: true, ticket: updatedTicket ?? ticket };
    }

    return { handled: true };
  }

  if (handoffState.active) return { handled: true };

  if (handoffState.waitingFinish) {
    return { handled: !isMessageAddressedToNexaDesk(message, client) };
  }

  if (isMessageAddressedToNexaDesk(message, client)) return { handled: false };

  await markStaffHandoffState(storage, message, 'asked', message.author.id);
  const reply = await message.reply({
    content: `<@${message.author.id}>, quieres encargarte tu de este ticket??? Responde **si** o **no**.`,
    allowedMentions: { users: [message.author.id], repliedUser: false }
  });
  await saveTranscript(storage, reply, 'assistant');
  return { handled: true };
}

async function getStaffHandoffState(storage, channelId) {
  const messages = await storage.listTranscriptMessages(channelId).catch(() => []);
  return parseStaffHandoffState(messages);
}

function parseStaffHandoffState(messages = []) {
  const state = {
    pending: false,
    active: false,
    waitingFinish: false,
    staffId: null
  };

  for (const item of messages) {
    const content = String(item.content ?? '');
    if (!content.includes(STAFF_HANDOFF_MARKER)) continue;
    const marker = content.slice(content.indexOf(STAFF_HANDOFF_MARKER) + STAFF_HANDOFF_MARKER.length).trim();
    const match = marker.match(/^(asked|accepted|waiting_finish|finished)(?::([0-9]+))?/);
    if (!match) continue;

    const [, action, staffId = null] = match;
    if (action === 'finished') {
      state.pending = false;
      state.active = false;
      state.waitingFinish = false;
      state.staffId = null;
      continue;
    }

    state.pending = action === 'asked';
    state.active = action === 'accepted';
    state.waitingFinish = action === 'waiting_finish';
    state.staffId = staffId;
  }

  return state;
}

async function markStaffHandoffState(storage, message, action, staffId) {
  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `staff-handoff-${action}-${Date.now()}`,
    authorId: message.client.user?.id,
    authorName: message.client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `${STAFF_HANDOFF_MARKER} ${action}${staffId ? `:${staffId}` : ''}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save staff handoff marker ${action} in ${message.channel.id}:`, error);
  });
}

async function activateStaffTakeover({ storage, message, ticket }) {
  await markStaffHandoffState(storage, message, 'accepted', message.author.id);
  const updatedTicket = await storage.updateTicket(ticket.channelId, {
    status: 'staff_active',
    aiDisabled: true,
    aiDisabledBy: message.author.id,
    aiDisabledAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to mark staff handoff accepted in ${ticket.channelId}:`, error);
    return null;
  });
  const reply = await message.reply({
    content: [
      `${EMOJIS.check} Perfecto <@${message.author.id}>, me quedo en silencio y dejo el ticket en tus manos.`,
      'Cuando termines, escribe **Nexa, he terminado** para que vuelva a atenderlo.'
    ].join('\n'),
    allowedMentions: { users: [message.author.id], repliedUser: false }
  });
  await saveTranscript(storage, reply, 'assistant');
  return updatedTicket;
}

function isStaffHandoffYes(content) {
  const normalized = normalizeText(content);
  return [
    /^(?:si|sii|sip|yes|yep|ok|vale|dale|claro|afirmativo)\b/,
    /\b(?:me\s+encargo|me\s+hago\s+cargo|lo\s+atiendo|yo\s+lo\s+atiendo|yo\s+me\s+encargo)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isStaffTakeoverDirective(content) {
  const normalized = normalizeText(content);
  return [
    /\b(?:nexa|nexadesk)\b.*\b(?:me\s+encargo|me\s+hago\s+cargo|lo\s+atiendo|yo\s+lo\s+atiendo|yo\s+me\s+encargo|yo\s+lo\s+llevo|yo\s+lo\s+gestiono)\b/,
    /\b(?:me\s+encargo|me\s+hago\s+cargo|lo\s+atiendo|yo\s+lo\s+atiendo|yo\s+me\s+encargo|yo\s+lo\s+llevo|yo\s+lo\s+gestiono)\b.*\b(?:nexa|nexadesk|ticket|caso|usuario)\b/,
    /\b(?:me\s+encargo|me\s+hago\s+cargo|yo\s+lo\s+llevo|yo\s+lo\s+gestiono)\b.*\b(?:no\s+necesito\s+tu\s+ayuda|no\s+hace\s+falta\s+tu\s+ayuda|deja\s+de\s+responder|no\s+respondas)\b/,
    /\b(?:nexa|nexadesk)\b.*\b(?:no\s+necesito\s+tu\s+ayuda|no\s+hace\s+falta\s+tu\s+ayuda|deja\s+de\s+responder|quedate\s+en\s+silencio|no\s+respondas|callate)\b/,
    /\b(?:lo\s+tomo|yo\s+sigo|yo\s+me\s+quedo|lo\s+llevo\s+yo|lo\s+gestiono\s+yo)\b.*\b(?:ticket|caso|usuario)\b/,
    /\b(?:human|staff|moderator)\b.*\b(?:takes?\s+over|will\s+handle|is\s+handling)\b/,
    /\b(?:i\s+got\s+this|i'll\s+take\s+it|i\s+will\s+handle\s+it|no\s+need\s+for\s+ai|stop\s+responding)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isStaffHandoffNo(content) {
  const normalized = normalizeText(content);
  return [
    /^(?:no|nop|nah|negativo)\b/,
    /\b(?:no\s+me\s+encargo|no\s+puedo|sigue\s+tu|atiendelo\s+tu)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isStaffHandoffFinish(content) {
  const normalized = normalizeText(content);
  return [
    /\bnexa(?:desk)?\b.*\b(?:he\s+terminado|termine|ya\s+termine|terminado)\b/,
    /\b(?:he\s+terminado|termine|ya\s+termine|terminado)\b.*\bnexa(?:desk)?\b/
  ].some((pattern) => pattern.test(normalized));
}

function isTicketOpener(message, ticket) {
  return Boolean(ticket?.openedBy && message.author?.id === ticket.openedBy);
}

async function pauseAiForHumanTakeover({ storage, message, ticket, reason, actorId }) {
  if (isAiDisabledTicket(ticket) || isClosedTicket(ticket)) return;

  await storage.updateTicket(ticket.channelId, {
    status: 'ai_disabled',
    aiDisabled: true,
    aiDisabledBy: actorId,
    aiDisabledAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to pause AI for human takeover in ${ticket.channelId}:`, error);
  });

  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `human-takeover-${message.id}`,
    authorId: message.client.user?.id,
    authorName: message.client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `[NexaDesk human takeover] IA pausada automaticamente. ${reason}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save human takeover marker for ${ticket.channelId}:`, error);
  });
}

function isConfiguredStaffMember(member, user, guildConfig) {
  if (!member || user?.bot) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(member, guildConfig.staffRoleId)) return true;
  return false;
}

function getMentionedExternalBot(message, client) {
  const botId = client?.user?.id;
  return message.mentions?.users?.find?.((user) => user.bot && user.id !== botId) ?? null;
}

function isMessageAddressedToNexaDesk(message, client) {
  const botId = client?.user?.id;
  if (botId && message.mentions?.users?.has(botId)) return true;
  if (botId && message.mentions?.repliedUser?.id === botId) return true;
  if (message.reference?.messageId) {
    const referenced = message.channel.messages.cache.get(message.reference.messageId);
    if (referenced?.author?.id === botId) return true;
  }

  const normalized = normalizeText(message.content);
  return [
    /\bnexa(?:desk)?\b/,
    /\bbot\b.*\b(?:ayuda|responde|puedes|decime|dime)\b/,
    /\b(?:ayuda|responde|puedes|decime|dime)\b.*\b(?:bot|nexa(?:desk)?)\b/
  ].some((pattern) => pattern.test(normalized));
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
  if (!isPremiumEntitled(guildConfig)) return false;
  const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig);
  return premium.voiceSupport !== false;
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
    const presence = buildBotPresence(client);
    client.user.setPresence(presence);
    console.log(`NexaDesk presence set to ${presence.status}: ${presence.activities[0]?.name ?? 'sin actividad'}.`);
  } catch (error) {
    console.error('Failed to set NexaDesk presence:', error);
  }
}

function buildBotPresence(client = null) {
  const guildCount = client?.guilds?.cache?.size ?? 0;
  return {
    status: 'online',
    afk: false,
    activities: [
      {
        name: `How can I help you today? | Ayudando en ${guildCount} servidores`,
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

  const reason = trimmed.replace(/\[ESCALATE\]\s*/gi, '').trim();
  return {
    shouldEscalate: true,
    reason: reason || 'El ticket requiere revision humana.',
    publicAnswer: reason || 'Voy a avisar al staff para que revise este ticket.'
  };
}

function looksLikeEscalation(answer) {
  return [
    /\bnecesito\s+(?:involucrar|avisar|contactar|derivar|escalar)\s+(?:a|al|con)\s+(?:un\s+)?(?:staff|moderador|humano|responsable)\b/i,
    /\bnecesito\s+que\s+(?:un\s+)?(?:staff|moderador|humano|responsable)\b.*\b(?:revise|atienda|ayude|intervenga|mire)\b/i,
    /\b(?:requiere|necesita)\s+(?:intervencion|revision|atencion)\s+(?:humana|manual|personalizada|del\s+staff)\b/i,
    /\b(?:voy|debo|tengo)\s+(?:a\s+)?(?:avisar|contactar|involucrar|derivar|escalar)\s+(?:a|al|con)\s+(?:un\s+)?(?:staff|moderador|humano|responsable)\b/i,
    /\b(?:requires?|needs?)\s+(?:human|staff|moderator)\s+(?:review|intervention|support|assistance)\b/i,
    /\b(?:i\s+need|i'll|i\s+will)\s+(?:to\s+)?(?:notify|contact|escalate|involve)\s+(?:the\s+)?(?:staff|moderator|human team)\b/i
  ].some((pattern) => pattern.test(answer));
}

async function handleCrisisRiskMessage({ storage, message, guildConfig, ticket }) {
  const reason = 'El usuario ha expresado riesgo inmediato de autolesion o suicidio.';
  if (guildConfig.staffRoleId) {
    await notifyStaffRole(message, guildConfig, ticket, reason);
  }

  await storage.updateTicket(ticket.channelId, {
    status: 'escalated',
    aiDisabled: true,
    aiDisabledBy: message.client.user?.id,
    aiDisabledAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to mark crisis ticket ${ticket.channelId} as escalated:`, error);
  });

  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `${CRISIS_MARKER}-${message.id}`,
    authorId: message.client.user?.id,
    authorName: message.client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `${CRISIS_MARKER} ${reason}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save crisis marker for ${ticket.channelId}:`, error);
  });

  const staffMention = guildConfig.staffRoleId ? `<@&${guildConfig.staffRoleId}> ` : '';
  const reply = await message.reply({
    content: [
      `${EMOJIS.ban} ${staffMention}**Urgente para staff:** el usuario ha expresado riesgo de hacerse daño. Entrad al ticket ahora.`,
      '',
      `${message.author}, siento mucho que estes pasando por esto. No quiero que estes solo ahora mismo.`,
      'Si estas en peligro inmediato, llama a emergencias ahora: **112** en Espana/UE, o el numero de emergencia de tu pais.',
      'En Espana tambien puedes llamar al **024**, linea de atencion a la conducta suicida.',
      'Mientras llega ayuda, alejate de ventanas, alturas u objetos con los que puedas hacerte dano y escribe o llama a alguien de confianza para que este contigo.',
      '',
      'He avisado al staff humano y he pausado la IA en este ticket para que te atiendan directamente.'
    ].join('\n'),
    allowedMentions: {
      roles: guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [],
      users: [message.author.id],
      repliedUser: false
    }
  });
  await saveTranscript(storage, reply, 'assistant');
}

function isCrisisRiskMessage(content) {
  const normalized = normalizeText(content);
  return [
    /\b(?:quiero|me\s+voy\s+a|voy\s+a|pienso|tengo\s+ganas\s+de)\s+(?:suicidarme|matarme|quitarme\s+la\s+vida)\b/,
    /\b(?:me\s+voy\s+a|voy\s+a)\s+(?:tirar|lanzar|saltar)\s+por\s+(?:la\s+)?(?:ventana|balcon|balcon|puente|azotea)\b/,
    /\b(?:kill\s+myself|end\s+my\s+life|jump\s+out\s+the\s+window|suicide)\b/,
    /\bno\s+quiero\s+(?:seguir\s+)?viviendo\b/,
    /\bme\s+quiero\s+morir\b/
  ].some((pattern) => pattern.test(normalized));
}

async function resolveAllianceTicketFlow({ message, storage, guildConfig, ticket, supportAgent }) {
  const recentMessages = await fetchRecentChannelMessages(message.channel, 20);
  if (hasStaffHumanConversation(recentMessages, message, guildConfig, ticket)) {
    return { type: 'none' };
  }

  const transcript = await storage.listTranscriptMessages(message.channel.id).catch(() => []);
  let allianceState = parseAllianceState(transcript);
  const allianceContext = isAllianceIntent(message.content)
    || allianceState.started
    || recentMessages.some((item) => !item.author.bot && isAllianceIntent(item.content));

  if (!allianceContext) return { type: 'none' };
  if (isAllianceChatter(message.content)) return { type: 'none' };
  if (allianceState.started && isAllianceCancelRequest(message.content)) {
    await markAllianceState(storage, message.channel, 'cancelled');
    return {
      type: 'reply',
      publicAnswer: 'Alianza cancelada. Si quieres retomarla mas adelante, escribe otra vez que quieres hacer una alianza.'
    };
  }

  if (allianceState.cancelled) {
    if (!isAllianceIntent(message.content)) return { type: 'none' };
    await markAllianceState(storage, message.channel, 'reopened');
    allianceState = createAllianceState();
  }

  const templateWasRequested = allianceState.templateRequested || allianceState.rulesAsked || allianceState.rulesRead;
  const waitingForAllianceTemplate = allianceState.started && templateWasRequested && !allianceState.userTemplate && !allianceState.templateCandidate;
  const awaitingTemplateConfirmation = allianceState.started && Boolean(allianceState.templateCandidate) && !allianceState.userTemplate;
  const currentMessageIsAllianceTemplate = (waitingForAllianceTemplate || awaitingTemplateConfirmation)
    ? isAllianceTemplateMessage(message.content, { templateRequested: true })
    : false;

  if (allianceState.started && isUserRequestingStaff(message.content) && !currentMessageIsAllianceTemplate) {
    return {
      type: 'escalate',
      reason: 'El usuario solicita asistencia humana durante el flujo de alianza.',
      publicAnswer: 'Aviso al staff para que revise esta alianza manualmente.'
    };
  }

  const missingAllianceConfig = [];
  if (!guildConfig?.allianceChannelId) missingAllianceConfig.push('canal de alianzas');
  if (!guildConfig?.allianceTemplate?.trim()) missingAllianceConfig.push('plantilla de alianza del servidor');
  if (missingAllianceConfig.length) {
    await markAllianceState(storage, message.channel, 'missing_config', missingAllianceConfig.join(', '));
    return {
      type: 'reply',
      publicAnswer: [
        'Puedo gestionar alianzas automaticamente, pero falta configuracion del servidor.',
        `Falta: ${missingAllianceConfig.join(' y ')}.`,
        'Un admin puede configurarlo con `/setup canal_alianzas:#canal plantilla_alianza:...`.'
      ].join('\n')
    };
  }

  if (!templateWasRequested && !allianceState.templateCandidate && !allianceState.userTemplate) {
    await markAllianceState(storage, message.channel, 'template_requested');
    return {
      type: 'reply',
      publicAnswer: [
        'Perfecto, esto seria una alianza.',
        'Enviame la **plantilla de alianza de tu servidor** en un solo mensaje.',
        'Cuando la detecte, te preguntare si esa es la plantilla correcta antes de continuar.'
      ].join('\n')
    };
  }

  if (awaitingTemplateConfirmation) {
    if (isAllianceTemplateConfirmYes(message.content)) {
      await markAllianceState(storage, message.channel, 'user_template', allianceState.templateCandidate);
      await markAllianceState(storage, message.channel, 'server_template_sent');
      return {
        type: 'reply',
        messages: [
          {
            mode: 'reply',
            content: [
              'Perfecto, usare esa plantilla.',
              'Te paso la plantilla del servidor en el siguiente mensaje para que puedas copiarla limpia.',
              '',
              'Para favorecer un buen funcionamiento del sistema de alianzas, envia una captura de como has enviado la plantilla que te hemos proporcionado.',
              'Despues, tu plantilla sera enviada automaticamente al canal de alianzas.'
            ].join('\n')
          },
          {
            mode: 'send',
            content: guildConfig.allianceTemplate.trim()
          }
        ]
      };
    }

    if (isAllianceTemplateConfirmNo(message.content)) {
      await markAllianceState(storage, message.channel, 'template_rejected');
      await markAllianceState(storage, message.channel, 'template_requested');
      return {
        type: 'reply',
        publicAnswer: 'Vale, no usare esa plantilla. Enviame la plantilla correcta de tu servidor en un solo mensaje.'
      };
    }

    if (currentMessageIsAllianceTemplate) {
      await markAllianceState(storage, message.channel, 'template_candidate', message.content);
      return {
        type: 'reply',
        publicAnswer: [
          'He detectado este mensaje como posible plantilla de alianza.',
          '¿Es esta la plantilla que quieres que envie al canal de alianzas?',
          'Responde **si** para continuar o **no** para enviarla de nuevo.'
        ].join('\n')
      };
    }

    return {
      type: 'reply',
      publicAnswer: 'Necesito que me confirmes la plantilla detectada. Responde **si** si es correcta o **no** si quieres enviarla de nuevo.'
    };
  }

  if (!allianceState.userTemplate) {
    if (!currentMessageIsAllianceTemplate) {
      return {
        type: 'reply',
        publicAnswer: 'Necesito primero la plantilla de alianza de tu servidor. Puedes enviarla completa en este ticket.'
      };
    }

    await markAllianceState(storage, message.channel, 'template_candidate', message.content);
    return {
      type: 'reply',
      publicAnswer: [
        'He detectado este mensaje como posible plantilla de alianza.',
        '¿Es esta la plantilla que quieres que envie al canal de alianzas?',
        'Responde **si** para continuar o **no** para enviarla de nuevo.'
      ].join('\n')
    };
  }

  if (!allianceState.proofVerified) {
    if (!message.attachments?.size) {
      return {
        type: 'reply',
        publicAnswer: 'Ahora necesito una captura donde se vea que has enviado nuestra plantilla de alianza. En cuanto la verifique, envio tu plantilla automaticamente.'
      };
    }

    const verification = await supportAgent.verifyAllianceProof({
      message,
      guildConfig,
      serverAllianceTemplate: guildConfig.allianceTemplate
    }).catch((error) => ({
      verified: false,
      reason: `No pude verificar la captura automaticamente: ${String(error?.message ?? error).slice(0, 250)}`
    }));

    await markAllianceState(storage, message.channel, 'proof_checked', verification.reason ?? '');
    if (!verification.verified) {
      return {
        type: 'reply',
        publicAnswer: [
          'No puedo confirmar todavia que la plantilla se haya enviado correctamente.',
          `Motivo: ${verification.reason || 'la captura no muestra la plantilla con suficiente claridad.'}`,
          'Envia una captura mas clara donde se vea el mensaje publicado con nuestra plantilla.'
        ].join('\n')
      };
    }

    await markAllianceState(storage, message.channel, 'proof_verified', verification.reason ?? '');
    const userTemplate = allianceState.userTemplate;
    const publishResult = await publishAllianceTemplate({
      message,
      guildConfig,
      ticket,
      userTemplate
    }).catch((error) => ({
      error: String(error?.message ?? error)
    }));
    if (publishResult.error) {
      return {
        type: 'reply',
        publicAnswer: [
          'La captura parece correcta, pero no pude publicar tu plantilla en el canal de alianzas.',
          `Motivo: ${publishResult.error}`,
          'Aviso al staff para que lo revise manualmente.'
        ].join('\n')
      };
    }
    await markAllianceState(storage, message.channel, 'published', publishResult.messageId ?? '');

    return {
      type: 'reply',
      publicAnswer: [
        'Perfecto, la plantilla se enviara en unos momentos.',
        `Ya la he publicado en ${publishResult.channelMention}. Gracias por seguir el proceso.`
      ].join('\n')
    };
  }

  if (allianceState.proofVerified && !allianceState.published) {
    const publishResult = await publishAllianceTemplate({
      message,
      guildConfig,
      ticket,
      userTemplate: allianceState.userTemplate
    }).catch((error) => ({
      error: String(error?.message ?? error)
    }));
    if (publishResult.error) {
      return {
        type: 'reply',
        publicAnswer: [
          'La captura ya esta verificada, pero sigo sin poder publicar la plantilla en el canal de alianzas.',
          `Motivo: ${publishResult.error}`,
          'Revisa permisos del bot en el canal configurado o cambia el canal con `/setup canal_alianzas:#canal`.'
        ].join('\n')
      };
    }
    await markAllianceState(storage, message.channel, 'published', publishResult.messageId ?? '');
    return {
      type: 'reply',
      publicAnswer: `Listo, ya publique la plantilla en ${publishResult.channelMention}.`
    };
  }

  if (allianceState.published) {
    return {
      type: 'reply',
      publicAnswer: 'La alianza ya quedo enviada al canal configurado. El staff podra revisarla desde alli.'
    };
  }

  return { type: 'none' };
}

function parseAllianceState(messages = []) {
  const state = createAllianceState();

  for (const item of messages) {
    const content = String(item.content ?? '');
    if (!content.includes(ALLIANCE_MARKER)) continue;
    if (content.includes('reopened')) {
      Object.assign(state, createAllianceState());
      continue;
    }
    state.started = true;
    if (content.includes('rules_asked')) state.rulesAsked = true;
    if (content.includes('rules_read')) {
      state.rulesRead = true;
      state.templateRequested = true;
    }
    if (content.includes('template_requested')) state.templateRequested = true;
    if (content.includes('server_template_sent')) state.serverTemplateSent = true;
    if (content.includes('proof_verified')) state.proofVerified = true;
    if (content.includes('published')) state.published = true;
    if (content.includes('cancelled')) state.cancelled = true;
    if (content.includes('template_rejected')) state.templateCandidate = '';
    if (content.includes('template_candidate:')) {
      state.templateCandidate = content.split('template_candidate:').slice(1).join('template_candidate:').trim();
    }
    if (content.includes('user_template:')) {
      state.userTemplate = content.split('user_template:').slice(1).join('user_template:').trim();
      state.templateCandidate = '';
    }
  }

  return state;
}

function createAllianceState() {
  return {
    started: false,
    rulesAsked: false,
    rulesRead: false,
    templateRequested: false,
    templateCandidate: '',
    userTemplate: '',
    serverTemplateSent: false,
    proofVerified: false,
    published: false,
    cancelled: false
  };
}

async function markAllianceState(storage, channel, action, details = '') {
  await storage.addTranscriptMessage({
    guildId: channel.guild?.id,
    channelId: channel.id,
    messageId: `alliance-${action}-${Date.now()}`,
    authorId: channel.client.user?.id,
    authorName: channel.client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `${ALLIANCE_MARKER} ${action}${details ? `: ${details}` : ''}`.slice(0, 3000),
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save alliance marker ${action} in ${channel.id}:`, error);
  });
}

async function publishAllianceTemplate({ message, guildConfig, ticket, userTemplate }) {
  const channel = await message.guild.channels.fetch(guildConfig.allianceChannelId).catch(() => null);
  if (!channel || !isAlliancePublishChannel(channel)) {
    throw new Error('El canal de alianzas configurado no existe o no permite publicar mensajes.');
  }

  const content = [
    '@everyone @here',
    '',
    `${EMOJIS.global} **Nueva solicitud de alianza verificada** ${EMOJIS.check}`,
    'NexaDesk verifico que el usuario envio la plantilla del servidor antes de publicar esta solicitud.',
    '',
    `**Solicitante:** ${message.author} (${message.author.id})`,
    `**Ticket:** ${message.channel}`,
    `**Canal:** #${ticket.channelName ?? message.channel.name}`,
    '',
    '**Plantilla recibida:**',
    userTemplate.trim() || 'No pude recuperar la plantilla del usuario.'
  ].join('\n');

  const chunks = splitDiscordText(content, 1900);
  let firstMessage = null;
  for (const [index, chunk] of chunks.entries()) {
    const sent = await channel.send({
      content: chunk,
      allowedMentions: index === 0 ? { parse: ['everyone'] } : { parse: [] }
    });
    firstMessage ??= sent;
  }

  return {
    channelMention: `${channel}`,
    messageId: firstMessage?.id
  };
}

function isAlliancePublishChannel(channel) {
  return Boolean(channel && (
    channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement
    || (channel.isTextBased?.() && channel.send)
  ));
}

function isAllianceRulesReadAck(content) {
  return /\bya\s+(?:las\s+)?(?:he|e)\s+leido\b/i.test(normalizeText(content));
}

function isAllianceTemplateConfirmYes(content) {
  const normalized = normalizeText(content);
  if (normalized.length > 90) return false;
  return [
    /^(?:si|sii|sip|yes|yep|correcto|correcta|esa|es esa|exacto|dale|vale|ok|perfecto)\b/,
    /\b(?:esa\s+es|es\s+esa|es\s+correcta|esta\s+bien|esta\s+correcta|continua|sigue)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isAllianceTemplateConfirmNo(content) {
  const normalized = normalizeText(content);
  if (normalized.length > 90) return false;
  return [
    /^(?:no|nop|nah|negativo)\b/,
    /\b(?:no\s+es|no\s+era|incorrecta|equivocada|otra\s+plantilla|la\s+cambio|la\s+envio\s+de\s+nuevo)\b/
  ].some((pattern) => pattern.test(normalized));
}

function hasStaffHumanConversation(recentMessages, currentMessage, guildConfig = null, ticket = null) {
  if (isMessageAddressedToNexaDesk(currentMessage, currentMessage.client)) return false;
  const currentIndex = recentMessages.findIndex((item) => item.id === currentMessage.id);
  const previous = currentIndex >= 0 ? recentMessages.slice(0, currentIndex) : recentMessages;
  return previous.slice(-8).some((item) => (
    !item.author.bot
    && item.author.id !== currentMessage.author.id
    && item.author.id !== ticket?.openedBy
    && (guildConfig
      ? isConfiguredStaffMember(item.member, item.author, guildConfig)
      : isLikelyStaffHumanMessage(item, currentMessage))
  ));
}

function findRecentStaffHumanMessage(recentMessages, currentMessage, guildConfig, ticket) {
  const currentIndex = recentMessages.findIndex((item) => item.id === currentMessage.id);
  const previous = currentIndex >= 0 ? recentMessages.slice(0, currentIndex) : recentMessages;
  return previous
    .slice(-8)
    .reverse()
    .find((item) => (
      !item.author.bot
      && item.author.id !== currentMessage.author.id
      && item.author.id !== ticket?.openedBy
      && isConfiguredStaffMember(item.member, item.author, guildConfig)
    )) ?? null;
}

function isLikelyStaffHumanMessage(item, currentMessage) {
  if (item.author.id === currentMessage.author.id) return false;
  return isLikelyStaffIdentity(item.member, item.author);
}

function isLikelyStaffIdentity(member, user) {
  if (member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return /(?:fundador|admin|staff|mod|moderador|owner|soporte)/i.test(member?.displayName ?? user?.username ?? '');
}

async function fetchRecentChannelMessages(channel, limit = 20) {
  try {
    const messages = await channel.messages.fetch({ limit });
    return [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  } catch {
    return [];
  }
}

function isAllianceIntent(content) {
  const normalized = normalizeText(content);
  return /\balianz(?:a|as)\b/.test(normalized)
    || /\bpartner(?:ship)?s?\b/.test(normalized)
    || /\bcolaboracion\b/.test(normalized);
}

function isAllianceTemplateMessage(content, { templateRequested = false } = {}) {
  const raw = String(content ?? '').trim();
  const normalized = normalizeText(raw);
  if (!raw || isShortAllianceAck(normalized)) return false;

  const hasLink = /(?:discord\.gg|discord\.com\/invite|https?:\/\/)/i.test(raw);
  const hasAllianceFields = [
    /\bnombre\b/,
    /\bservidor\b/,
    /\bmiembros?\b/,
    /\btematica\b/,
    /\binvitacion\b/,
    /\benlace\b/,
    /\bofrec(?:e|emos|en)\b/,
    /\bbusc(?:a|amos|an)\b/,
    /\bcontacto\b/,
    /\brepresentante\b/,
    /\bowner\b/
  ].filter((pattern) => pattern.test(normalized)).length;

  const hasMemberCount = /\b\d{2,6}\s*(?:miembros?|members?|users?|personas?)\b/i.test(normalized);
  const hasThemeHint = /\b(?:rp|erlc|roleplay|comunidad|gaming|minecraft|roblox|discord|anime|social)\b/i.test(normalized);

  if (templateRequested) {
    return hasLink || hasAllianceFields >= 2 || (hasMemberCount && hasThemeHint) || raw.length >= 55;
  }

  return isAllianceIntent(raw) && (hasLink || hasAllianceFields >= 2 || (hasMemberCount && hasThemeHint) || raw.length >= 90);
}

function isShortAllianceAck(normalized) {
  return /^(si|sí|vale|ok|okay|perfecto|dale|hazlo|hacelo|adelante|afirmativo|claro|porfa|por favor)[.!?\s]*$/.test(normalized);
}

function isAllianceChatter(content) {
  const normalized = normalizeText(content);
  return [
    /^(bruh|x dios|jsjs|jaja+|jeje+|xd|uh|q pesado|que pesado)[.!?\s]*$/,
    /\b(?:me la borra|lo borra|borra la plantilla)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isAllianceCancelRequest(content) {
  const normalized = normalizeText(content);
  return [
    /\b(?:cancela|cancelar|cancelo|anula|anular|parar|deten)\b.*\balianza\b/,
    /\balianza\b.*\b(?:cancelada|cancelar|cancela|anula|anular|parar|deten)\b/,
    /\b(?:ya\s+no|no\s+quiero)\b.*\balianza\b/
  ].some((pattern) => pattern.test(normalized));
}

function isUserRequestingStaff(content) {
  const normalized = normalizeText(content);
  return [
    /\basistencia\s+manual\b/,
    /\b(?:necesito|podria|puedes|podrias|quiero\s+hablar\s+con|pasame\s+con)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/,
    /\b(?:menciona(?:s|r)?|avisa(?:s|r)?|llama(?:s|r)?|contacta(?:s|r)?)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/,
    /\b(?:staff|moderador(?:es)?|humano|responsable)\b.*\b(?:por\s+favor|porfa|urgente|ayuda|venir|venga|atienda)\b/,
    /\bmanual\s+(?:support|assistance|help)\b/,
    /\b(?:need|want|call|notify|contact|bring|get)\b.*\b(staff|moderator|human|admin)\b/,
    /\b(?:staff|moderator|human|admin)\b.*\b(?:please|help|needed|urgent)\b/
  ].some((pattern) => pattern.test(normalized));
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
    .replace(/\[ESCALATE\]/gi, '')
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

async function maybeMirrorGlobalAnnouncement({ client, storage, config, message }) {
  if (!config.ANNOUNCEMENT_MIRROR_ENABLED) return false;
  if (message.author?.id === client.user?.id) return false;
  if (message.guild.id !== config.ANNOUNCEMENT_SOURCE_GUILD_ID) return false;
  if (message.channel.id !== config.ANNOUNCEMENT_SOURCE_CHANNEL_ID) return false;

  if (!hasMirrorableAnnouncementContent(message)) {
    console.log(`Global announcement ${message.id} skipped: empty content.`);
    return true;
  }

  const guildConfigs = await storage.listGuildConfigs().catch((error) => {
    console.error('Failed to load guild configs for announcement mirror:', error);
    return [];
  });
  const deliveredChannelIds = new Set();
  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  let disabledTargets = 0;

  for (const guildConfig of guildConfigs) {
    const discovery = normalizeDiscoveryConfig(guildConfig.discovery);
    const targetChannelId = discovery.announcementChannelId;
    if (!targetChannelId || deliveredChannelIds.has(targetChannelId)) {
      skipped += 1;
      continue;
    }
    deliveredChannelIds.add(targetChannelId);

    if (guildConfig.guildId === message.guild.id && targetChannelId === message.channel.id) {
      skipped += 1;
      continue;
    }

    try {
      const channel = await client.channels.fetch(targetChannelId);
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        skipped += 1;
        continue;
      }

      const permissions = channel.permissionsFor?.(client.user);
      if (permissions && !permissions.has(PermissionFlagsBits.SendMessages)) {
        skipped += 1;
        continue;
      }

      await channel.send(buildAnnouncementMirrorPayload(message, config, permissions));
      delivered += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed to mirror announcement ${message.id} to ${targetChannelId}:`, error?.message ?? error);
      if (isPermanentAnnouncementMirrorError(error)) {
        const disabled = await disableBrokenAnnouncementTarget({
          storage,
          guildConfig,
          targetChannelId,
          error
        }).catch((disableError) => {
          console.warn(`Could not disable broken announcement target ${targetChannelId}:`, disableError?.message ?? disableError);
          return false;
        });
        if (disabled) disabledTargets += 1;
      }
    }
  }

  console.log(`Global announcement ${message.id} mirrored. Delivered: ${delivered}. Skipped: ${skipped}. Failed: ${failed}. Disabled invalid targets: ${disabledTargets}.`);
  return true;
}

function isPermanentAnnouncementMirrorError(error) {
  const code = Number(error?.code ?? error?.rawError?.code ?? 0);
  const message = String(error?.message ?? error ?? '');
  return [10003, 10004, 50001, 50013].includes(code)
    || /Unknown Channel|Unknown Guild|Missing Access|Missing Permissions/i.test(message);
}

async function disableBrokenAnnouncementTarget({ storage, guildConfig, targetChannelId, error }) {
  if (!guildConfig?.guildId || !targetChannelId) return false;
  const discovery = normalizeDiscoveryConfig(guildConfig.discovery);
  if (discovery.announcementChannelId !== targetChannelId) return false;

  await storage.upsertGuildConfig(guildConfig.guildId, {
    discovery: {
      ...(guildConfig.discovery ?? {}),
      announcementChannelId: null,
      announcementChannelName: null,
      announcementMirrorDisabledAt: new Date().toISOString(),
      announcementMirrorDisabledReason: String(error?.message ?? error ?? 'Destino invalido').slice(0, 240)
    }
  });
  return true;
}

function hasMirrorableAnnouncementContent(message) {
  return Boolean(message.content?.trim() || message.embeds?.length || message.attachments?.size);
}

function buildAnnouncementMirrorPayload(message, config, permissions) {
  const canEmbed = !permissions || permissions.has(PermissionFlagsBits.EmbedLinks);
  const contentParts = [];
  if (message.content?.trim()) contentParts.push(message.content.trim());
  if (message.attachments?.size) {
    contentParts.push(...[...message.attachments.values()].map((attachment) => attachment.url).filter(Boolean));
  }
  const embeds = canEmbed ? message.embeds.slice(0, 10).map((embed) => embed.toJSON()) : undefined;
  const content = contentParts.join('\n').slice(0, 2000) || (embeds?.length ? undefined : 'Anuncio global de NexaDesk sin texto visible.');

  return {
    content,
    embeds,
    allowedMentions: config.ANNOUNCEMENT_MIRROR_ALLOW_MENTIONS ? undefined : { parse: [] }
  };
}

async function sendTicketResponse(message, payload) {
  try {
    return await message.reply(payload);
  } catch (error) {
    if (!isUnknownReplyReferenceError(error)) throw error;
    console.warn(`Reply target disappeared in ${message.channel?.id}; sending normal channel message instead.`);
    return message.channel.send(payload);
  }
}

async function sendAiFailureNotice(message) {
  try {
    return await sendTicketResponse(message, 'Sigo contigo, pero ahora mismo una parte del sistema esta tardando mas de lo normal. Dejo el ticket listo para que el staff lo revise si hace falta.');
  } catch (error) {
    console.error('Failed to send AI fallback notice:', error);
    return null;
  }
}

function compactRuntimeError(error) {
  const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
  const code = error?.code ?? error?.type ?? '';
  const message = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').slice(0, 420);
  return [status ? `status=${status}` : null, code ? `code=${code}` : null, message].filter(Boolean).join(' ');
}

function isUnknownReplyReferenceError(error) {
  if (error?.code === 10008) return true;
  if (error?.code !== 50035) return false;
  return JSON.stringify(error.rawError?.errors ?? {}).includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE');
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

async function maybeRecordAiQualitySignal({ storage, supportAgent, message, ticket, guildConfig }) {
  if (typeof storage.addAiQualitySignal !== 'function') return;
  if (typeof supportAgent.detectAiQualitySignal !== 'function') return;

  const transcript = await storage.listTranscriptMessages(message.channel.id).catch(() => []);
  const previousAiMessage = findPreviousAssistantTranscriptMessage(transcript, message.id);
  const detection = await supportAgent.detectAiQualitySignal({
    message,
    ticket,
    guildConfig,
    previousAiMessage
  });
  if (!detection?.detected) return;

  await storage.addAiQualitySignal({
    id: `ai-quality-${message.id}`,
    guildId: message.guild.id,
    guildName: guildConfig?.guildName ?? ticket.guildName ?? message.guild.name,
    channelId: message.channel.id,
    channelName: message.channel.name ?? ticket.channelName,
    messageId: message.id,
    userId: message.author.id,
    username: message.author.username,
    category: detection.category,
    severity: detection.severity,
    sentiment: detection.sentiment,
    confidence: detection.confidence,
    reason: detection.reason,
    userMessage: buildTranscriptMessageContent(message).slice(0, 2400),
    previousAiMessage: previousAiMessage?.content?.slice(0, 2400),
    detectedBy: detection.detectedBy ?? 'ai',
    createdAt: message.createdAt?.toISOString?.() ?? new Date().toISOString()
  });
}

function findPreviousAssistantTranscriptMessage(transcript = [], currentMessageId = null) {
  return [...transcript]
    .reverse()
    .find((entry) => entry.messageId !== currentMessageId && (entry.role === 'assistant' || entry.authorBot));
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

async function scanInstalledGuildsForDiscovery({ client, storage, supportAgent = null }) {
  if (!isClientReadyForDiscordRest(client)) {
    console.log('NexaDesk smart discovery skipped because this instance is not the active Discord gateway.');
    return;
  }
  const guilds = [...client.guilds.cache.values()];
  let detected = 0;
  for (const guild of guilds) {
    const result = await refreshGuildDiscovery(client, storage, { guildId: guild.id, reason: 'scheduled_scan' }, supportAgent).catch((error) => {
      console.warn(`Smart discovery failed for ${guild.name} (${guild.id}):`, error?.message ?? error);
      return null;
    });
    if (result && hasUsefulDiscovery(result.discovery)) detected += 1;
  }
  console.log(`NexaDesk smart discovery scanned ${guilds.length} guilds; useful channels found in ${detected}.`);
}

export async function refreshGuildDiscovery(client, storage, { guildId, reason = 'manual' }, supportAgent = null) {
  if (!isClientReadyForDiscordRest(client)) {
    throw new Error('Discord gateway is not active on this NexaDesk instance.');
  }
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const roles = await guild.roles.fetch().catch(() => null);
  const discovery = analyzeGuildChannelsForDiscovery(channels.values());
  const existing = await storage.getGuildConfig(guildId).catch(() => null);
  const patch = {
    guildName: guild.name,
    discovery: {
      ...(existing?.discovery ?? {}),
      ...discovery,
      reason
    }
  };

  let allianceQuestion = null;
  const autoConfigQuestions = [];
  const autoConfigDetection = await detectAutoConfigurationForGuild({
    guild,
    channels: [...channels.values()],
    roles: roles ? [...roles.values()] : [],
    existing,
    discovery,
    supportAgent
  }).catch((error) => {
    console.warn(`Auto-configuration failed for ${guild.name} (${guild.id}):`, error?.message ?? error);
    return null;
  });

  if (autoConfigDetection) {
    const canAskAutoConfig = shouldAskAutoConfigContacts(existing?.autoConfig);
    if (!existing?.ticketCategoryId && autoConfigDetection.ticketCategory?.autoAssign) {
      patch.ticketCategoryId = autoConfigDetection.ticketCategory.id;
      patch.ticketCategoryName = autoConfigDetection.ticketCategory.name;
    } else if (!existing?.ticketCategoryId && autoConfigDetection.ticketCategory?.shouldAsk && canAskAutoConfig) {
      autoConfigQuestions.push(autoConfigDetection.ticketCategory);
    }

    if (!existing?.staffRoleId && autoConfigDetection.staffRole?.autoAssign) {
      patch.staffRoleId = autoConfigDetection.staffRole.id;
    } else if (!existing?.staffRoleId && autoConfigDetection.staffRole?.shouldAsk && canAskAutoConfig) {
      autoConfigQuestions.push(autoConfigDetection.staffRole);
    }

    patch.autoConfig = {
      ...(existing?.autoConfig ?? {}),
      status: autoConfigQuestions.length
        ? 'needs_confirmation'
        : (patch.ticketCategoryId || patch.staffRoleId)
          ? 'auto_configured'
          : 'waiting_confirmation',
      scannedAt: new Date().toISOString(),
      summary: autoConfigDetection.summary,
      pending: autoConfigQuestions.map((question) => ({
        type: question.type,
        label: question.label,
        reason: question.reason,
        askedAt: new Date().toISOString(),
        candidates: question.candidates
      }))
    };
  }

  if (!existing?.allianceChannelId) {
    const allianceDetection = await detectAllianceChannelForGuild({
      guild,
      channels: [...channels.values()],
      supportAgent
    }).catch((error) => {
      console.warn(`Alliance channel detection failed for ${guild.name} (${guild.id}):`, error?.message ?? error);
      return null;
    });

    if (allianceDetection?.autoAssign) {
      patch.allianceChannelId = allianceDetection.channelId;
      patch.allianceChannelName = allianceDetection.channelName;
      patch.allianceDetection = {
        status: 'auto_assigned',
        channelId: allianceDetection.channelId,
        channelName: allianceDetection.channelName,
        confidence: allianceDetection.confidence,
        reason: allianceDetection.reason,
        scannedAt: new Date().toISOString()
      };
    } else if (allianceDetection?.shouldAskInstaller && shouldAskAllianceInstaller(existing?.allianceDetection)) {
      patch.allianceDetection = {
        status: 'needs_confirmation',
        channelId: allianceDetection.channelId,
        channelName: allianceDetection.channelName,
        confidence: allianceDetection.confidence,
        reason: allianceDetection.reason,
        askedAt: new Date().toISOString(),
        scannedAt: new Date().toISOString()
      };
      allianceQuestion = allianceDetection;
    }
  }

  const updated = await storage.upsertGuildConfig(guildId, patch);
  if (allianceQuestion) {
    await askAllianceChannelConfirmationByDm({
      guild,
      storage,
      guildConfig: updated,
      candidates: allianceQuestion.candidates ?? []
    }).catch((error) => {
      console.warn(`Could not DM alliance detection question for ${guild.name}:`, error?.message ?? error);
    });
  }
  if (autoConfigQuestions.length) {
    await askAutoConfigQuestionsByDm({
      guild,
      storage,
      guildConfig: updated,
      questions: autoConfigQuestions
    }).catch((error) => {
      console.warn(`Could not DM auto-configuration question for ${guild.name}:`, error?.message ?? error);
    });
  }
  return updated;
}

async function detectAutoConfigurationForGuild({ guild, channels, roles, existing, discovery, supportAgent }) {
  if (existing?.ticketCategoryId && existing?.staffRoleId) return null;

  const categoryCandidates = buildTicketCategoryCandidates(channels, discovery);
  const staffRoleCandidates = buildStaffRoleCandidates(roles);
  const summaryParts = [];
  let aiDecision = null;

  if (supportAgent?.detectAutoConfiguration && (categoryCandidates.length || staffRoleCandidates.length)) {
    aiDecision = await supportAgent.detectAutoConfiguration({
      guildName: guild.name,
      categories: categoryCandidates,
      staffRoles: staffRoleCandidates,
      currentConfig: existing ?? {}
    }).catch((error) => {
      console.warn(`Auto-setup AI classifier failed in ${guild.name}:`, error?.message ?? error);
      return null;
    });
  }

  const ticketCategory = existing?.ticketCategoryId
    ? null
    : buildAutoConfigChoice({
      type: 'ticket_category',
      label: 'categoria de tickets',
      aiDecision: aiDecision?.ticketCategory,
      candidates: categoryCandidates,
      autoThreshold: 90,
      askThreshold: 45
    });
  const staffRole = existing?.staffRoleId
    ? null
    : buildAutoConfigChoice({
      type: 'staff_role',
      label: 'rol staff',
      aiDecision: aiDecision?.staffRole,
      candidates: staffRoleCandidates,
      autoThreshold: 88,
      askThreshold: 42
    });

  if (ticketCategory?.autoAssign) summaryParts.push(`Categoria detectada: ${ticketCategory.name}.`);
  if (ticketCategory?.shouldAsk) summaryParts.push('Necesito confirmar la categoria de tickets.');
  if (staffRole?.autoAssign) summaryParts.push(`Rol staff detectado: ${staffRole.name}.`);
  if (staffRole?.shouldAsk) summaryParts.push('Necesito confirmar el rol staff.');

  if (!ticketCategory && !staffRole) return null;
  return {
    summary: aiDecision?.summary || summaryParts.join(' ') || 'Autoconfiguracion revisada.',
    ticketCategory,
    staffRole
  };
}

function buildAutoConfigChoice({ type, label, aiDecision, candidates, autoThreshold, askThreshold }) {
  if (!candidates.length) return null;
  const strongest = candidates[0];
  const selected = aiDecision?.id
    ? candidates.find((candidate) => candidate.id === aiDecision.id) ?? strongest
    : strongest;
  const confidence = Math.max(Number(selected.confidence ?? 0), Number(aiDecision?.confidence ?? 0));
  const runnerUp = candidates.find((candidate) => candidate.id !== selected.id);
  const gap = confidence - Number(runnerUp?.confidence ?? 0);
  const aiAction = String(aiDecision?.action ?? '').toLowerCase();
  const reason = aiDecision?.reason || selected.reason;

  if ((aiAction === 'auto' && confidence >= autoThreshold) || (confidence >= autoThreshold && gap >= 14)) {
    return {
      type,
      label,
      autoAssign: true,
      id: selected.id,
      name: selected.name,
      confidence,
      reason,
      candidates
    };
  }

  if (aiAction === 'ask' || confidence >= askThreshold) {
    return {
      type,
      label,
      shouldAsk: true,
      id: selected.id,
      name: selected.name,
      confidence,
      reason,
      candidates
    };
  }

  return null;
}

function buildTicketCategoryCandidates(channels, discovery = {}) {
  const categories = channels
    .filter((channel) => channel?.type === ChannelType.GuildCategory && channel.id)
    .map((channel) => {
      const score = scoreAutoConfigName(channel.name, [
        ['ticket', 45],
        ['tickets', 45],
        ['soporte', 42],
        ['support', 42],
        ['ayuda', 34],
        ['asistencia', 34],
        ['atencion', 28],
        ['help', 28],
        ['reclamos', 22],
        ['reportes', 20]
      ]);
      const discoveryBonus = channel.id === discovery?.suggestedTicketCategoryId ? 35 : 0;
      const confidence = Math.min(99, score + discoveryBonus);
      return {
        id: channel.id,
        name: channel.name,
        confidence,
        reason: discoveryBonus
          ? 'Coincide con la categoria sugerida por smart discovery.'
          : 'El nombre parece una categoria de tickets o soporte.'
      };
    })
    .filter((candidate) => candidate.confidence >= 28)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  return categories;
}

function buildStaffRoleCandidates(roles) {
  return roles
    .filter((role) => role && role.id && !role.managed && role.name !== '@everyone')
    .map((role) => {
      const score = scoreAutoConfigName(role.name, [
        ['staff', 52],
        ['soporte', 48],
        ['support', 48],
        ['moderador', 42],
        ['moderadores', 42],
        ['mod', 36],
        ['admin', 34],
        ['administrador', 34],
        ['helper', 30],
        ['equipo', 28],
        ['atencion', 24],
        ['tickets', 22],
        ['ticket', 22]
      ]);
      const positionBonus = Math.min(16, Math.max(0, Number(role.position ?? 0) / 10));
      const confidence = Math.min(99, Math.round(score + positionBonus));
      return {
        id: role.id,
        name: role.name,
        confidence,
        reason: 'El nombre y posicion del rol parecen corresponder al equipo de staff.'
      };
    })
    .filter((candidate) => candidate.confidence >= 26)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

function scoreAutoConfigName(name = '', weightedKeywords = []) {
  const normalized = normalizeChannelNameForDiscovery(name);
  const compact = normalized.replace(/\s+/g, '');
  let score = 0;
  for (const [keyword, weight] of weightedKeywords) {
    const key = normalizeChannelNameForDiscovery(keyword);
    const compactKey = key.replace(/\s+/g, '');
    if (normalized === key || compact === compactKey) score = Math.max(score, weight + 42);
    else if (normalized.split(/\s+/).includes(key)) score = Math.max(score, weight + 28);
    else if (normalized.includes(key) || compact.includes(compactKey)) score = Math.max(score, weight);
  }
  return score;
}

async function detectAllianceChannelForGuild({ guild, channels, supportAgent }) {
  const candidates = await buildAllianceChannelCandidates(channels);
  if (!candidates.length) return null;

  const strongest = candidates[0];
  const runnerUp = candidates[1];
  if (strongest.score >= 150 && (!runnerUp || strongest.score - runnerUp.score >= 35)) {
    return {
      autoAssign: true,
      shouldAskInstaller: false,
      channelId: strongest.id,
      channelName: strongest.name,
        confidence: Math.min(98, strongest.score),
      reason: strongest.reason,
      candidates
    };
  }

  if (supportAgent?.detectAllianceChannel) {
    const aiResult = await supportAgent.detectAllianceChannel({
      guildName: guild.name,
      candidates: candidates.slice(0, 8)
    }).catch((error) => {
      console.warn(`Alliance channel AI classifier failed in ${guild.name}:`, error?.message ?? error);
      return null;
    });
    if (aiResult?.detected && aiResult.confidence >= 88 && !aiResult.shouldAskInstaller) {
      return {
        autoAssign: true,
        shouldAskInstaller: false,
        channelId: aiResult.channelId,
        channelName: aiResult.channelName,
        confidence: aiResult.confidence,
        reason: aiResult.reason,
        candidates
      };
    }
    if (aiResult?.shouldAskInstaller || aiResult?.detected) {
      return {
        autoAssign: false,
        shouldAskInstaller: true,
        channelId: aiResult.channelId ?? strongest.id,
        channelName: aiResult.channelName ?? strongest.name,
        confidence: aiResult.confidence ?? strongest.score,
        reason: aiResult.reason ?? strongest.reason,
        candidates
      };
    }
  }

  if (strongest.score >= 78) {
    return {
      autoAssign: false,
      shouldAskInstaller: true,
      channelId: strongest.id,
      channelName: strongest.name,
      confidence: Math.min(85, strongest.score),
      reason: strongest.reason,
      candidates
    };
  }

  return null;
}

async function buildAllianceChannelCandidates(channels) {
  const textChannels = channels
    .filter((channel) => channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
    .sort((a, b) => a.position - b.position)
    .slice(0, 40);
  const scored = [];
  for (const channel of textChannels) {
    const nameScore = scoreAllianceChannelName(channel.name);
    if (nameScore < 20 && scored.length > 18) continue;
    const sample = await fetchAllianceChannelSample(channel);
    const messageScore = scoreAllianceMessageSample(sample);
    const score = nameScore + messageScore;
    if (score >= 35) {
      scored.push({
        id: channel.id,
        name: channel.name,
        score,
        confidence: Math.min(99, score),
        reason: buildAllianceDetectionReason(nameScore, messageScore),
        sample: sample.slice(0, 1600)
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

async function fetchAllianceChannelSample(channel) {
  if (!channel?.messages?.fetch) return '';
  const messages = await channel.messages.fetch({ limit: 12 }).catch(() => null);
  if (!messages) return '';
  return [...messages.values()]
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .map((message) => [
      message.content,
      ...message.embeds.flatMap((embed) => [
        embed.title,
        embed.description,
        ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`)
      ]),
      ...[...message.attachments.values()].map((attachment) => attachment.name)
    ].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n---\n')
    .slice(0, 2600);
}

function scoreAllianceChannelName(name = '') {
  const normalized = normalizeText(name);
  const compact = normalized.replace(/\s+/g, '');
  let score = 0;
  for (const keyword of ['alianzas', 'alianza', 'partners', 'partnership', 'colaboraciones', 'colaboracion', 'socios', 'afiliados', 'publicidad', 'ads', 'promo']) {
    const key = normalizeText(keyword);
    if (normalized === key || compact === key.replace(/\s+/g, '')) score = Math.max(score, 95);
    if (normalized.includes(key) || compact.includes(key.replace(/\s+/g, ''))) score = Math.max(score, 70);
  }
  return score;
}

function scoreAllianceMessageSample(sample = '') {
  const normalized = normalizeText(sample);
  if (!normalized) return 0;
  let score = 0;
  if (/(discord\.gg|discord\.com\/invite|https?:\/\/)/i.test(sample)) score += 24;
  if (/\b(?:alianza|alianzas|partner|partners|partnership|colaboracion|afiliad|publicidad)\b/.test(normalized)) score += 35;
  if (/\b(?:plantilla|template|formato)\b/.test(normalized)) score += 24;
  if (/\b(?:servidor|server|proyecto|comunidad)\b/.test(normalized)) score += 16;
  if (/\b(?:miembros|members|usuarios|users)\b/.test(normalized)) score += 16;
  if (/\b(?:tematica|roleplay|rp|gaming|roblox|minecraft|anime|social)\b/.test(normalized)) score += 13;
  if (/\b(?:ofrecemos|ofrece|buscamos|beneficios|requisitos|normas)\b/.test(normalized)) score += 13;
  if (sample.length > 500) score += 10;
  return score;
}

function buildAllianceDetectionReason(nameScore, messageScore) {
  if (nameScore >= 70 && messageScore >= 55) return 'El nombre y los mensajes recientes parecen de alianzas.';
  if (messageScore >= 80) return 'Los mensajes recientes parecen plantillas de alianza.';
  if (nameScore >= 70) return 'El nombre del canal parece de alianzas.';
  return 'Hay senales parciales de alianzas.';
}

function shouldAskAllianceInstaller(allianceDetection = {}) {
  if (!allianceDetection?.askedAt) return true;
  const elapsed = Date.now() - new Date(allianceDetection.askedAt).getTime();
  return !Number.isFinite(elapsed) || elapsed > 1000 * 60 * 60 * 24 * 3;
}

function shouldAskAutoConfigContacts(autoConfig = {}) {
  if (!autoConfig?.askedAt) return true;
  const elapsed = Date.now() - new Date(autoConfig.askedAt).getTime();
  return !Number.isFinite(elapsed) || elapsed > 1000 * 60 * 60 * 24 * 3;
}

async function askAllianceChannelConfirmationByDm({ guild, storage, guildConfig, candidates }) {
  const contacts = await getGuildSetupContacts(guild, guildConfig);
  if (!contacts.length) return false;
  const topCandidates = candidates.slice(0, 5);
  if (!topCandidates.length) return false;

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.global} Confirmar canal de alianzas`)
    .setDescription([
      `He revisado **${guild.name}** y he visto posibles canales de alianzas, pero prefiero confirmarlo contigo antes de asignarlo.`,
      '',
      'Pulsa el canal correcto. Si ninguno sirve, configura manualmente con `/setup canal_alianzas:#canal plantilla_alianza:<texto>`.'
    ].join('\n'))
    .addFields(
      ...topCandidates.slice(0, 3).map((candidate, index) => ({
        name: `${index + 1}. #${candidate.name} (${candidate.confidence ?? Math.min(99, candidate.score)}%)`,
        value: candidate.reason,
        inline: false
      }))
    )
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    ...topCandidates.map((candidate, index) => new ButtonBuilder()
      .setCustomId(`nexadesk:alliance_autoset:${guild.id}:${candidate.id}`)
      .setLabel(`#${candidate.name}`.slice(0, 80))
      .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary))
  );
  const results = await Promise.allSettled(contacts.map(({ user }) => user.send({ embeds: [embed], components: [row] })));
  await storage.upsertGuildConfig(guild.id, {
    guildName: guild.name,
    allianceDetection: {
      ...(guildConfig.allianceDetection ?? {}),
      status: 'asked_contacts',
      askedAt: new Date().toISOString()
    }
  }).catch(() => {});
  return results.some((result) => result.status === 'fulfilled');
}

async function askAutoConfigQuestionsByDm({ guild, storage, guildConfig, questions }) {
  const contacts = await getGuildSetupContacts(guild, guildConfig);
  if (!contacts.length || !questions.length) return false;

  const jobs = [];
  for (const question of questions) {
    const topCandidates = question.candidates.slice(0, 5);
    if (!topCandidates.length) continue;
    const embed = new EmbedBuilder()
      .setColor(0xffffff)
      .setTitle(`${EMOJIS.nexalogo} Duda de autoconfiguracion`)
      .setDescription([
        `Estoy configurando **${guild.name}** automaticamente, pero prefiero confirmar **${question.label}** antes de guardarlo.`,
        '',
        question.reason || 'Hay varias opciones posibles.',
        '',
        'Pulsa la opcion correcta. Si otro responsable responde primero, te avisare por MD.'
      ].join('\n'))
      .addFields(
        ...topCandidates.slice(0, 3).map((candidate, index) => ({
          name: `${index + 1}. ${candidate.name} (${candidate.confidence ?? 0}%)`,
          value: candidate.reason || 'Candidato detectado por NexaDesk.',
          inline: false
        }))
      )
      .setTimestamp(new Date());
    const row = new ActionRowBuilder().addComponents(
      ...topCandidates.map((candidate, index) => new ButtonBuilder()
        .setCustomId(`nexadesk:autoconfig:${guild.id}:${question.type}:${candidate.id}`)
        .setLabel(candidate.name.slice(0, 80))
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary))
    );
    for (const { user } of contacts) {
      jobs.push(user.send({ embeds: [embed], components: [row] }));
    }
  }

  const results = await Promise.allSettled(jobs);
  await storage.upsertGuildConfig(guild.id, {
    guildName: guild.name,
    autoConfig: {
      ...(guildConfig.autoConfig ?? {}),
      status: 'asked_contacts',
      askedAt: new Date().toISOString()
    }
  }).catch(() => {});
  return results.some((result) => result.status === 'fulfilled');
}

async function getGuildSetupContacts(guild, guildConfig = {}) {
  const contacts = new Map();
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner?.user) contacts.set(owner.user.id, { user: owner.user, label: 'owner' });

  const installerId = guildConfig?.addedByUserId || (await fetchBotInstallerInfo(guild).catch(() => null))?.userId;
  if (installerId && !contacts.has(installerId)) {
    const installerUser = await guild.client.users.fetch(installerId).catch(() => null);
    if (installerUser) contacts.set(installerUser.id, { user: installerUser, label: 'instalador' });
  }

  return [...contacts.values()];
}

async function notifyOtherSetupContacts({ guild, guildConfig = {}, resolver, topic }) {
  const contacts = await getGuildSetupContacts(guild, guildConfig);
  const others = contacts.filter(({ user }) => user.id !== resolver.id);
  if (!others.length) return;
  const body = [
    `${EMOJIS.check} <@${resolver.id}> ya me ha resuelto la duda sobre **${topic}** en **${guild.name}**.`,
    'No tienes que hacer nada mas para esa parte.'
  ].join('\n');
  await Promise.allSettled(others.map(({ user }) => user.send({ content: body, allowedMentions: { users: [resolver.id] } })));
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

export async function deleteTicketPanel(client, storage, { guildId, messageId }) {
  const guild = await client.guilds.fetch(guildId);
  const existing = await storage.getGuildConfig(guildId);
  const currentPanel = existing?.panels?.find((panel) => panel.messageId === messageId);
  if (!currentPanel) throw new Error('No encuentro ese panel en la configuracion guardada.');

  const channel = await guild.channels.fetch(currentPanel.channelId).catch(() => null);
  if (channel?.type === ChannelType.GuildText) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    await message?.delete().catch((error) => {
      console.warn(`Could not delete panel message ${messageId}:`, error?.message ?? error);
    });
  }

  return storage.upsertGuildConfig(guildId, {
    guildName: guild.name,
    panels: (existing?.panels ?? []).filter((item) => item.messageId !== messageId)
  });
}

export async function refreshTicketPanels(client, storage, { guildId }) {
  const guild = await client.guilds.fetch(guildId);
  const existing = await storage.getGuildConfig(guildId);
  const panels = existing?.panels ?? [];
  const refreshedAt = new Date().toISOString();

  for (const panel of panels) {
    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (!message?.editable) continue;
    await message.edit({
      embeds: [new EmbedBuilder(buildPanelEmbed(panel))],
      components: [buildPanelActionRow(panel, existing?.components ?? [])]
    }).catch((error) => {
      console.warn(`Could not refresh panel ${panel.messageId}:`, error?.message ?? error);
    });
  }

  return storage.upsertGuildConfig(guildId, {
    guildName: guild.name,
    panels: panels.map((panel) => ({ ...panel, refreshedAt }))
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
    .filter((channel) => channel && (
      channel.type === ChannelType.GuildText
      || channel.type === ChannelType.GuildAnnouncement
      || channel.type === ChannelType.GuildForum
      || channel.type === ChannelType.GuildCategory
    ))
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message = 'Operation timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createTypingHeartbeat(channel, { intervalMs = 7000, label = 'channel' } = {}) {
  let timer = null;
  const startedAt = Date.now();
  const sendTyping = () => channel.sendTyping().catch((error) => {
    console.warn(`Typing heartbeat failed for ${label}:`, error?.message ?? error);
  });

  return {
    start() {
      sendTyping();
      timer = setInterval(sendTyping, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      return Date.now() - startedAt;
    }
  };
}

