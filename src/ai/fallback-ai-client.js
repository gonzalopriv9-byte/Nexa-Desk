const MIN_PROVIDER_COOLDOWN_MS = 5000;
const MAX_PROVIDER_COOLDOWN_MS = 60 * 60 * 1000;

export class FallbackAiClient {
  constructor(providers = [], options = {}) {
    this.providers = providers.filter((provider) => provider?.client);
    this.timeouts = {
      generate: Number(options.generateTimeoutMs ?? options.timeoutMs ?? 6500),
      analyzeImages: Number(options.analyzeImagesTimeoutMs ?? 25000),
      transcribeAudio: Number(options.transcribeAudioTimeoutMs ?? 25000),
      synthesizeSpeech: Number(options.synthesizeSpeechTimeoutMs ?? 25000)
    };
    this.providerCooldownMs = Number(options.providerCooldownMs ?? 60000);
    this.providerCooldowns = new Map();
    this.providerFailureStreaks = new Map();
  }

  async generate(input) {
    return this.#runWithFallback('generate', input);
  }

  async analyzeImages(input) {
    return this.#runWithFallback('analyzeImages', input);
  }

  async transcribeAudio(input) {
    return this.#runWithFallback('transcribeAudio', input);
  }

  async synthesizeSpeech(input) {
    return this.#runWithFallback('synthesizeSpeech', input);
  }

  async #runWithFallback(method, input) {
    const candidates = this.providers.filter(({ client }) => typeof client?.[method] === 'function');
    if (!candidates.length) {
      throw new Error('No AI provider is configured for ' + method + '.');
    }

    const readyCandidates = candidates.filter(({ name }) => (this.providerCooldowns.get(name) ?? 0) <= Date.now());
    if (!readyCandidates.length) {
      const retryAfterMs = getNextProviderRetryAfterMs(candidates, this.providerCooldowns);
      const error = new Error('provider_backoff: all AI providers for ' + method + ' are cooling down; retry in ' + Math.ceil(retryAfterMs / 1000) + 's');
      error.code = 'provider_backoff';
      error.status = 429;
      error.retryAfterMs = retryAfterMs;
      console.warn('AI ' + method + ' backoff active; no provider called. Retry in ' + Math.ceil(retryAfterMs / 1000) + 's.');
      throw error;
    }

    let lastError = null;
    for (const [index, provider] of readyCandidates.entries()) {
      const startedAt = Date.now();
      try {
        const result = await withProviderTimeout(
          provider.client[method](input),
          this.timeouts[method],
          provider.name,
          method
        );
        if (method === 'generate' && typeof result === 'string' && !result.trim()) {
          const error = new Error('empty_response: ' + provider.name + ' returned no text');
          error.code = 'empty_response';
          error.status = 502;
          throw error;
        }
        this.providerCooldowns.delete(provider.name);
        this.providerFailureStreaks.delete(provider.name);
        const elapsed = Date.now() - startedAt;
        if (method === 'generate' && elapsed > 5000) {
          console.warn('AI ' + method + ' provider ' + provider.name + ' answered slowly in ' + elapsed + 'ms.');
        }
        return result;
      } catch (error) {
        lastError = error;
        const elapsed = Date.now() - startedAt;
        console.warn('AI ' + method + ' provider ' + provider.name + ' failed after ' + elapsed + 'ms: ' + compactAiError(error));
        const fallbackable = shouldFallbackAiError(error);
        if (fallbackable) {
          const retryAfterMs = getRetryAfterMs(error);
          const cooldownMs = this.#getCooldownMs(provider.name, retryAfterMs);
          this.providerCooldowns.set(provider.name, Date.now() + cooldownMs);
          console.warn('AI ' + method + ' provider ' + provider.name + ' cooldown=' + cooldownMs + 'ms' + (retryAfterMs > 0 ? ' retry-after=' + retryAfterMs + 'ms' : '') + '.');
        }
        if (!fallbackable || index === readyCandidates.length - 1) {
          throw decorateAiFallbackError(error, provider.name, method);
        }
        console.warn('AI ' + method + ' provider ' + provider.name + ' hit a recoverable issue. Trying fallback provider.');
      }
    }

