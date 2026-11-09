// Rattache un PDF à une matière d'après son dossier, son nom puis son contenu.
import { keyOf } from './util.js';

// Teintes bien séparées : deux matières voisines ne doivent pas se confondre dans la grille.
export const PALETTE = ['#2563EB', '#DC2626', '#16A34A', '#F59E0B', '#9333EA', '#0891B2', '#DB2777', '#64748B',
  '#4F46E5', '#EA580C', '#65A30D', '#0D9488', '#A16207', '#E11D48', '#7C3AED', '#CA8A04'];

const acronym = (k) => k.split(' ').filter(Boolean).map((w) => w[0]).join('');

/** Vrai si deux noms désignent la même matière (« BDD » ≈ « Bases de données »). */
export function sameSubject(a, b) {
  const ka = keyOf(a); const kb = keyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb || ka.replace(/ /g, '') === kb.replace(/ /g, '')) return true;
  const ca = ka.replace(/ /g, ''); const cb = kb.replace(/ /g, '');
  return (ca.length >= 2 && ca === acronym(kb)) || (cb.length >= 2 && cb === acronym(ka));
}

/** Score de correspondance entre un bout de texte (dossier, nom) et une matière. */
function nameScore(text, subject) {
  const kt = keyOf(text);
  if (!kt) return 0;
  let best = 0;
  for (const name of [subject.name, ...(subject.aliases || [])]) {
    const ks = keyOf(name);
    if (!ks) continue;
    const compact = kt.replace(/ /g, '');
    const acr = acronym(ks);
    if (kt === ks || compact === ks.replace(/ /g, '')) best = Math.max(best, 3);
    else if ((' ' + kt + ' ').includes(' ' + ks + ' ')) best = Math.max(best, 2);
    else if (acr.length >= 2 && (compact === acr || (' ' + kt + ' ').includes(' ' + acr + ' '))) best = Math.max(best, 2);
    else if (kt.length >= 4 && (' ' + ks + ' ').includes(' ' + kt + ' ')) best = Math.max(best, 1);
  }
  return best;
}

function countIn(haystack, needle) {
  if (!needle) return 0;
  let n = 0; let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; if (n > 9) break; }
  return n;
}

/** Devine la matière d'un fichier. Retourne l'id de la matière ou null. */
export function guessSubject(file, subjects) {
  if (!subjects.length) return null;
  // On ignore le dossier racine choisi et les dossiers de période (« Semestre 1 », « Partie 2 »).
  const dirs = contentDirs(file.path);
  const head = ' ' + keyOf(file.head || '') + ' ';
  let best = null; let bestScore = 0;
  for (const s of subjects) {
    let score = 0;
    dirs.forEach((d, i) => { score = Math.max(score, nameScore(d, s) * (20 - Math.min(i, 5))); });
    score = Math.max(score, nameScore(file.name.replace(/\.pdf$/i, ''), s) * 8);
    if (score === 0) {
      const c = countIn(head, ' ' + keyOf(s.name) + ' ');
      if (c >= 2) score = c;
    }
    if (score > bestScore) { bestScore = score; best = s.id; }
  }
  return best;
}

/* ---------- Dossiers par semestre et partie ---------- */

/**
 * Lit un nom de dossier de période : « Semestre 1 », « S1 », « Partie 2 », « P2 », « Semestre 1 - Partie 2 »,
 * « S1P2 », « 1ère partie »… Retourne { sem, part } (null si absent), ou null si ce n'est pas une période.
 */
export function parsePeriod(name) {
  const k = keyOf(name);
  let m = k.match(/^(?:(?:semestre|sem|s) ?(\d{1,2}))? ?(?:(?:partie|part|p) ?(\d))?$/);
  if (m && (m[1] || m[2])) return { sem: m[1] ? Number(m[1]) : null, part: m[2] ? Number(m[2]) : null };
  m = k.match(/^(\d)(?: ?(?:ere|er|eme|e|nd|nde))? ?partie$/);
  if (m) return { sem: null, part: Number(m[1]) };
  return null;
}

/** Période d'un fichier d'après son chemin (le dossier racine choisi est ignoré). */
export function periodOf(path) {
  const out = { sem: null, part: null };
  for (const d of path.split('/').slice(1, -1)) {
    const p = parsePeriod(d);
    if (p) { out.sem = p.sem ?? out.sem; out.part = p.part ?? out.part; }
  }
  return out.sem || out.part ? out : null;
}

/** Dossiers du chemin qui ne sont pas des périodes (racine et nom du fichier exclus). */
export const contentDirs = (path) => path.split('/').slice(1, -1).filter((d) => !parsePeriod(d));

export const periodLabel = (p) => (p ? [p.sem ? `Semestre ${p.sem}` : '', p.part ? `Partie ${p.part}` : ''].filter(Boolean).join(' · ') : '');

/** Période désignée par un nom de semestre de l'appli (« M2 SIGL · Partie 1 », « S1 partie 2 »…). */
export function periodOfText(text) {
  const k = ` ${keyOf(text)} `;
  const sem = k.match(/ (?:semestre|sem) ?(\d{1,2}) | s ?(\d{1,2})(?: |p)/);
  const part = k.match(/ (?:partie|part) ?(\d) |(?: |\d)p ?(\d) | (\d)(?: ?(?:ere|er|eme|e|nd|nde))? partie /);
  const out = { sem: sem ? Number(sem[1] || sem[2]) : null, part: part ? Number(part[1] || part[2] || part[3]) : null };
  return out.sem || out.part ? out : null;
}

/** Vrai si deux périodes peuvent désigner la même chose (une info absente ne contredit rien). */
export const samePeriod = (a, b) => !!a && !!b && (a.sem == null || b.sem == null || a.sem === b.sem)
  && (a.part == null || b.part == null || a.part === b.part) && ((a.sem != null && b.sem != null) || (a.part != null && b.part != null));
