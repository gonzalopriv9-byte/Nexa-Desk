export class FallbackAiClient {
  constructor(providers = []) {
    this.providers = providers.filter((provider) => provider?.client);
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
      try {
        return await provider.client[method](input);
      } catch (error) {
        lastError = error;
        if (!shouldFallbackAiError(error) || index === candidates.length - 1) {
          throw decorateAiFallbackError(error, provider.name, method);
        }
        console.warn(`AI ${method} provider ${provider.name} hit a recoverable limit. Trying fallback provider.`);
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
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true;

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

  return /rate.?limit|quota|limit.*exceed|exceed.*limit|token.*exceed|exceed.*token|insufficient|temporar|timeout|timed out|overloaded|unavailable|tpm|rpm/.test(message);
}

function decorateAiFallbackError(error, providerName, method) {
  if (error instanceof Error) {
    error.message = `AI ${method} failed on ${providerName}: ${error.message}`;
    return error;
  }
  return new Error(`AI ${method} failed on ${providerName}: ${String(error)}`);
}
