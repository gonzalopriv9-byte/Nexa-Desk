import crypto from 'node:crypto';

export const ADMIN_CODE_ROLE_ID = '1499803857042280488';
export const ADMIN_CODE_TTL_MS = 10 * 60 * 1000;

const ADMIN_CODE_VERSION = 2;
const ADMIN_CODE_AAD = Buffer.from('nexadesk-admin-code-v2');

export function generateAdminCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function normalizeAdminCode(code) {
  return String(code ?? '').replace(/\D/g, '').slice(0, 6);
}

export function buildAdminAccessCode({ code, config, createdBy, createdByTag, guildId, issuer = 'dashboard' }) {
  const normalized = normalizeAdminCode(code);
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  return {
    version: ADMIN_CODE_VERSION,
    codeHash: hashAdminCode({ code: normalized, salt, config }),
    codeSalt: salt,
    encryptedCode: encryptAdminCode({ code: normalized, config }),
    issuer,
    createdBy,
    createdByTag,
    guildId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ADMIN_CODE_TTL_MS).toISOString(),
    usedAt: null
  };
}

export function inspectAdminAccessCode({ record, code, config }) {
  const normalized = normalizeAdminCode(code);
  if (!record) return { ok: false, reason: 'missing' };
  if (!normalized || normalized.length !== 6) return { ok: false, reason: 'malformed' };

  const status = getAdminAccessCodeStatus(record);
  if (status.state === 'used') return { ok: false, reason: 'used', status };
  if (status.state === 'expired') return { ok: false, reason: 'expired', status };
  if (status.state === 'invalid') return { ok: false, reason: 'invalid', status };

  const expected = hashAdminCode({ code: normalized, salt: record.codeSalt, config });
  const legacyExpected = hashLegacyAdminCode({ code: normalized, salt: record.codeSalt, config });
  if (!safeEqual(expected, record.codeHash) && !safeEqual(legacyExpected, record.codeHash)) {
    return { ok: false, reason: 'wrong', status };
  }

  return { ok: true, reason: 'ok', status, normalized };
}

export function verifyAdminAccessCode({ record, code, config }) {
  return inspectAdminAccessCode({ record, code, config }).ok;
}

export function getAdminAccessCodeStatus(record, now = Date.now()) {
  if (!record) return { state: 'missing', label: 'Sin codigo activo' };
  if (record.usedAt) {
    return {
      state: 'used',
      label: 'Codigo ya utilizado',
      usedAt: record.usedAt,
      expiresAt: record.expiresAt ?? null
    };
  }

  const expiresAtMs = Date.parse(record.expiresAt ?? '');
  if (!Number.isFinite(expiresAtMs)) {
    return { state: 'invalid', label: 'Codigo dañado', expiresAt: record.expiresAt ?? null };
  }
  if (now > expiresAtMs) {
    return {
      state: 'expired',
      label: 'Codigo caducado',
      expiresAt: record.expiresAt,
      secondsRemaining: 0
    };
  }

  return {
    state: 'active',
    label: 'Codigo activo',
    expiresAt: record.expiresAt,
    secondsRemaining: Math.max(0, Math.ceil((expiresAtMs - now) / 1000)),
    createdBy: record.createdBy ?? null,
    createdByTag: record.createdByTag ?? null,
    guildId: record.guildId ?? null
  };
}

export function canReuseAdminAccessCode({ record, config, createdBy }) {
  const status = getAdminAccessCodeStatus(record);
  if (status.state !== 'active') return false;
  if (record.createdBy !== createdBy) return false;
  return Boolean(getAdminAccessCodeValue({ record, config }));
}

export function getAdminAccessCodeValue({ record, config }) {
  if (!record?.encryptedCode) return '';
  const decrypted = decryptAdminCode({ encryptedCode: record.encryptedCode, config });
  const normalized = normalizeAdminCode(decrypted);
  return normalized.length === 6 ? normalized : '';
}

function encryptAdminCode({ code, config }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAdminCodeKey(config), iv);
  cipher.setAAD(ADMIN_CODE_AAD);
  const encrypted = Buffer.concat([cipher.update(normalizeAdminCode(code), 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64')
  };
}

function decryptAdminCode({ encryptedCode, config }) {
  try {
    if (!encryptedCode?.iv || !encryptedCode?.tag || !encryptedCode?.value) return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getAdminCodeKey(config),
      Buffer.from(encryptedCode.iv, 'base64')
    );
    decipher.setAAD(ADMIN_CODE_AAD);
    decipher.setAuthTag(Buffer.from(encryptedCode.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedCode.value, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function hashAdminCode({ code, salt, config }) {
  return crypto
    .createHash('sha256')
    .update(`v2:${salt}:${normalizeAdminCode(code)}:${getAdminCodeSecret(config)}`)
    .digest('hex');
}

function hashLegacyAdminCode({ code, salt, config }) {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${normalizeAdminCode(code)}:${config.SESSION_SECRET}`)
    .digest('hex');
}

function getAdminCodeKey(config) {
  return crypto.createHash('sha256').update(getAdminCodeSecret(config)).digest();
}

function getAdminCodeSecret(config) {
  return String(
    config.ADMIN_CODE_SECRET
      || config.DISCORD_TOKEN
      || config.DOCS_TOTP_SECRET
      || config.SESSION_SECRET
      || 'nexadesk-admin-dev-secret'
  );
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex');
  const right = Buffer.from(String(b ?? ''), 'hex');
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}
