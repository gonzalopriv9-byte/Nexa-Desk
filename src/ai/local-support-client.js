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

  if (/\b(captura|imagen|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(text)) {
    return reply.image;
  }

  if (/\b(staff|mod|moderador|postular|postulaci[oó]n|quiero\s+ser\s+staff)\b/iu.test(text)) {
    return reply.staffApplication;
  }

  if (isRaidReport(text)) {
    return `[ESCALATE] ${reply.raid ?? getLocalizedReplies('en').raid}`;
  }

  if (isAllianceInfoQuestion(text)) {
    return reply.allianceInfo;
  }

  if (/\b(alianza|partner|partnership|colaboraci[oó]n)\b/iu.test(text)) {
    return reply.alliance;
  }

  if (/\b(acoso|amenaza|insulto|reportar|reporte|abuso|raid|raidead[oa]|nuke|flood|spam\s+masivo|harassment|threat|report)\b/iu.test(text)) {
    return reply.report;
  }

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
  if (language === 'zh') {
    return {
      staff: '我会联系人工工作人员，因为这个情况需要人工处理。',
      crisis: '我会立刻升级给人工处理。请先远离危险，并马上联系当地紧急服务或身边可信任的人。',
      panels: '要删除面板，请打开仪表盘，选择服务器，进入 Panels/Paneles，然后使用已发布面板旁边的删除选项。',
      image: '我已收到图片。如果看不清，请发送更清晰的截图或复制错误文字，我会继续帮你判断。',
      staffApplication: '如果你想申请 staff，请告诉我你想申请的岗位或区域；如果需要人工审核，我会联系 staff。',
      allianceInfo: '我会先查看服务器真实频道和上下文，不会在你没有明确要求时启动联盟申请流程。',
      alliance: '如果要申请联盟，请发送你的服务器模板，包括邀请链接、成员数量、主题、你们提供什么以及负责人联系方式。',
      report: '我可以帮你整理举报。请发送相关用户、发生了什么、时间，以及截图或证据。',
      problem: '我可以帮你。请告诉我你原本想做什么、出现了什么错误；如果可以，请发送截图或错误文字。',
      waiting: '没问题，我会在这里等你。你回来后把下一条关键信息发给我，我继续处理。',
      ack: '好的，我还在。你准备好后把下一步信息发给我。',
      languageSwitch: '好的，我会用中文回复。请告诉我你需要什么，我会继续帮你。',
      greeting: '你好，我在。告诉我你需要什么，我会帮你处理这个 ticket。',
      generic: '我在。请把最关键的信息发给我，我会根据现有内容继续处理，不会乱猜。'
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
      report: 'I can help with the report. Send the user involved, what happened, when it happened and any screenshots or proof you have.',
      problem: 'I can help. Tell me what you were trying to do, what error appeared and, if possible, send a screenshot or the exact text of the error.',
      waiting: 'No problem, I will wait here. When you come back, send the next detail and I will continue.',
      ack: 'Perfect, I am still here. Send me the next detail whenever you are ready.',
      languageSwitch: 'Perfect, I will answer in English from now on. Tell me what you need and I will continue.',
      greeting: 'Hi, I am here. Tell me what you need and I will help you with this ticket.',
      secret: 'I cannot search, read or reveal private files such as .env, tokens, API keys or credentials. If this is a security test, good catch: I can help review variable names or rotation steps safely.',
      raid: 'This sounds like a possible raid or server attack. I will bring staff in. Send the user/bot involved, approximate time, what they did, affected channels/roles and any screenshots or proof you have.',
      generic: 'I am with you. Send me the key detail of what happened and I will continue from there without guessing.'
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
    report: 'Te ayudo con el reporte. Pasame el usuario implicado, que ocurrio, cuando paso y capturas o pruebas si las tienes.',
    problem: 'Te ayudo. Dime que estabas intentando hacer, que error salio y, si puedes, envia captura o el texto exacto del fallo.',
    waiting: 'Sin problema, te espero por aqui. Cuando vuelvas, mandame el siguiente detalle y continuo.',
    ack: 'Perfecto, sigo atento. Cuando quieras, pasame el siguiente detalle.',
    languageSwitch: 'Perfecto, te respondere en español a partir de ahora. Dime que necesitas y seguimos.',
    greeting: 'Hola, estoy aqui. Dime que necesitas y te ayudo con este ticket.',
    secret: 'No puedo buscar, leer ni revelar archivos privados como .env, tokens, claves API o credenciales. Si esto era una prueba de seguridad, bien detectado: puedo ayudarte a revisar la configuracion sin exponer secretos o a rotar claves.',
    raid: 'Esto suena a un posible raid o ataque al servidor. Voy a avisar al staff. Pasame usuario o bot implicado, hora aproximada, que hicieron, canales/roles afectados y pruebas si las tienes.',
    generic: 'Sigo contigo. Pasame el detalle principal de lo que ocurre y avanzo desde ahi sin inventar.'
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
