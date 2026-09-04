import assert from 'node:assert/strict';
import { isTurnstileConfigured, verifyTurnstileToken } from '../src/turnstile.js';

const config = {
  TURNSTILE_SITE_KEY: 'site-key',
  TURNSTILE_SECRET_KEY: 'secret-key',
  TURNSTILE_VERIFY_TIMEOUT_MS: 2000,
  DASHBOARD_PUBLIC_URL: 'https://nexa-desk.com'
};

assert.equal(isTurnstileConfigured(config), true);
assert.equal(isTurnstileConfigured({ TURNSTILE_SITE_KEY: 'site-key' }), false);
assert.deepEqual(await verifyTurnstileToken({ config, token: '' }), { ok: false, reason: 'missing-token' });

const originalFetch = globalThis.fetch;
try {
  let lastRequest;
  globalThis.fetch = async (url, options) => {
    lastRequest = { url, options };
    return {
      ok: true,
      async json() { return { success: true, action: 'login', hostname: 'nexa-desk.com' }; }
    };
  };

  const success = await verifyTurnstileToken({ config, token: 'response-token', remoteIp: '203.0.113.8' });
  assert.deepEqual(success, { ok: true, action: 'login', hostname: 'nexa-desk.com' });
  assert.equal(lastRequest.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(lastRequest.options.method, 'POST');
  const requestBody = new URLSearchParams(lastRequest.options.body);
  assert.equal(requestBody.get('secret'), 'secret-key');
  assert.equal(requestBody.get('response'), 'response-token');
  assert.equal(requestBody.get('remoteip'), '203.0.113.8');

  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { success: true, action: 'other-action', hostname: 'nexa-desk.com' }; }
  });
  assert.deepEqual(await verifyTurnstileToken({ config, token: 'response-token' }), { ok: false, reason: 'action-mismatch' });

  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { success: false, 'error-codes': ['invalid-input-response'] }; }
  });
  const invalid = await verifyTurnstileToken({ config, token: 'response-token' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-token');
  assert.deepEqual(invalid.errorCodes, ['invalid-input-response']);

  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { success: true, action: 'login', hostname: 'evil.example' }; }
  });
  assert.deepEqual(await verifyTurnstileToken({ config, token: 'response-token' }), { ok: false, reason: 'hostname-mismatch' });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Turnstile tests passed');
