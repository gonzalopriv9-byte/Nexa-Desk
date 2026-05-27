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
  const context = normalizeText(messages.map((message) => message.content).join('\n'));
  const language = detectFallbackLanguage(text, system);
  const reply = getLocalizedReplies(language);

  if (isStaffRequest(text)) {
    return `[ESCALATE] ${reply.staff}`;
  }

  if (/\b(suicid|matarme|me\s+voy\s+a\s+tirar|self.?harm|kill myself)\b/iu.test(text)) {
    return `[ESCALATE] ${reply.crisis}`;
  }

  if (/\b(panel|paneles|borrar|eliminar|delete|remove)\b/iu.test(text) && /\b(dashboard|panel|paneles|web|opcion|opci[oó]n)\b/iu.test(context)) {
    return reply.panels;
  }

  if (/\b(captura|imagen|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(text)) {
    return reply.image;
  }

  if (/\b(staff|mod|moderador|postular|postulaci[oó]n|quiero\s+ser\s+staff)\b/iu.test(text)) {
    return reply.staffApplication;
  }

  if (/\b(alianza|partner|partnership|colaboraci[oó]n)\b/iu.test(text)) {
    return reply.alliance;
  }

  if (/\b(acoso|amenaza|insulto|reportar|reporte|abuso|harassment|threat|report)\b/iu.test(text)) {
    return reply.report;
  }

  if (/\b(error|fallo|problema|no\s+funciona|bug|issue)\b/iu.test(text)) {
    return reply.problem;
  }

  if (/^(hola|buenas|hey|hi|hello|buenos dias|buenas tardes)[!.?\s]*$/iu.test(text)) {
    return reply.greeting;
  }

  return reply.generic;
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
  if (language === 'en') {
    return {
      staff: 'I will bring a human staff member in because this needs manual attention.',
      crisis: 'I am escalating this immediately. Please stay where you are, move away from danger if you can, and contact emergency services or someone you trust right now.',
      panels: 'To delete panels, open the dashboard, choose your server, go to Panels, then use the delete option on the published panel. If it does not appear, staff should check your dashboard permissions.',
      image: 'I received the image. If it is not readable, send a clearer screenshot or paste the exact error text so I can continue without guessing.',
      staffApplication: 'If you want to apply for staff, tell me the role or area you want and I will help prepare the application or call staff if this server handles it manually.',
      alliance: 'For an alliance, send your server template with the invite, member count, theme, what you offer and a contact person. I will keep it organized for staff.',
      report: 'I can help with the report. Send the user involved, what happened, when it happened and any screenshots or proof you have.',
      problem: 'I can help. Tell me what you were trying to do, what error appeared and, if possible, send a screenshot or the exact text of the error.',
      greeting: 'Hi, I am here. Tell me what you need and I will help you with this ticket.',
      generic: 'I am with you. Send me the key detail of what happened and I will continue from there without guessing.'
    };
  }

  return {
    staff: 'Voy a avisar a un miembro del staff porque esto necesita atencion manual.',
    crisis: 'Voy a escalar esto de inmediato. Por favor, alejate del peligro si puedes y contacta ahora con emergencias o con una persona de confianza cercana.',
    panels: 'Para eliminar paneles: entra en la dashboard, elige tu servidor, ve a Paneles y usa la opcion de eliminar en el panel publicado. Si no aparece, el staff debe revisar tus permisos en la dashboard.',
    image: 'He recibido la imagen. Si no se lee bien, mandame una captura mas clara o copia el texto exacto del error para seguir sin inventar.',
    staffApplication: 'Si quieres postular a staff, dime el area o rol al que quieres entrar y te ayudo a preparar la postulacion; si el servidor lo gestiona manualmente, aviso al staff.',
    alliance: 'Para una alianza, enviame la plantilla de tu servidor con invitacion, miembros, tematica, que ofreceis y contacto responsable. La dejo ordenada para revision.',
    report: 'Te ayudo con el reporte. Pasame el usuario implicado, que ocurrio, cuando paso y capturas o pruebas si las tienes.',
    problem: 'Te ayudo. Dime que estabas intentando hacer, que error salio y, si puedes, envia captura o el texto exacto del fallo.',
    greeting: 'Hola, estoy aqui. Dime que necesitas y te ayudo con este ticket.',
    generic: 'Sigo contigo. Pasame el detalle principal de lo que ocurre y avanzo desde ahi sin inventar.'
  };
}

function getLastUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
}

function expectsJson(system = '') {
  return /JSON valido|SOLO JSON|Responde SOLO JSON|schema exacto|esquema exacto/iu.test(system);
}

function detectFallbackLanguage(text = '', system = '') {
  const source = `${text}\n${system}`;
  if (/\b(hello|hi|what|how|where|when|why|help|server|ticket|staff)\b/iu.test(source)) return 'en';
  return 'es';
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

function normalizeText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
