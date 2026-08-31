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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import crypto from 'node:crypto';
import {
  buildAffiliateProgress,
  formatAffiliateIdentifier,
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
import { ADMIN_CODE_ROLE_ID } from './admin-code.js';
import {
  buildMaintenanceNoticeText,
  getMaintenanceDelayMs,
  normalizeMaintenanceState,
  shouldApplyMaintenanceToGuild
} from './maintenance.js';
import { buildPanelActionRow, buildPanelEmbed, normalizePanelOptions, normalizeTicketComponent } from './panel-options.js';
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
import { buildGatewayGuildBackupSnapshot, restoreGuildBackupWithRest } from './backups.js';
import { buildFeedbackStats, formatRatingStars, normalizeGrowthConfig } from './growth.js';
import { DEFAULT_PREMIUM_MODULES, PREMIUM_SALES_FEATURES, getPremiumCheckoutConfig } from './premium-billing.js';
import { isPremiumEntitled, normalizePremiumConfig } from './premium.js';
import { buildReleaseState, findPendingFeatureByCommand } from './release-gates.js';
import { SecurityManager, SECURITY_LEVELS, normalizeSecurityConfig, normalizeSecurityLevel, summarizeSecurityConfig } from './security.js';
import { analyzeGuildChannelsForDiscovery, hasUsefulDiscovery, normalizeChannelNameForDiscovery, normalizeDiscoveryConfig } from './server-discovery.js';
import { buildTranscriptReplayUrl } from './transcripts.js';
import { hasVisualAttachments } from './ai/visual-analyzer.js';
import { createTicketFlowCard } from './welcome-card.js';
import { formatWelcomeTemplate as formatMemberWelcomeTemplate, normalizeWelcomeConfig } from './welcome.js';
import { XNPROTECT_BLACKLIST_CREDIT, checkXnProtectGlobalBan } from './xnprotect-blacklist.js';

const BOT_INVITE_PERMISSIONS = '1099780451478';
const PUBLIC_DASHBOARD_URL = 'https://nexa-desk.com/';
const PREMIUM_ADMIN_USER_ID = '1352652366330986526';
const ALLIANCE_MARKER = '[NexaDesk alliance]';
const CRISIS_MARKER = '[NexaDesk crisis]';
const STAFF_HANDOFF_MARKER = '[NexaDesk staff handoff]';
const STAFF_ESCALATION_MARKER = '[NexaDesk staff escalation]';
const STAFF_ONLY_COMPONENT_MARKER = 'component:staff-only';
const SCHEDULED_ANNOUNCEMENT_STATUS_LOG_MS = 5 * 60 * 1000;
const scheduledAnnouncementStatusLogCache = new Map();

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
  const activeFeedbackRatings = new Set();
  const panelCreatedChannels = new Set();
  const blacklistAlertedChannels = new Set();
  const ticketWelcomeChannels = new Set();
  const managedTimers = new Set();
  const securityManager = new SecurityManager({ storage, client, supportAgent, config });
  const leadershipGate = createHaLeadershipGate({ storage, config });
  voiceManager?.setTicketCloseHandler?.(({ session, member, transcript }) => handleVoiceTicketCloseRequest({
    client,
    storage,
    voiceManager,
    config,
    session,
    member,
    transcript
  }));

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
    if (config.BACKUPS_ENABLED) {
      trackManagedTimeout(managedTimers, () => {
        if (!isClientReadyForDiscordRest(readyClient)) return;
        captureInstalledGuildBackups({ client: readyClient, storage, source: 'startup' }).catch((error) => {
          console.error('Initial guild backup capture failed:', error);
        });
      }, config.BACKUP_STARTUP_DELAY_MS);
      trackManagedInterval(managedTimers, () => {
        if (!isClientReadyForDiscordRest(readyClient)) return;
        captureInstalledGuildBackups({ client: readyClient, storage, source: 'scheduled' }).catch((error) => {
          console.error('Scheduled guild backup capture failed:', error);
        });
      }, config.BACKUP_INTERVAL_MS);
    }
    trackManagedTimeout(managedTimers, () => {
      if (!isClientReadyForDiscordRest(readyClient)) return;
      processScheduledAnnouncements({ client: readyClient, storage }).catch((error) => {
        console.error('Initial scheduled announcements processor failed:', compactRuntimeError(error));
      });
    }, 15_000);
    trackManagedInterval(managedTimers, () => {
      if (!isClientReadyForDiscordRest(readyClient)) return;
      processScheduledAnnouncements({ client: readyClient, storage }).catch((error) => {
        console.error('Scheduled announcements processor failed:', compactRuntimeError(error));
      });
    }, 60_000);
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
        await handleTicketFeedbackButton({ interaction, storage, client, activeFeedbackRatings });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:ai_feedback:')) {
        await handleAiFeedbackButton({ interaction, storage });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('nexadesk:report:reject:')) {
        await handleReportRejectButton({ interaction, storage });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('nexadesk:report:action:')) {
        await handleReportActionSelect({ interaction, storage });
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

      if (await shouldBlockPendingCommand({ interaction, storage })) return;

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
          await handleCloseTicketCommand({ interaction, storage, client, voiceManager, config });
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
        await handleSendTranscriptCommand({ interaction, storage, config });
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

      if (interaction.commandName === 'reporte') {
        await handleReportCommand({ interaction, storage });
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

      if (interaction.commandName === 'message-owner') {
        await handleMessageOwnerCommand({ interaction, storage, client });
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

      if (interaction.commandName === 'novedades') {
        await handleReleaseNotesCommand({ interaction, storage, config });
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
      if (isNumberedTicketChannel(channel)) return;
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
      await finalizeDeletedTicket({ client, storage, channel, ticket, voiceManager, config });
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

    const externalTicketSource = (!ticket || !ticket.openedBy)
      ? await detectExternalTicketSource(message)
      : null;
    const externalTicketDetected = Boolean(externalTicketSource);
    const externalTicketOpenerId = externalTicketDetected
      ? await resolveExternalTicketOpenerId(message)
      : null;
    let externalTicketBlacklistChecked = false;
    if (externalTicketDetected && !guildConfig) {
      guildConfig = await storage.upsertGuildConfig(message.guild.id, {
        guildName: message.guild.name
      });
    }

    if (!ticket && (isConfiguredTicketCategory(message.channel, guildConfig) || externalTicketDetected)) {
      ticket = await createDetectedTicketRecord({ storage, channel: message.channel, openedBy: externalTicketOpenerId });
      if (externalTicketDetected && !ticket.alreadyExists && message.author.bot) {
        await sendExternalTicketWelcomeOnce({
          storage,
          message,
          guildConfig,
          ticketWelcomeChannels,
          sourceName: externalTicketSource.name
        });

        ticket = await maybeAlertTicketOpenerXnProtect({
          storage,
          channel: message.channel,
          guildConfig,
          ticket,
          openerId: externalTicketOpenerId,
          blacklistAlertedChannels
        });
        externalTicketBlacklistChecked = true;
      }
    }

    if (externalTicketDetected && ticket && externalTicketOpenerId && !ticket.openedBy) {
      const updatedTicket = await storage.updateTicket(ticket.channelId, { openedBy: externalTicketOpenerId });
      ticket = updatedTicket ?? ticket;
    }

    if (externalTicketDetected && ticket && !externalTicketBlacklistChecked) {
      ticket = await maybeAlertTicketOpenerXnProtect({
        storage,
        channel: message.channel,
        guildConfig,
        ticket,
        openerId: externalTicketOpenerId,
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
      await handleNaturalCloseRequest({ client, storage, message, ticket, guildConfig, config });
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

    if (hasVisualAttachments(message) && isActiveVoiceTicketMessage(voiceManager, message)) {
      await voiceManager.ingestVisualMessage({ message, guildConfig });
      return;
    }

    if (!config.AI_AUTO_REPLY) return;
    const activeResponseKey = message.channelId;
    if (activeResponses.has(activeResponseKey)) return;
    if (isAiDisabledTicket(ticket)) return;
    if (await shouldStaySilentInTicket({ storage, message, ticket, guildConfig, client })) return;

    activeResponses.add(activeResponseKey);
    try {
      if (isSensitiveFileAccessRequest(message.content)) {
        const reply = await sendTicketResponse(message, {
          content: buildSensitiveFileAccessRefusal(message),
          allowedMentions: { parse: [] }
        });
        await saveTranscript(storage, reply, 'assistant');
        return;
      }

      if (isVoiceConversationRequest(message.content)) {
        const handled = await handleNaturalVoiceRequest({
          storage,
          message,
          ticket,
          guildConfig,
          voiceManager
        });
        if (handled) return;
      }

      const autonomousAction = await handleAutonomousTicketAction({
        storage,
        supportAgent,
        message,
        ticket,
        guildConfig,
        voiceManager,
        config
      });
      if (autonomousAction.handled) return;

      if (isRaidReportMessage(message.content)) {
        const escalation = buildRaidReportEscalation(message);
        const shouldMentionStaff = await registerTicketEscalation({
          storage,
          message,
          guildConfig,
          ticket,
          reason: escalation.reason
        });
        const latestTicket = await storage.getTicket(message.channel.id);
        if (!latestTicket || isClosedTicket(latestTicket)) return;

        const reply = await sendTicketResponse(message, {
          content: buildPublicReply(escalation, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
          allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
        });
        await saveTranscript(storage, reply, 'assistant');
        return;
      }

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
        const publicAnswer = [
          `${message.author}, he avisado al staff para que entre a ayudarte directamente.`,
          'Les dejo este ticket preparado con el contexto para que puedan revisarlo sin perder tiempo.'
        ].join('\n');
        const escalation = {
          shouldEscalate: true,
          reason: 'El usuario solicita asistencia manual de staff.',
          publicAnswer
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
    await handleWelcomeMemberAdd({ member, storage }).catch((error) => {
      console.error(`Welcome Center failed in ${member.guild.id}:`, error);
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

  client.on(Events.GuildIntegrationsUpdate, async (guild) => {
    if (!await leadershipGate.isActive()) return;
    await securityManager.handleGuildIntegrationsUpdate(guild).catch((error) => {
      console.error(`Security integrations guard failed in ${guild?.id ?? 'unknown'}:`, error);
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

async function shouldBlockPendingCommand({ interaction, storage }) {
  if (!interaction?.isChatInputCommand?.()) return false;
  if (interaction.user?.id === PREMIUM_ADMIN_USER_ID) return false;

  const settings = await storage.getGlobalSettings().catch(() => ({}));
  const releaseState = buildReleaseState(settings.releaseControl);
  const pendingFeature = findPendingFeatureByCommand(releaseState, interaction.commandName);
  if (!pendingFeature) return false;

  await interaction.reply({
    ephemeral: true,
    content: [
      `${EMOJIS.gear} **Estamos trabajando en esta funcion.**`,
      `**${pendingFeature.title}** todavia esta en pruebas internas de NexaDesk.`,
      'El owner global puede probarla antes del lanzamiento publico. Cuando se publique desde `/owner`, quedara disponible para todos.'
    ].join('\n')
  });
  return true;
}

async function getPendingReleaseFeature({ storage, featureId, userId }) {
  if (userId === PREMIUM_ADMIN_USER_ID) return null;
  const settings = await storage.getGlobalSettings().catch(() => ({}));
  const releaseState = buildReleaseState(settings.releaseControl);
  return (releaseState.features ?? []).find((feature) => feature.id === featureId && !feature.released) ?? null;
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

async function handleWelcomeMemberAdd({ member, storage }) {
  if (!member?.guild || member.user?.bot) return;
  const guildConfig = await storage.getGuildConfig(member.guild.id).catch(() => null);
  const welcome = normalizeWelcomeConfig(guildConfig?.welcome);
  if (!welcome.enabled) return;

  const actions = [];
  if (welcome.roleId) {
    const role = await member.guild.roles.fetch(welcome.roleId).catch(() => null);
    if (role && member.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      const added = await member.roles.add(role, 'NexaDesk Welcome Center role').then(() => true).catch(() => false);
      actions.push(added ? `Rol aplicado: ${role.name}` : `No pude aplicar rol: ${role.name}`);
    } else {
      actions.push('Rol no aplicado: falta permiso Manage Roles o el rol no existe.');
    }
  }

  if (welcome.channelId) {
    const channel = await member.guild.channels.fetch(welcome.channelId).catch(() => null);
    if (channel?.isTextBased?.()) {
      const content = formatMemberWelcomeTemplate(welcome.message, {
        userMention: `${member}`,
        username: member.user.username,
        serverName: member.guild.name
      });
      const sent = await channel.send({
        content,
        allowedMentions: { users: [member.id], roles: [] }
      }).then(() => true).catch(() => false);
      actions.push(sent ? `Mensaje publico enviado en #${channel.name}` : `No pude enviar mensaje en #${channel.name}`);
    } else {
      actions.push('Mensaje publico no enviado: canal de bienvenida no valido.');
    }
  }

  if (welcome.dmEnabled) {
    const dmText = formatMemberWelcomeTemplate(welcome.dmMessage, {
      userMention: member.user.username,
      username: member.user.username,
      serverName: member.guild.name
    });
    const dmSent = await member.send(dmText).then(() => true).catch(() => false);
    actions.push(dmSent ? 'MD de bienvenida enviado.' : 'MD no enviado: usuario con privados cerrados.');
  }

  await storage.addGuildLog?.({
    guildId: member.guild.id,
    guildName: member.guild.name,
    type: 'growth',
    severity: 'info',
    title: 'Welcome Center ejecutado',
    message: `${member.user.tag} entro al servidor y NexaDesk proceso la bienvenida configurada.`,
    actorId: member.user.id,
    actorName: member.user.tag,
    metadata: {
      welcome,
      actions
    }
  }).catch((error) => {
    console.warn(`Could not persist welcome log for ${member.guild.id}:`, error?.message ?? error);
  });
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
    .setTitle(`${EMOJIS.global} Te recomendaron NexaDesk?`)
    .setDescription([
      `Si alguien te recomendo NexaDesk para **${guild.name}**, dile que te pase su **nombre de usuario de Discord**.`,
      '',
      `Usalo dentro del servidor con: \`/afiliado server usuario:<USERNAME>\``,
      '',
      `Cuando lo registres, ambos ayudais al crecimiento de NexaDesk. Cada **${threshold} servidores** que registren ese usuario, el afiliado gana **1 slot Premium durante ${rewardDays} dias**.`
    ].join('\n'))
    .addFields(
      {
        name: `${EMOJIS.check} Si tu quieres invitar servidores`,
        value: 'Ejecuta `/afiliado nombre` y comparte tu username. Es una forma directa de conseguir Premium sin pagar.'
      },
      {
        name: `${EMOJIS.nexalogo} Importante`,
        value: 'Cada servidor solo puede registrar un afiliado una vez. Elegidlo bien antes de usarlo.'
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
          'Funciona con paneles propios o con otros bots de tickets: Ticket King, XN Tickets, Guild Manager y canales en categorias configuradas.',
          'No tienes que migrar tu sistema actual: NexaDesk se convierte en la capa IA que atiende dentro del ticket.',
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
    .setTitle(`${EMOJIS.ticket} Estado del ticket`)
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
    .setTitle(`${EMOJIS.ticket} Briefing para staff`)
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
    .setTitle(`${EMOJIS.siren} Triage inteligente del ticket`)
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

async function handleCloseTicketCommand({ interaction, storage, client, voiceManager = null, config }) {
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
    await interaction.reply({
      content: !canTicketOpenerClose(guildConfig)
        ? 'En este servidor los tickets solo puede cerrarlos el staff configurado o alguien con Manage Server.'
        : 'Solo quien abrio este ticket, el staff configurado o alguien con Manage Server puede cerrarlo.',
      ephemeral: true
    });
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
    config,
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
      'La sala de voz no se pudo activar porque faltan columnas Pro Voice en PostgreSQL.',
      'Revisa que el esquema de PostgreSQL esté actualizado y vuelve a intentarlo.'
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

  if (!canCloseTicketFromInteraction(interaction, ticket, guildConfig)) {
    await interaction.reply({
      content: !canTicketOpenerClose(guildConfig)
        ? 'En este servidor las salas de voz de ticket solo puede cerrarlas staff o alguien con Manage Server.'
        : 'Solo el opener, el staff configurado o alguien con Manage Server puede cerrar la sala de voz.',
      ephemeral: true
    });
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

async function handleNaturalVoiceRequest({ storage, message, ticket, guildConfig, voiceManager = null }) {
  if (!message.guild || !ticket || !guildConfig) return false;

  const existingChannel = ticket.voiceChannelId
    ? await message.guild.channels.fetch(ticket.voiceChannelId).catch(() => null)
    : null;
  if (existingChannel) {
    const reply = await sendTicketResponse(message, {
      content: `${EMOJIS.wifi} Si, ya tienes sala de voz vinculada a este ticket: ${existingChannel}. Entra ahi y seguimos por voz.`,
      allowedMentions: { repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  if (!isVoiceSupportEnabled(guildConfig)) {
    const reply = await sendTicketResponse(message, {
      content: [
        `${EMOJIS.wifi} Puedo atender por voz, pero en este servidor la voz esta reservada para **Premium**.`,
        `Puedes seguir por aqui o pedir al staff que active Premium desde ${PUBLIC_DASHBOARD_URL}#premium.`
      ].join('\n'),
      allowedMentions: { repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  if (!canManageVoiceSupportFromMessage(message, ticket, guildConfig)) {
    const reply = await sendTicketResponse(message, {
      content: 'La sala de voz solo puede abrirla quien creo el ticket, el staff configurado o alguien con Manage Server.',
      allowedMentions: { repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    const reply = await sendTicketResponse(message, {
      content: 'Quiero abrirte sala de voz, pero me falta **Manage Channels** para crearla.',
      allowedMentions: { repliedUser: false }
    });
    await saveTranscript(storage, reply, 'assistant');
    return true;
  }

  const preparing = await sendTicketResponse(message, {
    content: `${EMOJIS.wifi} Si, creamos una sala de voz privada para este ticket. Dame un momento.`,
    allowedMentions: { repliedUser: false }
  });
  await saveTranscript(storage, preparing, 'assistant');

  const result = await createVoiceRoomForTicket({
    interaction: buildMessageInteractionContext(message),
    storage,
    voiceManager,
    ticket,
    guildConfig,
    textChannel: message.channel,
    requestedName: ticket.channelName || message.author.username,
    requestId: `natural-${message.id}`
  }).catch((error) => {
    console.error(`Natural voice room creation failed in ${message.channelId}:`, compactRuntimeError(error));
    return { ready: false, error };
  });

  const content = result.ready
    ? [
        `${EMOJIS.wifi} Sala de voz creada: ${result.channel}`,
        result.session?.started
          ? 'Entra cuando quieras. NexaDesk escuchara, transcribira y respondera por voz.'
          : `La sala esta creada, pero la IA de voz no pudo arrancar: ${result.session?.reason ?? 'motor no disponible.'}`
      ].join('\n')
    : [
        'No pude crear la sala de voz automaticamente.',
        'Revisa que tenga **Manage Channels**, **Connect**, **Speak** y que la migracion Pro Voice de PostgreSQL este aplicada.'
      ].join('\n');

  const reply = await message.channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (reply) await saveTranscript(storage, reply, 'assistant');
  return true;
}

async function handleAutonomousTicketAction({ storage, supportAgent, message, ticket, guildConfig, voiceManager = null, config }) {
  if (!config.AI_ACTIONS_ENABLED) return { handled: false };
  if (!supportAgent?.planTicketAction) return { handled: false };
  if (!shouldConsiderAutonomousActionRequest(message)) return { handled: false };

  const evidence = await buildTicketActionEvidence({ storage, message, ticket, guildConfig });
  const decision = await supportAgent.planTicketAction({
    message,
    ticket,
    guildConfig,
    evidence
  }).catch((error) => {
    console.warn(`Autonomous action planner failed in ${message.channelId}:`, error?.message ?? error);
    return null;
  });

  if (!decision || decision.action === 'none') return { handled: false };

  if (decision.action === 'create_voice_room') {
    return { handled: await handleNaturalVoiceRequest({ storage, message, ticket, guildConfig, voiceManager }) };
  }

  if (decision.action === 'ban_user') {
    return handleAutonomousBanAction({ storage, message, ticket, guildConfig, decision, evidence, config });
  }

  if (decision.action === 'create_text_channel') {
    return handleAutonomousCreateChannelAction({ storage, message, ticket, guildConfig, decision, evidence, config });
  }

  if (decision.action === 'delete_channel') {
    return handleAutonomousDeleteChannelAction({ storage, message, ticket, guildConfig, decision, evidence, config });
  }

  if (decision.action === 'lock_channel') {
    return handleAutonomousLockChannelAction({ storage, message, ticket, guildConfig, decision, evidence, config });
  }

  if (decision.action === 'escalate_staff') {
    const reason = decision.reason || 'La accion solicitada requiere revision humana.';
    const shouldMentionStaff = await registerTicketEscalation({ storage, message, guildConfig, ticket, reason });
    const reply = await sendTicketResponse(message, {
      content: buildPublicReply({
        shouldEscalate: true,
        reason,
        publicAnswer: decision.publicResponse || 'Puedo preparar el caso, pero esta accion necesita que el staff la revise antes de ejecutarla.'
      }, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
      allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
    });
    await saveTranscript(storage, reply, 'assistant');
    await logAutonomousAction(storage, message, {
      decision,
      executed: false,
      reason,
      severity: 'warning',
      title: 'Accion IA enviada a staff'
    });
    return { handled: true };
  }

  return { handled: false };
}

async function handleAutonomousBanAction({ storage, message, ticket, guildConfig, decision, evidence, config }) {
  const blockReason = await validateAutonomousBan({ message, guildConfig, decision, evidence, config });
  if (blockReason) {
    const shouldMentionStaff = await registerTicketEscalation({ storage, message, guildConfig, ticket, reason: blockReason });
    const reply = await sendTicketResponse(message, {
      content: buildPublicReply({
        shouldEscalate: true,
        reason: blockReason,
        publicAnswer: [
          'No voy a banear automaticamente con la informacion actual.',
          `${blockReason}`,
          'He avisado al staff para que revise el caso con seguridad.'
        ].join('\n')
      }, guildConfig, { mentionStaff: shouldMentionStaff }).slice(0, 1900),
      allowedMentions: { roles: shouldMentionStaff && guildConfig.staffRoleId ? [guildConfig.staffRoleId] : [] }
    });
    await saveTranscript(storage, reply, 'assistant');
    await logAutonomousAction(storage, message, {
      decision,
      executed: false,
      reason: blockReason,
      severity: 'warning',
      title: 'Ban autonomo bloqueado por seguridad'
    });
    return { handled: true };
  }

  const targetMember = await message.guild.members.fetch(decision.targetUserId).catch(() => null);
  const targetLabel = targetMember?.user?.tag ?? decision.targetUserId;
  const reason = `NexaDesk IA: ${decision.reason || 'evidencia fuerte revisada en ticket'}`.slice(0, 480);

  await targetMember?.send([
    `Has sido baneado de **${message.guild.name}** por NexaDesk.`,
    `Motivo: ${decision.reason || 'Evidencia fuerte revisada en un ticket.'}`,
    'Si crees que es un error, contacta con el staff del servidor o usa el servidor de soporte de NexaDesk.'
  ].join('\n')).catch(() => null);

  const banned = await message.guild.members.ban(decision.targetUserId, {
    reason,
    deleteMessageSeconds: 0
  }).then(() => true).catch((error) => {
    console.error(`Autonomous ban failed in ${message.guildId} for ${decision.targetUserId}:`, compactRuntimeError(error));
    return false;
  });

  if (!banned) {
    const reply = await sendTicketResponse(message, {
      content: [
        'Tenia criterio suficiente para actuar, pero Discord no me dejo aplicar el ban.',
        'Probablemente falta **Ban Members** o mi rol esta por debajo del usuario objetivo. Aviso al staff para que lo revise.'
      ].join('\n'),
      allowedMentions: { parse: [] }
    });
    await saveTranscript(storage, reply, 'assistant');
    await logAutonomousAction(storage, message, {
      decision,
      executed: false,
      reason: `Discord rechazo el ban de ${targetLabel}.`,
      severity: 'critical',
      title: 'Ban autonomo fallido por permisos'
    });
    return { handled: true };
  }

  const reply = await sendTicketResponse(message, {
    content: [
      `${EMOJIS.ban} Accion ejecutada: **ban aplicado** a ${targetMember ? `${targetMember}` : `<@${decision.targetUserId}>`}.`,
      `Motivo: ${decision.reason}`,
      decision.proofSummary?.length ? `Pruebas: ${decision.proofSummary.slice(0, 3).join(' | ')}` : ''
    ].filter(Boolean).join('\n').slice(0, 1900),
    allowedMentions: { users: [decision.targetUserId], roles: [] }
  });
  await saveTranscript(storage, reply, 'assistant');
  await storage.updateTicket(ticket.channelId, { status: 'staff_waiting' }).catch(() => null);
  await logAutonomousAction(storage, message, {
    decision,
    executed: true,
    reason: `Ban aplicado a ${targetLabel}.`,
    severity: 'critical',
    title: 'Ban autonomo ejecutado'
  });
  return { handled: true };
}

async function handleAutonomousCreateChannelAction({ storage, message, guildConfig, decision, evidence, config }) {
  if (!canMessageManageChannels(message, guildConfig)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Crear canales por IA requiere staff o Manage Channels.' });
  }
  if (decision.confidence < config.AI_ACTIONS_CHANNEL_CONFIDENCE) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'La IA no tiene suficiente confianza para crear un canal sin revision.' });
  }
  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Me falta Manage Channels para crear canales.' });
  }

  const name = sanitizeAutonomousChannelName(decision.channelName || inferChannelNameFromText(message.content));
  if (!name) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'No hay un nombre de canal claro.' });
  }

  const channelOptions = {
    name,
    type: ChannelType.GuildText,
    reason: `NexaDesk AI action requested by ${message.author.tag}`
  };
  const parentId = await resolveAutonomousChannelParentId(message, guildConfig);
  if (parentId) channelOptions.parent = parentId;

  const channel = await message.guild.channels.create(channelOptions);
  const reply = await sendTicketResponse(message, {
    content: `${EMOJIS.check} Canal creado: ${channel}.`,
    allowedMentions: { parse: [] }
  });
  await saveTranscript(storage, reply, 'assistant');
  await logAutonomousAction(storage, message, {
    decision: { ...decision, targetChannelId: channel.id, channelName: channel.name },
    executed: true,
    reason: `Canal #${channel.name} creado.`,
    severity: 'success',
    title: 'Canal creado por accion IA'
  });
  return { handled: true };
}

async function handleAutonomousDeleteChannelAction({ storage, message, ticket, guildConfig, decision, config }) {
  if (!canMessageManageChannels(message, guildConfig)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Eliminar canales por IA requiere staff o Manage Channels.' });
  }
  if (decision.confidence < config.AI_ACTIONS_CHANNEL_CONFIDENCE) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'La IA no tiene suficiente confianza para eliminar un canal sin revision.' });
  }
  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Me falta Manage Channels para eliminar canales.' });
  }

  const targetChannelId = decision.targetChannelId || extractMentionedChannelIds(message)[0] || (mentionsCurrentChannelDeletion(message.content) ? message.channelId : null);
  if (!targetChannelId) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'No hay canal objetivo claro para eliminar.' });
  }
  if (targetChannelId === message.channelId) {
    const reply = await sendTicketResponse(message, {
      content: 'Este es el canal del ticket. Lo cerrare correctamente con transcripcion en vez de borrarlo en seco.',
      allowedMentions: { parse: [] }
    });
    await saveTranscript(storage, reply, 'assistant');
    await closeTicketWithTranscript({
      client: message.client,
      storage,
      config,
      channel: message.channel,
      guild: message.guild,
      ticket,
      requestedBy: message.author,
      requestId: `ai-delete-${message.id}`,
      closingReply: reply,
      fallbackUser: message.author,
      reason: `NexaDesk AI ticket close requested by ${message.author.tag}`
    });
    return { handled: true };
  }
  if ([guildConfig.ticketCategoryId, guildConfig.voiceCategoryId, guildConfig.allianceChannelId].includes(targetChannelId)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'No eliminare canales/categorias criticas configuradas para NexaDesk sin revision manual.' });
  }

  const channel = await message.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!channel || !channel.deletable) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'No pude encontrar o eliminar ese canal por permisos/jerarquia.' });
  }

  await channel.delete(`NexaDesk AI action requested by ${message.author.tag}`);
  const reply = await sendTicketResponse(message, {
    content: `${EMOJIS.check} Canal eliminado: #${channel.name ?? targetChannelId}.`,
    allowedMentions: { parse: [] }
  });
  await saveTranscript(storage, reply, 'assistant');
  await logAutonomousAction(storage, message, {
    decision: { ...decision, targetChannelId, channelName: channel.name },
    executed: true,
    reason: `Canal #${channel.name ?? targetChannelId} eliminado.`,
    severity: 'critical',
    title: 'Canal eliminado por accion IA'
  });
  return { handled: true };
}

async function handleAutonomousLockChannelAction({ storage, message, ticket, guildConfig, decision, evidence, config }) {
  const activeRaid = evidence?.signals?.includes('active_raid_or_mass_spam');
  const staffAllowed = canMessageManageChannels(message, guildConfig);
  if (!staffAllowed && !(activeRaid && decision.confidence >= config.AI_ACTIONS_LOCK_CONFIDENCE)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Bloquear canales automaticamente requiere staff o evidencia de raid activo.' });
  }
  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'Me falta Manage Channels para bloquear canales.' });
  }

  const targetChannelId = decision.targetChannelId || extractMentionedChannelIds(message)[0] || message.channelId;
  const channel = await message.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!channel?.permissionOverwrites?.edit) {
    return respondActionNeedsStaff({ storage, message, guildConfig, decision, reason: 'No pude bloquear ese canal.' });
  }

  await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: false
  }, { reason: `NexaDesk AI lockdown requested by ${message.author.tag}` });

  const reply = await sendTicketResponse(message, {
    content: `${EMOJIS.ban} Canal bloqueado temporalmente: ${channel}. El staff puede revisarlo y reabrirlo cuando termine el incidente.`,
    allowedMentions: { parse: [] }
  });
  await saveTranscript(storage, reply, 'assistant');
  await logAutonomousAction(storage, message, {
    decision: { ...decision, targetChannelId, channelName: channel.name },
    executed: true,
    reason: `Canal #${channel.name ?? targetChannelId} bloqueado.`,
    severity: 'critical',
    title: 'Canal bloqueado por accion IA'
  });
  return { handled: true };
}

async function buildTicketActionEvidence({ storage, message, ticket, guildConfig }) {
  const [transcriptMessages, recentMessages] = await Promise.all([
    storage.listTranscriptMessages(message.channelId).catch(() => []),
    message.channel.messages.fetch({ limit: 12 }).catch(() => new Map())
  ]);

  const recent = [...recentMessages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-10);
  const requesterIsStaff = isConfiguredStaffMember(message.member, message.author, guildConfig);
  const mentionedUsers = [...message.mentions.users.values()]
    .filter((user) => user.id !== message.client.user?.id)
    .map((user) => ({ id: user.id, tag: user.tag, bot: user.bot }));
  const mentionedChannels = [...message.mentions.channels.values()]
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }));
  const recentAttachmentCount = recent.reduce((count, item) => count + (item.attachments?.size ?? 0), 0);
  const transcriptAttachmentCount = transcriptMessages
    .slice(-30)
    .filter((item) => /\[adjunto:|\[attachment:|pruebas visuales|analisis visual|captura|imagen|video/i.test(String(item.content ?? '')))
    .length;
  const allText = [
    message.content,
    ...recent.map((item) => item.content ?? ''),
    ...transcriptMessages.slice(-20).map((item) => item.content ?? '')
  ].join('\n');
  const normalized = normalizeText(allText);
  const signals = [];
  if (recentAttachmentCount || transcriptAttachmentCount) signals.push('visual_or_file_evidence');
  if (/\b(?:raid|raidead|nuke|flood|spam masivo|mass spam|webhook spam|canales borrados|roles borrados)\b/.test(normalized)) {
    signals.push('active_raid_or_mass_spam');
  }
  if (/\b(?:scam|estafa|phishing|token|malware|nitro gratis|robo|dox|doxing|amenaza|acoso|chantaje|extorsion)\b/.test(normalized)) {
    signals.push('serious_report_keyword');
  }
  if (mentionedUsers.length) signals.push('explicit_target_user_mentioned');
  if (mentionedChannels.length) signals.push('explicit_target_channel_mentioned');

  return {
    currentChannel: {
      id: message.channelId,
      name: message.channel?.name,
      type: message.channel?.type,
      ticketStatus: ticket?.status ?? 'open'
    },
    requester: {
      id: message.author.id,
      tag: message.author.tag,
      isStaff: requesterIsStaff,
      manageGuild: Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)),
      manageChannels: Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageChannels)),
      banMembers: Boolean(message.member?.permissions?.has(PermissionFlagsBits.BanMembers))
    },
    botPermissions: {
      manageChannels: Boolean(message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)),
      manageRoles: Boolean(message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)),
      banMembers: Boolean(message.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)),
      moderateMembers: Boolean(message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers))
    },
    ticket: {
      openedBy: ticket?.openedBy ?? null,
      categoryId: ticket?.categoryId ?? null,
      voiceChannelId: ticket?.voiceChannelId ?? null
    },
    mentionedUsers,
    mentionedChannels,
    rawIdsInMessage: extractRawIds(message.content),
    proof: {
      currentMessageAttachments: message.attachments?.size ?? 0,
      recentAttachmentCount,
      transcriptAttachmentCount,
      hasEvidence: Boolean(recentAttachmentCount || transcriptAttachmentCount),
      signals
    },
    recentTranscript: transcriptMessages
      .slice(-12)
      .map((item) => `${item.authorName || item.role}: ${String(item.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}`),
    recentDiscord: recent
      .map((item) => `${item.author?.tag ?? item.author?.id}: ${String(item.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}${item.attachments?.size ? ` [${item.attachments.size} adjunto(s)]` : ''}`)
  };
}

