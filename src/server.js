import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

export function createServer({ config, storage, bot }) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('tiny'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(config.DASHBOARD_ADMIN_KEY));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'nexadesk' });
  });

  app.get('/login', (req, res) => {
    if (isLoggedIn(req)) {
      res.redirect('/');
      return;
    }
    res.type('html').send(renderLogin());
  });

  app.post('/login', (req, res) => {
    if (req.body.adminKey !== config.DASHBOARD_ADMIN_KEY) {
      res.status(401).type('html').send(renderLogin('Clave incorrecta.'));
      return;
    }

    res.cookie('nexadesk_session', createSessionToken(config), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      signed: true,
      maxAge: 1000 * 60 * 60 * 12
    });
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie('nexadesk_session');
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }

    if (!isLoggedIn(req)) {
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      res.redirect('/login');
      return;
    }

    next();
  });

  app.get('/api/guilds', async (_req, res) => {
    res.json(await storage.listGuildConfigs());
  });

  app.get('/api/tickets', async (_req, res) => {
    res.json(await storage.listTickets());
  });

  app.post('/api/guilds/:guildId', requireAdmin(config), async (req, res) => {
    const updated = await storage.upsertGuildConfig(req.params.guildId, {
      guildName: req.body.guildName,
      ticketCategoryId: req.body.ticketCategoryId,
      ticketCategoryName: req.body.ticketCategoryName,
      serverInfo: req.body.serverInfo
    });
    res.json(updated);
  });

  app.post('/api/guilds/:guildId/categories', requireAdmin(config), async (req, res) => {
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

  app.post('/api/guilds/:guildId/panels', requireAdmin(config), async (req, res) => {
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

  app.get('/', async (_req, res) => {
    const guilds = await storage.listGuildConfigs();
    const tickets = await storage.listTickets();

    res.type('html').send(renderDashboard({ guilds, tickets }));
  });

  return app;
}

function requireAdmin(config) {
  return (req, res, next) => {
    const key = req.header('x-admin-key') || req.body.adminKey;
    if (!isLoggedIn(req) && key !== config.DASHBOARD_ADMIN_KEY) {
      res.status(401).json({ error: 'Invalid admin key' });
      return;
    }
    next();
  };
}

function createSessionToken(config) {
  const signature = crypto
    .createHmac('sha256', config.DASHBOARD_ADMIN_KEY)
    .update('nexadesk-dashboard')
    .digest('hex');
  return `dashboard.${signature}`;
}

function isLoggedIn(req) {
  return req.signedCookies?.nexadesk_session?.startsWith('dashboard.');
}

function renderLogin(error = '') {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Login</title>
  <style>
    :root { color-scheme: dark; --bg:#05080a; --panel:#0b1216; --line:#20323a; --text:#f2fbfc; --muted:#8ea3aa; --cyan:#4bd8ee; --amber:#ffb238; --danger:#ff5f57; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at 20% 0%, rgba(75,216,238,.18), transparent 28%),
        linear-gradient(135deg, rgba(255,178,56,.08), transparent 35%),
        repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px),
        var(--bg);
      color: var(--text);
    }
    main {
      width: min(440px, calc(100% - 32px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(11,18,22,.92);
      padding: 26px;
    }
    .mark { display:grid; place-items:center; width:44px; height:44px; border:1px solid rgba(75,216,238,.45); border-radius:8px; background:linear-gradient(145deg, rgba(75,216,238,.18), rgba(255,178,56,.12)); font-weight:900; }
    h1 { margin: 18px 0 8px; font-size: 30px; letter-spacing: 0; }
    p { color: var(--muted); margin: 0 0 22px; }
    label { display: grid; gap: 8px; color: var(--muted); font-size: 14px; }
    input, button { width: 100%; border-radius: 6px; border: 1px solid var(--line); background: #05080a; color: var(--text); padding: 12px; font: inherit; }
    button { margin-top: 14px; background: linear-gradient(135deg, var(--cyan), var(--amber)); color: #05080a; border: 0; font-weight: 800; cursor: pointer; }
    .error { color: var(--danger); margin-bottom: 14px; }
  </style>
</head>
<body>
  <main>
    <div class="mark">ND</div>
    <h1>NexaDesk</h1>
    <p>Acceso local al centro de operaciones.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/login">
      <label>Admin key
        <input name="adminKey" type="password" autocomplete="current-password" autofocus required>
      </label>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

function renderDashboard({ guilds, tickets }) {
  const guildOptions = guilds
    .map((guild) => `<option value="${escapeHtml(guild.guildId)}">${escapeHtml(guild.guildName ?? guild.guildId)}</option>`)
    .join('');

  const guildCards = guilds
    .map((guild) => `
      <article class="surface guild-card">
        <div>
          <p class="kicker">Servidor</p>
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
    .map((ticket) => `
      <tr>
        <td>#${escapeHtml(ticket.channelName)}</td>
        <td>${escapeHtml(ticket.guildName)}</td>
        <td>${escapeHtml(ticket.status)}</td>
        <td>${escapeHtml(new Date(ticket.createdAt).toLocaleString())}</td>
      </tr>
    `)
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexaDesk Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #05080a;
      --panel: #0b1216;
      --panel-2: #101a20;
      --line: #20323a;
      --text: #f2fbfc;
      --muted: #8ea3aa;
      --cyan: #4bd8ee;
      --amber: #ffb238;
      --danger: #ff5f57;
      --ok: #63e6a7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background:
        radial-gradient(circle at 12% 0%, rgba(75, 216, 238, 0.18), transparent 28%),
        linear-gradient(135deg, rgba(255, 178, 56, 0.08), transparent 35%),
        repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 72px),
        var(--bg);
      color: var(--text);
    }
    main {
      width: min(1240px, calc(100% - 32px));
      margin: 0 auto;
      padding: 30px 0 48px;
    }
    header {
      min-height: 220px;
      display: grid;
      grid-template-columns: 1.4fr 0.9fr;
      gap: 24px;
      align-items: center;
      margin-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: clamp(38px, 6vw, 76px); line-height: 0.94; max-width: 760px; }
    h2 { font-size: 18px; margin-bottom: 16px; }
    h3 { font-size: 17px; }
    p { margin: 8px 0 0; color: var(--muted); }
    .brand-lockup { display: flex; gap: 14px; align-items: center; margin-bottom: 22px; }
    .mark {
      display: grid; place-items: center;
      width: 42px; height: 42px;
      border: 1px solid rgba(75, 216, 238, 0.45);
      background: linear-gradient(145deg, rgba(75,216,238,.18), rgba(255,178,56,.12));
      border-radius: 8px;
      font-weight: 900;
    }
    .hero-panel {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(16,26,32,.92), rgba(5,8,10,.92));
      border-radius: 8px;
      padding: 18px;
    }
    .signal-list { display: grid; gap: 10px; margin-top: 16px; }
    .signal {
      display: flex; justify-content: space-between; gap: 18px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,.06);
      color: var(--muted);
    }
    .signal strong { color: var(--text); }
    .surface {
      border: 1px solid var(--line);
      background: rgba(11, 18, 22, 0.86);
      border-radius: 8px;
      padding: 20px;
      margin: 18px 0;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      background: linear-gradient(180deg, var(--panel-2), var(--panel));
    }
    .stat strong { display: block; font-size: 28px; }
    .stat span { color: var(--muted); }
    .workspace {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr;
      gap: 18px;
    }
    form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 14px; }
    input, select, textarea, button {
      width: 100%;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #071014;
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    textarea { min-height: 140px; resize: vertical; grid-column: 1 / -1; }
    .span-2 { grid-column: 1 / -1; }
    button {
      background: linear-gradient(135deg, var(--cyan), var(--amber));
      color: #071014;
      border: 0;
      font-weight: 800;
      cursor: pointer;
    }
    .secondary-button {
      background: #0b1216;
      color: var(--text);
      border: 1px solid var(--line);
    }
    .logout-form {
      display: flex;
      justify-content: flex-end;
      margin: -6px 0 12px;
    }
    .logout-form button { width: auto; padding: 9px 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-size: 13px; }
    .guild-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
    .guild-card { margin: 0; }
    dl { margin: 14px 0 0; display: grid; gap: 8px; }
    dt { color: var(--muted); font-size: 12px; }
    dd { margin: 2px 0 0; }
    .kicker { color: var(--cyan); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .tabs { display: grid; gap: 18px; }
    .notice { border-left: 3px solid var(--amber); padding-left: 12px; color: var(--muted); }
    @media (max-width: 760px) {
      header, form, .workspace { display: block; }
      .stats { grid-template-columns: 1fr; }
      .guild-grid { grid-template-columns: 1fr; }
      label, button { margin-top: 12px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="brand-lockup"><div class="mark">ND</div><strong>NexaDesk Command</strong></div>
        <h1>Soporte inteligente para tickets de Discord.</h1>
        <p>Gestiona categorias, paneles, base de conocimiento y tickets asistidos por IA desde un centro operativo listo para Render.</p>
      </div>
      <aside class="hero-panel">
        <p class="kicker">Estado del sistema</p>
        <div class="signal-list">
          <div class="signal"><span>Bot</span><strong>Online</strong></div>
          <div class="signal"><span>IA</span><strong>Groq</strong></div>
          <div class="signal"><span>Ultima sync</span><strong>${escapeHtml(new Date().toLocaleTimeString())}</strong></div>
        </div>
      </aside>
    </header>
    <form method="post" action="/logout" class="logout-form">
      <button class="secondary-button" type="submit">Cerrar sesion</button>
    </form>

    <div class="stats">
      <div class="stat"><strong>${guilds.length}</strong><span>Servidores configurados</span></div>
      <div class="stat"><strong>${tickets.length}</strong><span>Tickets detectados</span></div>
      <div class="stat"><strong>${tickets.filter((ticket) => ticket.status === 'open').length}</strong><span>Tickets abiertos</span></div>
    </div>

    <div class="workspace">
      <section class="surface">
        <h2>Servidores vigilados</h2>
        <div class="guild-grid">${guildCards || '<p class="notice">Invita el bot y registra comandos para empezar.</p>'}</div>
      </section>

      <section class="surface tabs">
        <div>
          <h2>Conocimiento del servidor</h2>
          <form onsubmit="return saveConfig(event)">
            <label>Servidor
              <select id="guildId" required>${guildOptions}</select>
            </label>
            <input id="adminKey" name="adminKey" type="hidden" value="">
            <label>Categoria de tickets ID
              <input id="ticketCategoryId" name="ticketCategoryId" placeholder="1234567890">
            </label>
            <label>Nombre categoria
              <input id="ticketCategoryName" name="ticketCategoryName" placeholder="soporte">
            </label>
            <textarea id="serverInfo" name="serverInfo" placeholder="Reglas, FAQs, horarios, precios, enlaces, tono de respuesta, politicas de reembolso..."></textarea>
            <button type="submit">Guardar inteligencia</button>
          </form>
        </div>

        <div>
          <h2>Crear categoria</h2>
          <form onsubmit="return createCategory(event)">
            <label>Servidor
              <select id="categoryGuildId" required>${guildOptions}</select>
            </label>
            <input id="categoryAdminKey" type="hidden" value="">
            <label class="span-2">Nombre de categoria
              <input id="categoryName" placeholder="NexaDesk Tickets" required>
            </label>
            <button type="submit">Crear y activar categoria</button>
          </form>
        </div>

        <div>
          <h2>Crear panel</h2>
          <form onsubmit="return createPanel(event)">
            <label>Servidor
              <select id="panelGuildId" required>${guildOptions}</select>
            </label>
            <input id="panelAdminKey" type="hidden" value="">
            <label>Canal del panel ID
              <input id="panelChannelId" placeholder="Canal donde publicar el panel" required>
            </label>
            <label>Boton
              <input id="panelButtonLabel" value="Abrir ticket">
            </label>
            <label class="span-2">Titulo
              <input id="panelTitle" value="Centro de soporte">
            </label>
            <textarea id="panelDescription">Pulsa el boton para abrir un ticket. NexaDesk analizara tu caso y avisara al staff si hace falta.</textarea>
            <button type="submit">Publicar panel</button>
          </form>
        </div>
      </section>
    </div>

    <section class="surface">
      <h2>Tickets recientes</h2>
      <table>
        <thead><tr><th>Canal</th><th>Servidor</th><th>Estado</th><th>Creado</th></tr></thead>
        <tbody>${ticketRows || '<tr><td colspan="4">Aun no hay tickets detectados.</td></tr>'}</tbody>
      </table>
    </section>
  </main>
  <script>
    async function saveConfig(event) {
      event.preventDefault();
      const guildId = document.querySelector('#guildId').value;
      const body = {
        adminKey: document.querySelector('#adminKey').value,
        ticketCategoryId: document.querySelector('#ticketCategoryId').value,
        ticketCategoryName: document.querySelector('#ticketCategoryName').value,
        serverInfo: document.querySelector('#serverInfo').value
      };
      const response = await fetch('/api/guilds/' + guildId, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        alert('No se pudo guardar. Revisa la admin key.');
        return false;
      }
      location.reload();
      return false;
    }
    async function createCategory(event) {
      event.preventDefault();
      const guildId = document.querySelector('#categoryGuildId').value;
      const response = await fetch('/api/guilds/' + guildId + '/categories', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-key': document.querySelector('#categoryAdminKey').value
        },
        body: JSON.stringify({ name: document.querySelector('#categoryName').value })
      });
      if (!response.ok) {
        alert('No se pudo crear la categoria.');
        return false;
      }
      location.reload();
      return false;
    }
    async function createPanel(event) {
      event.preventDefault();
      const guildId = document.querySelector('#panelGuildId').value;
      const response = await fetch('/api/guilds/' + guildId + '/panels', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-key': document.querySelector('#panelAdminKey').value
        },
        body: JSON.stringify({
          channelId: document.querySelector('#panelChannelId').value,
          title: document.querySelector('#panelTitle').value,
          description: document.querySelector('#panelDescription').value,
          buttonLabel: document.querySelector('#panelButtonLabel').value
        })
      });
      if (!response.ok) {
        alert('No se pudo publicar el panel.');
        return false;
      }
      location.reload();
      return false;
    }
  </script>
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
