export const DEFAULT_WELCOME_CONFIG = {
  enabled: false,
  channelId: null,
  channelName: null,
  message: 'Bienvenido {user} a {server}. Si necesitas ayuda, abre un ticket y NexaDesk te guiara paso a paso.',
  dmEnabled: false,
  dmMessage: 'Gracias por entrar a {server}. Si tienes dudas, abre un ticket y el equipo te ayudara con NexaDesk.',
  roleId: null,
  roleName: null
};

export function normalizeWelcomeConfig(value = {}) {
  const source = value?.welcome && typeof value.welcome === 'object' ? value.welcome : value;
  return {
    enabled: toBoolean(source?.enabled, DEFAULT_WELCOME_CONFIG.enabled),
    channelId: cleanId(source?.channelId),
    channelName: normalizeOptionalString(source?.channelName),
    message: normalizeMessage(source?.message, DEFAULT_WELCOME_CONFIG.message, 1200),
    dmEnabled: toBoolean(source?.dmEnabled, DEFAULT_WELCOME_CONFIG.dmEnabled),
    dmMessage: normalizeMessage(source?.dmMessage, DEFAULT_WELCOME_CONFIG.dmMessage, 1200),
    roleId: cleanId(source?.roleId),
    roleName: normalizeOptionalString(source?.roleName)
  };
}

export function formatWelcomeTemplate(template = '', { userMention = '', username = '', serverName = '' } = {}) {
  return String(template || DEFAULT_WELCOME_CONFIG.message)
    .replaceAll('{user}', userMention || username || 'usuario')
    .replaceAll('{username}', username || userMention || 'usuario')
    .replaceAll('{server}', serverName || 'este servidor')
    .trim()
    .slice(0, 1800);
}

function normalizeMessage(value, fallback, maxLength) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeOptionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function cleanId(value) {
  const id = String(value ?? '').trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}