function shouldConsiderAutonomousActionRequest(message) {
  const text = normalizeText(message.content);
  if (!text.trim()) return false;
  return [
    /\b(?:voz|voice|chat\s+de\s+voz|sala\s+de\s+voz|hablar\s+por\s+voz)\b/,
    /\b(?:ban|banear|banea|banealo|banearlo|sanciona|sancionar|expulsa|kick)\b/,
    /\b(?:crea|crear|haz|abre|abrir)\b.*\b(?:canal|channel)\b/,
    /\b(?:borra|borrar|elimina|eliminar|delete)\b.*\b(?:canal|channel)\b/,
    /\b(?:bloquea|bloquear|lockdown|cierra)\b.*\b(?:canal|chat)\b/,
    /\b(?:raid|raidead|nuke|flood|spam\s+masivo|estafa|phishing|malware|token|acoso|amenaza)\b/
  ].some((pattern) => pattern.test(text));
}

function isVoiceConversationRequest(content = '') {
  const text = normalizeText(content);
  return [
    /\b(?:podemos|puedo|podrias|puedes|quiero|mejor|prefiero|vamos)\b.*\b(?:hablar|atender|seguir|continuar)\b.*\b(?:voz|voice|vc)\b/,
    /\b(?:chat\s+de\s+voz|sala\s+de\s+voz|canal\s+de\s+voz|soporte\s+por\s+voz|ticket\s+por\s+voz)\b/,
    /\b(?:crea|abre|monta|haz)\b.*\b(?:voz|voice|vc)\b/
  ].some((pattern) => pattern.test(text));
}

