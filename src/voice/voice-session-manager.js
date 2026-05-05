import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
        duration: 900
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
        await this.#speak(session, answer.publicAnswer);
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
      'Si el caso requiere staff humano, empieza con [ESCALATE] y explica el motivo sin repetir menciones.',
      'No inventes datos del servidor. Usa solo el contexto proporcionado.',
      session.guildConfig.serverPrompt ? `Prompt del servidor:\n${session.guildConfig.serverPrompt}` : '',
      session.guildConfig.serverInfo ? `Informacion del servidor:\n${session.guildConfig.serverInfo}` : '',
      `Servidor: ${session.guildName}`,
      `Usuario hablando: ${member.displayName}`
    ].filter(Boolean).join('\n\n');

    const messages = history
      .slice(-18)
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: `${message.authorName || message.role}: ${message.content}`.slice(0, 2_000)
      }));
    messages.push({ role: 'user', content: transcript });

    const raw = await this.aiClient.generate({ system, messages });
    const parsed = parseVoiceEscalation(raw);
    return {
      ...parsed,
      mentionStaff: parsed.shouldEscalate && Boolean(session.guildConfig.staffRoleId)
    };
  }

  async #speak(session, text) {
    const safeText = stripDiscordMentions(text).slice(0, 900);
    if (!safeText) return;

    const audio = await this.aiClient.synthesizeSpeech({
      text: safeText,
      model: this.config.GROQ_TTS_MODEL,
      voice: this.config.GROQ_TTS_VOICE
    });
    const pcmStream = transcodeToDiscordPcm(audio);
    const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1.18);
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Idle, 45_000).catch(() => {});
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

function transcodeToDiscordPcm(audioBuffer) {
  const ffmpeg = spawn('ffmpeg', [
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
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  ffmpeg.once('error', (error) => {
    console.error('ffmpeg failed while preparing voice playback:', error);
  });
  ffmpeg.stdin.end(audioBuffer);
  return ffmpeg.stdout;
}

function runFfmpegBuffer(args, input) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];

    ffmpeg.stdout.on('data', (chunk) => stdout.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk));
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(message || `ffmpeg exited with code ${code}`));
    });

    ffmpeg.stdin.once('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    ffmpeg.stdin.end(input);
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
  if (error?.code === 'ENOENT') return 'ffmpeg no esta instalado';
  return String(error?.message ?? error).replace(/\s+/g, ' ').trim() || 'error desconocido';
}

function parseVoiceEscalation(answer) {
  const text = String(answer ?? '').trim();
  const shouldEscalate = /^\[ESCALATE\]/i.test(text) || /\[ESCALATE\]/i.test(text);
  const publicAnswer = text
    .replace(/\[ESCALATE\]/gi, '')
    .replace(/<@&?\d+>/g, '')
    .replace(/@staff/gi, 'staff')
    .trim();

  return {
    shouldEscalate,
    publicAnswer: publicAnswer || 'Necesito que el staff humano revise este caso.'
  };
}

function stripDiscordMentions(text) {
  return String(text ?? '')
    .replace(/<@&?\d+>/g, '')
    .replace(/<#\d+>/g, 'canal')
    .replace(/@everyone|@here/gi, '')
    .trim();
}
