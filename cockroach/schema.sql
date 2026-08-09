create table if not exists public.nexadesk_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default current_timestamp()
);

create table if not exists public.guild_configs (
  guild_id string primary key,
  guild_name string,
  ticket_category_id string,
  ticket_category_name string,
  staff_role_id string,
  server_prompt string,
  server_info string,
  plan string not null default 'free',
  voice_support_enabled bool not null default false,
  voice_category_id string,
  voice_category_name string,
  panels jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default current_timestamp()
);

create table if not exists public.tickets (
  channel_id string primary key,
  guild_id string not null,
  guild_name string,
  channel_name string,
  category_id string,
  opened_by string,
  voice_channel_id string,
  voice_channel_name string,
  voice_created_at timestamptz,
  status string not null default 'open',
  ai_disabled bool not null default false,
  ai_disabled_by string,
  ai_disabled_at timestamptz,
  exam_state jsonb,
  created_at timestamptz not null default current_timestamp(),
  updated_at timestamptz not null default current_timestamp()
);

create index if not exists tickets_guild_id_idx on public.tickets (guild_id);
create index if not exists tickets_created_at_idx on public.tickets (created_at desc);
create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_voice_channel_id_idx on public.tickets (voice_channel_id);

create table if not exists public.transcript_messages (
  id int8 primary key default unique_rowid(),
  channel_id string not null,
  guild_id string,
  message_id string,
  author_id string,
  author_name string,
  author_bot bool not null default false,
  role string,
  content string not null,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists transcript_messages_channel_id_idx on public.transcript_messages (channel_id);
create index if not exists transcript_messages_guild_id_idx on public.transcript_messages (guild_id);
create index if not exists transcript_messages_created_at_idx on public.transcript_messages (created_at);

create table if not exists public.global_blacklist (
  user_id string primary key,
  ban_code string not null unique,
  reason string not null,
  duration string not null default 'permanente',
  expires_at timestamptz,
  active bool not null default true,
  created_by string,
  created_at timestamptz not null default current_timestamp(),
  updated_at timestamptz not null default current_timestamp()
);

create table if not exists public.global_blacklist_evidence (
  id int8 primary key default unique_rowid(),
  user_id string not null,
  file_name string,
  file_url string not null,
  mime_type string,
  uploaded_by string,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists global_blacklist_evidence_user_id_idx on public.global_blacklist_evidence (user_id);

create table if not exists public.ticket_feedback (
  id string primary key,
  guild_id string not null,
  guild_name string,
  channel_id string,
  channel_name string,
  user_id string,
  username string,
  rating int4 not null,
  comment string,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists ticket_feedback_guild_id_idx on public.ticket_feedback (guild_id);
create index if not exists ticket_feedback_created_at_idx on public.ticket_feedback (created_at desc);

create table if not exists public.ai_quality_signals (
  id string primary key,
  guild_id string not null,
  guild_name string,
  channel_id string,
  channel_name string,
  user_id string,
  username string,
  content string,
  category string,
  severity string,
  sentiment string,
  confidence int4,
  reason string,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists ai_quality_signals_guild_id_idx on public.ai_quality_signals (guild_id);
create index if not exists ai_quality_signals_created_at_idx on public.ai_quality_signals (created_at desc);

create table if not exists public.guild_logs (
  id string primary key,
  guild_id string not null,
  guild_name string,
  type string not null,
  severity string not null default 'info',
  title string not null,
  message string,
  actor_id string,
  actor_name string,
  target_id string,
  target_name string,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists guild_logs_guild_id_idx on public.guild_logs (guild_id);
create index if not exists guild_logs_created_at_idx on public.guild_logs (created_at desc);
create index if not exists guild_logs_type_idx on public.guild_logs (type);

create table if not exists public.premium_purchases (
  id string primary key,
  discord_user_id string not null,
  buyer_username string,
  provider string not null,
  provider_session_id string,
  amount_total int8 not null default 0,
  currency string not null default 'eur',
  slots_purchased int4 not null default 0,
  slots_used int4 not null default 0,
  status string not null default 'pending',
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp(),
  updated_at timestamptz not null default current_timestamp()
);

create index if not exists premium_purchases_discord_user_id_idx on public.premium_purchases (discord_user_id);
create index if not exists premium_purchases_status_idx on public.premium_purchases (status);

create table if not exists public.premium_slot_activations (
  id string primary key,
  purchase_id string not null,
  discord_user_id string not null,
  guild_id string not null,
  guild_name string,
  activated_by string,
  expires_at timestamptz,
  created_at timestamptz not null default current_timestamp()
);

create unique index if not exists premium_slot_activations_guild_id_idx on public.premium_slot_activations (guild_id);
create index if not exists premium_slot_activations_discord_user_id_idx on public.premium_slot_activations (discord_user_id);

create table if not exists public.affiliate_profiles (
  discord_user_id string primary key,
  username string,
  code string not null unique,
  total_redemptions int4 not null default 0,
  reward_slots_granted int4 not null default 0,
  created_at timestamptz not null default current_timestamp(),
  updated_at timestamptz not null default current_timestamp()
);

create table if not exists public.affiliate_redemptions (
  guild_id string primary key,
  guild_name string,
  referrer_user_id string not null,
  referrer_username string,
  redeemed_by_user_id string,
  redeemed_by_username string,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists affiliate_redemptions_referrer_user_id_idx on public.affiliate_redemptions (referrer_user_id);

create table if not exists public.guild_backups (
  id string primary key,
  guild_id string not null,
  guild_name string,
  source string not null default 'scheduled',
  snapshot jsonb not null,
  created_at timestamptz not null default current_timestamp()
);

create index if not exists guild_backups_guild_id_idx on public.guild_backups (guild_id);
create index if not exists guild_backups_created_at_idx on public.guild_backups (created_at desc);

create table if not exists public.guild_backup_restores (
  id string primary key,
  source_guild_id string not null,
  target_guild_id string not null,
  requested_by string,
  status string not null default 'pending',
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default current_timestamp(),
  updated_at timestamptz not null default current_timestamp()
);

-- New V1.7-compatible guild JSON keys stored inside guild_configs.panels:
-- watchedTicketCategories: [{ id, name, primary }] max 2, second category requires Premium.
-- ticketClosePolicy: { mode: "opener_and_staff" | "staff_only", usersCanClose }.
-- scheduledAnnouncements: premium embed schedules with channelId, content, embed, nextRunAt and intervalHours.
