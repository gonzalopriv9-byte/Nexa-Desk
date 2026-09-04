const MAX_LESSONS = 40;
const MAX_TRIGGER_CHARS = 180;
const MAX_GUIDANCE_CHARS = 650;
const MAX_TERMS = 14;

const LESSON_TEMPLATES = Object.freeze({
  report: Object.freeze({
    trigger: 'reportar a un usuario, insultos, amenazas o acoso',
    terms: ['reportar', 'reporte', 'denunciar', 'denuncia', 'usuario', 'miembro', 'insulto', 'insultos', 'amenaza', 'amenazas', 'acoso', 'abuso'],
    guidance: 'Confirma que vas a ayudar con el reporte, reconoce lo ocurrido y pide solo usuario implicado, que ocurrio, cuando paso y pruebas. No reinicies la conversacion ni uses una respuesta generica.'
  }),
  malfunction: Object.freeze({
    trigger: 'la IA o el bot funciona mal',
    terms: ['funciona mal', 'no funciona', 'falla', 'error', 'bug', 'roto'],
    guidance: 'Reconoce el fallo y ofrece un siguiente paso concreto. No repitas una frase de espera ni pidas al usuario que vuelva a empezar sin motivo.'
  }),
  wrong_answer: Object.freeze({
    trigger: 'la respuesta no entiende el caso o es incorrecta',
    terms: ['incorrecta', 'incorrecto', 'mal', 'inventas', 'sin sentido', 'no entiendes', 'no me entiendes'],
    guidance: 'Corrige el contenido atendiendo al ultimo mensaje y al contexto anterior. Si falta un dato, pide solo el dato minimo y no inventes.'
  }),
  repetition: Object.freeze({
    trigger: 'la IA repite respuestas o suena pesada',
    terms: ['repetitivo', 'repetida', 'otra vez', 'pesado', 'robotico'],
    guidance: 'Evita repetir la misma frase. Continua desde el ultimo dato aportado y responde con avance real, no con un reinicio del flujo.'
  }),
  language: Object.freeze({
    trigger: 'la IA debe respetar el idioma del ultimo mensaje',
    terms: ['idioma', 'espanol', 'ingles', 'language', 'hablas'],
    guidance: 'Responde en el idioma del ultimo mensaje del usuario y no preguntes que idioma prefiere si ya se puede detectar.'
  }),
  vision: Object.freeze({
    trigger: 'hay una captura o imagen que debe analizarse',
    terms: ['imagen', 'captura', 'foto', 'screenshot', 'video'],
    guidance: 'Usa primero la evidencia visual disponible y describe hechos observables. No preguntes que aparece en la captura si ya fue analizada.'
  }),
  voice: Object.freeze({
    trigger: 'el caso trata de voz o audio',
    terms: ['voz', 'audio', 'tts', 'stt', 'suena'],
    guidance: 'Trata la peticion como un caso de voz o audio y ofrece la accion disponible, sin responder con un flujo de texto generico.'
  }),
  latency: Object.freeze({
    trigger: 'el usuario nota lentitud en la IA',
    terms: ['lento', 'lentisimo', 'tarda', 'demora', 'delay'],
    guidance: 'Da una respuesta breve y accionable. Evita esperas artificiales, reintentos innecesarios y contexto que no ayude a resolver el caso.'
  }),
  tone: Object.freeze({
    trigger: 'la IA debe sonar natural y adecuada',
    terms: ['tono', 'robotico', 'robotica', 'frio', 'pesado'],
    guidance: 'Mantén un tono natural, cercano y profesional. No uses plantillas defensivas ni menciones reglas internas.'
  }),
  anger: Object.freeze({
    trigger: 'el usuario esta enfadado con la IA',
    terms: ['enfadado', 'cabrea', 'harto', 'mierda', 'idiota', 'subnormal', 'inutil'],
    guidance: 'No discutas ni regañes. Reconoce el problema en una frase y pasa directamente a una solución o al siguiente dato necesario.'
  }),
  general: Object.freeze({
    trigger: 'el usuario expresa frustracion con la IA',
    terms: ['ayudas', 'sirves', 'frustrado', 'mal', 'problema'],
    guidance: 'Prioriza resolver el ultimo mensaje con una respuesta concreta. No uses una frase generica de continuidad si ya hay datos suficientes.'
  })
});

const VALID_CATEGORIES = new Set(Object.keys(LESSON_TEMPLATES));

export function normalizeAiLearning(value = []) {
  const source = Array.isArray(value) ? value : [];
  const byId = new Map();
  for (const item of source) {
    const normalized = normalizeLesson(item);
    if (!normalized) continue;
    const previous = byId.get(normalized.id);
    if (!previous) {
      byId.set(normalized.id, normalized);
      continue;
    }
    byId.set(normalized.id, {
      ...previous,
      occurrences: Math.max(previous.occurrences, normalized.occurrences),
      confidence: Math.max(previous.confidence, normalized.confidence),
      lastSeenAt: normalized.lastSeenAt || previous.lastSeenAt
    });
  }
  return [...byId.values()]
    .sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''))
    .slice(0, MAX_LESSONS);
}