function isActiveVoiceTicketMessage(voiceManager, message) {
  const session = voiceManager?.getSession?.(message.guildId);
  return Boolean(session && !session.stopped && session.ticketChannelId === message.channelId);
}

function buildMessageInteractionContext(message) {
  return {
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    client: message.client,
    user: message.author,
    options: {
      getString: () => null
    }
  };
}

function canManageVoiceSupportFromMessage(message, ticket, guildConfig) {
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(message.member, guildConfig.staffRoleId)) return true;
  if (ticket.openedBy) return ticket.openedBy === message.author.id;
  return true;
}

function canMessageManageChannels(message, guildConfig) {
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (message.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(message.member, guildConfig.staffRoleId)) return true;
  return false;
}

async function validateAutonomousBan({ message, guildConfig, decision, evidence, config }) {
  if (!config.AI_ACTIONS_AUTONOMOUS_BANS) return 'Los bans autonomos estan desactivados por configuracion.';
  if (decision.confidence < config.AI_ACTIONS_BAN_CONFIDENCE) return `Confianza insuficiente (${decision.confidence}/${config.AI_ACTIONS_BAN_CONFIDENCE}).`;
  if (!['strong', 'critical'].includes(decision.evidenceLevel)) return 'No hay evidencia fuerte o critica para banear sin revision.';
  if (!decision.targetUserId) return 'No hay usuario objetivo claro.';
  if (!isExplicitUserTarget(message, decision.targetUserId)) return 'El usuario objetivo no aparece mencionado o indicado claramente en el mensaje.';
  if (!hasConcreteModerationEvidence(evidence, decision)) return 'No hay prueba visual, adjunto o senal suficiente guardada para ejecutar ban automatico.';
  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) return 'Me falta Ban Members para aplicar el ban.';
  if (decision.targetUserId === message.author.id) return 'No aplico bans automaticos contra quien abre la solicitud.';
  if (decision.targetUserId === message.client.user?.id) return 'No puedo sancionarme a mi mismo.';
  if (decision.targetUserId === message.guild.ownerId) return 'No aplico acciones automaticas contra el owner del servidor.';

  const targetMember = await message.guild.members.fetch(decision.targetUserId).catch(() => null);
  if (!targetMember) return 'No pude obtener el miembro objetivo en este servidor.';
  if (targetMember.user?.bot) return 'Los bots sospechosos los gestiona Security Guard; este ticket queda para revision del staff.';
  if (targetMember.permissions?.has(PermissionFlagsBits.ManageGuild) || targetMember.permissions?.has(PermissionFlagsBits.Administrator)) {
    return 'No aplico bans automaticos contra admins o usuarios con Manage Server.';
  }
  if (guildConfig?.staffRoleId && memberHasRole(targetMember, guildConfig.staffRoleId)) {
    return 'No aplico bans automaticos contra miembros del staff configurado.';
  }
  if (!targetMember.bannable) return 'No puedo banear a ese usuario por jerarquia o permisos.';

  return '';
}

function isExplicitUserTarget(message, targetUserId) {
  if (message.mentions.users.has(targetUserId)) return true;
  const rawIds = extractRawIds(message.content);
  return rawIds.includes(targetUserId);
}

function hasConcreteModerationEvidence(evidence, decision) {
  if (evidence?.proof?.hasEvidence) return true;
  if (evidence?.proof?.signals?.includes('active_raid_or_mass_spam') && decision.evidenceLevel === 'critical') return true;
  return Array.isArray(decision.proofSummary) && decision.proofSummary.length >= 2 && decision.evidenceLevel === 'critical';
}

async function respondActionNeedsStaff({ storage, message, guildConfig, decision, reason }) {
  const reply = await sendTicketResponse(message, {
    content: [
      'No ejecuto esa accion automaticamente con la informacion actual.',
      reason,
      'Si procede, que un staff lo confirme y lo puedo dejar preparado.'
    ].join('\n').slice(0, 1900),
    allowedMentions: { parse: [] }
  });
  await saveTranscript(storage, reply, 'assistant');
  await logAutonomousAction(storage, message, {
    decision,
    executed: false,
    reason,
    severity: 'warning',
    title: 'Accion IA bloqueada por seguridad'
  });
  return { handled: true };
}

async function logAutonomousAction(storage, message, { decision, executed, reason, severity = 'info', title = 'Accion IA' }) {
  await storage.addGuildLog({
    guildId: message.guildId,
    guildName: message.guild?.name,
    type: 'ticket',
    severity,
    title,
    message: reason,
    actorId: message.author?.id,
    actorName: message.author?.tag ?? message.author?.username,
    targetId: decision?.targetUserId ?? decision?.targetChannelId ?? null,
    targetName: decision?.channelName ?? null,
    channelId: message.channelId,
    channelName: message.channel?.name,
    metadata: {
      executed,
      action: decision?.action,
      confidence: decision?.confidence,
      evidenceLevel: decision?.evidenceLevel,
      proofSummary: decision?.proofSummary ?? [],
      aiReason: decision?.reason ?? ''
    }
  }).catch((error) => {
    console.warn(`Could not persist autonomous action log in ${message.guildId}:`, error?.message ?? error);
  });
}

function extractMentionedChannelIds(message) {
  return [...message.mentions.channels.keys()];
}

function extractRawIds(content = '') {
  return [...String(content).matchAll(/\b\d{16,24}\b/g)].map((match) => match[0]);
}

function mentionsCurrentChannelDeletion(content = '') {
  const text = normalizeText(content);
  return /\b(?:este|actual|ticket)\b.*\b(?:canal|channel|ticket)\b/.test(text)
    || /\b(?:borra|elimina|delete|cierra)\s+(?:este\s+)?ticket\b/.test(text);
}

