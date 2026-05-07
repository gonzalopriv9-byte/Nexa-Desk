export const XNPROTECT_BLACKLIST_CREDIT = 'Blacklist proporcionada por XN Protect. Todos los derechos reservados.';

const XNPROTECT_GLOBAL_BAN_URL = 'https://apis.ebixcloud.com/apis/xnprotect/banglobal';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_500;
const cache = new Map();

export async function checkXnProtectGlobalBan(userId) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!/^\d{17,20}$/.test(normalizedUserId)) {
    return {
      checked: false,
      blacklisted: false,
      error: 'Invalid Discord user id'
    };
  }

  const cached = cache.get(normalizedUserId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(XNPROTECT_GLOBAL_BAN_URL);
    url.searchParams.set('id', normalizedUserId);

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`XN Protect returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const data = payload?.response ?? {};
    const value = {
      checked: true,
      blacklisted: data.banglobal === true,
      reason: String(data.reason ?? '').trim(),
      proof: String(data.proof ?? '').trim(),
      since: data.dates?.since ?? null,
      expires: data.dates?.expires ?? null,
      raw: payload
    };

    cache.set(normalizedUserId, { cachedAt: Date.now(), value });
    return value;
  } catch (error) {
    return {
      checked: false,
      blacklisted: false,
      error: error?.name === 'AbortError' ? 'XN Protect request timed out' : String(error?.message ?? error)
    };
  } finally {
    clearTimeout(timeout);
  }
}
