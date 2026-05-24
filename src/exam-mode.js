const DEFAULT_PASS_SCORE = 6;

export function normalizeExamConfig(source = {}) {
  const root = source?.exam && typeof source.exam === 'object' ? source.exam : source;
  const questions = normalizeExamQuestions(root.questions ?? source.examQuestions ?? source.questions);
  return {
    enabled: root.enabled === true || source.ticketMode === 'exam',
    reviewEnabled: toBoolean(root.reviewEnabled ?? source.examReviewEnabled, false),
    formUrl: cleanUrl(root.formUrl ?? source.examFormUrl),
    questions,
    passScore: clampNumber(root.passScore ?? source.examPassScore, 0, 10, DEFAULT_PASS_SCORE),
    instructions: cleanString(root.instructions ?? source.examInstructions, '', 1200)
  };
}

export function normalizeExamState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: Boolean(source.enabled),
    mode: source.mode === 'premium_review' ? 'premium_review' : 'free_questions',
    status: source.status || 'idle',
    questions: normalizeExamQuestions(source.questions),
    answers: Array.isArray(source.answers) ? source.answers.map(normalizeExamAnswer).filter(Boolean).slice(0, 40) : [],
    currentIndex: Math.max(0, Number.parseInt(source.currentIndex ?? 0, 10) || 0),
    formUrl: cleanUrl(source.formUrl),
    reviewEnabled: Boolean(source.reviewEnabled),
    passScore: clampNumber(source.passScore, 0, 10, DEFAULT_PASS_SCORE),
    startedAt: source.startedAt || null,
    completedAt: source.completedAt || null,
    lastQuestionAt: source.lastQuestionAt || null,
    evaluation: source.evaluation && typeof source.evaluation === 'object' ? source.evaluation : null,
    reviewRequestedAt: source.reviewRequestedAt || null,
    warnings: Array.isArray(source.warnings) ? source.warnings.slice(0, 20) : []
  };
}

export function isExamTicketMode(mode) {
  return String(mode ?? '').toLowerCase() === 'exam';
}

export function isExamReviewRequest(content = '') {
  const normalized = normalizePlain(content);
  return /\b(solicito|quiero|pido|necesito|puedo\s+pedir|me\s+gustaria)\s+(?:una\s+)?(?:revision|revisar|revisen)\b/u.test(normalized)
    || /\brevision\s+(?:manual|humana|staff)\b/u.test(normalized);
}

export function isExamCancelRequest(content = '') {
  return /\b(cancelar|cancela|anular|anula|terminar|salir)\s+(?:el\s+)?examen\b/u.test(normalizePlain(content));
}

export function buildExamQuestionPrompt(state) {
  const current = state.questions[state.currentIndex];
  const total = state.questions.length;
  return [
    `**Pregunta ${state.currentIndex + 1}/${total}**`,
    current,
    '',
    'Responde en un solo mensaje. Si necesitas revision humana al final, podras solicitarla.'
  ].join('\n');
}

export function buildExamAnswerRecord({ question, answer, askedAt }) {
  const answeredAt = new Date().toISOString();
  const responseSeconds = secondsBetween(askedAt, answeredAt);
  const flags = [];
  if (responseSeconds !== null && responseSeconds <= 4 && String(answer).trim().length >= 220) {
    flags.push('respuesta larga enviada muy rapido: posible pegado');
  }
  if (looksLikeAiGeneratedText(answer)) {
    flags.push('redaccion muy generica/estructurada: revisar posible IA');
  }

  return {
    question,
    answer: String(answer ?? '').trim().slice(0, 2200),
    askedAt: askedAt || null,
    answeredAt,
    responseSeconds,
    flags
  };
}

export function parseExamEvaluationJson(value = '', fallback = {}) {
  try {
    const json = String(value).match(/\{[\s\S]*\}/)?.[0] ?? value;
    const parsed = JSON.parse(json);
    const score = clampNumber(parsed.score, 0, 10, fallback.score ?? 0);
    return {
      score,
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : score >= (fallback.passScore ?? DEFAULT_PASS_SCORE),
      summary: cleanString(parsed.summary, 'Examen corregido.', 900),
      strengths: normalizeStringArray(parsed.strengths).slice(0, 5),
      concerns: normalizeStringArray(parsed.concerns).slice(0, 6),
      manualReviewRecommended: Boolean(parsed.manualReviewRecommended),
      aiGeneratedSuspicion: clampNumber(parsed.aiGeneratedSuspicion, 0, 100, 0),
      perQuestion: Array.isArray(parsed.perQuestion)
        ? parsed.perQuestion.slice(0, 40).map((item, index) => ({
            index: Number.parseInt(item.index ?? index + 1, 10) || index + 1,
            score: clampNumber(item.score, 0, 10, 0),
            feedback: cleanString(item.feedback, '', 500)
          }))
        : []
    };
  } catch {
    return buildHeuristicExamEvaluation(fallback.examState, fallback);
  }
}

