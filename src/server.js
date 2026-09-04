import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAdminAccessCode,
  canReuseAdminAccessCode,
  generateAdminCode,
  getAdminAccessCodeStatus,
  getAdminAccessCodeValue,
  inspectAdminAccessCode
} from './admin-code.js';
import { GroqClient } from './ai/groq-client.js';
import { GLOBAL_BLACKLIST_ADMIN_USER_ID, GLOBAL_BAN_CODE_PREFIX, buildGlobalBanCode, isBlacklistEntryActive, normalizeDiscordUserId, parseBlacklistDuration } from './blacklist.js';
import { normalizeTotpSecret, verifyTotpCode } from './docs-auth.js';
import { discordEmojiUrl } from './emojis.js';
import { buildExamAnswerRecord, buildHeuristicExamEvaluation, formatExamEvaluation, normalizeExamState } from './exam-mode.js';
import { normalizeGrowthConfig } from './growth.js';
import { normalizeMaintenanceState } from './maintenance.js';
import { normalizeTicketComponent } from './panel-options.js';
import { DEFAULT_PREMIUM_MODULES, PREMIUM_ADDONS, PREMIUM_SALES_FEATURES, getPremiumCheckoutConfig } from './premium-billing.js';
import { isPremiumEntitled, normalizePremiumConfig, summarizePremiumConfig } from './premium.js';
import { addManualPendingItem, buildLaunchPatch, buildReleaseState } from './release-gates.js';
import { normalizeSecurityConfig, summarizeSecurityConfig } from './security.js';
import { isTurnstileConfigured, verifyTurnstileToken } from './turnstile.js';
import { buildTranscriptFileName, buildTranscriptText, verifyTranscriptAccessToken } from './transcripts.js';
import { normalizeWelcomeConfig } from './welcome.js';
import { normalizePartners, removeUnreferencedPartnerUploads, renderPartnersPage, savePartnerUpload } from './partners.js';
import { buildBlacklistWebEntry, getBlacklistWebRecord, normalizeBlacklistDiscordIdentity, normalizeBlacklistWebEvidenceList, normalizeBlacklistWebLookup, renderBlacklistPage, serializeBlacklistWebRecord, saveBlacklistProofUpload } from './blacklist-web.js';
import { checkXnProtectGlobalBan } from './xnprotect-blacklist.js';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const BOT_INVITE_PERMISSIONS = '1099780451478';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');
const docsAuthAttempts = new Map();
const adminAuthAttempts = new Map();
const ADMIN_CODE_REPLAY_GRACE_MS = 2 * 60 * 1000;
const XNPROTECT_PROOF_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net'
]);
const XNPROTECT_PROOF_CACHE_TTL_MS = 5 * 60 * 1000;
const XNPROTECT_PROOF_TIMEOUT_MS = 3_500;
const XNPROTECT_PROOF_MAX_BYTES = 10_000_000;
const xnProtectProofCache = new Map();

