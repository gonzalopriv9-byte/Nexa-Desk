export class LocalSupportClient {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }

  async generate({ system = '', messages = [] } = {}) {
    if (!this.enabled) {
      throw new Error('Local support fallback is disabled.');
    }

    const lastUser = getLastUserMessage(messages);
    if (expectsJson(system)) {
      return buildJsonFallback({ system, lastUser });
    }

    return buildSupportFallback({ system, messages, lastUser });
  }
}

function buildSupportFallback({ system, messages, lastUser }) {
  const text = normalizeText(lastUser);
  const rawLastUser = String(lastUser ?? '').trim();
  const context = normalizeText(messages.map((message) => message.content).join('\n'));
  const language = detectFallbackLanguage(text, context);
  const reply = getLocalizedReplies(language);

  if (isLanguageSwitchRequest(text)) {
    return reply.languageSwitch;
  }

  if (isSensitiveAccessRequest(text)) {
    return reply.secret ?? getLocalizedReplies('en').secret;
  }

  if (isStaffRequest(text)) {
    return `[ESCALATE] ${reply.staff}`;
  }

  if (/\b(suicid|matarme|me\s+voy\s+a\s+tirar|self.?harm|kill myself)\b/iu.test(text)) {
    return `[ESCALATE] ${reply.crisis}`;
  }

  if (/\b(panel|paneles|borrar|eliminar|delete|remove)\b/iu.test(text) && /\b(dashboard|panel|paneles|web|opcion|opci[oó]n)\b/iu.test(context)) {
    return reply.panels;
  }

  if (/\b(funciones|caracteristicas|features|que\s+haces|como\s+funcionas|como\s+funciona|que\s+puedes\s+hacer|ultima\s+actualizacion|version|v1\.\d)\b/iu.test(text)) {
    return reply.capabilities;
  }

  if (/\b(captura|imagen|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(text)) {
    return reply.image;
  }

  if (/\b(staff|mod|moderador|postular|postulaci[oó]n|quiero\s+ser\s+staff)\b/iu.test(text)) {
    return reply.staffApplication;
  }

  if (isRaidReport(text)) {
    return `[ESCALATE] ${reply.raid ?? getLocalizedReplies('en').raid}`;
  }

  const channelLookupReply = buildChannelLookupFallback({ system, text, context, language, messages });
  if (channelLookupReply) return channelLookupReply;
  if (isAllianceInfoQuestion(text)) {
    return reply.allianceInfo;
  }

  if (/\b(alianza|partner|partnership|colaboraci[oó]n)\b/iu.test(text)) {
    return reply.alliance;
  }

  if (/\b(acoso|amenaza|insulto|reportar|reporte|abuso|raid|raidead[oa]|nuke|flood|spam\s+masivo|harassment|threat|report)\b/iu.test(text)) {
    return reply.report;
  }

  const groundedReply = buildGroundedSupportFallback({
    lastUser: rawLastUser,
    text,
    context,
    language
  });
  if (groundedReply) return groundedReply;
  if (/\b(error|fallo|problema|no\s+funciona|bug|issue)\b/iu.test(text)) {
    return reply.problem;
  }

  if (/\b(afk|vengo|vuelvo|regreso|un\s+momento|ahora\s+vengo|ya\s+vengo)\b/iu.test(text)) {
    return reply.waiting;
  }

  if (/^(vale|ok|okay|dale|perfecto|gracias|ty|thanks)[!.?\s]*$/iu.test(text)) {
    return reply.ack;
  }

  if (/^(hola|buenas|hey|hi|hello|buenos dias|buenas tardes)[!.?\s]*$/iu.test(text)) {
    return reply.greeting;
  }

  return reply.generic;
}

function buildChannelLookupFallback({ system = '', text = '', context = '', language = 'es', messages = [] } = {}) {
  const intent = getConversationChannelLookupIntent(text, messages, context);
  if (!intent) return '';

  const candidates = extractChannelCandidates(system);
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreChannelCandidate(candidate, intent) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];

  if (best && best.score >= 3) {
    if (language === 'en') return `You can find ${intent.labelEn} in ${best.mention}.`;
    if (language === 'zh') return `Discord channel: ${best.mention}`;
    return `Puedes consultar ${intent.labelEs} en ${best.mention}.`;
  }

  if (language === 'en') return `I have not located a public Discord channel for ${intent.labelEn} in the available server context; that does not confirm that it does not exist.`;
  if (language === 'zh') return `No public Discord channel was located for this request; that does not confirm that it does not exist.`;
  return `No he localizado un canal publico de Discord para ${intent.labelEs} en el contexto disponible; eso no confirma que no exista.`;
}

