import Groq from 'groq-sdk';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const MAX_TTS_INPUT_CHARS = 190;

export class GroqClient {
  constructor({ apiKey, model, visionModel }) {
    this.apiKey = apiKey;
    this.client = apiKey && apiKey !== 'replace_me' ? new Groq({ apiKey }) : null;
    this.model = model;
    this.visionModel = visionModel;
  }

  async generate({ system, messages, maxTokens = 350, temperature = 0.25 }) {
    if (!this.client) {
      throw new Error('Set GROQ_API_KEY in .env to use Groq.');
    }

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        ...messages
      ]
    });

    return sanitizeModelOutput(completion.choices[0]?.message?.content);
  }

  async analyzeImages({ system, prompt, images }) {
    if (!this.client) {
      throw new Error('Set GROQ_API_KEY in .env to use Groq vision.');
    }

    if (!this.visionModel) {
      throw new Error('Set GROQ_VISION_MODEL to use visual analysis.');
    }

    const completion = await this.client.chat.completions.create({
      model: this.visionModel,
      temperature: 0.1,
      max_completion_tokens: 350,
      messages: [
        { role: 'system', content: `${system}\n\nResponde directo. No incluyas razonamiento interno ni etiquetas <think>.` },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.slice(0, 5).map((image) => ({
              type: 'image_url',
              image_url: { url: image.url }
            }))
          ]
        }
      ]
    });

    return sanitizeModelOutput(completion.choices[0]?.message?.content);
  }

  async transcribeAudio({ audioBuffer, fileName = 'nexadesk-voice.wav', model, language, prompt }) {
    if (!this.client) {
      throw new Error('Set GROQ_API_KEY in .env to use Groq speech-to-text.');
    }

    const request = {
      file: new File([audioBuffer], fileName, { type: 'audio/wav' }),
      model: model || 'whisper-large-v3-turbo',
      response_format: 'json',
      temperature: 0
    };
    const normalizedLanguage = String(language ?? '').trim();
    const normalizedPrompt = String(prompt ?? '').trim();
    if (normalizedLanguage) request.language = normalizedLanguage;
    if (normalizedPrompt) request.prompt = normalizedPrompt.slice(0, 900);

    const transcription = await this.client.audio.transcriptions.create(request);
    return transcription.text?.trim() ?? '';
  }

  async synthesizeSpeech({ text, model, voice }) {
    if (!this.apiKey || this.apiKey === 'replace_me') {
      throw new Error('Set GROQ_API_KEY in .env to use Groq text-to-speech.');
    }

    const chunks = splitSpeechInput(text);
    if (!chunks.length) return Buffer.alloc(0);

    const audioBuffers = [];
    for (const chunk of chunks) {
      audioBuffers.push(await this.#createSpeechChunk({
        text: chunk,
        model: model || 'canopylabs/orpheus-v1-english',
        voice: voice || 'hannah'
      }));
    }

    return audioBuffers.length === 1 ? audioBuffers[0] : concatenateWavBuffers(audioBuffers);
  }

  async #createSpeechChunk({ text, model, voice }) {
    const response = await fetch(`${GROQ_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: 'wav'
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Groq TTS failed (${response.status}): ${body.slice(0, 500)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}

function sanitizeModelOutput(content) {
  const text = String(content ?? '').trim();
  if (!text) return '';

  const withoutClosedThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (withoutClosedThinking && !/^<think>/i.test(withoutClosedThinking)) {
    return withoutClosedThinking;
  }

  return text
    .replace(/<\/?think>/gi, '')
    .trim();
}

function splitSpeechInput(text) {
  const normalized = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > MAX_TTS_INPUT_CHARS) {
    const slice = remaining.slice(0, MAX_TTS_INPUT_CHARS);
    const splitAt = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf(', '),
      slice.lastIndexOf(' ')
    );
    const end = splitAt > 40 ? splitAt + 1 : MAX_TTS_INPUT_CHARS;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function concatenateWavBuffers(buffers) {
  const parsed = buffers.map(parseWavBuffer);
  const first = parsed[0];
  const data = Buffer.concat(parsed.map((entry) => entry.data));
  const output = Buffer.concat([
    first.buffer.subarray(0, first.dataStart),
    data,
    first.buffer.subarray(first.dataEnd)
  ]);
  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(data.length, first.dataSizeOffset);
  return output;
}

function parseWavBuffer(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Groq TTS did not return a valid WAV file.');
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (chunkId === 'data') {
      if (dataEnd > buffer.length) break;
      return {
        buffer,
        data: buffer.subarray(dataStart, dataEnd),
        dataStart,
        dataEnd,
        dataSizeOffset: offset + 4
      };
    }
    offset = dataEnd + (chunkSize % 2);
  }

  throw new Error('Groq TTS WAV response is missing a data chunk.');
}
