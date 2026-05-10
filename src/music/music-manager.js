import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import { normalizeMusicConfig } from './music-config.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const DEFAULT_FORMAT = 'bestaudio[ext=webm]/bestaudio/best';
const URL_PATTERN = /^https?:\/\/\S+/i;

export class MusicManager {
  constructor({ aiClient = null, config = {} }) {
    this.aiClient = aiClient;
    this.config = config;
    this.sessions = new Map();
  }

  getSession(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  async search(query, limit = 5) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) throw new Error('Escribe una busqueda o un enlace.');

    const result = await readJsonProcess(this.#ytDlpBin(), [
      '--dump-single-json',
      '--no-warnings',
      '--flat-playlist',
      `ytsearch${Math.max(Math.min(limit, 10), 1)}:${cleanQuery}`
    ], { timeoutMs: this.#metadataTimeoutMs() });

    return normalizeSearchEntries(result?.entries ?? []).slice(0, limit);
  }

  async enqueue({ interaction, query, guildConfig }) {
    const musicConfig = normalizeMusicConfig(guildConfig?.music);
    if (!musicConfig.enabled) {
      throw new Error('El sistema de musica esta desactivado en este servidor desde la dashboard.');
    }

    const memberVoiceChannel = interaction.member?.voice?.channel;
    if (!memberVoiceChannel) {
      throw new Error('Entra primero a un canal de voz para que pueda unirme.');
    }

    const session = await this.#ensureSession({ interaction, guildConfig, musicConfig, voiceChannel: memberVoiceChannel });
    if (session.queue.length >= musicConfig.maxQueueSize) {
      throw new Error(`La cola ya tiene ${musicConfig.maxQueueSize} canciones. Sube el limite desde la dashboard o espera a que avance.`);
    }

    const track = await this.resolveTrack(query, { requestedBy: interaction.user });
    session.queue.push(track);
    session.autoQueue = musicConfig.autoQueue;
    const started = session.player.state.status === AudioPlayerStatus.Idle && !session.current;
    if (started) {
      this.#playNext(session).catch((error) => this.#handlePlaybackError(session, error));
    }

    return {
      track,
      position: session.queue.length,
      started,
      queueLength: session.queue.length
    };
  }

