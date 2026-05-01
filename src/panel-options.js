export const PANEL_BUTTON_STYLES = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4
};

const DEFAULT_PANEL = {
  title: 'Centro de soporte',
  description: 'Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.',
  buttonLabel: 'Abrir ticket',
  buttonStyle: 'primary',
  buttonEmoji: '',
  embedColor: '#ffffff',
  authorName: '',
  authorIconUrl: '',
  footerText: 'NexaDesk AI Support',
  imageUrl: '',
  thumbnailUrl: '',
  ticketCategoryId: '',
  ticketCategoryName: '',
  welcomeMessage: 'Hola {user}, soy NexaDesk.\nCuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.'
};

export function normalizePanelOptions(input = {}) {
  return {
    title: cleanString(input.title, DEFAULT_PANEL.title, 256),
    description: cleanString(input.description, DEFAULT_PANEL.description, 4096),
    buttonLabel: cleanString(input.buttonLabel, DEFAULT_PANEL.buttonLabel, 80),
    buttonStyle: normalizeButtonStyle(input.buttonStyle),
    buttonEmoji: cleanString(input.buttonEmoji, DEFAULT_PANEL.buttonEmoji, 100),
    embedColor: normalizeHexColor(input.embedColor ?? input.color, DEFAULT_PANEL.embedColor),
    authorName: cleanString(input.authorName, DEFAULT_PANEL.authorName, 256),
    authorIconUrl: cleanUrl(input.authorIconUrl),
    footerText: cleanString(input.footerText, DEFAULT_PANEL.footerText, 2048),
    imageUrl: cleanUrl(input.imageUrl),
    thumbnailUrl: cleanUrl(input.thumbnailUrl),
    ticketCategoryId: cleanString(input.ticketCategoryId, DEFAULT_PANEL.ticketCategoryId, 32),
    ticketCategoryName: cleanString(input.ticketCategoryName, DEFAULT_PANEL.ticketCategoryName, 100),
    welcomeMessage: cleanString(input.welcomeMessage, DEFAULT_PANEL.welcomeMessage, 1200)
  };
}

export function buildPanelEmbed(panel) {
  const normalized = normalizePanelOptions(panel);
  const embed = {
    title: normalized.title,
    description: normalized.description,
    color: panelColorToNumber(normalized.embedColor),
    footer: { text: normalized.footerText }
  };

  if (normalized.authorName) {
    embed.author = {
      name: normalized.authorName,
      ...(normalized.authorIconUrl ? { icon_url: normalized.authorIconUrl } : {})
    };
  }
  if (normalized.imageUrl) embed.image = { url: normalized.imageUrl };
  if (normalized.thumbnailUrl) embed.thumbnail = { url: normalized.thumbnailUrl };

  return embed;
}

export function buildPanelButton(panel) {
  const normalized = normalizePanelOptions(panel);
  const button = {
    type: 2,
    style: PANEL_BUTTON_STYLES[normalized.buttonStyle] ?? PANEL_BUTTON_STYLES.primary,
    custom_id: 'nexadesk:create_ticket',
    label: normalized.buttonLabel
  };

  const emoji = parseDiscordEmoji(normalized.buttonEmoji);
  if (emoji) button.emoji = emoji;

  return button;
}

export function panelColorToNumber(color) {
  return Number.parseInt(normalizeHexColor(color).slice(1), 16);
}

export function panelWelcomeMessage(panel, userMention) {
  const normalized = normalizePanelOptions(panel);
  return normalized.welcomeMessage
    .replaceAll('{user}', userMention)
    .replaceAll('{bot}', 'NexaDesk');
}

function normalizeButtonStyle(style) {
  const key = String(style ?? '').toLowerCase();
  return Object.hasOwn(PANEL_BUTTON_STYLES, key) ? key : DEFAULT_PANEL.buttonStyle;
}

function normalizeHexColor(color, fallback = DEFAULT_PANEL.embedColor) {
  const value = String(color ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`;
  return fallback;
}

function cleanString(value, fallback = '', maxLength = 500) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function parseDiscordEmoji(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^:[\w-]+:$/.test(text)) return null;

  const customEmoji = text.match(/^<(a?):([A-Za-z0-9_]+):(\d+)>$/);
  if (customEmoji) {
    return {
      animated: customEmoji[1] === 'a',
      name: customEmoji[2],
      id: customEmoji[3]
    };
  }

  return { name: text.slice(0, 32) };
}
