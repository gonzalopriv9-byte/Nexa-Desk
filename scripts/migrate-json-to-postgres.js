import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStorage, PostgresStorage } from '../src/storage.js';
import { generateAffiliateCode, normalizeAffiliateProfile, normalizeAffiliateRedemption } from '../src/affiliates.js';
import { normalizeBlacklistEvidence } from '../src/blacklist.js';
import { normalizePremiumActivation, normalizePremiumPurchase } from '../src/premium-billing.js';
import { normalizeGuildBackupSnapshot } from '../src/backups.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolveDataDir(process.env.DATA_DIR);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Configura DATABASE_URL antes de migrar.');

await assertDataDirectory(dataDir);
const sourceFiles = await listPresentJsonFiles(dataDir);
const knownSourceFiles = new Set([
  'guilds.json',
  'tickets.json',
  'transcripts.json',
  'global-settings.json',
  'global-blacklist.json',
  'global-blacklist-evidence.json',
  'ticket-feedback.json',
  'ai-quality-signals.json',
  'guild-logs.json',
  'guild-backups.json',
  'guild-backup-restores.json',
  'premium-purchases.json',
  'premium-activations.json'
]);
if (!sourceFiles.some((file) => knownSourceFiles.has(file))) {
  throw new Error(`DATA_DIR no contiene archivos JSON de NexaDesk: ${dataDir}`);
}

const source = new JsonStorage(dataDir);
await source.init();
const target = new PostgresStorage({
  connectionString: databaseUrl,
  poolMax: Number(process.env.DATABASE_POOL_MAX || 5),
  connectTimeoutMs: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 8000)
});

const report = {
  ok: false,
  dataDir,
  sourceFiles,
  source: {},
  migrated: {
    globalSettings: 0,
    guilds: 0,
    tickets: 0,
    transcripts: 0,
    feedback: 0,
    aiQualitySignals: 0,
    guildLogs: 0,
    backups: 0,
    restores: 0,
    blacklist: 0,
    blacklistEvidence: 0,
    purchases: 0,
    activations: 0,
    affiliateProfiles: 0,
    affiliateRedemptions: 0
  },
  skipped: {
    transcripts: 0
  }
};

