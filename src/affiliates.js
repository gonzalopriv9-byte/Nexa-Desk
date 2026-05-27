import crypto from 'node:crypto';

export const AFFILIATE_DEFAULT_REWARD_THRESHOLD = 7;
export const AFFILIATE_DEFAULT_REWARD_SLOTS = 1;
export const AFFILIATE_DEFAULT_REWARD_DAYS = 30;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeAffiliateCode(value = '') {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 18);
}

export function generateAffiliateCode(username = '') {
  const prefix = normalizeAffiliateCode(username)
    .replace(/^NEXA/, '')
    .slice(0, 4)
    .padEnd(4, 'X');
  let suffix = '';
  for (let index = 0; index < 6; index += 1) {
    suffix += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return `NX${prefix}${suffix}`;
}

export function normalizeAffiliateProfile(value = {}) {
  const createdAt = value.createdAt ?? value.created_at ?? new Date().toISOString();
  const threshold = clampInteger(value.rewardThreshold ?? value.reward_threshold ?? AFFILIATE_DEFAULT_REWARD_THRESHOLD, 1, 100);
  const totalRedemptions = clampInteger(value.totalRedemptions ?? value.total_redemptions ?? 0, 0, 1_000_000);
  const rewardsEarned = clampInteger(value.rewardsEarned ?? value.rewards_earned ?? Math.floor(totalRedemptions / threshold), 0, 1_000_000);

  return {
    discordUserId: String(value.discordUserId ?? value.discord_user_id ?? ''),
    username: value.username ? String(value.username).slice(0, 120) : null,
    code: normalizeAffiliateCode(value.code),
    rewardThreshold: threshold,
    rewardSlots: clampInteger(value.rewardSlots ?? value.reward_slots ?? AFFILIATE_DEFAULT_REWARD_SLOTS, 1, 25),
    rewardDays: clampInteger(value.rewardDays ?? value.reward_days ?? AFFILIATE_DEFAULT_REWARD_DAYS, 1, 365),
    totalRedemptions,
    rewardsEarned,
    redemptionsUntilReward: totalRedemptions > 0 && totalRedemptions % threshold === 0
      ? 0
      : threshold - (totalRedemptions % threshold),
    createdAt,
    updatedAt: value.updatedAt ?? value.updated_at ?? createdAt
  };
}

export function normalizeAffiliateRedemption(value = {}) {
  const createdAt = value.createdAt ?? value.created_at ?? new Date().toISOString();
  return {
    id: String(value.id ?? `affiliate-${value.guildId ?? value.guild_id ?? Date.now()}`),
    code: normalizeAffiliateCode(value.code),
    ownerDiscordUserId: String(value.ownerDiscordUserId ?? value.owner_discord_user_id ?? ''),
    guildId: String(value.guildId ?? value.guild_id ?? ''),
    guildName: value.guildName ?? value.guild_name ?? null,
    redeemedByUserId: value.redeemedByUserId ?? value.redeemed_by_user_id ?? null,
    redeemedByUsername: value.redeemedByUsername ?? value.redeemed_by_username ?? null,
    rewardGranted: Boolean(value.rewardGranted ?? value.reward_granted ?? false),
    rewardPurchaseId: value.rewardPurchaseId ?? value.reward_purchase_id ?? null,
    createdAt
  };
}

export function buildAffiliateProgress(profile = {}) {
  const normalized = normalizeAffiliateProfile(profile);
  const remainder = normalized.totalRedemptions % normalized.rewardThreshold;
  const remaining = remainder === 0 && normalized.totalRedemptions > 0
    ? 0
    : normalized.rewardThreshold - remainder;
  return {
    ...normalized,
    currentCycle: normalized.totalRedemptions > 0 && remainder === 0
      ? Math.floor(normalized.totalRedemptions / normalized.rewardThreshold)
      : Math.floor(normalized.totalRedemptions / normalized.rewardThreshold) + 1,
    remainingForNextReward: remaining,
    progressInCycle: remainder || (normalized.totalRedemptions > 0 ? normalized.rewardThreshold : 0)
  };
}

export function addDays(date, days) {
  const base = date instanceof Date ? date : new Date(date);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base.toISOString();
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}
