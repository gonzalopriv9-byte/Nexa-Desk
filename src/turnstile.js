const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function isTurnstileConfigured(config = {}) {
  return Boolean(
    String(config.TURNSTILE_SITE_KEY ?? '').trim()
    && String(config.TURNSTILE_SECRET_KEY ?? '').trim()
  );
}

export async function verifyTurnstileToken({
  config,
  token,
  remoteIp,
  expectedAction = 'login'
} = {}) {
  if (!isTurnstileConfigured(config)) {
    return { ok: false, reason: 'not_configured' };
  }

  const responseToken = String(token ?? '').trim();
  if (!responseToken) {
    return { ok: false, reason: 'missing-token' };
  }

  const body = new URLSearchParams({
    secret: String(config.TURNSTILE_SECRET_KEY).trim(),
    response: responseToken
  });

  if (remoteIp) {
    body.set('remoteip', String(remoteIp));
  }

  const configuredTimeout = Number(config.TURNSTILE_VERIFY_TIMEOUT_MS ?? 5000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1000, configuredTimeout)
    : 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, reason: 'provider-http' };
    }

    let result;
    try {
      result = await response.json();
    } catch {
      return { ok: false, reason: 'malformed-response' };
    }

    if (result?.success !== true) {
      return {
        ok: false,
        reason: 'invalid-token',
        errorCodes: Array.isArray(result?.['error-codes'])
          ? result['error-codes'].slice(0, 5)
          : []
      };
    }

    if (expectedAction && result.action !== expectedAction) {
      return { ok: false, reason: 'action-mismatch' };
    }

    const hostname = String(result.hostname ?? '').trim().toLowerCase();
    const allowedHostnames = getAllowedHostnames(config);
    if (!hostname || (allowedHostnames.size > 0 && !allowedHostnames.has(hostname))) {
      return { ok: false, reason: 'hostname-mismatch' };
    }

    return {
      ok: true,
      action: result.action,
      hostname
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'provider-error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getAllowedHostnames(config = {}) {
  const publicUrl = String(config.DASHBOARD_PUBLIC_URL ?? '').trim();
  if (!publicUrl) return new Set();

  try {
    const hostname = new URL(publicUrl).hostname.toLowerCase();
    if (!hostname) return new Set();

    const hostnames = new Set([hostname]);
    if (hostname.startsWith('www.')) {
      hostnames.add(hostname.slice(4));
    } else {
      hostnames.add('www.' + hostname);
    }
    return hostnames;
  } catch {
    return new Set();
  }
}
