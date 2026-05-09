import crypto from 'node:crypto';
import { buildTotpUri } from '../src/docs-auth.js';

const issuer = process.argv[2] || 'NexaDesk';
const account = process.argv[3] || 'owner@nexadesk';
const secret = encodeBase32(crypto.randomBytes(20));

console.log(`DOCS_TOTP_SECRET=${secret}`);
console.log(`otpauth_uri=${buildTotpUri({ secret, issuer, account })}`);
console.log('Add the secret to Render and the Pi env, then add the otpauth URI manually in Google Authenticator.');

function encodeBase32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');

  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += alphabet[Number.parseInt(chunk, 2)];
  }
  return output;
}
