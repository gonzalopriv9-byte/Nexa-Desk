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
  // Keep the original transcript for evidence, but use a conservative intent
  // normalizer for obvious STT/phonetic misspellings before routing the reply.
  const text = normalizeSupportIntentText(lastUser);
  const rawLastUser = String(lastUser ?? '').trim();
  const context = normalizeText(messages.map((message) => message.content).join('\n'));
  const language = detectFallbackLanguage(text, context);
  const reply = getLocalizedReplies(language);

  if (isLanguageSwitchRequest(text)) {
    return reply.languageSwitch;
  }

  const safeReply = buildSafeSupportReply({ text: lastUser, language, context, messages });
  if (safeReply) return safeReply;

  if (isSensitiveAccessRequest(text)) {
    return reply.secret ?? getLocalizedReplies('en').secret;
  }

  const publicResourceReply = buildPublicResourceReply({ text, language });
  if (publicResourceReply) return publicResourceReply;

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

  // Reports about the web/service are technical incidents, not reports
  // against a Discord member. Keep this before the generic report matcher.
  if (isWebIssueMessage(text)) {
    return reply.webIssue;
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

function buildPublicResourceReply({ text = '', language = 'es' } = {}) {
  const normalized = normalizeText(text);
  const asksToLocate = /\b(?:donde|en\s+que|ver|buscar|busco|consultar|consulta|comprobar|comprobarlo|saber\s+si|aparece|registro|enlace|link|web|pagina|página|como\s+busco)\b/iu.test(normalized);
  const mentionsBlacklist = /\b(?:blacklist|blacklists|lista\s+negra|baneo(?:s)?\s+global(?:es)?|global\s+bans?|registro(?:s)?\s+de\s+blacklist)\b/iu.test(normalized);
  if (!mentionsBlacklist || !asksToLocate) return '';

  if (language === 'en') {
    return 'You can search the public NexaDesk blacklist at <https://nexa-desk.com/blacklist>. Enter the Discord user ID to see the public record available.';
  }
  return 'Puedes consultar la blacklist pública de NexaDesk en <https://nexa-desk.com/blacklist>. Introduce el ID de Discord para ver el registro público disponible.';
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
  if (/\b(?:verific(?:acion(?:es)?|arme|ame|arte|ate|arse|ase|ado(?:s|as)?|ar)?|captcha|rol(?:es)?|verified|verify)\b/iu.test(normalized)) {
    return { key: 'verification', labelEs: 'la verificacion', labelEn: 'verification', labelZh: '验证信息', terms: ['verificacion', 'verificar', 'captcha', 'rol', 'verified', 'verify'] };
  }
  if (/\b(?:estadistic(?:a|as)|m[eé]trica(?:s)?|stats|global(?:es)?|ranking|datos)\b/iu.test(normalized)) {
    return { key: 'statistics', labelEs: 'las estadisticas globales', labelEn: 'global statistics', labelZh: '全局统计', terms: ['estadistica', 'estadisticas', 'metrica', 'metricas', 'stats', 'global', 'ranking', 'datos'] };
  }
  if (/\b(?:comando(?:s)?|command(?:s)?|slash|orden(?:es)?|uso(?:s)?)\b/iu.test(normalized)) {
    return { key: 'commands', labelEs: 'los comandos disponibles', labelEn: 'the available commands', labelZh: '命令', terms: ['comando', 'comandos', 'command', 'commands', 'slash', 'orden', 'ordenes', 'uso', 'usos'] };
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
function isPoliteSignoff(value = '') {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!normalized || /[?¿]/u.test(String(value))) return false;

  const hasThanks = /\b(?:gracias|muchas\s+gracias|thanks|thank\s+you)\b/iu.test(normalized);
  const hasClosure = /\b(?:vale|ok|okay|perfecto|bueno|pues|nada|no\s+pasa\s+nada|de\s+nada|hasta\s+luego|adios|bye)\b/iu.test(normalized);
  const hasOperationalSignal = /\b(?:reportar|reporte|ayuda|necesito|quiero|puedes|podrias|no\s+ funciona|no\s+ responde|fallo|problema|bug|issue|captura|screenshot|sigue|continua|aparece|se\s+ rompe|cerrar|cierra)\b/iu.test(normalized);
  return hasThanks && hasClosure && !hasOperationalSignal;
}

function buildPoliteSignoffReply(language = 'es') {
  if (language === 'en') return 'You are welcome. If you need anything else, I am here.';
  if (language === 'zh') return '不客气。如果还需要帮助，随时告诉我。';
  return 'De nada. Si necesitas algo mas, aqui estoy.';
}

export function buildSafeSupportReply({ text = '', language = 'es', context = '', messages = [] } = {}) {
  const normalized = normalizeSupportIntentText(text);
  const reply = getLocalizedReplies(language);

  if (isPoliteSignoff(normalized)) return buildPoliteSignoffReply(language);
  if (isChildAgeStatement(normalized)) return reply.age;

  const generalKnowledgeReply = buildGeneralKnowledgeReply(normalized, language);
  if (generalKnowledgeReply) return generalKnowledgeReply;

  const noisyMessageReply = buildNoisyMessageReply(normalized, reply);
  if (noisyMessageReply) return noisyMessageReply;

  if (isWebIssueMessage(normalized)) return reply.webIssue;
  if (isReportOpening(normalized)) return reply.reportOpening;

  return '';
}

function isReportOpening(value = '') {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const reportVerb = /\b(?:reportar|reporte|reporto|denunciar|denuncia|queja|quejarme|report)\b/iu.test(normalized);
  const hasPersonOrIncident = /\b(?:usuario|user|miembro|persona|alguien|insult|amenaz|acoso|abuso|spam|estafa|phishing|racismo|discriminacion|chantaje|dox)\b|<@!?\d{16,24}>/iu.test(normalized);
  const hasWebTarget = /\b(?:web|pagina|sitio|dashboard|panel\s+web|bug|error|fallo|problema)\b/iu.test(normalized);
  return reportVerb && !hasPersonOrIncident && !hasWebTarget;
}

export function sanitizePublicSupportReply({ answer = '', latestText = '', language = 'es', context = '' } = {}) {
  const cleaned = String(answer ?? '').trim();
  if (!cleaned) return '';

  if (isPoliteSignoff(latestText)) return buildPoliteSignoffReply(language);

  const hadEscalationMarker = /^\s*\[ESCALATE\]/i.test(cleaned);
  const withEscalationMarker = (value) => hadEscalationMarker ? `[ESCALATE] ${value}` : value;
  const hasInternalReasoningLeak = /\b(?:he\s+entendido\s+el\s+dato\s+nuevo|la\s+señal\s+aporta|la\s+respuesta\s+debe\s+partir|el\s+texto\s+exacto\s+ya\s+es\s+accionable|i\s+understood\s+the\s+new\s+concrete\s+fact|the\s+response\s+should\s+start\s+from|fallback\s+(?:local|de\s+emergencia)|prompt\s+interno|chain\s+of\s+thought)\b/iu.test(cleaned);
  if (!hasInternalReasoningLeak) return cleaned;

  const safeReply = buildSafeSupportReply({ text: latestText, language, context });
  if (safeReply) return withEscalationMarker(safeReply);

  const groundedReply = buildGroundedSupportFallback({
    lastUser: latestText,
    text: latestText,
    context,
    language
  });
  if (groundedReply) return withEscalationMarker(groundedReply);

  if (language === 'en') return withEscalationMarker('I will focus on your latest message and give you a direct answer without restarting the ticket.');
  if (language === 'zh') return withEscalationMarker('我会直接处理你最新的消息，不会重新开始询问。');
  return withEscalationMarker('Voy a centrarme en tu ultimo mensaje y darte una respuesta directa, sin reiniciar el ticket.');
}

function isChildAgeStatement(value = '') {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const agePattern = /\b(?:tengo|soy)\s+(?:\d{1,2}|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:anos|years)\b/iu;
  if (!agePattern.test(normalized)) return false;
  const remainder = normalized.replace(agePattern, ' ').trim();
  if (!remainder) return true;
  // Keep the friendly age adaptation for a simple follow-up question, but do
  // not let it mask a report, incident, access problem or technical failure.
  return /[?¿]/u.test(remainder)
    && !/\b(?:reportar|reporte|denunciar|usuario|miembro|persona|amenaza|acoso|abuso|spam|estafa|phishing|web|pagina|dashboard|error|fallo|problema|bug|no\s+funciona|staff|moderador|seguridad|permiso)\b/iu.test(remainder);
}

function isWebIssueMessage(value = '') {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const webTarget = /\b(?:web|pagina|sitio|dashboard|panel\s+web|enlace|link|nexadesk\.com)\b/iu.test(normalized);
  const failure = /\b(?:mal\s+funcionamiento|no\s+funciona|fallo|error|bug|problema|caida|caido|roto|reportar|reporte)\b/iu.test(normalized);
  return webTarget && failure;
}

function buildGeneralKnowledgeReply(value = '', language = 'es') {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const answers = [];
  const add = (spanish, english, chinese) => {
    answers.push(language === 'en' ? english : language === 'zh' ? chinese : spanish);
  };

  if (/\b(?:por\s+que|porque)\b.*\bcielo\b.*\bazul\b/iu.test(normalized)) {
    add(
      'El cielo parece azul porque la luz del Sol se dispersa en la atmosfera y el azul se dispersa mas que otros colores.',
      'The sky looks blue because sunlight scatters in the atmosphere, and blue light scatters more than many other colours.',
      '天空看起来是蓝色的，因为阳光在大气中散射，而蓝光比许多其他颜色散射得更多。'
    );
  }
  if (/\b(?:cuantas?|numero\s+de)\b.*\bpatas\b.*\b(?:arana|insecto)\b/iu.test(normalized)) {
    add(
      'Una araña suele tener ocho patas.',
      'A spider usually has eight legs.',
      '蜘蛛通常有八条腿。'
    );
  }
  if (/\b(?:banana|platano|platanos)\b/iu.test(normalized) && /\b(?:que\s+es|fruta|comida|amarill)\b/iu.test(normalized)) {
    add(
      'El plátano o banana es una fruta.',
      'A banana is a fruit.',
      '香蕉是一种水果。'
    );
  }
  if (/\b(?:gato|miau)\b/iu.test(normalized) && /\b(?:sonido|ruido|hace|dice|maulla)\b/iu.test(normalized)) {
    add(
      'Un gato suele hacer «miau».',
      'A cat usually says “meow”.',
      '猫通常会“喵喵”叫。'
    );
  }
  if (/\b2\s*\+\s*2\b/iu.test(normalized)) {
    add('2 + 2 es 4.', '2 + 2 is 4.', '2 加 2 等于 4。');
  }
  if (/\b(?:despues|siguiente)\b.*\b(?:de\s+)?5\b/iu.test(normalized)) {
    add('Después del 5 viene el 6.', 'The number after 5 is 6.', '5 后面是 6。');
  }
  if (/\bagua\b.*\bmojad|\bmojad.*\bagua\b/iu.test(normalized)) {
    add(
      'Sí, en el lenguaje cotidiano decimos que el agua está mojada: el agua moja otros objetos y sus gotas están cubiertas de agua.',
      'Yes, in everyday language we say water is wet: water makes other objects wet and its drops are surrounded by water.',
      '日常说法里可以说水是湿的：水会让其他物体变湿，水滴本身也被水包围。'
    );
  }
  if (/\b(?:que\s+usamos|usamos)\b.*\bver\b|\bver\b.*\b(?:ojos|usamos)\b/iu.test(normalized)) {
    add('Usamos los ojos para ver.', 'We use our eyes to see.', '我们用眼睛看东西。');
  }
  if (/\bpeces\b/iu.test(normalized) && /\b(?:donde|viven|habitan)\b/iu.test(normalized)) {
    add('Los peces viven en el agua, como ríos, lagos y mares.', 'Fish live in water, such as rivers, lakes and seas.', '鱼生活在水里，比如河流、湖泊和海洋。');
  }
  if (/\b(?:sol|sun)\b.*\bamarill|\bamarill.*\b(?:sol|sun)\b/iu.test(normalized)) {
    add(
      'El Sol suele verse amarillo desde la Tierra por cómo atraviesa su luz la atmósfera; no es amarillo simplemente porque ilumine mucho.',
      'The Sun often looks yellow from Earth because of how its light passes through the atmosphere; it is not yellow simply because it shines brightly.',
      '从地球看太阳常常是黄色的，这是因为阳光穿过大气层的方式；并不是因为它“照得很亮”才是黄色。'
    );
  }

  return answers.length ? answers.join(' ').slice(0, 1800) : '';
}

function buildNoisyMessageReply(value = '', reply = {}) {
  const normalized = normalizeSupportIntentText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/\b(?:no\s+se|no\s+se)\b.*\b(?:como\s+va|hacer|esto)\b/iu.test(normalized)) {
    return 'No pasa nada. Dime qué intentas hacer o en qué parte te atascas y te lo explico paso a paso.';
  }
  if (/\b(?:pregunta|duda)\b/iu.test(normalized) && /\b(?:entiendes|entender|escuchas?)\b/iu.test(normalized)) {
    return 'Sí, te entiendo. Escribe la pregunta como puedas y, si alguna palabra no queda clara, te pediré solo una aclaración.';
  }
  if (/\b(?:pregunta|duda)\b/iu.test(normalized) && normalized.length < 110) {
    return reply.clarify ?? 'Sí, dime tu pregunta y te ayudo.';
  }
  if (/^(?:ah?\s+)?(?:bueno|oye)(?:\s+nexadesk)?[!.?\s]*$/iu.test(normalized)) {
    return reply.ack ?? 'Te leo. Dime qué necesitas.';
  }
  return '';
}

function buildGroundedSupportFallback({ lastUser = '', text = '', context = '', language = 'es' } = {}) {
  const signal = extractConcreteFailureSignal(lastUser);
  if (!signal || isPoliteSignoff(text)) return '';

  const previousVisual = /\b(?:imagen|captura|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(context)
    && !/\b(?:imagen|captura|foto|screenshot|pantallazo|adjunto|image)\b/iu.test(text);
  const quoted = language === 'zh' ? `“${signal.display}”` : `«${signal.display}»`;

  if (language === 'en') {
    return [
      `I can work from the concrete error you sent: ${quoted}.`,
      previousVisual ? 'The earlier image remains useful context, but this exact error is the current result.' : '',
      buildEnglishFailureMeaning(signal.kind),
      'You do not need to repeat it. The next step is to check the affected service or configuration; staff can review it with this exact message if needed.'
    ].filter(Boolean).join(' ');
  }

  if (language === 'zh') {
    return [
      `我可以根据你发来的具体错误继续处理：${quoted}。`,
      previousVisual ? '之前的图片仍然有用，但这条错误信息是当前结果。' : '',
      '不需要重复发送。下一步应检查相关服务或配置；如有需要，工作人员可以根据这条原始错误继续处理。'
    ].filter(Boolean).join(' ');
  }

  return [
    `Puedo trabajar con el error concreto que has enviado: ${quoted}.`,
    previousVisual ? 'La imagen anterior sigue siendo contexto útil, pero este texto exacto es el resultado actual.' : '',
    buildSpanishFailureMeaning(signal.kind),
    'No hace falta que lo repitas. El siguiente paso es revisar el servicio o la configuración afectada; si hace falta, el staff puede continuar con este mensaje exacto.'
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
  return 'Es un fallo concreto. Conserva este texto como evidencia y revisa el servicio afectado antes de repetir la misma accion.';
}

function buildEnglishFailureMeaning(kind) {
  if (kind === 'configuration') return 'This points to missing service configuration, not a problem with your account or the Cloudflare verification. Repeating the checkbox cannot create a missing variable.';
  if (kind === 'service') return 'This points to the host or a remote service failing to respond correctly. It does not by itself mean you did anything wrong; availability, proxy and service logs should be checked.';
  if (kind === 'access') return 'This points to the server rejecting the request or not allowing the access flow to complete. Authentication and the server response should be checked instead of repeating the same action blindly.';
  if (kind === 'client') return 'This points to a loading or client-response failure. Keep the exact text and inspect the failing request before changing steps without evidence.';
  return 'This is a concrete failure. Keep this exact message as evidence and check the affected service before repeating the same action.';
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
      webIssue: '明白了：这是网页或服务故障，不是针对某个用户的举报。请告诉我你当时在做什么，以及出现了什么结果或错误；如果可以，请发送截图。',
      reportOpening: '当然可以。请说明这是针对某个用户的举报，还是网页/服务故障，并告诉我发生了什么。',
      age: '好的，我会用简单的话解释。不需要提供个人资料，告诉我你的问题就可以了。',
      clarify: '我大概明白了。请把你的问题写出来，我会一步一步帮你。',
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
      webIssue: 'Understood: this is a website or service malfunction, not a report against a user. Tell me what you were trying to do and what result or error appeared; send a screenshot if you can.',
      reportOpening: 'Of course. Tell me whether this is a report about a user or a website/service malfunction, and what happened.',
      age: 'Got it. I will explain things simply. You do not need to share personal information; just tell me your question.',
      clarify: 'I think I follow you. Write your question as best you can and I will help step by step.',
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
    webIssue: 'Entendido: no es un reporte contra un usuario, sino un fallo de la web o del servicio. Dime que intentabas hacer y que resultado o error aparecio; si puedes, anade una captura.',
    reportOpening: 'Claro. Dime si el reporte es sobre un usuario o sobre un fallo de la web/servicio, y cuentame que ocurrio.',
    age: 'Vale, te lo explicare de forma sencilla. No necesito datos personales; dime cual es tu duda.',
    clarify: 'Creo que te sigo. Escribe la pregunta como puedas y te ayudo paso a paso.',
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

function normalizeSupportIntentText(value = '') {
  let text = normalizeText(value);
  const replacements = [
    [/\bchinco\b/giu, 'cinco'],
    [/ñengo/giu, 'tengo'],
    [/ñegrunta|ñegunta|ñeñunta/giu, 'pregunta'],
    [/\bkomo\b/giu, 'como'],
    [/\bba\b/giu, 'va'],
    [/\bsto\b/giu, 'esto'],
    [/\bxke\b/giu, 'porque'],
    [/añua/giu, 'agua'],
    [/eña/giu, 'esta'],
    [/moñada/giu, 'mojada'],
    [/ñol/giu, 'sol'],
    [/\bamawillo\b/giu, 'amarillo'],
    [/\bvolque\b/giu, 'porque'],
    [/\btango\b/giu, 'tanto'],
    [/\bentdines\b/giu, 'entiendes'],
    [/\bprjuano\b/giu, 'peruano'],
    [/\bgoy\b/giu, 'soy'],
    [/\bweño\b/giu, 'bueno'],
    [/ñueño/giu, 'bueno'],
    [/oñe/giu, 'oye'],
    [/\bshe\b/giu, 'se'],
    [/\bshi\b/giu, 'si'],
    [/\bell\b/giu, 'el'],
    [/\bmd\b/giu, 'me'],
    [/\bga\s+esgo\b/giu, 'que hago'],
    [/\bk\b/giu, 'que']
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeText(value = '') {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
