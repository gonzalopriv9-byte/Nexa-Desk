import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildGlobalBanCode,
  isBlacklistEntryActive,
  normalizeBlacklistEvidence,
  normalizeBlacklistLookup,
  normalizeDiscordUserId,
  parseBlacklistDuration
} from './blacklist.js';

const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');
const DISCORD_USER_ID_RE = /^\d{15,21}$/;
const MAX_REASON_LENGTH = 1000;
const MAX_SOURCE_LENGTH = 180;
const MAX_DURATION_LENGTH = 120;
const MAX_EVIDENCE_DESCRIPTION_LENGTH = 500;
const MAX_PROOF_BYTES = 10_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const PROOF_FILE_RE = /^blacklist-proof-[a-z0-9-]+\.(?:png|jpe?g|webp|gif)$/i;
const DISCORD_MEDIA_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net'
]);

export function normalizeBlacklistWebLookup(value) {
  const raw = normalizeDiscordUserId(value);
  const lookup = normalizeBlacklistLookup(raw);
  const userId = normalizeDiscordUserId(lookup.userId);
  if (!DISCORD_USER_ID_RE.test(userId)) {
    throw new Error('Introduce un ID de usuario de Discord válido o un código baneo-global válido.');
  }
  return {
    userId,
    banCode: buildGlobalBanCode(userId)
  };
}

export async function getBlacklistWebRecord({ storage, value }) {
  const lookup = normalizeBlacklistWebLookup(value);
  const entry = await storage.getBlacklistEntry(lookup.userId);
  if (!entry) return null;
  const evidence = await storage.listBlacklistEvidence(lookup.userId);
  return serializeBlacklistWebRecord({ entry, evidence });
}

export function serializeBlacklistWebRecord({ entry, evidence = [] }) {
  const userId = String(entry?.userId ?? '').trim();
  const normalizedEvidence = (Array.isArray(evidence) ? evidence : [])
    .map((item) => normalizeBlacklistEvidence(item))
    .filter((item) => safeEvidenceUrl(item.attachmentUrl));
  return {
    entry: {
      userId,
      banCode: String(entry?.banCode ?? buildGlobalBanCode(userId)),
      reason: String(entry?.reason ?? '').slice(0, MAX_REASON_LENGTH),
      duration: String(entry?.duration ?? 'permanente').slice(0, MAX_DURATION_LENGTH),
      expiresAt: entry?.expiresAt ?? null,
      active: entry?.active !== false,
      createdBy: String(entry?.createdBy ?? '').slice(0, MAX_SOURCE_LENGTH),
      createdAt: entry?.createdAt ?? null,
      updatedAt: entry?.updatedAt ?? null
    },
    evidence: normalizedEvidence,
    profileUrl: `https://discord.com/users/${encodeURIComponent(userId)}`,
    activeNow: isBlacklistEntryActive(entry)
  };
}

