const PREMIUM_PLANS = new Set(['pro', 'premium', 'enterprise']);

export function isPremiumEntitled(guildConfig = {}) {
  const expiresAt = guildConfig?.premiumExpiresAt ?? guildConfig?.premium?.expiresAt;
  if (isExpired(expiresAt)) return false;
  const plan = String(guildConfig?.plan ?? 'free').toLowerCase();
  return Boolean(guildConfig?.voiceSupportEnabled || PREMIUM_PLANS.has(plan));
}

export function normalizePremiumConfig(value = {}, guildConfig = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const entitled = isPremiumEntitled({ ...guildConfig, premium: source });

  return {
    enabled: entitled && source.enabled !== false,
    voiceSupport: source.voiceSupport !== false,
    priorityAi: source.priorityAi !== false,
    smartTranscripts: source.smartTranscripts !== false,
    securityPlus: source.securityPlus !== false,
    customBranding: Boolean(source.customBranding),
    weeklyInsights: source.weeklyInsights !== false,
    growthEngine: source.growthEngine !== false,
    publicReviews: source.publicReviews !== false,
    churnRadar: source.churnRadar !== false,
    conversionInsights: source.conversionInsights !== false,
    slaRadar: source.slaRadar !== false,
    autoSetupPlus: source.autoSetupPlus !== false,
    allianceAutomation: source.allianceAutomation !== false,
    teamAssist: source.teamAssist !== false,
    premiumAnalytics: source.premiumAnalytics !== false,
    affiliateBoost: source.affiliateBoost !== false,
    expiresAt: source.expiresAt ?? guildConfig?.premiumExpiresAt ?? null
  };
}

export function summarizePremiumConfig(guildConfig = {}) {
  const premium = normalizePremiumConfig(guildConfig.premium, guildConfig);
  const active = isPremiumEntitled(guildConfig);
  const features = [
    premium.voiceSupport ? 'Voz Pro' : null,
    premium.priorityAi ? 'IA prioritaria' : null,
    premium.smartTranscripts ? 'Transcripciones inteligentes' : null,
    premium.securityPlus ? 'Security Plus' : null,
    premium.customBranding ? 'Branding propio' : null,
    premium.weeklyInsights ? 'Informes semanales' : null,
    premium.growthEngine ? 'Growth Engine' : null,
    premium.publicReviews ? 'Reviews publicas' : null,
    premium.churnRadar ? 'Churn radar' : null,
    premium.conversionInsights ? 'Conversion insights' : null,
    premium.slaRadar ? 'SLA Radar' : null,
    premium.autoSetupPlus ? 'Auto-config Pro' : null,
    premium.allianceAutomation ? 'Alianzas Pro' : null,
    premium.teamAssist ? 'Team Assist' : null,
    premium.premiumAnalytics ? 'Analitica premium' : null,
    premium.affiliateBoost ? 'Affiliate Boost' : null
  ].filter(Boolean);

  return {
    active,
    plan: guildConfig.plan ?? 'free',
    features
  };
}

function isExpired(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}