  async resolveTrack(query, { requestedBy = null, autoQueued = false } = {}) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) throw new Error('Escribe una busqueda o un enlace.');

    const metadata = URL_PATTERN.test(cleanQuery)
      ? await this.#metadataForUrl(cleanQuery)
      : await this.#metadataForSearch(cleanQuery);
    const entry = normalizeTrackMetadata(metadata);
    if (!entry?.webpageUrl) {
      throw new Error('No he encontrado una cancion reproducible para esa busqueda.');
    }

    return {
      id: entry.id || randomUUID(),
      title: entry.title || cleanQuery,
      url: entry.webpageUrl,
      duration: entry.duration ?? null,
      uploader: entry.uploader || entry.channel || 'Fuente desconocida',
      thumbnail: entry.thumbnail || '',
      requestedById: requestedBy?.id ?? null,
      requestedByName: requestedBy?.username ?? 'Autocola IA',
      autoQueued,
      createdAt: new Date().toISOString()
    };
  }

  skip(guildId) {
    const session = this.getSession(guildId);
    if (!session) return false;
    session.skipRequested = true;
    this.#killCurrentProcess(session);
    session.player.stop(true);
    return true;
  }

  stop(guildId) {
    const session = this.getSession(guildId);
    if (!session) return false;

    session.destroyed = true;
    session.queue = [];
    session.current = null;
    this.#killCurrentProcess(session);
    session.player.stop(true);
    this.sessions.delete(guildId);
    try {
      getVoiceConnection(guildId)?.destroy();
    } catch {
      // Connection can already be gone.
    }
    return true;
  }

  pause(guildId) {
    return this.getSession(guildId)?.player.pause(true) ?? false;
  }

  resume(guildId) {
    return this.getSession(guildId)?.player.unpause() ?? false;
  }

  setVolume(guildId, percent) {
    const session = this.getSession(guildId);
    if (!session) return null;
    session.volume = clampVolume(percent);
    session.currentResource?.volume?.setVolume(session.volume / 100);
    return session.volume;
  }

  setAutoQueue(guildId, enabled) {
    const session = this.getSession(guildId);
    if (!session) return null;
    session.autoQueue = Boolean(enabled);
    return session.autoQueue;
  }

  getQueue(guildId) {
    const session = this.getSession(guildId);
    if (!session) {
      return {
        active: false,
        current: null,
        queue: [],
        history: [],
        autoQueue: false,
        volume: 0
      };
    }

    return {
      active: true,
      current: session.current,
      queue: [...session.queue],
      history: [...session.history],
      autoQueue: session.autoQueue,
      volume: session.volume,
      voiceChannelName: session.voiceChannelName
    };
  }

  async #ensureSession({ interaction, guildConfig, musicConfig, voiceChannel }) {
    const existing = this.sessions.get(interaction.guildId);
    if (existing) {
      if (existing.voiceChannelId !== voiceChannel.id) {
        throw new Error(`Ya estoy reproduciendo musica en ${existing.voiceChannelName}. Entra ahi o usa /musica parar.`);
      }
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });
    connection.subscribe(player);

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const session = {
      guildId: interaction.guildId,
      guildName: interaction.guild.name,
      textChannel: interaction.channel,
      textChannelId: interaction.channelId,
      voiceChannelId: voiceChannel.id,
      voiceChannelName: voiceChannel.name,
      connection,
      player,
      queue: [],
      history: [],
      current: null,
      currentProcess: null,
      currentResource: null,
      autoQueue: musicConfig.autoQueue,
      volume: clampVolume(musicConfig.defaultVolume),
      guildConfig,
      destroyed: false,
      skipRequested: false,
      autoQueueInFlight: false
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (session.destroyed) return;
      this.#killCurrentProcess(session);
      if (session.current) {
        session.history.unshift(session.current);
        session.history = session.history.slice(0, 18);
      }
      session.current = null;
      session.currentResource = null;
      this.#playNext(session).catch((error) => this.#handlePlaybackError(session, error));
    });
    player.on('error', (error) => this.#handlePlaybackError(session, error));
    connection.on(VoiceConnectionStatus.Disconnected, () => this.stop(session.guildId));

    this.sessions.set(interaction.guildId, session);
    return session;
  }

  async #playNext(session) {
    if (session.destroyed) return;
    if (!session.queue.length && session.autoQueue) {
      await this.#enqueueAiSuggestion(session);
    }

    const track = session.queue.shift();
    if (!track) {
      await session.textChannel.send('Cola terminada. Me quedo disponible por si quieres poner mas musica.').catch(() => {});
      return;
    }

    session.current = track;
    session.skipRequested = false;
    const streamUrl = await this.#getStreamUrl(track.url);
    const ffmpeg = spawn(this.#ffmpegBin(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      streamUrl,
      '-vn',
      '-af',
      'aresample=async=1:first_pts=0',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      String(CHANNELS),
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    session.currentProcess = ffmpeg;
    const stderr = [];
    ffmpeg.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (stderr.length > 8) stderr.shift();
    });
    ffmpeg.once('error', (error) => {
      if (session.currentProcess !== ffmpeg) return;
      this.#handlePlaybackError(session, error);
    });
    ffmpeg.once('close', (code) => {
      if (session.currentProcess !== ffmpeg) return;
      if (session.destroyed || session.skipRequested || code === 0) return;
      const details = Buffer.concat(stderr).toString('utf8').slice(-500);
      this.#handlePlaybackError(session, new Error(`ffmpeg termino con codigo ${code}. ${details}`));
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(session.volume / 100);
    session.currentResource = resource;
    session.connection.subscribe(session.player);
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Playing, 12_000);
    await session.textChannel.send({
      content: [
        `Reproduciendo ahora: **${track.title}**`,
        track.uploader ? `Fuente: ${track.uploader}` : '',
        track.autoQueued ? 'Autocola IA: elegida por similitud con el historial.' : `Pedida por: ${track.requestedByName}`
      ].filter(Boolean).join('\n')
    }).catch(() => {});
  }

  async #enqueueAiSuggestion(session) {
    if (session.autoQueueInFlight || !session.history.length) return;
    session.autoQueueInFlight = true;
    try {
      const query = await this.#buildAutoQueueQuery(session.history);
      if (!query) return;
      const normalizedExisting = new Set([...session.history, ...session.queue, session.current]
        .filter(Boolean)
        .map((track) => normalizeComparable(track.title)));
      const suggestion = await this.resolveTrack(query, { autoQueued: true });
      if (normalizedExisting.has(normalizeComparable(suggestion.title))) return;
      session.queue.push(suggestion);
      await session.textChannel.send(`Autocola IA preparo: **${suggestion.title}**`).catch(() => {});
    } catch (error) {
      console.error('AI autoqueue failed:', error);
    } finally {
      session.autoQueueInFlight = false;
    }
  }

  async #buildAutoQueueQuery(history) {
    const latest = history.slice(0, 8).map((track, index) => `${index + 1}. ${track.title} - ${track.uploader || 'desconocido'}`).join('\n');
    if (!this.aiClient?.generate) {
      return `song similar to ${history[0]?.title ?? ''}`.trim();
    }

    const answer = await this.aiClient.generate({
      system: [
        'Eres un DJ de Discord. Debes elegir la siguiente cancion para una autocola.',
        'Usa el historial para mantener genero, energia e idioma parecidos, pero evita repetir artista/cancion si puedes.',
        'Responde SOLO con una busqueda corta para YouTube Music. Sin comillas, sin explicaciones.'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `Ultimas canciones reproducidas:\n${latest}\n\nDame la siguiente busqueda.`
        }
      ]
    });

    return normalizeQuery(answer)
      .replace(/^["'`]+|["'`]+$/g, '')
      .split('\n', 1)[0]
      .slice(0, 120);
  }

  async #metadataForSearch(query) {
    const result = await readJsonProcess(this.#ytDlpBin(), [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      `ytsearch1:${query}`
    ], { timeoutMs: this.#metadataTimeoutMs() });
    return Array.isArray(result?.entries) ? result.entries[0] : result;
  }

  async #metadataForUrl(url) {
    return readJsonProcess(this.#ytDlpBin(), [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      url
    ], { timeoutMs: this.#metadataTimeoutMs() });
  }

  async #getStreamUrl(url) {
    const output = await readTextProcess(this.#ytDlpBin(), [
      '-f',
      this.config.MUSIC_YTDLP_FORMAT || DEFAULT_FORMAT,
      '--no-playlist',
      '--no-warnings',
      '--get-url',
      url
    ], { timeoutMs: this.#metadataTimeoutMs() });
    const streamUrl = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!streamUrl) throw new Error('yt-dlp no devolvio una URL de audio reproducible.');
    return streamUrl;
  }

  #handlePlaybackError(session, error) {
    if (session.destroyed) return;
    console.error(`Music playback failed for guild ${session.guildId}:`, error);
    const message = normalizeProcessError(error);
    session.textChannel?.send(`No pude reproducir esa cancion: ${message}`).catch(() => {});
    this.#killCurrentProcess(session);
    session.current = null;
    session.currentResource = null;
    setTimeout(() => this.#playNext(session).catch((nextError) => {
      console.error(`Music queue recovery failed for guild ${session.guildId}:`, nextError);
    }), 800);
  }

  #killCurrentProcess(session) {
    const process = session.currentProcess;
    session.currentProcess = null;
    if (!process || process.killed) return;
    try {
      process.kill('SIGKILL');
    } catch {
      // Best effort cleanup.
    }
  }

  #ytDlpBin() {
    return this.config.YTDLP_BIN || 'yt-dlp';
  }

  #ffmpegBin() {
    return this.config.FFMPEG_BIN || 'ffmpeg';
  }

  #metadataTimeoutMs() {
    return Number(this.config.MUSIC_METADATA_TIMEOUT_MS) || 18_000;
  }
}

