import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import prism from 'prism-media';

const SAMPLE_RATE = 48_000;
const STT_SAMPLE_RATE = 16_000;
const CHANNELS = 2;
const STT_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const MIN_VOICE_RMS = 0.0035;
const EDGE_TTS_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const EDGE_TTS_CHROMIUM_VERSION = '143.0.3650.75';
const EDGE_TTS_CHROMIUM_MAJOR = EDGE_TTS_CHROMIUM_VERSION.split('.', 1)[0];
const EDGE_TTS_GEC_VERSION = `1-${EDGE_TTS_CHROMIUM_VERSION}`;
const EDGE_TTS_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_TTS_CHROMIUM_MAJOR}.0.0.0`;

export class VoiceSessionManager {
  constructor({ storage, aiClient, config }) {
    this.storage = storage;
    this.aiClient = aiClient;
    this.config = config;
    this.sessionsByGuild = new Map();
  }

  async startTicketSession({ guild, textChannel, voiceChannel, ticket, guildConfig }) {
    if (!this.aiClient?.transcribeAudio || !this.aiClient?.synthesizeSpeech) {
      return { started: false, reason: 'El cliente de IA no tiene STT/TTS disponible.' };
    }

    const existing = this.sessionsByGuild.get(guild.id);
    if (existing && existing.voiceChannelId !== voiceChannel.id) {
      return {
        started: false,
        reason: `Ya hay una sala de voz IA activa en este servidor: ${existing.voiceChannelName}.`
      };
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    const player = createAudioPlayer();
    player.on('error', (error) => {
      console.error(`Voice playback failed for ${voiceChannel.id}:`, error);
    });
    connection.subscribe(player);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      connection.destroy();
      throw error;
    }

    const session = {
      guildId: guild.id,
      guildName: guild.name,
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id,
      voiceChannelName: voiceChannel.name,
      ticketChannelId: ticket.channelId,
      ticket,
      guildConfig,
      textChannel,
      voiceChannel,
      connection,
      player,
      speakers: new Set(),
      processing: false,
      stopped: false,
      startedAt: new Date().toISOString()
    };

    this.sessionsByGuild.set(guild.id, session);
    connection.on(VoiceConnectionStatus.Disconnected, () => this.stopSession(guild.id, voiceChannel.id));
    connection.receiver.speaking.on('start', (userId) => {
      this.#captureSpeech(session, userId).catch((error) => {
        console.error(`Voice capture failed for ${voiceChannel.id}:`, error);
      });
    });

    return { started: true };
  }

  stopSession(guildId, voiceChannelId = null) {
    const session = this.sessionsByGuild.get(guildId);
    if (!session) return false;
    if (voiceChannelId && session.voiceChannelId !== voiceChannelId) return false;

    session.stopped = true;
    this.sessionsByGuild.delete(guildId);
    try {
      getVoiceConnection(guildId)?.destroy();
    } catch {
      // Connection can already be destroyed by Discord.
    }
    return true;
  }

  getSession(guildId) {
    return this.sessionsByGuild.get(guildId) ?? null;
  }

  async #captureSpeech(session, userId) {
    if (session.stopped || session.speakers.has(userId)) return;

    const member = await session.voiceChannel.guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return;

    session.speakers.add(userId);
    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.config.VOICE_SILENCE_DURATION_MS
      }
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: CHANNELS,
      rate: SAMPLE_RATE
    });

    const chunks = [];
    let bytes = 0;
    const maxBytes = Math.floor(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * (this.config.VOICE_MAX_RECORDING_MS / 1000));

    decoder.on('data', (chunk) => {
      if (bytes >= maxBytes) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= maxBytes) opusStream.destroy();
    });

    await new Promise((resolve, reject) => {
      decoder.once('end', resolve);
      decoder.once('close', resolve);
      decoder.once('error', reject);
      opusStream.once('error', reject);
      opusStream.pipe(decoder);
    }).catch((error) => {
      console.error('Discord voice decode failed:', error);
    });
    session.speakers.delete(userId);

    const pcm = Buffer.concat(chunks);
    const durationMs = pcm.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000;
    if (session.stopped || durationMs < this.config.VOICE_MIN_RECORDING_MS || !pcm.length) return;

    await this.#handleUtterance(session, member, pcm).catch((error) => {
      console.error(`Voice utterance failed for ${session.voiceChannelId}:`, error);
      session.textChannel.send('No pude procesar ese audio. Prueba a repetirlo un poco mas claro.').catch(() => {});
    });
  }

  async #handleUtterance(session, member, pcm) {
    if (session.processing) {
      await session.textChannel.send(`Estoy terminando una respuesta anterior, ${member}. Te escucho en un momento.`).catch(() => {});
      return;
    }

    session.processing = true;
    try {
      const preparedAudio = await prepareSpeechForTranscription(pcm);
      if (!preparedAudio) {
        await session.textChannel.send(`No he detectado voz suficientemente clara, ${member}. Prueba a hablar un poco mas cerca del micro.`).catch(() => {});
        return;
      }

      const transcript = await this.aiClient.transcribeAudio({
        audioBuffer: preparedAudio.wav,
        fileName: `nexadesk-${session.ticketChannelId}-${Date.now()}.wav`,
        model: this.config.GROQ_STT_MODEL
      });

      if (!transcript) return;

      await this.storage.addTranscriptMessage({
        guildId: session.guildId,
        channelId: session.ticketChannelId,
        messageId: `voice-user-${randomUUID()}`,
        authorId: member.user.id,
        authorName: member.user.username,
        authorBot: false,
        role: 'user',
        content: `[Voz] ${transcript}`,
        createdAt: new Date().toISOString()
      });

      await session.textChannel.send(`**${member.displayName} por voz:** ${transcript.slice(0, 1_800)}`).catch(() => {});
      const answer = await this.#answerVoiceTicket(session, transcript, member);
      if (!answer) return;

      await this.storage.addTranscriptMessage({
        guildId: session.guildId,
        channelId: session.ticketChannelId,
        messageId: `voice-assistant-${randomUUID()}`,
        authorId: session.voiceChannel.client.user.id,
        authorName: session.voiceChannel.client.user.username,
        authorBot: true,
        role: 'assistant',
        content: `[Voz] ${answer.publicAnswer}`,
        createdAt: new Date().toISOString()
      });

      await session.textChannel.send({
        content: answer.mentionStaff && session.guildConfig.staffRoleId
          ? `<@&${session.guildConfig.staffRoleId}> ${answer.publicAnswer.slice(0, 1_800)}`
          : `**NexaDesk por voz:** ${answer.publicAnswer.slice(0, 1_800)}`,
        allowedMentions: { roles: answer.mentionStaff && session.guildConfig.staffRoleId ? [session.guildConfig.staffRoleId] : [] }
      }).catch(() => {});

      if (this.config.VOICE_TTS_ENABLED) {
        await this.#speak(session, answer.publicAnswer).catch((error) => {
          console.error(`Voice TTS failed for ${session.voiceChannelId}:`, error);
          session.textChannel.send('He respondido por texto, pero no pude reproducir la voz en la sala.').catch(() => {});
        });
      }
    } finally {
      session.processing = false;
    }
  }

  async #answerVoiceTicket(session, transcript, member) {
    const history = await this.storage.listTranscriptMessages(session.ticketChannelId);
    const system = [
      'Eres NexaDesk, soporte por voz para tickets de Discord.',
      'Responde en el mismo idioma del ultimo mensaje del usuario.',
      'Se breve y natural para poder leerlo en voz alta.',
      'Recibes transcripciones limpias de audio. Si hay texto del usuario, nunca digas que no puedes procesar, escuchar o entender el audio.',
      'No incluyas prefijos como "NexaDesk:", "[Voz]", ":Global:" ni nombres de emojis.',
      'Si el caso requiere staff humano, empieza con [ESCALATE] y explica el motivo sin repetir menciones.',
      'Si el usuario quiere reportar acoso, amenazas, abuso o incumplimientos, pide datos clave y escala al staff cuando sea necesario.',
      'No inventes datos del servidor. Usa solo el contexto proporcionado.',
      session.guildConfig.serverPrompt ? `Prompt del servidor:\n${session.guildConfig.serverPrompt}` : '',
      session.guildConfig.serverInfo ? `Informacion del servidor:\n${session.guildConfig.serverInfo}` : '',
      `Servidor: ${session.guildName}`,
      `Usuario hablando: ${member.displayName}`
    ].filter(Boolean).join('\n\n');

    const messages = buildVoiceConversationHistory(history, transcript);
    messages.push({
      role: 'user',
      content: `Ultimo mensaje transcrito de ${member.displayName}: ${sanitizeVoiceHistoryContent(transcript)}`
    });

    const raw = await this.aiClient.generate({ system, messages });
    const parsed = parseVoiceEscalation(raw);
    return {
      ...parsed,
      mentionStaff: parsed.shouldEscalate && Boolean(session.guildConfig.staffRoleId)
    };
  }

  async #speak(session, text) {
    const safeText = prepareVoiceSpeechText(text, this.config.VOICE_TTS_MAX_CHARS);
    if (!safeText) return;

    const audio = await this.#synthesizeSpeechWithFallback(safeText);
    if (!audio?.length) {
      throw new Error('TTS did not return audio bytes.');
    }
    const pcm = await decodeTtsToDiscordPcm(audio);
    const stats = analyzePcm16(pcm);
    if (!pcm.length || (stats.rms < 0.0008 && stats.peak < 0.01)) {
      throw new Error(`TTS audio decoded as silence (rms ${stats.rms.toFixed(5)}, peak ${stats.peak.toFixed(5)}).`);
    }

    console.log(`Voice TTS ready using ${this.config.VOICE_TTS_PROVIDER || 'auto'} (${audio.length} bytes, pcm ${pcm.length}, rms ${stats.rms.toFixed(4)}).`);
    session.connection.subscribe(session.player);
    await entersState(session.connection, VoiceConnectionStatus.Ready, 5_000);
    const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1.35);
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(session.player, AudioPlayerStatus.Idle, 45_000).catch(() => {});
  }

  async #synthesizeSpeechWithFallback(text) {
    if (['edge', 'piper', 'espeak'].includes(this.config.VOICE_TTS_PROVIDER)) {
      return synthesizeLocalSpeech(text, this.config);
    }

    if (this.config.VOICE_TTS_LOCAL_FIRST) {
      return synthesizeLocalSpeech(text, this.config);
    }

    try {
      return await this.aiClient.synthesizeSpeech({
        text,
        model: this.config.GROQ_TTS_MODEL,
        voice: this.config.GROQ_TTS_VOICE
      });
    } catch (error) {
      console.error('Groq TTS failed, trying local TTS fallback:', normalizeProcessError(error));
      return synthesizeLocalSpeech(text, this.config);
    }
  }
}

async function prepareSpeechForTranscription(pcm) {
  const stats = analyzePcm16(pcm);
  if (stats.rms < MIN_VOICE_RMS && stats.peak < 0.035) {
    return null;
  }

  try {
    const wav = await cleanPcmWithFfmpeg(pcm);
    if (wav.length > 44) return { wav, cleaned: true, stats };
  } catch (error) {
    console.error('Voice cleanup failed, falling back to raw WAV:', normalizeProcessError(error));
  }

  return { wav: buildWavFromPcm(pcm), cleaned: false, stats };
}

function cleanPcmWithFfmpeg(pcm) {
  return runFfmpegBuffer([
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    '-i',
    'pipe:0',
    '-af',
    [
      'highpass=f=85',
      'lowpass=f=7600',
      'afftdn=nf=-25',
      'acompressor=threshold=-22dB:ratio=3.2:attack=4:release=90',
      'dynaudnorm=f=75:g=15:m=8',
      'silenceremove=start_periods=1:start_threshold=-52dB:start_silence=0.12:stop_periods=-1:stop_threshold=-52dB:stop_silence=0.35'
    ].join(','),
    '-ac',
    String(STT_CHANNELS),
    '-ar',
    String(STT_SAMPLE_RATE),
    '-f',
    'wav',
    'pipe:1'
  ], pcm);
}

function buildWavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function decodeTtsToDiscordPcm(audioBuffer) {
  return runProcessBuffer('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-af',
    'dynaudnorm=f=75:g=9,volume=1.25',
    '-f',
    's16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    'pipe:1'
  ], audioBuffer);
}

async function synthesizeLocalSpeech(text, config = {}) {
  const normalizedText = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 650);

  if (!normalizedText) return Buffer.alloc(0);

  let lastError = null;
  for (const provider of getLocalTtsProviderOrder(config)) {
    try {
      if (provider === 'edge-direct') return await synthesizeWithEdgeDirect(normalizedText, config);
      if (provider === 'edge-cli') return await synthesizeWithEdgeTts(normalizedText, config);
      if (provider === 'piper') return await synthesizeWithPiper(normalizedText, config);
      if (provider === 'espeak') return await synthesizeWithEspeak(normalizedText);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('No local TTS command is available.');
}

function getLocalTtsProviderOrder(config) {
  const provider = config.VOICE_TTS_PROVIDER || 'auto';
  if (provider === 'edge') return ['edge-direct', 'edge-cli', 'piper', 'espeak'];
  if (provider === 'piper') return ['piper', 'edge-direct', 'edge-cli', 'espeak'];
  if (provider === 'espeak') return ['espeak'];
  return ['edge-direct', 'edge-cli', 'piper', 'espeak'];
}

function synthesizeWithEdgeDirect(text, config) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID().replace(/-/g, '');
    const connectionId = randomUUID().replace(/-/g, '');
    const endpoint = new URL('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1');
    endpoint.searchParams.set('TrustedClientToken', EDGE_TTS_TRUSTED_CLIENT_TOKEN);
    endpoint.searchParams.set('ConnectionId', connectionId);
    endpoint.searchParams.set('Sec-MS-GEC', generateEdgeSecMsGec());
    endpoint.searchParams.set('Sec-MS-GEC-Version', EDGE_TTS_GEC_VERSION);

    const chunks = [];
    const ws = new WebSocket(endpoint.toString(), {
      headers: buildEdgeWebsocketHeaders(),
      perMessageDeflate: true
    });
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Closing a failed socket is best-effort only.
      }
      reject(new Error('Edge TTS direct timed out.'));
    }, 10_000);

    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    ws.once('open', () => {
      ws.send(buildEdgeSpeechConfigMessage());
      ws.send(buildEdgeSsmlMessage({
        text,
        requestId,
        voice: config.EDGE_TTS_VOICE || 'es-ES-ElviraNeural',
        rate: config.EDGE_TTS_RATE || '+8%',
        pitch: config.EDGE_TTS_PITCH || '+0Hz',
        volume: config.EDGE_TTS_VOLUME || '+0%'
      }));
    });

    ws.on('message', async (data, isBinary) => {
      const payload = await websocketPayloadToBuffer(data).catch((error) => {
        finish(error);
        return null;
      });
      if (!payload || settled) return;

      if (!isBinary) {
        const message = payload.toString('utf8');
        if (message.includes('Path:turn.end')) {
          try {
            ws.close();
          } catch {
            // The stream can already be closing.
          }
          finish();
        }
        return;
      }

      const audio = parseEdgeAudioFrame(payload);
      if (audio?.length) chunks.push(audio);
    });

    ws.once('error', (error) => finish(error instanceof Error ? error : new Error('Edge TTS direct websocket failed.')));
    ws.once('close', () => {
      if (!settled) finish(chunks.length ? null : new Error('Edge TTS direct closed without audio.'));
    });
  });
}

async function synthesizeWithEdgeTts(text, config) {
  const outputPath = path.join(os.tmpdir(), `nexadesk-edge-${randomUUID()}.mp3`);
  try {
    await runProcessBuffer(config.EDGE_TTS_BIN || 'edge-tts', [
      '--voice',
      config.EDGE_TTS_VOICE || 'es-ES-ElviraNeural',
      '--rate',
      config.EDGE_TTS_RATE || '+8%',
      '--pitch',
      config.EDGE_TTS_PITCH || '+0Hz',
      '--volume',
      config.EDGE_TTS_VOLUME || '+0%',
      '--text',
      text,
      '--write-media',
      outputPath
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(outputPath, { force: true }).catch(() => {});
  }
}

function buildEdgeSpeechConfigMessage() {
  return [
    `X-Timestamp:${edgeDateString()}`,
    'Content-Type:application/json; charset=utf-8',
    'Path:speech.config',
    '',
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: 'false',
              wordBoundaryEnabled: 'false'
            },
            outputFormat: EDGE_TTS_OUTPUT_FORMAT
          }
        }
      }
    })
  ].join('\r\n');
}

function buildEdgeSsmlMessage({ text, requestId, voice, rate, pitch, volume }) {
  return [
    `X-RequestId:${requestId}`,
    'Content-Type:application/ssml+xml',
    `X-Timestamp:${edgeDateString()}Z`,
    'Path:ssml',
    '',
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="${escapeXml(volume)}">${escapeXml(text)}</prosody></voice></speak>`
  ].join('\r\n');
}

