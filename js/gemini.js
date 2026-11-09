// Lecture d'un emploi du temps PDF par Gemini (clé API gratuite de l'utilisateur).
import { blobToBase64, normTime, ymd, isoDay, parseYmd } from './util.js';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    sessions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          subject: { type: 'STRING' },
          code: { type: 'STRING', nullable: true },
          type: { type: 'STRING', nullable: true },
          room: { type: 'STRING', nullable: true },
          teacher: { type: 'STRING', nullable: true },
          weekday: { type: 'INTEGER', nullable: true },
          date: { type: 'STRING', nullable: true },
          start: { type: 'STRING' },
          end: { type: 'STRING' },
        },
        required: ['subject', 'start', 'end'],
      },
    },
  },
  required: ['sessions'],
};
// En-tête du document : un emploi du temps couvre une partie d'un semestre (« SEMESTRE 3 – PARTIE 2 »).
const META = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    semester: { type: 'INTEGER', nullable: true },
    part: { type: 'INTEGER', nullable: true },
    className: { type: 'STRING', nullable: true },
    start: { type: 'STRING', nullable: true },
    end: { type: 'STRING', nullable: true },
  },
};
SCHEMA.properties.meta = META;
SCHEMA.properties.exams = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { label: { type: 'STRING', nullable: true }, start: { type: 'STRING' }, end: { type: 'STRING' } },
    required: ['start', 'end'],
  },
};

function prompt() {
  const today = ymd(new Date());
  return `Tu reçois l'emploi du temps d'un étudiant au format PDF. Extrais chaque créneau de cours.
Nous sommes le ${today}.
Règles :
- Si c'est une semaine type qui se répète, renseigne "weekday" (1 = lundi … 7 = dimanche) et mets "date" à null.
- Si les créneaux sont datés (semaines différentes), renseigne "date" au format AAAA-MM-JJ (déduis l'année si elle manque) ET "weekday".
- "start" et "end" au format HH:MM sur 24 heures.
- "subject" : le nom de la matière tel qu'il est écrit, sans le type de séance ni la salle. Utilise exactement le même nom à chaque fois pour une même matière.
- Si les cases ne contiennent qu'un code (ex. « 2INF2302 ») expliqué dans une légende, mets ce code dans "code" et le nom complet de la légende dans "subject".
- "code" : le code de la matière s'il existe, sinon null.
- "type" : CM, TD, TP, Examen, etc. si c'est indiqué, sinon null.
- "room" si c'est indiqué, sinon null. "teacher" : l'enseignant, pris dans la case ou dans la légende, sinon null.
- Les périodes d'examens (ex. une colonne « EXAMENS » qui couvre toute une semaine) ne sont PAS des créneaux : mets-les dans "exams", avec "start" et "end" au format AAAA-MM-JJ (premier et dernier jour, samedi compris s'il est couvert) et "label" (ex. « Examens deuxième partie »). Si la colonne n'indique que la date du lundi, la période va du lundi au samedi.
- "meta" : ce que dit l'en-tête du document. Un emploi du temps couvre une PARTIE d'un semestre (un semestre a deux parties).
  "semester" : le numéro du semestre (« SEMESTRE 3 », « S3 » → 3 ; « semestre impair » sans numéro → null).
  "part" : le numéro de la partie (« PARTIE 2 », « 2ème partie », « P2 » → 2), sinon null.
  "className" : la classe ou filière (ex. « M2 SIGL-ID2C »), sinon null.
  "start" et "end" : premier et dernier jour couverts par ce document (semaines d'examens comprises), au format AAAA-MM-JJ, sinon null.
- N'invente rien. Ignore les pauses, les cases vides et les légendes.`;
}

/** En-tête lu par l'IA, nettoyé : { semNo, part, className, start, end } (champs vides si absents). */
export function cleanMeta(m) {
  const int = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);
  const d = (v) => (isDate(v) ? v : '');
  let start = d(m?.start); let end = d(m?.end);
  if (start && end && start > end) [start, end] = [end, start];
  return { semNo: int(m?.semester, 12), part: int(m?.part, 4), className: String(m?.className || '').replace(/\s+/g, ' ').trim(), start, end };
}

const API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Cherche le meilleur modèle « Flash » ouvert à cette clé.
 * Google retire régulièrement les anciens modèles : on ne fige donc pas de nom.
 */
export async function pickFlashModel(apiKey, signal) {
  let res;
  try { res = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey }, signal }); } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
  if (!res.ok) return null;
  const names = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  const byVersion = (a, b) => version(b) - version(a);
  const stable = names.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort(byVersion);
  if (stable.length) return stable[0];
  if (names.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const other = names.filter((n) => /flash/.test(n) && !/lite|image|tts|live|audio|embedding|thinking/.test(n)).sort(byVersion);
  return other[0] || null;
}

async function callModel(model, apiKey, body, signal) {
  let res;
  try {
    res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('Impossible de joindre Gemini (connexion ?).');
  }
  return res;
}

