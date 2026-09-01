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
import { GLOBAL_BLACKLIST_ADMIN_USER_ID, buildGlobalBanCode, isBlacklistEntryActive, parseBlacklistDuration } from './blacklist.js';
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

export function createServer({ config, storage, bot, events }) {
  const app = express();

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
      updatedAt: '14 de mayo de 2026',
      title: 'Terms and Conditions',
      eyebrow: 'NexaDesk Legal',
      intro: 'Estas condiciones explican como puede usarse NexaDesk, que responsabilidades mantiene cada servidor y que limites tiene el servicio.',
      sections: buildTermsSections()
    }));
  });

  app.get('/privacy', (_req, res) => {
    res.type('html').send(renderLegalPage({
      type: 'privacy',
      updatedAt: '14 de mayo de 2026',
      title: 'Privacy Policy',
      eyebrow: 'NexaDesk Privacy',
      intro: 'Esta politica resume que datos procesa NexaDesk para funcionar como bot de soporte, seguridad, voz, dashboard y transcripciones.',
      sections: buildPrivacySections()
    }));
  });

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
      application_context: {
        brand_name: 'NexaDesk',
        landing_page: 'LOGIN',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: `${dashboardUrl}/premium/paypal/success`,
        cancel_url: `${dashboardUrl}/premium/paypal/cancel`
      }
    }
  });
}

async function capturePremiumPayPalOrder({ orderId, storage, config, session }) {
  const baseUrl = getPayPalBaseUrl(config);
  const accessToken = await getPayPalAccessToken(config);
  const capture = await paypalFetch(config, `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    accessToken,
    body: {}
  });

  if (capture.status !== 'COMPLETED') return null;
  const unit = capture.purchase_units?.[0] ?? {};
  const captureInfo = unit.payments?.captures?.[0] ?? {};
  const checkoutConfig = getPremiumCheckoutConfig(config);
  const discordUserId = unit.custom_id || session.user.id;
  if (discordUserId !== session.user.id) {
    throw new Error('Este pago de PayPal pertenece a otra sesion de Discord.');
  }

  return storage.recordPremiumPurchase({
    id: `paypal-${capture.id}`,
    discordUserId,
    buyerUsername: session.user.username,
    provider: 'paypal',
    providerSessionId: capture.id,
    providerPaymentIntentId: captureInfo.id,
    amountTotal: Math.round(Number(captureInfo.amount?.value ?? checkoutConfig.priceCents / 100) * 100),
    currency: captureInfo.amount?.currency_code?.toLowerCase() ?? checkoutConfig.currency,
    slotsPurchased: checkoutConfig.slots,
    status: 'paid',
    metadata: {
      paypalStatus: capture.status,
      payerId: capture.payer?.payer_id,
      payerEmail: capture.payer?.email_address,
      captureStatus: captureInfo.status,
      referenceId: unit.reference_id,
      source: 'dashboard'
    }
  });
}

async function getPayPalAccessToken(config) {
  const baseUrl = getPayPalBaseUrl(config);
  const auth = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal OAuth fallo: ${response.status} ${data.error_description || data.error || ''}`.trim());
  }
  return data.access_token;
}

async function paypalFetch(config, url, { method = 'GET', accessToken, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'paypal-request-id': crypto.randomUUID(),
      'prefer': 'return=representation'
    },
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.error_description || data.name || JSON.stringify(data);
    throw new Error(`PayPal API fallo: ${response.status} ${detail}`);
  }
  return data;
}

function getPayPalBaseUrl(config) {
  return config.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getPayPalApprovalUrl(order = {}) {
  const links = Array.isArray(order.links) ? order.links : [];
  return links.find((link) => ['payer-action', 'payer_action', 'approve'].includes(String(link.rel ?? '').toLowerCase()))?.href
    ?? links.find((link) => /paypal\.com\/checkoutnow|paypal\.com\/webapps\/hermes/i.test(String(link.href ?? '')))?.href
    ?? null;
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/Expected token to be set/i.test(message)) {
    return 'Falta DISCORD_TOKEN en la Raspberry Pi. Configura el token actual en el .env local y reinicia PM2 para cargar roles, canales y paneles.';
  }
  if (/401|Unauthorized|Invalid Form Body|TOKEN_INVALID|invalid token/i.test(message)) {
    return 'El DISCORD_TOKEN configurado en la Raspberry Pi no es valido o fue reseteado. Actualiza el .env y reinicia PM2.';
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function requireGlobalAdmin(req, res, next) {
  if (req.session?.user?.id !== GLOBAL_BLACKLIST_ADMIN_USER_ID) {
    if (req.path === '/owner') {
      res.status(403).type('html').send(renderOwnerForbidden());
      return;
    }
    res.status(403).json({ error: 'Global admin only.' });
    return;
  }
  next();
}

function isAuthorizedAdminCodeIssuerRequest(req, config) {
  const authorization = String(req.get('authorization') ?? '').trim();
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const direct = String(req.get('x-nexadesk-admin-code-secret') ?? '').trim();
  const candidates = [config.ADMIN_CODE_SECRET, config.DISCORD_TOKEN]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return candidates.some((expected) => (
    timingSafeStringEqual(bearer, expected) || timingSafeStringEqual(direct, expected)
  ));
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdminSession(req, res, next) {
  setDocsSecurityHeaders(res);
  const session = getAdminSession(req);
  if (!session) {
    res.status(401).json({ error: 'Admin TOTP required.' });
    return;
  }
  req.adminSession = session;
  next();
}

function requireStatusEditor(req, res, next) {
  const adminSession = getAdminSession(req);
  if (adminSession) {
    req.statusEditor = {
      id: adminSession.issuedBy ?? 'admin-session',
      username: 'Admin session'
    };
    next();
    return;
  }

  const session = getSession(req);
  if (session?.user?.id === GLOBAL_BLACKLIST_ADMIN_USER_ID) {
    req.statusEditor = session.user;
    next();
    return;
  }

  res.status(403).json({ error: 'Status owner/admin only.' });
}

function requireDashboardSession(req, res, next) {
  if (!getSession(req)) {
    res.status(401).json({ error: 'Inicia sesion con Discord para subir archivos.' });
    return;
  }
  next();
}

function requireGuildAccess(req, res, next) {
  if (!canAccessGuild(req.session, req.params.guildId)) {
    res.status(403).json({ error: 'You cannot manage this guild.' });
    return;
  }
  next();
}

async function saveDashboardImageUpload({ fileName = 'panel-image.png', mimeType = '', dataUrl = '', config, storage }) {
  const match = String(dataUrl).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=]+)$/i);
  const type = match?.[1] || String(mimeType ?? '').toLowerCase();
  if (!match || !['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(type)) {
    throw new Error('Sube una imagen PNG, JPG, WEBP o GIF valida.');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5_000_000) {
    throw new Error('La imagen debe pesar menos de 5 MB.');
  }

  const extension = (({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  })[type] ?? path.extname(String(fileName)).toLowerCase()) || '.png';
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, id), buffer);
  const settings = await storage.getGlobalSettings().catch(() => ({}));
  const uploads = {
    ...(settings.dashboardUploads && typeof settings.dashboardUploads === 'object' ? settings.dashboardUploads : {}),
    [id]: {
      mimeType: type,
      dataUrl,
      size: buffer.length,
      originalName: String(fileName ?? '').slice(0, 180),
      createdAt: new Date().toISOString()
    }
  };
  const trimmedUploads = Object.fromEntries(Object.entries(uploads)
    .sort((a, b) => Date.parse(b[1]?.createdAt ?? '') - Date.parse(a[1]?.createdAt ?? ''))
    .slice(0, 80));
  await storage.updateGlobalSettings({ dashboardUploads: trimmedUploads }).catch((error) => {
    console.warn('Could not persist dashboard upload in global settings:', error?.message ?? error);
  });

  const publicUrl = new URL(`/uploads/${id}`, config.DASHBOARD_PUBLIC_URL).toString();
  return {
    url: publicUrl,
    fileName: id,
    size: buffer.length,
    mimeType: type
  };
}

async function exchangeDiscordCode(config, code) {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(config)
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    throw new Error(`Discord token exchange failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function discordFetch(path, accessToken) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Discord API failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function getRedirectUri(config) {
  return `${config.DASHBOARD_PUBLIC_URL.replace(/\/$/, '')}/auth/discord/callback`;
}

function turnstileErrorMessage(reason) {
  switch (reason) {
    case 'missing-token':
      return 'Completa la verificación de seguridad antes de continuar.';
    case 'timeout':
      return 'La verificación tardó demasiado. Recarga la página e inténtalo de nuevo.';
    case 'not_configured':
      return 'La protección anti-bots no está configurada correctamente.';
    default:
      return 'No hemos podido validar la verificación de seguridad. Inténtalo de nuevo.';
  }
}

function canManageGuild(guild) {
  const permissions = BigInt(guild.permissions ?? '0');
  return guild.owner || (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

function canAccessGuild(session, guildId) {
  return Boolean(session?.guilds?.some((guild) => guild.id === guildId));
}

function isTranscriptReplayRequest(req) {
  return /^\/tickets\/\d{16,24}\/replay$/.test(req.path);
}

function isTranscriptDownloadRequest(req) {
  return /^\/api\/tickets\/\d{16,24}\/transcript\.txt$/.test(req.path);
}

function verifyTranscriptReplayRequest(req, config) {
  const channelId = String(req.params?.channelId
    ?? req.path.match(/^\/tickets\/(\d{16,24})\/replay$/)?.[1]
    ?? req.path.match(/^\/api\/tickets\/(\d{16,24})\/transcript\.txt$/)?.[1]
    ?? '').trim();
  const userId = String(req.query.viewer ?? '').trim();
  const token = String(req.query.token ?? '').trim();
  if (!channelId || !/^\d{16,24}$/.test(userId) || !token) return false;
  return verifyTranscriptAccessToken({
    channelId,
    userId,
    token,
    secret: config.SESSION_SECRET
  });
}

function buildTranscriptAccessQuery(req) {
  const viewer = String(req.query.viewer ?? '').trim();
  const token = String(req.query.token ?? '').trim();
  if (!viewer || !token) return '';
  const params = new URLSearchParams({ viewer, token });
  return `?${params.toString()}`;
}

async function recordDashboardGuildLog(storage, req, { guildId, guildName, type = 'config', severity = 'info', title, message, metadata = {} }) {
  await storage.addGuildLog?.({
    guildId,
    guildName,
    type,
    severity,
    title,
    message,
    actorId: req.session?.user?.id,
    actorName: req.session?.user?.username,
    metadata: {
      source: 'dashboard',
      ...metadata
    }
  }).catch((error) => {
    console.warn(`Could not persist dashboard guild log for ${guildId}:`, error?.message ?? error);
  });
}

async function getDashboardUserState(storage, discordUserId) {
  const settings = await storage.getGlobalSettings().catch(() => ({}));
  return normalizeDashboardUserState(settings.dashboardUserStates?.[String(discordUserId)]);
}

async function updateDashboardUserState(storage, discordUserId, patch = {}) {
  const userId = String(discordUserId);
  const settings = await storage.getGlobalSettings().catch(() => ({}));
  const states = settings.dashboardUserStates && typeof settings.dashboardUserStates === 'object'
    ? settings.dashboardUserStates
    : {};
  const current = normalizeDashboardUserState(states[userId]);
  const now = new Date().toISOString();
  const next = normalizeDashboardUserState({
    ...current,
    tourCompleted: patch.tourCompleted,
    tourVersion: patch.tourVersion ?? current.tourVersion,
    firstSeenAt: current.firstSeenAt || now,
    lastSeenAt: now,
    updatedAt: now
  });
  const savedStates = {
    ...states,
    [userId]: next
  };
  await storage.updateGlobalSettings({
    dashboardUserStates: pruneDashboardUserStates(savedStates)
  });
  return next;
}

function normalizeDashboardUserState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    tourCompleted: Boolean(source.tourCompleted),
    tourVersion: String(source.tourVersion || '').slice(0, 40) || null,
    firstSeenAt: source.firstSeenAt || null,
    lastSeenAt: source.lastSeenAt || null,
    updatedAt: source.updatedAt || null
  };
}

function pruneDashboardUserStates(states = {}) {
  return Object.fromEntries(
    Object.entries(states)
      .filter(([userId]) => /^\d{17,20}$/.test(String(userId)))
      .slice(-2500)
  );
}

async function getInstalledGuildIds(bot, configs = []) {
  try {
    if (typeof bot.listInstalledGuildIds !== 'function') {
      return new Set(configs.map((config) => config.guildId).filter(Boolean));
    }

    const guildIds = await Promise.race([
      bot.listInstalledGuildIds(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Installed guild lookup timed out')), 3500))
    ]);
    return new Set(guildIds);
  } catch (error) {
    console.warn('Could not resolve installed guilds. Falling back to configured guilds:', normalizeError(error));
    return new Set(configs.map((config) => config.guildId).filter(Boolean));
  }
}

function mergeUserGuilds(session, configs, installedGuildIds = new Set(), config = null) {
  return session.guilds.map((guild) => {
    const guildConfig = configs.find((item) => item.guildId === guild.id);
    const installed = installedGuildIds.has(guild.id);
    return {
      ...guildConfig,
      guildId: guild.id,
      guildName: guildConfig?.guildName ?? guild.name,
      icon: guild.icon,
      configured: Boolean(guildConfig),
      connected: installed,
      installed,
      inviteUrl: config ? buildBotInviteUrl(config, guild.id) : `/invite/${guild.id}`
    };
  });
}

function enrichDashboardStats(stats, guilds) {
  const configuredGuilds = guilds.filter((guild) => guild.ticketCategoryId).length;
  const installedGuilds = guilds.filter((guild) => guild.installed).length;
  return {
    ...stats,
    totalGuilds: guilds.length,
    configuredGuilds,
    unconfiguredGuilds: Math.max(guilds.length - configuredGuilds, 0),
    installedGuilds,
    notInstalledGuilds: Math.max(guilds.length - installedGuilds, 0),
    escalationReadyGuilds: guilds.filter((guild) => guild.staffRoleId).length,
    aiReadyGuilds: guilds.filter((guild) => guild.serverPrompt || guild.serverInfo).length,
    securityReadyGuilds: guilds.filter((guild) => normalizeSecurityConfig(guild.security).enabled).length,
    growthReadyGuilds: guilds.filter((guild) => normalizeGrowthConfig(guild.growth).enabled).length,
    welcomeReadyGuilds: guilds.filter((guild) => normalizeWelcomeConfig(guild.welcome).enabled).length,
    proGuilds: guilds.filter(isPremiumEntitled).length,
    panels: guilds.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0)
  };
}

function serializeBackupListItem(snapshot = {}) {
  return {
    id: String(snapshot.id ?? ''),
    guildId: String(snapshot.guildId ?? ''),
    guildName: String(snapshot.guildName ?? 'Servidor').slice(0, 160),
    capturedAt: snapshot.capturedAt ?? snapshot.createdAt ?? null,
    source: String(snapshot.source ?? 'scheduled').slice(0, 80),
    summary: snapshot.summary && typeof snapshot.summary === 'object' ? snapshot.summary : {},
    fallback: Boolean(snapshot.fallback)
  };
}

function serializeBackupRestoreListItem(entry = {}) {
  return {
    id: String(entry.id ?? ''),
    backupId: String(entry.backupId ?? ''),
    sourceGuildId: String(entry.sourceGuildId ?? ''),
    sourceGuildName: String(entry.sourceGuildName ?? 'Servidor origen').slice(0, 160),
    targetGuildId: String(entry.targetGuildId ?? ''),
    targetGuildName: String(entry.targetGuildName ?? 'Servidor destino').slice(0, 160),
    requestedBy: entry.requestedBy ? String(entry.requestedBy) : null,
    status: String(entry.status ?? 'completed'),
    summary: entry.summary && typeof entry.summary === 'object' ? entry.summary : {},
    createdAt: entry.createdAt ?? entry.completedAt ?? null,
    completedAt: entry.completedAt ?? null,
    fallback: Boolean(entry.fallback)
  };
}

async function buildAdminSnapshot({ storage, bot }) {
  const [
    configs,
    tickets,
    feedback,
    aiQualitySignals,
    blacklistEntries,
    maintenance,
    settings
  ] = await Promise.all([
    storage.listGuildConfigs().catch((error) => {
      console.warn('Admin snapshot guilds failed:', normalizeError(error));
      return [];
    }),
    storage.listTickets().catch((error) => {
      console.warn('Admin snapshot tickets failed:', normalizeError(error));
      return [];
    }),
    typeof storage.listTicketFeedback === 'function'
      ? storage.listTicketFeedback().catch((error) => {
          console.warn('Admin snapshot feedback failed:', normalizeError(error));
          return [];
        })
      : Promise.resolve([]),
    typeof storage.listAiQualitySignals === 'function'
      ? storage.listAiQualitySignals().catch((error) => {
          console.warn('Admin snapshot AI quality failed:', normalizeError(error));
          return [];
        })
      : Promise.resolve([]),
    typeof storage.listBlacklistEntries === 'function'
      ? storage.listBlacklistEntries().catch((error) => {
          console.warn('Admin snapshot blacklist failed:', normalizeError(error));
          return [];
        })
      : Promise.resolve([]),
    typeof storage.getMaintenanceState === 'function'
      ? storage.getMaintenanceState().catch((error) => {
          console.warn('Admin snapshot maintenance failed:', normalizeError(error));
          return normalizeMaintenanceState();
        })
      : Promise.resolve(normalizeMaintenanceState()),
    storage.getGlobalSettings().catch((error) => {
      console.warn('Admin snapshot global settings failed:', normalizeError(error));
      return {};
    })
  ]);

  const guildIds = configs.map((guild) => guild.guildId).filter(Boolean);
  const installedGuildIds = await getInstalledGuildIds(bot, configs);
  let stats = buildEmptyDashboardStats();
  if (guildIds.length) {
    try {
      stats = await storage.getDashboardStats(guildIds);
    } catch (error) {
      console.warn('Admin snapshot stats failed:', normalizeError(error));
    }
  }

  const guilds = configs
    .map((guild) => ({
      ...guild,
      installed: installedGuildIds.has(guild.guildId),
      configured: Boolean(guild.ticketCategoryId),
      premiumSummary: summarizePremiumConfig(guild),
      premiumEntitled: isPremiumEntitled(guild),
      securitySummary: summarizeSecurityConfig(normalizeSecurityConfig(guild.security)),
      growth: normalizeGrowthConfig(guild.growth),
      welcome: normalizeWelcomeConfig(guild.welcome),
      componentsCount: guild.components?.length ?? 0,
      panelsCount: guild.panels?.length ?? 0
    }))
    .sort((a, b) => String(a.guildName ?? '').localeCompare(String(b.guildName ?? '')));

  return {
    generatedAt: new Date().toISOString(),
    runtime: buildAdminRuntime(),
    maintenance: normalizeMaintenanceState(maintenance),
    dashboardMaintenance: normalizeDashboardMaintenanceState(settings.dashboardMaintenance),
    stats: enrichAdminStats(stats, {
      guilds,
      tickets,
      feedback,
      aiQualitySignals,
      blacklistEntries,
      installedGuildIds
    }),
    guilds,
    tickets,
    feedback,
    aiQualitySignals,
    blacklistEntries
  };
}

function enrichAdminStats(stats, { guilds, tickets, feedback, aiQualitySignals, blacklistEntries, installedGuildIds }) {
  const configuredGuilds = guilds.filter((guild) => guild.configured).length;
  const openTickets = tickets.filter((ticket) => isOpenTicketStatus(ticket.status)).length;
  const premiumGuilds = guilds.filter((guild) => guild.premiumEntitled).length;
  const averageRating = feedback.length
    ? feedback.reduce((total, item) => total + Number(item.rating ?? 0), 0) / feedback.length
    : 0;
  return {
    ...stats,
    totalGuilds: guilds.length,
    installedGuilds: installedGuildIds.size,
    configuredGuilds,
    unconfiguredGuilds: Math.max(guilds.length - configuredGuilds, 0),
    totalTickets: tickets.length,
    openTickets,
    closedTickets: Math.max(tickets.length - openTickets, 0),
    feedbackCount: feedback.length,
    averageRating: Number(averageRating.toFixed(2)),
    aiQualitySignals: aiQualitySignals.length,
    unresolvedAiQualitySignals: aiQualitySignals.filter((signal) => !signal.resolved).length,
    activeBlacklistEntries: blacklistEntries.filter(isBlacklistEntryActive).length,
    premiumGuilds,
    freeGuilds: Math.max(guilds.length - premiumGuilds, 0),
    panels: guilds.reduce((total, guild) => total + (guild.panelsCount ?? 0), 0),
    components: guilds.reduce((total, guild) => total + (guild.componentsCount ?? 0), 0)
  };
}

function isOpenTicketStatus(status) {
  return !['closed', 'cerrado', 'resolved', 'archived', 'deleted'].includes(String(status ?? 'open').toLowerCase());
}

function buildAdminRuntime() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    env: process.env.NODE_ENV || 'development',
    runBot: String(process.env.RUN_BOT ?? 'true')
  };
}

async function buildHaHealthSnapshot({ storage, config }) {
  const settings = await storage.getGlobalSettings().catch((error) => ({
    botLeaseReadError: normalizeError(error)
  }));
  const lease = settings?.botLease && typeof settings.botLease === 'object' ? settings.botLease : {};
  const expiresAtMs = Date.parse(lease.expiresAt ?? '');
  const now = Date.now();
  const alive = Boolean(lease.ownerId && Number.isFinite(expiresAtMs) && expiresAtMs > now);
  return {
    ok: true,
    service: 'nexadesk',
    generatedAt: new Date(now).toISOString(),
    runtime: {
      env: config?.NODE_ENV || process.env.NODE_ENV || 'development',
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      runBot: String(config?.RUN_BOT ?? process.env.RUN_BOT ?? 'true'),
      haEnabled: String(config?.BOT_HA_ENABLED ?? process.env.BOT_HA_ENABLED ?? 'false'),
      botGatewayEligible: String(Boolean(config?.RUN_BOT || config?.BOT_HA_ENABLED)),
      instanceId: config?.BOT_INSTANCE_ID || process.env.BOT_INSTANCE_ID || 'local',
      primaryInstanceId: config?.BOT_PRIMARY_INSTANCE_ID || process.env.BOT_PRIMARY_INSTANCE_ID || '',
      keepaliveEnabled: String(config?.KEEPALIVE_ENABLED ?? process.env.KEEPALIVE_ENABLED ?? 'false'),
      keepaliveUrl: config?.KEEPALIVE_URL || process.env.KEEPALIVE_URL || ''
    },
    leader: {
      ownerId: lease.ownerId ?? '',
      hostname: lease.hostname ?? '',
      updatedAt: lease.updatedAt ?? null,
      expiresAt: lease.expiresAt ?? null,
      alive,
      secondsToExpiry: Number.isFinite(expiresAtMs) ? Math.round((expiresAtMs - now) / 1000) : null
    },
    warning: settings?.botLeaseReadError ?? null
  };
}

async function buildStatusSnapshot({ storage, bot }) {
  const [settings, configs, tickets] = await Promise.all([
    storage.getGlobalSettings().catch((error) => {
      console.warn('Status settings lookup failed:', normalizeError(error));
      return {};
    }),
    storage.listGuildConfigs().catch((error) => {
      console.warn('Status guild lookup failed:', normalizeError(error));
      return [];
    }),
    storage.listTickets().catch((error) => {
      console.warn('Status tickets lookup failed:', normalizeError(error));
      return [];
    })
  ]);
  const installedGuildIds = await getInstalledGuildIds(bot, configs);
  const status = normalizeStatusPage(settings.statusPage);
  const lease = settings.botLease && typeof settings.botLease === 'object' ? settings.botLease : {};
  const leaseExpiresAt = Date.parse(lease.expiresAt ?? '');
  const leaderAlive = Boolean(lease.ownerId && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now());
  const openTickets = tickets.filter((ticket) => isOpenTicketStatus(ticket.status)).length;
  return {
    generatedAt: new Date().toISOString(),
    status,
    metrics: {
      installedGuilds: installedGuildIds.size,
      configuredGuilds: configs.filter((guild) => guild.ticketCategoryId).length,
      openTickets,
      totalTickets: tickets.length,
      premiumGuilds: configs.filter(isPremiumEntitled).length
    },
    runtime: {
      env: process.env.NODE_ENV || 'development',
      uptimeSeconds: Math.round(process.uptime()),
      runBot: String(process.env.RUN_BOT ?? 'true'),
      haEnabled: String(process.env.BOT_HA_ENABLED ?? 'false'),
      instanceId: process.env.BOT_INSTANCE_ID || 'local',
      primaryInstanceId: process.env.BOT_PRIMARY_INSTANCE_ID || 'pi-main'
    },
    leader: {
      ownerId: lease.ownerId ?? '',
      hostname: lease.hostname ?? '',
      updatedAt: lease.updatedAt ?? null,
      expiresAt: lease.expiresAt ?? null,
      alive: leaderAlive
    }
  };
}

function normalizeStatusPage(input = {}) {
  const state = normalizeStatusState(input.state);
  const now = new Date().toISOString();
  return {
    state,
    headline: cleanStatusText(input.headline, defaultStatusHeadline(state), 90),
    message: cleanStatusText(input.message, defaultStatusMessage(state), 700),
    updatedBy: cleanStatusText(input.updatedBy, 'NexaDesk', 80),
    updatedAt: input.updatedAt || now,
    components: normalizeStatusComponents(input.components),
    updates: normalizeStatusUpdates(input.updates)
  };
}

function normalizeStatusState(value) {
  const state = String(value ?? '').toLowerCase();
  if (['operational', 'degraded', 'maintenance', 'outage'].includes(state)) return state;
  return 'operational';
}

function normalizeStatusComponents(value) {
  const parsed = parseMaybeJson(value, []);
  const source = Array.isArray(parsed) && parsed.length ? parsed : defaultStatusComponents();
  return source.slice(0, 8).map((item) => ({
    name: cleanStatusText(item?.name, 'Sistema', 44),
    state: normalizeStatusState(item?.state),
    detail: cleanStatusText(item?.detail, statusLabel(normalizeStatusState(item?.state)), 120)
  }));
}

function normalizeStatusUpdates(value) {
  const parsed = parseMaybeJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeStatusUpdate)
    .filter((item) => item.message)
    .slice(0, 20);
}

function normalizeStatusUpdate(input = {}) {
  const createdAt = input.createdAt || new Date().toISOString();
  return {
    id: String(input.id || `status-${Date.parse(createdAt) || Date.now()}`),
    level: normalizeStatusState(input.level),
    title: cleanStatusText(input.title, statusLabel(input.level), 80),
    message: cleanStatusText(input.message, '', 600),
    createdBy: cleanStatusText(input.createdBy, 'NexaDesk', 80),
    createdAt
  };
}

function defaultStatusComponents() {
  return [
    { name: 'Bot Discord', state: 'operational', detail: 'Atendiendo tickets y comandos.' },
    { name: 'Dashboard', state: 'operational', detail: 'Panel web disponible.' },
    { name: 'IA de soporte', state: 'operational', detail: 'Respuestas y contexto activos.' },
    { name: 'PostgreSQL', state: 'operational', detail: 'Datos y transcripciones sincronizados.' },
    { name: 'Voz Pro', state: 'operational', detail: 'STT/TTS disponible segun plan.' }
  ];
}

function cleanStatusText(value, fallback, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, maxLength);
}

function parseMaybeJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function defaultStatusHeadline(state) {
  return ({
    operational: 'NexaDesk esta operativo',
    degraded: 'NexaDesk funciona con degradacion parcial',
    maintenance: 'NexaDesk esta en mantenimiento programado',
    outage: 'NexaDesk esta revisando una incidencia'
  })[state] ?? 'NexaDesk esta operativo';
}

function defaultStatusMessage(state) {
  return ({
    operational: 'Todos los sistemas principales responden con normalidad.',
    degraded: 'Algunas funciones pueden ir mas lentas mientras revisamos el servicio.',
    maintenance: 'Estamos aplicando mejoras. Los servidores premium mantienen prioridad.',
    outage: 'Estamos investigando una incidencia y actualizaremos esta pagina en tiempo real.'
  })[state] ?? 'Todos los sistemas principales responden con normalidad.';
}

function statusLabel(state) {
  return ({
    operational: 'Operativo',
    degraded: 'Degradado',
    maintenance: 'Mantenimiento',
    outage: 'Incidencia'
  })[normalizeStatusState(state)] ?? 'Operativo';
}

function canEditStatusPage(req) {
  return Boolean(getAdminSession(req) || getSession(req)?.user?.id === GLOBAL_BLACKLIST_ADMIN_USER_ID);
}

function getStatusEditorName(req) {
  const admin = getAdminSession(req);
  if (admin) return 'Admin';
  const session = getSession(req);
  return session?.user?.username ?? '';
}

function buildPanelRequestPayload(req) {
  return {
    guildId: req.params.guildId,
    channelId: req.body.channelId,
    channelName: req.body.channelName,
    panelType: req.body.panelType,
    title: req.body.title || 'Soporte',
    description: req.body.description || 'Pulsa el boton para abrir un ticket.',
    buttonLabel: req.body.buttonLabel || 'Abrir ticket',
    buttonStyle: req.body.buttonStyle,
    buttonEmoji: req.body.buttonEmoji,
    ticketMode: req.body.ticketMode,
    embedColor: req.body.embedColor,
    authorName: req.body.authorName,
    authorIconUrl: req.body.authorIconUrl,
    footerText: req.body.footerText,
    imageUrl: req.body.imageUrl,
    thumbnailUrl: req.body.thumbnailUrl,
    ticketCategoryId: req.body.ticketCategoryId,
    ticketCategoryName: req.body.ticketCategoryName,
    exam: req.body.exam,
    selectPlaceholder: req.body.selectPlaceholder,
    componentIds: req.body.componentIds,
    welcomeMessage: req.body.welcomeMessage
  };
}

function buildEmptyDashboardStats() {
  return {
    totalGuilds: 0,
    configuredGuilds: 0,
    unconfiguredGuilds: 0,
    totalTickets: 0,
    openTickets: 0,
    closedTickets: 0,
    ticketsToday: 0,
    ticketsThisWeek: 0,
    panels: 0,
    transcriptMessages: 0,
    escalationReadyGuilds: 0,
    aiReadyGuilds: 0,
    securityReadyGuilds: 0,
    growthReadyGuilds: 0,
    welcomeReadyGuilds: 0,
    voiceRooms: 0,
    proGuilds: 0,
    feedbackCount: 0,
    averageRating: 0,
    promoterRate: 0,
    detractors: 0,
    promoters: 0
  };
}

function buildBotInviteUrl(config, guildId) {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.DISCORD_CLIENT_ID);
  url.searchParams.set('permissions', BOT_INVITE_PERMISSIONS);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('guild_id', guildId);
  url.searchParams.set('disable_guild_select', 'true');
  return url.toString();
}

function signSession(config, session) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function getSession(req) {
  return getSignedCookiePayload(req, 'nexadesk_session');
}

function getDocsSession(req) {
  const session = getSignedCookiePayload(req, 'nexadesk_docs');
  if (!session || session.scope !== 'docs') return null;
  if (!session.exp || Date.now() > session.exp) return null;
  return session;
}

function getAdminSession(req) {
  const session = getSignedCookiePayload(req, 'nexadesk_admin');
  if (!session || session.scope !== 'admin') return null;
  if (!session.exp || Date.now() > session.exp) return null;
  return session;
}

function getSignedCookiePayload(req, cookieName) {
  const value = req.signedCookies?.[cookieName];
  if (!value) return null;

  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;

  const expected = crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'dev-session-secret')
    .update(payload)
    .digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function setDocsSecurityHeaders(res) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(self), display-capture=()');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline' 'self'",
    "script-src 'unsafe-inline' 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; '));
}

function getRequestIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown')
    .split(',')[0]
    .trim();
}

function isDocsRateLimited(ip) {
  return isAuthRateLimited(docsAuthAttempts, ip);
}

function recordDocsFailure(ip) {
  recordAuthFailure(docsAuthAttempts, ip);
}

function clearDocsFailures(ip) {
  clearAuthFailures(docsAuthAttempts, ip);
}

function isAdminRateLimited(ip) {
  return isAuthRateLimited(adminAuthAttempts, ip);
}

function recordAdminFailure(ip) {
  recordAuthFailure(adminAuthAttempts, ip);
}

function clearAdminFailures(ip) {
  clearAuthFailures(adminAuthAttempts, ip);
}

function isRecentAdminCodeUse(record, ip) {
  if (!record?.usedAt || !record?.usedByIp) return false;
  if (String(record.usedByIp) !== String(ip)) return false;
  const usedAt = Date.parse(record.usedAt);
  if (!Number.isFinite(usedAt)) return false;
  return Date.now() - usedAt <= ADMIN_CODE_REPLAY_GRACE_MS;
}

function isAuthRateLimited(store, ip) {
  const entry = store.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    store.delete(ip);
    return false;
  }
  return entry.count >= 6;
}

function recordAuthFailure(store, ip) {
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  entry.count += 1;
}

function clearAuthFailures(store, ip) {
  store.delete(ip);
}

function adminCodeErrorMessage(reason) {
  if (reason === 'missing') return 'No hay ningun codigo activo. Genera uno con /code en Discord.';
  if (reason === 'expired') return 'Ese codigo ha caducado. Genera otro con /code en Discord.';
  if (reason === 'used') return 'Ese codigo ya se utilizo. Genera otro con /code en Discord.';
  if (reason === 'malformed') return 'El codigo debe tener 6 digitos. Puedes pegarlo con espacios, los limpio automaticamente.';
  if (reason === 'invalid') return 'El codigo guardado no es valido. Genera uno nuevo con /code en Discord.';
  return 'Codigo incorrecto. Copia el ultimo codigo activo generado con /code.';
}

async function buildDashboardAssistantReply({ config, message, guild, stats, activeView }) {
  const actions = suggestDashboardActions(message, guild);
  const fallback = buildDashboardAssistantFallback({ message, guild, stats, activeView, actions });

  if (actions.some((action) => action.type === 'fill')) {
    return fallback;
  }

  if (!config.GROQ_API_KEY || config.GROQ_API_KEY === 'replace_me') {
    return fallback;
  }

  try {
    const client = new GroqClient({
      apiKey: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
      visionModel: config.GROQ_VISION_MODEL
    });
    const reply = await Promise.race([
      client.generate({
      system: [
        'Eres el copiloto de la dashboard de NexaDesk.',
        'Responde en espanol claro, breve y accionable.',
        'Ayuda a configurar servidores Discord para tickets con IA, paneles, componentes, staff, voz Pro con STT/TTS, Modo examen, transcripciones, Security Guard, Growth Engine, Premium y mantenimiento global.',
        'La dashboard real tiene estas secciones: Resumen, Servidores, Configuracion, Componentes, Paneles, Crecimiento, Premium, Tickets y Logs.',
        'Posicionamiento clave: NexaDesk no sustituye sistemas de tickets; actua como capa IA compatible con Ticket King, XN Tickets, Guild Manager y paneles propios.',
        'En Configuracion se elige categoria, rol staff, prompt del servidor, informacion del servidor, canal/plantilla de alianzas y Security Guard.',
        'Descubrimiento inteligente escanea canales y detecta anuncios, normas, FAQ, soporte y categorias aunque usen tipografias raras.',
        'En Componentes se crean, editan y eliminan opciones del menu con preguntas previas, primer mensaje y modo Texto, Voz Pro, Modo examen o Solo staff (sin IA).',
        'En Paneles se publica, edita y elimina el embed, boton o menu en un canal de Discord; los botones tambien pueden abrir tickets de voz Pro o examenes.',
        'Para borrar paneles: Paneles > Paneles de este servidor > Eliminar panel. Para borrar componentes: Componentes > Componentes activos > Eliminar.',
        'Las imagenes de panel se suben desde el dispositivo en Paneles > Embed > Subir thumbnail/Subir imagen grande.',
        'En Crecimiento se gestionan valoraciones post-ticket, reviews publicas, canal de reviews y Churn Radar.',
        'En Premium se gestionan Voz Pro, Modo examen supervisado, IA prioritaria, transcripciones inteligentes, Security Plus, branding propio, informes semanales, Growth Engine, SLA Radar, Auto-config Pro, Alianzas Pro, Team Assist, analitica premium, Affiliate Boost y conversion insights por servidor.',
        'El sistema de afiliados usa /afiliado nombre para consultar tu username de afiliado y /afiliado server usuario:<USERNAME> para registrar quien recomendo NexaDesk en un servidor; cada 7 servidores desbloquean un slot Premium temporal.',
        'El modo mantenimiento se controla por slash command owner-only /mantenimiento o desde el panel oculto /admin; /admin se abre con codigo temporal emitido por /code a roles autorizados.',
        'Security Guard incluye anti-flood, anti-links IA, XN Protect Automod, anti-bots Top.gg, anti-alts y anti-nuke contra canales/config/webhooks, incluyendo bots personales o apps externas usados por usuarios.',
        'En Tickets se ven tickets y transcripciones guardadas.',
        'Si el usuario pide que tu metas algo, explica que puedes rellenar campos con botones de accion, pero el usuario debe revisar y guardar/publicar.',
        'No pidas IDs si la dashboard ya ofrece selectores de roles, canales y categorias.',
        'Si recomiendas navegar, menciona una seccion exacta: Resumen, Servidores, Configuracion, Componentes, Paneles, Crecimiento, Premium, Tickets o Logs.',
        'No inventes datos fuera del contexto recibido.'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `Pregunta: ${message}`,
            `Vista actual: ${activeView || 'overview'}`,
            `Servidor activo: ${guild ? JSON.stringify(summarizeGuildForAssistant(guild)) : 'ninguno'}`,
            `Stats: ${JSON.stringify(stats)}`
          ].join('\n')
        }
      ]
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Dashboard assistant timed out')), 8500))
    ]);

    return {
      reply: reply || fallback.reply,
      actions,
      source: 'groq'
    };
  } catch (error) {
    console.warn('Dashboard assistant fallback:', normalizeError(error));
    return fallback;
  }
}

function buildDashboardAssistantFallback({ message, guild, stats, activeView, actions }) {
  const lower = normalizeSearchText(message);
  const missing = guild ? getGuildMissingSteps(guild) : [];
  const fillAction = actions.find((action) => action.type === 'fill');
  let reply = 'Te guio desde aqui. ';

  if (!guild) {
    reply += 'Primero inicia sesion con Discord y selecciona un servidor gestionable.';
  } else if (fillAction) {
    reply += `Puedo hacerlo por ti desde aqui: pulsa "${fillAction.label}" y rellenare los campos correspondientes. Despues revisa el texto y guarda o publica.`;
  } else if ((lower.includes('eliminar') || lower.includes('borrar')) && lower.includes('panel')) {
    reply += 'Ve a Paneles y mira la tarjeta "Paneles de este servidor". Cada panel tiene "Editar panel enviado" y "Eliminar panel"; al eliminarlo NexaDesk intenta borrar tambien el mensaje de Discord.';
  } else if ((lower.includes('eliminar') || lower.includes('borrar') || lower.includes('editar')) && lower.includes('componente')) {
    reply += 'Ve a Componentes y mira "Componentes activos". Cada componente tiene botones de Editar y Eliminar; si esta usado por un menu, NexaDesk sincroniza los paneles cuando puede.';
  } else if (lower.includes('alianza') || lower.includes('plantilla')) {
    reply += 'Ve a Configuracion. Alli puedes elegir el canal de alianzas y pegar la plantilla completa del servidor con enters, emojis e invitaciones sin que se rompa como en un comando slash.';
  } else if (lower.includes('panel') || lower.includes('menu') || lower.includes('boton')) {
    reply += guild.components?.length
      ? 'Para publicar un panel, ve a Paneles, elige canal, modo boton o menu, sube imagenes desde el dispositivo si quieres y revisa la previsualizacion tipo Discord antes de publicar.'
      : 'Si quieres un menu desplegable, crea primero opciones en Componentes y despues publica el panel desde Paneles.';
  } else if (lower.includes('musica') || lower.includes('music') || lower.includes('cancion') || lower.includes('cola') || lower.includes('autocola') || lower.includes('dj')) {
    reply += 'El modulo de musica ya no forma parte de NexaDesk. La dashboard se centra en soporte, seguridad, voz Pro, paneles, alianzas, transcripciones y Premium.';
  } else if (lower.includes('crecimiento') || lower.includes('growth') || lower.includes('review') || lower.includes('valoracion') || lower.includes('reseña') || lower.includes('resena') || lower.includes('churn')) {
    reply += isPremiumEntitled(guild)
      ? 'Ve a Crecimiento para activar feedback por MD, elegir canal de reviews y convertir valoraciones altas en prueba social. Si activas Churn Radar, el staff recibe alertas cuando alguien queda insatisfecho.'
      : 'Ve a Crecimiento para preparar feedback post-ticket. Las reviews publicas y Churn Radar se desbloquean con Premium.';
  } else if (lower.includes('bienvenida') || lower.includes('welcome') || lower.includes('onboarding') || lower.includes('entrar al servidor') || lower.includes('nuevo miembro')) {
    reply += 'Ve a Bienvenida. Alli puedes activar un mensaje publico, un MD opcional y un rol automatico para miembros nuevos usando variables como {user}, {username} y {server}.';
  } else if (lower.includes('examen') || lower.includes('oposicion') || lower.includes('postulacion')) {
    reply += 'Para crear Modo examen, ve a Componentes o Paneles, elige "Modo examen" y pega preguntas en formato P:. En Free NexaDesk pregunta dentro del ticket. En Premium genera un formulario web propio de NexaDesk y puede abrir sala de voz para revision supervisada.';
  } else if (lower.includes('premium') || lower.includes('pro') || lower.includes('voz') || lower.includes('voice') || lower.includes('branding') || lower.includes('analitica') || lower.includes('insight')) {
    reply += isPremiumEntitled(guild)
      ? 'Ve a Premium para activar o pausar Voz Pro, Modo examen supervisado, IA prioritaria, transcripciones inteligentes, Security Plus, SLA Radar, Auto-config Pro, Alianzas Pro, Team Assist, Growth Engine, Affiliate Boost, branding e informes por servidor.'
      : 'Ve a Premium para ver que desbloquea el plan. El Modo examen con preguntas funciona desde paneles; la revision supervisada con formulario/sala se desbloquea con Premium.';
  } else if (lower.includes('seguridad') || lower.includes('security') || lower.includes('anti') || lower.includes('raid') || lower.includes('flood') || lower.includes('nuke') || lower.includes('phishing') || lower.includes('estafa') || lower.includes('links')) {
    reply += 'Ve a Configuracion y baja hasta Security Guard. Puedes activar nivel intermedio, Anti-links IA, XN Protect Automod, Anti-bots Top.gg, Anti-nuke de canales/config, elegir un canal de logs y guardar. Si Discord bloquea acciones, actualiza permisos desde el boton superior.';
  } else if (lower.includes('transcrip') || lower.includes('ticket')) {
    reply += 'En Tickets puedes abrir cada transcripcion guardada y descargarla en TXT. Si no aparecen tickets, abre uno desde un panel o una categoria configurada.';
  } else if (lower.includes('staff') || lower.includes('rol') || lower.includes('escalar')) {
    reply += 'Ve a Configuracion, selecciona el rol staff y guarda. Asi NexaDesk sabra a quien avisar cuando la IA necesite ayuda humana.';
  } else if (lower.includes('ia') || lower.includes('prompt') || lower.includes('contexto')) {
    reply += 'Ve a Configuracion y rellena el prompt del servidor con tono, limites, reglas y cuando pedir pruebas visuales o escalar.';
  } else if (missing.length) {
    reply += `El siguiente paso recomendado es ${missing[0].label.toLowerCase()}.`;
  } else {
    reply += `Tu configuracion pinta bien. Ahora revisaria actividad: ${stats.openTickets} tickets abiertos, ${stats.panels} paneles y ${stats.transcriptMessages} mensajes transcritos.`;
  }

  return {
    reply,
    actions,
    source: 'local'
  };
}

function suggestDashboardActions(message, guild) {
  const lower = normalizeSearchText(message);
  const actions = [];
  const add = (label, view, extra = {}) => {
    if (!actions.some((action) => action.label === label && action.view === view)) {
      actions.push({ label, view, ...extra });
    }
  };

  if (isFillPromptRequest(lower)) {
    add('Rellenar prompt recomendado', 'settings', {
      type: 'fill',
      toast: 'He rellenado un prompt recomendado. Revisalo y pulsa Guardar contexto y escalado.',
      fields: {
        serverPrompt: buildRecommendedServerPrompt(guild),
        serverInfo: buildRecommendedServerInfo(guild)
      }
    });
    add('Abrir Configuracion', 'settings');
  }

  if (isFillComponentRequest(lower)) {
    add('Rellenar componente base', 'components', {
      type: 'fill',
      toast: 'He preparado un componente base. Ajusta preguntas y pulsa Crear componente.',
      fields: {
        componentLabel: 'Soporte general',
        componentDescription: 'Ayuda para dudas, errores o solicitudes del servidor.',
        componentEmoji: '<a:Global:1499728413974593708>',
        componentTicketMode: lower.includes('voz') || lower.includes('voice') ? 'voice' : 'text',
        componentQuestions: 'Describe que necesitas\nAdjunta capturas o videos si hay un error visual\nQue resultado esperabas?',
        componentWelcomeMessage: 'Hola {user}, soy NexaDesk.\nHe guardado tus respuestas para que el staff tenga contexto. Voy a ayudarte con este ticket.'
      }
    });
    add('Crear Componentes', 'components');
  }

  if (isFillPanelRequest(lower)) {
    add('Rellenar panel profesional', 'panels', {
      type: 'fill',
      toast: 'He rellenado un panel profesional. Revisa canal/categoria y pulsa Publicar panel.',
      fields: {
        panelTitle: 'Centro de soporte',
        panelDescription: 'Abre un ticket y NexaDesk analizara tu caso con IA. Si hace falta, avisara al staff con un resumen claro.',
        panelButtonLabel: 'Abrir ticket',
        panelButtonEmoji: '<a:Global:1499728413974593708>',
        panelTicketMode: lower.includes('voz') || lower.includes('voice') ? 'voice' : 'text',
        panelFooterText: 'NexaDesk AI Support',
        panelWelcomeMessage: 'Hola {user}, soy NexaDesk.\nCuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.'
      }
    });
    add('Publicar Panel', 'panels');
  }

  if (isFillSecurityRequest(lower)) {
    add('Rellenar Security Guard', 'settings', {
      type: 'fill',
      toast: 'He preparado una configuracion de seguridad recomendada. Revisa y pulsa Guardar Security Guard.',
      fields: {
        securityEnabled: 'true',
        securityLevel: lower.includes('alto') || lower.includes('raid') ? 'high' : 'medium',
        securityMinAccountAgeDays: lower.includes('alto') || lower.includes('raid') ? '7' : '3',
        securityAntiFlood: 'true',
        securityAntiScamLinks: 'true',
        securityAntiOffensive: 'true',
        securityAntiBot: 'true',
        securityAntiAlt: 'true',
        securityAntiNuke: 'true'
      }
    });
    add('Abrir Configuracion', 'settings');
  }

  if (wantsAutofill(lower) && !actions.some((action) => action.type === 'fill')) {
    add('Rellenar prompt recomendado', 'settings', {
      type: 'fill',
      toast: 'He rellenado un prompt recomendado. Revisalo y pulsa Guardar contexto y escalado.',
      fields: {
        serverPrompt: buildRecommendedServerPrompt(guild),
        serverInfo: buildRecommendedServerInfo(guild)
      }
    });
    add('Abrir Configuracion', 'settings');
  }

  if (lower.includes('crecimiento') || lower.includes('growth') || lower.includes('review') || lower.includes('valoracion') || lower.includes('reseña') || lower.includes('resena') || lower.includes('churn')) add('Abrir Crecimiento', 'growth');
  if (lower.includes('bienvenida') || lower.includes('welcome') || lower.includes('onboarding') || lower.includes('entrar al servidor') || lower.includes('nuevo miembro')) add('Abrir Bienvenida', 'welcome');
  if (lower.includes('v1.5') || lower.includes('version') || lower.includes('video') || lower.includes('lanzamiento') || lower.includes('release') || lower.includes('novedad')) add('Abrir Premium', 'premium');
  if (lower.includes('premium') || lower.includes('pro') || lower.includes('voz') || lower.includes('voice') || lower.includes('branding') || lower.includes('analitica') || lower.includes('insight')) add('Abrir Premium', 'premium');
  if (lower.includes('examen') || lower.includes('oposicion') || lower.includes('postulacion')) {
    add('Crear examen', 'panels');
    add('Opciones de examen', 'components');
  }
  if (lower.includes('servidor') || lower.includes('invitar') || lower.includes('instalar')) add('Ir a Servidores', 'servers');
  if (lower.includes('ia') || lower.includes('prompt') || lower.includes('contexto') || lower.includes('staff') || lower.includes('rol') || lower.includes('seguridad') || lower.includes('security') || lower.includes('anti') || lower.includes('raid') || lower.includes('flood') || lower.includes('nuke') || lower.includes('phishing') || lower.includes('estafa') || lower.includes('links')) add('Abrir Configuracion', 'settings');
  if (lower.includes('componente') || lower.includes('pregunta') || lower.includes('menu')) add('Crear Componentes', 'components');
  if (lower.includes('panel') || lower.includes('boton') || lower.includes('publicar')) add('Publicar Panel', 'panels');
  if (lower.includes('ticket') || lower.includes('transcrip')) add('Ver Tickets', 'tickets');

  if (!actions.length && guild) {
    const missing = getGuildMissingSteps(guild);
    if (missing[0]) add(missing[0].actionLabel, missing[0].view);
  }

  if (!actions.length) {
    add('Ver Resumen', 'overview');
    add('Configurar Servidor', 'settings');
  }

  return actions.slice(0, 3);
}

function isFillPromptRequest(lower) {
  return wantsAutofill(lower) &&
    (lower.includes('prompt') || lower.includes('contexto') || lower.includes('ia'));
}

function isFillComponentRequest(lower) {
  return wantsAutofill(lower) &&
    (lower.includes('componente') || lower.includes('pregunta') || lower.includes('menu'));
}

function isFillPanelRequest(lower) {
  return wantsAutofill(lower) &&
    (lower.includes('panel') || lower.includes('embed') || lower.includes('boton'));
}

function isFillSecurityRequest(lower) {
  return wantsAutofill(lower) &&
    (lower.includes('seguridad') || lower.includes('security') || lower.includes('anti') || lower.includes('raid') || lower.includes('flood') || lower.includes('nuke'));
}

function wantsAutofill(lower) {
  return [
    'metelo',
    'mete',
    'meter',
    'ponlo',
    'pon',
    'rellena',
    'rellenalo',
    'hazlo',
    'crea',
    'crealo',
    'aplica'
  ].some((word) => lower.includes(word));
}

function buildRecommendedServerPrompt(guild = {}) {
  const guildName = guild?.guildName || 'este servidor';
  return [
    `Eres NexaDesk, el agente de soporte con IA de ${guildName}.`,
    'Responde siempre en el idioma del ultimo mensaje del usuario.',
    'Se claro, cercano y resolutivo. Haz una pregunta concreta si falta informacion.',
    'No inventes reglas, sanciones, precios ni informacion que no este en el contexto del servidor.',
    'Si el usuario pide staff humano, reporta amenazas, pagos, sanciones, datos sensibles o un caso que requiere permisos, escala al staff.',
    'Si el problema es visual, pide capturas, fotos o videos y usa esas pruebas antes de responder.',
    'Cuando escales, resume el caso para el staff en una frase clara y evita mencionar varias veces al rol.'
  ].join('\n');
}

function buildRecommendedServerInfo(guild = {}) {
  const guildName = guild?.guildName || 'Servidor';
  return [
    `Nombre del servidor: ${guildName}.`,
    'Objetivo: resolver tickets con IA y escalar a staff solo cuando haga falta.',
    'Buenas practicas: pedir contexto, revisar pruebas visuales si existen, mantener tono profesional y no cerrar tickets sin confirmacion.',
    'Completa aqui reglas, FAQs, horarios de soporte, enlaces importantes y politicas internas.'
  ].join('\n');
}

function getGuildMissingSteps(guild = {}) {
  const steps = [];
  if (!guild.installed) steps.push({ label: 'invitar NexaDesk al servidor', actionLabel: 'Invitar Bot', view: 'servers' });
  if (!guild.ticketCategoryId) steps.push({ label: 'elegir una categoria de tickets', actionLabel: 'Configurar Categoria', view: 'settings' });
  if (!guild.staffRoleId) steps.push({ label: 'asignar el rol de staff', actionLabel: 'Elegir Staff', view: 'settings' });
  if (!guild.serverPrompt && !guild.serverInfo) steps.push({ label: 'anadir contexto para la IA', actionLabel: 'Escribir Contexto IA', view: 'settings' });
  if (!normalizeSecurityConfig(guild.security).enabled) steps.push({ label: 'activar Security Guard', actionLabel: 'Configurar Seguridad', view: 'settings' });
  if (!normalizeWelcomeConfig(guild.welcome).enabled) steps.push({ label: 'activar Welcome Center', actionLabel: 'Configurar Bienvenida', view: 'welcome' });
  if (!(guild.components?.length)) steps.push({ label: 'crear componentes para menus', actionLabel: 'Crear Componentes', view: 'components' });
  if (!(guild.panels?.length)) steps.push({ label: 'publicar un panel de tickets', actionLabel: 'Publicar Panel', view: 'panels' });
  return steps;
}

function summarizeGuildForAssistant(guild = {}) {
  return {
    name: guild.guildName,
    installed: Boolean(guild.installed),
    configured: Boolean(guild.ticketCategoryId),
    hasStaffRole: Boolean(guild.staffRoleId),
    hasAiContext: Boolean(guild.serverPrompt || guild.serverInfo),
    security: summarizeSecurityConfig(normalizeSecurityConfig(guild.security)),
    growth: normalizeGrowthConfig(guild.growth),
    welcome: normalizeWelcomeConfig(guild.welcome),
    premium: summarizePremiumConfig(guild),
    panels: guild.panels?.length ?? 0,
    components: guild.components?.length ?? 0
  };
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function renderStatusPage({ snapshot, canEdit = false, editorName = '' }) {
  const initialSnapshot = toInlineJson(snapshot);
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Status</title>
  <link rel="icon" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#040404; --line:rgba(255,255,255,.14); --text:#f7f7f7; --muted:#a8a8a8; --ok:#7cff6b; --warn:#ffcf5a; --bad:#ff5f57; --blue:#9ed7ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--text); font-family:"Space Grotesk","Segoe UI",sans-serif; background:radial-gradient(circle at 18% 18%, rgba(255,255,255,.16), transparent 26%), radial-gradient(circle at 82% 4%, rgba(124,255,107,.12), transparent 22%), linear-gradient(135deg, #030303, #101010 45%, #030303); overflow-x:hidden; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px); background-size:72px 72px; mask-image:linear-gradient(to bottom, rgba(0,0,0,.9), rgba(0,0,0,.25)); animation:gridDrift 18s linear infinite; }
    body::after { content:""; position:fixed; width:48vw; height:48vw; right:-18vw; top:10vh; border:1px solid rgba(255,255,255,.18); border-radius:50%; pointer-events:none; box-shadow:0 0 90px rgba(255,255,255,.08), inset 0 0 90px rgba(255,255,255,.05); animation:orb 9s ease-in-out infinite alternate; }
    a { color:inherit; }
    .wrap { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:32px 0 54px; position:relative; z-index:1; }
    .topbar { display:flex; justify-content:space-between; align-items:center; gap:18px; margin-bottom:26px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:950; letter-spacing:-.04em; text-decoration:none; }
    .brand img { width:42px; height:42px; border:1px solid rgba(255,255,255,.18); border-radius:13px; padding:8px; background:#050505; box-shadow:0 0 34px rgba(255,255,255,.12); }
    .toplinks { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .pill,.toplinks a,.toplinks span { border:1px solid var(--line); border-radius:999px; padding:9px 12px; background:rgba(0,0,0,.34); color:#fff; text-decoration:none; font-size:13px; }
    .hero { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr); gap:18px; align-items:stretch; }
    .hero-card,.side-card,.component,.timeline,.editor { border:1px solid var(--line); border-radius:28px; background:linear-gradient(145deg, rgba(255,255,255,.09), rgba(255,255,255,.03)); box-shadow:0 28px 110px rgba(0,0,0,.38); backdrop-filter:blur(16px); }
    .hero-card { padding:30px; min-height:360px; position:relative; overflow:hidden; }
    .hero-card::after { content:""; position:absolute; right:-80px; bottom:-120px; width:320px; height:320px; border-radius:50%; border:1px solid rgba(255,255,255,.12); }
    .kicker { margin:0 0 14px; color:var(--muted); text-transform:uppercase; letter-spacing:.16em; font-size:12px; font-weight:900; }
    h1 { margin:0; font-size:clamp(46px, 8vw, 104px); line-height:.86; letter-spacing:-.08em; max-width:900px; }
    .headline { margin:20px 0 0; font-size:clamp(18px, 2.5vw, 27px); color:#eaeaea; max-width:760px; }
    .message { margin:12px 0 0; color:#bebebe; font-size:17px; line-height:1.65; max-width:820px; }
    .status-mark { display:inline-flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:10px 14px; background:rgba(0,0,0,.38); margin-bottom:22px; font-weight:950; }
    .dot { width:12px; height:12px; border-radius:50%; background:var(--ok); box-shadow:0 0 24px var(--ok); }
    .is-degraded .dot { background:var(--warn); box-shadow:0 0 24px var(--warn); }
    .is-maintenance .dot { background:var(--blue); box-shadow:0 0 24px var(--blue); }
    .is-outage .dot { background:var(--bad); box-shadow:0 0 24px var(--bad); }
    .side-card { padding:24px; display:grid; gap:14px; }
    .metric-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .metric { border:1px solid rgba(255,255,255,.12); border-radius:18px; padding:14px; background:rgba(0,0,0,.26); }
    .metric span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.11em; }
    .metric strong { display:block; margin-top:8px; font-size:30px; letter-spacing:-.06em; }
    .leader { border:1px dashed rgba(255,255,255,.22); border-radius:18px; padding:14px; color:#ddd; }
    .leader strong { display:block; color:#fff; margin-bottom:6px; }
    .section-title { display:flex; justify-content:space-between; align-items:end; gap:16px; margin:30px 0 14px; }
    .section-title h2 { margin:0; font-size:28px; letter-spacing:-.05em; }
    .section-title p { margin:0; color:var(--muted); }
    .components { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; }
    .component { padding:16px; min-height:150px; display:grid; align-content:space-between; }
    .component strong { font-size:17px; }
    .component p { color:var(--muted); margin:10px 0 0; line-height:1.45; }
    .badge { width:max-content; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:7px 9px; font-size:12px; font-weight:950; }
    .badge.operational { color:var(--ok); } .badge.degraded { color:var(--warn); } .badge.maintenance { color:var(--blue); } .badge.outage { color:var(--bad); }
    .timeline { padding:18px; }
    .update { display:grid; grid-template-columns:120px minmax(0,1fr); gap:16px; padding:16px 0; border-bottom:1px solid rgba(255,255,255,.1); }
    .update:last-child { border-bottom:0; }
    .update time { color:var(--muted); font-size:13px; }
    .update h3 { margin:0 0 6px; }
    .update p { margin:0; color:#c7c7c7; line-height:1.55; }
    .editor { margin-top:24px; padding:20px; display:${canEdit ? 'block' : 'none'}; }
    .editor-grid { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); gap:16px; }
    label { display:grid; gap:7px; color:#d7d7d7; font-size:13px; font-weight:800; }
    input,select,textarea { width:100%; border:1px solid rgba(255,255,255,.16); border-radius:14px; padding:12px 13px; background:#050505; color:#fff; font:inherit; }
    textarea { min-height:112px; resize:vertical; }
    button { border:0; border-radius:999px; padding:12px 16px; font-weight:950; cursor:pointer; background:#fff; color:#000; }
    .component-editor { display:grid; grid-template-columns:1fr 150px; gap:8px; margin-bottom:8px; }
    .muted { color:var(--muted); }
    .toast { position:fixed; right:18px; bottom:18px; border:1px solid rgba(255,255,255,.18); border-radius:18px; background:rgba(0,0,0,.9); color:#fff; padding:13px 15px; opacity:0; transform:translateY(12px); transition:.18s ease; z-index:3; }
    .toast.show { opacity:1; transform:translateY(0); }
    @keyframes gridDrift { from { background-position:0 0; } to { background-position:72px 72px; } }
    @keyframes orb { from { transform:translate3d(0,0,0) scale(1); } to { transform:translate3d(-20px,18px,0) scale(1.05); } }
    @media (max-width:980px) { .hero,.editor-grid { grid-template-columns:1fr; } .components { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:620px) { .wrap { width:min(100% - 20px,1180px); padding-top:18px; } .topbar,.section-title { align-items:flex-start; flex-direction:column; } .components,.metric-grid { grid-template-columns:1fr; } .hero-card,.side-card { border-radius:22px; padding:20px; } .update { grid-template-columns:1fr; gap:6px; } h1 { font-size:52px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <a class="brand" href="/"><img src="/assets/nexadesk-logo.svg" alt="">NexaDesk</a>
      <nav class="toplinks">
        <span id="livePill">Live conectado</span>
        ${canEdit ? `<span>Editor: ${escapeHtml(editorName || 'owner')}</span>` : '<a href="/login">Login owner</a><a href="/admin">Admin code</a>'}
      </nav>
    </header>
    <section class="hero">
      <article class="hero-card" id="heroCard">
        <div class="status-mark"><span class="dot"></span><span id="stateLabel">Operativo</span></div>
        <p class="kicker">Estado publico</p>
        <h1 id="statusHeadline">NexaDesk esta operativo</h1>
        <p class="headline" id="statusMessage">Todos los sistemas principales responden con normalidad.</p>
        <p class="message">Actualizado <span id="updatedAt">ahora</span> por <span id="updatedBy">NexaDesk</span>.</p>
      </article>
      <aside class="side-card">
        <div><p class="kicker">Runtime</p><h2 style="margin:0;font-size:34px;letter-spacing:-.06em;">Pulso del bot</h2></div>
        <div class="metric-grid">
          <div class="metric"><span>Servidores</span><strong id="metricGuilds">0</strong></div>
          <div class="metric"><span>Tickets abiertos</span><strong id="metricTickets">0</strong></div>
          <div class="metric"><span>Premium</span><strong id="metricPremium">0</strong></div>
          <div class="metric"><span>Uptime</span><strong id="metricUptime">0m</strong></div>
        </div>
        <div class="leader"><strong id="leaderTitle">Lider HA</strong><span id="leaderDetail">Calculando lease...</span></div>
      </aside>
    </section>
    <div class="section-title"><div><h2>Componentes</h2><p>Estado de cada pieza importante de NexaDesk.</p></div><span class="pill" id="generatedAt">Snapshot inicial</span></div>
    <section class="components" id="components"></section>
    <div class="section-title"><div><h2>Mensajes</h2><p>Comunicados publicos del owner, incidentes y mantenimientos.</p></div></div>
    <section class="timeline" id="updates"></section>
    <section class="editor" id="statusEditor">
      <div class="section-title" style="margin-top:0;"><div><h2>Editar estado</h2><p>Los cambios se publican en tiempo real.</p></div></div>
      <div class="editor-grid">
        <form id="stateForm">
          <label>Estado<select id="editState"><option value="operational">Operativo</option><option value="degraded">Degradado</option><option value="maintenance">Mantenimiento</option><option value="outage">Incidencia</option></select></label><br>
          <label>Titulo<input id="editHeadline" maxlength="90" placeholder="NexaDesk esta operativo"></label><br>
          <label>Mensaje publico<textarea id="editMessage" maxlength="700" placeholder="Explica que esta pasando..."></textarea></label><br>
          <div id="componentEditor"></div>
          <button type="submit">Publicar estado</button>
        </form>
        <form id="messageForm">
          <label>Tipo de mensaje<select id="messageLevel"><option value="operational">Info</option><option value="degraded">Aviso</option><option value="maintenance">Mantenimiento</option><option value="outage">Incidencia</option></select></label><br>
          <label>Titulo del mensaje<input id="messageTitle" maxlength="80" placeholder="Actualizacion"></label><br>
          <label>Mensaje<textarea id="messageBody" maxlength="600" placeholder="Escribe un comunicado para todos..."></textarea></label><br>
          <button type="submit">Añadir mensaje</button>
          <p class="muted">Consejo: usa mensajes cortos y claros. Si hay una incidencia, di que esta pasando, impacto y proximo update.</p>
        </form>
      </div>
    </section>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const canEdit = ${canEdit ? 'true' : 'false'};
    let snapshot = ${initialSnapshot};
    const labels = { operational:'Operativo', degraded:'Degradado', maintenance:'Mantenimiento', outage:'Incidencia' };
    const $ = (id) => document.getElementById(id);
    const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const fmt = (value) => value ? new Date(value).toLocaleString('es-ES') : 'Sin datos';
    const uptime = (seconds) => { const value = Number(seconds || 0); if (value > 86400) return Math.floor(value / 86400) + 'd'; if (value > 3600) return Math.floor(value / 3600) + 'h'; return Math.max(0, Math.floor(value / 60)) + 'm'; };
    function toast(message) { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(window.__statusToast); window.__statusToast = setTimeout(() => node.classList.remove('show'), 2400); }
    function render(next) {
      snapshot = next || snapshot;
      const status = snapshot.status || {};
      const state = status.state || 'operational';
      $('heroCard').className = 'hero-card is-' + state;
      $('stateLabel').textContent = labels[state] || 'Operativo';
      $('statusHeadline').textContent = status.headline || 'NexaDesk esta operativo';
      $('statusMessage').textContent = status.message || '';
      $('updatedAt').textContent = fmt(status.updatedAt);
      $('updatedBy').textContent = status.updatedBy || 'NexaDesk';
      $('generatedAt').textContent = 'Actualizado ' + fmt(snapshot.generatedAt);
      $('metricGuilds').textContent = snapshot.metrics?.installedGuilds ?? 0;
      $('metricTickets').textContent = snapshot.metrics?.openTickets ?? 0;
      $('metricPremium').textContent = snapshot.metrics?.premiumGuilds ?? 0;
      $('metricUptime').textContent = uptime(snapshot.runtime?.uptimeSeconds);
      $('leaderTitle').textContent = snapshot.leader?.alive ? 'Lider HA activo' : 'Lease sin lider activo';
      $('leaderDetail').textContent = snapshot.leader?.ownerId ? snapshot.leader.ownerId + ' · expira ' + fmt(snapshot.leader.expiresAt) : 'Esperando worker principal o standby.';
      $('components').innerHTML = (status.components || []).map((item) => '<article class="component"><div><strong>' + html(item.name) + '</strong><p>' + html(item.detail) + '</p></div><span class="badge ' + html(item.state) + '">' + html(labels[item.state] || item.state) + '</span></article>').join('');
      $('updates').innerHTML = (status.updates || []).length ? status.updates.map((item) => '<article class="update"><time>' + html(fmt(item.createdAt)) + '</time><div><span class="badge ' + html(item.level) + '">' + html(labels[item.level] || item.level) + '</span><h3>' + html(item.title) + '</h3><p>' + html(item.message) + '</p><p class="muted">Por ' + html(item.createdBy || 'NexaDesk') + '</p></div></article>').join('') : '<p class="muted">Sin comunicados recientes. Si todo esta tranquilo, esto es buena señal.</p>';
      if (canEdit) hydrateEditor(status);
    }
    function hydrateEditor(status) {
      if (document.activeElement && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
      $('editState').value = status.state || 'operational';
      $('editHeadline').value = status.headline || '';
      $('editMessage').value = status.message || '';
      $('componentEditor').innerHTML = (status.components || []).map((item, index) => '<div class="component-editor"><input data-comp-name="' + index + '" value="' + html(item.name) + '" maxlength="44"><select data-comp-state="' + index + '"><option value="operational">Operativo</option><option value="degraded">Degradado</option><option value="maintenance">Mantenimiento</option><option value="outage">Incidencia</option></select></div><input data-comp-detail="' + index + '" value="' + html(item.detail) + '" maxlength="120" style="margin-bottom:10px;">').join('');
      (status.components || []).forEach((item, index) => { const select = document.querySelector('[data-comp-state="' + index + '"]'); if (select) select.value = item.state || 'operational'; });
    }
    function readComponents() { return Array.from(document.querySelectorAll('[data-comp-name]')).map((input) => { const index = input.getAttribute('data-comp-name'); return { name:input.value, state:document.querySelector('[data-comp-state="' + index + '"]')?.value || 'operational', detail:document.querySelector('[data-comp-detail="' + index + '"]')?.value || '' }; }); }
    async function postJson(url, body) {
      const response = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, credentials:'same-origin', body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo guardar.');
      const fresh = await fetch('/status/api', { credentials:'same-origin' }).then((item) => item.json());
      render(fresh);
      return data;
    }
    if (canEdit) {
      $('stateForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await postJson('/status/api', { state:$('editState').value, headline:$('editHeadline').value, message:$('editMessage').value, components:readComponents() }); toast('Estado publicado.'); } catch (error) { toast(error.message); } });
      $('messageForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await postJson('/status/api/messages', { level:$('messageLevel').value, title:$('messageTitle').value, message:$('messageBody').value }); $('messageBody').value = ''; toast('Mensaje añadido.'); } catch (error) { toast(error.message); } });
    }
    render(snapshot);
    const source = new EventSource('/status/events');
    source.addEventListener('status.update', (event) => render(JSON.parse(event.data)));
    source.addEventListener('status.ready', (event) => render(JSON.parse(event.data)));
    source.addEventListener('error', () => { $('livePill').textContent = 'Reconectando live'; });
    source.addEventListener('open', () => { $('livePill').textContent = 'Live conectado'; });
  </script>
</body>
</html>`;
}

function renderDocsDisabled(config) {
  return renderDocsShell({
    title: 'NexaDesk Docs bloqueado',
    body: `
      <main class="gate">
        <img src="/assets/nexadesk-logo.svg" alt="NexaDesk" class="gate-logo">
        <p class="kicker">NexaDesk internal vault</p>
        <h1>Docs aun no esta configurado.</h1>
        <p>Define <code>DOCS_TOTP_SECRET</code> en el .env de la Raspberry Pi para activar el acceso con Google Authenticator.</p>
        <div class="notice">
          <strong>Setup recomendado</strong>
          <span>Genera un secreto base32 privado, guardalo como variable de entorno y anadelo manualmente a Google Authenticator con issuer <code>${escapeHtml(config.DOCS_TOTP_ISSUER)}</code>.</span>
        </div>
      </main>
    `
  });
}

function renderDocsGate({ config, error = '' }) {
  return renderDocsShell({
    title: 'NexaDesk Docs',
    accessGate: {
      title: 'Verificando vault privada',
      copy: 'Comprobando entorno seguro y acceso con codigo dinamico.',
      brandCopy: 'Abriendo la documentacion interna de NexaDesk.'
    },
    body: `
      <main class="gate">
        <img src="/assets/nexadesk-logo.svg" alt="NexaDesk" class="gate-logo">
        <p class="kicker">Acceso interno</p>
        <h1>Introduce el codigo Dinamico</h1>
        <p>Codigo de 6 digitos generado por Google Authenticator. No hay enlace en la dashboard y la sesion caduca en ${escapeHtml(String(config.DOCS_SESSION_MINUTES))} minutos.</p>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/docs" class="totp-form" autocomplete="off">
          <label>
            Codigo dinamico
            <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" autocomplete="one-time-code" autofocus required>
          </label>
          <button type="submit">Entrar a docs</button>
        </form>
        <div class="notice">
          <strong>Proteccion activa</strong>
          <span>Docs usa TOTP, sesion separada, noindex, no-cache, marca de agua, bloqueo de impresion y defensas anti-copia. Ninguna web puede bloquear al 100% una captura del sistema operativo.</span>
        </div>
      </main>
    `,
    script: renderDocsProtectionScript()
  });
}

function renderAdminDisabled(config) {
  return renderDocsShell({
    title: 'NexaDesk Admin bloqueado',
    body: `
      <main class="gate">
        <img src="/assets/nexadesk-logo.svg" alt="NexaDesk" class="gate-logo">
        <p class="kicker">NexaDesk command room</p>
        <h1>Admin aun no esta configurado.</h1>
        <p>Usa <code>/code</code> en Discord con el rol autorizado. El bot pedira a la web que emita un codigo temporal de acceso.</p>
        <div class="notice">
          <strong>Ruta oculta</strong>
          <span>El panel vive en <code>/admin</code>, no aparece en la dashboard principal y sus APIs requieren sesion firmada.</span>
        </div>
      </main>
    `
  });
}

function renderAdminGate({ config, error = '', codeStatus = null }) {
  const status = codeStatus ?? getAdminAccessCodeStatus(null);
  const statusText = renderAdminCodeStatus(status);
  return renderDocsShell({
    title: 'NexaDesk Admin',
    accessGate: {
      title: 'Verificando command room',
      copy: 'Comprobando codigo de rotacion y sesion admin.',
      brandCopy: 'Entrando al panel global de control.'
    },
    body: `
      <main class="gate">
        <img src="/assets/nexadesk-logo.svg" alt="NexaDesk" class="gate-logo">
        <p class="kicker">Panel oculto</p>
        <h1>Introduce el codigo de rotacion</h1>
        <p>Pide un codigo temporal con <code>/code</code> en Discord. La web lo emite y el bot solo lo solicita, asi mantenemos la validacion en la misma Raspberry Pi. Esta sesion caduca en ${escapeHtml(String(config.DOCS_SESSION_MINUTES))} minutos.</p>
        <div class="notice">
          <strong>${escapeHtml(status.label)}</strong>
          <span>${escapeHtml(statusText)}</span>
        </div>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/admin" class="totp-form" autocomplete="off" data-admin-code-form>
          <label>
            Codigo de rotacion
            <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" autocomplete="one-time-code" autofocus required>
          </label>
          <button type="submit">Entrar al admin</button>
        </form>
        <div class="notice">
          <strong>Sin acceso publico</strong>
          <span>El codigo dura 10 minutos, lo emite la web, se guarda hasheado, se cifra para poder repetirlo al mismo emisor mientras esta activo, se invalida al primer uso y protege endpoints internos bajo <code>/admin/api</code>.</span>
        </div>
      </main>
    `,
    script: renderAdminCodeSubmitScript()
  });
}

function renderAdminCodeSubmitScript() {
  return `<script>
    document.querySelectorAll('[data-admin-code-form]').forEach((form) => {
      let submitted = false;
      form.addEventListener('submit', (event) => {
        if (submitted) {
          event.preventDefault();
          return;
        }
        submitted = true;
        const button = form.querySelector('button[type="submit"]');
        if (button) {
          button.disabled = true;
          button.textContent = 'Entrando...';
        }
      });
    });
  </script>`;
}

function renderAdminCodeStatus(status) {
  if (!status || status.state === 'missing') return 'Ejecuta /code en Discord para crear un codigo nuevo.';
  if (status.state === 'active') {
    const expiresAt = status.expiresAt ? new Date(status.expiresAt).toLocaleString('es-ES') : 'pronto';
    const minutes = Math.max(1, Math.ceil((status.secondsRemaining ?? 0) / 60));
    const author = status.createdByTag ? ` Emitido por ${status.createdByTag}.` : '';
    return `Hay un codigo activo durante unos ${minutes} min. Expira: ${expiresAt}.${author}`;
  }
  if (status.state === 'used') return 'El ultimo codigo ya se uso. Ejecuta /code para generar uno nuevo.';
  if (status.state === 'expired') return 'El ultimo codigo expiro. Ejecuta /code para generar uno nuevo.';
  return 'El codigo guardado no se puede validar. Ejecuta /code para regenerarlo.';
}

function renderAdminPanel({ config, session, snapshot }) {
  const issuedAt = session.iat ? new Date(session.iat).toLocaleString('es-ES') : 'sesion actual';
  const expiresAt = session.exp ? new Date(session.exp).toLocaleString('es-ES') : 'pronto';
  const initialSnapshot = toInlineJson(snapshot);

  return renderDocsShell({
    title: 'NexaDesk Admin',
    body: `
      <main class="vault admin-vault" id="adminPanel">
        <style>
          .admin-vault { width:min(1500px, calc(100% - 26px)); }
          .admin-vault h1 { max-width:900px; }
          .admin-topline { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; }
          .admin-pill { border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:8px 11px; color:#fff; background:rgba(255,255,255,.055); font-weight:850; }
          .admin-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; margin:16px 0; }
          .admin-card,.admin-control,.admin-table-card { border:1px solid var(--line); border-radius:20px; background:linear-gradient(145deg, rgba(255,255,255,.075), rgba(255,255,255,.025)); box-shadow:0 24px 90px rgba(0,0,0,.26); }
          .admin-card { padding:16px; min-height:112px; position:relative; overflow:hidden; }
          .admin-card::after { content:""; position:absolute; right:-24px; bottom:-24px; width:96px; height:96px; border:1px solid rgba(255,255,255,.16); border-radius:28px; transform:rotate(18deg); }
          .admin-card span { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.12em; color:#bdbdbd; }
          .admin-card strong { display:block; margin-top:10px; font-size:clamp(26px, 4vw, 42px); color:#fff; line-height:1; }
          .admin-card small { display:block; margin-top:8px; color:#aaa; }
          .admin-control { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(320px,.8fr); gap:16px; padding:18px; margin-bottom:16px; }
          .admin-vault input,.admin-vault textarea,.admin-vault select { width:100%; border-radius:14px; border:1px solid rgba(255,255,255,.18); padding:12px 13px; background:#060606; color:#fff; font:inherit; letter-spacing:normal; text-align:left; }
          .admin-vault textarea { min-height:116px; resize:vertical; }
          .admin-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
          .admin-buttons { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:12px; }
          .admin-buttons button,.admin-action { border-radius:999px; padding:11px 14px; border:1px solid rgba(255,255,255,.2); }
          .admin-buttons .danger { background:#1b0505; color:#fff; border-color:rgba(255,95,87,.42); }
          .admin-layout { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.45fr); gap:16px; }
          .admin-stack { display:grid; gap:16px; }
          .admin-table-card { overflow:hidden; }
          .admin-table-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:16px; border-bottom:1px solid rgba(255,255,255,.1); }
          .admin-table-head h2 { font-size:21px; }
          .admin-table-head span { font-size:13px; }
          .admin-table-scroll { overflow:auto; max-height:430px; }
          .admin-table-card table { min-width:760px; }
          .admin-feed { display:grid; gap:8px; padding:14px; max-height:430px; overflow:auto; }
          .admin-feed-item { border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:11px; background:rgba(0,0,0,.32); }
          .admin-feed-item strong { display:block; color:#fff; }
          .admin-feed-item span { font-size:12px; }
          .admin-status { display:inline-flex; align-items:center; gap:8px; color:#fff; }
          .admin-status::before { content:""; width:9px; height:9px; border-radius:50%; background:#7cff6b; box-shadow:0 0 18px rgba(124,255,107,.7); }
          .admin-status.is-off::before { background:#ff5f57; box-shadow:0 0 18px rgba(255,95,87,.7); }
          .admin-toast { position:fixed; right:18px; bottom:18px; z-index:10001; max-width:420px; border:1px solid rgba(255,255,255,.18); border-radius:18px; padding:14px 16px; background:rgba(8,8,8,.94); color:#fff; box-shadow:0 24px 90px rgba(0,0,0,.44); opacity:0; transform:translateY(12px); pointer-events:none; transition:.18s ease; }
          .admin-toast.is-visible { opacity:1; transform:translateY(0); }
          @media (max-width:1050px) {
            .admin-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
            .admin-control,.admin-layout { grid-template-columns:1fr; }
          }
          @media (max-width:640px) {
            .admin-grid,.admin-form-grid { grid-template-columns:1fr; }
            .admin-table-head { align-items:flex-start; flex-direction:column; }
          }
        </style>
        <section class="vault-hero">
          <div>
            <p class="kicker">NexaDesk command room</p>
            <h1>Panel admin global</h1>
            <p>Vista oculta para operar NexaDesk en tiempo real: servidores, tickets, feedback, blacklist, runtime y modo mantenimiento.</p>
            <div class="admin-topline">
              <span class="admin-pill" id="adminLiveState">Live conectado</span>
              <span class="admin-pill">Ruta no enlazada</span>
              <span class="admin-pill">Codigo /code</span>
            </div>
          </div>
          <aside>
            <strong>Sesion admin</strong>
            <span>Inicio: ${escapeHtml(issuedAt)}</span>
            <span>Caduca: ${escapeHtml(expiresAt)}</span>
            <a href="/admin/logout">Cerrar admin</a>
          </aside>
        </section>

        <section class="vault-warning">
          <strong>Operacion sensible</strong>
          <span>No compartas capturas de esta pantalla. El panel no revela secretos de entorno, pero si muestra datos operativos globales del bot.</span>
        </section>

        <section class="admin-grid" id="adminStats"></section>

        <section class="admin-control">
          <div>
            <p class="kicker">Mantenimiento global</p>
            <h2>Control de velocidad Free</h2>
            <p>Cuando esta activo, NexaDesk avisa al abrir tickets y ralentiza solo servidores sin Premium. Premium mantiene prioridad normal.</p>
            <div class="admin-form-grid">
              <label>
                Estado
                <select id="maintenanceEnabled">
                  <option value="false">Desactivado</option>
                  <option value="true">Activado</option>
                </select>
              </label>
              <label>
                Delay para Free (segundos)
                <input id="maintenanceDelay" type="number" min="0.5" max="15" step="0.5" value="3.5">
              </label>
            </div>
            <label style="margin-top:12px">
              Mensaje para servidores Free
              <textarea id="maintenanceMessage" placeholder="NexaDesk esta en mantenimiento global..."></textarea>
            </label>
            <div class="admin-buttons">
              <button type="button" id="activateMaintenance">Activar mantenimiento</button>
              <button type="button" class="danger" id="disableMaintenance">Desactivar</button>
              <span id="maintenanceMeta">Sin cambios recientes.</span>
            </div>
          </div>
          <div class="admin-card">
            <span>Estado actual</span>
            <strong id="maintenanceLabel">...</strong>
            <small id="maintenanceDetails">Cargando estado.</small>
          </div>
        </section>

        <section class="admin-control">
          <div>
            <p class="kicker">Dashboard maintenance</p>
            <h2>Bloqueo visual de la web Free</h2>
            <p>Cuando esta activo, la dashboard principal muestra una pantalla de mantenimiento con juego. Usuarios con servidores Premium mantienen acceso prioritario; /admin, /docs, /status y paginas de gestion siguen disponibles.</p>
            <label style="margin-top:12px">
              Mensaje visible en la pantalla de mantenimiento
              <textarea id="dashboardMaintenanceMessage" placeholder="Estamos reforzando la dashboard..."></textarea>
            </label>
            <div class="admin-buttons">
              <button type="button" id="activateDashboardMaintenance">Activar web maintenance</button>
              <button type="button" class="danger" id="disableDashboardMaintenance">Desactivar</button>
              <span id="dashboardMaintenanceMeta">Sin cambios recientes.</span>
            </div>
          </div>
          <div class="admin-card">
            <span>Dashboard actual</span>
            <strong id="dashboardMaintenanceLabel">...</strong>
            <small id="dashboardMaintenanceDetails">Cargando estado.</small>
          </div>
        </section>

        <section class="admin-layout">
          <div class="admin-stack">
            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Realtime</p>
                  <h2>Eventos recientes</h2>
                </div>
                <span id="lastUpdate">Esperando snapshot...</span>
              </div>
              <div class="admin-feed" id="adminFeed"></div>
            </article>

            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Trust</p>
                  <h2>Blacklist interna</h2>
                </div>
                <span id="blacklistCount">0 entradas</span>
              </div>
              <div class="admin-table-scroll">
                <table>
                  <thead><tr><th>Usuario</th><th>Estado</th><th>Motivo</th><th>Expira</th></tr></thead>
                  <tbody id="blacklistRows"></tbody>
                </table>
              </div>
            </article>
          </div>

          <div class="admin-stack">
            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Servidores</p>
                  <h2>Configuracion global</h2>
                </div>
                <span id="guildCount">0 servidores</span>
              </div>
              <div class="admin-table-scroll">
                <table>
                  <thead><tr><th>Servidor</th><th>Estado</th><th>Premium</th><th>Security</th><th>Paneles</th></tr></thead>
                  <tbody id="guildRows"></tbody>
                </table>
              </div>
            </article>

            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Tickets</p>
                  <h2>Ultimos tickets</h2>
                </div>
                <span id="ticketCount">0 tickets</span>
              </div>
              <div class="admin-table-scroll">
                <table>
                  <thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Usuario</th><th>Creado</th></tr></thead>
                  <tbody id="ticketRows"></tbody>
                </table>
              </div>
            </article>

            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Growth</p>
                  <h2>Feedback reciente</h2>
                </div>
                <span id="feedbackCount">0 ratings</span>
              </div>
              <div class="admin-table-scroll">
                <table>
                  <thead><tr><th>Rating</th><th>Servidor</th><th>Ticket</th><th>Comentario</th><th>Fecha</th></tr></thead>
                  <tbody id="feedbackRows"></tbody>
                </table>
              </div>
            </article>

            <article class="admin-table-card">
              <div class="admin-table-head">
                <div>
                  <p class="kicker">Quality Radar</p>
                  <h2>Quejas sobre la IA</h2>
                </div>
                <span id="aiQualityCount">0 senales</span>
              </div>
              <div class="admin-table-scroll">
                <table>
                  <thead><tr><th>Severidad</th><th>Categoria</th><th>Usuario</th><th>Mensaje</th><th>Motivo</th><th>Fecha</th></tr></thead>
                  <tbody id="aiQualityRows"></tbody>
                </table>
              </div>
            </article>
          </div>
        </section>
        <div class="admin-toast" id="adminToast"></div>
      </main>
    `,
    script: renderAdminPanelScript(initialSnapshot)
  });
}

function renderOwnerReleasePanel({ session, releaseState }) {
  const pendingFeatures = releaseState.pendingFeatures ?? [];
  const manualItems = releaseState.manualPendingItems ?? [];
  const history = releaseState.launchHistory ?? [];
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Owner Release Center</title>
  <style>
    :root { color-scheme:dark; --bg:#030303; --card:rgba(255,255,255,.055); --line:rgba(255,255,255,.16); --text:#f7f7f7; --muted:#a8a8a8; --gold:#e8c66a; --ok:#8dffb2; --bad:#ff7777; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:radial-gradient(circle at 22% 0%, rgba(255,255,255,.13), transparent 30%), repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 82px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 82px), var(--bg); }
    main { width:min(1180px, calc(100vw - 28px)); margin:0 auto; padding:34px 0 48px; }
    .hero { min-height:260px; border:1px solid var(--line); border-radius:34px; padding:34px; background:linear-gradient(135deg, rgba(255,255,255,.10), rgba(255,255,255,.025)); box-shadow:0 24px 80px rgba(0,0,0,.42); position:relative; overflow:hidden; }
    .hero:after { content:""; position:absolute; inset:auto -10% -50% 45%; height:270px; background:radial-gradient(circle, rgba(232,198,106,.23), transparent 62%); filter:blur(6px); }
    .eyebrow { color:var(--gold); text-transform:uppercase; letter-spacing:.22em; font-size:12px; font-weight:900; }
    h1 { margin:14px 0 10px; font-size:clamp(38px, 7vw, 82px); line-height:.9; letter-spacing:-.07em; max-width:820px; }
    p { color:var(--muted); line-height:1.65; }
    .hero p { max-width:720px; font-size:18px; }
    .actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:24px; }
    button, a.button { border:0; border-radius:16px; padding:14px 18px; font-weight:950; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; color:#050505; background:#fff; transition:transform .18s ease, box-shadow .18s ease; }
    button:hover, a.button:hover { transform:translateY(-2px); box-shadow:0 18px 48px rgba(255,255,255,.12); }
    .secondary { background:rgba(255,255,255,.08); border:1px solid var(--line); color:var(--text); }
    .danger { background:linear-gradient(135deg, var(--gold), #fff1ad); color:#080808; }
    .grid { display:grid; grid-template-columns:1.1fr .9fr; gap:18px; margin-top:18px; }
    .card { border:1px solid var(--line); border-radius:26px; padding:22px; background:var(--card); backdrop-filter:blur(18px); box-shadow:0 18px 54px rgba(0,0,0,.25); }
    .card h2 { margin:0 0 8px; font-size:25px; letter-spacing:-.04em; }
    .list { display:grid; gap:12px; margin-top:16px; }
    .item { padding:14px; border:1px solid rgba(255,255,255,.12); border-radius:18px; background:rgba(0,0,0,.2); }
    .item strong { display:block; font-size:16px; margin-bottom:4px; }
    .item small { color:var(--muted); }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.08); border-radius:999px; padding:7px 10px; color:#d8d8d8; font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; margin-top:8px; }
    .status { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:22px; }
    .stat { border:1px solid var(--line); border-radius:18px; padding:14px; background:rgba(0,0,0,.2); }
    .stat span { color:var(--muted); display:block; font-size:12px; text-transform:uppercase; letter-spacing:.12em; font-weight:900; }
    .stat strong { display:block; margin-top:4px; font-size:28px; }
    form { display:grid; gap:12px; margin-top:12px; }
    label { display:grid; gap:7px; color:#d8d8d8; font-weight:800; }
    input, textarea, select { width:100%; border:1px solid var(--line); border-radius:16px; background:rgba(0,0,0,.42); color:var(--text); padding:13px 14px; font:inherit; outline:none; }
    textarea { min-height:120px; resize:vertical; }
    .toast { position:fixed; right:18px; bottom:18px; max-width:360px; border:1px solid var(--line); border-radius:18px; background:#fff; color:#050505; padding:14px 16px; font-weight:900; box-shadow:0 18px 60px rgba(0,0,0,.36); opacity:0; transform:translateY(12px); transition:.2s ease; }
    .toast.show { opacity:1; transform:none; }
    @media (max-width: 820px) { .grid { grid-template-columns:1fr; } .status { grid-template-columns:1fr; } .hero { padding:24px; border-radius:24px; } }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">Owner-only release center</div>
    <h1>Publica funciones cuando tu digas.</h1>
    <p>Todo lo nuevo puede quedar en pruebas internas: los comandos solo los usa el owner, las secciones nuevas muestran “Estamos trabajando en esta parte” y el boton de lanzamiento abre la funcion para todos.</p>
    <div class="actions">
      <button class="danger" id="launchButton" type="button">${releaseState.hasPending ? 'Lanzar actualizacion' : 'No hay cambios pendientes'}</button>
      <a class="button secondary" href="/">Volver a dashboard</a>
    </div>
    <div class="status">
      <div class="stat"><span>Pendientes codigo</span><strong id="pendingFeatureCount">${pendingFeatures.length}</strong></div>
      <div class="stat"><span>Notas pendientes</span><strong id="manualPendingCount">${manualItems.length}</strong></div>
      <div class="stat"><span>Ultimo lanzamiento</span><strong id="lastLaunch">${escapeHtml(formatOwnerDate(releaseState.lastLaunchAt))}</strong></div>
    </div>
  </section>

  <section class="grid">
    <article class="card">
      <h2>Cola de lanzamiento</h2>
      <p>Estas son las funciones declaradas en codigo como “pendientes” y las notas que quieras agrupar en la proxima release.</p>
      <div class="list" id="pendingList">${renderOwnerPendingList(releaseState)}</div>
    </article>
    <article class="card">
      <h2>Anadir nota pendiente</h2>
      <p>Usalo para dejar registrado lo que estamos preparando aunque aun no tenga comando o seccion propia.</p>
      <form id="pendingForm">
        <label>Tipo
          <select name="type">
            <option value="feature">Funcion</option>
            <option value="dashboard">Dashboard</option>
            <option value="command">Comando</option>
            <option value="fix">Fix</option>
          </select>
        </label>
        <label>Titulo
          <input name="title" maxlength="90" placeholder="Ej: Nuevo modulo de...">
        </label>
        <label>Descripcion
          <textarea name="description" maxlength="500" placeholder="Que incluye y que debe estar listo antes de publicarlo"></textarea>
        </label>
        <button type="submit">Guardar como pendiente</button>
      </form>
    </article>
  </section>

  <section class="card" style="margin-top:18px;">
    <h2>Historial</h2>
    <div class="list" id="historyList">${renderOwnerHistoryList(history)}</div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
  const toast = document.querySelector('#toast');
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2600);
  }
  async function refresh() {
    const res = await fetch('/owner/api/release');
    const body = await res.json();
    location.reload();
  }
  document.querySelector('#pendingForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const res = await fetch('/owner/api/release/pending', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(data)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || 'No pude guardar la nota.');
      return;
    }
    showToast('Actualizacion pendiente guardada.');
    setTimeout(refresh, 500);
  });
  document.querySelector('#launchButton').addEventListener('click', async () => {
    if (!confirm('¿Lanzar ahora todas las funciones y notas pendientes para todo el mundo?')) return;
    const res = await fetch('/owner/api/release/launch', { method:'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || 'No pude lanzar la actualizacion.');
      return;
    }
    showToast('Actualizacion lanzada. Todo lo pendiente queda publico.');
    setTimeout(refresh, 700);
  });
</script>
</body>
</html>`;
}

function renderOwnerForbidden() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Owner Only</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:#030303; color:#fff; }
    main { width:min(620px, calc(100vw - 28px)); border:1px solid rgba(255,255,255,.16); border-radius:28px; padding:32px; background:rgba(255,255,255,.055); box-shadow:0 28px 80px rgba(0,0,0,.4); text-align:center; }
    h1 { margin:0; font-size:clamp(38px, 9vw, 72px); letter-spacing:-.08em; }
    p { color:#aaa; line-height:1.6; }
    a { display:inline-flex; margin-top:14px; padding:13px 16px; border-radius:16px; background:#fff; color:#050505; text-decoration:none; font-weight:950; }
  </style>
</head>
<body>
  <main>
    <h1>Owner only.</h1>
    <p>Esta zona controla lanzamientos internos de NexaDesk. Solo el owner global puede entrar con login de Discord.</p>
    <a href="/">Volver</a>
  </main>
</body>
</html>`;
}

function renderOwnerPendingList(releaseState) {
  const items = [
    ...(releaseState.pendingFeatures ?? []).map((feature) => ({
      title: feature.title,
      description: feature.description,
      type: feature.type,
      meta: [
        feature.commands?.length ? `Comandos: /${feature.commands.join(', /')}` : null,
        feature.dashboardViews?.length ? `Dashboard: ${feature.dashboardViews.join(', ')}` : null,
        feature.dashboardPaths?.length ? `Rutas: ${feature.dashboardPaths.join(', ')}` : null
      ].filter(Boolean).join(' · ') || 'Pendiente en codigo'
    })),
    ...(releaseState.manualPendingItems ?? []).map((item) => ({
      title: item.title,
      description: item.description,
      type: item.type,
      meta: `Anadido por ${item.createdBy} · ${formatOwnerDate(item.createdAt)}`
    }))
  ];
  if (!items.length) return '<p>No hay nada pendiente. La proxima funcion que declaremos en codigo aparecera aqui automaticamente.</p>';
  return items.map((item) => `
    <div class="item">
      <span class="pill">${escapeHtml(item.type)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(item.description || item.meta)}</small>
      ${item.description ? `<small style="display:block;margin-top:6px;">${escapeHtml(item.meta)}</small>` : ''}
    </div>
  `).join('');
}

function renderOwnerHistoryList(history = []) {
  if (!history.length) return '<p>No hay lanzamientos registrados todavia.</p>';
  return history.slice(0, 12).map((item) => `
    <div class="item">
      <strong>${escapeHtml(item.title || 'Lanzamiento')}</strong>
      <small>${escapeHtml(formatOwnerDate(item.launchedAt))} · ${escapeHtml(item.launchedBy || 'owner')}</small>
      <small style="display:block;margin-top:6px;">Features: ${(item.featureIds ?? []).length} · Notas: ${(item.manualItems ?? []).length}</small>
    </div>
  `).join('');
}

function formatOwnerDate(value) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return 'Nunca';
  return new Date(time).toLocaleString('es-ES');
}

function renderDocsVault({ config, session }) {
  const docs = buildDocsSections(config);
  const issuedAt = session.iat ? new Date(session.iat).toLocaleString('es-ES') : 'sesion actual';
  const expiresAt = session.exp ? new Date(session.exp).toLocaleString('es-ES') : 'pronto';

  return renderDocsShell({
    title: 'NexaDesk Internal Docs',
    body: `
      <main class="vault" id="docsVault">
        <section class="vault-hero">
          <div>
            <p class="kicker">NexaDesk confidential</p>
            <h1>Documentacion sensible del bot</h1>
            <p>Arquitectura, secretos, despliegue, seguridad, IA, voz, PostgreSQL y playbooks operativos. Valores criticos redacted por seguridad.</p>
          </div>
          <aside>
            <strong>Sesion protegida</strong>
            <span>Inicio: ${escapeHtml(issuedAt)}</span>
            <span>Caduca: ${escapeHtml(expiresAt)}</span>
            <a href="/docs/logout">Cerrar docs</a>
          </aside>
        </section>
        <section class="vault-warning">
          <strong>Regla de oro</strong>
          <span>No pegues tokens reales, service role keys ni secretos TOTP en Discord, tickets, GitHub, capturas o documentos publicos. Esta zona muestra estado y procedimientos, no credenciales completas.</span>
        </section>
        <section class="privacy-console" aria-live="polite">
          <div>
            <strong>Modo anti-captura activo</strong>
            <span>El contenido se oculta por defecto. Manten pulsado para verlo y se tapara automaticamente al soltar, cambiar de ventana o usar atajos sensibles.</span>
          </div>
          <button type="button" id="revealDocsButton">Mantener pulsado para ver docs</button>
        </section>
        <nav class="docs-index">
          ${docs.map((doc, index) => `<a href="#doc-${index + 1}">${escapeHtml(doc.title)}</a>`).join('')}
        </nav>
        <section class="docs-grid">
          ${docs.map((doc, index) => renderDocsCard(doc, index)).join('')}
        </section>
      </main>
    `,
    script: renderDocsProtectionScript()
  });
}

function renderDocsCard(doc, index) {
  const watermark = `NEXADESK CONFIDENTIAL - DOC ${index + 1}`;
  return `
    <article class="doc-card" id="doc-${index + 1}" data-watermark="${escapeHtml(watermark)}">
      <div class="doc-head">
        <span>${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
        <div>
          <p class="kicker">${escapeHtml(doc.classification || 'Internal')}</p>
          <h2>${escapeHtml(doc.title)}</h2>
          <p>${escapeHtml(doc.summary)}</p>
        </div>
      </div>
      <div class="doc-body">
        ${doc.blocks.map(renderDocsBlock).join('')}
      </div>
    </article>
  `;
}

function renderDocsBlock(block) {
  if (block.type === 'table') {
    return `
      <div class="table-wrap">
        <table>
          <thead><tr>${block.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
          <tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
    `;
  }

  if (block.type === 'code') {
    return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
  }

  if (block.type === 'list') {
    return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  }

  return `<p>${escapeHtml(block.value)}</p>`;
}

function buildDocsSections(config) {
  const secretRows = [
    ['DISCORD_TOKEN', secretState(config.DISCORD_TOKEN), 'Bot login y REST de dashboard. Rotar si Discord avisa de conexiones o leak.'],
    ['DISCORD_CLIENT_SECRET', secretState(config.DISCORD_CLIENT_SECRET), 'OAuth Discord para login de dashboard.'],
    ['SESSION_SECRET', secretState(config.SESSION_SECRET), 'Firma sesiones dashboard y docs. Debe ser largo y privado.'],
    ['DOCS_TOTP_SECRET', secretState(config.DOCS_TOTP_SECRET), 'Secreto base32 para Google Authenticator. No subir a GitHub.'],
    ['DATABASE_URL', secretState(config.DATABASE_URL), 'Conexión privada a PostgreSQL. Nunca exponer al cliente.'],
    ['GROQ_API_KEY', secretState(config.GROQ_API_KEY), 'Cuenta IA primaria.'],
    ['GROQ_FALLBACK_API_KEYS', secretState(config.GROQ_FALLBACK_API_KEYS), 'Cuentas IA backup separadas por coma.'],
    ['AKIOMAE_API_KEY', secretState(config.AKIOMAE_API_KEY), 'Fallback externo cuando Groq agote limites.'],
    ['DISCORD_OWNER_ADMIN_ID', secretState(config.DISCORD_OWNER_ADMIN_ID), 'Usuario autorizado para activar Premium y funciones owner-only.'],
    ['DASHBOARD_PUBLIC_URL', secretState(config.DASHBOARD_PUBLIC_URL), 'URL publica usada en /ayuda, MD de bienvenida e invitaciones.'],
    ['PAYPAL_CLIENT_ID', secretState(config.PAYPAL_CLIENT_ID), 'Checkout Premium automatico con PayPal.'],
    ['PAYPAL_CLIENT_SECRET', secretState(config.PAYPAL_CLIENT_SECRET), 'Secreto PayPal para capturar pagos. Nunca exponer al cliente.'],
    ['PREMIUM_PAYMENT_URL', secretState(config.PREMIUM_PAYMENT_URL), 'Fallback de pago manual si PayPal API aun no esta lista.'],
    ['PREMIUM_PACK_PRICE_CENTS', secretState(config.PREMIUM_PACK_PRICE_CENTS), 'Precio del pack Premium en centimos.'],
    ['PREMIUM_PACK_SLOTS', secretState(config.PREMIUM_PACK_SLOTS), 'Numero de servidores que activa cada compra Premium.'],
    ['VOICE_TTS_PROVIDER', secretState(config.VOICE_TTS_PROVIDER), 'Proveedor de voz para tickets Pro Voice.'],
    ['EDGE_TTS_VOICE', secretState(config.EDGE_TTS_VOICE), 'Voz natural usada cuando Edge TTS esta disponible.'],
    ['AI_VISUAL_ANALYSIS', secretState(config.AI_VISUAL_ANALYSIS), 'Activa analisis de imagenes y videos en tickets cuando el prompt lo permite.'],
    ['ANNOUNCEMENT_SOURCE_GUILD_ID', secretState(config.ANNOUNCEMENT_SOURCE_GUILD_ID), 'Servidor central desde donde salen anuncios globales.'],
    ['ANNOUNCEMENT_SOURCE_CHANNEL_ID', secretState(config.ANNOUNCEMENT_SOURCE_CHANNEL_ID), 'Canal central que se replica a los canales de anuncios detectados.'],
    ['TOPGG_API_TOKEN', secretState(config.TOPGG_API_TOKEN), 'Permite consultar si un bot esta listado en Top.gg antes de banearlo con Anti-bots.']
  ];

  return [
    {
      title: 'Mapa maestro',
      classification: 'Owner only',
      summary: 'Vision global de como esta dividido NexaDesk y que piezas no deben filtrarse.',
      blocks: [
        { type: 'list', items: [
          'La Raspberry Pi sirve la dashboard publica y ejecuta el worker del bot con PM2.',
          'La Raspberry Pi mantiene el liderazgo principal del bot con BOT_INSTANCE_ID=pi-main.',
          'PostgreSQL guarda configuracion, paneles, componentes, tickets, transcripciones, feedback de tickets y blacklist interna.',
          'Quality Radar guarda senales en ai_quality_signals cuando el usuario se queja de que NexaDesk/IA funciona mal, se equivoca, repite, no ve imagenes, falla en voz o genera enfado.',
          'Groq procesa soporte IA, vision, STT y parte de TTS; Akiomae queda como fallback final.',
          'XN Protect aporta blacklist global, Automod textual ofensivo/malicioso y Antiscam de imagenes. NexaDesk acredita la fuente y no banea automaticamente por blacklist externa.',
          'Top.gg se usa como lista positiva para Anti-bots: si un bot esta listado, se permite; si Top.gg devuelve 404, se puede banear; si falla la API, no se banea.',
          'Premium por servidor se decide con plan pro/premium/enterprise, voice_support_enabled o /activarpremium desde owner autorizado.',
          'Growth Engine pide feedback al cerrar tickets; Premium permite reviews publicas y Churn Radar para recuperar usuarios insatisfechos.',
          'Modo mantenimiento global se activa con /mantenimiento o desde /admin; ralentiza solo servidores Free y avisa al abrir tickets.',
          'Smart Discovery recorre todos los canales de cada servidor instalado, normaliza tipografias raras y detecta anuncios, normas, FAQ, soporte y categorias candidatas.',
          'El canal de anuncios detectado es destino de broadcast: todo mensaje publicado en ANNOUNCEMENT_SOURCE_CHANNEL_ID dentro de ANNOUNCEMENT_SOURCE_GUILD_ID se replica ahi.',
          'Release Control: toda funcion nueva debe declararse en src/release-gates.js. Mientras no este lanzada desde /owner, sus comandos quedan owner-only y las secciones nuevas de dashboard con data-release-feature muestran "Estamos trabajando en esta parte".',
          '/docs es una zona oculta: no aparece en la UI, requiere TOTP y no debe contener secretos en claro.',
          `/admin es el command room oculto: se entra con codigo temporal emitido por la web y solicitado con /code, limitado al rol ${config.ADMIN_CODE_ROLE_ID}, usa cookie separada y permite ver datos globales live y activar/desactivar mantenimiento.`
        ] }
      ]
    },
    {
      title: 'Secretos y variables criticas',
      classification: 'Credential map',
      summary: 'Estado de secretos sin revelar valores. Si algo aparece como Falta, esa funcion puede romperse.',
      blocks: [
        { type: 'table', headers: ['Variable', 'Estado', 'Uso'], rows: secretRows },
        { type: 'list', items: [
          `DISCORD_CLIENT_ID publico actual: ${config.DISCORD_CLIENT_ID}`,
          `Dashboard publica configurada: ${config.DASHBOARD_PUBLIC_URL}`,
          `TOTP issuer/account: ${config.DOCS_TOTP_ISSUER} / ${config.DOCS_TOTP_ACCOUNT}`,
          'Nunca guardar contrasenas, tokens o service_role keys dentro de README, capturas, commits ni tickets.'
        ] }
      ]
    },
    {
      title: 'Despliegue y runtime',
      classification: 'Infrastructure',
      summary: 'Donde corre cada parte y como recuperarla si se cae.',
      blocks: [
        { type: 'table', headers: ['Pieza', 'Ubicacion', 'Notas'], rows: [
          ['Dashboard web + worker', 'Raspberry Pi + PM2', 'Ejecuta la dashboard y el worker en el mismo equipo.'],
          ['Bot worker principal', 'Raspberry Pi /home/pi/nexadesk', 'PM2 NexaDesk con BOT_INSTANCE_ID=pi-main; health local en puerto 3010.'],
          ['Repositorio', 'github.com/gonzalopriv9-byte/Nexa-Desk', 'main contiene la version que se actualiza en la Raspberry Pi.'],
          ['Dominio dashboard', 'https://nexa-desk.com/', 'OAuth redirect debe apuntar a /auth/discord/callback.']
        ] },
        { type: 'code', value: 'systemctl status nexadesk\njournalctl -u nexadesk -n 80 --no-pager\ncurl -fsS http://127.0.0.1:3010/health' }
      ]
    },
    {
      title: 'Discord, permisos y comandos',
      classification: 'Bot operations',
      summary: 'Permisos, intents, comandos y puntos sensibles del bot en Discord.',
      blocks: [
        { type: 'list', items: [
          'Privileged intents recomendados: MESSAGE CONTENT INTENT y SERVER MEMBERS INTENT.',
          'Permisos de invitacion: Manage Channels, Manage Roles, View Audit Log, Manage Messages, Moderate Members, Kick, Ban, voz y lectura de historial.',
          'El bot registra slash commands globales con npm run register.',
          'Comandos clave: /setup, /ayuda, /desactivar ia, /activar ia, /ticket prioridad, /ticket cerrar, /ticket resumen, /voz crear, /globalstats, /crecimiento, /activarpremium, /mantenimiento, /seguridad configurar.',
          '/seguridad configurar acepta nivel, canal_logs, edad_minima_dias, antiflood, antilinks, automod, antibots, antialts y antinuke.',
          'Si entra staff al ticket, NexaDesk deja de responder salvo mencion, reply o llamada directa.',
          'Diferenciacion comercial clave: NexaDesk no vende "otro bot de tickets"; vende una capa IA compatible con los sistemas que el servidor ya usa.'
        ] }
      ]
    },
    {
      title: 'Flujos de tickets y automatizacion',
      classification: 'Support flow',
      summary: 'Como decide NexaDesk cuando hablar, cuando callarse y como convive con otros bots.',
      blocks: [
        { type: 'table', headers: ['Flujo', 'Entrada', 'Respuesta'], rows: [
          ['Panel NexaDesk boton/menu', 'Usuario pulsa componente y responde preguntas previas.', 'Crea canal privado, guarda respuestas, saluda, revisa blacklist externa, activa IA y opcionalmente sala de voz Pro.'],
          ['Ticket bots externos', 'Canal ticket-[numero] o mensaje inicial de Ticket King, XN Tickets, Guild Manager o bot similar.', 'Detecta opener, saluda una sola vez, revisa XN Protect, atiende hasta staff.'],
          ['Otros bots/categorias', 'Nuevo canal en categoria configurada por /setup o dashboard.', 'Registra ticket si encaja, guarda transcript y atiende segun prompt del servidor.'],
          ['Staff humano', 'Staff escribe, responde o toma el ticket.', 'NexaDesk pregunta si se encargan; si aceptan, IA queda en modo silencio salvo mencion directa.'],
          ['Cierre propio', '/ticket cerrar o cierre por intencion clara del usuario.', 'Guarda transcripcion, intenta enviar MD al opener, pide rating y actualiza dashboard.'],
          ['Cierre de terceros', 'Canal eliminado por otro bot.', 'El bot intenta capturar transcript previo con mensajes guardados, manda MD con feedback y deja registro en PostgreSQL si la tabla esta aplicada.'],
          ['Growth Engine', 'Usuario pulsa rating en el MD post-ticket.', 'Guarda ticket_feedback, actualiza estadisticas, publica review si Premium lo permite o avisa Churn Radar si rating bajo.']
        ] },
        { type: 'list', items: [
          'Primer mensaje del usuario en un ticket nuevo siempre debe ser respondido por NexaDesk aunque haya avisos de blacklist previos.',
          'La IA debe responder en el idioma del ultimo mensaje del usuario y no inventar que ha visto una imagen si no tiene analisis visual real.',
          'El contexto de voz transcrito se guarda como transcript y entra en el historial para siguientes respuestas.',
          'Modo examen guarda estado, preguntas, respuestas, flags de posible copia/IA y nota provisional en tickets.exam_state.',
          'Si el usuario pide staff, asistencia manual, riesgo legal, amenazas, acoso serio o autolesion, NexaDesk escala con resumen claro.'
        ] }
      ]
    },
    {
      title: 'PostgreSQL y datos guardados',
      classification: 'Data model',
      summary: 'Tablas, contenido guardado y decisiones de privacidad.',
      blocks: [
        { type: 'table', headers: ['Tabla', 'Contenido', 'Riesgo'], rows: [
          ['guild_configs', 'Categoria, staff, prompt, info, paneles, componentes, premium, security, alianzas.', 'Alto: contiene contexto interno del servidor.'],
          ['tickets', 'Canal, servidor, opener, voz, estado, timestamps y exam_state.', 'Medio/Alto: metadatos de soporte y respuestas de examenes.'],
          ['transcript_messages', 'Mensajes de tickets, voz y eventos importantes.', 'Alto: puede contener datos de usuarios.'],
          ['ticket_feedback', 'Rating post-ticket, usuario, canal y si se publico review.', 'Medio: satisfaccion de usuarios y reputacion operativa.'],
          ['ai_quality_signals', 'Quejas espontaneas sobre errores de IA, frustracion, voz, vision, idioma, repeticion o respuestas malas.', 'Alto: contiene mensajes de usuario y ultima respuesta IA relacionada.'],
          ['global_blacklist', 'Baneos internos y codigos.', 'Alto: moderacion sensible.'],
          ['global_blacklist_evidence', 'URLs de pruebas y adjuntos.', 'Alto: evidencias privadas.']
        ] },
        { type: 'list', items: [
          'Produccion debe mostrar "NexaDesk storage backend: PostgreSQL" al arrancar.',
          'El service_role solo vive en backend. Nunca se manda al navegador.',
          'La dashboard filtra servidores por OAuth: owner, Administrator o Manage Server.'
        ] }
      ]
    },
    {
      title: 'IA, vision y voz',
      classification: 'AI pipeline',
      summary: 'Modelos, fallbacks y flujo de audio/vision.',
      blocks: [
        { type: 'table', headers: ['Area', 'Config actual', 'Notas'], rows: [
          ['Texto IA', config.GROQ_MODEL, 'Modelo rapido para tickets y dashboard assistant.'],
          ['Vision', config.GROQ_VISION_MODEL, 'Imagenes y frames de video si AI_VISUAL_ANALYSIS=true.'],
          ['STT', config.GROQ_STT_MODEL, 'Transcribe voz en tickets Pro Voice.'],
          ['TTS', `${config.VOICE_TTS_PROVIDER} / ${config.EDGE_TTS_VOICE}`, 'Edge/Piper/Groq segun entorno y disponibilidad.'],
          ['Limites voz', `${config.VOICE_MIN_RECORDING_MS}-${config.VOICE_MAX_RECORDING_MS} ms`, 'Evita clips demasiado cortos y audios eternos.']
        ] },
        { type: 'list', items: [
          'Groq primary se usa primero; GROQ_FALLBACK_API_KEYS rota cuentas si hay limites.',
          'Akiomae queda como ultimo fallback si Groq se agota.',
          'La IA debe responder en el idioma del ultimo mensaje del usuario.',
          'Si el prompt pide pruebas visuales, la IA interpreta imagenes/videos antes de preguntar que ve.'
        ] }
      ]
    },
    {
      title: 'Dashboard, paneles y Premium',
      classification: 'Product strategy',
      summary: 'Funciones vendibles y flujo administrativo.',
      blocks: [
        { type: 'list', items: [
          'Dashboard: Resumen, Servidores, Configuracion, Componentes, Paneles, Crecimiento, Premium, Tickets y Logs.',
          'V1.5 se gestiona desde /owner como lanzamiento privado: /novedades, /reporte y Modo examen web quedan bloqueados hasta que el owner pulse Lanzar actualizacion.',
          'Release Control mantiene las funciones nuevas en preview privada para el owner y muestra "Estamos trabajando en esta parte" en la dashboard publica hasta el lanzamiento.',
          'Configuracion incluye Descubrimiento inteligente para reescanear canales y usar anuncios/normas/FAQ como contexto operativo.',
          'Los anuncios globales salen del canal central configurado y llegan al canal de anuncios detectado de cada servidor; por defecto no replica menciones para evitar @everyone accidental.',
          'Paneles soportan boton unico o menu desplegable con 2+ componentes.',
          'Componentes guardan preguntas previas, categoria destino, primer mensaje y modo texto/voz/examen.',
          'Modo examen Free pregunta dentro del ticket, corrige con IA, marca posibles copias/IA y permite solicitar revision humana; Modo examen Premium puede abrir sala de voz y formulario externo para supervision.',
          'Crecimiento permite configurar feedback post-ticket, canal de reviews, rating publico minimo y alertas de baja satisfaccion.',
          'Premium incluye Voz Pro, Modo examen supervisado, IA prioritaria, transcripciones inteligentes, Security Plus, Growth Engine, reviews publicas, Churn Radar, SLA Radar, Auto-config Pro, Alianzas Pro, Team Assist, analitica premium, Affiliate Boost, branding propio e informes semanales.',
          'Afiliados: /afiliado nombre muestra el username de afiliado; /afiliado server usuario:<USERNAME> registra un servidor una sola vez. Cada AFFILIATE_REWARD_SERVER_COUNT servidores generan AFFILIATE_REWARD_SLOTS slots Premium durante AFFILIATE_REWARD_DAYS dias.',
          'Monetizacion: el pack recomendado es PREMIUM_PACK_SLOTS servidores por PREMIUM_PACK_PRICE_CENTS centimos. PayPal Checkout crea orden, captura pago y guarda premium_purchases; despues el usuario elige servidores en la dashboard.',
          'Fallback rapido: si PAYPAL_CLIENT_ID/SECRET no estan listos pero PREMIUM_PAYMENT_URL existe, la dashboard abre ese enlace y guarda una compra pending para validacion manual en soporte.',
          'Upsell activo: /premium, /ayuda Premium, MD de bienvenida y bloqueos de Voz Pro apuntan a la dashboard #premium.',
          'La seccion Premium usa paleta dorada y solo abre si el usuario tiene al menos un servidor con premium activo.',
          'Premium no se ralentiza durante mantenimiento global; los servidores Free reciben aviso al abrir ticket.',
          'El antiguo modulo de musica fue retirado para centrar el producto en soporte, seguridad, voz, alianzas y transcripciones.',
          'Premium se activa con /activarpremium servidor:<ID> por el owner autorizado o manualmente en PostgreSQL.'
        ] }
      ]
    },
    {
      title: 'Seguridad y abuso',
      classification: 'Trust and safety',
      summary: 'Capas anti-raid, anti-scam, blacklist y crisis.',
      blocks: [
        { type: 'list', items: [
          'Security Guard detecta flood, links sospechosos, imagenes scam, contenido ofensivo/malicioso, alts, bots no listados en Top.gg, webhooks/apps externas, creaciones masivas de canales, cambios de permisos/config y patrones anti-nuke.',
          'Los links se analizan con IA cuando aparecen en mensajes; puede recomendar review, borrado o aislamiento. Los adjuntos de imagen se revisan con XN Protect Antiscam cuando Anti-links IA esta activo.',
          'XN Protect Automod se consulta con contenido textual y, si response.malicioso=true, se borra el mensaje, se intenta aislar al autor y se loguea motivo/palabras/categoria/score si la API lo devuelve.',
          'Anti-bots consulta Top.gg con TOPGG_API_TOKEN. Solo banea bots cuando la API confirma que no estan listados; con timeout/error/token ausente solo deja aviso.',
          'Los mensajes de crisis/autolesion no se bloquean por Automod para permitir contencion y escalado humano.',
          'XN Protect se consulta al abrir tickets y deja aviso al staff sin banear automaticamente.',
          'En crisis/autolesion, NexaDesk debe escalar al staff inmediatamente y responder con contencion breve.',
          'En alianzas, el bot pide leer normas, recibe plantilla, entrega plantilla del servidor, verifica captura y publica en canal configurado.'
        ] }
      ]
    },
    {
      title: 'Playbooks de emergencia',
      classification: 'Incident response',
      summary: 'Que hacer cuando algo se rompe o hay riesgo.',
      blocks: [
        { type: 'table', headers: ['Incidente', 'Accion inmediata', 'Despues'], rows: [
          ['Token Discord reseteado', 'Actualizar DISCORD_TOKEN en el .env de la Pi y reiniciar PM2.', 'Revisar logs de reconnect y evitar loops.'],
          ['Bot offline', 'systemctl restart nexadesk; revisar journalctl.', 'Verificar intents, token y conectividad.'],
          ['Dashboard de la Pi falla', 'Revisar el .env y los logs de PM2.', 'Confirmar token, PostgreSQL y estado del servicio.'],
          ['PostgreSQL missing column/table', 'Revisar el esquema migrado en PostgreSQL.', 'Verificar tablas, índices y permisos SQL.'],
          ['Groq sin creditos', 'Confirmar GROQ_FALLBACK_API_KEYS y AKIOMAE_API_KEY.', 'Reducir modelo o limits si hay costes.'],
          ['Leak de secreto', 'Rotar secreto inmediatamente.', 'Actualizar la Pi y revocar claves antiguas.']
        ] }
      ]
    },
    {
      title: 'Checklist privado de lanzamiento',
      classification: 'Launch',
      summary: 'Antes de vender o anunciar NexaDesk.',
      blocks: [
        { type: 'list', items: [
          'Raspberry Pi actualizada desde main y /health operativo.',
          'Pi activa con NexaDesk online y presencia actualizada.',
          'PostgreSQL schema aplicado y transcripciones guardando.',
          'OAuth Discord con redirect correcto.',
          'DOCS_TOTP_SECRET configurado y probado desde Google Authenticator.',
          'No hay tokens ni service_role keys en commits, screenshots ni mensajes publicos.',
          'Probar un ticket normal, uno Ticket King, uno con imagen, uno de voz, uno de Modo examen y uno de cierre con transcripcion.'
        ] }
      ]
    }
  ];
}

function secretState(value) {
  const raw = String(value ?? '').trim();
  if (!raw || ['replace_me', 'change_me', 'local', 'dummy-secret', 'dummy.token.value'].includes(raw)) return 'Falta';
  return 'Configurado - valor oculto';
}

function renderDocsShell({ title, body, script = '', accessGate = null }) {
  const watermarkWords = Array.from({ length: 96 }, (_, index) => `<span>NEXADESK CONFIDENTIAL ${String(index + 1).padStart(2, '0')}</span>`).join('');
  const accessGateMarkup = accessGate ? renderAccessGateMarkup(accessGate) : '';
  const accessGateScript = accessGate ? renderAccessGateScript() : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#050505; --panel:#111; --panel2:#191919; --line:#303030; --text:#fff; --muted:#a8a8a8; --danger:#ff5f57; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 15% 0%, rgba(255,255,255,.12), transparent 30%), repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0 1px, transparent 1px 74px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 74px), var(--bg); color:var(--text); user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
    body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; background:url('/assets/nexadesk-logo.svg') center / min(420px, 55vw) no-repeat; opacity:.105; filter:grayscale(1); }
    .access-gate { position:fixed; inset:0; z-index:10000; display:grid; place-items:center; overflow:hidden; background:#030303; transition:opacity .8s ease, visibility .8s ease; }
    .access-gate.is-hidden { opacity:0; visibility:hidden; pointer-events:none; }
    .gate-rain,.gate-rain::before,.gate-rain::after { content:""; position:absolute; inset:-45% 0; pointer-events:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1440' height='720' viewBox='0 0 1440 720'%3E%3Cg stroke='%23fff' stroke-linecap='round'%3E%3Cline x1='46' y1='28' x2='46' y2='86' opacity='.46'/%3E%3Cline x1='128' y1='202' x2='128' y2='264' opacity='.28'/%3E%3Cline x1='219' y1='92' x2='219' y2='172' opacity='.56'/%3E%3Cline x1='314' y1='318' x2='314' y2='366' opacity='.34'/%3E%3Cline x1='428' y1='10' x2='428' y2='78' opacity='.5'/%3E%3Cline x1='536' y1='154' x2='536' y2='222' opacity='.36'/%3E%3Cline x1='672' y1='424' x2='672' y2='482' opacity='.42'/%3E%3Cline x1='790' y1='62' x2='790' y2='146' opacity='.58'/%3E%3Cline x1='938' y1='246' x2='938' y2='306' opacity='.32'/%3E%3Cline x1='1088' y1='132' x2='1088' y2='212' opacity='.5'/%3E%3Cline x1='1226' y1='462' x2='1226' y2='516' opacity='.34'/%3E%3Cline x1='1368' y1='42' x2='1368' y2='124' opacity='.54'/%3E%3Ccircle cx='74' cy='612' r='1' opacity='.6'/%3E%3Ccircle cx='884' cy='584' r='1' opacity='.54'/%3E%3Ccircle cx='1194' cy='62' r='1' opacity='.5'/%3E%3C/g%3E%3C/svg%3E"); background-size:1440px 720px; animation:gateRain 2.8s linear infinite; opacity:.8; }
    .gate-rain::before { inset:-55% -8% -35% 4%; animation-duration:2.1s; opacity:.48; transform:scaleX(-1); }
    .gate-rain::after { inset:-65% 2% -30% -10%; animation-duration:3.4s; opacity:.36; transform:scale(1.12); }
    .gate-grid { position:absolute; inset:0; background:radial-gradient(circle at 50% 46%, rgba(255,255,255,.12), transparent 24%), repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 96px); mask-image:linear-gradient(180deg, transparent, #000 18%, #000 74%, transparent); opacity:.34; }
    .gate-shell { position:relative; z-index:2; width:min(410px, calc(100% - 34px)); min-height:250px; border:1px solid rgba(255,255,255,.13); border-radius:12px; background:linear-gradient(180deg, rgba(12,12,12,.94), rgba(2,2,2,.92)); box-shadow:0 30px 120px rgba(0,0,0,.72), 0 0 80px rgba(255,255,255,.06); display:grid; place-items:center; padding:28px; overflow:hidden; }
    .gate-shell::before { content:""; position:absolute; inset:-1px; background:linear-gradient(115deg, transparent 0 28%, rgba(255,255,255,.24) 48%, transparent 68%); transform:translateX(-125%); animation:gateScan 2.7s ease-in-out .45s both; }
    .gate-verify,.gate-brand { position:absolute; inset:26px; display:grid; place-items:center; text-align:center; transition:opacity .45s ease, transform .55s cubic-bezier(.2,.8,.2,1), filter .55s ease; }
    .gate-brand { opacity:0; transform:translateY(18px) scale(.96); filter:blur(12px); }
    .access-gate.is-brand .gate-verify { opacity:0; transform:translateY(-18px) scale(.96); filter:blur(10px); }
    .access-gate.is-brand .gate-brand { opacity:1; transform:translateY(0) scale(1); filter:blur(0); }
    .gate-orbit { width:62px; height:62px; border-radius:50%; border:1px solid rgba(255,255,255,.18); display:grid; place-items:center; margin:0 auto 20px; position:relative; box-shadow:0 0 42px rgba(255,255,255,.12); }
    .gate-orbit::before { content:""; position:absolute; inset:-7px; border-radius:inherit; border:1px solid rgba(255,255,255,.1); border-top-color:#fff; animation:spin 1s linear infinite; }
    .gate-check { width:24px; height:24px; border-radius:50%; border:1px solid rgba(255,255,255,.28); display:grid; place-items:center; color:#030303; background:#fff; transform:scale(.7); opacity:0; transition:opacity .25s ease, transform .25s ease; font-weight:950; }
    .access-gate.is-complete .gate-orbit::before { animation:none; border-color:rgba(255,255,255,.18); }
    .access-gate.is-complete .gate-check { opacity:1; transform:scale(1); }
    .gate-title { margin:0; font-size:18px; font-weight:950; letter-spacing:-.03em; }
    .gate-copy { margin:8px auto 0; max-width:310px; font-size:13px; line-height:1.55; color:#a9a9a9; }
    .gate-proof { width:100%; border:1px solid rgba(255,255,255,.11); border-radius:8px; margin-top:18px; padding:10px 12px; display:flex; justify-content:space-between; gap:12px; color:#cfcfcf; background:rgba(255,255,255,.035); font-size:12px; }
    .gate-brand img { width:72px; height:72px; border-radius:16px; border:1px solid rgba(255,255,255,.24); box-shadow:0 0 58px rgba(255,255,255,.18); margin-bottom:20px; }
    .gate-brand strong { display:block; font-size:22px; letter-spacing:.18em; margin-bottom:8px; color:#fff; }
    .gate-progress { position:absolute; left:24px; right:24px; bottom:20px; height:2px; background:rgba(255,255,255,.12); overflow:hidden; border-radius:999px; }
    .gate-progress span { display:block; width:100%; height:100%; background:#fff; transform-origin:left; animation:gateProgress 4.9s cubic-bezier(.2,.8,.2,1) both; }
    .gate-skip { position:absolute; z-index:3; right:18px; bottom:18px; border:1px solid rgba(255,255,255,.16); color:#fff; background:rgba(255,255,255,.045); border-radius:999px; padding:9px 12px; font-weight:800; cursor:pointer; }
    a { color:#fff; }
    code,pre { user-select:none; -webkit-user-select:none; }
    .watermark-field { position:fixed; inset:-24vh -24vw; z-index:18; pointer-events:none; display:grid; grid-template-columns:repeat(6, minmax(180px,1fr)); gap:34px; transform:rotate(-24deg); opacity:.16; font-weight:950; letter-spacing:.17em; color:#fff; text-transform:uppercase; mix-blend-mode:screen; animation:watermarkDrift 18s linear infinite alternate; }
    .watermark-field span { white-space:nowrap; }
    .gate,.vault { position:relative; z-index:2; width:min(1180px, calc(100% - 36px)); margin:0 auto; }
    .gate { min-height:100vh; display:grid; place-content:center; max-width:560px; text-align:left; }
    .gate-logo { width:72px; height:72px; border:1px solid rgba(255,255,255,.38); border-radius:18px; padding:12px; background:#050505; box-shadow:0 0 70px rgba(255,255,255,.1); }
    .kicker { color:#fff; font-size:12px; letter-spacing:.12em; text-transform:uppercase; margin:0 0 8px; }
    h1 { margin:12px 0; font-size:clamp(38px, 7vw, 72px); line-height:.94; }
    h2 { margin:0; font-size:24px; }
    p,li,td,th,span,label { color:var(--muted); line-height:1.55; }
    .totp-form,.notice,.error,.vault-hero,.vault-warning,.privacy-console,.docs-index,.doc-card { border:1px solid var(--line); border-radius:18px; background:linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); box-shadow:0 24px 90px rgba(0,0,0,.28); }
    .totp-form { display:grid; gap:12px; padding:16px; margin-top:18px; }
    label { display:grid; gap:8px; font-weight:800; color:#fff; }
    input,button { border-radius:13px; border:1px solid var(--line); padding:13px 14px; background:#080808; color:#fff; font:inherit; }
    input { text-align:center; letter-spacing:.42em; font-size:28px; font-weight:900; }
    button { background:#fff; color:#050505; border:0; font-weight:900; cursor:pointer; }
    .notice,.error { margin-top:14px; padding:15px; }
    .notice strong,.notice span,.error { display:block; }
    .notice strong { color:#fff; }
    .error { color:#fff; border-color:rgba(255,95,87,.58); background:rgba(255,95,87,.12); }
    .vault { padding:34px 0 80px; }
    .vault-hero { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:18px; padding:24px; margin-bottom:16px; }
    .vault-hero aside { border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:16px; background:rgba(0,0,0,.28); display:grid; gap:7px; }
    .vault-hero aside strong,.vault-hero aside a { color:#fff; }
    .vault-warning { padding:16px 18px; margin-bottom:16px; border-style:dashed; }
    .vault-warning strong { display:block; color:#fff; }
    .privacy-console { position:sticky; top:12px; z-index:45; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:center; padding:14px 16px; margin-bottom:16px; border-color:rgba(255,255,255,.28); background:linear-gradient(135deg, rgba(255,255,255,.16), rgba(255,255,255,.04)); backdrop-filter:blur(18px); }
    .privacy-console strong { display:block; color:#fff; }
    .privacy-console span { display:block; font-size:13px; }
    .privacy-console button { white-space:nowrap; box-shadow:0 0 34px rgba(255,255,255,.14); }
    body.docs-vault.secure-locked .docs-index,
    body.docs-vault.secure-locked .docs-grid,
    body.docs-vault.secure-locked .vault-hero,
    body.docs-vault.secure-locked .vault-warning { filter:blur(20px) brightness(.36); opacity:.34; pointer-events:none; transform:scale(.992); }
    body.docs-vault.secure-locked .docs-index *,
    body.docs-vault.secure-locked .docs-grid *,
    body.docs-vault.secure-locked .vault-hero *,
    body.docs-vault.secure-locked .vault-warning * { color:transparent !important; text-shadow:0 0 20px rgba(255,255,255,.62); }
    body.docs-vault.secure-revealed .docs-index,
    body.docs-vault.secure-revealed .docs-grid,
    body.docs-vault.secure-revealed .vault-hero,
    body.docs-vault.secure-revealed .vault-warning { filter:none; opacity:1; pointer-events:auto; transform:none; transition:filter .16s ease, opacity .16s ease, transform .16s ease; }
    .docs-index { display:flex; flex-wrap:wrap; gap:9px; padding:12px; margin-bottom:16px; }
    .docs-index a { text-decoration:none; border:1px solid rgba(255,255,255,.16); border-radius:999px; padding:8px 10px; color:#fff; background:rgba(0,0,0,.25); }
    .docs-grid { display:grid; gap:16px; }
    .doc-card { position:relative; overflow:hidden; padding:22px; }
    .doc-card::before { content:""; position:absolute; inset:0; pointer-events:none; background:url('/assets/nexadesk-logo.svg') center / 280px no-repeat; opacity:.08; filter:grayscale(1); }
    .doc-card::after { content:attr(data-watermark); position:absolute; left:8%; top:42%; transform:rotate(-18deg); font-size:clamp(42px, 8vw, 96px); font-weight:950; letter-spacing:.12em; color:rgba(255,255,255,.12); white-space:nowrap; pointer-events:none; }
    .doc-head,.doc-body { position:relative; z-index:1; }
    .doc-head { display:grid; grid-template-columns:56px minmax(0,1fr); gap:16px; align-items:start; border-bottom:1px solid rgba(255,255,255,.1); padding-bottom:16px; margin-bottom:16px; }
    .doc-head > span { width:48px; height:48px; border-radius:14px; display:grid; place-items:center; background:#fff; color:#050505; font-weight:950; }
    .doc-body { display:grid; gap:13px; }
    ul { margin:0; padding-left:20px; }
    .table-wrap { overflow:auto; border:1px solid rgba(255,255,255,.12); border-radius:14px; }
    table { width:100%; border-collapse:collapse; min-width:680px; background:rgba(0,0,0,.22); }
    th,td { text-align:left; padding:12px; border-bottom:1px solid rgba(255,255,255,.1); vertical-align:top; }
    th { color:#fff; background:rgba(255,255,255,.06); }
    pre { margin:0; white-space:pre-wrap; border:1px solid rgba(255,255,255,.12); border-radius:14px; padding:14px; background:#050505; color:#fff; }
    .privacy-shield { position:fixed; inset:0; z-index:9999; display:none; place-items:center; background:rgba(0,0,0,.985); color:#fff; text-align:center; padding:24px; }
    .privacy-shield.is-active { display:grid; }
    .privacy-shield h2 { font-size:clamp(34px, 8vw, 92px); line-height:.9; margin:0 0 12px; }
    .privacy-shield p { max-width:620px; margin:0 auto; }
    @keyframes gateRain { from { transform:translate3d(0,-240px,0); } to { transform:translate3d(0,110vh,0); } }
    @keyframes gateScan { 0%,22% { transform:translateX(-125%); opacity:0; } 44% { opacity:.75; } 100% { transform:translateX(125%); opacity:0; } }
    @keyframes gateProgress { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @keyframes watermarkDrift { from { transform:rotate(-24deg) translate3d(-20px,-12px,0); } to { transform:rotate(-24deg) translate3d(26px,18px,0); } }
    @media print {
      html,body { width:100vw; height:100vh; overflow:hidden; background:#000 !important; }
      body * { display:none !important; }
      body::after { content:"NEXADESK DOCS - IMPRESION BLOQUEADA"; display:grid !important; place-items:center; position:fixed; inset:0; color:#fff; font-size:42px; font-weight:950; letter-spacing:.08em; text-align:center; }
    }
    @media (max-width:760px) {
      .gate,.vault { width:min(100% - 22px, 1180px); }
      .vault { padding-top:14px; }
      .vault-hero { grid-template-columns:1fr; padding:16px; }
      .privacy-console { grid-template-columns:1fr; position:relative; top:auto; }
      .doc-card { padding:16px; }
      .doc-head { grid-template-columns:1fr; }
      h1 { font-size:42px; }
      .watermark-field { grid-template-columns:repeat(4, minmax(150px,1fr)); gap:30px; opacity:.2; }
    }
    @media (prefers-reduced-motion:reduce) { .gate-rain,.gate-rain::before,.gate-rain::after,.gate-shell::before,.gate-orbit::before,.gate-progress span { animation:none; transition:none; } .access-gate { display:none; } }
  </style>
</head>
<body>
  ${accessGateMarkup}
  <div class="watermark-field" aria-hidden="true">${watermarkWords}</div>
  <div class="privacy-shield" id="privacyShield"><div><h2>Contenido oculto</h2><p>Vuelve a la pestana para restaurar la vista segura.</p></div></div>
  ${body}
  ${accessGateScript}${script}
</body>
</html>`;
}

function renderAccessGateMarkup({ title = 'Verificando acceso seguro', copy = 'Comprobando sesion, navegador y conexion con NexaDesk.', brandCopy = 'Entrando al centro de mando de soporte.' } = {}) {
  return `
  <section class="access-gate" id="accessGate" aria-label="Entrada segura NexaDesk">
    <div class="gate-rain"></div>
    <div class="gate-grid"></div>
    <div class="gate-shell">
      <div class="gate-verify">
        <div>
          <div class="gate-orbit"><span class="gate-check">✓</span></div>
          <h2 class="gate-title" id="gateTitle">${escapeHtml(title)}</h2>
          <p class="gate-copy" id="gateCopy">${escapeHtml(copy)}</p>
          <div class="gate-proof"><span>NexaDesk Shield</span><strong id="gateStatus">Analizando...</strong></div>
        </div>
      </div>
      <div class="gate-brand">
        <div>
          <img src="/assets/nexadesk-logo.svg" alt="NexaDesk">
          <strong>NEXADESK</strong>
          <p class="gate-copy">${escapeHtml(brandCopy)}</p>
        </div>
      </div>
      <div class="gate-progress"><span></span></div>
    </div>
  </section>`;
}

function renderAccessGateScript() {
  return `<script>
    (() => {
      const gate = document.querySelector('#accessGate');
      const gateTitle = document.querySelector('#gateTitle');
      const gateCopy = document.querySelector('#gateCopy');
      const gateStatus = document.querySelector('#gateStatus');
      const focusFirstLoginInput = () => window.setTimeout(() => document.querySelector('input[autofocus]')?.focus({ preventScroll: true }), 120);
      const finishGate = () => {
        gate?.classList.add('is-hidden');
        window.setTimeout(() => {
          gate?.remove();
          focusFirstLoginInput();
        }, 900);
      };
      if (gate && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finishGate();
      } else if (gate) {
        window.setTimeout(() => {
          gate.classList.add('is-complete');
          if (gateTitle) gateTitle.textContent = 'Verificacion completada';
          if (gateCopy) gateCopy.textContent = 'Acceso preparado. Cargando interfaz de NexaDesk.';
          if (gateStatus) gateStatus.textContent = 'Permitido';
        }, 2100);
        window.setTimeout(() => gate.classList.add('is-brand'), 3050);
        window.setTimeout(finishGate, 5100);
      }
    })();
  </script>`;
}

function renderDocsProtectionScript() {
  return `<script>
    const isVault = Boolean(document.querySelector('#docsVault'));
    const shield = document.querySelector('#privacyShield');
    const revealButton = document.querySelector('#revealDocsButton');
    let revealHold = false;
    let lockTimer = null;
    const setLocked = (locked, reason = '') => {
      if (!isVault) return;
      document.body.classList.toggle('docs-vault', true);
      document.body.classList.toggle('secure-locked', locked);
      document.body.classList.toggle('secure-revealed', !locked);
      if (locked && reason && shield) shield.querySelector('p').textContent = reason;
    };
    const lockNow = (reason = 'Contenido oculto por seguridad.') => {
      revealHold = false;
      clearTimeout(lockTimer);
      setLocked(true, reason);
    };
    const revealNow = () => {
      if (!isVault) return;
      clearTimeout(lockTimer);
      revealHold = true;
      setLocked(false);
      lockTimer = setTimeout(() => {
        if (!revealHold) lockNow('Sesion visual bloqueada.');
      }, 250);
    };
    const flashShield = (message = 'Accion bloqueada por seguridad.') => {
      if (!shield) return;
      shield.querySelector('p').textContent = message;
      lockNow(message);
      shield.classList.add('is-active');
      setTimeout(() => shield.classList.remove('is-active'), 1500);
    };
    if (isVault) {
      document.body.classList.add('docs-vault', 'secure-locked');
      revealButton?.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        revealNow();
      });
      revealButton?.addEventListener('touchstart', (event) => {
        event.preventDefault();
        revealNow();
      }, { passive:false });
      ['pointerup','pointercancel','pointerleave','mouseup','mouseleave','touchend','touchcancel'].forEach((eventName) => {
        window.addEventListener(eventName, () => lockNow('Contenido oculto al soltar el control.'), { passive:true });
      });
    }
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('dragstart', (event) => event.preventDefault());
    document.addEventListener('copy', (event) => { event.preventDefault(); flashShield('Copia bloqueada en docs.'); });
    document.addEventListener('cut', (event) => { event.preventDefault(); flashShield('Corte bloqueado en docs.'); });
    document.addEventListener('paste', (event) => { if (isVault) event.preventDefault(); });
    document.addEventListener('selectstart', (event) => {
      if (!event.target.closest('input')) event.preventDefault();
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'PrintScreen') {
        navigator.clipboard?.writeText('Captura bloqueada por NexaDesk Docs.').catch(() => {});
        flashShield('Intento de captura detectado.');
      }
    });
    document.addEventListener('keydown', (event) => {
      const key = String(event.key || '').toLowerCase();
      if (isVault && key === ' ' && event.target === document.body) {
        event.preventDefault();
        revealNow();
        return;
      }
      const blocked = event.key === 'PrintScreen'
        || event.key === 'F12'
        || event.metaKey
        || ((event.ctrlKey || event.metaKey) && ['p','s','u','c','x','a','f'].includes(key))
        || ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i','j','c','s','3','4','5'].includes(key));
      if (blocked) {
        event.preventDefault();
        flashShield('Accion bloqueada en documentos internos.');
      }
    });
    document.addEventListener('keyup', (event) => {
      if (isVault && String(event.key || '').toLowerCase() === ' ') lockNow('Contenido oculto al soltar el control.');
    });
    window.addEventListener('beforeprint', () => flashShield('Impresion bloqueada en documentos internos.'));
    window.addEventListener('pagehide', () => lockNow('Contenido oculto al salir de la pagina.'));
    window.addEventListener('freeze', () => lockNow('Contenido oculto por congelacion de pestana.'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        lockNow('Contenido oculto al cambiar de pestana.');
        shield?.classList.add('is-active');
      }
    });
    window.addEventListener('blur', () => {
      lockNow('Contenido oculto al perder foco.');
      shield?.classList.add('is-active');
    });
    window.addEventListener('focus', () => setTimeout(() => shield?.classList.remove('is-active'), 350));
    setInterval(() => {
      if (!isVault) return;
      const devtoolsLikelyOpen = (window.outerWidth - window.innerWidth > 160) || (window.outerHeight - window.innerHeight > 180);
      if (devtoolsLikelyOpen) flashShield('Vista bloqueada: consola o panel externo detectado.');
    }, 900);
  </script>`;
}

function renderAdminPanelScript(initialSnapshot) {
  return `<script>
    const state = {
      snapshot: ${initialSnapshot},
      events: []
    };
    const byId = (id) => document.getElementById(id);
    const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[char]);
    const fmtDate = (value) => {
      if (!value) return 'No indicado';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-ES');
    };
    const short = (value, length = 110) => {
      const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
      return text.length > length ? text.slice(0, length - 1) + '...' : text || '-';
    };
    const uptime = (seconds = 0) => {
      const total = Number(seconds) || 0;
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      return h ? h + 'h ' + m + 'm' : m + 'm';
    };
    const setToast = (message) => {
      const toast = byId('adminToast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('is-visible');
      clearTimeout(window.__adminToastTimer);
      window.__adminToastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
    };
    const renderStats = () => {
      const snapshot = state.snapshot || {};
      const stats = snapshot.stats || {};
      const runtime = snapshot.runtime || {};
      const maintenance = snapshot.maintenance || {};
      const dashboardMaintenance = snapshot.dashboardMaintenance || {};
      const cards = [
        ['Servidores', String(stats.installedGuilds ?? 0) + ' / ' + String(stats.totalGuilds ?? 0), 'instalados / configurados'],
        ['Tickets', String(stats.openTickets ?? 0) + ' abiertos', String(stats.totalTickets ?? 0) + ' totales'],
        ['Premium', String(stats.premiumGuilds ?? stats.proGuilds ?? 0), String(stats.freeGuilds ?? 0) + ' Free'],
        ['Feedback', String(stats.averageRating ?? 0) + ' / 5', String(stats.feedbackCount ?? 0) + ' valoraciones'],
        ['Quality IA', String(stats.unresolvedAiQualitySignals ?? 0), String(stats.aiQualitySignals ?? 0) + ' senales'],
        ['Blacklist', String(stats.activeBlacklistEntries ?? 0), 'entradas activas'],
        ['Paneles', String(stats.panels ?? 0), String(stats.components ?? 0) + ' componentes'],
        ['Runtime', String(runtime.rssMb ?? 0) + ' MB', 'uptime ' + uptime(runtime.uptimeSeconds)],
        ['Mantenimiento', maintenance.enabled ? 'ACTIVO' : 'OFF', maintenance.enabled ? 'Free con delay' : 'sin ralentizar'],
        ['Web maintenance', dashboardMaintenance.enabled ? 'ACTIVO' : 'OFF', dashboardMaintenance.enabled ? 'Free ve pantalla de espera' : 'dashboard abierta']
      ];
      byId('adminStats').innerHTML = cards.map((card) => '<article class="admin-card"><span>' + html(card[0]) + '</span><strong>' + html(card[1]) + '</strong><small>' + html(card[2]) + '</small></article>').join('');
    };
    const renderMaintenance = () => {
      const maintenance = state.snapshot.maintenance || {};
      byId('maintenanceEnabled').value = maintenance.enabled ? 'true' : 'false';
      byId('maintenanceDelay').value = String(((maintenance.delayMs ?? 3500) / 1000).toFixed(1)).replace('.0', '');
      byId('maintenanceMessage').value = maintenance.message || '';
      byId('maintenanceLabel').textContent = maintenance.enabled ? 'Activo' : 'Desactivado';
      byId('maintenanceDetails').textContent = maintenance.enabled
        ? 'Delay Free: ' + ((maintenance.delayMs ?? 3500) / 1000) + 's. Actualizado: ' + fmtDate(maintenance.updatedAt)
        : 'Los servidores Free y Premium responden a velocidad normal.';
      byId('maintenanceMeta').textContent = maintenance.enabled
        ? 'Activado por ' + (maintenance.enabledBy || 'admin') + ' - ' + fmtDate(maintenance.enabledAt || maintenance.updatedAt)
        : 'Desactivado - ' + fmtDate(maintenance.disabledAt || maintenance.updatedAt);
    };
    const renderDashboardMaintenance = () => {
      const dashboardMaintenance = state.snapshot.dashboardMaintenance || {};
      byId('dashboardMaintenanceMessage').value = dashboardMaintenance.message || '';
      byId('dashboardMaintenanceLabel').textContent = dashboardMaintenance.enabled ? 'Activo' : 'Desactivado';
      byId('dashboardMaintenanceDetails').textContent = dashboardMaintenance.enabled
        ? 'Dashboard Free bloqueada. Actualizado: ' + fmtDate(dashboardMaintenance.updatedAt)
        : 'La dashboard principal esta disponible para Free y Premium.';
      byId('dashboardMaintenanceMeta').textContent = dashboardMaintenance.enabled
        ? 'Activado por ' + (dashboardMaintenance.enabledBy || 'admin') + ' - ' + fmtDate(dashboardMaintenance.enabledAt || dashboardMaintenance.updatedAt)
        : 'Desactivado - ' + fmtDate(dashboardMaintenance.disabledAt || dashboardMaintenance.updatedAt);
    };
    const renderGuilds = () => {
      const guilds = state.snapshot.guilds || [];
      byId('guildCount').textContent = guilds.length + ' servidores';
      byId('guildRows').innerHTML = guilds.map((guild) => {
        const status = [
          guild.installed ? 'Bot instalado' : 'No instalado',
          guild.configured ? 'Configurado' : 'Sin setup',
          guild.staffRoleId ? 'Staff OK' : 'Staff falta'
        ].join(' · ');
        const premium = guild.premiumSummary?.label || (guild.premiumEntitled ? 'Premium' : 'Free');
        const security = guild.securitySummary?.label || (guild.security?.enabled ? 'Activo' : 'Off');
        return '<tr><td><strong>' + html(guild.guildName || guild.guildId) + '</strong><br><span>' + html(guild.guildId) + '</span></td><td>' + html(status) + '</td><td>' + html(premium) + '</td><td>' + html(security) + '</td><td>' + html(String(guild.panelsCount || 0)) + ' paneles<br><span>' + html(String(guild.componentsCount || 0)) + ' componentes</span></td></tr>';
      }).join('') || '<tr><td colspan="5">No hay servidores configurados todavia.</td></tr>';
    };
    const renderTickets = () => {
      const tickets = state.snapshot.tickets || [];
      byId('ticketCount').textContent = tickets.length + ' tickets recientes';
      byId('ticketRows').innerHTML = tickets.map((ticket) => (
        '<tr><td><strong>#' + html(ticket.channelName || ticket.channelId) + '</strong><br><span>' + html(ticket.channelId) + '</span></td><td>' + html(ticket.guildName || ticket.guildId) + '</td><td>' + html(ticket.status || 'open') + '</td><td>' + html(ticket.openerUserId || ticket.userId || '-') + '</td><td>' + html(fmtDate(ticket.createdAt)) + '</td></tr>'
      )).join('') || '<tr><td colspan="5">No hay tickets todavia.</td></tr>';
    };
    const renderFeedback = () => {
      const feedback = state.snapshot.feedback || [];
      byId('feedbackCount').textContent = feedback.length + ' ratings recientes';
      byId('feedbackRows').innerHTML = feedback.map((item) => (
        '<tr><td><strong>' + html(item.rating ?? '-') + '/5</strong></td><td>' + html(item.guildName || item.guildId || '-') + '</td><td>' + html(item.channelName || item.channelId || '-') + '</td><td>' + html(short(item.comment || item.reason || '', 150)) + '</td><td>' + html(fmtDate(item.createdAt)) + '</td></tr>'
      )).join('') || '<tr><td colspan="5">No hay feedback guardado.</td></tr>';
    };
    const renderAiQuality = () => {
      const signals = state.snapshot.aiQualitySignals || [];
      const unresolved = signals.filter((signal) => !signal.resolved).length;
      byId('aiQualityCount').textContent = unresolved + ' pendientes / ' + signals.length + ' totales';
      byId('aiQualityRows').innerHTML = signals.slice(0, 80).map((item) => (
        '<tr><td><strong>' + html(item.severity || '-') + '</strong><br><span>' + html(String(item.confidence ?? 0)) + '%</span></td><td>' + html(item.category || 'general') + '</td><td>' + html(item.username || item.userId || '-') + '<br><span>#' + html(item.channelName || item.channelId || '-') + '</span></td><td>' + html(short(item.userMessage, 180)) + '</td><td>' + html(short(item.reason, 150)) + '</td><td>' + html(fmtDate(item.createdAt)) + '</td></tr>'
      )).join('') || '<tr><td colspan="6">No hay quejas de IA detectadas.</td></tr>';
    };
    const renderBlacklist = () => {
      const entries = state.snapshot.blacklistEntries || [];
      byId('blacklistCount').textContent = entries.length + ' entradas';
      byId('blacklistRows').innerHTML = entries.map((entry) => (
        '<tr><td><strong>' + html(entry.userId || '-') + '</strong><br><span>' + html(entry.banCode || '') + '</span></td><td>' + html(entry.active ? 'Activa' : 'Inactiva') + '</td><td>' + html(short(entry.reason, 170)) + '</td><td>' + html(fmtDate(entry.expiresAt)) + '</td></tr>'
      )).join('') || '<tr><td colspan="4">No hay blacklist interna.</td></tr>';
    };
    const renderFeed = () => {
      const feed = byId('adminFeed');
      feed.innerHTML = state.events.slice(0, 40).map((event) => (
        '<div class="admin-feed-item"><strong>' + html(event.type || 'event') + '</strong><span>' + html(fmtDate(event.at || event.receivedAt)) + '</span><p>' + html(short(JSON.stringify(event.payload || event), 220)) + '</p></div>'
      )).join('') || '<div class="admin-feed-item"><strong>Esperando eventos</strong><span>La conexion live esta preparada.</span></div>';
    };
    const renderAll = () => {
      renderStats();
      renderMaintenance();
      renderDashboardMaintenance();
      renderGuilds();
      renderTickets();
      renderFeedback();
      renderAiQuality();
      renderBlacklist();
      renderFeed();
      byId('lastUpdate').textContent = 'Actualizado: ' + fmtDate(state.snapshot.generatedAt);
    };
    const loadSnapshot = async (silent = false) => {
      try {
        const response = await fetch('/admin/api/snapshot', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        state.snapshot = await response.json();
        renderAll();
        if (!silent) setToast('Snapshot admin actualizado.');
      } catch (error) {
        byId('adminLiveState').textContent = 'Live con errores';
        byId('adminLiveState').classList.add('is-off');
        setToast('No pude cargar snapshot admin: ' + error.message);
      }
    };
    const setMaintenance = async (enabled) => {
      try {
        const response = await fetch('/admin/api/maintenance', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled,
            delaySeconds: Number(byId('maintenanceDelay').value || 3.5),
            message: byId('maintenanceMessage').value
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
        state.snapshot.maintenance = body.maintenance;
        renderAll();
        await loadSnapshot(true);
        setToast(enabled ? 'Modo mantenimiento activado.' : 'Modo mantenimiento desactivado.');
      } catch (error) {
        setToast('No pude cambiar mantenimiento: ' + error.message);
      }
    };
    const setDashboardMaintenance = async (enabled) => {
      try {
        const response = await fetch('/admin/api/dashboard-maintenance', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled,
            message: byId('dashboardMaintenanceMessage').value
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
        state.snapshot.dashboardMaintenance = body.dashboardMaintenance;
        renderAll();
        await loadSnapshot(true);
        setToast(enabled ? 'Mantenimiento de dashboard activado.' : 'Mantenimiento de dashboard desactivado.');
      } catch (error) {
        setToast('No pude cambiar dashboard maintenance: ' + error.message);
      }
    };
    byId('activateMaintenance').addEventListener('click', () => setMaintenance(true));
    byId('disableMaintenance').addEventListener('click', () => setMaintenance(false));
    byId('activateDashboardMaintenance').addEventListener('click', () => setDashboardMaintenance(true));
    byId('disableDashboardMaintenance').addEventListener('click', () => setDashboardMaintenance(false));
    renderAll();
    setInterval(() => loadSnapshot(true), 20000);
    if (window.EventSource) {
      const source = new EventSource('/admin/events');
      source.addEventListener('ready', () => {
        byId('adminLiveState').textContent = 'Live conectado';
        byId('adminLiveState').classList.remove('is-off');
      });
      source.addEventListener('admin.event', (message) => {
        try {
          const event = JSON.parse(message.data);
          state.events.unshift({ ...event, receivedAt: new Date().toISOString() });
          renderFeed();
          loadSnapshot(true);
        } catch {
          state.events.unshift({ type: 'raw.event', payload: message.data, receivedAt: new Date().toISOString() });
          renderFeed();
        }
      });
      source.onerror = () => {
        byId('adminLiveState').textContent = 'Reconectando live';
        byId('adminLiveState').classList.add('is-off');
      };
    }
  </script>`;
}

function renderBackupsPage({ session, guilds = [], backups = [], restores = [], config }) {
  const initial = JSON.stringify({ guilds, backups, restores }).replace(/</g, '\\u003c');
  const dashboardUrl = config.DASHBOARD_PUBLIC_URL.replace(/\/$/, '');
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Backups - NexaDesk</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#050505; --panel:rgba(16,16,16,.82); --panel2:rgba(255,255,255,.06); --line:rgba(255,255,255,.16); --text:#f7f7f7; --muted:#aaa; --gold:#d6b86a; --danger:#ff5c5c; --ok:#72f0a2; }
    * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:#050505; overflow-x:hidden; }
    body::before { content:""; position:fixed; inset:-20%; pointer-events:none; background:radial-gradient(circle at 16% 6%, rgba(255,255,255,.18), transparent 25%), radial-gradient(circle at 80% 18%, rgba(214,184,106,.18), transparent 28%), repeating-linear-gradient(90deg, rgba(255,255,255,.055) 0 1px, transparent 1px 96px), repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 1px, transparent 1px 96px); animation: drift 18s ease-in-out infinite alternate; }
    @keyframes drift { from { transform:translate3d(-18px,-10px,0) scale(1); } to { transform:translate3d(18px,14px,0) scale(1.04); } }
    main { position:relative; z-index:1; width:min(1180px, calc(100% - 28px)); margin:0 auto; padding:30px 0 70px; }
    nav { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:22px; }
    .brand { display:flex; align-items:center; gap:12px; color:#fff; text-decoration:none; font-weight:950; letter-spacing:-.02em; }
    .brand img { width:42px; height:42px; border-radius:12px; border:1px solid rgba(255,255,255,.35); background:#000; }
    .nav-links { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; }
    a.pill, button { border:1px solid var(--line); border-radius:999px; background:rgba(255,255,255,.08); color:#fff; padding:11px 14px; text-decoration:none; font-weight:900; cursor:pointer; transition:.2s ease; }
    button:hover, a.pill:hover { transform:translateY(-1px); border-color:rgba(255,255,255,.34); background:rgba(255,255,255,.14); }
    button.primary { background:#fff; color:#000; }
    button.gold { background:linear-gradient(135deg, #fff2b7, var(--gold)); color:#0a0a0a; border-color:rgba(255,255,255,.46); }
    button.danger { background:rgba(255,92,92,.14); border-color:rgba(255,92,92,.42); color:#ffdede; }
    button:disabled { opacity:.55; cursor:not-allowed; transform:none; }
    .hero { border:1px solid var(--line); border-radius:30px; padding:30px; background:linear-gradient(145deg, rgba(25,25,25,.9), rgba(5,5,5,.72)); box-shadow:0 30px 100px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.08); overflow:hidden; position:relative; }
    .hero::after { content:""; position:absolute; inset:auto -100px -160px auto; width:320px; height:320px; border-radius:50%; background:rgba(255,255,255,.12); filter:blur(24px); }
    .kicker { margin:0 0 10px; color:var(--gold); text-transform:uppercase; letter-spacing:.18em; font-size:12px; font-weight:900; }
    h1 { margin:0; font-size:clamp(42px, 7vw, 86px); line-height:.9; letter-spacing:-.07em; }
    p { color:var(--muted); line-height:1.62; }
    .hero p { max-width:760px; font-size:18px; }
    .grid { display:grid; grid-template-columns:1.05fr .95fr; gap:16px; margin-top:16px; }
    .card { border:1px solid var(--line); border-radius:24px; padding:20px; background:var(--panel); backdrop-filter:blur(18px); box-shadow:0 18px 70px rgba(0,0,0,.25); }
    .card h2 { margin:0 0 8px; font-size:24px; letter-spacing:-.03em; }
    .field { display:grid; gap:8px; margin:14px 0; }
    label { color:#d7d7d7; font-weight:850; font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
    select { width:100%; border:1px solid rgba(255,255,255,.18); border-radius:14px; background:#080808; color:#fff; padding:13px 12px; font:inherit; outline:none; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
    .stat-row { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:16px; }
    .stat { border:1px solid var(--line); border-radius:18px; padding:14px; background:var(--panel2); }
    .stat strong { display:block; font-size:26px; }
    .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .backup-list, .restore-list { display:grid; gap:10px; max-height:520px; overflow:auto; padding-right:4px; }
    .backup-item { border:1px solid var(--line); border-radius:18px; padding:14px; background:rgba(255,255,255,.055); cursor:pointer; transition:.2s ease; }
    .backup-item:hover, .backup-item.selected { border-color:#fff; background:rgba(255,255,255,.11); transform:translateY(-1px); }
    .backup-title { display:flex; justify-content:space-between; gap:10px; font-weight:950; }
    .badge { display:inline-flex; align-items:center; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:5px 8px; font-size:12px; color:#fff; background:rgba(255,255,255,.08); }
    .badge.gold { color:#171000; background:var(--gold); border-color:var(--gold); }
    .meta { color:var(--muted); font-size:13px; margin-top:8px; display:flex; flex-wrap:wrap; gap:8px; }
    .restore-item { border-left:3px solid var(--gold); padding:10px 12px; background:rgba(255,255,255,.045); border-radius:12px; color:#ddd; }
    .empty { border:1px dashed rgba(255,255,255,.24); border-radius:18px; padding:18px; color:var(--muted); background:rgba(255,255,255,.04); }
    .toast { position:fixed; right:18px; bottom:18px; z-index:5; max-width:min(420px, calc(100% - 36px)); border:1px solid rgba(255,255,255,.2); border-radius:18px; padding:14px 16px; background:#fff; color:#050505; box-shadow:0 20px 80px rgba(0,0,0,.45); opacity:0; transform:translateY(12px); transition:.25s ease; pointer-events:none; font-weight:800; }
    .toast.show { opacity:1; transform:translateY(0); }
    .warning { border:1px solid rgba(214,184,106,.34); background:rgba(214,184,106,.08); border-radius:16px; padding:12px 14px; color:#ead9a5; }
    @media (max-width: 860px) { main { width:min(100% - 18px, 720px); padding-top:18px; } nav { align-items:flex-start; } .grid { grid-template-columns:1fr; } .stat-row { grid-template-columns:repeat(2,1fr); } .hero { padding:22px; border-radius:24px; } }
  </style>
</head>
<body>
  <main>
    <nav>
      <a class="brand" href="/"><img src="/assets/nexadesk-logo.svg" alt="">NexaDesk</a>
      <div class="nav-links">
        <a class="pill" href="/">Dashboard</a>
        <a class="pill" href="${escapeHtml(dashboardUrl)}/status">Estado</a>
        <form method="post" action="/logout" style="margin:0"><button type="submit">Cerrar sesion</button></form>
      </div>
    </nav>

    <section class="hero">
      <p class="kicker">Security Recovery Center</p>
      <h1>Backups de servidor, listos para un mal dia.</h1>
      <p>NexaDesk indexa roles, categorias, canales y permisos cada hora. Si un raid destruye el servidor, invita el bot a un servidor nuevo, entra aqui y recrea la estructura desde PostgreSQL.</p>
      <div class="stat-row">
        <div class="stat"><strong id="statBackups">${backups.length}</strong><span>Snapshots</span></div>
        <div class="stat"><strong id="statGuilds">${guilds.filter((guild) => guild.installed).length}</strong><span>Destinos instalados</span></div>
        <div class="stat"><strong id="statRoles">0</strong><span>Roles indexados</span></div>
        <div class="stat"><strong id="statChannels">0</strong><span>Canales indexados</span></div>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h2>1. Selecciona el backup raideado</h2>
        <p>Elige el snapshot del servidor destruido. Puedes crear uno manual antes de tocar nada si todavia queda estructura viva.</p>
        <div class="field">
          <label>Servidor origen para captura manual</label>
          <select id="captureGuild"></select>
        </div>
        <div class="actions">
          <button id="captureBtn" class="primary">Crear backup ahora</button>
          <button id="refreshBtn">Actualizar lista</button>
        </div>
        <div id="backupList" class="backup-list" style="margin-top:16px"></div>
      </div>

      <div class="card">
        <h2>2. Restaura en un servidor nuevo</h2>
        <p>El destino debe tener NexaDesk instalado con permisos altos. Por seguridad, la restauracion crea roles y canales, no borra nada existente.</p>
        <div class="warning">Recomendado: crea un servidor vacio, invita NexaDesk como administrador y restaura ahi para reconstruir rapido.</div>
        <div class="field">
          <label>Servidor destino</label>
          <select id="targetGuild"></select>
        </div>
        <div class="actions">
          <button id="restoreBtn" class="gold">Restaurar estructura</button>
        </div>
        <h2 style="margin-top:24px">Ultimas restauraciones</h2>
        <div id="restoreList" class="restore-list"></div>
      </div>
    </section>
  </main>
  <div id="toast" class="toast"></div>
  <script>
    const initialState = ${initial};
    const state = { ...initialState, selectedBackupId: initialState.backups[0]?.id || '', busy:false };
    const $ = (id) => document.getElementById(id);
    const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
    const fmt = (value) => value ? new Intl.DateTimeFormat('es-ES', { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : 'Fecha desconocida';
    const toast = (message) => { const node = $('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(window.__toastTimer); window.__toastTimer = setTimeout(() => node.classList.remove('show'), 4200); };
    function selectedBackup() { return state.backups.find((backup) => backup.id === state.selectedBackupId) || state.backups[0] || null; }
    function render() {
      const installed = state.guilds.filter((guild) => guild.installed);
      $('statBackups').textContent = state.backups.length;
      $('statGuilds').textContent = installed.length;
      const latest = selectedBackup();
      $('statRoles').textContent = latest?.summary?.roles ?? 0;
      $('statChannels').textContent = latest?.summary?.channels ?? 0;
      $('captureGuild').innerHTML = state.guilds.map((guild) => '<option value="' + html(guild.guildId) + '">' + html(guild.guildName) + (guild.installed ? '' : ' - bot no instalado') + '</option>').join('');
      $('targetGuild').innerHTML = installed.map((guild) => '<option value="' + html(guild.guildId) + '">' + html(guild.guildName) + '</option>').join('') || '<option value="">No hay destinos instalados</option>';
      $('backupList').innerHTML = state.backups.map((backup) => {
        const summary = backup.summary || {};
        const selected = backup.id === state.selectedBackupId ? ' selected' : '';
        return '<div class="backup-item' + selected + '" data-backup="' + html(backup.id) + '"><div class="backup-title"><span>' + html(backup.guildName) + '</span><span class="badge gold">' + html(backup.source) + '</span></div><div class="meta"><span>' + html(fmt(backup.capturedAt)) + '</span><span>' + Number(summary.roles || 0) + ' roles</span><span>' + Number(summary.channels || 0) + ' canales</span><span>' + Number(summary.categories || 0) + ' categorias</span>' + (backup.fallback ? '<span class="badge">fallback</span>' : '') + '</div></div>';
      }).join('') || '<div class="empty">Todavia no hay backups accesibles. Pulsa "Crear backup ahora" o espera al indexado horario.</div>';
      document.querySelectorAll('[data-backup]').forEach((node) => node.addEventListener('click', () => { state.selectedBackupId = node.dataset.backup; render(); }));
      $('restoreList').innerHTML = state.restores.map((item) => '<div class="restore-item"><strong>' + html(item.sourceGuildName) + ' -> ' + html(item.targetGuildName) + '</strong><br><span>' + html(item.status) + ' · ' + html(fmt(item.completedAt || item.createdAt)) + '</span></div>').join('') || '<div class="empty">Aun no has restaurado ningun backup.</div>';
      $('restoreBtn').disabled = state.busy || !selectedBackup() || !installed.length;
      $('captureBtn').disabled = state.busy;
      $('refreshBtn').disabled = state.busy;
    }
    async function api(path, body) {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: body ? { 'content-type':'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status);
      return payload;
    }
    async function reload() {
      const payload = await api('/api/backups');
      state.guilds = payload.guilds || [];
      state.backups = payload.backups || [];
      state.restores = payload.restores || [];
      if (!state.backups.find((backup) => backup.id === state.selectedBackupId)) state.selectedBackupId = state.backups[0]?.id || '';
      render();
    }
    $('refreshBtn').addEventListener('click', async () => { state.busy = true; render(); try { await reload(); toast('Backups actualizados.'); } catch (error) { toast(error.message); } finally { state.busy = false; render(); } });
    $('captureBtn').addEventListener('click', async () => { state.busy = true; render(); try { const payload = await api('/api/backups/capture', { guildId:$('captureGuild').value }); state.backups.unshift(payload.backup); state.selectedBackupId = payload.backup.id; toast('Backup creado y guardado en PostgreSQL.'); await reload(); } catch (error) { toast(error.message); } finally { state.busy = false; render(); } });
    $('restoreBtn').addEventListener('click', async () => {
      const backup = selectedBackup();
      const targetGuildId = $('targetGuild').value;
      if (!backup || !targetGuildId) return;
      if (!confirm('Vas a recrear roles y canales de "' + backup.guildName + '" en el servidor destino. No se borrara nada existente. Continuar?')) return;
      state.busy = true; render();
      try { const payload = await api('/api/backups/restore', { backupId:backup.id, targetGuildId }); state.restores.unshift(payload.restore); toast('Restauracion completada. Revisa Discord.'); await reload(); }
      catch (error) { toast(error.message); }
      finally { state.busy = false; render(); }
    });
    render();
  </script>
</body>
</html>`;
}

function renderLegalPage({ title, eyebrow, intro, updatedAt, sections }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - NexaDesk</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#050505; --panel:#101010; --line:#303030; --text:#fff; --muted:#b6b6b6; --paper:#fff; --ink:#050505; }
    * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:radial-gradient(circle at 12% 0%, rgba(255,255,255,.14), transparent 28%), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 86px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 86px), var(--bg); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(180deg, transparent, rgba(0,0,0,.72)); }
    main { position:relative; z-index:1; width:min(1040px, calc(100% - 32px)); margin:0 auto; padding:38px 0 70px; }
    nav { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; margin-bottom:26px; }
    .brand { display:flex; align-items:center; gap:12px; color:#fff; text-decoration:none; font-weight:900; }
    .brand img { width:42px; height:42px; border:1px solid rgba(255,255,255,.45); border-radius:10px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    a.pill { color:#fff; text-decoration:none; border:1px solid rgba(255,255,255,.22); border-radius:999px; padding:9px 12px; background:rgba(255,255,255,.045); }
    header,.legal-card { border:1px solid rgba(255,255,255,.15); border-radius:20px; background:linear-gradient(145deg, rgba(24,24,24,.88), rgba(7,7,7,.78)); box-shadow:0 24px 90px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.035) inset; }
    header { padding:28px; margin-bottom:16px; overflow:hidden; position:relative; }
    header::after { content:""; position:absolute; right:-120px; top:-140px; width:280px; height:280px; border-radius:50%; background:rgba(255,255,255,.11); filter:blur(18px); }
    .kicker { margin:0 0 12px; color:#fff; text-transform:uppercase; letter-spacing:.14em; font-size:12px; }
    h1 { margin:0; font-size:clamp(38px, 7vw, 78px); line-height:.92; }
    h2 { margin:0 0 10px; font-size:22px; }
    p { color:var(--muted); line-height:1.65; margin:12px 0 0; }
    .updated { display:inline-flex; margin-top:18px; border:1px solid rgba(255,255,255,.24); border-radius:999px; padding:8px 11px; color:#fff; background:rgba(255,255,255,.06); font-size:13px; }
    .legal-grid { display:grid; gap:14px; }
    .legal-card { padding:22px; }
    ul { margin:12px 0 0; padding-left:20px; color:var(--muted); line-height:1.65; }
    li + li { margin-top:7px; }
    .notice { border-style:dashed; background:rgba(255,255,255,.055); }
    @media (max-width:620px) { main { width:100%; padding:18px 12px 42px; } header,.legal-card { border-radius:16px; padding:18px; } nav { align-items:flex-start; } .links { width:100%; } a.pill { flex:1 1 auto; text-align:center; } }
  </style>
</head>
<body>
  <main>
    <nav>
      <a class="brand" href="/login"><img src="/assets/nexadesk-logo.svg" alt="NexaDesk"><span>NexaDesk</span></a>
      <div class="links">
        <a class="pill" href="/terms">Terms</a>
        <a class="pill" href="/privacy">Privacy</a>
        <a class="pill" href="/login">Dashboard</a>
      </div>
    </nav>
    <header>
      <p class="kicker">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(intro)}</p>
      <span class="updated">Ultima actualizacion: ${escapeHtml(updatedAt)}</span>
    </header>
    <section class="legal-grid">
      ${sections.map((section) => `
        <article class="legal-card ${section.notice ? 'notice' : ''}">
          <h2>${escapeHtml(section.title)}</h2>
          ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ''}
          ${section.items?.length ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        </article>
      `).join('')}
    </section>
  </main>
</body>
</html>`;
}

function buildTermsSections() {
  return [
    {
      title: '1. Aceptacion del servicio',
      body: 'Al invitar NexaDesk a un servidor, iniciar sesion en la dashboard o usar sus comandos, aceptas estas condiciones en nombre propio o del servidor que administras.'
    },
    {
      title: '2. Que ofrece NexaDesk',
      items: [
        'Bot de Discord para tickets de soporte con IA, escalado a staff, paneles, menus, componentes, transcripciones y configuracion por servidor.',
        'Compatibilidad con sistemas externos de tickets como Ticket King y canales creados en categorias configuradas.',
        'Dashboard web con OAuth de Discord para administrar servidores donde tengas permisos.',
        'Funciones de seguridad como anti-flood, analisis de links, XN Protect Automod, avisos de blacklist global, Anti-bots Top.gg, anti-alts y anti-nuke.',
        'Funciones premium por servidor como voz con STT/TTS, Modo examen supervisado, IA prioritaria, transcripciones inteligentes, Growth Engine, reviews, Churn Radar, branding e informes.'
      ]
    },
    {
      title: '3. Responsabilidades del servidor',
      items: [
        'El owner o administradores del servidor son responsables de configurar roles, permisos, prompts, paneles y canales adecuados.',
        'El staff humano debe revisar escalados, avisos de seguridad, blacklist externa y decisiones sensibles antes de tomar medidas definitivas.',
        'No debes usar NexaDesk para acosar, vigilar indebidamente, extraer datos privados, automatizar abuso o infringir las normas de Discord.',
        'Debes informar a tus usuarios si usas transcripciones, IA, analisis visual, voz o sistemas de moderacion automatizada en tus tickets.'
      ]
    },
    {
      title: '4. IA y moderacion',
      items: [
        'NexaDesk usa IA para responder tickets, resumir, analizar enlaces, interpretar pruebas visuales cuando este activado y ayudar en la dashboard.',
        'La IA puede equivocarse, omitir contexto o generar respuestas incompletas. Las decisiones importantes deben ser revisadas por staff humano.',
        'En casos de autolesion, amenazas, acoso, abuso legal o seguridad critica, NexaDesk intenta escalar a staff, pero no sustituye servicios profesionales o emergencias reales.'
      ]
    },
    {
      title: '5. Seguridad y servicios externos',
      items: [
        'XN Protect se usa para blacklist global y automod ofensivo/malicioso. NexaDesk muestra fuente, motivo y pruebas cuando estan disponibles.',
        'Top.gg se usa como referencia para Anti-bots. NexaDesk solo banea bots por esta capa si Top.gg confirma que no estan listados.',
        'Groq u otros proveedores compatibles pueden procesar mensajes, imagenes, audio o contexto necesario para prestar funciones de IA.'
      ]
    },
    {
      title: '6. Disponibilidad y cambios',
      items: [
        'NexaDesk se ofrece tal como esta y puede cambiar, pausar funciones, entrar en mantenimiento o modificar limites para proteger estabilidad y costes.',
        'Las funciones premium pueden activarse o desactivarse por servidor segun plan, configuracion o incidencias tecnicas.',
        'Podemos actualizar estas condiciones cuando el producto cambie. La version publicada en esta pagina sera la referencia vigente.'
      ]
    },
    {
      title: '7. Contacto y soporte',
      body: 'Para dudas, soporte, apelaciones o incidencias, utiliza el servidor oficial de soporte: https://discord.gg/vVXbq7ePEZ'
    },
    {
      title: 'Nota legal',
      body: 'Este documento es una politica operativa del proyecto NexaDesk y no constituye asesoramiento legal profesional. Si necesitas cumplimiento legal especifico, revisalo con un especialista.',
      notice: true
    }
  ];
}

function buildPrivacySections() {
  return [
    {
      title: '1. Datos que podemos procesar',
      items: [
        'Datos de Discord necesarios para funcionar: IDs de usuario, servidor, canal, mensaje, rol, nombres visibles, avatar y permisos de servidores gestionables.',
        'Configuracion por servidor: categoria de tickets, rol staff, prompt del servidor, informacion del servidor, paneles, componentes, seguridad, alianzas, crecimiento y premium.',
        'Contenido de tickets: mensajes, respuestas de formularios, adjuntos enlazados, transcripciones, resumenes, estado del ticket y datos de cierre.',
        'Datos de voz premium: transcripciones STT, mensajes de voz convertidos a texto, respuestas TTS y metadatos de sala/canal cuando la funcion esta activa.',
        'Eventos de seguridad: flood, links analizados, resultados de XN Protect Automod, avisos de blacklist, checks de Top.gg, acciones anti-nuke y logs de moderacion.'
      ]
    },
    {
      title: '2. Para que usamos los datos',
      items: [
        'Responder tickets con IA y mantener contexto conversacional.',
        'Avisar a staff con resumen cuando la IA detecta que hace falta asistencia humana.',
        'Guardar transcripciones y valoraciones post-ticket para consulta en dashboard, envio por MD, mejora del soporte y trazabilidad.',
        'Crear paneles, categorias, menus y componentes configurados por el servidor.',
        'Proteger servidores con sistemas anti-flood, anti-scam, automod, anti-bots, anti-alts y anti-nuke.',
        'Mejorar la experiencia de dashboard, estadisticas globales, diagnosticos y funciones premium.'
      ]
    },
    {
      title: '3. Donde se guardan',
      items: [
        'La configuracion, tickets y transcripciones se guardan en PostgreSQL desde el backend de NexaDesk.',
        'La dashboard usa cookies de sesion firmadas para mantener login con Discord OAuth.',
        'Los tokens, claves de servicio y secretos se mantienen como variables de entorno del backend y no deben exponerse al cliente.',
        'Si faltan variables de PostgreSQL en desarrollo, NexaDesk puede usar almacenamiento JSON local.'
      ]
    },
    {
      title: '4. Servicios externos',
      items: [
        'Discord proporciona OAuth, datos de servidor, mensajes y acciones del bot.',
        'Groq u otros proveedores IA pueden recibir fragmentos necesarios para generar respuestas, analizar imagenes, transcribir voz o revisar enlaces.',
        'XN Protect puede recibir contenido textual o IDs para automod y blacklist global.',
        'Top.gg puede recibir IDs de bots para comprobar si estan listados antes de aplicar Anti-bots.',
        'La Raspberry Pi aloja la dashboard publica y ejecuta el worker del bot.'
      ]
    },
    {
      title: '5. Retencion y control',
      items: [
        'Las transcripciones se conservan para soporte y auditoria hasta que el owner del proyecto o administradores autorizados las eliminen o se aplique una politica de limpieza.',
        'Los servidores pueden ajustar prompts, paneles, seguridad y funciones premium desde la dashboard.',
        'Si quieres pedir revision o eliminacion de datos asociados a un servidor, contacta con soporte aportando ID de servidor y contexto.'
      ]
    },
    {
      title: '6. Seguridad',
      items: [
        'NexaDesk limita el acceso a dashboard a usuarios con permisos de gestion en el servidor.',
        'La vault interna requiere codigo dinamico TOTP y no aparece enlazada desde la dashboard normal.',
        'Las acciones de seguridad intentan evitar baneos automaticos sin certeza cuando dependen de APIs externas.',
        'Ningun sistema es perfecto: los administradores deben revisar logs, permisos y escalados importantes.'
      ]
    },
    {
      title: '7. Menores, contenido sensible y emergencias',
      body: 'NexaDesk puede procesar mensajes sensibles dentro de tickets. No debe usarse como sustituto de ayuda profesional, legal, medica o de emergencia. En situaciones de riesgo real, contacta con servicios de emergencia o moderadores humanos inmediatamente.'
    },
    {
      title: '8. Contacto',
      body: 'Para consultas de privacidad, soporte o apelaciones, usa el servidor oficial: https://discord.gg/vVXbq7ePEZ'
    },
    {
      title: 'Nota legal',
      body: 'Esta politica es una descripcion operativa de privacidad para NexaDesk y no sustituye asesoramiento legal profesional.',
      notice: true
    }
  ];
}

function renderLogin(config, { error = '' } = {}) {
  const turnstileEnabled = Boolean(config.TURNSTILE_ENABLED);
  const turnstileConfigured = isTurnstileConfigured(config);
  const turnstileRequired = turnstileEnabled && turnstileConfigured;
  const isReady = Boolean(config.DISCORD_CLIENT_SECRET)
    && (!turnstileEnabled || turnstileConfigured);
  const setupError = !config.DISCORD_CLIENT_SECRET
    ? 'Falta DISCORD_CLIENT_SECRET en el entorno.'
    : turnstileEnabled && !turnstileConfigured
      ? 'Falta configurar TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY en el entorno.'
      : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Login</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <link rel="apple-touch-icon" href="/assets/nexadesk-logo.svg">
  ${turnstileRequired ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
  <style>
    :root { color-scheme: dark; --bg:#050505; --panel:#101010; --panel-2:#181818; --line:#343434; --text:#ffffff; --muted:#a8a8a8; --ink:#050505; --paper:#ffffff; --danger:#ff5f57; --ok:#ffffff; }
    * { box-sizing: border-box; }
    body { min-height:100vh; margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 16% 0%, rgba(255,255,255,.13), transparent 28%), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 72px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px), var(--bg); color:var(--text); overflow-x:hidden; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(180deg, transparent, rgba(5,8,10,.78)); }
    .access-gate { position:fixed; inset:0; z-index:50; display:grid; place-items:center; overflow:hidden; background:#030303; transition:opacity .8s ease, visibility .8s ease; }
    .access-gate.is-hidden { opacity:0; visibility:hidden; pointer-events:none; }
    .gate-rain,.gate-rain::before,.gate-rain::after { content:""; position:absolute; inset:-45% 0; pointer-events:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1440' height='720' viewBox='0 0 1440 720'%3E%3Cg stroke='%23fff' stroke-linecap='round'%3E%3Cline x1='46' y1='28' x2='46' y2='86' opacity='.46'/%3E%3Cline x1='128' y1='202' x2='128' y2='264' opacity='.28'/%3E%3Cline x1='219' y1='92' x2='219' y2='172' opacity='.56'/%3E%3Cline x1='314' y1='318' x2='314' y2='366' opacity='.34'/%3E%3Cline x1='428' y1='10' x2='428' y2='78' opacity='.5'/%3E%3Cline x1='536' y1='154' x2='536' y2='222' opacity='.36'/%3E%3Cline x1='672' y1='424' x2='672' y2='482' opacity='.42'/%3E%3Cline x1='790' y1='62' x2='790' y2='146' opacity='.58'/%3E%3Cline x1='938' y1='246' x2='938' y2='306' opacity='.32'/%3E%3Cline x1='1088' y1='132' x2='1088' y2='212' opacity='.5'/%3E%3Cline x1='1226' y1='462' x2='1226' y2='516' opacity='.34'/%3E%3Cline x1='1368' y1='42' x2='1368' y2='124' opacity='.54'/%3E%3Ccircle cx='74' cy='612' r='1' opacity='.6'/%3E%3Ccircle cx='884' cy='584' r='1' opacity='.54'/%3E%3Ccircle cx='1194' cy='62' r='1' opacity='.5'/%3E%3C/g%3E%3C/svg%3E"); background-size:1440px 720px; animation:gateRain 2.8s linear infinite; opacity:.8; }
    .gate-rain::before { inset:-55% -8% -35% 4%; animation-duration:2.1s; opacity:.48; transform:scaleX(-1); }
    .gate-rain::after { inset:-65% 2% -30% -10%; animation-duration:3.4s; opacity:.36; transform:scale(1.12); }
    .gate-grid { position:absolute; inset:0; background:radial-gradient(circle at 50% 46%, rgba(255,255,255,.12), transparent 24%), repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 96px); mask-image:linear-gradient(180deg, transparent, #000 18%, #000 74%, transparent); opacity:.34; }
    .gate-shell { position:relative; z-index:2; width:min(410px, calc(100% - 34px)); min-height:250px; border:1px solid rgba(255,255,255,.13); border-radius:12px; background:linear-gradient(180deg, rgba(12,12,12,.94), rgba(2,2,2,.92)); box-shadow:0 30px 120px rgba(0,0,0,.72), 0 0 80px rgba(255,255,255,.06); display:grid; place-items:center; padding:28px; overflow:hidden; }
    .gate-shell::before { content:""; position:absolute; inset:-1px; background:linear-gradient(115deg, transparent 0 28%, rgba(255,255,255,.24) 48%, transparent 68%); transform:translateX(-125%); animation:gateScan 2.7s ease-in-out .45s both; }
    .gate-verify,.gate-brand { position:absolute; inset:26px; display:grid; place-items:center; text-align:center; transition:opacity .45s ease, transform .55s cubic-bezier(.2,.8,.2,1), filter .55s ease; }
    .gate-brand { opacity:0; transform:translateY(18px) scale(.96); filter:blur(12px); }
    .access-gate.is-brand .gate-verify { opacity:0; transform:translateY(-18px) scale(.96); filter:blur(10px); }
    .access-gate.is-brand .gate-brand { opacity:1; transform:translateY(0) scale(1); filter:blur(0); }
    .gate-orbit { width:62px; height:62px; border-radius:50%; border:1px solid rgba(255,255,255,.18); display:grid; place-items:center; margin:0 auto 20px; position:relative; box-shadow:0 0 42px rgba(255,255,255,.12); }
    .gate-orbit::before { content:""; position:absolute; inset:-7px; border-radius:inherit; border:1px solid rgba(255,255,255,.1); border-top-color:#fff; animation:spin 1s linear infinite; }
    .gate-check { width:24px; height:24px; border-radius:50%; border:1px solid rgba(255,255,255,.28); display:grid; place-items:center; color:#030303; background:#fff; transform:scale(.7); opacity:0; transition:opacity .25s ease, transform .25s ease; font-weight:950; }
    .access-gate.is-complete .gate-orbit::before { animation:none; border-color:rgba(255,255,255,.18); }
    .access-gate.is-complete .gate-check { opacity:1; transform:scale(1); }
    .gate-title { margin:0; font-size:18px; font-weight:950; letter-spacing:-.03em; }
    .gate-copy { margin:8px auto 0; max-width:310px; font-size:13px; line-height:1.55; color:#a9a9a9; }
    .gate-proof { width:100%; border:1px solid rgba(255,255,255,.11); border-radius:8px; margin-top:18px; padding:10px 12px; display:flex; justify-content:space-between; gap:12px; color:#cfcfcf; background:rgba(255,255,255,.035); font-size:12px; }
    .gate-brand img { width:72px; height:72px; border-radius:16px; border:1px solid rgba(255,255,255,.24); box-shadow:0 0 58px rgba(255,255,255,.18); margin-bottom:20px; }
    .gate-brand strong { display:block; font-size:22px; letter-spacing:.18em; margin-bottom:8px; }
    .gate-progress { position:absolute; left:24px; right:24px; bottom:20px; height:2px; background:rgba(255,255,255,.12); overflow:hidden; border-radius:999px; }
    .gate-progress span { display:block; width:100%; height:100%; background:#fff; transform-origin:left; animation:gateProgress 4.9s cubic-bezier(.2,.8,.2,1) both; }
    .gate-skip { position:absolute; z-index:3; right:18px; bottom:18px; border:1px solid rgba(255,255,255,.16); color:#fff; background:rgba(255,255,255,.045); border-radius:999px; padding:9px 12px; font-weight:800; cursor:pointer; }
    main { position:relative; z-index:1; width:min(1180px, calc(100% - 32px)); min-height:100vh; margin:0 auto; display:grid; grid-template-columns:1.25fr .75fr; gap:32px; align-items:center; padding:44px 0; }
    .intro { animation:rise .7s ease both; }
    .brand { display:flex; gap:14px; align-items:center; margin-bottom:32px; }
    .brand-logo { width:48px; height:48px; object-fit:cover; border-radius:10px; border:1px solid rgba(255,255,255,.55); box-shadow:0 0 44px rgba(255,255,255,.11); }
    .mark { display:grid; place-items:center; width:48px; height:48px; border:1px solid rgba(255,255,255,.55); border-radius:8px; background:#fff; color:#050505; font-weight:900; box-shadow:0 0 42px rgba(255,255,255,.12); }
    .eyebrow { color:var(--paper); text-transform:uppercase; letter-spacing:.12em; font-size:12px; margin:0 0 14px; }
    h1 { margin:0; font-size:clamp(44px, 7vw, 92px); line-height:.92; letter-spacing:0; max-width:780px; }
    p { color:var(--muted); margin:18px 0 0; max-width:690px; font-size:17px; line-height:1.6; }
    .feature-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:34px; }
    .feature { border:1px solid var(--line); background:rgba(255,255,255,.045); border-radius:8px; padding:14px; }
    .feature strong { display:block; margin-bottom:6px; }
    .login-card { border:1px solid var(--line); border-radius:8px; background:linear-gradient(180deg, rgba(24,24,24,.96), rgba(8,8,8,.96)); padding:24px; animation:rise .7s ease .12s both; box-shadow:0 24px 90px rgba(0,0,0,.34); }
    .banner-frame { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:12px; background:#050505; box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; animation:bannerIn .8s cubic-bezier(.2,.8,.2,1) both, bannerGlow 4.8s ease-in-out infinite; }
    .banner-frame::before { content:""; position:absolute; inset:-40% auto -40% -35%; width:34%; z-index:2; pointer-events:none; background:linear-gradient(90deg, transparent, rgba(255,255,255,.34), transparent); filter:blur(10px); transform:skewX(-18deg); animation:bannerScan 5.4s ease-in-out infinite; }
    .banner-frame::after { content:""; position:absolute; inset:0; z-index:1; pointer-events:none; background:radial-gradient(circle at 25% 50%, rgba(255,255,255,.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,.06), transparent 24%, transparent 76%, rgba(255,255,255,.06)); mix-blend-mode:screen; opacity:.58; }
    .banner-frame img { position:relative; z-index:0; display:block; width:100%; background:#050505; transform:scale(1.006); filter:contrast(1.04) brightness(.96); transition:transform .7s cubic-bezier(.2,.8,.2,1), filter .7s ease; }
    .banner-frame:hover img { transform:scale(1.03); filter:contrast(1.12) brightness(1.08); }
    .brand-banner-frame { margin-bottom:18px; }
    .status-line { display:flex; justify-content:space-between; gap:12px; color:var(--muted); border-bottom:1px solid rgba(255,255,255,.08); padding:11px 0; }
    .status-line strong { color:var(--text); }
    .dash-emoji { width:18px; height:18px; object-fit:contain; margin-right:7px; vertical-align:-4px; }
    .login-button { display:block; text-align:center; width:100%; border:0; border-radius:6px; background:#fff; color:#050505; padding:13px; font:inherit; font-weight:900; text-decoration:none; margin-top:22px; cursor:pointer; }
    .login-button:disabled { opacity:.5; cursor:not-allowed; }
    .turnstile-wrap { margin-top:18px; min-height:66px; }
    .turnstile-help { color:var(--muted); font-size:12px; margin:8px 0 0; }
    .legal-links { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; font-size:13px; }
    .legal-links a { color:#fff; text-decoration:none; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:8px 10px; background:rgba(255,255,255,.045); }
    .loading { position:fixed; inset:0; z-index:10; display:none; place-items:center; background:rgba(5,8,10,.88); backdrop-filter:blur(12px); }
    .loading.is-active { display:grid; }
    .loader { width:min(440px, calc(100% - 32px)); border:1px solid var(--line); background:#0b1216; border-radius:8px; padding:24px; text-align:center; }
    .pulse { width:48px; height:48px; margin:0 auto 18px; border-radius:50%; border:2px solid rgba(255,255,255,.18); border-top-color:#fff; animation:spin 1s linear infinite; }
    #loadingPhrase { color:var(--text); font-weight:800; margin:0; }
    #loadingTip { display:block; margin-top:8px; color:var(--muted); line-height:1.45; }
    .error { color:var(--danger); margin-top:14px; }
    @keyframes rise { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
    @keyframes bannerIn { from { opacity:0; transform:translateY(18px) scale(.985); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes bannerScan { 0%, 12% { transform:translateX(0) skewX(-18deg); opacity:0; } 30% { opacity:.85; } 58%, 100% { transform:translateX(430%) skewX(-18deg); opacity:0; } }
    @keyframes bannerGlow { 0%,100% { box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; } 50% { box-shadow:0 22px 90px rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.09) inset; } }
    @keyframes gateRain { from { transform:translate3d(0,-240px,0); } to { transform:translate3d(0,110vh,0); } }
    @keyframes gateScan { 0%,22% { transform:translateX(-125%); opacity:0; } 44% { opacity:.75; } 100% { transform:translateX(125%); opacity:0; } }
    @keyframes gateProgress { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion:reduce) { .banner-frame,.banner-frame::before,.banner-frame img,.gate-rain,.gate-rain::before,.gate-rain::after,.gate-shell::before,.gate-orbit::before,.gate-progress span { animation:none; transition:none; } .access-gate { display:none; } }
    @media (max-width:860px) { main { grid-template-columns:1fr; align-items:start; padding-top:28px; } .feature-row { grid-template-columns:1fr; } }
    @media (max-width:520px) {
      main { width:100%; min-height:100dvh; padding:18px 12px 28px; gap:16px; }
      .brand { margin-bottom:20px; }
      .brand-logo { width:40px; height:40px; }
      h1 { font-size:clamp(38px, 14vw, 58px); }
      p { font-size:15px; }
      .feature-row { margin-top:22px; }
      .login-card { padding:16px; border-radius:14px; }
      .brand-banner-frame { max-height:120px; }
      .brand-banner-frame img { height:100%; object-fit:cover; }
      .status-line { align-items:flex-start; }
      .loader { width:calc(100% - 24px); }
    }
  </style>
</head>
<body>
  <section class="access-gate" id="accessGate" aria-label="Entrada segura NexaDesk">
    <div class="gate-rain"></div>
    <div class="gate-grid"></div>
    <div class="gate-shell">
      <div class="gate-verify">
        <div>
          <div class="gate-orbit"><span class="gate-check">✓</span></div>
          <h2 class="gate-title" id="gateTitle">Verificando acceso seguro</h2>
          <p class="gate-copy" id="gateCopy">Comprobando sesion, navegador y conexion con NexaDesk.</p>
          <div class="gate-proof"><span>NexaDesk Shield</span><strong id="gateStatus">Analizando...</strong></div>
        </div>
      </div>
      <div class="gate-brand">
        <div>
          <img src="/assets/nexadesk-logo.svg" alt="NexaDesk">
          <strong>NEXADESK</strong>
          <p class="gate-copy">Entrando al centro de mando de soporte.</p>
        </div>
      </div>
      <div class="gate-progress"><span></span></div>
    </div>
  </section>
  <div class="loading" id="loading">
    <div class="loader">
      <div class="pulse"></div>
      <p id="loadingPhrase">"La seguridad es un proceso, no un boton." - Bruce Schneier</p>
      <small id="loadingTip">Tip NexaDesk: configura rol staff y canal de logs antes de abrir paneles publicos.</small>
    </div>
  </div>
  <main>
    <section class="intro">
      <div class="brand"><img class="brand-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk"><strong>NexaDesk</strong></div>
      <p class="eyebrow">AI ticket command center</p>
      <h1>La capa IA para cualquier sistema de tickets.</h1>
      <p>NexaDesk no te obliga a cambiar de bot. Trabaja encima de Ticket King, XN Tickets, Guild Manager o tus propios paneles: atiende, resume, escala, guarda transcripciones y ayuda al staff con contexto real.</p>
      <div class="feature-row">
        <div class="feature"><strong>Compatible con todo</strong><span>Detecta tickets externos y se une sin romper tu flujo actual.</span></div>
        <div class="feature"><strong>Staff Copilot</strong><span>Resume el caso, estima riesgo y sugiere el siguiente paso.</span></div>
        <div class="feature"><strong>Crecimiento medible</strong><span>NexaScore, reviews, afiliados y Premium para convertir soporte en confianza.</span></div>
      </div>
    </section>
    <aside class="login-card">
      <div class="banner-frame brand-banner-frame"><img src="/assets/nexadesk-banner.svg" alt="NexaDesk animated monochrome banner"></div>
      <p class="eyebrow">Acceso seguro</p>
      <h2>Entrar con Discord</h2>
      <p>Solo veras servidores donde tengas permisos de gestion.</p>
      <div class="status-line"><span>${renderDashboardEmoji('rightArrow', 'OAuth')}OAuth</span><strong>Discord</strong></div>
      <div class="status-line"><span>${renderDashboardEmoji('server', 'Datos')}Datos</span><strong>PostgreSQL</strong></div>
      <div class="status-line"><span>${renderDashboardEmoji('check', 'Realtime')}Realtime</span><strong>Activo</strong></div>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      ${isReady ? `
        <form class="login-form" id="loginForm" method="post" action="/auth/discord">
          ${turnstileRequired ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${escapeHtml(config.TURNSTILE_SITE_KEY)}" data-theme="dark" data-action="login" data-callback="nexaTurnstileSuccess" data-expired-callback="nexaTurnstileExpired" data-error-callback="nexaTurnstileError"></div><p class="turnstile-help" id="turnstileHelp">Completa la verificación para continuar.</p></div>` : ''}
          <button class="login-button" id="loginButton" type="submit"${turnstileRequired ? ' disabled' : ''}>Continuar con Discord</button>
        </form>
      ` : `<p class="error">${escapeHtml(setupError)}</p>`}
      <div class="legal-links"><a href="/terms">Terms and Conditions</a><a href="/privacy">Privacy Policy</a></div>
    </aside>
  </main>
  <script>
    const loadingCards = [
      { quote: '"La seguridad es un proceso, no un boton." - Bruce Schneier', tip: 'Tip NexaDesk: configura rol staff y canal de logs antes de abrir paneles publicos.' },
      { quote: '"Confia, pero verifica." - proverbio de seguridad', tip: 'Tip NexaDesk: revisa transcripciones antes de cerrar casos delicados.' },
      { quote: '"La privacidad no deberia ser el precio de usar Internet." - Gary Kovacs', tip: 'Tip NexaDesk: no pongas tokens, claves ni datos sensibles en prompts del servidor.' },
      { quote: '"La simplicidad es la maxima sofisticacion." - atribuido a Leonardo da Vinci', tip: 'Tip NexaDesk: empieza con un panel simple y anade componentes cuando el flujo este claro.' }
    ];
    const gate = document.querySelector('#accessGate');
    const gateTitle = document.querySelector('#gateTitle');
    const gateCopy = document.querySelector('#gateCopy');
    const gateStatus = document.querySelector('#gateStatus');
    const finishGate = () => {
      gate?.classList.add('is-hidden');
      window.setTimeout(() => gate?.remove(), 900);
    };
    if (gate && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishGate();
    } else if (gate) {
      window.setTimeout(() => {
        gate.classList.add('is-complete');
        if (gateTitle) gateTitle.textContent = 'Verificacion completada';
        if (gateCopy) gateCopy.textContent = 'Acceso preparado. Cargando interfaz de NexaDesk.';
        if (gateStatus) gateStatus.textContent = 'Permitido';
      }, 2100);
      window.setTimeout(() => gate.classList.add('is-brand'), 3050);
      window.setTimeout(finishGate, 5100);
    }
    let phraseIndex = 0;
    const phrase = document.querySelector('#loadingPhrase');
    const tip = document.querySelector('#loadingTip');
    setInterval(() => {
      phraseIndex = (phraseIndex + 1) % loadingCards.length;
      if (phrase) phrase.textContent = loadingCards[phraseIndex].quote;
      if (tip) tip.textContent = loadingCards[phraseIndex].tip;
    }, 1500);
    const turnstileRequired = ${turnstileRequired ? 'true' : 'false'};
    const loginForm = document.querySelector('#loginForm');
    const loginButton = document.querySelector('#loginButton');
    const turnstileHelp = document.querySelector('#turnstileHelp');

    const setTurnstileState = (ready, message) => {
      if (loginButton && turnstileRequired) {
        loginButton.disabled = !ready;
      }
      if (turnstileHelp && message) {
        turnstileHelp.textContent = message;
      }
    };

    window.nexaTurnstileSuccess = (token) => {
      if (token) {
        setTurnstileState(true, 'Verificación completada.');
      }
    };

    window.nexaTurnstileExpired = () => {
      setTurnstileState(false, 'La verificación ha caducado. Complétala de nuevo.');
    };

    window.nexaTurnstileError = () => {
      setTurnstileState(false, 'No se pudo cargar la verificación. Recarga la página.');
    };

    loginForm?.addEventListener('submit', (event) => {
      const response = loginForm.querySelector('input[name="cf-turnstile-response"]')?.value || '';

      if (turnstileRequired && !response) {
        event.preventDefault();
        setTurnstileState(false, 'Completa la verificación antes de continuar.');
        return;
      }

      loginButton?.setAttribute('disabled', '');
      document.querySelector('#loading')?.classList.add('is-active');
    });
  </script>
</body>
</html>`;
}

function renderError(message) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Error</title>
  <style>
    :root { color-scheme: dark; --bg:#05080a; --line:#20323a; --text:#f2fbfc; --muted:#8ea3aa; --danger:#ff5f57; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(620px, calc(100% - 32px)); border:1px solid var(--line); border-radius:8px; padding:24px; background:#0b1216; }
    h1 { margin:0 0 10px; }
    p { color:var(--muted); }
    code { color:var(--danger); overflow-wrap:anywhere; }
    a { color:#ffffff; }
  </style>
</head>
<body>
  <main>
    <h1>No se pudo cargar el dashboard</h1>
    <p>La sesion de Discord funciona, pero fallo una dependencia del dashboard.</p>
    <code>${escapeHtml(message)}</code>
    <p>Revisa variables de PostgreSQL o ejecuta el schema si el error menciona tablas.</p>
    <a href="/logout" onclick="event.preventDefault(); document.querySelector('form').submit()">Cerrar sesion</a>
    <form method="post" action="/logout"></form>
  </main>
</body>
</html>`;
}

function renderDashboardMaintenancePage({ session, maintenance }) {
  const message = normalizeDashboardMaintenanceState(maintenance).message;
  const username = session?.user?.globalName || session?.user?.username || 'owner';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>NexaDesk - Dashboard en mantenimiento</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#020202; --text:#fff; --muted:#b8b8b8; --line:rgba(255,255,255,.17); --glass:rgba(255,255,255,.07); --ok:#fff; --danger:#ff4d4d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; overflow-x:hidden; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:radial-gradient(circle at 18% 0%, rgba(255,255,255,.16), transparent 28%), radial-gradient(circle at 80% 8%, rgba(255,255,255,.1), transparent 30%), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 86px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 86px), var(--bg); }
    body::before { content:""; position:fixed; inset:-35%; pointer-events:none; background:conic-gradient(from 160deg, transparent, rgba(255,255,255,.12), transparent 28%, rgba(255,255,255,.08), transparent 55%); filter:blur(52px); opacity:.45; animation:spin 28s linear infinite; }
    main { position:relative; z-index:1; width:min(1180px, calc(100% - 28px)); margin:0 auto; padding:32px 0 46px; display:grid; gap:18px; }
    .hero { min-height:420px; border:1px solid var(--line); border-radius:34px; padding:clamp(22px, 5vw, 48px); background:linear-gradient(145deg, rgba(255,255,255,.12), rgba(255,255,255,.035) 44%, rgba(0,0,0,.62)); box-shadow:0 42px 160px rgba(0,0,0,.56), 0 0 0 1px rgba(255,255,255,.04) inset; overflow:hidden; position:relative; display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,420px); gap:28px; align-items:center; }
    .hero::before { content:""; position:absolute; inset:-1px; background:linear-gradient(115deg, transparent 0 30%, rgba(255,255,255,.26) 48%, transparent 68%); transform:translateX(-120%); animation:scan 5.4s ease-in-out infinite; pointer-events:none; }
    .hero::after { content:""; position:absolute; width:520px; height:520px; right:-210px; top:-220px; border-radius:50%; border:1px solid rgba(255,255,255,.18); box-shadow:0 0 0 52px rgba(255,255,255,.035), 0 0 0 118px rgba(255,255,255,.018); animation:ring 8s ease-in-out infinite; }
    .eyebrow { margin:0 0 12px; text-transform:uppercase; letter-spacing:.22em; font-size:12px; color:#fff; opacity:.78; font-weight:950; }
    h1 { margin:0; font-size:clamp(46px, 8vw, 106px); line-height:.86; letter-spacing:-.075em; max-width:780px; }
    p { color:var(--muted); line-height:1.65; font-size:17px; }
    .hero p { max-width:660px; font-size:18px; }
    .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; }
    a,button { border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:13px 16px; color:#050505; background:#fff; text-decoration:none; font-weight:950; cursor:pointer; }
    a.secondary,button.secondary { color:#fff; background:rgba(255,255,255,.07); }
    .status { display:grid; gap:12px; }
    .status-card { border:1px solid var(--line); border-radius:24px; padding:18px; background:rgba(0,0,0,.28); backdrop-filter:blur(18px); }
    .status-card strong { display:block; font-size:26px; margin-top:6px; }
    .status-card span { color:var(--muted); text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:900; }
    .game-wrap { border:1px solid var(--line); border-radius:32px; padding:20px; background:linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.024)); box-shadow:0 30px 110px rgba(0,0,0,.42); }
    .game-head { display:flex; justify-content:space-between; gap:12px; align-items:end; margin-bottom:14px; }
    .game-head h2 { margin:0; font-size:clamp(26px, 4vw, 44px); letter-spacing:-.045em; }
    .score { display:flex; gap:8px; flex-wrap:wrap; }
    .score span { border:1px solid rgba(255,255,255,.16); border-radius:999px; padding:8px 10px; color:#fff; background:rgba(0,0,0,.28); font-weight:900; }
    canvas { width:100%; height:min(430px, 58vh); display:block; border:1px solid rgba(255,255,255,.16); border-radius:24px; background:radial-gradient(circle at 50% 20%, rgba(255,255,255,.12), transparent 28%), #050505; touch-action:none; }
    .mobile-controls { display:none; gap:10px; margin-top:12px; }
    .mobile-controls button { flex:1; color:#fff; background:rgba(255,255,255,.08); }
    .tips { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .tip { border:1px solid var(--line); border-radius:22px; padding:16px; background:var(--glass); }
    .tip strong { display:block; margin-bottom:6px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @keyframes scan { 0%,20% { transform:translateX(-130%); opacity:0; } 44% { opacity:.72; } 72%,100% { transform:translateX(130%); opacity:0; } }
    @keyframes ring { 0%,100% { transform:scale(.98); opacity:.42; } 50% { transform:scale(1.05); opacity:.9; } }
    @media (max-width:860px) { .hero { grid-template-columns:1fr; min-height:auto; border-radius:24px; } .tips { grid-template-columns:1fr; } .game-head { display:grid; } .mobile-controls { display:flex; } canvas { height:420px; } }
    @media (max-width:520px) { main { width:100%; padding:12px 10px 28px; } .hero,.game-wrap { border-radius:22px; padding:16px; } h1 { font-size:clamp(42px, 17vw, 64px); } .hero p,p { font-size:15px; } canvas { height:360px; border-radius:18px; } }
    @media (prefers-reduced-motion:reduce) { body::before,.hero::before,.hero::after { animation:none; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">Dashboard maintenance</p>
        <h1>Estamos blindando el centro de control.</h1>
        <p>Hola ${escapeHtml(username)}. ${escapeHtml(message)}</p>
        <p>Durante el mantenimiento, la dashboard queda en modo protegido para usuarios Free. Los servidores Premium conservan acceso prioritario mientras desplegamos mejoras.</p>
        <div class="actions">
          <a href="/status">Ver estado en vivo</a>
          <a class="secondary" href="/logout" onclick="event.preventDefault(); document.querySelector('#logoutForm').submit()">Cerrar sesion</a>
        </div>
      </div>
      <aside class="status">
        <div class="status-card"><span>Acceso dashboard</span><strong>Mantenimiento</strong></div>
        <div class="status-card"><span>Acceso Premium</span><strong>Prioritario</strong></div>
        <div class="status-card"><span>Bot Discord</span><strong>Operativo</strong></div>
      </aside>
    </section>
    <section class="game-wrap">
      <div class="game-head">
        <div>
          <p class="eyebrow">Nexa Shield Runner</p>
          <h2>Protege los tickets mientras volvemos.</h2>
          <p>Mueve el escudo, recoge tickets blancos y esquiva amenazas rojas. En movil puedes arrastrar o usar botones.</p>
        </div>
        <div class="score"><span id="score">Score 0</span><span id="streak">Racha 0</span><span id="time">60s</span></div>
      </div>
      <canvas id="shieldGame" width="1100" height="430" aria-label="Mini juego de mantenimiento NexaDesk"></canvas>
      <div class="mobile-controls"><button type="button" id="leftBtn">Izquierda</button><button type="button" id="rightBtn">Derecha</button></div>
    </section>
    <section class="tips">
      <article class="tip"><strong>Tip NexaDesk</strong><span>Configura un rol de staff: cuando la IA detecta riesgo, escala con resumen claro.</span></article>
      <article class="tip"><strong>Tip de seguridad</strong><span>Activa Security Guard antes de campañas o alianzas grandes. El mejor raid es el que se corta al principio.</span></article>
      <article class="tip"><strong>Tip Premium</strong><span>Premium mantiene prioridad durante mantenimientos y desbloquea automatizaciones avanzadas.</span></article>
    </section>
  </main>
  <form id="logoutForm" method="post" action="/logout"></form>
  <script>
    const canvas = document.querySelector('#shieldGame');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.querySelector('#score');
    const streakEl = document.querySelector('#streak');
    const timeEl = document.querySelector('#time');
    const player = { x: canvas.width / 2, y: canvas.height - 48, w: 118, h: 22, vx: 0 };
    const drops = [];
    let score = 0;
    let streak = 0;
    let seconds = 60;
    let last = performance.now();
    let spawn = 0;
    function resetDrop(drop) {
      drop.x = 40 + Math.random() * (canvas.width - 80);
      drop.y = -30 - Math.random() * 220;
      drop.r = 13 + Math.random() * 12;
      drop.speed = 130 + Math.random() * 220;
      drop.bad = Math.random() < 0.34;
      drop.spin = Math.random() * 6.28;
    }
    for (let i = 0; i < 12; i += 1) {
      const drop = {};
      resetDrop(drop);
      drop.y -= i * 36;
      drops.push(drop);
    }
    function drawLogo(x, y, size) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, size * .08);
      ctx.lineJoin = 'round';
      ctx.strokeRect(x - size * .48, y - size * .34, size * .96, size * .54);
      ctx.beginPath();
      ctx.moveTo(x - size * .08, y + size * .2);
      ctx.lineTo(x + size * .02, y + size * .42);
      ctx.lineTo(x + size * .2, y + size * .2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - size * .25, y - size * .08);
      ctx.lineTo(x + size * .26, y - size * .08);
      ctx.moveTo(x - size * .2, y + size * .08);
      ctx.lineTo(x + size * .08, y + size * .08);
      ctx.stroke();
      ctx.restore();
    }
    function drawDrop(drop) {
      ctx.save();
      ctx.translate(drop.x, drop.y);
      ctx.rotate(drop.spin);
      if (drop.bad) {
        ctx.strokeStyle = '#ff4d4d';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-drop.r, -drop.r);
        ctx.lineTo(drop.r, drop.r);
        ctx.moveTo(drop.r, -drop.r);
        ctx.lineTo(-drop.r, drop.r);
        ctx.stroke();
      } else {
        drawLogo(0, 0, drop.r * 2.2);
      }
      ctx.restore();
    }
    function step(now) {
      const dt = Math.min(.04, (now - last) / 1000);
      last = now;
      spawn += dt;
      seconds = Math.max(0, seconds - dt);
      player.x += player.vx * dt;
      player.x = Math.max(player.w / 2, Math.min(canvas.width - player.w / 2, player.x));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      for (let x = 0; x < canvas.width; x += 86) ctx.fillRect(x, 0, 1, canvas.height);
      for (let y = 0; y < canvas.height; y += 86) ctx.fillRect(0, y, canvas.width, 1);
      drops.forEach((drop) => {
        drop.y += drop.speed * dt;
        drop.spin += (drop.bad ? 1.8 : .8) * dt;
        const caught = Math.abs(drop.x - player.x) < player.w * .58 && Math.abs(drop.y - player.y) < 36;
        if (caught) {
          score += drop.bad ? -20 : 12 + Math.min(streak, 8);
          streak = drop.bad ? 0 : streak + 1;
          resetDrop(drop);
        } else if (drop.y > canvas.height + 40) {
          if (!drop.bad) streak = 0;
          resetDrop(drop);
        }
        drawDrop(drop);
      });
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(255,255,255,.5)';
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.roundRect(player.x - player.w / 2, player.y, player.w, player.h, 14);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#050505';
      ctx.font = '900 14px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText('NEXA SHIELD', player.x, player.y + 16);
      scoreEl.textContent = 'Score ' + Math.max(0, Math.round(score));
      streakEl.textContent = 'Racha ' + streak;
      timeEl.textContent = Math.ceil(seconds) + 's';
      if (seconds <= 0) {
        seconds = 60;
        score = Math.max(0, Math.round(score * .45));
        streak = 0;
      }
      requestAnimationFrame(step);
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') player.vx = -520;
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') player.vx = 520;
    });
    window.addEventListener('keyup', () => { player.vx = 0; });
    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      player.x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    });
    document.querySelector('#leftBtn')?.addEventListener('pointerdown', () => { player.vx = -520; });
    document.querySelector('#rightBtn')?.addEventListener('pointerdown', () => { player.vx = 520; });
    document.querySelectorAll('#leftBtn,#rightBtn').forEach((button) => button.addEventListener('pointerup', () => { player.vx = 0; }));
    requestAnimationFrame(step);
  </script>
</body>
</html>`;
}

function renderDiscordAuthComplete(session) {
  const username = session?.user?.username ?? 'tu cuenta';
  const guildCount = session?.guilds?.length ?? 0;
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>NexaDesk - Acceso confirmado</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#030303; --text:#fff; --muted:#a9a9a9; --line:rgba(255,255,255,.14); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; overflow:hidden; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 50% 44%, rgba(255,255,255,.13), transparent 24%), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 88px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 88px), var(--bg); color:var(--text); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:url('/assets/nexadesk-logo.svg') center / min(420px, 58vw) no-repeat; opacity:.055; filter:grayscale(1); animation:markPulse 4.8s ease-in-out infinite; }
    .auth-shell { position:relative; z-index:2; min-height:100vh; display:grid; place-items:center; padding:20px; }
    .auth-card { width:min(520px, 100%); border:1px solid var(--line); border-radius:18px; background:linear-gradient(180deg, rgba(16,16,16,.92), rgba(4,4,4,.92)); box-shadow:0 34px 130px rgba(0,0,0,.72), 0 0 100px rgba(255,255,255,.06); padding:26px; text-align:center; overflow:hidden; position:relative; animation:cardIn .72s cubic-bezier(.2,.8,.2,1) both; }
    .auth-card::before { content:""; position:absolute; inset:-1px; background:linear-gradient(115deg, transparent 0 26%, rgba(255,255,255,.22) 48%, transparent 70%); transform:translateX(-130%); animation:scan 3.1s ease-in-out .35s both; pointer-events:none; }
    .auth-logo { width:84px; height:84px; object-fit:contain; border:1px solid rgba(255,255,255,.24); border-radius:20px; padding:14px; background:#050505; box-shadow:0 0 70px rgba(255,255,255,.14); margin:0 auto 18px; }
    .eyebrow { margin:0 0 10px; text-transform:uppercase; letter-spacing:.18em; font-size:12px; color:#fff; opacity:.8; }
    h1 { margin:0; font-size:clamp(32px, 7vw, 62px); line-height:.92; letter-spacing:-.04em; }
    p { margin:14px auto 0; max-width:390px; color:var(--muted); line-height:1.58; }
    .status-grid { display:grid; gap:10px; margin:24px 0 0; text-align:left; }
    .status-line { display:flex; justify-content:space-between; gap:14px; align-items:center; border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:11px 12px; background:rgba(255,255,255,.04); color:var(--muted); }
    .status-line strong { color:#fff; }
    .progress { height:3px; background:rgba(255,255,255,.12); border-radius:999px; overflow:hidden; margin-top:22px; }
    .progress span { display:block; height:100%; width:100%; background:#fff; transform-origin:left; animation:progress 4.15s cubic-bezier(.2,.8,.2,1) both; }
    .phrase { min-height:24px; font-weight:900; color:#fff; margin-top:18px; }
    .auth-tip { min-height:22px; margin-top:6px; color:var(--muted); font-size:13px; }
    .auth-rain,.auth-rain::before,.auth-rain::after { content:""; position:absolute; inset:-45% 0; pointer-events:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1440' height='720' viewBox='0 0 1440 720'%3E%3Cg stroke='%23fff' stroke-linecap='round'%3E%3Cline x1='46' y1='28' x2='46' y2='86' opacity='.46'/%3E%3Cline x1='219' y1='92' x2='219' y2='172' opacity='.56'/%3E%3Cline x1='428' y1='10' x2='428' y2='78' opacity='.5'/%3E%3Cline x1='790' y1='62' x2='790' y2='146' opacity='.58'/%3E%3Cline x1='1088' y1='132' x2='1088' y2='212' opacity='.5'/%3E%3Cline x1='1368' y1='42' x2='1368' y2='124' opacity='.54'/%3E%3Ccircle cx='74' cy='612' r='1' opacity='.6'/%3E%3Ccircle cx='884' cy='584' r='1' opacity='.54'/%3E%3C/g%3E%3C/svg%3E"); background-size:1440px 720px; animation:rain 2.8s linear infinite; opacity:.7; }
    .auth-rain::before { inset:-55% -8% -35% 4%; animation-duration:2.1s; opacity:.42; transform:scaleX(-1); }
    .auth-rain::after { inset:-65% 2% -30% -10%; animation-duration:3.4s; opacity:.3; transform:scale(1.12); }
    .skip { position:fixed; right:18px; bottom:18px; z-index:5; border:1px solid rgba(255,255,255,.16); color:#fff; background:rgba(255,255,255,.045); border-radius:999px; padding:9px 12px; font-weight:800; cursor:pointer; }
    @keyframes rain { from { transform:translate3d(0,-240px,0); } to { transform:translate3d(0,110vh,0); } }
    @keyframes scan { 0%,22% { transform:translateX(-130%); opacity:0; } 44% { opacity:.72; } 100% { transform:translateX(130%); opacity:0; } }
    @keyframes progress { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes cardIn { from { opacity:0; transform:translateY(24px) scale(.97); filter:blur(12px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes markPulse { 0%,100% { opacity:.04; transform:scale(.98); } 50% { opacity:.09; transform:scale(1.02); } }
    @media (prefers-reduced-motion:reduce) { .auth-rain,.auth-rain::before,.auth-rain::after,.auth-card,.auth-card::before,.progress span,body::before { animation:none; } }
  </style>
</head>
<body>
  <div class="auth-rain"></div>
  <main class="auth-shell">
    <section class="auth-card">
      <img class="auth-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk">
      <p class="eyebrow">Discord verificado</p>
      <h1>Preparando tu dashboard</h1>
      <p>OAuth completado para <strong>${escapeHtml(username)}</strong>. Estamos sincronizando servidores, permisos y datos en tiempo real.</p>
      <div class="status-grid">
        <div class="status-line"><span>Identidad Discord</span><strong>Confirmada</strong></div>
        <div class="status-line"><span>Servidores gestionables</span><strong>${escapeHtml(String(guildCount))}</strong></div>
        <div class="status-line"><span>Consola NexaDesk</span><strong>Desbloqueando</strong></div>
      </div>
      <div class="progress"><span></span></div>
      <p class="phrase" id="authPhrase">"Confia, pero verifica." - proverbio de seguridad</p>
      <p class="auth-tip" id="authTip">Tip NexaDesk: revisa permisos del bot antes de publicar paneles.</p>
    </section>
  </main>
  <script>
    const loadingCards = [
      { quote: '"Confia, pero verifica." - proverbio de seguridad', tip: 'Tip NexaDesk: revisa permisos del bot antes de publicar paneles.' },
      { quote: '"La seguridad es un proceso, no un boton." - Bruce Schneier', tip: 'Tip NexaDesk: define rol staff para que las escalaciones no se pierdan.' },
      { quote: '"La privacidad no deberia ser el precio de usar Internet." - Gary Kovacs', tip: 'Tip NexaDesk: evita guardar secretos en prompts o descripciones publicas.' },
      { quote: '"La simplicidad es la maxima sofisticacion." - atribuido a Leonardo da Vinci', tip: 'Tip NexaDesk: empieza por Resumen y deja que el tutorial te guie.' }
    ];
    let index = 0;
    const phrase = document.querySelector('#authPhrase');
    const tip = document.querySelector('#authTip');
    const go = () => { window.location.replace('/'); };
    window.setInterval(() => {
      index = (index + 1) % loadingCards.length;
      if (phrase) phrase.textContent = loadingCards[index].quote;
      if (tip) tip.textContent = loadingCards[index].tip;
    }, 1100);
    window.setTimeout(go, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 900 : 4300);
  </script>
</body>
</html>`;
}

function getDashboardEmojiUrls() {
  return Object.fromEntries(
    ['logs', 'gear', 'siren', 'crown', 'ticket', 'server', 'check', 'nexalogo', 'rightArrow', 'ban', 'wifi', 'global']
      .map((key) => [key, discordEmojiUrl(key)])
  );
}

function renderDashboardEmoji(name, alt = name) {
  const src = discordEmojiUrl(name);
  return src ? `<img class="dash-emoji" src="${src}" alt="${escapeHtml(alt)}" loading="lazy">` : '';
}

function renderDashboard({ session, guilds, tickets, stats, dashboardState = {}, releaseState = buildReleaseState() }) {
  const guildOptions = guilds
    .map((guild) => `<option value="${escapeHtml(guild.guildId)}" data-installed="${guild.installed ? 'true' : 'false'}" data-invite-url="${escapeHtml(guild.inviteUrl)}">${escapeHtml(guild.guildName ?? guild.guildId)}${guild.installed ? '' : ' - instalar bot'}</option>`)
    .join('');

  const guildList = guilds
    .map((guild) => `
      <button class="guild-pill ${guild.installed ? '' : 'is-not-installed'}" type="button" data-guild-id="${escapeHtml(guild.guildId)}" data-installed="${guild.installed ? 'true' : 'false'}" data-invite-url="${escapeHtml(guild.inviteUrl)}">
        <span>
          <strong>${escapeHtml(guild.guildName ?? guild.guildId)}</strong>
          <small>${guild.installed ? (guild.configured ? 'Configurado' : 'Instalado sin configurar') : 'Bot no instalado'} - ${escapeHtml(String(guild.panels?.length ?? 0))} paneles</small>
        </span>
        <i>${guild.installed ? (guild.ticketCategoryName ? 'Listo' : 'Pendiente') : 'Invitar'}</i>
      </button>
    `)
    .join('');

  const ticketRows = tickets
    .map((ticket) => renderTicketRow(ticket))
    .join('');

  const readinessGuilds = stats.installedGuilds || stats.totalGuilds;
  const healthScore = readinessGuilds
    ? Math.round(((stats.configuredGuilds + stats.escalationReadyGuilds + stats.aiReadyGuilds + (stats.securityReadyGuilds || 0)) / (readinessGuilds * 4)) * 100)
    : 0;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Dashboard</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <link rel="apple-touch-icon" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#050505; --panel:#101010; --panel-2:#181818; --line:#343434; --soft-line:rgba(255,255,255,.1); --text:#ffffff; --muted:#a8a8a8; --paper:#ffffff; --ink:#050505; --ok:#ffffff; --danger:#ff5f57; --glass:rgba(15,15,15,.72); --glass-strong:rgba(18,18,18,.9); --glow:rgba(255,255,255,.18); }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    img,svg,video { max-width:100%; }
    html { scroll-behavior:smooth; }
    body { position:relative; min-height:100vh; margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:#030303; color:var(--text); overflow-x:hidden; isolation:isolate; }
    body::before,body::after { content:""; position:fixed; inset:0; pointer-events:none; z-index:0; }
    body::before { background:radial-gradient(circle at 8% 6%, rgba(255,255,255,.18), transparent 26%), radial-gradient(circle at 84% 12%, rgba(255,255,255,.12), transparent 25%), radial-gradient(circle at 48% 100%, rgba(255,255,255,.09), transparent 32%), linear-gradient(180deg, #050505, #030303 46%, #080808); opacity:.92; }
    body::after { background:repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 88px), repeating-linear-gradient(0deg, rgba(255,255,255,.028) 0 1px, transparent 1px 88px); mask-image:radial-gradient(circle at 50% 26%, #000 0 54%, transparent 82%); opacity:.62; animation:gridBreath 12s ease-in-out infinite alternate; }
    .ambient-scene { position:fixed; inset:0; z-index:0; overflow:hidden; pointer-events:none; }
    .ambient-scene::before { content:""; position:absolute; inset:-20%; background:conic-gradient(from 120deg at 50% 50%, transparent, rgba(255,255,255,.12), transparent 24%, rgba(255,255,255,.07), transparent 48%); filter:blur(52px); opacity:.46; animation:auroraSpin 24s linear infinite; }
    .ambient-scene::after { content:""; position:absolute; inset:0; background:radial-gradient(circle, rgba(255,255,255,.32) 0 1px, transparent 1.6px) 0 0 / 92px 92px; opacity:.13; animation:starDrift 18s linear infinite; }
    .ambient-orb { position:absolute; width:38vmax; aspect-ratio:1; border-radius:50%; filter:blur(44px); opacity:.22; background:radial-gradient(circle, rgba(255,255,255,.72), transparent 62%); mix-blend-mode:screen; animation:orbFloat 18s ease-in-out infinite alternate; }
    .ambient-orb.one { left:-16vmax; top:8vh; }
    .ambient-orb.two { right:-18vmax; top:28vh; width:32vmax; animation-duration:22s; animation-delay:-7s; }
    .ambient-orb.three { left:36vw; bottom:-20vmax; width:30vmax; animation-duration:26s; animation-delay:-12s; }
    .ambient-rings { position:absolute; left:50%; top:0; width:min(780px, 76vw); aspect-ratio:1; border:1px solid rgba(255,255,255,.08); border-radius:50%; transform:translate(-50%, -58%); box-shadow:0 0 0 58px rgba(255,255,255,.015), 0 0 0 118px rgba(255,255,255,.01); animation:ringPulse 9s ease-in-out infinite; }
    .app-shell { position:relative; z-index:1; width:min(1440px, calc(100% - 40px)); margin:0 auto; display:grid; grid-template-columns:220px minmax(0,1fr); gap:22px; padding:22px 0 52px; }
    .sidebar { position:sticky; top:22px; height:calc(100vh - 44px); border:1px solid rgba(255,255,255,.16); border-radius:18px; background:linear-gradient(180deg, rgba(18,18,18,.82), rgba(6,6,6,.78)); backdrop-filter:blur(22px) saturate(1.18); padding:16px; animation:rise .55s ease both; box-shadow:0 24px 90px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.035) inset; }
    main { min-width:0; animation:rise .55s ease .08s both; }
    .topbar { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; align-items:stretch; margin-bottom:16px; }
    header { border:1px solid rgba(255,255,255,.16); border-radius:20px; padding:24px; background:linear-gradient(135deg, rgba(24,24,24,.86), rgba(8,8,8,.66)); backdrop-filter:blur(22px) saturate(1.2); overflow:hidden; position:relative; box-shadow:0 28px 110px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.035) inset; }
    header::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(120deg, rgba(255,255,255,.16), transparent 32%, transparent 68%, rgba(255,255,255,.06)); opacity:.46; }
    header::after { content:""; position:absolute; width:320px; height:320px; right:-150px; top:-170px; border-radius:50%; background:rgba(255,255,255,.12); filter:blur(14px); animation:headerGlow 7s ease-in-out infinite alternate; }
    h1,h2,h3 { margin:0; letter-spacing:0; }
    h1 { font-size:clamp(32px, 4.6vw, 58px); line-height:.96; max-width:760px; position:relative; z-index:1; }
    h2 { font-size:19px; margin-bottom:12px; }
    h3 { font-size:18px; }
    p { margin:8px 0 0; color:var(--muted); line-height:1.55; }
    .brand-lockup { display:flex; gap:14px; align-items:center; margin-bottom:22px; }
    .brand-logo { width:42px; height:42px; object-fit:cover; border-radius:11px; border:1px solid rgba(255,255,255,.55); box-shadow:0 0 38px rgba(255,255,255,.12); }
    .mark { display:grid; place-items:center; width:42px; height:42px; border:1px solid rgba(255,255,255,.55); background:#fff; color:#050505; border-radius:10px; font-weight:900; }
    .nav-brand { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
    .nav-link { display:flex; align-items:center; gap:10px; color:var(--muted); text-decoration:none; border:1px solid transparent; border-radius:10px; padding:10px 11px; margin:4px 0; transition:color .22s ease, border-color .22s ease, background .22s ease, transform .22s ease; }
    .nav-icon { display:grid; place-items:center; width:24px; height:24px; border:1px solid rgba(255,255,255,.16); border-radius:8px; color:#fff; background:rgba(255,255,255,.045); font-size:13px; line-height:1; flex:0 0 auto; }
    .dash-emoji { width:18px; height:18px; object-fit:contain; vertical-align:-4px; margin-right:7px; filter:drop-shadow(0 0 12px rgba(255,255,255,.2)); }
    .nav-icon .dash-emoji { width:16px; height:16px; margin:0; vertical-align:0; }
    .label-with-emoji,.server-status span,.stat span,.status-line span,.check-item span { display:flex; align-items:center; gap:7px; }
    .label-with-emoji .dash-emoji,.server-status .dash-emoji,.stat .dash-emoji,.status-line .dash-emoji,.check-item .dash-emoji { margin-right:0; }
    .nav-link:hover,.nav-link.is-active { color:var(--text); border-color:rgba(255,255,255,.44); background:linear-gradient(135deg, rgba(255,255,255,.12), rgba(255,255,255,.035)); transform:translateX(3px); box-shadow:0 12px 34px rgba(0,0,0,.24), 0 0 28px rgba(255,255,255,.045) inset; }
    .nav-foot { position:absolute; left:16px; right:16px; bottom:16px; }
    .nav-legal { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; font-size:12px; }
    .nav-legal a { color:var(--muted); text-decoration:none; border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:7px 9px; background:rgba(255,255,255,.035); }
    .nav-legal a:hover { color:#fff; border-color:rgba(255,255,255,.36); }
    .hero-panel,.surface,.stat,.active-server { border:1px solid rgba(255,255,255,.16); border-radius:16px; background:var(--glass); backdrop-filter:blur(20px) saturate(1.16); box-shadow:0 20px 70px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.035) inset; }
    .hero-panel { padding:18px; background:linear-gradient(180deg, rgba(26,26,26,.86), rgba(7,7,7,.78)); }
    .banner-frame { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:14px; background:#050505; box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; animation:bannerIn .8s cubic-bezier(.2,.8,.2,1) both, bannerGlow 4.8s ease-in-out infinite; }
    .banner-frame::before { content:""; position:absolute; inset:-40% auto -40% -35%; width:34%; z-index:2; pointer-events:none; background:linear-gradient(90deg, transparent, rgba(255,255,255,.34), transparent); filter:blur(10px); transform:skewX(-18deg); animation:bannerScan 5.4s ease-in-out infinite; }
    .banner-frame::after { content:""; position:absolute; inset:0; z-index:1; pointer-events:none; background:radial-gradient(circle at 25% 50%, rgba(255,255,255,.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,.06), transparent 24%, transparent 76%, rgba(255,255,255,.06)); mix-blend-mode:screen; opacity:.58; }
    .banner-frame img { position:relative; z-index:0; display:block; width:100%; background:#050505; transform:scale(1.006); filter:contrast(1.04) brightness(.96); transition:transform .7s cubic-bezier(.2,.8,.2,1), filter .7s ease; }
    .banner-frame:hover img { transform:scale(1.03); filter:contrast(1.12) brightness(1.08); }
    .dashboard-banner-frame { height:150px; margin-bottom:16px; }
    .dashboard-banner-frame img { height:100%; object-fit:cover; }
    .overview-hero { margin-bottom:18px; animation:cardReveal .58s cubic-bezier(.2,.8,.2,1) both; }
    .signal-list { display:grid; gap:10px; margin-top:16px; }
    .signal { display:flex; justify-content:space-between; gap:18px; padding:10px 0; border-bottom:1px solid var(--soft-line); color:var(--muted); }
    .signal strong { color:var(--text); }
    .view-stage { position:relative; min-height:520px; }
    .dashboard-view { display:none; animation:viewIn .34s cubic-bezier(.2,.8,.2,1) both; }
    .dashboard-view.is-active { display:block; }
    .release-wip { min-height:360px; display:grid; place-items:center; text-align:center; border:1px solid rgba(255,255,255,.16); border-radius:32px; background:radial-gradient(circle at 50% 0%, rgba(255,255,255,.13), transparent 32%), rgba(0,0,0,.72); box-shadow:inset 0 0 0 1px rgba(255,255,255,.04), 0 28px 80px rgba(0,0,0,.32); padding:34px; }
    .release-wip h2 { margin:0; font-size:clamp(34px, 6vw, 76px); letter-spacing:-.08em; text-transform:uppercase; }
    .release-wip p { max-width:620px; margin:14px auto 0; color:var(--muted); font-size:18px; line-height:1.6; }
    .release-wip .wip-pill { display:inline-flex; margin-bottom:14px; padding:8px 12px; border-radius:999px; border:1px solid rgba(255,255,255,.22); color:#050505; background:#fff; font-weight:950; text-transform:uppercase; letter-spacing:.1em; font-size:12px; }
    .release-wip-inline { min-height:0; margin-bottom:14px; padding:18px; border-radius:18px; text-align:left; place-items:start; }
    .release-wip-inline h2 { font-size:clamp(24px, 4vw, 38px); }
    .release-wip-inline p { margin:8px 0 0; font-size:14px; }
    .is-hidden { display:none !important; }
    .view-heading { display:flex; align-items:end; justify-content:space-between; gap:16px; margin:0 0 14px; }
    .view-heading p { margin:4px 0 0; }
    .surface { position:relative; padding:20px; animation:cardReveal .58s cubic-bezier(.2,.8,.2,1) both; transition:border-color .28s ease, transform .28s ease, box-shadow .28s ease; overflow:hidden; }
    .surface::before,.control-card::before,.active-server::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(135deg, rgba(255,255,255,.12), transparent 34%, transparent 72%, rgba(255,255,255,.05)); opacity:.42; }
    .surface:hover { border-color:rgba(255,255,255,.26); box-shadow:0 28px 100px rgba(0,0,0,.3), 0 0 42px rgba(255,255,255,.04) inset; transform:translateY(-1px); }
    .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .stat { position:relative; padding:16px; background:linear-gradient(180deg, rgba(26,26,26,.88), rgba(8,8,8,.78)); overflow:hidden; transition:transform .24s ease, border-color .24s ease; }
    .stat::after { content:""; position:absolute; width:110px; height:110px; right:-60px; top:-60px; border-radius:50%; background:rgba(255,255,255,.1); filter:blur(10px); opacity:.7; }
    .stat:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.28); }
    .stat strong { display:block; font-size:28px; }
    .stat small { display:block; margin-top:6px; }
    .stat span, label, th, dt, small { color:var(--muted); }
    .command-center { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin-bottom:16px; }
    .insight-card { position:relative; border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:16px; background:linear-gradient(145deg, rgba(255,255,255,.1), rgba(255,255,255,.025)); backdrop-filter:blur(18px); box-shadow:0 18px 64px rgba(0,0,0,.22); overflow:hidden; }
    .insight-card::after { content:""; position:absolute; inset:auto -30% -60% 28%; height:160px; background:radial-gradient(circle, rgba(255,255,255,.15), transparent 65%); opacity:.7; }
    .insight-card strong { display:block; font-size:24px; margin-top:8px; }
    .meter { height:9px; border-radius:999px; overflow:hidden; background:#071014; border:1px solid var(--soft-line); margin-top:12px; }
    .meter span { display:block; height:100%; width:var(--value); background:#fff; }
    .mini-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:12px; }
    .mini-grid div { border:1px solid var(--soft-line); border-radius:10px; padding:10px; background:rgba(5,8,10,.38); }
    .mini-grid strong { font-size:18px; margin:0; }
    .workspace { display:grid; grid-template-columns:310px minmax(0,1fr); gap:16px; align-items:start; }
    .single-column { display:grid; gap:16px; }
    .section-heading { display:flex; align-items:end; justify-content:space-between; gap:16px; margin:6px 0 14px; }
    .section-heading p { margin:4px 0 0; }
    .active-server { position:relative; padding:18px; margin-bottom:16px; background:linear-gradient(135deg, rgba(255,255,255,.09), rgba(255,255,255,.025)); overflow:hidden; }
    .active-server select { margin-top:12px; }
    .server-status { display:grid; grid-template-columns:repeat(auto-fit,minmax(125px,1fr)); gap:8px; margin-top:12px; }
    .server-status div { border:1px solid var(--soft-line); border-radius:10px; padding:10px; background:rgba(5,8,10,.42); }
    .server-status strong { display:block; font-size:13px; margin-top:4px; }
    .server-score { display:grid; grid-template-columns:minmax(0,1fr) 220px auto; align-items:center; gap:12px; margin-top:12px; border:1px solid var(--soft-line); border-radius:14px; padding:14px; background:linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); }
    .server-score span { color:var(--muted); }
    .server-score strong { display:block; font-size:30px; line-height:1; margin:6px 0; }
    .server-score small { display:block; color:var(--muted); }
    .server-score .meter { margin:0; min-width:180px; }
    .server-score .quick-action { white-space:nowrap; justify-self:end; }
    .guild-list { display:grid; gap:8px; max-height:560px; overflow:auto; padding-right:4px; }
    .guild-pill { display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; border:1px solid var(--soft-line); background:rgba(10,10,10,.64); color:var(--text); border-radius:14px; padding:12px; cursor:pointer; transition:transform .22s cubic-bezier(.2,.8,.2,1), border-color .22s ease, background .22s ease, box-shadow .22s ease; }
    .guild-pill:hover { transform:translateX(3px); }
    .guild-pill:hover,.guild-pill.is-active { border-color:rgba(255,255,255,.72); background:rgba(255,255,255,.08); box-shadow:0 16px 42px rgba(0,0,0,.28); }
    .guild-pill.is-not-installed { border-style:dashed; background:rgba(255,255,255,.035); }
    .guild-pill.is-not-installed i { color:#050505; background:#fff; padding:5px 8px; border-radius:999px; font-weight:900; }
    .guild-pill strong,.guild-pill small { display:block; }
    .guild-pill i { color:#fff; font-style:normal; font-size:12px; }
    .install-banner { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:center; margin-top:14px; border:1px dashed rgba(255,255,255,.45); border-radius:12px; padding:14px; background:rgba(255,255,255,.055); }
    .install-banner[hidden] { display:none; }
    .install-banner strong { display:block; }
    .install-banner a { display:inline-flex; align-items:center; justify-content:center; min-width:150px; border-radius:10px; padding:11px 12px; color:#050505; background:#fff; text-decoration:none; font-weight:900; }
    .readiness-checklist { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-top:12px; }
    .check-item { display:flex; align-items:center; gap:9px; border:1px solid var(--soft-line); border-radius:11px; padding:10px; color:var(--muted); background:rgba(5,8,10,.38); transition:transform .22s ease, border-color .22s ease, background .22s ease; }
    .check-item::before { content:""; width:10px; height:10px; border-radius:50%; border:1px solid rgba(255,255,255,.45); flex:0 0 auto; }
    .check-item.is-done { color:var(--text); border-color:rgba(255,255,255,.24); background:rgba(255,255,255,.06); }
    .check-item.is-done::before { background:#fff; box-shadow:0 0 18px rgba(255,255,255,.32); }
    .quick-actions { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0 18px; }
    .quick-action { width:auto; border:1px solid var(--line); background:#0a0a0a; color:#fff; border-radius:999px; padding:9px 12px; font-size:13px; }
    .recommendation-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:12px; }
    .recommendation { border:1px solid var(--soft-line); border-radius:13px; padding:13px; background:rgba(255,255,255,.04); transition:transform .22s ease, border-color .22s ease; }
    .recommendation:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.28); }
    .recommendation strong { display:block; margin-bottom:6px; }
    .discovery-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .discovery-item { border:1px solid var(--soft-line); border-radius:13px; padding:12px; background:linear-gradient(145deg, rgba(255,255,255,.07), rgba(255,255,255,.025)); }
    .discovery-item span { display:block; color:var(--muted); font-size:12px; margin-bottom:5px; }
    .discovery-item strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .welcome-preview { display:grid; gap:12px; }
    .welcome-bubble { border:1px solid var(--soft-line); border-radius:18px; padding:14px; background:linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); box-shadow:inset 0 0 0 1px rgba(255,255,255,.03); }
    .welcome-bubble strong,.welcome-bubble span { display:block; }
    .welcome-bubble span { margin-top:7px; color:var(--muted); line-height:1.55; white-space:pre-wrap; }
    .security-playbook { grid-column:1 / -1; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
    .security-playbook div { border:1px solid var(--soft-line); border-radius:14px; padding:12px; background:linear-gradient(145deg, rgba(255,255,255,.07), rgba(255,255,255,.025)); }
    .security-playbook strong,.security-playbook span { display:block; }
    .security-playbook span { color:var(--muted); font-size:13px; margin-top:5px; line-height:1.35; }
    .feedback-card.is-positive { border-color:rgba(82,255,166,.32); }
    .feedback-card.is-warning { border-color:rgba(255,205,82,.34); background:linear-gradient(135deg, rgba(255,205,82,.09), rgba(255,255,255,.025)); }
    .feedback-card.is-critical { border-color:rgba(255,82,82,.42); background:linear-gradient(135deg, rgba(255,82,82,.12), rgba(255,255,255,.025)); }
    .premium-grid { display:grid; grid-template-columns:minmax(320px,.92fr) minmax(0,1.08fr); gap:16px; align-items:start; }
    #view-premium { --gold:#f4c95d; --gold-2:#b98724; --gold-glow:rgba(244,201,93,.24); }
    #view-premium .surface,#view-premium .control-card { border-color:rgba(244,201,93,.28); box-shadow:0 24px 95px rgba(95,61,8,.18); }
    .premium-market { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(0,1.2fr); gap:16px; align-items:start; margin-bottom:16px; }
    .premium-buy-card { background:radial-gradient(circle at 18% 0%, rgba(255,244,184,.28), transparent 34%), linear-gradient(145deg, rgba(244,201,93,.2), rgba(8,7,4,.92)); }
    .premium-buy-card h2 { margin-top:14px; font-size:clamp(26px, 4vw, 44px); line-height:1; color:#fff4c9; font-family:Georgia, "Times New Roman", serif; }
    .premium-sales-note { margin-top:12px; border:1px solid rgba(244,201,93,.22); border-radius:14px; padding:12px; color:#ffeaa8; background:rgba(244,201,93,.075); line-height:1.45; }
    .premium-sales-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .premium-sales-grid div { border:1px solid rgba(244,201,93,.18); border-radius:13px; padding:11px; background:rgba(255,255,255,.04); }
    .premium-sales-grid strong,.premium-sales-grid span { display:block; }
    .premium-sales-grid span { color:#d7c27a; font-size:12px; margin-top:4px; line-height:1.35; }
    .premium-checkout-mode { display:inline-flex; align-items:center; gap:7px; margin-top:8px; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:7px 10px; color:#fff; background:rgba(0,0,0,.28); font-size:12px; font-weight:850; }
    .premium-wallet { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px; margin:16px 0; }
    .premium-wallet div { border:1px solid rgba(244,201,93,.2); border-radius:14px; padding:12px; background:rgba(244,201,93,.07); }
    .premium-wallet strong,.premium-wallet small { display:block; }
    .premium-wallet strong { color:#fff4c9; font-size:24px; }
    .premium-wallet small { margin-top:4px; color:#d7c27a; }
    .premium-activation-list { display:grid; gap:10px; }
    .premium-activation-row { display:grid; grid-template-columns:minmax(0,1fr) 140px; gap:12px; align-items:center; border:1px solid rgba(244,201,93,.2); border-radius:14px; padding:12px; background:linear-gradient(135deg, rgba(244,201,93,.08), rgba(255,255,255,.025)); }
    .premium-activation-row strong,.premium-activation-row span { display:block; }
    .premium-activation-row span { color:var(--muted); font-size:13px; margin-top:3px; }
    .premium-activation-row.is-active { border-color:rgba(244,201,93,.5); background:linear-gradient(135deg, rgba(244,201,93,.18), rgba(255,255,255,.04)); }
    .premium-activation-row button { background:linear-gradient(135deg, #fff6c8, #f4c95d); color:#080704; }
    .premium-activation-row button.secondary-button { background:#0a0a0a; color:#fff4c9; border:1px solid rgba(244,201,93,.32); }
    .premium-hero { min-height:100%; background:radial-gradient(circle at 22% 0%, rgba(244,201,93,.34), transparent 34%), linear-gradient(145deg, rgba(244,201,93,.18), rgba(7,7,6,.92)); }
    .premium-plan { display:inline-flex; align-items:center; gap:8px; border:1px solid rgba(244,201,93,.65); border-radius:999px; padding:7px 10px; color:#120d02; background:linear-gradient(135deg, #fff4b8, var(--gold)); box-shadow:0 0 30px var(--gold-glow); font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .premium-hero h2 { margin-top:18px; font-size:clamp(28px, 4vw, 48px); line-height:.98; }
    .premium-lock { margin-top:16px; border:1px dashed rgba(255,255,255,.38); border-radius:14px; padding:14px; background:rgba(255,255,255,.045); }
    .premium-feature-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:16px; }
    .premium-feature { border:1px solid var(--soft-line); border-radius:13px; padding:12px; background:rgba(255,255,255,.045); transition:transform .22s ease, border-color .22s ease, background .22s ease; }
    .premium-feature:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.3); background:rgba(255,255,255,.075); }
    .premium-feature strong,.premium-feature span { display:block; }
    .premium-feature span { margin-top:5px; color:var(--muted); font-size:13px; line-height:1.45; }
    .premium-toggle-list { display:grid; grid-template-columns:1fr; gap:10px; }
    .premium-toggle { display:grid; grid-template-columns:minmax(0,1fr) 150px; gap:12px; align-items:center; border:1px solid rgba(244,201,93,.22); border-radius:14px; padding:13px; background:linear-gradient(135deg, rgba(244,201,93,.08), rgba(255,255,255,.025)); }
    .premium-toggle strong,.premium-toggle span { display:block; }
    .premium-toggle span { color:var(--muted); font-size:13px; margin-top:3px; line-height:1.45; }
    .premium-locked .premium-toggle select { opacity:.54; }
    .feedback-list { display:grid; gap:10px; margin-top:14px; max-height:360px; overflow:auto; padding-right:4px; }
    .feedback-card { border:1px solid var(--soft-line); border-radius:14px; padding:12px; background:linear-gradient(135deg, rgba(255,255,255,.065), rgba(255,255,255,.025)); }
    .feedback-card strong,.feedback-card span { display:block; }
    .feedback-card span { color:var(--muted); font-size:13px; margin-top:4px; }
    .premium-denied { position:relative; min-height:min(580px, calc(100vh - 250px)); display:grid; place-items:center; border:1px solid rgba(244,201,93,.24); border-radius:22px; overflow:hidden; background:radial-gradient(circle at 50% 22%, rgba(244,201,93,.16), transparent 26%), linear-gradient(145deg, #020202, #080704 58%, #000); box-shadow:0 36px 140px rgba(0,0,0,.62), 0 0 0 1px rgba(244,201,93,.08) inset; }
    .premium-denied::before { content:""; position:absolute; inset:26px; border:1px solid rgba(244,201,93,.22); border-radius:18px; pointer-events:none; }
    .premium-denied::after { content:"PREMIUM"; position:absolute; inset:auto 0 18px; text-align:center; color:rgba(244,201,93,.07); font-size:clamp(48px, 13vw, 160px); font-weight:950; letter-spacing:.18em; pointer-events:none; }
    .premium-denied-inner { position:relative; z-index:1; width:min(780px, calc(100% - 48px)); text-align:center; padding:70px 24px; }
    .premium-denied-kicker { display:inline-flex; margin-bottom:18px; border:1px solid rgba(244,201,93,.45); border-radius:999px; padding:8px 13px; color:#f9df91; background:rgba(244,201,93,.06); font-size:12px; font-weight:900; letter-spacing:.18em; text-transform:uppercase; }
    .premium-denied h2 { font-family:Georgia, "Times New Roman", serif; margin:0; color:#fff4c9; font-size:clamp(40px, 8vw, 92px); line-height:.92; letter-spacing:.02em; text-shadow:0 0 34px rgba(244,201,93,.28); }
    .premium-denied p { margin:22px auto 0; max-width:560px; color:#d7c27a; font-size:clamp(17px, 2.2vw, 24px); }
    .premium-denied a { display:inline-flex; margin-top:28px; align-items:center; justify-content:center; border:1px solid rgba(244,201,93,.45); border-radius:999px; padding:12px 18px; color:#080704; background:linear-gradient(135deg, #fff6c8, #f4c95d); text-decoration:none; font-weight:950; box-shadow:0 0 42px rgba(244,201,93,.18); }
    .control-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .control-card { position:relative; border:1px solid rgba(255,255,255,.16); border-radius:18px; padding:18px; background:linear-gradient(180deg, rgba(24,24,24,.86), rgba(8,8,8,.78)); backdrop-filter:blur(20px) saturate(1.14); transition:transform .28s cubic-bezier(.2,.8,.2,1), border-color .28s ease, box-shadow .28s ease; overflow:hidden; box-shadow:0 22px 80px rgba(0,0,0,.26), 0 0 0 1px rgba(255,255,255,.035) inset; }
    .control-card:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.28); box-shadow:0 28px 100px rgba(0,0,0,.34), 0 0 48px rgba(255,255,255,.045) inset; }
    .control-card.wide { grid-column:1 / -1; }
    .card-head { display:flex; gap:12px; align-items:flex-start; margin-bottom:14px; }
    .step { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:#050505; background:#fff; font-weight:900; flex:0 0 auto; }
    form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    label { display:grid; gap:6px; font-size:14px; }
    input,select,textarea,button { width:100%; min-width:0; border-radius:10px; border:1px solid var(--line); background:#080808; color:var(--text); padding:11px 12px; font:inherit; transition:border-color .22s ease, background .22s ease, transform .22s ease, box-shadow .22s ease; }
    input:focus,select:focus,textarea:focus { outline:0; border-color:rgba(255,255,255,.72); box-shadow:0 0 0 4px rgba(255,255,255,.08); background:#0d0d0d; }
    input[type="color"] { min-height:44px; padding:5px; cursor:pointer; }
    textarea { min-height:140px; resize:vertical; grid-column:1 / -1; }
    .span-2 { grid-column:1 / -1; }
    button { background:#fff; color:#050505; border:0; font-weight:900; cursor:pointer; }
    button:hover { transform:translateY(-1px); box-shadow:0 14px 34px rgba(255,255,255,.12); }
    button:disabled,input:disabled,select:disabled,textarea:disabled { opacity:.48; cursor:not-allowed; }
    .secondary-button { background:#0a0a0a; color:var(--text); border:1px solid var(--line); }
    .form-section { grid-column:1 / -1; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; padding:14px; border:1px solid var(--soft-line); border-radius:14px; background:rgba(255,255,255,.035); }
    .section-label { grid-column:1 / -1; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:2px; }
    .section-label strong { font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .section-label span { color:var(--muted); font-size:13px; }
    .panel-builder { grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr); align-items:start; }
    .panel-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .panel-preview-wrap { position:sticky; top:22px; display:grid; gap:12px; }
    .discord-preview { border:1px solid var(--line); border-radius:16px; background:#313338; padding:16px; box-shadow:0 28px 90px rgba(0,0,0,.32); overflow:hidden; color:#dbdee1; }
    .preview-message { display:grid; grid-template-columns:42px minmax(0,1fr); gap:12px; align-items:start; }
    .preview-avatar { width:42px; height:42px; border-radius:50%; border:1px solid rgba(255,255,255,.22); background:#050505; color:#fff; display:grid; place-items:center; font-weight:900; box-shadow:0 0 18px rgba(255,255,255,.12); }
    .preview-name { display:flex; gap:8px; align-items:center; margin-bottom:8px; font-weight:800; }
    .preview-badge { color:#fff; background:#5865f2; border-radius:5px; padding:2px 5px; font-size:10px; font-weight:900; }
    .embed-preview { border-left:4px solid var(--preview-color,#fff); border-radius:4px; background:#2b2d31; padding:12px; max-width:520px; transition:border-color .22s ease, transform .22s ease; box-shadow:0 1px 0 rgba(0,0,0,.2); }
    .embed-author,.embed-footer { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .embed-title { color:#fff; font-weight:900; margin-top:6px; overflow-wrap:anywhere; }
    .embed-description { color:#d7d7d7; white-space:pre-wrap; overflow-wrap:anywhere; margin-top:6px; line-height:1.45; }
    .embed-media { display:grid; grid-template-columns:74px minmax(0,1fr); gap:10px; margin-top:10px; }
    .embed-thumb,.embed-image { border:1px solid var(--soft-line); border-radius:10px; background:rgba(0,0,0,.18); min-height:58px; display:grid; place-items:center; color:#b5bac1; font-size:12px; overflow:hidden; }
    .embed-thumb img,.embed-image img { width:100%; height:100%; object-fit:cover; display:block; }
    .embed-image { min-height:92px; }
    .preview-button { margin-top:10px; width:auto; display:inline-flex; padding:9px 12px; border-radius:8px; color:#fff; background:#5865f2; transition:background .22s ease, transform .22s ease; }
    .preview-button.secondary { background:#4f545c; }
    .preview-button.success { background:#248046; }
    .preview-button.danger { background:#da373c; }
    .panel-history { border:1px solid var(--soft-line); border-radius:14px; background:rgba(255,255,255,.035); padding:12px; }
    .panel-history h3 { font-size:15px; margin-bottom:10px; }
    .panel-stack { display:grid; gap:8px; max-height:220px; overflow:auto; }
    .panel-card { border:1px solid var(--soft-line); border-radius:12px; padding:11px; background:rgba(5,5,5,.42); transition:transform .22s ease, border-color .22s ease, background .22s ease; }
    .panel-card:hover { transform:translateX(3px); border-color:rgba(255,255,255,.3); background:rgba(255,255,255,.07); }
    .panel-card strong,.panel-card small { display:block; }
    .panel-card small { margin-top:4px; }
    .card-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
    .danger-action { border-color:rgba(255,95,87,.48) !important; color:#fff !important; background:rgba(255,95,87,.12) !important; }
    .menu-preview { margin-top:10px; border:1px solid var(--line); border-radius:8px; background:#181818; color:#d7d7d7; padding:10px 12px; max-width:360px; }
    .menu-preview strong { display:block; color:#fff; margin-bottom:4px; }
    .menu-option-preview { border-top:1px solid var(--soft-line); padding:8px 0; }
    .menu-option-preview:first-of-type { border-top:0; }
    .component-list { display:grid; gap:10px; max-height:360px; overflow:auto; }
    .component-picker { display:grid; gap:8px; max-height:220px; overflow:auto; padding:10px; border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,.03); }
    .component-choice { display:flex; gap:10px; align-items:flex-start; padding:10px; border:1px solid var(--soft-line); border-radius:12px; cursor:pointer; transition:background .18s ease, border-color .18s ease, transform .18s ease; }
    .component-choice:hover { background:rgba(255,255,255,.05); border-color:rgba(255,255,255,.25); transform:translateY(-1px); }
    .component-choice input { width:auto; margin-top:3px; }
    .component-choice span { display:grid; gap:2px; }
    .component-choice small { color:var(--muted); }
    .question-preview { margin-top:8px; color:var(--muted); font-size:12px; }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; padding:12px; border-bottom:1px solid var(--line); }
    .table-action { width:auto; padding:8px 10px; font-size:13px; }
    .kicker { color:#fff; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .notice,.empty-state { border:1px dashed rgba(255,255,255,.38); border-radius:12px; padding:16px; color:var(--muted); background:rgba(255,255,255,.045); }
    .empty-state strong { color:var(--text); display:block; margin-bottom:5px; }
    .ticket-tools { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:14px; }
    .transcript-viewer { margin-top:16px; border:1px solid var(--line); border-radius:14px; background:#080808; overflow:hidden; }
    .transcript-viewer[hidden] { display:none; }
    .transcript-head { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:14px 16px; border-bottom:1px solid var(--line); background:#101010; }
    .transcript-head strong { display:block; }
    .transcript-head span { color:var(--muted); font-size:13px; }
    .transcript-actions { display:flex; gap:8px; align-items:center; }
    .transcript-download { display:inline-flex; align-items:center; justify-content:center; width:auto; border-radius:10px; border:1px solid var(--line); background:#0a0a0a; color:var(--text); padding:8px 10px; font-size:13px; font-weight:900; text-decoration:none; }
    .transcript-body { display:grid; gap:10px; max-height:420px; overflow:auto; padding:16px; }
    .transcript-message { border:1px solid var(--soft-line); border-radius:12px; padding:12px; background:rgba(255,255,255,.035); }
    .transcript-message.assistant { border-color:rgba(255,255,255,.28); background:rgba(255,255,255,.07); }
    .transcript-meta { display:flex; justify-content:space-between; gap:12px; color:var(--muted); font-size:12px; margin-bottom:7px; }
    .transcript-content { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.45; }
    .log-toolbar { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:end; margin-bottom:14px; }
    .log-toolbar select { margin:0; }
    .log-list { display:grid; gap:10px; }
    .log-entry { position:relative; display:grid; gap:10px; border:1px solid var(--line); border-radius:14px; padding:14px; background:linear-gradient(135deg, rgba(255,255,255,.065), rgba(255,255,255,.025)); overflow:hidden; }
    .log-entry::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:#fff; opacity:.8; }
    .log-entry.warning::before { background:#f4c95d; }
    .log-entry.critical::before { background:#ff5f57; }
    .log-entry.success::before { background:#7cff6b; }
    .log-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .log-head strong { display:block; color:var(--text); }
    .log-head span,.log-message,.log-meta { color:var(--muted); }
    .log-badges { display:flex; flex-wrap:wrap; gap:6px; }
    .log-badge { display:inline-flex; align-items:center; gap:5px; border:1px solid rgba(255,255,255,.16); border-radius:999px; padding:5px 8px; background:rgba(255,255,255,.06); color:var(--text); font-size:12px; font-weight:850; }
    .log-message { line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
    .log-meta { display:flex; flex-wrap:wrap; gap:8px; font-size:12px; }
    .log-meta span { border:1px solid rgba(255,255,255,.1); border-radius:999px; padding:5px 8px; background:rgba(0,0,0,.22); }
    .live { color:var(--ok); }
    .toast { position:fixed; right:24px; bottom:88px; z-index:30; max-width:min(420px, calc(100% - 32px)); border:1px solid var(--line); border-radius:14px; background:#101010; color:var(--text); padding:14px 16px; box-shadow:0 22px 70px rgba(0,0,0,.55); transform:translateY(18px); opacity:0; pointer-events:none; transition:opacity .25s ease, transform .25s ease; }
    .toast.is-visible { opacity:1; transform:translateY(0); }
    .assistant-launcher { position:fixed; right:24px; bottom:24px; z-index:32; width:auto; min-width:178px; border-radius:999px; display:flex; align-items:center; gap:10px; padding:12px 16px; box-shadow:0 22px 70px rgba(0,0,0,.55); }
    .assistant-launcher span { display:grid; place-items:center; width:28px; height:28px; border-radius:50%; color:#050505; background:#fff; box-shadow:0 0 22px rgba(255,255,255,.22); }
    .assistant-panel { position:fixed; right:24px; bottom:88px; z-index:31; width:min(430px, calc(100% - 32px)); max-height:min(680px, calc(100vh - 112px)); display:grid; grid-template-rows:auto minmax(0,1fr) auto; border:1px solid rgba(255,255,255,.42); border-radius:18px; background:#f7f7f2; color:#050505; box-shadow:0 28px 110px rgba(0,0,0,.62), 0 0 0 1px rgba(0,0,0,.08) inset; overflow:hidden; transform:translateY(18px) scale(.98); opacity:0; pointer-events:none; transition:opacity .24s ease, transform .24s cubic-bezier(.2,.8,.2,1); }
    .assistant-panel.is-open { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
    .assistant-head { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:16px; border-bottom:1px solid rgba(0,0,0,.14); background:#ffffff; }
    .assistant-head strong,.assistant-head span { display:block; }
    .assistant-head span { color:#565656; font-size:13px; margin-top:3px; }
    .assistant-close { width:36px; height:36px; padding:0; border-radius:10px; }
    .assistant-body { display:grid; gap:10px; overflow:auto; padding:16px; }
    .assistant-message { max-width:92%; border:1px solid rgba(0,0,0,.12); border-radius:14px; padding:12px; background:#ffffff; color:#111; line-height:1.45; white-space:pre-wrap; box-shadow:0 10px 26px rgba(0,0,0,.06); }
    .assistant-message.user { justify-self:end; color:#fff; background:#050505; border-color:#050505; }
    .assistant-message.loading { color:#565656; }
    .assistant-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:9px; }
    .assistant-action { width:auto; border-radius:999px; border:1px solid rgba(0,0,0,.2); background:#050505; color:#fff; padding:7px 10px; font-size:12px; }
    .assistant-quick { display:flex; gap:8px; overflow:auto; padding:0 16px 12px; }
    .assistant-chip { width:auto; flex:0 0 auto; border:1px solid rgba(0,0,0,.16); background:#fff; color:#050505; padding:8px 10px; border-radius:999px; font-size:12px; }
    .assistant-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:14px 16px 16px; border-top:1px solid rgba(0,0,0,.14); background:#ffffff; }
    .assistant-form input { margin:0; background:#f3f3ee; color:#050505; border-color:rgba(0,0,0,.18); }
    .assistant-form input:focus { background:#fff; border-color:#050505; box-shadow:0 0 0 4px rgba(0,0,0,.08); }
    .assistant-form button { width:auto; min-width:88px; }
    .tour-replay { position:fixed; right:218px; bottom:24px; z-index:32; width:auto; border:1px solid rgba(255,255,255,.18); background:rgba(8,8,8,.82); color:#fff; border-radius:999px; padding:12px 15px; box-shadow:0 22px 70px rgba(0,0,0,.48); backdrop-filter:blur(14px); }
    .tour-overlay { position:fixed; inset:0; z-index:80; display:none; pointer-events:none; }
    .tour-overlay.is-open { display:block; pointer-events:auto; }
    .tour-dim { position:absolute; inset:0; background:radial-gradient(circle at 70% 18%, rgba(255,255,255,.11), transparent 28%), rgba(0,0,0,.56); }
    .tour-card { position:fixed; right:24px; bottom:92px; z-index:84; width:min(440px, calc(100% - 32px)); border:1px solid rgba(255,255,255,.34); border-radius:22px; background:linear-gradient(145deg, rgba(255,255,255,.97), rgba(238,238,231,.94)); color:#050505; padding:18px; box-shadow:0 34px 130px rgba(0,0,0,.72), 0 0 0 1px rgba(0,0,0,.07) inset; animation:tourCardIn .34s cubic-bezier(.2,.8,.2,1) both; }
    .tour-card::before { content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; background:linear-gradient(135deg, rgba(255,255,255,.9), transparent 38%, rgba(0,0,0,.06)); }
    .tour-card > * { position:relative; }
    .tour-head { display:flex; gap:12px; align-items:center; margin-bottom:13px; }
    .tour-avatar { display:grid; place-items:center; flex:0 0 auto; width:42px; height:42px; border-radius:14px; background:#050505; color:#fff; font-weight:950; box-shadow:0 18px 44px rgba(0,0,0,.22); }
    .tour-head strong,.tour-head span { display:block; }
    .tour-head span { color:#5b5b5b; font-size:13px; margin-top:3px; }
    .tour-title { margin:0 0 8px; font-size:24px; line-height:1.05; color:#050505; }
    .tour-text { margin:0; color:#333; line-height:1.5; font-weight:650; }
    .tour-progress { height:7px; border-radius:999px; overflow:hidden; background:rgba(0,0,0,.1); margin:16px 0 12px; }
    .tour-progress span { display:block; height:100%; width:0; border-radius:inherit; background:linear-gradient(90deg,#050505,#777); transition:width .25s ease; }
    .tour-dots { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
    .tour-dot { width:8px; height:8px; border-radius:999px; background:rgba(0,0,0,.18); transition:width .2s ease, background .2s ease; }
    .tour-dot.is-active { width:24px; background:#050505; }
    .tour-actions { display:flex; justify-content:flex-end; gap:8px; align-items:center; }
    .tour-actions div { display:flex; gap:8px; }
    .tour-actions button { width:auto; min-width:92px; border-radius:12px; }
    .tour-skip { display:none; }
    .tour-highlight { position:relative; z-index:83 !important; border-radius:18px; outline:2px solid rgba(255,255,255,.96); outline-offset:4px; box-shadow:0 0 0 10px rgba(255,255,255,.13), 0 28px 95px rgba(255,255,255,.18) !important; }
    .tour-highlight::after { content:""; position:absolute; inset:-10px; border-radius:inherit; pointer-events:none; border:1px solid rgba(255,255,255,.5); animation:tourPulse 1.35s ease-in-out infinite; }
    .loading { position:fixed; inset:0; z-index:60; display:grid; place-items:center; background:radial-gradient(circle at 50% 35%, rgba(255,255,255,.14), transparent 28%), rgba(5,8,10,.9); backdrop-filter:blur(14px); transition:opacity .35s ease, visibility .35s ease; }
    .loading.is-hidden { opacity:0; visibility:hidden; }
    .loader { position:relative; width:min(420px, calc(100% - 32px)); border:1px solid rgba(255,255,255,.28); background:linear-gradient(145deg, rgba(255,255,255,.1), rgba(7,18,22,.94)); border-radius:18px; padding:28px; text-align:center; overflow:hidden; box-shadow:0 30px 120px rgba(0,0,0,.55); }
    .loader::after { content:""; position:absolute; inset:auto -20% 0; height:2px; background:linear-gradient(90deg, transparent, #fff, transparent); animation:loaderSweep 1.45s ease-in-out infinite; }
    .pulse { position:relative; width:54px; height:54px; margin:0 auto 18px; border-radius:50%; border:2px solid rgba(255,255,255,.18); animation:loaderPulse 1.45s ease-in-out infinite; }
    .pulse::before,.pulse::after { content:""; position:absolute; inset:9px; border:2px solid #fff; border-radius:50%; opacity:.9; }
    .pulse::after { inset:20px; background:#fff; box-shadow:0 0 28px rgba(255,255,255,.42); }
    #loadingPhrase { color:var(--text); font-weight:900; letter-spacing:.01em; margin:0; }
    #loadingTip { display:block; margin-top:9px; color:var(--muted); line-height:1.45; }
    @keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
    @keyframes viewIn { from { opacity:0; transform:translateY(14px) scale(.992); filter:blur(4px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes cardReveal { from { opacity:0; transform:translateY(18px) scale(.985); filter:blur(8px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes gridBreath { from { opacity:.36; transform:scale(1); } to { opacity:.72; transform:scale(1.025); } }
    @keyframes auroraSpin { to { transform:rotate(360deg); } }
    @keyframes starDrift { from { transform:translate3d(0,0,0); } to { transform:translate3d(-92px,92px,0); } }
    @keyframes orbFloat { from { transform:translate3d(-3%, -2%, 0) scale(.96); } to { transform:translate3d(4%, 3%, 0) scale(1.08); } }
    @keyframes ringPulse { 0%,100% { opacity:.32; transform:translate(-50%, -58%) scale(.98); } 50% { opacity:.68; transform:translate(-50%, -58%) scale(1.04); } }
    @keyframes headerGlow { from { transform:translate3d(0,0,0) scale(.98); opacity:.64; } to { transform:translate3d(-20px,22px,0) scale(1.08); opacity:.92; } }
    @keyframes bannerIn { from { opacity:0; transform:translateY(18px) scale(.985); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes bannerScan { 0%, 12% { transform:translateX(0) skewX(-18deg); opacity:0; } 30% { opacity:.85; } 58%, 100% { transform:translateX(430%) skewX(-18deg); opacity:0; } }
    @keyframes bannerGlow { 0%,100% { box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; } 50% { box-shadow:0 22px 90px rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.09) inset; } }
    @keyframes loaderPulse { 0%,100% { transform:scale(.96); box-shadow:0 0 0 0 rgba(255,255,255,.18); } 50% { transform:scale(1.04); box-shadow:0 0 0 18px rgba(255,255,255,0); } }
    @keyframes loaderSweep { from { transform:translateX(-55%); } to { transform:translateX(55%); } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @keyframes tourCardIn { from { opacity:0; transform:translateY(20px) scale(.97); filter:blur(8px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes tourPulse { 0%,100% { opacity:.24; transform:scale(.98); } 50% { opacity:.72; transform:scale(1.025); } }
    :root {
      --ease-out-pro:cubic-bezier(.16, 1, .3, 1);
      --ease-spring:cubic-bezier(.22, 1.35, .34, 1);
      --surface-pro:linear-gradient(145deg, rgba(255,255,255,.115), rgba(255,255,255,.034) 46%, rgba(255,255,255,.018));
      --surface-pro-hover:linear-gradient(145deg, rgba(255,255,255,.16), rgba(255,255,255,.05) 48%, rgba(255,255,255,.026));
      --hairline:rgba(255,255,255,.18);
      --hairline-strong:rgba(255,255,255,.34);
    }
    html { scroll-behavior:smooth; }
    body { background:#020202; text-rendering:geometricPrecision; -webkit-font-smoothing:antialiased; }
    body::before { opacity:.72; background-size:76px 76px; mask-image:linear-gradient(to bottom, rgba(0,0,0,.9), rgba(0,0,0,.72) 55%, rgba(0,0,0,.18)); }
    body::after { opacity:.92; background:radial-gradient(circle at 18% 8%, rgba(255,255,255,.12), transparent 24%), radial-gradient(circle at 82% 0%, rgba(255,255,255,.08), transparent 26%), linear-gradient(180deg, rgba(255,255,255,.04), transparent 28%, rgba(0,0,0,.32)); }
    ::selection { color:#050505; background:#fff; }
    .app-shell { width:min(1540px, calc(100% - 56px)); grid-template-columns:248px minmax(0,1fr); gap:28px; padding-top:28px; padding-bottom:70px; }
    main { animation:dashboardEnter .78s var(--ease-out-pro) both; }
    main.is-switching .dashboard-view.is-active { animation:viewSwitchPro .46s var(--ease-out-pro) both; }
    .sidebar { top:28px; height:calc(100vh - 56px); border-radius:30px; padding:18px; border-color:rgba(255,255,255,.2); background:linear-gradient(165deg, rgba(255,255,255,.105), rgba(18,18,18,.68) 28%, rgba(2,2,2,.82)); box-shadow:0 36px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.045) inset; overflow:hidden; display:flex; flex-direction:column; min-height:0; }
    .sidebar::before { content:""; position:absolute; inset:-120px -70px auto auto; width:220px; height:220px; border-radius:50%; background:rgba(255,255,255,.13); filter:blur(58px); opacity:.62; pointer-events:none; animation:sidebarGlow 8s ease-in-out infinite alternate; }
    .sidebar > * { position:relative; z-index:1; }
    .nav-brand { margin-bottom:20px; flex:0 0 auto; }
    .nav-menu { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:2px 6px 8px 0; margin-right:-6px; overscroll-behavior:contain; scrollbar-width:thin; }
    .nav-menu::-webkit-scrollbar { width:6px; }
    .nav-menu::-webkit-scrollbar-track { background:transparent; }
    .nav-menu::-webkit-scrollbar-thumb { background:rgba(255,255,255,.22); border-radius:999px; }
    .nav-menu:hover::-webkit-scrollbar-thumb { background:rgba(255,255,255,.44); }
    .brand-logo { border-radius:18px; box-shadow:0 18px 54px rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.18) inset; }
    .nav-link { min-height:45px; border-radius:16px; padding:11px 13px; letter-spacing:.01em; position:relative; overflow:hidden; }
    .nav-link span:last-child { font-weight:800; }
    .nav-link::after { content:""; position:absolute; inset:0; background:linear-gradient(100deg, transparent 0%, rgba(255,255,255,.16) 42%, transparent 74%); transform:translateX(-130%); opacity:0; pointer-events:none; }
    .nav-link:hover::after,.nav-link.is-active::after { animation:softShimmer 1.8s var(--ease-out-pro) both; }
    .nav-link:hover,.nav-link.is-active { border-color:rgba(255,255,255,.56); background:linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,.052)); transform:translateX(5px); }
    .nav-icon { width:22px; display:grid; place-items:center; }
    .nav-foot { position:static; flex:0 0 auto; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,.1); }
    .nav-foot button { width:100%; min-height:44px; white-space:normal; }
    .dashboard-banner-frame { border-radius:28px; height:132px; margin-bottom:18px; border-color:rgba(255,255,255,.16); box-shadow:0 32px 110px rgba(0,0,0,.5); }
    .dashboard-banner-frame::after { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(90deg, rgba(255,255,255,.06), transparent 26%, transparent 72%, rgba(255,255,255,.08)); mix-blend-mode:screen; }
    .dashboard-command-banner { position:relative; isolation:isolate; overflow:hidden; display:grid; grid-template-columns:190px minmax(0,1fr) auto; gap:24px; align-items:center; min-height:132px; padding:18px 24px; border:1px solid rgba(255,255,255,.16); background:radial-gradient(circle at 12% 50%, rgba(255,255,255,.2), transparent 22%), linear-gradient(135deg, rgba(255,255,255,.105), rgba(255,255,255,.025) 44%, rgba(0,0,0,.8)); animation:bannerIn .8s var(--ease-out-pro) both, commandBannerPulse 6.8s ease-in-out infinite; }
    .dashboard-command-banner::before { content:""; position:absolute; inset:-40% auto -40% -25%; width:28%; z-index:2; pointer-events:none; background:linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent); filter:blur(12px); transform:skewX(-18deg); animation:commandBannerSweep 5.2s ease-in-out infinite; }
    .command-banner-grid { position:absolute; inset:0; z-index:-2; background:repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 1px, transparent 1px 74px), repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 1px, transparent 1px 74px); mask-image:linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent); opacity:.9; animation:commandGridDrift 14s linear infinite; }
    .command-banner-signal { position:absolute; z-index:-1; border:1px solid rgba(255,255,255,.2); border-radius:50%; opacity:.72; animation:commandSignal 4.8s ease-in-out infinite; }
    .command-banner-signal.one { width:210px; height:210px; left:28px; top:-42px; }
    .command-banner-signal.two { width:330px; height:330px; right:-110px; bottom:-170px; animation-delay:-1.6s; opacity:.42; }
    .command-banner-mark { width:104px; height:104px; display:grid; place-items:center; justify-self:center; border-radius:30px; background:linear-gradient(180deg,#fff,#dcdcdc); box-shadow:0 22px 72px rgba(255,255,255,.16), 0 0 0 1px rgba(255,255,255,.42) inset; animation:commandMarkFloat 4.8s ease-in-out infinite; }
    .command-banner-mark img { width:70px; height:70px; object-fit:contain; filter:invert(1); }
    .command-banner-copy { min-width:0; }
    .command-banner-copy span { display:block; color:#d8d8d8; text-transform:uppercase; letter-spacing:.22em; font-size:12px; font-weight:950; }
    .command-banner-copy strong { display:block; margin-top:6px; font-size:clamp(36px, 5vw, 74px); line-height:.86; letter-spacing:-.08em; color:#fff; text-shadow:0 0 28px rgba(255,255,255,.18); }
    .command-banner-copy small { display:block; margin-top:10px; color:#cfcfcf; font-size:clamp(14px, 2vw, 18px); white-space:normal; }
    .command-banner-pills { display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
    .command-banner-pills i { font-style:normal; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:8px 10px; color:#fff; background:rgba(0,0,0,.28); font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.12em; box-shadow:0 12px 34px rgba(0,0,0,.28); }
    header { border:1px solid rgba(255,255,255,.14); border-radius:30px; padding:28px; background:linear-gradient(145deg, rgba(255,255,255,.105), rgba(255,255,255,.028)); box-shadow:0 34px 120px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; overflow:hidden; }
    header::before { opacity:.75; filter:blur(56px); }
    h1 { letter-spacing:-.065em; }
    h2,.tour-title { letter-spacing:-.035em; }
    .topbar { grid-template-columns:minmax(0,1fr) minmax(300px,360px); gap:20px; margin-bottom:22px; }
    .hero-panel,.surface,.stat,.active-server,.control-card,.insight-card,.premium-buy-card,.install-banner,.server-score { border-radius:24px; border-color:var(--hairline); background:var(--surface-pro); box-shadow:0 30px 110px rgba(0,0,0,.38), 0 0 0 1px rgba(255,255,255,.038) inset; backdrop-filter:blur(26px) saturate(1.22); }
    .hero-panel { padding:24px; }
    .surface,.control-card,.active-server,.stat { transition:transform .38s var(--ease-out-pro), border-color .38s ease, box-shadow .38s ease, background .38s ease; }
    .surface:hover,.control-card:hover,.active-server:hover,.stat:hover { transform:translateY(-3px); border-color:var(--hairline-strong); background:var(--surface-pro-hover); box-shadow:0 42px 140px rgba(0,0,0,.46), 0 0 42px rgba(255,255,255,.055) inset; }
    .dashboard-view.is-active .surface,.dashboard-view.is-active .control-card,.dashboard-view.is-active .stat,.dashboard-view.is-active .active-server,.dashboard-view.is-active .insight-card { animation:proCardIn .58s var(--ease-out-pro) both; }
    .dashboard-view.is-active .surface:nth-of-type(2),.dashboard-view.is-active .control-card:nth-of-type(2),.dashboard-view.is-active .stat:nth-of-type(2) { animation-delay:.045s; }
    .dashboard-view.is-active .surface:nth-of-type(3),.dashboard-view.is-active .control-card:nth-of-type(3),.dashboard-view.is-active .stat:nth-of-type(3) { animation-delay:.09s; }
    .view-heading,.section-heading { margin-bottom:18px; }
    .view-heading h2,.section-heading h2 { font-size:clamp(26px, 3.2vw, 42px); line-height:.98; }
    input,select,textarea { border-radius:16px; border-color:rgba(255,255,255,.18); background:rgba(0,0,0,.46); transition:border-color .22s ease, box-shadow .22s ease, background .22s ease, transform .22s ease; }
    input:hover,select:hover,textarea:hover { border-color:rgba(255,255,255,.3); background:rgba(0,0,0,.54); }
    input:focus,select:focus,textarea:focus { border-color:#fff; box-shadow:0 0 0 4px rgba(255,255,255,.095), 0 0 32px rgba(255,255,255,.07); background:#050505; }
    button,.login-button,.transcript-download { border-radius:16px; transition:transform .22s var(--ease-out-pro), box-shadow .22s ease, border-color .22s ease, background .22s ease; }
    button:hover,.login-button:hover,.transcript-download:hover { transform:translateY(-2px); box-shadow:0 18px 50px rgba(0,0,0,.34); }
    button:active,.login-button:active,.transcript-download:active { transform:translateY(0) scale(.985); }
    .secondary-button { background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.22); }
    .guild-pill,.component-card,.component-choice,.panel-card,.log-entry,.transcript-message { border-radius:18px; transition:transform .28s var(--ease-out-pro), border-color .28s ease, background .28s ease; }
    .guild-pill:hover,.component-card:hover,.component-choice:hover,.panel-card:hover,.log-entry:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.34); }
    .premium-blocked { border-radius:30px; }
    #view-premium .surface,#view-premium .control-card,#view-premium .premium-buy-card { background:linear-gradient(145deg, rgba(244,201,93,.18), rgba(255,255,255,.055) 40%, rgba(0,0,0,.54)); }
    .scheduled-announcements-list { display:grid; gap:10px; margin-top:14px; }
    .scheduled-announcement-card small { line-height:1.45; }
    .toast,.assistant-panel,.assistant-launcher,.tour-replay { border-radius:22px; }
    .loading { background:radial-gradient(circle at 50% 42%, rgba(255,255,255,.16), transparent 28%), radial-gradient(circle at 20% 14%, rgba(255,255,255,.1), transparent 24%), rgba(0,0,0,.88); backdrop-filter:blur(24px) saturate(1.18); }
    .loader { border-radius:30px; background:linear-gradient(145deg, rgba(255,255,255,.15), rgba(12,12,12,.93)); box-shadow:0 40px 150px rgba(0,0,0,.64), 0 0 0 1px rgba(255,255,255,.05) inset; }
    .tour-overlay { --spot-x:50vw; --spot-y:34vh; }
    .tour-dim { background:radial-gradient(circle at var(--spot-x) var(--spot-y), rgba(255,255,255,.03) 0 120px, rgba(0,0,0,.28) 205px, rgba(0,0,0,.84) 100%), radial-gradient(circle at 72% 12%, rgba(255,255,255,.08), transparent 30%); backdrop-filter:none; }
    .tour-card { border-radius:30px; padding:22px; background:linear-gradient(145deg, rgba(255,255,255,.99), rgba(238,238,232,.97)); box-shadow:0 40px 150px rgba(0,0,0,.72), 0 0 0 1px rgba(0,0,0,.08) inset; }
    .tour-avatar { width:52px; height:52px; border-radius:18px; }
    .tour-actions { justify-content:space-between; }
    .tour-actions::before { content:"Recorrido obligatorio"; color:#555; font-weight:850; font-size:12px; text-transform:uppercase; letter-spacing:.11em; align-self:center; }
    .tour-skip,.gate-skip,.skip { display:none !important; }
    .tour-highlight { outline:2px solid #fff; outline-offset:7px; box-shadow:0 0 0 16px rgba(255,255,255,.14), 0 32px 110px rgba(255,255,255,.18), 0 0 0 1px rgba(0,0,0,.7) inset !important; filter:none !important; }
    * { scrollbar-color:rgba(255,255,255,.34) rgba(255,255,255,.05); }
    *::-webkit-scrollbar { width:10px; height:10px; }
    *::-webkit-scrollbar-track { background:rgba(255,255,255,.04); border-radius:999px; }
    *::-webkit-scrollbar-thumb { background:rgba(255,255,255,.25); border-radius:999px; border:2px solid rgba(0,0,0,.65); }
    *::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.44); }
    @keyframes dashboardEnter { from { opacity:0; transform:translateY(22px) scale(.99); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes viewSwitchPro { from { opacity:0; transform:translateY(18px) scale(.992); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes proCardIn { from { opacity:0; transform:translateY(26px) scale(.985); filter:blur(12px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes softShimmer { 0% { opacity:0; transform:translateX(-140%); } 35% { opacity:.9; } 100% { opacity:0; transform:translateX(140%); } }
    @keyframes sidebarGlow { from { transform:translate3d(0,0,0) scale(.92); opacity:.38; } to { transform:translate3d(-32px,54px,0) scale(1.16); opacity:.72; } }
    @keyframes commandBannerPulse { 0%,100% { box-shadow:0 32px 110px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.035) inset; } 50% { box-shadow:0 34px 140px rgba(255,255,255,.09), 0 0 52px rgba(255,255,255,.04) inset; } }
    @keyframes commandBannerSweep { 0%,18% { opacity:0; transform:translateX(0) skewX(-18deg); } 38% { opacity:.9; } 72%,100% { opacity:0; transform:translateX(560%) skewX(-18deg); } }
    @keyframes commandGridDrift { from { background-position:0 0, 0 0; } to { background-position:74px 0, 0 74px; } }
    @keyframes commandSignal { 0%,100% { transform:scale(.96); opacity:.35; } 50% { transform:scale(1.07); opacity:.82; } }
    @keyframes commandMarkFloat { 0%,100% { transform:translateY(0) rotate(-2deg); } 50% { transform:translateY(-5px) rotate(2deg); } }
    @media (prefers-reduced-motion:reduce) { body::before,body::after,.ambient-scene,.ambient-scene::before,.ambient-scene::after,.ambient-orb,.ambient-rings,.banner-frame,.banner-frame::before,.banner-frame img,.dashboard-command-banner,.dashboard-command-banner::before,.command-banner-grid,.command-banner-signal,.command-banner-mark,.loader::after,.pulse { animation:none; transition:none; } }
    @media (max-width:1120px) { .app-shell,.workspace,.topbar,.command-center,.panel-builder,.premium-grid,.premium-market { grid-template-columns:1fr; } .sidebar { position:relative; height:auto; top:auto; } .nav-foot { position:static; margin-top:18px; } .panel-preview-wrap { position:relative; top:auto; } }
    @media (max-width:760px) {
      body { overflow-x:hidden; background-size:auto; }
      .app-shell { width:100%; display:block; padding:14px 12px 112px; }
      .sidebar { position:fixed; left:10px; right:10px; bottom:10px; top:auto; z-index:45; width:auto; height:auto; margin:0; padding:8px; display:block; overflow:visible; border-radius:28px; background:linear-gradient(145deg, rgba(255,255,255,.16), rgba(8,8,8,.9)); border:1px solid rgba(255,255,255,.18); box-shadow:0 26px 95px rgba(0,0,0,.68), 0 0 0 1px rgba(255,255,255,.04) inset; backdrop-filter:blur(22px) saturate(1.2); }
      .nav-brand,.nav-foot { display:none; }
      .nav-menu { width:100%; min-width:0; display:flex; gap:7px; overflow-x:auto; overflow-y:hidden; padding:0; margin:0; overscroll-behavior-x:contain; scroll-snap-type:x mandatory; scrollbar-width:none; }
      .nav-menu::-webkit-scrollbar { display:none; }
      .nav-link { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; min-width:48px; min-height:48px; margin:0; padding:10px; border-radius:20px; white-space:nowrap; font-size:14px; scroll-snap-align:center; }
      .nav-link span:last-child { display:none; }
      .nav-link.is-active { min-width:max-content; padding:10px 14px; background:rgba(255,255,255,.18); }
      .nav-link.is-active span:last-child { display:inline; }
      .nav-link:hover,.nav-link.is-active { transform:none; }
      .nav-icon { width:24px; }
      main { width:100%; }
      .dashboard-banner-frame { height:auto; min-height:136px; margin-top:10px; }
      .dashboard-command-banner { grid-template-columns:62px minmax(0,1fr); gap:12px; padding:14px; border-radius:18px; }
      .command-banner-mark { width:58px; height:58px; border-radius:18px; }
      .command-banner-mark img { width:38px; height:38px; }
      .command-banner-copy span { font-size:10px; letter-spacing:.16em; }
      .command-banner-copy strong { font-size:clamp(30px, 11vw, 44px); }
      .command-banner-copy small { font-size:13px; margin-top:6px; }
      .command-banner-pills { grid-column:1 / -1; flex-direction:row; align-items:center; justify-content:flex-start; overflow-x:auto; padding-bottom:2px; }
      .command-banner-pills i { font-size:10px; padding:7px 9px; }
      header,.hero-panel,.surface,.active-server,.control-card { padding:14px; border-radius:14px; }
      h1 { font-size:clamp(31px, 12vw, 44px); }
      h2 { font-size:18px; }
      p { font-size:14px; }
      .topbar,.workspace,.command-center,.panel-builder { gap:12px; margin-bottom:12px; }
      .view-heading,.section-heading,.ticket-tools,.transcript-head { display:grid; align-items:start; gap:10px; }
      .log-toolbar,.log-head { grid-template-columns:1fr; display:grid; }
      .active-server { margin-bottom:12px; }
      form,.control-grid,.stats,.server-status,.server-score,.mini-grid,.discovery-grid,.panel-fields,.form-section,.security-playbook,.readiness-checklist,.recommendation-grid,.premium-feature-grid,.premium-toggle,.premium-wallet,.premium-activation-row { grid-template-columns:1fr; }
      input,select,textarea { font-size:16px; min-height:44px; }
      .control-card,.surface,.active-server { scroll-margin-top:16px; }
      label,button { margin-top:0; }
      textarea { min-height:118px; }
      .form-section { padding:10px; }
      .install-banner { grid-template-columns:1fr; }
      .install-banner a { width:100%; }
      .guild-list,.component-list,.component-picker,.panel-stack { max-height:320px; }
      .guild-pill { padding:11px; }
      .guild-pill:hover,.panel-card:hover { transform:none; }
      .server-score .meter { min-width:0; }
      .server-score .quick-action { justify-self:stretch; }
      .preview-message { grid-template-columns:34px minmax(0,1fr); gap:9px; }
      .preview-avatar { width:34px; height:34px; }
      .embed-preview { max-width:100%; }
      .embed-media { grid-template-columns:1fr; }
      table { display:block; width:100%; overflow-x:auto; white-space:nowrap; -webkit-overflow-scrolling:touch; }
      th,td { padding:10px; }
      .transcript-actions { flex-wrap:wrap; }
      .toast { left:12px; right:12px; bottom:100px; max-width:none; }
      .assistant-launcher { right:18px; bottom:76px; min-width:0; padding:11px 13px; }
      .assistant-panel { left:8px; right:8px; bottom:136px; width:auto; max-height:calc(100dvh - 154px); border-radius:18px; }
      .tour-replay { right:auto; left:18px; bottom:76px; min-width:0; padding:11px 13px; }
      .tour-card { left:10px; right:10px; bottom:136px; width:auto; max-height:calc(100dvh - 154px); overflow:auto; border-radius:22px; padding:15px; }
      .tour-title { font-size:21px; }
      .tour-actions { display:grid; grid-template-columns:1fr; }
      .tour-actions div { display:grid; grid-template-columns:1fr 1fr; }
      .tour-actions button { width:100%; }
      .assistant-form { grid-template-columns:1fr; }
      .assistant-form button { width:100%; }
      .loading { min-height:100dvh; }
    }
    @media (max-width:420px) {
      .server-status,.stats { gap:8px; }
      .stat strong { font-size:24px; }
      .assistant-launcher strong { display:none; }
      .assistant-launcher { min-width:auto; border-radius:50%; padding:10px; }
      .assistant-launcher span { margin:0; }
    }
  </style>
</head>
<body>
  <div class="ambient-scene" aria-hidden="true">
    <span class="ambient-orb one"></span>
    <span class="ambient-orb two"></span>
    <span class="ambient-orb three"></span>
    <span class="ambient-rings"></span>
  </div>
  <div class="loading" id="loading">
    <div class="loader">
      <div class="pulse"></div>
      <p id="loadingPhrase">"La seguridad es un proceso, no un boton." - Bruce Schneier</p>
      <small id="loadingTip">Tip NexaDesk: usa contexto IA corto, claro y con limites de escalado.</small>
    </div>
  </div>
  <div class="app-shell">
  <aside class="sidebar">
    <div class="nav-brand"><img class="brand-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk"><strong>NexaDesk</strong></div>
    <nav class="nav-menu" aria-label="Secciones de NexaDesk">
      <a class="nav-link is-active" href="#overview" data-view="overview"><span class="nav-icon">${renderDashboardEmoji('nexalogo', 'Resumen')}</span><span>Resumen</span></a>
      <a class="nav-link" href="#servers" data-view="servers"><span class="nav-icon">${renderDashboardEmoji('server', 'Servidores')}</span><span>Servidores</span></a>
      <a class="nav-link" href="#settings" data-view="settings"><span class="nav-icon">${renderDashboardEmoji('gear', 'Configuracion')}</span><span>Configuracion</span></a>
      <a class="nav-link" href="#components" data-view="components"><span class="nav-icon">${renderDashboardEmoji('ticket', 'Componentes')}</span><span>Componentes</span></a>
      <a class="nav-link" href="#panels" data-view="panels"><span class="nav-icon">${renderDashboardEmoji('ticket', 'Paneles')}</span><span>Paneles</span></a>
      <a class="nav-link" href="#growth" data-view="growth"><span class="nav-icon">${renderDashboardEmoji('rightArrow', 'Crecimiento')}</span><span>Crecimiento</span></a>
      <a class="nav-link" href="#welcome" data-view="welcome"><span class="nav-icon">${renderDashboardEmoji('check', 'Bienvenida')}</span><span>Bienvenida</span></a>
      <a class="nav-link" href="#premium" data-view="premium"><span class="nav-icon">${renderDashboardEmoji('crown', 'Premium')}</span><span>Premium</span></a>
      <a class="nav-link" href="#tickets" data-view="tickets"><span class="nav-icon">${renderDashboardEmoji('ticket', 'Tickets')}</span><span>Tickets</span></a>
      <a class="nav-link" href="#logs" data-view="logs"><span class="nav-icon">${renderDashboardEmoji('logs', 'Logs')}</span><span>Logs</span></a>
    </nav>
    <div class="nav-foot">
      <div class="nav-legal"><a href="/terms" target="_blank" rel="noopener">Terms</a><a href="/privacy" target="_blank" rel="noopener">Privacy</a></div>
      <form method="post" action="/logout"><button class="secondary-button" type="submit">Cerrar sesion</button></form>
    </div>
  </aside>
  <main>
    <div class="overview-hero" id="overviewHero">
      <div class="dashboard-banner-frame dashboard-command-banner" aria-label="NexaDesk secure dashboard banner">
        <div class="command-banner-grid"></div>
        <div class="command-banner-signal one"></div>
        <div class="command-banner-signal two"></div>
        <div class="command-banner-mark"><img src="/assets/nexadesk-logo.svg" alt=""></div>
        <div class="command-banner-copy">
          <span>Secure AI ticket command</span>
          <strong>NexaDesk</strong>
          <small>Tickets limpios. Staff en control. Seguridad sin ruido.</small>
        </div>
        <div class="command-banner-pills"><i>AI</i><i>Security</i><i>Realtime</i></div>
      </div>
      <div class="topbar">
        <header>
          <div class="brand-lockup"><img class="brand-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk"><strong>NexaDesk Command</strong></div>
          <h1>Centro de control para soporte con IA.</h1>
          <p>Elige un servidor, configura el contexto, prepara el escalado humano y publica paneles sin copiar IDs.</p>
        </header>
        <aside class="hero-panel">
          <p class="kicker">Sesion Discord</p>
          <div class="signal-list">
            <div class="signal"><span>Usuario</span><strong>${escapeHtml(session.user.username)}</strong></div>
            <div class="signal"><span>Realtime</span><strong id="liveState">Conectando</strong></div>
            <div class="signal"><span>Ultima sync</span><strong id="lastSync">${escapeHtml(new Date().toLocaleTimeString())}</strong></div>
          </div>
        </aside>
      </div>
    </div>
    <div class="view-stage">
      <section class="dashboard-view is-active" id="view-overview" data-view="overview">
        <div class="view-heading">
          <div><h2>Resumen</h2><p>Solo lo que importa: servidores listos, tickets, datos guardados y conversion premium.</p></div>
        </div>
        <section class="active-server">
          <p class="kicker">Servidor activo</p>
          <select id="guildId" required>${guildOptions}</select>
          <div class="server-status">
            <div><span>${renderDashboardEmoji('ticket', 'Categoria')}Categoria</span><strong id="activeCategory">Sin configurar</strong></div>
            <div><span>${renderDashboardEmoji('wifi', 'Staff')}Staff</span><strong id="activeStaff">Sin configurar</strong></div>
            <div><span>${renderDashboardEmoji('ticket', 'Paneles')}Paneles</span><strong id="activePanels">0</strong></div>
            <div><span>${renderDashboardEmoji('siren', 'Seguridad')}Seguridad</span><strong id="activeSecurity">Off</strong></div>
            <div><span>${renderDashboardEmoji('crown', 'Premium')}Premium</span><strong id="activePremium">Free</strong></div>
            <div><span>${renderDashboardEmoji('logs', 'Transcripciones')}Transcripciones</span><strong id="activeTranscripts">0</strong></div>
            <div><span>${renderDashboardEmoji('global', 'Anuncios')}Anuncios</span><strong id="activeAnnouncements">No detectado</strong></div>
            <div><span>${renderDashboardEmoji('check', 'Bienvenida')}Bienvenida</span><strong id="activeWelcome">Off</strong></div>
          </div>
          <div class="server-score">
            <div>
              <span>NexaScore del servidor</span>
              <strong id="activeScore">0%</strong>
              <small id="activeScoreText">Selecciona un servidor para auditarlo.</small>
            </div>
            <div class="meter" id="activeScoreMeter" style="--value:0%"><span></span></div>
            <button class="quick-action" type="button" id="activeNextAction" data-go-view="settings">Siguiente accion</button>
          </div>
          <div class="install-banner" id="installBanner" hidden>
            <div><strong id="installTitle">NexaDesk no esta instalado en este servidor.</strong><p id="installText">Al seleccionarlo puedes invitar el bot directamente con permisos recomendados.</p></div>
            <a id="installLink" href="#">Invitar bot</a>
          </div>
          <div class="readiness-checklist" id="readinessChecklist" aria-label="Checklist del servidor activo"></div>
        </section>
        <div class="stats" id="overview">
          <div class="stat"><strong id="guildCount">${stats.totalGuilds}</strong><span>${renderDashboardEmoji('server', 'Servidores')}Servidores gestionables</span><small id="guildInstallMeta">${stats.installedGuilds ?? 0} con bot - ${stats.notInstalledGuilds ?? 0} por invitar</small></div>
          <div class="stat"><strong id="ticketCount">${stats.totalTickets}</strong><span>${renderDashboardEmoji('ticket', 'Tickets')}Tickets detectados</span><small>${stats.ticketsToday} hoy - ${stats.ticketsThisWeek} esta semana</small></div>
          <div class="stat"><strong id="openCount">${stats.openTickets}</strong><span>${renderDashboardEmoji('ticket', 'Abiertos')}Tickets abiertos</span><small>${stats.closedTickets} cerrados o archivados</small></div>
          <div class="stat"><strong id="ratingAverage">${stats.averageRating ?? 0}/5</strong><span>${renderDashboardEmoji('check', 'Growth')}Rating soporte</span><small id="feedbackMeta">${stats.feedbackCount ?? 0} valoraciones - ${stats.promoterRate ?? 0}% promotores</small></div>
        </div>
        <section class="command-center">
          <article class="insight-card">
            <p class="kicker">Salud global</p>
            <strong id="healthScore">${healthScore}%</strong>
            <p>Promedio de servidores instalados con categoria, staff, contexto IA y seguridad configurados.</p>
            <div class="meter" style="--value:${healthScore}%"><span></span></div>
          </article>
          <article class="insight-card">
            <p class="kicker">Automatizacion</p>
            <div class="mini-grid">
              <div><strong id="panelCount">${stats.panels}</strong><small>Paneles publicados</small></div>
              <div><strong id="aiReadyCount">${stats.aiReadyGuilds}</strong><small>Servidores con IA lista</small></div>
              <div><strong id="proGuildCount">${stats.proGuilds ?? 0}</strong><small>Servidores Premium</small></div>
              <div><strong id="securityReadyCount">${stats.securityReadyGuilds ?? 0}</strong><small>Servidores protegidos</small></div>
            </div>
          </article>
          <article class="insight-card">
            <p class="kicker">Datos utiles</p>
            <div class="mini-grid">
              <div><strong id="transcriptCount">${stats.transcriptMessages}</strong><small>Mensajes guardados</small></div>
              <div><strong id="staffReadyCount">${stats.escalationReadyGuilds}</strong><small>Escalado con staff</small></div>
              <div><strong id="voiceRoomCount">${stats.voiceRooms ?? 0}</strong><small>Salas de voz activas</small></div>
              <div><strong id="growthReadyCount">${stats.growthReadyGuilds ?? 0}</strong><small>Growth Engine listo</small></div>
            </div>
          </article>
          <article class="insight-card">
            <p class="kicker">Security comercial</p>
            <div class="mini-grid">
              <div><strong id="securityCoverageRate">0%</strong><small>Cobertura instalada</small></div>
              <div><strong id="securityModulesAvg">0</strong><small>Modulos activos</small></div>
              <div><strong id="welcomeReadyCount">${stats.welcomeReadyGuilds ?? 0}</strong><small>Welcome Centers</small></div>
              <div><strong id="securityPitchScore">Seguro</strong><small>Mensaje para vender</small></div>
            </div>
          </article>
        </section>
        <div class="quick-actions" aria-label="Acciones rapidas">
          <button class="quick-action" type="button" data-go-view="settings">Configurar IA y staff</button>
          <button class="quick-action" type="button" data-go-view="settings">Activar seguridad</button>
          <button class="quick-action" type="button" data-go-view="components">Crear menu de tickets</button>
          <button class="quick-action" type="button" data-go-view="panels">Publicar panel</button>
          <button class="quick-action" type="button" data-go-view="growth">Activar Growth Engine</button>
          <button class="quick-action" type="button" data-go-view="welcome">Configurar bienvenida</button>
          <button class="quick-action" type="button" data-go-view="premium">Gestionar Premium</button>
          <button class="quick-action" type="button" data-go-view="tickets">Ver transcripciones</button>
        </div>
        <section class="surface">
          <div class="section-heading">
            <div><h2>Siguiente mejor accion</h2><p>NexaDesk te marca lo que falta para dejar el servidor listo.</p></div>
          </div>
          <div class="recommendation-grid" id="recommendations"></div>
        </section>
      </section>
      <section class="dashboard-view" id="view-servers" data-view="servers">
        <div class="view-heading">
          <div><h2>Servidores</h2><p>Selecciona el servidor que quieres preparar, revisar o invitar.</p></div>
        </div>
      <section class="surface" id="servers">
        <h2>Servidores</h2>
        <p>Selecciona uno para editarlo. Solo aparecen servidores donde tienes permisos.</p>
        <div class="guild-list" id="guildGrid">${guildList || '<p class="notice">No tienes servidores gestionables.</p>'}</div>
      </section>
      </section>
      <section class="dashboard-view" id="view-settings" data-view="settings">
        <div class="view-heading">
          <div><h2>Configuracion</h2><p>Contexto IA, staff y categoria principal del servidor activo.</p></div>
        </div>
      <section class="control-grid" id="settings">
        <article class="control-card wide">
          <div class="card-head"><span class="step">1</span><div><h2>IA y contexto</h2><p>Define como debe responder NexaDesk dentro de este servidor.</p></div></div>
          <form onsubmit="return saveConfig(event)">
            <input id="ticketCategoryName" type="hidden">
            <label>Categoria principal<select id="ticketCategoryId"></select></label>
            <label>Categoria extra Premium<select id="ticketCategoryId2"></select></label>
            <label>Rol staff<select id="staffRoleId"></select></label>
            <label>Cierre de tickets<select id="ticketCloseMode"><option value="opener_and_staff">Usuario que abrio + staff</option><option value="staff_only">Solo staff</option></select></label>
            <textarea id="serverPrompt" placeholder="Prompt del servidor: personalidad, tono, limites, cuando escalar..."></textarea>
            <textarea id="serverInfo" placeholder="Reglas, FAQs, horarios, precios, enlaces y respuestas frecuentes..."></textarea>
            <p class="notice span-2">Premium permite vigilar hasta 2 categorias de tickets. En Free solo se usa la principal aunque dejes preparada una extra.</p>
            <label class="span-2">Canal de alianzas<select id="allianceChannelId"></select></label>
            <textarea class="span-2" id="allianceTemplate" placeholder="Plantilla de alianza del servidor. Pegala completa con saltos de linea, emojis, invitacion y @everyone/@here si los usas."></textarea>
            <p class="notice span-2">La plantilla de alianzas se copia exactamente desde aqui. Asi no se rompe con comandos slash y puedes pegar textos largos con enters.</p>
            <button class="span-2" type="submit">Guardar contexto y escalado</button>
          </form>
        </article>
        <article class="control-card">
          <div class="card-head"><span class="step">2</span><div><h2>Categoria de tickets</h2><p>Crea una categoria nueva y dejala activa automaticamente.</p></div></div>
          <form onsubmit="return createCategory(event)">
            <select id="categoryGuildId" hidden required>${guildOptions}</select>
            <label class="span-2">Nombre de categoria<input id="categoryName" placeholder="NexaDesk Tickets" required></label>
            <button class="span-2" type="submit">Crear y activar categoria</button>
          </form>
        </article>
        <article class="control-card">
          <div class="card-head"><span class="step">AI</span><div><h2>Descubrimiento inteligente</h2><p>Escanea todos los canales y entiende nombres raros como 𝓐𝓷𝓾𝓷𝓬𝓲𝓸𝓼, avisos o news.</p></div></div>
          <div class="discovery-grid" id="discoverySummary">
            <div class="discovery-item"><span>Anuncios</span><strong>No detectado</strong></div>
            <div class="discovery-item"><span>Normas</span><strong>No detectado</strong></div>
            <div class="discovery-item"><span>FAQ/info</span><strong>No detectado</strong></div>
            <div class="discovery-item"><span>Categoria sugerida</span><strong>No detectada</strong></div>
          </div>
          <p class="notice">El canal de anuncios detectado recibe los mensajes globales publicados desde el canal central de NexaDesk y tambien ayuda como contexto operativo.</p>
          <button class="secondary-button" type="button" onclick="return rescanDiscovery()">Reescanear canales</button>
        </article>
        <article class="control-card wide">
            <div class="card-head"><span class="step">3</span><div><h2>Security Guard</h2><p>Activa proteccion anti-flood, anti-links e imagenes scam IA, XN Protect Automod, anti-alts, anti-bots y anti-nuke de canales/config/webhooks usando audit logs.</p></div></div>
          <form onsubmit="return saveSecurity(event)">
            <label>Estado<select id="securityEnabled">
              <option value="false">Desactivado</option>
              <option value="true">Activo</option>
            </select></label>
            <label>Nivel<select id="securityLevel">
              <option value="low">Bajo - suave</option>
              <option value="medium">Intermedio - recomendado</option>
              <option value="high">Alto - lanzamiento/raid</option>
            </select></label>
            <label>Canal de logs<select id="securityLogChannelId"></select></label>
            <label>Edad minima de cuenta<input id="securityMinAccountAgeDays" type="number" min="0" max="90" value="3"></label>
            <label>Anti-flood<select id="securityAntiFlood">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>Anti-links e imagenes IA<select id="securityAntiScamLinks">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>XN Protect Automod<select id="securityAntiOffensive">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>Anti-bots Top.gg<select id="securityAntiBot">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>Anti-alts<select id="securityAntiAlt">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>Anti-nuke<select id="securityAntiNuke">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <div class="security-playbook">
              <div><strong id="securityCoverageLabel">0/6 modulos</strong><span>Cobertura activa del escudo para vender seguridad real al owner.</span></div>
              <div><strong id="securityBotPolicyLabel">Top.gg seguro</strong><span>Anti-bots visual: permite bots listados/confiables y avisa cuando falta verificacion.</span></div>
              <div><strong id="securityRiskLabel">Riesgo controlado</strong><span>Resumen comercial del nivel actual para explicar que protege NexaDesk.</span></div>
            </div>
            <p class="notice span-2">Anti-bots solo banea bots que Top.gg confirme como no listados. Anti-nuke tambien detecta rafagas de canales, permisos, webhooks, apps externas y cambios del servidor; puede limpiar canales nuevos, borrar webhooks sospechosos, retirar roles peligrosos manejables y aplicar lockdown rapido solo sobre canales afectados. Para cobertura completa, actualiza permisos con View Audit Log, Manage Channels, Manage Webhooks, Manage Roles, Manage Messages, Moderate Members, Kick Members y Ban Members.</p>
            <button class="span-2" type="submit">Guardar Security Guard</button>
          </form>
        </article>
      </section>
      </section>
      <section class="dashboard-view" id="view-components" data-view="components">
        <div class="view-heading">
          <div><h2>Componentes</h2><p>Crea las opciones del menu desplegable: categoria destino, preguntas previas y primer mensaje.</p></div>
        </div>
      <section class="control-grid" id="components">
        <article class="control-card">
          <div class="card-head"><span class="step">3</span><div><h2>Nueva opcion de menu</h2><p>Cada componente aparece como categoria seleccionable antes de abrir el ticket.</p></div></div>
          <form onsubmit="return createComponent(event)">
            <select id="componentGuildId" hidden required>${guildOptions}</select>
            <input id="editingComponentId" type="hidden">
            <label>Nombre visible<input id="componentLabel" value="Soporte general" maxlength="100"></label>
            <label>Emoji<input id="componentEmoji" placeholder="Ej: &lt;:ticket:1535982903534559252&gt;"></label>
            <label class="span-2">Descripcion corta<input id="componentDescription" value="Abre un ticket de soporte general." maxlength="100"></label>
            <label class="span-2">Categoria destino<select id="componentTicketCategoryId"></select></label>
            <label>Tipo de ticket<select id="componentTicketMode">
              <option value="text">Texto + IA</option>
              <option value="voice">Voz Pro + STT/TTS</option>
              <option value="exam">Modo examen</option>
              <option value="staff">Solo staff (sin IA)</option>
            </select></label>
            <label class="span-2">Preguntas antes de crear el ticket<textarea id="componentQuestions" placeholder="Una pregunta por linea. Maximo 5.&#10;Ej: Cual es tu nick?&#10;Describe el problema"></textarea></label>
            <div class="span-2 form-section compact is-hidden" id="componentExamSettings" data-release-feature="v15-web-exam-mode" data-release-lock-mode="disabled">
              <div class="section-label"><strong>Modo examen</strong><span>En Free corrige preguntas dentro del ticket. En Premium genera formulario web NexaDesk y puede abrir revision con sala de voz.</span></div>
              <label class="span-2">URL externa opcional Premium<input id="componentExamFormUrl" placeholder="Opcional: https://forms.gle/... (si lo dejas vacio, NexaDesk crea formulario web)"></label>
              <label>Revision Premium<select id="componentExamReviewEnabled"><option value="false">No, corregir por preguntas</option><option value="true">Si, sala de voz + formulario</option></select></label>
              <label>Nota minima<input id="componentExamPassScore" type="number" min="0" max="10" step="0.5" value="6"></label>
              <p class="notice span-2">Preguntas en formato recomendado: <strong>P: ¿Cuantos años tienes?</strong>. Puedes poner hasta 40 preguntas. Si activas revision Premium, el formulario se abre fuera de Discord y el staff supervisa pantalla manualmente.</p>
            </div>
            <label class="span-2">Primer mensaje personalizado<textarea id="componentWelcomeMessage">Hola {user}, soy NexaDesk.
Antes de empezar, he guardado tus respuestas para que el staff tenga contexto.
{answers}</textarea></label>
            <p class="notice span-2">Variables del primer mensaje: <code>{user}</code>, <code>{username}</code>, <code>{server}</code>, <code>{channel}</code>, <code>{bot}</code> y <code>{answers}</code>. Si no pones <code>{answers}</code>, NexaDesk no añadira las respuestas previas automaticamente.</p>
            <button class="span-2" id="componentSubmitButton" type="submit">Crear componente</button>
            <button class="span-2 secondary-button is-hidden" id="componentCancelEditButton" type="button" onclick="resetComponentEditor()">Cancelar edicion</button>
          </form>
        </article>
        <article class="control-card">
          <div class="card-head"><span class="step">4</span><div><h2>Componentes activos</h2><p>Estos se pueden usar en paneles de tipo menu.</p></div></div>
          <div class="component-list" id="componentHistory"><p class="notice">Selecciona un servidor para ver sus componentes.</p></div>
        </article>
      </section>
      </section>
      <section class="dashboard-view" id="view-panels" data-view="panels">
        <div class="view-heading">
          <div><h2>Paneles</h2><p>Construye paneles personalizados sin mezclarlo con el resto de la configuracion.</p></div>
        </div>
      <section class="control-grid" id="panels">
        <article class="control-card wide">
          <div class="card-head"><span class="step">3</span><div><h2>Panel de soporte</h2><p>Disena el embed, decide donde se abre el ticket y revisa el resultado antes de publicarlo.</p></div></div>
          <form class="panel-builder" onsubmit="return createPanel(event)">
            <div class="panel-fields">
              <select id="panelGuildId" hidden required>${guildOptions}</select>
              <input id="editingPanelMessageId" type="hidden">
              <div class="form-section">
                <div class="section-label"><strong>Tipo de panel</strong><span>Boton directo o menu desplegable</span></div>
                <label>Modo<select id="panelType">
                  <option value="button">Boton unico</option>
                  <option value="menu">Menu seleccionable</option>
                </select></label>
                <label id="panelSelectPlaceholderWrap">Texto del menu<input id="panelSelectPlaceholder" value="Elige el tipo de ticket"></label>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Destino</strong><span>Canal publico y categoria privada</span></div>
                <label>Canal donde publicar<select id="panelChannelId" required></select></label>
                <label>Categoria donde abrir tickets<select id="panelTicketCategoryId"></select></label>
                <label id="panelTicketModeWrap">Tipo del boton<select id="panelTicketMode">
                  <option value="text">Texto + IA</option>
                  <option value="voice">Voz Pro + STT/TTS</option>
                  <option value="exam">Modo examen</option>
              <option value="staff">Solo staff (sin IA)</option>
                </select></label>
              </div>
              <div class="form-section is-hidden" id="panelExamSettings" data-release-feature="v15-web-exam-mode" data-release-lock-mode="disabled">
                <div class="section-label"><strong>Modo examen</strong><span>Preguntas automaticas o revision Premium con formulario web NexaDesk</span></div>
                <label class="span-2">Preguntas del examen<textarea id="panelExamQuestions" placeholder="P: ¿Cuantos años tienes?&#10;P: ¿Cuanto llevas roleando?&#10;P: ¿Como resolverias un conflicto entre usuarios?"></textarea></label>
                <label class="span-2">URL externa opcional Premium<input id="panelExamFormUrl" placeholder="Opcional: https://forms.gle/... (si lo dejas vacio, NexaDesk crea formulario web)"></label>
                <label>Revision Premium<select id="panelExamReviewEnabled"><option value="false">No, corregir por preguntas</option><option value="true">Si, sala de voz + formulario</option></select></label>
                <label>Nota minima<input id="panelExamPassScore" type="number" min="0" max="10" step="0.5" value="6"></label>
              </div>
              <div class="form-section" id="panelMenuComponentsSection">
                <div class="section-label"><strong>Opciones del menu</strong><span>Marca 2 o mas componentes para construir menus completos</span></div>
                <label class="span-2">Componentes<select id="panelComponentIds" multiple size="5"></select></label>
                <div class="span-2 component-picker" id="panelComponentPicker"></div>
                <div class="span-2 quick-actions">
                  <button class="secondary-button" type="button" onclick="selectAllPanelComponents()">Seleccionar todos</button>
                  <button class="secondary-button" type="button" onclick="clearPanelComponents()">Limpiar seleccion</button>
                </div>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Boton</strong><span>Texto, color y emoji</span></div>
                <label>Texto del boton<input id="panelButtonLabel" value="Abrir ticket"></label>
                <label>Estilo<select id="panelButtonStyle">
                  <option value="primary">Azul Discord</option>
                  <option value="secondary">Gris limpio</option>
                  <option value="success">Verde correcto</option>
                  <option value="danger">Rojo urgente</option>
                </select></label>
                <label class="span-2">Emoji del boton<input id="panelButtonEmoji" placeholder="Ej: &lt;:ticket:1535982903534559252&gt;"></label>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Embed</strong><span>Contenido visual del panel</span></div>
                <label>Titulo<input id="panelTitle" value="Centro de soporte"></label>
                <label>Color<input id="panelEmbedColor" type="color" value="#ffffff"></label>
                <label class="span-2">Autor<input id="panelAuthorName" placeholder="NexaDesk Support"></label>
                <label class="span-2">Icono del autor<input id="panelAuthorIconUrl" placeholder="https://..."></label>
                <textarea id="panelDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</textarea>
                <input id="panelThumbnailUrl" type="hidden">
                <input id="panelImageUrl" type="hidden">
                <label>Subir thumbnail<input id="panelThumbnailFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
                <label>Subir imagen grande<input id="panelImageFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
                <label class="span-2">Footer<input id="panelFooterText" value="NexaDesk AI Support"></label>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Primer mensaje</strong><span>Usa variables para controlar exactamente el saludo del ticket</span></div>
                <textarea id="panelWelcomeMessage">Hola {user}, soy NexaDesk.
Cuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.</textarea>
                <p class="notice">Variables disponibles: <code>{user}</code>, <code>{username}</code>, <code>{server}</code>, <code>{channel}</code>, <code>{bot}</code> y <code>{answers}</code>.</p>
              </div>
              <button class="span-2" id="panelSubmitButton" type="submit">Publicar panel personalizado</button>
              <button class="span-2 secondary-button is-hidden" id="panelCancelEditButton" type="button" onclick="resetPanelEditor()">Cancelar edicion</button>
            </div>
            <aside class="panel-preview-wrap">
              <div class="discord-preview">
                <div class="preview-message">
                  <div class="preview-avatar">N</div>
                  <div>
                    <div class="preview-name">NexaDesk <span class="preview-badge">APP</span></div>
                    <article class="embed-preview" id="panelPreview">
                      <div class="embed-author" id="previewAuthor"></div>
                      <div class="embed-title" id="previewTitle">Centro de soporte</div>
                      <div class="embed-description" id="previewDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</div>
                      <div class="embed-media">
                        <div class="embed-thumb" id="previewThumbnail">Thumbnail opcional</div>
                        <div class="embed-image" id="previewImage">Imagen opcional</div>
                      </div>
                      <div class="embed-footer" id="previewFooter">NexaDesk AI Support</div>
                    </article>
                    <button class="preview-button" id="previewButton" type="button">Abrir ticket</button>
                    <div class="menu-preview is-hidden" id="previewMenu"><strong>Elige el tipo de ticket</strong><div id="previewMenuOptions"></div></div>
                  </div>
                </div>
              </div>
              <div class="panel-history">
                <h3>Paneles de este servidor</h3>
                <div class="panel-stack" id="panelHistory"><p class="notice">Selecciona un servidor para ver sus paneles.</p></div>
              </div>
            </aside>
          </form>
        </article>
      </section>
      </section>
      <section class="dashboard-view" id="view-growth" data-view="growth">
        <div class="view-heading">
          <div><h2>Crecimiento</h2><p>Convierte cada ticket bien atendido en confianza, reviews y senales para mejorar tu comunidad.</p></div>
        </div>
        <section class="control-grid" id="growth">
          <article class="control-card wide">
            <div class="card-head"><span class="step">G</span><div><h2>Growth Engine</h2><p>Feedback por MD al cerrar tickets, canal de reviews y alertas de baja satisfaccion.</p></div></div>
            <form onsubmit="return saveGrowth(event)">
              <select id="growthGuildId" hidden required>${guildOptions}</select>
              <label>Estado<select id="growthEnabled"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label>Pedir feedback por MD<select id="growthFeedbackDm"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label>Reviews publicas Premium<select id="growthPublicReviews"><option value="false">No publicar</option><option value="true">Publicar reviews altas</option></select></label>
              <label>Canal de reviews y alertas<select id="growthReviewChannelId"></select></label>
              <label>Rating minimo publico<input id="growthTestimonialMinRating" type="number" min="4" max="5" value="5"></label>
              <label>Churn Radar<select id="growthLowRatingAlerts"><option value="true">Avisar ratings bajos</option><option value="false">Pausado</option></select></label>
              <label>CTA de invitacion<select id="growthInviteCta"><option value="true">Preparar conversion</option><option value="false">No usar CTA</option></select></label>
              <p class="notice span-2">Las valoraciones internas funcionan para todos. Publicar reviews y Churn Radar avanzado requieren Premium activo en el servidor.</p>
              <button class="span-2" type="submit">Guardar Growth Engine</button>
            </form>
          </article>
          <article class="control-card">
            <div class="card-head"><span class="step">R</span><div><h2>Metricas de confianza</h2><p>Lo que el owner necesita ver para saber que el soporte esta funcionando.</p></div></div>
            <div class="mini-grid">
              <div><strong id="growthFeedbackCount">0</strong><small>Valoraciones</small></div>
              <div><strong id="growthAverageRating">0/5</strong><small>Rating medio</small></div>
              <div><strong id="growthPromoterRate">0%</strong><small>Promotores</small></div>
              <div><strong id="growthDetractors">0</strong><small>Riesgos</small></div>
            </div>
            <div class="feedback-list" id="growthFeedbackList"><p class="notice">Aun no hay valoraciones para este servidor.</p></div>
          </article>
          <article class="control-card">
            <div class="card-head"><span class="step">IA</span><div><h2>Radar de feedback IA</h2><p>Senales rapidas desde MD cuando la IA fue clara o necesita revision.</p></div></div>
            <div class="mini-grid">
              <div><strong id="aiQualityTotal">0</strong><small>Senales IA</small></div>
              <div><strong id="aiQualityBad">0</strong><small>A revisar</small></div>
              <div><strong id="aiQualityGood">0</strong><small>Claras</small></div>
              <div><strong id="aiQualityCritical">0</strong><small>Criticas</small></div>
            </div>
            <div class="feedback-list" id="aiQualityList"><p class="notice">Aun no hay feedback rapido de IA.</p></div>
          </article>
        </section>
      </section>
      <section class="dashboard-view" id="view-welcome" data-view="welcome">
        <div class="view-heading">
          <div><h2>Bienvenida</h2><p>Configura el primer contacto de los nuevos miembros sin saturar tickets.</p></div>
        </div>
        <section class="control-grid" id="welcome">
          <article class="control-card wide">
            <div class="card-head"><span class="step">W</span><div><h2>Welcome Center</h2><p>Mensaje publico, MD opcional y rol automatico al entrar. Ideal para servidores que quieren una primera impresion limpia.</p></div></div>
            <form onsubmit="return saveWelcome(event)">
              <select id="welcomeGuildId" hidden required>${guildOptions}</select>
              <label>Estado<select id="welcomeEnabled"><option value="false">Pausado</option><option value="true">Activo</option></select></label>
              <label>Canal de bienvenida<select id="welcomeChannelId"></select></label>
              <label>Rol automatico<select id="welcomeRoleId"></select></label>
              <label>MD de bienvenida<select id="welcomeDmEnabled"><option value="false">No enviar MD</option><option value="true">Enviar MD</option></select></label>
              <label class="span-2">Mensaje publico<textarea id="welcomeMessage" placeholder="Bienvenido {user} a {server}. Abre un ticket si necesitas ayuda."></textarea></label>
              <label class="span-2">Mensaje privado opcional<textarea id="welcomeDmMessage" placeholder="Gracias por entrar a {server}, {username}. Si necesitas ayuda, abre un ticket."></textarea></label>
              <p class="notice span-2">Variables disponibles: <code>{user}</code> menciona al usuario, <code>{username}</code> pone su nombre y <code>{server}</code> pone el nombre del servidor. El bot nunca menciona roles en la bienvenida para evitar abuso.</p>
              <button class="span-2" type="submit">Guardar Welcome Center</button>
            </form>
          </article>
          <article class="control-card">
            <div class="card-head"><span class="step">PV</span><div><h2>Preview</h2><p>Asi se vera la bienvenida antes de guardarla.</p></div></div>
            <div class="welcome-preview">
              <div class="welcome-bubble">
                <strong>Mensaje publico</strong>
                <span id="welcomePublicPreview">Activa un servidor para ver la preview.</span>
              </div>
              <div class="welcome-bubble">
                <strong>MD privado</strong>
                <span id="welcomeDmPreview">MD pausado.</span>
              </div>
              <div class="welcome-bubble">
                <strong>Estado operativo</strong>
                <span id="welcomeOpsPreview">Sin configurar.</span>
              </div>
            </div>
          </article>
        </section>
      </section>
      <section class="dashboard-view" id="view-premium" data-view="premium">
        <div class="view-heading">
          <div><h2>Premium</h2><p>Compra un pack de 3 servidores por 3€ y activalo directamente desde la dashboard.</p></div>
        </div>
        <section class="premium-market" id="premiumMarket">
          <article class="control-card premium-buy-card">
            <span class="premium-plan">Pack directo</span>
            <h2>3 servidores premium por <span id="premiumPackPrice">3,00 €</span></h2>
            <p id="premiumSalesSubline">Pagas una vez con PayPal, vuelves a NexaDesk y eliges exactamente en que servidores quieres activar el premium. NexaDesk no guarda datos de pago.</p>
            <div class="premium-checkout-mode" id="premiumCheckoutMode">PayPal Checkout</div>
            <div class="premium-sales-note" id="premiumSalesUrgency">Precio early-access para activar monetizacion cuanto antes.</div>
            <div class="premium-sales-grid">
              <div><strong>Voz + examen</strong><span>Funciones que un servidor nota al instante.</span></div>
              <div><strong>Seguridad + IA</strong><span>Proteccion avanzada sin cambiar de bot de tickets.</span></div>
              <div><strong>Setup desde <b id="premiumSetupPrice">5,00 €</b></strong><span>Servicio manual para quien no quiere configurar nada.</span></div>
            </div>
            <div class="premium-wallet">
              <div><strong id="premiumSlotsAvailable">0</strong><small>Slots disponibles</small></div>
              <div><strong id="premiumSlotsUsed">0</strong><small>Slots usados</small></div>
              <div><strong id="premiumSlotsPurchased">0</strong><small>Slots comprados</small></div>
              <div><strong id="premiumPendingPurchases">0</strong><small>Pagos pendientes</small></div>
            </div>
            <button class="premium-billing-action" id="premiumBuyButton" type="button">Comprar pack premium</button>
            <p class="notice" id="premiumCheckoutNotice">Pago seguro con PayPal Checkout.</p>
          </article>
          <article class="control-card premium-activation-card">
            <div class="card-head"><span class="step">3</span><div><h2>¿En que servidores quieres activar el premium?</h2><p>Cuando el pago este confirmado, usa tus slots aqui. Cada slot activa un servidor completo.</p></div></div>
            <div class="premium-activation-list" id="premiumActivationList">
              <p class="notice">Cargando estado premium...</p>
            </div>
          </article>
        </section>
        <section class="premium-denied is-hidden" id="premiumDenied" aria-live="polite">
          <div class="premium-denied-inner">
            <span class="premium-denied-kicker">NexaDesk Premium</span>
            <h2>Este servidor no tiene premium</h2>
            <p>Compra el pack desde arriba, activa un slot en este servidor o abre ticket si quieres validacion manual.</p>
            <a href="https://discord.gg/vVXbq7ePEZ" target="_blank" rel="noopener">Abrir soporte</a>
          </div>
        </section>
        <section class="premium-grid" id="premiumContent">
          <article class="control-card premium-hero" id="premiumHeroCard">
            <span class="premium-plan" id="premiumPlanBadge">Free</span>
            <h2 id="premiumHeroTitle">Convierte NexaDesk en un agente de pago.</h2>
            <p id="premiumHeroText">Premium desbloquea voz natural, examenes supervisados, IA mas proactiva, transcripciones accionables, seguridad reforzada, branding propio, Growth Engine, SLA Radar y afiliados para que el owner vea valor real.</p>
            <div class="premium-lock" id="premiumLockNotice">
              <strong>Plan no activo todavia</strong>
              <p>Activalo con <code>/activarpremium servidor:&lt;ID&gt;</code> o poniendo <code>plan = pro</code> / <code>voice_support_enabled = true</code> en PostgreSQL. Las preferencias se pueden dejar preparadas.</p>
            </div>
            <div class="premium-feature-grid">
              <div class="premium-feature"><strong>Voz Pro</strong><span>Tickets con sala privada, STT/TTS y transcripcion en el canal.</span></div>
              <div class="premium-feature"><strong>Modo examen</strong><span>Oposiciones con preguntas automaticas, formulario web propio, nota provisional y revision supervisada.</span></div>
              <div class="premium-feature"><strong>IA prioritaria</strong><span>Respuestas mas proactivas, checklist de datos y escalados mejor resumidos.</span></div>
              <div class="premium-feature"><strong>Smart transcripts</strong><span>Resumen ejecutivo, puntos clave y descarga lista para staff.</span></div>
              <div class="premium-feature"><strong>Security Plus</strong><span>Anti-scam IA, senales de riesgo y alertas mas visibles para staff.</span></div>
              <div class="premium-feature"><strong>Branding propio</strong><span>Paneles y mensajes mas personalizables para comunidades serias.</span></div>
              <div class="premium-feature"><strong>Informes semanales</strong><span>Ideas de mejora: motivos frecuentes, volumen y necesidades de staff.</span></div>
              <div class="premium-feature"><strong>Growth Engine</strong><span>Feedback post-ticket, reviews publicas y conversion de soporte en prueba social.</span></div>
              <div class="premium-feature"><strong>Churn Radar</strong><span>Alertas cuando un usuario queda insatisfecho para recuperarlo antes de perderlo.</span></div>
              <div class="premium-feature"><strong>SLA Radar</strong><span>Detecta tickets frios o sin respuesta antes de que el usuario se marche.</span></div>
              <div class="premium-feature"><strong>Auto-config Pro</strong><span>Recomendaciones de canales, gaps de setup y pistas para no inventar respuestas.</span></div>
              <div class="premium-feature"><strong>Alianzas Pro</strong><span>Flujo mas limpio para plantillas, verificacion y publicacion automatica.</span></div>
              <div class="premium-feature"><strong>Team Assist</strong><span>Briefings para staff, handoff inteligente y sugerencias de cierre.</span></div>
              <div class="premium-feature"><strong>Affiliate Boost</strong><span>Recompensas por crecimiento y slots premium por servidores referidos.</span></div>
              <div class="premium-feature"><strong>2 categorias vigiladas</strong><span>NexaDesk puede entrar en dos zonas de tickets distintas sin duplicar bots ni paneles.</span></div>
              <div class="premium-feature"><strong>Anuncios programados</strong><span>Embeds automaticos para eventos, normas, avisos, recordatorios y campanas del servidor.</span></div>
            </div>
          </article>
          <article class="control-card" id="premiumSettingsCard">
            <div class="card-head"><span class="step">P</span><div><h2>Modulos premium</h2><p>Activa lo que quieres ofrecer en este servidor cuando el plan este disponible.</p></div></div>
            <form class="premium-toggle-list" onsubmit="return savePremium(event)">
              <select id="premiumGuildId" hidden required>${guildOptions}</select>
              <label class="premium-toggle"><span><strong>Voz Pro STT/TTS</strong><span>Permite paneles de voz y salas privadas vinculadas al ticket.</span></span><select id="premiumVoiceSupport"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>IA prioritaria</strong><span>La IA pregunta mejor, resume antes de escalar y evita respuestas roboticas.</span></span><select id="premiumPriorityAi"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Transcripciones inteligentes</strong><span>Prepara cada cierre para dashboard, MD al usuario y revision de staff.</span></span><select id="premiumSmartTranscripts"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Security Plus</strong><span>Refuerza links sospechosos, blacklist, flood y avisos para staff.</span></span><select id="premiumSecurityPlus"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Branding propio</strong><span>Permite preparar una experiencia mas white-label para el servidor.</span></span><select id="premiumCustomBranding"><option value="false">Desactivado</option><option value="true">Activo</option></select></label>
              <label class="premium-toggle"><span><strong>Informes semanales</strong><span>Activa el futuro reporte de tendencias para vender valor continuo.</span></span><select id="premiumWeeklyInsights"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Growth Engine</strong><span>Desbloquea reviews, feedback accionable y metricas de satisfaccion.</span></span><select id="premiumGrowthEngine"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Reviews publicas</strong><span>Convierte valoraciones altas en mensajes visibles en el canal elegido.</span></span><select id="premiumPublicReviews"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Churn Radar</strong><span>Avisa al staff cuando hay valoraciones bajas o riesgo de perdida.</span></span><select id="premiumChurnRadar"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Conversion insights</strong><span>Prepara senales para detectar donde los tickets ayudan a crecer.</span></span><select id="premiumConversionInsights"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>SLA Radar</strong><span>Detecta tickets que llevan demasiado tiempo sin accion clara.</span></span><select id="premiumSlaRadar"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Auto-config Pro</strong><span>Usa descubrimiento inteligente para encontrar canales y contexto real del servidor.</span></span><select id="premiumAutoSetupPlus"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Alianzas Pro</strong><span>Mejora el flujo de alianzas y su verificacion automatica.</span></span><select id="premiumAllianceAutomation"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Team Assist</strong><span>Ayuda al staff con handoff, briefings y respuestas recomendadas.</span></span><select id="premiumTeamAssist"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Analitica premium</strong><span>Prepara datos para informes de motivos, resultados y calidad de soporte.</span></span><select id="premiumAnalytics"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Affiliate Boost</strong><span>Activa recompensas por afiliados y crecimiento recomendado.</span></span><select id="premiumAffiliateBoost"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>2 categorias vigiladas</strong><span>Permite configurar una segunda categoria de tickets desde Configuracion.</span></span><select id="premiumMultiCategoryWatch"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <label class="premium-toggle"><span><strong>Anuncios programados</strong><span>Envia embeds automaticos al canal y fecha/intervalo que elijas.</span></span><select id="premiumScheduledAnnouncements"><option value="true">Activo</option><option value="false">Pausado</option></select></label>
              <button type="submit">Guardar modulos premium</button>
            </form>
          </article>
          <article class="control-card wide" id="scheduledAnnouncementsCard">
            <div class="card-head"><span class="step">A</span><div><h2>Anuncios programados</h2><p>Premium: prepara embeds automaticos para eventos, recordatorios, normas y campanas.</p></div></div>
            <form onsubmit="return saveScheduledAnnouncement(event)">
              <label>Canal destino<select id="announcementChannelId"></select></label>
              <label>Nombre interno<input id="announcementName" placeholder="Recordatorio semanal"></label>
              <label class="span-2">Texto encima del embed<input id="announcementContent" placeholder="@everyone Nuevo anuncio disponible"></label>
              <label>Titulo del embed<input id="announcementTitle" placeholder="Nuevo anuncio del servidor"></label>
              <label>Color<input id="announcementColor" placeholder="#ffffff" value="#ffffff"></label>
              <textarea class="span-2" id="announcementDescription" placeholder="Mensaje del anuncio. Puedes escribir varias lineas, normas, enlaces y llamadas a la accion."></textarea>
              <label>Programacion<select id="announcementScheduleType"><option value="interval">Cada X horas</option><option value="once">Fecha exacta una vez</option></select></label>
              <label>Cada cuantas horas<input id="announcementEveryHours" type="number" min="1" max="720" value="24"></label>
              <label class="span-2">Proxima ejecucion<input id="announcementNextRunAt" type="datetime-local"></label>
              <label>Imagen opcional<input id="announcementImageUrl" placeholder="https://..."></label>
              <label>Footer opcional<input id="announcementFooterText" placeholder="NexaDesk"></label>
              <button class="span-2" type="submit">Guardar anuncio programado</button>
            </form>
            <div class="scheduled-announcements-list" id="scheduledAnnouncementList">
              <p class="notice">Selecciona un servidor para ver sus anuncios.</p>
            </div>
          </article>
        </section>
      </section>
      <section class="dashboard-view" id="view-tickets" data-view="tickets">
        <div class="view-heading">
          <div><h2>Tickets</h2><p>Consulta actividad reciente y abre transcripciones guardadas.</p></div>
        </div>
    <section class="surface" id="tickets">
      <div class="ticket-tools">
        <div><h2>Tickets recientes</h2><p>Abre cada replay en una pestaña nueva con aspecto de chat de Discord.</p></div>
      </div>
      ${ticketRows ? `<table><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th><th>Replay</th></tr></thead><tbody id="ticketRows">${ticketRows}</tbody></table>` : '<div class="empty-state" id="emptyTickets"><strong>Aun no hay tickets detectados.</strong><span>Crea un panel o abre un ticket en una categoria configurada para ver actividad en tiempo real aqui.</span></div><table hidden><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th><th>Replay</th></tr></thead><tbody id="ticketRows"></tbody></table>'}
    </section>
      </section>
      <section class="dashboard-view" id="view-logs" data-view="logs">
        <div class="view-heading">
          <div><h2>Logs del servidor</h2><p>Auditoria detallada de seguridad, tickets, paneles, premium, mensajes owner y cambios importantes.</p></div>
          <button class="secondary-button table-action" type="button" onclick="loadGuildLogs()">Actualizar logs</button>
        </div>
        <section class="surface" id="logs">
          <div class="log-toolbar">
            <label>Servidor activo<select id="logsGuildId" required>${guildOptions}</select></label>
            <button class="quick-action" type="button" onclick="loadGuildLogs()">Refrescar</button>
          </div>
          <div class="log-list" id="guildLogList">
            <p class="notice">Selecciona un servidor para cargar sus logs.</p>
          </div>
        </section>
      </section>
    </div>
  </main>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <section class="assistant-panel" id="assistantPanel" aria-label="Copiloto NexaDesk" aria-live="polite">
    <div class="assistant-head">
      <div><strong>Copiloto NexaDesk</strong><span>Te guia por secciones, configuracion y buenas practicas.</span></div>
      <button class="assistant-close secondary-button" id="assistantClose" type="button" aria-label="Cerrar asistente">x</button>
    </div>
    <div class="assistant-body" id="assistantBody">
      <article class="assistant-message">Dime que quieres preparar y te llevo directo. Puedo ayudarte con IA, staff, seguridad, paneles, menus, premium y transcripciones.</article>
    </div>
    <div class="assistant-quick" aria-label="Preguntas rapidas">
      <button class="assistant-chip" type="button" data-assistant-prompt="Que me falta para dejar este servidor listo?">Que falta?</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Como creo un panel con menu desplegable?">Panel con menu</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Como hago que la IA escale al staff?">Escalado staff</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Mete una configuracion de seguridad recomendada">Seguridad</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Como activo Growth Engine y reviews publicas?">Crecimiento</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Como creo un panel de Modo examen para oposiciones?">Modo examen</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Como configuro la bienvenida de nuevos miembros?">Bienvenida</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Que funciones premium puedo activar aqui?">Premium</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Donde veo las transcripciones?">Transcripciones</button>
    </div>
    <form class="assistant-form" id="assistantForm">
      <input id="assistantInput" autocomplete="off" maxlength="900" placeholder="Pregunta: como configuro tickets?">
      <button type="submit">Enviar</button>
    </form>
  </section>
  <button class="tour-replay" id="tourReplay" type="button">Tutorial</button>
  <button class="assistant-launcher" id="assistantLauncher" type="button"><span>N</span> Ayuda IA</button>
  <section class="tour-overlay" id="dashboardTour" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">
    <div class="tour-dim"></div>
    <article class="tour-card">
      <div class="tour-head">
        <span class="tour-avatar">N</span>
        <div><strong>Asistente de bienvenida</strong><span id="tourSection">Primer recorrido</span></div>
      </div>
      <h2 class="tour-title" id="tourTitle">Bienvenido a NexaDesk</h2>
      <p class="tour-text" id="tourText">Te enseño la dashboard en menos de un minuto.</p>
      <div class="tour-progress" aria-hidden="true"><span id="tourProgress"></span></div>
      <div class="tour-dots" id="tourDots" aria-hidden="true"></div>
      <div class="tour-actions">
        <div>
          <button class="secondary-button" id="tourBack" type="button">Atrás</button>
          <button id="tourNext" type="button">Siguiente</button>
        </div>
      </div>
    </article>
  </section>
  <script>
    const loadingCards = [
      { quote: '"La seguridad es un proceso, no un boton." - Bruce Schneier', tip: 'Tip NexaDesk: usa contexto IA corto, claro y con limites de escalado.' },
      { quote: '"Confia, pero verifica." - proverbio de seguridad', tip: 'Tip NexaDesk: mira Logs para entender que hizo el bot y por que.' },
      { quote: '"La privacidad no deberia ser el precio de usar Internet." - Gary Kovacs', tip: 'Tip NexaDesk: revisa que las transcripciones no contengan datos sensibles antes de compartirlas.' },
      { quote: '"La simplicidad es la maxima sofisticacion." - atribuido a Leonardo da Vinci', tip: 'Tip NexaDesk: un buen panel tiene pocas opciones, preguntas concretas y un primer mensaje humano.' }
    ];
    let loadingPhraseIndex = 0;
    const loadingPhrase = document.querySelector('#loadingPhrase');
    const loadingTip = document.querySelector('#loadingTip');
    const loadingTimer = setInterval(() => {
      loadingPhraseIndex = (loadingPhraseIndex + 1) % loadingCards.length;
      if (loadingPhrase) loadingPhrase.textContent = loadingCards[loadingPhraseIndex].quote;
      if (loadingTip) loadingTip.textContent = loadingCards[loadingPhraseIndex].tip;
    }, 1500);
    window.addEventListener('load', () => {
      setTimeout(() => {
        clearInterval(loadingTimer);
        document.querySelector('#loading')?.classList.add('is-hidden');
      }, 550);
    });
    const state = {
      tickets: ${JSON.stringify(tickets)},
      stats: ${JSON.stringify(stats)},
      premiumAccount: null,
      activeLogGuildId: null,
      guildLogs: [],
      activeView: 'overview'
    };
    const guildConfigs = ${JSON.stringify(guilds)};
    const dashboardEmojis = ${JSON.stringify(getDashboardEmojiUrls())};
    const releaseState = ${toInlineJson(releaseState)};
    let guildMeta = {};
    function isReleasedFeature(featureId) {
      if (!featureId || releaseState?.isOwner) return true;
      const feature = (releaseState.features || []).find((item) => item.id === featureId);
      return !feature || feature.released;
    }
    function applyReleaseGates() {
      document.querySelectorAll('[data-release-feature]').forEach((section) => {
        const featureId = section.dataset.releaseFeature;
        if (isReleasedFeature(featureId) || section.dataset.releaseLocked === 'true') return;
        const feature = (releaseState.features || []).find((item) => item.id === featureId) || {};
        section.dataset.releaseLocked = 'true';
        if (section.dataset.releaseLockMode === 'disabled') {
          section.querySelectorAll('input, select, textarea, button').forEach((field) => { field.disabled = true; });
          const notice = document.createElement('div');
          notice.className = 'release-wip release-wip-inline';
          notice.innerHTML = '<div><span class="wip-pill">Preview en desarrollo</span><h2>Estamos trabajando en esta parte</h2><p>' + escapeHtml(feature.title || 'Nueva funcion de NexaDesk') + ' todavia esta en pruebas internas. El owner global puede probarla antes del lanzamiento publico y publicarla desde /owner cuando este lista.</p></div>';
          section.prepend(notice);
          return;
        }
        section.innerHTML = '<div class="release-wip"><div><span class="wip-pill">Preview en desarrollo</span><h2>Estamos trabajando en esta parte</h2><p>' + escapeHtml(feature.title || 'Nueva funcion de NexaDesk') + ' todavia esta en pruebas internas. El owner global puede probarla antes del lanzamiento publico y publicarla desde /owner cuando este lista.</p></div></div>';
      });
    }
    function setActiveView(view, { updateHash = true } = {}) {
      const nextView = document.querySelector('[data-view="' + view + '"].dashboard-view') ? view : 'overview';
      state.activeView = nextView;
      const mainEl = document.querySelector('main');
      if (mainEl) {
        mainEl.classList.remove('is-switching');
        void mainEl.offsetWidth;
        mainEl.classList.add('is-switching');
        window.clearTimeout(window.__nexaViewSwitchTimer);
        window.__nexaViewSwitchTimer = window.setTimeout(() => mainEl.classList.remove('is-switching'), 520);
      }
      document.querySelectorAll('.dashboard-view').forEach((section) => {
        section.classList.toggle('is-active', section.dataset.view === nextView);
      });
      document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
        link.classList.toggle('is-active', link.dataset.view === nextView);
      });
      document.querySelector('#overviewHero')?.toggleAttribute('hidden', nextView !== 'overview');
      if (updateHash && location.hash !== '#' + nextView) {
        history.replaceState(null, '', '#' + nextView);
      }
      if (nextView === 'logs') {
        loadGuildLogs().catch((error) => showToast(error.message));
      }
    }
    const dashboardTourKey = 'nexadesk.dashboard.tour.completed.' + ${JSON.stringify(session.user?.id || 'anonymous')};
    const dashboardTourLegacyKey = 'nexadesk.dashboard.tour.v4.' + ${JSON.stringify(session.user?.id || 'anonymous')};
    const dashboardTourVersion = 'v5';
    let dashboardTourCompleted = ${JSON.stringify(Boolean(dashboardState?.tourCompleted))};
    const dashboardUsername = ${JSON.stringify(session.user?.globalName || session.user?.username || 'owner')};
    const dashboardTourSteps = [
      {
        view: 'overview',
        target: '#view-overview .view-heading, #view-overview header, #view-overview',
        section: 'Resumen',
        title: 'Hola ' + dashboardUsername + ', bienvenido al centro de control de NexaDesk',
        text: 'Te voy a enseñar rapidamente que gestiona cada zona de la dashboard para que puedas configurar soporte con IA, paneles, seguridad, premium y transcripciones sin perderte.'
      },
      {
        view: 'servers',
        target: '#view-servers .view-heading, #view-servers',
        section: 'Servidores',
        title: 'Elige que servidor gestionar',
        text: 'Selecciona un servidor para editarlo. Si NexaDesk no esta invitado, el boton Invitar abre el enlace con los permisos necesarios para que no tengas que buscar IDs.'
      },
      {
        view: 'settings',
        target: '#view-settings .view-heading, #view-settings',
        section: 'Configuracion',
        title: 'Contexto, staff y reglas del servidor',
        text: 'Aqui defines la categoria de tickets, el rol staff, el prompt de IA, normas, alianzas y Security Guard. Es donde NexaDesk aprende como debe actuar dentro de tu comunidad.'
      },
      {
        view: 'components',
        target: '#view-components .view-heading, #view-components',
        section: 'Componentes',
        title: 'Categorias del menu de tickets',
        text: 'Crea opciones del menu desplegable: soporte, reportes, alianzas, modo examen o voz. Tambien puedes poner preguntas previas para que el staff reciba contexto desde el primer mensaje.'
      },
      {
        view: 'panels',
        target: '#view-panels .view-heading, #view-panels',
        section: 'Paneles',
        title: 'Publica paneles en Discord',
        text: 'Construye el panel que vera el usuario en Discord. Puedes usar boton o menu, personalizar embeds, subir imagenes, editar paneles enviados y previsualizar como quedaran.'
      },
      {
        view: 'tickets',
        target: '#view-tickets .view-heading, #tickets, #view-tickets',
        section: 'Tickets',
        title: 'Transcripciones y actividad',
        text: 'Desde aqui revisas tickets recientes y abres transcripciones guardadas. Es util para auditorias, soporte posterior y para entender que esta pasando en cada servidor.'
      },
      {
        view: 'logs',
        target: '#view-logs .view-heading, #logs, #view-logs',
        section: 'Logs',
        title: 'Auditoria detallada por servidor',
        text: 'Aqui el owner ve decisiones de Security Guard, avisos importantes, acciones de premium, mensajes enviados al owner y eventos que ayudan a entender que hizo NexaDesk.'
      },
      {
        view: 'premium',
        target: '#view-premium .view-heading, #view-premium',
        section: 'Premium',
        title: 'Funciones avanzadas por servidor',
        text: 'Gestiona slots premium, voz, automatizaciones extra y ventajas de crecimiento. Si el servidor no tiene Premium, la dashboard te indica como activarlo desde soporte.'
      },
      {
        view: 'growth',
        target: '#view-growth .view-heading, #view-growth',
        section: 'Crecimiento',
        title: 'Herramientas para crecer',
        text: 'Activa recomendaciones, afiliados, reviews y anuncios inteligentes. Esta zona ayuda a convertir tickets bien atendidos en confianza, actividad y nuevos servidores.'
      },
      {
        view: 'welcome',
        target: '#view-welcome .view-heading, #view-welcome',
        section: 'Bienvenida',
        title: 'Cuida el primer contacto',
        text: 'Configura un mensaje publico, un MD opcional y un rol automatico para que cada nuevo miembro entienda donde pedir ayuda sin abrir tickets innecesarios.'
      },
      {
        view: state.activeView || 'overview',
        target: '#assistantLauncher',
        section: 'Ayuda IA',
        title: 'Si te pierdes, preguntale al copiloto',
        text: 'El boton Ayuda IA puede llevarte a secciones, rellenar configuraciones base y explicarte que hacer. Es el apoyo rapido para owners que no quieren tocar IDs ni leer docs eternas.'
      }
    ];
    let dashboardTourIndex = 0;
    let dashboardTourTarget = null;
    function safeLocalStorageGet(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    function safeLocalStorageSet(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    }
    function hasDashboardTourCompleted() {
      return dashboardTourCompleted
        || safeLocalStorageGet(dashboardTourKey) === 'done'
        || safeLocalStorageGet(dashboardTourLegacyKey) === 'done';
    }
    function markDashboardTourCompleted() {
      dashboardTourCompleted = true;
      safeLocalStorageSet(dashboardTourKey, 'done');
      fetch('/api/me/dashboard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tourCompleted: true, tourVersion: dashboardTourVersion })
      }).catch(() => {});
    }
    function clearDashboardTourHighlight() {
      if (dashboardTourTarget) dashboardTourTarget.classList.remove('tour-highlight');
      dashboardTourTarget = null;
    }
    function findDashboardTourTarget(selector) {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    }
    function scrollDashboardTourTarget(target, view) {
      if (!target) return;
      const position = window.getComputedStyle(target).position;
      if (position === 'fixed' || position === 'sticky') return;
      const activeView = document.getElementById('view-' + view);
      const anchor = activeView?.querySelector('.view-heading') || target;
      const offset = window.matchMedia('(max-width: 760px)').matches ? 88 : 24;
      const top = Math.max(0, anchor.getBoundingClientRect().top + window.scrollY - offset);
      window.scrollTo({ top, behavior: 'smooth' });
    }
    function renderDashboardTourStep() {
      const overlay = document.querySelector('#dashboardTour');
      if (!overlay) return;
      const step = dashboardTourSteps[dashboardTourIndex] || dashboardTourSteps[0];
      const view = step.view || state.activeView || 'overview';
      if (view !== state.activeView && document.querySelector('[data-view="' + view + '"].dashboard-view')) {
        setActiveView(view, { updateHash: false });
      }
      document.querySelector('#tourSection').textContent = step.section + ' - paso ' + (dashboardTourIndex + 1) + ' de ' + dashboardTourSteps.length;
      document.querySelector('#tourTitle').textContent = step.title;
      document.querySelector('#tourText').textContent = step.text;
      document.querySelector('#tourProgress').style.width = Math.round(((dashboardTourIndex + 1) / dashboardTourSteps.length) * 100) + '%';
      document.querySelector('#tourBack').disabled = dashboardTourIndex === 0;
      document.querySelector('#tourNext').textContent = dashboardTourIndex === dashboardTourSteps.length - 1 ? 'Terminar' : 'Siguiente';
      document.querySelector('#tourDots').innerHTML = dashboardTourSteps.map((_, index) => '<span class="tour-dot ' + (index === dashboardTourIndex ? 'is-active' : '') + '"></span>').join('');
      clearDashboardTourHighlight();
      setTimeout(() => {
        const target = findDashboardTourTarget(step.target);
        if (!target) return;
        dashboardTourTarget = target;
        const rect = target.getBoundingClientRect();
        overlay.style.setProperty('--spot-x', Math.round(rect.left + rect.width / 2) + 'px');
        overlay.style.setProperty('--spot-y', Math.round(rect.top + rect.height / 2) + 'px');
        target.classList.add('tour-highlight');
        scrollDashboardTourTarget(target, view);
        window.setTimeout(() => {
          const updated = target.getBoundingClientRect();
          overlay.style.setProperty('--spot-x', Math.round(updated.left + updated.width / 2) + 'px');
          overlay.style.setProperty('--spot-y', Math.round(updated.top + updated.height / 2) + 'px');
        }, 360);
      }, 120);
    }
    function startDashboardTour({ force = false } = {}) {
      if (!force && hasDashboardTourCompleted()) return;
      setAssistantOpen(false);
      dashboardTourIndex = 0;
      document.querySelector('#dashboardTour')?.classList.add('is-open');
      renderDashboardTourStep();
    }
    function finishDashboardTour(message = 'Tutorial completado. Siempre puedes repetirlo desde el boton Tutorial.') {
      document.querySelector('#dashboardTour')?.classList.remove('is-open');
      clearDashboardTourHighlight();
      markDashboardTourCompleted();
      showToast(message);
    }
    function moveDashboardTour(delta) {
      const nextIndex = dashboardTourIndex + delta;
      if (nextIndex >= dashboardTourSteps.length) {
        finishDashboardTour();
        return;
      }
      dashboardTourIndex = Math.max(0, nextIndex);
      renderDashboardTourStep();
    }
    function maybeStartDashboardTour() {
      if (hasDashboardTourCompleted()) {
        if (!dashboardTourCompleted) markDashboardTourCompleted();
        return;
      }
      setTimeout(() => startDashboardTour(), 950);
    }
    function ticketRow(ticket) {
      return '<tr><td>#' + escapeHtml(ticket.channelName) + '</td><td>' + escapeHtml(ticket.guildName) + '</td><td>' + escapeHtml(ticket.status) + '</td><td>' + escapeHtml(new Date(ticket.createdAt).toLocaleString()) + '</td><td><button class="table-action secondary-button" type="button" data-replay-channel="' + escapeHtml(ticket.channelId) + '">Ver</button></td></tr>';
    }
    function escapeHtml(value) {
      return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#039;');
    }
    function emojiIcon(name, alt) {
      const src = dashboardEmojis[name];
      return src ? '<img class="dash-emoji" src="' + src + '" alt="' + escapeHtml(alt || name) + '" loading="lazy">' : '';
    }
    function renderTickets() {
      document.querySelector('#ticketRows').innerHTML = state.tickets.length ? state.tickets.map(ticketRow).join('') : '<tr><td colspan="5">Aun no hay tickets detectados.</td></tr>';
      document.querySelector('#emptyTickets')?.remove();
      document.querySelector('#ticketRows')?.closest('table')?.removeAttribute('hidden');
      bindReplayButtons();
    }
    function bindReplayButtons() {
      document.querySelectorAll('[data-replay-channel]').forEach((button) => {
        button.onclick = () => openTicketReplay(button.dataset.replayChannel);
      });
    }
    function openTicketReplay(channelId) {
      if (!channelId) return;
      window.open('/tickets/' + encodeURIComponent(channelId) + '/replay', '_blank', 'noopener');
    }
    async function loadGuildLogs(guildId = document.querySelector('#logsGuildId')?.value || document.querySelector('#guildId')?.value) {
      if (!guildId) return;
      state.activeLogGuildId = guildId;
      const target = document.querySelector('#guildLogList');
      if (target) target.innerHTML = '<p class="notice">Cargando logs del servidor...</p>';
      const logs = await getJson('/api/guilds/' + guildId + '/logs?limit=220');
      state.guildLogs = logs;
      renderGuildLogs(logs);
    }
    function renderGuildLogs(logs = state.guildLogs) {
      const target = document.querySelector('#guildLogList');
      if (!target) return;
      if (!logs.length) {
        target.innerHTML = '<p class="notice">Aun no hay logs para este servidor. Cuando Security Guard actue, se envie un mensaje owner o cambie algo relevante, aparecera aqui.</p>';
        return;
      }
      target.innerHTML = logs.map((log) => {
        const badges = [
          formatLogType(log.type),
          formatLogSeverity(log.severity)
        ].filter(Boolean);
        const meta = [
          log.actorName || log.actorId ? 'Actor: ' + (log.actorName || log.actorId) : null,
          log.targetName || log.targetId ? 'Objetivo: ' + (log.targetName || log.targetId) : null,
          log.channelName || log.channelId ? 'Canal: #' + (log.channelName || log.channelId) : null
        ].filter(Boolean);
        const fields = Array.isArray(log.metadata?.fields)
          ? log.metadata.fields.slice(0, 4).map((field) => field.name + ': ' + field.value)
          : [];
        return '<article class="log-entry ' + escapeHtml(log.severity || 'info') + '">' +
          '<div class="log-head"><div><strong>' + escapeHtml(log.title || 'Evento NexaDesk') + '</strong><span>' + escapeHtml(new Date(log.createdAt).toLocaleString()) + '</span></div><div class="log-badges">' + badges.map((badge) => '<span class="log-badge">' + escapeHtml(badge) + '</span>').join('') + '</div></div>' +
          '<div class="log-message">' + escapeHtml(log.message || '') + '</div>' +
          (meta.length ? '<div class="log-meta">' + meta.map((item) => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>' : '') +
          (fields.length ? '<div class="log-meta">' + fields.map((item) => '<span>' + escapeHtml(item).slice(0, 220) + '</span>').join('') + '</div>' : '') +
          '</article>';
      }).join('');
    }
    function formatLogType(type) {
      return ({
        security: 'Security Guard',
        ticket: 'Ticket',
        config: 'Configuracion',
        panel: 'Panel',
        component: 'Componente',
        premium: 'Premium',
        growth: 'Growth',
        owner_message: 'MD Owner',
        system: 'Sistema'
      })[type] || 'Sistema';
    }
    function formatLogSeverity(severity) {
      return ({
        debug: 'Debug',
        info: 'Info',
        success: 'Correcto',
        warning: 'Aviso',
        critical: 'Critico'
      })[severity] || 'Info';
    }
    function renderStats() {
      const stats = state.stats;
      const readinessGuilds = stats.installedGuilds || stats.totalGuilds;
      const health = readinessGuilds ? Math.round(((stats.configuredGuilds + stats.escalationReadyGuilds + stats.aiReadyGuilds + (stats.securityReadyGuilds || 0)) / (readinessGuilds * 4)) * 100) : 0;
      document.querySelector('#guildCount').textContent = stats.totalGuilds;
      document.querySelector('#guildInstallMeta').textContent = (stats.installedGuilds || 0) + ' con bot - ' + (stats.notInstalledGuilds || 0) + ' por invitar';
      document.querySelector('#ticketCount').textContent = stats.totalTickets;
      document.querySelector('#openCount').textContent = stats.openTickets;
      document.querySelector('#ratingAverage').textContent = (stats.averageRating || 0) + '/5';
      document.querySelector('#feedbackMeta').textContent = (stats.feedbackCount || 0) + ' valoraciones - ' + (stats.promoterRate || 0) + '% promotores';
      document.querySelector('#healthScore').textContent = health + '%';
      document.querySelector('.meter')?.style.setProperty('--value', health + '%');
      document.querySelector('#panelCount').textContent = stats.panels;
      document.querySelector('#aiReadyCount').textContent = stats.aiReadyGuilds;
      document.querySelector('#transcriptCount').textContent = stats.transcriptMessages;
      document.querySelector('#staffReadyCount').textContent = stats.escalationReadyGuilds;
      document.querySelector('#proGuildCount').textContent = stats.proGuilds || 0;
      document.querySelector('#securityReadyCount').textContent = stats.securityReadyGuilds || 0;
      document.querySelector('#voiceRoomCount').textContent = stats.voiceRooms || 0;
      document.querySelector('#growthReadyCount').textContent = stats.growthReadyGuilds || 0;
      document.querySelector('#welcomeReadyCount').textContent = stats.welcomeReadyGuilds || 0;
      const securityCoverageRate = (stats.installedGuilds || 0)
        ? Math.round(((stats.securityReadyGuilds || 0) / (stats.installedGuilds || 1)) * 100)
        : 0;
      document.querySelector('#securityCoverageRate').textContent = securityCoverageRate + '%';
      document.querySelector('#securityModulesAvg').textContent = String(computeAverageSecurityModules());
      document.querySelector('#securityPitchScore').textContent = securityCoverageRate >= 70 ? 'Fuerte' : securityCoverageRate >= 35 ? 'En progreso' : 'Activar';
    }
    async function refreshStats() {
      state.stats = await getJson('/api/stats');
      renderStats();
    }
    async function refreshGuilds() {
      const guilds = await getJson('/api/guilds');
      guildConfigs.splice(0, guildConfigs.length, ...guilds);
      const activeGuildId = document.querySelector('#guildId')?.value;
      if (activeGuildId) {
        const activeGuild = getGuildConfig(activeGuildId);
        renderComponentHistory(activeGuild || {});
        renderPanelHistory(activeGuild || {});
        renderPremiumPanel(activeGuild || {});
        renderPremiumAccount();
        renderGrowthPanel(activeGuild || {});
        renderGuildSelectors(activeGuildId);
      }
    }
    async function refreshPremiumAccount() {
      state.premiumAccount = await getJson('/api/premium/account');
      renderPremiumAccount();
      return state.premiumAccount;
    }
    function renderPremiumAccount() {
      const account = state.premiumAccount;
      const checkout = account?.checkout || {};
      const sales = account?.sales || {};
      document.querySelector('#premiumPackPrice').textContent = checkout.displayPrice || '3,00 €';
      document.querySelector('#premiumSalesSubline').textContent = sales.subline || 'Pagas una vez con PayPal, vuelves a NexaDesk y eliges exactamente en que servidores quieres activar el premium. NexaDesk no guarda datos de pago.';
      document.querySelector('#premiumSalesUrgency').textContent = sales.urgency || 'Precio early-access para activar monetizacion cuanto antes.';
      document.querySelector('#premiumCheckoutMode').textContent = checkout.providerLabel || 'PayPal Checkout';
      document.querySelector('#premiumSetupPrice').textContent = checkout.setupDisplayPrice || '5,00 €';
      document.querySelector('#premiumSlotsAvailable').textContent = account ? account.slotsAvailable : '...';
      document.querySelector('#premiumSlotsUsed').textContent = account ? account.slotsUsed : '...';
      document.querySelector('#premiumSlotsPurchased').textContent = account ? account.slotsPurchased : '...';
      document.querySelector('#premiumPendingPurchases').textContent = account ? account.pendingPurchases || 0 : '...';
      const buyButton = document.querySelector('#premiumBuyButton');
      if (buyButton) {
        buyButton.disabled = !checkout.configured;
        buyButton.textContent = checkout.configured
          ? 'Comprar pack premium'
          : 'PayPal pendiente';
        buyButton.onclick = buyPremiumPack;
      }
      const notice = document.querySelector('#premiumCheckoutNotice');
      if (notice) {
        notice.textContent = checkout.configured
          ? checkout.apiConfigured
            ? 'Pago seguro con PayPal Checkout. NexaDesk solo recibe confirmacion del pago y los slots.'
            : 'Pago manual activo: tras pagar, abre ticket de soporte para validar y activar slots.'
          : 'Faltan PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET o PREMIUM_PAYMENT_URL en el .env de la Raspberry Pi para activar pagos reales.';
      }

      const target = document.querySelector('#premiumActivationList');
      if (!target) return;
      if (!account) {
        target.innerHTML = '<p class="notice">Cargando estado premium...</p>';
        return;
      }

      const slotsAvailable = Number(account.slotsAvailable || 0);
      target.innerHTML = guildConfigs.length
        ? guildConfigs.map((guild) => {
            const premium = normalizePremium(guild);
            const installedText = guild.installed ? 'Bot instalado' : 'Bot no instalado todavia';
            const statusText = premium.entitled ? 'Premium activo' : slotsAvailable > 0 ? 'Listo para activar' : 'Sin slots disponibles';
            const buttonText = premium.entitled ? 'Activo' : slotsAvailable > 0 ? 'Activar' : 'Comprar';
            const disabled = premium.entitled ? ' disabled' : '';
            const action = slotsAvailable > 0 ? 'activate' : 'buy';
            return '<div class="premium-activation-row ' + (premium.entitled ? 'is-active' : '') + '">' +
              '<span><strong>' + escapeHtml(guild.guildName || guild.guildId) + '</strong><span>' + escapeHtml(statusText + ' - ' + installedText) + '</span></span>' +
              '<button class="premium-billing-action ' + (premium.entitled ? 'secondary-button' : '') + '" type="button" data-premium-action="' + action + '" data-guild-id="' + escapeHtml(guild.guildId) + '"' + disabled + '>' + escapeHtml(buttonText) + '</button>' +
              '</div>';
          }).join('')
        : '<p class="notice">No hay servidores gestionables en tu cuenta de Discord.</p>';
      bindPremiumBillingButtons(target);
    }
    function bindPremiumBillingButtons(root = document) {
      root.querySelectorAll('[data-premium-action]').forEach((button) => {
        button.onclick = () => {
          if (button.dataset.premiumAction === 'activate') {
            activatePremiumForGuild(button.dataset.guildId);
            return;
          }
          buyPremiumPack();
        };
      });
    }
    async function buyPremiumPack() {
      try {
        showToast('Preparando checkout seguro con PayPal...');
        const response = await postJson('/api/premium/checkout', {});
        if (!response.url) throw new Error('PayPal no devolvio URL de pago.');
        if (response.manual && response.message) showToast(response.message);
        window.location.href = response.url;
      } catch (error) {
        showToast(error.message);
      }
    }
    async function activatePremiumForGuild(guildId) {
      const guild = getGuildConfig(guildId);
      if (!guild) {
        showToast('No encuentro ese servidor en tu cuenta.');
        return;
      }
      try {
        showToast('Activando premium en ' + guild.guildName + '...');
        const result = await postJson('/api/premium/activate', {
          guildId,
          guildName: guild.guildName
        });
        if (Array.isArray(result.guilds)) {
          guildConfigs.splice(0, guildConfigs.length, ...result.guilds);
        }
        state.premiumAccount = result.account;
        renderGuildSelectors(document.querySelector('#guildId')?.value || guildId);
        renderPremiumAccount();
        renderPremiumPanel(getActiveGuild());
        refreshStats().catch(() => {});
        showToast(result.alreadyActive ? 'Ese servidor ya tenia premium activo.' : 'Premium activado. Ya puedes configurar los modulos.');
      } catch (error) {
        showToast(error.message);
      }
    }
    async function getJson(url) {
      const response = await fetch(url);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }
    async function postJson(url, body, method = 'POST') {
      const response = await fetch(url, { method, headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    function showToast(message) {
      const toast = document.querySelector('#toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('is-visible');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
    }
    function getGuildConfig(guildId) {
      return guildConfigs.find((guild) => guild.guildId === guildId) || null;
    }
    function getActiveGuild() {
      return getGuildConfig(document.querySelector('#guildId')?.value);
    }
    function goToView(view) {
      setActiveView(view);
      document.querySelector('main')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function getGuildReadiness(guild = {}) {
      return [
        { key: 'installed', label: 'Bot instalado', done: Boolean(guild.installed), view: 'servers' },
        { key: 'category', label: 'Categoria de tickets', done: Boolean(guild.ticketCategoryId), view: 'settings' },
        { key: 'announcements', label: 'Canal anuncios', done: Boolean(guild.discovery?.announcementChannelId), view: 'settings' },
        { key: 'staff', label: 'Rol staff', done: Boolean(guild.staffRoleId), view: 'settings' },
        { key: 'context', label: 'Contexto IA', done: Boolean(guild.serverPrompt || guild.serverInfo), view: 'settings' },
        { key: 'security', label: 'Security Guard', done: Boolean(guild.security?.enabled), view: 'settings' },
        { key: 'growth', label: 'Growth Engine', done: Boolean(normalizeGrowth(guild).enabled), view: 'growth' },
        { key: 'welcome', label: 'Welcome Center', done: Boolean(normalizeWelcome(guild).enabled), view: 'welcome' },
        { key: 'components', label: 'Componentes', done: Boolean(guild.components?.length), view: 'components' },
        { key: 'panels', label: 'Panel publicado', done: Boolean(guild.panels?.length), view: 'panels' }
      ];
    }
    function getGuildScore(guild = {}) {
      const weights = { installed:10, category:15, announcements:5, staff:15, context:20, security:15, growth:8, welcome:6, components:10, panels:15 };
      const readiness = getGuildReadiness(guild).map((item) => ({ ...item, weight: weights[item.key] || 10 }));
      const total = readiness.reduce((sum, item) => sum + item.weight, 0);
      const done = readiness.reduce((sum, item) => sum + (item.done ? item.weight : 0), 0);
      const score = total ? Math.round((done / total) * 100) : 0;
      const missing = readiness.filter((item) => !item.done);
      const label = score >= 85 ? 'Listo para operar' : score >= 60 ? 'Casi listo' : score >= 35 ? 'Setup a medias' : 'Necesita setup';
      return { score, missing, label };
    }
    function renderServerScore(guild = getActiveGuild()) {
      const scoreEl = document.querySelector('#activeScore');
      const textEl = document.querySelector('#activeScoreText');
      const meterEl = document.querySelector('#activeScoreMeter');
      const button = document.querySelector('#activeNextAction');
      if (!scoreEl || !textEl || !meterEl || !button) return;
      if (!guild) {
        scoreEl.textContent = '0%';
        textEl.textContent = 'Selecciona un servidor para auditarlo.';
        meterEl.style.setProperty('--value', '0%');
        button.textContent = 'Seleccionar servidor';
        button.dataset.goView = 'servers';
        bindNavigationButtons(button.parentElement || document);
        return;
      }
      const result = getGuildScore(guild);
      const next = result.missing[0];
      scoreEl.textContent = result.score + '%';
      textEl.textContent = next ? result.label + ' - falta: ' + next.label : result.label + ' - revisa tickets y transcripciones.';
      meterEl.style.setProperty('--value', result.score + '%');
      button.textContent = next ? 'Resolver: ' + next.label : 'Ver tickets';
      button.dataset.goView = next?.view || 'tickets';
      bindNavigationButtons(button.parentElement || document);
    }
    function formatVoiceState(guild = {}) {
      const plan = String(guild.plan || 'free').toUpperCase();
      const enabled = Boolean(guild.voiceSupportEnabled || ['PRO', 'ENTERPRISE', 'PREMIUM'].includes(plan));
      return enabled ? 'Pro activo' : plan === 'FREE' ? 'Free' : plan;
    }
    function normalizePremium(guild = {}) {
      const plan = String(guild.plan || 'free').toLowerCase();
      const entitled = Boolean(guild.voiceSupportEnabled || ['pro', 'enterprise', 'premium'].includes(plan));
      const raw = guild.premium || {};
      return {
        entitled,
        plan,
        enabled: entitled && raw.enabled !== false,
        voiceSupport: raw.voiceSupport !== false,
        priorityAi: raw.priorityAi !== false,
        smartTranscripts: raw.smartTranscripts !== false,
        securityPlus: raw.securityPlus !== false,
        customBranding: raw.customBranding === true,
        weeklyInsights: raw.weeklyInsights !== false,
        growthEngine: raw.growthEngine !== false,
        publicReviews: raw.publicReviews !== false,
        churnRadar: raw.churnRadar !== false,
        conversionInsights: raw.conversionInsights !== false,
        slaRadar: raw.slaRadar !== false,
        autoSetupPlus: raw.autoSetupPlus !== false,
        allianceAutomation: raw.allianceAutomation !== false,
        teamAssist: raw.teamAssist !== false,
        premiumAnalytics: raw.premiumAnalytics !== false,
        affiliateBoost: raw.affiliateBoost !== false,
        multiCategoryWatch: raw.multiCategoryWatch !== false,
        scheduledAnnouncements: raw.scheduledAnnouncements !== false
      };
    }
    function normalizeGrowth(guild = {}) {
      const raw = guild.growth || {};
      return {
        enabled: raw.enabled !== false,
        feedbackDm: raw.feedbackDm !== false,
        publicReviews: raw.publicReviews === true,
        lowRatingAlerts: raw.lowRatingAlerts !== false,
        inviteCta: raw.inviteCta !== false,
        testimonialMinRating: Math.min(Math.max(Number.parseInt(raw.testimonialMinRating || 5, 10) || 5, 4), 5),
        reviewChannelId: raw.reviewChannelId || '',
        reviewChannelName: raw.reviewChannelName || ''
      };
    }
    function normalizeWelcome(guild = {}) {
      const raw = guild.welcome || {};
      return {
        enabled: raw.enabled === true,
        channelId: raw.channelId || '',
        channelName: raw.channelName || '',
        message: raw.message || 'Bienvenido {user} a {server}. Si necesitas ayuda, abre un ticket y NexaDesk te guiara paso a paso.',
        dmEnabled: raw.dmEnabled === true,
        dmMessage: raw.dmMessage || 'Gracias por entrar a {server}. Si tienes dudas, abre un ticket y el equipo te ayudara con NexaDesk.',
        roleId: raw.roleId || '',
        roleName: raw.roleName || ''
      };
    }
    function formatPremiumState(guild = {}) {
      const premium = normalizePremium(guild);
      if (premium.entitled) return String(guild.plan || 'pro').toUpperCase();
      return 'Free';
    }
    function formatTranscriptState(guild = {}) {
      if (!guild?.guildId) return '0';
      return String(state.tickets.filter((ticket) => ticket.guildId === guild.guildId).length);
    }
    function formatWelcomeState(guild = {}) {
      const welcome = normalizeWelcome(guild);
      if (!welcome.enabled) return 'Off';
      if (welcome.channelName) return '#' + welcome.channelName;
      return welcome.dmEnabled ? 'MD activo' : 'Activo';
    }
    function formatScheduledAnnouncementsState(guild = {}) {
      const announcements = Array.isArray(guild.scheduledAnnouncements) ? guild.scheduledAnnouncements : [];
      if (announcements.length) {
        const active = announcements.filter((item) => item.enabled !== false).length;
        return active + '/' + announcements.length + ' programados';
      }
      return formatDiscoveredChannel(guild.discovery?.announcementChannelName, 'No detectado');
    }
    function formatDiscoveredChannel(name, fallback = 'No detectado') {
      return name ? '#' + name : fallback;
    }
    function renderDiscoverySummary(guild = {}) {
      const target = document.querySelector('#discoverySummary');
      const discovery = guild?.discovery || {};
      const items = [
        ['Anuncios', discovery.announcementChannelName, 'Destino de anuncios globales enviados desde el canal central.'],
        ['Normas', discovery.rulesChannelName, 'Reglas que ayudan a la IA a responder con contexto.'],
        ['FAQ/info', discovery.faqChannelName, 'Preguntas frecuentes y datos utiles del servidor.'],
        ['Soporte publico', discovery.supportChannelName, 'Canal publico donde suelen pedir ayuda.'],
        ['Categoria sugerida', discovery.suggestedTicketCategoryName, 'Posible categoria donde viven los tickets.'],
        ['Ultimo escaneo', discovery.scannedAt ? new Date(discovery.scannedAt).toLocaleString() : '', 'Actualiza cuando cambies canales o nombres.']
      ];
      if (target) {
        target.innerHTML = items.map(([label, value, helper]) => {
          const display = label === 'Ultimo escaneo'
            ? (value || 'Pendiente')
            : label === 'Categoria sugerida'
              ? (value || 'No detectada')
              : formatDiscoveredChannel(value);
          return '<div class="discovery-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(display) + '</strong><small>' + escapeHtml(helper) + '</small></div>';
        }).join('');
      }
      const active = document.querySelector('#activeAnnouncements');
      if (active) active.textContent = formatScheduledAnnouncementsState(guild);
    }
    async function rescanDiscovery() {
      const guildId = document.querySelector('#guildId')?.value;
      if (!guildId) {
        showToast('Selecciona un servidor primero.');
        return false;
      }
      showToast('Escaneando canales con Smart Discovery...');
      try {
        const updated = await postJson('/api/guilds/' + guildId + '/discovery', {});
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = updated;
        else guildConfigs.push(updated);
        renderGuildSelectors(guildId);
        showToast(updated.discovery?.announcementChannelName
          ? 'Anuncios detectado: #' + updated.discovery.announcementChannelName
          : 'Escaneo completado. No encontre un canal claro de anuncios.');
      } catch (error) {
        showToast(error.message);
      }
      return false;
    }
    function normalizeSecurity(guild = {}) {
      const raw = guild.security || {};
      return {
        enabled: Boolean(raw.enabled),
        level: raw.level || 'medium',
        logChannelId: raw.logChannelId || '',
        minAccountAgeDays: Number.isFinite(Number(raw.minAccountAgeDays)) ? Number(raw.minAccountAgeDays) : 3,
        antiFlood: raw.antiFlood !== false,
        antiScamLinks: raw.antiScamLinks !== false,
        antiOffensive: raw.antiOffensive !== false,
        antiBot: raw.antiBot !== false,
        antiAlt: raw.antiAlt !== false,
        antiNuke: raw.antiNuke !== false
      };
    }
    function countSecurityModules(security = {}) {
      return ['antiFlood', 'antiScamLinks', 'antiOffensive', 'antiBot', 'antiAlt', 'antiNuke']
        .filter((key) => security[key] !== false).length;
    }
    function computeAverageSecurityModules() {
      const secured = guildConfigs
        .map((guild) => normalizeSecurity(guild))
        .filter((security) => security.enabled);
      if (!secured.length) return 0;
      return Math.round((secured.reduce((sum, security) => sum + countSecurityModules(security), 0) / secured.length) * 10) / 10;
    }
    function formatSecurityState(guild = {}) {
      const security = normalizeSecurity(guild);
      if (!security.enabled) return 'Off';
      const map = { low: 'Bajo', medium: 'Intermedio', high: 'Alto' };
      return map[security.level] || 'Activo';
    }
    function renderSecurityCommercialPanel(guild = getActiveGuild()) {
      const security = normalizeSecurity(guild || {});
      const modules = countSecurityModules(security);
      const coverage = document.querySelector('#securityCoverageLabel');
      const policy = document.querySelector('#securityBotPolicyLabel');
      const risk = document.querySelector('#securityRiskLabel');
      if (coverage) coverage.textContent = security.enabled ? modules + '/6 modulos' : 'Escudo pausado';
      if (policy) policy.textContent = security.antiBot ? 'Top.gg + whitelist visual' : 'Anti-bots pausado';
      if (risk) {
        risk.textContent = !security.enabled
          ? 'Riesgo alto'
          : security.level === 'high'
            ? 'Modo anti-raid'
            : security.level === 'medium'
              ? 'Riesgo controlado'
              : 'Proteccion suave';
      }
    }
    function renderReadinessChecklist(guild = getActiveGuild()) {
      renderServerScore(guild);
      const target = document.querySelector('#readinessChecklist');
      if (!target) return;
      if (!guild) {
        target.innerHTML = '<div class="check-item">Selecciona un servidor</div>';
        return;
      }
      target.innerHTML = getGuildReadiness(guild).map((item) => (
        '<button class="check-item ' + (item.done ? 'is-done' : '') + '" type="button" data-go-view="' + item.view + '">' +
        '<span>' + emojiIcon(item.done ? 'check' : iconForReadiness(item.key), item.label) + escapeHtml(item.label) + '</span>' +
        '</button>'
      )).join('');
      bindNavigationButtons(target);
    }
    function iconForReadiness(key) {
      return {
        installed: 'server',
        category: 'ticket',
        announcements: 'global',
        staff: 'wifi',
        context: 'gear',
        security: 'siren',
        growth: 'rightArrow',
        welcome: 'check',
        components: 'ticket',
        panels: 'ticket'
      }[key] || 'rightArrow';
    }
    function renderRecommendations(guild = getActiveGuild()) {
      const target = document.querySelector('#recommendations');
      if (!target) return;
      if (!guild) {
        target.innerHTML = '<article class="recommendation"><strong>Selecciona un servidor</strong><p>El asistente te dara una ruta concreta cuando haya un servidor activo.</p></article>';
        return;
      }

      const missing = getGuildReadiness(guild).filter((item) => !item.done);
      const cards = missing.length ? missing.slice(0, 2).map((item) => recommendationForStep(item, guild)) : [
        { title: 'Listo para operar', text: 'Tu servidor tiene categoria, staff, contexto y paneles. Revisa Tickets para validar actividad y transcripciones.', view: 'tickets', action: 'Ver tickets' },
        { title: 'Mejora el prompt', text: 'Puedes afinar el contexto IA con reglas, tono, FAQ y cuando pedir capturas o videos como prueba visual.', view: 'settings', action: 'Editar contexto' }
      ];

      target.innerHTML = cards.map((card) => (
        '<article class="recommendation"><strong>' + escapeHtml(card.title) + '</strong><p>' + escapeHtml(card.text) + '</p><button class="quick-action" type="button" data-go-view="' + card.view + '">' + escapeHtml(card.action) + '</button></article>'
      )).join('');
      bindNavigationButtons(target);
    }
    function recommendationForStep(item, guild) {
      const map = {
        installed: { title: 'Invita NexaDesk', text: 'Este servidor aparece en tu cuenta, pero el bot no esta dentro. Invitalo con permisos recomendados antes de configurar.', view: 'servers', action: 'Abrir servidores' },
        category: { title: 'Elige categoria principal', text: 'Selecciona donde se detectan o crean tickets. Sin categoria, la IA no sabe que canales debe atender.', view: 'settings', action: 'Configurar categoria' },
        announcements: { title: 'Detecta anuncios y canales clave', text: 'Reescanea canales para que NexaDesk encuentre anuncios, normas, FAQ y soporte incluso con tipografias raras.', view: 'settings', action: 'Revisar discovery' },
        staff: { title: 'Asigna rol de staff', text: 'NexaDesk necesita saber a quien avisar cuando haya escalado humano o asistencia manual.', view: 'settings', action: 'Elegir staff' },
        context: { title: 'Dale contexto a la IA', text: 'Anade reglas, FAQ, tono, limites y si debe pedir pruebas visuales. Esto mejora mucho las respuestas.', view: 'settings', action: 'Escribir prompt' },
        security: { title: 'Activa Security Guard', text: 'Protege el servidor con anti-flood, anti-links IA, anti-bots, anti-alts, anti-nuke de canales/config y lockdown quirurgico solo en canales afectados.', view: 'settings', action: 'Configurar seguridad' },
        growth: { title: 'Activa Growth Engine', text: 'Pide valoraciones al cerrar tickets y convierte el buen soporte en reviews, prueba social y oportunidades de crecimiento.', view: 'growth', action: 'Abrir crecimiento' },
        welcome: { title: 'Prepara Welcome Center', text: 'Cuida la primera impresion con mensaje de bienvenida, MD opcional y rol automatico sin tocar comandos.', view: 'welcome', action: 'Configurar bienvenida' },
        components: { title: 'Crea opciones de menu', text: 'Los componentes separan tipos de ticket, preguntas previas y mensajes iniciales personalizados.', view: 'components', action: 'Crear componente' },
        panels: { title: 'Publica un panel', text: 'Ya puedes publicar un panel en un canal visible para que los usuarios abran tickets desde Discord.', view: 'panels', action: 'Publicar panel' }
      };
      return map[item.key] || { title: guild.guildName || 'Servidor', text: 'Revisa la configuracion recomendada.', view: item.view, action: 'Abrir' };
    }
    function bindNavigationButtons(root = document) {
      root.querySelectorAll('[data-go-view]').forEach((button) => {
        button.onclick = () => goToView(button.dataset.goView);
      });
    }
    function setConfigurationDisabled(disabled) {
      for (const selector of ['#ticketCategoryId', '#ticketCategoryId2', '#ticketCloseMode', '#staffRoleId', '#serverPrompt', '#serverInfo', '#allianceChannelId', '#allianceTemplate', '#categoryName', '#securityEnabled', '#securityLevel', '#securityLogChannelId', '#securityMinAccountAgeDays', '#securityAntiFlood', '#securityAntiScamLinks', '#securityAntiOffensive', '#securityAntiBot', '#securityAntiAlt', '#securityAntiNuke', '#componentLabel', '#componentEmoji', '#componentDescription', '#componentTicketCategoryId', '#componentTicketMode', '#componentQuestions', '#componentExamFormUrl', '#componentExamReviewEnabled', '#componentExamPassScore', '#componentWelcomeMessage', '#panelType', '#panelSelectPlaceholder', '#panelComponentIds', '#panelChannelId', '#panelTicketCategoryId', '#panelTicketMode', '#panelExamQuestions', '#panelExamFormUrl', '#panelExamReviewEnabled', '#panelExamPassScore', '#panelButtonLabel', '#panelButtonStyle', '#panelButtonEmoji', '#panelTitle', '#panelEmbedColor', '#panelAuthorName', '#panelAuthorIconUrl', '#panelDescription', '#panelThumbnailUrl', '#panelImageUrl', '#panelThumbnailFile', '#panelImageFile', '#panelFooterText', '#panelWelcomeMessage', '#growthEnabled', '#growthFeedbackDm', '#growthPublicReviews', '#growthReviewChannelId', '#growthTestimonialMinRating', '#growthLowRatingAlerts', '#growthInviteCta', '#welcomeEnabled', '#welcomeChannelId', '#welcomeRoleId', '#welcomeDmEnabled', '#welcomeMessage', '#welcomeDmMessage', '#premiumVoiceSupport', '#premiumPriorityAi', '#premiumSmartTranscripts', '#premiumSecurityPlus', '#premiumCustomBranding', '#premiumWeeklyInsights', '#premiumGrowthEngine', '#premiumPublicReviews', '#premiumChurnRadar', '#premiumConversionInsights', '#premiumSlaRadar', '#premiumAutoSetupPlus', '#premiumAllianceAutomation', '#premiumTeamAssist', '#premiumAnalytics', '#premiumAffiliateBoost', '#premiumMultiCategoryWatch', '#premiumScheduledAnnouncements', '#announcementChannelId', '#announcementName', '#announcementContent', '#announcementTitle', '#announcementDescription', '#announcementColor', '#announcementScheduleType', '#announcementEveryHours', '#announcementNextRunAt', '#announcementImageUrl', '#announcementFooterText']) {
        const element = document.querySelector(selector);
        if (element) element.disabled = disabled;
      }
      document.querySelectorAll('#settings button, #components button, #panels button, #view-growth button, #view-welcome button, #view-premium button').forEach((button) => {
        if (button.classList.contains('premium-billing-action')) return;
        button.disabled = disabled;
      });
    }
    function renderInstallRequired(guild) {
      setConfigurationDisabled(true);
      document.querySelector('#installBanner').hidden = false;
      document.querySelector('#installTitle').textContent = 'NexaDesk no esta instalado en este servidor.';
      document.querySelector('#installText').textContent = 'Al seleccionarlo puedes invitar el bot directamente con permisos recomendados.';
      document.querySelector('#installLink').href = guild.inviteUrl;
      document.querySelector('#installLink').textContent = 'Invitar bot';
      document.querySelector('#installLink').target = '';
      document.querySelector('#ticketCategoryId').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#ticketCategoryId2').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#staffRoleId').innerHTML = '<option>Instala NexaDesk para cargar roles</option>';
      document.querySelector('#securityLogChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#allianceChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#announcementChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#panelChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#panelComponentIds').innerHTML = '<option>Crea componentes primero</option>';
      document.querySelector('#growthReviewChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#welcomeChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#welcomeRoleId').innerHTML = '<option>Instala NexaDesk para cargar roles</option>';
      document.querySelector('#activeCategory').textContent = 'Bot no instalado';
      document.querySelector('#activeStaff').textContent = 'Bot no instalado';
      document.querySelector('#activePanels').textContent = String(guild.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(guild);
      document.querySelector('#activePremium').textContent = formatPremiumState(guild);
      document.querySelector('#activeTranscripts').textContent = formatTranscriptState(guild);
      document.querySelector('#activeAnnouncements').textContent = formatScheduledAnnouncementsState(guild);
      document.querySelector('#activeWelcome').textContent = formatWelcomeState(guild);
      renderComponentHistory(guild);
      renderPanelHistory(guild);
      renderPremiumPanel(guild);
      renderScheduledAnnouncementsPanel(guild);
      renderGrowthPanel(guild);
      renderWelcomePanel(guild);
      renderSecurityCommercialPanel(guild);
      renderDiscoverySummary(guild);
      renderReadinessChecklist(guild);
      renderRecommendations(guild);
      document.querySelectorAll('.guild-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.guildId === guild.guildId));
    }
    function renderGuildLoadError(guildId, message) {
      const guild = getGuildConfig(guildId) || {};
      setConfigurationDisabled(true);
      document.querySelector('#installBanner').hidden = false;
      document.querySelector('#installTitle').textContent = 'La Pi necesita el token del bot.';
      document.querySelector('#installText').textContent = message;
      document.querySelector('#installLink').href = 'https://nexa-desk.com/';
      document.querySelector('#installLink').target = '_blank';
      document.querySelector('#installLink').textContent = 'Abrir dashboard';
      document.querySelector('#ticketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#ticketCategoryId2').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#staffRoleId').innerHTML = '<option>No se pudieron cargar roles</option>';
      document.querySelector('#securityLogChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#allianceChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#announcementChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#panelChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#panelComponentIds').innerHTML = '<option>No se pudieron cargar componentes</option>';
      document.querySelector('#growthReviewChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#welcomeChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#welcomeRoleId').innerHTML = '<option>No se pudieron cargar roles</option>';
      document.querySelector('#activeCategory').textContent = 'Token requerido';
      document.querySelector('#activeStaff').textContent = 'Token requerido';
      document.querySelector('#activePanels').textContent = String(guild.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(guild);
      document.querySelector('#activePremium').textContent = formatPremiumState(guild);
      document.querySelector('#activeTranscripts').textContent = formatTranscriptState(guild);
      document.querySelector('#activeAnnouncements').textContent = formatScheduledAnnouncementsState(guild);
      document.querySelector('#activeWelcome').textContent = formatWelcomeState(guild);
      renderComponentHistory(guild);
      renderPanelHistory(guild);
      renderPremiumPanel(guild);
      renderScheduledAnnouncementsPanel(guild);
      renderGrowthPanel(guild);
      renderWelcomePanel(guild);
      renderSecurityCommercialPanel(guild);
      renderDiscoverySummary(guild);
      renderReadinessChecklist(guild);
      renderRecommendations(guild);
      document.querySelectorAll('.guild-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.guildId === guildId));
    }
    async function loadGuildMeta(guildId) {
      if (!guildId) return;
      const guild = getGuildConfig(guildId);
      if (guild && !guild.installed) {
        renderInstallRequired(guild);
        return;
      }
      setConfigurationDisabled(false);
      document.querySelector('#installBanner').hidden = false;
      document.querySelector('#installTitle').textContent = 'Permisos de NexaDesk';
      document.querySelector('#installText').textContent = 'Si tickets o seguridad fallan, actualiza permisos con Manage Channels, Manage Roles, View Audit Log y moderacion.';
      document.querySelector('#installLink').href = guild.inviteUrl;
      document.querySelector('#installLink').textContent = 'Actualizar permisos';
      document.querySelector('#installLink').target = '';
      const [roles, channels] = await Promise.all([
        getJson('/api/guilds/' + guildId + '/roles'),
        getJson('/api/guilds/' + guildId + '/channels')
      ]);
      guildMeta[guildId] = { roles, channels };
      renderGuildSelectors(guildId);
    }
    function renderGuildSelectors(guildId) {
      const meta = guildMeta[guildId];
      if (!meta) return;
      const config = guildConfigs.find((guild) => guild.guildId === guildId) || {};
      const categories = meta.channels.filter((channel) => channel.type === 4);
      const textChannels = meta.channels.filter((channel) => channel.type === 0);
      const categoryOptions = '<option value="">Sin categoria</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#ticketCategoryId').innerHTML = categoryOptions;
      document.querySelector('#ticketCategoryId2').innerHTML = '<option value="">Sin categoria extra</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#staffRoleId').innerHTML = '<option value="">Sin rol staff</option>' + meta.roles.map((role) => '<option value="' + role.id + '">' + escapeHtml(role.name) + '</option>').join('');
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option value="">Usar categoria principal</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#panelChannelId').innerHTML = textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option value="">Usar categoria principal</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#securityLogChannelId').innerHTML = '<option value="">Sin canal de logs</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#allianceChannelId').innerHTML = '<option value="">Sin canal de alianzas</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#announcementChannelId').innerHTML = '<option value="">Sin canal</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#growthReviewChannelId').innerHTML = '<option value="">Sin canal de reviews</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#welcomeChannelId').innerHTML = '<option value="">Sin canal publico</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#welcomeRoleId').innerHTML = '<option value="">Sin rol automatico</option>' + meta.roles.map((role) => '<option value="' + role.id + '">' + escapeHtml(role.name) + '</option>').join('');
      document.querySelector('#panelComponentIds').innerHTML = (config.components || []).length
        ? config.components.map((component) => '<option value="' + escapeHtml(component.id) + '">' + escapeHtml(component.label + ' - ' + formatTicketMode(component.ticketMode)) + '</option>').join('')
        : '<option value="">Crea componentes primero</option>';
      renderPanelComponentPicker(config);
      document.querySelector('#componentTicketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#panelTicketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#ticketCategoryId').value = config.ticketCategoryId || '';
      const watched = Array.isArray(config.watchedTicketCategories) ? config.watchedTicketCategories : [];
      const secondWatched = watched.find((item) => item?.id && item.id !== config.ticketCategoryId);
      document.querySelector('#ticketCategoryId2').value = secondWatched?.id || '';
      const premiumForCategories = normalizePremium(config);
      document.querySelector('#ticketCategoryId2').disabled = !(premiumForCategories.entitled && premiumForCategories.multiCategoryWatch);
      document.querySelector('#ticketCloseMode').value = config.ticketClosePolicy?.mode === 'staff_only' ? 'staff_only' : 'opener_and_staff';
      document.querySelector('#staffRoleId').value = config.staffRoleId || '';
      document.querySelector('#ticketCategoryName').value = config.ticketCategoryName || selectedOptionText('#ticketCategoryId');
      document.querySelector('#serverPrompt').value = config.serverPrompt || '';
      document.querySelector('#serverInfo').value = config.serverInfo || '';
      document.querySelector('#allianceChannelId').value = config.allianceChannelId || config.discovery?.allianceChannelId || '';
      document.querySelector('#allianceTemplate').value = config.allianceTemplate || '';
      const security = normalizeSecurity(config);
      document.querySelector('#securityEnabled').value = security.enabled ? 'true' : 'false';
      document.querySelector('#securityLevel').value = security.level;
      document.querySelector('#securityLogChannelId').value = security.logChannelId || '';
      document.querySelector('#securityMinAccountAgeDays').value = security.minAccountAgeDays;
      document.querySelector('#securityAntiFlood').value = security.antiFlood ? 'true' : 'false';
      document.querySelector('#securityAntiScamLinks').value = security.antiScamLinks ? 'true' : 'false';
      document.querySelector('#securityAntiOffensive').value = security.antiOffensive ? 'true' : 'false';
      document.querySelector('#securityAntiBot').value = security.antiBot ? 'true' : 'false';
      document.querySelector('#securityAntiAlt').value = security.antiAlt ? 'true' : 'false';
      document.querySelector('#securityAntiNuke').value = security.antiNuke ? 'true' : 'false';
      const growth = normalizeGrowth(config);
      document.querySelector('#growthEnabled').value = growth.enabled ? 'true' : 'false';
      document.querySelector('#growthFeedbackDm').value = growth.feedbackDm ? 'true' : 'false';
      document.querySelector('#growthPublicReviews').value = growth.publicReviews ? 'true' : 'false';
      document.querySelector('#growthReviewChannelId').value = growth.reviewChannelId || '';
      document.querySelector('#growthTestimonialMinRating').value = growth.testimonialMinRating;
      document.querySelector('#growthLowRatingAlerts').value = growth.lowRatingAlerts ? 'true' : 'false';
      document.querySelector('#growthInviteCta').value = growth.inviteCta ? 'true' : 'false';
      const welcome = normalizeWelcome(config);
      document.querySelector('#welcomeEnabled').value = welcome.enabled ? 'true' : 'false';
      document.querySelector('#welcomeChannelId').value = welcome.channelId || '';
      document.querySelector('#welcomeRoleId').value = welcome.roleId || '';
      document.querySelector('#welcomeDmEnabled').value = welcome.dmEnabled ? 'true' : 'false';
      document.querySelector('#welcomeMessage').value = welcome.message;
      document.querySelector('#welcomeDmMessage').value = welcome.dmMessage;
      document.querySelector('#activeCategory').textContent = config.ticketCategoryName || selectedOptionText('#ticketCategoryId') || 'Sin configurar';
      const staffOption = document.querySelector('#staffRoleId')?.selectedOptions?.[0];
      document.querySelector('#activeStaff').textContent = staffOption?.value ? staffOption.textContent : 'Sin configurar';
      document.querySelector('#activePanels').textContent = String(config.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(config);
      document.querySelector('#activePremium').textContent = formatPremiumState(config);
      document.querySelector('#activeTranscripts').textContent = formatTranscriptState(config);
      document.querySelector('#activeAnnouncements').textContent = formatScheduledAnnouncementsState(config);
      document.querySelector('#activeWelcome').textContent = formatWelcomeState(config);
      renderComponentHistory(config);
      renderPanelHistory(config);
      renderPremiumPanel(config);
      renderScheduledAnnouncementsPanel(config);
      renderGrowthPanel(config);
      renderWelcomePanel(config);
      renderSecurityCommercialPanel(config);
      renderDiscoverySummary(config);
      renderReadinessChecklist(config);
      renderRecommendations(config);
      updatePanelMode();
      updatePanelPreview();
      document.querySelectorAll('.guild-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.guildId === guildId));
    }
    function selectedOptionText(selector) {
      const option = document.querySelector(selector)?.selectedOptions?.[0];
      return option && option.value ? option.textContent : '';
    }
    function syncGuildForm(sourceId, { inviteIfMissing = true } = {}) {
      const guildId = document.querySelector(sourceId).value;
      const guild = getGuildConfig(guildId);
      resetPanelEditor({ keepFields: true });
      for (const selector of ['#guildId', '#categoryGuildId', '#componentGuildId', '#panelGuildId', '#growthGuildId', '#welcomeGuildId', '#premiumGuildId', '#logsGuildId']) {
        const element = document.querySelector(selector);
        if (element && element.value !== guildId) element.value = guildId;
      }
      if (guild && !guild.installed && inviteIfMissing) {
        showToast('Abriendo invitacion de NexaDesk para ' + guild.guildName + '...');
        window.location.href = guild.inviteUrl;
        return;
      }
      loadGuildMeta(guildId).catch((error) => {
        renderGuildLoadError(guildId, error.message);
        showToast(error.message);
      });
      if (state.activeView === 'logs') loadGuildLogs(guildId).catch((error) => showToast(error.message));
    }
    async function saveConfig(event) {
      event.preventDefault();
      const guildId = document.querySelector('#guildId').value;
      const categoryName = selectedOptionText('#ticketCategoryId') || document.querySelector('#ticketCategoryName').value;
      const primaryCategoryId = document.querySelector('#ticketCategoryId').value;
      const secondaryCategoryId = document.querySelector('#ticketCategoryId2').value;
      const watchedTicketCategories = [
        primaryCategoryId ? { id: primaryCategoryId, name: categoryName, primary: true } : null,
        secondaryCategoryId ? { id: secondaryCategoryId, name: selectedOptionText('#ticketCategoryId2'), primary: false } : null
      ].filter(Boolean);
      const updated = await postJson('/api/guilds/' + guildId, {
        ticketCategoryId: primaryCategoryId,
        ticketCategoryName: categoryName,
        watchedTicketCategories,
        ticketClosePolicy: {
          mode: document.querySelector('#ticketCloseMode').value,
          usersCanClose: document.querySelector('#ticketCloseMode').value !== 'staff_only'
        },
        staffRoleId: document.querySelector('#staffRoleId').value,
        serverPrompt: document.querySelector('#serverPrompt').value,
        serverInfo: document.querySelector('#serverInfo').value,
        alliance: {
          channelId: document.querySelector('#allianceChannelId').value,
          channelName: selectedOptionText('#allianceChannelId'),
          template: document.querySelector('#allianceTemplate').value
        }
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        showToast('Configuracion guardada.');
      }
      return false;
    }
    async function saveSecurity(event) {
      event.preventDefault();
      const guildId = document.querySelector('#guildId').value;
      const securityEnabled = document.querySelector('#securityEnabled').value === 'true';
      const updated = await postJson('/api/guilds/' + guildId, {
        security: {
          enabled: securityEnabled,
          level: document.querySelector('#securityLevel').value,
          logChannelId: document.querySelector('#securityLogChannelId').value,
          logChannelName: selectedOptionText('#securityLogChannelId'),
          minAccountAgeDays: document.querySelector('#securityMinAccountAgeDays').value,
          antiFlood: document.querySelector('#securityAntiFlood').value === 'true',
          antiScamLinks: document.querySelector('#securityAntiScamLinks').value === 'true',
          antiOffensive: document.querySelector('#securityAntiOffensive').value === 'true',
          antiBot: document.querySelector('#securityAntiBot').value === 'true',
          antiAlt: document.querySelector('#securityAntiAlt').value === 'true',
          antiNuke: document.querySelector('#securityAntiNuke').value === 'true',
          disabledAt: securityEnabled ? null : new Date().toISOString()
        }
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Security Guard guardado. Actualiza permisos si aun no lo hiciste.');
      }
      return false;
    }
    async function savePremium(event) {
      event.preventDefault();
      const guildId = document.querySelector('#premiumGuildId')?.value || document.querySelector('#guildId').value;
      const updated = await postJson('/api/guilds/' + guildId, {
        premium: {
          voiceSupport: document.querySelector('#premiumVoiceSupport').value === 'true',
          priorityAi: document.querySelector('#premiumPriorityAi').value === 'true',
          smartTranscripts: document.querySelector('#premiumSmartTranscripts').value === 'true',
          securityPlus: document.querySelector('#premiumSecurityPlus').value === 'true',
          customBranding: document.querySelector('#premiumCustomBranding').value === 'true',
          weeklyInsights: document.querySelector('#premiumWeeklyInsights').value === 'true',
          growthEngine: document.querySelector('#premiumGrowthEngine').value === 'true',
          publicReviews: document.querySelector('#premiumPublicReviews').value === 'true',
          churnRadar: document.querySelector('#premiumChurnRadar').value === 'true',
          conversionInsights: document.querySelector('#premiumConversionInsights').value === 'true',
          slaRadar: document.querySelector('#premiumSlaRadar').value === 'true',
          autoSetupPlus: document.querySelector('#premiumAutoSetupPlus').value === 'true',
          allianceAutomation: document.querySelector('#premiumAllianceAutomation').value === 'true',
          teamAssist: document.querySelector('#premiumTeamAssist').value === 'true',
          premiumAnalytics: document.querySelector('#premiumAnalytics').value === 'true',
          affiliateBoost: document.querySelector('#premiumAffiliateBoost').value === 'true',
          multiCategoryWatch: document.querySelector('#premiumMultiCategoryWatch').value === 'true',
          scheduledAnnouncements: document.querySelector('#premiumScheduledAnnouncements').value === 'true'
        }
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Modulos premium guardados para este servidor.');
      }
      return false;
    }
    async function saveGrowth(event) {
      event.preventDefault();
      const guildId = document.querySelector('#growthGuildId')?.value || document.querySelector('#guildId').value;
      const updated = await postJson('/api/guilds/' + guildId, {
        growth: {
          enabled: document.querySelector('#growthEnabled').value === 'true',
          feedbackDm: document.querySelector('#growthFeedbackDm').value === 'true',
          publicReviews: document.querySelector('#growthPublicReviews').value === 'true',
          reviewChannelId: document.querySelector('#growthReviewChannelId').value,
          reviewChannelName: selectedOptionText('#growthReviewChannelId'),
          testimonialMinRating: document.querySelector('#growthTestimonialMinRating').value,
          lowRatingAlerts: document.querySelector('#growthLowRatingAlerts').value === 'true',
          inviteCta: document.querySelector('#growthInviteCta').value === 'true'
        }
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Growth Engine guardado.');
      }
      return false;
    }
    function renderWelcomePanel(guild = getActiveGuild()) {
      const welcome = normalizeWelcome(guild || {});
      const values = {
        welcomeEnabled: welcome.enabled,
        welcomeDmEnabled: welcome.dmEnabled
      };
      for (const [id, value] of Object.entries(values)) {
        const element = document.querySelector('#' + id);
        if (element) element.value = value ? 'true' : 'false';
      }
      if (document.querySelector('#welcomeChannelId')) document.querySelector('#welcomeChannelId').value = welcome.channelId || '';
      if (document.querySelector('#welcomeRoleId')) document.querySelector('#welcomeRoleId').value = welcome.roleId || '';
      if (document.querySelector('#welcomeMessage')) document.querySelector('#welcomeMessage').value = welcome.message;
      if (document.querySelector('#welcomeDmMessage')) document.querySelector('#welcomeDmMessage').value = welcome.dmMessage;
      renderWelcomePreview(guild);
    }
    function renderWelcomePreview(guild = getActiveGuild()) {
      const welcome = normalizeWelcome(guild || {});
      const serverName = guild?.guildName || 'tu servidor';
      const sampleUser = '@NuevoUsuario';
      const format = (text) => String(text || '')
        .replaceAll('{user}', sampleUser)
        .replaceAll('{username}', 'NuevoUsuario')
        .replaceAll('{server}', serverName)
        .slice(0, 900);
      const channelName = selectedOptionText('#welcomeChannelId') || welcome.channelName;
      const roleName = selectedOptionText('#welcomeRoleId') || welcome.roleName;
      const publicPreview = document.querySelector('#welcomePublicPreview');
      const dmPreview = document.querySelector('#welcomeDmPreview');
      const opsPreview = document.querySelector('#welcomeOpsPreview');
      if (publicPreview) publicPreview.textContent = welcome.enabled ? format(document.querySelector('#welcomeMessage')?.value || welcome.message) : 'Welcome Center pausado.';
      if (dmPreview) dmPreview.textContent = (document.querySelector('#welcomeDmEnabled')?.value === 'true') ? format(document.querySelector('#welcomeDmMessage')?.value || welcome.dmMessage) : 'MD privado pausado.';
      if (opsPreview) {
        opsPreview.textContent = [
          welcome.enabled ? 'Activo' : 'Pausado',
          channelName ? 'Canal: #' + channelName : 'Sin canal publico',
          roleName ? 'Rol: ' + roleName : 'Sin rol automatico'
        ].join(' · ');
      }
    }
    async function saveWelcome(event) {
      event.preventDefault();
      const guildId = document.querySelector('#welcomeGuildId')?.value || document.querySelector('#guildId').value;
      const updated = await postJson('/api/guilds/' + guildId, {
        welcome: {
          enabled: document.querySelector('#welcomeEnabled').value === 'true',
          channelId: document.querySelector('#welcomeChannelId').value,
          channelName: selectedOptionText('#welcomeChannelId'),
          roleId: document.querySelector('#welcomeRoleId').value,
          roleName: selectedOptionText('#welcomeRoleId'),
          message: document.querySelector('#welcomeMessage').value,
          dmEnabled: document.querySelector('#welcomeDmEnabled').value === 'true',
          dmMessage: document.querySelector('#welcomeDmMessage').value
        }
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Welcome Center guardado.');
      }
      return false;
    }
    async function createCategory(event) {
      event.preventDefault();
      await postJson('/api/guilds/' + document.querySelector('#categoryGuildId').value + '/categories', { name: document.querySelector('#categoryName').value }).then(() => location.reload()).catch((error) => showToast(error.message));
      return false;
    }
    async function createComponent(event) {
      event.preventDefault();
      const guildId = document.querySelector('#componentGuildId').value;
      const editingId = document.querySelector('#editingComponentId').value;
      const ticketMode = document.querySelector('#componentTicketMode').value;
      const rawQuestions = document.querySelector('#componentQuestions').value.split(/\\n/).map((item) => item.trim()).filter(Boolean);
      if (ticketMode === 'exam' && !isReleasedFeature('v15-web-exam-mode')) {
        showToast('Modo examen sigue en pruebas internas. El owner puede publicarlo desde /owner.');
        return false;
      }
      const payload = {
        label: document.querySelector('#componentLabel').value,
        description: document.querySelector('#componentDescription').value,
        emoji: document.querySelector('#componentEmoji').value,
        ticketCategoryId: document.querySelector('#componentTicketCategoryId').value,
        ticketCategoryName: selectedOptionText('#componentTicketCategoryId'),
        ticketMode,
        questions: ticketMode === 'exam' ? [] : rawQuestions.slice(0, 5),
        exam: {
          enabled: ticketMode === 'exam',
          questions: ticketMode === 'exam' ? rawQuestions.slice(0, 40) : [],
          formUrl: document.querySelector('#componentExamFormUrl').value,
          reviewEnabled: document.querySelector('#componentExamReviewEnabled').value === 'true',
          passScore: document.querySelector('#componentExamPassScore').value
        },
        welcomeMessage: document.querySelector('#componentWelcomeMessage').value
      };
      const updated = await postJson(
        editingId ? '/api/guilds/' + guildId + '/components/' + encodeURIComponent(editingId) : '/api/guilds/' + guildId + '/components',
        payload,
        editingId ? 'PUT' : 'POST'
      ).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        resetComponentEditor({ keepGuild: true });
        renderGuildSelectors(guildId);
        showToast(editingId ? 'Componente actualizado y paneles sincronizados.' : 'Componente creado. Ya puedes usarlo en un panel de menu.');
      }
      return false;
    }
    function resetComponentEditor({ keepGuild = false } = {}) {
      const guildId = document.querySelector('#componentGuildId')?.value;
      document.querySelector('#editingComponentId').value = '';
      document.querySelector('#componentLabel').value = 'Soporte general';
      document.querySelector('#componentEmoji').value = '';
      document.querySelector('#componentDescription').value = 'Abre un ticket de soporte general.';
      document.querySelector('#componentTicketCategoryId').value = '';
      document.querySelector('#componentTicketMode').value = 'text';
      document.querySelector('#componentQuestions').value = '';
      document.querySelector('#componentExamFormUrl').value = '';
      document.querySelector('#componentExamReviewEnabled').value = 'false';
      document.querySelector('#componentExamPassScore').value = '6';
      document.querySelector('#componentWelcomeMessage').value = 'Hola {user}, soy NexaDesk.\\nAntes de empezar, he guardado tus respuestas para que el staff tenga contexto.\\n{answers}';
      document.querySelector('#componentSubmitButton').textContent = 'Crear componente';
      document.querySelector('#componentCancelEditButton')?.classList.add('is-hidden');
      if (keepGuild && guildId) document.querySelector('#componentGuildId').value = guildId;
      updateComponentMode();
    }
    function editComponent(componentId) {
      const guild = getGuildConfig(document.querySelector('#componentGuildId')?.value) || {};
      const component = (guild.components || []).find((item) => item.id === componentId);
      if (!component) {
        showToast('No encuentro ese componente.');
        return;
      }
      document.querySelector('#editingComponentId').value = component.id;
      document.querySelector('#componentLabel').value = component.label || '';
      document.querySelector('#componentEmoji').value = component.emoji || '';
      document.querySelector('#componentDescription').value = component.description || '';
      document.querySelector('#componentTicketCategoryId').value = component.ticketCategoryId || '';
      document.querySelector('#componentTicketMode').value = component.ticketMode || 'text';
      const questions = component.ticketMode === 'exam' ? (component.exam?.questions || []) : (component.questions || []);
      document.querySelector('#componentQuestions').value = questions.join('\\n');
      document.querySelector('#componentExamFormUrl').value = component.exam?.formUrl || '';
      document.querySelector('#componentExamReviewEnabled').value = component.exam?.reviewEnabled ? 'true' : 'false';
      document.querySelector('#componentExamPassScore').value = component.exam?.passScore ?? '6';
      document.querySelector('#componentWelcomeMessage').value = component.welcomeMessage || '';
      document.querySelector('#componentSubmitButton').textContent = 'Guardar cambios del componente';
      document.querySelector('#componentCancelEditButton')?.classList.remove('is-hidden');
      updateComponentMode();
      document.querySelector('#components')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    async function deleteComponent(componentId) {
      const guildId = document.querySelector('#componentGuildId').value;
      if (!confirm('¿Eliminar este componente? Si esta en un panel de menu, NexaDesk intentara sincronizar el panel.')) return;
      const updated = await postJson('/api/guilds/' + guildId + '/components/' + encodeURIComponent(componentId), {}, 'DELETE').catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        resetComponentEditor({ keepGuild: true });
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Componente eliminado.');
      }
    }
    function formatTicketMode(mode) {
      if (mode === 'voice') return 'Voz Pro + STT/TTS';
      if (mode === 'exam') return 'Modo examen';
      if (mode === 'staff') return 'Solo staff (sin IA)';
      return 'Texto + IA';
    }
    function updateComponentMode() {
      const mode = document.querySelector('#componentTicketMode')?.value || 'text';
      document.querySelector('#componentExamSettings')?.classList.toggle('is-hidden', mode !== 'exam');
      const questions = document.querySelector('#componentQuestions');
      if (questions) {
        questions.placeholder = mode === 'exam'
          ? 'Una pregunta por linea. Hasta 40 preguntas.\\nP: ¿Cuantos años tienes?\\nP: ¿Como actuarias ante un usuario toxico?'
          : 'Una pregunta por linea. Maximo 5.\\nEj: Cual es tu nick?\\nDescribe el problema';
      }
    }
    function renderComponentHistory(guild = {}) {
      const components = guild.components || [];
      const componentHistory = document.querySelector('#componentHistory');
      if (!componentHistory) return;
      componentHistory.innerHTML = components.length
        ? components.slice().reverse().map((component) => '<article class="panel-card"><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + (component.label || 'Componente sin nombre')) + '</strong><small>' + escapeHtml(component.description || 'Sin descripcion') + '</small><small>Modo: ' + escapeHtml(formatTicketMode(component.ticketMode)) + '</small><small>Categoria: ' + escapeHtml(component.ticketCategoryName || guild.ticketCategoryName || 'principal') + '</small><small>Preguntas: ' + escapeHtml(String(component.ticketMode === 'exam' ? ((component.exam?.questions || []).length) : ((component.questions || []).length))) + '</small><div class="card-actions"><button class="secondary-button table-action" type="button" data-edit-component="' + escapeHtml(component.id) + '">Editar</button><button class="secondary-button table-action danger-action" type="button" data-delete-component="' + escapeHtml(component.id) + '">Eliminar</button></div></article>').join('')
        : '<p class="notice">Aun no hay componentes. Crea uno para poder publicar paneles de menu.</p>';
      bindComponentButtons(componentHistory);
    }
    function renderPanelHistory(guild = {}) {
      const panels = guild.panels || [];
      const panelHistory = document.querySelector('#panelHistory');
      if (!panelHistory) return;
      panelHistory.innerHTML = panels.length
        ? panels.slice().reverse().map((panel) => '<article class="panel-card"><strong>' + escapeHtml(panel.title || 'Panel sin titulo') + '</strong><small>Tipo: ' + escapeHtml(panel.panelType === 'menu' ? 'Menu desplegable' : 'Boton') + '</small><small>Modo boton: ' + escapeHtml(formatTicketMode(panel.ticketMode)) + '</small><small>Canal: ' + escapeHtml(panel.channelName || panel.channelId || 'sin canal') + '</small><small>Categoria: ' + escapeHtml(panel.ticketCategoryName || guild.ticketCategoryName || 'principal') + '</small><small>' + escapeHtml(panel.panelType === 'menu' ? ('Componentes: ' + (panel.componentIds || []).length) : ('Boton: ' + (panel.buttonLabel || 'Abrir ticket'))) + '</small><div class="card-actions"><button class="secondary-button table-action" type="button" data-edit-panel="' + escapeHtml(panel.messageId || '') + '">Editar panel enviado</button><button class="secondary-button table-action danger-action" type="button" data-delete-panel="' + escapeHtml(panel.messageId || '') + '">Eliminar panel</button></div></article>').join('')
        : '<p class="notice">Aun no hay paneles publicados en este servidor.</p>';
      bindPanelEditButtons(panelHistory);
    }
    function renderPremiumPanel(guild = getActiveGuild()) {
      const premium = normalizePremium(guild || {});
      const planLabel = premium.entitled ? String(guild?.plan || 'pro').toUpperCase() : 'FREE';
      document.querySelector('#premiumDenied')?.classList.toggle('is-hidden', premium.entitled);
      document.querySelector('#premiumContent')?.classList.toggle('is-hidden', !premium.entitled);
      document.querySelector('#premiumPlanBadge').textContent = planLabel;
      document.querySelector('#premiumHeroCard')?.classList.toggle('premium-locked', !premium.entitled);
      document.querySelector('#premiumSettingsCard')?.classList.toggle('premium-locked', !premium.entitled);
      document.querySelector('#premiumLockNotice')?.classList.toggle('is-hidden', premium.entitled);
      document.querySelector('#premiumHeroTitle').textContent = premium.entitled
        ? 'Premium activo en este servidor.'
        : 'Prepara el upgrade antes de venderlo.';
      document.querySelector('#premiumHeroText').textContent = premium.entitled
      ? 'Configura que modulos quieres dejar activos: compatibilidad con bots externos, voz, Modo examen, IA prioritaria, smart transcripts, seguridad avanzada, Growth Engine, SLA Radar, Team Assist, alianzas y afiliados.'
        : 'Puedes dejar estos modulos preparados. Cuando el owner active Premium, NexaDesk desbloqueara las funciones de mayor valor sin rehacer la configuracion.';
      const values = {
        premiumVoiceSupport: premium.voiceSupport,
        premiumPriorityAi: premium.priorityAi,
        premiumSmartTranscripts: premium.smartTranscripts,
        premiumSecurityPlus: premium.securityPlus,
        premiumCustomBranding: premium.customBranding,
        premiumWeeklyInsights: premium.weeklyInsights,
        premiumGrowthEngine: premium.growthEngine,
        premiumPublicReviews: premium.publicReviews,
        premiumChurnRadar: premium.churnRadar,
        premiumConversionInsights: premium.conversionInsights,
        premiumSlaRadar: premium.slaRadar,
        premiumAutoSetupPlus: premium.autoSetupPlus,
        premiumAllianceAutomation: premium.allianceAutomation,
        premiumTeamAssist: premium.teamAssist,
        premiumAnalytics: premium.premiumAnalytics,
        premiumAffiliateBoost: premium.affiliateBoost,
        premiumMultiCategoryWatch: premium.multiCategoryWatch,
        premiumScheduledAnnouncements: premium.scheduledAnnouncements
      };
      for (const [id, value] of Object.entries(values)) {
        const element = document.querySelector('#' + id);
        if (element) element.value = value ? 'true' : 'false';
      }
    }
    function renderScheduledAnnouncementsPanel(guild = getActiveGuild()) {
      const list = document.querySelector('#scheduledAnnouncementList');
      if (!list) return;
      const premium = normalizePremium(guild || {});
      const announcements = Array.isArray(guild?.scheduledAnnouncements) ? guild.scheduledAnnouncements : [];
      document.querySelector('#scheduledAnnouncementsCard')?.classList.toggle('premium-locked', !premium.entitled || !premium.scheduledAnnouncements);
      if (!premium.entitled || !premium.scheduledAnnouncements) {
        list.innerHTML = '<p class="notice">Disponible en Premium. Puedes dejar el anuncio preparado, pero solo se enviara cuando el modulo este activo.</p>';
        return;
      }
      list.innerHTML = announcements.length
        ? announcements.slice().reverse().map((item) => (
          '<article class="panel-card scheduled-announcement-card">' +
          '<strong>' + escapeHtml(item.name || item.embed?.title || 'Anuncio') + '</strong>' +
          '<small>Canal: ' + escapeHtml(item.channelName || item.channelId || 'sin canal') + '</small>' +
          '<small>Estado: ' + escapeHtml(item.enabled === false ? 'Pausado' : 'Activo') + ' - Proximo: ' + escapeHtml(formatAnnouncementDate(item.nextRunAt)) + '</small>' +
          '<small>' + escapeHtml((item.embed?.title || 'Sin titulo') + ' - ' + (item.scheduleType === 'once' ? 'una vez' : ('cada ' + (item.intervalHours || 24) + 'h'))) + '</small>' +
          '<div class="card-actions"><button class="secondary-button table-action" type="button" data-edit-announcement="' + escapeHtml(item.id) + '">Editar</button><button class="secondary-button table-action danger-action" type="button" data-delete-announcement="' + escapeHtml(item.id) + '">Eliminar</button></div>' +
          '</article>'
        )).join('')
        : '<p class="notice">Aun no hay anuncios programados. Crea uno con un embed limpio y NexaDesk lo enviara solo.</p>';
      bindScheduledAnnouncementButtons(list);
    }
    async function saveScheduledAnnouncement(event) {
      event.preventDefault();
      const guildId = document.querySelector('#premiumGuildId')?.value || document.querySelector('#guildId').value;
      const guild = getGuildConfig(guildId) || {};
      const editingId = document.querySelector('#announcementName')?.dataset.editingId;
      const channelId = document.querySelector('#announcementChannelId').value;
      if (!channelId) {
        showToast('Elige un canal destino para el anuncio.');
        return false;
      }
      const existing = Array.isArray(guild.scheduledAnnouncements) ? guild.scheduledAnnouncements.slice() : [];
      const announcement = {
        id: editingId || 'ann-' + Date.now().toString(36),
        enabled: true,
        name: document.querySelector('#announcementName').value || 'Anuncio programado',
        channelId,
        channelName: selectedOptionText('#announcementChannelId'),
        content: document.querySelector('#announcementContent').value || '',
        scheduleType: document.querySelector('#announcementScheduleType').value,
        intervalHours: Number(document.querySelector('#announcementEveryHours').value || 24),
        nextRunAt: datetimeLocalToIso(document.querySelector('#announcementNextRunAt').value) || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        embed: {
          title: document.querySelector('#announcementTitle').value || 'Anuncio',
          description: document.querySelector('#announcementDescription').value,
          color: document.querySelector('#announcementColor').value || '#ffffff',
          imageUrl: document.querySelector('#announcementImageUrl').value || null,
          footerText: document.querySelector('#announcementFooterText').value || null
        },
        createdAt: existing.find((item) => item.id === editingId)?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const next = [announcement, ...existing.filter((item) => item.id !== announcement.id)].slice(0, 25);
      const updated = await postJson('/api/guilds/' + guildId, {
        scheduledAnnouncements: next
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((item) => item.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        clearAnnouncementForm();
        renderGuildSelectors(guildId);
        showToast('Anuncio programado guardado.');
      }
      return false;
    }
    function bindScheduledAnnouncementButtons(root = document) {
      root.querySelectorAll('[data-edit-announcement]').forEach((button) => {
        button.onclick = () => editScheduledAnnouncement(button.dataset.editAnnouncement);
      });
      root.querySelectorAll('[data-delete-announcement]').forEach((button) => {
        button.onclick = () => deleteScheduledAnnouncement(button.dataset.deleteAnnouncement);
      });
    }
    function editScheduledAnnouncement(id) {
      const guild = getActiveGuild() || {};
      const announcement = (guild.scheduledAnnouncements || []).find((item) => item.id === id);
      if (!announcement) return;
      document.querySelector('#announcementName').dataset.editingId = announcement.id;
      document.querySelector('#announcementChannelId').value = announcement.channelId || '';
      document.querySelector('#announcementName').value = announcement.name || '';
      document.querySelector('#announcementContent').value = announcement.content || '';
      document.querySelector('#announcementTitle').value = announcement.embed?.title || '';
      document.querySelector('#announcementDescription').value = announcement.embed?.description || '';
      document.querySelector('#announcementColor').value = announcement.embed?.color || '#ffffff';
      document.querySelector('#announcementScheduleType').value = announcement.scheduleType || 'interval';
      document.querySelector('#announcementEveryHours').value = announcement.intervalHours || 24;
      document.querySelector('#announcementNextRunAt').value = isoToDatetimeLocal(announcement.nextRunAt);
      document.querySelector('#announcementImageUrl').value = announcement.embed?.imageUrl || '';
      document.querySelector('#announcementFooterText').value = announcement.embed?.footerText || '';
      showToast('Editando anuncio programado.');
    }
    async function deleteScheduledAnnouncement(id) {
      const guildId = document.querySelector('#guildId').value;
      const guild = getGuildConfig(guildId) || {};
      const next = (guild.scheduledAnnouncements || []).filter((item) => item.id !== id);
      const updated = await postJson('/api/guilds/' + guildId, { scheduledAnnouncements: next }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((item) => item.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        showToast('Anuncio eliminado.');
      }
    }
    function clearAnnouncementForm() {
      document.querySelector('#announcementName').dataset.editingId = '';
      for (const selector of ['#announcementName', '#announcementContent', '#announcementTitle', '#announcementDescription', '#announcementImageUrl', '#announcementFooterText']) {
        const element = document.querySelector(selector);
        if (element) element.value = '';
      }
      document.querySelector('#announcementColor').value = '#ffffff';
      document.querySelector('#announcementEveryHours').value = '24';
      document.querySelector('#announcementScheduleType').value = 'interval';
      document.querySelector('#announcementNextRunAt').value = isoToDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    }
    function isoToDatetimeLocal(value) {
      const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
      if (!Number.isFinite(date.getTime())) return '';
      const offset = date.getTimezoneOffset() * 60000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 16);
    }
    function datetimeLocalToIso(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }
    function formatAnnouncementDate(value) {
      const date = value ? new Date(value) : null;
      return date && Number.isFinite(date.getTime())
        ? date.toLocaleString()
        : 'sin fecha';
    }
    async function renderGrowthPanel(guild = getActiveGuild()) {
      const growth = normalizeGrowth(guild || {});
      const values = {
        growthEnabled: growth.enabled,
        growthFeedbackDm: growth.feedbackDm,
        growthPublicReviews: growth.publicReviews,
        growthLowRatingAlerts: growth.lowRatingAlerts,
        growthInviteCta: growth.inviteCta
      };
      for (const [id, value] of Object.entries(values)) {
        const element = document.querySelector('#' + id);
        if (element) element.value = value ? 'true' : 'false';
      }
      document.querySelector('#growthReviewChannelId').value = growth.reviewChannelId || '';
      document.querySelector('#growthTestimonialMinRating').value = growth.testimonialMinRating;
      if (guild?.guildId) {
        loadGrowthFeedback(guild.guildId).catch(() => renderGrowthFeedback([]));
        loadAiQualitySignals(guild.guildId).catch(() => renderAiQualitySignals([]));
      } else {
        renderGrowthFeedback([]);
        renderAiQualitySignals([]);
      }
    }
    async function loadGrowthFeedback(guildId) {
      const feedback = await getJson('/api/guilds/' + guildId + '/feedback');
      renderGrowthFeedback(feedback);
    }
    async function loadAiQualitySignals(guildId) {
      const signals = await getJson('/api/guilds/' + guildId + '/ai-quality');
      renderAiQualitySignals(signals);
    }
    function renderGrowthFeedback(feedback = []) {
      const ratings = feedback.map((item) => Number(item.rating)).filter((rating) => rating >= 1 && rating <= 5);
      const average = ratings.length ? Math.round((ratings.reduce((sum, item) => sum + item, 0) / ratings.length) * 10) / 10 : 0;
      const promoters = ratings.filter((rating) => rating >= 4).length;
      const detractors = ratings.filter((rating) => rating <= 2).length;
      document.querySelector('#growthFeedbackCount').textContent = String(ratings.length);
      document.querySelector('#growthAverageRating').textContent = average + '/5';
      document.querySelector('#growthPromoterRate').textContent = (ratings.length ? Math.round((promoters / ratings.length) * 100) : 0) + '%';
      document.querySelector('#growthDetractors').textContent = String(detractors);
      const target = document.querySelector('#growthFeedbackList');
      if (!target) return;
      target.innerHTML = feedback.length
        ? feedback.slice(0, 12).map((item) => '<article class="feedback-card"><strong>' + escapeHtml(formatRating(item.rating)) + '</strong><span>#' + escapeHtml(item.channelName || item.channelId || 'ticket') + ' - ' + escapeHtml(item.username || item.userId || 'usuario') + '</span><span>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '</span></article>').join('')
        : '<p class="notice">Aun no hay valoraciones para este servidor.</p>';
    }
    function formatRating(rating) {
      const safe = Math.min(Math.max(Number.parseInt(rating || 0, 10) || 0, 0), 5);
      return '[' + '+'.repeat(safe) + '-'.repeat(5 - safe) + '] ' + safe + '/5';
    }
    function renderAiQualitySignals(signals = []) {
      const good = signals.filter((item) => item.detectedBy === 'dm_feedback' && item.resolved).length;
      const bad = signals.filter((item) => !item.resolved && item.detectedBy === 'dm_feedback').length;
      const critical = signals.filter((item) => ['critical', 'high'].includes(String(item.severity || '').toLowerCase())).length;
      document.querySelector('#aiQualityTotal').textContent = String(signals.length);
      document.querySelector('#aiQualityBad').textContent = String(bad);
      document.querySelector('#aiQualityGood').textContent = String(good);
      document.querySelector('#aiQualityCritical').textContent = String(critical);
      const target = document.querySelector('#aiQualityList');
      if (!target) return;
      target.innerHTML = signals.length
        ? signals.slice(0, 12).map((item) => {
            const severity = String(item.severity || 'medium').toLowerCase();
            const style = item.resolved ? 'is-positive' : ['critical', 'high'].includes(severity) ? 'is-critical' : 'is-warning';
            const label = item.resolved ? 'IA clara' : (item.category || 'IA a revisar');
            return '<article class="feedback-card ' + style + '"><strong>' + escapeHtml(label) + ' · ' + escapeHtml(severity) + '</strong><span>#' + escapeHtml(item.channelName || item.channelId || 'ticket') + ' - ' + escapeHtml(item.username || item.userId || 'usuario') + '</span><span>' + escapeHtml(item.reason || 'Sin motivo') + '</span><span>' + escapeHtml(new Date(item.createdAt).toLocaleString()) + '</span></article>';
          }).join('')
        : '<p class="notice">Aun no hay feedback rapido de IA.</p>';
    }
    function renderPanelComponentPicker(guild = getActiveGuild()) {
      const picker = document.querySelector('#panelComponentPicker');
      if (!picker) return;
      const components = guild?.components || [];
      const selectedIds = new Set([...(document.querySelector('#panelComponentIds')?.selectedOptions || [])].map((option) => option.value));
      picker.innerHTML = components.length
        ? components.map((component) => (
          '<label class="component-choice">' +
          '<input type="checkbox" value="' + escapeHtml(component.id) + '" ' + (selectedIds.has(component.id) ? 'checked' : '') + '>' +
          '<span><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + component.label) + '</strong><small>' + escapeHtml(formatTicketMode(component.ticketMode) + ' - ' + (component.ticketMode === 'exam' ? ((component.exam?.questions || []).length) : ((component.questions || []).length)) + ' preguntas') + '</small></span>' +
          '</label>'
        )).join('')
        : '<p class="notice">Crea componentes primero para montar menus con varias opciones.</p>';
      picker.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          syncPanelComponentSelectFromPicker();
          updatePanelPreview();
        });
      });
    }
    function syncPanelComponentSelectFromPicker() {
      const selectedIds = new Set([...document.querySelectorAll('#panelComponentPicker input[type="checkbox"]:checked')].map((input) => input.value));
      document.querySelectorAll('#panelComponentIds option').forEach((option) => {
        option.selected = selectedIds.has(option.value);
      });
    }
    function syncPanelComponentPickerFromSelect() {
      const selectedIds = new Set([...(document.querySelector('#panelComponentIds')?.selectedOptions || [])].map((option) => option.value));
      document.querySelectorAll('#panelComponentPicker input[type="checkbox"]').forEach((input) => {
        input.checked = selectedIds.has(input.value);
      });
    }
    function selectAllPanelComponents() {
      document.querySelectorAll('#panelComponentIds option').forEach((option) => {
        option.selected = Boolean(option.value);
      });
      syncPanelComponentPickerFromSelect();
      updatePanelPreview();
    }
    function clearPanelComponents() {
      document.querySelectorAll('#panelComponentIds option').forEach((option) => {
        option.selected = false;
      });
      syncPanelComponentPickerFromSelect();
      updatePanelPreview();
    }
    function bindPanelEditButtons(root = document) {
      root.querySelectorAll('[data-edit-panel]').forEach((button) => {
        button.onclick = () => editPanel(button.dataset.editPanel);
      });
      root.querySelectorAll('[data-delete-panel]').forEach((button) => {
        button.onclick = () => deletePanel(button.dataset.deletePanel);
      });
    }
    function bindComponentButtons(root = document) {
      root.querySelectorAll('[data-edit-component]').forEach((button) => {
        button.onclick = () => editComponent(button.dataset.editComponent);
      });
      root.querySelectorAll('[data-delete-component]').forEach((button) => {
        button.onclick = () => deleteComponent(button.dataset.deleteComponent);
      });
    }
    async function deletePanel(messageId) {
      const guildId = document.querySelector('#panelGuildId').value;
      if (!messageId) return;
      if (!confirm('¿Eliminar este panel? NexaDesk intentara borrar tambien el mensaje publicado en Discord.')) return;
      const updated = await postJson('/api/guilds/' + guildId + '/panels/' + encodeURIComponent(messageId), {}, 'DELETE').catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        resetPanelEditor();
        renderGuildSelectors(guildId);
        refreshStats().catch(() => {});
        showToast('Panel eliminado.');
      }
    }
    function updatePanelMode() {
      const panelType = document.querySelector('#panelType')?.value || 'button';
      const ticketMode = document.querySelector('#panelTicketMode')?.value || 'text';
      document.querySelector('#panelMenuComponentsSection')?.classList.toggle('is-hidden', panelType !== 'menu');
      document.querySelector('#panelSelectPlaceholderWrap')?.classList.toggle('is-hidden', panelType !== 'menu');
      document.querySelector('#panelTicketModeWrap')?.classList.toggle('is-hidden', panelType === 'menu');
      document.querySelector('#panelExamSettings')?.classList.toggle('is-hidden', panelType !== 'button' || ticketMode !== 'exam');
      document.querySelector('#previewButton')?.classList.toggle('is-hidden', panelType === 'menu');
      document.querySelector('#previewMenu')?.classList.toggle('is-hidden', panelType !== 'menu');
    }
    function selectedPanelComponents() {
      const guild = getGuildConfig(document.querySelector('#panelGuildId')?.value) || {};
      const selectedIds = [...(document.querySelector('#panelComponentIds')?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
      return (guild.components || []).filter((component) => selectedIds.includes(component.id));
    }
    function editPanel(messageId) {
      const guild = getGuildConfig(document.querySelector('#panelGuildId')?.value) || {};
      const panel = (guild.panels || []).find((item) => item.messageId === messageId);
      if (!panel) {
        showToast('No encuentro ese panel en este servidor.');
        return;
      }

      document.querySelector('#editingPanelMessageId').value = panel.messageId;
      document.querySelector('#panelType').value = panel.panelType || 'button';
      document.querySelector('#panelChannelId').value = panel.channelId || '';
      document.querySelector('#panelChannelId').disabled = true;
      document.querySelector('#panelTicketCategoryId').value = panel.ticketCategoryId || '';
      document.querySelector('#panelTicketMode').value = panel.ticketMode || 'text';
      document.querySelector('#panelExamQuestions').value = (panel.exam?.questions || []).map((item) => 'P: ' + item).join('\\n');
      document.querySelector('#panelExamFormUrl').value = panel.exam?.formUrl || '';
      document.querySelector('#panelExamReviewEnabled').value = panel.exam?.reviewEnabled ? 'true' : 'false';
      document.querySelector('#panelExamPassScore').value = panel.exam?.passScore || 6;
      document.querySelector('#panelSelectPlaceholder').value = panel.selectPlaceholder || 'Elige el tipo de ticket';
      document.querySelector('#panelTitle').value = panel.title || 'Centro de soporte';
      document.querySelector('#panelDescription').value = panel.description || '';
      document.querySelector('#panelButtonLabel').value = panel.buttonLabel || 'Abrir ticket';
      document.querySelector('#panelButtonStyle').value = panel.buttonStyle || 'primary';
      document.querySelector('#panelButtonEmoji').value = panel.buttonEmoji || '';
      document.querySelector('#panelEmbedColor').value = panel.embedColor || '#ffffff';
      document.querySelector('#panelAuthorName').value = panel.authorName || '';
      document.querySelector('#panelAuthorIconUrl').value = panel.authorIconUrl || '';
      document.querySelector('#panelThumbnailUrl').value = panel.thumbnailUrl || '';
      document.querySelector('#panelImageUrl').value = panel.imageUrl || '';
      document.querySelector('#panelThumbnailFile').value = '';
      document.querySelector('#panelImageFile').value = '';
      document.querySelector('#panelFooterText').value = panel.footerText || 'NexaDesk AI Support';
      document.querySelector('#panelWelcomeMessage').value = panel.welcomeMessage || '';
      const componentIds = new Set(panel.componentIds || []);
      document.querySelectorAll('#panelComponentIds option').forEach((option) => {
        option.selected = componentIds.has(option.value);
      });
      renderPanelComponentPicker(guild);
      document.querySelector('#panelSubmitButton').textContent = 'Guardar cambios en panel enviado';
      document.querySelector('#panelCancelEditButton').classList.remove('is-hidden');
      updatePanelPreview();
      goToView('panels');
      showToast('Panel cargado en modo edicion. El canal original no se puede mover; se editara el mensaje ya enviado.');
    }
    function resetPanelEditor({ keepFields = false } = {}) {
      const editingInput = document.querySelector('#editingPanelMessageId');
      if (!editingInput) return;
      editingInput.value = '';
      document.querySelector('#panelChannelId').disabled = false;
      document.querySelector('#panelSubmitButton').textContent = 'Publicar panel personalizado';
      document.querySelector('#panelCancelEditButton').classList.add('is-hidden');
      if (!keepFields) {
        document.querySelector('#panelType').value = 'button';
        document.querySelector('#panelTicketMode').value = 'text';
        document.querySelector('#panelExamQuestions').value = '';
        document.querySelector('#panelExamFormUrl').value = '';
        document.querySelector('#panelExamReviewEnabled').value = 'false';
        document.querySelector('#panelExamPassScore').value = '6';
        document.querySelector('#panelThumbnailUrl').value = '';
        document.querySelector('#panelImageUrl').value = '';
        document.querySelector('#panelThumbnailFile').value = '';
        document.querySelector('#panelImageFile').value = '';
        clearPanelComponents();
      }
      updatePanelPreview();
    }
    async function uploadPanelImage(input, targetSelector) {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('Sube una imagen valida.');
        input.value = '';
        return;
      }
      if (file.size > 5_000_000) {
        showToast('La imagen debe pesar menos de 5 MB.');
        input.value = '';
        return;
      }
      showToast('Subiendo imagen...');
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await postJson('/api/uploads/panel-image', {
        fileName: file.name,
        mimeType: file.type,
        dataUrl
      }).catch((error) => showToast(error.message));
      if (uploaded?.url) {
        document.querySelector(targetSelector).value = uploaded.url;
        updatePanelPreview();
        showToast('Imagen subida y lista para Discord.');
      }
    }
    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen.'));
        reader.readAsDataURL(file);
      });
    }
    function updatePanelPreview() {
      updatePanelMode();
      const color = document.querySelector('#panelEmbedColor')?.value || '#ffffff';
      const author = document.querySelector('#panelAuthorName')?.value || '';
      const title = document.querySelector('#panelTitle')?.value || 'Centro de soporte';
      const description = document.querySelector('#panelDescription')?.value || 'Pulsa el boton para abrir un ticket.';
      const footer = document.querySelector('#panelFooterText')?.value || 'NexaDesk AI Support';
      const thumbnail = document.querySelector('#panelThumbnailUrl')?.value || '';
      const image = document.querySelector('#panelImageUrl')?.value || '';
      const buttonLabel = document.querySelector('#panelButtonLabel')?.value || 'Abrir ticket';
      const buttonStyle = document.querySelector('#panelButtonStyle')?.value || 'primary';
      const buttonEmoji = document.querySelector('#panelButtonEmoji')?.value || '';
      const selectPlaceholder = document.querySelector('#panelSelectPlaceholder')?.value || 'Elige el tipo de ticket';
      document.querySelector('#panelPreview')?.style.setProperty('--preview-color', color);
      document.querySelector('#previewAuthor').textContent = author;
      document.querySelector('#previewTitle').textContent = title;
      document.querySelector('#previewDescription').textContent = description;
      document.querySelector('#previewFooter').textContent = footer;
      document.querySelector('#previewThumbnail').innerHTML = thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="Thumbnail">' : 'Thumbnail opcional';
      document.querySelector('#previewImage').innerHTML = image ? '<img src="' + escapeHtml(image) + '" alt="Imagen del embed">' : 'Imagen opcional';
      const previewButton = document.querySelector('#previewButton');
      if (previewButton) {
        previewButton.textContent = (buttonEmoji ? buttonEmoji + ' ' : '') + buttonLabel;
        previewButton.className = 'preview-button ' + buttonStyle;
      }
      const previewMenu = document.querySelector('#previewMenu');
      const previewMenuOptions = document.querySelector('#previewMenuOptions');
      if (previewMenu && previewMenuOptions) {
        previewMenu.querySelector('strong').textContent = selectPlaceholder;
        const components = selectedPanelComponents();
        previewMenuOptions.innerHTML = components.length
          ? components.map((component) => '<div class="menu-option-preview"><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + component.label) + '</strong><small>' + escapeHtml(component.description || 'Sin descripcion') + '</small><div class="question-preview">' + escapeHtml(formatTicketMode(component.ticketMode)) + ' - ' + escapeHtml(String(component.ticketMode === 'exam' ? ((component.exam?.questions || []).length) : ((component.questions || []).length))) + ' preguntas</div></div>').join('')
          : '<div class="menu-option-preview"><small>Selecciona componentes para previsualizar el menu.</small></div>';
      }
    }
    async function createPanel(event) {
      event.preventDefault();
      const guildId = document.querySelector('#panelGuildId').value;
      const editingMessageId = document.querySelector('#editingPanelMessageId').value;
      const componentIds = [...document.querySelector('#panelComponentIds').selectedOptions].map((option) => option.value).filter(Boolean);
      const ticketMode = document.querySelector('#panelTicketMode').value;
      const examQuestions = document.querySelector('#panelExamQuestions').value.split(/\\n/).map((item) => item.trim()).filter(Boolean);
      if (document.querySelector('#panelType').value === 'button' && ticketMode === 'exam' && !isReleasedFeature('v15-web-exam-mode')) {
        showToast('Modo examen sigue en pruebas internas. El owner puede publicarlo desde /owner.');
        return false;
      }
      if (document.querySelector('#panelType').value === 'menu' && componentIds.length < 2) {
        showToast('Para un panel de menu, selecciona al menos 2 componentes.');
        return false;
      }
      if (document.querySelector('#panelType').value === 'button' && ticketMode === 'exam' && !examQuestions.length && document.querySelector('#panelExamReviewEnabled').value !== 'true') {
        showToast('Para Modo examen, anade preguntas o activa revision Premium con formulario.');
        return false;
      }

      const payload = {
        channelId: document.querySelector('#panelChannelId').value,
        channelName: selectedOptionText('#panelChannelId'),
        panelType: document.querySelector('#panelType').value,
        ticketCategoryId: document.querySelector('#panelTicketCategoryId').value,
        ticketCategoryName: selectedOptionText('#panelTicketCategoryId'),
        ticketMode,
        exam: {
          enabled: ticketMode === 'exam',
          questions: ticketMode === 'exam' ? examQuestions.slice(0, 40) : [],
          formUrl: document.querySelector('#panelExamFormUrl').value,
          reviewEnabled: document.querySelector('#panelExamReviewEnabled').value === 'true',
          passScore: document.querySelector('#panelExamPassScore').value
        },
        selectPlaceholder: document.querySelector('#panelSelectPlaceholder').value,
        componentIds,
        title: document.querySelector('#panelTitle').value,
        description: document.querySelector('#panelDescription').value,
        buttonLabel: document.querySelector('#panelButtonLabel').value,
        buttonStyle: document.querySelector('#panelButtonStyle').value,
        buttonEmoji: document.querySelector('#panelButtonEmoji').value,
        embedColor: document.querySelector('#panelEmbedColor').value,
        authorName: document.querySelector('#panelAuthorName').value,
        authorIconUrl: document.querySelector('#panelAuthorIconUrl').value,
        footerText: document.querySelector('#panelFooterText').value,
        imageUrl: document.querySelector('#panelImageUrl').value,
        thumbnailUrl: document.querySelector('#panelThumbnailUrl').value,
        welcomeMessage: document.querySelector('#panelWelcomeMessage').value
      };
      const url = editingMessageId
        ? '/api/guilds/' + guildId + '/panels/' + encodeURIComponent(editingMessageId)
        : '/api/guilds/' + guildId + '/panels';
      const updated = await postJson(url, payload, editingMessageId ? 'PUT' : 'POST').catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        resetPanelEditor({ keepFields: true });
        showToast(editingMessageId ? 'Panel enviado actualizado en Discord.' : 'Panel publicado con personalizacion completa.');
      }
      return false;
    }
    function setAssistantOpen(open) {
      document.querySelector('#assistantPanel')?.classList.toggle('is-open', open);
      if (open) setTimeout(() => document.querySelector('#assistantInput')?.focus(), 80);
    }
    function appendAssistantMessage(content, { role = 'assistant', actions = [] } = {}) {
      const body = document.querySelector('#assistantBody');
      if (!body) return null;
      const article = document.createElement('article');
      article.className = 'assistant-message ' + role;
      article.textContent = content;
      if (actions.length) {
        const actionWrap = document.createElement('div');
        actionWrap.className = 'assistant-actions';
        actions.forEach((action) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'assistant-action';
          button.textContent = action.label;
          button.dataset.assistantAction = JSON.stringify(action);
          actionWrap.appendChild(button);
        });
        article.appendChild(actionWrap);
      }
      body.appendChild(article);
      bindAssistantActionButtons(article);
      body.scrollTop = body.scrollHeight;
      return article;
    }
    function bindAssistantActionButtons(root = document) {
      root.querySelectorAll('[data-assistant-action]').forEach((button) => {
        button.onclick = () => {
          try {
            applyAssistantAction(JSON.parse(button.dataset.assistantAction));
          } catch {
            showToast('No pude aplicar esa accion.');
          }
        };
      });
    }
    function applyAssistantAction(action = {}) {
      if (action.view) goToView(action.view);

      if (action.type === 'fill' && action.fields) {
        for (const [fieldId, value] of Object.entries(action.fields)) {
          const field = document.querySelector('#' + CSS.escape(fieldId));
          if (!field) continue;
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
        updatePanelPreview();
        renderReadinessChecklist(getActiveGuild());
        renderRecommendations(getActiveGuild());
        showToast(action.toast || 'He rellenado los campos. Revisa y guarda los cambios.');
        appendAssistantMessage('He rellenado los campos por ti. Revisalos y pulsa el boton principal de la seccion para guardar o publicar.', { actions: [{ label: 'Seguir en esta seccion', view: action.view || state.activeView }] });
        return;
      }

      if (action.toast) showToast(action.toast);
    }
    async function askAssistant(prompt) {
      const question = String(prompt ?? document.querySelector('#assistantInput')?.value ?? '').trim();
      if (!question) return;
      setAssistantOpen(true);
      document.querySelector('#assistantInput').value = '';
      appendAssistantMessage(question, { role: 'user' });
      const loading = appendAssistantMessage('Pensando con el contexto de tu dashboard...', { role: 'assistant loading' });
      try {
        const response = await Promise.race([
          postJson('/api/assistant', {
            message: question,
            guildId: document.querySelector('#guildId')?.value,
            activeView: state.activeView
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('El asistente esta tardando demasiado. Uso guia local.')), 10000))
        ]);
        if (loading) loading.remove();
        appendAssistantMessage(response.reply, { actions: response.actions || [] });
      } catch (error) {
        if (loading) loading.remove();
        const guild = getActiveGuild();
        const fallbackAction = guild ? getGuildReadiness(guild).find((item) => !item.done) : null;
        appendAssistantMessage('No he podido contactar con la IA ahora mismo, pero puedo seguir guiandote desde la dashboard. Prueba con Configuracion para revisar categoria, staff y contexto.', {
          actions: fallbackAction ? [{ label: fallbackAction.label, view: fallbackAction.view }] : [{ label: 'Abrir Configuracion', view: 'settings' }]
        });
        showToast(error.message);
      }
    }
    const source = new EventSource('/api/events');
    source.addEventListener('ready', () => {
      document.querySelector('#liveState').textContent = 'En vivo';
      document.querySelector('#liveState').className = 'live';
    });
    source.addEventListener('ticket.created', (event) => {
      const message = JSON.parse(event.data);
      state.tickets = [message.payload, ...state.tickets.filter((ticket) => ticket.channelId !== message.payload.channelId)];
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      renderTickets();
      refreshStats().catch(() => {});
    });
    source.addEventListener('ticket.updated', (event) => {
      const message = JSON.parse(event.data);
      state.tickets = state.tickets.map((ticket) => ticket.channelId === message.payload.channelId ? message.payload : ticket);
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      renderTickets();
      refreshStats().catch(() => {});
    });
    source.addEventListener('guild.updated', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshGuilds().catch(() => {});
      refreshStats().catch(() => {});
    });
    source.addEventListener('transcript.message', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshStats().catch(() => {});
    });
    source.addEventListener('ticket.feedback', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshStats().catch(() => {});
      renderGrowthPanel(getActiveGuild());
    });
    source.addEventListener('ai.quality.signal', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      renderGrowthPanel(getActiveGuild());
    });
    source.addEventListener('guild.log.created', (event) => {
      const message = JSON.parse(event.data);
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      if (state.activeView === 'logs' && message.payload?.guildId === (document.querySelector('#logsGuildId')?.value || document.querySelector('#guildId')?.value)) {
        state.guildLogs = [message.payload, ...state.guildLogs.filter((log) => log.id !== message.payload.id)].slice(0, 220);
        renderGuildLogs();
      }
    });
    source.addEventListener('premium.purchase.recorded', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshPremiumAccount().catch(() => {});
    });
    source.addEventListener('premium.activation.created', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshGuilds().catch(() => {});
      refreshPremiumAccount().catch(() => {});
      refreshStats().catch(() => {});
    });
    source.onerror = () => {
      document.querySelector('#liveState').textContent = 'Reconectando';
      document.querySelector('#liveState').className = '';
    };
    for (const selector of ['#guildId', '#categoryGuildId', '#componentGuildId', '#panelGuildId', '#growthGuildId', '#welcomeGuildId', '#premiumGuildId', '#logsGuildId']) {
      document.querySelector(selector)?.addEventListener('change', () => syncGuildForm(selector));
    }
    document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setActiveView(link.dataset.view);
      });
    });
    bindNavigationButtons();
    document.querySelector('#assistantLauncher')?.addEventListener('click', () => setAssistantOpen(true));
    document.querySelector('#assistantClose')?.addEventListener('click', () => setAssistantOpen(false));
    document.querySelector('#tourReplay')?.addEventListener('click', () => startDashboardTour({ force: true }));
    document.querySelector('#tourBack')?.addEventListener('click', () => moveDashboardTour(-1));
    document.querySelector('#tourNext')?.addEventListener('click', () => moveDashboardTour(1));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.querySelector('#dashboardTour')?.classList.contains('is-open')) {
        showToast('Completa el recorrido para cerrar el tutorial.');
      }
    });
    document.querySelector('#assistantForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      askAssistant();
    });
    document.querySelectorAll('[data-assistant-prompt]').forEach((button) => {
      button.addEventListener('click', () => askAssistant(button.dataset.assistantPrompt));
    });
    window.addEventListener('hashchange', () => {
      setActiveView((location.hash || '#overview').slice(1), { updateHash: false });
    });
    document.querySelectorAll('.guild-pill').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.installed === 'false') {
          showToast('Abriendo invitacion de NexaDesk...');
          window.location.href = button.dataset.inviteUrl;
          return;
        }
        document.querySelector('#guildId').value = button.dataset.guildId;
        syncGuildForm('#guildId');
      });
    });
    document.querySelector('#ticketCategoryId')?.addEventListener('change', () => {
      document.querySelector('#ticketCategoryName').value = selectedOptionText('#ticketCategoryId');
      if (!document.querySelector('#panelTicketCategoryId')?.value) {
        document.querySelector('#panelTicketCategoryId').value = document.querySelector('#ticketCategoryId').value;
      }
      if (document.querySelector('#ticketCategoryId2')?.value === document.querySelector('#ticketCategoryId').value) {
        document.querySelector('#ticketCategoryId2').value = '';
      }
    });
    document.querySelector('#componentTicketMode')?.addEventListener('input', updateComponentMode);
    document.querySelector('#componentTicketMode')?.addEventListener('change', updateComponentMode);
    for (const selector of ['#panelType', '#panelSelectPlaceholder', '#panelComponentIds', '#panelTicketMode', '#panelExamQuestions', '#panelExamFormUrl', '#panelExamReviewEnabled', '#panelExamPassScore', '#panelTitle', '#panelDescription', '#panelButtonLabel', '#panelButtonStyle', '#panelButtonEmoji', '#panelEmbedColor', '#panelAuthorName', '#panelThumbnailUrl', '#panelImageUrl', '#panelFooterText']) {
      document.querySelector(selector)?.addEventListener('input', updatePanelPreview);
      document.querySelector(selector)?.addEventListener('change', updatePanelPreview);
    }
    for (const selector of ['#welcomeEnabled', '#welcomeChannelId', '#welcomeRoleId', '#welcomeDmEnabled', '#welcomeMessage', '#welcomeDmMessage']) {
      document.querySelector(selector)?.addEventListener('input', () => renderWelcomePreview(getActiveGuild()));
      document.querySelector(selector)?.addEventListener('change', () => renderWelcomePreview(getActiveGuild()));
    }
    document.querySelector('#panelThumbnailFile')?.addEventListener('change', (event) => uploadPanelImage(event.target, '#panelThumbnailUrl'));
    document.querySelector('#panelImageFile')?.addEventListener('change', (event) => uploadPanelImage(event.target, '#panelImageUrl'));
    bindReplayButtons();
    updateComponentMode();
    updatePanelPreview();
    renderPremiumPanel(getActiveGuild());
    renderPremiumAccount();
    refreshPremiumAccount().catch((error) => showToast(error.message));
    renderGrowthPanel(getActiveGuild());
    renderWelcomePanel(getActiveGuild());
    renderSecurityCommercialPanel(getActiveGuild());
    renderReadinessChecklist(getActiveGuild());
    renderRecommendations(getActiveGuild());
    applyReleaseGates();
    setActiveView((location.hash || '#overview').slice(1), { updateHash: false });
    syncGuildForm('#guildId', { inviteIfMissing: false });
    maybeStartDashboardTour();
  </script>
</body>
</html>`;
}

function renderTicketRow(ticket) {
  return `<tr><td>#${escapeHtml(ticket.channelName)}</td><td>${escapeHtml(ticket.guildName)}</td><td>${escapeHtml(ticket.status)}</td><td>${escapeHtml(new Date(ticket.createdAt).toLocaleString())}</td><td><button class="table-action secondary-button" type="button" data-replay-channel="${escapeHtml(ticket.channelId)}">Ver</button></td></tr>`;
}

function renderTicketReplayPage({ ticket, messages, users, publicAccess = false, accessQuery = '' }) {
  const messageCount = messages.length;
  const transcriptDownloadUrl = `/api/tickets/${encodeURIComponent(ticket.channelId)}/transcript.txt${accessQuery}`;
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Replay #${escapeHtml(ticket.channelName)} - NexaDesk</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme:dark; --bg:#111214; --chat:#313338; --line:#3f4147; --text:#f2f3f5; --muted:#b5bac1; --accent:#ffffff; --mention-bg:rgba(88,101,242,.22); --mention:#dee0fc; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; color:var(--text); background:radial-gradient(circle at 24% -10%, rgba(255,255,255,.11), transparent 30%), linear-gradient(180deg,#151518,#0b0c0e); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0 1px, transparent 1px 86px), repeating-linear-gradient(0deg, rgba(255,255,255,.024) 0 1px, transparent 1px 86px); opacity:.28; }
    main { position:relative; width:min(1120px, calc(100% - 28px)); margin:0 auto; padding:24px 0 48px; }
    .replay-shell { border:1px solid rgba(255,255,255,.14); border-radius:28px; overflow:hidden; background:#2b2d31; box-shadow:0 34px 120px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,255,255,.04); }
    .replay-top { display:flex; justify-content:space-between; align-items:center; gap:18px; padding:18px 22px; border-bottom:1px solid rgba(255,255,255,.1); background:linear-gradient(180deg,#1f2024,#17181b); }
    .channel-lockup { display:flex; align-items:center; gap:12px; min-width:0; }
    .hash { display:grid; place-items:center; width:42px; height:42px; border-radius:14px; color:#111; background:#fff; font-size:25px; font-weight:950; }
    h1 { margin:0; font-size:20px; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .meta { color:var(--muted); font-size:13px; margin-top:5px; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .actions a { color:#111; background:#fff; border:0; border-radius:999px; padding:10px 13px; font-weight:900; text-decoration:none; }
    .actions a.secondary { color:#fff; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14); }
    .chat { padding:8px 0 18px; background:var(--chat); }
    .day-divider { display:flex; align-items:center; gap:12px; margin:18px 22px 12px; color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
    .day-divider::before,.day-divider::after { content:""; height:1px; flex:1; background:rgba(255,255,255,.12); }
    .message { display:grid; grid-template-columns:44px minmax(0,1fr); gap:12px; padding:4px 22px; margin:0; }
    .message:hover { background:rgba(255,255,255,.035); }
    .avatar { width:42px; height:42px; border-radius:50%; object-fit:cover; background:#111; border:1px solid rgba(255,255,255,.12); }
    .avatar-fallback { display:grid; place-items:center; font-weight:950; color:#111; background:#fff; }
    .message-head { display:flex; gap:9px; align-items:baseline; min-width:0; }
    .author { font-weight:900; color:#fff; }
    .bot-tag { color:#fff; background:#5865f2; border-radius:4px; padding:1px 4px; font-size:11px; font-weight:950; }
    time { color:var(--muted); font-size:12px; }
    .content { margin-top:2px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.42; color:#dbdee1; }
    .mention { color:var(--mention); background:var(--mention-bg); border-radius:4px; padding:0 3px; font-weight:800; }
    .emoji { width:22px; height:22px; object-fit:contain; vertical-align:-5px; }
    .attachments { display:grid; gap:8px; margin-top:8px; max-width:620px; }
    .attachment { border:1px solid rgba(255,255,255,.12); border-radius:12px; overflow:hidden; background:#232428; }
    .attachment img { display:block; max-height:420px; width:auto; max-width:100%; }
    .attachment a { display:block; color:#fff; padding:10px 12px; text-decoration:none; font-weight:800; }
    .empty { padding:60px 22px; text-align:center; color:var(--muted); }
    @media (max-width:720px) { main { width:100%; padding:0; } .replay-shell { min-height:100vh; border-radius:0; border-left:0; border-right:0; } .replay-top { align-items:flex-start; flex-direction:column; } .actions { width:100%; justify-content:flex-start; } .message { padding:6px 14px; grid-template-columns:38px minmax(0,1fr); } .avatar { width:36px; height:36px; } }
  </style>
</head>
<body>
  <main>
    <section class="replay-shell">
      <header class="replay-top">
        <div class="channel-lockup">
          <span class="hash">#</span>
          <div>
            <h1>${escapeHtml(ticket.channelName || ticket.channelId)}</h1>
            <div class="meta">${escapeHtml(ticket.guildName || 'Servidor')} - ${escapeHtml(ticket.status || 'open')} - ${messageCount} mensajes guardados</div>
          </div>
        </div>
        <div class="actions">
          ${publicAccess ? '' : '<a class="secondary" href="/#tickets">Volver a dashboard</a>'}
          <a href="${escapeHtml(transcriptDownloadUrl)}">Descargar TXT</a>
        </div>
      </header>
      <section class="chat">
        ${renderReplayMessages(messages, users)}
      </section>
    </section>
  </main>
</body>
</html>`;
}

function renderReplayMessages(messages, users) {
  if (!messages.length) return '<div class="empty">Este ticket aun no tiene mensajes guardados.</div>';
  let lastDay = '';
  return messages.map((message) => {
    const day = formatReplayDay(message.createdAt);
    const divider = day !== lastDay ? `<div class="day-divider">${escapeHtml(day)}</div>` : '';
    lastDay = day;
    return divider + renderReplayMessage(message, users);
  }).join('');
}

function renderReplayMessage(message, users) {
  const user = users.get(String(message.authorId ?? '')) ?? {
    name: message.authorName || message.role || 'Desconocido',
    bot: message.authorBot
  };
  const parsed = parseReplayContent(message.content);
  return `<article class="message">
    ${renderReplayAvatar(user)}
    <div>
      <div class="message-head"><span class="author">${escapeHtml(user.name)}</span>${user.bot ? '<span class="bot-tag">APP</span>' : ''}<time>${escapeHtml(formatReplayTime(message.createdAt))}</time></div>
      ${parsed.text ? `<div class="content">${renderReplayText(parsed.text, users)}</div>` : ''}
      ${parsed.attachments.length ? `<div class="attachments">${parsed.attachments.map(renderReplayAttachment).join('')}</div>` : ''}
    </div>
  </article>`;
}

function renderReplayAvatar(user) {
  if (user.avatarUrl) {
    return `<img class="avatar" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}">`;
  }
  if (user.bot) {
    return '<img class="avatar" src="/assets/nexadesk-logo.svg" alt="NexaDesk">';
  }
  return `<div class="avatar avatar-fallback">${escapeHtml(String(user.name ?? '?').trim().slice(0, 1).toUpperCase() || '?')}</div>`;
}

function parseReplayContent(content) {
  const attachments = [];
  const textLines = [];
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const match = line.match(/^\[Adjunto:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(https?:\/\/[^\]]+)\]$/i);
    if (match) {
      attachments.push({ name: match[1], contentType: match[2], url: match[3] });
    } else {
      textLines.push(line);
    }
  }
  return { text: textLines.join('\n').trim(), attachments };
}

function renderReplayText(text, users) {
  return escapeHtml(text)
    .replace(/&lt;@!?(\d{17,22})&gt;/g, (_match, userId) => {
      const user = users.get(String(userId));
      return `<span class="mention">@${escapeHtml(user?.name || userId)}</span>`;
    })
    .replace(/&lt;(a?):([a-zA-Z0-9_]{2,32}):(\d{17,22})&gt;/g, (_match, animated, name, id) => {
      const extension = animated ? 'gif' : 'png';
      return `<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${extension}" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:">`;
    });
}

function renderReplayAttachment(attachment) {
  const isImage = /^image\//i.test(attachment.contentType) || /\.(png|jpe?g|webp|gif)$/i.test(attachment.url);
  if (isImage) {
    return `<div class="attachment"><a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${escapeHtml(attachment.name || 'Imagen adjunta')}</a><img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachment.name || 'Imagen adjunta')}" loading="lazy"></div>`;
  }
  return `<div class="attachment"><a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${escapeHtml(attachment.name || 'Archivo adjunto')}</a></div>`;
}

function buildReplayUserMap(messages) {
  const users = new Map();
  for (const message of messages) {
    if (!message.authorId) continue;
    const id = String(message.authorId);
    if (!users.has(id)) {
      users.set(id, {
        id,
        name: message.authorName || message.role || id,
        bot: Boolean(message.authorBot)
      });
    }
  }
  for (const content of messages.map((message) => message.content || '')) {
    for (const match of String(content).matchAll(/<@!?(\d{17,22})>/g)) {
      const id = match[1];
      if (!users.has(id)) users.set(id, { id, name: id, bot: false });
    }
  }
  return users;
}

async function hydrateReplayUsersFromDiscord({ config, users }) {
  if (!config.DISCORD_TOKEN || !users.size) return;
  const entries = [...users.values()].filter((user) => user.id && !user.bot).slice(0, 35);
  await Promise.all(entries.map(async (user) => {
    const fetched = await fetchDiscordUserWithBot(config, user.id).catch(() => null);
    if (!fetched) return;
    user.name = fetched.global_name || fetched.username || user.name;
    user.avatarUrl = buildDiscordAvatarUrl(fetched);
  }));
}

async function fetchDiscordUserWithBot(config, userId) {
  const response = await fetch(`${DISCORD_API}/users/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bot ${config.DISCORD_TOKEN}` }
  });
  if (!response.ok) return null;
  return response.json();
}

function buildDiscordAvatarUrl(user) {
  if (user?.avatar) {
    const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=80`;
  }
  const index = Number(BigInt(user.id ?? 0) % 5n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function formatReplayDay(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? 'Fecha desconocida' : date.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatReplayTime(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function renderSimpleErrorPage(title, message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - NexaDesk</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#fff;font-family:Segoe UI,system-ui,sans-serif}article{width:min(560px,calc(100% - 32px));border:1px solid rgba(255,255,255,.16);border-radius:28px;padding:28px;background:linear-gradient(145deg,rgba(255,255,255,.1),rgba(255,255,255,.03));box-shadow:0 30px 100px rgba(0,0,0,.45)}h1{margin:0;font-size:34px}p{color:#b5b5b5;line-height:1.55}a{color:#050505;background:#fff;border-radius:999px;padding:10px 14px;text-decoration:none;font-weight:900}</style></head><body><article><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/">Volver</a></article></body></html>`;
}

function toInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function validateWebExamAccess({ ticket, guildConfig, state, token }) {
  if (!ticket) {
    return { status: 404, title: 'Examen no encontrado', message: 'Este enlace no corresponde a un ticket de examen activo.' };
  }
  if (!state.enabled || state.mode !== 'premium_review') {
    return { status: 403, title: 'Examen no disponible', message: 'Este ticket no tiene el formulario web Premium activo.' };
  }
  if (!isPremiumEntitled(guildConfig ?? {})) {
    return { status: 403, title: 'Premium requerido', message: 'El formulario web de examen solo esta disponible en servidores Premium.' };
  }
  if (!state.formToken || token !== state.formToken) {
    return { status: 403, title: 'Codigo de examen invalido', message: 'El enlace de examen no es valido o ha caducado. Vuelve al ticket y usa el enlace enviado por NexaDesk.' };
  }
  if (!state.questions.length) {
    return { status: 422, title: 'Sin preguntas configuradas', message: 'Este examen no tiene preguntas guardadas. El staff debe revisar la configuracion del panel.' };
  }
  return null;
}

function renderExamPage({ ticket, guildConfig, state, token, error = null, submitted = false }) {
  const evaluation = state?.evaluation;
  const resultHtml = evaluation
    ? `<div class="result"><h2>Resultado provisional</h2><p><strong>${Number(evaluation.score ?? 0).toFixed(1)}/10</strong> - ${evaluation.passed ? 'apto provisional' : 'no apto provisional'}</p><p>${escapeHtml(evaluation.summary ?? '')}</p></div>`
    : '';
  const questionsHtml = (state?.questions ?? []).map((question, index) => `
    <label class="question">
      <span>${index + 1}. ${escapeHtml(question)}</span>
      <textarea name="answer_${index}" required minlength="2" maxlength="2200" placeholder="Responde con tus propias palabras...">${escapeHtml(state.answers?.[index]?.answer ?? '')}</textarea>
    </label>
  `).join('');
  const completed = submitted || state?.status === 'completed';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NexaDesk Exam Mode</title>
  <style>
    :root { color-scheme: dark; --bg:#050505; --card:#101010; --line:#2c2c2c; --text:#f7f7f7; --muted:#a7a7a7; --gold:#f4c95d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 20% 10%, rgba(244,201,93,.16), transparent 28%), linear-gradient(135deg, #020202, #111 48%, #050505); color:var(--text); }
    body:before { content:""; position:fixed; inset:0; background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px); background-size:48px 48px; mask-image: radial-gradient(circle at center, black, transparent 78%); pointer-events:none; }
    main { width:min(920px, calc(100% - 28px)); margin:0 auto; padding:42px 0 64px; position:relative; z-index:1; }
    .hero { border:1px solid var(--line); border-radius:30px; padding:28px; background:rgba(16,16,16,.78); box-shadow:0 30px 90px rgba(0,0,0,.42); backdrop-filter: blur(16px); }
    .eyebrow { color:var(--gold); letter-spacing:.14em; text-transform:uppercase; font-size:12px; font-weight:800; }
    h1 { margin:.35rem 0 .6rem; font-size:clamp(34px, 7vw, 74px); line-height:.9; letter-spacing:-.06em; }
    p { color:var(--muted); font-size:17px; line-height:1.55; }
    form, .result, .error { margin-top:22px; border:1px solid var(--line); border-radius:24px; padding:22px; background:rgba(255,255,255,.035); }
    .question { display:block; margin:0 0 18px; }
    .question span { display:block; margin-bottom:8px; font-weight:800; }
    textarea { width:100%; min-height:130px; resize:vertical; border:1px solid #3b3b3b; border-radius:18px; background:#060606; color:var(--text); padding:14px; font:inherit; outline:none; }
    textarea:focus { border-color:var(--gold); box-shadow:0 0 0 3px rgba(244,201,93,.16); }
    button { width:100%; border:0; border-radius:18px; padding:16px 18px; background:var(--gold); color:#050505; font-weight:950; font-size:16px; cursor:pointer; }
    button:hover { filter:brightness(1.08); transform:translateY(-1px); }
    .meta { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:18px; }
    .meta div { border:1px solid var(--line); border-radius:16px; padding:12px; color:var(--muted); }
    .meta strong { display:block; color:var(--text); }
    .error { border-color:#8b3535; background:rgba(255,95,87,.08); }
    .ok { border-color:rgba(244,201,93,.55); background:rgba(244,201,93,.08); }
    @media (max-width:720px) { .meta { grid-template-columns:1fr; } .hero { padding:20px; border-radius:22px; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">NexaDesk Premium Exam Mode</div>
      <h1>Examen web seguro</h1>
      <p>Responde desde aqui con calma. NexaDesk guardara tus respuestas en el ticket y dara una nota provisional para que el staff pueda revisarla.</p>
      <div class="meta">
        <div><strong>${escapeHtml(guildConfig?.guildName ?? ticket?.guildName ?? 'Servidor')}</strong>Servidor</div>
        <div><strong>#${escapeHtml(ticket?.channelName ?? 'ticket')}</strong>Ticket</div>
        <div><strong>${escapeHtml(String(state?.passScore ?? 6))}/10</strong>Nota minima</div>
      </div>
      ${error ? `<div class="error"><h2>${escapeHtml(error.title)}</h2><p>${escapeHtml(error.message)}</p></div>` : ''}
      ${completed ? `<div class="result ok"><h2>Examen enviado</h2><p>Las respuestas ya han quedado guardadas. Vuelve a Discord para ver el resultado y pedir revision humana si lo necesitas.</p></div>${resultHtml}` : ''}
      ${!error && !completed ? `<form method="post" action="/exam/${encodeURIComponent(ticket.channelId)}?token=${encodeURIComponent(token)}">
        ${questionsHtml}
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Enviar examen</button>
      </form>` : ''}
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