export function buildHeuristicExamEvaluation(examState = {}, fallback = {}) {
  const state = normalizeExamState(examState);
  const passScore = clampNumber(state.passScore ?? fallback.passScore, 0, 10, DEFAULT_PASS_SCORE);
  const answers = state.answers ?? [];

  if (!answers.length) {
    return {
      score: clampNumber(fallback.score, 0, 10, 0),
      passed: false,
      summary: 'No hay respuestas suficientes para corregir el examen automaticamente.',
      strengths: [],
      concerns: ['Sin respuestas registradas.'],
      manualReviewRecommended: true,
      aiGeneratedSuspicion: 0,
      perQuestion: []
    };
  }

  const scoredAnswers = answers.map((item, index) => scoreExamAnswer(item, index));
  const answeredRatio = state.questions.length ? answers.length / state.questions.length : 1;
  const baseAverage = average(scoredAnswers.map((item) => item.score));
  const warningCount = state.warnings.length + answers.reduce((total, item) => total + (item.flags?.length ?? 0), 0);
  const completionPenalty = answeredRatio < 0.95 ? (1 - answeredRatio) * 2 : 0;
  const warningPenalty = Math.min(1.2, warningCount * 0.18);
  const score = clampNumber(baseAverage - completionPenalty - warningPenalty, 0, 10, 0);
  const passed = score >= passScore;

  const strengths = inferExamStrengths(answers);
  const concerns = inferExamConcerns({ answers, scoredAnswers, state, warningCount, passScore, score });
  const aiGeneratedSuspicion = clampNumber(
    Math.round(Math.min(92, warningCount * 22 + scoredAnswers.filter((item) => item.generic).length * 8)),
    0,
    100,
    0
  );

  return {
    score,
    passed,
    summary: [
      'Correccion automatica generada con evaluador interno de respaldo.',
      passed ? 'Las respuestas cubren la mayoria de criterios esperados.' : 'Las respuestas necesitan mas detalle o revision humana.'
    ].join(' '),
    strengths,
    concerns,
    manualReviewRecommended: warningCount > 0 || Math.abs(score - passScore) <= 1,
    aiGeneratedSuspicion,
    perQuestion: scoredAnswers.slice(0, 8).map((item) => ({
      index: item.index,
      score: item.score,
      feedback: item.feedback
    }))
  };
}

export function formatExamEvaluation(evaluation, state) {
  const score = Number(evaluation.score ?? 0);
  const passed = evaluation.passed;
  const lines = [
    `**Resultado provisional del examen:** ${score.toFixed(1)}/10`,
    passed ? 'Estado: **apto provisional**.' : 'Estado: **no apto provisional**.',
    evaluation.summary ? `Resumen: ${evaluation.summary}` : '',
    evaluation.strengths?.length ? `Puntos fuertes: ${evaluation.strengths.join('; ')}` : '',
    evaluation.concerns?.length ? `A revisar: ${evaluation.concerns.join('; ')}` : '',
    evaluation.aiGeneratedSuspicion >= 60 ? `Aviso: posible uso de IA (${evaluation.aiGeneratedSuspicion}%). Staff deberia revisarlo.` : '',
    state.warnings?.length ? `Senales automaticas: ${state.warnings.join('; ')}` : '',
    '',
    'Si no estas de acuerdo, escribe **solicito revision** y avisare al staff. La IA se desactivara para que lo revise una persona.'
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1900);
}

export function buildExamEvaluationInput(state) {
  return state.answers.map((item, index) => [
    `Pregunta ${index + 1}: ${item.question}`,
    `Respuesta: ${item.answer}`,
    item.responseSeconds !== null ? `Tiempo de respuesta: ${item.responseSeconds}s` : null,
    item.flags?.length ? `Senales: ${item.flags.join('; ')}` : null
  ].filter(Boolean).join('\n')).join('\n\n');
}

