import { ChannelType } from 'discord.js';

const TEXT_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum
]);

const ANNOUNCEMENT_KEYWORDS = [
  'anuncios',
  'anuncio',
  'announcements',
  'announcement',
  'news',
  'noticias',
  'novedades',
  'avisos',
  'aviso',
  'comunicados',
  'updates',
  'actualizaciones'
];

const SUPPORT_KEYWORDS = ['soporte', 'support', 'ayuda', 'help', 'tickets', 'ticket', 'asistencia', 'atencion'];
const RULES_KEYWORDS = ['normas', 'reglas', 'rules', 'normativa', 'reglamento'];
const FAQ_KEYWORDS = ['faq', 'dudas', 'preguntas', 'guia', 'guide', 'informacion', 'info'];
const TICKET_CATEGORY_KEYWORDS = ['tickets', 'ticket', 'soporte', 'support', 'ayuda', 'asistencia'];

export function analyzeGuildChannelsForDiscovery(channelsInput = []) {
  const channels = [...channelsInput]
    .filter(Boolean)
    .map(normalizeChannelForDiscovery)
    .filter(Boolean);

  const textChannels = channels.filter((channel) => TEXT_TYPES.has(channel.type));
  const categories = channels.filter((channel) => channel.type === ChannelType.GuildCategory);
  const announcement = pickBest(textChannels, ANNOUNCEMENT_KEYWORDS, (channel) => channel.type === ChannelType.GuildAnnouncement ? 20 : 0);
  const support = pickBest(textChannels, SUPPORT_KEYWORDS);
  const rules = pickBest(textChannels, RULES_KEYWORDS);
  const faq = pickBest(textChannels, FAQ_KEYWORDS);
  const ticketCategory = pickBest(categories, TICKET_CATEGORY_KEYWORDS);

  return {
    source: 'nexadesk-smart-discovery',
    scannedAt: new Date().toISOString(),
    announcementChannelId: announcement?.id ?? null,
    announcementChannelName: announcement?.name ?? null,
    announcementConfidence: announcement?.score ?? 0,
    supportChannelId: support?.id ?? null,
    supportChannelName: support?.name ?? null,
    rulesChannelId: rules?.id ?? null,
    rulesChannelName: rules?.name ?? null,
    faqChannelId: faq?.id ?? null,
    faqChannelName: faq?.name ?? null,
    suggestedTicketCategoryId: ticketCategory?.id ?? null,
    suggestedTicketCategoryName: ticketCategory?.name ?? null,
    hints: buildDiscoveryHints({ announcement, support, rules, faq, ticketCategory })
  };
}

export function normalizeDiscoveryConfig(value = {}) {
  const source = value?.discovery && typeof value.discovery === 'object' ? value.discovery : value;
  return {
    source: source?.source ?? 'nexadesk-smart-discovery',
    scannedAt: source?.scannedAt ?? null,
    announcementChannelId: source?.announcementChannelId ?? null,
    announcementChannelName: source?.announcementChannelName ?? null,
    announcementConfidence: Number(source?.announcementConfidence ?? 0),
    supportChannelId: source?.supportChannelId ?? null,
    supportChannelName: source?.supportChannelName ?? null,
    rulesChannelId: source?.rulesChannelId ?? null,
    rulesChannelName: source?.rulesChannelName ?? null,
    faqChannelId: source?.faqChannelId ?? null,
    faqChannelName: source?.faqChannelName ?? null,
    suggestedTicketCategoryId: source?.suggestedTicketCategoryId ?? null,
    suggestedTicketCategoryName: source?.suggestedTicketCategoryName ?? null,
    hints: Array.isArray(source?.hints) ? source.hints.slice(0, 8) : []
  };
}

export function hasUsefulDiscovery(discovery = {}) {
  const normalized = normalizeDiscoveryConfig(discovery);
  return Boolean(
    normalized.announcementChannelId
    || normalized.supportChannelId
    || normalized.rulesChannelId
    || normalized.faqChannelId
    || normalized.suggestedTicketCategoryId
  );
}

export function buildDiscoveryContext(discovery = {}) {
  const normalized = normalizeDiscoveryConfig(discovery);
  const lines = [
    normalized.announcementChannelName ? `Canal de anuncios detectado: #${normalized.announcementChannelName}` : null,
    normalized.rulesChannelName ? `Canal de normas detectado: #${normalized.rulesChannelName}` : null,
    normalized.faqChannelName ? `Canal FAQ/info detectado: #${normalized.faqChannelName}` : null,
    normalized.supportChannelName ? `Canal de soporte detectado: #${normalized.supportChannelName}` : null,
    normalized.suggestedTicketCategoryName ? `Categoria sugerida para tickets: ${normalized.suggestedTicketCategoryName}` : null
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : 'No hay canales utiles detectados todavia.';
}

export function normalizeChannelNameForDiscovery(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeChannelForDiscovery(channel) {
  const name = String(channel.name ?? '').trim();
  if (!name || !channel.id) return null;
  return {
    id: channel.id,
    name,
    type: channel.type,
    position: Number(channel.position ?? 0),
    normalizedName: normalizeChannelNameForDiscovery(name)
  };
}

function pickBest(channels, keywords, bonus = () => 0) {
  return channels
    .map((channel) => ({
      ...channel,
      score: scoreChannelName(channel, keywords) + bonus(channel)
    }))
    .filter((channel) => channel.score >= 24)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    [0] ?? null;
}

function scoreChannelName(channel, keywords) {
  const normalized = channel.normalizedName;
  const compact = normalized.replace(/\s+/g, '');
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  let score = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeChannelNameForDiscovery(keyword);
    const compactKeyword = normalizedKeyword.replace(/\s+/g, '');
    if (normalized === normalizedKeyword) score = Math.max(score, 100);
    if (tokens.has(normalizedKeyword)) score = Math.max(score, 86);
    if (compact === compactKeyword) score = Math.max(score, 82);
    if (normalized.includes(normalizedKeyword)) score = Math.max(score, 64);
    if (compact.includes(compactKeyword)) score = Math.max(score, 58);
  }
  return score;
}

function buildDiscoveryHints({ announcement, support, rules, faq, ticketCategory }) {
  return [
    announcement ? `Canal de anuncios detectado: #${announcement.name}. Util para avisos de estado o changelogs.` : 'No he detectado un canal claro de anuncios.',
    ticketCategory ? `Categoria candidata para tickets: ${ticketCategory.name}.` : 'No he detectado una categoria obvia de tickets/soporte.',
    support ? `Canal publico de soporte detectado: #${support.name}.` : null,
    rules ? `Canal de normas detectado: #${rules.name}. Puede alimentar el contexto IA.` : null,
    faq ? `Canal de FAQ/info detectado: #${faq.name}. Puede alimentar respuestas frecuentes.` : null
  ].filter(Boolean);
}