try {
  await target.init();
  await assertPostgresSchema(target.client);

  const settings = await source.getGlobalSettings();
  const guilds = await source.listGuildConfigs();
  const tickets = await source.listTickets();
  const feedback = await source.listTicketFeedback();
  const aiQualitySignals = await source.listAiQualitySignals();
  const blacklist = await source.listBlacklistEntries();
  const transcriptStore = await readJson(path.join(dataDir, 'transcripts.json'), {});
  const logStore = await readJson(path.join(dataDir, 'guild-logs.json'), {});
  const rawBackups = await readJson(path.join(dataDir, 'guild-backups.json'), {});
  const rawRestores = await readJson(path.join(dataDir, 'guild-backup-restores.json'), {});
  const rawPurchases = await readJson(path.join(dataDir, 'premium-purchases.json'), {});
  const rawActivations = await readJson(path.join(dataDir, 'premium-activations.json'), {});
  const affiliates = settings?.affiliates && typeof settings.affiliates === 'object' ? settings.affiliates : {};

  let sourceEvidenceCount = 0;
  for (const entry of blacklist) {
    sourceEvidenceCount += (await source.listBlacklistEvidence(entry.userId)).length;
  }

  report.source = {
    globalSettings: settings && Object.keys(settings).length ? 1 : 0,
    guilds: guilds.length,
    tickets: tickets.length,
    transcripts: Object.values(transcriptStore).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
    feedback: feedback.length,
    aiQualitySignals: aiQualitySignals.length,
    guildLogs: Object.values(logStore).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
    backups: Object.values(rawBackups).filter(Boolean).length,
    restores: Object.values(rawRestores).filter(Boolean).length,
    blacklist: blacklist.length,
    blacklistEvidence: sourceEvidenceCount,
    purchases: Object.values(rawPurchases).filter(Boolean).length,
    activations: Object.values(rawActivations).filter(Boolean).length,
    affiliateProfiles: Object.values(affiliates.profiles ?? {}).filter(Boolean).length,
    affiliateRedemptions: Object.values(affiliates.redemptions ?? {}).filter(Boolean).length
  };

  const originalClient = target.client;
  await originalClient.withTransaction(async (db) => {
    target.client = db;
    try {
      if (settings && Object.keys(settings).length) {
        await target.updateGlobalSettings(settings);
        report.migrated.globalSettings = 1;
      }

      for (const guild of guilds) {
        await upsert(db, 'guild_configs', toGuildRow(guild), 'guild_id');
        report.migrated.guilds += 1;
      }

      for (const ticket of tickets) {
        await upsert(db, 'tickets', toTicketRow(ticket), 'channel_id');
        report.migrated.tickets += 1;
      }

      const transcriptRows = buildTranscriptRows(transcriptStore);
      for (const row of transcriptRows) {
        const existing = await db.query(
          'SELECT id FROM public.transcript_messages WHERE channel_id = $1 AND message_id = $2 LIMIT 1',
          [row.channel_id, row.message_id]
        );
        if (existing.rowCount) {
          report.skipped.transcripts += 1;
          continue;
        }
        await insert(db, 'transcript_messages', row);
        report.migrated.transcripts += 1;
      }

      for (const item of feedback) {
        await upsert(db, 'ticket_feedback', toFeedbackRow(item), 'id');
        report.migrated.feedback += 1;
      }
      for (const item of aiQualitySignals) {
        await upsert(db, 'ai_quality_signals', toAiQualitySignalRow(item), 'id');
        report.migrated.aiQualitySignals += 1;
      }

      for (const [guildId, entries] of Object.entries(logStore)) {
        if (!Array.isArray(entries)) continue;
        for (const [index, item] of entries.entries()) {
          const normalized = { ...(item ?? {}), guildId: item?.guildId ?? guildId };
          normalized.id = normalized.id
            ? String(normalized.id)
            : stableId('json-log', [guildId, index, normalized.createdAt, normalized.title, normalized.message]);
          await upsert(db, 'guild_logs', toGuildLogRow(normalized), 'id');
          report.migrated.guildLogs += 1;
        }
      }

      for (const [key, item] of Object.entries(rawBackups)) {
        if (!item || typeof item !== 'object') continue;
        const normalized = normalizeGuildBackupSnapshot({
          ...item,
          id: item.id ?? stableId('json-backup', [key, item.guildId, item.capturedAt, JSON.stringify(item.snapshot ?? item)])
        });
        await upsert(db, 'guild_backups', toGuildBackupRow(normalized), 'id');
        report.migrated.backups += 1;
      }

      for (const [key, item] of Object.entries(rawRestores)) {
        if (!item || typeof item !== 'object') continue;
        const normalized = normalizeRestore({
          ...item,
          id: item.id ?? stableId('json-restore', [key, item.backupId, item.targetGuildId, item.createdAt])
        });
        await upsert(db, 'guild_backup_restores', toGuildBackupRestoreRow(normalized), 'id');
        report.migrated.restores += 1;
      }

      for (const item of blacklist) {
        await upsert(db, 'global_blacklist', toBlacklistRow(item), 'user_id');
        report.migrated.blacklist += 1;
        const evidenceItems = await source.listBlacklistEvidence(item.userId);
        for (const [index, evidence] of evidenceItems.entries()) {
          const normalized = normalizeBlacklistEvidence({
            ...evidence,
            attachmentUrl: evidence.attachmentUrl
              ?? evidence.attachment_url
              ?? evidence.fileUrl
              ?? evidence.file_url
          });
          if (!normalized.attachmentUrl) {
            throw new Error(`La evidencia ${index + 1} de ${item.userId} no tiene attachmentUrl/fileUrl.`);
          }
          const sourceKey = evidence.id
            ? `legacy-evidence-${item.userId}-${String(evidence.id)}`
            : stableId('json-evidence', [item.userId, index, normalized.createdAt, normalized.attachmentUrl, normalized.description]);
          await upsert(db, 'global_blacklist_evidence', {
            user_id: normalized.userId,
            ban_code: normalized.banCode,
            attachment_url: normalized.attachmentUrl,
            proxy_url: normalized.proxyUrl,
            file_name: normalized.fileName,
            content_type: normalized.contentType,
            description: normalized.description,
            created_by: normalized.createdBy,
            source_key: sourceKey,
            created_at: normalized.createdAt
          }, 'source_key');
          report.migrated.blacklistEvidence += 1;
        }
      }

      for (const [key, item] of Object.entries(rawPurchases)) {
        if (!item || typeof item !== 'object') continue;
        const purchase = normalizePremiumPurchase({
          ...item,
          id: item.id ?? stableId('json-purchase', [key, item.providerSessionId, item.createdAt, item.discordUserId])
        });
        await upsert(db, 'premium_purchases', toPremiumPurchaseRow(purchase), 'id');
        report.migrated.purchases += 1;
      }

      for (const [key, item] of Object.entries(rawActivations)) {
        if (!item || typeof item !== 'object') continue;
        const activation = normalizePremiumActivation({
          ...item,
          id: item.id ?? stableId('json-activation', [key, item.guildId, item.purchaseId, item.createdAt])
        });
        if (!activation.purchaseId) {
          throw new Error(`La activación ${activation.id} no tiene purchaseId; no la importo silenciosamente.`);
        }
        await upsert(db, 'premium_slot_activations', toPremiumActivationRow(activation), 'id');
        report.migrated.activations += 1;
      }

      for (const [key, item] of Object.entries(affiliates.profiles ?? {})) {
        if (!item || typeof item !== 'object') continue;
        const input = {
          ...item,
          discordUserId: item.discordUserId ?? item.discord_user_id ?? key
        };
        input.code = input.code || generateAffiliateCode(input.username ?? input.discordUserId, input.discordUserId);
        const profile = normalizeAffiliateProfile(input);
        if (!profile.discordUserId || !profile.code) {
          throw new Error(`Perfil de afiliado inválido en ${key}.`);
        }
        await upsert(db, 'affiliate_profiles', toAffiliateProfileRow(profile), 'discord_user_id');
        report.migrated.affiliateProfiles += 1;
      }

      for (const [key, item] of Object.entries(affiliates.redemptions ?? {})) {
        if (!item || typeof item !== 'object') continue;
        const input = {
          ...item,
          id: item.id ?? stableId('json-redemption', [key, item.guildId, item.guild_id, item.createdAt]),
          guildId: item.guildId ?? item.guild_id ?? key,
          ownerDiscordUserId: item.ownerDiscordUserId
            ?? item.owner_discord_user_id
            ?? item.referrerUserId
            ?? item.referrer_user_id,
          code: item.code ?? item.affiliateCode ?? item.affiliate_code
        };
        const redemption = normalizeAffiliateRedemption(input);
        if (!redemption.ownerDiscordUserId || !redemption.guildId) {
          throw new Error(`Redención de afiliado inválida en ${key}.`);
        }
        const existing = await db.query(
          'SELECT id FROM public.affiliate_redemptions WHERE guild_id = $1 LIMIT 1',
          [redemption.guildId]
        );
        const row = toAffiliateRedemptionRow({
          ...redemption,
          id: existing.rows[0]?.id ?? redemption.id
        });
        await upsert(db, 'affiliate_redemptions', row, 'id');
        report.migrated.affiliateRedemptions += 1;
      }
    } finally {
      target.client = originalClient;
    }
  });

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('ERROR:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await target.client.close();
}

function resolveDataDir(value) {
  const raw = String(value ?? './data');
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

async function assertDataDirectory(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`DATA_DIR no existe o no es un directorio: ${directory}`);
  }
}