function normalizeExamQuestions(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:P|Q|Pregunta)\s*[:.)-]\s*/iu, '').trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((question) => cleanString(question, '', 180))
    .filter(Boolean);
}

function scoreExamAnswer(item, index) {
  const answer = cleanString(item.answer, '', 2200);
  const normalized = normalizePlain(answer);
  const question = normalizePlain(item.question);
  const words = answer.split(/\s+/).filter(Boolean).length;
  let score = 4;

  if (words >= 3) score += 0.6;
  if (words >= 8) score += 0.9;
  if (words >= 18) score += 0.9;
  if (words >= 35) score += 0.55;
  if (words >= 75) score += 0.3;
  if (/\b(no se|ni idea|da igual|lo que sea|porque si)\b/u.test(normalized)) score -= 2;

  const positiveSignals = [
    /\b(staff|moderador|humano|superior|owner)\b/u,
    /\b(prueba|captura|evidencia|contexto|detalle|transcripcion)\b/u,
    /\b(permiso|rol|categoria|configuracion|dashboard|supabase)\b/u,
    /\b(escalar|avisar|mencionar|revisar|calmar|resolver)\b/u,
    /\b(seguridad|blacklist|xn protect|link|malicioso|sospechoso)\b/u,
    /\b(privacidad|contrasena|datos|sensible|bancario)\b/u,
    /\b(emergencia|profesional|confianza|peligro|suicid)\b/u
  ];
  score += Math.min(2.6, positiveSignals.filter((pattern) => pattern.test(normalized)).length * 0.55);
  score = Math.max(score, scoreTargetedExamAnswer({ question, answer: normalized }));

  if (item.responseSeconds !== null && item.responseSeconds <= 4 && words >= 55) score -= 0.8;
  if (item.flags?.length) score -= Math.min(1.2, item.flags.length * 0.45);

  const generic = looksLikeGenericAnswer(normalized, words);
  if (generic) score -= 0.35;

  return {
    index: index + 1,
    score: Math.round(clampNumber(score, 0, 10, 0) * 10) / 10,
    generic,
    feedback: buildQuestionFeedback({ answer, words, score, flags: item.flags ?? [] })
  };
}

function scoreTargetedExamAnswer({ question, answer }) {
  if (/\bcomando\b/u.test(question) && /\/desactivar\s+ia\b/u.test(answer)) return 9.4;
  if (/\bsuicid|quiere\s+suicidarse\b/u.test(question) && /\b(emergencia|profesional|confianza|peligro|no estas solo)\b/u.test(answer)) return 8.6;
  if (/\bdatos\b/u.test(question) && /\b(contrasena|bancari|documento|sensible|ubicacion|clave)\b/u.test(answer)) return 8.3;
  if (/\blink\b/u.test(question) && /\b(no\s+se\s+debe\s+abrir|sospechoso|seguridad|reportarlo|staff)\b/u.test(answer)) return 7.8;
  if (/\bcaptura|imagen\b/u.test(question) && /\b(analizar|extraer|error|informacion|solucion|escalar)\b/u.test(answer)) return 7.7;
  if (/\bblacklist|xn protect\b/u.test(question) && /\b(riesgo|staff|superior|revis|aviso)\b/u.test(answer)) return 7.5;
  if (/\bsupabase\b/u.test(question) && /\b(ticket|mensaje|configuracion|transcripcion|servidor)\b/u.test(answer)) return 7.2;
  if (/\bticket king\b/u.test(question) && /\b(permiso|categoria|configuracion|ia|ticket|estado|limitacion)\b/u.test(answer)) return 7.1;
  if (/\bcanales privados\b/u.test(question) && /\b(permiso|rol|categoria|configuracion|restriccion)\b/u.test(answer)) return 7.6;
  if (/\bescalar\b/u.test(question) && /\b(staff|superior|informacion|contexto|resolver)\b/u.test(answer)) return 7.4;
  if (/\balianza\b/u.test(question) && /\b(plantilla|norma|captura|canal|alianza)\b/u.test(answer)) return 7.5;
  if (/\balianza\b/u.test(question) && /\bstaff\b/u.test(answer)) return 5.8;
  if (/\bhumano\b/u.test(question) && /\b(humano|manual|cargo|calmar|atender)\b/u.test(answer)) return 7.4;
  return 0;
}

