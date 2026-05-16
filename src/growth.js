export const DEFAULT_GROWTH_CONFIG = {
  enabled: true,
  feedbackDm: true,
  publicReviews: false,
  lowRatingAlerts: true,
  inviteCta: true,
  testimonialMinRating: 5,
  reviewChannelId: null,
  reviewChannelName: null
};

export function normalizeGrowthConfig(value = {}) {
  const source = value?.growth && typeof value.growth === 'object' ? value.growth : value;
  return {
    enabled: source?.enabled !== false,
    feedbackDm: source?.feedbackDm !== false,
    publicReviews: Boolean(source?.publicReviews),
    lowRatingAlerts: source?.lowRatingAlerts !== false,
    inviteCta: source?.inviteCta !== false,
    testimonialMinRating: clampRating(source?.testimonialMinRating ?? DEFAULT_GROWTH_CONFIG.testimonialMinRating),
    reviewChannelId: normalizeOptionalString(source?.reviewChannelId),
    reviewChannelName: normalizeOptionalString(source?.reviewChannelName)
  };
}

export function normalizeTicketFeedback(value = {}) {
  const rating = clampRating(value.rating);
  const createdAt = value.createdAt ?? new Date().toISOString();
  return {
    id: value.id ?? `feedback-${value.channelId ?? 'unknown'}-${value.userId ?? 'unknown'}-${createdAt}`,
    guildId: normalizeOptionalString(value.guildId),
    guildName: normalizeOptionalString(value.guildName),
    channelId: normalizeOptionalString(value.channelId),
    channelName: normalizeOptionalString(value.channelName),
    userId: normalizeOptionalString(value.userId),
    username: normalizeOptionalString(value.username),
    rating,
    comment: normalizeOptionalString(value.comment),
    source: normalizeOptionalString(value.source) ?? 'dm_rating',
    publicReviewPosted: Boolean(value.publicReviewPosted),
    createdAt
  };
}

export function buildFeedbackStats(feedback = []) {
  const ratings = feedback
    .map((item) => Number(item.rating))
    .filter((rating) => Number.isFinite(rating) && rating >= 1 && rating <= 5);
  const average = ratings.length
    ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10
    : 0;
  const promoters = ratings.filter((rating) => rating >= 4).length;
  const detractors = ratings.filter((rating) => rating <= 2).length;
  const promoterRate = ratings.length ? Math.round((promoters / ratings.length) * 100) : 0;
  return {
    feedbackCount: ratings.length,
    averageRating: average,
    promoterRate,
    detractors,
    promoters
  };
}

export function formatRatingStars(rating) {
  const safeRating = clampRating(rating);
  return `[${'+'.repeat(safeRating)}${'-'.repeat(5 - safeRating)}] ${safeRating}/5`;
}

function clampRating(value) {
  const rating = Number.parseInt(value, 10);
  if (!Number.isFinite(rating)) return 5;
  return Math.min(Math.max(rating, 1), 5);
}

function normalizeOptionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
