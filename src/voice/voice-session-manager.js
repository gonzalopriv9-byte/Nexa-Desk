import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
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
import { detectAiQualitySignalHeuristic, parseAiQualitySignalJson } from '../ai-quality.js';
import { hasVisualAttachments } from '../ai/visual-analyzer.js';

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
  constructor({ storage, aiClient, config, visualAnalyzer = null }) {
    this.storage = storage;
    this.aiClient = aiClient;
    this.config = config;
    this.visualAnalyzer = visualAnalyzer;
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
      currentTurnId: null,
      currentAudioStream: null,
      currentPcmStream: null,
      lastUnclearVoiceNoticeAt: 0,
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

    if (shouldUseFishStreaming(this.config) && this.config.VOICE_TTS_PREWARM_ENABLED) {
      void prewarmFishAudio(this.config).then((elapsedMs) => {
        console.log(`Voice TTS prewarmed with Fish.audio in ${elapsedMs}ms.`);
      }).catch((error) => {
        console.warn('Voice TTS prewarm failed:', normalizeProcessError(error));
      });
    }

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

  async speakToTicket(guildId, text) {
    const session = this.getSession(guildId);
    if (!session || session.stopped) {
      return { spoken: false, reason: 'No hay una sesion de voz activa para este servidor.' };
    }
    if (!this.config.VOICE_TTS_ENABLED) {
      return { spoken: false, reason: 'VOICE_TTS_ENABLED esta desactivado.' };
    }
    await this.#speak(session, text);
    return { spoken: true };
  }

  async ingestVisualMessage({ message, guildConfig }) {
    const session = this.getSession(message.guildId);
    if (!session || session.stopped || session.ticketChannelId !== message.channelId) {
      return { handled: false };
    }
    if (!this.visualAnalyzer || !hasVisualAttachments(message)) {
      return { handled: false };
    }

    const analysis = await this.visualAnalyzer.analyzeMessageAttachments({
      message,
      guildConfig: guildConfig ?? session.guildConfig,
      force: true
    }).catch((error) => {
      console.warn(`Voice visual ingest failed for ${message.channelId}:`, error?.message ?? error);
      return `NexaDesk recibio una prueba visual, pero no pudo analizarla automaticamente: ${String(error?.message ?? error).slice(0, 260)}`;
    });

    const content = [
      'Pruebas visuales analizadas para el modo voz:',
      `Mensaje visual: ${message.author?.username ?? 'usuario'} (${message.id})`,
      analysis || 'Prueba visual recibida. No hay analisis automatico disponible.'
    ].join('\n');

    await this.storage.addTranscriptMessage({
      guildId: session.guildId,
      channelId: session.ticketChannelId,
      messageId: `voice-visual-${message.id}`,
      authorId: session.voiceChannel.client.user.id,
      authorName: session.voiceChannel.client.user.username,
      authorBot: true,
      role: 'system',
      content,
      createdAt: new Date().toISOString()
    }).catch(() => {});

    return { handled: true, analysisReady: Boolean(analysis?.trim()) };
  }

  async #captureSpeech(session, userId) {
    if (session.stopped || session.speakers.has(userId)) return;

    const member = await session.voiceChannel.guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) return;

    this.#interruptVoicePlayback(session);

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
    const turnId = randomUUID();
    this.#interruptVoiceTurn(session);
    session.currentTurnId = turnId;

    session.processing = true;
    try {
      const preparedAudio = await prepareSpeechForTranscription(pcm);
      if (!preparedAudio) {
        if (shouldSendUnclearVoiceNotice(session)) {
          await session.textChannel.send(`No he detectado voz suficientemente clara, ${member}. Prueba a hablar un poco mas cerca del micro.`).catch(() => {});
        }
        return;
      }

      const transcript = await this.aiClient.transcribeAudio({
        audioBuffer: preparedAudio.wav,
        fileName: `nexadesk-${session.ticketChannelId}-${Date.now()}.wav`,
        model: this.config.GROQ_STT_MODEL
      });

      if (!this.#isCurrentVoiceTurn(session, turnId) || !transcript) return;

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

      void this.#recordVoiceAiQualitySignal(session, member, transcript).catch((error) => {
        console.warn(`Voice AI quality signal capture failed for ${session.ticketChannelId}:`, error?.message ?? error);
      });

      await session.textChannel.send(`**${member.displayName} por voz:** ${transcript.slice(0, 1_800)}`).catch(() => {});
      const answer = await this.#answerVoiceTicket(session, transcript, member);
      if (!this.#isCurrentVoiceTurn(session, turnId) || !answer) return;

      const speakPromise = this.config.VOICE_TTS_ENABLED
        ? this.#speak(session, answer.publicAnswer).catch((error) => {
          console.error(`Voice TTS failed for ${session.voiceChannelId}:`, error);
          if (this.#isCurrentVoiceTurn(session, turnId)) {
            session.textChannel.send('He respondido por texto, pero no pude reproducir la voz en la sala.').catch(() => {});
          }
        })
        : null;

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

      if (speakPromise) await speakPromise;
    } finally {
      if (this.#isCurrentVoiceTurn(session, turnId)) {
        session.processing = false;
        session.currentTurnId = null;
        session.currentAudioStream = null;
        session.currentPcmStream = null;
      }
    }
  }

  #interruptVoiceTurn(session) {
    if (!session.currentTurnId && !session.processing) return;
    this.#interruptVoicePlayback(session);
    session.currentAudioStream?.destroy?.();
    session.currentPcmStream?.destroy?.();
  }

  #interruptVoicePlayback(session) {
    if (!session?.player) return;
    try {
      session.player.stop(true);
    } catch {
      // The audio player may already be idle.
    }
  }

  #isCurrentVoiceTurn(session, turnId) {
    return !session.stopped && session.currentTurnId === turnId;
  }

  async #answerVoiceTicket(session, transcript, member) {
    const history = await this.storage.listTranscriptMessages(session.ticketChannelId);
    const visualContext = await this.#analyzeRecentVisualContext(session, transcript, history);
    const hasVisualEvidence = Boolean(visualContext.trim()) || hasRecentAnalyzedVisualEvidence(history);
    const system = [
      'Eres NexaDesk, soporte por voz para tickets de Discord.',
      'Responde en el mismo idioma del ultimo mensaje del usuario.',
      'Se muy breve y natural para poder leerlo en voz alta: maximo 2 frases, salvo emergencia.',
      'Recibes transcripciones limpias de audio. Si hay texto del usuario, nunca digas que no puedes procesar, escuchar o entender el audio.',
      'La transcripcion del ticket es memoria fuerte: usa mensajes de voz anteriores como contexto y no reinicies el caso.',
      'No afirmes que estas viendo una captura, imagen, video o adjunto salvo que la transcripcion incluya un adjunto o analisis visual real.',
      hasVisualEvidence
        ? 'Hay analisis visual real disponible: usalo para continuar sin pedir al usuario que copie el texto de la imagen.'
        : 'No hay adjuntos ni analisis visuales en la transcripcion: si el usuario dice que enviara una captura, espera a que la mande y no diagnostiques todavia.',
      visualContext ? `Analisis visual reciente para este turno:\n${visualContext}` : '',
      'No incluyas prefijos como "NexaDesk:", "[Voz]", ":Global:" ni nombres de emojis.',
      'Si el caso requiere staff humano, empieza con [ESCALATE] y explica el motivo sin repetir menciones.',
      'Si el usuario quiere reportar acoso, amenazas, abuso o incumplimientos, pide datos clave y escala al staff cuando sea necesario.',
      'No inventes datos del servidor. Usa solo el contexto proporcionado.',
      session.guildConfig.serverPrompt ? `Prompt del servidor:\n${compactVoiceContext(session.guildConfig.serverPrompt, 900)}` : '',
      session.guildConfig.serverInfo ? `Informacion del servidor:\n${compactVoiceContext(session.guildConfig.serverInfo, 700)}` : '',
      `Servidor: ${session.guildName}`,
      `Usuario hablando: ${member.displayName}`
    ].filter(Boolean).join('\n\n');

    const messages = buildVoiceConversationHistory(history, transcript);
    messages.push({
      role: 'user',
      content: `Ultimo mensaje transcrito de ${member.displayName}: ${sanitizeVoiceHistoryContent(transcript)}`
    });

    const raw = await this.aiClient.generate({
      system,
      messages,
      maxTokens: 115,
      temperature: 0.18
    });
    const parsed = parseVoiceEscalation(raw);
    if (!hasVisualEvidence && claimsToSeeVisualEvidence(parsed.publicAnswer)) {
      parsed.publicAnswer = 'Perfecto, mandame la captura cuando puedas y la reviso con el contexto del error que me has contado.';
      parsed.shouldEscalate = false;
    }
    return {
      ...parsed,
      mentionStaff: parsed.shouldEscalate && Boolean(session.guildConfig.staffRoleId)
    };
  }

  async #analyzeRecentVisualContext(session, transcript, history = []) {
    if (!this.visualAnalyzer || !shouldVoiceSearchVisualContext(transcript, history)) return '';

    const messages = await session.textChannel.messages.fetch({ limit: 10 }).catch(() => null);
    if (!messages?.size) return '';

    const recentVisualMessage = [...messages.values()]
      .filter((item) => !item.author?.bot && hasVisualAttachments(item))
      .filter((item) => Date.now() - Number(item.createdTimestamp ?? 0) <= 10 * 60_000)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      .at(0);

    if (!recentVisualMessage) return '';

    const existing = [...history]
      .reverse()
      .find((entry) => entry.messageId === `voice-visual-${recentVisualMessage.id}`);
    if (existing?.content?.trim()) return existing.content;

    const analysis = await this.visualAnalyzer.analyzeMessageAttachments({
      message: recentVisualMessage,
      guildConfig: session.guildConfig,
      force: true
    }).catch((error) => {
      console.warn(`Voice visual analysis failed for ${session.ticketChannelId}:`, error?.message ?? error);
      return '';
    });

    if (!analysis?.trim()) return '';

    const content = [
      'Pruebas visuales analizadas para el modo voz:',
      `Mensaje visual: ${recentVisualMessage.author?.username ?? 'usuario'} (${recentVisualMessage.id})`,
      analysis
    ].join('\n');

    await this.storage.addTranscriptMessage({
      guildId: session.guildId,
      channelId: session.ticketChannelId,
      messageId: `voice-visual-${recentVisualMessage.id}`,
      authorId: session.voiceChannel.client.user.id,
      authorName: session.voiceChannel.client.user.username,
      authorBot: true,
      role: 'system',
      content,
      createdAt: new Date().toISOString()
    }).catch(() => {});

    return content;
  }

  async #recordVoiceAiQualitySignal(session, member, transcript) {
    if (typeof this.storage.addAiQualitySignal !== 'function') return;

    const heuristic = detectAiQualitySignalHeuristic(transcript);
    if (!heuristic.shouldAnalyze) return;

    const history = await this.storage.listTranscriptMessages(session.ticketChannelId).catch(() => []);
    const previousAiMessage = [...history].reverse().find((entry) => entry.role === 'assistant' || entry.authorBot);
    let detection = heuristic;
    try {
      const answer = await this.aiClient.generate({
        system: [
          'Eres NexaDesk Quality Radar para tickets por voz.',
          'Detecta si el usuario se queja de que NexaDesk/IA funciona mal, no entiende, inventa, repite, falla en voz/audio, tarda mucho o si el usuario se enfada con el bot.',
          'No marques detected=true si solo esta reportando un problema externo.',
          'Responde SOLO JSON valido:',
          '{"detected":true|false,"category":"malfunction|wrong_answer|repetition|language|vision|voice|latency|tone|anger|general","severity":"low|medium|high|critical","sentiment":"confused|frustrated|angry","confidence":0-100,"reason":"frase breve"}'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [
              `Servidor: ${session.guildName}`,
              `Canal: #${session.ticket?.channelName ?? session.ticketChannelId}`,
              `Usuario: ${member.user.tag ?? member.user.id}`,
              '',
              'Ultima respuesta conocida de NexaDesk:',
              previousAiMessage?.content ? String(previousAiMessage.content).slice(0, 1200) : 'No disponible.',
              '',
              'Transcripcion de voz del usuario:',
              transcript.slice(0, 1800)
            ].join('\n').slice(0, 4200)
          }
        ]
      });
      detection = parseAiQualitySignalJson(answer, heuristic);
    } catch (error) {
      console.warn('Voice AI quality classifier fallback:', error?.message ?? error);
    }

    if (!detection?.detected) return;
    await this.storage.addAiQualitySignal({
      id: `ai-quality-voice-${session.ticketChannelId}-${randomUUID()}`,
      guildId: session.guildId,
      guildName: session.guildName,
      channelId: session.ticketChannelId,
      channelName: session.ticket?.channelName,
      messageId: null,
      userId: member.user.id,
      username: member.user.username,
      category: detection.category,
      severity: detection.severity,
      sentiment: detection.sentiment,
      confidence: detection.confidence,
      reason: detection.reason,
      userMessage: `[Voz] ${transcript}`.slice(0, 2400),
      previousAiMessage: previousAiMessage?.content?.slice(0, 2400),
      detectedBy: `voice-${detection.detectedBy ?? 'ai'}`,
      createdAt: new Date().toISOString()
    });
  }

  async #speak(session, text) {
    const safeText = prepareVoiceSpeechText(text, this.config.VOICE_TTS_MAX_CHARS);
    if (!safeText) return;

    if (shouldUseFishStreaming(this.config)) {
      try {
        await this.#speakFishStream(session, safeText);
        return;
      } catch (error) {
        console.error('Fish.audio streaming TTS failed, using buffered fallback:', normalizeProcessError(error));
      }
    }

    await this.#speakBuffered(session, safeText);
  }

  async #speakFishStream(session, text) {
    const startedAt = Date.now();
    const { audioStream, contentType } = await createFishAudioStream(text, this.config);
    const pcmStream = decodeTtsStreamToDiscordPcm(audioStream, this.config);
    session.currentAudioStream = audioStream;
    session.currentPcmStream = pcmStream;

    session.connection.subscribe(session.player);
    await entersState(session.connection, VoiceConnectionStatus.Ready, 5_000);
    const resource = createAudioResource(pcmStream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1.35);
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Playing, 8_000);
    console.log(`Voice TTS streaming started using Fish.audio (${contentType || 'audio stream'}, ${Date.now() - startedAt}ms to playback).`);
    await entersState(session.player, AudioPlayerStatus.Idle, 45_000).catch(() => {});
  }

  async #speakBuffered(session, text) {
    const audio = await this.#synthesizeSpeechWithFallback(text);
    if (!audio?.length) {
      throw new Error('TTS did not return audio bytes.');
    }
    const pcm = await decodeTtsToDiscordPcm(audio, this.config);
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
    const provider = this.config.VOICE_TTS_PROVIDER || 'auto';

    if (provider === 'fish') {
      try {
        return await synthesizeWithFishAudio(text, this.config);
      } catch (error) {
        console.error('Fish.audio TTS failed, trying local TTS fallback:', normalizeProcessError(error));
        return synthesizeLocalSpeech(text, this.config);
      }
    }

    if (['edge', 'piper', 'espeak'].includes(provider)) {
      return synthesizeLocalSpeech(text, this.config);
    }

    if (this.config.VOICE_TTS_LOCAL_FIRST) {
      return synthesizeLocalSpeech(text, this.config);
    }

    if (provider === 'auto' && this.config.FISH_AUDIO_API_KEY) {
      try {
        return await synthesizeWithFishAudio(text, this.config);
      } catch (error) {
        console.error('Fish.audio TTS failed, trying Groq TTS fallback:', normalizeProcessError(error));
      }
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

function decodeTtsToDiscordPcm(audioBuffer, config = {}) {
  return runProcessBuffer(config.FFMPEG_BIN || 'ffmpeg', [
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

function shouldUseFishStreaming(config = {}) {
  if (!config.VOICE_TTS_STREAMING_ENABLED || !String(config.FISH_AUDIO_API_KEY ?? '').trim()) return false;
  const provider = config.VOICE_TTS_PROVIDER || 'auto';
  return provider === 'fish' || (provider === 'auto' && !config.VOICE_TTS_LOCAL_FIRST);
}

async function createFishAudioStream(text, config = {}) {
  const apiKey = String(config.FISH_AUDIO_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('FISH_AUDIO_API_KEY is not configured.');
  }

  const payload = buildFishAudioPayload(text, config, {
    format: config.FISH_AUDIO_TTS_STREAM_FORMAT || 'mp3',
    latency: config.FISH_AUDIO_TTS_STREAM_LATENCY || 'balanced',
    chunkLength: Number(config.FISH_AUDIO_TTS_STREAM_CHUNK_LENGTH) || 80,
    minChunkLength: Number(config.FISH_AUDIO_TTS_STREAM_MIN_CHUNK_LENGTH) || 25,
    maxChars: Math.min(Number(config.FISH_AUDIO_TTS_MAX_CHARS) || 260, Number(config.VOICE_TTS_MAX_CHARS) || 220, 280),
    maxNewTokens: 384,
    mp3Bitrate: Number(config.FISH_AUDIO_TTS_STREAM_MP3_BITRATE) || 64
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.FISH_AUDIO_TIMEOUT_MS) || 5_000);
  try {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: config.FISH_AUDIO_TTS_MODEL || 's2.1-pro-free'
      },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('application/json')) {
      const body = await response.text().catch(() => '');
      throw new Error(`Fish.audio streaming TTS returned ${response.status}: ${body.slice(0, 300)}`);
    }
    if (!response.body) {
      throw new Error('Fish.audio streaming TTS did not return a readable body.');
    }

    clearTimeout(timeout);
    return {
      audioStream: Readable.fromWeb(response.body),
      contentType
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Fish.audio streaming TTS timed out before audio headers.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeTtsStreamToDiscordPcm(audioStream, config = {}) {
  const child = spawn(config.FFMPEG_BIN || 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-probesize',
    '32768',
    '-analyzeduration',
    '0',
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
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const output = new PassThrough({
    highWaterMark: SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE
  });
  const stderr = [];
  let inputErrored = false;

  child.stdout.pipe(output);
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8) stderr.push(chunk);
  });
  child.once('error', (error) => {
    if (!output.destroyed) output.destroy(error);
  });
  child.once('close', (code) => {
    if (code === 0 || inputErrored || output.destroyed) return;
    const message = Buffer.concat(stderr).toString('utf8').trim();
    output.destroy(new Error(message || `ffmpeg streaming decoder exited with code ${code}`));
  });

  child.stdin.once('error', (error) => {
    if (error.code !== 'EPIPE' && !output.destroyed) output.destroy(error);
  });
  audioStream.once('error', (error) => {
    inputErrored = true;
    child.stdin.destroy(error);
    if (!output.destroyed) output.destroy(error);
  });
  audioStream.pipe(child.stdin);

  return output;
}

async function prewarmFishAudio(config = {}) {
  const startedAt = Date.now();
  const { audioStream } = await createFishAudioStream('NexaDesk listo.', config);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      audioStream.destroy();
      resolve();
    }, Math.min(Number(config.FISH_AUDIO_TIMEOUT_MS) || 5_000, 5_000));

    audioStream.once('data', () => {
      clearTimeout(timeout);
      audioStream.destroy();
      resolve();
    });
    audioStream.once('end', () => {
      clearTimeout(timeout);
      resolve();
    });
    audioStream.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    audioStream.resume();
  });

  return Date.now() - startedAt;
}

