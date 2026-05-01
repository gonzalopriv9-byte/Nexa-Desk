import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const dataDir = process.env.DATA_DIR || './data';
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this migration.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const guilds = Object.values(await readJson('guilds.json', {}));
const tickets = Object.values(await readJson('tickets.json', {}));
const transcripts = await readJson('transcripts.json', {});
const transcriptMessages = Object.values(transcripts).flat();

await upsertRows('guild_configs', guilds.map(toGuildRow), 'guild_id');
await upsertRows('tickets', tickets.map(toTicketRow), 'channel_id');
await insertTranscriptMessages(transcriptMessages.map(toTranscriptRow));

console.log(`Migrated ${guilds.length} guild configs.`);
console.log(`Migrated ${tickets.length} tickets.`);
console.log(`Migrated ${transcriptMessages.length} transcript messages.`);

async function readJson(fileName, fallback) {
  try {
    const filePath = path.join(dataDir, fileName);
    return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function upsertRows(table, rows, onConflict) {
  if (!rows.length) return;

  for (const chunk of chunkRows(rows, 200)) {
    const { error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} migration failed: ${error.message}`);
  }
}

async function insertTranscriptMessages(rows) {
  if (!rows.length) return;

  for (const chunk of chunkRows(rows, 200)) {
    const { error } = await supabase
      .from('transcript_messages')
      .insert(chunk);
    if (error) throw new Error(`transcript_messages migration failed: ${error.message}`);
  }
}

function toGuildRow(guild) {
  return {
    guild_id: guild.guildId,
    guild_name: guild.guildName,
    ticket_category_id: guild.ticketCategoryId,
    ticket_category_name: guild.ticketCategoryName,
    staff_role_id: guild.staffRoleId,
    server_prompt: guild.serverPrompt,
    server_info: guild.serverInfo,
    panels: guild.panels ?? [],
    updated_at: guild.updatedAt ?? new Date().toISOString()
  };
}

function toTicketRow(ticket) {
  return {
    channel_id: ticket.channelId,
    guild_id: ticket.guildId,
    guild_name: ticket.guildName,
    channel_name: ticket.channelName,
    category_id: ticket.categoryId,
    opened_by: ticket.openedBy,
    status: ticket.status ?? 'open',
    ai_disabled: ticket.aiDisabled ?? ticket.status === 'ai_disabled',
    ai_disabled_by: ticket.aiDisabledBy,
    ai_disabled_at: ticket.aiDisabledAt,
    created_at: ticket.createdAt ?? new Date().toISOString(),
    updated_at: ticket.updatedAt ?? new Date().toISOString()
  };
}

function toTranscriptRow(message) {
  return {
    channel_id: message.channelId,
    guild_id: message.guildId,
    message_id: message.messageId,
    author_id: message.authorId,
    author_name: message.authorName,
    author_bot: message.authorBot ?? false,
    role: message.role,
    content: message.content,
    created_at: message.createdAt ?? new Date().toISOString()
  };
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
