import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

export function createServer({ config, storage, bot, events }) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('tiny'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(config.SESSION_SECRET));

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

  app.get('/auth/discord/callback', async (req, res) => {
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
  });

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

  app.get('/api/guilds', async (req, res) => {
    const configs = await storage.listGuildConfigs();
    res.json(mergeUserGuilds(req.session, configs));
  });

  app.get('/api/tickets', async (req, res) => {
    const tickets = await storage.listTickets();
    res.json(tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId)));
  });

  app.get('/api/tickets/:channelId/transcript', async (req, res) => {
    const ticket = await storage.getTicket(req.params.channelId);
    if (!ticket || !canAccessGuild(req.session, ticket.guildId)) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    res.json(await storage.listTranscriptMessages(req.params.channelId));
  });

  app.post('/api/guilds/:guildId', requireGuildAccess, async (req, res) => {
    const guild = req.session.guilds.find((item) => item.id === req.params.guildId);
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: req.body.guildName || guild?.name,
      ticketCategoryId: req.body.ticketCategoryId,
      ticketCategoryName: req.body.ticketCategoryName,
      serverInfo: req.body.serverInfo
    });
    res.json(updated);
  });

  app.post('/api/guilds/:guildId/categories', requireGuildAccess, async (req, res) => {
    try {
      const updated = await bot.createTicketCategory({
        guildId: req.params.guildId,
        name: req.body.name || 'NexaDesk Tickets'
      });
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/guilds/:guildId/panels', requireGuildAccess, async (req, res) => {
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
  });

  app.get('/', async (req, res) => {
    const [configs, tickets] = await Promise.all([
      storage.listGuildConfigs(),
      storage.listTickets()
    ]);
    res.type('html').send(renderDashboard({
      session: req.session,
      guilds: mergeUserGuilds(req.session, configs),
      tickets: tickets.filter((ticket) => canAccessGuild(req.session, ticket.guildId))
    }));
  });

  return app;
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
  <style>
    :root { color-scheme: dark; --bg:#05080a; --line:#20323a; --text:#f2fbfc; --muted:#8ea3aa; --cyan:#4bd8ee; --amber:#ffb238; --danger:#ff5f57; }
    * { box-sizing: border-box; }
    body { min-height:100vh; margin:0; display:grid; place-items:center; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 20% 0%, rgba(75,216,238,.18), transparent 28%), linear-gradient(135deg, rgba(255,178,56,.08), transparent 35%), repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px), var(--bg); color:var(--text); }
    main { width:min(460px, calc(100% - 32px)); border:1px solid var(--line); border-radius:8px; background:rgba(11,18,22,.92); padding:26px; }
    .mark { display:grid; place-items:center; width:44px; height:44px; border:1px solid rgba(75,216,238,.45); border-radius:8px; background:linear-gradient(145deg, rgba(75,216,238,.18), rgba(255,178,56,.12)); font-weight:900; }
    h1 { margin:18px 0 8px; font-size:30px; letter-spacing:0; }
    p { color:var(--muted); margin:0 0 22px; }
    a { display:block; text-align:center; width:100%; border-radius:6px; background:linear-gradient(135deg, var(--cyan), var(--amber)); color:#05080a; padding:12px; font-weight:800; text-decoration:none; }
    .error { color:var(--danger); margin-top:14px; }
  </style>
</head>
<body>
  <main>
    <div class="mark">ND</div>
    <h1>NexaDesk</h1>
    <p>Inicia sesion con Discord para ver y gestionar solo los servidores donde tienes permisos.</p>
    ${isReady ? '<a href="/auth/discord">Entrar con Discord</a>' : '<p class="error">Falta DISCORD_CLIENT_SECRET en el entorno.</p>'}
  </main>
</body>
</html>`;
}

function renderDashboard({ session, guilds, tickets }) {
  const guildOptions = guilds
    .map((guild) => `<option value="${escapeHtml(guild.guildId)}">${escapeHtml(guild.guildName ?? guild.guildId)}</option>`)
    .join('');

  const guildCards = guilds
    .map((guild) => `
      <article class="surface guild-card">
        <div>
          <p class="kicker">${guild.connected ? 'Conectado' : 'Disponible'}</p>
          <h3>${escapeHtml(guild.guildName ?? guild.guildId)}</h3>
        </div>
        <dl>
          <div><dt>Categoria</dt><dd>${escapeHtml(guild.ticketCategoryName ?? 'Sin configurar')}</dd></div>
          <div><dt>Paneles</dt><dd>${escapeHtml(String(guild.panels?.length ?? 0))}</dd></div>
          <div><dt>Actualizado</dt><dd>${escapeHtml(guild.updatedAt ? new Date(guild.updatedAt).toLocaleString() : 'Pendiente')}</dd></div>
        </dl>
      </article>
    `)
    .join('');

  const ticketRows = tickets
    .map((ticket) => renderTicketRow(ticket))
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Dashboard</title>
  <style>
    :root { color-scheme:dark; --bg:#05080a; --panel:#0b1216; --panel-2:#101a20; --line:#20323a; --text:#f2fbfc; --muted:#8ea3aa; --cyan:#4bd8ee; --amber:#ffb238; --ok:#63e6a7; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"Segoe UI",ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 12% 0%, rgba(75,216,238,.18), transparent 28%), linear-gradient(135deg, rgba(255,178,56,.08), transparent 35%), repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px), var(--bg); color:var(--text); }
    main { width:min(1240px, calc(100% - 32px)); margin:0 auto; padding:30px 0 48px; }
    header { min-height:220px; display:grid; grid-template-columns:1.4fr .9fr; gap:24px; align-items:center; margin-bottom:22px; border-bottom:1px solid var(--line); }
    h1,h2,h3 { margin:0; letter-spacing:0; }
    h1 { font-size:clamp(38px, 6vw, 76px); line-height:.94; max-width:760px; }
    h2 { font-size:18px; margin-bottom:16px; }
    h3 { font-size:17px; }
    p { margin:8px 0 0; color:var(--muted); }
    .brand-lockup { display:flex; gap:14px; align-items:center; margin-bottom:22px; }
    .mark { display:grid; place-items:center; width:42px; height:42px; border:1px solid rgba(75,216,238,.45); background:linear-gradient(145deg, rgba(75,216,238,.18), rgba(255,178,56,.12)); border-radius:8px; font-weight:900; }
    .hero-panel,.surface,.stat { border:1px solid var(--line); border-radius:8px; background:rgba(11,18,22,.86); }
    .hero-panel { padding:18px; background:linear-gradient(180deg, rgba(16,26,32,.92), rgba(5,8,10,.92)); }
    .signal-list { display:grid; gap:10px; margin-top:16px; }
    .signal { display:flex; justify-content:space-between; gap:18px; padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06); color:var(--muted); }
    .signal strong { color:var(--text); }
    .surface { padding:20px; margin:18px 0; }
    .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .stat { padding:16px; background:linear-gradient(180deg,var(--panel-2),var(--panel)); }
    .stat strong { display:block; font-size:28px; }
    .stat span, label, th, dt { color:var(--muted); }
    .workspace { display:grid; grid-template-columns:.9fr 1.1fr; gap:18px; }
    form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    label { display:grid; gap:6px; font-size:14px; }
    input,select,textarea,button { width:100%; border-radius:6px; border:1px solid var(--line); background:#071014; color:var(--text); padding:10px 12px; font:inherit; }
    textarea { min-height:140px; resize:vertical; grid-column:1 / -1; }
    .span-2 { grid-column:1 / -1; }
    button { background:linear-gradient(135deg,var(--cyan),var(--amber)); color:#071014; border:0; font-weight:800; cursor:pointer; }
    .secondary-button { background:#0b1216; color:var(--text); border:1px solid var(--line); }
    .logout-form { display:flex; justify-content:flex-end; margin:-6px 0 12px; }
    .logout-form button { width:auto; padding:9px 12px; }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; padding:12px; border-bottom:1px solid var(--line); }
    .guild-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .guild-card { margin:0; }
    dl { margin:14px 0 0; display:grid; gap:8px; }
    dd { margin:2px 0 0; }
    .kicker { color:var(--cyan); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .tabs { display:grid; gap:18px; }
    .notice { border-left:3px solid var(--amber); padding-left:12px; color:var(--muted); }
    .live { color:var(--ok); }
    @media (max-width:760px) { header,form,.workspace { display:block; } .stats,.guild-grid { grid-template-columns:1fr; } label,button { margin-top:12px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="brand-lockup"><div class="mark">ND</div><strong>NexaDesk Command</strong></div>
        <h1>Soporte inteligente para tickets de Discord.</h1>
        <p>Gestiona categorias, paneles, base de conocimiento y tickets asistidos por IA desde un centro operativo conectado a Supabase.</p>
      </div>
      <aside class="hero-panel">
        <p class="kicker">Sesion Discord</p>
        <div class="signal-list">
          <div class="signal"><span>Usuario</span><strong>${escapeHtml(session.user.username)}</strong></div>
          <div class="signal"><span>Realtime</span><strong id="liveState">Conectando</strong></div>
          <div class="signal"><span>Ultima sync</span><strong id="lastSync">${escapeHtml(new Date().toLocaleTimeString())}</strong></div>
        </div>
      </aside>
    </header>
    <form method="post" action="/logout" class="logout-form"><button class="secondary-button" type="submit">Cerrar sesion</button></form>
    <div class="stats">
      <div class="stat"><strong id="guildCount">${guilds.length}</strong><span>Servidores disponibles</span></div>
      <div class="stat"><strong id="ticketCount">${tickets.length}</strong><span>Tickets detectados</span></div>
      <div class="stat"><strong id="openCount">${tickets.filter((ticket) => ticket.status === 'open').length}</strong><span>Tickets abiertos</span></div>
    </div>
    <div class="workspace">
      <section class="surface"><h2>Servidores</h2><div class="guild-grid" id="guildGrid">${guildCards || '<p class="notice">No tienes servidores gestionables.</p>'}</div></section>
      <section class="surface tabs">
        <div>
          <h2>Conocimiento del servidor</h2>
          <form onsubmit="return saveConfig(event)">
            <label>Servidor<select id="guildId" required>${guildOptions}</select></label>
            <label>Categoria de tickets ID<input id="ticketCategoryId" placeholder="1234567890"></label>
            <label>Nombre categoria<input id="ticketCategoryName" placeholder="soporte"></label>
            <textarea id="serverInfo" placeholder="Reglas, FAQs, horarios, precios, enlaces, tono de respuesta..."></textarea>
            <button type="submit">Guardar inteligencia</button>
          </form>
        </div>
        <div>
          <h2>Crear categoria</h2>
          <form onsubmit="return createCategory(event)">
            <label>Servidor<select id="categoryGuildId" required>${guildOptions}</select></label>
            <label class="span-2">Nombre de categoria<input id="categoryName" placeholder="NexaDesk Tickets" required></label>
            <button type="submit">Crear y activar categoria</button>
          </form>
        </div>
        <div>
          <h2>Crear panel</h2>
          <form onsubmit="return createPanel(event)">
            <label>Servidor<select id="panelGuildId" required>${guildOptions}</select></label>
            <label>Canal del panel ID<input id="panelChannelId" placeholder="Canal donde publicar el panel" required></label>
            <label>Boton<input id="panelButtonLabel" value="Abrir ticket"></label>
            <label class="span-2">Titulo<input id="panelTitle" value="Centro de soporte"></label>
            <textarea id="panelDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</textarea>
            <button type="submit">Publicar panel</button>
          </form>
        </div>
      </section>
    </div>
    <section class="surface">
      <h2>Tickets recientes</h2>
      <table><thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th></tr></thead><tbody id="ticketRows">${ticketRows || '<tr><td colspan="4">Aun no hay tickets detectados.</td></tr>'}</tbody></table>
    </section>
  </main>
  <script>
    const state = { tickets: ${JSON.stringify(tickets)} };
    function ticketRow(ticket) {
      return '<tr><td>#' + escapeHtml(ticket.channelName) + '</td><td>' + escapeHtml(ticket.guildName) + '</td><td>' + escapeHtml(ticket.status) + '</td><td>' + escapeHtml(new Date(ticket.createdAt).toLocaleString()) + '</td></tr>';
    }
    function escapeHtml(value) {
      return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#039;');
    }
    function renderTickets() {
      document.querySelector('#ticketRows').innerHTML = state.tickets.length ? state.tickets.map(ticketRow).join('') : '<tr><td colspan="4">Aun no hay tickets detectados.</td></tr>';
      document.querySelector('#ticketCount').textContent = state.tickets.length;
      document.querySelector('#openCount').textContent = state.tickets.filter((ticket) => ticket.status === 'open').length;
    }
    async function postJson(url, body) {
      const response = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
      return response.json();
    }
    async function saveConfig(event) {
      event.preventDefault();
      const guildId = document.querySelector('#guildId').value;
      await postJson('/api/guilds/' + guildId, {
        ticketCategoryId: document.querySelector('#ticketCategoryId').value,
        ticketCategoryName: document.querySelector('#ticketCategoryName').value,
        serverInfo: document.querySelector('#serverInfo').value
      }).catch((error) => alert(error.message));
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
    });
    source.addEventListener('guild.updated', () => {
      document.querySelector('#lastSync').textContent = new Date().toLocaleTimeString();
    });
    source.onerror = () => {
      document.querySelector('#liveState').textContent = 'Reconectando';
      document.querySelector('#liveState').className = '';
    };
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