function getConversationChannelLookupIntent(latestText = '', messages = [], context = '') {
  const direct = detectChannelLookupIntent(latestText);
  if (direct) return direct;

  const normalizedLatest = normalizeText(latestText);
  const isFollowUp = /\b(?:busca|buscar|buscalo|encuentra|encontrarlo|localiza|mira)\b/iu.test(normalizedLatest)
    || (/\b(?:digo|refiero|me\s+refiero|en\s+discord|canal\s+de\s+discord|ese\s+canal|ese)\b/iu.test(normalizedLatest)
      && /\b(?:canal|discord|eso|ese)\b/iu.test(normalizedLatest));
  if (!isFollowUp) return null;

  const previousUsers = messages
    .filter((message) => message?.role === 'user')
    .map((message) => String(message.content ?? ''))
    .reverse();
  for (const previous of previousUsers) {
    const intent = detectChannelLookupIntent(previous);
    if (intent) return intent;
  }

  return detectChannelLookupIntent(context);
}

function detectChannelLookupIntent(value = '') {
  const normalized = normalizeText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const asksLocation = /\b(?:donde|en\s+que|canal|canales|buscar|busca|buscalo|encuentra|localiza|ver|mirar|publica|publican|aparece|aparecen)\b/iu.test(normalized);
  if (!asksLocation) return null;

  if (/\b(?:alianza|alianzas|partner|partnership|partners|colaboracion|colaboraciones)\b/iu.test(normalized)) {
    return { key: 'alliances', labelEs: 'las alianzas y solicitudes', labelEn: 'alliances and requests', labelZh: '联盟和申请', terms: ['alianza', 'alianzas', 'partner', 'partnership', 'colaboracion'] };
  }
  if (/\b(?:verific(?:acion|arme|arse|ado|ada|ados|adas)?|captcha|rol(?:es)?|verified|verify)\b/iu.test(normalized)) {
    return { key: 'verification', labelEs: 'la verificacion', labelEn: 'verification', labelZh: '验证信息', terms: ['verificacion', 'verificar', 'captcha', 'rol', 'verified', 'verify'] };
  }
  if (/\b(?:estadistic(?:a|as)|m[eé]trica(?:s)?|stats|global(?:es)?|ranking|datos)\b/iu.test(normalized)) {
    return { key: 'statistics', labelEs: 'las estadisticas globales', labelEn: 'global statistics', labelZh: '全局统计', terms: ['estadistica', 'estadisticas', 'metrica', 'metricas', 'stats', 'global', 'ranking', 'datos'] };
  }
  if (/\b(?:ejemplo(?:s)?|demo(?:s)?|tutorial(?:es)?|guia(?:s)?|documentacion|docs|funciona|funcionamiento)\b/iu.test(normalized)) {
    return { key: 'examples', labelEs: 'ejemplos del funcionamiento del bot', labelEn: 'bot examples', labelZh: '机器人示例', terms: ['ejemplo', 'ejemplos', 'demo', 'tutorial', 'guia', 'documentacion', 'docs', 'funcionamiento'] };
  }
  return null;
}

