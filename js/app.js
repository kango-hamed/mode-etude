// Mode Étude — page « Nouvel onglet ».
import * as db from './db.js';
import { extractPages } from './pdftext.js';
import { parseTimetable, parseExams, splitExams, parseExamTimetable } from './gemini.js';
import { guessSubject, sameSubject, PALETTE, periodOf, contentDirs, periodLabel, periodOfText, samePeriod } from './subjects.js';
import { topSites, webSearch, hostOf, cleanTitle } from './browser.js';
import { themeSupported, currentTheme, onThemeChange, paletteFrom, themeImage, canLoad } from './theme.js';
import { PROJECT_KINDS, REMINDERS, DEFAULT_REMIND, announce, loadProjects } from './projects.js';
import { planRevisions, stageLabel, docKind, KIND_ORDER } from './revisions.js';
import {
  DAYS, ymd, parseYmd, isoDay, addDays, startOfDay, startOfWeek, fmtLong, fmtShort,
  relDue, esc, fold, keyOf, highlight, uid, fmtSize, normTime, daysBetween,
} from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const S = {
  settings: { apiKey: '', model: '', folder: null }, // model vide = choix automatique
  // Un emploi du temps par semestre : { id, name, start, end, source, importedAt, hasPdf, sessions }
  semesters: [],
  subjects: [],
  deadlines: [],
  // Projets et compétitions en cours : { id, name, kind, due, url, next, progress (0-100), done }
  projects: [],
  // Révisions : séances faites (clé matière|date|étape) et documents revus (clé matière|fichier).
  revisions: { done: {}, checked: {} },
  files: [],
  auto: new Map(), // fileId -> subjectId deviné
  pages: null, // cache de recherche
  topSites: [],
  shortcuts: { custom: [], removed: [] },
  ui: { projEdit: null, showProjDone: false, day: 0, selDay: null, calMonth: null, showDone: false, draft: null, semId: null, subject: null, semEdit: false },
};

/* ---------- Chargement / sauvegarde ---------- */

async function load() {
  const [settings, semesters, legacy, subjects, deadlines, files, shortcuts, sites, wall, projects] = await Promise.all([
    db.kvGet('settings'), db.kvGet('semesters'), db.kvGet('timetable'), db.kvGet('subjects'), db.kvGet('deadlines'), db.getFiles(),
    db.kvGet('shortcuts'), topSites(), db.kvGet('wallpaper'), db.kvGet('projects'),
  ]);
  S.revisions = { done: {}, checked: {}, ...(await db.kvGet('revisions') || {}) };
  Object.assign(S.settings, settings || {});
  Object.assign(S.shortcuts, shortcuts || {});
  S.topSites = sites;
  await applyWallpaper(wall);
  S.semesters = semesters || [];
  if (!semesters && legacy?.sessions?.length) {
    // Ancienne version : un seul emploi du temps. Il devient le premier semestre.
    const sem = { ...legacy, id: uid() };
    S.semesters = [sem];
    await db.kvSet('semesters', S.semesters);
    const pdf = await db.kvGet('timetablePdf');
    if (pdf) await db.kvSet(`timetablePdf:${sem.id}`, pdf);
  }
  S.subjects = subjects || [];
  // Semestres importés avant la détection des examens : une « matière » EXAMENS devient une période d'examens.
  let changed = false;
  for (const sem of S.semesters) {
    const rows = sem.sessions.map((s) => ({ ...s, subject: S.subjects.find((x) => x.id === s.subjectId)?.name || '', code: S.subjects.find((x) => x.id === s.subjectId)?.code || '' }));
    const { sessions: kept, exams } = splitExams(rows, sem.exams);
    if (kept.length === rows.length) continue;
    const keep = new Set(kept.map((s) => s.id));
    sem.sessions = sem.sessions.filter((s) => keep.has(s.id));
    sem.exams = exams.map((e) => ({ id: e.id || uid(), ...e }));
    changed = true;
  }
  // Avant la notion de partie : on reprend semestre et partie depuis le nom ou le fichier, s'ils y figurent.
  for (const sem of S.semesters) {
    if (sem.semNo || sem.part) continue;
    const q = periodOfText(`${sem.name || ''} ${sem.source || ''}`);
    if (q) { sem.semNo = q.sem || null; sem.part = q.part || null; changed = true; }
  }
  if (changed) await db.kvSet('semesters', S.semesters);
  S.deadlines = deadlines || [];
  S.projects = projects || [];
  S.files = files || [];
  recomputeAuto();
}

const save = (key) => db.kvSet(key, S[key]);
/** Les rappels (tâche de fond) relisent la liste dès qu'elle change. */
const saveProjectsAndAnnounce = async () => { await save('projects'); announce(); };

/** Projets ajoutés depuis la barre d'outils pendant que l'onglet était ouvert. */
async function refreshProjects() {
  S.projects = await loadProjects();
  if (location.hash === '' || location.hash === '#/') { if (!document.activeElement?.matches('input,select') && !S.ui.projEdit) render(); }
}
try { globalThis.browser?.runtime?.onMessage?.addListener((m) => { if (m?.type === 'projects-changed') refreshProjects(); }); } catch { /* hors extension */ }

let wallUrl = null;
// Apparence : fond d'écran choisi, et (option) couleurs et image du thème de Firefox.
const look = { wall: null, themeColors: false, themeImg: '' };
let themeVars = [];

function applyWallpaper(blob) {
  look.wall = blob || null;
  return applyLook();
}

async function applyLook() {
  const root = document.documentElement;
  themeVars.forEach((k) => root.style.removeProperty(k)); themeVars = [];
  root.style.colorScheme = ''; delete root.dataset.ffTheme;
  look.themeColors = false; look.themeImg = '';
  let img = '';
  if (S.settings.followTheme && themeSupported()) {
    const th = await currentTheme();
    const pal = paletteFrom(th);
    if (pal) {
      for (const [k, v] of Object.entries(pal.vars)) { root.style.setProperty(k, v); themeVars.push(k); }
      root.style.colorScheme = pal.dark ? 'dark' : 'light';
      root.dataset.ffTheme = pal.dark ? 'dark' : 'light';
      look.themeColors = true;
    }
    const url = themeImage(th);
    if (url && await canLoad(url)) look.themeImg = url;
    if (S.settings.themeImage && look.themeImg) img = look.themeImg;
  }
  // Pas d'image de thème : le fond d'écran choisi dans les Réglages, s'il y en a un.
  if (!img) {
    if (wallUrl) URL.revokeObjectURL(wallUrl);
    wallUrl = look.wall ? URL.createObjectURL(look.wall) : null;
    img = wallUrl;
  }
  document.body.style.backgroundImage = img ? `url("${img}")` : '';
  document.body.classList.toggle('has-wall', !!img);
  document.body.classList.toggle('theme-wall', !!img && img === look.themeImg);
}

function recomputeAuto() {
  S.auto.clear();
  for (const f of S.files) S.auto.set(f.id, guessSubject(f, S.subjects));
}

/* ---------- Requêtes sur les données ---------- */

const subjectById = (id) => S.subjects.find((s) => s.id === id);
const subjectName = (id) => subjectById(id)?.name || 'Sans matière';
const subjectColor = (id) => subjectById(id)?.color || '#8A8F9C';

function subjectOfFile(f) {
  if (f.subjectId === '__none') return null;
  if (f.subjectId && subjectById(f.subjectId)) return f.subjectId;
  return S.auto.get(f.id) || null;
}

/** Périodes d'examens valides d'un semestre : [{ id, label, start, end }] (dates AAAA-MM-JJ). */
const examsOf = (sem) => (sem?.exams || []).filter((e) => e.start && e.end && e.start <= e.end);
const examOn = (sem, date) => { const k = ymd(date); return examsOf(sem).find((e) => k >= e.start && k <= e.end) || null; };
const examAnyOn = (date) => S.semesters.map((s) => examOn(s, date)).find(Boolean) || null;

/** Période d'un semestre : dates saisies, sinon première et dernière date du PDF ; elle inclut les examens. */
function semRange(sem, coursesOnly = false) {
  if (!sem) return null;
  const dated = sem.sessions.filter((s) => s.date && !(coursesOnly && s.exam)).map((s) => s.date).sort();
  const exams = coursesOnly ? [] : examsOf(sem);
  const start = sem.start || [dated[0], ...exams.map((e) => e.start)].filter(Boolean).sort()[0] || '';
  const end = [sem.end || dated[dated.length - 1], ...exams.map((e) => e.end)].filter(Boolean).sort().at(-1) || '';
  if (!start || !end || start > end) return null;
  return { start: parseYmd(start), end: parseYmd(end), auto: !sem.start || !sem.end };
}

/** Séances d'un semestre ce jour-là : les créneaux hebdomadaires ne valent qu'entre ses dates, hors examens. */
function semSessionsOn(sem, date) {
  const day = startOfDay(date); const key = ymd(day); const wd = isoDay(day);
  // Les cours hebdomadaires ne débordent pas sur des examens placés avant ou après eux.
  const r = semRange(sem, true) || semRange(sem);
  const inRange = (!r || (day >= r.start && day <= r.end)) && !examOn(sem, day);
  return sem.sessions.filter((s) => (s.date ? s.date === key : inRange && Number(s.weekday) === wd));
}

const allSessions = () => S.semesters.flatMap((s) => s.sessions);

/**
 * Numéro de semaine compté depuis le premier cours : une semaine d'examens placée avant ou après
 * les cours (ex. épreuves de la partie 1) ne décale pas « Semaine 1 ». null hors des cours.
 */
function weekNumber(sem, monday) {
  const r = semRange(sem, true) || semRange(sem);
  if (!r || addDays(monday, 6) < r.start || monday > r.end) return null;
  return Math.round(daysBetween(startOfWeek(r.start), monday) / 7) + 1;
}

/**
 * Activité (sport, coaching, journée culturelle…) plutôt que matière : aucun enseignant ni code.
 * Le choix fait à la main (subject.activity) l'emporte toujours.
 */
function isActivity(id) {
  const s = S.subjects.find((x) => x.id === id);
  if (!s) return false;
  if (typeof s.activity === 'boolean') return s.activity;
  if (s.code || S.files.some((f) => subjectOfFile(f) === id)) return false;
  const sessions = allSessions();
  if (sessions.some((x) => x.subjectId === id && x.teacher)) return false;
  if (sessions.some((x) => x.teacher)) return true; // les autres ont un prof, pas celle-ci
  // Emploi du temps sans enseignants : on se fie aux intitulés en capitales (SPORT, COACHING…).
  const letters = s.name.replace(/[^A-Za-zÀ-ÿ]/g, '');
  return letters.length > 2 && letters === letters.toUpperCase();
}

function sessionsOn(date) {
  return S.semesters.flatMap((sem) => semSessionsOn(sem, date)).sort((a, b) => a.start.localeCompare(b.start));
}

/** Semestre affiché : celui choisi, sinon celui en cours, sinon le plus récent. */
function currentSem() {
  const chosen = S.semesters.find((x) => x.id === S.ui.semId);
  if (chosen) return chosen;
  const today = startOfDay(new Date());
  const now = S.semesters.find((x) => { const r = semRange(x); return r && today >= r.start && today <= r.end; });
  if (now) return now;
  const end = (x) => (semRange(x)?.end?.getTime() || 0);
  return [...S.semesters].sort((a, b) => end(b) - end(a) || String(b.importedAt).localeCompare(String(a.importedAt)))[0] || null;
}

const semLabel = (sem) => (sem.name || sem.className || String(sem.source || '').replace(/\.pdf$/i, '') || 'Semestre').trim();

/**
 * Un emploi du temps couvre une PARTIE d'un semestre (un semestre a deux parties) : semNo et part sont lus
 * dans l'en-tête du PDF à l'import. Pour les anciens imports, on les cherche dans le nom.
 */
function semPeriod(sem) {
  if (!sem) return null;
  if (sem.semNo || sem.part) return { sem: sem.semNo || null, part: sem.part || null };
  return periodOfText(`${sem.name || ''} ${sem.source || ''}`);
}
const periodShort = (p) => (p ? [p.sem ? `Semestre ${p.sem}` : '', p.part ? `Partie ${p.part}` : ''].filter(Boolean).join(' · ') : '');

/** Nom sans la période (elle est affichée à part) : « M2 SIGL · Partie 1 » → « M2 SIGL ». */
const semBase = (sem) => semLabel(sem)
  .replace(/\s*[·,\-–]?\s*\b(?:semestre|sem)\s*\d{1,2}\b/gi, '')
  .replace(/\s*[·,\-–]?\s*\(?\b(?:partie|part)\s*\d\b\)?/gi, '')
  .replace(/[\s·,\-–]+$/, '').trim() || semLabel(sem);

/** « Semestre 3 · Partie 2 · M2 SIGL-ID2C · 26 oct. → 19 déc. 2026 » */
function semOptionLabel(sem) {
  const r = semRange(sem);
  const per = periodShort(semPeriod(sem));
  return `${per ? `${per} · ` : ''}${semBase(sem)}${r ? ` · ${fmtShort(r.start)} → ${fmtShort(r.end)} ${r.end.getFullYear()}` : ' · semaine type'}`;
}

/** Sélecteur des emplois du temps, rangés par semestre puis par partie. */
function semSelect(id, selectedId, cls = 'input sm sem-select') {
  const order = (x) => { const q = semPeriod(x) || {}; return [q.sem || 99, q.part || 9, semRange(x)?.start?.getTime() || 0]; };
  const list = [...S.semesters].sort((a, b) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  const groups = new Map();
  for (const x of list) { const n = semPeriod(x)?.sem; const k = n ? `Semestre ${n}` : 'Autres'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const opt = (x) => { const q = semPeriod(x); const r = semRange(x);
    const text = q?.sem ? `${q.part ? `Partie ${q.part}` : 'Semestre entier'} · ${semBase(x)}${r ? ` · ${fmtShort(r.start)} → ${fmtShort(r.end)}` : ''}` : semOptionLabel(x);
    return `<option value="${esc(x.id)}" ${x.id === selectedId ? 'selected' : ''}>${esc(text)}</option>`; };
  const body = groups.size > 1 || !groups.has('Autres')
    ? [...groups.entries()].map(([k, xs]) => `<optgroup label="${esc(k)}">${xs.map(opt).join('')}</optgroup>`).join('')
    : list.map(opt).join('');
  return `<select id="${id}" class="${cls}">${body}</select>`;
}

function nextSessions(subjectId, count = 3, from = new Date()) {
  const out = [];
  const nowHM = `${String(from.getHours()).padStart(2, '0')}:${String(from.getMinutes()).padStart(2, '0')}`;
  for (let i = 0; i < 60 && out.length < count; i++) {
    const d = addDays(startOfDay(from), i);
    for (const s of sessionsOn(d)) {
      if (subjectId && s.subjectId !== subjectId) continue;
      if (i === 0 && s.end <= nowHM) continue;
      out.push({ ...s, on: d });
      if (out.length >= count) break;
    }
  }
  return out;
}

const pendingDeadlines = (subjectId) => S.deadlines
  .filter((d) => !d.done && (!subjectId || d.subjectId === subjectId))
  .sort((a, b) => a.due.localeCompare(b.due));

const filesOf = (subjectId) => S.files.filter((f) => subjectOfFile(f) === subjectId);

/* ---------- Révisions ---------- */

/** Épreuves datées de tous les semestres (sans doublon quand deux parties partagent une épreuve). */
function examList() {
  const seen = new Set();
  return allSessions().filter((s) => s.exam && s.date && s.subjectId)
    .filter((s) => { const k = `${s.subjectId}|${s.date}|${s.start}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
const classesOn = (d) => sessionsOn(d).filter((s) => !s.exam);
const dayLoad = (d) => classesOn(d).reduce((m, s) => m + duration(s), 0);
const lastEnd = (d) => classesOn(d).map((s) => s.end || s.start).sort().at(-1) || '';

/** Séances de révision prévues pour les épreuves à venir (recalculées à chaque affichage). */
const revisionPlan = () => planRevisions(examList(), { today: new Date(), load: dayLoad, lastEnd });

/** Documents d'une matière rangés par rubrique (Cours, TD, TP, Annales, Autres). */
function examDocs(subjectId) {
  const groups = new Map();
  for (const f of filesOf(subjectId).sort((a, b) => a.path.localeCompare(b.path, 'fr', { numeric: true }))) {
    const k = docKind(contentDirs(f.path).slice(1));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  return KIND_ORDER.filter((k) => groups.has(k)).map((k) => ({ kind: k, files: groups.get(k) }));
}
const docKey = (subjectId, f) => `${subjectId}|${f.id}`;

/** Avancement d'une épreuve : séances faites et documents revus, sur le total. */
function examProgress(exam, plan) {
  const revs = plan.filter((r) => r.exam === exam);
  const docs = examDocs(exam.subjectId).flatMap((g) => g.files);
  const total = revs.length + docs.length;
  const done = revs.filter((r) => S.revisions.done[r.key]).length + docs.filter((f) => S.revisions.checked[docKey(exam.subjectId, f)]).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

const revWhen = (r) => (r.after ? `après ${r.after.replace(':', 'h')}` : 'journée sans cours');

function revRow(r, { withDate = true } = {}) {
  const today = ymd(new Date());
  const late = r.date < today && !S.revisions.done[r.key];
  const id = `rv-${keyOf(r.key).replace(/ /g, '-')}`;
  return `<div class="dl rev ${S.revisions.done[r.key] ? 'done' : ''}">
    <input type="checkbox" id="${esc(id)}" data-rev="${esc(r.key)}" ${S.revisions.done[r.key] ? 'checked' : ''}>
    <label class="what" for="${esc(id)}">
      <b>${withDate ? esc(subjectName(r.exam.subjectId)) : esc(stageLabel(r.stage))}</b>
      <span class="muted small">${withDate
        ? `${esc(stageLabel(r.stage))} · examen ${esc(fmtLong(parseYmd(r.exam.date)).toLowerCase())}`
        : `${esc(fmtLong(parseYmd(r.date)))} · ${esc(revWhen(r))}`}</span>
    </label>
    ${late ? '<span class="badge warn">En retard</span>' : withDate ? `<span class="badge plain">${esc(r.date === today ? revWhen(r) : relDue(r.date).label)}</span>` : ''}
  </div>`;
}

/* ---------- Petits composants ---------- */

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

let busyCancel = null;
let busyClock = null;

/** Fenêtre d'attente. pct = null : barre animée. opts.onCancel ajoute un bouton Annuler, opts.clock un chrono. */
function busy(title, detail = '', pct = null, opts = {}) {
  const o = $('#overlay');
  clearInterval(busyClock); busyClock = null;
  if (title === null) { o.hidden = true; o.innerHTML = ''; busyCancel = null; return; }
  busyCancel = opts.onCancel || null;
  o.hidden = false;
  o.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <h2>${esc(title)}</h2>
    ${detail ? `<div class="muted small" style="overflow-wrap:anywhere">${esc(detail)}</div>` : ''}
    <div class="small" id="busyStep" aria-live="polite">${esc(opts.step || '')}</div>
    <div class="progress ${pct === null ? 'indeterminate' : ''}"><i style="width:${pct === null ? 30 : Math.round(pct * 100)}%"></i></div>
    ${opts.clock || busyCancel ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span class="muted small" id="busyElapsed">${opts.clock ? '0 s' : ''}</span>
      ${busyCancel ? '<button class="btn" data-act="busy-cancel">Annuler</button>' : ''}</div>` : ''}
  </div>`;
  if (opts.clock) {
    const t0 = Date.now();
    busyClock = setInterval(() => {
      const el = $('#busyElapsed');
      if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s${opts.hint && Date.now() - t0 > 20000 ? ' · ' + opts.hint : ''}`;
    }, 1000);
  }
}

