import crypto from 'node:crypto';

export const ADMIN_CODE_ROLE_ID = '1499803857042280488';
export const ADMIN_CODE_TTL_MS = 5 * 60 * 1000;

export function generateAdminCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function normalizeAdminCode(code) {
  return String(code ?? '').replace(/\D/g, '').slice(0, 6);
}

export function buildAdminAccessCode({ code, config, createdBy, createdByTag, guildId }) {
  const normalized = normalizeAdminCode(code);
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  return {
    codeHash: hashAdminCode({ code: normalized, salt, config }),
    codeSalt: salt,
    createdBy,
    createdByTag,
    guildId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ADMIN_CODE_TTL_MS).toISOString(),
    usedAt: null
  };
}

export function verifyAdminAccessCode({ record, code, config }) {
  const normalized = normalizeAdminCode(code);
  if (!record || !normalized || normalized.length !== 6) return false;
  if (record.usedAt) return false;
  const expiresAt = Date.parse(record.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = hashAdminCode({ code: normalized, salt: record.codeSalt, config });
  return safeEqual(expected, record.codeHash);
}

function hashAdminCode({ code, salt, config }) {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${normalizeAdminCode(code)}:${config.SESSION_SECRET}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex');
  const right = Buffer.from(String(b ?? ''), 'hex');
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}
