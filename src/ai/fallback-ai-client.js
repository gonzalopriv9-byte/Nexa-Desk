export class FallbackAiClient {
  constructor(providers = [], options = {}) {
    this.providers = providers.filter((provider) => provider?.client);
    this.timeouts = {
      generate: Number(options.generateTimeoutMs ?? options.timeoutMs ?? 6500),
      analyzeImages: Number(options.analyzeImagesTimeoutMs ?? 25000),
      transcribeAudio: Number(options.transcribeAudioTimeoutMs ?? 25000),
      synthesizeSpeech: Number(options.synthesizeSpeechTimeoutMs ?? 25000)
    };
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
      throw new Error(`No AI provider is configured for ${method}.`);
    }

    let lastError = null;
    for (const [index, provider] of candidates.entries()) {
      const startedAt = Date.now();
      try {
        const result = await withProviderTimeout(
          provider.client[method](input),
          this.timeouts[method],
          provider.name,
          method
        );
        if (method === 'generate' && typeof result === 'string' && !result.trim()) {
          const error = new Error(`empty_response: ${provider.name} returned no text`);
          error.code = 'empty_response';
          error.status = 502;
          throw error;
        }
        const elapsed = Date.now() - startedAt;
        if (method === 'generate' && elapsed > 5000) {
          console.warn(`AI ${method} provider ${provider.name} answered slowly in ${elapsed}ms.`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const elapsed = Date.now() - startedAt;
        console.warn(`AI ${method} provider ${provider.name} failed after ${elapsed}ms: ${compactAiError(error)}`);
        if (!shouldFallbackAiError(error) || index === candidates.length - 1) {
          throw decorateAiFallbackError(error, provider.name, method);
        }
        console.warn(`AI ${method} provider ${provider.name} hit a recoverable issue. Trying fallback provider.`);
      }
    }

    throw lastError ?? new Error(`No AI provider returned a response for ${method}.`);
  }
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

  return /api.?key|unauthori[sz]ed|forbidden|invalid.?key|clave|token|rate.?limit|quota|limit.*exceed|exceed.*limit|token.*exceed|exceed.*token|insufficient|temporar|timeout|timed out|overloaded|unavailable|tpm|rpm|aborted|provider_timeout|empty_response/.test(message);
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
  const message = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').slice(0, 260);
  return [status ? `status=${status}` : null, code ? `code=${code}` : null, message].filter(Boolean).join(' ');
}