function buildEdgeWebsocketHeaders() {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': EDGE_TTS_USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${randomUUID().replace(/-/g, '').toUpperCase()};`
  };
}

function generateEdgeSecMsGec() {
  const windowsEpochSeconds = 11_644_473_600;
  const unixSeconds = Date.now() / 1000;
  const roundedWindowsSeconds = unixSeconds + windowsEpochSeconds - ((unixSeconds + windowsEpochSeconds) % 300);
  const ticks = Math.floor(roundedWindowsSeconds * 10_000_000);
  return createHash('sha256')
    .update(`${ticks}${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function edgeDateString() {
  const date = new Date();
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

async function websocketPayloadToBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  return Buffer.from(data);
}

function parseEdgeAudioFrame(frame) {
  if (frame.length < 2) return null;
  const headerLength = frame.readUInt16BE(0);
  const audioStart = 2 + headerLength;
  if (audioStart >= frame.length) return null;
  const header = frame.subarray(2, audioStart).toString('utf8');
  if (!header.includes('Path:audio')) return null;
  return frame.subarray(audioStart);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function synthesizeWithPiper(text, config) {
  const attempt = buildPiperAttempt(text, config);
  return runProcessBuffer(attempt.command, attempt.args, attempt.input);
}

function synthesizeWithEspeak(text) {
  const voice = detectLocalTtsVoice(text);
  return runProcessBuffer('espeak-ng', ['-v', voice, '-s', '165', '-p', '48', '-a', '185', '--stdout', text])
    .catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return runProcessBuffer('espeak', ['-v', voice, '-s', '165', '-p', '48', '-a', '185', '--stdout', text]);
    });
}

function buildPiperAttempt(text, config) {
  const args = [
    '-q',
    '--model',
    config.PIPER_TTS_MODEL,
    '--output_file',
    '-',
    '--length_scale',
    String(config.PIPER_TTS_LENGTH_SCALE ?? 0.96),
    '--noise_scale',
    String(config.PIPER_TTS_NOISE_SCALE ?? 0.62),
    '--noise_w',
    String(config.PIPER_TTS_NOISE_W ?? 0.75),
    '--sentence_silence',
    '0.16'
  ];

  if (config.PIPER_TTS_CONFIG) {
    args.splice(3, 0, '--config', config.PIPER_TTS_CONFIG);
  }

  return {
    command: config.PIPER_TTS_BIN || 'piper',
    args,
    input: `${text}\n`
  };
}

function detectLocalTtsVoice(text) {
  const value = String(text ?? '').toLowerCase();
  if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1\u00bf\u00a1]/i.test(value)) return 'es';
  const spanishHints = [' que ', ' para ', ' por ', ' usuario ', ' servidor ', ' ticket ', ' soporte ', ' gracias ', ' puedes '];
  return spanishHints.some((hint) => ` ${value} `.includes(hint)) ? 'es' : 'en-us';
}

function runFfmpegBuffer(args, input) {
  return runProcessBuffer('ffmpeg', args, input);
}

function runProcessBuffer(command, args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(message || `${command} exited with code ${code}`));
    });

    child.stdin.once('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input ?? undefined);
  });
}

function analyzePcm16(pcm) {
  if (!pcm.length) return { rms: 0, peak: 0 };

  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += BYTES_PER_SAMPLE) {
    const value = pcm.readInt16LE(offset) / 32768;
    const abs = Math.abs(value);
    peak = Math.max(peak, abs);
    sumSquares += value * value;
    samples += 1;
  }

  return {
    rms: samples ? Math.sqrt(sumSquares / samples) : 0,
    peak
  };
}

function normalizeProcessError(error) {
  if (error?.code === 'ENOENT') return 'comando no disponible';
  return String(error?.message ?? error).replace(/\s+/g, ' ').trim() || 'error desconocido';
}

function parseVoiceEscalation(answer) {
  const text = String(answer ?? '').trim();
  const shouldEscalate = /^\[ESCALATE\]/i.test(text) || /\[ESCALATE\]/i.test(text);
  let publicAnswer = sanitizeVoiceAssistantAnswer(text)
    .replace(/\[ESCALATE\]/gi, '')
    .replace(/<@&?\d+>/g, '')
    .replace(/@staff/gi, 'staff')
    .trim();

  if (isBadAudioProcessingAnswer(publicAnswer)) {
    publicAnswer = 'Entiendo. Para reportar el caso, dime el usuario implicado, que ocurrio, cuando paso y si tienes pruebas o capturas.';
  }

  return {
    shouldEscalate,
    publicAnswer: publicAnswer || 'Necesito que el staff humano revise este caso.'
  };
}

function buildVoiceConversationHistory(history, currentTranscript) {
  const normalizedCurrent = normalizeComparableText(currentTranscript);
  return history
    .filter((message) => ['user', 'assistant'].includes(message.role))
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      authorName: message.authorName || message.role,
      content: sanitizeVoiceHistoryContent(message.content)
    }))
    .filter((message) => message.content && !isOperationalVoiceMessage(message.content))
    .filter((message) => normalizeComparableText(message.content) !== normalizedCurrent)
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: `${message.authorName}: ${message.content}`.slice(0, 1_600)
    }));
}

function sanitizeVoiceHistoryContent(content) {
  return String(content ?? '')
    .replace(/\[Voz\]/gi, '')
    .replace(/\[ESCALATE\]/gi, '')
    .replace(/NexaDesk\s*:\s*/gi, '')
    .replace(/:Global:/gi, '')
    .replace(/:wifi:/gi, '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/<@&?\d+>/g, 'staff')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeVoiceAssistantAnswer(content) {
  return sanitizeVoiceHistoryContent(content)
    .replace(/^assistant\s*:\s*/i, '')
    .replace(/^soporte\s*:\s*/i, '')
    .trim();
}

function isOperationalVoiceMessage(content) {
  const normalized = normalizeComparableText(content);
  return [
    'stt tts activo',
    'sala de voz vinculada',
    'he respondido por texto',
    'no pude reproducir la voz',
    'no pude procesar ese audio',
    'prueba a repetirlo',
    'no he detectado voz suficientemente clara',
    'estoy terminando una respuesta anterior'
  ].some((pattern) => normalized.includes(pattern));
}

function isBadAudioProcessingAnswer(content) {
  const normalized = normalizeComparableText(content);
  return normalized.includes('no puedo procesar el audio')
    || normalized.includes('no pude procesar el audio')
    || normalized.includes('repite tu mensaje de manera clara')
    || normalized.includes('no puedo escuchar el audio');
}

function normalizeComparableText(content) {
  return sanitizeVoiceHistoryContent(content)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function stripDiscordMentions(text) {
  return sanitizeVoiceAssistantAnswer(text)
    .replace(/<@&?\d+>/g, '')
    .replace(/<#\d+>/g, 'canal')
    .replace(/@everyone|@here/gi, '')
    .trim();
}

function prepareVoiceSpeechText(text, maxChars = 420) {
  const cleaned = stripDiscordMentions(text)
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(120, Math.min(Number(maxChars) || 420, 900));
  if (cleaned.length <= limit) return cleaned;

  const slice = cleaned.slice(0, limit);
  const splitAt = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('; '),
    slice.lastIndexOf(', ')
  );
  return `${slice.slice(0, splitAt > 120 ? splitAt + 1 : limit).trim()} Te dejo el resto por escrito en el ticket.`;
}
