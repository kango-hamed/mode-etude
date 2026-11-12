// Planning de révisions : des séances avant chaque épreuve, placées sur des jours peu chargés.
import { ymd, parseYmd, addDays, startOfDay, daysBetween, keyOf } from './util.js';

/** Séances de révision avant une épreuve : J-14, J-7, J-3, la veille. */
export const STAGES = [14, 7, 3, 1];
export const stageLabel = (n) => (n === 1 ? 'La veille' : `J-${n}`);
/** Au-delà, une journée est trop chargée : la séance glisse d'un jour plus tôt. */
const MAX_PER_DAY = 2;

/** Clé stable d'une séance : l'épreuve (matière + date) et l'étape, pour retrouver ce qui est coché. */
export const revKey = (exam, stage) => `${exam.subjectId}|${exam.date}|${stage}`;

/**
 * Planning des révisions pour les épreuves à venir.
 * exams : [{ id, subjectId, date, start }] ; ctx.load(date) → minutes de cours ce jour-là ;
 * ctx.lastEnd(date) → heure de fin du dernier cours (« 16:30 ») ou '' ; ctx.today (Date).
 * Retour : [{ key, exam, stage, date (AAAA-MM-JJ), after }] trié par date.
 */
export function planRevisions(exams, ctx) {
  const today = startOfDay(ctx.today || new Date());
  const todayKey = ymd(today);
  const upcoming = exams.filter((e) => e.date && e.date > todayKey).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const examDays = new Set(exams.map((e) => e.date));
  const perDay = new Map();
  const out = [];
  // Les épreuves les plus proches choisissent leurs jours en premier.
  for (const exam of upcoming) {
    const examDay = parseYmd(exam.date);
    const lead = daysBetween(today, examDay);
    // Épreuve proche : on garde les étapes encore possibles ; s'il n'en reste aucune, une séance aujourd'hui.
    let stages = STAGES.filter((n) => n <= lead);
    if (!stages.length) stages = [lead];
    const used = new Set();
    for (const stage of stages) {
      const target = addDays(examDay, -stage);
      // Sinon, en dernier recours : un jour avec une autre épreuve (l'après-midi) ou une séance de plus.
      const day = pickDay(target, today, examDay, (d) => {
        const k = ymd(d);
        return !used.has(k) && !examDays.has(k) && (perDay.get(k) || 0) < MAX_PER_DAY;
      }, ctx.load) || pickDay(target, today, examDay, (d) => !used.has(ymd(d)) && (perDay.get(ymd(d)) || 0) <= MAX_PER_DAY, ctx.load);
      if (!day) continue;
      const k = ymd(day);
      used.add(k);
      perDay.set(k, (perDay.get(k) || 0) + 1);
      out.push({ key: revKey(exam, stage), exam, stage, date: k, after: ctx.lastEnd ? ctx.lastEnd(day) : '' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.exam.date.localeCompare(b.exam.date));
}

/**
 * Jour retenu pour une séance visée le jour `target` : lui s'il convient, sinon on cherche jusqu'à
 * 2 jours plus tôt puis 1 jour plus tard (jamais avant aujourd'hui ni le jour de l'épreuve),
 * en préférant le jour le moins chargé en cours.
 */
function pickDay(target, today, examDay, ok, load) {
  const cands = [0, -1, -2, 1]
    .map((dx) => addDays(target, dx))
    .filter((d) => d >= today && d < examDay && ok(d));
  if (!cands.length) return null;
  if (ok(target) && target >= today && target < examDay) {
    // Le jour visé convient, sauf s'il est très chargé et qu'un voisin plus tôt est libre.
    const free = cands.find((d) => d < target && (load?.(d) || 0) === 0);
    return (load?.(target) || 0) >= 360 && free ? free : target;
  }
  return cands.sort((a, b) => (load?.(a) || 0) - (load?.(b) || 0))[0];
}

/** Rubrique d'un document d'après son chemin : Cours, TD, TP, Annales… (premier dossier sous la matière). */
export function docKind(dirs) {
  for (const d of dirs) {
    const k = keyOf(d);
    if (/^(annales?|examens?|sujets? d examens?|partiels?)\b/.test(k)) return 'Annales';
    if (/^td(?: ?\d+)?\b|^travaux diriges/.test(k)) return 'TD';
    if (/^tp(?: ?\d+)?\b|^travaux pratiques/.test(k)) return 'TP';
    if (/^(cours|cm|chapitres?|supports?|slides)\b/.test(k)) return 'Cours';
  }
  return 'Autres';
}
export const KIND_ORDER = ['Cours', 'TD', 'TP', 'Annales', 'Autres'];