export function createServer({ config, storage, bot, discordClient = null, events }) {
  const app = express();
  const discordIdentityCache = new Map();
  const discordUsernameCache = new Map();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('tiny'));

  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  app.use(cookieParser(config.SESSION_SECRET));
  app.use('/assets', express.static(ASSETS_DIR, {
    immutable: true,
    maxAge: '7d'
  }));
  app.use('/uploads', express.static(UPLOADS_DIR, {
    immutable: true,
    maxAge: '30d'
  }));

  app.get('/uploads/:fileName', asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    const upload = settings.dashboardUploads?.[req.params.fileName];
    if (!upload?.dataUrl || !upload?.mimeType) {
      res.status(404).send('Not found');
      return;
    }
    const base64 = String(upload.dataUrl).split(',')[1];
    if (!base64) {
      res.status(404).send('Not found');
      return;
    }
    res.setHeader('cache-control', 'public, max-age=2592000, immutable');
    res.type(upload.mimeType).send(Buffer.from(base64, 'base64'));
  }));

  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(path.join(ASSETS_DIR, 'nexadesk-logo.svg'));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nexadesk' });
  });

  app.get('/health/ha', asyncHandler(async (_req, res) => {
    res.json(await buildHaHealthSnapshot({ storage, config }));
  }));

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /docs\nDisallow: /admin\nDisallow: /owner\nDisallow: /api\n');
  });

  app.get('/terms', (_req, res) => {
    res.type('html').send(renderLegalPage({
      type: 'terms',
      updatedAt: '1 de septiembre de 2026',
      title: 'Términos y condiciones',
      eyebrow: 'NexaDesk Legal',
      intro: 'Estas condiciones describen el uso actual de NexaDesk, las responsabilidades del servidor y los límites del servicio.',
      sections: buildTermsSections()
    }));
  });

  app.get('/privacy', (_req, res) => {
    res.type('html').send(renderLegalPage({
      type: 'privacy',
      updatedAt: '1 de septiembre de 2026',
      title: 'Política de privacidad',
      eyebrow: 'NexaDesk Privacy',
      intro: 'Esta política describe los datos que NexaDesk procesa para funcionar como bot de soporte, seguridad, voz, dashboard, IA y transcripciones.',
      sections: buildPrivacySections()
    }));
  });

  app.get('/blacklist', asyncHandler(async (req, res) => {
    const query = String(req.query.q ?? '').trim().slice(0, 200);
    const session = getSession(req);
    let record = null;
    let error = '';
    if (query) {
      try {
        const lookup = await resolveBlacklistLookup(query);
        const [localLookup, xnLookup] = await Promise.all([
          getBlacklistWebRecord({ storage, value: lookup.userId, identity: lookup.identity })
            .then((value) => ({ ok: true, value }))
            .catch((lookupError) => ({ ok: false, error: lookupError })),
          checkXnProtectGlobalBan(lookup.userId)
            .then((value) => ({ ok: true, value }))
            .catch((lookupError) => ({ ok: false, error: lookupError }))
        ]);

        if (xnLookup.ok && xnLookup.value?.checked && xnLookup.value.blacklisted) {
          record = await buildXnProtectBlacklistWebRecord({
            userId: lookup.userId,
            result: xnLookup.value,
            identity: lookup.identity
          });
        } else if (localLookup.ok) {
          record = localLookup.value;
        } else {
          throw localLookup.error || xnLookup.error || new Error('No se pudo consultar el registro.');
        }
      } catch (lookupError) {
        error = lookupError?.message ?? 'La búsqueda no es válida.';
      }
    }
    res.type('html').send(renderBlacklistPage({
      query,
      record,
      error,
      isOwner: session?.user?.id === GLOBAL_BLACKLIST_ADMIN_USER_ID
    }));
  }));

  async function buildXnProtectBlacklistWebRecord({ userId, result, identity = null }) {
    const banCode = buildGlobalBanCode(userId);
    const createdAt = normalizeXnProtectBlacklistDate(result?.since);
    const expiresAt = normalizeXnProtectBlacklistDate(result?.expires);
    const proof = await cacheXnProtectProof(result?.proof);
    const evidence = proof.url
      ? [{
          id: 'xnprotect-web-' + userId,
          userId,
          banCode,
          attachmentUrl: proof.url,
          description: 'Prueba proporcionada por XN Protect',
          createdBy: 'XN Protect Database',
          createdAt: createdAt || new Date().toISOString()
        }]
      : [];

    return serializeBlacklistWebRecord({
      entry: {
        userId,
        banCode,
        reason: String(result?.reason ?? '').trim() || 'XN Protect no devolvió un motivo.',
        duration: expiresAt ? 'Hasta la fecha indicada por XN Protect' : 'Permanente',
        expiresAt,
        active: true,
        createdBy: 'XN Protect Database',
        createdAt,
        updatedAt: createdAt
      },
      evidence,
      proofNote: proof.note,
      identity
    });
  }

  async function resolveBlacklistLookup(value) {
    const raw = normalizeDiscordUserId(value);
    const normalized = raw.toLowerCase();
    if (normalized.startsWith(GLOBAL_BAN_CODE_PREFIX) || /^\d{15,21}$/.test(raw)) {
      const userId = normalizeBlacklistWebLookup(raw).userId;
      const identity = await resolveDiscordIdentityById(userId);
      return { userId, identity };
    }

    const identity = await resolveDiscordIdentityByUsername(raw);
    if (!identity?.id || !/^\d{15,21}$/.test(identity.id)) {
      throw new Error('No pude localizar ese username. Prueba con el username exacto o con el ID de Discord.');
    }
    return { userId: identity.id, identity };
  }

  async function resolveDiscordIdentityById(userId) {
    const normalizedId = normalizeDiscordUserId(userId);
    const cachedResult = discordIdentityCache.get(normalizedId);
    if (cachedResult && Date.now() - cachedResult.checkedAt < 5 * 60 * 1000) return cachedResult.identity;

    const cached = findCachedDiscordIdentityById(normalizedId);
    if (cached) {
      discordIdentityCache.set(normalizedId, { checkedAt: Date.now(), identity: cached });
      return cached;
    }

    const fetched = await fetchDiscordUserWithBot(config, normalizedId).catch(() => null);
    const identity = normalizeBlacklistDiscordIdentity(fetched, normalizedId);
    discordIdentityCache.set(normalizedId, { checkedAt: Date.now(), identity });
    if (discordIdentityCache.size > 500) discordIdentityCache.delete(discordIdentityCache.keys().next().value);
    return identity;
  }

  async function resolveDiscordIdentityByUsername(value) {
    const query = normalizeDiscordSearchValue(value);
    if (!query) return null;
    const cachedUsername = discordUsernameCache.get(query);
    if (cachedUsername && Date.now() - cachedUsername.checkedAt < 5 * 60 * 1000) return cachedUsername.identity;

    const remember = (identity) => {
      discordUsernameCache.set(query, { checkedAt: Date.now(), identity });
      if (discordUsernameCache.size > 300) discordUsernameCache.delete(discordUsernameCache.keys().next().value);
      return identity;
    };
    const cached = findCachedDiscordIdentities(query);
    if (cached.length === 1) return remember(cached[0]);
    if (cached.length > 1) {
      throw new Error('Hay varias personas con ese nombre. Usa el username exacto o el ID de Discord.');
    }

    const blacklistEntries = await storage.listBlacklistEntries().catch(() => []);
    const blacklistIdentities = uniqueDiscordIdentities(await Promise.all(
      blacklistEntries
        .slice(0, 100)
        .map((entry) => resolveDiscordIdentityById(entry?.userId))
    ));
    const blacklistMatches = blacklistIdentities.filter((identity) => matchesDiscordIdentity(identity, query));
    if (blacklistMatches.length === 1) return remember(blacklistMatches[0]);
    if (blacklistMatches.length > 1) {
      const exact = blacklistMatches.filter((identity) => isExactDiscordUsernameMatch(identity, query));
      if (exact.length === 1) return exact[0];
      throw new Error('Hay varias personas con ese nombre. Usa el username exacto o el ID de Discord.');
    }

    const configs = await storage.listGuildConfigs().catch(() => []);
    const guildIds = await getInstalledGuildIds(bot, configs);
    const discovered = await searchDiscordGuildMembers({ query, guildIds });
    const unique = uniqueDiscordIdentities(discovered);
    if (unique.length === 1) return remember(unique[0]);
    if (unique.length > 1) {
      const exact = unique.filter((identity) => isExactDiscordUsernameMatch(identity, query));
      if (exact.length === 1) return exact[0];
      throw new Error('Hay varias personas con ese nombre. Usa el username exacto o el ID de Discord.');
    }

    // Discord no ofrece una búsqueda global de usuarios por username. El bot solo puede
    // resolver nombres que conoce por caché, por una guild conectada o por un registro previo.
    return remember(null);
  }

  function findCachedDiscordIdentityById(userId) {
    const target = normalizeDiscordUserId(userId);
    const users = collectCachedDiscordUsers();
    const user = users.find((candidate) => normalizeDiscordUserId(candidate?.id) === target);
    return user ? normalizeBlacklistDiscordIdentity(user, target) : null;
  }

  function findCachedDiscordIdentities(query) {
    const normalizedQuery = normalizeDiscordSearchValue(query);
    const matches = collectCachedDiscordUsers()
      .filter((user) => matchesDiscordIdentity(user, normalizedQuery))
      .map((user) => normalizeBlacklistDiscordIdentity(user, user?.id));
    return uniqueDiscordIdentities(matches);
  }

  function collectCachedDiscordUsers() {
    const users = new Map();
    const add = (user) => {
      const id = normalizeDiscordUserId(user?.id);
      if (id && user && typeof user === 'object') users.set(id, user);
    };

    for (const user of discordClient?.users?.cache?.values?.() ?? []) add(user);
    for (const guild of discordClient?.guilds?.cache?.values?.() ?? []) {
      for (const member of guild?.members?.cache?.values?.() ?? []) add(member?.user ?? member);
    }
    return [...users.values()];
  }

  async function searchDiscordGuildMembers({ query, guildIds }) {
    const ids = [...guildIds].filter((id) => /^\d{15,21}$/.test(String(id))).slice(0, 40);
    if (!ids.length || !config.DISCORD_TOKEN) return [];
    const results = await Promise.all(ids.map((guildId) => fetchDiscordGuildMemberSearch(config, guildId, query)));
    return results.flat();
  }

  function uniqueDiscordIdentities(identities) {
    const unique = new Map();
    for (const identity of identities) {
      const id = normalizeDiscordUserId(identity?.id);
      if (id && !unique.has(id)) unique.set(id, identity);
    }
    return [...unique.values()];
  }

  function isExactDiscordUsernameMatch(identity, query) {
    const normalized = normalizeDiscordSearchValue(query);
    return normalizeDiscordSearchValue(identity?.username) === normalized;
  }

  function matchesDiscordIdentity(user, query) {
    const normalized = normalizeDiscordSearchValue(query);
    const username = normalizeDiscordSearchValue(user?.username);
    const globalName = normalizeDiscordSearchValue(user?.global_name ?? user?.globalName);
    const displayName = normalizeDiscordSearchValue(user?.display_name ?? user?.displayName ?? user?.nick);
    const legacyTag = user?.discriminator && user.discriminator !== '0'
      ? normalizeDiscordSearchValue(String(user.username ?? '') + '#' + user.discriminator)
      : '';
    const tag = normalizeDiscordSearchValue(user?.tag);
    return [username, globalName, displayName, legacyTag, tag].some((value) => value && value === normalized);
  }

  function normalizeDiscordSearchValue(value) {
    return normalizeDiscordUserId(value).replace(/^@+/, '').toLowerCase();
  }

  async function fetchDiscordGuildMemberSearch(runtimeConfig, guildId, query) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    try {
      const url = new URL(DISCORD_API + '/guilds/' + encodeURIComponent(guildId) + '/members/search');
      url.searchParams.set('query', String(query).slice(0, 100));
      url.searchParams.set('limit', '25');
      const response = await fetch(url, {
        headers: {
          authorization: 'Bot ' + runtimeConfig.DISCORD_TOKEN,
          accept: 'application/json'
        },
        signal: controller.signal
      });
      if (!response.ok) return [];
      const members = await response.json();
      return (Array.isArray(members) ? members : [])
        .map((member) => ({ ...(member?.user ?? {}), nick: member?.nick }))
        .filter((user) => matchesDiscordIdentity(user, normalizeDiscordSearchValue(query)))
        .map((user) => normalizeBlacklistDiscordIdentity(user, user.id));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cacheXnProtectProof(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return { url: '', note: '' };

    let source;
    try {
      source = new URL(raw);
    } catch {
      return { url: '', note: 'XN Protect indicó una prueba, pero la URL no es válida.' };
    }
    if (source.protocol !== 'https:' || !XNPROTECT_PROOF_HOSTS.has(source.hostname.toLowerCase())) {
      return { url: '', note: 'XN Protect indicó una prueba, pero su origen no está disponible para visualización segura.' };
    }

    const cacheKey = source.origin + source.pathname;
    const cached = xnProtectProofCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < XNPROTECT_PROOF_CACHE_TTL_MS) return cached.value;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), XNPROTECT_PROOF_TIMEOUT_MS);
    let valueToCache;
    try {
      const response = await fetch(source.toString(), {
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('origin HTTP ' + response.status);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > XNPROTECT_PROOF_MAX_BYTES) throw new Error('proof too large');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > XNPROTECT_PROOF_MAX_BYTES) throw new Error('invalid proof size');
      const mimeType = inferXnProtectProofMimeType(response.headers.get('content-type'), source.pathname);
      if (!mimeType) throw new Error('unsupported proof type');
      const upload = await saveBlacklistProofUpload({
        buffer,
        mimeType,
        fileName: path.basename(source.pathname)
      });
      valueToCache = { url: upload.url, note: '' };
    } catch (error) {
      console.warn('Could not cache XN Protect proof ' + cacheKey + ': ' + (error?.message ?? error));
      valueToCache = { url: '', note: 'XN Protect indicó una prueba, pero la imagen ya no está disponible en su origen.' };
    } finally {
      clearTimeout(timeout);
    }

    xnProtectProofCache.set(cacheKey, { checkedAt: Date.now(), value: valueToCache });
    if (xnProtectProofCache.size > 256) xnProtectProofCache.delete(xnProtectProofCache.keys().next().value);
    return valueToCache;
  }

  function inferXnProtectProofMimeType(contentType, pathname) {
    const header = String(contentType ?? '').toLowerCase().split(';')[0].trim();
    if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(header)) return header;
    const extension = path.extname(pathname).toLowerCase();
    return ({
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    })[extension] || '';
  }

  function normalizeXnProtectBlacklistDate(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    const date = new Date(String(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  app.get('/partners', asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    const session = getSession(req);
    res.type('html').send(renderPartnersPage({
      partners: settings.partners,
      isOwner: isPartnerEditorUser(session?.user?.id, config),
      session,
      dashboardUrl: config.DASHBOARD_PUBLIC_URL
    }));
  }));

  app.get('/exam/:channelId', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId).catch(() => null);
    const guildConfig = ticket?.guildId ? await storage.getGuildConfig(ticket.guildId).catch(() => null) : null;
    const state = normalizeExamState(ticket?.examState);
    const token = String(req.query.token ?? '');
    res.type('html').send(renderExamPage({
      ticket,
      guildConfig,
      state,
      token,
      error: validateWebExamAccess({ ticket, guildConfig, state, token })
    }));
  }));

  app.post('/exam/:channelId', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId).catch(() => null);
    const guildConfig = ticket?.guildId ? await storage.getGuildConfig(ticket.guildId).catch(() => null) : null;
    const state = normalizeExamState(ticket?.examState);
    const token = String(req.query.token ?? req.body.token ?? '');
    const error = validateWebExamAccess({ ticket, guildConfig, state, token });
    if (error) {
      res.status(error.status).type('html').send(renderExamPage({ ticket, guildConfig, state, token, error }));
      return;
    }

    if (state.status === 'completed') {
      res.type('html').send(renderExamPage({ ticket, guildConfig, state, token, submitted: true }));
      return;
    }

    const now = new Date().toISOString();
    const answers = state.questions.map((question, index) => buildExamAnswerRecord({
      question,
      answer: String(req.body[`answer_${index}`] ?? '').trim(),
      askedAt: state.startedAt
    }));
    const completedState = normalizeExamState({
      ...state,
      answers,
      warnings: [...state.warnings, ...answers.flatMap((answer) => answer.flags ?? [])].slice(0, 20),
      currentIndex: state.questions.length,
      status: 'completed',
      completedAt: now
    });
    const evaluation = buildHeuristicExamEvaluation(completedState, {
      passScore: completedState.passScore,
      examState: completedState
    });
    const finalState = normalizeExamState({
      ...completedState,
      evaluation
    });

    const resultText = formatExamEvaluation(evaluation, finalState);
    await storage.updateTicket(ticket.channelId, {
      status: evaluation.manualReviewRecommended ? 'exam_review_recommended' : 'exam_completed',
      examState: finalState
    });
    await storage.addTranscriptMessage({
      guildId: ticket.guildId,
      channelId: ticket.channelId,
      messageId: `web-exam-${Date.now()}`,
      authorId: ticket.openedBy || 'web-exam',
      authorName: 'Examen web NexaDesk',
      authorBot: false,
      role: 'user',
      content: [
        'Examen completado desde formulario web Premium.',
        resultText
      ].join('\n'),
      createdAt: now
    }).catch((logError) => console.warn(`Could not persist web exam transcript for ${ticket.channelId}:`, logError?.message ?? logError));

    await bot?.sendChannelMessage?.({
      channelId: ticket.channelId,
      payload: {
        content: [
          'NexaDesk: Examen web completado.',
          resultText
        ].join('\n').slice(0, 1900),
        allowedMentions: { parse: [] }
      }
    }).catch((sendError) => console.warn(`Could not send web exam result to ticket ${ticket.channelId}:`, sendError?.message ?? sendError));

    res.type('html').send(renderExamPage({ ticket, guildConfig, state: finalState, token, submitted: true }));
  }));

  app.get('/status', asyncHandler(async (req, res) => {
    const snapshot = await buildStatusSnapshot({ storage, bot });
    res.type('html').send(renderStatusPage({
      snapshot,
      canEdit: canEditStatusPage(req),
      editorName: getStatusEditorName(req)
    }));
  }));

  app.get('/status/api', asyncHandler(async (_req, res) => {
    res.json(await buildStatusSnapshot({ storage, bot }));
  }));

  app.post('/status/api', requireStatusEditor, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings();
    const current = normalizeStatusPage(settings.statusPage);
    const next = normalizeStatusPage({
      ...current,
      state: req.body.state,
      headline: req.body.headline,
      message: req.body.message,
      components: req.body.components,
      updatedBy: req.statusEditor?.username ?? req.statusEditor?.id ?? 'owner',
      updatedAt: new Date().toISOString()
    });
    const saved = await storage.updateGlobalSettings({ statusPage: next });
    res.json({ status: normalizeStatusPage(saved.statusPage) });
  }));

  app.post('/status/api/messages', requireStatusEditor, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings();
    const current = normalizeStatusPage(settings.statusPage);
    const update = normalizeStatusUpdate({
      id: `status-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      level: req.body.level,
      title: req.body.title,
      message: req.body.message,
      createdBy: req.statusEditor?.username ?? req.statusEditor?.id ?? 'owner',
      createdAt: new Date().toISOString()
    });
    if (!update.message) {
      res.status(400).json({ error: 'Message is required.' });
      return;
    }
    const next = normalizeStatusPage({
      ...current,
      updates: [update, ...current.updates].slice(0, 20),
      updatedBy: update.createdBy,
      updatedAt: update.createdAt
    });
    const saved = await storage.updateGlobalSettings({ statusPage: next });
    res.json({ status: normalizeStatusPage(saved.statusPage) });
  }));

  app.get('/status/events', asyncHandler(async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });

    const sendSnapshot = async (eventName = 'status.snapshot') => {
      const snapshot = await buildStatusSnapshot({ storage, bot }).catch((error) => ({
        status: normalizeStatusPage(),
        generatedAt: new Date().toISOString(),
        error: normalizeError(error)
      }));
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };

    await sendSnapshot('status.ready');
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    }, 25000);

    const send = (event) => {
      if (event.type !== 'global.settings.updated' && event.type !== 'maintenance.updated') return;
      void sendSnapshot('status.update');
    };

    events?.on?.('event', send);
    req.on('close', () => {
      clearInterval(heartbeat);
      events?.off?.('event', send);
    });
  }));

  app.get('/login', (req, res) => {
    if (getSession(req)) {
      res.redirect('/');
      return;
    }
    res.type('html').send(renderLogin(config));
  });

  app.post('/auth/discord', asyncHandler(async (req, res) => {
    if (!config.DISCORD_CLIENT_SECRET) {
      res.status(500).type('html').send(renderLogin(config, {
        error: 'DISCORD_CLIENT_SECRET is not configured.'
      }));
      return;
    }

    if (config.TURNSTILE_ENABLED) {
      const verification = await verifyTurnstileToken({
        config,
        token: req.body['cf-turnstile-response'],
        remoteIp: getRequestIp(req)
      });

      if (!verification.ok) {
        console.warn(`Turnstile login verification failed: ${verification.reason}`);
        res.status(403).type('html').send(renderLogin(config, {
          error: turnstileErrorMessage(verification.reason)
        }));
        return;
      }
    }

    const state = crypto.randomBytes(18).toString('hex');
    res.cookie('nexadesk_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      signed: true,
      maxAge: 1000 * 60 * 10
    });

    const url = new URL(`${DISCORD_API}/oauth2/authorize`);
    url.searchParams.set('client_id', config.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', getRedirectUri(config));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }));

  app.get('/auth/discord', (_req, res) => {
    res.redirect('/login');
  });

  app.get('/auth/discord/complete', (req, res) => {
    const session = getSession(req);
    if (!session) {
      res.redirect('/login');
      return;
    }

    res.type('html').send(renderDiscordAuthComplete(session));
  });

  app.get('/auth/discord/callback', asyncHandler(async (req, res) => {
    try {
      if (!config.DISCORD_CLIENT_SECRET) {
        res.status(500).send('DISCORD_CLIENT_SECRET is not configured.');
        return;
      }

      if (!req.query.code || req.query.state !== req.signedCookies.nexadesk_oauth_state) {
        res.status(400).send('Invalid Discord OAuth state.');
        return;
      }

      const token = await exchangeDiscordCode(config, req.query.code);
      const [user, guilds] = await Promise.all([
        discordFetch('/users/@me', token.access_token),
        discordFetch('/users/@me/guilds', token.access_token)
      ]);

      const manageableGuilds = guilds
        .filter((guild) => canManageGuild(guild))
        .map((guild) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          owner: guild.owner
        }));

      res.clearCookie('nexadesk_oauth_state');
      res.cookie('nexadesk_session', signSession(config, {
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar
        },
        guilds: manageableGuilds
      }), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        maxAge: 1000 * 60 * 60 * 12
      });
      res.redirect('/auth/discord/complete');
    } catch (error) {
      console.error('Discord OAuth failed:', error);
      res.status(500).send('Discord login failed.');
    }
  }));

  app.post('/logout', (_req, res) => {
    res.clearCookie('nexadesk_session');
    res.redirect('/login');
  });

  app.get('/docs/logout', (req, res) => {
    setDocsSecurityHeaders(res);
    res.clearCookie('nexadesk_docs');
    res.redirect('/docs');
  });

  app.get('/docs', (req, res) => {
    setDocsSecurityHeaders(res);
    if (!normalizeTotpSecret(config.DOCS_TOTP_SECRET)) {
      res.status(503).type('html').send(renderDocsDisabled(config));
      return;
    }

    const docsSession = getDocsSession(req);
    if (!docsSession) {
      res.type('html').send(renderDocsGate({ config }));
      return;
    }

    res.type('html').send(renderDocsVault({ config, session: docsSession }));
  });

  app.post('/docs', (req, res) => {
    setDocsSecurityHeaders(res);
    const ip = getRequestIp(req);
    if (isDocsRateLimited(ip)) {
      res.status(429).type('html').send(renderDocsGate({
        config,
        error: 'Demasiados intentos. Espera un minuto antes de probar otro codigo.'
      }));
      return;
    }

    const secret = normalizeTotpSecret(config.DOCS_TOTP_SECRET);
    if (!secret) {
      res.status(503).type('html').send(renderDocsDisabled(config));
      return;
    }

    if (!verifyTotpCode({ code: req.body.code, secret })) {
      recordDocsFailure(ip);
      res.status(401).type('html').send(renderDocsGate({
        config,
        error: 'Codigo dinamico incorrecto o caducado.'
      }));
      return;
    }

    clearDocsFailures(ip);
    const now = Date.now();
    const maxAge = config.DOCS_SESSION_MINUTES * 60 * 1000;
    res.cookie('nexadesk_docs', signSession(config, {
      scope: 'docs',
      nonce: crypto.randomBytes(12).toString('hex'),
      iat: now,
      exp: now + maxAge
    }), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      signed: true,
      maxAge
    });
    res.redirect('/docs');
  });

  app.get('/admin/logout', (_req, res) => {
    setDocsSecurityHeaders(res);
    res.clearCookie('nexadesk_admin');
    res.redirect('/admin');
  });

  app.post('/internal/admin/code', asyncHandler(async (req, res) => {
    if (!isAuthorizedAdminCodeIssuerRequest(req, config)) {
      res.status(401).json({ error: 'Unauthorized admin code issuer.' });
      return;
    }

    const createdBy = String(req.body.createdBy ?? '').trim();
    if (!createdBy) {
      res.status(400).json({ error: 'createdBy is required.' });
      return;
    }

    const settings = await storage.getGlobalSettings();
    const currentRecord = settings?.adminAccessCode;
    const reusable = canReuseAdminAccessCode({ record: currentRecord, config, createdBy });
    const code = reusable
      ? getAdminAccessCodeValue({ record: currentRecord, config })
      : generateAdminCode();
    const record = reusable
      ? currentRecord
      : buildAdminAccessCode({
        code,
        config,
        createdBy,
        createdByTag: String(req.body.createdByTag ?? '').trim().slice(0, 120),
        guildId: String(req.body.guildId ?? '').trim().slice(0, 40),
        issuer: 'dashboard'
      });

    if (!reusable) {
      await storage.updateGlobalSettings({ adminAccessCode: record });
    }

    const status = getAdminAccessCodeStatus(record);
    res.json({
      ok: true,
      code,
      reused: reusable,
      expiresAt: record.expiresAt,
      secondsRemaining: status.secondsRemaining ?? null,
      adminUrl: new URL('/admin', config.DASHBOARD_PUBLIC_URL).toString(),
      issuer: record.issuer ?? 'dashboard'
    });
  }));

  app.get('/admin', asyncHandler(async (req, res) => {
    setDocsSecurityHeaders(res);
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      const settings = await storage.getGlobalSettings().catch(() => ({}));
      res.type('html').send(renderAdminGate({
        config,
        codeStatus: getAdminAccessCodeStatus(settings?.adminAccessCode)
      }));
      return;
    }

    res.type('html').send(renderAdminPanel({
      config,
      session: adminSession,
      snapshot: await buildAdminSnapshot({ storage, bot })
    }));
  }));

  app.post('/admin', asyncHandler(async (req, res) => {
    setDocsSecurityHeaders(res);
    const ip = getRequestIp(req);
    if (isAdminRateLimited(ip)) {
      res.status(429).type('html').send(renderAdminGate({
        config,
        error: 'Demasiados intentos. Espera un minuto antes de probar otro codigo.'
      }));
      return;
    }

    const settings = await storage.getGlobalSettings();
    const record = settings?.adminAccessCode;
    const verification = inspectAdminAccessCode({ record, code: req.body.code, config });
    const replayVerification = !verification.ok && verification.reason === 'used' && isRecentAdminCodeUse(record, ip)
      ? inspectAdminAccessCode({ record, code: req.body.code, config, allowUsed: true })
      : null;
    const finalVerification = replayVerification?.ok ? replayVerification : verification;
    if (!finalVerification.ok) {
      if (finalVerification.reason === 'wrong' || finalVerification.reason === 'malformed') {
        recordAdminFailure(ip);
      }
      res.status(401).type('html').send(renderAdminGate({
        config,
        codeStatus: getAdminAccessCodeStatus(record),
        error: adminCodeErrorMessage(finalVerification.reason)
      }));
      return;
    }

    clearAdminFailures(ip);
    const now = Date.now();
    const maxAge = config.DOCS_SESSION_MINUTES * 60 * 1000;
    await storage.updateGlobalSettings({
      adminAccessCode: {
        ...record,
        usedAt: record.usedAt || new Date(now).toISOString(),
        usedByIp: record.usedByIp || ip,
        lastAcceptedAt: new Date(now).toISOString(),
        lastAcceptedByIp: ip
      }
    });
    res.cookie('nexadesk_admin', signSession(config, {
      scope: 'admin',
      authMethod: 'discord-rotating-code',
      issuedBy: record.createdBy,
      nonce: crypto.randomBytes(12).toString('hex'),
      iat: now,
      exp: now + maxAge
    }), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      signed: true,
      maxAge
    });
    res.redirect('/admin');
  }));

  app.get('/admin/api/snapshot', requireAdminSession, asyncHandler(async (_req, res) => {
    res.json(await buildAdminSnapshot({ storage, bot }));
  }));

  app.post('/admin/api/maintenance', requireAdminSession, asyncHandler(async (req, res) => {
    const enabled = Boolean(req.body.enabled);
    const delaySeconds = Number(req.body.delaySeconds);
    const patch = enabled
      ? {
          enabled: true,
          message: String(req.body.message ?? '').trim().slice(0, 500),
          delayMs: Number.isFinite(delaySeconds) ? Math.round(delaySeconds * 1000) : undefined,
          enabledBy: 'admin-vault',
          enabledAt: new Date().toISOString(),
          disabledBy: null,
          disabledAt: null
        }
      : {
          enabled: false,
          disabledBy: 'admin-vault',
          disabledAt: new Date().toISOString()
        };
    res.json({ maintenance: await storage.setMaintenanceState(patch) });
  }));

  app.post('/admin/api/dashboard-maintenance', requireAdminSession, asyncHandler(async (req, res) => {
    const enabled = Boolean(req.body.enabled);
    const currentSettings = await storage.getGlobalSettings().catch(() => ({}));
    const dashboardMaintenance = normalizeDashboardMaintenanceState({
      ...currentSettings.dashboardMaintenance,
      enabled,
      message: String(req.body.message ?? '').trim().slice(0, 500),
      enabledBy: enabled ? 'admin-vault' : currentSettings.dashboardMaintenance?.enabledBy,
      enabledAt: enabled ? new Date().toISOString() : currentSettings.dashboardMaintenance?.enabledAt,
      disabledBy: enabled ? null : 'admin-vault',
      disabledAt: enabled ? null : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const saved = await storage.updateGlobalSettings({ dashboardMaintenance });
    res.json({ dashboardMaintenance: normalizeDashboardMaintenanceState(saved.dashboardMaintenance) });
  }));

  app.get('/admin/events', requireAdminSession, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const send = (event) => {
      res.write(`event: admin.event\ndata: ${JSON.stringify(event)}\n\n`);
    };

    events?.on?.('event', send);
    req.on('close', () => {
      events?.off?.('event', send);
    });
  });

  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }

    const session = getSession(req);
    if (!session) {
      if ((isTranscriptReplayRequest(req) || isTranscriptDownloadRequest(req)) && req.query.viewer && req.query.token) {
        next();
        return;
      }
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      res.redirect('/login');
      return;
    }

    req.session = session;
    next();
  });

  app.get('/owner', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    res.type('html').send(renderOwnerReleasePanel({
      session: req.session,
      releaseState: buildReleaseState(settings.releaseControl, { isOwner: true })
    }));
  }));

  app.post('/partners/api/upload', requirePartnerEditor(config), express.raw({
    type: ['image/*', 'video/*'],
    limit: '50mb'
  }), asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'No se recibió ningún fichero multimedia.' });
      return;
    }
    const upload = await savePartnerUpload({
      buffer: req.body,
      mimeType: req.get('content-type'),
      fileName: req.get('x-file-name'),
      durationSeconds: req.get('x-media-duration')
    });
    res.json(upload);
  }));

  app.post('/blacklist/api/upload', requireGlobalAdmin, express.raw({
    type: ['image/*'],
    limit: '10mb'
  }), asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'No se recibió ninguna imagen.' });
      return;
    }
    const upload = await saveBlacklistProofUpload({
      buffer: req.body,
      mimeType: req.get('content-type'),
      fileName: req.get('x-file-name')
    });
    res.json(upload);
  }));

  app.put('/blacklist/api', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const lookup = normalizeBlacklistWebLookup(req.body?.userId);
    const existing = await storage.getBlacklistEntry(lookup.userId);
    const entry = buildBlacklistWebEntry(
      { ...(req.body ?? {}), userId: lookup.userId },
      existing,
      req.session.user.username || req.session.user.id
    );
    const savedEntry = await storage.upsertBlacklistEntry(entry);
    let savedEvidence;
    if (Array.isArray(req.body?.evidence)) {
      const evidence = normalizeBlacklistWebEvidenceList(req.body.evidence, {
        userId: savedEntry.userId,
        banCode: savedEntry.banCode,
        createdBy: savedEntry.createdBy || req.session.user.username || req.session.user.id
      });
      savedEvidence = await storage.replaceBlacklistEvidence(savedEntry.userId, evidence);
    } else {
      savedEvidence = await storage.listBlacklistEvidence(savedEntry.userId);
    }
    events?.publish?.('blacklist.web.updated', {
      userId: savedEntry.userId,
      updatedBy: req.session.user.username || req.session.user.id
    });
    res.json({ record: serializeBlacklistWebRecord({ entry: savedEntry, evidence: savedEvidence }) });
  }));

  app.post('/partners/api', requirePartnerEditor(config), asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.partners)) {
      res.status(400).json({ error: 'La lista de partners no es válida.' });
      return;
    }
    if (req.body.partners.length > 24) {
      res.status(400).json({ error: 'No puedes publicar más de 24 partners.' });
      return;
    }
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    const previous = normalizePartners(settings.partners);
    const partners = normalizePartners(req.body.partners);
    const saved = await storage.updateGlobalSettings({ partners });
    await removeUnreferencedPartnerUploads(previous, partners);
    events?.publish?.('partners.updated', { partners, updatedBy: req.session.user.username || req.session.user.id });
    res.json({ partners: normalizePartners(saved.partners) });
  }));

  app.get('/owner/api/release', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    res.json({ release: buildReleaseState(settings.releaseControl, { isOwner: true }) });
  }));

  app.post('/owner/api/release/pending', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    const releaseControl = addManualPendingItem(settings.releaseControl, {
      title: req.body.title,
      description: req.body.description,
      type: req.body.type
    }, { createdBy: req.session.user.username || req.session.user.id });
    const saved = await storage.updateGlobalSettings({ releaseControl });
    events?.publish?.('release.pending.created', buildReleaseState(saved.releaseControl, { isOwner: true }));
    res.json({ release: buildReleaseState(saved.releaseControl, { isOwner: true }) });
  }));

  app.post('/owner/api/release/launch', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const settings = await storage.getGlobalSettings().catch(() => ({}));
    const releaseControl = buildLaunchPatch(settings.releaseControl, {
      launchedBy: req.session.user.username || req.session.user.id
    });
    const saved = await storage.updateGlobalSettings({ releaseControl });
    const state = buildReleaseState(saved.releaseControl, { isOwner: true });
    events?.publish?.('release.launched', state);
    res.json({ release: state });
  }));

  app.get('/invite/:guildId', requireGuildAccess, (req, res) => {
    res.redirect(buildBotInviteUrl(config, req.params.guildId));
  });

  app.get('/premium/paypal/success', asyncHandler(async (req, res) => {
    const orderId = String(req.query.token ?? '').trim();
    if (orderId) {
      await capturePremiumPayPalOrder({
        orderId,
        storage,
        config,
        session: req.session
      });
    }
    res.redirect('/#premium');
  }));

  app.get('/premium/paypal/cancel', (_req, res) => {
    res.redirect('/#premium');
  });

  app.get('/api/me', (req, res) => {
    res.json(req.session);
  });

  app.get('/api/me/dashboard-state', asyncHandler(async (req, res) => {
    res.json(await getDashboardUserState(storage, req.session.user.id));
  }));

  app.patch('/api/me/dashboard-state', asyncHandler(async (req, res) => {
    res.json(await updateDashboardUserState(storage, req.session.user.id, {
      tourCompleted: req.body.tourCompleted,
      tourVersion: req.body.tourVersion
    }));
  }));

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const send = (event) => {
      if (event.payload?.guildId && !canAccessGuild(req.session, event.payload.guildId)) return;
      if (event.payload?.discordUserId
        && event.payload.discordUserId !== req.session.user.id
        && req.session.user.id !== GLOBAL_BLACKLIST_ADMIN_USER_ID) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    events.on('event', send);
    req.on('close', () => {
      events.off('event', send);
    });
  });

  app.get('/api/guilds', asyncHandler(async (req, res) => {
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    res.json(mergeUserGuilds(req.session, configs, installedGuildIds, config));
  }));

  app.get('/api/tickets', asyncHandler(async (req, res) => {
    const tickets = await storage.listTickets();
    res.json(tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)));
  }));

  app.get('/api/stats', asyncHandler(async (req, res) => {
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    const stats = await storage.getDashboardStats(req.session.guilds.map((guild) => guild.id));
    res.json(enrichDashboardStats(stats, guilds));
  }));

  app.get('/api/backups', asyncHandler(async (req, res) => {
    const manageableGuildIds = req.session.guilds.map((guild) => guild.id);
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    const [backups, restores] = await Promise.all([
      storage.listGuildBackupSnapshots?.(manageableGuildIds, { limit: 120 }) ?? [],
      storage.listGuildBackupRestores?.(manageableGuildIds, { limit: 80 }) ?? []
    ]);
    res.json({
      guilds,
      backups: backups.map(serializeBackupListItem),
      restores: restores.map(serializeBackupRestoreListItem)
    });
  }));

  app.post('/api/backups/capture', asyncHandler(async (req, res) => {
    const guildId = String(req.body.guildId ?? '').trim();
    if (!canAccessGuild(req.session, guildId)) {
      res.status(403).json({ error: 'No puedes crear backups de este servidor.' });
      return;
    }
    const saved = await bot.captureGuildBackup({
      guildId,
      source: `dashboard:${req.session.user.id}`
    });
    await recordDashboardGuildLog(storage, req, {
      guildId,
      guildName: saved.guildName,
      type: 'security',
      severity: 'success',
      title: 'Backup manual creado',
      message: `Snapshot creado desde /backups con ${saved.summary.roles} roles y ${saved.summary.channels} canales.`,
      metadata: { backupId: saved.id, summary: saved.summary }
    });
    res.json({ backup: serializeBackupListItem(saved) });
  }));

  app.post('/api/backups/restore', asyncHandler(async (req, res) => {
    const backupId = String(req.body.backupId ?? '').trim();
    const targetGuildId = String(req.body.targetGuildId ?? '').trim();
    const backup = await storage.getGuildBackupSnapshot?.(backupId);
    if (!backup) {
      res.status(404).json({ error: 'No encuentro ese backup.' });
      return;
    }
    if (!canAccessGuild(req.session, backup.guildId) || !canAccessGuild(req.session, targetGuildId)) {
      res.status(403).json({ error: 'Necesitas permisos en el servidor origen y destino.' });
      return;
    }
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    if (!installedGuildIds.has(targetGuildId)) {
      res.status(409).json({ error: 'NexaDesk no esta instalado en el servidor destino. Invitalo primero con permisos de administrador.' });
      return;
    }
    const restore = await bot.restoreGuildBackup({
      backupId,
      targetGuildId,
      requestedBy: req.session.user.id
    });
    res.json({ restore: serializeBackupRestoreListItem(restore) });
  }));

  app.get('/api/premium/account', asyncHandler(async (req, res) => {
    const account = await storage.getPremiumBillingAccount(req.session.user.id);
    res.json(buildPremiumAccountResponse({ account, config }));
  }));

  app.post('/api/premium/checkout', asyncHandler(async (req, res) => {
    const checkoutConfig = getPremiumCheckoutConfig(config);
    if (!checkoutConfig.configured) {
      res.status(503).json({ error: 'PayPal no esta configurado todavia. Anade PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET o PREMIUM_PAYMENT_URL en el .env de la Raspberry Pi.' });
      return;
    }

    if (!checkoutConfig.apiConfigured) {
      const pendingPurchase = await recordManualPremiumIntent({ storage, session: req.session, checkoutConfig }).catch((error) => {
        console.warn('Could not record manual premium intent:', normalizeError(error));
        return null;
      });
      res.json({
        url: checkoutConfig.manualPaymentUrl,
        manual: true,
        pendingPurchaseId: pendingPurchase?.id ?? null,
        message: 'Pago manual abierto. Tras pagar, abre ticket de soporte para validar el pago y activar tus slots.'
      });
      return;
    }

    const order = await createPremiumPayPalOrder({
      config,
      session: req.session,
      checkoutConfig
    }).catch(async (error) => {
      if (checkoutConfig.manualPaymentUrl) {
        console.warn('PayPal checkout failed; falling back to manual payment URL:', normalizeError(error));
        const pendingPurchase = await recordManualPremiumIntent({ storage, session: req.session, checkoutConfig, error }).catch(() => null);
        return { manualFallback: true, url: checkoutConfig.manualPaymentUrl, pendingPurchaseId: pendingPurchase?.id ?? null };
      }
      throw error;
    });
    if (order.manualFallback) {
      res.json({
        url: order.url,
        manual: true,
        pendingPurchaseId: order.pendingPurchaseId,
        message: 'PayPal Checkout fallo, pero puedes pagar con el enlace manual y validarlo por soporte.'
      });
      return;
    }
    const approveUrl = getPayPalApprovalUrl(order);
    if (!approveUrl) {
      console.warn('PayPal order without approval link:', JSON.stringify({
        id: order.id,
        status: order.status,
        links: order.links?.map((link) => ({ rel: link.rel, href: link.href }))
      }));
      if (checkoutConfig.manualPaymentUrl) {
        const pendingPurchase = await recordManualPremiumIntent({ storage, session: req.session, checkoutConfig }).catch(() => null);
        res.json({
          url: checkoutConfig.manualPaymentUrl,
          manual: true,
          pendingPurchaseId: pendingPurchase?.id ?? null,
          message: 'PayPal no devolvio enlace de aprobacion; abro el pago manual de respaldo.'
        });
        return;
      }
      res.status(502).json({ error: 'PayPal no devolvio enlace de aprobacion compatible.' });
      return;
    }

    res.json({ url: approveUrl, orderId: order.id });
  }));

  app.post('/api/premium/activate', asyncHandler(async (req, res) => {
    const guildId = String(req.body.guildId ?? '').trim();
    if (!canAccessGuild(req.session, guildId)) {
      res.status(403).json({ error: 'No puedes activar premium en este servidor.' });
      return;
    }

    const guild = req.session.guilds.find((item) => item.id === guildId);
    const result = await storage.activatePremiumSlot({
      discordUserId: req.session.user.id,
      guildId,
      guildName: guild?.name ?? req.body.guildName,
      activatedBy: req.session.user.id
    });
    await recordDashboardGuildLog(storage, req, {
      guildId,
      guildName: guild?.name ?? req.body.guildName,
      type: 'premium',
      severity: result.alreadyActive ? 'info' : 'success',
      title: result.alreadyActive ? 'Premium ya estaba activo' : 'Premium activado desde dashboard',
      message: result.alreadyActive
        ? 'El usuario intento activar Premium, pero el servidor ya tenia un slot activo.'
        : 'Se consumio un slot Premium y se activo el servidor desde la dashboard.',
      metadata: { discordUserId: req.session.user.id, activation: result.activation ?? null }
    });
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    res.json({
      ...result,
      account: buildPremiumAccountResponse({ account: result.account, config }),
      guilds
    });
  }));

  app.get('/api/blacklist', requireGlobalAdmin, asyncHandler(async (_req, res) => {
    const entries = await storage.listBlacklistEntries();
    const withEvidence = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      evidence: await storage.listBlacklistEvidence(entry.userId)
    })));
    res.json(withEvidence);
  }));

  app.post('/api/blacklist', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const userId = String(req.body.userId ?? '').trim();
    if (!/^\d{17,20}$/.test(userId)) {
      res.status(400).json({ error: 'Pon un ID de usuario valido.' });
      return;
    }
    const reason = String(req.body.reason ?? '').trim();
    if (!reason) {
      res.status(400).json({ error: 'Pon un motivo para la blacklist.' });
      return;
    }
    const duration = parseBlacklistDuration(req.body.duration || 'permanente');
    const entry = await storage.upsertBlacklistEntry({
      userId,
      banCode: buildGlobalBanCode(userId),
      reason,
      duration: duration.duration,
      expiresAt: duration.expiresAt,
      active: true,
      createdBy: req.session.user.id
    });
    res.json({
      ...entry,
      evidence: await storage.listBlacklistEvidence(entry.userId)
    });
  }));

  app.delete('/api/blacklist/:id', requireGlobalAdmin, asyncHandler(async (req, res) => {
    const entry = await storage.deactivateBlacklistEntry(req.params.id, req.session.user.id);
    if (!entry) {
      res.status(404).json({ error: 'Blacklist entry not found' });
      return;
    }
    res.json(entry);
  }));

  app.post('/api/assistant', asyncHandler(async (req, res) => {
    const message = String(req.body.message ?? '').trim().slice(0, 900);
    if (!message) {
      res.status(400).json({ error: 'Escribe una pregunta para el asistente.' });
      return;
    }

    const configs = await storage.listGuildConfigs();
    const knownInstalledGuildIds = new Set(configs.map((item) => item.guildId).filter(Boolean));
    const guilds = mergeUserGuilds(req.session, configs, knownInstalledGuildIds, config);
    const guild = guilds.find((item) => item.guildId === req.body.guildId) ?? guilds[0] ?? null;
    let stats;
    try {
      stats = enrichDashboardStats(
        await storage.getDashboardStats(req.session.guilds.map((item) => item.id)),
        guilds
      );
    } catch (error) {
      console.warn('Dashboard assistant stats fallback:', normalizeError(error));
      stats = enrichDashboardStats(buildEmptyDashboardStats(), guilds);
    }
    res.json(await buildDashboardAssistantReply({ config, message, guild, stats, activeView: req.body.activeView }));
  }));

  app.get('/api/tickets/:channelId/transcript', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId);
    if (!ticket || !canAccessGuild(req.session, ticket.guildId)) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    res.json(await storage.listTranscriptMessages(req.params.channelId));
  }));

  app.get('/api/tickets/:channelId/transcript.txt', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId);
    const sessionCanAccess = req.session ? canAccessGuild(req.session, ticket?.guildId) : false;
    const signedCanAccess = verifyTranscriptReplayRequest(req, config);
    if (!ticket || (!sessionCanAccess && !signedCanAccess)) {
      res.status(404).type('text/plain').send('Ticket not found');
      return;
    }

    const messages = await storage.listTranscriptMessages(req.params.channelId);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${buildTranscriptFileName(ticket)}"`);
    res.send(buildTranscriptText({ ticket, messages }));
  }));

  app.get('/tickets/:channelId/replay', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId);
    const sessionCanAccess = req.session ? canAccessGuild(req.session, ticket?.guildId) : false;
    const signedCanAccess = verifyTranscriptReplayRequest(req, config);
    if (!ticket || (!sessionCanAccess && !signedCanAccess)) {
      res.status(404).type('html').send(renderSimpleErrorPage('Transcripcion no encontrada', 'No tienes acceso a este ticket o ya no existe.'));
      return;
    }

    const messages = await storage.listTranscriptMessages(req.params.channelId);
    const users = buildReplayUserMap(messages);
    await hydrateReplayUsersFromDiscord({ config, users }).catch((error) => {
      console.warn(`Could not hydrate replay users for ${req.params.channelId}:`, normalizeError(error));
    });
    res.type('html').send(renderTicketReplayPage({
      ticket,
      messages,
      users,
      publicAccess: !sessionCanAccess && signedCanAccess,
      accessQuery: buildTranscriptAccessQuery(req)
    }));
  }));

  app.get('/api/guilds/:guildId/roles', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildRoles({ guildId: req.params.guildId }));
  }));

  app.get('/api/guilds/:guildId/channels', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildChannels({ guildId: req.params.guildId }));
  }));

  app.get('/api/guilds/:guildId/feedback', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await storage.listTicketFeedback([req.params.guildId]));
  }));

  app.get('/api/guilds/:guildId/ai-quality', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(typeof storage.listAiQualitySignals === 'function'
      ? await storage.listAiQualitySignals([req.params.guildId])
      : []);
  }));

  app.get('/api/guilds/:guildId/logs', requireGuildAccess, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '180', 10) || 180, 1), 500);
    res.json(await storage.listGuildLogs(req.params.guildId, { limit }));
  }));

  app.post('/api/uploads/panel-image', requireDashboardSession, asyncHandler(async (req, res) => {
    const upload = await saveDashboardImageUpload({
      fileName: req.body.fileName,
      mimeType: req.body.mimeType,
      dataUrl: req.body.dataUrl,
      config,
      storage
    });
    res.json(upload);
  }));

  app.post('/api/guilds/:guildId/discovery', requireGuildAccess, asyncHandler(async (req, res) => {
    if (typeof bot.refreshGuildDiscovery !== 'function') {
      res.status(501).json({ error: 'Smart discovery is not available in this runtime.' });
      return;
    }
    const updated = await bot.refreshGuildDiscovery({ guildId: req.params.guildId, reason: 'dashboard' });
    await recordDashboardGuildLog(storage, req, {
      guildId: req.params.guildId,
      guildName: updated.guildName,
      type: 'config',
      severity: 'info',
      title: 'Smart Discovery ejecutado desde dashboard',
      message: 'NexaDesk reescaneo canales para detectar anuncios, normas, FAQ, soporte y categorias utiles.',
      metadata: { discovery: updated.discovery ?? null }
    });
    res.json(updated);
  }));

  app.post('/api/guilds/:guildId', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const existing = await storage.getGuildConfig(req.params.guildId);
    const patch = { guildName: req.body.guildName || existing?.guildName || guild?.name };
    for (const key of ['ticketCategoryId', 'ticketCategoryName', 'staffRoleId', 'serverPrompt', 'serverInfo']) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key];
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'watchedTicketCategories')) {
      patch.watchedTicketCategories = normalizeDashboardWatchedCategories(req.body.watchedTicketCategories, patch);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'ticketClosePolicy')) {
      patch.ticketClosePolicy = normalizeDashboardTicketClosePolicy(req.body.ticketClosePolicy);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'scheduledAnnouncements')) {
      patch.scheduledAnnouncements = normalizeDashboardScheduledAnnouncements(req.body.scheduledAnnouncements);
    }
    if (req.body.security) patch.security = normalizeSecurityConfig(req.body.security);
    if (req.body.growth) patch.growth = normalizeGrowthConfig(req.body.growth);
    if (req.body.welcome) patch.welcome = normalizeWelcomeConfig(req.body.welcome);
    if (req.body.alliance) {
      patch.allianceChannelId = req.body.alliance.channelId;
      patch.allianceChannelName = req.body.alliance.channelName;
      patch.allianceTemplate = req.body.alliance.template;
    }
    if (req.session.user?.id === GLOBAL_BLACKLIST_ADMIN_USER_ID) {
      if (Object.prototype.hasOwnProperty.call(req.body, 'plan')) patch.plan = req.body.plan;
      if (Object.prototype.hasOwnProperty.call(req.body, 'voiceSupportEnabled')) patch.voiceSupportEnabled = Boolean(req.body.voiceSupportEnabled);
    }
    if (req.body.premium) {
      patch.premium = normalizePremiumConfig(req.body.premium, { ...(existing ?? {}), ...patch });
    }
    const updated = await storage.upsertGuildConfig(req.params.guildId, patch);
    await recordDashboardGuildLog(storage, req, {
      guildId: req.params.guildId,
      guildName: updated.guildName,
      type: req.body.premium ? 'premium' : req.body.growth || req.body.welcome ? 'growth' : req.body.security ? 'security' : 'config',
      severity: 'success',
      title: 'Configuracion actualizada desde dashboard',
      message: 'Se guardaron cambios de configuracion del servidor.',
      metadata: { changedKeys: Object.keys(patch) }
    });
    res.json(updated);
  }));

  app.post('/api/guilds/:guildId/categories', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.createTicketCategory({
        guildId: req.params.guildId,
        name: req.body.name || 'NexaDesk Tickets'
      });
      await recordDashboardGuildLog(storage, req, {
        guildId: req.params.guildId,
        guildName: updated.guildName,
        type: 'config',
        severity: 'success',
        title: 'Categoria creada desde dashboard',
        message: `Se creo o preparo una categoria de tickets: ${req.body.name || 'NexaDesk Tickets'}.`
      });
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }));

  app.post('/api/guilds/:guildId/components', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const existing = await storage.getGuildConfig(req.params.guildId);
    const component = normalizeTicketComponent(req.body);
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: existing?.guildName || guild?.name,
      components: [
        ...(existing?.components ?? []),
        component
      ]
    });
    await recordDashboardGuildLog(storage, req, {
      guildId: req.params.guildId,
      guildName: updated.guildName,
      type: 'component',
      severity: 'success',
      title: 'Componente creado',
      message: `Se creo el componente "${component.label}" para paneles de tickets.`,
      metadata: { componentId: component.id, ticketMode: component.ticketMode }
    });
    res.json(updated);
  }));

  app.put('/api/guilds/:guildId/components/:componentId', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const existing = await storage.getGuildConfig(req.params.guildId);
    const components = existing?.components ?? [];
    const previous = components.find((component) => component.id === req.params.componentId);
    if (!previous) {
      res.status(404).json({ error: 'No encuentro ese componente.' });
      return;
    }

    const component = normalizeTicketComponent({
      ...previous,
      ...req.body,
      id: previous.id,
      createdAt: previous.createdAt
    });
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: existing?.guildName || guild?.name,
      components: components.map((item) => item.id === previous.id ? component : item)
    });
    await bot.refreshTicketPanels?.({ guildId: req.params.guildId }).catch((error) => {
      console.warn(`Could not refresh panels after component update in ${req.params.guildId}:`, error?.message ?? error);
    });
    await recordDashboardGuildLog(storage, req, {
      guildId: req.params.guildId,
      guildName: updated.guildName,
      type: 'component',
      severity: 'success',
      title: 'Componente actualizado',
      message: `Se actualizo el componente "${component.label}" y se intentaron sincronizar paneles publicados.`,
      metadata: { componentId: component.id, previousLabel: previous.label, ticketMode: component.ticketMode }
    });
    res.json(updated);
  }));

  app.delete('/api/guilds/:guildId/components/:componentId', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const existing = await storage.getGuildConfig(req.params.guildId);
    const components = existing?.components ?? [];
    const component = components.find((item) => item.id === req.params.componentId);
    if (!component) {
      res.status(404).json({ error: 'No encuentro ese componente.' });
      return;
    }
    const affectedPanels = (existing?.panels ?? []).filter((panel) => (panel.componentIds ?? []).includes(component.id));
    const panelsWithNoOptions = affectedPanels.filter((panel) => (panel.componentIds ?? []).filter((id) => id !== component.id).length === 0);
    if (panelsWithNoOptions.length) {
      res.status(400).json({ error: 'No puedo eliminarlo porque dejaria un panel de menu sin opciones. Edita o borra primero ese panel.' });
      return;
    }

    const updatedPanels = (existing?.panels ?? []).map((panel) => ({
      ...panel,
      componentIds: Array.isArray(panel.componentIds)
        ? panel.componentIds.filter((id) => id !== component.id)
        : []
    }));
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: existing?.guildName || guild?.name,
      components: components.filter((item) => item.id !== component.id),
      panels: updatedPanels
    });
    await bot.refreshTicketPanels?.({ guildId: req.params.guildId }).catch((error) => {
      console.warn(`Could not refresh panels after component delete in ${req.params.guildId}:`, error?.message ?? error);
    });
    await recordDashboardGuildLog(storage, req, {
      guildId: req.params.guildId,
      guildName: updated.guildName,
      type: 'component',
      severity: 'warning',
      title: 'Componente eliminado',
      message: `Se elimino el componente "${component.label}". Los paneles de menu afectados fueron sincronizados.`,
      metadata: { componentId: component.id, affectedPanels: affectedPanels.map((panel) => panel.messageId || panel.title).filter(Boolean) }
    });
    res.json(updated);
  }));

  app.post('/api/guilds/:guildId/panels', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.createTicketPanel(buildPanelRequestPayload(req));
      await recordDashboardGuildLog(storage, req, {
        guildId: req.params.guildId,
        guildName: updated.guildName,
        type: 'panel',
        severity: 'success',
        title: 'Panel publicado',
        message: `Se publico un panel de tickets "${req.body.title || 'Centro de soporte'}".`,
        metadata: { channelId: req.body.channelId, panelType: req.body.panelType, ticketMode: req.body.ticketMode }
      });
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }));

  app.put('/api/guilds/:guildId/panels/:messageId', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.updateTicketPanel({
        ...buildPanelRequestPayload(req),
        messageId: req.params.messageId
      });
      await recordDashboardGuildLog(storage, req, {
        guildId: req.params.guildId,
        guildName: updated.guildName,
        type: 'panel',
        severity: 'success',
        title: 'Panel actualizado',
        message: `Se actualizo el panel enviado "${req.body.title || req.params.messageId}".`,
        metadata: { messageId: req.params.messageId, channelId: req.body.channelId, panelType: req.body.panelType }
      });
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }));

  app.delete('/api/guilds/:guildId/panels/:messageId', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.deleteTicketPanel({
        guildId: req.params.guildId,
        messageId: req.params.messageId
      });
      await recordDashboardGuildLog(storage, req, {
        guildId: req.params.guildId,
        guildName: updated.guildName,
        type: 'panel',
        severity: 'warning',
        title: 'Panel eliminado',
        message: `Se elimino el panel publicado con mensaje ${req.params.messageId}.`,
        metadata: { messageId: req.params.messageId }
      });
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }));

  app.get('/backups', asyncHandler(async (req, res) => {
    const manageableGuildIds = req.session.guilds.map((guild) => guild.id);
    const configs = await storage.listGuildConfigs();
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    const [backups, restores] = await Promise.all([
      storage.listGuildBackupSnapshots?.(manageableGuildIds, { limit: 120 }) ?? [],
      storage.listGuildBackupRestores?.(manageableGuildIds, { limit: 80 }) ?? []
    ]);
    res.type('html').send(renderBackupsPage({
      session: req.session,
      guilds,
      backups: backups.map(serializeBackupListItem),
      restores: restores.map(serializeBackupRestoreListItem),
      config
    }));
  }));

  app.get('/', asyncHandler(async (req, res) => {
    const manageableGuildIds = req.session.guilds.map((guild) => guild.id);
    const [configs, tickets, stats, dashboardState, settings] = await Promise.all([
      storage.listGuildConfigs(),
      storage.listTickets(),
      storage.getDashboardStats(manageableGuildIds),
      getDashboardUserState(storage, req.session.user.id),
      storage.getGlobalSettings().catch(() => ({}))
    ]);
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    const dashboardMaintenance = normalizeDashboardMaintenanceState(settings.dashboardMaintenance);
    const hasDashboardPriorityAccess = req.session.user.id === GLOBAL_BLACKLIST_ADMIN_USER_ID
      || guilds.some((guild) => guild.installed && isPremiumEntitled(guild));
    if (dashboardMaintenance.enabled && !hasDashboardPriorityAccess) {
      res.type('html').send(renderDashboardMaintenancePage({
        session: req.session,
        maintenance: dashboardMaintenance
      }));
      return;
    }
    res.type('html').send(renderDashboard({
      session: req.session,
      guilds,
      tickets: tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)),
      stats: enrichDashboardStats(stats, guilds),
      dashboardState,
      releaseState: buildReleaseState(settings.releaseControl, { isOwner: req.session.user.id === GLOBAL_BLACKLIST_ADMIN_USER_ID })
    }));
  }));

  app.use((error, req, res, _next) => {
    console.error('Dashboard request failed:', error);
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: normalizeError(error) });
      return;
    }
    res.status(500).type('html').send(renderError(normalizeError(error)));
  });

  return app;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function normalizeDashboardMaintenanceState(value = {}) {
  return {
    enabled: Boolean(value?.enabled),
    message: String(value?.message || 'Estamos reforzando la dashboard para que NexaDesk sea mas rapido, mas seguro y mas estable.').trim().slice(0, 500),
    enabledBy: value?.enabledBy ? String(value.enabledBy).slice(0, 120) : null,
    enabledAt: value?.enabledAt || null,
    disabledBy: value?.disabledBy ? String(value.disabledBy).slice(0, 120) : null,
    disabledAt: value?.disabledAt || null,
    updatedAt: value?.updatedAt || null
  };
}