function buildQuestionFeedback({ answer, words, score, flags }) {
  if (!answer.trim()) return 'Sin respuesta.';
  if (flags.length) return `Respuesta valida, pero con senales a revisar: ${flags.join(', ')}.`;
  if (score >= 7) return 'Respuesta clara y alineada con el rol.';
  if (words < 12) return 'Respuesta demasiado corta; conviene aportar mas criterio y contexto.';
  return 'Respuesta aceptable, aunque podria concretar mejor los pasos.';
}

function inferExamStrengths(answers) {
  const text = normalizePlain(answers.map((item) => item.answer).join('\n'));
  const strengths = [];
  if (/\b(staff|moderador|humano|superior)\b/u.test(text)) strengths.push('entiende cuando debe intervenir el staff humano');
  if (/\b(prueba|captura|evidencia|contexto|transcripcion)\b/u.test(text)) strengths.push('pide pruebas y contexto antes de actuar');
  if (/\b(contrasena|datos bancarios|documentos|informacion sensible|privacidad)\b/u.test(text)) strengths.push('reconoce datos sensibles que no se deben pedir');
  if (/\b(emergencia|profesional|confianza|peligro|suicid)\b/u.test(text)) strengths.push('trata casos de crisis con prudencia');
  if (/\b(permiso|rol|categoria|dashboard|configuracion|supabase)\b/u.test(text)) strengths.push('conoce partes importantes de configuracion de NexaDesk');
  return strengths.slice(0, 5);
}

function inferExamConcerns({ answers, scoredAnswers, state, warningCount, passScore, score }) {
  const concerns = [];
  const shortAnswers = scoredAnswers.filter((item) => item.score < 5).length;
  if (state.questions.length && answers.length < state.questions.length) concerns.push('faltan preguntas por responder');
  if (shortAnswers >= 3) concerns.push('varias respuestas son demasiado breves');
  if (warningCount > 0) concerns.push('hay senales automaticas de respuesta pegada o posible IA');
  if (score < passScore) concerns.push('no alcanza la nota minima configurada');
  if (Math.abs(score - passScore) <= 1) concerns.push('resultado cercano al corte: recomendable revision humana');
  return concerns.slice(0, 6);
}

function looksLikeGenericAnswer(normalized, words) {
  if (words < 18) return false;
  let score = 0;
  if (/\b(es importante|se debe|hay que|correctamente|adecuadamente)\b/u.test(normalized)) score += 1;
  if (/\b(usuario|staff|servidor)\b/u.test(normalized) && !/\b(captura|rol|categoria|ticket king|supabase|xn protect|emergencia)\b/u.test(normalized)) score += 1;
  return score >= 2;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value)));
  if (!valid.length) return 0;
  return valid.reduce((total, value) => total + Number(value), 0) / valid.length;
}

function normalizeExamAnswer(item) {
  if (!item || typeof item !== 'object') return null;
  const question = cleanString(item.question, '', 180);
  const answer = cleanString(item.answer, '', 2200);
  if (!question || !answer) return null;
  return {
    question,
    answer,
    askedAt: item.askedAt || null,
    answeredAt: item.answeredAt || null,
    responseSeconds: Number.isFinite(Number(item.responseSeconds)) ? Math.max(0, Math.round(Number(item.responseSeconds))) : null,
    flags: normalizeStringArray(item.flags).slice(0, 6)
  };
}

function looksLikeAiGeneratedText(value = '') {
  const text = String(value ?? '').trim();
  if (text.length < 260) return false;
  const normalized = text.toLowerCase();
  let score = 0;
  if (/\b(en conclusion|por otro lado|ademas|asimismo|cabe destacar|es importante mencionar|desde mi punto de vista)\b/u.test(normalized)) score += 1;
  if (/\b(como modelo|no tengo experiencias personales|no puedo tener opiniones)\b/u.test(normalized)) score += 3;
  if ((text.match(/[.;:]/g) ?? []).length >= 8 && text.split(/\s+/).length >= 80) score += 1;
  if (/\b(primero|segundo|tercero|finalmente)\b/u.test(normalized)) score += 1;
  return score >= 2;
}

function secondsBetween(start, end) {
  const a = Date.parse(start ?? '');
  const b = Date.parse(end ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item, '', 500)).filter(Boolean);
}

function cleanString(value, fallback = '', maxLength = 500) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (['true', '1', 'yes', 'on', 'si'].includes(normalizePlain(value))) return true;
  if (['false', '0', 'no', 'off'].includes(String(value ?? '').toLowerCase())) return false;
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizePlain(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
