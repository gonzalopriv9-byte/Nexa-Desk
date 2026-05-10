const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_TRACK_URL_PATTERN = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/|spotify:track:)([a-zA-Z0-9]+)/i;

export class SpotifyClient {
  constructor({ clientId = '', clientSecret = '', market = 'ES' } = {}) {
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.market = String(market || 'ES').trim().toUpperCase();
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async searchTracks(query, limit = 5) {
    if (!this.isConfigured()) return [];
    const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
    if (!cleanQuery) return [];

    const params = new URLSearchParams({
      type: 'track',
      limit: String(Math.max(Math.min(Number(limit) || 5, 10), 1)),
      q: cleanQuery
    });
    if (this.market) params.set('market', this.market);

    const data = await this.#request(`/search?${params.toString()}`);
    return (data?.tracks?.items ?? [])
      .map((item) => normalizeSpotifyTrack(item))
      .filter(Boolean);
  }

  async getTrackFromUrl(url) {
    if (!this.isConfigured()) return null;
    const id = parseSpotifyTrackId(url);
    if (!id) return null;
    const params = new URLSearchParams();
    if (this.market) params.set('market', this.market);
    const data = await this.#request(`/tracks/${encodeURIComponent(id)}?${params.toString()}`);
    return normalizeSpotifyTrack(data);
  }

  async #request(path) {
    const token = await this.#getAccessToken();
    const response = await fetch(`${SPOTIFY_API_URL}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json'
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Spotify respondio ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  async #getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Spotify token fallo ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max((Number(data.expires_in) || 3600) - 60, 60) * 1000;
    return this.token;
  }
}

export function isSpotifyTrackUrl(value) {
  return SPOTIFY_TRACK_URL_PATTERN.test(String(value || ''));
}

export function buildSpotifySongQuery(track) {
  if (!track) return '';
  return `${track.artistText} - ${track.title} official audio topic`.replace(/\s+/g, ' ').trim();
}

function parseSpotifyTrackId(value) {
  const match = SPOTIFY_TRACK_URL_PATTERN.exec(String(value || ''));
  return match?.[1] ?? '';
}

function normalizeSpotifyTrack(item) {
  if (!item?.id || !item?.name) return null;
  const artists = (item.artists ?? [])
    .map((artist) => ({ id: artist.id, name: artist.name }))
    .filter((artist) => artist.name);
  const image = [...(item.album?.images ?? [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return {
    id: item.id,
    title: item.name,
    artists,
    artistText: artists.map((artist) => artist.name).join(', ') || 'Artista desconocido',
    album: item.album?.name || '',
    duration: item.duration_ms ? Math.round(item.duration_ms / 1000) : null,
    durationMs: item.duration_ms ?? null,
    explicit: Boolean(item.explicit),
    isrc: item.external_ids?.isrc || '',
    spotifyUrl: item.external_urls?.spotify || `https://open.spotify.com/track/${item.id}`,
    previewUrl: item.preview_url || '',
    thumbnail: image?.url || ''
  };
}
