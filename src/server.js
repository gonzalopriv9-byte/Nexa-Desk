import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

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
    res.json(mergeUserGuilds(req.session, configs));
  }));

  app.get('/api/tickets', asyncHandler(async (req, res) => {
    const tickets = await storage.listTickets();
    res.json(tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)));
  }));

  app.get('/api/stats', asyncHandler(async (req, res) => {
    res.json(await storage.getDashboardStats(req.session.guilds.map((guild) => guild.id)));
  }));

  app.get('/api/tickets/:channelId/transcript', asyncHandler(async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId);
    if (!ticket || !canAccessGuild(req.session, ticket.guildId)) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    res.json(await storage.listTranscriptMessages(req.params.channelId));
  }));

  app.get('/api/guilds/:guildId/roles', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildRoles({ guildId: req.params.guildId }));
  }));

  app.get('/api/guilds/:guildId/channels', requireGuildAccess, asyncHandler(async (req, res) => {
    res.json(await bot.listGuildChannels({ guildId: req.params.guildId }));
  }));

  app.post('/api/guilds/:guildId', requireGuildAccess, asyncHandler(async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: req.body.guildName || guild?.name,
      ticketCategoryId: req.body.ticketCategoryId,
      ticketCategoryName: req.body.ticketCategoryName,
      staffRoleId: req.body.staffRoleId,
      serverPrompt: req.body.serverPrompt,
      serverInfo: req.body.serverInfo
    });
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

  app.post('/api/guilds/:guildId/panels', requireGuildAccess, asyncHandler(async (req, res) => {
    try {
      const updated = await bot.createTicketPanel({
        guildId: req.params.guildId,
        channelId: req.body.channelId,
        title: req.body.title || 'Soporte',
        description: req.body.description || 'Pulsa el boton para abrir un ticket.',
        buttonLabel: req.body.buttonLabel || 'Abrir ticket'
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
    res.type('html').send(renderDashboard({
      session: req.session,
      guilds: mergeUserGuilds(req.session, configs),
      tickets: tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)),
      stats
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
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
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

function mergeUserGuilds(session, configs) {
  return session.guilds.map((guild) => {
    const config = configs.find((item) => item.guildId === guild.id);
    return {
      ...config,
      guildId: guild.id,
      guildName: config?.guildName ?? guild.name,
      icon: guild.icon,
      connected: Boolean(config)
    };
  });
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
  const value = req.signedCookies?.nexadesk_session;
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
    .brand-banner { width:100%; border:1px solid var(--line); border-radius:10px; margin-bottom:18px; display:block; background:#050505; }
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
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:860px) { main { grid-template-columns:1fr; align-items:start; padding-top:28px; } .feature-row { grid-template-columns:1fr; } }
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
      <img class="brand-banner" src="/assets/nexadesk-banner.svg" alt="NexaDesk animated monochrome banner">
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
    .map((guild) => `<option value="${escapeHtml(guild.guildId)}">${escapeHtml(guild.guildName ?? guild.guildId)}</option>`)
    .join('');

  const guildList = guilds
    .map((guild) => `
      <button class="guild-pill" type="button" data-guild-id="${escapeHtml(guild.guildId)}">
        <span>
          <strong>${escapeHtml(guild.guildName ?? guild.guildId)}</strong>
          <small>${guild.connected ? 'Configurado' : 'Disponible'} - ${escapeHtml(String(guild.panels?.length ?? 0))} paneles</small>
        </span>
        <i>${guild.ticketCategoryName ? 'Listo' : 'Pendiente'}</i>
      </button>
    `)
    .join('');

  const ticketRows = tickets
    .map((ticket) => renderTicketRow(ticket))
    .join('');

  const healthScore = stats.totalGuilds
    ? Math.round(((stats.configuredGuilds + stats.escalationReadyGuilds + stats.aiReadyGuilds) / (stats.totalGuilds * 3)) * 100)
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
    .nav-link { display:block; color:var(--muted); text-decoration:none; border:1px solid transparent; border-radius:10px; padding:10px 11px; margin:4px 0; }
    .nav-link:hover { color:var(--text); border-color:var(--line); background:#0b1216; }
    .nav-foot { position:absolute; left:16px; right:16px; bottom:16px; }
    .hero-panel,.surface,.stat,.active-server { border:1px solid var(--line); border-radius:14px; background:rgba(11,18,22,.86); }
    .hero-panel { padding:18px; background:linear-gradient(180deg, rgba(24,24,24,.94), rgba(5,5,5,.94)); }
    .dashboard-banner { width:100%; height:150px; object-fit:cover; border:1px solid var(--line); border-radius:14px; background:#050505; margin-bottom:16px; }
    .signal-list { display:grid; gap:10px; margin-top:16px; }
    .signal { display:flex; justify-content:space-between; gap:18px; padding:10px 0; border-bottom:1px solid var(--soft-line); color:var(--muted); }
    .signal strong { color:var(--text); }
    .surface { padding:20px; animation:rise .55s ease both; }
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
    .section-heading { display:flex; align-items:end; justify-content:space-between; gap:16px; margin:6px 0 14px; }
    .section-heading p { margin:4px 0 0; }
    .active-server { padding:18px; margin-bottom:16px; background:linear-gradient(135deg, rgba(255,255,255,.075), rgba(255,255,255,.025)); }
    .active-server select { margin-top:12px; }
    .server-status { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-top:12px; }
    .server-status div { border:1px solid var(--soft-line); border-radius:10px; padding:10px; background:rgba(5,8,10,.42); }
    .server-status strong { display:block; font-size:13px; margin-top:4px; }
    .guild-list { display:grid; gap:8px; max-height:560px; overflow:auto; padding-right:4px; }
    .guild-pill { display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; border:1px solid var(--soft-line); background:#071014; color:var(--text); border-radius:12px; padding:12px; cursor:pointer; }
    .guild-pill:hover,.guild-pill.is-active { border-color:rgba(255,255,255,.72); background:rgba(255,255,255,.08); }
    .guild-pill strong,.guild-pill small { display:block; }
    .guild-pill i { color:#fff; font-style:normal; font-size:12px; }
    .control-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .control-card { border:1px solid var(--line); border-radius:14px; padding:18px; background:linear-gradient(180deg, rgba(24,24,24,.94), rgba(8,8,8,.94)); }
    .control-card.wide { grid-column:1 / -1; }
    .card-head { display:flex; gap:12px; align-items:flex-start; margin-bottom:14px; }
    .step { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; color:#050505; background:#fff; font-weight:900; flex:0 0 auto; }
    form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    label { display:grid; gap:6px; font-size:14px; }
    input,select,textarea,button { width:100%; border-radius:10px; border:1px solid var(--line); background:#080808; color:var(--text); padding:11px 12px; font:inherit; }
    textarea { min-height:140px; resize:vertical; grid-column:1 / -1; }
    .span-2 { grid-column:1 / -1; }
    button { background:#fff; color:#050505; border:0; font-weight:900; cursor:pointer; }
    .secondary-button { background:#0a0a0a; color:var(--text); border:1px solid var(--line); }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; padding:12px; border-bottom:1px solid var(--line); }
    .kicker { color:#fff; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .notice,.empty-state { border:1px dashed rgba(255,255,255,.38); border-radius:12px; padding:16px; color:var(--muted); background:rgba(255,255,255,.045); }
    .empty-state strong { color:var(--text); display:block; margin-bottom:5px; }
    .live { color:var(--ok); }
    .loading { position:fixed; inset:0; z-index:20; display:grid; place-items:center; background:rgba(5,8,10,.9); backdrop-filter:blur(12px); transition:opacity .35s ease, visibility .35s ease; }
    .loading.is-hidden { opacity:0; visibility:hidden; }
    .loader { width:min(420px, calc(100% - 32px)); border:1px solid var(--line); background:#0b1216; border-radius:14px; padding:24px; text-align:center; }
    .pulse { width:46px; height:46px; margin:0 auto 16px; border-radius:50%; border:2px solid rgba(255,255,255,.18); border-top-color:#fff; animation:spin 1s linear infinite; }
    #loadingPhrase { color:var(--text); font-weight:800; }
    @keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (max-width:1120px) { .app-shell,.workspace,.topbar,.command-center { grid-template-columns:1fr; } .sidebar { position:relative; height:auto; top:auto; } .nav-foot { position:static; margin-top:18px; } }
    @media (max-width:760px) { form,.control-grid,.stats,.server-status,.mini-grid { grid-template-columns:1fr; } label,button { margin-top:12px; } .app-shell { width:min(100% - 24px, 1440px); } }
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
    <a class="nav-link" href="#overview">Resumen</a>
    <a class="nav-link" href="#servers">Servidores</a>
    <a class="nav-link" href="#settings">Configuracion</a>
    <a class="nav-link" href="#tickets">Tickets</a>
    <div class="nav-foot">
      <form method="post" action="/logout"><button class="secondary-button" type="submit">Cerrar sesion</button></form>
    </div>
  </aside>
  <main>
    <img class="dashboard-banner" src="/assets/nexadesk-banner.svg" alt="NexaDesk animated monochrome banner">
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
    <div class="stats" id="overview">
      <div class="stat"><strong id="guildCount">${stats.totalGuilds}</strong><span>Servidores disponibles</span><small>${stats.configuredGuilds} configurados - ${stats.unconfiguredGuilds} pendientes</small></div>
      <div class="stat"><strong id="ticketCount">${stats.totalTickets}</strong><span>Tickets detectados</span><small>${stats.ticketsToday} hoy - ${stats.ticketsThisWeek} esta semana</small></div>
      <div class="stat"><strong id="openCount">${stats.openTickets}</strong><span>Tickets abiertos</span><small>${stats.closedTickets} cerrados o archivados</small></div>
    </div>
    <section class="command-center">
      <article class="insight-card">
        <p class="kicker">Salud global</p>
        <strong id="healthScore">${healthScore}%</strong>
        <p>Promedio de servidores con categoria, staff y contexto IA configurados.</p>
        <div class="meter" style="--value:${healthScore}%"><span></span></div>
      </article>
      <article class="insight-card">
        <p class="kicker">Automatizacion</p>
        <div class="mini-grid">
          <div><strong id="panelCount">${stats.panels}</strong><small>Paneles publicados</small></div>
          <div><strong id="aiReadyCount">${stats.aiReadyGuilds}</strong><small>Servidores con IA lista</small></div>
        </div>
      </article>
      <article class="insight-card">
        <p class="kicker">Actividad</p>
        <div class="mini-grid">
          <div><strong id="transcriptCount">${stats.transcriptMessages}</strong><small>Mensajes guardados</small></div>
          <div><strong id="staffReadyCount">${stats.escalationReadyGuilds}</strong><small>Escalado con staff</small></div>
        </div>
      </article>
    </section>
    <div class="section-heading">
      <div><h2>Configura tu servidor</h2><p>Un flujo claro: servidor activo, IA, staff y paneles.</p></div>
    </div>
    <section class="active-server">
      <p class="kicker">Servidor activo</p>
      <select id="guildId" required>${guildOptions}</select>
      <div class="server-status">
        <div><span>Categoria</span><strong id="activeCategory">Sin configurar</strong></div>
        <div><span>Staff</span><strong id="activeStaff">Sin configurar</strong></div>
        <div><span>Paneles</span><strong id="activePanels">0</strong></div>
      </div>
    </section>
    <div class="workspace">
      <section class="surface" id="servers">
        <h2>Servidores</h2>
        <p>Selecciona uno para editarlo. Solo aparecen servidores donde tienes permisos.</p>
        <div class="guild-list" id="guildGrid">${guildList || '<p class="notice">No tienes servidores gestionables.</p>'}</div>
      </section>
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
        <article class="control-card">
          <div class="card-head"><span class="step">3</span><div><h2>Panel de soporte</h2><p>Publica el boton que abre tickets en el canal elegido.</p></div></div>
          <form onsubmit="return createPanel(event)">
            <select id="panelGuildId" hidden required>${guildOptions}</select>
            <label>Canal del panel<select id="panelChannelId" required></select></label>
            <label>Boton<input id="panelButtonLabel" value="Abrir ticket"></label>
            <label class="span-2">Titulo<input id="panelTitle" value="Centro de soporte"></label>
            <textarea id="panelDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</textarea>
            <button class="span-2" type="submit">Publicar panel</button>
          </form>
        </article>
      </section>
    </div>
    <section class="surface" id="tickets">
      <h2>Tickets recientes</h2>
      ${ticketRows ? `<table><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th></tr></thead><tbody id="ticketRows">${ticketRows}</tbody></table>` : '<div class="empty-state" id="emptyTickets"><strong>Aun no hay tickets detectados.</strong><span>Crea un panel o abre un ticket en una categoria configurada para ver actividad en tiempo real aqui.</span></div><table hidden><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th></tr></thead><tbody id="ticketRows"></tbody></table>'}
    </section>
  </main>
  </div>
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
      stats: ${JSON.stringify(stats)}
    };
    const guildConfigs = ${JSON.stringify(guilds)};
    let guildMeta = {};
    function ticketRow(ticket) {
      return '<tr><td>#' + escapeHtml(ticket.channelName) + '</td><td>' + escapeHtml(ticket.guildName) + '</td><td>' + escapeHtml(ticket.status) + '</td><td>' + escapeHtml(new Date(ticket.createdAt).toLocaleString()) + '</td></tr>';
    }
    function escapeHtml(value) {
      return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#039;');
    }
    function renderTickets() {
      document.querySelector('#ticketRows').innerHTML = state.tickets.length ? state.tickets.map(ticketRow).join('') : '<tr><td colspan="4">Aun no hay tickets detectados.</td></tr>';
      document.querySelector('#emptyTickets')?.remove();
      document.querySelector('#ticketRows')?.closest('table')?.removeAttribute('hidden');
    }
    function renderStats() {
      const stats = state.stats;
      const health = stats.totalGuilds ? Math.round(((stats.configuredGuilds + stats.escalationReadyGuilds + stats.aiReadyGuilds) / (stats.totalGuilds * 3)) * 100) : 0;
      document.querySelector('#guildCount').textContent = stats.totalGuilds;
      document.querySelector('#ticketCount').textContent = stats.totalTickets;
      document.querySelector('#openCount').textContent = stats.openTickets;
      document.querySelector('#healthScore').textContent = health + '%';
      document.querySelector('.meter')?.style.setProperty('--value', health + '%');
      document.querySelector('#panelCount').textContent = stats.panels;
      document.querySelector('#aiReadyCount').textContent = stats.aiReadyGuilds;
      document.querySelector('#transcriptCount').textContent = stats.transcriptMessages;
      document.querySelector('#staffReadyCount').textContent = stats.escalationReadyGuilds;
    }
    async function refreshStats() {
      state.stats = await fetch('/api/stats').then((response) => response.json());
      renderStats();
    }
    async function postJson(url, body) {
      const response = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
      return response.json();
    }
    async function loadGuildMeta(guildId) {
      if (!guildId) return;
      const [roles, channels] = await Promise.all([
        fetch('/api/guilds/' + guildId + '/roles').then((response) => response.json()),
        fetch('/api/guilds/' + guildId + '/channels').then((response) => response.json())
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
      document.querySelector('#panelChannelId').innerHTML = textChannels.map((channel) => '<option value="' + channel.id + '">#' + escapeHtml(channel.name) + '</option>').join('');
      document.querySelector('#ticketCategoryId').value = config.ticketCategoryId || '';
      document.querySelector('#staffRoleId').value = config.staffRoleId || '';
      document.querySelector('#ticketCategoryName').value = config.ticketCategoryName || selectedOptionText('#ticketCategoryId');
      document.querySelector('#serverPrompt').value = config.serverPrompt || '';
      document.querySelector('#serverInfo').value = config.serverInfo || '';
      document.querySelector('#activeCategory').textContent = config.ticketCategoryName || selectedOptionText('#ticketCategoryId') || 'Sin configurar';
      const staffOption = document.querySelector('#staffRoleId')?.selectedOptions?.[0];
      document.querySelector('#activeStaff').textContent = staffOption?.value ? staffOption.textContent : 'Sin configurar';
      document.querySelector('#activePanels').textContent = String(config.panels?.length ?? 0);
      document.querySelectorAll('.guild-pill').forEach((button) => button.classList.toggle('is-active', button.dataset.guildId === guildId));
    }
    function selectedOptionText(selector) {
      const option = document.querySelector(selector)?.selectedOptions?.[0];
      return option && option.value ? option.textContent : '';
    }
    function syncGuildForm(sourceId) {
      const guildId = document.querySelector(sourceId).value;
      for (const selector of ['#guildId', '#categoryGuildId', '#panelGuildId']) {
        const element = document.querySelector(selector);
        if (element && element.value !== guildId) element.value = guildId;
      }
      loadGuildMeta(guildId).catch((error) => alert(error.message));
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
      }).catch((error) => alert(error.message));
      if (updated) {
        const index = guildConfigs.findIndex((guild) => guild.guildId === guildId);
        if (index >= 0) guildConfigs[index] = { ...guildConfigs[index], ...updated };
        renderGuildSelectors(guildId);
      }
      return false;
    }
    async function createCategory(event) {
      event.preventDefault();
      await postJson('/api/guilds/' + document.querySelector('#categoryGuildId').value + '/categories', { name: document.querySelector('#categoryName').value }).then(() => location.reload()).catch((error) => alert(error.message));
      return false;
    }
    async function createPanel(event) {
      event.preventDefault();
      await postJson('/api/guilds/' + document.querySelector('#panelGuildId').value + '/panels', {
        channelId: document.querySelector('#panelChannelId').value,
        title: document.querySelector('#panelTitle').value,
        description: document.querySelector('#panelDescription').value,
        buttonLabel: document.querySelector('#panelButtonLabel').value
      }).then(() => location.reload()).catch((error) => alert(error.message));
      return false;
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
    source.addEventListener('guild.updated', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshStats().catch(() => {});
    });
    source.addEventListener('transcript.message', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
      refreshStats().catch(() => {});
    });
    source.onerror = () => {
      document.querySelector('#liveState').textContent = 'Reconectando';
      document.querySelector('#liveState').className = '';
    };
    for (const selector of ['#guildId', '#categoryGuildId', '#panelGuildId']) {
      document.querySelector(selector)?.addEventListener('change', () => syncGuildForm(selector));
    }
    document.querySelectorAll('.guild-pill').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelector('#guildId').value = button.dataset.guildId;
        syncGuildForm('#guildId');
      });
    });
    document.querySelector('#ticketCategoryId')?.addEventListener('change', () => {
      document.querySelector('#ticketCategoryName').value = selectedOptionText('#ticketCategoryId');
    });
    syncGuildForm('#guildId');
  </script>
</body>
</html>`;
}

function renderTicketRow(ticket) {
  return `<tr><td>#${escapeHtml(ticket.channelName)}</td><td>${escapeHtml(ticket.guildName)}</td><td>${escapeHtml(ticket.status)}</td><td>${escapeHtml(new Date(ticket.createdAt).toLocaleString())}</td></tr>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
