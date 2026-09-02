import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_LABEL = 'Migración histórica (SPAgency)';
const BAN_PREFIX = 'baneo-global-';
const PROOF_RE = /^proofs\/[a-z0-9._-]+$/i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

loadDotEnv(path.resolve(process.cwd(), '.env'));

main().catch((error) => {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const inputPath = path.resolve(process.cwd(), options.input || 'data/import/spagency/blacklist.json');
  const proofRoot = path.resolve(process.cwd(), options.proofRoot || path.dirname(inputPath));
  const mode = options.mode || 'historical-expiry';
  const nullDuration = options.nullDuration || 'inactive';
  const conflict = options.conflict || 'skip';
  const now = parseDate(options.now, new Date().toISOString());
  const nowMs = Date.parse(now);

  if (!['historical-expiry', 'all-active'].includes(mode)) {
    throw new Error('--mode debe ser historical-expiry o all-active.');
  }
  if (!['inactive', 'permanent'].includes(nullDuration)) {
    throw new Error('--null-duration debe ser inactive o permanent.');
  }
  if (!['skip', 'update'].includes(conflict)) {
    throw new Error('--conflict debe ser skip o update.');
  }

  const raw = await fs.readFile(inputPath, 'utf8');
  const source = JSON.parse(raw);
  if (!Array.isArray(source)) {
    throw new Error('El JSON debe contener un array de registros.');
  }

  const mapped = [];
  const evidence = [];
  const invalid = [];
  const reasonCounts = new Map();
  const proofStats = { references: 0, filesFound: 0, filesCopied: 0, filesMissing: 0, invalidReferences: 0 };

  for (const [index, record] of source.entries()) {
    const result = await mapRecord(record, { mode, nullDuration, now, nowMs, proofRoot, proofStats });
    if (!result) {
      invalid.push({ index, id: record?.id ?? null });
      continue;
    }
    mapped.push(result.entry);
    evidence.push(...result.evidence);
    reasonCounts.set(result.entry.reason, (reasonCounts.get(result.entry.reason) || 0) + 1);
  }

  const duplicateIds = findDuplicates(mapped.map((entry) => entry.userId));
  if (duplicateIds.length) {
    throw new Error(`El histórico contiene IDs duplicados: ${duplicateIds.slice(0, 10).join(', ')}`);
  }

  const summary = buildSummary({ source, mapped, evidence, invalid, reasonCounts, proofStats, now, mode, nullDuration, conflict, inputPath, proofRoot });
  printSummary(summary);

  if (!options.apply) {
    console.log('\nDRY RUN: no se ha escrito nada en PostgreSQL. Añade --apply cuando confirmes el mapeo.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('No se encontró DATABASE_URL en .env o en el entorno.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await assertTable(client, 'global_blacklist');
    await assertTable(client, 'global_blacklist_evidence');
    await assertColumn(client, 'global_blacklist_evidence', 'source_key');

    let blacklistAffected = 0;
    for (const entry of mapped) {
      const result = await client.query(buildBlacklistQuery(conflict), [
        entry.userId,
        entry.banCode,
        entry.reason,
        entry.duration,
        entry.expiresAt,
        entry.active,
        entry.createdBy,
        entry.createdAt,
        entry.updatedAt
      ]);
      blacklistAffected += result.rowCount || 0;
    }

    let evidenceAffected = 0;
    for (const item of evidence) {
      const result = await client.query(buildEvidenceQuery(conflict), [
        item.userId,
        item.banCode,
        item.attachmentUrl,
        item.proxyUrl,
        item.fileName,
        item.contentType,
        item.description,
        item.createdBy,
        item.sourceKey,
        item.createdAt
      ]);
      evidenceAffected += result.rowCount || 0;
    }

    await client.query('COMMIT');
    console.log(`\nAPLICADO: ${blacklistAffected} filas de blacklist y ${evidenceAffected} evidencias nuevas/actualizadas.`);
    console.log(`Conflictos de blacklist existentes: ${conflict === 'skip' ? 'omitidos' : 'actualizados'}.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function mapRecord(record, { mode, nullDuration, now, nowMs, proofRoot, proofStats }) {
  if (!record || typeof record !== 'object') return null;
  const userId = String(record.id ?? '').trim();
  if (!/^\d{15,21}$/.test(userId)) return null;

  const createdAt = parseDate(record.createdAt, now);
  const createdMs = Date.parse(createdAt);
  const punishmentDays = parsePunishmentDays(record.punishmentDays);
  const sourceActive = ['activo', 'active', 'true'].includes(String(record.status ?? '').trim().toLowerCase());
  const reason = String(record.reason ?? '').replace(/\u0000/g, '').trim().slice(0, 900) || 'Sin motivo especificado';
  const historicalExpiresAt = punishmentDays === null
    ? null
    : new Date(createdMs + punishmentDays * DAY_MS).toISOString();

  let expiresAt = historicalExpiresAt;
  let active = sourceActive;
  let duration = punishmentDays === null ? 'historico-sin-duracion' : `${punishmentDays}d`;

  if (mode === 'historical-expiry') {
    if (punishmentDays === null) {
      active = sourceActive && nullDuration === 'permanent';
      expiresAt = null;
      duration = nullDuration === 'permanent' ? 'permanente' : 'historico-sin-duracion';
    } else {
      active = sourceActive && Date.parse(historicalExpiresAt) > nowMs;
    }
  } else {
    expiresAt = null;
    if (punishmentDays === null) {
      active = sourceActive && nullDuration === 'permanent';
      duration = nullDuration === 'permanent' ? 'permanente' : 'historico-sin-duracion';
    } else {
      active = sourceActive;
      duration = `${punishmentDays}d-importado-activo`;
    }
  }

  const entry = {
    userId,
    banCode: `${BAN_PREFIX}${userId}`,
    reason,
    duration,
    expiresAt,
    active,
    createdBy: SOURCE_LABEL,
    createdAt,
    updatedAt: parseDate(record.updatedAt, createdAt)
  };

  const evidence = await mapProofs(record, { proofRoot, proofStats, entry });
  return { entry, evidence };
}

async function mapProofs(record, { proofRoot, proofStats, entry }) {
  const proofs = Array.isArray(record.proofs) ? record.proofs : [];
  const result = [];
  for (const rawProof of proofs) {
    proofStats.references += 1;
    const proof = String(rawProof ?? '').trim().replaceAll('\\', '/');
    if (!PROOF_RE.test(proof)) {
      proofStats.invalidReferences += 1;
      continue;
    }

    const absolutePath = path.resolve(proofRoot, proof);
    const expectedRoot = `${proofRoot}${path.sep}`;
    const insideRoot = absolutePath.startsWith(expectedRoot);
    const fileExists = insideRoot && fsSync.existsSync(absolutePath) && fsSync.statSync(absolutePath).isFile();
    let attachmentUrl = '';
    let storedFileName = proof;

    if (fileExists) {
      proofStats.filesFound += 1;
      const copied = await copyProofAsset(absolutePath, entry.userId, proof);
      attachmentUrl = `/uploads/${copied.fileName}`;
      storedFileName = copied.fileName;
      proofStats.filesCopied += 1;
    } else {
      proofStats.filesMissing += 1;
    }

    result.push({
      userId: entry.userId,
      banCode: entry.banCode,
      attachmentUrl,
      proxyUrl: null,
      fileName: storedFileName,
      contentType: contentTypeFor(proof),
      description: `Prueba histórica importada desde SPAgency${fileExists ? '' : ' (archivo no encontrado localmente)'}.`,
      createdBy: SOURCE_LABEL,
      sourceKey: `spagency:${entry.userId}:${proof}`,
      createdAt: entry.createdAt
    });
  }
  return result;
}

async function copyProofAsset(sourcePath, userId, proof) {
  const uploadsDir = path.resolve(process.cwd(), 'data', 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const extension = path.extname(proof).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`Prueba histórica no compatible: ${proof}`);
  const digest = crypto.createHash('sha256').update(`${userId}:${proof}`).digest('hex').slice(0, 10);
  const fileName = `blacklist-proof-${userId}-${digest}${extension}`;
  const destination = path.join(uploadsDir, fileName);
  if (!fsSync.existsSync(destination)) await fs.copyFile(sourcePath, destination);
  return { fileName };
}

function buildBlacklistQuery(conflict) {
  const insert = `insert into public.global_blacklist
    (user_id, ban_code, reason, duration, expires_at, active, created_by, created_at, updated_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
  if (conflict === 'skip') return `${insert} on conflict (user_id) do nothing`;
  return `${insert}
    on conflict (user_id) do update set
      ban_code = excluded.ban_code,
      reason = excluded.reason,
      duration = excluded.duration,
      expires_at = excluded.expires_at,
      active = excluded.active,
      created_by = excluded.created_by,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`;
}

function buildEvidenceQuery(conflict) {
  const insert = `insert into public.global_blacklist_evidence
    (user_id, ban_code, attachment_url, proxy_url, file_name, content_type, description, created_by, source_key, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  if (conflict === 'skip') return `${insert} on conflict (source_key) do nothing`;
  return `${insert}
    on conflict (source_key) do update set
      attachment_url = excluded.attachment_url,
      proxy_url = excluded.proxy_url,
      file_name = excluded.file_name,
      content_type = excluded.content_type,
      description = excluded.description,
      created_by = excluded.created_by,
      created_at = excluded.created_at`;
}

function buildSummary({ source, mapped, evidence, invalid, reasonCounts, proofStats, now, mode, nullDuration, conflict, inputPath, proofRoot }) {
  const active = mapped.filter((entry) => entry.active).length;
  const expired = mapped.filter((entry) => !entry.active && entry.expiresAt).length;
  const noDuration = mapped.filter((entry) => entry.duration === 'historico-sin-duracion').length;
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }));
  return {
    inputPath,
    proofRoot,
    sourceRecords: source.length,
    validRecords: mapped.length,
    invalidRecords: invalid.length,
    activeAfterMapping: active,
    inactiveOrExpiredAfterMapping: mapped.length - active,
    expiredByPunishmentDate: expired,
    missingDurationForReview: noDuration,
    evidenceReferencesToStore: evidence.length,
    proofStats,
    mode,
    nullDuration,
    conflict,
    evaluatedAt: now,
    topReasons
  };
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
  if (summary.invalidRecords) console.log(`\nAviso: ${summary.invalidRecords} registros no se importarían por ID inválido.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = match[2];
      continue;
    }
    throw new Error(`Argumento desconocido: ${arg}`);
  }
  return options;
}

function parsePunishmentDays(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return null;
  return days;
}

function parseDate(value, fallback) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function contentTypeFor(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension] || 'application/octet-stream';
}

async function assertTable(client, tableName) {
  const result = await client.query('select to_regclass($1) as table_name', [`public.${tableName}`]);
  if (!result.rows[0]?.table_name) throw new Error(`No existe public.${tableName}. Ejecuta primero el esquema PostgreSQL actualizado.`);
}

async function assertColumn(client, tableName, columnName) {
  const result = await client.query(`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = $1 and column_name = $2
  `, [tableName, columnName]);
  if (!result.rowCount) throw new Error(`Falta public.${tableName}.${columnName}. Ejecuta el esquema PostgreSQL actualizado.`);
}

function loadDotEnv(filePath) {
  let raw;
  try { raw = fsSync.readFileSync(filePath, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function printUsage() {
  console.log(`Uso:
  node scripts/import-spagency-blacklist.js --input=data/import/spagency/blacklist.json
  node scripts/import-spagency-blacklist.js --input=... --mode=historical-expiry --null-duration=inactive --apply

Opciones:
  --input=RUTA                  JSON exportado; por defecto data/import/spagency/blacklist.json
  --proof-root=RUTA             Carpeta que contiene proofs/; por defecto la carpeta del JSON
  --mode=historical-expiry      Respeta createdAt + punishmentDays (recomendado)
  --mode=all-active             Convierte Activo en blacklist indefinida (no recomendado)
  --null-duration=inactive      Registros sin duración quedan inactivos (por defecto)
  --null-duration=permanent     Registros sin duración se consideran permanentes
  --conflict=skip               No pisa entradas existentes (por defecto)
  --conflict=update             Actualiza entradas existentes explícitamente
  --now=ISO                     Fecha de evaluación reproducible
  --apply                       Escribe en PostgreSQL; sin esto solo hace dry-run
`);
}
