import { Readable } from 'node:stream';

const GOOGLE_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INLINE_IMAGE_BYTES = 20_000_000;

export class GoogleAiStudioClient {
  constructor({ apiKey, model = 'gemini-2.5-flash-lite', ttsModel = 'gemini-3.1-flash-tts-preview', ttsVoice = 'Kore', thinkingBudget = 0, timeoutMs = 5000, ttsTimeoutMs = 8000, ttsMaxStreamMs = 45000 }) {
    this.apiKey = String(apiKey ?? '').trim();
    this.model = String(model || 'gemini-2.5-flash-lite').trim();
    this.ttsModel = String(ttsModel || 'gemini-3.1-flash-tts-preview').trim();
    this.ttsVoice = String(ttsVoice || 'Kore').trim();
    this.thinkingBudget = Number.isFinite(Number(thinkingBudget)) ? Math.max(0, Number(thinkingBudget)) : 0;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
    this.ttsTimeoutMs = Number(ttsTimeoutMs) > 0 ? Number(ttsTimeoutMs) : 8000;
    this.ttsMaxStreamMs = Number(ttsMaxStreamMs) > 0 ? Number(ttsMaxStreamMs) : 45000;
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
      ...buildThinkingConfig(this.model, this.thinkingBudget)
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
        ...buildThinkingConfig(this.model, this.thinkingBudget)
      }
    });
    return extractText(data);
  }


  async synthesizeSpeech({ text, model, voice } = {}) {
    this.#assertApiKey('speech generation');
    const normalizedText = normalizeTtsInput(text);
    if (!normalizedText) return Buffer.alloc(0);

    const data = await this.#request({
      model: String(model || this.ttsModel).trim(),
      contents: [{
        role: 'user',
        parts: [{ text: normalizedText }]
      }],
      generationConfig: buildSpeechGenerationConfig(voice || this.ttsVoice)
    });

    return wrapPcmInWav(extractAudio(data), 24_000, 1);
  }

  async createSpeechStream({ text, model, voice, timeoutMs, maxStreamMs } = {}) {
    this.#assertApiKey('speech generation');
    const normalizedText = normalizeTtsInput(text);
    if (!normalizedText) throw new Error('Gemini TTS received empty text.');

    const modelName = String(model || this.ttsModel).trim();
    const controller = new AbortController();
    const requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.ttsTimeoutMs;
    const headerTimeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    headerTimeout.unref?.();

    let response;
    try {
      response = await fetch(
        GOOGLE_AI_BASE_URL + '/models/' + encodeURIComponent(modelName) + ':streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-goog-api-key': this.apiKey
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: normalizedText }]
            }],
            generationConfig: buildSpeechGenerationConfig(voice || this.ttsVoice)
          }),
          signal: controller.signal
        }
      );
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error('Gemini TTS streaming request timed out before headers.');
        timeoutError.code = 'provider_timeout';
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(headerTimeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const data = parseJson(body);
      const message = data?.error?.message || body.replace(/\\s+/g, ' ').slice(0, 500);
      const error = new Error('Gemini TTS streaming returned ' + response.status + ': ' + (message || 'request failed'));
      error.status = response.status;
      error.code = response.status === 429 ? 'rate_limit' : 'google_tts_error';
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    if (!response.body) throw new Error('Gemini TTS streaming did not return a readable body.');

    return {
      audioStream: Readable.from(iterateGeminiSpeechAudio(response.body, {
        controller,
        firstAudioTimeoutMs: requestTimeoutMs,
        maxStreamMs: Number(maxStreamMs) > 0 ? Number(maxStreamMs) : this.ttsMaxStreamMs
      })),
      contentType: response.headers.get('content-type') || 'text/event-stream'
    };
  }

  #assertApiKey(capability = 'features') {
    if (!this.apiKey || this.apiKey === 'replace_me') {
      throw new Error('Set GOOGLE_AI_STUDIO_API_KEY or GEMINI_API_KEY in .env to use Google AI Studio ' + capability + '.');
    }
  }

  async #request({ system, contents, generationConfig, model = this.model }) {
    const modelName = encodeURIComponent(String(model || this.model).trim());
    const key = encodeURIComponent(this.apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        GOOGLE_AI_BASE_URL + '/models/' + modelName + ':generateContent?key=' + key,
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


function buildSpeechGenerationConfig(voice) {
  return {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: String(voice || 'Kore').trim()
        }
      }
    }
  };
}

