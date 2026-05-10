import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Innertube } from 'youtubei.js';
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
import { buildSpotifySongQuery, isSpotifyTrackUrl } from './spotify-client.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const DEFAULT_FORMAT = '251/250/249/140/bestaudio[ext=webm]/bestaudio/best';
const URL_PATTERN = /^https?:\/\/\S+/i;
const YOUTUBE_WATCH_URL = 'https://www.youtube.com/watch?v=';
const CACHE_TTL_MS = 1000 * 60 * 20;
const QUICK_SEARCH_TIMEOUT_MS = 4_500;
const MUSIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const AUDIO_HINT_PATTERN = /\b(official audio|audio oficial|topic|provided to youtube|visualizer)\b/i;
const LYRIC_VIDEO_PATTERN = /\b(letra|lyrics|lyric video|subtitulado|subtitulos)\b/i;
const VIDEOCLIP_PATTERN = /\b(official video|video oficial|videoclip|video clip|music video|mv|trailer|teaser|shorts?)\b/i;
const ALTERED_VERSION_PATTERN = /\b(live|en vivo|concert|cover|karaoke|instrumental|remix|slowed|reverb|sped up|nightcore|edit|intro|extended)\b/i;

export class MusicManager {
  constructor({ aiClient = null, spotifyClient = null, config = {} }) {
    this.aiClient = aiClient;
    this.spotifyClient = spotifyClient;
    this.config = config;
    this.sessions = new Map();
    this.searchCache = new Map();
    this.streamCache = new Map();
    this.streamInflight = new Map();
    this.aiQueryCache = new Map();
    this.spotifyCache = new Map();
    this.youtubeClientPromise = null;
    if (this.#fastStreamEnabled()) {
      this.#getYoutubeClient().catch((error) => {
        console.error('YouTube fast stream warmup failed:', normalizeProcessError(error));
      });
    }
  }

  getSession(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  async search(query, limit = 5, options = {}) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) throw new Error('Escribe una busqueda o un enlace.');

    if (options.preferSpotify) {
      const spotifyResults = await this.#spotifySearchEntries(cleanQuery, limit).catch((error) => {
        console.error('Spotify music search failed, falling back to YouTube:', normalizeProcessError(error));
        return [];
      });
      if (spotifyResults.length) return spotifyResults;
    }

    const cached = this.#getCache(this.searchCache, `yt:${limit}:${cleanQuery.toLowerCase()}`);
    if (cached) return cached;

    const quickResults = await this.#quickYoutubeSearch(cleanQuery, limit).catch((error) => {
      console.error('Fast YouTube search failed, falling back to yt-dlp:', normalizeProcessError(error));
      return [];
    });
    if (quickResults.length) {
      const ranked = rankPlayableCandidates(quickResults, cleanQuery).slice(0, limit);
      this.#setCache(this.searchCache, `yt:${limit}:${cleanQuery.toLowerCase()}`, ranked);
      return ranked;
    }

    const result = await readJsonProcess(this.#ytDlpBin(), [
      '--dump-single-json',
      '--no-warnings',
      '--flat-playlist',
      `ytsearch${Math.max(Math.min(limit, 10), 1)}:${cleanQuery}`
    ], { timeoutMs: this.#metadataTimeoutMs() });

    const entries = rankPlayableCandidates(normalizeSearchEntries(result?.entries ?? []), cleanQuery).slice(0, limit);
    this.#setCache(this.searchCache, `yt:${limit}:${cleanQuery.toLowerCase()}`, entries);
    return entries;
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

    const existingSession = this.sessions.get(interaction.guildId);
    if (existingSession?.queue?.length >= musicConfig.maxQueueSize) {
      throw new Error(`La cola ya tiene ${musicConfig.maxQueueSize} canciones. Sube el limite desde la dashboard o espera a que avance.`);
    }

    let track = null;
    const sessionPromise = this.#ensureSession({ interaction, guildConfig, musicConfig, voiceChannel: memberVoiceChannel });
    const hadExistingSession = Boolean(existingSession);
    try {
      track = await this.resolveTrack(query, { requestedBy: interaction.user });
      this.#warmStreamUrl(track.url);
    } catch (error) {
      const session = await sessionPromise.catch(() => null);
      if (!hadExistingSession && session && !session.current && !session.queue.length) {
        this.stop(interaction.guildId);
      }
      throw error;
    }

    const session = await sessionPromise;
    if (session.queue.length >= musicConfig.maxQueueSize) {
      throw new Error(`La cola ya tiene ${musicConfig.maxQueueSize} canciones. Sube el limite desde la dashboard o espera a que avance.`);
    }

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

    const spotifyTrack = isSpotifyTrackUrl(cleanQuery)
      ? await this.#spotifyTrackFromUrl(cleanQuery).catch((error) => {
        console.error('Spotify URL lookup failed, trying direct metadata:', normalizeProcessError(error));
        return null;
      })
      : null;
    const metadata = spotifyTrack
      ? await this.#metadataForSpotifyTrack(spotifyTrack, cleanQuery)
      : URL_PATTERN.test(cleanQuery)
        ? await this.#metadataForUrl(cleanQuery)
        : await this.#metadataForSongOnlySearch(cleanQuery);
    const entry = normalizeTrackMetadata(metadata);
    if (!entry?.webpageUrl) {
      throw new Error('No he encontrado una cancion reproducible para esa busqueda.');
    }
    const spotify = entry.spotify ?? null;

    return {
      id: entry.id || randomUUID(),
      title: spotify ? `${spotify.artistText} - ${spotify.title}` : entry.title || cleanQuery,
      url: entry.webpageUrl,
      duration: spotify?.duration ?? entry.duration ?? null,
      uploader: spotify ? `Spotify: ${spotify.artistText}` : entry.uploader || entry.channel || 'Fuente desconocida',
      thumbnail: spotify?.thumbnail || entry.thumbnail || '',
      sourceTitle: entry.title || '',
      sourceUploader: entry.uploader || entry.channel || '',
      spotify,
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
      selfDeaf: false,
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
      currentInputProcess: null,
      currentAbortController: null,
      currentResource: null,
      autoQueue: musicConfig.autoQueue,
      volume: clampVolume(musicConfig.defaultVolume),
      guildConfig,
      destroyed: false,
      skipRequested: false,
      recoveringFromError: false,
      autoQueueInFlight: false
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (session.destroyed) return;
      if (session.recoveringFromError) {
        session.recoveringFromError = false;
        return;
      }
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
    this.#warmQueuedStreams(session);
    const streamInfo = await this.#getStreamInfo(track.url);
    const { ffmpeg, abortController, inputProcess } = await this.#spawnFfmpeg(streamInfo);

    session.currentProcess = ffmpeg;
    session.currentInputProcess = inputProcess;
    session.currentAbortController = abortController;
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
    const [quickResult] = await this.search(query, 1).catch(() => []);
    if (quickResult) return quickResult;

    const result = await readJsonProcess(this.#ytDlpBin(), [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      `ytsearch1:${query}`
    ], { timeoutMs: this.#metadataTimeoutMs() });
    return Array.isArray(result?.entries) ? result.entries[0] : result;
  }

  async #metadataForSongOnlySearch(query) {
    const spotifyTrack = await this.#searchSpotifyTrack(query).catch((error) => {
      console.error('Spotify lookup failed, using AI YouTube query:', normalizeProcessError(error));
      return null;
    });
    if (spotifyTrack) {
      return this.#metadataForSpotifyTrack(spotifyTrack, query);
    }

    const optimizedQuery = await this.#buildSongOnlySearchQuery(query);
    const [optimizedResults, fallbackResults] = await Promise.all([
      this.search(optimizedQuery, 8).catch(() => []),
      this.search(`${query} official audio topic`, 6).catch(() => [])
    ]);
    const candidates = [...optimizedResults, ...fallbackResults];
    const best = rankPlayableCandidates(dedupeTracks(candidates), query)[0];
    if (best) return best;
    return this.#metadataForSearch(optimizedQuery);
  }

  async #buildSongOnlySearchQuery(query) {
    const cleanQuery = normalizeQuery(query);
    const cached = this.#getCache(this.aiQueryCache, cleanQuery.toLowerCase());
    if (cached) return cached;

    const fallback = `${cleanQuery} official audio topic`;
    if (!this.aiClient?.generate) {
      this.#setCache(this.aiQueryCache, cleanQuery.toLowerCase(), fallback);
      return fallback;
    }

    try {
      const answer = await this.aiClient.generate({
        system: [
          'Eres un buscador musical para un bot de Discord.',
          'Convierte la peticion del usuario en una busqueda corta para encontrar SOLO la cancion limpia, no videoclip.',
          'Prioriza audio oficial, Topic, official audio o audio oficial.',
          'Evita terminos como official video, videoclip, live, remix, cover, extended intro, trailer o reaction.',
          'Si el usuario solo da titulo, mantenlo y anade official audio topic.',
          'Responde SOLO con la busqueda, sin comillas ni explicaciones.'
        ].join('\n'),
        messages: [
          { role: 'user', content: cleanQuery }
        ]
      });
      const optimized = normalizeQuery(answer)
        .replace(/^["'`]+|["'`]+$/g, '')
        .split('\n', 1)[0]
        .slice(0, 140);
      const result = optimized || fallback;
      this.#setCache(this.aiQueryCache, cleanQuery.toLowerCase(), result);
      return result;
    } catch (error) {
      console.error('AI song-only query failed, using fallback:', normalizeProcessError(error));
      this.#setCache(this.aiQueryCache, cleanQuery.toLowerCase(), fallback, 1000 * 60 * 5);
      return fallback;
    }
  }

  async #metadataForSpotifyTrack(spotifyTrack, originalQuery) {
    const primaryQuery = buildSpotifySongQuery(spotifyTrack);
    const compact = `${spotifyTrack.artistText} ${spotifyTrack.title}`.replace(/\s+/g, ' ').trim();
    const [primaryResults, officialResults, topicResults] = await Promise.all([
      this.search(primaryQuery, 8).catch(() => []),
      this.search(`${compact} official audio`, 6).catch(() => []),
      this.search(`${compact} topic`, 6).catch(() => [])
    ]);
    const candidates = [...primaryResults, ...officialResults, ...topicResults];
    const best = rankPlayableCandidates(dedupeTracks(candidates), originalQuery, { spotifyTrack })[0];
    if (best) return { ...best, spotify: spotifyTrack };

    const fallback = await this.#metadataForSearch(primaryQuery);
    return { ...fallback, spotify: spotifyTrack };
  }

  async #searchSpotifyTrack(query) {
    const tracks = await this.#spotifySearchTracks(query, 6);
    return rankSpotifyCandidates(tracks, query)[0] ?? null;
  }

  async #spotifyTrackFromUrl(url) {
    if (!this.spotifyClient?.isConfigured?.()) return null;
    const cached = this.#getCache(this.spotifyCache, `url:${url}`);
    if (cached) return cached;
    const track = await this.spotifyClient.getTrackFromUrl(url);
    if (track) this.#setCache(this.spotifyCache, `url:${url}`, track);
    return track;
  }

  async #spotifySearchTracks(query, limit = 5) {
    if (!this.spotifyClient?.isConfigured?.()) return [];
    const cleanQuery = normalizeQuery(query);
    const cacheKey = `search:${limit}:${cleanQuery.toLowerCase()}`;
    const cached = this.#getCache(this.spotifyCache, cacheKey);
    if (cached) return cached;
    const tracks = await this.spotifyClient.searchTracks(cleanQuery, limit);
    const ranked = rankSpotifyCandidates(tracks, cleanQuery).slice(0, limit);
    this.#setCache(this.spotifyCache, cacheKey, ranked);
    return ranked;
  }

  async #spotifySearchEntries(query, limit = 5) {
    const tracks = await this.#spotifySearchTracks(query, limit);
    return tracks.map((track) => ({
      id: `spotify:${track.id}`,
      title: `${track.artistText} - ${track.title}`,
      webpageUrl: track.spotifyUrl,
      duration: track.duration,
      uploader: `Spotify: ${track.album || track.artistText}`,
      thumbnail: track.thumbnail,
      spotify: track
    }));
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

  async #getStreamInfo(url) {
    const cached = this.#getCache(this.streamCache, url);
    if (cached) return normalizeStreamInfo(cached);
    const inflight = this.streamInflight.get(url);
    if (inflight) return inflight;

    const promise = this.#getFastYoutubeStreamInfo(url)
      .catch((error) => {
        console.error('YouTube fast stream failed, falling back to yt-dlp:', normalizeProcessError(error));
        return this.#getYtDlpStreamInfo(url);
      })
      .finally(() => {
        this.streamInflight.delete(url);
      });
    this.streamInflight.set(url, promise);
    return promise;
  }

  async #getYtDlpStreamInfo(url) {
    const streamInfo = {
      url,
      transport: 'ytdlp-pipe',
      source: 'yt-dlp',
      args: this.#buildYtDlpPipeArgs(url)
    };
    this.#setCache(this.streamCache, url, streamInfo, 1000 * 60 * 8);
    return streamInfo;
  }

  #buildYtDlpPipeArgs(url) {
    const args = [
      '-f',
      this.config.MUSIC_YTDLP_FORMAT || DEFAULT_FORMAT,
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout',
      '8',
      '-o',
      '-',
      url
    ];
    if (this.config.MUSIC_YTDLP_FORCE_IPV4) {
      args.splice(args.length - 1, 0, '--force-ipv4');
    }
    return args;
  }

  async #getFastYoutubeStreamInfo(url) {
    if (!this.#fastStreamEnabled()) throw new Error('fast stream desactivado');
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) throw new Error('no es una URL de YouTube compatible');

    const youtube = await this.#getYoutubeClient();
    const clients = parseFastStreamClients(this.config.MUSIC_FAST_STREAM_CLIENTS);
    let lastError = null;
    for (const client of clients) {
      try {
        const startedAt = Date.now();
        const info = await youtube.getBasicInfo(videoId, { client });
        const format = chooseInnertubeAudioFormat([
          ...(info.streaming_data?.formats ?? []),
          ...(info.streaming_data?.adaptive_formats ?? [])
        ]);
        if (!format?.url) throw new Error(`sin formato de audio usable con ${client}`);
        const streamUrl = String(format.url);
        const streamInfo = {
          url: streamUrl,
          transport: 'fetch-range',
          source: `innertube:${client}`,
          contentLength: Number(format.content_length || format.contentLength) || parseContentLengthFromUrl(streamUrl)
        };
        await validateFastStreamInfo(streamInfo);
        this.#setCache(this.streamCache, url, streamInfo, 1000 * 60 * 8);
        if (this.config.MUSIC_DEBUG_STREAMS) {
          console.log(`YouTube fast stream ${client} ${format.itag} in ${Date.now() - startedAt}ms`);
        }
        return streamInfo;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no se pudo resolver stream rapido');
  }

  #getYoutubeClient() {
    if (!this.youtubeClientPromise) {
      this.youtubeClientPromise = Innertube.create();
    }
    return this.youtubeClientPromise;
  }

  #fastStreamEnabled() {
    return this.config.MUSIC_FAST_STREAM_ENABLED !== false
      && String(this.config.MUSIC_FAST_STREAM_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  #warmStreamUrl(url) {
    if (!url) return;
    this.#getStreamInfo(url).catch((error) => {
      console.error('Music stream prewarm failed:', normalizeProcessError(error));
    });
  }

  #warmQueuedStreams(session) {
    for (const track of session.queue.slice(0, 2)) {
      this.#warmStreamUrl(track.url);
    }
  }

  async #spawnFfmpeg(streamInfo) {
    if (streamInfo.transport === 'fetch-range') {
      const abortController = new AbortController();
      const ffmpeg = spawn(this.#ffmpegBin(), buildFfmpegArgs('pipe:0', false), { stdio: ['pipe', 'pipe', 'pipe'] });
      const body = Readable.from(streamRangeChunks(streamInfo, abortController.signal));
      body.on('error', (error) => {
        if (!ffmpeg.killed) ffmpeg.stdin.destroy(error);
      });
      ffmpeg.stdin.on('error', () => {});
      body.pipe(ffmpeg.stdin);
      return { ffmpeg, abortController, inputProcess: null };
    }

    if (streamInfo.transport === 'ytdlp-pipe') {
      const ytdlp = spawn(this.#ytDlpBin(), streamInfo.args || this.#buildYtDlpPipeArgs(streamInfo.url), { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpeg = spawn(this.#ffmpegBin(), buildFfmpegArgs('pipe:0', false), { stdio: ['pipe', 'pipe', 'pipe'] });
      ytdlp.stdout.pipe(ffmpeg.stdin);
      ytdlp.stderr.on('data', () => {});
      ytdlp.once('close', () => {
        ffmpeg.stdin.end();
      });
      ffmpeg.stdin.on('error', () => {});
      return { ffmpeg, abortController: null, inputProcess: ytdlp };
    }

    return {
      ffmpeg: spawn(this.#ffmpegBin(), buildFfmpegArgs(streamInfo.url, true), { stdio: ['ignore', 'pipe', 'pipe'] }),
      abortController: null,
      inputProcess: null
    };
  }

  async #quickYoutubeSearch(query, limit = 5) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
    const html = await fetchText(url, { timeoutMs: QUICK_SEARCH_TIMEOUT_MS });
    const blocks = html.split('"videoRenderer":').slice(1);
    const results = [];
    const seen = new Set();

    for (const block of blocks) {
      if (results.length >= limit) break;
      const id = matchJsonString(block, /"videoId":"([^"]+)"/);
      if (!id || seen.has(id)) continue;
      const title = matchJsonString(block, /"title":\{"runs":\[\{"text":"([^"]+)"/)
        || matchJsonString(block, /"title":\{"simpleText":"([^"]+)"/);
      if (!title) continue;
      const uploader = matchJsonString(block, /"ownerText":\{"runs":\[\{"text":"([^"]+)"/)
        || matchJsonString(block, /"shortBylineText":\{"runs":\[\{"text":"([^"]+)"/)
        || 'YouTube';
      const durationLabel = matchJsonString(block, /"lengthText":\{.*?"simpleText":"([^"]+)"/);
      seen.add(id);
      results.push({
        id,
        title,
        webpageUrl: `${YOUTUBE_WATCH_URL}${id}`,
        duration: parseDurationLabel(durationLabel),
        uploader,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      });
    }

    return results;
  }

  #getCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  #setCache(cache, key, value, ttlMs = CACHE_TTL_MS) {
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  #handlePlaybackError(session, error) {
    if (session.destroyed) return;
    session.recoveringFromError = true;
    console.error(`Music playback failed for guild ${session.guildId}:`, error);
    const message = normalizeProcessError(error);
    session.textChannel?.send(`No pude reproducir esa cancion: ${message}`).catch(() => {});
    this.#killCurrentProcess(session);
    session.current = null;
    session.currentResource = null;
    setTimeout(() => this.#playNext(session).catch((nextError) => {
      console.error(`Music queue recovery failed for guild ${session.guildId}:`, nextError);
    }).finally(() => {
      session.recoveringFromError = false;
    }), 800);
  }

  #killCurrentProcess(session) {
    session.currentAbortController?.abort();
    session.currentAbortController = null;
    const inputProcess = session.currentInputProcess;
    session.currentInputProcess = null;
    if (inputProcess && !inputProcess.killed) {
      try {
        inputProcess.kill('SIGKILL');
      } catch {
        // Best effort cleanup.
      }
    }
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

function buildFfmpegArgs(input, reconnect) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(reconnect ? [
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5'
    ] : []),
    '-i',
    input,
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
  ];
}

function rankPlayableCandidates(entries, query, context = {}) {
  return [...entries]
    .map((entry, index) => ({
      entry,
      score: scorePlayableCandidate(entry, query, context) - index * 0.25
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);
}

function scorePlayableCandidate(track, query, context = {}) {
  const title = normalizeComparable(track.title);
  const uploader = normalizeComparable(track.uploader || track.channel);
  const rawTitle = String(track.title ?? '');
  const rawUploader = String(track.uploader || track.channel || '');
  const normalizedQuery = normalizeComparable(query);
  let score = 100;

  if (/\btopic\b/i.test(rawUploader) || /\btopic\b/i.test(rawTitle)) score += 55;
  if (AUDIO_HINT_PATTERN.test(rawTitle) || AUDIO_HINT_PATTERN.test(rawUploader)) score += 38;
  if (/\bofficial audio\b|\baudio oficial\b/i.test(rawTitle)) score += 28;
  if (LYRIC_VIDEO_PATTERN.test(rawTitle)) score -= 16;
  if (track.duration && track.duration >= 95 && track.duration <= 480) score += 18;
  if (track.duration && track.duration > 540) score -= 45;
  if (track.duration && track.duration < 70) score -= 40;

  if (VIDEOCLIP_PATTERN.test(rawTitle)) score -= 95;
  if (VIDEOCLIP_PATTERN.test(rawUploader)) score -= 35;
  if (ALTERED_VERSION_PATTERN.test(rawTitle) && !queryAllowsAlteredVersion(normalizedQuery, rawTitle)) score -= 65;
  if (/\bfull album\b|\balbum completo\b|\bplaylist\b|\bmix\b/i.test(rawTitle)) score -= 90;
  if (/\breaction\b|\breaccion\b|\breview\b|\banalisis\b/i.test(rawTitle)) score -= 100;

  for (const token of normalizedQuery.split(' ').filter((part) => part.length > 2).slice(0, 10)) {
    if (title.includes(token) || uploader.includes(token)) score += 2;
  }

  const spotifyTrack = context.spotifyTrack;
  if (spotifyTrack) {
    const spotifyTitle = normalizeComparable(spotifyTrack.title);
    const spotifyArtists = normalizeComparable(spotifyTrack.artistText);
    const artistTokens = spotifyArtists.split(' ').filter((part) => part.length > 2).slice(0, 8);
    const titleTokens = spotifyTitle.split(' ').filter((part) => part.length > 2).slice(0, 8);

    if (spotifyTitle && (title.includes(spotifyTitle) || spotifyTitle.includes(title))) score += 45;
    for (const token of titleTokens) {
      if (title.includes(token)) score += 5;
    }
    for (const token of artistTokens) {
      if (title.includes(token) || uploader.includes(token)) score += 6;
    }
    if (artistTokens.some((token) => uploader.includes(token)) && /\btopic\b/i.test(rawUploader)) score += 24;

    if (spotifyTrack.duration && track.duration) {
      const diff = Math.abs(Number(track.duration) - Number(spotifyTrack.duration));
      if (diff <= 8) score += 42;
      else if (diff <= 18) score += 26;
      else if (diff <= 35) score += 8;
      else if (diff > 90) score -= 75;
      else if (diff > 45) score -= 38;
    }
  }

  return score;
}

function rankSpotifyCandidates(tracks, query) {
  const normalizedQuery = normalizeComparable(query);
  return [...tracks]
    .map((track, index) => {
      const text = normalizeComparable(`${track.artistText} ${track.title} ${track.album}`);
      let score = 100 - index * 0.5;
      for (const token of normalizedQuery.split(' ').filter((part) => part.length > 2).slice(0, 12)) {
        if (text.includes(token)) score += 7;
      }
      const title = normalizeComparable(track.title);
      if (title && normalizedQuery.includes(title)) score += 24;
      if (track.duration && track.duration >= 70 && track.duration <= 540) score += 8;
      return { track, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track);
}

function queryAllowsAlteredVersion(normalizedQuery, rawTitle) {
  const title = normalizeComparable(rawTitle);
  for (const keyword of ['live', 'en vivo', 'cover', 'karaoke', 'instrumental', 'remix', 'slowed', 'reverb', 'sped up', 'nightcore']) {
    const normalizedKeyword = normalizeComparable(keyword);
    if (title.includes(normalizedKeyword) && normalizedQuery.includes(normalizedKeyword)) return true;
  }
  return false;
}

function dedupeTracks(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = entry.id || entry.webpageUrl || normalizeComparable(entry.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function normalizeStreamInfo(value) {
  if (typeof value === 'string') {
    return { url: value, transport: 'direct', source: 'legacy' };
  }
  return {
    url: value?.url || '',
    transport: value?.transport || 'direct',
    source: value?.source || 'unknown',
    contentLength: Number(value?.contentLength) || parseContentLengthFromUrl(value?.url)
  };
}

async function* streamRangeChunks(streamInfo, signal) {
  const chunkSize = 1024 * 1024;
  const total = Number(streamInfo.contentLength) || 0;
  let start = 0;

  while (!signal.aborted && (!total || start < total)) {
    const end = total ? Math.min(start + chunkSize - 1, total - 1) : start + chunkSize - 1;
    const response = await fetch(streamInfo.url, {
      signal,
      headers: {
        Range: `bytes=${start}-${end}`,
        'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
      }
    });

    if (response.status === 416) return;
    if (!response.ok && response.status !== 206) {
      throw new Error(`fast stream range ${start}-${end} respondio ${response.status}`);
    }

    const chunk = Buffer.from(await response.arrayBuffer());
    if (!chunk.length) return;
    yield chunk;
    start += chunk.length;
    if (!total && chunk.length < chunkSize) return;
  }
}

async function validateFastStreamInfo(streamInfo) {
  const total = Number(streamInfo.contentLength) || 0;
  const starts = total > 1024 * 1024
    ? [0, 1024 * 1024, Math.max(total - 1024, 0)]
    : [0];

  for (const start of starts) {
    const end = Math.min(start + 1023, Math.max(total - 1, start + 1023));
    const response = await fetch(streamInfo.url, {
      headers: {
        Range: `bytes=${start}-${end}`,
        'user-agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
      }
    });
    response.body?.cancel().catch(() => {});
    if (!response.ok && response.status !== 206) {
      throw new Error(`fast stream no valido en rango ${start}-${end}: ${response.status}`);
    }
  }
}

function parseContentLengthFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return Number(url.searchParams.get('clen')) || 0;
  } catch {
    return 0;
  }
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
    thumbnail: entry.thumbnail,
    spotify: entry.spotify || entry.spotifyTrack || null
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

async function fetchText(url, { timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': MUSIC_USER_AGENT,
        'accept-language': 'es-ES,es;q=0.9,en;q=0.7'
      }
    });
    if (!response.ok) throw new Error(`YouTube respondio ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function matchJsonString(value, pattern) {
  const match = pattern.exec(value);
  return match ? decodeJsonText(match[1]) : '';
}

function decodeJsonText(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return String(value ?? '')
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function parseDurationLabel(value) {
  const parts = String(value ?? '')
    .split(':')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
  if (!parts.length) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function extractYouTubeVideoId(value) {
  const text = String(value || '');
  const patterns = [
    /(?:youtube\.com\/watch\?.*?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/i,
    /^[a-zA-Z0-9_-]{11}$/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1] || match[0];
  }
  return '';
}

function parseFastStreamClients(value) {
  const clients = String(value || 'ANDROID,IOS')
    .split(',')
    .map((client) => client.trim().toUpperCase())
    .filter(Boolean);
  return clients.length ? clients : ['ANDROID', 'IOS'];
}

function chooseInnertubeAudioFormat(formats = []) {
  const preferredItags = new Map([
    [251, 1000],
    [250, 900],
    [249, 800],
    [140, 700],
    [139, 500],
    [600, 350],
    [599, 300]
  ]);
  return formats
    .filter((format) => format?.url && String(format.mime_type || format.mimeType || '').includes('audio'))
    .map((format) => ({
      format,
      score: (preferredItags.get(Number(format.itag)) || 0)
        + (Number(format.bitrate) || 0) / 1000
        + (String(format.mime_type || '').includes('opus') ? 35 : 0)
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.format)[0] ?? null;
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