const busyStep = (text) => { const el = $('#busyStep'); if (el) el.textContent = text; };

function sessionRow(s, date) {
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const live = date && ymd(date) === ymd(now) && s.start <= hm && hm < (s.end || '24:00');
  const meta = [s.type, s.room, s.teacher].filter(Boolean).join(' · ');
  return `<a class="session" href="#/matiere/${esc(s.subjectId)}">
    <div class="time"><b>${esc(s.start)}</b><span class="muted small">${esc(s.end)}</span></div>
    <span class="bar" style="background:${esc(subjectColor(s.subjectId))}"></span>
    <div class="what"><b>${esc(subjectName(s.subjectId))}</b><span class="muted small">${esc(meta || '—')}</span></div>
    ${s.exam ? '<span class="badge exam-badge">Examen</span>' : live ? '<span class="badge">En cours</span>' : ''}
  </a>`;
}

function deadlineRow(d) {
  const r = relDue(d.due);
  return `<div class="dl ${d.done ? 'done' : ''}">
    <input type="checkbox" id="dl-${esc(d.id)}" data-act="toggle-dl" data-id="${esc(d.id)}" ${d.done ? 'checked' : ''}>
    <label class="what" for="dl-${esc(d.id)}">
      <b>${esc(d.title)}</b>
      <span class="muted small">${esc([d.kind, d.subjectId ? subjectName(d.subjectId) : ''].filter(Boolean).join(' · '))}</span>
    </label>
    <span class="badge ${r.urgent && !d.done ? 'warn' : 'plain'}">${esc(r.label)}</span>
    <button class="btn ghost icon" data-act="del-dl" data-id="${esc(d.id)}" aria-label="Supprimer « ${esc(d.title)} »">×</button>
  </div>`;
}

function subjectOptions(selected, { emptyLabel = '—' } = {}) {
  return `<option value="">${esc(emptyLabel)}</option>` + S.subjects
    .filter((s) => s.id === selected || !isActivity(s.id))
    .map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

function addDeadlineForm(subjectId = '') {
  const tomorrow = ymd(addDays(new Date(), 1));
  return `<details class="add">
    <summary class="btn" style="width:100%">+ Ajouter un devoir, une interro…</summary>
    <form id="dlForm" class="form-grid">
      <label class="f full">Intitulé<input class="input sm" name="title" required placeholder="TP Docker, interro chap. 3…"></label>
      <label class="f">Matière<select class="input sm" name="subjectId">${subjectOptions(subjectId)}</select></label>
      <label class="f">Type<select class="input sm" name="kind">
        <option>Devoir</option><option>Interro</option><option>Examen</option><option>Projet</option><option>Exercices</option></select></label>
      <label class="f full">Pour le<input class="input sm" type="date" name="due" value="${tomorrow}" required></label>
      <button class="btn primary full" type="submit">Ajouter</button>
    </form>
  </details>`;
}

/* ---------- Projets et compétitions ---------- */


/** La date limite la plus proche en tête ; sans date, à la fin. */
const pendingProjects = () => S.projects.filter((p) => !p.done)
  .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.name.localeCompare(b.name));