function normalizeDashboardWatchedCategories(value = [], patch = {}) {
  const raw = Array.isArray(value) ? value : [];
  const primary = patch.ticketCategoryId
    ? [{ id: patch.ticketCategoryId, name: patch.ticketCategoryName, primary: true }]
    : [];
  return [...primary, ...raw]
    .map((item) => ({
      id: String(item?.id ?? '').trim(),
      name: item?.name ? String(item.name).slice(0, 120) : null,
      primary: Boolean(item?.primary)
    }))
    .filter((item, index, list) => item.id && list.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 2)
    .map((item, index) => ({ ...item, primary: index === 0 || item.primary }));
}

function normalizeDashboardTicketClosePolicy(value = {}) {
  const mode = value?.mode === 'staff_only' || value?.usersCanClose === false
    ? 'staff_only'
    : 'opener_and_staff';
  return {
    mode,
    usersCanClose: mode !== 'staff_only',
    updatedAt: new Date().toISOString()
  };
}

function normalizeDashboardScheduledAnnouncements(value = []) {
  const raw = Array.isArray(value) ? value : [];
  return raw.slice(0, 25).map((item) => {
    const scheduleType = item?.scheduleType === 'once' ? 'once' : 'interval';
    const intervalHours = Math.max(1, Math.min(24 * 30, Number(item?.intervalHours ?? 24) || 24));
    const now = new Date().toISOString();
    return {
      id: String(item?.id ?? `ann-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`).slice(0, 80),
      enabled: item?.enabled !== false,
      name: String(item?.name ?? 'Anuncio programado').slice(0, 90),
      channelId: item?.channelId ? String(item.channelId) : null,
      channelName: item?.channelName ? String(item.channelName).slice(0, 120) : null,
      content: item?.content ? String(item.content).slice(0, 1800) : '',
      scheduleType,
      intervalHours,
      nextRunAt: item?.nextRunAt ? String(item.nextRunAt) : now,
      lastRunAt: item?.lastRunAt ? String(item.lastRunAt) : null,
      runCount: Math.max(0, Number(item?.runCount ?? 0) || 0),
      embed: {
        title: String(item?.embed?.title ?? item?.title ?? 'Anuncio').slice(0, 256),
        description: String(item?.embed?.description ?? item?.description ?? '').slice(0, 3800),
        color: String(item?.embed?.color ?? item?.color ?? '#ffffff').slice(0, 16),
        imageUrl: item?.embed?.imageUrl ? String(item.embed.imageUrl).slice(0, 500) : null,
        footerText: item?.embed?.footerText ? String(item.embed.footerText).slice(0, 200) : null
      },
      createdAt: item?.createdAt ? String(item.createdAt) : now,
      updatedAt: now
    };
  }).filter((item) => item.channelId && (item.embed.title || item.embed.description));
}

