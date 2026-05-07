export const GLOBAL_BLACKLIST_ADMIN_USER_ID = '1352652366330986526';
export const GLOBAL_BAN_CODE_PREFIX = 'baneo-global-';
export const SUPPORT_SERVER_URL = 'https://discord.gg/vVXbq7ePEZ';

export function buildGlobalBanCode(userId) {
  return `${GLOBAL_BAN_CODE_PREFIX}${String(userId ?? '').trim()}`;
}

export function normalizeBlacklistLookup(value) {
  const raw = String(value ?? '').trim();
  if (raw.startsWith(GLOBAL_BAN_CODE_PREFIX)) {
    return {
      userId: raw.slice(GLOBAL_BAN_CODE_PREFIX.length),
      banCode: raw
    };
  }
  return {
    userId: raw,
    banCode: buildGlobalBanCode(raw)
  };
}

export function parseBlacklistDuration(value = 'permanente') {
  const raw = String(value || 'permanente').trim();
  const lower = raw.toLowerCase();
  if (!raw || ['permanente', 'permanent', 'indefinido', 'indefinida', 'forever'].includes(lower)) {
    return {
      duration: 'permanente',
      expiresAt: null
    };
  }

  const match = lower.match(/^(\d+)\s*(min|m|h|d|dia|dias|w|semana|semanas|mes|meses)$/);
  if (!match) {
    return {
      duration: raw,
      expiresAt: null
    };
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    min: 60_000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    dia: 24 * 60 * 60_000,
    dias: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
    semana: 7 * 24 * 60 * 60_000,
    semanas: 7 * 24 * 60 * 60_000,
    mes: 30 * 24 * 60 * 60_000,
    meses: 30 * 24 * 60 * 60_000
  };

  return {
    duration: raw,
    expiresAt: new Date(Date.now() + amount * multipliers[unit]).toISOString()
  };
}

export function normalizeBlacklistEntry(entry = {}) {
  const lookup = normalizeBlacklistLookup(entry.userId ?? entry.user_id ?? entry.banCode ?? entry.ban_code);
  const parsedDuration = parseBlacklistDuration(entry.duration);
  return {
    userId: lookup.userId,
    banCode: entry.banCode ?? entry.ban_code ?? lookup.banCode,
    reason: String(entry.reason ?? entry.motivo ?? 'Sin motivo especificado').slice(0, 1000),
    duration: parsedDuration.duration,
    expiresAt: entry.expiresAt ?? entry.expires_at ?? parsedDuration.expiresAt,
    active: entry.active ?? true,
    createdBy: entry.createdBy ?? entry.created_by,
    createdAt: entry.createdAt ?? entry.created_at ?? new Date().toISOString(),
    updatedAt: entry.updatedAt ?? entry.updated_at ?? new Date().toISOString()
  };
}

export function normalizeBlacklistEvidence(evidence = {}) {
  const lookup = normalizeBlacklistLookup(evidence.userId ?? evidence.user_id ?? evidence.banCode ?? evidence.ban_code);
  return {
    id: evidence.id,
    userId: lookup.userId,
    banCode: evidence.banCode ?? evidence.ban_code ?? lookup.banCode,
    attachmentUrl: evidence.attachmentUrl ?? evidence.attachment_url,
    proxyUrl: evidence.proxyUrl ?? evidence.proxy_url,
    fileName: evidence.fileName ?? evidence.file_name,
    contentType: evidence.contentType ?? evidence.content_type,
    description: evidence.description ?? '',
    createdBy: evidence.createdBy ?? evidence.created_by,
    createdAt: evidence.createdAt ?? evidence.created_at ?? new Date().toISOString()
  };
}

export function isBlacklistEntryActive(entry, now = Date.now()) {
  const normalized = normalizeBlacklistEntry(entry);
  if (!normalized.active) return false;
  if (!normalized.expiresAt) return true;
  return new Date(normalized.expiresAt).getTime() > now;
}
