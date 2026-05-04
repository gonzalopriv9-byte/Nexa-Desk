export const PANEL_BUTTON_STYLES = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4
};

const DEFAULT_PANEL = {
  panelType: 'button',
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
  ticketMode: 'text',
  selectPlaceholder: 'Elige el tipo de ticket',
  componentIds: [],
  welcomeMessage: 'Hola {user}, soy NexaDesk.\nCuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.'
};

const DEFAULT_COMPONENT = {
  label: 'Soporte general',
  description: 'Abre un ticket de soporte general.',
  emoji: '',
  ticketCategoryId: '',
  ticketCategoryName: '',
  ticketMode: 'text',
  questions: [],
  welcomeMessage: 'Hola {user}, soy NexaDesk.\nAntes de empezar, he guardado tus respuestas para que el staff tenga contexto.'
};

export function normalizePanelOptions(input = {}) {
  return {
    panelType: normalizePanelType(input.panelType),
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
    ticketMode: normalizeTicketMode(input.ticketMode),
    selectPlaceholder: cleanString(input.selectPlaceholder, DEFAULT_PANEL.selectPlaceholder, 100),
    componentIds: normalizeStringList(input.componentIds).slice(0, 25),
    welcomeMessage: cleanString(input.welcomeMessage, DEFAULT_PANEL.welcomeMessage, 1200)
  };
}

export function normalizeTicketComponent(input = {}) {
  const existingId = cleanString(input.id, '', 80);
  return {
    id: existingId || createComponentId(),
    label: cleanString(input.label, DEFAULT_COMPONENT.label, 100),
    description: cleanString(input.description, DEFAULT_COMPONENT.description, 100),
    emoji: cleanString(input.emoji, DEFAULT_COMPONENT.emoji, 100),
    ticketCategoryId: cleanString(input.ticketCategoryId, DEFAULT_COMPONENT.ticketCategoryId, 32),
    ticketCategoryName: cleanString(input.ticketCategoryName, DEFAULT_COMPONENT.ticketCategoryName, 100),
    ticketMode: normalizeTicketMode(input.ticketMode),
    questions: normalizeStringList(input.questions).slice(0, 5).map((question) => cleanString(question, '', 45)).filter(Boolean),
    welcomeMessage: cleanString(input.welcomeMessage, DEFAULT_COMPONENT.welcomeMessage, 1200),
    createdAt: input.createdAt || new Date().toISOString()
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

export function buildPanelActionRow(panel, ticketComponents = []) {
  const normalized = normalizePanelOptions(panel);
  if (normalized.panelType === 'menu') {
    return buildPanelSelectRow(normalized, ticketComponents);
  }

  return {
    type: 1,
    components: [buildPanelButton(normalized)]
  };
}

export function buildPanelSelectRow(panel, ticketComponents = []) {
  const normalized = normalizePanelOptions(panel);
  const componentIdSet = new Set(normalized.componentIds);
  const options = ticketComponents
    .map(normalizeTicketComponent)
    .filter((component) => componentIdSet.has(component.id))
    .slice(0, 25)
    .map((component) => {
      const option = {
        label: component.label,
        value: component.id,
        description: component.description
      };
      const emoji = parseDiscordEmoji(component.emoji);
      if (emoji) option.emoji = emoji;
      return option;
    });

  if (!options.length) {
    throw new Error('Crea y selecciona al menos un componente para publicar un panel con menu.');
  }

  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: createPanelSelectCustomId(),
        placeholder: normalized.selectPlaceholder,
        min_values: 1,
        max_values: 1,
        options
      }
    ]
  };
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

function normalizePanelType(type) {
  return String(type ?? '').toLowerCase() === 'menu' ? 'menu' : 'button';
}

function normalizeTicketMode(mode) {
  return String(mode ?? '').toLowerCase() === 'voice' ? 'voice' : DEFAULT_PANEL.ticketMode;
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

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createComponentId() {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createPanelSelectCustomId() {
  return `nexadesk:select_ticket_component:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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