export function buildBlacklistWebEntry(body = {}, existing = null, updatedBy = 'owner') {
  const lookup = normalizeBlacklistWebLookup(body.userId ?? existing?.userId);
  const reason = cleanText(body.reason ?? existing?.reason, MAX_REASON_LENGTH);
  if (!reason) throw new Error('El motivo del baneo es obligatorio.');

  const duration = cleanText(body.duration ?? existing?.duration ?? 'permanente', MAX_DURATION_LENGTH) || 'permanente';
  const parsedDuration = parseBlacklistDuration(duration);
  const hasExpiryField = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
  const explicitExpires = hasExpiryField
    ? (String(body.expiresAt ?? '').trim() ? normalizeNullableDate(body.expiresAt) : parsedDuration.expiresAt)
    : existing?.expiresAt ?? parsedDuration.expiresAt;
  const createdAt = normalizeDate(body.createdAt ?? existing?.createdAt) || new Date().toISOString();
  const source = cleanText(body.source ?? body.createdBy ?? existing?.createdBy ?? 'NexaDesk', MAX_SOURCE_LENGTH) || 'NexaDesk';
  const active = body.active === undefined
    ? existing?.active !== false
    : normalizeBoolean(body.active);

  return {
    userId: lookup.userId,
    banCode: lookup.banCode,
    reason,
    duration,
    expiresAt: explicitExpires,
    active,
    createdBy: source,
    createdAt,
    updatedBy: cleanText(updatedBy, MAX_SOURCE_LENGTH),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeBlacklistWebEvidenceList(value, { userId, banCode, createdBy = 'owner' } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((item) => normalizeBlacklistWebEvidence(item, { userId, banCode, createdBy }))
    .filter(Boolean);
}

function normalizeBlacklistWebEvidence(value, { userId, banCode, createdBy }) {
  if (!value || typeof value !== 'object') return null;
  const attachmentUrl = safeEvidenceUrl(value.attachmentUrl ?? value.attachment_url ?? value.url);
  if (!attachmentUrl) return null;
  const contentType = normalizeImageType(value.contentType ?? value.content_type, attachmentUrl);
  return {
    id: value.id,
    userId,
    banCode,
    attachmentUrl,
    proxyUrl: '',
    fileName: cleanFileName(value.fileName ?? value.file_name),
    contentType,
    description: cleanText(value.description, MAX_EVIDENCE_DESCRIPTION_LENGTH),
    createdBy: cleanText(value.createdBy ?? value.created_by ?? createdBy, MAX_SOURCE_LENGTH),
    createdAt: normalizeDate(value.createdAt ?? value.created_at) || new Date().toISOString()
  };
}

export async function saveBlacklistProofUpload({ buffer, mimeType, fileName = 'blacklist-proof' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('No se recibió ninguna imagen.');
  const type = normalizeImageType(mimeType);
  if (!type) throw new Error('La prueba debe ser PNG, JPG, WEBP o GIF.');
  if (buffer.length > MAX_PROOF_BYTES) throw new Error('La imagen de prueba debe pesar menos de 10 MB.');
  if (!matchesImageSignature(buffer, type)) throw new Error('El contenido no coincide con el tipo de imagen declarado.');

  const extension = ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  })[type];
  const id = `blacklist-proof-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, id), buffer, { flag: 'wx' });
  return {
    url: `/uploads/${id}`,
    fileName: id,
    contentType: type,
    size: buffer.length,
    kind: 'image'
  };
}

function safeEvidenceUrl(value) {
  const raw = String(value ?? '').trim().slice(0, 2000);
  if (/^\/uploads\/[a-z0-9._-]+$/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !DISCORD_MEDIA_HOSTS.has(url.hostname.toLowerCase())) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function cleanFileName(value) {
  const fileName = path.basename(String(value ?? '').trim());
  return PROOF_FILE_RE.test(fileName) ? fileName : '';
}

function normalizeImageType(value, url = '') {
  const type = String(value ?? '').toLowerCase().split(';')[0].trim();
  if (IMAGE_TYPES.has(type)) return type;
  const extension = path.extname(String(url).split('?')[0]).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[extension] || '';
}

function matchesImageSignature(buffer, type) {
  if (type === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg' || type === 'image/jpg') return buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (type === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function normalizeDate(value) {
  const date = new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeNullableDate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const date = normalizeDate(value);
  if (!date) throw new Error('La fecha de caducidad no es válida.');
  return date;
}

function normalizeBoolean(value) {
  if (value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1') return true;
  return false;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

function jsonForHtml(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatDate(value) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return 'No indicada';
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(time));
}

function formatDateInput(value) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (name) => parts.find((part) => part.type === name)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function renderEvidence(evidence) {
  if (!evidence.length) return '<div class="proof-empty">No hay imagen de prueba publicada para este registro.</div>';
  return `<div class="proof-grid">${evidence.map((item) => {
    const url = safeEvidenceUrl(item.attachmentUrl);
    const label = item.description || item.fileName || 'Prueba documental';
    const type = String(item.contentType ?? '').startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:$|\?)/i.test(url);
    return type
      ? `<a class="proof" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" referrerpolicy="no-referrer"><span>${escapeHtml(label)}</span></a>`
      : `<a class="proof proof-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir prueba ↗<span>${escapeHtml(label)}</span></a>`;
  }).join('')}</div>`;
}

function renderRecord(record, isOwner) {
  const { entry, evidence, profileUrl, activeNow } = record;
  const status = activeNow ? 'Activa' : entry.active ? 'Caducada' : 'Inactiva';
  const statusClass = activeNow ? 'active' : 'inactive';
  return `<section class="result-card" id="result" aria-live="polite">
    <div class="result-top"><div><p class="eyebrow">Resultado de búsqueda</p><h2>Registro global encontrado</h2></div><span class="status ${statusClass}">${status}</span></div>
    <div class="identity-row"><div class="avatar-mark">⌁</div><div><strong>Usuario de Discord</strong><span class="mono">${escapeHtml(entry.userId)}</span></div><a class="profile-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">Ver perfil ↗</a></div>
    <div class="info-grid">
      <div class="info"><span>Fecha de baneo</span><strong>${escapeHtml(formatDate(entry.createdAt))}</strong></div>
      <div class="info"><span>Fuente</span><strong>${escapeHtml(entry.createdBy || 'No indicada')}</strong></div>
      <div class="info"><span>Duración</span><strong>${escapeHtml(entry.duration || 'Permanente')}</strong></div>
      <div class="info"><span>Caduca</span><strong>${entry.expiresAt ? escapeHtml(formatDate(entry.expiresAt)) : 'Sin caducidad'}</strong></div>
    </div>
    <div class="reason"><span>Argumento del baneo</span><p>${escapeHtml(entry.reason || 'Sin motivo especificado')}</p></div>
    <div class="proof-section"><div class="proof-heading"><span>Prueba</span><small>${evidence.length ? `${evidence.length} archivo${evidence.length === 1 ? '' : 's'}` : 'Sin adjuntos'}</small></div>${renderEvidence(evidence)}</div>
    ${isOwner ? '<a class="owner-edit-link" href="#owner-editor">Editar este registro ↓</a>' : ''}
  </section>`;
}

export function renderBlacklistPage({ query = '', record = null, error = '', isOwner = false } = {}) {
  const initial = jsonForHtml(record);
  const content = error
    ? `<section class="notice error"><strong>No se pudo realizar la búsqueda.</strong><span>${escapeHtml(error)}</span></section>`
    : record
      ? renderRecord(record, isOwner)
      : query
        ? '<section class="notice"><strong>No se encontró ningún registro.</strong><span>Comprueba el ID de Discord o el código de baneo global e inténtalo de nuevo.</span></section>'
        : '<section class="empty"><div class="empty-icon">⌕</div><p class="eyebrow">Consulta pública</p><h2>La información que necesitas, sin ruido.</h2><p>Busca un ID de usuario de Discord para consultar el estado, la fecha, el origen, el motivo y las pruebas disponibles de una blacklist global.</p></section>';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Consulta pública de registros de blacklist global de NexaDesk.">
  <title>Blacklist global · NexaDesk</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root{color-scheme:dark;--bg:#050505;--panel:rgba(255,255,255,.055);--panel2:rgba(255,255,255,.09);--line:rgba(255,255,255,.16);--text:#f7f7f7;--muted:#ababab;--soft:#707070;--gold:#d6b86a;--red:#ff7474;--green:#8fdaae;--ease:cubic-bezier(.2,.75,.2,1)}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 10% -8%,rgba(255,255,255,.15),transparent 30%),radial-gradient(circle at 92% 7%,rgba(214,184,106,.12),transparent 25%),repeating-linear-gradient(90deg,rgba(255,255,255,.038) 0 1px,transparent 1px 86px),repeating-linear-gradient(0deg,rgba(255,255,255,.026) 0 1px,transparent 1px 86px),var(--bg)}a{color:inherit}.shell{width:min(1060px,calc(100% - 30px));margin:0 auto;padding:22px 0 68px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 0 30px}.brand{display:inline-flex;align-items:center;gap:11px;text-decoration:none;font-weight:950;letter-spacing:-.04em}.brand img{width:41px;height:41px;border:1px solid rgba(255,255,255,.35);border-radius:13px;background:#050505}.nav{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.nav a,.owner-chip{padding:9px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(255,255,255,.035);font-size:12px;font-weight:850;text-decoration:none}.nav a:hover{color:#050505;background:#fff}.owner-chip{color:#050505;background:var(--gold);border-color:transparent}.hero{position:relative;overflow:hidden;padding:clamp(28px,6vw,66px);border:1px solid var(--line);border-radius:34px;background:linear-gradient(135deg,rgba(255,255,255,.12),rgba(255,255,255,.035) 52%,rgba(0,0,0,.58));box-shadow:0 40px 130px rgba(0,0,0,.5)}.hero:after{content:"";position:absolute;right:-160px;top:-210px;width:520px;height:520px;border:1px solid rgba(214,184,106,.28);border-radius:50%;box-shadow:0 0 0 55px rgba(214,184,106,.06),0 0 0 120px rgba(255,255,255,.025);pointer-events:none}.hero>*{position:relative;z-index:1}.eyebrow{margin:0 0 13px;color:var(--gold);font-size:11px;font-weight:950;letter-spacing:.22em;text-transform:uppercase}.hero h1{max-width:780px;margin:0 0 18px;font-size:clamp(46px,8vw,94px);line-height:.88;letter-spacing:-.085em}.hero p:not(.eyebrow){max-width:690px;margin:0;color:#bdbdbd;font-size:clamp(16px,2vw,20px);line-height:1.5}.search-form{display:flex;gap:10px;max-width:770px;margin-top:31px}.search-form input{flex:1;min-width:0;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:15px 18px;color:#fff;background:rgba(0,0,0,.4);outline:0;font:inherit}.search-form input:focus{border-color:var(--gold);box-shadow:0 0 0 4px rgba(214,184,106,.12)}button,.button{border:1px solid transparent;border-radius:999px;padding:13px 18px;color:#050505;background:#fff;font:inherit;font-weight:950;cursor:pointer;text-decoration:none;transition:transform .2s var(--ease),background .2s ease,box-shadow .2s ease}button:hover,.button:hover{transform:translateY(-2px);background:var(--gold);box-shadow:0 15px 32px rgba(0,0,0,.25)}.hero-note{margin-top:14px!important;color:var(--soft)!important;font-size:12px!important}.result-wrap{margin-top:25px}.result-card,.empty,.notice{border:1px solid var(--line);border-radius:28px;background:linear-gradient(145deg,rgba(255,255,255,.1),rgba(255,255,255,.03) 54%,rgba(0,0,0,.42));box-shadow:0 26px 90px rgba(0,0,0,.38)}.result-card{padding:clamp(22px,4vw,38px)}.result-top,.identity-row,.proof-heading{display:flex;align-items:center;justify-content:space-between;gap:15px}.result-top h2{margin:0;font-size:clamp(27px,4vw,47px);letter-spacing:-.07em}.status{padding:8px 11px;border:1px solid;border-radius:999px;font-size:11px;font-weight:950;letter-spacing:.1em;text-transform:uppercase}.status.active{color:var(--green);border-color:rgba(143,218,174,.4);background:rgba(143,218,174,.08)}.status.inactive{color:#ffc1a3;border-color:rgba(255,193,163,.35);background:rgba(255,193,163,.07)}.identity-row{justify-content:flex-start;margin:28px 0 21px;padding:15px;border:1px solid rgba(255,255,255,.12);border-radius:19px;background:rgba(0,0,0,.25)}.avatar-mark{display:grid;place-items:center;width:46px;height:46px;border:1px solid rgba(214,184,106,.5);border-radius:14px;color:var(--gold);font-size:26px}.identity-row strong,.identity-row span{display:block}.identity-row strong{font-size:13px}.identity-row span{margin-top:4px;color:var(--muted);font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.profile-link{margin-left:auto;padding:10px 13px;border:1px solid rgba(255,255,255,.2);border-radius:999px;color:#fff;text-decoration:none;font-size:12px;font-weight:900}.profile-link:hover{background:#fff;color:#050505}.info-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.info{min-width:0;padding:15px;border:1px solid rgba(255,255,255,.12);border-radius:17px;background:rgba(255,255,255,.035)}.info span,.reason>span,.proof-heading>span{display:block;color:var(--soft);font-size:10px;font-weight:950;letter-spacing:.14em;text-transform:uppercase}.info strong{display:block;margin-top:8px;overflow:hidden;color:#eee;font-size:14px;line-height:1.35;text-overflow:ellipsis}.reason{margin-top:10px;padding:18px;border:1px solid rgba(214,184,106,.28);border-radius:18px;background:rgba(214,184,106,.06)}.reason p{margin:10px 0 0;color:#eee;line-height:1.6;white-space:pre-wrap}.proof-section{margin-top:26px}.proof-heading{margin-bottom:12px}.proof-heading small{color:var(--soft);font-size:12px}.proof-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:11px}.proof{position:relative;display:flex;flex-direction:column;overflow:hidden;min-height:150px;border:1px solid rgba(255,255,255,.15);border-radius:17px;background:rgba(0,0,0,.35);text-decoration:none}.proof img{width:100%;height:145px;object-fit:cover}.proof span{padding:9px 11px;color:var(--muted);font-size:12px;line-height:1.35}.proof-link{justify-content:center;padding:18px;color:var(--gold);font-weight:950}.proof-link span{padding:7px 0 0;color:var(--muted);font-weight:500}.proof-empty{padding:18px;border:1px dashed rgba(255,255,255,.18);border-radius:16px;color:var(--soft);font-size:13px}.owner-edit-link{display:inline-flex;margin-top:22px;color:var(--gold);font-size:13px;font-weight:900;text-decoration:none}.empty{padding:68px 24px;text-align:center}.empty-icon{display:grid;place-items:center;width:65px;height:65px;margin:0 auto 20px;border:1px solid rgba(214,184,106,.5);border-radius:20px;color:var(--gold);font-size:30px}.empty h2{max-width:580px;margin:0 auto 12px;font-size:clamp(28px,5vw,53px);line-height:.96;letter-spacing:-.075em}.empty>p:last-child{max-width:620px;margin:0 auto;color:var(--muted);line-height:1.6}.notice{display:grid;gap:8px;padding:25px;color:var(--muted);line-height:1.5}.notice strong{color:#fff;font-size:19px}.notice.error{border-color:rgba(255,116,116,.38)}.notice.error strong{color:var(--red)}.owner-editor{margin-top:25px;padding:25px;border:1px solid rgba(214,184,106,.35);border-radius:28px;background:linear-gradient(145deg,rgba(214,184,106,.09),rgba(255,255,255,.035),rgba(0,0,0,.45))}.owner-editor h2{margin:0 0 6px;font-size:clamp(26px,4vw,44px);letter-spacing:-.07em}.owner-editor>p{margin:0 0 22px;color:var(--muted);line-height:1.5}.owner-form{display:grid;gap:12px}.owner-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}.field{display:grid;gap:7px}.field label{font-size:11px;font-weight:950;letter-spacing:.1em;text-transform:uppercase}.field input,.field textarea,.field select{width:100%;border:1px solid rgba(255,255,255,.17);border-radius:14px;padding:11px 12px;color:#fff;background:rgba(0,0,0,.36);outline:0;font:inherit}.field textarea{min-height:110px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--gold);box-shadow:0 0 0 4px rgba(214,184,106,.1)}.field.full{grid-column:1/-1}.proof-editor{padding:14px;border:1px dashed rgba(255,255,255,.2);border-radius:17px}.proof-editor>label{display:block;margin-bottom:10px;font-size:11px;font-weight:950;letter-spacing:.1em;text-transform:uppercase}.proof-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:11px}.proof-edit{position:relative;overflow:hidden;min-height:100px;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:#000}.proof-edit img{width:100%;height:100px;object-fit:cover}.proof-edit button{position:absolute;right:6px;top:6px;padding:5px 8px;color:#fff;background:rgba(0,0,0,.75);font-size:11px}.proof-edit button:hover{background:var(--red)}.proof-add{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.proof-add input{max-width:100%;color:var(--muted);font-size:12px}.owner-actions{display:flex;align-items:center;gap:11px;flex-wrap:wrap}.owner-status{min-height:20px;color:var(--muted);font-size:13px}.owner-status.error{color:var(--red)}footer{display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;margin-top:25px;padding-top:20px;border-top:1px solid rgba(255,255,255,.12);color:var(--soft);font-size:12px}footer nav{display:flex;gap:12px;flex-wrap:wrap}footer a{color:var(--muted);text-decoration:none}footer a:hover{color:#fff}@media(max-width:760px){.topbar,.result-top{align-items:flex-start;flex-direction:column}.nav{justify-content:flex-start}.search-form{flex-direction:column}.search-form button{width:100%}.info-grid{grid-template-columns:1fr 1fr}.owner-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.identity-row{align-items:flex-start;flex-wrap:wrap}.profile-link{margin-left:57px}}@media(max-width:450px){.shell{width:min(100% - 18px,1060px);padding-top:12px}.hero{padding:24px 17px;border-radius:24px}.hero h1{font-size:clamp(44px,15vw,70px)}.result-card,.owner-editor{padding:18px;border-radius:22px}.info-grid{grid-template-columns:1fr}.empty{padding:48px 17px}footer{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar"><a class="brand" href="/"><img src="/assets/nexadesk-logo.svg" alt="">NexaDesk</a><nav class="nav"><a href="/">Dashboard</a><a href="/partners">Partners</a><a href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Soporte</a>${isOwner ? '<span class="owner-chip">Owner mode</span>' : ''}</nav></header>
    <main>
      <section class="hero"><p class="eyebrow">NexaDesk / Global Safety</p><h1>Consulta una blacklist. Entiende el contexto.</h1><p>Busca un usuario por su ID de Discord o por su código global para consultar un registro de seguridad, su origen, el motivo y las pruebas disponibles.</p><form class="search-form" action="/blacklist" method="get"><input name="q" value="${escapeHtml(query)}" placeholder="ID de Discord o baneo-global-..." autocomplete="off" required><button type="submit">Buscar registro ↗</button></form><p class="hero-note">Consulta pública · Los registros pueden estar activos, caducados o inactivos.</p></section>
      <div class="result-wrap">${content}</div>
      ${isOwner ? `<section class="owner-editor" id="owner-editor"><p class="eyebrow">Zona privada</p><h2>Editar registro global.</h2><p>Solo el owner global puede modificar o crear registros. Usa un ID de Discord válido; la información se guarda en PostgreSQL y el código de baneo se genera automáticamente.</p><form class="owner-form" id="blacklistOwnerForm"><div class="owner-grid"><div class="field"><label for="blacklistUserId">ID de Discord</label><input id="blacklistUserId" required inputmode="numeric" placeholder="123456789012345678"></div><div class="field"><label for="blacklistSource">Fuente / bot</label><input id="blacklistSource" maxlength="180" placeholder="Bot de seguridad, SPAgency..."></div><div class="field"><label for="blacklistCreatedAt">Fecha de baneo</label><input id="blacklistCreatedAt" type="datetime-local" required></div><div class="field"><label for="blacklistDuration">Duración</label><input id="blacklistDuration" maxlength="120" placeholder="permanente, 30 dias..."></div><div class="field"><label for="blacklistExpiresAt">Caducidad (opcional)</label><input id="blacklistExpiresAt" type="datetime-local"></div><div class="field"><label for="blacklistActive">Estado administrativo</label><select id="blacklistActive"><option value="true">Activa</option><option value="false">Inactiva</option></select></div><div class="field full"><label for="blacklistReason">Argumento del baneo</label><textarea id="blacklistReason" maxlength="1000" required placeholder="Motivo documentado del baneo..."></textarea></div></div><div class="proof-editor"><label>Pruebas de imagen</label><div class="proof-list" id="blacklistProofList"></div><div class="proof-add"><input id="blacklistProofFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><span class="owner-status" id="blacklistProofStatus"></span></div></div><div class="owner-actions"><button type="submit">Guardar registro</button><a class="button" href="/blacklist">Limpiar</a><span class="owner-status" id="blacklistOwnerStatus" aria-live="polite"></span></div></form></section>` : ''}
    </main>
    <footer><span>NexaDesk · Global Safety.</span><nav><a href="/terms">Términos</a><a href="/privacy">Privacidad</a><a href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Discord oficial</a></nav></footer>
  </div>
  <script id="blacklistInitialRecord" type="application/json">${initial}</script>
  ${isOwner ? `<script>
    (() => {
      const form = document.getElementById('blacklistOwnerForm');
      if (!form) return;
      const initial = JSON.parse(document.getElementById('blacklistInitialRecord')?.textContent || 'null');
      const state = { evidence: Array.isArray(initial?.evidence) ? initial.evidence : [] };
      const el = (id) => document.getElementById(id);
      const setStatus = (message, error = false) => { const node = el('blacklistOwnerStatus'); node.textContent = message; node.classList.toggle('error', error); };
      const toLocal = (value) => { const time = Date.parse(value || ''); if (!Number.isFinite(time)) return ''; const date = new Date(time); const parts = new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).formatToParts(date); const get = (name) => parts.find((part) => part.type === name)?.value || ''; return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute'); };
      const fromLocal = (value) => value ? new Date(value).toISOString() : null;
      const esc = (value) => String(value ?? '').replace(/[&<>\"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[char]));
      function renderEvidence() { const target = el('blacklistProofList'); if (!target) return; target.innerHTML = state.evidence.length ? state.evidence.map((item, index) => '<div class="proof-edit"><img src="' + esc(item.attachmentUrl) + '" alt="Prueba ' + (index + 1) + '" referrerpolicy="no-referrer"><button type="button" data-remove-proof="' + index + '">Quitar</button></div>').join('') : '<span class="owner-status">Sin imágenes adjuntas.</span>'; }
      function loadRecord(record) { const entry = record?.entry; if (!entry) { el('blacklistCreatedAt').value = ''; el('blacklistExpiresAt').value = ''; el('blacklistDuration').value = 'permanente'; el('blacklistActive').value = 'true'; el('blacklistSource').value = ''; el('blacklistReason').value = ''; return; } el('blacklistUserId').value = entry.userId || ''; el('blacklistSource').value = entry.createdBy || ''; el('blacklistCreatedAt').value = toLocal(entry.createdAt) || ''; el('blacklistDuration').value = entry.duration || 'permanente'; el('blacklistExpiresAt').value = toLocal(entry.expiresAt) || ''; el('blacklistActive').value = entry.active === false ? 'false' : 'true'; el('blacklistReason').value = entry.reason || ''; renderEvidence(); }
      el('blacklistProofFile')?.addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (!file) return; const status = el('blacklistProofStatus'); try { if (!file.type.startsWith('image/')) throw new Error('Solo se admiten imágenes.'); status.textContent = 'Subiendo prueba...'; const response = await fetch('/blacklist/api/upload', { method:'POST', credentials:'same-origin', headers:{ 'content-type':file.type, 'x-file-name':encodeURIComponent(file.name) }, body:file }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo subir la imagen.'); state.evidence.push({ attachmentUrl:data.url, fileName:data.fileName, contentType:data.contentType, description:'Prueba documental', createdBy:el('blacklistSource').value.trim() || 'owner' }); renderEvidence(); status.textContent = 'Prueba lista. Guarda el registro para publicarla.'; event.target.value = ''; } catch (error) { status.textContent = error.message; } });
      document.addEventListener('click', (event) => { const button = event.target.closest('[data-remove-proof]'); if (!button) return; state.evidence.splice(Number(button.dataset.removeProof), 1); renderEvidence(); });
      form.addEventListener('submit', async (event) => { event.preventDefault(); const userId = String(el('blacklistUserId').value ?? '').normalize('NFKC').replace(/[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200D\\u2060\\uFEFF]/g, '').trim(); el('blacklistUserId').value = userId; if (!/^[0-9]{15,21}$/.test(userId)) return setStatus('El ID de Discord debe tener entre 15 y 21 dígitos.', true); const payload = { userId, source:el('blacklistSource').value.trim(), createdAt:fromLocal(el('blacklistCreatedAt').value), expiresAt:fromLocal(el('blacklistExpiresAt').value), duration:el('blacklistDuration').value.trim() || 'permanente', active:el('blacklistActive').value === 'true', reason:el('blacklistReason').value.trim(), evidence:state.evidence }; try { setStatus('Guardando...'); const response = await fetch('/blacklist/api', { method:'PUT', credentials:'same-origin', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo guardar el registro.'); window.location.href = '/blacklist?q=' + encodeURIComponent(userId); } catch (error) { setStatus(error.message, true); } });
      loadRecord(initial); renderEvidence();
    })();
  </script>` : ''}
</body>
</html>`;
}
