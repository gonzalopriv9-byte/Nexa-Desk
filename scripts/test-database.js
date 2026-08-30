import 'dotenv/config';
import { createPostgresClient } from '../src/postgres-client.js';

const expectedTables = [
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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no está configurada en .env.');
  process.exit(1);
}

const client = createPostgresClient(process.env.DATABASE_URL, {
  max: 2,
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 8000)
});

try {
  const connection = await client.query('SELECT current_user, current_database(), version()');
  console.log('Conexión correcta:');
  console.table(connection.rows.map(({ current_user, current_database }) => ({ current_user, current_database })));

  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const present = new Set(tables.rows.map((row) => row.table_name));
  const missing = expectedTables.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`Faltan tablas: ${missing.join(', ')}`);

  const counts = await client.query(`
    SELECT 'guild_configs' AS table_name, count(*)::INT AS rows FROM public.guild_configs
    UNION ALL SELECT 'tickets', count(*)::INT FROM public.tickets
    UNION ALL SELECT 'transcript_messages', count(*)::INT FROM public.transcript_messages
    UNION ALL SELECT 'guild_logs', count(*)::INT FROM public.guild_logs
    UNION ALL SELECT 'guild_backups', count(*)::INT FROM public.guild_backups
    ORDER BY table_name
  `);
  console.log('Filas principales:');
  console.table(counts.rows);

  const trigger = await client.query(`
    SELECT trigger_name
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'affiliate_redemptions'
      AND trigger_name = 'affiliate_redemptions_sync_profile_trigger'
  `);
  if (trigger.rowCount !== 1) throw new Error('No se encontró el trigger de afiliados.');

  console.log('OK: PostgreSQL está listo para NexaDesk.');
} catch (error) {
  console.error('ERROR:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await client.close();
}