function inferChannelNameFromText(content = '') {
  const raw = String(content ?? '');
  return raw.match(/(?:canal|channel)\s+(?:llamado|llamada|nombre|#)?\s*["'`#]?([a-zA-Z0-9_\-\s]{3,40})/i)?.[1]
    ?? raw.match(/["'`]([a-zA-Z0-9_\-\s]{3,40})["'`]/)?.[1]
    ?? '';
}

function sanitizeAutonomousChannelName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function resolveAutonomousChannelParentId(message, guildConfig) {
  const candidates = [guildConfig?.ticketCategoryId, guildConfig?.voiceCategoryId].filter(Boolean);
  for (const id of candidates) {
    const channel = await message.guild.channels.fetch(id).catch(() => null);
    if (channel?.type === ChannelType.GuildCategory) return channel.id;
  }
  return null;
}

async function handleSendTranscriptCommand({ interaction, storage, config }) {
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
      guildName: interaction.guild.name,
      config
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
    content: `Enlace de transcripcion enviado por MD a ${targetUser.tag}.`,
    createdAt: new Date().toISOString()
  });

  await interaction.editReply(`Enlace de transcripcion enviado por MD a **${targetUser.tag}**.`);
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
    .setTitle(`${EMOJIS.crown} Premium activado`)
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
    .setTitle(`${EMOJIS.crown} NexaDesk Premium`)
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
  if (subcommand === 'codigo' || subcommand === 'nombre') {
    await interaction.deferReply({ ephemeral: true });
    const profile = await storage.getOrCreateAffiliateProfile({
      discordUserId: interaction.user.id,
      username: interaction.user.username,
      rewardThreshold: config.AFFILIATE_REWARD_SERVER_COUNT,
      rewardSlots: config.AFFILIATE_REWARD_SLOTS,
      rewardDays: config.AFFILIATE_REWARD_DAYS
    });
    const progress = buildAffiliateProgress(profile);
    const affiliateName = formatAffiliateIdentifier(profile);
    const embed = new EmbedBuilder()
      .setColor(0xf4c95d)
      .setTitle(`${EMOJIS.global} Tu nombre de afiliado NexaDesk`)
      .setDescription([
        `Tu nombre de afiliado es: **${affiliateName}**`,
        '',
        'Compartelo con owners que vayan a invitar NexaDesk. Cuando el bot entre a su servidor, ellos deben usar:',
        `\`/afiliado server usuario:${affiliateName.replace(/^@/, '')}\``
      ].join('\n'))
      .addFields(
        { name: 'Progreso', value: `${progress.progressInCycle}/${progress.rewardThreshold} servidores en este ciclo (${progress.totalRedemptions} total).`, inline: true },
        { name: 'Recompensa', value: `${profile.rewardSlots} slot Premium durante ${profile.rewardDays} dias cada ${profile.rewardThreshold} servidores.`, inline: true },
        { name: 'Te faltan', value: `${progress.remainingForNextReward || profile.rewardThreshold} servidores para el siguiente slot.`, inline: true }
      )
      .setFooter({ text: 'Cada servidor solo puede registrar un afiliado una vez.' })
      .setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (subcommand === 'server') {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Este comando debe usarse dentro del servidor que quiere registrar el afiliado.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Necesitas Manage Server para registrar un afiliado en este servidor.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const code = normalizeAffiliateCode(interaction.options.getString('usuario') ?? interaction.options.getString('codigo', true));
    const result = await storage.recordAffiliateRedemption({
      code,
      guildId: interaction.guildId,
      guildName: interaction.guild?.name ?? `Servidor ${interaction.guildId}`,
      redeemedByUserId: interaction.user.id,
      redeemedByUsername: interaction.user.tag ?? interaction.user.username,
      rewardThreshold: config.AFFILIATE_REWARD_SERVER_COUNT,
      rewardSlots: config.AFFILIATE_REWARD_SLOTS,
      rewardDays: config.AFFILIATE_REWARD_DAYS
    }).catch(async (error) => {
      const message = String(error?.message ?? error);
      if (/Codigo de afiliado no encontrado|Usuario de afiliado no encontrado/i.test(message)) {
        await interaction.editReply([
          `${EMOJIS.wifi} No encuentro ese usuario de afiliado.`,
          'Dile a tu amigo que ejecute `/afiliado nombre` primero y vuelve a intentarlo con su username de Discord.'
        ].join('\n'));
        return null;
      }
      if (/propio usuario/i.test(message)) {
        await interaction.editReply('No puedes registrar tu propio usuario como afiliado en este servidor. Pide a otro owner que use tu username en su servidor.');
        return null;
      }
      throw error;
    });
    if (!result) return;

    if (result.alreadyRedeemed) {
      const redemption = normalizeAffiliateRedemption(result.redemption);
      const registeredProfile = result.profile ? formatAffiliateIdentifier(result.profile) : `@${redemption.code.toLowerCase()}`;
      await interaction.editReply([
        `${EMOJIS.wifi} Este servidor ya tiene un afiliado registrado.`,
        `Afiliado usado: **${registeredProfile}**`,
        'Por seguridad y para evitar abuso, no se puede cambiar desde Discord.'
      ].join('\n'));
      return;
    }

    const profile = normalizeAffiliateProfile(result.profile);
    const progress = buildAffiliateProgress(profile);
    const affiliateName = formatAffiliateIdentifier(profile);
    await notifyAffiliateOwner({ client, profile, guildName: interaction.guild?.name ?? interaction.guildId, rewardPurchase: result.rewardPurchase }).catch((error) => {
      console.warn(`Could not notify affiliate owner ${profile.discordUserId}:`, error?.message ?? error);
    });

    const embed = new EmbedBuilder()
      .setColor(0xf4c95d)
      .setTitle(`${EMOJIS.check} Afiliado registrado`)
      .setDescription([
        `Servidor registrado correctamente con el afiliado **${affiliateName}**.`,
        '',
        `El afiliado recibio un aviso por MD. Le faltan **${progress.remainingForNextReward || profile.rewardThreshold} servidores** para su siguiente recompensa.`
      ].join('\n'))
      .addFields(
        { name: 'Servidor', value: interaction.guild?.name ?? interaction.guildId, inline: true },
        { name: 'Progreso', value: `${progress.progressInCycle}/${progress.rewardThreshold} en este ciclo (${progress.totalRedemptions} total).`, inline: true },
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
  const affiliateName = formatAffiliateIdentifier(profile);
  const lines = [
    `${EMOJIS.global} **ALGUIEN HA REGISTRADO TU USUARIO DE AFILIADO**`,
    '',
    `Tu usuario **${affiliateName}** ha sido registrado en **${guildName}**.`,
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

async function handleMessageOwnerCommand({ interaction, storage, client }) {
  if (interaction.user.id !== PREMIUM_ADMIN_USER_ID) {
    await interaction.reply({
      content: 'Este comando solo puede usarlo el owner autorizado de NexaDesk.',
      ephemeral: true
    });
    return;
  }

  const guildId = (interaction.options.getString('serverid') ?? interaction.options.getString('servidor') ?? '').trim();
  const customMessage = (interaction.options.getString('message') ?? interaction.options.getString('mensaje') ?? '').trim().slice(0, 1800);
  if (!/^\d{17,20}$/.test(guildId)) {
    await interaction.reply({ content: 'Pon un ID de servidor valido.', ephemeral: true });
    return;
  }
  if (!customMessage) {
    await interaction.reply({ content: 'Pon el mensaje que quieres enviar al owner/instalador.', ephemeral: true });
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

  const embed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`${EMOJIS.nexalogo} Mensaje importante de NexaDesk`)
    .setDescription(customMessage)
    .addFields(
      { name: 'Servidor', value: `${guild.name} (${guild.id})`, inline: false },
      { name: 'Enviado por', value: `${interaction.user.tag ?? interaction.user.username} (${interaction.user.id})`, inline: false }
    )
    .setFooter({ text: 'NexaDesk Owner Message' })
    .setTimestamp(new Date());

  const results = [];
  for (const { user, label } of targets.values()) {
    await user.send({ embeds: [embed] })
      .then(() => results.push(`${label}: enviado a ${user.tag ?? user.username}`))
      .catch((error) => results.push(`${label}: fallo (${error?.code ?? error?.message ?? 'DM cerrado'})`));
  }

  await storage.addGuildLog?.({
    guildId: guild.id,
    guildName: guild.name,
    type: 'owner_message',
    severity: results.some((line) => line.includes('fallo')) ? 'warning' : 'success',
    title: 'MD personalizado enviado a owner/instalador',
    message: customMessage,
    actorId: interaction.user.id,
    actorName: interaction.user.tag ?? interaction.user.username,
    metadata: { results }
  }).catch((error) => console.warn(`Could not persist owner message log for ${guild.id}:`, error?.message ?? error));

  await interaction.editReply([
    `${EMOJIS.check} Mensaje procesado para **${guild.name}**.`,
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

  await interaction.deferReply({ ephemeral: true });

  let issued;
  try {
    issued = await requestAdminCodeFromDashboard({ interaction, config });
  } catch (error) {
    await interaction.editReply([
      `${EMOJIS.ban} No pude pedir el codigo a la web de NexaDesk.`,
      `Motivo: ${String(error?.message ?? error).slice(0, 500)}`,
      `Ruta admin: ${new URL('/admin', config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL).toString()}`,
      'Mientras la web no emita el codigo, no genero codigos locales para evitar errores de expirado entre la Pi y el dashboard local.'
    ].join('\n'));
    return;
  }

  const expiresAt = Math.round(Date.parse(issued.expiresAt) / 1000);
  await interaction.editReply({
    content: [
      `${EMOJIS.check} ${issued.reused ? 'Codigo activo' : 'Codigo nuevo'} emitido por la web para **/admin**: \`${issued.code}\``,
      `Caduca <t:${expiresAt}:R> y se invalida al primer uso correcto.`,
      `Ruta: ${issued.adminUrl || new URL('/admin', config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL).toString()}`,
      issued.reused
        ? 'La web me ha devuelto el mismo codigo activo para no invalidarte el anterior.'
        : 'Si lo pides otra vez antes de usarlo, la web te devolvera este mismo codigo mientras siga activo.'
    ].join('\n'),
    ephemeral: true
  });
}

async function requestAdminCodeFromDashboard({ interaction, config }) {
  const baseUrl = String(config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL).replace(/\/+$/, '');
  const endpoint = new URL('/internal/admin/code', baseUrl);
  const token = String(config.ADMIN_CODE_SECRET || config.DISCORD_TOKEN || '').trim();
  if (!token) {
    throw new Error('Falta token interno para pedir codigos admin.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-nexadesk-admin-code-secret': token,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      createdBy: interaction.user.id,
      createdByTag: interaction.user.tag ?? interaction.user.username,
      guildId: interaction.guildId,
      requestedFrom: 'discord-command'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.code) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
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
    .setTitle(`${EMOJIS.gear} Modo mantenimiento NexaDesk`)
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
      security: normalizeSecurityConfig({
        ...current,
        enabled: false,
        disabledAt: new Date().toISOString(),
        disabledBy: interaction.user.id
      })
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
    .setTitle(`${EMOJIS.siren} Security Guard`)
    .setDescription(`Estado de seguridad para **${guild?.name ?? 'este servidor'}**.`)
    .addFields(
      { name: `${EMOJIS.check} Estado`, value: config.enabled ? 'Activo' : 'Desactivado', inline: true },
      { name: `${EMOJIS.server} Nivel`, value: level.label, inline: true },
      { name: `${EMOJIS.gear} Resumen`, value: summarizeSecurityConfig(config) },
      {
        name: `${EMOJIS.rightArrow} Modulos`,
        value: [
          `Anti-flood: **${config.antiFlood ? 'on' : 'off'}** (${config.floodLimit} mensajes/${config.floodWindowSeconds}s)`,
          `Anti-links IA: **${config.antiScamLinks ? 'on' : 'off'}**`,
          `XN Protect Automod: **${config.antiOffensive ? 'on' : 'off'}**`,
          `Anti-bots Top.gg: **${config.antiBot ? 'on' : 'off'}**`,
          `Anti-alts: **${config.antiAlt ? 'on' : 'off'}** (${config.minAccountAgeDays} dias)`,
          `Anti-nuke: **${config.antiNuke ? 'on' : 'off'}** (${config.nukeLimit} acciones/${config.nukeWindowSeconds}s)`,
          `Canales/config/webhooks: **${config.antiNuke ? 'vigilado' : 'off'}** (bots personales, apps externas, permisos y cambios del servidor)`
        ].join('\n')
      },
      { name: `${EMOJIS.logs} Logs`, value: config.logChannelId ? `<#${config.logChannelId}>` : 'Sin canal de logs. Se avisara al owner por MD cuando sea importante.', inline: true },
      { name: `${EMOJIS.ban} Permisos recomendados`, value: 'View Audit Log, Manage Channels, Manage Webhooks, Manage Roles, Manage Messages, Moderate Members, Kick Members y Ban Members.' }
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
    console.warn(`External ticket ${channel.id} detected, but opener could not be resolved for XN Protect check.`);
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

async function handleReleaseNotesCommand({ interaction, storage, config }) {
  const settings = await storage.getGlobalSettings().catch(() => ({}));
  const isOwner = interaction.user.id === PREMIUM_ADMIN_USER_ID;
  const releaseState = buildReleaseState(settings.releaseControl, { isOwner });
  const feature = releaseState.features.find((item) => item.id === 'v15-release-notes');
  const isReleased = Boolean(feature?.released);

  await interaction.reply({
    embeds: [buildV15ReleaseEmbed({ config, guild: interaction.guild, isReleased })],
    components: buildV15ReleaseComponents({ config }),
    ephemeral: !isReleased
  });
}

function buildV15ReleaseEmbed({ config, guild, isReleased }) {
  const guildLabel = guild?.name ? ` en ${guild.name}` : '';
  return new EmbedBuilder()
    .setColor(isReleased ? 0xffffff : 0xf4c95d)
    .setTitle(`${EMOJIS.nexalogo} NexaDesk V1.5`)
    .setDescription([
      `La capa de IA para cualquier sistema de tickets${guildLabel}.`,
      'No cambies tu bot de tickets: haz que responda mejor, escale mejor y convierta soporte en confianza.'
    ].join('\n'))
    .addFields(
      {
        name: `${EMOJIS.global} Lo que hay que enseñar en el video`,
        value: [
          'Dashboard con control center, logs, status, premium y asistente IA.',
          'Tickets compatibles con paneles propios, Ticket King, XN Tickets y flujos externos.',
          'Release Control: el owner decide cuando una funcion pasa de beta privada a publica.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.wifi} IA mas util`,
        value: [
          'Usa contexto del servidor, preguntas previas, imagenes, voz y transcripciones.',
          'Evita inventar cuando no tiene datos y sabe pedir staff cuando toca.',
          'Modo examen para postulaciones con correccion provisional y revision humana.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.ban} Seguridad y confianza`,
        value: [
          'Security Guard contra flood, links sospechosos, automod XN Protect y anti-nuke.',
          'Avisos de blacklist global sin banear automaticamente al usuario.',
          'Logs por servidor para que el owner vea que paso y por que.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.check} Premium y crecimiento`,
        value: [
          'Voz Pro, SLA Radar, Team Assist, Growth Engine, afiliados y reviews.',
          '3 servidores Premium por 3€, activables desde la dashboard.',
          'Herramientas pensadas para que el soporte ayude a crecer el servidor.'
        ].join('\n')
      },
      {
        name: `${EMOJIS.rightArrow} Estado`,
        value: isReleased
          ? 'V1.5 publicada para todos.'
          : 'Preview privada. Cuando este lista, publicala desde `/owner` con Lanzar actualizacion.'
      }
    )
    .setFooter({ text: 'NexaDesk V1.5 - soporte inteligente, humano cuando importa.' })
    .setTimestamp(new Date());
}

function buildV15ReleaseComponents({ config }) {
  const dashboardBase = config.DASHBOARD_PUBLIC_URL || PUBLIC_DASHBOARD_URL;
  const dashboardUrl = new URL('/', dashboardBase).toString();
  const premiumUrl = new URL('/#premium', dashboardBase).toString();
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Abrir dashboard')
        .setStyle(ButtonStyle.Link)
        .setURL(dashboardUrl),
      new ButtonBuilder()
        .setLabel('Premium')
        .setStyle(ButtonStyle.Link)
        .setURL(premiumUrl),
      new ButtonBuilder()
        .setLabel('Soporte')
        .setStyle(ButtonStyle.Link)
        .setURL(SUPPORT_SERVER_URL)
    )
  ];
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
      .setTitle(`${EMOJIS.gear} Como configuro el servidor?`)
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
          value: [
            'No tienes que cambiar de sistema. NexaDesk actua como capa IA encima de tu bot actual.',
            'Compatible con Ticket King, XN Tickets, Guild Manager y canales creados en categorias configuradas.',
            'Si el canal trae mensaje inicial del bot externo, NexaDesk detecta opener, saluda una sola vez y atiende hasta que entre staff.'
          ].join('\n')
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
          value: 'En PostgreSQL, para que la dashboard pueda mostrar historial, estadisticas y transcripciones por servidor.'
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
      .setTitle(`${EMOJIS.crown} Premium de NexaDesk`)
      .setDescription(`Premium esta pensado para servidores que quieren soporte mas rapido, mas humano y mas facil de vender como experiencia profesional. Pack actual: **${checkout.slots} servidores por ${checkout.displayPrice}**.`)
      .addFields(
        {
          name: `${EMOJIS.nexalogo} Funciones incluidas`,
          value: [
            'Compatibilidad Pro con Ticket King, XN Tickets, Guild Manager y paneles propios sin migracion obligatoria.',
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
      .setTitle(`${EMOJIS.siren} Seguridad del servidor`)
      .setDescription('NexaDesk Security Guard protege el servidor sin sustituir tu sistema de tickets. Actua como capa preventiva alrededor del soporte.')
      .addFields(
        {
          name: `${EMOJIS.ban} Que protege`,
          value: [
            'Anti-flood: borra spam rapido y puede aplicar timeout.',
            'Anti-links e imagenes IA: revisa enlaces con IA y adjuntos visuales con XN Protect Antiscam para bloquear phishing, estafas, malware y regalos falsos.',
            'XN Protect Automod: borra contenido ofensivo/malicioso y avisa al staff con motivo, categoria, score y palabras detectadas cuando la API lo devuelve.',
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
          `${EMOJIS.gear} Como configuro el servidor?`,
          `${EMOJIS.siren} Seguridad del servidor`,
          `${EMOJIS.global} Crecimiento y reviews`,
          `${EMOJIS.crown} Premium`,
          `${EMOJIS.logs} Datos y transcripciones`,
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
  if (isExamTicketMode(ticketMode)) {
    const pendingExamFeature = await getPendingReleaseFeature({
      storage,
      featureId: 'v15-web-exam-mode',
      userId: interaction.user?.id
    });
    if (pendingExamFeature) {
      await interaction.reply({
        content: [
          `${EMOJIS.gear} **Estamos trabajando en esta parte.**`,
          `**${pendingExamFeature.title}** sigue en pruebas internas de NexaDesk.`,
          'Cuando el owner global lance la 1.5 desde `/owner`, los tickets de examen quedaran disponibles para todos.'
        ].join('\n'),
        ephemeral: true
      });
      return;
    }
  }
  const canUsePremiumExamReview = isExamTicketMode(ticketMode)
    && isPremiumEntitled(guildConfig)
    && examConfig?.reviewEnabled
    && Boolean(examConfig?.formUrl || examConfig?.questions?.length);
  if (isExamTicketMode(ticketMode) && !canUsePremiumExamReview && !examConfig?.questions?.length) {
    await interaction.reply({
      content: [
        `${EMOJIS.ticket} Este panel esta en Modo examen, pero no tiene preguntas ni formulario configurado.`,
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
    openedBy: interaction.user.id,
    ...(ticketMode === 'staff' ? {
      status: 'ai_disabled',
      aiDisabled: true,
      aiDisabledBy: STAFF_ONLY_COMPONENT_MARKER,
      aiDisabledAt: new Date().toISOString()
    } : {})
  });

  if (ticket.alreadyExists) {
    await replyOrEditEphemeral(interaction, { content: `Ticket creado: ${channel}` });
    return;
  }

  const welcomePayload = ticketMode === 'staff' ? {
    content: buildStaffOnlyTicketWelcomeMessage({
      answers,
      userMention: `${interaction.user}`,
      guildConfig,
      serverName: interaction.guild.name,
      channelName: channel.name
    }),
    allowedMentions: {
      users: [interaction.user.id],
      roles: guildConfig?.staffRoleId ? [guildConfig.staffRoleId] : []
    }
  } : buildTicketWelcomeMessage({
    panel: normalizedPanel,
    component: normalizedComponent,
    answers,
    userMention: `${interaction.user}`,
    username: interaction.user.username,
    serverName: interaction.guild.name,
    channelName: channel.name
  });
  const welcome = await channel.send(welcomePayload);
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
          `${EMOJIS.wifi} No pude vincular la sala de voz porque PostgreSQL no tiene las columnas Pro Voice aplicadas.`,
          'Revisa que el esquema de PostgreSQL esté actualizado y vuelve a publicar o crear el ticket.'
        ].join('\n'));
        await saveTranscript(storage, voiceNotice, 'assistant');
        voiceStatus.push('Sala de voz pendiente: falta migracion de PostgreSQL.');
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
  const formToken = crypto.randomUUID().replaceAll('-', '');
  const internalFormUrl = examConfig.questions.length ? buildInternalExamFormUrl(config, ticket.channelId, formToken) : '';
  const formUrl = examConfig.formUrl || internalFormUrl;
  const reviewEnabled = premium && examConfig.reviewEnabled && Boolean(formUrl);
  const now = new Date().toISOString();
  const state = normalizeExamState({
    enabled: true,
    mode: reviewEnabled ? 'premium_review' : 'free_questions',
    status: reviewEnabled ? 'awaiting_screen_share' : 'questioning',
    questions: examConfig.questions,
    currentIndex: 0,
    answers: [],
    formUrl,
    formToken,
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
          .setTitle(`${EMOJIS.crown} Modo examen con revision Premium`)
          .setDescription([
            `${interaction.user}, he preparado el examen supervisado.`,
            `Formulario: ${formUrl}`,
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
        .setTitle(`${EMOJIS.ticket} Modo examen`)
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

function buildInternalExamFormUrl(config, channelId, token) {
  const base = getPublicDashboardBaseUrl(config);
  return `${base}/exam/${encodeURIComponent(channelId)}?token=${encodeURIComponent(token)}`;
}

function getPublicDashboardBaseUrl(config) {
  const configured = String(config.DASHBOARD_PUBLIC_URL || '').trim();
  try {
    const url = new URL(configured || PUBLIC_DASHBOARD_URL);
    const host = url.hostname.toLowerCase();
    const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(host);
    const isPrivateLan = /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isLocalHost || isPrivateLan) return PUBLIC_DASHBOARD_URL.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return PUBLIC_DASHBOARD_URL.replace(/\/+$/, '');
  }
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

async function sendExternalTicketWelcomeOnce({ storage, message, guildConfig, ticketWelcomeChannels, sourceName = 'un bot externo de tickets' }) {
  if (ticketWelcomeChannels.has(message.channel.id)) return null;
  ticketWelcomeChannels.add(message.channel.id);

  const transcript = await storage.listTranscriptMessages(message.channel.id).catch(() => []);
  if (transcript.some((item) => isExternalTicketWelcomeContent(item.content))) return null;

  const welcome = await message.channel.send([
    `${EMOJIS.nexalogo} Hola, soy **NexaDesk**.`,
    `He detectado este ticket de ${sourceName} y voy a ayudarte aqui sin que tengas que cambiar de sistema. Cuentame que necesitas y, si hace falta, avisare al staff con un resumen claro.`
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
        .setTitle(`${EMOJIS.gear} Modo mantenimiento activo`)
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

async function processScheduledAnnouncements({ client, storage }) {
  const guildConfigs = await storage.listGuildConfigs().catch((error) => {
    console.error('Could not load guild configs for scheduled announcements:', compactRuntimeError(error));
    return [];
  });
  const now = Date.now();

  for (const guildConfig of guildConfigs) {
    const announcements = Array.isArray(guildConfig.scheduledAnnouncements) ? guildConfig.scheduledAnnouncements : [];
    if (!announcements.length) continue;
    const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {});
    const isPremium = isPremiumEntitled(guildConfig ?? {});
    if (!isPremium || premium.scheduledAnnouncements === false) {
      if (shouldLogScheduledAnnouncementStatus(`${guildConfig.guildId}:premium`, now)) {
        console.warn(`Scheduled announcements skipped for ${guildConfig.guildName ?? guildConfig.guildId}: premium required or module disabled.`);
      }
      continue;
    }

    let changed = false;
    const nextAnnouncements = [];
    for (const announcement of announcements) {
      const dueAt = Date.parse(announcement.nextRunAt ?? '');
      if (announcement.enabled === false || dueAt > now) {
        nextAnnouncements.push(announcement);
        continue;
      }
      if (!Number.isFinite(dueAt)) {
        if (shouldLogScheduledAnnouncementStatus(`${guildConfig.guildId}:${announcement.id}:invalid-date`, now)) {
          console.warn(`Scheduled announcement ${announcement.id} in ${guildConfig.guildName ?? guildConfig.guildId} has an invalid nextRunAt value.`);
        }
        changed = true;
        nextAnnouncements.push({
          ...announcement,
          nextRunAt: new Date(now + 5 * 60_000).toISOString(),
          updatedAt: new Date().toISOString()
        });
        continue;
      }

      const sent = await sendScheduledAnnouncement({ client, guildConfig, announcement }).catch((error) => {
        console.error(`Scheduled announcement ${announcement.id} failed in ${guildConfig.guildId}:`, compactRuntimeError(error));
        return false;
      });
      const nextRunAt = sent
        ? computeNextAnnouncementRun(announcement, now)
        : new Date(now + 5 * 60_000).toISOString();
      changed = true;
      nextAnnouncements.push({
        ...announcement,
        enabled: announcement.scheduleType === 'once' ? false : announcement.enabled !== false,
        lastRunAt: sent ? new Date(now).toISOString() : announcement.lastRunAt ?? null,
        nextRunAt,
        runCount: Number(announcement.runCount ?? 0) + (sent ? 1 : 0),
        updatedAt: new Date().toISOString()
      });
    }

    if (changed) {
      await storage.upsertGuildConfig(guildConfig.guildId, {
        scheduledAnnouncements: nextAnnouncements
      }).catch((error) => {
        console.error(`Could not persist scheduled announcement state for ${guildConfig.guildId}:`, compactRuntimeError(error));
      });
    }
  }
}

async function sendScheduledAnnouncement({ client, guildConfig, announcement }) {
  if (!announcement.channelId) {
    console.warn(`Scheduled announcement ${announcement.id} skipped in ${guildConfig.guildName ?? guildConfig.guildId}: no target channel configured.`);
    return false;
  }
  const guild = client.guilds.cache.get(guildConfig.guildId)
    ?? await client.guilds.fetch(guildConfig.guildId).catch(() => null);
  if (!guild) {
    console.warn(`Scheduled announcement ${announcement.id} skipped: guild ${guildConfig.guildId} is not available to the bot.`);
    return false;
  }
  const channel = guild.channels.cache.get(announcement.channelId)
    ?? await guild.channels.fetch(announcement.channelId).catch(() => null);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    console.warn(`Scheduled announcement ${announcement.id} skipped in ${guild.name}: target channel ${announcement.channelId} is missing or not a text channel.`);
    return false;
  }

  const embed = new EmbedBuilder()
    .setColor(parseEmbedColor(announcement.embed?.color))
    .setTitle(String(announcement.embed?.title || announcement.name || 'Anuncio').slice(0, 256))
    .setDescription(String(announcement.embed?.description || '').slice(0, 4096))
    .setTimestamp(new Date());
  if (announcement.embed?.imageUrl) embed.setImage(announcement.embed.imageUrl);
  if (announcement.embed?.footerText) embed.setFooter({ text: String(announcement.embed.footerText).slice(0, 200) });

  await channel.send({
    content: announcement.content ? String(announcement.content).slice(0, 1800) : undefined,
    embeds: [embed],
    allowedMentions: { parse: ['users', 'roles', 'everyone'] }
  });
  console.log(`Scheduled announcement ${announcement.id} delivered in ${guild.name} / #${channel.name}.`);
  return true;
}

function computeNextAnnouncementRun(announcement, fallbackMs = Date.now()) {
  if (announcement.scheduleType === 'once') return new Date(fallbackMs).toISOString();
  const intervalHours = Math.max(1, Math.min(24 * 30, Number(announcement.intervalHours ?? 24) || 24));
  return new Date(fallbackMs + intervalHours * 60 * 60 * 1000).toISOString();
}

function parseEmbedColor(value = '#ffffff') {
  const hex = String(value || '#ffffff').replace('#', '').trim();
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(0xffffff, parsed)) : 0xffffff;
}

function shouldLogScheduledAnnouncementStatus(key, now = Date.now()) {
  const previous = scheduledAnnouncementStatusLogCache.get(key) ?? 0;
  if (now - previous < SCHEDULED_ANNOUNCEMENT_STATUS_LOG_MS) return false;
  scheduledAnnouncementStatusLogCache.set(key, now);
  return true;
}

function isExternalTicketWelcomeContent(content) {
  return /he\s+detectado\s+este\s+ticket\s+de\s+[\s\S]{1,120}?voy\s+a\s+ayudarte\s+aqui/i.test(String(content ?? ''));
}

function isConfiguredTicketCategory(channel, guildConfig) {
  return Boolean(channel && getWatchedTicketCategoryIds(guildConfig).includes(channel.parentId));
}

function getWatchedTicketCategoryIds(guildConfig) {
  const ids = [
    guildConfig?.ticketCategoryId,
    ...(Array.isArray(guildConfig?.watchedTicketCategories)
      ? guildConfig.watchedTicketCategories.map((item) => item?.id ?? item)
      : [])
  ]
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  const premium = isPremiumEntitled(guildConfig ?? {})
    && normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {}).multiCategoryWatch !== false;
  return unique.slice(0, premium ? 2 : 1);
}

async function detectExternalTicketSource(message) {
  if (isExternalTicketSeedMessage(message)) {
    return identifyExternalTicketSource(message) ?? { id: 'external_ticket_bot', name: 'un bot externo de tickets' };
  }

  if (message.author.bot) return null;
  return findRecentExternalTicketSource(message.channel);
}

function isExternalTicketChannel(channel) {
  const name = normalizeText(channel?.name ?? '');
  return /^(ticket|soporte|support|ayuda|reporte|report|claim|consulta)(?:-|_|\s|$)/i.test(name)
    || /^ticket-\d+$/i.test(channel?.name ?? '');
}

function isNumberedTicketChannel(channel) {
  return /^ticket-\d+$/i.test(channel?.name ?? '');
}

function isExternalTicketSeedMessage(message) {
  return isExternalTicketChannel(message.channel)
    && message.author?.bot
    && message.author.id !== message.client?.user?.id
    && looksLikeExternalTicketSeedMessage(message);
}

async function findRecentExternalTicketSource(channel) {
  if (!isExternalTicketChannel(channel)) return null;
  try {
    const messages = await channel.messages.fetch({ limit: 25 });
    const seed = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .find(isExternalTicketSeedMessage);
    return seed ? identifyExternalTicketSource(seed) ?? { id: 'external_ticket_bot', name: 'un bot externo de tickets' } : null;
  } catch {
    return null;
  }
}

async function resolveExternalTicketOpenerId(message) {
  if (isExternalTicketSeedMessage(message)) {
    return extractTicketOpenerIdFromBotMessage(message);
  }

  try {
    const messages = await message.channel.messages.fetch({ limit: 25 });
    const seedMessage = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .find((item) => isExternalTicketSeedMessage(item));
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

function identifyExternalTicketSource(message) {
  const botName = buildBotNameHaystack(message.author);
  const text = normalizeText(buildMessageSearchText(message));

  if (/\bticket\s*king\b/.test(botName) || botName.includes('ticketking') || /\bticket\s*king\b/i.test(text)) {
    return { id: 'ticket_king', name: 'Ticket King' };
  }

  if (/\bxn\s*(?:tickets?|protect)\b/.test(botName) || /\bxn\s*(?:tickets?|protect)\b/i.test(text)) {
    return { id: 'xn_tickets', name: 'XN Tickets' };
  }

  if (/\bguild\s*manager\b/.test(botName) || /\bguild\s*manager\b/i.test(text)) {
    return { id: 'guild_manager', name: 'Guild Manager' };
  }

  if (looksLikeExternalTicketSeedMessage(message)) {
    const cleanName = String(message.author?.username ?? 'bot externo').replace(/[^\p{L}\p{N}\s._-]/gu, '').trim();
    return { id: 'external_ticket_bot', name: cleanName || 'un bot externo de tickets' };
  }

  return null;
}

function looksLikeExternalTicketSeedMessage(message) {
  if (!message?.author?.bot || message.author.id === message.client?.user?.id) return false;
  const text = normalizeText(buildMessageSearchText(message));
  if (!text) return false;
  return [
    /\bticket\s+abierto\b/i,
    /\b(?:ha\s+creado|creo|abierto|opened|created).{0,80}\bticket\b/i,
    /\bticket.{0,80}(?:abierto|creado|opened|created)\b/i,
    /\b(?:cerrar|reclamar|claim|close)\s+ticket\b/i,
    /\b\/close\b/i,
    /\bxn\s*tickets?\b/i,
    /\bticket\s+king\b/i
  ].some((pattern) => pattern.test(text));
}

function buildBotNameHaystack(user) {
  if (!user?.bot) return '';
  return [
    user.username,
    user.globalName,
    user.tag,
    user.displayName
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[-_]/g, ' ');
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

function buildTicketWelcomeMessage({ panel, component, answers = [], userMention, username = 'usuario', serverName = 'este servidor', channelName = 'ticket' }) {
  const rawTemplate = component?.welcomeMessage || panel?.welcomeMessage || '';
  const template = rawTemplate || (component
    ? 'Hola {user}, soy NexaDesk.\nAntes de empezar, he guardado tus respuestas para que el staff tenga contexto.\n{answers}'
    : 'Hola {user}, soy NexaDesk.\nCuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.');
  const answerBlock = buildWelcomeAnswersBlock(answers);
  const shouldAppendLegacyAnswers = answers.length
    && !/\{answers\}/i.test(template)
    && isLegacyComponentWelcomeTemplate(template);
  const baseMessage = formatWelcomeTemplate(template, {
    userMention,
    username,
    serverName,
    channelName,
    answers: answerBlock
  });
  const finalMessage = `${EMOJIS.nexalogo} ${baseMessage}${shouldAppendLegacyAnswers ? `\n${answerBlock}` : ''}`.trim();
  return finalMessage.slice(0, 1950);
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

function formatWelcomeTemplate(template, { userMention, username, serverName, channelName, answers = '' }) {
  return String(template ?? '')
    .replaceAll('{user}', userMention)
    .replaceAll('{username}', username)
    .replaceAll('{server}', serverName)
    .replaceAll('{channel}', channelName)
    .replaceAll('{answers}', answers)
    .replaceAll('{bot}', 'NexaDesk')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildWelcomeAnswersBlock(answers = []) {
  if (!answers.length) return '';
  return [
    '**Respuestas previas:**',
    ...answers.map((item) => `**${item.question}**\n${item.answer}`)
  ].join('\n');
}

function isLegacyComponentWelcomeTemplate(template) {
  const normalized = String(template ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return normalized === 'hola {user}, soy nexadesk. antes de empezar, he guardado tus respuestas para que el staff tenga contexto.';
}

function buildTicketChannelName(username, componentLabel) {
  const prefix = componentLabel ? `ticket-${componentLabel}-${username}` : `ticket-${username}`;
  return prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90);
}

async function handleNaturalCloseRequest({ client, storage, message, ticket, guildConfig, config }) {
  if (!canCloseTicketFromMessage(message, ticket, guildConfig)) {
    const staffOnly = !canTicketOpenerClose(guildConfig);
    const reply = await message.reply({
      content: staffOnly
        ? 'En este servidor los tickets solo puede cerrarlos el staff configurado o alguien con Manage Server.'
        : 'Solo quien abrio este ticket, el staff configurado o alguien con Manage Server puede cerrarlo.',
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
    config,
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

async function handleVoiceTicketCloseRequest({ client, storage, voiceManager, config, session, member, transcript }) {
  const channel = session.textChannel;
  const guild = channel.guild;
  const [storedTicket, storedGuildConfig] = await Promise.all([
    storage.getTicket(channel.id).catch(() => null),
    storage.getGuildConfig(guild.id).catch(() => null)
  ]);
  const ticket = {
    ...(storedTicket ?? session.ticket),
    voiceChannelId: (storedTicket ?? session.ticket)?.voiceChannelId ?? session.voiceChannelId
  };
  const guildConfig = storedGuildConfig ?? session.guildConfig;

  if (!ticket?.channelId) {
    const reply = await channel.send({
      content: 'He entendido que quieres cerrar el ticket, pero este canal no esta registrado como ticket activo. Aviso al staff para que lo revise.',
      allowedMentions: { parse: [] }
    }).catch(() => null);
    if (reply) await saveTranscript(storage, reply, 'assistant');
    return { handled: true };
  }

  if (!canCloseTicketFromVoiceMember(member, ticket, guildConfig)) {
    const staffOnly = !canTicketOpenerClose(guildConfig);
    const reply = await channel.send({
      content: staffOnly
        ? 'He entendido que quieres cerrar el ticket, pero este servidor permite cerrarlo solo al staff configurado o a alguien con Manage Server.'
        : 'He entendido que quieres cerrar el ticket, pero solo puede hacerlo quien lo abrio, el staff configurado o alguien con Manage Server.',
      allowedMentions: { parse: [] }
    }).catch(() => null);
    if (reply) await saveTranscript(storage, reply, 'assistant');
    return { handled: true };
  }

  const closingReply = await channel.send({
    content: [
      `${EMOJIS.check} Ticket cerrado por voz.`,
      'Estoy preparando la transcripcion y eliminare este canal en unos segundos.'
    ].join('\n'),
    allowedMentions: { parse: [] }
  });

  await storage.addTranscriptMessage({
    guildId: guild.id,
    channelId: channel.id,
    messageId: `voice-close-intent-${Date.now()}`,
    authorId: member.user.id,
    authorName: member.user.username,
    authorBot: false,
    role: 'system',
    content: `Cierre solicitado por voz: ${transcript}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to record voice close intent ${channel.id}: ${compactRuntimeError(error)}`);
  });

  await closeTicketWithTranscript({
    client,
    storage,
    config,
    voiceManager,
    channel,
    guild,
    ticket,
    requestedBy: member.user,
    requestId: `voice-${Date.now()}`,
    closingReply,
    fallbackUser: member.user,
    reason: `NexaDesk voice close requested by ${member.user.tag}`
  });

  return { handled: true };
}

async function closeTicketWithTranscript({ client, storage, config, voiceManager = null, channel, guild, ticket, requestedBy, requestId, closingReply, fallbackUser = null, reason }) {
  const requestedAt = new Date().toISOString();
  scheduleTicketChannelDelete({
    guild,
    channelId: channel.id,
    reason,
    delayMs: 10_000
  });

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
  }).catch((error) => {
    console.error(`Failed to record ticket close request ${channel.id}: ${compactRuntimeError(error)}`);
  });

  await channel.sendTyping().catch(() => {});
  await saveTranscript(storage, closingReply, 'assistant').catch((error) => {
    console.error(`Failed to save closing reply transcript ${channel.id}: ${compactRuntimeError(error)}`);
  });

  const closedAt = new Date().toISOString();
  const closedTicket = {
    ...ticket,
    status: 'closed',
    updatedAt: closedAt
  };
  await storage.updateTicket(channel.id, {
    status: 'closed',
    aiDisabled: false
  }).catch((error) => {
    console.error(`Failed to mark ticket closed before delete ${channel.id}: ${compactRuntimeError(error)}`);
  });

  const messages = await withOperationTimeout(
    storage.listTranscriptMessages(channel.id),
    6_000,
    `list transcript ${channel.id}`
  ).catch((error) => {
    console.error(`Failed to list transcript before ticket close ${channel.id}: ${compactRuntimeError(error)}`);
    return [];
  });
  const guildConfig = await storage.getGuildConfig(guild.id).catch(() => null);
  const targetUser = await resolveTranscriptRecipient(client, ticket, messages) ?? fallbackUser;
  let dmStatus = 'No se pudo detectar usuario para enviar el enlace de transcripcion por MD.';

  if (targetUser) {
    try {
      await withOperationTimeout(
        sendTranscriptDm({
          targetUser,
          ticket: closedTicket,
          messages,
          guildName: guild.name,
          guildConfig,
          config
        }),
        10_000,
        `send transcript dm ${channel.id}`
      );
      dmStatus = `Enlace de transcripcion enviado automaticamente por MD a ${targetUser.tag}.`;
    } catch (error) {
      console.error(`Failed to DM transcript for ticket close ${channel.id}: ${compactRuntimeError(error)}`);
      dmStatus = `No se pudo enviar el enlace de transcripcion por MD a ${targetUser.tag}. Puede tener los MD cerrados.`;
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
  }).catch((error) => {
    console.error(`Failed to record ticket close DM status ${channel.id}: ${compactRuntimeError(error)}`);
  });
  await withOperationTimeout(
    closeLinkedVoiceRoom({ guild, ticket, voiceManager, reason: `NexaDesk ticket closed by ${requestedBy.tag}` }),
    6_000,
    `close linked voice room ${channel.id}`
  ).catch((error) => {
    console.error(`Failed to close linked voice room for ticket ${channel.id}: ${compactRuntimeError(error)}`);
  });

  try {
    await closingReply.edit([
      `${EMOJIS.check} Ticket cerrado.`,
      dmStatus,
      'Este canal se eliminara automaticamente en unos segundos.'
    ].join('\n'));
  } catch {
    // The channel may already be gone if another ticket bot deleted it first.
  }
}

function scheduleTicketChannelDelete({ guild, channelId, reason, delayMs = 10_000 }) {
  const timer = setTimeout(async () => {
    let freshChannel = null;
    try {
      freshChannel = await guild.channels.fetch(channelId).catch(() => null);
      if (!freshChannel) {
        console.log(`Closed ticket channel ${channelId} was already deleted.`);
        return;
      }

      await freshChannel.delete(reason);
      console.log(`Deleted closed ticket channel ${freshChannel.name ?? channelId} (${channelId}).`);
    } catch (error) {
      console.error(`Failed to delete closed ticket channel ${channelId}: ${compactRuntimeError(error)}`);
      if (freshChannel?.isTextBased?.()) {
        await freshChannel.send([
          'No tengo permisos suficientes para eliminar este canal.',
          'El ticket ya quedo cerrado en NexaDesk, pero necesito **Manage Channels** y que mi rol este por encima para borrarlo automaticamente.'
        ].join('\n')).catch((sendError) => {
          if (isMissingAccessError(sendError) || isMissingPermissionError(sendError)) return;
          console.error(`Failed to send ticket delete permission warning ${channelId}: ${compactRuntimeError(sendError)}`);
        });
      }
    }
  }, delayMs);
  timer.unref?.();
  return timer;
}

async function finalizeDeletedTicket({ client, storage, channel, ticket, voiceManager = null, config }) {
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
  let dmStatus = 'No se pudo detectar usuario para enviar el enlace de transcripcion por MD.';

  if (targetUser) {
    try {
      await sendTranscriptDm({
        targetUser,
        ticket: closedTicket,
        messages,
        guildName: channel.guild?.name,
        guildConfig,
        config
      });
      dmStatus = `Enlace de transcripcion enviado automaticamente por MD a ${targetUser.tag}.`;
    } catch (error) {
      console.error('Failed to auto DM deleted ticket transcript:', error);
      dmStatus = `No se pudo enviar el enlace de transcripcion por MD a ${targetUser.tag}. Puede tener los MD cerrados.`;
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

async function sendTranscriptDm({ targetUser, ticket, guildName, guildConfig = null, config = null }) {
  const transcriptUrl = buildTranscriptReplayUrl({
    dashboardBaseUrl: getPublicDashboardBaseUrl(config ?? {}),
    channelId: ticket.channelId,
    userId: targetUser.id,
    secret: config?.SESSION_SECRET
  });
  const growth = normalizeGrowthConfig(guildConfig?.growth);
  const premium = normalizePremiumConfig(guildConfig?.premium, guildConfig ?? {});
  const shouldAskFeedback = growth.enabled && growth.feedbackDm;
  const content = [
    `${EMOJIS.logs} Aqui tienes el enlace para ver la transcripcion de tu ticket en **${ticket.guildName ?? guildName ?? 'el servidor'}**:`,
    transcriptUrl,
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
    components: shouldAskFeedback ? buildTranscriptFeedbackComponents(ticket.channelId) : []
  });
}

function buildFeedbackComponents(channelId, { disabled = false, selectedRating = null } = {}) {
  return [
    new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((rating) =>
        new ButtonBuilder()
          .setCustomId(`nexadesk:feedback:${channelId}:${rating}`)
          .setLabel(String(rating))
          .setDisabled(disabled)
          .setStyle(selectedRating === rating ? ButtonStyle.Primary : rating >= 4 ? ButtonStyle.Success : rating <= 2 ? ButtonStyle.Danger : ButtonStyle.Secondary)
      )
    )
  ];
}

function buildTranscriptFeedbackComponents(channelId, {
  disabled = false,
  selectedRating = null,
  aiDisabled = false,
  selectedAiVerdict = null
} = {}) {
  return [
    ...buildFeedbackComponents(channelId, { disabled, selectedRating }),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`nexadesk:ai_feedback:${channelId}:good`)
        .setLabel(selectedAiVerdict === 'good' ? 'IA clara guardada' : 'IA clara')
        .setDisabled(aiDisabled)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`nexadesk:ai_feedback:${channelId}:bad`)
        .setLabel(selectedAiVerdict === 'bad' ? 'Reporte IA guardado' : 'Reportar IA')
        .setDisabled(aiDisabled)
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

async function handleTicketFeedbackButton({ interaction, storage, client, activeFeedbackRatings }) {
  const [, , channelId, ratingValue] = interaction.customId.split(':');
  const rating = Number.parseInt(ratingValue, 10);
  const ticket = await storage.getTicket(channelId).catch(() => null);
  if (!ticket) {
    await replyToFeedbackInteraction(interaction, 'No encuentro el ticket asociado a esta valoracion.');
    return;
  }

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    await replyToFeedbackInteraction(interaction, 'Esta valoracion no es valida.');
    return;
  }

  if (ticket.openedBy && interaction.user.id !== ticket.openedBy) {
    await replyToFeedbackInteraction(interaction, 'Solo la persona que abrio el ticket puede valorar esta atencion.');
    return;
  }

  const feedbackId = `feedback-${channelId}-${interaction.user.id}`;
  if (activeFeedbackRatings?.has(feedbackId)) {
    await deferFeedbackInteraction(interaction);
    return;
  }

  activeFeedbackRatings?.add(feedbackId);
  try {
    const existingFeedback = typeof storage.getTicketFeedback === 'function'
      ? await storage.getTicketFeedback(feedbackId).catch((error) => {
          console.error(`Failed to check existing feedback ${feedbackId}:`, error);
          return null;
        })
      : null;
    if (existingFeedback) {
      await acknowledgeFeedbackButton(interaction, {
        channelId,
        rating: existingFeedback.rating,
        alreadySaved: true
      });
      return;
    }

    const guildConfig = await storage.getGuildConfig(ticket.guildId).catch(() => null);
    const feedback = await storage.addTicketFeedback({
      id: feedbackId,
      guildId: ticket.guildId,
      guildName: ticket.guildName ?? guildConfig?.guildName,
      channelId,
      channelName: ticket.channelName,
      userId: interaction.user.id,
      username: interaction.user.username,
      rating,
      source: 'dm_rating'
    });

    await acknowledgeFeedbackButton(interaction, { channelId, rating: feedback.rating });
    if (!feedback.notPersisted) {
      await maybePublishFeedbackReview({ client, storage, feedback, ticket, guildConfig });
    }
  } finally {
    activeFeedbackRatings?.delete(feedbackId);
  }
}

async function acknowledgeFeedbackButton(interaction, { channelId, rating, alreadySaved = false }) {
  const content = buildFeedbackAcknowledgementContent(interaction.message?.content ?? '', {
    rating,
    alreadySaved
  });
  const components = buildTranscriptFeedbackComponents(channelId, {
    disabled: true,
    selectedRating: rating
  });

  if (!interaction.deferred && !interaction.replied && typeof interaction.update === 'function') {
    try {
      await interaction.update({ content, components });
      return;
    } catch (error) {
      console.error(`Failed to update feedback message ${interaction.customId}:`, error);
    }
  }

  if (!interaction.deferred && !interaction.replied) {
    await replyToFeedbackInteraction(
      interaction,
      `${EMOJIS.check} Valoracion guardada: ${formatRatingStars(rating)}.`
    ).catch((error) => {
      console.error(`Failed to acknowledge feedback interaction ${interaction.customId}:`, error);
    });
  }
}

async function handleAiFeedbackButton({ interaction, storage }) {
  const [, , channelId, verdict] = interaction.customId.split(':');
  const ticket = await storage.getTicket(channelId).catch(() => null);
  if (!ticket) {
    await replyToFeedbackInteraction(interaction, 'No encuentro el ticket asociado a este feedback de IA.');
    return;
  }

  if (ticket.openedBy && interaction.user.id !== ticket.openedBy) {
    await replyToFeedbackInteraction(interaction, 'Solo la persona que abrio el ticket puede enviar feedback de IA.');
    return;
  }

  const normalizedVerdict = verdict === 'good' ? 'good' : 'bad';
  const transcript = await storage.listTranscriptMessages(channelId).catch(() => []);
  const previousAiMessage = [...transcript].reverse().find((entry) => entry.role === 'assistant' || entry.authorBot);
  const id = `ai-feedback-${channelId}-${interaction.user.id}`;
  const positive = normalizedVerdict === 'good';
  const reason = positive
    ? 'El usuario marco desde MD que la respuesta de IA fue clara.'
    : 'El usuario reporto desde MD que la respuesta de IA necesita revision.';

  await storage.addAiQualitySignal?.({
    id,
    guildId: ticket.guildId,
    guildName: ticket.guildName,
    channelId,
    channelName: ticket.channelName,
    messageId: interaction.message?.id,
    userId: interaction.user.id,
    username: interaction.user.username,
    category: positive ? 'general' : 'wrong_answer',
    severity: positive ? 'low' : 'medium',
    sentiment: positive ? 'satisfied' : 'frustrated',
    confidence: 100,
    reason,
    userMessage: `Feedback rapido de IA desde MD: ${positive ? 'IA clara' : 'Reportar IA'}.`,
    previousAiMessage: previousAiMessage?.content?.slice(0, 2400),
    detectedBy: 'dm_feedback',
    resolved: positive,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save AI feedback ${id}:`, error);
  });

  await storage.addGuildLog?.({
    guildId: ticket.guildId,
    guildName: ticket.guildName,
    type: 'growth',
    severity: positive ? 'success' : 'warning',
    title: positive ? 'Feedback IA positivo' : 'Feedback IA a revisar',
    message: positive
      ? `${interaction.user.username} marco la IA como clara en #${ticket.channelName ?? channelId}.`
      : `${interaction.user.username} reporto una respuesta IA a revisar en #${ticket.channelName ?? channelId}.`,
    actorId: interaction.user.id,
    actorName: interaction.user.username,
    channelId,
    channelName: ticket.channelName,
    metadata: { verdict: normalizedVerdict, ticketId: ticket.channelId }
  }).catch(() => {});

  await acknowledgeAiFeedbackButton(interaction, {
    channelId,
    verdict: normalizedVerdict
  });
}

async function acknowledgeAiFeedbackButton(interaction, { channelId, verdict }) {
  const selectedRating = extractRatingFromFeedbackContent(interaction.message?.content ?? '');
  const content = buildAiFeedbackAcknowledgementContent(interaction.message?.content ?? '', verdict);
  const components = buildTranscriptFeedbackComponents(channelId, {
    disabled: Boolean(selectedRating),
    selectedRating,
    aiDisabled: true,
    selectedAiVerdict: verdict
  });

  if (!interaction.deferred && !interaction.replied && typeof interaction.update === 'function') {
    try {
      await interaction.update({ content, components });
      return;
    } catch (error) {
      console.error(`Failed to update AI feedback message ${interaction.customId}:`, error);
    }
  }

  await replyToFeedbackInteraction(
    interaction,
    verdict === 'good'
      ? `${EMOJIS.check} Gracias. He guardado que la IA fue clara.`
      : `${EMOJIS.wifi} Gracias. He enviado esta respuesta IA al radar de mejoras.`
  ).catch((error) => {
    console.error(`Failed to acknowledge AI feedback interaction ${interaction.customId}:`, error);
  });
}

function buildAiFeedbackAcknowledgementContent(content, verdict) {
  const base = String(content ?? '').trim();
  if (/Feedback IA (?:guardado|registrado)/i.test(base)) return base;
  const line = verdict === 'good'
    ? `${EMOJIS.check} Feedback IA guardado: respuesta clara.`
    : `${EMOJIS.wifi} Feedback IA guardado: el owner podra revisarlo en Growth Engine.`;
  return [base, line].filter(Boolean).join('\n\n');
}

function extractRatingFromFeedbackContent(content) {
  const match = String(content ?? '').match(/\[(?:\+|-){5}\]\s+([1-5])\/5/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function deferFeedbackInteraction(interaction) {
  if (interaction.deferred || interaction.replied || typeof interaction.deferUpdate !== 'function') return;
  await interaction.deferUpdate().catch((error) => {
    console.error(`Failed to defer repeated feedback interaction ${interaction.customId}:`, error);
  });
}

function buildFeedbackAcknowledgementContent(content, { rating, alreadySaved = false }) {
  const base = String(content ?? '').trim();
  if (/Valoracion (?:guardada|registrada)/i.test(base)) return base;

  const line = `${EMOJIS.check} ${alreadySaved ? 'Valoracion ya registrada' : 'Gracias. Valoracion guardada'}: ${formatRatingStars(rating)}.`;
  return [base, line].filter(Boolean).join('\n\n');
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
    content: `${EMOJIS.siren} ${staffMention}Churn Radar: una valoracion baja necesita revision humana.`,
    embeds: [
      new EmbedBuilder()
        .setColor(0xffcc00)
        .setTitle(`${EMOJIS.siren} Riesgo de perdida detectado`)
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
      { name: `${EMOJIS.ticket} Canales activos`, value: String(activeTickets.length), inline: true },
      {
        name: `${EMOJIS.ticket} Tickets`,
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
        name: `${EMOJIS.gear} Runtime`,
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
  const intelligence = buildGuildIntelligenceReport({
    guild: interaction.guild,
    guildConfig,
    activeTickets,
    todayTickets
  });

  const embed = new EmbedBuilder()
    .setColor(operational.score >= 80 ? 0xffffff : operational.score >= 55 ? 0xffcc00 : 0xff5f57)
    .setTitle(`${EMOJIS.gear} Diagnostico NexaDesk`)
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
        name: `${EMOJIS.ticket} Tickets`,
        value: [
          `Abiertos: **${activeTickets.length}**`,
          `Creados hoy: **${todayTickets}**`,
          `Esperando staff: **${escalatedTickets}**`,
          `Con voz: **${activeTickets.filter((ticket) => ticket.voiceChannelId).length}**`
        ].join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.gear} Modulos`,
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
        name: `${EMOJIS.server} Inteligencia del servidor`,
        value: intelligence.summaryLines.join('\n'),
        inline: true
      },
      {
        name: `${EMOJIS.check} Oportunidades recomendadas`,
        value: intelligence.opportunities.length
          ? intelligence.opportunities.map((item) => `- ${item}`).join('\n')
          : 'No veo oportunidades criticas ahora mismo. Mantén transcripciones y feedback activos para seguir optimizando.',
        inline: false
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

async function handleReportCommand({ interaction, storage }) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Los reportes solo se pueden enviar dentro de un servidor.', ephemeral: true });
    return;
  }

  const target = interaction.options.getUser('usuario', true);
  const reason = interaction.options.getString('razon', true).trim().slice(0, 900);
  const moderatorNote = interaction.options.getString('mensaje_moderador')?.trim().slice(0, 700) || '';
  const proofs = ['prueba', 'prueba_2', 'prueba_3']
    .map((name) => interaction.options.getAttachment(name))
    .filter(Boolean);

  if (!proofs.length) {
    await interaction.reply({ content: 'Sube al menos una prueba visual como archivo. No acepto enlaces para evitar pruebas manipuladas.', ephemeral: true });
    return;
  }

  const invalidProof = proofs.find((proof) => !isVisualReportProof(proof));
  if (invalidProof) {
    await interaction.reply({
      content: `La prueba **${invalidProof.name ?? invalidProof.id}** no parece imagen o video. Sube una captura, imagen o clip directamente desde Discord.`,
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const guildConfig = await storage.getGuildConfig(interaction.guildId).catch(() => null);
  const reportChannel = await findModerationReportChannel(interaction.guild, guildConfig);
  if (!reportChannel) {
    await interaction.editReply([
      `${EMOJIS.siren} No encuentro un canal interno de moderacion donde enviar este reporte.`,
      'Crea o configura un canal tipo `mods`, `reportes`, `staff-logs` o activa un canal de logs en `/seguridad configurar canal_logs:`.'
    ].join('\n'));
    return;
  }

  const reportId = `report-${Date.now()}-${interaction.id.slice(-6)}`;
  const reportEmbed = buildReportEmbed({
    reportId,
    guild: interaction.guild,
    reporter: interaction.user,
    target,
    reason,
    moderatorNote,
    proofs,
    sourceChannel: interaction.channel
  });
  const staffMention = guildConfig?.staffRoleId ? `<@&${guildConfig.staffRoleId}> ` : '';
  const reportMessage = await reportChannel.send({
    content: `${staffMention}${EMOJIS.siren} Nuevo reporte recibido desde ${interaction.channel}.`,
    embeds: [reportEmbed],
    components: buildReportReviewComponents({ targetId: target.id, reporterId: interaction.user.id }),
    allowedMentions: guildConfig?.staffRoleId ? { roles: [guildConfig.staffRoleId] } : { parse: [] }
  });

  await storage.addGuildLog?.({
    guildId: interaction.guildId,
    guildName: interaction.guild.name,
    type: 'user_report',
    severity: 'warning',
    title: 'Reporte de usuario enviado a moderacion',
    message: reason,
    actorId: interaction.user.id,
    actorName: interaction.user.tag ?? interaction.user.username,
    targetId: target.id,
    targetName: target.tag ?? target.username,
    channelId: interaction.channelId,
    channelName: interaction.channel?.name,
    metadata: {
      reportId,
      reportChannelId: reportChannel.id,
      reportMessageId: reportMessage.id,
      proofCount: proofs.length,
      moderatorNote
    }
  }).catch((error) => console.warn(`Could not persist user report log in ${interaction.guildId}:`, error?.message ?? error));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf4c95d)
        .setTitle(`${EMOJIS.check} Usuario reportado correctamente`)
        .setDescription('Usuario reportado correctamente, pronto recibiras una respuesta.')
        .addFields(
          { name: 'Usuario reportado', value: `${target} (${target.id})`, inline: false },
          { name: 'Canal de revision', value: `${reportChannel}`, inline: false }
        )
        .setFooter({ text: 'NexaDesk Report System' })
        .setTimestamp(new Date())
    ]
  });
}

async function handleReportRejectButton({ interaction, storage }) {
  const guildConfig = await storage.getGuildConfig(interaction.guildId).catch(() => null);
  if (!canReviewReport(interaction, guildConfig)) {
    await interaction.reply({ content: 'Solo staff o usuarios con permisos de moderacion pueden revisar reportes.', ephemeral: true });
    return;
  }

  const { targetId, reporterId } = parseReportCustomId(interaction.customId);
  await markReportMessageReviewed({
    interaction,
    storage,
    status: 'Reporte rechazado',
    color: 0x8a8a8a,
    action: 'reject',
    targetId,
    reporterId
  });
}

async function handleReportActionSelect({ interaction, storage }) {
  const guildConfig = await storage.getGuildConfig(interaction.guildId).catch(() => null);
  if (!canReviewReport(interaction, guildConfig)) {
    await interaction.reply({ content: 'Solo staff o usuarios con permisos de moderacion pueden tomar accion sobre reportes.', ephemeral: true });
    return;
  }

  const action = interaction.values?.[0];
  const { targetId, reporterId } = parseReportCustomId(interaction.customId);
  if (action === 'warn') {
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    await targetUser?.send([
      `${EMOJIS.ban} Has recibido una advertencia en **${interaction.guild.name}**.`,
      'Un reporte fue revisado por moderacion. Si crees que es un error, habla con el staff del servidor.'
    ].join('\n')).catch(() => null);
    await markReportMessageReviewed({
      interaction,
      storage,
      status: 'Warn aplicado',
      color: 0xf4c95d,
      action: 'warn',
      targetId,
      reporterId
    });
    return;
  }

  if (action === 'ban') {
    try {
      await interaction.guild.members.ban(targetId, {
        reason: `NexaDesk reporte revisado por ${interaction.user.tag ?? interaction.user.username}`
      });
    } catch (error) {
      await interaction.reply({
        content: `No pude banear a ese usuario: ${String(error?.message ?? error).slice(0, 300)}`,
        ephemeral: true
      });
      return;
    }

    await markReportMessageReviewed({
      interaction,
      storage,
      status: 'Ban aplicado',
      color: 0xff5f57,
      action: 'ban',
      targetId,
      reporterId
    });
  }
}

function isVisualReportProof(attachment) {
  const contentType = String(attachment?.contentType ?? '').toLowerCase();
  const name = String(attachment?.name ?? attachment?.url ?? '').toLowerCase();
  return contentType.startsWith('image/')
    || contentType.startsWith('video/')
    || /\.(?:png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(name);
}

function buildReportEmbed({ reportId, guild, reporter, target, reason, moderatorNote, proofs, sourceChannel }) {
  const proofLines = proofs.map((proof, index) => `${index + 1}. [${proof.name ?? `Prueba ${index + 1}`}](${proof.url})`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0xf4c95d)
    .setTitle(`${EMOJIS.siren} Nuevo reporte de usuario`)
    .setDescription('Un usuario ha enviado un reporte con pruebas adjuntas. Revisadlo antes de aplicar sanciones.')
    .addFields(
      { name: 'ID reporte', value: reportId, inline: false },
      { name: 'Servidor', value: `${guild.name} (${guild.id})`, inline: false },
      { name: 'Reportado', value: `${target} (${target.id})`, inline: false },
      { name: 'Reportado por', value: `${reporter} (${reporter.id})`, inline: false },
      { name: 'Razon', value: reason || 'Sin razon indicada.', inline: false },
      { name: 'Mensaje para moderador', value: moderatorNote || 'No indicado.', inline: false },
      { name: 'Canal origen', value: `${sourceChannel ?? 'No indicado'}`, inline: false },
      { name: 'Pruebas visuales', value: proofLines.slice(0, 1000), inline: false }
    )
    .setFooter({ text: 'NexaDesk Report System' })
    .setTimestamp(new Date());
  const firstImage = proofs.find((proof) => String(proof.contentType ?? '').startsWith('image/'));
  if (firstImage?.url) embed.setImage(firstImage.url);
  return embed;
}

function buildReportReviewComponents({ targetId, reporterId, disabled = false }) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`nexadesk:report:reject:${targetId}:${reporterId}`)
        .setLabel('Rechazar')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`nexadesk:report:action:${targetId}:${reporterId}`)
        .setPlaceholder('Tomar Accion')
        .setDisabled(disabled)
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel('Warn')
            .setDescription('Enviar advertencia al usuario reportado.')
            .setValue('warn'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Ban')
            .setDescription('Banear al usuario reportado del servidor.')
            .setValue('ban')
        )
    )
  ];
}

async function markReportMessageReviewed({ interaction, storage, status, color, action, targetId, reporterId }) {
  const embed = interaction.message.embeds?.[0]
    ? EmbedBuilder.from(interaction.message.embeds[0])
    : new EmbedBuilder().setTitle('Reporte NexaDesk');
  embed
    .setColor(color)
    .addFields({ name: 'Estado', value: `${status} por ${interaction.user} (${interaction.user.id})`, inline: false })
    .setTimestamp(new Date());

  await interaction.update({
    embeds: [embed],
    components: buildReportReviewComponents({ targetId, reporterId, disabled: true })
  });

  await storage.addGuildLog?.({
    guildId: interaction.guildId,
    guildName: interaction.guild?.name,
    type: `user_report_${action}`,
    severity: action === 'ban' ? 'critical' : action === 'warn' ? 'warning' : 'info',
    title: status,
    message: `Reporte revisado por ${interaction.user.tag ?? interaction.user.username}`,
    actorId: interaction.user.id,
    actorName: interaction.user.tag ?? interaction.user.username,
    targetId,
    channelId: interaction.channelId,
    channelName: interaction.channel?.name,
    metadata: {
      reporterId,
      reportMessageId: interaction.message.id
    }
  }).catch((error) => console.warn(`Could not persist report action log in ${interaction.guildId}:`, error?.message ?? error));
}

function parseReportCustomId(customId = '') {
  const [, , , targetId = '', reporterId = ''] = String(customId).split(':');
  return { targetId, reporterId };
}

function canReviewReport(interaction, guildConfig) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || isConfiguredStaffMember(interaction.member, interaction.user, guildConfig)
  );
}

async function findModerationReportChannel(guild, guildConfig) {
  const security = normalizeSecurityConfig(guildConfig?.security);
  const configuredLogChannel = security.logChannelId
    ? await guild.channels.fetch(security.logChannelId).catch(() => null)
    : null;
  if (isUsableReportChannel(configuredLogChannel, guild)) return configuredLogChannel;

  const channels = await guild.channels.fetch().catch(() => new Map());
  const candidates = [...channels.values()]
    .filter((channel) => isUsableReportChannel(channel, guild))
    .map((channel) => ({ channel, score: scoreModerationChannel(channel, guildConfig, guild) }))
    .filter((item) => item.score >= 45)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.channel ?? null;
}

function isUsableReportChannel(channel, guild) {
  if (!channel || !channel.isTextBased?.() || typeof channel.send !== 'function') return false;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return false;
  const botMember = guild.members.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : channel.permissionsFor(guild.client.user);
  return !permissions || (permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.SendMessages));
}

function scoreModerationChannel(channel, guildConfig, guild) {
  const name = normalizeChannelNameForDiscovery(channel.name ?? '');
  let score = 0;
  if (/\b(?:mod|mods|moderacion|moderation|staff|admin|admins|reportes|reports|denuncias|sanciones|logs|stafflogs|security|seguridad)\b/u.test(name)) score += 50;
  if (/\b(?:public|general|chat|ticket|tickets|alianza|partners|anuncios|avisos|bienvenida)\b/u.test(name)) score -= 35;
  const everyoneOverwrite = channel.permissionOverwrites?.cache?.get(guild.roles.everyone.id);
  if (everyoneOverwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) score += 35;
  const staffOverwrite = guildConfig?.staffRoleId
    ? channel.permissionOverwrites?.cache?.get(guildConfig.staffRoleId)
    : null;
  if (staffOverwrite?.allow?.has?.(PermissionFlagsBits.ViewChannel)) score += 20;
  if (channel.parent?.name && /\b(?:staff|mod|admin|moderacion|logs|security)\b/u.test(normalizeChannelNameForDiscovery(channel.parent.name))) score += 20;
  return score;
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

function buildGuildIntelligenceReport({ guild, guildConfig, activeTickets = [], todayTickets = 0 }) {
  const channels = [...(guild?.channels?.cache?.values?.() ?? [])];
  const textChannels = channels.filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
  const voiceChannels = channels.filter((channel) => channel.type === ChannelType.GuildVoice);
  const categories = channels.filter((channel) => channel.type === ChannelType.GuildCategory);
  const botsCached = [...(guild?.members?.cache?.values?.() ?? [])].filter((member) => member.user?.bot).length;
  const totalMembers = Number(guild?.memberCount ?? guild?.members?.cache?.size ?? 0);
  const humanEstimate = Math.max(0, totalMembers - botsCached);
  const membersPerOpenTicket = activeTickets.length && humanEstimate
    ? Math.max(1, Math.round(humanEstimate / activeTickets.length))
    : null;
  const supportChannelSignals = textChannels.filter((channel) =>
    /\b(?:soporte|support|ticket|tickets|ayuda|help|dudas|faq|reportes|reports|alianzas|partners|staff)\b/u
      .test(normalizeChannelNameForDiscovery(channel.name ?? ''))
  ).length;
  const privateChannels = textChannels.filter((channel) => {
    const everyoneOverwrite = channel.permissionOverwrites?.cache?.get?.(guild.roles.everyone.id);
    return Boolean(everyoneOverwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel));
  }).length;
  const hasStaff = Boolean(guildConfig?.staffRoleId);
  const hasContext = Boolean(guildConfig?.serverPrompt || guildConfig?.serverInfo);
  const security = normalizeSecurityConfig(guildConfig?.security);
  const hasPanel = Boolean(guildConfig?.panels?.length);
  const hasComponents = Boolean(guildConfig?.components?.length);
  const sizeLabel = totalMembers >= 1000
    ? 'Comunidad grande'
    : totalMembers >= 250
      ? 'Comunidad en crecimiento'
      : 'Comunidad pequena/mediana';

  const summaryLines = [
    `Miembros: **${formatNumber(totalMembers)}** (${sizeLabel})`,
    `Canales: **${textChannels.length} texto**, **${voiceChannels.length} voz**, **${categories.length} categorias**`,
    `Tickets activos: **${activeTickets.length}**${membersPerOpenTicket ? ` (~1 por cada ${membersPerOpenTicket} miembros)` : ''}`,
    `Canales privados: **${privateChannels}** - Senales soporte: **${supportChannelSignals}**`
  ];

  const opportunities = [];
  if (!hasContext) opportunities.push('Anadir contexto IA con normas, FAQ y tono del servidor para reducir preguntas repetidas.');
  if (!hasStaff) opportunities.push('Configurar rol staff para que los escalados lleguen a la gente correcta.');
  if (!security.enabled) opportunities.push('Activar Security Guard antes de llevar NexaDesk a servidores con mucha gente.');
  if (!hasComponents) opportunities.push('Crear componentes con preguntas previas para que cada ticket llegue con contexto desde el primer mensaje.');
  if (!hasPanel) opportunities.push('Publicar al menos un panel profesional con menu o boton para que los usuarios no dependan de staff.');
  if (todayTickets >= 8) opportunities.push('Hay bastante volumen hoy: conviene revisar transcripciones y activar Growth Engine para medir satisfaccion.');
  if (totalMembers >= 500 && !isPremiumEntitled(guildConfig ?? {})) opportunities.push('Servidor grande detectado: Premium puede venderse aqui por voz, examenes, SLA Radar y transcripciones inteligentes.');
  if (supportChannelSignals >= 4 && !guildConfig?.discovery?.faqChannelId) opportunities.push('Hay muchos canales de soporte/info; ejecuta diagnostico o autoconfig para que NexaDesk los use como contexto.');

  return {
    summaryLines,
    opportunities: opportunities.slice(0, 5)
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-ES').format(Number(value ?? 0));
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
  if (!canTicketOpenerClose(guildConfig)) return false;
  if (ticket.openedBy) return ticket.openedBy === message.author.id;
  return true;
}

function canCloseTicketFromVoiceMember(member, ticket, guildConfig) {
  if (member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(member, guildConfig.staffRoleId)) return true;
  if (!canTicketOpenerClose(guildConfig)) return false;
  if (ticket.openedBy) return ticket.openedBy === member?.user?.id;
  return true;
}

function canCloseTicketFromInteraction(interaction, ticket, guildConfig) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (guildConfig?.staffRoleId && memberHasRole(interaction.member, guildConfig.staffRoleId)) return true;
  if (!canTicketOpenerClose(guildConfig)) return false;
  if (ticket.openedBy) return ticket.openedBy === interaction.user.id;
  return true;
}

function canTicketOpenerClose(guildConfig) {
  return guildConfig?.ticketClosePolicy?.usersCanClose !== false
    && guildConfig?.ticketClosePolicy?.mode !== 'staff_only';
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

  const reason = trimmed.replace(/\[ESCALATE\]\s*/gi, '').trim();
  return {
    shouldEscalate: true,
    reason: reason || 'El ticket requiere revision humana.',
    publicAnswer: reason || 'Voy a avisar al staff para que revise este ticket.'
  };
}

function looksLikeEscalation(answer) {
  return [
    /\b(?:necesito|requiere|hace\s+falta)\s+(?:asistencia|ayuda|atencion)\s+(?:humana|manual|del\s+staff|de\s+staff)\b/i,
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
  if (allianceState.started && isAllianceInfoQuestion(message.content) && !allianceState.userTemplate) {
    await markAllianceState(storage, message.channel, 'cancelled', 'info_question');
    return { type: 'none' };
  }
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
  if (isAllianceInfoQuestion(normalized)) return false;
  return /\balianz(?:a|as)\b/.test(normalized)
    || /\bpartner(?:ship)?s?\b/.test(normalized)
    || /\bcolaboracion\b/.test(normalized);
}

function isAllianceInfoQuestion(content) {
  const normalized = normalizeText(content);
  const talksAboutAlliance = /\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b/.test(normalized);
  if (!talksAboutAlliance) return false;
  if (/\b(?:cual|cuales|que|where|which|what|list|show|ver|listar|mostrar|muestrame|dime|saber|conocer)\b/.test(normalized)
    && /\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b/.test(normalized)
    && !/\b(?:quiero|queria|quisiera|me\s+gustaria|hacer|realizar|proponer|solicitar|tramitar|enviar|mandar)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:quiero|queria|me\s+gustaria|hacer|realizar|proponer|solicitar|mandar|enviar|ofrecer|crear|tramitar)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b/.test(normalized)) {
    return false;
  }
  return [
    /\b(?:cuales?|que|donde|ver|listar|muestrame|mostrar|saber|conocer)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b/,
    /\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b.*\b(?:de\s+este\s+servidor|del\s+servidor|tiene|hay|actual(?:es)?|lista|canal|canales|ejemplos?)\b/,
    /\b(?:quienes|con\s+quien)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboracion(?:es)?)\b/
  ].some((pattern) => pattern.test(normalized));
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
    /\b(?:asistencia|aistencia|asisten(?:c|s)ia|ayuda|atencion)\s+(?:manual|humana|de\s+staff|del\s+staff)\b/,
    /\b(?:quiero|necesito|ocupo|requiero)\s+(?:un\s+)?(?:humano|staff|moderador|responsable|persona)\b/,
    /\b(?:necesito|podria|puedes|podrias|quiero\s+hablar\s+con|pasame\s+con)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/,
    /\b(?:menciona(?:s|r)?|pinguea(?:s|r)?|pinge?a(?:s|r)?|avisa(?:s|r)?|llama(?:s|r)?|contacta(?:s|r)?)\b.*\b(staff|moderador(?:es)?|humano|responsable)\b/,
    /\b(?:staff|moderador(?:es)?|humano|responsable)\b.*\b(?:por\s+favor|porfa|urgente|ayuda|venir|venga|atienda)\b/,
    /\bmanual\s+(?:support|assistance|help)\b/,
    /\b(?:need|want|call|notify|contact|bring|get)\b.*\b(staff|moderator|human|admin)\b/,
    /\b(?:staff|moderator|human|admin)\b.*\b(?:please|help|needed|urgent)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isSensitiveFileAccessRequest(content) {
  const normalized = normalizeText(content);
  const hasSecretTarget = [
    /\.env(?:\b|$)/,
    /\b(?:archivo|fichero|file)\s+(?:env|\.env|config|configuracion|configuration)\b/,
    /\b(?:token|tokens|api\s*key|apikey|clave\s+api|service\s*role|service_role|secret|secreto|password|contrasena|credenciales|credentials|vault)\b/
  ].some((pattern) => pattern.test(normalized));
  if (!hasSecretTarget) return false;

  const hasReadIntent = [
    /\b(?:leer|leeme|mostrar|muestrame|ver|dime|decir|cuentame|buscar|encuentra|encontrar|abrir|acceder|consultar|copiar|pasar|pasame|mandar|enviar|revelar|exponer|sacar)\b/,
    /\b(?:read|show|find|open|get|tell|send|print|dump|cat|reveal|expose)\b/,
    /\b(?:que\s+hay|que\s+contiene|contenido|dentro|inside|contains?)\b/
  ].some((pattern) => pattern.test(normalized));

  return hasReadIntent || /\.env(?:\b|$)/.test(normalized);
}

function buildSensitiveFileAccessRefusal(message) {
  return [
    `${message.author}, no puedo buscar, leer ni revelar archivos privados como .env, tokens, claves API o credenciales.`,
    'Si esto era una prueba de seguridad: bien detectado. Puedo ayudarte a revisar la configuracion sin exponer secretos, explicar que variables hacen falta o avisar al staff si crees que una clave se ha filtrado.',
    'Si algun secreto se publico por error, lo correcto es rotarlo cuanto antes.'
  ].join('\n');
}

function isRaidReportMessage(content) {
  const normalized = normalizeText(content);
  const looksLikeTest = /\b(?:prueba|test|simulacion|simular|tester|laboratorio)\b/.test(normalized);
  const hasVictimSignal = /\b(?:me|nos|mi|nuestro|servidor|server|sv)\b/.test(normalized);
  const hasRaidSignal = [
    /\b(?:raid|raidead[oa]s?|raidearon|raidear|raideo|nuke|nukear|nuked|flood|flooding)\b/,
    /\b(?:spam\s+masivo|muchos\s+mensajes|canales\s+borrados|roles\s+borrados|mass\s+spam|mass\s+ping|mass\s+mention)\b/,
    /\b(?:atacaron|ataque|invadieron|reventaron|destrozaron)\b.*\b(?:servidor|server|sv)\b/
  ].some((pattern) => pattern.test(normalized));
  if (!hasRaidSignal) return false;
  if (looksLikeTest && !hasVictimSignal) return false;
  return true;
}

function buildRaidReportEscalation(message) {
  return {
    shouldEscalate: true,
    reason: 'El usuario reporta un posible raid o ataque al servidor.',
    publicAnswer: [
      `${message.author}, esto suena a un posible raid o ataque al servidor. Voy a avisar al staff para que lo revise cuanto antes.`,
      'Para actuar rapido, pasame en un mensaje: usuario o bot implicado, hora aproximada, que hicieron exactamente, canales/roles afectados y pruebas si las tienes.',
      'Si el ataque sigue activo, evita borrar pruebas hasta que staff revise logs y aplica medidas urgentes desde el panel de moderacion si tienes permisos.'
    ].join('\n')
  };
}

function isTicketCloseRequest(content) {
  const normalized = normalizeText(content);
  if (/\b(?:no|nunca|jamas|never|dont|don't)\b.{0,24}\b(?:cerrar|cierres|cierr|close|delete)\b/.test(normalized)) return false;
  if (/\b(?:cerrar|cierre|close|delete)\b.{0,32}\b(?:cuando|si|solo|solamente|permiso|pueden|pueda|puedo|politica|configuracion)\b/.test(normalized)) return false;
  return [
    /\b(?:cierra|cierralo|cierra\s+el|cierra\s+este|cerrar|cerrad)\s+(?:el\s+|este\s+)?(?:ticket|canal)\b/,
    /\b(?:puedes|podrias|pueden|quiero|necesito|toca|dale)\s+(?:cerrar|cerrarlo|cerrar\s+el|cerrar\s+este)\s+(?:ticket|canal|esto|este)\b/,
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
  console.log(`Global announcement ${message.id} ignored: announcement mirroring is retired in this build.`);
  return true;

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

function withOperationTimeout(promise, timeoutMs, label = 'operation') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'operation_timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timeoutId));
}

function isUnknownReplyReferenceError(error) {
  if (error?.code === 10008) return true;
  if (error?.code !== 50035) return false;
  return JSON.stringify(error.rawError?.errors ?? {}).includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE');
}

async function registerTicketEscalation({ storage, message, guildConfig, ticket, reason }) {
  const alreadyEscalated = isTicketEscalated(ticket);
  const alreadyMentionedStaff = guildConfig.staffRoleId
    ? await hasStaffEscalationMarker(storage, message.channel.id)
    : true;

  if (alreadyEscalated && alreadyMentionedStaff) return false;

  if (guildConfig.staffRoleId) {
    await notifyStaffRole(message, guildConfig, ticket, reason);
    await markStaffEscalation(storage, message, reason);
  }

  if (!alreadyEscalated) {
    await storage.updateTicket(ticket.channelId, {
      status: 'escalated'
    });
  }

  return Boolean(guildConfig.staffRoleId);
}

async function hasStaffEscalationMarker(storage, channelId) {
  const transcript = await storage.listTranscriptMessages(channelId).catch(() => []);
  return transcript.some((item) => String(item?.content ?? '').includes(STAFF_ESCALATION_MARKER));
}

async function markStaffEscalation(storage, message, reason) {
  await storage.addTranscriptMessage({
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: `staff-escalation-${message.id}-${Date.now()}`,
    authorId: message.client.user?.id,
    authorName: message.client.user?.username ?? 'NexaDesk',
    authorBot: true,
    role: 'system',
    content: `${STAFF_ESCALATION_MARKER} ${String(reason ?? '').slice(0, 500)}`,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    console.error(`Failed to save staff escalation marker in ${message.channel.id}:`, error);
  });
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

export async function sendChannelMessage(client, { channelId, payload }) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
    throw new Error('El canal no existe o no permite enviar mensajes.');
  }
  return channel.send(payload);
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

async function captureInstalledGuildBackups({ client, storage, source = 'scheduled' }) {
  if (!isClientReadyForDiscordRest(client)) {
    console.log('NexaDesk backups skipped because this instance is not the active Discord gateway.');
    return;
  }
  const guilds = [...client.guilds.cache.values()];
  let captured = 0;
  let failed = 0;
  let stoppedReason = '';
  for (const guild of guilds) {
    const saved = await captureGuildBackup(client, storage, { guildId: guild.id, source }).catch((error) => {
      failed += 1;
      console.warn(`Guild backup failed for ${guild.name} (${guild.id}):`, error?.message ?? error);
      if (/gateway is not active|leadership|lease/i.test(String(error?.message ?? error))) {
        stoppedReason = 'Discord gateway dejo de ser lider activo durante el barrido.';
      }
      return null;
    });
    if (saved) captured += 1;
    if (saved?.fallback) {
      stoppedReason = 'PostgreSQL no tiene guild_backups aplicado; detengo el barrido horario tras un snapshot fallback para proteger el lease HA.';
    }
    if (stoppedReason) break;
    await sleep(250);
  }
  console.log(`NexaDesk backups indexed ${captured}/${guilds.length} guilds${failed ? `; failed ${failed}` : ''}${stoppedReason ? `; stopped: ${stoppedReason}` : ''}.`);
}

export async function captureGuildBackup(client, storage, { guildId, source = 'dashboard' }) {
  if (!isClientReadyForDiscordRest(client)) {
    throw new Error('Discord gateway is not active on this NexaDesk instance.');
  }
  const guild = await client.guilds.fetch(guildId);
  const snapshot = await buildGatewayGuildBackupSnapshot(guild, { source });
  const saved = await storage.saveGuildBackupSnapshot(snapshot);
  await storage.addGuildLog?.({
    guildId: guild.id,
    guildName: guild.name,
    type: 'security',
    severity: 'success',
    title: 'Backup capturado',
    message: `Snapshot guardado con ${saved.summary.roles} roles y ${saved.summary.channels} canales.`,
    metadata: { backupId: saved.id, source: saved.source, summary: saved.summary }
  }).catch(() => {});
  return saved;
}

export async function restoreGuildBackup(client, storage, { backupId, targetGuildId, requestedBy = null }) {
  if (!isClientReadyForDiscordRest(client)) {
    throw new Error('Discord gateway is not active on this NexaDesk instance.');
  }
  const backup = await storage.getGuildBackupSnapshot(backupId);
  if (!backup) throw new Error('No encuentro ese backup en PostgreSQL.');
  const targetGuild = await client.guilds.fetch(targetGuildId);
  const result = await restoreGuildBackupWithRest({
    rest: client.rest,
    backup,
    targetGuildId,
    targetGuild,
    requestedBy
  });
  const saved = await storage.recordGuildBackupRestore?.(result);
  await storage.addGuildLog?.({
    guildId: targetGuildId,
    guildName: result.targetGuildName,
    type: 'security',
    severity: result.status === 'completed' ? 'success' : 'warning',
    title: 'Backup restaurado',
    message: `Restaurado desde ${result.sourceGuildName}: ${result.summary.rolesCreated} roles y ${result.summary.channelsCreated} canales creados.`,
    metadata: { backupId, restoreId: result.id, summary: result.summary, requestedBy }
  }).catch(() => {});
  return saved ?? result;
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

