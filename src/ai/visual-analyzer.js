import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const MAX_IMAGE_URL_BYTES = 20_000_000;
const IMAGE_EXTENSION_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

export class VisualAnalyzer {
  constructor({ visionClient, enabled = true, videoFrameCount = 3, videoMaxBytes = 25_000_000 }) {
    this.visionClient = visionClient;
    this.enabled = enabled;
    this.videoFrameCount = videoFrameCount;
    this.videoMaxBytes = videoMaxBytes;
  }

  async analyzeMessageAttachments({ message, guildConfig, force = false }) {
    if (!this.enabled || !this.visionClient) return '';
    if (!force && !shouldAnalyzeVisualProof(message, guildConfig)) return '';

    const media = collectVisualAttachments(message);
    if (!media.length) return '';

    const notes = [];
    const imageInputs = [];
    for (const attachment of media) {
      if (imageInputs.length >= 5) break;

      if (attachment.kind === 'image') {
        if (attachment.size && attachment.size > MAX_IMAGE_URL_BYTES) {
          notes.push(`No pude analizar la imagen "${attachment.name}": supera el limite de 20 MB para vision.`);
          continue;
        }

        const dataUrl = await attachmentToDataUrl(attachment, MAX_IMAGE_URL_BYTES).catch((error) => {
          notes.push(`La imagen "${attachment.name}" no se pudo descargar localmente (${normalizeError(error)}); intento analizarla por URL directa.`);
          return attachment.url;
        });

        imageInputs.push({
          label: attachment.name,
          url: dataUrl,
          source: 'image'
        });
        continue;
      }

      const frames = await this.#extractVideoFrames(attachment).catch((error) => {
        notes.push(`No pude analizar el video "${attachment.name}": ${normalizeError(error)}.`);
        return [];
      });
      imageInputs.push(...frames.slice(0, 5 - imageInputs.length));
    }

    if (!imageInputs.length) {
      return notes.length ? `Pruebas visuales recibidas, pero no analizadas:\n- ${notes.join('\n- ')}` : '';
    }

    const analysis = await this.visionClient.analyzeImages({
      system: [
        'Eres un analista visual para tickets de soporte en Discord.',
        'Describe solo lo que se puede observar en las imagenes o fotogramas.',
        'Lee texto visible, errores, nombres de pantallas, botones, estados y cualquier detalle util para soporte.',
        'No inventes datos que no se vean. Si algo no es claro, dilo.',
        'Si la imagen se puede leer parcialmente, extrae lo visible y di que parte esta borrosa, no respondas que no puedes verla entera.'
      ].join('\n'),
      prompt: buildVisualPrompt({ message, media, imageInputs }),
      images: imageInputs
    });

    return [
      'Pruebas visuales analizadas por NexaDesk:',
      analysis,
      notes.length ? `Notas tecnicas:\n- ${notes.join('\n- ')}` : ''
    ].filter(Boolean).join('\n');
  }

  async #extractVideoFrames(attachment) {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexadesk-video-'));
    const videoPath = path.join(workDir, `input${safeExtension(attachment.name, '.mp4')}`);
    try {
      await downloadFile(attachment.url, videoPath, this.videoMaxBytes);
      const outputPattern = path.join(workDir, 'frame-%02d.jpg');
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        videoPath,
        '-vf',
        'fps=1/3,scale=1280:-1',
        '-frames:v',
        String(this.videoFrameCount),
        '-q:v',
        '5',
        outputPattern
      ], { timeout: 30_000 });

      const files = (await fs.readdir(workDir)).filter((file) => /^frame-\d+\.jpg$/.test(file)).sort();
      const frames = [];
      for (const file of files.slice(0, this.videoFrameCount)) {
        const bytes = await fs.readFile(path.join(workDir, file));
        frames.push({
          label: `${attachment.name} (${file})`,
          url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          source: 'video-frame'
        });
      }
      return frames;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function shouldAnalyzeVisualProof(message, guildConfig) {
  if (hasVisualAttachments(message)) return true;

  const configText = normalizeForVisualMatch([
    guildConfig?.serverPrompt,
    guildConfig?.serverInfo
  ].filter(Boolean).join('\n'));
  const messageText = normalizeForVisualMatch(message?.content ?? '');

  if (/\b(pruebas?\s+visuales?|evidencia\s+visual|capturas?|screenshots?|fotos?|imagenes?|videos?|grabacion|adjunta\s+(foto|captura|video)|pedir\s+pruebas?)\b/u.test(configText)) {
    return true;
  }

  return hasVisualAttachments(message) && /\b(mira|adjunto|prueba|captura|foto|imagen|video|pantallazo|error|fallo|bug)\b/u.test(messageText);
}

