import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');
const MAX_PARTNERS = 24;
const MAX_TITLE_LENGTH = 120;
const MAX_BIO_LENGTH = 700;
const MAX_DESCRIPTION_LENGTH = 700;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_VIDEO_BYTES = 50_000_000;
const MAX_VIDEO_SECONDS = 30;
const PARTNER_FILE_RE = /^partner-[a-z0-9-]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov)$/i;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

export function normalizePartners(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
      ? value.items
      : [];
  const seenIds = new Set();
  const normalized = [];

  for (let index = 0; index < source.length && normalized.length < MAX_PARTNERS; index += 1) {
    const partner = normalizePartner(source[index], index, seenIds);
    if (partner) normalized.push(partner);
  }

  return normalized;
}

function normalizePartner(value, index, seenIds) {
  const source = value && typeof value === 'object' ? value : {};
  const title = cleanText(source.title, MAX_TITLE_LENGTH);
  if (!title) return null;

  const baseId = slugify(source.id || source.title || `partner-${index + 1}`) || `partner-${index + 1}`;
  let id = baseId.slice(0, 80);
  let suffix = 2;
  while (seenIds.has(id)) {
    id = `${baseId.slice(0, 70)}-${suffix}`;
    suffix += 1;
  }
  seenIds.add(id);

  return {
    id,
    title,
    bio: cleanText(source.bio, MAX_BIO_LENGTH),
    whatItDoes: cleanText(source.whatItDoes, MAX_DESCRIPTION_LENGTH),
    discordUrl: normalizeDiscordUrl(source.discordUrl),
    iconUrl: normalizeMediaUrl(source.iconUrl),
    media: normalizeMedia(source.media),
    createdAt: isIsoDate(source.createdAt) ? source.createdAt : null,
    updatedAt: isIsoDate(source.updatedAt) ? source.updatedAt : null
  };
}

function normalizeMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = normalizeMediaUrl(value.url);
  if (!url) return null;
  const mimeType = normalizeMimeType(value.mimeType);
  const kind = value.kind === 'video' || mimeType.startsWith('video/') ? 'video' : 'image';
  const fileName = safePartnerFileName(value.fileName);
  const durationSeconds = Number(value.durationSeconds);
  return {
    url,
    fileName,
    mimeType: mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
    kind,
    size: clampInteger(value.size, 0, MAX_VIDEO_BYTES),
    durationSeconds: kind === 'video' && Number.isFinite(durationSeconds)
      ? Math.min(Math.max(durationSeconds, 0), MAX_VIDEO_SECONDS)
      : null
  };
}

