export const CUSTOM_EMOJIS = {
  server: { id: '1504529355030925383', name: 'server', animated: true },
  check: { id: '1504523637506707637', name: 'check', animated: true },
  nexalogo: { id: '1504522931697619085', name: 'nexalogo', animated: true },
  rightArrow: { id: '1504521571036041278', name: 'rightarrow', animated: true },
  ban: { id: '1504520933853888673', name: 'ban', animated: false },
  wifi: { id: '1499732411829846116', name: 'wifi', animated: true },
  global: { id: '1499728413974593708', name: 'Global', animated: true }
};

export const DISCORD_EMOJIS = Object.fromEntries(
  Object.entries(CUSTOM_EMOJIS).map(([key, emoji]) => [
    key,
    `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
  ])
);

export function discordEmojiUrl(key, { size = 64 } = {}) {
  const emoji = CUSTOM_EMOJIS[key];
  if (!emoji) return '';
  const extension = emoji.animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${extension}?size=${size}&quality=lossless`;
}