function extractChannelCandidates(system = '') {
  const source = String(system ?? '');
  const candidates = [];
  const canonicalPattern = /Canal real del servidor:\s*<(?:#)(\d{16,24})>\s*\(nombre visible:\s*#([^)]{2,120})\)\.?/giu;
  let match;
  while ((match = canonicalPattern.exec(source)) !== null) {
    const id = match[1];
    if (candidates.some((candidate) => candidate.id === id)) continue;
    candidates.push({
      id,
      mention: `<#${id}>`,
      name: normalizeText(match[2]),
      context: match[0]
    });
  }
  if (candidates.length) return candidates;

  const pattern = /<#(\d{16,24})>/g;
  while ((match = pattern.exec(source)) !== null) {
    const id = match[1];
    if (candidates.some((candidate) => candidate.id === id)) continue;
    candidates.push({ id, mention: `<#${id}>`, context: source.slice(Math.max(0, match.index - 180), match.index + 220) });
  }
  return candidates;
}

function scoreChannelCandidate(candidate, intent) {
  const context = normalizeText(candidate.context).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let score = 0;
  for (const term of intent.terms) {
    if (context.includes(term)) score += term.length >= 6 ? 4 : 2;
  }
  if (context.includes('mencion exacta para discord')) score += 2;
  return score;
}
function buildGroundedSupportFallback({ lastUser = '', text = '', context = '', language = 'es' } = {}) {
  const signal = extractConcreteFailureSignal(lastUser);
  if (!signal) return '';

  const previousVisual = /\b(?:imagen|captura|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(context)
    && !/\b(?:imagen|captura|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(text);
  const quoted = language === 'zh' ? `“${signal.display}”` : `«${signal.display}»`;

  if (language === 'en') {
    return [
      `I understood the new concrete fact: the latest message contains this error: ${quoted}.`,
      previousVisual ? 'The earlier image is still context, but this exact error is the current state.' : '',
      buildEnglishFailureMeaning(signal.kind),
      'The exact text is already actionable, so I will not ask you to repeat it. The owner or staff should review the service configuration or the failing dependency before trying the same step again.'
    ].filter(Boolean).join(' ');
  }

  if (language === 'zh') {
    return [
      `我已识别到最新的具体错误：${quoted}。`,
      previousVisual ? '之前的图片仍然是上下文，但这条错误信息代表当前状态。' : '',
      '这表明需要检查服务端配置，而不是重复相同的操作。请把准确错误交给服务器管理员或工作人员处理。'
    ].filter(Boolean).join(' ');
  }

  return [
    `He entendido el dato nuevo: el ultimo mensaje contiene este error: ${quoted}.`,
    previousVisual ? 'La imagen anterior queda como contexto, pero este error exacto marca el estado actual.' : '',
    buildSpanishFailureMeaning(signal.kind),
    'El texto exacto ya es accionable; no te voy a pedir que lo repitas. El owner o staff debe revisar el servicio, la configuracion o la dependencia que esta fallando antes de repetir el mismo paso.'
  ].filter(Boolean).join(' ');
}

function extractConcreteFailureSignal(value = '') {
  const raw = normalizeText(value);
  if (raw.length < 6) return null;
  const normalized = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const statusMatch = raw.match(/\b(?:http(?:\/\d(?:\.\d+)?)?\s*)?([45]\d{2})\b/iu);
  const hasQuotedError = /["“«].{4,}["”»]/u.test(raw);
  const hasFailureWord = /\b(?:error|fallo|problema|failed|failure|exception|issue|bug|falta|missing|undefined|not\s+defined|timeout|timed\s+out|forbidden|unauthorized|unreachable|bad\s+gateway|no\s+(?:me\s+)?(?:deja|permite)|no\s+funciona|no\s+responde|se\s+(?:rompe|cae))\b/iu.test(normalized);
  if (!statusMatch && !hasQuotedError && !hasFailureWord) return null;

  let kind = 'generic';
  if (/\b(?:falta|missing|undefined|not\s+defined|environment|entorno|variable|configuraci[oó]n|configuration|credencial|credential)\b/iu.test(normalized)) {
    kind = 'configuration';
  } else if (statusMatch || /\b(?:timeout|timed\s+out|bad\s+gateway|origin\s+unreachable|connection|unreachable|servidor|server)\b/iu.test(normalized)) {
    kind = 'service';
  } else if (/\b(?:401|403|forbidden|unauthorized|acceso|entrar|acceder|login|no\s+(?:me\s+)?(?:deja|permite))\b/iu.test(normalized)) {
    kind = 'access';
  } else if (/\b(?:no\s+funciona|no\s+responde|se\s+(?:rompe|cae)|crash|carga|blank|pantalla)\b/iu.test(normalized)) {
    kind = 'client';
  }

  return { kind, display: sanitizeFailureDisplay(raw) };
}

function sanitizeFailureDisplay(value = '') {
  return normalizeText(value)
    .replace(/\bmfa\.[A-Za-z0-9_-]{20,}\b/giu, '[token oculto]')
    .replace(/((?:token|secret|password|contrasena|contraseña|api[_\s-]?key|clave\s+api)\s*[:=]\s*)\S+/giu, '$1[oculto]')
    .replace(/([?&](?:token|secret|password|key|api_key)=)[^&\s]+/giu, '$1[oculto]')
    .slice(0, 320);
}

function buildSpanishFailureMeaning(kind) {
  if (kind === 'configuration') return 'La señal apunta a una configuracion ausente en el servicio, no a un fallo de tu cuenta ni de la verificacion de Cloudflare. Repetir la casilla no puede crear una variable que falta.';
  if (kind === 'service') return 'La señal apunta a que el host o un servicio remoto no ha respondido correctamente. No implica por si sola que hayas hecho nada mal; hay que revisar disponibilidad, proxy y logs del servicio.';
  if (kind === 'access') return 'La señal apunta a que el servidor esta rechazando la peticion o no permite completar el acceso. Conviene revisar la autenticacion y la respuesta del servidor, no repetir la misma accion a ciegas.';
  if (kind === 'client') return 'La señal apunta a un fallo de carga o respuesta del cliente. Conviene conservar el texto exacto y revisar la peticion que falla antes de cambiar pasos sin evidencia.';
  return 'La señal aporta un fallo concreto. La respuesta debe partir de ese dato y separar lo confirmado de lo que aun hay que comprobar, en vez de reiniciar la conversacion.';
}

function buildEnglishFailureMeaning(kind) {
  if (kind === 'configuration') return 'This points to missing service configuration, not a problem with your account or the Cloudflare verification. Repeating the checkbox cannot create a missing variable.';
  if (kind === 'service') return 'This points to the host or a remote service failing to respond correctly. It does not by itself mean you did anything wrong; availability, proxy and service logs should be checked.';
  if (kind === 'access') return 'This points to the server rejecting the request or not allowing the access flow to complete. Authentication and the server response should be checked instead of repeating the same action blindly.';
  if (kind === 'client') return 'This points to a loading or client-response failure. Keep the exact text and inspect the failing request before changing steps without evidence.';
  return 'This is a concrete failure signal. The response should start from that fact and separate what is confirmed from what still needs checking, rather than restarting the conversation.';
}
function buildJsonFallback({ system, lastUser }) {
  const compact = `${system}\n${lastUser}`;
  const text = normalizeText(compact);

  if (compact.includes('"detected":true|false')) {
    const detected = /\b(ia|bot|nexa|nexadesk|respuesta|imagen|voz|audio|lento|tarda|mal|rallad|borrach|no\s+entiende|inventa)\b/iu.test(text);
    return JSON.stringify({
      detected,
      category: detected ? detectQualityCategory(text) : 'general',
      severity: /mierda|subnormal|fatal|horrible|critico|crash|no\s+va/iu.test(text) ? 'high' : 'medium',
      sentiment: /mierda|subnormal|fatal|horrible|enfad/iu.test(text) ? 'angry' : 'frustrated',
      confidence: detected ? 72 : 35,
      reason: detected ? 'Fallback local detecto posible queja sobre NexaDesk.' : ''
    });
  }

  if (compact.includes('"verdict":"safe|suspicious|malicious"')) {
    const malicious = /\b(nitro|free|gratis|airdrop|steamcommunity|login|verify|wallet|token|robux|gift)\b/iu.test(text);
    return JSON.stringify({
      verdict: malicious ? 'suspicious' : 'safe',
      confidence: malicious ? 70 : 55,
      reason: malicious ? 'El texto contiene patrones comunes de estafa o verificacion externa.' : 'No hay senales claras en el filtro local.',
      riskSignals: malicious ? ['Patron sospechoso en el contenido o URL.'] : [],
      recommendedAction: malicious ? 'review' : 'allow'
    });
  }

  if (compact.includes('"spam":true|false')) {
    const spam = /\b(nexadesk lab|raid|flood|spam|everyone|discord\.gg|nitro gratis)\b/iu.test(text);
    return JSON.stringify({
      spam,
      confidence: spam ? 78 : 45,
      reason: spam ? 'Patron local compatible con spam o prueba de raid.' : 'No hay suficientes senales locales de spam.',
      signals: spam ? ['Rafaga, raid, invitacion o etiqueta de laboratorio.'] : [],
      recommendedAction: spam ? 'delete_and_isolate' : 'allow'
    });
  }

  if (compact.includes('"action":"create_voice_room|ban_user|create_text_channel|delete_channel|lock_channel|escalate_staff|none"')) {
    const actionText = normalizeText(lastUser);
    const voice = /\b(voz|voice|chat de voz|sala de voz|hablar por voz)\b/iu.test(actionText);
    const staff = /\b(staff|humano|moderador|admin|owner|responsable)\b/iu.test(actionText);
    const ban = /\b(ban|banear|banea|expulsar|sancionar)\b/iu.test(actionText);
    return JSON.stringify({
      action: voice ? 'create_voice_room' : staff || ban ? 'escalate_staff' : 'none',
      confidence: voice ? 82 : staff || ban ? 76 : 0,
      evidenceLevel: 'none',
      targetUserId: null,
      targetChannelId: null,
      channelName: null,
      reason: voice
        ? 'Fallback local detecto peticion de voz.'
        : ban
          ? 'Fallback local no ejecuta bans sin analisis IA y pruebas verificables.'
          : staff
            ? 'Fallback local detecto necesidad de staff.'
            : 'Sin accion segura detectada.',
      publicResponse: '',
      proofSummary: [],
      requiresStaffReview: !voice
    });
  }

  if (compact.includes('"score":0-10')) {
    return JSON.stringify({
      score: 5,
      passed: false,
      summary: 'Correccion local provisional: requiere revision humana porque el proveedor IA no estuvo disponible.',
      strengths: ['Respuestas recibidas y guardadas para revision.'],
      concerns: ['No se pudo aplicar la rubrica completa con IA externa.'],
      manualReviewRecommended: true,
      aiGeneratedSuspicion: 0,
      perQuestion: []
    });
  }

  if (compact.includes('"detected":true|false,"channelId"')) {
    return JSON.stringify({
      detected: false,
      channelId: null,
      confidence: 0,
      reason: 'Fallback local no confirma canal sin IA.',
      shouldAskInstaller: true
    });
  }

  if (compact.includes('"summary":"frase breve"')) {
    return JSON.stringify({
      summary: 'Fallback local: hace falta confirmar configuracion manualmente.',
      ticketCategory: { action: 'skip', id: null, confidence: 0, reason: 'Sin IA externa disponible.' },
      staffRole: { action: 'skip', id: null, confidence: 0, reason: 'Sin IA externa disponible.' }
    });
  }

  return '{}';
}

function getLocalizedReplies(language) {
  if (language === 'zh') {
    return {
      staff: '我会联系人工工作人员，因为这个情况需要人工处理。',
      crisis: '我会立刻升级给人工处理。请先远离危险，并马上联系当地紧急服务或身边可信任的人。',
      panels: '要删除面板，请打开仪表盘，选择服务器，进入 Panels/Paneles，然后使用已发布面板旁边的删除选项。',
      image: '我已收到图片。如果看不清，请发送更清晰的截图或复制错误文字，我会继续帮你判断。',
      staffApplication: '如果你想申请 staff，请告诉我你想申请的岗位或区域；如果需要人工审核，我会联系 staff。',
      allianceInfo: '我会先查看服务器真实频道和上下文，不会在你没有明确要求时启动联盟申请流程。',
      alliance: '如果要申请联盟，请发送你的服务器模板，包括邀请链接、成员数量、主题、你们提供什么以及负责人联系方式。',
      capabilities: 'NexaDesk 可以自动处理 tickets、读取服务器上下文、升级给 staff、保存 transcripts、检测黑名单和恶意内容、支持联盟流程、报告系统、语音支持、考试模式、Security Guard、Premium 多分类监听和定时公告。',
      report: '我可以帮你整理举报。请发送相关用户、发生了什么、时间，以及截图或证据。',
      problem: '我可以帮你。请告诉我你原本想做什么、出现了什么错误；如果可以，请发送截图或错误文字。',
      waiting: '没问题，我会在这里等你。你回来后把下一条关键信息发给我，我继续处理。',
      ack: '好的，我还在。你准备好后把下一步信息发给我。',
      languageSwitch: '好的，我会用中文回复。请告诉我你需要什么，我会继续帮你。',
      greeting: '你好，我在。告诉我你需要什么，我会帮你处理这个 ticket。',
      generic: '我还没有足够的具体事实来判断这个 ticket。请告诉我发生了什么或提供准确结果，我会从那里继续处理。'
    };
  }

  if (language === 'en') {
    return {
      staff: 'I will bring a human staff member in because this needs manual attention.',
      crisis: 'I am escalating this immediately. Please stay where you are, move away from danger if you can, and contact emergency services or someone you trust right now.',
      panels: 'To delete panels, open the dashboard, choose your server, go to Panels, then use the delete option on the published panel. If it does not appear, staff should check your dashboard permissions.',
      image: 'I received the image. If it is not readable, send a clearer screenshot or paste the exact error text so I can continue without guessing.',
      staffApplication: 'If you want to apply for staff, tell me the role or area you want and I will help prepare the application or call staff if this server handles it manually.',
      allianceInfo: 'I will check the real server channels and context before answering that. I will not start the alliance request flow unless you explicitly want to create one.',
      alliance: 'For an alliance, send your server template with the invite, member count, theme, what you offer and a contact person. I will keep it organized for staff.',
      capabilities: 'NexaDesk can answer ticket users with AI, read server context, escalate to staff with summaries, save transcripts, review images, detect blacklist/security risks, handle reports and partnerships, support voice rooms, run exam mode, protect against raids, and unlock Premium features like 2 watched categories and scheduled announcements.',
      report: 'I can help with the report. Send the user involved, what happened, when it happened and any screenshots or proof you have.',
      problem: 'I can help. Tell me what you were trying to do, what error appeared and, if possible, send a screenshot or the exact text of the error.',
      waiting: 'No problem, I will wait here. When you come back, send the next detail and I will continue.',
      ack: 'Perfect, I am still here. Send me the next detail whenever you are ready.',
      languageSwitch: 'Perfect, I will answer in English from now on. Tell me what you need and I will continue.',
      greeting: 'Hi, I am here. Tell me what you need and I will help you with this ticket.',
      secret: 'I cannot search, read or reveal private files such as .env, tokens, API keys or credentials. If this is a security test, good catch: I can help review variable names or rotation steps safely.',
      raid: 'This sounds like a possible raid or server attack. I will bring staff in. Send the user/bot involved, approximate time, what they did, affected channels/roles and any screenshots or proof you have.',
      generic: 'I do not have a concrete fact sufficient to orient this ticket yet. Tell me what happened or give me the exact result, and I will work from there.'
    };
  }

  return {
    staff: 'Voy a avisar a un miembro del staff porque esto necesita atencion manual.',
    crisis: 'Voy a escalar esto de inmediato. Por favor, alejate del peligro si puedes y contacta ahora con emergencias o con una persona de confianza cercana.',
    panels: 'Para eliminar paneles: entra en la dashboard, elige tu servidor, ve a Paneles y usa la opcion de eliminar en el panel publicado. Si no aparece, el staff debe revisar tus permisos en la dashboard.',
    image: 'He recibido la imagen. Si no se lee bien, mandame una captura mas clara o copia el texto exacto del error para seguir sin inventar.',
    staffApplication: 'Si quieres postular a staff, dime el area o rol al que quieres entrar y te ayudo a preparar la postulacion; si el servidor lo gestiona manualmente, aviso al staff.',
    allianceInfo: 'Voy a revisar los canales y el contexto real del servidor antes de responder eso. No abrire el flujo de alianza salvo que me digas claramente que quieres crear una.',
    alliance: 'Para una alianza, enviame la plantilla de tu servidor con invitacion, miembros, tematica, que ofreceis y contacto responsable. La dejo ordenada para revision.',
    capabilities: 'NexaDesk atiende tickets con IA, lee contexto real del servidor, escala casos al staff con resumen, guarda transcripciones, revisa imagenes, detecta riesgos de blacklist/seguridad, gestiona reportes y alianzas, abre salas de voz, corrige modo examen, protege contra raids y en Premium permite 2 categorias vigiladas y anuncios programados.',
    report: 'Te ayudo con el reporte. Pasame el usuario implicado, que ocurrio, cuando paso y capturas o pruebas si las tienes.',
    problem: 'Te ayudo. Dime que estabas intentando hacer, que error salio y, si puedes, envia captura o el texto exacto del fallo.',
    waiting: 'Sin problema, te espero por aqui. Cuando vuelvas, mandame el siguiente detalle y continuo.',
    ack: 'Perfecto, sigo atento. Cuando quieras, pasame el siguiente detalle.',
    languageSwitch: 'Perfecto, te respondere en español a partir de ahora. Dime que necesitas y seguimos.',
    greeting: 'Hola, estoy aqui. Dime que necesitas y te ayudo con este ticket.',
    secret: 'No puedo buscar, leer ni revelar archivos privados como .env, tokens, claves API o credenciales. Si esto era una prueba de seguridad, bien detectado: puedo ayudarte a revisar la configuracion sin exponer secretos o a rotar claves.',
    raid: 'Esto suena a un posible raid o ataque al servidor. Voy a avisar al staff. Pasame usuario o bot implicado, hora aproximada, que hicieron, canales/roles afectados y pruebas si las tienes.',
    generic: 'Aun no tengo un hecho concreto suficiente para orientar este ticket. Escribeme que ocurrio o el resultado exacto y trabajare desde ese punto.'
  };
}

function getLastUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
}

function expectsJson(system = '') {
  return /JSON valido|SOLO JSON|Responde SOLO JSON|schema exacto|esquema exacto/iu.test(system);
}

function detectFallbackLanguage(text = '', context = '') {
  const latest = normalizeText(text).toLowerCase();
  const recent = normalizeText(context).toLowerCase();

  if (/[\u4E00-\u9FFF]/u.test(latest)) return 'zh';
  if (/\b(espanol|español|castellano|que hables en espanol|que hables en español|habla en espanol|habla en español)\b/iu.test(latest)) return 'es';
  if (/[¿¡ñáéíóúü]/iu.test(latest)) return 'es';
  if (/\b(hola|buenas|vale|gracias|necesito|puedes|podrias|porfa|servidor|ticket|ayuda|problema|fallo|error|staff|moderador|alianza|reporte|examen|vengo|regreso|ahora|afk)\b/iu.test(latest)) return 'es';
  if (/\b(hello|hi|what|how|where|when|why|help|server|ticket|staff|thanks|need|could|please)\b/iu.test(latest)) return 'en';
  if (/\b(hola|buenas|gracias|necesito|servidor|ticket|ayuda|problema)\b/iu.test(recent)) return 'es';
  return 'es';
}

function isLanguageSwitchRequest(text = '') {
  return /\b(que\s+hables\s+en\s+espanol|que\s+hables\s+en\s+español|habla\s+en\s+espanol|habla\s+en\s+español|responde\s+en\s+espanol|responde\s+en\s+español|speak\s+spanish|speak\s+english|answer\s+in\s+english|中文|chinese)\b/iu.test(text);
}

function detectQualityCategory(text = '') {
  if (/\b(imagen|foto|captura|vision|screenshot)\b/iu.test(text)) return 'vision';
  if (/\b(voz|audio|suena|tts|stt)\b/iu.test(text)) return 'voice';
  if (/\b(lento|tarda|esperando|typing)\b/iu.test(text)) return 'latency';
  if (/\b(idioma|ingles|espanol|chino|language)\b/iu.test(text)) return 'language';
  if (/\b(repite|repetitivo|bucle)\b/iu.test(text)) return 'repetition';
  return 'malfunction';
}

function isStaffRequest(text = '') {
  return /\b(humano|staff|moderador|mod|owner|admin|responsable|menciona|mencionales|llama|avis(a|e))\b/iu.test(text)
    && /\b(quiero|necesito|puedes|podrias|porfa|porfavor|manual|ayuda|asistencia|hablar|llamar|avisar)\b/iu.test(text);
}

function isSensitiveAccessRequest(text = '') {
  const hasSecretTarget = [
    /\.env(?:\b|$)/iu,
    /\b(?:archivo|fichero|file)\s+(?:env|\.env|config|configuracion|configuration)\b/iu,
    /\b(?:token|tokens|api\s*key|apikey|clave\s+api|service\s*role|service_role|secret|secreto|password|contrasena|contrase.?a|credenciales|credentials|vault)\b/iu
  ].some((pattern) => pattern.test(text));
  if (!hasSecretTarget) return false;

  return [
    /\b(?:leer|leeme|mostrar|muestrame|ver|dime|decir|cuentame|buscar|encuentra|encontrar|abrir|acceder|consultar|copiar|pasar|pasame|mandar|enviar|revelar|exponer|sacar)\b/iu,
    /\b(?:read|show|find|open|get|tell|send|print|dump|cat|reveal|expose)\b/iu,
    /\b(?:que\s+hay|que\s+contiene|contenido|dentro|inside|contains?)\b/iu,
    /\.env(?:\b|$)/iu
  ].some((pattern) => pattern.test(text));
}

function isRaidReport(text = '') {
  const looksLikeTest = /\b(?:prueba|test|simulacion|simular|tester|laboratorio)\b/iu.test(text);
  const hasVictimSignal = /\b(?:me|nos|mi|nuestro|servidor|server|sv)\b/iu.test(text);
  const hasRaidSignal = [
    /\b(?:raid|raidead[oa]s?|raidearon|raidear|raideo|nuke|nukear|nuked|flood|flooding)\b/iu,
    /\b(?:spam\s+masivo|muchos\s+mensajes|canales\s+borrados|roles\s+borrados|mass\s+spam|mass\s+ping|mass\s+mention)\b/iu,
    /\b(?:atacaron|ataque|invadieron|reventaron|destrozaron)\b.*\b(?:servidor|server|sv)\b/iu
  ].some((pattern) => pattern.test(text));
  if (!hasRaidSignal) return false;
  if (looksLikeTest && !hasVictimSignal) return false;
  return true;
}

function isAllianceInfoQuestion(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  const talksAboutAlliance = /\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboraci[oó]n(?:es)?)\b/iu.test(normalized);
  if (!talksAboutAlliance) return false;
  if (/\b(?:quiero|queria|me\s+gustaria|hacer|realizar|proponer|solicitar|mandar|enviar|ofrecer|crear|tramitar)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboraci[oó]n(?:es)?)\b/iu.test(normalized)) {
    return false;
  }
  return [
    /\b(?:cuales?|que|donde|ver|listar|muestrame|mostrar|saber|conocer)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboraci[oó]n(?:es)?)\b/iu,
    /\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboraci[oó]n(?:es)?)\b.*\b(?:de\s+este\s+servidor|del\s+servidor|tiene|hay|actual(?:es)?|lista|canal|canales|ejemplos?)\b/iu,
    /\b(?:quienes|con\s+quien)\b.*\b(?:alianz(?:a|as)|partner(?:ship)?s?|colaboraci[oó]n(?:es)?)\b/iu
  ].some((pattern) => pattern.test(normalized));
}

function normalizeText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