function buildPremiumAccountResponse({ account, config }) {
  const checkout = getPremiumCheckoutConfig(config);
  return {
    ...account,
    checkout,
    sales: {
      headline: `${checkout.slots} servidores Premium por ${checkout.displayPrice}`,
      subline: 'Activa soporte por IA, voz, examenes, seguridad avanzada y crecimiento sin cambiar tu bot de tickets.',
      features: PREMIUM_SALES_FEATURES,
      addons: PREMIUM_ADDONS,
      urgency: 'Precio early-access mientras NexaDesk sigue creciendo. Ideal para cerrar los primeros servidores de pago.',
      supportUrl: checkout.supportUrl
    }
  };
}

async function recordManualPremiumIntent({ storage, session, checkoutConfig, error = null }) {
  const now = new Date().toISOString();
  return storage.recordPremiumPurchase({
    id: `manual-pending-${session.user.id}-${Date.now()}`,
    discordUserId: session.user.id,
    buyerUsername: session.user.username,
    provider: 'manual',
    providerSessionId: `manual-${session.user.id}-${Date.now()}`,
    amountTotal: checkoutConfig.priceCents,
    currency: checkoutConfig.currency,
    slotsPurchased: checkoutConfig.slots,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    metadata: {
      source: 'dashboard',
      paymentUrl: checkoutConfig.manualPaymentUrl,
      supportUrl: checkoutConfig.supportUrl,
      fallbackReason: error ? normalizeError(error) : null
    }
  });
}

async function createPremiumPayPalOrder({ config, session, checkoutConfig }) {
  const baseUrl = getPayPalBaseUrl(config);
  const accessToken = await getPayPalAccessToken(config);
  const purchaseId = `nexadesk-${session.user.id}-${Date.now()}`;
  const value = (checkoutConfig.priceCents / 100).toFixed(2);
  const dashboardUrl = config.DASHBOARD_PUBLIC_URL.replace(/\/$/, '');

  return paypalFetch(config, `${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    accessToken,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: purchaseId,
          custom_id: session.user.id,
          description: `${checkoutConfig.slots} servidores premium NexaDesk`,
          amount: {
            currency_code: checkoutConfig.currency.toUpperCase(),
            value
          }
        }
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'NexaDesk',
            landing_page: 'LOGIN',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: `${dashboardUrl}/premium/paypal/success`,
            cancel_url: `${dashboardUrl}/premium/paypal/cancel`
          }
        }
      },