export function mergeAiLearningLesson(existing = [], lesson = {}) {
  const current = normalizeAiLearning(existing);
  const next = normalizeLesson(lesson);
  if (!next) return current;
  const index = current.findIndex((item) => item.id === next.id);
  if (index < 0) return normalizeAiLearning([next, ...current]);

  const previous = current[index];
  const merged = {
    ...previous,
    ...next,
    occurrences: Math.min(9999, previous.occurrences + Math.max(1, next.occurrences)),
    confidence: Math.max(previous.confidence, next.confidence),
    createdAt: previous.createdAt || next.createdAt,
    lastSeenAt: new Date().toISOString()
  };
  return normalizeAiLearning([merged, ...current.filter((item) => item.id !== next.id)]);
}

export function selectRelevantAiLearningLessons(lessons, query, { limit = 6 } = {}) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 10);
  return normalizeAiLearning(lessons)
    .map((lesson) => {
      const score = lesson.terms.reduce((total, term) => {
        const normalizedTerm = normalizeSearch(term);
        if (!normalizedTerm || !normalizedQuery.includes(normalizedTerm)) return total;
        return total + (normalizedTerm.includes(' ') ? 4 : 2);
      }, 0);
      return score > 0 ? { lesson, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (b.lesson.confidence - a.lesson.confidence))
    .slice(0, safeLimit)
    .map((item) => item.lesson);
}

export function formatAiLearningContext(lessons = []) {
  const normalized = normalizeAiLearning(lessons);
  if (!normalized.length) return '';
  return [
    'Memoria operativa aprendida y validada:',
    ...normalized.map((lesson) => '- ' + lesson.guidance)
  ].join('\n').slice(0, 2600);
}

export function buildAiLearningLesson({ message = '', category = '', confidence = 80, severity = 'medium', source = 'quality_signal' } = {}) {
  const requestedCategory = normalizeSearch(category);
  const resolvedCategory = requestedCategory && VALID_CATEGORIES.has(requestedCategory)
    ? requestedCategory
    : inferCategory(message);
  const now = new Date().toISOString();
  return normalizeLesson({
    id: 'ai-learning-' + resolvedCategory,
    category: resolvedCategory,
    confidence,
    severity,
    source,
    occurrences: 1,
    createdAt: now,
    lastSeenAt: now
  });
}

function normalizeLesson(value) {
  if (!value || typeof value !== 'object') return null;
  const category = normalizeCategory(value.category);
  const template = LESSON_TEMPLATES[category];
  const now = new Date().toISOString();
  return {
    id: cleanText(value.id, 100) || 'ai-learning-' + category,
    category,
    trigger: cleanText(template.trigger, MAX_TRIGGER_CHARS),
    guidance: cleanText(template.guidance, MAX_GUIDANCE_CHARS),
    terms: template.terms.slice(0, MAX_TERMS),
    occurrences: clampInteger(value.occurrences, 1, 9999),
    confidence: clampInteger(value.confidence, 0, 100, 70),
    severity: normalizeSeverity(value.severity),
    source: cleanText(value.source, 80) || 'quality_signal',
    createdAt: safeIso(value.createdAt) || now,
    lastSeenAt: safeIso(value.lastSeenAt) || safeIso(value.createdAt) || now
  };
}

function inferCategory(value) {
  const normalized = normalizeSearch(value);
  if (/\b(reportar|reporte|denunciar|denuncia|insulto|insultos|amenaza|amenazas|acoso|abuso)\b/.test(normalized)) return 'report';
  if (/\b(lento|lentisimo|tarda|demora|delay)\b/.test(normalized)) return 'latency';
  if (/\b(repetitivo|repetida|otra vez|pesado|robotico)\b/.test(normalized)) return 'repetition';
  if (/\b(imagen|captura|foto|screenshot|video)\b/.test(normalized)) return 'vision';
  if (/\b(voz|audio|tts|stt|suena)\b/.test(normalized)) return 'voice';
  if (/\b(idioma|espanol|ingles|language)\b/.test(normalized)) return 'language';
  if (/\b(incorrecta|incorrecto|inventas|sin sentido|no entiendes)\b/.test(normalized)) return 'wrong_answer';
  if (/\b(tono|frio|robotico|robotica)\b/.test(normalized)) return 'tone';
  if (/\b(enfadado|cabrea|harto|mierda|idiota|subnormal|inutil)\b/.test(normalized)) return 'anger';
  return 'general';
}

function normalizeCategory(value) {
  const normalized = normalizeSearch(value).replace(/\s+/g, '_');
  return VALID_CATEGORIES.has(normalized) ? normalized : 'general';
}

function normalizeSeverity(value) {
  const normalized = normalizeSearch(value);
  return ['low', 'medium', 'high', 'critical'].includes(normalized) ? normalized : 'medium';
}

function normalizeSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function clampInteger(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