function normalizeSearchEntries(entries) {
  return entries
    .map((entry) => normalizeTrackMetadata(entry))
    .filter((entry) => entry.title && entry.webpageUrl);
}

function normalizeTrackMetadata(entry = {}) {
  const webpageUrl = entry.webpage_url
    || entry.original_url
    || (entry.url && String(entry.url).startsWith('http') ? entry.url : '')
    || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '');
  return {
    id: entry.id,
    title: entry.title,
    webpageUrl,
    duration: entry.duration,
    uploader: entry.uploader || entry.channel,
    thumbnail: entry.thumbnail
  };
}

function readJsonProcess(command, args, options = {}) {
  return readTextProcess(command, args, options).then((output) => {
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(`No pude leer la respuesta de ${command}: ${String(error?.message ?? error)}`);
    }
  });
}

function readTextProcess(command, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} tardo demasiado en responder.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${command} no esta disponible: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (code === 0 && output) {
        resolve(output);
        return;
      }
      const details = Buffer.concat(stderr).toString('utf8').trim() || output || `codigo ${code}`;
      reject(new Error(`${command} fallo: ${details.slice(0, 700)}`));
    });
  });
}

function normalizeProcessError(error) {
  return String(error?.message ?? error ?? 'error desconocido').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeQuery(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 85;
  return Math.min(Math.max(Math.round(number), 1), 150);
}

export function formatTrackDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return 'Directo/desconocido';
  const minutes = Math.floor(total / 60);
  const rest = Math.floor(total % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}
