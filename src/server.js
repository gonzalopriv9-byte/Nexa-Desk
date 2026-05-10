import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroqClient } from './ai/groq-client.js';
import { GLOBAL_BLACKLIST_ADMIN_USER_ID, buildGlobalBanCode, isBlacklistEntryActive, parseBlacklistDuration } from './blacklist.js';
import { normalizeTotpSecret, verifyTotpCode } from './docs-auth.js';
import { normalizeTicketComponent } from './panel-options.js';
import { isPremiumEntitled, normalizePremiumConfig, summarizePremiumConfig } from './premium.js';
import { normalizeSecurityConfig, summarizeSecurityConfig } from './security.js';
import { buildTranscriptFileName, buildTranscriptText } from './transcripts.js';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const BOT_INVITE_PERMISSIONS = '1099780189334';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const docsAuthAttempts = new Map();

export function createServer({ config, storage, bot, events }) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('tiny'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(config.SESSION_SECRET));
  app.use('/assets', express.static(ASSETS_DIR, {
    immutable: true,
    maxAge: '7d'
  }));

  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(path.join(ASSETS_DIR, 'nexadesk-logo.svg'));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nexadesk' });
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /docs\nDisallow: /api\n');
  });

  app.get('/login', (req, res) => {
    if (getSession(req)) {
      res.redirect('/');
      return;
    }
    res.type('html').send(renderLogin(config));
  });

  app.get('/auth/discord', (req, res) => {
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
      res.redirect('/');
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

  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }

    const session = getSession(req);
    if (!session) {
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

  app.get('/invite/:guildId', requireGuildAccess, (req, res) => {
    res.redirect(buildBotInviteUrl(config, req.params.guildId));
  });

  app.get('/api/me', (req, res) => {
    res.json(req.session);
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const send = (event) => {
      if (event.payload?.guildId && !canAccessGuild(req.session, event.payload.guildId)) return;
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
    if (!ticket || !canAccessGuild(req.session, ticket.guildId)) {
      res.status(404).type('text/plain').send('Ticket not found');
      return;
    }

    const messages = await storage.listTranscriptMessages(req.params.channelId);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${buildTranscriptFileName(ticket)}"`);
    res.send(buildTranscriptText({ ticket, messages }));
  }));

  app.get('/api/guilds/:guildId/roles', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildRoles({ guildId: req.params.guildId }));
  }));

  app.get('/api/guilds/:guildId/channels', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildChannels({ guildId: req.params.guildId }));
  }));

  app.post('/api/guilds/:guildId', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const existing = await storage.getGuildConfig(req.params.guildId);
    const patch = { guildName: req.body.guildName || existing?.guildName || guild?.name };
    for (const key of ['ticketCategoryId', 'ticketCategoryName', 'staffRoleId', 'serverPrompt', 'serverInfo']) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key];
    }
    if (req.body.security) patch.security = normalizeSecurityConfig(req.body.security);
    if (req.session.user?.id === GLOBAL_BLACKLIST_ADMIN_USER_ID) {
      if (Object.prototype.hasOwnProperty.call(req.body, 'plan')) patch.plan = req.body.plan;
      if (Object.prototype.hasOwnProperty.call(req.body, 'voiceSupportEnabled')) patch.voiceSupportEnabled = Boolean(req.body.voiceSupportEnabled);
    }
    if (req.body.premium) {
      patch.premium = normalizePremiumConfig(req.body.premium, { ...(existing ?? {}), ...patch });
    }
    const updated = await storage.upsertGuildConfig(req.params.guildId, patch);
    res.json(updated);
  }));

  app.post('/api/guilds/:guildId/categories', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.createTicketCategory({
        guildId: req.params.guildId,
        name: req.body.name || 'NexaDesk Tickets'
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
    res.json(updated);
  }));

  app.post('/api/guilds/:guildId/panels', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.createTicketPanel(buildPanelRequestPayload(req));
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
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }));

  app.get('/', asyncHandler(async (req, res) => {
    const manageableGuildIds = req.session.guilds.map((guild) => guild.id);
    const [configs, tickets, stats] = await Promise.all([
      storage.listGuildConfigs(),
      storage.listTickets(),
      storage.getDashboardStats(manageableGuildIds)
    ]);
    const installedGuildIds = await getInstalledGuildIds(bot, configs);
    const guilds = mergeUserGuilds(req.session, configs, installedGuildIds, config);
    res.type('html').send(renderDashboard({
      session: req.session,
      guilds,
      tickets: tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)),
      stats: enrichDashboardStats(stats, guilds)
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

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/Expected token to be set/i.test(message)) {
    return 'Falta DISCORD_TOKEN en Render. Pon el token actual del bot en Environment y redeploy para cargar roles, canales y paneles.';
  }
  if (/401|Unauthorized|Invalid Form Body|TOKEN_INVALID|invalid token/i.test(message)) {
    return 'El DISCORD_TOKEN configurado en Render no es valido o fue reseteado. Actualizalo con el token actual del bot y redeploy.';
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
    res.status(403).json({ error: 'Global admin only.' });
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

function canManageGuild(guild) {
  const permissions = BigInt(guild.permissions ?? '0');
  return guild.owner || (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

function canAccessGuild(session, guildId) {
  return session.guilds.some((guild) => guild.id === guildId);
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
    proGuilds: guilds.filter(isPremiumEntitled).length,
    panels: guilds.reduce((total, guild) => total + (guild.panels?.length ?? 0), 0)
  };
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
    voiceRooms: 0,
    proGuilds: 0
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
  const entry = docsAuthAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    docsAuthAttempts.delete(ip);
    return false;
  }
  return entry.count >= 6;
}

function recordDocsFailure(ip) {
  const now = Date.now();
  const entry = docsAuthAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    docsAuthAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  entry.count += 1;
}

function clearDocsFailures(ip) {
  docsAuthAttempts.delete(ip);
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
        'Ayuda a configurar servidores Discord para tickets con IA, paneles, componentes, staff, voz Pro con STT/TTS, transcripciones, Security Guard y Premium.',
        'La dashboard real tiene estas secciones: Resumen, Servidores, Configuracion, Componentes, Paneles, Premium y Tickets.',
        'En Configuracion se elige categoria, rol staff, prompt del servidor, informacion del servidor y Security Guard.',
        'En Componentes se crean opciones del menu con preguntas previas, primer mensaje y modo Texto o Voz Pro.',
        'En Paneles se publica el embed, boton o menu en un canal de Discord; los botones tambien pueden abrir tickets de voz Pro.',
        'En Premium se gestionan Voz Pro, IA prioritaria, transcripciones inteligentes, Security Plus, branding propio e informes semanales por servidor.',
        'En Tickets se ven tickets y transcripciones guardadas.',
        'Si el usuario pide que tu metas algo, explica que puedes rellenar campos con botones de accion, pero el usuario debe revisar y guardar/publicar.',
        'No pidas IDs si la dashboard ya ofrece selectores de roles, canales y categorias.',
        'Si recomiendas navegar, menciona una seccion exacta: Resumen, Servidores, Configuracion, Componentes, Paneles, Premium o Tickets.',
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
  } else if (lower.includes('panel') || lower.includes('menu') || lower.includes('boton')) {
    reply += guild.components?.length
      ? 'Para publicar un panel, ve a Paneles, elige canal, modo boton o menu y revisa la previsualizacion antes de publicar.'
      : 'Si quieres un menu desplegable, crea primero opciones en Componentes y despues publica el panel desde Paneles.';
  } else if (lower.includes('premium') || lower.includes('pro') || lower.includes('voz') || lower.includes('voice') || lower.includes('branding') || lower.includes('analitica') || lower.includes('insight')) {
    reply += isPremiumEntitled(guild)
      ? 'Ve a Premium para activar o pausar Voz Pro, IA prioritaria, transcripciones inteligentes, Security Plus, branding propio e informes semanales por servidor.'
      : 'Ve a Premium para ver que desbloquea el plan. La activacion del plan se hace manualmente con /activarpremium o desde Supabase, y despues alli gestionas los modulos.';
  } else if (lower.includes('seguridad') || lower.includes('security') || lower.includes('anti') || lower.includes('raid') || lower.includes('flood') || lower.includes('nuke') || lower.includes('phishing') || lower.includes('estafa') || lower.includes('links')) {
    reply += 'Ve a Configuracion y baja hasta Security Guard. Puedes activar nivel intermedio, Anti-links IA, elegir un canal de logs y guardar. Si Discord bloquea acciones, actualiza permisos desde el boton superior.';
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

  if (lower.includes('premium') || lower.includes('pro') || lower.includes('voz') || lower.includes('voice') || lower.includes('branding') || lower.includes('analitica') || lower.includes('insight')) add('Abrir Premium', 'premium');
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

function renderDocsDisabled(config) {
  return renderDocsShell({
    title: 'NexaDesk Docs bloqueado',
    body: `
      <main class="gate">
        <img src="/assets/nexadesk-logo.svg" alt="NexaDesk" class="gate-logo">
        <p class="kicker">NexaDesk internal vault</p>
        <h1>Docs aun no esta configurado.</h1>
        <p>Define <code>DOCS_TOTP_SECRET</code> en Render y en la Pi para activar el acceso con Google Authenticator.</p>
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
            <p>Arquitectura, secretos, despliegue, seguridad, IA, voz, Supabase y playbooks operativos. Valores criticos redacted por seguridad.</p>
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
    ['SUPABASE_SERVICE_ROLE_KEY', secretState(config.SUPABASE_SERVICE_ROLE_KEY), 'Acceso total a Supabase desde backend. Nunca exponer al cliente.'],
    ['GROQ_API_KEY', secretState(config.GROQ_API_KEY), 'Cuenta IA primaria.'],
    ['GROQ_FALLBACK_API_KEYS', secretState(config.GROQ_FALLBACK_API_KEYS), 'Cuentas IA backup separadas por coma.'],
    ['AKIOMAE_API_KEY', secretState(config.AKIOMAE_API_KEY), 'Fallback externo cuando Groq agote limites.']
  ];

  return [
    {
      title: 'Mapa maestro',
      classification: 'Owner only',
      summary: 'Vision global de como esta dividido NexaDesk y que piezas no deben filtrarse.',
      blocks: [
        { type: 'list', items: [
          'Render sirve la dashboard publica con RUN_BOT=false y usa OAuth Discord para usuarios normales.',
          'La Raspberry Pi mantiene vivo el worker del bot con RUN_BOT=true y systemd.',
          'Supabase guarda configuracion, paneles, componentes, tickets, transcripciones y blacklist interna.',
          'Groq procesa soporte IA, vision, STT y parte de TTS; Akiomae queda como fallback final.',
          '/docs es una zona oculta: no aparece en la UI, requiere TOTP y no debe contener secretos en claro.'
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
          ['Dashboard web', 'Render Web Service', 'RUN_BOT=false; necesita token para roles/canales/paneles via REST.'],
          ['Bot worker', 'Raspberry Pi pi@192.168.1.52 /home/pi/nexadesk', 'Servicio systemd nexadesk; health local en puerto 3010. Password no documentada aqui.'],
          ['Repositorio', 'github.com/gonzalopriv9-byte/Nexa-Desk', 'main despliega Render si auto-deploy esta activo.'],
          ['Dominio dashboard', 'https://nexa-desk.onrender.com/', 'OAuth redirect debe apuntar a /auth/discord/callback.']
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
          'Comandos clave: /setup, /ayuda, /desactivar ia, /activar ia, /ticket cerrar, /ticket resumen, /voz crear, /globalstats, /activarpremium.',
          'Si entra staff al ticket, NexaDesk deja de responder salvo mencion, reply o llamada directa.'
        ] }
      ]
    },
    {
      title: 'Supabase y datos guardados',
      classification: 'Data model',
      summary: 'Tablas, contenido guardado y decisiones de privacidad.',
      blocks: [
        { type: 'table', headers: ['Tabla', 'Contenido', 'Riesgo'], rows: [
          ['guild_configs', 'Categoria, staff, prompt, info, paneles, componentes, premium, security, alianzas.', 'Alto: contiene contexto interno del servidor.'],
          ['tickets', 'Canal, servidor, opener, voz, estado, timestamps.', 'Medio: metadatos de soporte.'],
          ['transcript_messages', 'Mensajes de tickets, voz y eventos importantes.', 'Alto: puede contener datos de usuarios.'],
          ['global_blacklist', 'Baneos internos y codigos.', 'Alto: moderacion sensible.'],
          ['global_blacklist_evidence', 'URLs de pruebas y adjuntos.', 'Alto: evidencias privadas.']
        ] },
        { type: 'list', items: [
          'Produccion debe mostrar "NexaDesk storage backend: Supabase" al arrancar.',
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
          'Dashboard: Resumen, Servidores, Configuracion, Componentes, Paneles, Premium y Tickets.',
          'Paneles soportan boton unico o menu desplegable con 2+ componentes.',
          'Componentes guardan preguntas previas, categoria destino, primer mensaje y modo texto/voz.',
          'Premium incluye Voz Pro, IA prioritaria, transcripciones inteligentes, Security Plus, branding propio e informes semanales.',
          'Premium se activa con /activarpremium servidor:<ID> por el owner autorizado o manualmente en Supabase.'
        ] }
      ]
    },
    {
      title: 'Seguridad y abuso',
      classification: 'Trust and safety',
      summary: 'Capas anti-raid, anti-scam, blacklist y crisis.',
      blocks: [
        { type: 'list', items: [
          'Security Guard detecta flood, links sospechosos, alts, bots no deseados y patrones anti-nuke.',
          'Los links se analizan con IA cuando aparecen en mensajes; puede recomendar review, borrado o aislamiento.',
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
          ['Token Discord reseteado', 'Actualizar DISCORD_TOKEN en Pi y Render; reiniciar nexadesk.', 'Revisar logs de reconnect y evitar loops.'],
          ['Bot offline', 'systemctl restart nexadesk; revisar journalctl.', 'Verificar intents, token y conectividad.'],
          ['Render dashboard falla', 'Revisar env vars y logs de Render.', 'Confirmar RUN_BOT=false y token valido.'],
          ['Supabase missing column/table', 'Ejecutar supabase/schema.sql actualizado.', 'Verificar tablas y RLS si aplica.'],
          ['Groq sin creditos', 'Confirmar GROQ_FALLBACK_API_KEYS y AKIOMAE_API_KEY.', 'Reducir modelo o limits si hay costes.'],
          ['Leak de secreto', 'Rotar secreto inmediatamente.', 'Actualizar Pi, Render y revocar claves antiguas.']
        ] }
      ]
    },
    {
      title: 'Checklist privado de lanzamiento',
      classification: 'Launch',
      summary: 'Antes de vender o anunciar NexaDesk.',
      blocks: [
        { type: 'list', items: [
          'Render actualizado desde main y /health operativo.',
          'Pi activa con NexaDesk online y presencia actualizada.',
          'Supabase schema aplicado y transcripciones guardando.',
          'OAuth Discord con redirect correcto.',
          'DOCS_TOTP_SECRET configurado y probado desde Google Authenticator.',
          'No hay tokens ni service_role keys en commits, screenshots ni mensajes publicos.',
          'Probar un ticket normal, uno Ticket King, uno con imagen, uno de voz y uno de cierre con transcripcion.'
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

function renderDocsShell({ title, body, script = '' }) {
  const watermarkWords = Array.from({ length: 96 }, (_, index) => `<span>NEXADESK CONFIDENTIAL ${String(index + 1).padStart(2, '0')}</span>`).join('');
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
  </style>
</head>
<body>
  <div class="watermark-field" aria-hidden="true">${watermarkWords}</div>
  <div class="privacy-shield" id="privacyShield"><div><h2>Contenido oculto</h2><p>Vuelve a la pestana para restaurar la vista segura.</p></div></div>
  ${body}
  ${script}
</body>
</html>`;
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

function renderLogin(config) {
  const isReady = Boolean(config.DISCORD_CLIENT_SECRET);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Login</title>
  <link rel="icon" type="image/svg+xml" href="/assets/nexadesk-logo.svg">
  <link rel="apple-touch-icon" href="/assets/nexadesk-logo.svg">
  <style>
    :root { color-scheme: dark; --bg:#050505; --panel:#101010; --panel-2:#181818; --line:#343434; --text:#ffffff; --muted:#a8a8a8; --ink:#050505; --paper:#ffffff; --danger:#ff5f57; --ok:#ffffff; }
    * { box-sizing: border-box; }
    body { min-height:100vh; margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 16% 0%, rgba(255,255,255,.13), transparent 28%), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 72px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px), var(--bg); color:var(--text); overflow-x:hidden; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(180deg, transparent, rgba(5,8,10,.78)); }
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
    a.login-button { display:block; text-align:center; width:100%; border-radius:6px; background:#fff; color:#050505; padding:13px; font-weight:900; text-decoration:none; margin-top:22px; }
    .loading { position:fixed; inset:0; z-index:10; display:none; place-items:center; background:rgba(5,8,10,.88); backdrop-filter:blur(12px); }
    .loading.is-active { display:grid; }
    .loader { width:min(440px, calc(100% - 32px)); border:1px solid var(--line); background:#0b1216; border-radius:8px; padding:24px; text-align:center; }
    .pulse { width:48px; height:48px; margin:0 auto 18px; border-radius:50%; border:2px solid rgba(255,255,255,.18); border-top-color:#fff; animation:spin 1s linear infinite; }
    #loadingPhrase { color:var(--text); font-weight:800; margin:0; }
    .error { color:var(--danger); margin-top:14px; }
    @keyframes rise { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
    @keyframes bannerIn { from { opacity:0; transform:translateY(18px) scale(.985); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes bannerScan { 0%, 12% { transform:translateX(0) skewX(-18deg); opacity:0; } 30% { opacity:.85; } 58%, 100% { transform:translateX(430%) skewX(-18deg); opacity:0; } }
    @keyframes bannerGlow { 0%,100% { box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; } 50% { box-shadow:0 22px 90px rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.09) inset; } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion:reduce) { .banner-frame,.banner-frame::before,.banner-frame img { animation:none; transition:none; } }
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
  <div class="loading" id="loading">
    <div class="loader">
      <div class="pulse"></div>
      <p id="loadingPhrase">Preparando a tu agente de confianza</p>
    </div>
  </div>
  <main>
    <section class="intro">
      <div class="brand"><img class="brand-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk"><strong>NexaDesk</strong></div>
      <p class="eyebrow">AI ticket command center</p>
      <h1>Soporte de Discord que sabe cuando actuar y cuando escalar.</h1>
      <p>Gestiona paneles, categorias, prompts, transcripts y escalados de staff desde una consola limpia, conectada a Discord y lista para equipos reales.</p>
      <div class="feature-row">
        <div class="feature"><strong>Contexto vivo</strong><span>La IA lee la configuracion actual del servidor antes de responder.</span></div>
        <div class="feature"><strong>Escalado claro</strong><span>Cuando hace falta staff, NexaDesk menciona y avisa al rol correcto.</span></div>
        <div class="feature"><strong>Paneles propios</strong><span>Crea entradas de soporte sin depender de copiar IDs manualmente.</span></div>
      </div>
    </section>
    <aside class="login-card">
      <div class="banner-frame brand-banner-frame"><img src="/assets/nexadesk-banner.svg" alt="NexaDesk animated monochrome banner"></div>
      <p class="eyebrow">Acceso seguro</p>
      <h2>Entrar con Discord</h2>
      <p>Solo veras servidores donde tengas permisos de gestion.</p>
      <div class="status-line"><span>OAuth</span><strong>Discord</strong></div>
      <div class="status-line"><span>Datos</span><strong>Supabase</strong></div>
      <div class="status-line"><span>Realtime</span><strong>Activo</strong></div>
      ${isReady ? '<a class="login-button" id="loginButton" href="/auth/discord">Continuar con Discord</a>' : '<p class="error">Falta DISCORD_CLIENT_SECRET en el entorno.</p>'}
    </aside>
  </main>
  <script>
    const phrases = [
      'Preparando a tu agente de confianza',
      'Sincronizando servidores gestionables',
      'Cargando el centro de soporte',
      'Afinando el contexto de NexaDesk',
      'Conectando con Discord de forma segura'
    ];
    let phraseIndex = 0;
    const phrase = document.querySelector('#loadingPhrase');
    setInterval(() => {
      phraseIndex = (phraseIndex + 1) % phrases.length;
      if (phrase) phrase.textContent = phrases[phraseIndex];
    }, 1300);
    document.querySelector('#loginButton')?.addEventListener('click', () => {
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
    <p>Revisa variables de Supabase o ejecuta el schema si el error menciona tablas.</p>
    <a href="/logout" onclick="event.preventDefault(); document.querySelector('form').submit()">Cerrar sesion</a>
    <form method="post" action="/logout"></form>
  </main>
</body>
</html>`;
}

function renderDashboard({ session, guilds, tickets, stats }) {
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
    :root { color-scheme:dark; --bg:#050505; --panel:#101010; --panel-2:#181818; --line:#343434; --soft-line:rgba(255,255,255,.1); --text:#ffffff; --muted:#a8a8a8; --paper:#ffffff; --ink:#050505; --ok:#ffffff; --danger:#ff5f57; }
    * { box-sizing:border-box; }
    img,svg,video { max-width:100%; }
    html { scroll-behavior:smooth; }
    body { margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 10% 0%, rgba(255,255,255,.12), transparent 30%), repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0 1px, transparent 1px 72px), repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px), var(--bg); color:var(--text); }
    .app-shell { width:min(1440px, calc(100% - 40px)); margin:0 auto; display:grid; grid-template-columns:220px minmax(0,1fr); gap:22px; padding:22px 0 52px; }
    .sidebar { position:sticky; top:22px; height:calc(100vh - 44px); border:1px solid var(--line); border-radius:14px; background:rgba(7,16,20,.88); padding:16px; animation:rise .55s ease both; }
    main { min-width:0; animation:rise .55s ease .08s both; }
    .topbar { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; align-items:stretch; margin-bottom:16px; }
    header { border:1px solid var(--line); border-radius:16px; padding:24px; background:linear-gradient(135deg, rgba(24,24,24,.96), rgba(8,8,8,.82)); overflow:hidden; position:relative; }
    header::after { content:""; position:absolute; width:260px; height:260px; right:-120px; top:-140px; border-radius:50%; background:rgba(255,255,255,.1); filter:blur(10px); }
    h1,h2,h3 { margin:0; letter-spacing:0; }
    h1 { font-size:clamp(32px, 4.6vw, 58px); line-height:.96; max-width:760px; position:relative; z-index:1; }
    h2 { font-size:19px; margin-bottom:12px; }
    h3 { font-size:18px; }
    p { margin:8px 0 0; color:var(--muted); line-height:1.55; }
    .brand-lockup { display:flex; gap:14px; align-items:center; margin-bottom:22px; }
    .brand-logo { width:42px; height:42px; object-fit:cover; border-radius:11px; border:1px solid rgba(255,255,255,.55); box-shadow:0 0 38px rgba(255,255,255,.12); }
    .mark { display:grid; place-items:center; width:42px; height:42px; border:1px solid rgba(255,255,255,.55); background:#fff; color:#050505; border-radius:10px; font-weight:900; }
    .nav-brand { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
    .nav-link { display:block; color:var(--muted); text-decoration:none; border:1px solid transparent; border-radius:10px; padding:10px 11px; margin:4px 0; transition:color .22s ease, border-color .22s ease, background .22s ease, transform .22s ease; }
    .nav-link:hover,.nav-link.is-active { color:var(--text); border-color:rgba(255,255,255,.44); background:#0b1216; transform:translateX(3px); }
    .nav-foot { position:absolute; left:16px; right:16px; bottom:16px; }
    .hero-panel,.surface,.stat,.active-server { border:1px solid var(--line); border-radius:14px; background:rgba(11,18,22,.86); }
    .hero-panel { padding:18px; background:linear-gradient(180deg, rgba(24,24,24,.94), rgba(5,5,5,.94)); }
    .banner-frame { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:14px; background:#050505; box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; animation:bannerIn .8s cubic-bezier(.2,.8,.2,1) both, bannerGlow 4.8s ease-in-out infinite; }
    .banner-frame::before { content:""; position:absolute; inset:-40% auto -40% -35%; width:34%; z-index:2; pointer-events:none; background:linear-gradient(90deg, transparent, rgba(255,255,255,.34), transparent); filter:blur(10px); transform:skewX(-18deg); animation:bannerScan 5.4s ease-in-out infinite; }
    .banner-frame::after { content:""; position:absolute; inset:0; z-index:1; pointer-events:none; background:radial-gradient(circle at 25% 50%, rgba(255,255,255,.16), transparent 28%), linear-gradient(90deg, rgba(255,255,255,.06), transparent 24%, transparent 76%, rgba(255,255,255,.06)); mix-blend-mode:screen; opacity:.58; }
    .banner-frame img { position:relative; z-index:0; display:block; width:100%; background:#050505; transform:scale(1.006); filter:contrast(1.04) brightness(.96); transition:transform .7s cubic-bezier(.2,.8,.2,1), filter .7s ease; }
    .banner-frame:hover img { transform:scale(1.03); filter:contrast(1.12) brightness(1.08); }
    .dashboard-banner-frame { height:150px; margin-bottom:16px; }
    .dashboard-banner-frame img { height:100%; object-fit:cover; }
    .signal-list { display:grid; gap:10px; margin-top:16px; }
    .signal { display:flex; justify-content:space-between; gap:18px; padding:10px 0; border-bottom:1px solid var(--soft-line); color:var(--muted); }
    .signal strong { color:var(--text); }
    .view-stage { position:relative; min-height:520px; }
    .dashboard-view { display:none; animation:viewIn .34s cubic-bezier(.2,.8,.2,1) both; }
    .dashboard-view.is-active { display:block; }
    .is-hidden { display:none !important; }
    .view-heading { display:flex; align-items:end; justify-content:space-between; gap:16px; margin:0 0 14px; }
    .view-heading p { margin:4px 0 0; }
    .surface { padding:20px; animation:rise .55s ease both; transition:border-color .28s ease, transform .28s ease, box-shadow .28s ease; }
    .surface:hover { border-color:rgba(255,255,255,.22); box-shadow:0 24px 80px rgba(0,0,0,.24); }
    .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:16px; }
    .stat { padding:16px; background:linear-gradient(180deg,var(--panel-2),var(--panel)); }
    .stat strong { display:block; font-size:28px; }
    .stat small { display:block; margin-top:6px; }
    .stat span, label, th, dt, small { color:var(--muted); }
    .command-center { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:16px; }
    .insight-card { border:1px solid var(--line); border-radius:14px; padding:16px; background:linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); }
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
    .active-server { padding:18px; margin-bottom:16px; background:linear-gradient(135deg, rgba(255,255,255,.075), rgba(255,255,255,.025)); }
    .active-server select { margin-top:12px; }
    .server-status { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-top:12px; }
    .server-status div { border:1px solid var(--soft-line); border-radius:10px; padding:10px; background:rgba(5,8,10,.42); }
    .server-status strong { display:block; font-size:13px; margin-top:4px; }
    .server-score { display:grid; grid-template-columns:minmax(0,1fr) 220px auto; align-items:center; gap:12px; margin-top:12px; border:1px solid var(--soft-line); border-radius:14px; padding:14px; background:linear-gradient(135deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); }
    .server-score span { color:var(--muted); }
    .server-score strong { display:block; font-size:30px; line-height:1; margin:6px 0; }
    .server-score small { display:block; color:var(--muted); }
    .server-score .meter { margin:0; min-width:180px; }
    .server-score .quick-action { white-space:nowrap; justify-self:end; }
    .guild-list { display:grid; gap:8px; max-height:560px; overflow:auto; padding-right:4px; }
    .guild-pill { display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; border:1px solid var(--soft-line); background:#071014; color:var(--text); border-radius:12px; padding:12px; cursor:pointer; transition:transform .22s cubic-bezier(.2,.8,.2,1), border-color .22s ease, background .22s ease; }
    .guild-pill:hover { transform:translateX(3px); }
    .guild-pill:hover,.guild-pill.is-active { border-color:rgba(255,255,255,.72); background:rgba(255,255,255,.08); }
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
    .premium-grid { display:grid; grid-template-columns:minmax(320px,.92fr) minmax(0,1.08fr); gap:16px; align-items:start; }
    .premium-hero { min-height:100%; background:radial-gradient(circle at 20% 0%, rgba(255,255,255,.18), transparent 34%), linear-gradient(145deg, rgba(255,255,255,.12), rgba(255,255,255,.025)); }
    .premium-plan { display:inline-flex; align-items:center; gap:8px; border:1px solid rgba(255,255,255,.42); border-radius:999px; padding:7px 10px; color:#050505; background:#fff; font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .premium-hero h2 { margin-top:18px; font-size:clamp(28px, 4vw, 48px); line-height:.98; }
    .premium-lock { margin-top:16px; border:1px dashed rgba(255,255,255,.38); border-radius:14px; padding:14px; background:rgba(255,255,255,.045); }
    .premium-feature-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:16px; }
    .premium-feature { border:1px solid var(--soft-line); border-radius:13px; padding:12px; background:rgba(255,255,255,.045); transition:transform .22s ease, border-color .22s ease, background .22s ease; }
    .premium-feature:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.3); background:rgba(255,255,255,.075); }
    .premium-feature strong,.premium-feature span { display:block; }
    .premium-feature span { margin-top:5px; color:var(--muted); font-size:13px; line-height:1.45; }
    .premium-toggle-list { display:grid; grid-template-columns:1fr; gap:10px; }
    .premium-toggle { display:grid; grid-template-columns:minmax(0,1fr) 150px; gap:12px; align-items:center; border:1px solid var(--soft-line); border-radius:14px; padding:13px; background:rgba(255,255,255,.035); }
    .premium-toggle strong,.premium-toggle span { display:block; }
    .premium-toggle span { color:var(--muted); font-size:13px; margin-top:3px; line-height:1.45; }
    .premium-locked .premium-toggle select { opacity:.54; }
    .control-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .control-card { border:1px solid var(--line); border-radius:14px; padding:18px; background:linear-gradient(180deg, rgba(24,24,24,.94), rgba(8,8,8,.94)); transition:transform .28s cubic-bezier(.2,.8,.2,1), border-color .28s ease, box-shadow .28s ease; }
    .control-card:hover { transform:translateY(-2px); border-color:rgba(255,255,255,.26); box-shadow:0 24px 80px rgba(0,0,0,.28); }
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
    .discord-preview { border:1px solid var(--line); border-radius:16px; background:linear-gradient(180deg,#151515,#080808); padding:16px; box-shadow:0 28px 90px rgba(0,0,0,.32); overflow:hidden; }
    .preview-message { display:grid; grid-template-columns:42px minmax(0,1fr); gap:12px; align-items:start; }
    .preview-avatar { width:42px; height:42px; border-radius:50%; border:1px solid rgba(255,255,255,.36); background:#fff; color:#050505; display:grid; place-items:center; font-weight:900; }
    .preview-name { display:flex; gap:8px; align-items:center; margin-bottom:8px; font-weight:800; }
    .preview-badge { color:#050505; background:#fff; border-radius:5px; padding:2px 5px; font-size:10px; font-weight:900; }
    .embed-preview { border-left:4px solid var(--preview-color,#fff); border-radius:6px; background:#101010; padding:12px; max-width:520px; transition:border-color .22s ease, transform .22s ease; }
    .embed-author,.embed-footer { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .embed-title { color:#fff; font-weight:900; margin-top:6px; overflow-wrap:anywhere; }
    .embed-description { color:#d7d7d7; white-space:pre-wrap; overflow-wrap:anywhere; margin-top:6px; line-height:1.45; }
    .embed-media { display:grid; grid-template-columns:74px minmax(0,1fr); gap:10px; margin-top:10px; }
    .embed-thumb,.embed-image { border:1px solid var(--soft-line); border-radius:10px; background:rgba(255,255,255,.055); min-height:58px; display:grid; place-items:center; color:var(--muted); font-size:12px; overflow:hidden; }
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
    .loading { position:fixed; inset:0; z-index:60; display:grid; place-items:center; background:rgba(5,8,10,.9); backdrop-filter:blur(12px); transition:opacity .35s ease, visibility .35s ease; }
    .loading.is-hidden { opacity:0; visibility:hidden; }
    .loader { width:min(420px, calc(100% - 32px)); border:1px solid var(--line); background:#0b1216; border-radius:14px; padding:24px; text-align:center; }
    .pulse { width:46px; height:46px; margin:0 auto 16px; border-radius:50%; border:2px solid rgba(255,255,255,.18); border-top-color:#fff; animation:spin 1s linear infinite; }
    #loadingPhrase { color:var(--text); font-weight:800; }
    @keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
    @keyframes viewIn { from { opacity:0; transform:translateY(14px) scale(.992); filter:blur(4px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes bannerIn { from { opacity:0; transform:translateY(18px) scale(.985); filter:blur(10px); } to { opacity:1; transform:translateY(0) scale(1); filter:blur(0); } }
    @keyframes bannerScan { 0%, 12% { transform:translateX(0) skewX(-18deg); opacity:0; } 30% { opacity:.85; } 58%, 100% { transform:translateX(430%) skewX(-18deg); opacity:0; } }
    @keyframes bannerGlow { 0%,100% { box-shadow:0 22px 70px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.03) inset; } 50% { box-shadow:0 22px 90px rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.09) inset; } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion:reduce) { .banner-frame,.banner-frame::before,.banner-frame img { animation:none; transition:none; } }
    @media (max-width:1120px) { .app-shell,.workspace,.topbar,.command-center,.panel-builder,.premium-grid { grid-template-columns:1fr; } .sidebar { position:relative; height:auto; top:auto; } .nav-foot { position:static; margin-top:18px; } .panel-preview-wrap { position:relative; top:auto; } }
    @media (max-width:760px) {
      body { overflow-x:hidden; background-size:auto; }
      .app-shell { width:100%; gap:12px; padding:0 10px 96px; }
      .sidebar { position:sticky; top:0; z-index:40; height:auto; margin:0 -10px; padding:10px; display:flex; align-items:center; gap:8px; overflow-x:auto; border-radius:0 0 18px 18px; background:rgba(5,5,5,.92); backdrop-filter:blur(16px); }
      .nav-brand { flex:0 0 auto; margin:0 6px 0 0; }
      .nav-brand strong { display:none; }
      .brand-logo { width:36px; height:36px; border-radius:10px; }
      .nav-link { flex:0 0 auto; display:inline-flex; align-items:center; margin:0; padding:9px 11px; white-space:nowrap; font-size:14px; }
      .nav-link:hover,.nav-link.is-active { transform:none; }
      .nav-foot { flex:0 0 auto; position:static; margin:0 0 0 auto; }
      .nav-foot form { display:block; }
      .nav-foot button { width:max-content; margin:0; padding:9px 11px; white-space:nowrap; font-size:13px; }
      main { width:100%; }
      .dashboard-banner-frame { height:86px; margin-top:10px; }
      header,.hero-panel,.surface,.active-server,.control-card { padding:14px; border-radius:14px; }
      h1 { font-size:clamp(31px, 12vw, 44px); }
      h2 { font-size:18px; }
      p { font-size:14px; }
      .topbar,.workspace,.command-center,.panel-builder { gap:12px; margin-bottom:12px; }
      .view-heading,.section-heading,.ticket-tools,.transcript-head { display:grid; align-items:start; gap:10px; }
      .active-server { margin-bottom:12px; }
      form,.control-grid,.stats,.server-status,.server-score,.mini-grid,.panel-fields,.form-section,.readiness-checklist,.recommendation-grid,.premium-feature-grid,.premium-toggle { grid-template-columns:1fr; }
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
      .toast { left:12px; right:12px; bottom:82px; max-width:none; }
      .assistant-launcher { right:12px; bottom:12px; min-width:0; padding:11px 13px; }
      .assistant-panel { left:8px; right:8px; bottom:72px; width:auto; max-height:calc(100dvh - 86px); border-radius:16px; }
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
  <div class="loading" id="loading">
    <div class="loader">
      <div class="pulse"></div>
      <p id="loadingPhrase">Preparando a tu agente de confianza</p>
    </div>
  </div>
  <div class="app-shell">
  <aside class="sidebar">
    <div class="nav-brand"><img class="brand-logo" src="/assets/nexadesk-logo.svg" alt="NexaDesk"><strong>NexaDesk</strong></div>
    <a class="nav-link is-active" href="#overview" data-view="overview">Resumen</a>
    <a class="nav-link" href="#servers" data-view="servers">Servidores</a>
    <a class="nav-link" href="#settings" data-view="settings">Configuracion</a>
    <a class="nav-link" href="#components" data-view="components">Componentes</a>
    <a class="nav-link" href="#panels" data-view="panels">Paneles</a>
    <a class="nav-link" href="#premium" data-view="premium">Premium</a>
    <a class="nav-link" href="#tickets" data-view="tickets">Tickets</a>
    <div class="nav-foot">
      <form method="post" action="/logout"><button class="secondary-button" type="submit">Cerrar sesion</button></form>
    </div>
  </aside>
  <main>
    <div class="banner-frame dashboard-banner-frame"><img src="/assets/nexadesk-banner.svg" alt="NexaDesk animated monochrome banner"></div>
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
    <section class="active-server">
      <p class="kicker">Servidor activo</p>
      <select id="guildId" required>${guildOptions}</select>
      <div class="server-status">
        <div><span>Categoria</span><strong id="activeCategory">Sin configurar</strong></div>
        <div><span>Staff</span><strong id="activeStaff">Sin configurar</strong></div>
        <div><span>Paneles</span><strong id="activePanels">0</strong></div>
        <div><span>Seguridad</span><strong id="activeSecurity">Off</strong></div>
        <div><span>Premium</span><strong id="activePremium">Free</strong></div>
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
    <div class="view-stage">
      <section class="dashboard-view is-active" id="view-overview" data-view="overview">
        <div class="view-heading">
          <div><h2>Resumen</h2><p>Solo lo que importa: servidores listos, tickets, datos guardados y conversion premium.</p></div>
        </div>
        <div class="stats" id="overview">
          <div class="stat"><strong id="guildCount">${stats.totalGuilds}</strong><span>Servidores gestionables</span><small id="guildInstallMeta">${stats.installedGuilds ?? 0} con bot - ${stats.notInstalledGuilds ?? 0} por invitar</small></div>
          <div class="stat"><strong id="ticketCount">${stats.totalTickets}</strong><span>Tickets detectados</span><small>${stats.ticketsToday} hoy - ${stats.ticketsThisWeek} esta semana</small></div>
          <div class="stat"><strong id="openCount">${stats.openTickets}</strong><span>Tickets abiertos</span><small>${stats.closedTickets} cerrados o archivados</small></div>
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
            </div>
          </article>
        </section>
        <div class="quick-actions" aria-label="Acciones rapidas">
          <button class="quick-action" type="button" data-go-view="settings">Configurar IA y staff</button>
          <button class="quick-action" type="button" data-go-view="settings">Activar seguridad</button>
          <button class="quick-action" type="button" data-go-view="components">Crear menu de tickets</button>
          <button class="quick-action" type="button" data-go-view="panels">Publicar panel</button>
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
            <label>Categoria de tickets<select id="ticketCategoryId"></select></label>
            <label>Rol staff<select id="staffRoleId"></select></label>
            <textarea id="serverPrompt" placeholder="Prompt del servidor: personalidad, tono, limites, cuando escalar..."></textarea>
            <textarea id="serverInfo" placeholder="Reglas, FAQs, horarios, precios, enlaces y respuestas frecuentes..."></textarea>
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
        <article class="control-card wide">
          <div class="card-head"><span class="step">3</span><div><h2>Security Guard</h2><p>Activa proteccion anti-flood, anti-links IA, anti-alts, anti-bots y anti-nuke usando audit logs.</p></div></div>
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
            <label>Anti-links IA<select id="securityAntiScamLinks">
              <option value="true">Activo</option>
              <option value="false">Desactivado</option>
            </select></label>
            <label>Anti-bots<select id="securityAntiBot">
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
            <p class="notice span-2">Para anti-nuke completo, actualiza permisos del bot con View Audit Log, Manage Messages, Moderate Members, Kick Members y Ban Members.</p>
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
            <label>Nombre visible<input id="componentLabel" value="Soporte general" maxlength="100"></label>
            <label>Emoji<input id="componentEmoji" placeholder="Ej: &lt;a:Global:1499728413974593708&gt;"></label>
            <label class="span-2">Descripcion corta<input id="componentDescription" value="Abre un ticket de soporte general." maxlength="100"></label>
            <label class="span-2">Categoria destino<select id="componentTicketCategoryId"></select></label>
            <label>Tipo de ticket<select id="componentTicketMode">
              <option value="text">Texto + IA</option>
              <option value="voice">Voz Pro + STT/TTS</option>
            </select></label>
            <label class="span-2">Preguntas antes de crear el ticket<textarea id="componentQuestions" placeholder="Una pregunta por linea. Maximo 5.&#10;Ej: Cual es tu nick?&#10;Describe el problema"></textarea></label>
            <label class="span-2">Primer mensaje personalizado<textarea id="componentWelcomeMessage">Hola {user}, soy NexaDesk.
Antes de empezar, he guardado tus respuestas para que el staff tenga contexto.</textarea></label>
            <button class="span-2" type="submit">Crear componente</button>
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
                </select></label>
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
                <label class="span-2">Emoji del boton<input id="panelButtonEmoji" placeholder="Ej: &lt;a:Global:1499728413974593708&gt;"></label>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Embed</strong><span>Contenido visual del panel</span></div>
                <label>Titulo<input id="panelTitle" value="Centro de soporte"></label>
                <label>Color<input id="panelEmbedColor" type="color" value="#ffffff"></label>
                <label class="span-2">Autor<input id="panelAuthorName" placeholder="NexaDesk Support"></label>
                <label class="span-2">Icono del autor<input id="panelAuthorIconUrl" placeholder="https://..."></label>
                <textarea id="panelDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</textarea>
                <label>Thumbnail<input id="panelThumbnailUrl" placeholder="https://..."></label>
                <label>Imagen grande<input id="panelImageUrl" placeholder="https://..."></label>
                <label class="span-2">Footer<input id="panelFooterText" value="NexaDesk AI Support"></label>
              </div>
              <div class="form-section">
                <div class="section-label"><strong>Primer mensaje</strong><span>Usa {user} para mencionar al usuario</span></div>
                <textarea id="panelWelcomeMessage">Hola {user}, soy NexaDesk.
Cuentame que necesitas y te ayudare con este ticket. Si hace falta, avisare al staff con el contexto ordenado.</textarea>
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
      <section class="dashboard-view" id="view-premium" data-view="premium">
        <div class="view-heading">
          <div><h2>Premium</h2><p>Gestiona las funciones de alto valor por servidor. La activacion del plan se hace con /activarpremium o Supabase.</p></div>
        </div>
        <section class="premium-grid">
          <article class="control-card premium-hero" id="premiumHeroCard">
            <span class="premium-plan" id="premiumPlanBadge">Free</span>
            <h2 id="premiumHeroTitle">Convierte NexaDesk en un agente de pago.</h2>
            <p id="premiumHeroText">Premium desbloquea voz natural, IA mas proactiva, transcripciones accionables, seguridad reforzada, branding propio e informes para que el owner vea valor real.</p>
            <div class="premium-lock" id="premiumLockNotice">
              <strong>Plan no activo todavia</strong>
              <p>Activalo con <code>/activarpremium servidor:&lt;ID&gt;</code> o poniendo <code>plan = pro</code> / <code>voice_support_enabled = true</code> en Supabase. Las preferencias se pueden dejar preparadas.</p>
            </div>
            <div class="premium-feature-grid">
              <div class="premium-feature"><strong>Voz Pro</strong><span>Tickets con sala privada, STT/TTS y transcripcion en el canal.</span></div>
              <div class="premium-feature"><strong>IA prioritaria</strong><span>Respuestas mas proactivas, checklist de datos y escalados mejor resumidos.</span></div>
              <div class="premium-feature"><strong>Smart transcripts</strong><span>Resumen ejecutivo, puntos clave y descarga lista para staff.</span></div>
              <div class="premium-feature"><strong>Security Plus</strong><span>Anti-scam IA, senales de riesgo y alertas mas visibles para staff.</span></div>
              <div class="premium-feature"><strong>Branding propio</strong><span>Paneles y mensajes mas personalizables para comunidades serias.</span></div>
              <div class="premium-feature"><strong>Informes semanales</strong><span>Ideas de mejora: motivos frecuentes, volumen y necesidades de staff.</span></div>
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
              <button type="submit">Guardar modulos premium</button>
            </form>
          </article>
        </section>
      </section>
      <section class="dashboard-view" id="view-tickets" data-view="tickets">
        <div class="view-heading">
          <div><h2>Tickets</h2><p>Consulta actividad reciente y abre transcripciones guardadas.</p></div>
        </div>
    <section class="surface" id="tickets">
      <div class="ticket-tools">
        <div><h2>Tickets recientes</h2><p>Abre una transcripcion para revisar la conversacion guardada por servidor.</p></div>
      </div>
      ${ticketRows ? `<table><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th><th>Transcripcion</th></tr></thead><tbody id="ticketRows">${ticketRows}</tbody></table>` : '<div class="empty-state" id="emptyTickets"><strong>Aun no hay tickets detectados.</strong><span>Crea un panel o abre un ticket en una categoria configurada para ver actividad en tiempo real aqui.</span></div><table hidden><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th><th>Transcripcion</th></tr></thead><tbody id="ticketRows"></tbody></table>'}
      <aside class="transcript-viewer" id="transcriptViewer" hidden>
        <div class="transcript-head">
          <div><strong id="transcriptTitle">Transcripcion</strong><span id="transcriptMeta">Selecciona un ticket para cargar mensajes.</span></div>
          <div class="transcript-actions">
            <a class="transcript-download" id="downloadTranscript" href="#" download>Descargar TXT</a>
            <button class="secondary-button table-action" type="button" onclick="closeTranscript()">Cerrar</button>
          </div>
        </div>
        <div class="transcript-body" id="transcriptBody"></div>
      </aside>
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
      <button class="assistant-chip" type="button" data-assistant-prompt="Que funciones premium puedo activar aqui?">Premium</button>
      <button class="assistant-chip" type="button" data-assistant-prompt="Donde veo las transcripciones?">Transcripciones</button>
    </div>
    <form class="assistant-form" id="assistantForm">
      <input id="assistantInput" autocomplete="off" maxlength="900" placeholder="Pregunta: como configuro tickets?">
      <button type="submit">Enviar</button>
    </form>
  </section>
  <button class="assistant-launcher" id="assistantLauncher" type="button"><span>N</span> Ayuda IA</button>
  <script>
    const loadingPhrases = [
      'Preparando a tu agente de confianza',
      'Sincronizando roles y canales',
      'Ordenando tickets recientes',
      'Cargando contexto de tus servidores',
      'Activando el centro de soporte'
    ];
    let loadingPhraseIndex = 0;
    const loadingPhrase = document.querySelector('#loadingPhrase');
    const loadingTimer = setInterval(() => {
      loadingPhraseIndex = (loadingPhraseIndex + 1) % loadingPhrases.length;
      if (loadingPhrase) loadingPhrase.textContent = loadingPhrases[loadingPhraseIndex];
    }, 1200);
    window.addEventListener('load', () => {
      setTimeout(() => {
        clearInterval(loadingTimer);
        document.querySelector('#loading')?.classList.add('is-hidden');
      }, 550);
    });
    const state = {
      tickets: ${JSON.stringify(tickets)},
      stats: ${JSON.stringify(stats)},
      activeTranscriptChannelId: null,
      activeView: 'overview'
    };
    const guildConfigs = ${JSON.stringify(guilds)};
    let guildMeta = {};
    function setActiveView(view, { updateHash = true } = {}) {
      const nextView = document.querySelector('[data-view="' + view + '"].dashboard-view') ? view : 'overview';
      state.activeView = nextView;
      document.querySelectorAll('.dashboard-view').forEach((section) => {
        section.classList.toggle('is-active', section.dataset.view === nextView);
      });
      document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
        link.classList.toggle('is-active', link.dataset.view === nextView);
      });
      if (updateHash && location.hash !== '#' + nextView) {
        history.replaceState(null, '', '#' + nextView);
      }
    }
    function ticketRow(ticket) {
      return '<tr><td>#' + escapeHtml(ticket.channelName) + '</td><td>' + escapeHtml(ticket.guildName) + '</td><td>' + escapeHtml(ticket.status) + '</td><td>' + escapeHtml(new Date(ticket.createdAt).toLocaleString()) + '</td><td><button class="table-action secondary-button" type="button" data-transcript-channel="' + escapeHtml(ticket.channelId) + '">Ver</button></td></tr>';
    }
    function escapeHtml(value) {
      return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#039;');
    }
    function renderTickets() {
      document.querySelector('#ticketRows').innerHTML = state.tickets.length ? state.tickets.map(ticketRow).join('') : '<tr><td colspan="5">Aun no hay tickets detectados.</td></tr>';
      document.querySelector('#emptyTickets')?.remove();
      document.querySelector('#ticketRows')?.closest('table')?.removeAttribute('hidden');
      bindTranscriptButtons();
    }
    function bindTranscriptButtons() {
      document.querySelectorAll('[data-transcript-channel]').forEach((button) => {
        button.onclick = () => openTranscript(button.dataset.transcriptChannel);
      });
    }
    async function openTranscript(channelId) {
      const ticket = state.tickets.find((item) => item.channelId === channelId);
      state.activeTranscriptChannelId = channelId;
      document.querySelector('#transcriptViewer').hidden = false;
      document.querySelector('#transcriptTitle').textContent = ticket ? '#' + ticket.channelName : 'Transcripcion';
      document.querySelector('#transcriptMeta').textContent = ticket ? ticket.guildName + ' - ' + ticket.status : 'Cargando mensajes';
      document.querySelector('#downloadTranscript').href = '/api/tickets/' + channelId + '/transcript.txt';
      document.querySelector('#transcriptBody').innerHTML = '<p class="notice">Cargando transcripcion...</p>';
      try {
        const messages = await fetch('/api/tickets/' + channelId + '/transcript').then((response) => {
          if (!response.ok) throw new Error('No se pudo cargar la transcripcion.');
          return response.json();
        });
        renderTranscriptMessages(messages);
      } catch (error) {
        document.querySelector('#transcriptBody').innerHTML = '<p class="notice">' + escapeHtml(error.message) + '</p>';
      }
    }
    function closeTranscript() {
      state.activeTranscriptChannelId = null;
      document.querySelector('#transcriptViewer').hidden = true;
      document.querySelector('#transcriptBody').innerHTML = '';
    }
    function renderTranscriptMessages(messages) {
      document.querySelector('#transcriptMeta').textContent = messages.length + ' mensajes guardados';
      document.querySelector('#transcriptBody').innerHTML = messages.length
        ? messages.map((message) => '<article class="transcript-message ' + escapeHtml(message.role || '') + '"><div class="transcript-meta"><strong>' + escapeHtml(message.authorName || message.role || 'Desconocido') + '</strong><span>' + escapeHtml(new Date(message.createdAt).toLocaleString()) + '</span></div><div class="transcript-content">' + escapeHtml(message.content || '') + '</div></article>').join('')
        : '<p class="notice">Este ticket aun no tiene mensajes guardados.</p>';
    }
    function renderStats() {
      const stats = state.stats;
      const readinessGuilds = stats.installedGuilds || stats.totalGuilds;
      const health = readinessGuilds ? Math.round(((stats.configuredGuilds + stats.escalationReadyGuilds + stats.aiReadyGuilds + (stats.securityReadyGuilds || 0)) / (readinessGuilds * 4)) * 100) : 0;
      document.querySelector('#guildCount').textContent = stats.totalGuilds;
      document.querySelector('#guildInstallMeta').textContent = (stats.installedGuilds || 0) + ' con bot - ' + (stats.notInstalledGuilds || 0) + ' por invitar';
      document.querySelector('#ticketCount').textContent = stats.totalTickets;
      document.querySelector('#openCount').textContent = stats.openTickets;
      document.querySelector('#healthScore').textContent = health + '%';
      document.querySelector('.meter')?.style.setProperty('--value', health + '%');
      document.querySelector('#panelCount').textContent = stats.panels;
      document.querySelector('#aiReadyCount').textContent = stats.aiReadyGuilds;
      document.querySelector('#transcriptCount').textContent = stats.transcriptMessages;
      document.querySelector('#staffReadyCount').textContent = stats.escalationReadyGuilds;
      document.querySelector('#proGuildCount').textContent = stats.proGuilds || 0;
      document.querySelector('#securityReadyCount').textContent = stats.securityReadyGuilds || 0;
      document.querySelector('#voiceRoomCount').textContent = stats.voiceRooms || 0;
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
        renderGuildSelectors(activeGuildId);
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
        { key: 'staff', label: 'Rol staff', done: Boolean(guild.staffRoleId), view: 'settings' },
        { key: 'context', label: 'Contexto IA', done: Boolean(guild.serverPrompt || guild.serverInfo), view: 'settings' },
        { key: 'security', label: 'Security Guard', done: Boolean(guild.security?.enabled), view: 'settings' },
        { key: 'components', label: 'Componentes', done: Boolean(guild.components?.length), view: 'components' },
        { key: 'panels', label: 'Panel publicado', done: Boolean(guild.panels?.length), view: 'panels' }
      ];
    }
    function getGuildScore(guild = {}) {
      const weights = { installed:10, category:15, staff:15, context:20, security:15, components:10, panels:15 };
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
        weeklyInsights: raw.weeklyInsights !== false
      };
    }
    function formatPremiumState(guild = {}) {
      const premium = normalizePremium(guild);
      if (premium.entitled) return String(guild.plan || 'pro').toUpperCase();
      return 'Free';
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
        antiBot: raw.antiBot !== false,
        antiAlt: raw.antiAlt !== false,
        antiNuke: raw.antiNuke !== false
      };
    }
    function formatSecurityState(guild = {}) {
      const security = normalizeSecurity(guild);
      if (!security.enabled) return 'Off';
      const map = { low: 'Bajo', medium: 'Intermedio', high: 'Alto' };
      return map[security.level] || 'Activo';
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
        '<span>' + escapeHtml(item.label) + '</span>' +
        '</button>'
      )).join('');
      bindNavigationButtons(target);
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
        staff: { title: 'Asigna rol de staff', text: 'NexaDesk necesita saber a quien avisar cuando haya escalado humano o asistencia manual.', view: 'settings', action: 'Elegir staff' },
        context: { title: 'Dale contexto a la IA', text: 'Anade reglas, FAQ, tono, limites y si debe pedir pruebas visuales. Esto mejora mucho las respuestas.', view: 'settings', action: 'Escribir prompt' },
        security: { title: 'Activa Security Guard', text: 'Protege el servidor con anti-flood, anti-links IA, anti-bots, anti-alts y anti-nuke antes de abrirlo al publico.', view: 'settings', action: 'Configurar seguridad' },
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
      for (const selector of ['#ticketCategoryId', '#staffRoleId', '#serverPrompt', '#serverInfo', '#categoryName', '#securityEnabled', '#securityLevel', '#securityLogChannelId', '#securityMinAccountAgeDays', '#securityAntiFlood', '#securityAntiScamLinks', '#securityAntiBot', '#securityAntiAlt', '#securityAntiNuke', '#componentLabel', '#componentEmoji', '#componentDescription', '#componentTicketCategoryId', '#componentTicketMode', '#componentQuestions', '#componentWelcomeMessage', '#panelType', '#panelSelectPlaceholder', '#panelComponentIds', '#panelChannelId', '#panelTicketCategoryId', '#panelTicketMode', '#panelButtonLabel', '#panelButtonStyle', '#panelButtonEmoji', '#panelTitle', '#panelEmbedColor', '#panelAuthorName', '#panelAuthorIconUrl', '#panelDescription', '#panelThumbnailUrl', '#panelImageUrl', '#panelFooterText', '#panelWelcomeMessage', '#premiumVoiceSupport', '#premiumPriorityAi', '#premiumSmartTranscripts', '#premiumSecurityPlus', '#premiumCustomBranding', '#premiumWeeklyInsights']) {
        const element = document.querySelector(selector);
        if (element) element.disabled = disabled;
      }
      document.querySelectorAll('#settings button, #components button, #panels button, #view-premium button').forEach((button) => {
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
      document.querySelector('#staffRoleId').innerHTML = '<option>Instala NexaDesk para cargar roles</option>';
      document.querySelector('#securityLogChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#panelChannelId').innerHTML = '<option>Instala NexaDesk para cargar canales</option>';
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option>Instala NexaDesk para cargar categorias</option>';
      document.querySelector('#panelComponentIds').innerHTML = '<option>Crea componentes primero</option>';
      document.querySelector('#activeCategory').textContent = 'Bot no instalado';
      document.querySelector('#activeStaff').textContent = 'Bot no instalado';
      document.querySelector('#activePanels').textContent = String(guild.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(guild);
      document.querySelector('#activePremium').textContent = formatPremiumState(guild);
      renderComponentHistory(guild);
      renderPanelHistory(guild);
      renderPremiumPanel(guild);
      renderReadinessChecklist(guild);
      renderRecommendations(guild);
      document.querySelectorAll('.guild-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.guildId === guild.guildId));
    }
    function renderGuildLoadError(guildId, message) {
      const guild = getGuildConfig(guildId) || {};
      setConfigurationDisabled(true);
      document.querySelector('#installBanner').hidden = false;
      document.querySelector('#installTitle').textContent = 'Render necesita el token del bot.';
      document.querySelector('#installText').textContent = message;
      document.querySelector('#installLink').href = 'https://dashboard.render.com/';
      document.querySelector('#installLink').target = '_blank';
      document.querySelector('#installLink').textContent = 'Abrir Render';
      document.querySelector('#ticketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#staffRoleId').innerHTML = '<option>No se pudieron cargar roles</option>';
      document.querySelector('#securityLogChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#panelChannelId').innerHTML = '<option>No se pudieron cargar canales</option>';
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option>No se pudieron cargar categorias</option>';
      document.querySelector('#panelComponentIds').innerHTML = '<option>No se pudieron cargar componentes</option>';
      document.querySelector('#activeCategory').textContent = 'Token requerido';
      document.querySelector('#activeStaff').textContent = 'Token requerido';
      document.querySelector('#activePanels').textContent = String(guild.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(guild);
      document.querySelector('#activePremium').textContent = formatPremiumState(guild);
      renderComponentHistory(guild);
      renderPanelHistory(guild);
      renderPremiumPanel(guild);
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
      document.querySelector('#ticketCategoryId').innerHTML = '<option value="">Sin categoria</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#staffRoleId').innerHTML = '<option value="">Sin rol staff</option>' + meta.roles.map((role) => '<option value="' + role.id + '">' + escapeHtml(role.name) + '</option>').join('');
      document.querySelector('#componentTicketCategoryId').innerHTML = '<option value="">Usar categoria principal</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#panelChannelId').innerHTML = textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#panelTicketCategoryId').innerHTML = '<option value="">Usar categoria principal</option>' + categories.map((channel) => '<option value="' + channel.id + '">' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#securityLogChannelId').innerHTML = '<option value="">Sin canal de logs</option>' + textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#panelComponentIds').innerHTML = (config.components || []).length
        ? config.components.map((component) => '<option value="' + escapeHtml(component.id) + '">' + escapeHtml(component.label + (component.ticketMode === 'voice' ? ' - Voz Pro' : ' - Texto')) + '</option>').join('')
        : '<option value="">Crea componentes primero</option>';
      renderPanelComponentPicker(config);
      document.querySelector('#componentTicketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#panelTicketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#ticketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#staffRoleId').value = config.staffRoleId || '';
      document.querySelector('#ticketCategoryName').value = config.ticketCategoryName || selectedOptionText('#ticketCategoryId');
      document.querySelector('#serverPrompt').value = config.serverPrompt || '';
      document.querySelector('#serverInfo').value = config.serverInfo || '';
      const security = normalizeSecurity(config);
      document.querySelector('#securityEnabled').value = security.enabled ? 'true' : 'false';
      document.querySelector('#securityLevel').value = security.level;
      document.querySelector('#securityLogChannelId').value = security.logChannelId || '';
      document.querySelector('#securityMinAccountAgeDays').value = security.minAccountAgeDays;
      document.querySelector('#securityAntiFlood').value = security.antiFlood ? 'true' : 'false';
      document.querySelector('#securityAntiScamLinks').value = security.antiScamLinks ? 'true' : 'false';
      document.querySelector('#securityAntiBot').value = security.antiBot ? 'true' : 'false';
      document.querySelector('#securityAntiAlt').value = security.antiAlt ? 'true' : 'false';
      document.querySelector('#securityAntiNuke').value = security.antiNuke ? 'true' : 'false';
      document.querySelector('#activeCategory').textContent = config.ticketCategoryName || selectedOptionText('#ticketCategoryId') || 'Sin configurar';
      const staffOption = document.querySelector('#staffRoleId')?.selectedOptions?.[0];
      document.querySelector('#activeStaff').textContent = staffOption?.value ? staffOption.textContent : 'Sin configurar';
      document.querySelector('#activePanels').textContent = String(config.panels?.length ?? 0);
      document.querySelector('#activeSecurity').textContent = formatSecurityState(config);
      document.querySelector('#activePremium').textContent = formatPremiumState(config);
      renderComponentHistory(config);
      renderPanelHistory(config);
      renderPremiumPanel(config);
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
      for (const selector of ['#guildId', '#categoryGuildId', '#componentGuildId', '#panelGuildId', '#premiumGuildId']) {
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
    }
    async function saveConfig(event) {
      event.preventDefault();
      const guildId = document.querySelector('#guildId').value;
      const categoryName = selectedOptionText('#ticketCategoryId') || document.querySelector('#ticketCategoryName').value;
      const updated = await postJson('/api/guilds/' + guildId, {
        ticketCategoryId: document.querySelector('#ticketCategoryId').value,
        ticketCategoryName: categoryName,
        staffRoleId: document.querySelector('#staffRoleId').value,
        serverPrompt: document.querySelector('#serverPrompt').value,
        serverInfo: document.querySelector('#serverInfo').value
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
      const updated = await postJson('/api/guilds/' + guildId, {
        security: {
          enabled: document.querySelector('#securityEnabled').value === 'true',
          level: document.querySelector('#securityLevel').value,
          logChannelId: document.querySelector('#securityLogChannelId').value,
          logChannelName: selectedOptionText('#securityLogChannelId'),
          minAccountAgeDays: document.querySelector('#securityMinAccountAgeDays').value,
          antiFlood: document.querySelector('#securityAntiFlood').value === 'true',
          antiScamLinks: document.querySelector('#securityAntiScamLinks').value === 'true',
          antiBot: document.querySelector('#securityAntiBot').value === 'true',
          antiAlt: document.querySelector('#securityAntiAlt').value === 'true',
          antiNuke: document.querySelector('#securityAntiNuke').value === 'true'
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
          weeklyInsights: document.querySelector('#premiumWeeklyInsights').value === 'true'
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
    async function createCategory(event) {
      event.preventDefault();
      await postJson('/api/guilds/' + document.querySelector('#categoryGuildId').value + '/categories', { name: document.querySelector('#categoryName').value }).then(() => location.reload()).catch((error) => showToast(error.message));
      return false;
    }
    async function createComponent(event) {
      event.preventDefault();
      const guildId = document.querySelector('#componentGuildId').value;
      const updated = await postJson('/api/guilds/' + guildId + '/components', {
        label: document.querySelector('#componentLabel').value,
        description: document.querySelector('#componentDescription').value,
        emoji: document.querySelector('#componentEmoji').value,
        ticketCategoryId: document.querySelector('#componentTicketCategoryId').value,
        ticketCategoryName: selectedOptionText('#componentTicketCategoryId'),
        ticketMode: document.querySelector('#componentTicketMode').value,
        questions: document.querySelector('#componentQuestions').value.split(/\\n/).map((item) => item.trim()).filter(Boolean).slice(0, 5),
        welcomeMessage: document.querySelector('#componentWelcomeMessage').value
      }).catch((error) => showToast(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
        showToast('Componente creado. Ya puedes usarlo en un panel de menu.');
      }
      return false;
    }
    function renderComponentHistory(guild = {}) {
      const components = guild.components || [];
      const componentHistory = document.querySelector('#componentHistory');
      if (!componentHistory) return;
      componentHistory.innerHTML = components.length
        ? components.slice().reverse().map((component) => '<article class="panel-card"><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + (component.label || 'Componente sin nombre')) + '</strong><small>' + escapeHtml(component.description || 'Sin descripcion') + '</small><small>Modo: ' + escapeHtml(component.ticketMode === 'voice' ? 'Voz Pro + STT/TTS' : 'Texto + IA') + '</small><small>Categoria: ' + escapeHtml(component.ticketCategoryName || guild.ticketCategoryName || 'principal') + '</small><small>Preguntas: ' + escapeHtml(String((component.questions || []).length)) + '</small></article>').join('')
        : '<p class="notice">Aun no hay componentes. Crea uno para poder publicar paneles de menu.</p>';
    }
    function renderPanelHistory(guild = {}) {
      const panels = guild.panels || [];
      const panelHistory = document.querySelector('#panelHistory');
      if (!panelHistory) return;
      panelHistory.innerHTML = panels.length
        ? panels.slice().reverse().map((panel) => '<article class="panel-card"><strong>' + escapeHtml(panel.title || 'Panel sin titulo') + '</strong><small>Tipo: ' + escapeHtml(panel.panelType === 'menu' ? 'Menu desplegable' : 'Boton') + '</small><small>Modo boton: ' + escapeHtml(panel.ticketMode === 'voice' ? 'Voz Pro + STT/TTS' : 'Texto + IA') + '</small><small>Canal: ' + escapeHtml(panel.channelName || panel.channelId || 'sin canal') + '</small><small>Categoria: ' + escapeHtml(panel.ticketCategoryName || guild.ticketCategoryName || 'principal') + '</small><small>' + escapeHtml(panel.panelType === 'menu' ? ('Componentes: ' + (panel.componentIds || []).length) : ('Boton: ' + (panel.buttonLabel || 'Abrir ticket'))) + '</small><button class="secondary-button table-action" type="button" data-edit-panel="' + escapeHtml(panel.messageId || '') + '">Editar panel enviado</button></article>').join('')
        : '<p class="notice">Aun no hay paneles publicados en este servidor.</p>';
      bindPanelEditButtons(panelHistory);
    }
    function renderPremiumPanel(guild = getActiveGuild()) {
      const premium = normalizePremium(guild || {});
      const planLabel = premium.entitled ? String(guild?.plan || 'pro').toUpperCase() : 'FREE';
      document.querySelector('#premiumPlanBadge').textContent = planLabel;
      document.querySelector('#premiumHeroCard')?.classList.toggle('premium-locked', !premium.entitled);
      document.querySelector('#premiumSettingsCard')?.classList.toggle('premium-locked', !premium.entitled);
      document.querySelector('#premiumLockNotice')?.classList.toggle('is-hidden', premium.entitled);
      document.querySelector('#premiumHeroTitle').textContent = premium.entitled
        ? 'Premium activo en este servidor.'
        : 'Prepara el upgrade antes de venderlo.';
      document.querySelector('#premiumHeroText').textContent = premium.entitled
        ? 'Configura que modulos quieres dejar activos: voz, IA prioritaria, smart transcripts, seguridad avanzada, branding e informes.'
        : 'Puedes dejar estos modulos preparados. Cuando el owner active Premium, NexaDesk desbloqueara las funciones de mayor valor sin rehacer la configuracion.';
      const values = {
        premiumVoiceSupport: premium.voiceSupport,
        premiumPriorityAi: premium.priorityAi,
        premiumSmartTranscripts: premium.smartTranscripts,
        premiumSecurityPlus: premium.securityPlus,
        premiumCustomBranding: premium.customBranding,
        premiumWeeklyInsights: premium.weeklyInsights
      };
      for (const [id, value] of Object.entries(values)) {
        const element = document.querySelector('#' + id);
        if (element) element.value = value ? 'true' : 'false';
      }
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
          '<span><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + component.label) + '</strong><small>' + escapeHtml((component.ticketMode === 'voice' ? 'Voz Pro' : 'Texto') + ' - ' + (component.questions || []).length + ' preguntas') + '</small></span>' +
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
    }
    function updatePanelMode() {
      const panelType = document.querySelector('#panelType')?.value || 'button';
      document.querySelector('#panelMenuComponentsSection')?.classList.toggle('is-hidden', panelType !== 'menu');
      document.querySelector('#panelSelectPlaceholderWrap')?.classList.toggle('is-hidden', panelType !== 'menu');
      document.querySelector('#panelTicketModeWrap')?.classList.toggle('is-hidden', panelType === 'menu');
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
        clearPanelComponents();
      }
      updatePanelPreview();
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
      document.querySelector('#previewThumbnail').textContent = thumbnail ? 'Thumbnail cargada' : 'Thumbnail opcional';
      document.querySelector('#previewImage').textContent = image ? 'Imagen cargada' : 'Imagen opcional';
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
          ? components.map((component) => '<div class="menu-option-preview"><strong>' + escapeHtml((component.emoji ? component.emoji + ' ' : '') + component.label) + '</strong><small>' + escapeHtml(component.description || 'Sin descripcion') + '</small><div class="question-preview">' + escapeHtml(component.ticketMode === 'voice' ? 'Voz Pro + STT/TTS' : 'Texto + IA') + ' - ' + escapeHtml(String((component.questions || []).length)) + ' preguntas previas</div></div>').join('')
          : '<div class="menu-option-preview"><small>Selecciona componentes para previsualizar el menu.</small></div>';
      }
    }
    async function createPanel(event) {
      event.preventDefault();
      const guildId = document.querySelector('#panelGuildId').value;
      const editingMessageId = document.querySelector('#editingPanelMessageId').value;
      const componentIds = [...document.querySelector('#panelComponentIds').selectedOptions].map((option) => option.value).filter(Boolean);
      if (document.querySelector('#panelType').value === 'menu' && componentIds.length < 2) {
        showToast('Para un panel de menu, selecciona al menos 2 componentes.');
        return false;
      }

      const payload = {
        channelId: document.querySelector('#panelChannelId').value,
        channelName: selectedOptionText('#panelChannelId'),
        panelType: document.querySelector('#panelType').value,
        ticketCategoryId: document.querySelector('#panelTicketCategoryId').value,
        ticketCategoryName: selectedOptionText('#panelTicketCategoryId'),
        ticketMode: document.querySelector('#panelTicketMode').value,
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
      if (state.activeTranscriptChannelId) openTranscript(state.activeTranscriptChannelId).catch(() => {});
    });
    source.onerror = () => {
      document.querySelector('#liveState').textContent = 'Reconectando';
      document.querySelector('#liveState').className = '';
    };
    for (const selector of ['#guildId', '#categoryGuildId', '#componentGuildId', '#panelGuildId', '#premiumGuildId']) {
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
    });
    for (const selector of ['#panelType', '#panelSelectPlaceholder', '#panelComponentIds', '#panelTicketMode', '#panelTitle', '#panelDescription', '#panelButtonLabel', '#panelButtonStyle', '#panelButtonEmoji', '#panelEmbedColor', '#panelAuthorName', '#panelThumbnailUrl', '#panelImageUrl', '#panelFooterText']) {
      document.querySelector(selector)?.addEventListener('input', updatePanelPreview);
      document.querySelector(selector)?.addEventListener('change', updatePanelPreview);
    }
    bindTranscriptButtons();
    updatePanelPreview();
    renderPremiumPanel(getActiveGuild());
    renderReadinessChecklist(getActiveGuild());
    renderRecommendations(getActiveGuild());
    setActiveView((location.hash || '#overview').slice(1), { updateHash: false });
    syncGuildForm('#guildId', { inviteIfMissing: false });
  </script>
</body>
</html>`;
}

function renderTicketRow(ticket) {
  return `<tr><td>#${escapeHtml(ticket.channelName)}</td><td>${escapeHtml(ticket.guildName)}</td><td>${escapeHtml(ticket.status)}</td><td>${escapeHtml(new Date(ticket.createdAt).toLocaleString())}</td><td><button class="table-action secondary-button" type="button" data-transcript-channel="${escapeHtml(ticket.channelId)}">Ver</button></td></tr>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
