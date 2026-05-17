export const AI_QUALITY_CATEGORIES = new Set([
  'malfunction',
  'wrong_answer',
  'repetition',
  'language',
  'vision',
  'voice',
  'latency',
  'tone',
  'anger',
  'general'
]);

export const AI_QUALITY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function normalizeAiQualitySignal(value = {}) {
  const createdAt = value.createdAt ?? new Date().toISOString();
  const category = normalizeCategory(value.category);
  const severity = normalizeSeverity(value.severity);
  return {
    id: normalizeOptionalString(value.id) ?? `ai-quality-${value.messageId ?? value.channelId ?? 'unknown'}-${createdAt}`,
    guildId: normalizeOptionalString(value.guildId),
    guildName: normalizeOptionalString(value.guildName),
    channelId: normalizeOptionalString(value.channelId),
    channelName: normalizeOptionalString(value.channelName),
    messageId: normalizeOptionalString(value.messageId),
    userId: normalizeOptionalString(value.userId),
    username: normalizeOptionalString(value.username),
    category,
    severity,
    sentiment: normalizeOptionalString(value.sentiment) ?? severityToSentiment(severity),
    confidence: clampConfidence(value.confidence),
    reason: normalizeOptionalString(value.reason),
    userMessage: normalizeOptionalString(value.userMessage) ?? '',
    previousAiMessage: normalizeOptionalString(value.previousAiMessage),
    detectedBy: normalizeOptionalString(value.detectedBy) ?? 'heuristic',
    resolved: Boolean(value.resolved),
    createdAt
  };
}

export function detectAiQualitySignalHeuristic(content = '') {
  const normalized = normalizeText(content);
  if (!normalized) return { detected: false, shouldAnalyze: false };

  const target = /\b(?:nexa|nexadesk|ia|ai|bot|asistente|soporte automatico|automatizado|robot)\b/.test(normalized)
    || /\b(?:no\s+me\s+entiendes?|no\s+entiendes?|no\s+sirves?|eres\s+(?:inutil|tonto|malo|pesado|robotico))\b/.test(normalized)
    || /\b(?:you\s+dont\s+understand|you\s+are\s+useless|bad\s+bot|stupid\s+bot)\b/.test(normalized);
  const complaint = [
    /\b(?:funciona|va|anda|responde|contesta)\s+(?:mal|fatal|horrible|lento|raro)\b/,
    /\b(?:no\s+funciona|no\s+va|falla|fallando|bug|error|se\s+buguea|se\s+rompio|se\s+ha\s+roto)\b/,
    /\b(?:no\s+entiendes?|no\s+me\s+entiendes?|no\s+ayudas?|no\s+me\s+ayudas?|no\s+sirves?)\b/,
    /\b(?:respuesta\s+(?:mal|incorrecta|mala|repetida|sin\s+sentido)|respondes?\s+(?:mal|incorrecto|tonterias|cosas\s+raras))\b/,
    /\b(?:repetitivo|pesado|robotico|muy\s+robot|parece\s+un\s+robot|inventas?|te\s+lo\s+inventas?)\b/,
    /\b(?:no\s+lees?\s+(?:la\s+)?imagen|no\s+ves?\s+(?:la\s+)?captura|no\s+entiendes?\s+(?:la\s+)?foto)\b/,
    /\b(?:voz\s+(?:mal|robotica|no\s+suena|fatal)|audio\s+(?:mal|no\s+suena|fatal))\b/,
    /\b(?:tardas?|lento|lentisimo|demora|demoras)\b/,
    /\b(?:wrong\s+answer|bad\s+answer|not\s+working|doesnt\s+work|does\s+not\s+work|broken|buggy|useless|annoying)\b/
  ].some((pattern) => pattern.test(normalized));
  const directBotComplaint = [
    /\b(?:no\s+me\s+entiendes?|no\s+entiendes?|no\s+me\s+ayudas?|no\s+sirves?)\b/,
    /\b(?:no\s+lees?\s+(?:la\s+)?imagen|no\s+ves?\s+(?:la\s+)?captura|no\s+entiendes?\s+(?:la\s+)?foto)\b/,
    /\b(?:voz|audio|tts|stt)\s+(?:mal|robotic[oa]|no\s+suena|fatal|rota|roto)\b/,
    /\b(?:you\s+dont\s+understand|bad\s+bot|stupid\s+bot|wrong\s+answer)\b/
  ].some((pattern) => pattern.test(normalized));
  const anger = [
    /\b(?:me\s+enfada|estoy\s+enfadad[oa]|me\s+cabrea|me\s+molesta|estoy\s+harto|me\s+tienes\s+harto)\b/,
    /\b(?:callate|cállate|deja\s+de\s+responder|para\s+ya|que\s+pesado|pesadisimo)\b/,
    /\b(?:mierda|asco|inutil|subnormal|idiota|tonto|estupido|fuck|shit|stupid)\b/
  ].some((pattern) => pattern.test(normalized));

  const shouldAnalyze = (target && (complaint || anger)) || directBotComplaint;
  if (!shouldAnalyze) {
    return { detected: false, shouldAnalyze: target || complaint || anger };
  }

  const category = inferCategory(normalized, { anger });
  const severity = inferSeverity(normalized, { anger });
  return {
    detected: true,
    shouldAnalyze: true,
    category,
    severity,
    sentiment: anger ? 'angry' : 'frustrated',
    confidence: anger ? 88 : 82,
    reason: buildHeuristicReason(category, severity),
    detectedBy: 'heuristic'
  };
}