/** Envoie le PDF à Gemini avec une consigne et un schéma de réponse. Retourne { parsed, model }. */
async function askGemini(file, { apiKey, model }, text, schema, { onStep = () => {}, signal } = {}) {
  if (!apiKey) throw new Error('Ajoute ta clé Gemini dans les Réglages.');
  if (file.size > 18 * 1024 * 1024) throw new Error('PDF trop lourd (18 Mo max).');
  const data = await blobToBase64(file);
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data } }, { text }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
  };
  if (!model) onStep('Recherche du modèle Gemini…');
  let used = model || (await pickFlashModel(apiKey, signal)) || 'gemini-flash-latest';
  onStep(`Lecture du PDF par ${used}…`);
  // Réflexion courte : lire un tableau n'a pas besoin d'un long raisonnement, et c'est bien plus rapide.
  body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  let res = await callModel(used, apiKey, body, signal);
  if (res.status === 400) {
    const err = await res.clone().json().catch(() => null);
    if (/thinking/i.test(err?.error?.message || '')) {
      delete body.generationConfig.thinkingConfig; // modèle qui ne gère pas ce réglage
      res = await callModel(used, apiKey, body, signal);
    }
  }
  // Modèle retiré ou inconnu : on prend automatiquement le plus récent disponible et on réessaie une fois.
  if (res.status === 404) {
    onStep('Modèle indisponible, recherche d\'un autre…');
    const fallback = await pickFlashModel(apiKey, signal);
    if (fallback && fallback !== used) {
      used = fallback;
      onStep(`Lecture du PDF par ${used}…`);
      res = await callModel(used, apiKey, body, signal);
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error.message; } catch { /* ignore */ }
    if (res.status === 400 && /api key/i.test(msg)) msg = 'clé API invalide, vérifie-la dans les Réglages.';
    else if (res.status === 429) msg = 'limite gratuite atteinte pour le moment, réessaie dans une minute.';
    else if (res.status === 404) msg += ' — indique un autre modèle dans les Réglages.';
    throw new Error(`Gemini (${res.status}) : ${msg}`);
  }
  const json = await res.json();
  const out = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try { return { parsed: JSON.parse(out), model: used }; } catch { throw new Error("Réponse de l'IA illisible, réessaie."); }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const cleanExams = (list) => (list || [])
  .filter((e) => isDate(e.start) && isDate(e.end))
  .map((e) => ({ label: String(e.label || 'Examens').trim() || 'Examens', start: e.start, end: e.end < e.start ? e.start : e.end }));

const EXAM_WORD = /\bexam(en)?s?\b/i;
const niceLabel = (s) => { const t = s.trim(); return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t; };

/**
 * Filet de sécurité : une « matière » qui s'appelle « EXAMENS… » (sans prof ni code) est en fait une
 * période d'examens. On la retire des créneaux et on regroupe ses jours en périodes.
 */
export function splitExams(rows, exams = []) {
  const out = cleanExams(exams);
  const isExamRow = (r) => EXAM_WORD.test(r.subject || '') && !r.code && !r.teacher;
  const examRows = rows.filter((r) => isExamRow(r) && isDate(r.date)).sort((a, b) => a.date.localeCompare(b.date));
  const covered = (d) => out.some((e) => d >= e.start && d <= e.end);
  let cur = null;
  for (const r of examRows) {
    if (covered(r.date)) continue;
    // Jours consécutifs (dimanche sauté) = une seule période.
    if (cur && (parseYmd(r.date) - parseYmd(cur.end)) / 86400000 <= 2) { if (r.date > cur.end) cur.end = r.date; continue; }
    cur = { label: niceLabel(r.subject), start: r.date, end: r.date };
    out.push(cur);
  }
  return { sessions: rows.filter((r) => !(isExamRow(r) && (isDate(r.date) || !r.date))), exams: out };
}

/**
 * Lit tout l'emploi du temps. Retourne { sessions, exams, model } ; « model » est celui qui a réellement répondu.
 * onStep(texte) informe de l'étape en cours ; signal permet d'annuler.
 */
export async function parseTimetable(file, settings, opts = {}) {
  const { parsed, model } = await askGemini(file, settings, prompt(), SCHEMA, opts);
  const { sessions, exams } = splitExams(clean(parsed.sessions || []), parsed.exams);
  return { sessions, exams, meta: cleanMeta(parsed.meta), model };
}

const EXAM_SCHEMA = { type: 'OBJECT', properties: { exams: SCHEMA.properties.exams }, required: ['exams'] };