export function hasVisualAttachments(message) {
  return collectVisualAttachments(message).length > 0;
}

function collectVisualAttachments(message) {
  return [...(message?.attachments?.values?.() ?? [])]
    .map(normalizeAttachment)
    .filter(Boolean);
}

function normalizeAttachment(attachment) {
  const name = attachment.name || attachment.filename || 'archivo';
  const contentType = String(attachment.contentType ?? '').toLowerCase();
  const extension = path.extname(name).toLowerCase();
  const url = attachment.url || attachment.proxyURL;
  const size = Number(attachment.size ?? 0);
  if (!url) return null;

  if (contentType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    if (contentType.includes('gif') || extension === '.gif') {
      return { kind: 'video', name, url, contentType, size };
    }
    return { kind: 'image', name, url, contentType, size };
  }

  if (contentType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return { kind: 'video', name, url, contentType, size };
  }

  return null;
}

function normalizeForVisualMatch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildVisualPrompt({ message, media, imageInputs }) {
  const attachmentList = media
    .map((item, index) => `${index + 1}. ${item.kind.toUpperCase()} "${item.name}" (${item.contentType || 'tipo desconocido'})`)
    .join('\n');
  const inputList = imageInputs
    .map((item, index) => `${index + 1}. ${item.label} [${item.source}]`)
    .join('\n');

  return [
    'Analiza estas pruebas visuales de un ticket de Discord.',
    'Devuelve un resumen breve y accionable para que la IA de soporte pueda continuar el caso.',
    'Incluye texto visible, mensajes de error, estado de la interfaz y posibles pasos de diagnostico.',
    'Si son fotogramas de video, aclara que solo analizas muestras del video.',
    '',
    `Mensaje del usuario: ${message.content || '(sin texto, solo adjuntos)'}`,
    '',
    `Adjuntos recibidos:\n${attachmentList}`,
    '',
    `Imagenes/fotogramas enviados al modelo:\n${inputList}`
  ].join('\n');
}

async function downloadFile(url, destination, maxBytes) {
  const buffer = await downloadBuffer(url, maxBytes);
  await fs.writeFile(destination, buffer);
}

async function attachmentToDataUrl(attachment, maxBytes) {
  const buffer = await downloadBuffer(attachment.url, maxBytes);
  const mimeType = getImageMimeType(attachment);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function downloadBuffer(url, maxBytes) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'NexaDesk/1.0 (+https://nexa-desk.onrender.com)'
    }
  });
  if (!response.ok) {
    throw new Error(`descarga fallida (${response.status})`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`archivo demasiado grande (${Math.round(contentLength / 1024 / 1024)} MB)`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`archivo demasiado grande (${Math.round(buffer.length / 1024 / 1024)} MB)`);
  }

  return buffer;
}

function getImageMimeType(attachment) {
  const contentType = String(attachment.contentType ?? '').toLowerCase();
  if (contentType.startsWith('image/') && !contentType.includes(';')) return contentType;
  return IMAGE_EXTENSION_MIME[path.extname(attachment.name).toLowerCase()] ?? 'image/png';
}

function safeExtension(fileName, fallback) {
  const extension = path.extname(fileName).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) ? extension : fallback;
}

function normalizeError(error) {
  if (error?.code === 'ENOENT') return 'ffmpeg no esta instalado en la maquina';
  const message = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
  return message || 'error desconocido';
}