    throw lastError ?? new Error('No AI provider returned a response for ' + method + '.');
  }

  #getCooldownMs(providerName, retryAfterMs) {
    const failures = (this.providerFailureStreaks.get(providerName) ?? 0) + 1;
    this.providerFailureStreaks.set(providerName, failures);
    const baseMs = Math.max(MIN_PROVIDER_COOLDOWN_MS, Number(this.providerCooldownMs) || 60000);
    const exponentialMs = Math.min(
      MAX_PROVIDER_COOLDOWN_MS,
      baseMs * (2 ** Math.min(failures - 1, 6))
    );
    const explicitMs = Number(retryAfterMs);
    if (Number.isFinite(explicitMs) && explicitMs > 0) {
      return Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(exponentialMs, explicitMs));
    }
    return Math.min(MAX_PROVIDER_COOLDOWN_MS, exponentialMs + Math.floor(Math.random() * 1000));
  }
}

function getNextProviderRetryAfterMs(candidates, cooldowns) {
  const now = Date.now();
  const timestamps = candidates
    .map(({ name }) => cooldowns.get(name) ?? 0)
    .filter((timestamp) => timestamp > now);
  if (!timestamps.length) return MIN_PROVIDER_COOLDOWN_MS;
  return Math.max(MIN_PROVIDER_COOLDOWN_MS, Math.min(...timestamps) - now);
}

function getRetryAfterMs(error) {
  const direct = Number(error?.retryAfterMs);
  if (Number.isFinite(direct) && direct > 0) return direct;

  for (const headers of [error?.headers, error?.response?.headers, error?.cause?.headers]) {
    const value = typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers?.['retry-after'] ?? headers?.['Retry-After'];
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  const text = [
    error?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
    error?.cause?.message
  ].filter(Boolean).join(' ');
  return parseRetryAfterText(text);
}

function parseRetryAfterText(value) {
  const match = String(value ?? '').replace(/\s+/g, ' ').match(
    /(?:try again in|retry(?:-after| in))\s*:?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i
  );
  if (!match || !match.slice(1).some(Boolean)) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function createAiProvider(name, client) {
  return { name, client };
}

function shouldFallbackAiError(error) {
  const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
  if ([401, 403, 408, 409, 413, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true;

  const message = [
    error?.code,
    error?.type,
    error?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.error?.type
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/google.?ai.?studio|invalid.?model|unsupported.*model/.test(message)) return true;

  return /api.?key|unauthori[sz]ed|forbidden|invalid.?key|clave|token|rate.?limit|quota|limit.*exceed|exceed.*limit|token.*exceed|exceed.*token|insufficient|temporar|timeout|timed out|overloaded|unavailable|tpm|rpm|aborted|provider_timeout|empty_response|failed\s+to\s+retrieve\s+media|model_not_found|does\s+not\s+exist|decommissioned/.test(message);
}

function decorateAiFallbackError(error, providerName, method) {
  if (error instanceof Error) {
    error.message = `AI ${method} failed on ${providerName}: ${error.message}`;
    return error;
  }
  return new Error(`AI ${method} failed on ${providerName}: ${String(error)}`);
}

function withProviderTimeout(promise, timeoutMs, providerName, method) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`provider_timeout: ${providerName} ${method} exceeded ${ms}ms`);
      error.code = 'provider_timeout';
      error.status = 504;
      reject(error);
    }, ms);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timeoutId));
}

function compactAiError(error) {
  const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
  const code = error?.code ?? error?.type ?? '';
  const message = String(error?.message ?? error ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\borg_[A-Za-z0-9_-]+\b/g, 'org_[redacted]')
    .slice(0, 260);
  return [status ? `status=${status}` : null, code ? `code=${code}` : null, message].filter(Boolean).join(' ');
}
