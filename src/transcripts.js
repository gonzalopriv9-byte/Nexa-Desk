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