async function listPresentJsonFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

async function readJson(filePath, fallback = {}) {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function assertPostgresSchema(db) {
  const required = [
    'affiliate_profiles',
    'affiliate_redemptions',
    'ai_quality_signals',
    'global_blacklist',
    'global_blacklist_evidence',
    'guild_backup_restores',
    'guild_backups',
    'guild_configs',
    'guild_logs',
    'premium_purchases',
    'premium_slot_activations',
    'ticket_feedback',
    'tickets',
    'transcript_messages'
  ];
  const result = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1::text[])",
    [required]
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = required.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Faltan tablas PostgreSQL: ${missing.join(', ')}. Ejecuta npm run db:setup primero.`);
  }

  const column = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'global_blacklist_evidence' AND column_name = 'source_key'"
  );
  if (column.rowCount !== 1) {
    throw new Error('Falta global_blacklist_evidence.source_key. Ejecuta npm run db:setup de nuevo.');
  }
}

async function insert(db, table, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const values = columns.map((column) => prepareJsonValue(table, column, row[column]));
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  await db.query(
    `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders.join(', ')})`,
    values
  );
}

async function upsert(db, table, row, onConflict) {
  const result = await db.from(table).upsert(row, { onConflict }).select().single();
  if (result.error) throw result.error;
  return result.data;
}

function prepareJsonValue(table, column, value) {
  const jsonColumns = {
    guild_configs: new Set(['panels']),
    tickets: new Set(['exam_state']),
    guild_logs: new Set(['metadata']),
    premium_purchases: new Set(['metadata']),
    guild_backups: new Set(['summary', 'snapshot']),
    guild_backup_restores: new Set(['summary'])
  };
  return jsonColumns[table]?.has(column) && value !== null && value !== undefined
    ? JSON.stringify(value)
    : value ?? null;
}

function buildTranscriptRows(store) {
  const occurrences = new Map();
  const rows = [];
  for (const [storeChannelId, messages] of Object.entries(store ?? {})) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const channelId = String(message?.channelId ?? message?.channel_id ?? storeChannelId);
      const createdAt = message?.createdAt ?? message?.created_at ?? new Date().toISOString();
      const content = String(message?.content ?? '');
      const fingerprint = [
        channelId,
        message?.messageId ?? message?.message_id ?? '',
        createdAt,
        message?.authorId ?? message?.author_id ?? '',
        message?.authorName ?? message?.author_name ?? '',
        message?.role ?? '',
        content
      ].join('\u001f');
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      const sourceMessageId = message?.messageId ?? message?.message_id;
      const messageId = sourceMessageId
        ? String(sourceMessageId)
        : stableId('json-migration', [fingerprint, occurrence]);
      rows.push({
        channel_id: channelId,
        guild_id: message?.guildId ?? message?.guild_id ?? null,
        message_id: messageId,
        author_id: message?.authorId ?? message?.author_id ?? null,
        author_name: message?.authorName ?? message?.author_name ?? null,
        author_bot: message?.authorBot ?? message?.author_bot ?? false,
        role: message?.role ?? null,
        content,
        created_at: createdAt
      });
    }
  }
  return rows;
}

function toGuildRow(guild = {}) {
  const panelStore = {
    panels: guild.panels ?? [],
    components: guild.components ?? [],
    security: guild.security ?? {},
    premium: guild.premium ?? {},
    autoConfig: guild.autoConfig ?? {},
    growth: guild.growth ?? {},
    welcome: guild.welcome ?? {},
    alliance: {
      channelId: guild.allianceChannelId ?? guild.alliance_channel_id ?? null,
      channelName: guild.allianceChannelName ?? guild.alliance_channel_name ?? null,
      template: guild.allianceTemplate ?? guild.alliance_template ?? null
    },
    allianceDetection: guild.allianceDetection ?? {},
    install: {
      addedByUserId: guild.addedByUserId ?? guild.added_by_user_id ?? null,
      addedByUsername: guild.addedByUsername ?? guild.added_by_username ?? null,
      addedAt: guild.addedAt ?? guild.added_at ?? null,
      detectedAt: guild.addedByDetectedAt ?? guild.detectedAt ?? guild.detected_at ?? null
    },
    discovery: guild.discovery ?? {},
    watchedTicketCategories: guild.watchedTicketCategories ?? guild.watched_ticket_categories ?? [],
    ticketClosePolicy: guild.ticketClosePolicy ?? guild.ticket_close_policy ?? {},
    scheduledAnnouncements: guild.scheduledAnnouncements ?? guild.scheduled_announcements ?? []
  };
  return {
    guild_id: String(guild.guildId ?? guild.guild_id ?? ''),
    guild_name: guild.guildName ?? guild.guild_name ?? null,
    ticket_category_id: guild.ticketCategoryId ?? guild.ticket_category_id ?? null,
    ticket_category_name: guild.ticketCategoryName ?? guild.ticket_category_name ?? null,
    staff_role_id: guild.staffRoleId ?? guild.staff_role_id ?? null,
    server_prompt: guild.serverPrompt ?? guild.server_prompt ?? null,
    server_info: guild.serverInfo ?? guild.server_info ?? null,
    plan: guild.plan ?? 'free',
    voice_support_enabled: guild.voiceSupportEnabled ?? guild.voice_support_enabled ?? false,
    voice_category_id: guild.voiceCategoryId ?? guild.voice_category_id ?? null,
    voice_category_name: guild.voiceCategoryName ?? guild.voice_category_name ?? null,
    panels: panelStore,
    updated_at: guild.updatedAt ?? guild.updated_at ?? new Date().toISOString()
  };
}

function toTicketRow(ticket = {}) {
  const now = new Date().toISOString();
  return {
    channel_id: String(ticket.channelId ?? ticket.channel_id ?? ''),
    guild_id: String(ticket.guildId ?? ticket.guild_id ?? ''),
    guild_name: ticket.guildName ?? ticket.guild_name ?? null,
    channel_name: ticket.channelName ?? ticket.channel_name ?? null,
    category_id: ticket.categoryId ?? ticket.category_id ?? null,
    opened_by: ticket.openedBy ?? ticket.opened_by ?? null,
    voice_channel_id: ticket.voiceChannelId ?? ticket.voice_channel_id ?? null,
    voice_channel_name: ticket.voiceChannelName ?? ticket.voice_channel_name ?? null,
    voice_created_at: ticket.voiceCreatedAt ?? ticket.voice_created_at ?? null,
    status: ticket.status ?? 'open',
    ai_disabled: ticket.aiDisabled ?? ticket.ai_disabled ?? ticket.status === 'ai_disabled',
    ai_disabled_by: ticket.aiDisabledBy ?? ticket.ai_disabled_by ?? null,
    ai_disabled_at: ticket.aiDisabledAt ?? ticket.ai_disabled_at ?? null,
    exam_state: ticket.examState ?? ticket.exam_state ?? null,
    created_at: ticket.createdAt ?? ticket.created_at ?? now,
    updated_at: ticket.updatedAt ?? ticket.updated_at ?? now
  };
}

function toFeedbackRow(item = {}) {
  return {
    id: String(item.id),
    guild_id: item.guildId ?? item.guild_id ?? null,
    guild_name: item.guildName ?? item.guild_name ?? null,
    channel_id: item.channelId ?? item.channel_id ?? null,
    channel_name: item.channelName ?? item.channel_name ?? null,
    user_id: item.userId ?? item.user_id ?? null,
    username: item.username ?? null,
    rating: item.rating,
    comment: item.comment ?? null,
    source: item.source ?? 'dm_rating',
    public_review_posted: item.publicReviewPosted ?? item.public_review_posted ?? false,
    created_at: item.createdAt ?? item.created_at ?? new Date().toISOString()
  };
}

function toAiQualitySignalRow(item = {}) {
  return {
    id: String(item.id),
    guild_id: item.guildId ?? item.guild_id ?? '',
    guild_name: item.guildName ?? item.guild_name ?? null,
    channel_id: item.channelId ?? item.channel_id ?? '',
    channel_name: item.channelName ?? item.channel_name ?? null,
    message_id: item.messageId ?? item.message_id ?? null,
    user_id: item.userId ?? item.user_id ?? null,
    username: item.username ?? null,
    category: item.category ?? 'general',
    severity: item.severity ?? 'medium',
    sentiment: item.sentiment ?? null,
    confidence: item.confidence ?? 70,
    reason: item.reason ?? null,
    user_message: item.userMessage ?? item.user_message ?? '',
    previous_ai_message: item.previousAiMessage ?? item.previous_ai_message ?? null,
    detected_by: item.detectedBy ?? item.detected_by ?? 'ai',
    resolved: item.resolved ?? false,
    created_at: item.createdAt ?? item.created_at ?? new Date().toISOString()
  };
}

function toGuildLogRow(entry = {}) {
  return {
    id: String(entry.id),
    guild_id: String(entry.guildId ?? entry.guild_id ?? ''),
    guild_name: entry.guildName ?? entry.guild_name ?? null,
    type: entry.type ?? 'system',
    severity: entry.severity ?? 'info',
    title: String(entry.title ?? 'Evento NexaDesk'),
    message: entry.message ?? entry.description ?? '',
    actor_id: entry.actorId ?? entry.actor_id ?? null,
    actor_name: entry.actorName ?? entry.actor_name ?? null,
    target_id: entry.targetId ?? entry.target_id ?? null,
    target_name: entry.targetName ?? entry.target_name ?? null,
    channel_id: entry.channelId ?? entry.channel_id ?? null,
    channel_name: entry.channelName ?? entry.channel_name ?? null,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
    created_at: entry.createdAt ?? entry.created_at ?? new Date().toISOString()
  };
}

function toPremiumPurchaseRow(item) {
  return {
    id: item.id,
    discord_user_id: item.discordUserId,
    buyer_username: item.buyerUsername,
    provider: item.provider,
    provider_session_id: item.providerSessionId,
    provider_payment_intent_id: item.providerPaymentIntentId,
    amount_total: item.amountTotal,
    currency: item.currency,
    slots_purchased: item.slotsPurchased,
    slots_used: item.slotsUsed,
    status: item.status,
    metadata: item.metadata ?? {},
    expires_at: item.expiresAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt
  };
}

function toPremiumActivationRow(item) {
  return {
    id: item.id,
    purchase_id: item.purchaseId,
    discord_user_id: item.discordUserId,
    guild_id: item.guildId,
    guild_name: item.guildName,
    activated_by: item.activatedBy,
    active: item.active !== false,
    expires_at: item.expiresAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt
  };
}

function toAffiliateProfileRow(item) {
  return {
    discord_user_id: item.discordUserId,
    username: item.username,
    code: item.code,
    reward_threshold: item.rewardThreshold,
    reward_slots: item.rewardSlots,
    reward_days: item.rewardDays,
    total_redemptions: item.totalRedemptions,
    rewards_earned: item.rewardsEarned,
    created_at: item.createdAt,
    updated_at: item.updatedAt
  };
}

function toAffiliateRedemptionRow(item) {
  return {
    id: item.id,
    code: item.code,
    owner_discord_user_id: item.ownerDiscordUserId,
    guild_id: item.guildId,
    guild_name: item.guildName,
    redeemed_by_user_id: item.redeemedByUserId,
    redeemed_by_username: item.redeemedByUsername,
    reward_granted: item.rewardGranted === true,
    reward_purchase_id: item.rewardPurchaseId,
    created_at: item.createdAt
  };
}

function toBlacklistRow(item = {}) {
  return {
    user_id: item.userId ?? item.user_id,
    ban_code: item.banCode ?? item.ban_code,
    reason: item.reason ?? 'Sin motivo especificado',
    duration: item.duration ?? 'permanente',
    expires_at: item.expiresAt ?? item.expires_at ?? null,
    active: item.active !== false,
    created_by: item.createdBy ?? item.created_by ?? null,
    created_at: item.createdAt ?? item.created_at ?? new Date().toISOString(),
    updated_at: item.updatedAt ?? item.updated_at ?? new Date().toISOString()
  };
}

function toGuildBackupRow(item) {
  return {
    id: item.id,
    guild_id: item.guildId,
    guild_name: item.guildName,
    captured_at: item.capturedAt,
    source: item.source,
    summary: item.summary ?? {},
    snapshot: item.snapshot ?? {},
    created_at: item.createdAt
  };
}

function toGuildBackupRestoreRow(item) {
  return {
    id: item.id,
    backup_id: item.backupId,
    source_guild_id: item.sourceGuildId,
    source_guild_name: item.sourceGuildName,
    target_guild_id: item.targetGuildId,
    target_guild_name: item.targetGuildName,
    requested_by: item.requestedBy,
    status: item.status,
    summary: item.summary ?? {},
    created_at: item.createdAt,
    completed_at: item.completedAt
  };
}

function normalizeRestore(item = {}) {
  const createdAt = item.createdAt ?? item.created_at ?? item.startedAt ?? new Date().toISOString();
  return {
    id: String(item.id),
    backupId: String(item.backupId ?? item.backup_id ?? ''),
    sourceGuildId: String(item.sourceGuildId ?? item.source_guild_id ?? ''),
    sourceGuildName: String(item.sourceGuildName ?? item.source_guild_name ?? 'Servidor origen'),
    targetGuildId: String(item.targetGuildId ?? item.target_guild_id ?? ''),
    targetGuildName: String(item.targetGuildName ?? item.target_guild_name ?? 'Servidor destino'),
    requestedBy: item.requestedBy ?? item.requested_by ?? null,
    status: ['completed', 'partial', 'failed'].includes(item.status) ? item.status : 'completed',
    summary: item.summary && typeof item.summary === 'object' ? item.summary : {},
    createdAt,
    completedAt: item.completedAt ?? item.completed_at ?? createdAt
  };
}

function stableId(prefix, parts) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
