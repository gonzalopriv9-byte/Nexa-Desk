import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_SOURCE_BYTES = 10_000_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');
const LOCAL_UPLOAD_RE = /^\/uploads\/([a-z0-9._-]+)$/i;
const LOCAL_PROOF_RE = /^blacklist-proof-[a-z0-9._-]+$/i;
const ALLOWED_REMOTE_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net'
]);

export async function createWatermarkedEvidenceAttachment(evidence, index = 0) {
  const source = await readEvidenceSource(evidence);
  if (!source || !source.buffer.length || source.buffer.length > MAX_SOURCE_BYTES) return null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexadesk-watermark-'));
  const inputPath = path.join(tempDir, `input${extensionFor(evidence)}`);
  const outputPath = path.join(tempDir, 'output.png');

  try {
    await fs.writeFile(inputPath, source.buffer, { flag: 'wx' });
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      "drawtext=text='NexaDesk Global Safety':fontcolor=white@0.86:fontsize=24:box=1:boxcolor=black@0.52:boxborderw=10:x=20:y=h-th-20",
      '-an',
      '-f',
      'image2',
      outputPath
    ]);
    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      name: `nexadesk-proof-${index + 1}-${crypto.randomBytes(3).toString('hex')}.png`
    };
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readEvidenceSource(evidence) {
  const localPath = resolveLocalEvidencePath(evidence);
  if (localPath) {
    const buffer = await fs.readFile(localPath).catch(() => null);
    return buffer ? { buffer, kind: 'local' } : null;
  }

  const rawUrl = String(evidence?.proxyUrl || evidence?.attachmentUrl || '').trim();
  if (!/^https:\/\//i.test(rawUrl)) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ALLOWED_REMOTE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(part.value));
    }
    return { buffer: Buffer.concat(chunks, total), kind: 'remote' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveLocalEvidencePath(evidence) {
  const attachmentUrl = String(evidence?.attachmentUrl ?? '').trim();
  const match = attachmentUrl.match(LOCAL_UPLOAD_RE);
  if (match) return path.join(UPLOADS_DIR, path.basename(match[1]));

  const fileName = path.basename(String(evidence?.fileName ?? '').trim());
  if (LOCAL_PROOF_RE.test(fileName)) return path.join(UPLOADS_DIR, fileName);
  return null;
}

function extensionFor(evidence) {
  const source = String(evidence?.fileName || evidence?.attachmentUrl || '').toLowerCase();
  const extension = path.extname(source).replace(/[^a-z0-9.]/g, '');
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension) ? extension : '.img';
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-500) || `ffmpeg exited with ${code}`));
    });
  });
}
