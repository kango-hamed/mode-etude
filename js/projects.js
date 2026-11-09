// Projets et compétitions : partagés entre le nouvel onglet, la petite fenêtre d'ajout et les rappels.
import * as db from './db.js';
import { ymd, parseYmd, addDays, startOfDay, daysBetween, uid } from './util.js';

export const PROJECT_KINDS = ['Compétition', 'Projet', 'Hackathon', 'Stage', 'Perso'];

/** Rappel par défaut : la veille. */
export const REMINDERS = [
  { v: 0, label: 'Le jour même' },
  { v: 1, label: '1 jour avant' },
  { v: 3, label: '3 jours avant' },
  { v: 7, label: '1 semaine avant' },
  { v: -1, label: 'Pas de rappel' },
];
export const DEFAULT_REMIND = 1;

export const loadProjects = async () => (await db.kvGet('projects')) || [];
export const saveProjects = (list) => db.kvSet('projects', list);

/** Prévient les autres pages de l'extension (nouvel onglet ouvert, rappels) qu'un projet a changé. */
export function announce() {
  try { globalThis.browser?.runtime?.sendMessage({ type: 'projects-changed' })?.catch?.(() => {}); } catch { /* hors extension */ }
}

export async function addProject(fields) {
  const list = await loadProjects();
  const p = { id: uid(), name: '', kind: 'Compétition', due: '', url: '', next: '', remind: DEFAULT_REMIND,
    progress: 0, done: false, createdAt: ymd(new Date()), ...fields };
  list.push(p);
  await saveProjects(list);
  announce();
  return p;
}

/**
 * Rappels à envoyer maintenant : X jours avant la date limite, puis le jour même (à partir de 8 h).
 * Chaque rappel n'est envoyé qu'une fois par date limite (p.notified garde la trace).
 */
export function dueReminders(list, now = new Date()) {
  const out = [];
  if (now.getHours() < 8) return out;
  for (const p of list) {
    if (p.done || !p.due) continue;
    const remind = p.remind ?? DEFAULT_REMIND;
    if (remind < 0) continue;
    const left = daysBetween(now, parseYmd(p.due));
    if (left < 0) continue;
    const stages = [...new Set([remind, 0])];
    // Le rappel le plus proche déjà atteint (on n'envoie pas « dans 3 jours » s'il reste 1 jour).
    const stage = stages.filter((s) => left <= s).sort((a, b) => a - b)[0];
    if (stage === undefined) continue;
    const key = `${p.due}:${stage}`;
    if ((p.notified || []).includes(key)) continue;
    out.push({ p, key, left });
  }
  return out;
}

export function reminderText(p, left) {
  const when = left === 0 ? "c'est aujourd'hui" : left === 1 ? "c'est demain" : `dans ${left} jours`;
  return `Date limite ${when}${p.next ? ` · Prochaine étape : ${p.next}` : ''}`;
}

/* ---------- Dates trouvées dans une page ---------- */

const MONTHS = {
  janvier: 1, janv: 1, jan: 1, january: 1,
  fevrier: 2, fevr: 2, fev: 2, february: 2, feb: 2,
  mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, april: 4, apr: 4,
  mai: 5, may: 5,
  juin: 6, june: 6, jun: 6,
  juillet: 7, juil: 7, july: 7, jul: 7,
  aout: 8, august: 8, aug: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  decembre: 12, dec: 12, december: 12,
};
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function make(y, m, d, today) {
  if (!m || !d || m > 12 || d > 31) return null;
  let year = y ? (y < 100 ? 2000 + y : y) : today.getFullYear();
  let date = new Date(year, m - 1, d);
  if (date.getMonth() !== m - 1) return null;
  if (!y && date < today) date = new Date(++year, m - 1, d); // « 15 mars » déjà passé : l'an prochain
  return date;
}

/**
 * Dates citées dans un texte (« 15 décembre 2026 », « 15/12/2026 », « December 15, 2026 »…), à venir uniquement.
 * Les dates proches de « date limite », « deadline », « clôture »… passent en premier.
 */
export function findDates(text, today = startOfDay(new Date())) {
  const t = fold(String(text || '')).slice(0, 60000);
  const found = [];
  const push = (date, index) => { if (date && date >= today && date <= addDays(today, 3 * 365)) found.push({ date, index }); };
  let m;
  const reNum = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
  while ((m = reNum.exec(t))) push(make(Number(m[3]), Number(m[2]), Number(m[1]), today), m.index);
  const reIso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = reIso.exec(t))) push(make(Number(m[1]), Number(m[2]), Number(m[3]), today), m.index);
  const reFr = new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\b`, 'g');
  while ((m = reFr.exec(t))) push(make(m[3] ? Number(m[3]) : 0, MONTHS[m[2]], Number(m[1]), today), m.index);
  const reEn = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?\\b`, 'g');
  while ((m = reEn.exec(t))) push(make(m[3] ? Number(m[3]) : 0, MONTHS[m[1]], Number(m[2]), today), m.index);

  const KEY = /\b(date limite|deadline|cloture|clos|jusqu'?au|avant le|au plus tard|inscriptions?|candidatures?|soumission|submission|due|ends?|fin le)\b/g;
  const keys = []; while ((m = KEY.exec(t))) keys.push(m.index + m[0].length);
  // Une date « proche » suit le mot-clé dans la même phrase (« Date limite : 28 novembre »).
  const near = (i) => keys.some((k) => i >= k && i - k <= 40 && !/[!?\n]|\.\s/.test(t.slice(k, i)));
  const seen = new Map();
  for (const f of found) {
    const k = ymd(f.date);
    const cur = seen.get(k) || { ymd: k, key: false, first: f.index };
    cur.key ||= near(f.index); cur.first = Math.min(cur.first, f.index);
    seen.set(k, cur);
  }
  return [...seen.values()].sort((a, b) => (b.key - a.key) || (a.first - b.first)).map((x) => ({ ymd: x.ymd, key: x.key }));
}
