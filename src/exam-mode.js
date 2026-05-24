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
        ? parsed.perQuestion.slice(0, 25).map((item, index) => ({
            index: Number.parseInt(item.index ?? index + 1, 10) || index + 1,
            score: clampNumber(item.score, 0, 10, 0),
            feedback: cleanString(item.feedback, '', 500)
          }))
        : []
    };
  } catch {
    return {
      score: clampNumber(fallback.score, 0, 10, 0),
      passed: false,
      summary: 'No pude leer la correccion automatica como JSON. Solicita revision manual.',
      strengths: [],
      concerns: ['Formato de correccion no valido.'],
      manualReviewRecommended: true,
      aiGeneratedSuspicion: 0,
      perQuestion: []
    };
  }
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
    .slice(0, 25)
    .map((question) => cleanString(question, '', 180))
    .filter(Boolean);
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
