const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INLINE_IMAGE_BYTES = 20_000_000;

export class GoogleAiStudioClient {
  constructor({ apiKey, model = 'gemini-2.5-flash-lite', thinkingBudget = 0, timeoutMs = 5000 }) {
    this.apiKey = String(apiKey ?? '').trim();
    this.model = String(model || 'gemini-2.5-flash-lite').trim();
    this.thinkingBudget = Number.isFinite(Number(thinkingBudget)) ? Math.max(0, Number(thinkingBudget)) : 0;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  }

  async generate({ system = '', messages = [], maxTokens = 350, temperature = 0.25 } = {}) {
    if (!this.apiKey || this.apiKey === 'replace_me') {
      throw new Error('Set GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY in .env to use Google AI Studio.');
    }

    const contents = messages
      .map((message) => ({
        role: message?.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(message?.content ?? '') }]
      }))
      .filter((message) => message.parts[0].text.trim());

    const generationConfig = {
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.25,
      maxOutputTokens: Math.max(1, Number(maxTokens) || 350),
      thinkingConfig: { thinkingBudget: this.thinkingBudget }
    };

    const data = await this.#request({ system, contents, generationConfig });
    return extractText(data);
  }

  async analyzeImages({ system = '', prompt = '', images = [] } = {}) {
    if (!this.apiKey || this.apiKey === 'replace_me') {
      throw new Error('Set GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY in .env to use Google AI Studio vision.');
    }

    const imageParts = [];
    for (const image of images.slice(0, 5)) {
      const part = await imageToInlineData(image);
      if (part) imageParts.push(part);
    }
    if (!imageParts.length) throw new Error('Google AI Studio received no readable images.');

    const data = await this.#request({
      system,
      contents: [{
        role: 'user',
        parts: [{ text: String(prompt ?? '') }, ...imageParts]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 350,
        thinkingConfig: { thinkingBudget: this.thinkingBudget }
      }
    });
    return extractText(data);
  }

  async #request({ system, contents, generationConfig }) {
    const model = encodeURIComponent(this.model);
    const key = encodeURIComponent(this.apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        GOOGLE_AI_BASE_URL + '/models/' + model + ':generateContent?key=' + key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(String(system ?? '').trim()
              ? { systemInstruction: { parts: [{ text: String(system).slice(0, 30_000) }] } }
              : {}),
            contents,
            generationConfig
          }),
          signal: controller.signal
        }
      );
      const body = await response.text().catch(() => '');
      const data = parseJson(body);
      if (!response.ok) {
        const apiMessage = data?.error?.message || body.replace(/\\s+/g, ' ').slice(0, 500);
        const error = new Error(
          'Google AI Studio returned ' + response.status + ': ' + (apiMessage || 'request failed')
        );
        error.status = response.status;
        error.code = response.status === 429 ? 'rate_limit' : 'google_ai_studio_error';
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(
          'Google AI Studio request timed out after ' + this.timeoutMs + 'ms'
        );
        timeoutError.code = 'provider_timeout';
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractText(data) {
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => String(part?.text ?? ''))
    .filter(Boolean)
    .join('')
    .trim();
  if (text) return text;

  const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'empty_response';
  const error = new Error('Google AI Studio returned no text: ' + reason);
  error.code = 'empty_response';
  error.status = 502;
  throw error;
}

async function imageToInlineData(image = {}) {
  const value = String(image.url ?? '').trim();
  if (!value) return null;

  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) return null;
    const base64 = match[2];
    if (Buffer.byteLength(base64, 'base64') > MAX_INLINE_IMAGE_BYTES) {
      throw new Error('Google AI Studio image exceeds the 20 MB limit.');
    }
    return { inlineData: { mimeType: match[1], data: base64 } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(value, { signal: controller.signal });
    if (!response.ok) throw new Error('image download failed (' + response.status + ')');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      throw new Error('Google AI Studio image exceeds the 20 MB limit.');
    }
    const mimeType = String(response.headers.get('content-type') || image.contentType || 'image/jpeg').split(';')[0];
    return {
      inlineData: {
        mimeType: mimeType.startsWith('image/') ? mimeType : 'image/jpeg',
        data: buffer.toString('base64')
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
