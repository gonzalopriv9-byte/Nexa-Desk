export const PREMIUM_PACK_NAME = 'NexaDesk Premium Pack';

export const DEFAULT_PREMIUM_MODULES = {
  enabled: true,
  voiceSupport: true,
  priorityAi: true,
  smartTranscripts: true,
  securityPlus: true,
  customBranding: true,
  weeklyInsights: true,
  growthEngine: true,
  publicReviews: true,
  churnRadar: true,
  conversionInsights: true
};

export function normalizePremiumPurchase(value = {}) {
  const slotsPurchased = clampInteger(value.slotsPurchased ?? value.slots_purchased ?? 3, 1, 100);
  const slotsUsed = clampInteger(value.slotsUsed ?? value.slots_used ?? 0, 0, slotsPurchased);
  const createdAt = value.createdAt ?? value.created_at ?? new Date().toISOString();

  return {
    id: String(value.id ?? value.providerSessionId ?? value.provider_session_id ?? `purchase-${Date.now()}`),
    discordUserId: String(value.discordUserId ?? value.discord_user_id ?? ''),
    buyerUsername: value.buyerUsername ?? value.buyer_username ?? null,
    provider: String(value.provider ?? 'stripe'),
    providerSessionId: value.providerSessionId ?? value.provider_session_id ?? null,
    providerPaymentIntentId: value.providerPaymentIntentId ?? value.provider_payment_intent_id ?? null,
    amountTotal: Number.isFinite(Number(value.amountTotal ?? value.amount_total)) ? Number(value.amountTotal ?? value.amount_total) : null,
    currency: String(value.currency ?? 'eur').toLowerCase(),
    slotsPurchased,
    slotsUsed,
    status: String(value.status ?? 'paid').toLowerCase(),
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
    createdAt,
    updatedAt: value.updatedAt ?? value.updated_at ?? createdAt
  };
}

export function normalizePremiumActivation(value = {}) {
  const createdAt = value.createdAt ?? value.created_at ?? value.activatedAt ?? value.activated_at ?? new Date().toISOString();

  return {
    id: String(value.id ?? `activation-${value.guildId ?? value.guild_id ?? Date.now()}`),
    purchaseId: String(value.purchaseId ?? value.purchase_id ?? ''),
    discordUserId: String(value.discordUserId ?? value.discord_user_id ?? ''),
    guildId: String(value.guildId ?? value.guild_id ?? ''),
    guildName: value.guildName ?? value.guild_name ?? null,
    activatedBy: value.activatedBy ?? value.activated_by ?? null,
    active: value.active !== false,
    createdAt,
    updatedAt: value.updatedAt ?? value.updated_at ?? createdAt
  };
}

export function summarizePremiumBilling({ purchases = [], activations = [] } = {}) {
  const activeActivations = activations
    .map(normalizePremiumActivation)
    .filter((activation) => activation.active);
  const usedByPurchase = new Map();
  for (const activation of activeActivations) {
    if (!activation.purchaseId) continue;
    usedByPurchase.set(activation.purchaseId, (usedByPurchase.get(activation.purchaseId) ?? 0) + 1);
  }

  const normalizedPurchases = purchases.map((purchase) => {
    const normalized = normalizePremiumPurchase(purchase);
    const computedUsed = usedByPurchase.get(normalized.id);
    return {
      ...normalized,
      slotsUsed: computedUsed ?? normalized.slotsUsed
    };
  });

  const paidPurchases = normalizedPurchases.filter(isUsablePremiumPurchase);
  const slotsPurchased = paidPurchases.reduce((total, purchase) => total + purchase.slotsPurchased, 0);
  const slotsUsed = Math.min(
    activeActivations.length,
    slotsPurchased || activeActivations.length
  );

  return {
    purchases: normalizedPurchases,
    activations: activeActivations,
    slotsPurchased,
    slotsUsed,
    slotsAvailable: Math.max(slotsPurchased - slotsUsed, 0)
  };
}

export function pickAvailablePremiumPurchase({ purchases = [], activations = [] } = {}) {
  const summary = summarizePremiumBilling({ purchases, activations });
  const usedByPurchase = new Map();
  for (const activation of summary.activations) {
    usedByPurchase.set(activation.purchaseId, (usedByPurchase.get(activation.purchaseId) ?? 0) + 1);
  }

  return summary.purchases
    .filter(isUsablePremiumPurchase)
    .find((purchase) => (usedByPurchase.get(purchase.id) ?? purchase.slotsUsed) < purchase.slotsPurchased) ?? null;
}

export function isUsablePremiumPurchase(purchase = {}) {
  const status = String(purchase.status ?? '').toLowerCase();
  return ['paid', 'complete', 'completed', 'succeeded', 'no_payment_required'].includes(status);
}

export function getPremiumCheckoutConfig(config) {
  const slots = clampInteger(config.PREMIUM_PACK_SLOTS, 1, 25);
  const priceCents = clampInteger(config.PREMIUM_PACK_PRICE_CENTS, 50, 100000);
  const currency = String(config.PREMIUM_PACK_CURRENCY || 'eur').toLowerCase();

  return {
    configured: Boolean(config.STRIPE_SECRET_KEY),
    slots,
    priceCents,
    currency,
    displayPrice: formatPriceCents(priceCents, currency)
  };
}

export function formatPriceCents(cents, currency = 'eur') {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: String(currency || 'eur').toUpperCase()
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${String(currency || 'eur').toUpperCase()}`;
  }
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}
