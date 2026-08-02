import crypto from 'node:crypto';

const TRANSCRIPT_ACCESS_TOKEN_VERSION = 'v1';

export function buildTranscriptText({ ticket, messages = [] }) {
  const lines = [
    'NexaDesk Transcript',
    `Guild: ${ticket?.guildName ?? ticket?.guildId ?? 'Unknown'}`,
    `Channel: #${ticket?.channelName ?? ticket?.channelId ?? 'unknown'}`,
    `Status: ${ticket?.status ?? 'unknown'}`,
    `Created: ${formatDate(ticket?.createdAt)}`,
    `Exported: ${new Date().toISOString()}`,
    '',
    'Messages:',
    '---------'
  ];

  if (!messages.length) {
    lines.push('No messages were saved for this ticket.');
    return lines.join('\n');
  }

  for (const message of messages) {
    lines.push([
      `[${formatDate(message.createdAt)}]`,
      `${message.authorName || message.role || 'Unknown'}${message.authorBot ? ' [BOT]' : ''}:`,
      normalizeContent(message.content)
    ].join(' '));
  }

  return `${lines.join('\n')}\n`;
}

export function buildTranscriptFileName(ticket) {
  const channel = sanitizeFilePart(ticket?.channelName ?? ticket?.channelId ?? 'ticket');
  const date = new Date().toISOString().slice(0, 10);
  return `nexadesk-${channel}-${date}.txt`;
}

export function buildTranscriptReplayUrl({ dashboardBaseUrl, channelId, userId, secret }) {
  const url = new URL(`/tickets/${encodeURIComponent(channelId)}/replay`, dashboardBaseUrl);
  url.searchParams.set('viewer', String(userId));
  url.searchParams.set('token', buildTranscriptAccessToken({ channelId, userId, secret }));
  return url.toString();
}

export function buildTranscriptAccessToken({ channelId, userId, secret }) {
  return crypto
    .createHmac('sha256', normalizeTranscriptTokenSecret(secret))
    .update(buildTranscriptAccessPayload({ channelId, userId }))
    .digest('base64url');
}

export function verifyTranscriptAccessToken({ channelId, userId, token, secret }) {
  const provided = String(token ?? '').trim();
  if (!provided) return false;
  const expected = buildTranscriptAccessToken({ channelId, userId, secret });
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function normalizeContent(content = '') {
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\n  ');
}

function formatDate(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function sanitizeFilePart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'ticket';
}

function buildTranscriptAccessPayload({ channelId, userId }) {
  return [
    TRANSCRIPT_ACCESS_TOKEN_VERSION,
    String(channelId ?? '').trim(),
    String(userId ?? '').trim()
  ].join(':');
}

function normalizeTranscriptTokenSecret(secret) {
  const value = String(secret ?? '').trim();
  return value || 'nexadesk-transcript-access-fallback';
}
