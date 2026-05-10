export function normalizeMusicConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled !== false,
    autoQueue: source.autoQueue !== false,
    defaultVolume: clampNumber(source.defaultVolume, 1, 150, 85),
    maxQueueSize: clampNumber(source.maxQueueSize, 5, 100, 50),
    djRoleId: source.djRoleId ? String(source.djRoleId) : ''
  };
}

export function summarizeMusicConfig(value = {}) {
  const music = normalizeMusicConfig(value);
  return {
    enabled: music.enabled,
    autoQueue: music.autoQueue,
    defaultVolume: music.defaultVolume,
    maxQueueSize: music.maxQueueSize,
    hasDjRole: Boolean(music.djRoleId)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}
