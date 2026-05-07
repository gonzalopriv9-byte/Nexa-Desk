export class AkiomaeClient {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl || 'https://api.akiomae.xyz').replace(/\/$/, '');
  }

  async generate({ system, messages }) {
    if (!this.apiKey || this.apiKey === 'replace_me') {
      throw new Error('Set AKIOMAE_API_KEY in .env to use Akiomae fallback.');
    }

    const prompt = formatAkiomaePrompt({ system, messages });
    const payload = JSON.stringify({
      prompt,
      system,
      messages
    });

    let response = await this.#requestAi({ payload, useQueryKey: false });
    if (response.status === 401) {
      response = await this.#requestAi({ payload, useQueryKey: true });
    }

    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`Akiomae returned ${response.status}: ${body.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }

    const data = parseJsonBody(body);
    const answer = data?.response ?? data?.content ?? data?.message ?? data?.text ?? body;
    return String(answer ?? '').trim();
  }

  async #requestAi({ payload, useQueryKey }) {
    const url = new URL(`${this.baseUrl}/api/ai`);
    if (useQueryKey) url.searchParams.set('key', this.apiKey);

    return fetch(url, {
      method: 'POST',
      headers: {
        ...(useQueryKey ? {} : { authorization: `Bearer ${this.apiKey}` }),
        'content-type': 'application/json'
      },
      body: payload
    });
  }
}

function formatAkiomaePrompt({ system, messages }) {
  const conversation = messages
    .map((message) => `${message.role === 'assistant' ? 'NexaDesk' : 'Usuario'}: ${message.content}`)
    .join('\n');

  return [
    'Sistema:',
    system,
    '',
    'Conversacion:',
    conversation,
    '',
    'Responde como NexaDesk siguiendo el sistema.'
  ].join('\n').slice(0, 18_000);
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
