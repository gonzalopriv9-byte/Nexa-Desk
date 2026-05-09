import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function normalizeTotpSecret(value = '') {
  return String(value)
    .replace(/\s+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
}

export function verifyTotpCode({ code, secret, window = 1, stepSeconds = 30, digits = 6 }) {
  const normalizedCode = String(code ?? '').replace(/\D/g, '');
  const normalizedSecret = normalizeTotpSecret(secret);
  if (!/^\d{6}$/.test(normalizedCode) || !normalizedSecret) return false;

  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateTotpCode({
      secret: normalizedSecret,
      counter: counter + offset,
      digits
    });
    if (safeEqual(normalizedCode, expected)) return true;
  }

  return false;
}

export function buildTotpUri({ secret, issuer = 'NexaDesk', account = 'owner' }) {
  const normalizedSecret = normalizeTotpSecret(secret);
  const label = `${issuer}:${account}`;
  const url = new URL(`otpauth://totp/${encodeURIComponent(label)}`);
  url.searchParams.set('secret', normalizedSecret);
  url.searchParams.set('issuer', issuer);
  url.searchParams.set('algorithm', 'SHA1');
  url.searchParams.set('digits', '6');
  url.searchParams.set('period', '30');
  return url.toString();
}

function generateTotpCode({ secret, counter, digits }) {
  const key = decodeBase32(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function decodeBase32(secret) {
  let bits = '';
  for (const char of normalizeTotpSecret(secret)) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error('DOCS_TOTP_SECRET must be valid base32.');
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