function normalizeTtsInput(value) {
  return String(value ?? '')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 9000);
}

function extractAudio(data) {
  const encoded = extractInlineAudioData(data).join('');
  if (encoded) return Buffer.from(encoded, 'base64');

  const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'empty_audio';
  const error = new Error('Gemini TTS returned no audio: ' + reason);
  error.code = 'empty_response';
  error.status = 502;
  throw error;
}

function wrapPcmInWav(pcm, sampleRate, channels) {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function* iterateGeminiSpeechAudio(body, { controller, firstAudioTimeoutMs = 8000, maxStreamMs = 45000 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let audioSeen = false;
  let timeoutReason = '';
  let firstAudioTimer;
  let totalTimer;

  try {
    firstAudioTimer = setTimeout(() => {
      timeoutReason = 'Gemini TTS streaming timed out before the first audio chunk.';
      controller.abort();
    }, Math.max(1000, Number(firstAudioTimeoutMs) || 8000));
    firstAudioTimer.unref?.();
    totalTimer = setTimeout(() => {
      timeoutReason = 'Gemini TTS streaming exceeded its maximum duration.';
      controller.abort();
    }, Math.max(5000, Number(maxStreamMs) || 45000));
    totalTimer.unref?.();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');

      let separator;
      while ((separator = pending.indexOf('\\n\\n')) >= 0) {
        const event = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        for (const chunk of parseGeminiSseAudioEvent(event)) {
          audioSeen = true;
          clearTimeout(firstAudioTimer);
          yield chunk;
        }
      }
    }

    pending += decoder.decode().replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    if (pending.trim()) {
      for (const chunk of parseGeminiSseAudioEvent(pending)) {
        audioSeen = true;
        clearTimeout(firstAudioTimer);
        yield chunk;
      }
    }

    if (!audioSeen) throw new Error('Gemini TTS streaming returned no audio data.');
  } catch (error) {
    if (error?.name === 'AbortError' && timeoutReason) {
      const timeoutError = new Error(timeoutReason);
      timeoutError.code = 'provider_timeout';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(firstAudioTimer);
    clearTimeout(totalTimer);
    reader.releaseLock?.();
  }
}

function parseGeminiSseAudioEvent(event) {
  const dataLines = String(event ?? '')
    .split('\\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return [];

  const payload = dataLines.join('\\n').trim();
  if (!payload || payload === '[DONE]') return [];

  const data = parseJson(payload);
  if (data?.error) {
    throw new Error('Gemini TTS stream error: ' + (data.error.message || 'request failed'));
  }
  return extractInlineAudioData(data).map((value) => Buffer.from(value, 'base64'));
}

function extractInlineAudioData(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  return candidates
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.inlineData?.data || part?.inline_data?.data || '')
    .filter(Boolean);
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

function buildThinkingConfig(model, thinkingBudget) {
  const budget = Number(thinkingBudget);
  if (!Number.isFinite(budget) || budget <= 0) return {};

  if (isGemini3Model(model)) {
    return { thinkingConfig: { thinkingLevel: budgetToThinkingLevel(budget) } };
  }

  return { thinkingConfig: { thinkingBudget: Math.floor(budget) } };
}

function isGemini3Model(model) {
  return /^gemini-3(?:[.-]|$)/i.test(String(model ?? '').trim());
}

function budgetToThinkingLevel(budget) {
  if (budget <= 2048) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