export function parseAiQualitySignalJson(raw, fallback = {}) {
  const text = String(raw ?? '').trim();
  const parsed = safeJsonParse(text) ?? safeJsonParse((text.match(/\{[\s\S]*\}/)?.[0] ?? ''));
  if (!parsed || typeof parsed !== 'object') {
    return fallback.detected ? fallback : { detected: false };
  }

  const detected = Boolean(parsed.detected);
  if (!detected) return { detected: false };

  return {
    detected: true,
    category: normalizeCategory(parsed.category),
    severity: normalizeSeverity(parsed.severity),
    sentiment: normalizeOptionalString(parsed.sentiment) ?? severityToSentiment(parsed.severity),
    confidence: clampConfidence(parsed.confidence),
    reason: normalizeOptionalString(parsed.reason) ?? fallback.reason ?? 'El usuario expresa frustracion con el funcionamiento de la IA.',
    detectedBy: 'ai'
  };
}

function inferCategory(normalized, { anger }) {
  if (/\b(?:no\s+lees?\s+(?:la\s+)?imagen|no\s+ves?\s+(?:la\s+)?captura|foto|imagen|captura)\b/.test(normalized)) return 'vision';
  if (/\b(?:voz|audio|suena|robotica|robotico)\b/.test(normalized)) return 'voice';
  if (/\b(?:idioma|ingles|espanol|español|chino|no\s+hablas|language)\b/.test(normalized)) return 'language';
  if (/\b(?:lento|lentisimo|tarda|demora|delay)\b/.test(normalized)) return 'latency';
  if (/\b(?:repetitivo|repite|pesado|otra\s+vez)\b/.test(normalized)) return 'repetition';
  if (/\b(?:inventas?|incorrecta|mal|wrong|sin\s+sentido)\b/.test(normalized)) return 'wrong_answer';
  if (anger) return 'anger';
  return 'malfunction';
}

function inferSeverity(normalized, { anger }) {
  if (/\b(?:subnormal|idiota|fuck|shit|me\s+tienes\s+harto|estoy\s+harto|asco|mierda)\b/.test(normalized)) return 'high';
  if (anger) return 'medium';
  if (/\b(?:fatal|horrible|no\s+sirves?|inutil|useless|broken)\b/.test(normalized)) return 'high';
  return 'medium';
}

function buildHeuristicReason(category, severity) {
  const labels = {
    malfunction: 'El usuario indica que la IA o el bot funciona mal.',
    wrong_answer: 'El usuario indica que la IA esta dando respuestas incorrectas o inventadas.',
    repetition: 'El usuario se queja de respuestas repetitivas o pesadas.',
    language: 'El usuario detecta un problema de idioma en la respuesta.',
    vision: 'El usuario indica que la IA no esta interpretando bien imagenes o capturas.',
    voice: 'El usuario indica un problema de voz, audio o naturalidad.',
    latency: 'El usuario indica lentitud en la IA.',
    tone: 'El usuario se queja del tono de la IA.',
    anger: 'El usuario muestra enfado directo con la IA.',
    general: 'El usuario muestra frustracion con la experiencia de IA.'
  };
  return `${labels[category] ?? labels.general} Severidad ${severity}.`;
}

function normalizeCategory(value) {
  const category = String(value ?? '').trim().toLowerCase().replace(/[^a-z_]/g, '_');
  return AI_QUALITY_CATEGORIES.has(category) ? category : 'general';
}

function normalizeSeverity(value) {
  const severity = String(value ?? '').trim().toLowerCase();
  return AI_QUALITY_SEVERITIES.has(severity) ? severity : 'medium';
}

function severityToSentiment(value) {
  const severity = normalizeSeverity(value);
  if (severity === 'critical' || severity === 'high') return 'angry';
  if (severity === 'low') return 'confused';
  return 'frustrated';
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 70;
  return Math.min(Math.max(Math.round(number), 0), 100);
}

function normalizeOptionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@#:_/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