async function synthesizeWithFishAudio(text, config = {}) {
  const apiKey = String(config.FISH_AUDIO_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('FISH_AUDIO_API_KEY is not configured.');
  }

  const payload = buildFishAudioPayload(text, config, {
    format: config.FISH_AUDIO_TTS_FORMAT || 'opus',
    latency: config.FISH_AUDIO_TTS_LATENCY || 'balanced',
    chunkLength: Number(config.FISH_AUDIO_TTS_CHUNK_LENGTH) || 220,
    minChunkLength: 50,
    maxChars: Number(config.FISH_AUDIO_TTS_MAX_CHARS) || 260,
    maxNewTokens: 512,
    mp3Bitrate: 128
  });
  if (!payload.text) return Buffer.alloc(0);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.FISH_AUDIO_TIMEOUT_MS) || 5_000);
  try {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: config.FISH_AUDIO_TTS_MODEL || 's2.1-pro-free'
      },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('application/json')) {
      const body = await response.text().catch(() => '');
      throw new Error(`Fish.audio TTS returned ${response.status}: ${body.slice(0, 300)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Fish.audio TTS timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildFishAudioPayload(text, config = {}, overrides = {}) {
  const normalizedText = normalizeFishAudioText(text);
  if (!normalizedText) return { text: '' };

  const maxChars = Math.max(120, Math.min(Number(overrides.maxChars) || 450, 500));
  const format = overrides.format || config.FISH_AUDIO_TTS_FORMAT || 'opus';
  const payload = {
    text: fitTextForFishAudio(normalizedText, maxChars),
    temperature: 0.64,
    top_p: 0.72,
    prosody: {
      speed: Number(config.FISH_AUDIO_TTS_SPEED) || 1.04,
      volume: Number(config.FISH_AUDIO_TTS_VOLUME) || 0,
      normalize_loudness: true
    },
    chunk_length: Number(overrides.chunkLength) || 220,
    normalize: true,
    format,
    latency: overrides.latency || config.FISH_AUDIO_TTS_LATENCY || 'balanced',
    max_new_tokens: Number(overrides.maxNewTokens) || 768,
    repetition_penalty: 1.16,
    min_chunk_length: Number(overrides.minChunkLength) || 50,
    condition_on_previous_chunks: false,
    early_stop_threshold: 1
  };

  if (format === 'opus' || format === 'pcm') {
    payload.sample_rate = 48_000;
  }

  const referenceId = String(config.FISH_AUDIO_TTS_REFERENCE_ID ?? '').trim();
  if (referenceId) {
    payload.reference_id = referenceId;
  }
  if (format === 'opus') {
    payload.opus_bitrate = Number(config.FISH_AUDIO_TTS_OPUS_BITRATE) || 32_000;
  }
  if (format === 'mp3') {
    payload.mp3_bitrate = Number(overrides.mp3Bitrate) || 128;
  }

  return payload;
}

function normalizeFishAudioText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactVoiceContext(content, maxChars) {
  const normalized = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(200, Number(maxChars) || 700);
  if (normalized.length <= limit) return normalized;

  const head = Math.floor(limit * 0.65);
  const tail = Math.max(120, limit - head - 24);
  return `${normalized.slice(0, head).trim()} ... ${normalized.slice(-tail).trim()}`;
}

function fitTextForFishAudio(text, maxChars) {
  if (text.length <= maxChars) return text;
  const suffix = ' Te dejo el resto por escrito en el ticket.';
  const slice = text.slice(0, Math.max(120, maxChars - suffix.length));
  const splitAt = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('; '),
    slice.lastIndexOf(', ')
  );
  return `${slice.slice(0, splitAt > 120 ? splitAt + 1 : slice.length).trim()}${suffix}`;
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
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: `${message.authorName}: ${message.content}`.slice(0, 700)
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

function shouldSendUnclearVoiceNotice(session) {
  const now = Date.now();
  if (now - Number(session.lastUnclearVoiceNoticeAt ?? 0) < 12_000) return false;
  session.lastUnclearVoiceNoticeAt = now;
  return true;
}

function shouldVoiceSearchVisualContext(transcript, history = []) {
  const normalized = normalizeComparableText([
    transcript,
    history.slice(-8).map((message) => message.content ?? '').join('\n')
  ].join('\n'));

  return /\b(?:captura|capturas|imagen|imagenes|foto|fotos|pantallazo|screenshot|adjunto|prueba|pruebas|ahi\s+las\s+tienes|te\s+la\s+mando|te\s+las\s+mando)\b/.test(normalized)
    || history.slice(-8).some((message) => /\[adjunto:|captura recibida|imagen recibida|video recibido/i.test(String(message.content ?? '')));
}

function hasRecentAnalyzedVisualEvidence(history = []) {
  return history
    .slice(-30)
    .some((message) => /pruebas visuales analizadas|analisis visual|pruebas visuales analizadas para el modo voz/i.test(String(message.content ?? '')));
}

function claimsToSeeVisualEvidence(content) {
  const normalized = normalizeComparableText(content);
  return [
    /\b(?:estoy|estoy viendo|veo|viendo|revisando)\b.*\b(?:captura|imagen|foto|pantallazo|screenshot)\b/,
    /\b(?:en|segun)\s+(?:la|tu)\s+(?:captura|imagen|foto|pantallazo|screenshot)\b/,
    /\bparece\s+que\s+el\s+error\s+se\s+debe\b/
  ].some((pattern) => pattern.test(normalized));
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
