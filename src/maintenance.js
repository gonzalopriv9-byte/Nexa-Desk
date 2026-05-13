import { isPremiumEntitled } from './premium.js';

export const DEFAULT_MAINTENANCE_DELAY_MS = 3500;

export function normalizeMaintenanceState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const delayMs = Number(source.delayMs);
  return {
    enabled: Boolean(source.enabled),
    message: String(source.message ?? '').trim().slice(0, 500),
    delayMs: Number.isFinite(delayMs) && delayMs >= 500 && delayMs <= 15000
      ? Math.round(delayMs)
      : DEFAULT_MAINTENANCE_DELAY_MS,
    enabledBy: source.enabledBy ? String(source.enabledBy) : null,
    enabledAt: source.enabledAt ?? null,
    disabledBy: source.disabledBy ? String(source.disabledBy) : null,
    disabledAt: source.disabledAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function isMaintenanceActive(value = {}) {
  return normalizeMaintenanceState(value).enabled;
}

export function shouldApplyMaintenanceToGuild({ maintenance, guildConfig }) {
  return isMaintenanceActive(maintenance) && !isPremiumEntitled(guildConfig ?? {});
}

export function buildMaintenanceNoticeText(value = {}) {
  const maintenance = normalizeMaintenanceState(value);
  return maintenance.message || [
    'NexaDesk esta en modo mantenimiento global.',
    'En servidores Free la IA puede responder hasta un 50% mas lenta mientras ajustamos el servicio.',
    'Los servidores Premium mantienen prioridad normal.'
  ].join('\n');
}

export function getMaintenanceDelayMs(value = {}) {
  return normalizeMaintenanceState(value).delayMs;
}