function normalizeMediaUrl(value) {
  const raw = String(value ?? '').trim().slice(0, 2000);
  if (!raw) return '';
  if (/^\/uploads\/[a-z0-9._-]+$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeDiscordUrl(value) {
  const raw = normalizeMediaUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!['discord.gg', 'discord.com', 'discordapp.com'].includes(host)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeMimeType(value) {
  const type = String(value ?? '').toLowerCase().split(';')[0].trim();
  return IMAGE_TYPES.has(type) || VIDEO_TYPES.has(type) ? type : '';
}

function safePartnerFileName(value) {
  const fileName = path.basename(String(value ?? '').trim());
  return PARTNER_FILE_RE.test(fileName) ? fileName : '';
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(Math.round(number), min), max);
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export async function savePartnerUpload({ buffer, mimeType, fileName = 'partner-media', durationSeconds = null }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('El fichero está vacío o no se ha recibido correctamente.');
  }

  const type = normalizeMimeType(mimeType);
  if (!type) throw new Error('Solo se admiten PNG, JPG, WEBP, GIF, MP4, WEBM o MOV.');

  const isVideo = VIDEO_TYPES.has(type);
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (buffer.length > maxBytes) {
    throw new Error(isVideo ? 'El vídeo debe pesar menos de 50 MB.' : 'La imagen debe pesar menos de 5 MB.');
  }
  if (!matchesMediaSignature(buffer, type)) {
    throw new Error('El contenido del fichero no coincide con su tipo declarado.');
  }

  let verifiedDuration = null;
  if (isVideo) {
    verifiedDuration = type === 'video/webm' ? detectWebmDuration(buffer) : detectMp4Duration(buffer);
    const hintedDuration = Number(durationSeconds);
    if (verifiedDuration === null && Number.isFinite(hintedDuration) && hintedDuration >= 0) {
      verifiedDuration = hintedDuration;
    }
    if (verifiedDuration === null) {
      throw new Error('No se ha podido verificar la duración del vídeo. Usa MP4 o WEBM desde la web.');
    }
    if (verifiedDuration > MAX_VIDEO_SECONDS + 0.05) {
      throw new Error('El vídeo no puede durar más de 30 segundos.');
    }
  }

  const extension = extensionFor(type, fileName);
  const id = `partner-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, id), buffer, { flag: 'wx' });

  return {
    url: `/uploads/${id}`,
    fileName: id,
    size: buffer.length,
    mimeType: type,
    kind: isVideo ? 'video' : 'image',
    durationSeconds: isVideo ? Math.round(verifiedDuration * 100) / 100 : null
  };
}

function extensionFor(type, fileName) {
  const extensions = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
  };
  return extensions[type] || path.extname(String(fileName)).toLowerCase() || '.bin';
}

function matchesMediaSignature(buffer, type) {
  if (type === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg' || type === 'image/jpg') return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (type === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (type === 'video/mp4' || type === 'video/quicktime') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (type === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function detectMp4Duration(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const box = readMp4Box(buffer, offset);
    if (!box) break;
    if (box.type === 'moov') {
      const nested = findMp4Atom(buffer.subarray(box.contentStart, box.end), 'mvhd');
      if (nested) return parseMvhdDuration(buffer, nested);
    }
    offset = box.end;
  }
  const mvhd = findMp4Atom(buffer, 'mvhd');
  return mvhd ? parseMvhdDuration(buffer, mvhd) : null;
}

function detectWebmDuration(buffer) {
  let offset = 0;
  while (offset + 2 < buffer.length) {
    const element = readEbmlElement(buffer, offset);
    if (!element) break;
    if (element.id === 0x1549a966) {
      const duration = parseWebmInfo(buffer, element.contentStart, element.end);
      if (duration !== null) return duration;
    }
    if (element.id === 0x18538067) {
      const duration = findWebmInfo(buffer, element.contentStart, element.end);
      if (duration !== null) return duration;
    }
    offset = element.end;
  }
  return null;
}

function findWebmInfo(buffer, start, end) {
  let offset = start;
  while (offset + 2 < end) {
    const element = readEbmlElement(buffer, offset, end);
    if (!element) break;
    if (element.id === 0x1549a966) return parseWebmInfo(buffer, element.contentStart, element.end);
    offset = element.end;
  }
  return null;
}

function parseWebmInfo(buffer, start, end) {
  let offset = start;
  let timecodeScale = 1_000_000;
  let duration = null;
  while (offset + 2 < end) {
    const element = readEbmlElement(buffer, offset, end);
    if (!element) break;
    if (element.id === 0x2ad7b1 && element.size > 0 && element.size <= 8) {
      timecodeScale = readUnsignedBigEndian(buffer, element.contentStart, element.end);
    } else if (element.id === 0x4489 && (element.size === 4 || element.size === 8)) {
      duration = element.size === 4
        ? buffer.readFloatBE(element.contentStart)
        : buffer.readDoubleBE(element.contentStart);
    }
    offset = element.end;
  }
  return duration !== null && Number.isFinite(duration) && timecodeScale > 0
    ? duration * timecodeScale / 1_000_000_000
    : null;
}

function readEbmlElement(buffer, offset, limit = buffer.length) {
  const id = readEbmlVint(buffer, offset, { keepMarker: true, limit });
  if (!id) return null;
  const size = readEbmlVint(buffer, id.nextOffset, { keepMarker: false, limit });
  if (!size || (!size.unknown && size.value > limit - size.nextOffset)) return null;
  return {
    id: id.value,
    size: size.unknown ? null : size.value,
    contentStart: size.nextOffset,
    end: size.unknown ? limit : size.nextOffset + size.value
  };
}

function readEbmlVint(buffer, offset, { keepMarker, limit }) {
  if (offset >= limit) return null;
  const first = buffer[offset];
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > limit) return null;
  let value = 0n;
  for (let index = 0; index < length; index += 1) value = (value << 8n) | BigInt(buffer[offset + index]);
  if (!keepMarker) value &= (1n << BigInt(length * 7)) - 1n;
  const unknown = !keepMarker && value === (1n << BigInt(length * 7)) - 1n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(value), unknown, nextOffset: offset + length };
}

function readUnsignedBigEndian(buffer, start, end) {
  let value = 0;
  for (let index = start; index < end; index += 1) value = value * 256 + buffer[index];
  return value;
}

function findMp4Atom(buffer, target) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const box = readMp4Box(buffer, offset);
    if (!box) break;
    if (box.type === target) return box;
    offset = box.end;
  }
  return null;
}

function readMp4Box(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = buffer.length - offset;
  }
  if (size < headerSize || offset + size > buffer.length) return null;
  return { type, start: offset, contentStart: offset + headerSize, end: offset + size };
}

function parseMvhdDuration(buffer, box) {
  const content = box.contentStart;
  if (content + 20 > box.end) return null;
  const version = buffer[content];
  if (version === 0) {
    const timescale = buffer.readUInt32BE(content + 12);
    const duration = buffer.readUInt32BE(content + 16);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1 && content + 32 <= box.end) {
    const timescale = buffer.readUInt32BE(content + 20);
    const duration = buffer.readBigUInt64BE(content + 24);
    return timescale > 0 && duration <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(duration) / timescale
      : null;
  }
  return null;
}

export async function removeUnreferencedPartnerUploads(previous, next) {
  const keep = new Set(normalizePartners(next).flatMap((partner) => [
    partner.media?.fileName,
    safePartnerFileName(partner.iconUrl.split('/').pop())
  ]).filter(Boolean));
  const remove = new Set(normalizePartners(previous).flatMap((partner) => [
    partner.media?.fileName,
    safePartnerFileName(partner.iconUrl.split('/').pop())
  ]).filter((fileName) => fileName && !keep.has(fileName)));
  await Promise.all([...remove].map(async (fileName) => {
    await fs.unlink(path.join(UPLOADS_DIR, fileName)).catch(() => {});
  }));
}

export function renderPartnersPage({ partners = [], isOwner = false, session = null, dashboardUrl = '' }) {
  const normalized = normalizePartners(partners);
  const initialState = JSON.stringify(normalized).replace(/</g, '\\u003c');
  const ownerName = session?.user?.globalName || session?.user?.username || 'owner';
  const cards = normalized.map(renderPartnerCard).join('');
  const emptyState = normalized.length
    ? ''
    : `<section class="empty-state"><div class="empty-mark">✦</div><p class="eyebrow">NexaDesk partners</p><h2>Las mejores colaboraciones todavía están por llegar.</h2><p>Estamos preparando un espacio para los equipos y comunidades que comparten nuestra obsesión por un soporte claro, rápido y humano.</p></section>`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Partners de NexaDesk: equipos y comunidades que construyen experiencias de soporte más claras.">
  <title>Partners - NexaDesk</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#050505; --surface:rgba(255,255,255,.055); --surface-strong:rgba(255,255,255,.105); --line:rgba(255,255,255,.16); --text:#f7f7f7; --muted:#a9a9a9; --soft:#747474; --gold:#d6b86a; --danger:#ff6868; --ease:cubic-bezier(.2,.75,.2,1); }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; min-height:100vh; overflow-x:hidden; color:var(--text); font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 12% -10%, rgba(255,255,255,.16), transparent 30%), radial-gradient(circle at 87% 8%, rgba(214,184,106,.13), transparent 25%), repeating-linear-gradient(90deg, rgba(255,255,255,.042) 0 1px, transparent 1px 86px), repeating-linear-gradient(0deg, rgba(255,255,255,.027) 0 1px, transparent 1px 86px), var(--bg); }
    body::before { content:""; position:fixed; inset:-30%; z-index:-1; pointer-events:none; background:conic-gradient(from 120deg, transparent, rgba(255,255,255,.08), transparent 28%, rgba(214,184,106,.06), transparent 56%); filter:blur(70px); animation:drift 20s ease-in-out infinite alternate; opacity:.7; }
    @keyframes drift { from { transform:translate3d(-2%, -1%, 0) rotate(0deg); } to { transform:translate3d(2%, 1%, 0) rotate(8deg); } }
    @keyframes rise { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    @keyframes scan { 0%,35% { transform:translateX(-120%); } 70%,100% { transform:translateX(120%); } }
    @keyframes pulse { 0%,100% { box-shadow:0 0 0 0 rgba(214,184,106,.22); } 50% { box-shadow:0 0 0 12px rgba(214,184,106,0); } }
    a { color:inherit; }
    .shell { width:min(1240px, calc(100% - 34px)); margin:0 auto; padding:24px 0 72px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:4px 0 30px; animation:rise .65s var(--ease) both; }
    .brand { display:inline-flex; align-items:center; gap:12px; color:#fff; text-decoration:none; font-weight:950; letter-spacing:-.03em; }
    .brand img { width:42px; height:42px; border:1px solid rgba(255,255,255,.38); border-radius:13px; background:#050505; }
    .toplinks { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:9px; }
    .toplinks a,.toplinks span { border:1px solid var(--line); border-radius:999px; padding:9px 12px; color:var(--muted); text-decoration:none; font-size:13px; font-weight:800; background:rgba(255,255,255,.035); transition:transform .22s var(--ease), background .22s ease, color .22s ease; }
    .toplinks a:hover { color:#050505; background:#fff; transform:translateY(-2px); }
    .owner-pill { color:#050505 !important; background:var(--gold) !important; border-color:transparent !important; }
    .hero { position:relative; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr); gap:26px; align-items:stretch; min-height:440px; padding:clamp(26px, 6vw, 70px); overflow:hidden; border:1px solid var(--line); border-radius:38px; background:linear-gradient(135deg, rgba(255,255,255,.125), rgba(255,255,255,.035) 48%, rgba(0,0,0,.62)); box-shadow:0 42px 160px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.08); animation:rise .75s .08s var(--ease) both; }
    .hero::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(112deg, transparent 0 28%, rgba(255,255,255,.22) 46%, transparent 63%); transform:translateX(-120%); animation:scan 8s ease-in-out infinite; opacity:.55; }
    .hero::after { content:""; position:absolute; right:-150px; top:-190px; width:540px; height:540px; border:1px solid rgba(214,184,106,.24); border-radius:50%; box-shadow:0 0 0 54px rgba(214,184,106,.06), 0 0 0 120px rgba(255,255,255,.025); pointer-events:none; }
    .hero-copy,.hero-showcase { position:relative; z-index:1; }
    .eyebrow { margin:0 0 15px; color:var(--gold); text-transform:uppercase; letter-spacing:.22em; font-size:12px; font-weight:950; }
    h1,h2,p { margin-top:0; }
    h1 { max-width:760px; margin-bottom:22px; font-size:clamp(52px, 8.4vw, 116px); line-height:.86; letter-spacing:-.085em; }
    .hero-copy > p:not(.eyebrow) { max-width:680px; color:#c0c0c0; font-size:clamp(17px, 2vw, 21px); line-height:1.5; }
    .hero-actions { display:flex; flex-wrap:wrap; gap:11px; margin-top:30px; }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:46px; padding:12px 16px; border:1px solid var(--line); border-radius:999px; color:#050505; background:#fff; text-decoration:none; font-weight:950; cursor:pointer; transition:transform .22s var(--ease), box-shadow .22s ease, background .22s ease; }
    .button:hover { transform:translateY(-3px); box-shadow:0 15px 36px rgba(0,0,0,.28); }
    .button.secondary { color:#fff; background:rgba(255,255,255,.06); }
    .button.gold { color:#050505; background:var(--gold); border-color:transparent; }
    .hero-showcase { display:grid; align-content:end; gap:12px; }
    .signal-card { position:relative; min-height:245px; display:grid; align-content:space-between; padding:22px; overflow:hidden; border:1px solid rgba(255,255,255,.19); border-radius:28px; background:linear-gradient(145deg, rgba(0,0,0,.08), rgba(0,0,0,.55)); backdrop-filter:blur(20px); }
    .signal-card::before { content:""; position:absolute; width:180px; height:180px; right:-45px; top:-58px; border:1px solid rgba(255,255,255,.2); border-radius:50%; animation:pulse 3.5s ease-in-out infinite; }
    .signal-label { display:flex; justify-content:space-between; gap:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.16em; font-size:11px; font-weight:900; }
    .signal-card strong { display:block; max-width:290px; font-size:clamp(30px, 4vw, 52px); line-height:.95; letter-spacing:-.07em; }
    .signal-card small { color:var(--muted); line-height:1.45; }
    .signal-dots { display:flex; gap:6px; }
    .signal-dots i { width:7px; height:7px; border-radius:50%; background:#fff; opacity:.3; }
    .signal-dots i:first-child { opacity:1; background:var(--gold); }
    .section-head { display:flex; align-items:end; justify-content:space-between; gap:18px; margin:64px 0 18px; animation:rise .75s .16s var(--ease) both; }
    .section-head h2 { margin-bottom:6px; font-size:clamp(28px, 4vw, 52px); line-height:1; letter-spacing:-.065em; }
    .section-head p { margin-bottom:0; color:var(--muted); line-height:1.5; }
    .section-count { color:var(--gold); text-transform:uppercase; letter-spacing:.14em; font-size:12px; font-weight:950; white-space:nowrap; }
    .partners-grid { display:grid; grid-template-columns:repeat(12, minmax(0,1fr)); gap:15px; }
    .partner-card { grid-column:span 6; position:relative; display:flex; flex-direction:column; overflow:hidden; min-height:550px; border:1px solid var(--line); border-radius:28px; background:linear-gradient(145deg, rgba(255,255,255,.105), rgba(255,255,255,.028) 50%, rgba(0,0,0,.48)); box-shadow:0 28px 100px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06); animation:rise .7s var(--ease) both; transition:transform .28s var(--ease), border-color .28s ease, box-shadow .28s ease; }
    .partner-card:nth-child(3n+2) { animation-delay:.08s; }
    .partner-card:nth-child(3n+3) { animation-delay:.14s; }
    .partner-card:hover { transform:translateY(-7px); border-color:rgba(214,184,106,.52); box-shadow:0 42px 120px rgba(0,0,0,.5), 0 0 0 1px rgba(214,184,106,.1) inset; }
    .partner-media { position:relative; aspect-ratio:16/9; overflow:hidden; background:radial-gradient(circle at 50% 35%, rgba(255,255,255,.16), transparent 30%), #0a0a0a; }
    .partner-media img,.partner-media video { display:block; width:100%; height:100%; object-fit:cover; }
    .partner-media::after { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(180deg, transparent 40%, rgba(0,0,0,.7)); }
    .media-placeholder { display:grid; place-items:center; height:100%; background:radial-gradient(circle at 50% 40%, rgba(214,184,106,.18), transparent 28%), repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 1px, transparent 1px 18px); }
    .media-placeholder img { width:74px; height:74px; object-fit:contain; opacity:.9; }
    .media-badge { position:absolute; left:16px; bottom:14px; z-index:1; border:1px solid rgba(255,255,255,.22); border-radius:999px; padding:7px 9px; color:#fff; background:rgba(0,0,0,.5); backdrop-filter:blur(12px); text-transform:uppercase; letter-spacing:.12em; font-size:10px; font-weight:950; }
    .partner-body { display:flex; flex:1; flex-direction:column; padding:22px; }
    .partner-heading { display:flex; align-items:center; gap:13px; min-width:0; }
    .partner-icon { flex:0 0 auto; width:54px; height:54px; object-fit:cover; border:1px solid rgba(255,255,255,.22); border-radius:17px; background:#000; }
    .partner-icon-fallback { display:grid; place-items:center; color:#050505; background:#fff; font-size:22px; font-weight:950; }
    .partner-heading h3 { min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; font-size:clamp(22px, 3vw, 34px); line-height:.98; letter-spacing:-.06em; }
    .partner-bio { margin:18px 0 0; color:#d0d0d0; font-size:16px; line-height:1.58; }
    .partner-what { margin:13px 0 0; padding-top:14px; border-top:1px solid rgba(255,255,255,.11); color:var(--muted); font-size:14px; line-height:1.55; }
    .partner-what strong { display:block; margin-bottom:5px; color:#fff; font-size:11px; text-transform:uppercase; letter-spacing:.15em; }
    .partner-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:auto; padding-top:22px; }
    .partner-footer small { color:var(--soft); text-transform:uppercase; letter-spacing:.13em; font-size:10px; font-weight:900; }
    .partner-link { display:inline-flex; align-items:center; gap:7px; color:#050505; background:#fff; border-radius:999px; padding:10px 13px; text-decoration:none; font-size:13px; font-weight:950; transition:transform .22s var(--ease), background .22s ease; }
    .partner-link:hover { transform:translateY(-2px); background:var(--gold); }
    .empty-state { padding:70px 24px; border:1px dashed rgba(255,255,255,.2); border-radius:28px; text-align:center; background:rgba(255,255,255,.025); }
    .empty-mark { display:grid; place-items:center; width:64px; height:64px; margin:0 auto 20px; border:1px solid rgba(214,184,106,.55); border-radius:20px; color:var(--gold); font-size:28px; }
    .empty-state h2 { max-width:620px; margin:0 auto 12px; font-size:clamp(28px, 4vw, 50px); line-height:.98; letter-spacing:-.07em; }
    .empty-state p:last-child { max-width:620px; margin:0 auto; color:var(--muted); line-height:1.6; }
    .editor-shell { margin-top:70px; padding:26px; border:1px solid rgba(214,184,106,.38); border-radius:30px; background:linear-gradient(145deg, rgba(214,184,106,.09), rgba(255,255,255,.035) 50%, rgba(0,0,0,.45)); box-shadow:0 30px 110px rgba(0,0,0,.36); }
    .editor-head { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:22px; }
    .editor-head h2 { margin:0 0 6px; font-size:clamp(26px, 4vw, 45px); letter-spacing:-.065em; }
    .editor-head p { max-width:680px; margin:0; color:var(--muted); line-height:1.55; }
    .owner-badge { flex:0 0 auto; border:1px solid rgba(214,184,106,.5); border-radius:999px; padding:9px 12px; color:#050505; background:var(--gold); text-transform:uppercase; letter-spacing:.12em; font-size:11px; font-weight:950; }
    .editor-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; }
    .editor-form { display:grid; gap:12px; }
    .field { display:grid; gap:7px; }
    .field label { color:#fff; font-size:12px; font-weight:900; }
    .field small { color:var(--soft); line-height:1.35; }
    input,textarea { width:100%; border:1px solid rgba(255,255,255,.17); border-radius:15px; padding:12px 13px; color:#fff; background:rgba(0,0,0,.38); outline:none; font:inherit; transition:border-color .2s ease, box-shadow .2s ease; }
    input:focus,textarea:focus { border-color:rgba(214,184,106,.75); box-shadow:0 0 0 4px rgba(214,184,106,.12); }
    textarea { min-height:112px; resize:vertical; }
    .upload-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .file-control { display:grid; gap:7px; min-width:0; padding:12px; border:1px dashed rgba(255,255,255,.22); border-radius:16px; background:rgba(0,0,0,.22); }
    .file-control span { color:#fff; font-size:12px; font-weight:900; }
    .file-control input { padding:9px; font-size:12px; }
    .editor-actions { display:flex; flex-wrap:wrap; gap:9px; align-items:center; margin-top:3px; }
    .editor-status { min-height:22px; color:var(--muted); font-size:13px; }
    .editor-status.is-error { color:var(--danger); }
    .editor-list { display:grid; align-content:start; gap:9px; }
    .editor-list-head { display:flex; justify-content:space-between; align-items:center; gap:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.14em; font-size:11px; font-weight:950; }
    .editor-item { display:grid; grid-template-columns:48px minmax(0,1fr) auto; align-items:center; gap:11px; padding:10px; border:1px solid rgba(255,255,255,.13); border-radius:17px; background:rgba(0,0,0,.3); }
    .editor-item img { width:48px; height:48px; object-fit:cover; border-radius:13px; background:#000; }
    .editor-item strong,.editor-item small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .editor-item small { margin-top:4px; color:var(--soft); }
    .mini-actions { display:flex; gap:6px; }
    .mini-button { border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:8px 10px; color:#fff; background:rgba(255,255,255,.06); cursor:pointer; font-weight:900; }
    .mini-button:hover { background:#fff; color:#050505; }
    .mini-button.danger:hover { background:var(--danger); border-color:var(--danger); }
    footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:15px; margin-top:28px; padding-top:20px; border-top:1px solid rgba(255,255,255,.12); color:var(--soft); font-size:12px; }
    footer nav { display:flex; flex-wrap:wrap; gap:12px; }
    footer a { color:var(--muted); text-decoration:none; }
    footer a:hover { color:#fff; }
    @media (max-width:900px) { .hero { grid-template-columns:1fr; min-height:auto; } .hero-showcase { max-width:560px; } .partner-card { grid-column:span 12; } }
    @media (max-width:620px) { .shell { width:min(100% - 20px, 1240px); padding-top:15px; } .topbar,.section-head,.editor-head { align-items:flex-start; flex-direction:column; } .toplinks { justify-content:flex-start; } h1 { font-size:clamp(50px, 17vw, 84px); } .hero { padding:23px 18px; border-radius:25px; } .hero-showcase { display:block; } .signal-card { margin-top:22px; min-height:210px; } .section-head { gap:8px; margin-top:46px; } .partner-card { min-height:0; border-radius:23px; } .partner-body { padding:18px; } .editor-shell { padding:18px; border-radius:23px; } .editor-grid,.upload-row { grid-template-columns:1fr; } .owner-badge { align-self:flex-start; } footer { align-items:flex-start; flex-direction:column; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-duration:.001ms !important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/"><img src="/assets/nexadesk-logo.svg" alt="">NexaDesk</a>
      <nav class="toplinks" aria-label="Navegación principal">
        <a href="/">Dashboard</a>
        <a href="/status">Status</a>
        <a href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Soporte</a>
        ${isOwner ? `<span class="owner-pill">Owner mode · ${escapeHtml(ownerName)}</span>` : ''}
      </nav>
    </header>

    <main>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">NexaDesk / Partners</p>
          <h1>Soporte que crece con la gente correcta.</h1>
          <p>Conoce a los equipos, comunidades y productos que comparten nuestra visión: menos ruido operativo, más contexto y mejores experiencias para cada persona que pide ayuda.</p>
          <div class="hero-actions">
            <a class="button" href="#partner-grid">Explorar partners <span aria-hidden="true">↘</span></a>
            <a class="button secondary" href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Hablar con NexaDesk</a>
          </div>
        </div>
        <div class="hero-showcase">
          <div class="signal-card">
            <div class="signal-label"><span>Partner network</span><span>2026</span></div>
            <div><strong>Contexto real.<br>Impacto visible.</strong><small>Alianzas que hacen que el soporte sea una parte más inteligente del producto.</small></div>
            <div class="signal-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          </div>
        </div>
      </section>

      <div class="section-head" id="partner-grid">
        <div><p class="eyebrow">La red NexaDesk</p><h2>Partners destacados</h2><p>Una selección curada de colaboradores, comunidades y herramientas que están construyendo con nosotros.</p></div>
        <span class="section-count">${normalized.length} ${normalized.length === 1 ? 'partner' : 'partners'}</span>
      </div>
      <section class="partners-grid" aria-label="Partners de NexaDesk">${cards}${emptyState}</section>

      ${isOwner ? renderOwnerEditor(normalized, initialState) : ''}
    </main>

    <footer>
      <span>NexaDesk · Support without noise.</span>
      <nav><a href="/terms">Términos</a><a href="/privacy">Privacidad</a><a href="${escapeHtml(dashboardUrl || '/')}" >Dashboard</a><a href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Discord oficial</a></nav>
    </footer>
  </div>
  ${isOwner ? renderOwnerScript() : ''}
</body>
</html>`;
}

function renderPartnerCard(partner) {
  const icon = partner.iconUrl
    ? `<img class="partner-icon" src="${escapeHtml(partner.iconUrl)}" alt="Icono de ${escapeHtml(partner.title)}" loading="lazy">`
    : `<span class="partner-icon partner-icon-fallback" aria-hidden="true">✦</span>`;
  const media = partner.media?.url
    ? partner.media.kind === 'video'
      ? `<video src="${escapeHtml(partner.media.url)}" controls preload="metadata" playsinline></video><span class="media-badge">Video · ${escapeHtml(formatDuration(partner.media.durationSeconds))}</span>`
      : `<img src="${escapeHtml(partner.media.url)}" alt="${escapeHtml(partner.title)}" loading="lazy"><span class="media-badge">Partner spotlight</span>`
    : `<div class="media-placeholder"><img src="/assets/nexadesk-logo.svg" alt="NexaDesk"></div><span class="media-badge">NexaDesk network</span>`;
  const discord = partner.discordUrl
    ? `<a class="partner-link" href="${escapeHtml(partner.discordUrl)}" target="_blank" rel="noopener">Discord <span aria-hidden="true">↗</span></a>`
    : '';
  return `<article class="partner-card">
    <div class="partner-media">${media}</div>
    <div class="partner-body">
      <div class="partner-heading">${icon}<h3>${escapeHtml(partner.title)}</h3></div>
      ${partner.bio ? `<p class="partner-bio">${escapeHtml(partner.bio)}</p>` : ''}
      ${partner.whatItDoes ? `<p class="partner-what"><strong>Lo que hace</strong>${escapeHtml(partner.whatItDoes)}</p>` : ''}
      <div class="partner-footer"><small>Partner verificado por NexaDesk</small>${discord}</div>
    </div>
  </article>`;
}

function renderOwnerEditor(partners, initialState) {
  const list = partners.length
    ? partners.map((partner) => `<div class="editor-item" data-editor-item="${escapeHtml(partner.id)}"><span class="partner-icon partner-icon-fallback">✦</span><div><strong>${escapeHtml(partner.title)}</strong><small>${escapeHtml(partner.discordUrl || 'Sin enlace Discord')}</small></div><div class="mini-actions"><button class="mini-button" type="button" data-edit-partner="${escapeHtml(partner.id)}">Editar</button><button class="mini-button danger" type="button" data-delete-partner="${escapeHtml(partner.id)}">Borrar</button></div></div>`).join('')
    : '<p class="editor-status">Todavía no hay partners. Crea el primero desde aquí.</p>';
  return `<section class="editor-shell" id="partner-editor" data-initial-partners="${escapeHtml(initialState)}">
    <div class="editor-head"><div><p class="eyebrow">Zona privada</p><h2>Construye la página de partners.</h2><p>Solo el owner global puede editarla. Las imágenes se guardan en la Raspberry Pi y los vídeos se limitan a 30 segundos antes de publicarse.</p></div><span class="owner-badge">Owner only</span></div>
    <div class="editor-grid">
      <form class="editor-form" id="partnerForm">
        <input type="hidden" id="partnerId">
        <div class="field"><label for="partnerTitle">Título del partner</label><input id="partnerTitle" maxlength="120" placeholder="Ej. Grafana Community" required></div>
        <div class="field"><label for="partnerBio">Biografía</label><textarea id="partnerBio" maxlength="700" placeholder="Quién es el partner y por qué importa..."></textarea></div>
        <div class="field"><label for="partnerDiscordUrl">Enlace de Discord</label><input id="partnerDiscordUrl" type="url" maxlength="500" placeholder="https://discord.gg/..." inputmode="url"><small>Solo se aceptan enlaces de Discord.</small></div>
        <div class="field"><label for="partnerWhatItDoes">Qué hace</label><textarea id="partnerWhatItDoes" maxlength="700" placeholder="Qué aporta, qué construye o cómo ayuda a su comunidad..."></textarea></div>
        <div class="upload-row"><div class="file-control"><span>Icono del partner</span><input id="partnerIconFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></div><div class="file-control"><span>Foto o vídeo · máximo 30 s</span><input id="partnerMediaFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"></div></div>
        <div class="editor-actions"><button class="button gold" type="submit">Guardar partner</button><button class="button secondary" type="button" id="newPartnerButton">Nuevo partner</button><span class="editor-status" id="partnerStatus" aria-live="polite"></span></div>
      </form>
      <div class="editor-list"><div class="editor-list-head"><span>Partners publicados</span><span id="editorCount">${partners.length}/${MAX_PARTNERS}</span></div><div id="editorItems">${list}</div></div>
    </div>
  </section>`;
}

function renderOwnerScript() {
  return `<script>
    (() => {
      const editor = document.querySelector('#partner-editor');
      const form = document.querySelector('#partnerForm');
      if (!editor || !form) return;
      const state = { partners: JSON.parse(editor.dataset.initialPartners || '[]'), editingId: '' };
      const byId = (id) => document.getElementById(id);
      const status = (message, isError = false) => { const node = byId('partnerStatus'); if (node) { node.textContent = message; node.classList.toggle('is-error', isError); } };
      const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
      const placeholderIcon = () => '<span class="partner-icon partner-icon-fallback">✦</span>';
      function renderItems() {
        const target = byId('editorItems');
        if (!target) return;
        byId('editorCount').textContent = state.partners.length + '/${MAX_PARTNERS}';
        target.innerHTML = state.partners.length ? state.partners.map((partner) => '<div class="editor-item" data-editor-item="' + escapeHtml(partner.id) + '">' + placeholderIcon() + '<div><strong>' + escapeHtml(partner.title) + '</strong><small>' + escapeHtml(partner.discordUrl || 'Sin enlace Discord') + '</small></div><div class="mini-actions"><button class="mini-button" type="button" data-edit-partner="' + escapeHtml(partner.id) + '">Editar</button><button class="mini-button danger" type="button" data-delete-partner="' + escapeHtml(partner.id) + '">Borrar</button></div></div>').join('') : '<p class="editor-status">Todavía no hay partners. Crea el primero desde aquí.</p>';
      }
      function resetForm() { state.editingId = ''; form.reset(); byId('partnerId').value = ''; status(''); }
      function loadPartner(id) { const partner = state.partners.find((item) => item.id === id); if (!partner) return; state.editingId = id; byId('partnerId').value = id; byId('partnerTitle').value = partner.title || ''; byId('partnerBio').value = partner.bio || ''; byId('partnerDiscordUrl').value = partner.discordUrl || ''; byId('partnerWhatItDoes').value = partner.whatItDoes || ''; status('Editando ' + partner.title + '. Sube nuevos medios solo si quieres reemplazarlos.'); window.scrollTo({ top: editor.getBoundingClientRect().top + window.scrollY - 18, behavior:'smooth' }); }
      async function uploadFile(input, kind) {
        const file = input.files?.[0]; if (!file) return null;
        const allowed = kind === 'icon' ? file.type.startsWith('image/') : (file.type.startsWith('image/') || file.type.startsWith('video/'));
        if (!allowed) throw new Error('Tipo de fichero no permitido.');
        if (kind === 'icon' && file.size > ${MAX_IMAGE_BYTES}) throw new Error('El icono debe pesar menos de 5 MB.');
        let duration = '';
        if (file.type.startsWith('video/')) {
          duration = await new Promise((resolve, reject) => { const video = document.createElement('video'); const objectUrl = URL.createObjectURL(file); video.preload = 'metadata'; video.onloadedmetadata = () => { const value = Number(video.duration); URL.revokeObjectURL(objectUrl); if (!Number.isFinite(value) || value > ${MAX_VIDEO_SECONDS} + .05) reject(new Error('El vídeo no puede durar más de 30 segundos.')); else resolve(String(value)); }; video.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('No se pudo leer la duración del vídeo.')); }; video.src = objectUrl; });
        }
        status('Subiendo ' + (kind === 'icon' ? 'icono' : 'media') + '...');
        const response = await fetch('/partners/api/upload', { method:'POST', credentials:'same-origin', headers:{ 'content-type':file.type, 'x-file-name':encodeURIComponent(file.name), 'x-media-duration':duration }, body:file });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'No se pudo subir el fichero.');
        return data;
      }
      byId('partnerIconFile').addEventListener('change', async (event) => { try { const upload = await uploadFile(event.target, 'icon'); state.pendingIcon = upload; status('Icono listo. Guarda el partner para publicarlo.'); } catch (error) { event.target.value=''; status(error.message, true); } });
      byId('partnerMediaFile').addEventListener('change', async (event) => { try { const upload = await uploadFile(event.target, 'media'); state.pendingMedia = upload; status('Media lista. Guarda el partner para publicarla.'); } catch (error) { event.target.value=''; status(error.message, true); } });
      form.addEventListener('submit', async (event) => { event.preventDefault(); const title = byId('partnerTitle').value.trim(); if (!title) return status('El título es obligatorio.', true); if (!state.editingId && state.partners.length >= ${MAX_PARTNERS}) return status('Has alcanzado el límite de partners.', true); const existing = state.partners.find((item) => item.id === state.editingId); const rawDiscord = byId('partnerDiscordUrl').value.trim(); if (rawDiscord && !/^https:\/\/(?:discord\\.gg|discord\\.com|discordapp\\.com)\//i.test(rawDiscord)) return status('El enlace debe ser de Discord.', true); const partner = { ...(existing || {}), id: state.editingId || ('partner-' + Date.now()), title, bio:byId('partnerBio').value.trim(), discordUrl:rawDiscord, whatItDoes:byId('partnerWhatItDoes').value.trim(), iconUrl:state.pendingIcon?.url || existing?.iconUrl || '', media:state.pendingMedia || existing?.media || null }; if (state.editingId) state.partners = state.partners.map((item) => item.id === state.editingId ? partner : item); else state.partners.push(partner); try { status('Guardando...'); const response = await fetch('/partners/api', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({ partners:state.partners }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo guardar.'); state.partners = data.partners || state.partners; state.pendingIcon = null; state.pendingMedia = null; resetForm(); renderItems(); status('Partner publicado correctamente.'); setTimeout(() => window.location.reload(), 700); } catch (error) { status(error.message, true); } });
      byId('newPartnerButton').addEventListener('click', resetForm);
      document.addEventListener('click', (event) => { const edit = event.target.closest('[data-edit-partner]'); if (edit) { loadPartner(edit.dataset.editPartner); return; } const remove = event.target.closest('[data-delete-partner]'); if (remove) { const partner = state.partners.find((item) => item.id === remove.dataset.deletePartner); if (!partner || !window.confirm('¿Borrar ' + partner.title + '?')) return; state.partners = state.partners.filter((item) => item.id !== partner.id); if (state.editingId === partner.id) resetForm(); renderItems(); status('Cambio pendiente. Pulsa Guardar partner para confirmar.'); } });
      renderItems();
    })();
  </script>`;
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '≤30 s';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}
