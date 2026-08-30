import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonStorage, PostgresStorage } from '../src/storage.js';

const dataDir = process.env.DATA_DIR || './data';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Configura DATABASE_URL antes de migrar.');

const source = new JsonStorage(dataDir);
await source.init();
const target = new PostgresStorage({
  connectionString: databaseUrl,
  poolMax: Number(process.env.DATABASE_POOL_MAX || 5),
  connectTimeoutMs: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 8000)
});

const report = { guilds: 0, tickets: 0, transcripts: 0, feedback: 0, aiQualitySignals: 0, guildLogs: 0, backups: 0, restores: 0, blacklist: 0, blacklistEvidence: 0, purchases: 0, activations: 0, affiliateProfiles: 0, affiliateRedemptions: 0 };
try {
  await target.init();

  const settings = await source.getGlobalSettings();
  if (settings && Object.keys(settings).length) await target.updateGlobalSettings(settings);

  const guilds = await source.listGuildConfigs();
  for (const guild of guilds) { await target.upsertGuildConfig(guild.guildId, guild); report.guilds += 1; }

  const tickets = await source.listTickets();
  for (const ticket of tickets) { await target.createTicket(ticket); report.tickets += 1; }

  const transcriptStore = await readJson('transcripts.json', {});
  const messages = dedupeTranscriptMessages(Object.values(transcriptStore).flat());
  const existingTranscriptKeys = new Set((await target.client.query('SELECT channel_id, message_id FROM public.transcript_messages WHERE message_id IS NOT NULL')).rows.map((row) => transcriptKey(row)));
  for (const message of messages) {
    const key = transcriptKey({ channel_id: message.channelId, message_id: message.messageId });
    if (key && existingTranscriptKeys.has(key)) continue;
    await target.addTranscriptMessage(message);
    if (key) existingTranscriptKeys.add(key);
    report.transcripts += 1;
  }

  for (const item of await source.listTicketFeedback()) { await target.addTicketFeedback(item); report.feedback += 1; }
  for (const item of await source.listAiQualitySignals()) { await target.addAiQualitySignal(item); report.aiQualitySignals += 1; }

  const logStore = await readJson('guild-logs.json', {});
  const existingLogIds = new Set((await target.client.query('SELECT id FROM public.guild_logs')).rows.map((row) => String(row.id)));
  for (const entries of Object.values(logStore)) for (const item of entries) {
    if (existingLogIds.has(String(item.id))) continue;
    await target.addGuildLog(item); existingLogIds.add(String(item.id)); report.guildLogs += 1;
  }

  for (const item of await source.listGuildBackupSnapshots([], { limit: 500 })) { await target.saveGuildBackupSnapshot(item); report.backups += 1; }
  for (const item of await source.listGuildBackupRestores([], { limit: 500 })) { await target.recordGuildBackupRestore(item); report.restores += 1; }

  for (const item of await source.listBlacklistEntries()) { await target.upsertBlacklistEntry(item); report.blacklist += 1; for (const evidence of await source.listBlacklistEvidence(item.userId)) { await target.addBlacklistEvidence(evidence); report.blacklistEvidence += 1; } }

  const purchases = Object.values(await readJson('premium-purchases.json', {}));
  for (const item of purchases) { await target.recordPremiumPurchase(item); report.purchases += 1; }
  const activations = Object.values(await readJson('premium-activations.json', {}));
  for (const item of activations) {
    const result = await target.client.from('premium_slot_activations').upsert(toPremiumActivationRow(item), { onConflict: 'id' });
    if (result.error) throw result.error;
    report.activations += 1;
  }

  const affiliates = settings?.affiliates ?? {};
  for (const item of Object.values(affiliates.profiles ?? {})) { const result = await target.client.from('affiliate_profiles').upsert(toAffiliateProfileRow(item), { onConflict: 'discord_user_id' }); if (result.error) throw result.error; report.affiliateProfiles += 1; }
  for (const item of Object.values(affiliates.redemptions ?? {})) { const result = await target.client.from('affiliate_redemptions').upsert(toAffiliateRedemptionRow(item), { onConflict: 'id' }); if (result.error) throw result.error; report.affiliateRedemptions += 1; }

  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await target.client.close();
}

async function readJson(fileName, fallback) {
  try { return JSON.parse((await fs.readFile(path.join(dataDir, fileName), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function dedupeTranscriptMessages(messages) {
  const seen = new Set(); const result = [];
  for (const message of messages) { const key = transcriptKey({ channel_id: message.channelId, message_id: message.messageId }); if (key && seen.has(key)) continue; if (key) seen.add(key); result.push(message); }
  return result;
}

function transcriptKey(row) { return row.channel_id && row.message_id ? String(row.channel_id) + ':' + String(row.message_id) : null; }
function toPremiumActivationRow(item) { return { id: item.id, purchase_id: item.purchaseId, discord_user_id: item.discordUserId, guild_id: item.guildId, guild_name: item.guildName, activated_by: item.activatedBy, active: item.active !== false, expires_at: item.expiresAt, created_at: item.createdAt, updated_at: item.updatedAt }; }
function toAffiliateProfileRow(item) { return { discord_user_id: item.discordUserId, username: item.username, code: item.code, reward_threshold: item.rewardThreshold ?? 7, reward_slots: item.rewardSlots ?? 1, reward_days: item.rewardDays ?? 30, total_redemptions: item.totalRedemptions ?? 0, rewards_earned: item.rewardsEarned ?? 0, created_at: item.createdAt, updated_at: item.updatedAt }; }
function toAffiliateRedemptionRow(item) { return { id: item.id, code: item.code, owner_discord_user_id: item.ownerDiscordUserId, guild_id: item.guildId, guild_name: item.guildName, redeemed_by_user_id: item.redeemedByUserId, redeemed_by_username: item.redeemedByUsername, reward_granted: item.rewardGranted === true, reward_purchase_id: item.rewardPurchaseId, created_at: item.createdAt }; }