/** Relit un emploi du temps déjà importé, uniquement pour y trouver les périodes d'examens (plus rapide). */
export async function parseExams(file, settings, opts = {}) {
  const text = `Tu reçois l'emploi du temps d'un étudiant au format PDF. Nous sommes le ${ymd(new Date())}.
Trouve uniquement les périodes d'examens (souvent une colonne ou une case « EXAMENS » qui couvre une semaine entière).
Pour chacune : "start" et "end" au format AAAA-MM-JJ (premier et dernier jour, samedi compris s'il est couvert ; si seule la date du lundi est indiquée, va du lundi au samedi), et "label" (le texte écrit, ex. « Examens deuxième partie »).
S'il n'y en a aucune, renvoie une liste vide. N'invente rien.`;
  const { parsed, model } = await askGemini(file, settings, text, EXAM_SCHEMA, opts);
  return { exams: cleanExams(parsed.exams), model };
}

export function clean(rows) {
  return rows
    .map((r) => {
      let date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
      let weekday = Number.isInteger(r.weekday) && r.weekday >= 1 && r.weekday <= 7 ? r.weekday : '';
      if (date) weekday = isoDay(parseYmd(date));
      return {
        subject: String(r.subject || '').trim(),
        code: String(r.code || '').trim(),
        type: String(r.type || '').trim(),
        room: String(r.room || '').trim(),
        teacher: String(r.teacher || '').trim(),
        weekday, date,
        start: normTime(r.start),
        end: normTime(r.end),
      };
    })
    .filter((r) => r.subject && r.start);
}

const EXAM_SESSIONS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sessions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          subject: { type: 'STRING' },
          code: { type: 'STRING', nullable: true },
          date: { type: 'STRING' },
          start: { type: 'STRING' },
          end: { type: 'STRING', nullable: true },
          room: { type: 'STRING', nullable: true },
          type: { type: 'STRING', nullable: true },
          group: { type: 'STRING', nullable: true },
        },
        required: ['subject', 'date', 'start'],
      },
    },
    meta: META,
  },
  required: ['sessions'],
};

/**
 * Lit le calendrier des examens (publié à part, souvent peu avant la semaine d'examens).
 * known = [{ name, code }] : les matières déjà connues, pour reprendre exactement leurs noms.
 */
export async function parseExamTimetable(file, settings, known = [], opts = {}) {
  const list = known.map((s) => `- ${s.code ? s.code + ' = ' : ''}${s.name}`).join('\n');
  const text = `Tu reçois le programme des examens (compositions) d'une école au format PDF. Nous sommes le ${ymd(new Date())}.
Le document est souvent une page scannée, parfois pivotée : lis-la dans le bon sens.
Il couvre souvent plusieurs classes (ex. « M2 CSIA », « M2 SIGL (ID2C) », « M2 RTEL (ASERT) ») : chaque créneau horaire a alors une ligne par classe.${opts.group ? ` L'étudiant est en « ${opts.group} ».` : ''}
Extrais chaque épreuve de CHAQUE classe :
- "group" : la classe telle qu'elle est écrite (ex. « M2 SIGL (ID2C) ») ; null si le document ne concerne qu'une classe.
- "date" au format AAAA-MM-JJ (les dates sont en tête de colonne ; déduis l'année si elle manque).
- "start" et "end" au format HH:MM sur 24 heures, d'après la colonne des horaires (ex. « 07H30 - 09H30 » → 07:30 et 09:30) ; "end" à null s'il n'est pas indiqué.
- "subject" : le nom de la matière. S'il est écrit tout en capitales, écris-le normalement (« CLUSTER HADOOP » → « Cluster Hadoop », accents compris : « METHODOLOGIE » → « Méthodologie »). ${list ? `Si c'est une matière de la liste ci-dessous (par son nom ou son code), recopie EXACTEMENT ce nom :\n${list}\n` : ''}- "code" : le code de la matière s'il est indiqué, sinon null.
- "room" : la salle si elle est indiquée, sinon null. "type" : « Examen », « Rattrapage », « Oral »… selon ce qui est écrit, sinon « Examen ».
- Une case barrée, vide ou remplie de « //// » veut dire « pas d'épreuve » : ignore-la.
- "meta" : d'après le titre, "semester" (numéro du semestre s'il est écrit, sinon null) et "part" (« (Partie 1) » → 1, sinon null).
- N'invente rien. Ignore les signatures, cachets, surveillants et légendes.`;
  const { parsed, model } = await askGemini(file, settings, text, EXAM_SESSIONS_SCHEMA, opts);
  const sessions = (parsed.sessions || [])
    .filter((r) => isDate(r.date) && normTime(r.start))
    .map((r) => ({
      subject: String(r.subject || '').trim(), code: String(r.code || '').trim(), date: r.date, weekday: isoDay(parseYmd(r.date)),
      start: normTime(r.start), end: normTime(r.end) || '', room: String(r.room || '').trim(), type: String(r.type || 'Examen').trim() || 'Examen', teacher: '',
      group: String(r.group || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((r) => r.subject && !/^[\s/\\\-–_.]*$/.test(r.subject)); // « //// » = pas d'épreuve
  return { sessions, meta: cleanMeta(parsed.meta), model };
}