function projectForm(p = null) {
  const v = p || { name: '', kind: 'Projet', due: '', url: '', next: '' };
  return `<form id="projForm" class="form-grid proj-form">
    ${p ? `<input type="hidden" name="pid" value="${esc(p.id)}">` : ''}
    <label class="f full">Nom<input class="input sm" name="name" required value="${esc(v.name)}" placeholder="Hackathon, application de gestion…"></label>
    <label class="f">Type<select class="input sm" name="kind">${PROJECT_KINDS.map((k) => `<option ${k === v.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="f">Date limite<input class="input sm" type="date" name="due" value="${esc(v.due || '')}"></label>
    <label class="f full">Me le rappeler<select class="input sm" name="remind">${REMINDERS.map((r) => `<option value="${r.v}" ${r.v === (v.remind ?? DEFAULT_REMIND) ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
    <label class="f full">Prochaine étape<input class="input sm" name="next" value="${esc(v.next || '')}" placeholder="Maquette, envoyer le dossier…"></label>
    <label class="f full">Lien (dépôt, plateforme)<input class="input sm" name="url" type="url" value="${esc(v.url || '')}" placeholder="https://github.com/…"></label>
    <div class="full proj-form-actions">
      ${p ? `<button class="btn ghost small" type="button" data-act="proj-del" data-id="${esc(p.id)}">Supprimer</button><span style="flex:1"></span>` : ''}
      <button class="btn small" type="button" data-act="proj-cancel">Annuler</button>
      <button class="btn primary small" type="submit">${p ? 'Enregistrer' : 'Ajouter'}</button>
    </div>
  </form>`;
}

function projectRow(p) {
  if (S.ui.projEdit === p.id) return `<div class="proj editing">${projectForm(p)}</div>`;
  const r = p.due && !p.done ? relDue(p.due) : null;
  const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
  const name = p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
  return `<div class="proj ${p.done ? 'done' : ''}">
    <div class="proj-top">
      <span class="proj-kind k-${esc(keyOf(p.kind).replace(/ /g, '-'))}">${esc(p.kind)}</span>
      <b class="proj-name">${name}</b>
      ${r ? `<span class="badge ${r.urgent ? 'warn' : 'plain'}" title="Date limite : ${esc(fmtLong(parseYmd(p.due)))}">${esc(r.label)}</span>` : ''}
    </div>
    ${p.next && !p.done ? `<div class="proj-next small"><span class="muted">Prochaine étape :</span> ${esc(p.next)}</div>` : ''}
    <div class="proj-prog">
      <input type="range" min="0" max="100" step="10" value="${pct}" data-proj-progress="${esc(p.id)}" style="--p:${pct}%"
        aria-label="Avancement de ${esc(p.name)}" ${p.done ? 'disabled' : ''}>
      <span class="small muted" data-proj-pct="${esc(p.id)}">${pct} %</span>
    </div>
    <div class="proj-actions">
      ${p.done
    ? `<button class="btn ghost small" data-act="proj-reopen" data-id="${esc(p.id)}">Reprendre</button>
         <button class="btn ghost small" data-act="proj-del" data-id="${esc(p.id)}">Supprimer</button>`
    : `<button class="btn ghost small" data-act="proj-edit" data-id="${esc(p.id)}">Modifier</button>
         <button class="btn ghost small" data-act="proj-done" data-id="${esc(p.id)}">Terminé ✓</button>`}
    </div>
  </div>`;
}

function projectsCard() {
  const list = pendingProjects();
  const done = S.projects.filter((p) => p.done);
  return `<section class="card" aria-labelledby="h-proj">
    <div class="head"><h2 id="h-proj">Projets & compétitions</h2>
      ${done.length ? `<button class="btn ghost small" data-act="proj-show-done">${S.ui.showProjDone ? 'Masquer' : 'Voir'} les terminés (${done.length})</button>` : ''}</div>
    <div class="projs">${fitList('proj', homeList('proj').items, S.ui.projEdit === 'new' || list.length ? '' : '<div class="empty">Aucun projet en cours.</div>')}</div>
    ${S.ui.projEdit === 'new' ? `<div class="proj editing">${projectForm()}</div>`
    : '<button class="btn proj-add" data-act="proj-new">+ Ajouter un projet</button>'}
  </section>`;
}

/* ---------- Salutation de l'accueil ---------- */

// Icônes selon le moment : soleil levant, soleil, coucher, lune ; étincelle pour les jours particuliers.
const GREET_ICONS = {
  morning: '<path d="M12 3v2M5.6 7.6l1.4 1.4M18.4 7.6 17 9M3 15h2M19 15h2"/><path d="M7 15a5 5 0 0 1 10 0"/><path d="M3 19h18"/>',
  day: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  evening: '<path d="M12 9V3M8 6l4-3 4 3"/><path d="M5.6 12.6l1.4 1.4M18.4 12.6 17 14M3 19h2M19 19h2"/><path d="M7 19a5 5 0 0 1 10 0"/>',
  night: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
};

/**
 * Une phrase d'accueil qui change, comme sur claude.ai : selon l'heure, le jour, et ce qui t'attend
 * (examen, rendu du jour). Tirée une fois au chargement, puis gardée tant que le moment de la journée ne change pas.
 * Formulations neutres (pas d'accord masculin/féminin).
 */
function greeting() {
  const now = new Date();
  const h = now.getHours(); const wd = isoDay(now);
  const moment = h >= 5 && h < 12 ? 'morning' : h < 18 && h >= 12 ? 'day' : h >= 18 && h < 23 ? 'evening' : 'night';
  const key = `${ymd(now)}:${moment}`;
  if (S.ui.greet?.key === key) return S.ui.greet;
  const n = (S.settings.firstName || '').trim();
  const name = (t) => (n ? t.replace('{n}', `, ${n}`) : t.replace('{n}', ''));
  const today = startOfDay(now);
  const examToday = examAnyOn(today); const examTomorrow = examAnyOn(addDays(today, 1));
  const dueToday = S.deadlines.filter((d) => !d.done && d.due === ymd(today)).length
    + S.projects.filter((p) => !p.done && p.due === ymd(today)).length;

  let pool; let icon = moment;
  if (examToday && h < 18) { pool = ['Courage pour les examens{n}', 'Jour d\'examen : tu vas assurer{n}', 'Respire, tout est révisé{n}']; icon = 'spark'; }
  else if (examTomorrow) { pool = ['Examens demain : on révise{n} ?', 'Dernière ligne droite{n}', 'Demain, examens. Une dernière révision ?']; icon = 'spark'; }
  else if (dueToday && h < 20) { pool = [`${dueToday > 1 ? `${dueToday} rendus` : 'Un rendu'} aujourd'hui{n}`, 'C\'est le jour du rendu{n}', 'On boucle ce rendu{n} ?']; icon = 'spark'; }
  else if (wd === 1 && moment === 'morning') pool = ['Nouvelle semaine, nouveau départ{n}', 'Bon lundi{n}', 'C\'est reparti pour une semaine{n}'];
  else if (wd === 5 && moment !== 'morning') pool = ['Bientôt le week-end{n}', 'Bon vendredi{n}', 'Encore un effort avant le week-end{n}'];
  else if (wd >= 6 && moment !== 'night') pool = ['Bon week-end{n}', `Un ${wd === 6 ? 'samedi' : 'dimanche'} studieux{n} ?`, 'Un peu de révisions ce week-end{n} ?', 'Repos ou révisions{n} ?'];
  else pool = {
    morning: ['Bonjour{n}', 'Belle matinée{n}', 'Café et cours{n} ?', 'Que veux-tu apprendre aujourd\'hui{n} ?', 'Une bonne journée pour avancer{n}'],
    day: ['Bon après-midi{n}', 'On s\'y remet{n} ?', 'Et maintenant, on avance sur quoi{n} ?', 'Une pause, puis on reprend{n} ?'],
    evening: ['Bonsoir{n}', 'Encore un peu de révisions{n} ?', 'La soirée t\'appartient{n}', 'Un dernier effort pour aujourd\'hui{n} ?'],
    night: ['Il se fait tard{n}', 'Encore debout{n} ?', 'Pense à dormir un peu{n}', 'Nuit de révisions{n} ?'],
  }[moment];
  const prev = S.ui.greet?.text;
  const choices = pool.map(name).filter((t) => t !== prev);
  S.ui.greet = { key, text: choices[Math.floor(Math.random() * choices.length)] || name(pool[0]), icon };
  return S.ui.greet;
}

function greetBlock(today) {
  const g = greeting();
  return `<div class="greet">
    <span class="greet-date">${esc(fmtLong(today))}</span>
    <h1><svg class="greet-ico" viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GREET_ICONS[g.icon]}</svg>${esc(g.text)}</h1>
  </div>`;
}

/* ---------- Widgets de l'accueil : jamais de défilement ---------- */

/** Éléments d'un widget (HTML), dans l'ordre d'affichage. */
function homeList(kind) {
  if (kind === 'day') {
    const day = addDays(startOfDay(new Date()), S.ui.day);
    return { title: `Mes cours ${S.ui.day === 0 ? "aujourd'hui" : 'demain'}`, items: sessionsOn(day).map((s) => sessionRow(s, day)) };
  }
  if (kind === 'rev') {
    const today = ymd(new Date());
    return { title: 'À réviser', items: revisionPlan().filter((r) => r.date <= today && !S.revisions.done[r.key]).map((r) => revRow(r)) };
  }
  if (kind === 'due') {
    return { title: 'À rendre', items: [...pendingDeadlines(), ...(S.ui.showDone ? S.deadlines.filter((d) => d.done) : [])].map(deadlineRow) };
  }
  return { title: 'Projets & compétitions',
    items: [...pendingProjects(), ...(S.ui.showProjDone ? S.projects.filter((p) => p.done) : [])].map(projectRow) };
}

/** Liste d'un widget : fitWidgets() masque ce qui dépasse de l'écran, le bouton « Voir plus » montre tout. */
const fitList = (kind, items, empty = '') => `<div class="fit-list" data-fit="${kind}">${items.join('') || empty}</div>
  <button class="btn ghost small fit-more" data-act="fit-more" data-fit="${kind}" hidden></button>`;

/**
 * Chaque widget s'arrête au bas de la fenêtre : les derniers éléments sont masqués (au moins un reste visible)
 * et « Voir plus (N) » apparaît. Recalculé à chaque affichage, redimensionnement ou formulaire ouvert.
 */
function fitWidgets() {
  const lists = [...document.querySelectorAll('[data-fit]')].filter((l) => l.matches('.fit-list'));
  if (!lists.length) return;
  // Le bas de la page (marge sous les cartes) doit rester dans la fenêtre lui aussi.
  const limit = window.innerHeight - (parseFloat(getComputedStyle(view).paddingBottom) || 0) - 2;
  for (const list of lists) {
    const items = [...list.children].filter((c) => !c.matches('.fit-keep, .empty, .editing'));
    const btn = list.parentElement.querySelector(`.fit-more[data-fit="${list.dataset.fit}"]`);
    items.forEach((i) => { i.hidden = false; });
    btn.hidden = true;
    const card = list.closest('.card');
    const bottom = () => card.getBoundingClientRect().bottom + window.scrollY;
    let shown = items.length;
    while (shown > 1 && bottom() > limit) {
      items[--shown].hidden = true;
      btn.hidden = false;
      btn.textContent = `Voir plus (${items.length - shown})`;
    }
  }
}

/** Fenêtre « Voir plus » : la liste complète du widget ; elle se met à jour après chaque action. */
function showMore() {
  const o = $('#overlay');
  const kind = S.ui.more;
  if (!kind || location.hash.replace(/^#\/?/, '') !== '') { if (o.dataset.more) { o.hidden = true; o.innerHTML = ''; delete o.dataset.more; } S.ui.more = null; return; }
  const { title, items } = homeList(kind);
  o.dataset.more = kind;
  o.hidden = false;
  o.innerHTML = `<div class="box more-box" role="dialog" aria-modal="true" aria-labelledby="moreTitle">
    <div class="head" style="margin:0"><h2 id="moreTitle">${esc(title)} <span class="muted small">(${items.length})</span></h2>
      <button class="btn ghost icon" data-act="more-close" aria-label="Fermer">×</button></div>
    <div class="more-list">${items.join('') || '<div class="empty">Plus rien ici.</div>'}</div>
  </div>`;
}

/* ---------- Vues ---------- */

function visibleShortcuts() {
  const prefs = S.shortcuts;
  const seen = new Set();
  const all = [...prefs.custom.map((c) => ({ ...c, favicon: '', custom: true })), ...S.topSites]
    .filter((s) => { const h = hostOf(s.url); if (seen.has(h) || prefs.removed.includes(h)) return false; seen.add(h); return true; });
  return { shown: all.slice(0, 10) };
}

function shortcutTile(s) {
  const name = cleanTitle(s.title, s.url);
  const h = hostOf(s.url);
  return `<div class="sc">
    <a class="sc-link" href="${esc(s.url)}">
      <span class="sc-ico">${s.favicon ? `<img src="${esc(s.favicon)}" alt="" width="32" height="32">` : `<span aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>`}</span>
      <span class="sc-name">${esc(name)}</span>
    </a>
    <details class="sc-menu">
      <summary aria-label="Options de ${esc(name)}">⋯</summary>
      <div class="menu">
        <button data-act="sc-remove" data-host="${esc(h)}" data-custom="${s.custom ? s.id : ''}">Retirer</button>
      </div>
    </details>
  </div>`;
}

function viewHome() {
  const today = startOfDay(new Date());
  const day = addDays(today, S.ui.day);
  const sessions = sessionsOn(day);
  const deadlines = pendingDeadlines();
  const doneCount = S.deadlines.filter((d) => d.done).length;
  const hour = new Date().getHours();
  const sc = visibleShortcuts();

  const setup = [];
  if (!allSessions().length) setup.push('edt');
  if (!S.files.length) setup.push('folder');
  if (!S.settings.apiKey) setup.push('key');
  if (S.settings.hideSetup) setup.length = 0;

  let emptyDay = '';
  if (!sessions.length) {
    const nxt = nextSessions(null, 1, addDays(day, 1));
    emptyDay = `<div class="empty">Pas de cours ${S.ui.day === 0 ? "aujourd'hui" : 'demain'}.
      ${nxt.length ? `<br>Prochain : <b>${esc(subjectName(nxt[0].subjectId))}</b>, ${esc(fmtLong(nxt[0].on).toLowerCase())} à ${esc(nxt[0].start)}.` : ''}</div>`;
  }

  return `
  <section class="home-hero">
    ${greetBlock(today)}
    <form id="webForm" class="bigsearch" role="search">
      <label class="sr" for="q">Rechercher sur le web ou dans tes cours</label>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="q" type="search" data-search="" data-limit="6" placeholder="Rechercher sur le web ou dans tes cours" autocomplete="off">
    </form>
    <section id="results" class="card dropdown" hidden aria-live="polite"></section>
  </section>

  <section class="shortcuts" aria-label="Raccourcis">
    ${sc.shown.map(shortcutTile).join('')}
    <div class="sc"><button class="sc-link sc-add" data-act="sc-add"><span class="sc-ico" aria-hidden="true">+</span><span class="sc-name">Ajouter</span></button></div>
  </section>

  ${setup.length ? `<section class="steps" aria-label="Pour commencer">
    ${setup.includes('edt') ? `<div class="step"><b>Ton emploi du temps</b>
      <span class="muted small">Dépose le PDF de l'école, l'IA reconstruit ton planning.</span>
      <a class="btn" href="#/reglages">Importer</a></div>` : ''}
    ${setup.includes('folder') ? `<div class="step"><b>Ton dossier de cours</b>
      <span class="muted small">Choisis le dossier où sont tes PDF : ils seront rangés par matière et cherchables.</span>
      <button class="btn" data-act="pick-folder">Choisir le dossier</button></div>` : ''}
    ${setup.includes('key') ? `<div class="step"><b>Clé IA gratuite</b>
      <span class="muted small">Optionnel, mais nécessaire pour lire l'emploi du temps automatiquement.</span>
      <a class="btn" href="#/reglages">Ajouter la clé</a></div>` : ''}
    <button class="btn ghost icon steps-close" data-act="setup-hide" aria-label="Masquer ces suggestions" title="Masquer (tout reste dans Réglages → Imports)">×</button>
  </section>` : ''}

  <div class="widgets">
    <section class="card" aria-labelledby="h-day">
      <div class="head">
        <h2 id="h-day">Mes cours</h2>
        <div class="seg" role="group" aria-label="Jour">
          <button data-act="day" data-v="0" aria-pressed="${S.ui.day === 0}">Aujourd'hui</button>
          <button data-act="day" data-v="1" aria-pressed="${S.ui.day === 1}">Demain</button>
        </div>
      </div>
      <div class="stack">${examAnyOn(day) ? `<div class="exam-tag">${esc(examAnyOn(day).label || 'Examens')} ${S.ui.day === 0 ? "aujourd'hui" : 'demain'}</div>` : ''}
        ${fitList('day', homeList('day').items, examAnyOn(day) ? '' : emptyDay)}</div>
    </section>

    <section class="card" aria-labelledby="h-due">
      <div class="head"><h2 id="h-due">À rendre</h2>
        ${doneCount ? `<button class="btn ghost small" data-act="show-done">${S.ui.showDone ? 'Masquer' : 'Voir'} les terminés (${doneCount})</button>` : ''}</div>
      ${fitList('due', homeList('due').items, '<div class="empty">Rien à rendre pour l\'instant.</div>')}
      ${addDeadlineForm()}
    </section>

    ${revCard()}

    ${projectsCard()}
  </div>`;
}

/** Widget « À réviser » : les séances du jour (et celles en retard). Absent sans épreuve à venir. */
function revCard() {
  const plan = revisionPlan();
  if (!plan.length) return '';
  const next = plan.find((r) => r.date > ymd(new Date()) && !S.revisions.done[r.key]);
  const empty = `<div class="empty">Rien à réviser aujourd'hui.${next ? `<br>Prochaine séance : <b>${esc(subjectName(next.exam.subjectId))}</b>, ${esc(fmtLong(parseYmd(next.date)).toLowerCase())}.` : ''}</div>`;
  return `<section class="card" aria-labelledby="h-rev">
      <div class="head"><h2 id="h-rev">À réviser</h2><a class="btn ghost small" href="#/revisions">Planning</a></div>
      ${fitList('rev', homeList('rev').items, empty)}
    </section>`;
}

/* ---------- Page Révisions ---------- */

function viewRevisions() {
  const plan = revisionPlan();
  const today = ymd(new Date());
  const exams = [...new Set(plan.map((r) => r.exam))];
  const intro = `<p class="muted" style="margin:0">Avant chaque épreuve : une séance à J-14, J-7, J-3 et la veille, placées sur tes jours les moins chargés (jamais plus de deux par jour).
    Coche les séances faites et les documents revus.</p>`;
  if (!exams.length) {
    const past = examList().length;
    return `<h1>Révisions</h1>${intro}
      <div class="notice">${past ? 'Toutes tes épreuves sont passées.' : 'Aucune épreuve connue pour l\'instant.'}
        Importe le calendrier des examens dans <a href="#/reglages">Réglages → Imports</a> : le planning se crée tout seul.</div>`;
  }
  return `<h1>Révisions</h1>${intro}
  <div class="rev-list">${exams.map((e) => {
    const p = examProgress(e, plan);
    const n = daysBetween(new Date(), parseYmd(e.date));
    const docs = examDocs(e.subjectId);
    return `<section class="card rev-exam" style="--c:${esc(subjectColor(e.subjectId))}" aria-labelledby="h-rv-${esc(e.id)}">
      <div class="rev-head">
        <span class="sp-chip" style="background:${esc(subjectColor(e.subjectId))}" aria-hidden="true"></span>
        <div><h2 id="h-rv-${esc(e.id)}"><a href="#/matiere/${esc(e.subjectId)}">${esc(subjectName(e.subjectId))}</a></h2>
          <div class="muted small">${esc(e.type && e.type !== 'Examen' ? e.type : 'Examen')} · ${esc(fmtLong(parseYmd(e.date)))} · ${esc(e.start.replace(':', 'h'))}${e.room ? ` · ${esc(e.room)}` : ''}</div></div>
        <span class="badge ${n <= 3 ? 'warn' : 'plain'}">${n === 1 ? 'demain' : `dans ${n} jours`}</span>
      </div>
      <div class="rev-bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Avancement">
        <i style="width:${p.pct}%"></i></div>
      <div class="muted small">${p.done}/${p.total} · ${p.pct} %</div>
      <div class="rev-grid">
        <div><h3>Séances</h3>${plan.filter((r) => r.exam === e).map((r) => revRow(r, { withDate: false })).join('')}</div>
        <div><h3>À revoir</h3>${docs.length ? docs.map((g) => `<div class="fgroup"><h4>${esc(g.kind)} <span class="muted">(${g.files.filter((f) => S.revisions.checked[docKey(e.subjectId, f)]).length}/${g.files.length})</span></h4>
          ${g.files.map((f) => { const k = docKey(e.subjectId, f); const id = `rd-${esc(e.id)}-${esc(f.id)}`; return `<div class="dl ${S.revisions.checked[k] ? 'done' : ''}">
            <input type="checkbox" id="${id}" data-revdoc="${esc(k)}" ${S.revisions.checked[k] ? 'checked' : ''}>
            <label class="what" for="${id}"><b>${esc(f.name.replace(/\.pdf$/i, ''))}</b></label>
            <button class="btn ghost small" data-act="open-file" data-id="${esc(f.id)}">Ouvrir</button></div>`; }).join('')}</div>`).join('')
          : `<div class="empty">Aucun PDF rattaché à cette matière. ${S.files.length ? `Range-les depuis <a href="#/matiere/${esc(e.subjectId)}">Mon semestre</a>.` : 'Choisis ton dossier de cours dans les <a href="#/reglages">Réglages</a>.'}</div>`}
          ${docs.length && !docs.some((g) => g.kind === 'Annales') ? '<p class="muted small" style="margin:6px 0 0">Pas d\'annales : ajoute un dossier « Annales » dans cette matière pour t\'entraîner sur d\'anciens sujets.</p>' : ''}
        </div>
      </div>
    </section>`;
  }).join('')}</div>`;
}

const dueByDay = (d) => S.deadlines.filter((x) => !x.done && x.due === ymd(d));
const selectedDay = () => (S.ui.selDay ? parseYmd(S.ui.selDay) : startOfDay(new Date()));

/** Petit calendrier du mois : un clic sur un jour affiche sa semaine et le met en valeur. */
function miniCalendar(sel) {
  const today = startOfDay(new Date());
  const month = S.ui.calMonth ? parseYmd(S.ui.calMonth) : new Date(sel.getFullYear(), sel.getMonth(), 1);
  const start = startOfWeek(month);
  const nWeeks = Math.ceil((daysBetween(start, new Date(month.getFullYear(), month.getMonth() + 1, 0)) + 1) / 7);
  const selMonday = ymd(startOfWeek(sel));
  const title = month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const weeks = Array.from({ length: nWeeks }, (_, w) => {
    const monday = addDays(start, w * 7);
    return `<div class="cal-row ${ymd(monday) === selMonday ? 'in-week' : ''}">${Array.from({ length: 7 }, (_, k) => {
      const d = addDays(monday, k);
      const n = sessionsOn(d).length; const due = dueByDay(d).length; const exam = examAnyOn(d);
      const label = `${fmtLong(d)}${exam ? ', examens' : ''}${n ? `, ${n} cours` : ''}${due ? `, ${due} à rendre` : ''}`;
      return `<button class="cal-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${ymd(d) === ymd(today) ? 'today' : ''} ${exam ? 'exam' : ''}"
        data-act="pick-day" data-v="${ymd(d)}" aria-pressed="${ymd(d) === ymd(sel)}" aria-label="${esc(label)}">
        <span>${d.getDate()}</span>
        <i class="cal-marks" aria-hidden="true">${n ? '<i class="m-course"></i>' : ''}${due ? '<i class="m-due"></i>' : ''}</i>
      </button>`;
    }).join('')}</div>`;
  }).join('');
  return `<section class="card cal" aria-label="Calendrier">
    <div class="cal-head">
      <button class="btn ghost icon" data-act="cal-month" data-v="-1" aria-label="Mois précédent">‹</button>
      <b>${esc(title.charAt(0).toUpperCase() + title.slice(1))}</b>
      <button class="btn ghost icon" data-act="cal-month" data-v="1" aria-label="Mois suivant">›</button>
    </div>
    <div class="cal-row cal-dows" aria-hidden="true">${DAYS.map((n) => `<span>${n.charAt(0)}</span>`).join('')}</div>
    ${weeks}
    <div class="cal-foot">
      <span class="muted small cal-legend"><i class="m-course"></i> cours <i class="m-due"></i> à rendre <i class="m-exam"></i> examens</span>
      <button class="btn small" data-act="pick-day" data-v="${ymd(today)}">Aujourd'hui</button>
    </div>
  </section>`;
}

function viewWeek() {
  const today = startOfDay(new Date());
  const sel = selectedDay();
  const monday = startOfWeek(sel);
  let days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  days = days.filter((d, i) => i < 5 || ymd(d) === ymd(sel) || sessionsOn(d).length || dueByDay(d).length || examAnyOn(d));
  // « Semaine 3 · M2 SIGL-ID2C » si la semaine tombe dans un semestre daté.
  const sem = S.semesters.find((x) => { const r = semRange(x); return r && addDays(monday, 6) >= r.start && monday <= r.end; });
  const wn = sem && weekNumber(sem, monday);
  const semInfo = sem ? `${wn ? `Semaine ${wn}` : examAnyOn(monday) || days.some((d) => examAnyOn(d)) ? "Semaine d'examens" : 'Hors cours'} · ${semLabel(sem)}` : '';
  return `
  <div class="head">
    <div><h1 style="margin:0">Semaine du ${esc(fmtShort(monday))}</h1>${semInfo ? `<div class="muted small">${esc(semInfo)}</div>` : ''}</div>
  </div>
  ${!allSessions().length ? '<div class="notice">Aucun emploi du temps pour l\'instant. <a href="#/reglages">Importer le PDF</a>.</div>' : ''}
  <div class="week-layout">
  ${miniCalendar(sel)}
  <div class="week-scroll"><div class="week">
    ${days.map((d) => `<section class="day ${ymd(d) === ymd(today) ? 'today' : ''} ${ymd(d) === ymd(sel) ? 'selected' : ''}" aria-label="${esc(fmtLong(d))}" ${ymd(d) === ymd(sel) ? 'aria-current="date"' : ''}>
      <h3><button class="day-pick" data-act="pick-day" data-v="${ymd(d)}">${esc(DAYS[isoDay(d) - 1])} ${d.getDate()}</button>${ymd(d) === ymd(today) ? '<span class="badge">Aujourd\'hui</span>' : ''}</h3>
      ${examAnyOn(d) ? `<div class="exam-tag">${esc(examAnyOn(d).label || 'Examens')}</div>` : ''}
      ${sessionsOn(d).map((s) => `<a class="slot ${s.exam ? 'is-exam' : ''}" href="#/matiere/${esc(s.subjectId)}" style="background:color-mix(in srgb, ${esc(subjectColor(s.subjectId))} 16%, var(--card))">
        <div class="t">${esc(s.start)} – ${esc(s.end)}</div><b>${esc(subjectName(s.subjectId))}</b>
        <div class="r">${esc([s.type, s.room].filter(Boolean).join(' · '))}</div></a>`).join('')}
      ${dueByDay(d).map((x) => `<div class="due">À rendre : ${esc(x.title)}</div>`).join('')}
      ${!sessionsOn(d).length && !dueByDay(d).length && !examAnyOn(d) ? '<div class="muted small day-empty">Pas de cours</div>' : ''}
    </section>`).join('')}
  </div></div>
  </div>`;
}

function fileRow(f) {
  const sid = subjectOfFile(f);
  const auto = !f.subjectId;
  return `<div class="file">
    <div class="fname"><button data-act="open-file" data-id="${esc(f.id)}">${esc(f.name)}</button>
      <div class="path">${esc(f.path)} · ${f.pageCount ? `${f.pageCount} p.` : (f.error ? 'texte illisible' : '—')} · ${esc(fmtSize(f.size))}</div></div>
    <label class="sr" for="as-${esc(f.id)}">Matière de ${esc(f.name)}</label>
    <select class="input sm" id="as-${esc(f.id)}" data-assign="${esc(f.id)}">${subjectOptions(sid, { emptyLabel: '— À classer' })}</select>
    ${auto && sid ? '<span class="badge plain" title="Matière devinée automatiquement">auto</span>' : ''}
  </div>`;
}

/* ---------- Mon semestre : liste des matières + contenu ---------- */

const unclassifiedFiles = () => S.files.filter((f) => !subjectOfFile(f)).sort((a, b) => a.path.localeCompare(b.path, 'fr', { numeric: true }));

/** Matières du semestre affiché, puis les autres (dossiers, anciens semestres). Les activités sont à part. */
/** Période d'une matière : celle de la plupart de ses PDF (« Semestre 1 / Partie 2 / ETL / … »). */
function subjectPeriod(id) {
  const counts = new Map();
  for (const f of filesOf(id)) {
    const p = periodOf(f.path); if (!p) continue;
    const k = JSON.stringify(p);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? JSON.parse(best[0]) : null;
}

/** Période d'un semestre de l'appli, d'après son nom ou son PDF (« M2 SIGL · Partie 1 »). */

/**
 * Matières du semestre affiché (celles de son emploi du temps, et celles rangées dans le dossier de la même période),
 * puis les autres, regroupées par période d'après leurs dossiers.
 */
function subjectGroups() {
  const sem = currentSem();
  const inSem = new Set(sem ? sem.sessions.map((s) => s.subjectId) : []);
  const sp = semPeriod(sem);
  const byName = (a, b) => a.name.localeCompare(b.name, 'fr');
  const courses = S.subjects.filter((s) => !isActivity(s.id));
  const period = new Map(courses.map((s) => [s.id, subjectPeriod(s.id)]));
  const isCur = (s) => inSem.has(s.id) || (sp && samePeriod(period.get(s.id), sp));
  const cur = courses.filter(isCur).sort(byName);
  const others = new Map();
  for (const s of courses.filter((x) => !isCur(x))) {
    const label = periodLabel(period.get(s.id));
    if (!others.has(label)) others.set(label, []);
    others.get(label).push(s);
  }
  // Périodes dans l'ordre (Semestre 1 · Partie 1, Partie 2…), sans période à la fin.
  const order = (l) => { const p = periodOfText(l) || {}; return l ? (p.sem || 0) * 10 + (p.part || 0) : 1e9; };
  const other = [...others.entries()].sort((a, b) => order(a[0]) - order(b[0]))
    .map(([label, list]) => ({ label, list: list.sort(byName) }));
  return { cur, other, sp };
}

function subjectItem(s, selected) {
  const nFiles = filesOf(s.id).length;
  const nDue = pendingDeadlines(s.id).length;
  const meta = [s.code || '', nFiles ? `${nFiles} PDF` : '', nDue ? `${nDue} à rendre` : ''].filter(Boolean).join(' · ');
  return `<a class="sl-item" href="#/matiere/${esc(s.id)}" ${selected === s.id ? 'aria-current="page"' : ''}>
    <span class="dot" style="background:${esc(s.color)}" aria-hidden="true"></span>
    <span class="sl-name">${esc(s.name)}</span>
    ${meta ? `<span class="sl-meta ${nDue ? 'has-due' : ''}">${esc(meta)}</span>` : ''}</a>`;
}

/** Fichiers rangés par sous-dossier (Cours, TD, Annales…). */
function fileGroups(files) {
  const groups = new Map();
  for (const f of files) {
    // Sans les dossiers de période ni celui de la matière : il reste « TD », « Cours »…
    const key = contentDirs(f.path).slice(1).join(' / ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr', { numeric: true })));
  if (keys.length === 1) return `<div class="files">${groups.get(keys[0]).map(fileRow).join('')}</div>`;
  return keys.map((k) => `<div class="fgroup"><h4>${esc(k || 'Divers')} <span class="muted">(${groups.get(k).length})</span></h4>
    <div class="files">${groups.get(k).map(fileRow).join('')}</div></div>`).join('');
}

function subjectPanel(id) {
  const s = subjectById(id);
  const files = filesOf(id).sort((a, b) => a.path.localeCompare(b.path, 'fr', { numeric: true }));
  const next = nextSessions(id, 8).find((x) => !x.exam);
  const today = ymd(new Date());
  const exam = allSessions().filter((x) => x.exam && x.subjectId === id && x.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))[0];
  const dls = pendingDeadlines(id);
  const doneDls = S.deadlines.filter((d) => d.done && d.subjectId === id);
  return `<section class="card sp" aria-labelledby="h-subj-name">
    <div class="sp-head">
      <span class="sp-chip" style="background:${esc(s.color)}" aria-hidden="true"></span>
      <div>
        <h2 id="h-subj-name">${esc(s.name)}</h2>
        <div class="muted small">${next
          ? `Prochain cours : ${esc(fmtLong(next.on).toLowerCase())} à ${esc(next.start)}${[next.type, next.room].filter(Boolean).length ? ' · ' + esc([next.type, next.room].filter(Boolean).join(' · ')) : ''}`
          : 'Aucun cours prévu.'}</div>
      </div>
      ${exam ? `<div class="sp-exam"><span class="badge exam-badge">${esc(exam.type || 'Examen')}</span>
        <b>${esc(fmtLong(parseYmd(exam.date)))}</b> · ${esc(exam.start.replace(':', 'h'))} – ${esc((exam.end || '').replace(':', 'h'))}${exam.room ? ` · ${esc(exam.room)}` : ''}
        <span class="muted small">(${(() => { const n = daysBetween(new Date(), parseYmd(exam.date)); return n > 6 ? `dans ${n} jours` : esc(relDue(exam.date).label); })()})</span>
        <a class="small" href="#/revisions">Planning de révisions</a></div>` : ''}
    </div>
    <div class="sp-grid">
      <div class="sp-files">
        <div class="head"><h3>Cours et documents <span class="muted">(${files.length})</span></h3></div>
        ${files.length ? `<label class="sr" for="sq">Rechercher dans ${esc(s.name)}</label>
          <input id="sq" class="input sm" type="search" data-search="${esc(id)}" placeholder="Rechercher dans ${esc(s.name)}…" autocomplete="off">
          <div id="results" class="results" hidden aria-live="polite" style="margin-top:8px"></div>` : ''}
        <div style="margin-top:6px">${files.length ? fileGroups(files) : `<div class="empty">Aucun PDF rattaché. ${S.files.length
          ? (unclassifiedFiles().length ? 'Range-les depuis <a href="#/a-classer">À classer</a>.' : 'Assigne un fichier à cette matière depuis une autre matière.')
          : '<button class="btn" data-act="pick-folder">Choisir mon dossier de cours</button>'}</div>`}</div>
      </div>
      <div class="sp-due">
        <div class="head"><h3>Devoirs à venir <span class="muted">(${dls.length})</span></h3></div>
        <div>${dls.map(deadlineRow).join('') || '<div class="empty">Rien à rendre pour cette matière.</div>'}
          ${S.ui.showDone ? doneDls.map(deadlineRow).join('') : ''}</div>
        ${doneDls.length ? `<button class="btn ghost small" data-act="show-done" style="margin-top:6px">${S.ui.showDone ? 'Masquer' : 'Voir'} les terminés (${doneDls.length})</button>` : ''}
        ${addDeadlineForm(id)}
      </div>
    </div>
  </section>`;
}

function unclassifiedPanel() {
  const files = unclassifiedFiles();
  return `<section class="card stack" aria-labelledby="h-uncl">
    <h2 id="h-uncl">PDF à classer</h2>
    <p class="muted small" style="margin:0">Choisis la matière de chaque fichier. Ton choix est retenu, même après une resynchronisation.
      ${S.subjects.length ? '' : 'Crée d\'abord tes matières (import de l\'emploi du temps ou <a href="#/reglages">Réglages</a>).'}</p>
    <div class="files">${files.map(fileRow).join('') || '<div class="empty">Tout est rangé.</div>'}</div>
  </section>`;
}

function viewCourses(sel) {
  const sem = currentSem();
  const { cur, other, sp } = subjectGroups();
  const nOther = other.reduce((n, g) => n + g.list.length, 0);
  const nUncl = unclassifiedFiles().length;
  let id = sel || S.ui.subject;
  if (id === 'a-classer' ? !nUncl && sel !== 'a-classer' : !subjectById(id)) id = cur[0]?.id || other[0]?.list[0]?.id || (nUncl ? 'a-classer' : null);
  S.ui.subject = id;

  if (!id) {
    return `<h1>Mon semestre</h1>
    <section class="card stack">
      <div class="muted">Aucune matière pour l'instant.</div>
      <p style="margin:0">Importe ton emploi du temps : chaque matière y est créée automatiquement. Ou choisis ton dossier de cours : un sous-dossier = une matière.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" href="#/reglages">Importer l'emploi du temps</a>
        <button class="btn" data-act="pick-folder">Choisir mon dossier de cours</button></div>
    </section>`;
  }

  const group = (title, list) => (list.length ? `${title ? `<div class="sl-title">${esc(title)}</div>` : ''}${list.map((s) => subjectItem(s, id)).join('')}` : '');
  return `
  <div class="head"><div><h1 style="margin:0">Mon semestre</h1>
      ${S.semesters.length > 1 ? `<label class="sr" for="semSel">Semestre</label>
        ${semSelect('semSel', sem?.id)}`
        : sem ? `<div class="muted small">${esc(semOptionLabel(sem))}</div>` : ''}</div></div>
  <div class="courses">
    <nav class="card sl" aria-label="Matières">
      ${group(nOther && cur.length ? `Ce semestre${sp ? ` · ${periodLabel(sp)}` : ''}` : '', cur)}
      ${other.map((g) => group(cur.length || other.length > 1 ? (g.label || 'Autres matières') : '', g.list)).join('')}
      ${nUncl ? `<a class="sl-item warn" href="#/a-classer" ${id === 'a-classer' ? 'aria-current="page"' : ''}>
        <span class="sl-name">À classer</span><span class="sl-meta">${nUncl} PDF</span></a>` : ''}
    </nav>
    ${id === 'a-classer' ? unclassifiedPanel() : subjectPanel(id)}
  </div>`;
}

/* ---------- Emploi du temps : grille semaine × jour × créneau, comme le PDF de l'école ---------- */

const toMin = (hm) => { const [h, m] = String(hm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const duration = (s) => Math.max(0, toMin(s.end || s.start) - toMin(s.start));
const fmtHours = (min) => { const h = Math.floor(min / 60); const m = min % 60; return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`; };
const typeOf = (s) => (s.type || '').trim().toUpperCase() || 'Autre';
const fmtNum = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Actions de la page Emploi du temps : modifier ; les imports sont dans Réglages → Imports. */
function ttActions(sem) {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap">
    ${sem ? '<button class="btn" data-act="edit-tt">Modifier les créneaux</button>' : '<a class="btn primary" href="#/reglages">Importer dans les Réglages</a>'}
    ${sem ? `<button class="btn ghost" data-act="sem-edit" aria-expanded="${!!S.ui.semEdit}">Paramètres</button>` : ''}
  </div>`;
}

const DISTINCT = PALETTE;
const STOP = new Set(['de', 'des', 'du', 'la', 'le', 'les', 'et', 'd', 'l', 'a', 'en', 'pour', 'au', 'aux', 'sur']);

/** Code court d'une matière : celui du PDF, sinon un sigle (« Deep learning » → DL). */
function subjectCode(id) {
  const s = subjectById(id);
  if (!s) return '?';
  if (s.code) return s.code;
  const base = s.name.replace(/\(.*?\)/g, '').trim();
  const words = keyOf(base).split(' ').filter((w) => w && !STOP.has(w));
  if (words.length <= 1) return base.slice(0, 10);
  return words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join('').toUpperCase().slice(0, 6);
}

/**
 * Les séances types de la journée (ex. 07h30–10h00, 10h15–12h45, 14h30–17h00) :
 * les heures de début les plus fréquentes du lundi au vendredi.
 */
function standardSlots(sessions) {
  const count = new Map();
  for (const s of sessions) {
    if (Number(s.weekday) > 5) continue;
    const k = `${s.start}-${s.end}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const slots = [];
  for (const [k] of top) {
    const [start, end] = k.split('-');
    // pas deux séances qui se chevauchent
    if (slots.some((x) => toMin(start) < toMin(x.end) && toMin(x.start) < toMin(end))) continue;
    slots.push({ start, end });
    if (slots.length === 3) break;
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/** Créneaux propres à un jour qui ne suit pas les séances types (le samedi matin, par ex.). */
function ownSlots(sessions, wd) {
  const byStart = new Map();
  for (const s of sessions) {
    if (Number(s.weekday) !== wd) continue;
    const ends = byStart.get(s.start) || new Map();
    ends.set(s.end, (ends.get(s.end) || 0) + 1);
    byStart.set(s.start, ends);
  }
  return [...byStart.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, ends]) => ({ start, end: [...ends.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
}

const overlaps = (s, slot) => toMin(s.start) < toMin(slot.end) && toMin(slot.start) < toMin(s.end || s.start);

/** Ligne de la grille d'une séance : le premier créneau recouvert, sinon celui dont le début est le plus proche. */
function slotIndex(s, rows) {
  const i = rows.findIndex((r) => r.start && overlaps(s, r));
  if (i !== -1) return i;
  let best = 0;
  rows.forEach((r, j) => { if (Math.abs(toMin(r.start) - toMin(s.start)) < Math.abs(toMin(rows[best].start) - toMin(s.start))) best = j; });
  return best;
}

/** Vrai si le calendrier des examens a été importé pour cette période. */
const examPlanned = (sem, period) => sem.sessions.some((s) => s.exam && s.date >= period.start && s.date <= period.end);
const examSessions = (sem) => sem.sessions.filter((s) => s.exam).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

function ttCell(items, span, cls) {
  const s = items[0];
  const tip = items.map((x) => `${subjectName(x.subjectId)}\n${x.start}–${x.end}${x.type ? ' · ' + x.type : ''}${x.room ? ' · ' + x.room : ''}${x.teacher ? ' · ' + x.teacher : ''}`).join('\n\n');
  return `<td class="tt-c ${cls}" ${span > 1 ? `rowspan="${span}"` : ''} style="--c:${esc(subjectColor(s.subjectId))}">
    ${items.map((x) => (x.exam
      // Épreuve : le code, l'heure exacte (elle ne suit pas forcément les séances) et la salle.
      ? `<a class="is-exam" href="#/matiere/${esc(x.subjectId)}" title="${esc(tip)}" aria-label="${esc('Examen, ' + tip.replace(/\n+/g, ', '))}">
        <b>${esc(subjectCode(x.subjectId))}</b><span>${esc(x.type || 'Examen')} · ${esc(x.start.replace(':', 'h'))}${x.room ? ' · ' + esc(x.room) : ''}</span></a>`
      : isActivity(x.subjectId)
      // Activité : son nom, dans un cadre discret, sans lien vers une fiche matière.
      ? `<span class="act" title="${esc(tip)}"><b>${esc(subjectName(x.subjectId))}</b></span>`
      : `<a href="#/matiere/${esc(x.subjectId)}" title="${esc(tip)}" aria-label="${esc(tip.replace(/\n+/g, ', '))}">
      <b>${esc(subjectCode(x.subjectId))}</b>${x.type ? `<span>${esc(x.type)}</span>` : ''}</a>`)).join('')}
  </td>`;
}

function viewTimetable() {
  const d = S.ui.draft;
  if (d) return viewDraft(d);
  const sem = currentSem();

  if (!sem) {
    return `<h1>Emploi du temps</h1>
    <section class="card stack">
      <div class="muted">Aucun emploi du temps pour l'instant.</div>
      <p style="margin:0">Importe le PDF fourni par l'école dans <b>Réglages → Imports</b> : l'IA en extrait les créneaux, tu vérifies, tu valides. Au semestre suivant, tu importes le nouveau fichier : chaque semestre garde le sien.</p>
      ${ttActions(null)}
    </section>`;
  }

  const range = semRange(sem);
  const today = startOfDay(new Date());
  const wds = new Set(sem.sessions.map((s) => Number(s.weekday)));
  for (const e of examsOf(sem)) for (let d = parseYmd(e.start); ymd(d) <= e.end; d = addDays(d, 1)) wds.add(isoDay(d));
  const days = [1, 2, 3, 4, 5, 6, 7].filter((k) => k <= 5 || wds.has(k));

  // Colonnes : les semaines du semestre, ou une seule « semaine type ».
  const cols = [];
  if (range) {
    for (let w = startOfWeek(range.start); w <= range.end; w = addDays(w, 7)) {
      const items = (k) => { const day = addDays(w, k - 1); return day >= range.start && day <= range.end ? semSessionsOn(sem, day) : null; };
      cols.push({ n: weekNumber(sem, w), dated: true, monday: w, items, current: ymd(w) === ymd(startOfWeek(today)), past: addDays(w, 6) < today });
    }
  } else {
    cols.push({ n: null, items: (k) => sem.sessions.filter((s) => !s.date && Number(s.weekday) === k) });
  }
  const colItems = cols.map((c) => Object.fromEntries(days.map((k) => [k, c.items(k)])));
  const used = (range ? colItems.flatMap((ci) => days.flatMap((k) => ci[k] || [])) : sem.sessions).filter((s) => !s.exam);

  const head = `<tr><th class="tt-day" scope="col"><span class="sr">Jour</span></th><th class="tt-time" scope="col">Horaires</th>
    ${cols.map((c) => {
      const total = days.reduce((m, k) => m + (colItems[cols.indexOf(c)][k] || []).reduce((a, s) => a + (s.exam ? 0 : duration(s)), 0), 0);
      const exam = c.monday && (!c.n || [0, 1, 2, 3, 4].every((k) => examOn(sem, addDays(c.monday, k))));
      return c.dated ? `<th scope="col" class="tt-wk ${c.current ? 'current' : ''} ${c.past ? 'past' : ''} ${exam ? 'exam' : ''}" ${c.current ? 'id="ttCurrent"' : ''}>
        <a href="#/semaine/${ymd(c.monday)}" title="Ouvrir cette semaine">${c.n ? `Semaine ${c.n}` : 'Examens'}</a>
        <span>${fmtNum(c.monday)}${exam && c.n ? ' · <em>Examens</em>' : total ? ` · ${fmtHours(total)}` : ''}</span></th>`
        : `<th scope="col" class="tt-wk">Chaque semaine<span>${fmtHours(total)}</span></th>`;
    }).join('')}</tr>`;

  // Chaque jour garde ses trois séances types, même vides ; un jour à part (samedi) a ses propres créneaux.
  const courses = sem.sessions.filter((s) => !s.exam); // les épreuves ne définissent pas les créneaux
  const std = standardSlots(courses);
  const body = days.map((k) => {
    const daySessions = courses.filter((s) => Number(s.weekday) === k);
    const fits = std.length && daySessions.every((s) => std.some((x) => x.start === s.start));
    const rows = fits || !daySessions.length ? std.map((x) => ({ ...x })) : ownSlots(courses, k);
    if (!rows.length) rows.push({ start: '', end: '' });
    const covered = new Set(); // « ligne:colonne » déjà occupées par une séance qui déborde
    const trs = rows.map((r, ri) => {
      const cells = cols.map((c, ci) => {
        if (covered.has(`${ri}:${ci}`)) return '';
        const dayItems = colItems[ci][k] || [];
        const date = c.monday ? addDays(c.monday, k - 1) : null;
        const exam = date && examOn(sem, date);
        const cls = [colItems[ci][k] === null ? 'out' : '', c.past ? 'past' : '', date && ymd(date) === ymd(today) ? 'today' : '', exam ? 'exam-day' : ''].join(' ');
        // Semaine d'examens dont le calendrier n'est pas encore connu : un bloc sur toute la journée, comme le PDF.
        if (exam && !examPlanned(sem, exam)) {
          for (let j = 1; j < rows.length; j++) covered.add(`${j}:${ci}`);
          return `<td class="tt-c exam ${cls}" rowspan="${rows.length}" title="${esc(`${exam.label || 'Examens'} · du ${fmtShort(parseYmd(exam.start))} au ${fmtShort(parseYmd(exam.end))} · calendrier pas encore importé`)}">
            <span class="exam-in"><b>${esc(exam.label || 'Examens')}</b></span></td>`;
        }
        // Une séance va dans le créneau qu'elle recouvre en premier ; une épreuve à cheval sur une pause, dans le plus proche.
        const here = dayItems.filter((s) => r.start && slotIndex(s, rows) === ri);
        if (!here.length) return `<td class="tt-c empty ${cls}"><span class="sr">${exam ? "Pas d'épreuve" : 'Libre'}</span></td>`;
        // Une séance longue (journée, examen) couvre les créneaux suivants.
        let span = 1;
        while (ri + span < rows.length && here.some((s) => overlaps(s, rows[ri + span]))
          && !dayItems.some((s) => !here.includes(s) && overlaps(s, rows[ri + span]))) {
          covered.add(`${ri + span}:${ci}`); span++;
        }
        return ttCell(here, span, cls);
      }).join('');
      return `<tr>${ri === 0 ? `<th scope="rowgroup" class="tt-day" rowspan="${rows.length}"><span>${esc(DAYS[k - 1])}</span></th>` : ''}
        <th scope="row" class="tt-time">${r.start ? `<b>${esc(r.start.replace(':', 'h'))}</b><span>${esc(r.end.replace(':', 'h'))}</span>` : '—'}</th>${cells}</tr>`;
    }).join('');
    return `<tbody>${trs}</tbody>`;
  }).join(`<tbody class="tt-sep" aria-hidden="true"><tr><td colspan="${cols.length + 2}"></td></tr></tbody>`);

  // Récapitulatif par matière (la légende du PDF).
  const stats = new Map();
  for (const s of used) {
    const st = stats.get(s.subjectId) || { count: 0, min: 0, types: new Map(), teachers: new Set() };
    st.count++; st.min += duration(s);
    st.types.set(typeOf(s), (st.types.get(typeOf(s)) || 0) + duration(s));
    if (s.teacher) st.teachers.add(s.teacher);
    stats.set(s.subjectId, st);
  }
  const allRows = [...stats.entries()].sort((a, b) => subjectCode(a[0]).localeCompare(subjectCode(b[0]), 'fr', { numeric: true }));
  const statRows = allRows.filter(([id]) => !isActivity(id));
  const actRows = allRows.filter(([id]) => isActivity(id)).sort((a, b) => subjectName(a[0]).localeCompare(subjectName(b[0]), 'fr'));
  const totalMin = statRows.reduce((m, [, st]) => m + st.min, 0);
  const exams = sem.exams || [];

  return `
  <div class="head">
    <div class="tt-title">
      <h1 style="margin:0">Emploi du temps</h1>
      <label class="sr" for="semSel">Semestre</label>
      ${semSelect('semSel', sem.id)}
    </div>
    ${ttActions(sem)}
  </div>

  ${S.ui.semEdit ? `<section class="card" aria-label="Paramètres du semestre">
    <div class="form-grid sem-period">
      <label class="f">Nom<input class="input sm" data-tt="name" value="${esc(sem.name || '')}" placeholder="${esc(semLabel(sem))}"></label>
      <label class="f">Semestre n°<input class="input sm" type="number" min="1" max="12" data-tt="semNo" value="${esc(semPeriod(sem)?.sem || '')}"></label>
      <label class="f">Partie n°<input class="input sm" type="number" min="1" max="4" data-tt="part" value="${esc(semPeriod(sem)?.part || '')}"></label>
      <label class="f">Début<input class="input sm" type="date" data-tt="start" value="${esc(sem.start || (range ? ymd(range.start) : ''))}"></label>
      <label class="f">Fin<input class="input sm" type="date" data-tt="end" value="${esc(sem.end || (range ? ymd(range.end) : ''))}"></label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center;margin-top:8px">
      <p class="muted small" style="margin:0">${range
        ? (range.auto ? 'Dates déduites du PDF. Modifie-les si le semestre commence ou finit à un autre moment.' : 'Les créneaux qui se répètent chaque semaine sont placés entre ces deux dates.')
        : 'Semaine type : indique le début et la fin du semestre pour voir toutes les semaines.'}</p>
      <button class="btn ghost danger" data-act="sem-del">Supprimer ce semestre</button>
    </div>
    ${examEditor(exams, 'sem')}
  </section>` : ''}
  ${!exams.length && range && !S.ui.semEdit ? `<div class="notice small exam-notice">
    <span>Aucune semaine d'examens dans ce semestre${sem.hasPdf ? ' : ce PDF a été importé avant que l\'IA sache les repérer.' : '.'}</span>
    <span style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" data-act="exam-add" data-ctx="sem">Ajouter à la main</button>
      <a class="btn small" href="#/reglages">Importer le calendrier (Réglages)</a></span></div>` : ''}

  ${exams.length || examSessions(sem).length ? examCard(sem) : ''}

  <section class="card tt-card" aria-label="Grille de l'emploi du temps">
    <div class="tt-scroll"><table class="tt">
      <thead>${head}</thead>
      ${body}
    </table></div>
    <p class="muted small" style="margin:10px 0 0">${range ? `${cols.length} semaines · ` : ''}${sem.sessions.length} créneaux · ${esc(sem.source || 'saisie manuelle')}</p>
  </section>

  <section class="card" aria-labelledby="h-recap">
    <div class="head"><h2 id="h-recap">Matières</h2>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="muted small">Total : ${fmtHours(totalMin)}</span>
        <button class="btn small" data-act="tt-recolor">Couleurs bien distinctes</button></div></div>
    <p class="muted small" style="margin:-4px 0 10px">Clique sur la pastille pour changer la couleur, ou sur le code pour le corriger (ex. 2INF2302).</p>
    <div class="table-scroll"><table class="edit recap">
      <thead><tr><th>Code</th><th>Matière</th><th>Séances</th><th>Heures</th><th>Détail</th><th>Enseignant</th><th><span class="sr">Type</span></th></tr></thead>
      <tbody>${statRows.map(([id, st]) => `<tr>
        <td><div class="code-cell" style="--c:${esc(subjectColor(id))}">
          <input type="color" value="${esc(subjectColor(id))}" data-subj="${esc(id)}" data-f="color" aria-label="Couleur de ${esc(subjectName(id))}">
          <input class="code-in" value="${esc(subjectById(id)?.code || '')}" placeholder="${esc(subjectCode(id))}" data-subj="${esc(id)}" data-f="code" aria-label="Code de ${esc(subjectName(id))}">
        </div></td>
        <td><a href="#/matiere/${esc(id)}" class="recap-name">${esc(subjectName(id))}</a></td>
        <td>${st.count}</td><td><b>${fmtHours(st.min)}</b></td>
        <td class="muted">${[...st.types.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, m]) => `${esc(t)} ${fmtHours(m)}`).join(' · ')}</td>
        <td class="muted">${esc([...st.teachers].join(', ') || '—')}</td>
        <td><button class="btn ghost small" data-act="subj-kind" data-id="${esc(id)}" data-v="1" title="Ce n'est pas une matière (sport, journée…)">Activité</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>

  ${actRows.length ? `<section class="card" aria-labelledby="h-act">
    <div class="head"><h2 id="h-act">Autres activités</h2><span class="muted small">Sans enseignant · hors volume horaire</span></div>
    <div class="acts">${actRows.map(([id, st]) => `<div class="act-item" style="--c:${esc(subjectColor(id))}">
      <input type="color" value="${esc(subjectColor(id))}" data-subj="${esc(id)}" data-f="color" aria-label="Couleur de ${esc(subjectName(id))}">
      <div><b>${esc(subjectName(id))}</b><span class="muted small">${st.count} séance${st.count > 1 ? 's' : ''} · ${fmtHours(st.min)}</span></div>
      <button class="btn ghost small" data-act="subj-kind" data-id="${esc(id)}" data-v="0">C'est une matière</button>
    </div>`).join('')}</div>
  </section>` : ''}`;
}

/** Carte « Examens » : la ou les périodes, puis les épreuves une fois le calendrier importé. */
function examCard(sem) {
  const list = examSessions(sem);
  const periods = examsOf(sem);
  const when = periods.map((e) => `${esc(e.label || 'Examens')} · du ${esc(fmtLong(parseYmd(e.start)).toLowerCase())} au ${esc(fmtLong(parseYmd(e.end)).toLowerCase())}`).join('<br>');
  const today = ymd(new Date());
  const actions = `<div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn small ghost" data-act="manual-exam">${list.length ? 'Corriger les épreuves' : 'Saisir à la main'}</button>
  </div>`;
  return `<section class="card exam-card" aria-labelledby="h-exam">
    <div class="head"><div><h2 id="h-exam">Examens</h2>${when ? `<div class="muted small">${when}</div>` : ''}</div>${actions}</div>
    ${list.length ? `<div class="exam-list">${list.map((s) => `<a class="exam-line ${s.date < today ? 'past' : ''}" href="#/matiere/${esc(s.subjectId)}" style="--c:${esc(subjectColor(s.subjectId))}">
        <span class="el-date">${esc(fmtLong(parseYmd(s.date)))}</span>
        <span class="el-time">${esc(s.start.replace(':', 'h'))} – ${esc((s.end || '').replace(':', 'h'))}</span>
        <span class="el-code">${esc(subjectCode(s.subjectId))}</span>
        <span class="el-name">${esc(subjectName(s.subjectId))}${s.type && s.type !== 'Examen' ? ` · ${esc(s.type)}` : ''}</span>
        <span class="el-room muted">${esc(s.room || '')}</span>
      </a>`).join('')}</div>
      <p class="muted small" style="margin:8px 0 0">${esc(sem.examSource || 'Saisie manuelle')}${sem.examImportedAt ? ` · importé le ${esc(fmtShort(new Date(sem.examImportedAt)))}` : ''}. Si l'école publie une nouvelle version, importe-la dans <a href="#/reglages">Réglages → Imports</a> : elle remplace celle-ci.</p>`
    : `<p class="muted" style="margin:0">Le calendrier des examens n'est pas encore importé. Dès que l'école le publie, importe le PDF dans <a href="#/reglages">Réglages → Imports</a> : les épreuves apparaîtront dans la grille, la semaine, l'accueil et la fiche de chaque matière.</p>`}
  </section>`;
}

/** Liste modifiable des périodes d'examens (ctx = « sem » pour le semestre affiché, « draft » à l'import). */
function examEditor(list, ctx) {
  return `<div class="exams">
    <div class="exams-head"><b>Semaines d'examens</b>
      <button class="btn small" data-act="exam-add" data-ctx="${ctx}">+ Ajouter</button></div>
    ${list.map((e, i) => `<div class="exam-row">
      <label class="f">Intitulé<input class="input sm" data-exam="${i}" data-ctx="${ctx}" data-f="label" value="${esc(e.label || '')}" placeholder="Examens"></label>
      <label class="f">Du<input class="input sm" type="date" data-exam="${i}" data-ctx="${ctx}" data-f="start" value="${esc(e.start || '')}"></label>
      <label class="f">Au<input class="input sm" type="date" data-exam="${i}" data-ctx="${ctx}" data-f="end" value="${esc(e.end || '')}"></label>
      <button class="btn ghost icon" data-act="exam-del" data-i="${i}" data-ctx="${ctx}" aria-label="Retirer cette période">×</button>
    </div>`).join('') || '<div class="muted small">Aucune. Les cours qui se répètent chaque semaine sont suspendus pendant ces dates.</div>'}
  </div>`;
}

/** Vérification du calendrier des examens : une ligne par épreuve, la date est obligatoire. */
function viewExamDraft(d) {
  const sem = S.semesters.find((x) => x.id === d.semId);
  const hasOld = sem?.sessions.some((s) => s.exam);
  const names = S.subjects.filter((s) => !isActivity(s.id)).map((s) => s.name);
  const groups = d.groups || [];
  const shown = d.rows.map((r, i) => [r, i]).filter(([r]) => examRowShown(d, r));
  const many = groups.length > 1;
  return `<h1>Vérifie le calendrier des examens</h1>
  <p class="muted" style="margin:0">${esc(d.source || 'Saisie manuelle')} · ${shown.length} épreuve${shown.length > 1 ? 's' : ''}${many && d.group !== '*' ? ` pour ta classe (sur ${d.rows.length} dans le document)` : ''}.
    Corrige ce qui est faux, puis valide. Si la fin n'est pas indiquée, l'épreuve dure deux heures.</p>
  <div class="exam-pick">
    ${many ? `<label class="f">Ma classe
      <select class="input sm" id="examGroup">
        ${d.group === '*' || !groups.includes(d.group) ? '<option value="*" selected>— Choisis ta classe —</option>' : ''}
        ${groups.map((g) => `<option value="${esc(g)}" ${g === d.group ? 'selected' : ''}>${esc(g)} · ${d.rows.filter((r) => r.group === g).length} épreuves</option>`).join('')}
        ${d.group !== '*' && groups.includes(d.group) ? '<option value="*">Toutes les classes</option>' : ''}
      </select></label>` : ''}
    ${S.semesters.length > 1 ? `<label class="f">Semestre
      ${semSelect('examSem', d.semId, 'input sm')}</label>` : ''}
  </div>
  ${many && d.group === '*' ? '<p class="notice">Ce document couvre plusieurs classes. Choisis la tienne pour ne garder que tes épreuves.</p>' : ''}
  <datalist id="subjList">${[...new Set([...names, ...shown.map(([r]) => r.subject)])].filter(Boolean).map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
  <section class="card">
    <div class="table-scroll"><table class="edit">
      <thead><tr><th>Date</th><th>Début</th><th>Fin</th><th>Matière</th><th>Code</th><th>Type</th><th>Salle</th>${many && d.group === '*' ? '<th>Classe</th>' : ''}<th><span class="sr">Supprimer</span></th></tr></thead>
      <tbody>${shown.map(([r, i]) => `<tr>
        <td><input class="input" type="date" data-row="${i}" data-f="date" value="${esc(r.date)}" aria-label="Date" required></td>
        <td><input class="input" type="time" data-row="${i}" data-f="start" value="${esc(r.start)}" aria-label="Début"></td>
        <td><input class="input" type="time" data-row="${i}" data-f="end" value="${esc(r.end)}" aria-label="Fin"></td>
        <td><input class="input" list="subjList" data-row="${i}" data-f="subject" value="${esc(r.subject)}" aria-label="Matière"></td>
        <td><input class="input" data-row="${i}" data-f="code" value="${esc(r.code || '')}" aria-label="Code" style="width:100px"></td>
        <td><input class="input" data-row="${i}" data-f="type" value="${esc(r.type || 'Examen')}" aria-label="Type" style="width:100px"></td>
        <td><input class="input" data-row="${i}" data-f="room" value="${esc(r.room)}" aria-label="Salle" style="width:110px"></td>
        ${many && d.group === '*' ? `<td class="small muted" style="white-space:nowrap">${esc(r.group || '—')}</td>` : ''}
        <td><button class="btn ghost icon" data-act="draft-del" data-row="${i}" aria-label="Supprimer la ligne">×</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center;margin-top:12px">
      <button class="btn" data-act="draft-add">+ Ajouter une épreuve</button>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${hasOld ? '<span class="muted small">Remplace le calendrier des examens déjà importé.</span>' : ''}
        <button class="btn" data-act="draft-cancel">Annuler</button>
        <button class="btn primary" data-act="draft-save">Valider</button>
      </div>
    </div>
  </section>`;
}

/** Emploi du temps déjà importé pour la même partie du même semestre (même classe si elle est connue). */
function draftMatch(d) {
  const m = d.meta || {};
  if (!m.semNo && !m.part) return null;
  return S.semesters.find((x) => {
    const q = semPeriod(x); if (!q) return false;
    return (q.sem || null) === (m.semNo || null) && (q.part || null) === (m.part || null)
      && (!m.className || !x.className || keyOf(m.className) === keyOf(x.className));
  }) || null;
}

function viewDraft(d) {
  if (d.kind === 'exam') return viewExamDraft(d);
  const dayOpts = (v) => `<option value="">—</option>` + DAYS.map((n, i) => `<option value="${i + 1}" ${Number(v) === i + 1 ? 'selected' : ''}>${n}</option>`).join('');
  const m = d.meta || {};
  const match = draftMatch(d);
  return `<h1>Vérifie les créneaux</h1>
  <p class="muted" style="margin:0">${esc(d.source || 'Saisie manuelle')} · ${d.rows.length} lignes. Corrige ce qui est faux, puis valide.
    Une ligne avec une <b>date</b> ne compte que ce jour-là ; sans date, elle se répète chaque semaine.</p>
  <section class="card draft-meta" aria-labelledby="h-dm">
    <h2 id="h-dm" style="font-size:16px;margin:0 0 4px">Période couverte</h2>
    <p class="muted small" style="margin:0 0 10px">${d.editing ? 'Ce qu\'indique l\'emploi du temps.' : 'Lue dans l\'en-tête du PDF. Un emploi du temps couvre une partie d\'un semestre.'}</p>
    <div class="dm-grid">
      <label class="f">Classe<input class="input sm" data-meta="className" value="${esc(m.className || '')}" placeholder="ex. M2 SIGL-ID2C"></label>
      <label class="f">Semestre n°<input class="input sm" type="number" min="1" max="12" data-meta="semNo" value="${esc(m.semNo || '')}" placeholder="ex. 3"></label>
      <label class="f">Partie n°<input class="input sm" type="number" min="1" max="4" data-meta="part" value="${esc(m.part || '')}" placeholder="1 ou 2"></label>
      <label class="f">Du<input class="input sm" type="date" data-meta="start" value="${esc(m.start || '')}"></label>
      <label class="f">Au<input class="input sm" type="date" data-meta="end" value="${esc(m.end || '')}"></label>
    </div>
    ${!d.editing && match ? `<p class="small" style="margin:10px 0 0">Tu as déjà « ${esc(semOptionLabel(match))} » : par défaut, ce PDF le remplace.</p>` : ''}
  </section>
  <datalist id="subjList">${[...new Set([...S.subjects.map((s) => s.name), ...d.rows.map((r) => r.subject)])].filter(Boolean).map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
  <section class="card">
    <div class="table-scroll"><table class="edit">
      <thead><tr><th>Jour</th><th>Date (optionnelle)</th><th>Début</th><th>Fin</th><th>Matière</th><th>Code</th><th>Type</th><th>Salle</th><th><span class="sr">Supprimer</span></th></tr></thead>
      <tbody>${d.rows.map((r, i) => `<tr>
        <td><select class="input" data-row="${i}" data-f="weekday" aria-label="Jour">${dayOpts(r.weekday)}</select></td>
        <td><input class="input" type="date" data-row="${i}" data-f="date" value="${esc(r.date)}" aria-label="Date"></td>
        <td><input class="input" type="time" data-row="${i}" data-f="start" value="${esc(r.start)}" aria-label="Début"></td>
        <td><input class="input" type="time" data-row="${i}" data-f="end" value="${esc(r.end)}" aria-label="Fin"></td>
        <td><input class="input" list="subjList" data-row="${i}" data-f="subject" value="${esc(r.subject)}" aria-label="Matière"></td>
        <td><input class="input" data-row="${i}" data-f="code" value="${esc(r.code || '')}" aria-label="Code" style="width:100px"></td>
        <td><input class="input" data-row="${i}" data-f="type" value="${esc(r.type)}" aria-label="Type" style="width:80px"></td>
        <td><input class="input" data-row="${i}" data-f="room" value="${esc(r.room)}" aria-label="Salle" style="width:110px"></td>
        <td><button class="btn ghost icon" data-act="draft-del" data-row="${i}" aria-label="Supprimer la ligne">×</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;margin-top:12px">
      <button class="btn" data-act="draft-add">+ Ajouter une ligne</button>
      <div style="flex-basis:100%;order:-1">${examEditor(d.exams || [], 'draft')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${S.semesters.length && !d.editing ? (() => {
          const other = match || currentSem();
          const t = d.target || (match ? 'replace' : 'new');
          return `<label class="small" style="display:flex;gap:6px;align-items:center">Enregistrer
          <select class="input sm" id="draftTarget" style="width:auto">
            <option value="new" ${t === 'new' ? 'selected' : ''}>comme une nouvelle partie</option>
            <option value="replace" ${t === 'replace' ? 'selected' : ''}>à la place de « ${esc(semOptionLabel(other))} »</option>
            <option value="append" ${t === 'append' ? 'selected' : ''}>en plus dans « ${esc(semOptionLabel(other))} »</option>
          </select></label>`; })() : ''}
        <button class="btn" data-act="draft-cancel">Annuler</button>
        <button class="btn primary" data-act="draft-save">Valider</button>
      </div>
    </div>
  </section>`;
}

function viewSettings() {
  const f = S.settings.folder;
  const total = S.files.reduce((n, x) => n + (x.size || 0), 0);
  const sem = currentSem();
  const ai = !!S.settings.apiKey;
  const noAi = ai ? '' : 'disabled title="Ajoute d\'abord ta clé Gemini (section IA plus bas)"';
  const nEx = sem ? examSessions(sem).length : 0;
  const tt = (x) => `${x.sessions.filter((y) => !y.exam).length} créneaux · ${esc(x.source || 'saisie manuelle')}${x.importedAt ? ` · importé le ${esc(fmtShort(new Date(x.importedAt)))}` : ''}`;
  return `<h1>Réglages</h1>
  <section class="card stack imports" aria-labelledby="h-imp">
    <div class="head" style="margin:0"><h2 id="h-imp">Imports</h2>
      ${S.semesters.length > 1 ? `<label class="imp-sem"><span class="muted small">Semestre</span>
        ${semSelect('semSel', sem?.id)}</label>` : ''}</div>
    ${ai ? '' : '<div class="notice warn small">La lecture automatique des PDF demande ta clé Gemini gratuite (section « IA » plus bas). Sans elle, tu peux tout saisir à la main.</div>'}

    <div class="imp">
      <div class="imp-txt"><b>Emploi du temps</b>
        <span class="muted small">${sem ? tt(sem) : 'Le PDF de l\'école : l\'IA en extrait les créneaux, tu vérifies, tu valides. Chaque import peut devenir un nouveau semestre.'}</span></div>
      <div class="imp-act">
        <button class="btn primary small" data-act="pick-edt" ${noAi}>${sem ? 'Importer un nouveau PDF' : 'Importer un PDF'}</button>
        ${sem ? '' : '<button class="btn small" data-act="manual-tt">Saisir à la main</button>'}
        ${sem?.hasPdf ? '<button class="btn ghost small" data-act="open-edt-pdf">Voir le PDF</button>' : ''}
      </div>
    </div>

    ${sem ? `<div class="imp">
      <div class="imp-txt"><b>Calendrier des examens</b>
        <span class="muted small">${nEx ? `${nEx} épreuve${nEx > 1 ? 's' : ''} · ${esc(sem.examSource || 'saisie manuelle')}${sem.examImportedAt ? ` · importé le ${esc(fmtShort(new Date(sem.examImportedAt)))}` : ''}`
          : examsOf(sem).length ? 'Semaine d\'examens connue, épreuves pas encore importées. Importe le PDF dès que l\'école le publie.' : 'Pas encore importé. Importe le PDF dès que l\'école le publie.'}</span></div>
      <div class="imp-act">
        <button class="btn ${nEx ? '' : 'primary'} small" data-act="pick-exam" ${noAi}>${nEx ? 'Importer une nouvelle version' : 'Importer le PDF'}</button>
        ${!examsOf(sem).length && sem.hasPdf ? `<button class="btn small" data-act="exam-detect" ${noAi}>Chercher la semaine d'examens dans l'emploi du temps</button>` : ''}
        ${sem.examSource && nEx ? '<button class="btn ghost small" data-act="open-exam-pdf">Voir le PDF</button>' : ''}
      </div>
    </div>` : ''}

    <div class="imp">
      <div class="imp-txt"><b>Dossier de cours</b>
        <span class="muted small">${f ? `<b>${esc(f.name)}</b> · ${S.files.length} PDF · ${esc(fmtSize(total))} · synchronisé le ${esc(fmtShort(new Date(f.syncedAt)))}. ` : ''}Firefox ne laisse pas une extension surveiller un dossier : quand tu ajoutes des cours, resynchronise en choisissant le même dossier. Les PDF restent sur ton PC.</span></div>
      <div class="imp-act">
        <button class="btn ${f ? '' : 'primary'} small" data-act="pick-folder">${f ? 'Resynchroniser' : 'Choisir le dossier'}</button>
        ${sem ? '<button class="btn small" data-act="folders-open">Créer les dossiers (script)</button>' : ''}
        ${f ? '<button class="btn ghost danger small" data-act="clear-index">Vider l\'index</button>' : ''}
      </div>
    </div>

    <div class="imp">
      <div class="imp-txt"><b>Sauvegarde</b>
        <span class="muted small">Emploi du temps, matières, devoirs et projets (sans la clé ni les PDF).</span></div>
      <div class="imp-act">
        <button class="btn small" data-act="import">Importer une sauvegarde</button>
        <button class="btn ghost small" data-act="export">Exporter</button>
      </div>
    </div>
  </section>

  <section class="card stack" aria-labelledby="h-look">
    <h2 id="h-look">Accueil</h2>
    <p class="muted small" style="margin:0">Les raccourcis viennent de tes sites les plus visités dans Firefox. Le bouton ⋯ d'une tuile la retire.</p>
    <form id="nameForm" class="name-form">
      <label class="f">Ton prénom (pour l'accueil, facultatif)<input class="input sm" name="firstName" value="${esc(S.settings.firstName || '')}" autocomplete="given-name" maxlength="30"></label>
      <button class="btn small" type="submit">Enregistrer</button>
    </form>
    <div class="look-opts">
      <label class="check"><input type="checkbox" data-look="followTheme" ${S.settings.followTheme ? 'checked' : ''} ${themeSupported() ? '' : 'disabled'}>
        <span><b>Suivre le thème de Firefox</b><span class="muted small">${!themeSupported()
          ? 'Disponible dans l\'extension installée dans Firefox.'
          : S.settings.followTheme
            ? (look.themeColors ? 'Les couleurs suivent ton thème et changent avec lui.' : 'Ton thème ne définit pas de couleurs : celles par défaut restent.')
            : 'Les couleurs de la page suivent celles de ton thème (about:addons → Thèmes).'}</span></span></label>
      ${S.settings.followTheme && themeSupported() ? `<label class="check"><input type="checkbox" data-look="themeImage" ${S.settings.themeImage && look.themeImg ? 'checked' : ''} ${look.themeImg ? '' : 'disabled'}>
        <span><b>Utiliser l'image du thème en fond</b><span class="muted small">${look.themeImg
          ? 'Elle remplace ton fond d\'écran tant que l\'option est cochée.'
          : 'Ce thème n\'a pas d\'image utilisable.'}</span></span></label>` : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-act="pick-wall">${look.wall ? 'Changer le fond d\'écran' : 'Choisir un fond d\'écran'}</button>
      ${look.wall ? '<button class="btn ghost" data-act="remove-wall">Retirer le fond</button>' : ''}
      ${S.shortcuts.removed.length ? `<button class="btn ghost" data-act="sc-restore">Réafficher les ${S.shortcuts.removed.length} raccourcis retirés</button>` : ''}
    </div>
  </section>

  <section class="card stack" aria-labelledby="h-ai">
    <h2 id="h-ai">IA (lecture de l'emploi du temps)</h2>
    <p class="muted small" style="margin:0">Crée une clé gratuite sur <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. Elle reste dans ce navigateur. Seul le PDF de l'emploi du temps est envoyé à Google ; en offre gratuite, Google peut utiliser ces données pour améliorer ses produits.</p>
    <form id="aiForm" class="form-grid">
      <label class="f full">Clé API Gemini<input class="input sm" name="apiKey" type="password" autocomplete="off" value="${esc(S.settings.apiKey)}"></label>
      <label class="f full">Modèle (laisse vide : le plus récent est choisi tout seul)<input class="input sm" name="model" value="${esc(S.settings.model)}" placeholder="Automatique"></label>
      <button class="btn primary" type="submit">Enregistrer</button>
    </form>
  </section>

  <section class="card stack" aria-labelledby="h-subj">
    <h2 id="h-subj">Matières</h2>
    <p class="muted small" style="margin:0">« Autres noms » aide à reconnaître les dossiers (ex. BDD, SQL pour Bases de données). Sépare-les par des virgules.</p>
    ${S.subjects.map((s) => `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="color" value="${esc(s.color)}" data-subj="${esc(s.id)}" data-f="color" aria-label="Couleur de ${esc(s.name)}" style="width:44px;height:38px;border:0;background:none">
      <input class="input sm" style="flex:1 1 200px" value="${esc(s.name)}" data-subj="${esc(s.id)}" data-f="name" aria-label="Nom">
      <input class="input sm" style="flex:1 1 200px" value="${esc((s.aliases || []).join(', '))}" data-subj="${esc(s.id)}" data-f="aliases" placeholder="Autres noms" aria-label="Autres noms de ${esc(s.name)}">
      <button class="btn ghost danger" data-act="subj-del" data-id="${esc(s.id)}">Supprimer</button>
    </div>`).join('') || '<div class="muted">Aucune matière.</div>'}
    <form id="subjForm" style="display:flex;gap:8px;flex-wrap:wrap">
      <label class="sr" for="newSubj">Nouvelle matière</label>
      <input class="input sm" id="newSubj" name="name" placeholder="Nouvelle matière" style="flex:1 1 220px" required>
      <button class="btn" type="submit">Ajouter</button>
    </form>
  </section>`;
}

/* ---------- Routeur ---------- */

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  if (name === 'semaine' && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    // Lien direct vers une semaine : on sélectionne aujourd'hui s'il en fait partie, sinon le lundi.
    const today = startOfDay(new Date());
    S.ui.selDay = ymd(startOfWeek(today)) === ymd(startOfWeek(parseYmd(arg))) ? ymd(today) : ymd(startOfWeek(parseYmd(arg)));
    S.ui.calMonth = null;
    history.replaceState(null, '', '#/semaine');
  }
  const map = { '': ['home', viewHome], semaine: ['semaine', viewWeek], semestre: ['semestre', () => viewCourses('')],
    matiere: ['semestre', () => viewCourses(decodeURIComponent(arg || ''))], 'a-classer': ['semestre', () => viewCourses('a-classer')],
    edt: ['edt', viewTimetable], revisions: ['revisions', viewRevisions], reglages: ['reglages', viewSettings] };
  const [nav, fn] = map[name] || map[''];
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  view.innerHTML = fn();
  // Vue Semaine : le jour sélectionné reste visible si la semaine déborde.
  const selDay = $('.day.selected');
  if (selDay) {
    const sc = selDay.closest('.week-scroll');
    const r = selDay.getBoundingClientRect(); const box = sc.getBoundingClientRect();
    if (r.right > box.right || r.left < box.left) sc.scrollLeft += r.left - box.left - 8;
  }
  // Grille de l'emploi du temps : on fait défiler jusqu'à la semaine en cours.
  const cur = $('#ttCurrent');
  if (cur) {
    const sc = cur.closest('.tt-scroll');
    const fixed = [...sc.querySelectorAll('thead th.tt-day, thead th.tt-time')].reduce((w, th) => w + th.offsetWidth, 0);
    if (cur.offsetLeft + cur.offsetWidth > sc.clientWidth) sc.scrollLeft = cur.offsetLeft - fixed - 8;
  }
}

function render({ keepScroll = true } = {}) {
  const y = window.scrollY;
  route();
  if (keepScroll) window.scrollTo(0, y);
  fitWidgets();
  showMore();
  showFolderDialog();
}

/* ---------- Recherche ---------- */

async function ensurePages() {
  if (S.pages) return S.pages;
  const all = await db.getAllPages();
  S.pages = all.map((p) => ({ fileId: p.fileId, page: p.page, text: p.text, f: fold(p.text) }));
  return S.pages;
}

async function runSearch(input) {
  const box = $('#results');
  const q = input.value.trim();
  const terms = fold(q).split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) { box.hidden = true; box.innerHTML = ''; return; }
  const scope = input.dataset.search || null;
  if (!S.files.length) {
    if (input.form?.id === 'webForm') { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="muted">Aucun PDF indexé. <button class="btn" data-act="pick-folder">Choisir mon dossier de cours</button></div>';
    return;
  }
  const pages = await ensurePages();
  if (input.value.trim() !== q) return; // une saisie plus récente a pris le relais
  const byId = new Map(S.files.map((f) => [f.id, f]));
  const hits = [];
  for (const p of pages) {
    const file = byId.get(p.fileId);
    if (!file || (scope && subjectOfFile(file) !== scope)) continue;
    if (!terms.every((t) => p.f.includes(t))) continue;
    let score = 0;
    for (const t of terms) { let i = 0; while ((i = p.f.indexOf(t, i)) !== -1 && score < 50) { score++; i += t.length; } }
    if (terms.every((t) => fold(file.name).includes(t))) score += 20;
    const at = p.f.indexOf(terms[0]);
    const a = Math.max(0, at - 80); const b = Math.min(p.text.length, at + 140);
    const snip = (a > 0 ? '… ' : '') + p.text.slice(a, b).replace(/\s+/g, ' ') + (b < p.text.length ? ' …' : '');
    hits.push({ file, page: p.page, score, snip });
  }
  // fichiers dont seul le nom correspond (PDF scannés sans texte)
  for (const f of S.files) {
    if (scope && subjectOfFile(f) !== scope) continue;
    if (terms.every((t) => fold(f.name).includes(t)) && !hits.some((h) => h.file.id === f.id)) hits.push({ file: f, page: 1, score: 15, snip: '' });
  }
  hits.sort((x, y) => y.score - x.score);
  const limit = Number(input.dataset.limit) || 40;
  const top = hits.slice(0, limit);
  const web = input.form?.id === 'webForm';
  box.hidden = false;
  box.innerHTML = `<div class="muted small" style="margin-bottom:4px">${web ? `<b>Entrée</b> pour chercher « ${esc(q)} » sur le web · ` : ''}${hits.length
    ? `${hits.length} page${hits.length > 1 ? 's' : ''} dans tes cours${hits.length > limit ? ` (${limit} premières)` : ''}`
    : 'Rien dans tes cours.'}</div>
    <div class="results">${top.map((h) => `<button class="result" data-act="open-file" data-id="${esc(h.file.id)}" data-page="${h.page}" data-q="${esc(q)}">
      <span class="rname">${highlight(h.file.name, terms)}</span>
      <span class="muted small"> · p. ${h.page} · ${esc(subjectName(subjectOfFile(h.file)))}</span>
      ${h.snip ? `<div class="snip">${highlight(h.snip, terms)}</div>` : ''}
    </button>`).join('')}</div>`;
}

/* ---------- Actions ---------- */

async function openFile(id, page = 1, q = '') {
  const f = await db.getFile(id);
  if (!f?.blob) { toast('Fichier introuvable, resynchronise ton dossier.'); return; }
  const url = URL.createObjectURL(f.blob);
  const hash = `#page=${page}${q ? `&search=${encodeURIComponent(q)}` : ''}`;
  window.open(url + hash, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

/**
 * Choix du dossier de cours. Firefox parcourt tout le dossier AVANT de prévenir la page,
 * sans rien afficher : sur un gros dossier, ça peut durer. On affiche donc un message dès que
 * la fenêtre de choix se ferme, jusqu'à ce que Firefox livre les fichiers (ou que tu annules).
 */
function pickFolder() {
  const inp = $('#folderInput');
  let waiting = false; let timer = 0;
  const stop = () => { clearTimeout(timer); window.removeEventListener('focus', onBack); inp.removeEventListener('cancel', onCancel); };
  const onBack = () => setTimeout(() => {
    if (inp.dataset.got) return;
    waiting = true;
    busy('Firefox lit le contenu du dossier…', 'Il parcourt tous les sous-dossiers avant de les transmettre : ça peut prendre un moment pour un gros dossier.', null);
    // Un seul fichier illisible (socket MySQL/Docker, fichier verrouillé…) et Firefox abandonne tout, sans prévenir.
    timer = setTimeout(() => {
      if (inp.dataset.got) return;
      busy(null);
      toast("Firefox n'a toujours rien transmis. Souvent, un fichier illisible bloque tout le dossier : un socket de base de données (mysql.sock), un volume Docker, un fichier verrouillé. Sors ces dossiers techniques du dossier de cours, puis réessaie.", 20000);
    }, 45000);
  }, 400);
  const onCancel = () => { stop(); if (waiting) busy(null); };
  delete inp.dataset.got;
  window.addEventListener('focus', onBack, { once: true });
  inp.addEventListener('cancel', onCancel, { once: true });
  inp.onchange = () => { inp.dataset.got = '1'; stop(); };
  inp.click();
}

async function syncFolder(fileList) {
  const all = [...fileList];
  const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
  if (!all.length) {
    busy(null);
    toast("Firefox n'a transmis aucun fichier de ce dossier. S'il est dans OneDrive, rends les fichiers disponibles hors connexion (clic droit → « Toujours conserver sur cet appareil »), puis réessaie.", 12000);
    return;
  }
  if (!pdfs.length) {
    busy(null);
    toast(`Aucun PDF parmi les ${all.length} fichiers de « ${(all[0].webkitRelativePath || '').split('/')[0] || 'ce dossier'} ».`, 8000);
    return;
  }
  const root = (pdfs[0].webkitRelativePath || pdfs[0].name).split('/')[0];
  const existing = new Map(S.files.map((f) => [f.path, f]));
  const seen = new Set();
  let done = 0; let added = 0;
  try {
    for (const file of pdfs) {
      const path = file.webkitRelativePath || file.name;
      seen.add(path);
      const old = existing.get(path);
      busy('Indexation des cours…', `${done + 1}/${pdfs.length} — ${path}`, done / pdfs.length);
      if (old && old.size === file.size && old.lastModified === file.lastModified) { done++; continue; }
      let pages = []; let error = '';
      try { pages = await extractPages(file); } catch (e) { error = String(e?.message || e); }
      const rec = {
        id: old?.id || uid(), path, name: file.name, size: file.size, lastModified: file.lastModified,
        blob: file, pageCount: pages.length, head: pages.slice(0, 2).join('\n').slice(0, 4000),
        subjectId: old?.subjectId || null, error,
      };
      await db.saveIndexedFile(rec, pages);
      done++; added++;
    }
    let removed = 0;
    for (const [path, f] of existing) if (!seen.has(path)) { await db.deleteFile(f.id); removed++; }
    S.files = await db.getFiles();
    // Sans emploi du temps : on crée les matières depuis les sous-dossiers.
    if (!S.subjects.length) {
      // « Semestre 1 / Partie 2 / ETL / … » : la matière est le premier dossier qui n'est pas une période.
      const dirs = [...new Set(S.files.map((f) => contentDirs(f.path)[0]).filter(Boolean))];
      S.subjects = dirs.map((name, i) => ({ id: uid(), name, color: PALETTE[i % PALETTE.length], aliases: [] }));
      await save('subjects');
    }
    S.settings.folder = { name: root, syncedAt: new Date().toISOString() };
    await save('settings');
    S.pages = null;
    recomputeAuto();
    toast(`${S.files.length} PDF indexés (${added} nouveaux ou modifiés${removed ? `, ${removed} retirés` : ''}).`);
  } catch (e) {
    toast('Erreur pendant l\'indexation : ' + (e?.message || e), 6000);
  } finally {
    busy(null);
    render();
  }
}

const IMPORT_TIMEOUT = 180000; // 3 minutes

async function importTimetablePdf(file) {
  const ctrl = new AbortController();
  let reason = '';
  const timer = setTimeout(() => { reason = 'timeout'; ctrl.abort(); }, IMPORT_TIMEOUT);
  busy("L'IA lit ton emploi du temps…", file.name, null, {
    clock: true, step: 'Préparation du PDF…', hint: 'un emploi du temps chargé peut prendre jusqu\'à 1 à 2 minutes',
    onCancel: () => { reason = 'cancel'; ctrl.abort(); },
  });
  try {
    const { sessions: rows, exams, meta, model } = await parseTimetable(file, S.settings, { onStep: busyStep, signal: ctrl.signal });
    if (model !== S.settings.model) { S.settings.model = model; await save('settings'); }
    if (!rows.length) throw new Error("Aucun créneau trouvé dans ce PDF.");
    S.ui.draft = { source: file.name, rows, exams: exams.map((e) => ({ id: uid(), ...e })), pdf: file, meta };
    location.hash = '#/edt';
  } catch (e) {
    if (ctrl.signal.aborted) {
      toast(reason === 'cancel' ? 'Import annulé.' : "Gemini n'a pas répondu en 3 minutes. Réessaie, ou indique un modèle plus rapide dans les Réglages (ex. un modèle « flash-lite »).", 9000);
    } else {
      toast(e.message || String(e), 9000);
    }
  } finally {
    clearTimeout(timer);
    busy(null);
    render({ keepScroll: false });
  }
}

/** Calendrier des examens (PDF publié à part) : l'IA le lit, puis l'écran de vérification s'ouvre. */
async function importExamPdf(file) {
  const sem = currentSem(); if (!sem) return;
  const ctrl = new AbortController();
  let reason = '';
  const timer = setTimeout(() => { reason = 'timeout'; ctrl.abort(); }, IMPORT_TIMEOUT);
  busy("L'IA lit le calendrier des examens…", file.name, null, {
    clock: true, step: 'Préparation du PDF…', onCancel: () => { reason = 'cancel'; ctrl.abort(); },
  });
  try {
    const known = S.subjects.filter((s) => !isActivity(s.id)).map((s) => ({ name: s.name, code: s.code || '' }));
    const { sessions: rows, meta, model } = await parseExamTimetable(file, S.settings, known,
      { onStep: busyStep, signal: ctrl.signal, group: S.settings.myClass || semLabel(sem) });
    if (model !== S.settings.model) { S.settings.model = model; await save('settings'); }
    if (!rows.length) throw new Error('Aucune épreuve trouvée dans ce PDF.');
    const groups = [...new Set(rows.map((r) => r.group).filter(Boolean))];
    // « (Partie 1) » dans le titre : l'emploi du temps de cette partie ; sinon celui dont les dates sont les plus proches.
    const target = semForPart(meta, rows.map((r) => r.date)) || semForDates(rows.map((r) => r.date)) || sem;
    S.ui.draft = { kind: 'exam', semId: target.id, source: file.name, rows, pdf: file, groups, group: bestGroup(groups, target) || '*' };
    location.hash = '#/edt';
  } catch (e) {
    toast(ctrl.signal.aborted ? (reason === 'cancel' ? 'Import annulé.' : "Gemini n'a pas répondu en 3 minutes. Réessaie.") : (e.message || String(e)), 9000);
  } finally {
    clearTimeout(timer); busy(null); render({ keepScroll: false });
  }
}

/**
 * Classe de l'étudiant parmi celles du document (« M2 SIGL (ID2C) » ≈ semestre « M2 SIGL-ID2C ») :
 * le choix déjà fait, sinon celle qui partage le plus de mots avec le nom du semestre.
 */
function bestGroup(groups, sem) {
  if (!groups.length) return '';
  const saved = S.settings.myClass && groups.find((g) => keyOf(g) === keyOf(S.settings.myClass));
  if (saved) return saved;
  const ref = new Set(keyOf(`${S.settings.myClass || ''} ${sem ? `${semLabel(sem)} ${sem.source || ''}` : ''}`).split(' ').filter(Boolean));
  const score = (g) => keyOf(g).split(' ').filter((w) => ref.has(w)).length;
  const best = [...groups].sort((a, b) => score(b) - score(a))[0];
  // « M2 » seul ne suffit pas : il faut au moins deux mots en commun (M2 + SIGL…).
  return score(best) >= 2 ? best : '';
}

/** Emploi du temps de la partie (et du semestre, s'il est écrit) indiquée dans le titre du calendrier des examens. */
function semForPart(meta, dates) {
  if (!meta?.part && !meta?.semNo) return null;
  const ok = S.semesters.filter((x) => { const q = semPeriod(x); return q && (!meta.part || q.part === meta.part) && (!meta.semNo || !q.sem || q.sem === meta.semNo); });
  if (ok.length <= 1) return ok[0] || null;
  const first = dates.length ? parseYmd([...dates].sort()[0]) : new Date();
  const dist = (x) => { const r = semRange(x, true) || semRange(x); return r ? Math.abs(daysBetween(r.start, first)) : 1e9; };
  return ok.sort((a, b) => dist(a) - dist(b))[0];
}

/** Semestre auquel rattacher des épreuves : celui dont les cours sont les plus proches de leurs dates. */
function semForDates(dates) {
  if (!dates.length || !S.semesters.length) return null;
  const first = parseYmd([...dates].sort()[0]);
  const dist = (sem) => {
    const r = semRange(sem, true) || semRange(sem); if (!r) return Infinity;
    if (first >= r.start && first <= addDays(r.end, 21)) return 0;
    return Math.abs(daysBetween(first < r.start ? first : r.end, first < r.start ? r.start : first));
  };
  return [...S.semesters].sort((a, b) => dist(a) - dist(b))[0];
}

/** Lignes du brouillon d'examens retenues : celles de la classe choisie (ou toutes). */
const examRowShown = (d, r) => !d.group || d.group === '*' || !r.group || r.group === d.group;

/** Enregistre le calendrier des examens vérifié : il remplace le précédent de ce semestre. */
async function saveExamDraft(d) {
  const sem = S.semesters.find((x) => x.id === d.semId) || currentSem();
  if (!sem) return;
  const bad = []; const sessions = [];
  d.rows.forEach((r, i) => {
    if (!examRowShown(d, r)) return; // épreuve d'une autre classe
    const subject = (r.subject || '').trim();
    if (!subject && !r.room) return;
    const start = normTime(r.start);
    if (!subject || !r.date || !start) { bad.push(i + 1); return; }
    // Fin non indiquée : on compte deux heures.
    const end = normTime(r.end) || `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}:${start.slice(3)}`;
    sessions.push({ id: uid(), exam: true, subject, code: (r.code || '').trim(), date: r.date, weekday: isoDay(parseYmd(r.date)),
      start, end, type: (r.type || 'Examen').trim(), room: r.room || '', teacher: '' });
  });
  if ((d.groups || []).length > 1 && d.group === '*' && !confirm('Tu n\'as pas choisi ta classe : les épreuves de toutes les classes seront enregistrées. Continuer ?')) return;
  if (bad.length) { toast(`Lignes incomplètes : ${bad.join(', ')} (date, début et matière obligatoires).`, 6000); return; }
  if (d.group && d.group !== '*' && d.group !== S.settings.myClass) { S.settings.myClass = d.group; await save('settings'); }
  // Le code désigne la matière plus sûrement que le nom : « 2INF2302 » → « ETL et pipelines de données ».
  for (const s of sessions) {
    const byCode = s.code && S.subjects.find((x) => x.code && keyOf(x.code) === keyOf(s.code));
    if (byCode) s.subject = byCode.name;
  }
  const subjMap = resolveSubjects([...new Set(sessions.map((s) => s.subject))]);
  for (const s of sessions) {
    s.subjectId = subjMap.get(s.subject);
    const subj = subjectById(s.subjectId);
    if (s.code && subj && !subj.code) subj.code = s.code;
    if (subj && subj.activity === undefined) subj.activity = false; // une matière avec un examen n'est pas une activité
    delete s.subject; delete s.code;
  }
  sem.sessions = [...sem.sessions.filter((s) => !s.exam), ...sessions];
  // Pas encore de semaine d'examens : on la crée d'après les dates des épreuves.
  const dates = sessions.map((s) => s.date).sort();
  if (dates.length && !examsOf(sem).some((e) => dates[0] <= e.end && dates.at(-1) >= e.start)) {
    (sem.exams ||= []).push({ id: uid(), label: 'Examens', start: dates[0], end: dates.at(-1) });
  }
  if (d.pdf) { await db.kvSet(`examPdf:${sem.id}`, d.pdf); sem.examSource = d.source; }
  sem.examImportedAt = new Date().toISOString();
  await Promise.all([save('semesters'), save('subjects')]);
  S.ui.draft = null; S.ui.semId = sem.id;
  recomputeAuto();
  toast(`Calendrier des examens enregistré : ${sessions.length} épreuve${sessions.length > 1 ? 's' : ''}.`);
  location.hash = '#/edt';
  render({ keepScroll: false });
}

/** Relit le PDF d'origine du semestre affiché pour y trouver la semaine d'examens. */
async function detectExams() {
  const sem = currentSem(); if (!sem) return;
  const pdf = await db.kvGet(`timetablePdf:${sem.id}`);
  if (!pdf) { toast('PDF d\'origine introuvable : réimporte l\'emploi du temps.'); return; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMPORT_TIMEOUT);
  busy("L'IA cherche les examens…", sem.source || '', null, { clock: true, step: 'Préparation du PDF…', onCancel: () => ctrl.abort() });
  try {
    const { exams, model } = await parseExams(pdf, S.settings, { onStep: busyStep, signal: ctrl.signal });
    if (model !== S.settings.model) { S.settings.model = model; await save('settings'); }
    if (!exams.length) { toast('Aucune semaine d\'examens trouvée dans le PDF. Tu peux l\'ajouter à la main.', 7000); return; }
    sem.exams = exams.map((e) => ({ id: uid(), ...e }));
    await save('semesters');
    toast(exams.map((e) => `${e.label} : du ${fmtShort(parseYmd(e.start))} au ${fmtShort(parseYmd(e.end))}`).join(' · '), 7000);
  } catch (e) {
    toast(ctrl.signal.aborted ? 'Recherche annulée.' : (e.message || String(e)), 7000);
  } finally {
    clearTimeout(timer); busy(null); render();
  }
}

const exactSubject = (name) => {
  const k = keyOf(name);
  return S.subjects.find((x) => keyOf(x.name) === k || (x.aliases || []).some((a) => keyOf(a) === k));
};

/** « BDD » ≈ « Bases de données », « Cloud » ≈ « Cloud Computing ». */
function looseMatch(a, b) {
  if (sameSubject(a, b)) return true;
  const ka = keyOf(a); const kb = keyOf(b);
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 4 && (' ' + long + ' ').includes(' ' + short + ' ');
}

function createSubject(name) {
  const s = { id: uid(), name: name.trim(), color: PALETTE[S.subjects.length % PALETTE.length], aliases: [] };
  S.subjects.push(s);
  return s.id;
}

const findOrCreateSubject = (name) => exactSubject(name)?.id || createSubject(name);

/**
 * Associe les noms de matières de l'emploi du temps aux matières existantes.
 * Une matière née d'un dossier (« BDD ») prend le nom complet de l'emploi du temps.
 */
function resolveSubjects(names) {
  const map = new Map(); const claimed = new Set();
  for (const n of names) { const s = exactSubject(n); if (s) { map.set(n, s.id); claimed.add(s.id); } }
  for (const n of names) {
    if (map.has(n)) continue;
    const s = S.subjects.find((x) => !claimed.has(x.id) && [x.name, ...(x.aliases || [])].some((a) => looseMatch(a, n)));
    if (s) {
      s.aliases = [...new Set([...(s.aliases || []), s.name])];
      if (n.trim().length > s.name.length) s.name = n.trim();
      map.set(n, s.id); claimed.add(s.id);
    } else {
      const id = createSubject(n); map.set(n, id); claimed.add(id);
    }
  }
  return map;
}

async function saveDraft() {
  const d = S.ui.draft;
  if (d.kind === 'exam') { await saveExamDraft(d); return; }
  const bad = [];
  const sessions = [];
  // Les lignes « EXAMENS » saisies comme des cours deviennent des périodes d'examens.
  const split = splitExams(d.rows, d.exams);
  const keptRows = new Set(split.sessions);
  d.rows.forEach((r, i) => {
    if (!keptRows.has(r)) return;
    const subject = (r.subject || '').trim();
    const start = normTime(r.start); const end = normTime(r.end);
    const date = r.date || '';
    const weekday = date ? isoDay(parseYmd(date)) : Number(r.weekday) || '';
    if (!subject && !r.room && !r.type) return; // ligne vide ignorée
    if (!subject || !start || !weekday) { bad.push(i + 1); return; }
    sessions.push({ id: uid(), subject, code: (r.code || '').trim(), weekday, date, start, end: end || start,
      type: r.type || '', room: r.room || '', teacher: r.teacher || '' });
  });
  if (bad.length) { toast(`Lignes incomplètes : ${bad.join(', ')} (jour, début et matière obligatoires).`, 6000); return; }
  const subjMap = resolveSubjects([...new Set(sessions.map((s) => s.subject))]);
  for (const s of sessions) {
    s.subjectId = subjMap.get(s.subject);
    const subj = subjectById(s.subjectId);
    if (s.code && subj) subj.code = s.code; // le code lu dans le PDF devient celui de la matière
    delete s.subject; delete s.code;
  }
  const target = d.editing ? 'edit' : (S.semesters.length ? ($('#draftTarget')?.value || 'new') : 'new');
  let sem = d.editing ? S.semesters.find((x) => x.id === d.semId) : (draftMatch(d) || currentSem());
  const exams = split.exams.map((e) => ({ id: uid(), ...e }));
  const m = d.meta || {};
  // Semestre, partie, classe et dates lus dans l'en-tête (corrigés à la vérification).
  const period = { semNo: Number(m.semNo) || null, part: Number(m.part) || null, className: (m.className || '').trim(), start: m.start || '', end: m.end || '' };
  const fresh = { name: '', ...period, source: d.source || 'saisie manuelle', importedAt: new Date().toISOString(), hasPdf: !!d.pdf, sessions, exams };
  if (target === 'new' || !sem) { sem = { id: uid(), ...fresh }; S.semesters.push(sem); }
  else if (target === 'replace') Object.assign(sem, fresh);
  else if (target === 'append') { sem.sessions.push(...sessions); sem.exams = [...(sem.exams || []), ...exams]; }
  else { sem.sessions = [...sessions, ...sem.sessions.filter((s) => s.exam)]; sem.exams = exams; Object.assign(sem, period); } // le calendrier des examens est gardé
  if (d.pdf && target !== 'append' && target !== 'edit') await db.kvSet(`timetablePdf:${sem.id}`, d.pdf);
  await Promise.all([save('semesters'), save('subjects')]);
  S.ui.draft = null;
  S.ui.semId = sem.id;
  recomputeAuto();
  toast(`Emploi du temps enregistré : ${sem.sessions.length} créneaux.`);
  location.hash = '#/edt';
  // Nouvel emploi du temps : on propose aussitôt de préparer les dossiers de cours qui vont avec.
  if (target !== 'edit' && target !== 'append') openFolderDialog(sem);
  render({ keepScroll: false });
}

const saveShortcuts = () => db.kvSet('shortcuts', S.shortcuts);

/* ---------- Dossiers de cours générés depuis l'emploi du temps ---------- */

/** Nom de dossier Windows valide qui reste reconnu comme la matière (mêmes mots). */
const folderName = (name) => String(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Sans nom';

/** Sous-dossiers d'une matière d'après les types de ses séances (CM → Cours, TD, TP). */
function subjectSubdirs(sem, id, extra) {
  const types = new Set(sem.sessions.filter((x) => x.subjectId === id && !x.exam).map((x) => typeOf(x)));
  const dirs = [];
  if (types.has('CM') || types.has('COURS') || types.has('C') || !types.size) dirs.push('Cours');
  if (types.has('TD')) dirs.push('TD');
  if (types.has('TP')) dirs.push('TP');
  if (!dirs.length) dirs.push('Cours');
  return [...dirs, ...extra];
}

/** Arborescence prévue : Semestre N / Partie P / Matière / (Cours, TD, TP…), pour les matières (pas les activités). */
function folderPlan(dlg) {
  const sem = S.semesters.find((x) => x.id === dlg.semId); if (!sem) return null;
  const base = [dlg.sem ? `Semestre ${dlg.sem}` : '', dlg.part ? `Partie ${dlg.part}` : ''].filter(Boolean);
  const ids = [...new Set(sem.sessions.map((x) => x.subjectId))]
    .filter((id) => subjectById(id) && !isActivity(id))
    .sort((a, b) => subjectName(a).localeCompare(subjectName(b), 'fr'));
  const extra = [dlg.annales ? 'Annales' : '', dlg.projets ? 'Projets' : ''].filter(Boolean);
  return { sem, base, subjects: ids.map((id) => ({ name: folderName(subjectName(id)), dirs: subjectSubdirs(sem, id, extra) })) };
}

/** Script Windows (.bat) : à placer dans le dossier de cours, il crée ce qui manque sans rien effacer. */
function folderScript(plan) {
  const q = (t) => t.replace(/%/g, '%%'); // seul caractère spécial entre guillemets dans un .bat
  const base = plan.base.join('\\');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `rem Mode Etude - dossiers de cours pour "${q(semLabel(plan.sem))}", generes le ${fmtNum(new Date())}/${new Date().getFullYear()}.`,
    'rem Place ce fichier dans ton dossier de cours puis double-clique dessus. Rien n\'est efface ni ecrase.',
    'cd /d "%~dp0"',
    '',
  ];
  for (const sub of plan.subjects) {
    for (const d of sub.dirs) {
      const path = [base, sub.name, d].filter(Boolean).join('\\');
      lines.push(`if not exist "${q(path)}" mkdir "${q(path)}"`);
    }
  }
  lines.push('', 'echo.', `echo Dossiers prets : ${plan.subjects.length} matieres dans "%CD%${base ? `\\${q(base)}` : ''}".`,
    'echo Dans Mode Etude : Reglages, puis Resynchroniser et choisis ce dossier.', 'echo.', 'pause', '');
  return lines.join('\r\n');
}

function openFolderDialog(sem) {
  if (!sem) return;
  const p = semPeriod(sem) || {};
  S.ui.folderDlg = { semId: sem.id, sem: p.sem || '', part: p.part || '', annales: true, projets: false };
  render();
}

/** Fenêtre d'aperçu du script, au-dessus de la page (comme « Voir plus »). */
function showFolderDialog() {
  const o = $('#overlay');
  const dlg = S.ui.folderDlg;
  if (!dlg) { if (o.dataset.folders) { o.hidden = true; o.innerHTML = ''; delete o.dataset.folders; } return; }
  const plan = folderPlan(dlg);
  if (!plan) { S.ui.folderDlg = null; return; }
  const tree = [
    plan.base.length ? plan.base.join(' / ') + ' /' : '(dossier de cours) /',
    ...plan.subjects.map((x) => `  ${x.name} / ${x.dirs.join(', ')}`),
  ].join('\n');
  o.dataset.folders = '1';
  o.hidden = false;
  o.innerHTML = `<div class="box more-box" role="dialog" aria-modal="true" aria-labelledby="fdTitle">
    <div class="head" style="margin:0"><h2 id="fdTitle">Préparer ton dossier de cours</h2>
      <button class="btn ghost icon" data-act="folders-close" aria-label="Fermer">×</button></div>
    <p class="muted small" style="margin:0">Un script Windows crée un dossier par matière de « ${esc(semLabel(plan.sem))} », rangé par semestre et partie,
      avec les mêmes noms que l'emploi du temps : chaque PDF que tu y mets sera reconnu tout seul.</p>
    <div class="fd-row">
      <label class="f">Semestre n°<input class="input sm" type="number" min="1" max="12" data-fd="sem" value="${esc(dlg.sem)}" placeholder="ex. 1"></label>
      <label class="f">Partie n°<input class="input sm" type="number" min="1" max="4" data-fd="part" value="${esc(dlg.part)}" placeholder="facultatif"></label>
    </div>
    <div class="look-opts">
      <label class="check"><input type="checkbox" data-fd="annales" ${dlg.annales ? 'checked' : ''}><span>Ajouter un dossier « Annales » à chaque matière</span></label>
      <label class="check"><input type="checkbox" data-fd="projets" ${dlg.projets ? 'checked' : ''}><span>Ajouter un dossier « Projets » à chaque matière</span></label>
    </div>
    <pre class="fd-tree" aria-label="Aperçu des dossiers">${esc(tree)}</pre>
    <p class="muted small" style="margin:0">Place le fichier téléchargé dans ton dossier de cours, double-clique dessus, puis
      Réglages → Resynchroniser. Il ne crée que ce qui manque : rien n'est effacé.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn" data-act="folders-close">Plus tard</button>
      <button class="btn primary" data-act="folders-download" ${plan.subjects.length ? '' : 'disabled'}>Télécharger le script (.bat)</button>
    </div>
  </div>`;
}

async function downloadFolderScript() {
  const dlg = S.ui.folderDlg; const plan = dlg && folderPlan(dlg);
  if (!plan) return;
  // Numéros saisis ici alors que l'emploi du temps ne les avait pas : ils lui sont rattachés.
  if (!plan.sem.semNo && !plan.sem.part && (dlg.sem || dlg.part)) {
    plan.sem.semNo = Number(dlg.sem) || null; plan.sem.part = Number(dlg.part) || null;
    await save('semesters');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([folderScript(plan)], { type: 'application/x-bat' }));
  a.download = `creer-dossiers-${keyOf(plan.base.join(' ') || semLabel(plan.sem)).replace(/ /g, '-') || 'cours'}.bat`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  S.ui.folderDlg = null;
  toast('Script téléchargé : mets-le dans ton dossier de cours et double-clique dessus.', 6000);
  render();
}

const handlers = {
  'sc-add': async () => {
    let url = prompt('Adresse du site (ex. moodle.mon-ecole.fr) :');
    if (!url) return;
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { toast('Adresse invalide.'); return; }
    const title = (prompt('Nom affiché :', cleanTitle('', url)) || '').trim() || cleanTitle('', url);
    S.shortcuts.custom.unshift({ id: uid(), url, title });
    S.shortcuts.removed = S.shortcuts.removed.filter((h) => h !== hostOf(url));
    await saveShortcuts(); render();
  },
  'sc-remove': async (el) => {
    const host = el.dataset.host;
    if (el.dataset.custom) S.shortcuts.custom = S.shortcuts.custom.filter((c) => c.id !== el.dataset.custom);
    if (!S.shortcuts.removed.includes(host)) S.shortcuts.removed.push(host);
    await saveShortcuts(); render();
  },
  'busy-cancel': () => { if (busyCancel) busyCancel(); },
  'subj-kind': async (el) => {
    const s = subjectById(el.dataset.id); if (!s) return;
    s.activity = el.dataset.v === '1';
    await save('subjects');
    toast(s.activity ? `« ${s.name} » est rangée dans les activités.` : `« ${s.name} » est de nouveau une matière.`);
    render();
  },
  'exam-add': async (el) => {
    if (el.dataset.ctx === 'draft') {
      (S.ui.draft.exams ||= []).push({ id: uid(), label: 'Examens', start: '', end: '' });
      render(); return;
    }
    const sem = currentSem(); if (!sem) return;
    // Par défaut : la semaine qui suit le dernier cours (lundi → samedi).
    const r = semRange(sem);
    const monday = r ? addDays(startOfWeek(r.end), 7) : startOfWeek(new Date());
    (sem.exams ||= []).push({ id: uid(), label: 'Examens', start: ymd(monday), end: ymd(addDays(monday, 5)) });
    S.ui.semEdit = true;
    await save('semesters'); toast('Semaine d\'examens ajoutée : vérifie les dates.'); render();
  },
  'exam-detect': () => detectExams(),
  'exam-del': async (el) => {
    const list = el.dataset.ctx === 'draft' ? S.ui.draft.exams : currentSem()?.exams;
    if (!list) return;
    list.splice(Number(el.dataset.i), 1);
    if (el.dataset.ctx !== 'draft') await save('semesters');
    render();
  },
  'tt-recolor': async () => {
    // Une couleur différente pour chaque matière du semestre affiché, dans l'ordre des codes.
    const sem = currentSem(); if (!sem) return;
    const ids = [...new Set(sem.sessions.map((s) => s.subjectId))].sort((a, b) => subjectCode(a).localeCompare(subjectCode(b), 'fr', { numeric: true }));
    ids.forEach((id, i) => { const s = subjectById(id); if (s) s.color = DISTINCT[i % DISTINCT.length]; });
    await save('subjects'); toast('Couleurs mises à jour.'); render();
  },
  'sem-edit': () => { S.ui.semEdit = !S.ui.semEdit; render(); },
  'sem-del': async () => {
    const sem = currentSem(); if (!sem) return;
    if (!confirm(`Supprimer le semestre « ${semLabel(sem)} » et ses ${sem.sessions.length} créneaux ? Les matières, devoirs et PDF sont conservés.`)) return;
    S.semesters = S.semesters.filter((x) => x.id !== sem.id);
    S.ui.semId = null; S.ui.semEdit = false;
    await Promise.all([save('semesters'), db.kvDel(`timetablePdf:${sem.id}`), db.kvDel(`examPdf:${sem.id}`)]);
    toast('Semestre supprimé.'); render();
  },
  'sc-restore': async () => { S.shortcuts.removed = []; await saveShortcuts(); render(); },
  'pick-wall': () => $('#wallInput').click(),
  'remove-wall': async () => { await db.kvDel('wallpaper'); await applyWallpaper(null); render(); },
  day: (el) => { S.ui.day = Number(el.dataset.v); render(); },
  'pick-day': (el) => { S.ui.selDay = el.dataset.v; S.ui.calMonth = null; render(); },
  'cal-month': (el) => {
    const sel = selectedDay();
    const m = S.ui.calMonth ? parseYmd(S.ui.calMonth) : new Date(sel.getFullYear(), sel.getMonth(), 1);
    S.ui.calMonth = ymd(new Date(m.getFullYear(), m.getMonth() + Number(el.dataset.v), 1)); render();
  },
  'show-done': () => { S.ui.showDone = !S.ui.showDone; render(); },
  'folders-open': () => openFolderDialog(currentSem()),
  'setup-hide': async () => { S.settings.hideSetup = true; await save('settings'); render(); },
  'folders-close': () => { S.ui.folderDlg = null; showFolderDialog(); },
  'folders-download': () => downloadFolderScript(),
  'fit-more': (el) => { S.ui.more = el.dataset.fit; showMore(); $('#overlay [data-act="more-close"]')?.focus(); },
  'more-close': () => { S.ui.more = null; showMore(); },
  'proj-new': () => { S.ui.projEdit = 'new'; render(); $('#projForm [name="name"]')?.focus(); },
  'proj-edit': (el) => { S.ui.projEdit = el.dataset.id; render(); $('#projForm [name="name"]')?.focus(); },
  'proj-cancel': () => { S.ui.projEdit = null; render(); },
  'proj-done': async (el) => {
    const p = S.projects.find((x) => x.id === el.dataset.id); if (!p) return;
    p.done = true; p.progress = 100; p.doneAt = ymd(new Date());
    await saveProjectsAndAnnounce(); toast(`« ${p.name} » terminé. Bravo !`); render();
  },
  'proj-reopen': async (el) => {
    const p = S.projects.find((x) => x.id === el.dataset.id); if (!p) return;
    p.done = false; delete p.doneAt; await saveProjectsAndAnnounce(); render();
  },
  'proj-del': async (el) => {
    const p = S.projects.find((x) => x.id === el.dataset.id); if (!p) return;
    if (!confirm(`Supprimer « ${p.name} » ?`)) return;
    S.projects = S.projects.filter((x) => x.id !== p.id); S.ui.projEdit = null;
    await saveProjectsAndAnnounce(); render();
  },
  'proj-show-done': () => { S.ui.showProjDone = !S.ui.showProjDone; render(); },
  'del-dl': async (el) => { S.deadlines = S.deadlines.filter((d) => d.id !== el.dataset.id); await save('deadlines'); render(); },
  'open-file': (el) => openFile(el.dataset.id, Number(el.dataset.page) || 1, el.dataset.q || ''),
  'pick-folder': () => pickFolder(),
  'pick-edt': () => $('#edtInput').click(),
  'open-edt-pdf': async () => {
    const b = await db.kvGet(`timetablePdf:${currentSem()?.id}`);
    if (b) window.open(URL.createObjectURL(b), '_blank'); else toast('PDF introuvable.');
  },
  'edit-tt': () => {
    const sem = currentSem(); if (!sem) return;
    const q = semPeriod(sem) || {};
    S.ui.draft = { editing: true, semId: sem.id, source: sem.source,
      meta: { semNo: q.sem || '', part: q.part || '', className: sem.className || '', start: sem.start || '', end: sem.end || '' }, exams: (sem.exams || []).map((e) => ({ ...e })), rows: sem.sessions.filter((s) => !s.exam).map((s) => ({
      subject: subjectName(s.subjectId), code: subjectById(s.subjectId)?.code || '', weekday: s.weekday, date: s.date, start: s.start, end: s.end, type: s.type, room: s.room, teacher: s.teacher })) };
    render({ keepScroll: false });
  },
  'manual-tt': () => { S.ui.draft = { source: 'saisie manuelle', meta: {}, rows: [{ subject: '', weekday: 1, date: '', start: '08:00', end: '10:00', type: '', room: '' }] }; render({ keepScroll: false }); },
  'draft-add': () => {
    const last = S.ui.draft.rows.at(-1);
    const exam = S.ui.draft.kind === 'exam';
    const group = exam && S.ui.draft.group && S.ui.draft.group !== '*' ? S.ui.draft.group : '';
    S.ui.draft.rows.push({ subject: '', weekday: last?.weekday || 1, date: exam ? last?.date || '' : '', start: last?.end || '08:00', end: '', type: exam ? 'Examen' : '', room: '', group });
    render();
  },
  'pick-exam': () => $('#examInput').click(),
  'manual-exam': () => {
    const sem = currentSem(); if (!sem) return;
    const first = examsOf(sem)[0]?.start || '';
    // On repart des épreuves déjà enregistrées pour pouvoir les corriger.
    const rows = sem.sessions.filter((s) => s.exam).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .map((s) => ({ subject: subjectName(s.subjectId), code: subjectById(s.subjectId)?.code || '', date: s.date, start: s.start, end: s.end, type: s.type, room: s.room }));
    S.ui.draft = { kind: 'exam', semId: sem.id, source: sem.examSource || 'saisie manuelle',
      rows: rows.length ? rows : [{ subject: '', code: '', date: first, start: '08:00', end: '10:00', type: 'Examen', room: '' }] };
    render({ keepScroll: false });
  },
  'open-exam-pdf': async () => {
    const b = await db.kvGet(`examPdf:${currentSem()?.id}`);
    if (b) window.open(URL.createObjectURL(b), '_blank'); else toast('PDF introuvable.');
  },
  'draft-del': (el) => { S.ui.draft.rows.splice(Number(el.dataset.row), 1); render(); },
  'draft-cancel': () => { S.ui.draft = null; render(); },
  'draft-save': () => saveDraft(),
  'subj-del': async (el) => {
    const id = el.dataset.id; const s = subjectById(id);
    const used = allSessions().filter((x) => x.subjectId === id).length;
    if (!confirm(`Supprimer « ${s.name} » ?${used ? ` Ses ${used} créneaux seront retirés de l'emploi du temps.` : ''}`)) return;
    S.subjects = S.subjects.filter((x) => x.id !== id);
    for (const sem of S.semesters) sem.sessions = sem.sessions.filter((x) => x.subjectId !== id);
    await Promise.all([save('subjects'), save('semesters')]);
    recomputeAuto(); render();
  },
  'clear-index': async () => {
    if (!confirm('Retirer tous les PDF indexés de l\'extension ? Tes fichiers sur le disque ne sont pas touchés.')) return;
    await db.clearFiles(); S.files = []; S.pages = null; S.settings.folder = null; await save('settings'); recomputeAuto(); render();
  },
  export: () => {
    const data = { app: 'mode-etude', version: 2, exportedAt: new Date().toISOString(), semesters: S.semesters, subjects: S.subjects, deadlines: S.deadlines, projects: S.projects, revisions: S.revisions,
      assignments: Object.fromEntries(S.files.filter((f) => f.subjectId).map((f) => [f.path, f.subjectId])) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `mode-etude-${ymd(new Date())}.json`;
    a.click();
  },
  import: () => $('#backupInput').click(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input[type=checkbox]')) return;
  const fn = handlers[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

let searchTimer;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('[data-search]')) { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(t), 140); }
  if (t.matches('[data-row]') && S.ui.draft) S.ui.draft.rows[Number(t.dataset.row)][t.dataset.f] = t.value;
  if (t.matches('[data-proj-progress]')) {
    t.style.setProperty('--p', `${t.value}%`);
    const lbl = $(`[data-proj-pct="${CSS.escape(t.dataset.projProgress)}"]`); if (lbl) lbl.textContent = `${t.value} %`;
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-proj-progress]')) {
    const p = S.projects.find((x) => x.id === t.dataset.projProgress);
    if (p) { p.progress = Number(t.value); await saveProjectsAndAnnounce(); }
  } else if (t.matches('[data-rev]')) {
    if (t.checked) S.revisions.done[t.dataset.rev] = true; else delete S.revisions.done[t.dataset.rev];
    await save('revisions'); setTimeout(render, 250);
  } else if (t.matches('[data-revdoc]')) {
    if (t.checked) S.revisions.checked[t.dataset.revdoc] = true; else delete S.revisions.checked[t.dataset.revdoc];
    await save('revisions'); render();
  } else if (t.matches('[data-act="toggle-dl"]')) {
    const d = S.deadlines.find((x) => x.id === t.dataset.id);
    if (d) { d.done = t.checked; await save('deadlines'); setTimeout(render, 250); }
  } else if (t.matches('[data-row]') && S.ui.draft) {
    const row = S.ui.draft.rows[Number(t.dataset.row)];
    row[t.dataset.f] = t.value;
    if (t.dataset.f === 'date' && t.value) { row.weekday = isoDay(parseYmd(t.value)); render(); }
  } else if (t.matches('[data-assign]')) {
    const id = t.dataset.assign; const subjectId = t.value || '__none';
    await db.updateFile(id, { subjectId });
    const f = S.files.find((x) => x.id === id); if (f) f.subjectId = subjectId;
    toast(t.value ? `Rangé dans ${subjectName(t.value)}.` : 'Retiré de la matière.');
    render();
  } else if (t.matches('[data-subj]')) {
    const s = subjectById(t.dataset.subj); if (!s) return;
    if (t.dataset.f === 'aliases') s.aliases = t.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (t.dataset.f === 'name') { if (!t.value.trim()) { render(); return; } s.name = t.value.trim(); }
    else if (t.dataset.f === 'code') s.code = t.value.trim().toUpperCase();
    else s[t.dataset.f] = t.value;
    await save('subjects'); recomputeAuto();
    if (t.dataset.f === 'code' || t.dataset.f === 'color') render(); // la grille de l'emploi du temps change
  } else if (t.id === 'folderInput') {
    const files = [...t.files]; t.value = '';
    await syncFolder(files);
  } else if (t.id === 'examInput') {
    const f = t.files[0]; t.value = '';
    if (f) await importExamPdf(f);
  } else if (t.id === 'edtInput') {
    const f = t.files[0]; t.value = '';
    if (f) await importTimetablePdf(f);
  } else if (t.matches('[data-exam]')) {
    const list = t.dataset.ctx === 'draft' ? S.ui.draft?.exams : currentSem()?.exams;
    const e = list?.[Number(t.dataset.exam)]; if (!e) return;
    e[t.dataset.f] = t.value.trim();
    if (e.start && e.end && e.end < e.start) toast('La fin des examens est avant leur début.');
    if (t.dataset.ctx !== 'draft') { await save('semesters'); render(); }
  } else if (t.id === 'semSel') {
    S.ui.semId = t.value; render();
  } else if (t.id === 'examGroup' && S.ui.draft) {
    S.ui.draft.group = t.value; render();
  } else if (t.id === 'examSem' && S.ui.draft) {
    S.ui.draft.semId = t.value; render();
  } else if (t.matches('[data-meta]') && S.ui.draft) {
    const k = t.dataset.meta;
    (S.ui.draft.meta ||= {})[k] = k === 'semNo' || k === 'part' ? (Number(t.value) || '') : t.value.trim();
    render();
  } else if (t.id === 'draftTarget' && S.ui.draft) {
    S.ui.draft.target = t.value;
  } else if (t.matches('[data-tt]')) {
    const sem = currentSem(); if (!sem) return;
    const k = t.dataset.tt;
    const v = k === 'semNo' || k === 'part' ? (Number(t.value) || '') : t.value.trim();
    if (v) sem[k] = v; else delete sem[k];
    // Numéro saisi à la main : l'autre est figé tel qu'il était déduit du nom, pour ne pas le perdre.
    if ((k === 'semNo' || k === 'part') && !sem[k === 'semNo' ? 'part' : 'semNo']) { const q = periodOfText(`${sem.name || ''} ${sem.source || ''}`); const o = k === 'semNo' ? 'part' : 'semNo'; const ov = q?.[o === 'semNo' ? 'sem' : 'part']; if (ov) sem[o] = ov; }
    if (sem.start && sem.end && sem.start > sem.end) toast('La date de fin est avant la date de début.');
    await save('semesters'); render();
  } else if (t.matches('[data-fd]') && S.ui.folderDlg) {
    const k = t.dataset.fd;
    S.ui.folderDlg[k] = t.type === 'checkbox' ? t.checked : t.value.replace(/\D/g, '').slice(0, 2);
    showFolderDialog();
    $(`[data-fd="${k}"]`)?.focus();
  } else if (t.matches('[data-look]')) {
    S.settings[t.dataset.look] = t.checked;
    if (t.dataset.look === 'followTheme' && t.checked && S.settings.themeImage === undefined) S.settings.themeImage = false;
    await save('settings');
    await applyLook(); render();
  } else if (t.id === 'wallInput') {
    const f = t.files[0]; t.value = '';
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { toast('Image trop lourde (15 Mo max).'); return; }
    await db.kvSet('wallpaper', f); await applyWallpaper(f); render();
  } else if (t.id === 'backupInput') {
    const f = t.files[0]; t.value = '';
    if (f) await restoreBackup(f);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'webForm') {
    const q = $('#q').value.trim();
    if (q) webSearch(q);
    return;
  }
  if (form.id === 'dlForm') {
    S.deadlines.push({ id: uid(), title: data.title.trim(), subjectId: data.subjectId || '', kind: data.kind, due: data.due, done: false });
    await save('deadlines'); toast('Ajouté.'); render();
  } else if (form.id === 'projForm') {
    const fields = { name: data.name.trim(), kind: data.kind, due: data.due || '', url: data.url.trim(), next: data.next.trim(), remind: Number(data.remind) };
    const p = data.pid && S.projects.find((x) => x.id === data.pid);
    if (p) { if (p.due !== fields.due) p.notified = []; Object.assign(p, fields); }
    else S.projects.push({ id: uid(), ...fields, progress: 0, done: false, createdAt: ymd(new Date()) });
    S.ui.projEdit = null;
    await saveProjectsAndAnnounce(); toast(p ? 'Projet mis à jour.' : 'Projet ajouté.'); render();
  } else if (form.id === 'nameForm') {
    S.settings.firstName = (data.firstName || '').trim();
    S.ui.greet = null; // nouvelle phrase avec le prénom
    await save('settings'); toast(S.settings.firstName ? `Salut, ${S.settings.firstName} !` : 'Prénom retiré.'); render();
  } else if (form.id === 'aiForm') {
    S.settings.apiKey = data.apiKey.trim(); S.settings.model = data.model.trim();
    await save('settings');
    try { await globalThis.browser?.permissions?.request({ origins: ['https://generativelanguage.googleapis.com/*'] }); } catch { /* hors extension */ }
    toast('Réglages IA enregistrés.'); render();
  } else if (form.id === 'subjForm') {
    findOrCreateSubject(data.name); await save('subjects'); recomputeAuto(); render();
  }
});

async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'mode-etude') throw new Error('Ce fichier n\'est pas une sauvegarde Mode Étude.');
    if (!confirm('Remplacer ton emploi du temps, tes matières, tes devoirs et tes projets par cette sauvegarde ?')) return;
    if (data.semesters) S.semesters = data.semesters;
    else if (data.timetable?.sessions?.length) S.semesters = [{ ...data.timetable, id: uid(), hasPdf: false }]; // sauvegarde version 1
    S.subjects = data.subjects || []; S.deadlines = data.deadlines || []; S.ui.semId = null;
    if (data.projects) S.projects = data.projects;
    if (data.revisions) S.revisions = { done: {}, checked: {}, ...data.revisions };
    await Promise.all([save('semesters'), save('subjects'), save('deadlines'), save('projects'), save('revisions')]);
    for (const f of S.files) {
      const sid = data.assignments?.[f.path];
      if (sid) { f.subjectId = sid; await db.updateFile(f.id, { subjectId: sid }); }
    }
    recomputeAuto(); toast('Sauvegarde restaurée.'); render();
  } catch (e) { toast(e.message || String(e), 6000); }
}

window.addEventListener('hashchange', () => render({ keepScroll: false }));

// Ferme la liste de résultats quand on clique ailleurs ou qu'on appuie sur Échap.
document.addEventListener('pointerdown', (e) => {
  const box = $('#results');
  if (box && $('#webForm') && !e.target.closest('.home-hero')) box.hidden = true;
});
// Changement de thème dans Firefox : la page suit aussitôt.
onThemeChange(async () => { if (S.settings.followTheme) { await applyLook(); render(); } });

// Accueil : les widgets se réajustent à la taille de la fenêtre et quand un formulaire s'ouvre.
let fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitWidgets, 120); });
document.addEventListener('toggle', () => fitWidgets(), true);
// Clic à côté de la fenêtre « Voir plus » : elle se ferme.
$('#overlay').addEventListener('click', (e) => {
  if (e.target.id !== 'overlay') return;
  if (S.ui.folderDlg) { S.ui.folderDlg = null; showFolderDialog(); } else if (S.ui.more) { S.ui.more = null; showMore(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.ui.folderDlg) { S.ui.folderDlg = null; showFolderDialog(); return; }
  if (e.key === 'Escape' && S.ui.more) { S.ui.more = null; showMore(); return; }
  if (e.key === 'Escape' && $('#webForm')) { const box = $('#results'); if (box) box.hidden = true; }
});

// Rafraîchit « En cours » / le jour quand l'onglet revient au premier plan.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  S.projects = await loadProjects();
  if (!S.ui.draft && !document.activeElement?.matches('input,select')) render();
});

load().then(() => render({ keepScroll: false })).catch((e) => {
  view.innerHTML = `<div class="notice warn">Impossible d'ouvrir le stockage local : ${esc(e.message || e)}</div>`;
});
