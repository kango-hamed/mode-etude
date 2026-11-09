// Petits outils : dates, texte, échappement HTML.

export const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const isoDay = (d) => ((d.getDay() + 6) % 7) + 1; // 1 = lundi … 7 = dimanche
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfWeek = (d) => addDays(startOfDay(d), -(isoDay(d) - 1));
export const fmtLong = (d) => `${DAYS[isoDay(d) - 1]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const MONTHS_ABBR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const fmtShort = (d) => `${d.getDate()} ${MONTHS_ABBR[d.getMonth()]}`;
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

/** Libellé relatif d'une échéance. */
export function relDue(dueYmd, today = new Date()) {
  const n = daysBetween(today, parseYmd(dueYmd));
  if (n < 0) return { label: n === -1 ? 'hier' : `en retard (${-n} j)`, urgent: true, late: true };
  if (n === 0) return { label: "aujourd'hui", urgent: true };
  if (n === 1) return { label: 'demain', urgent: true };
  if (n <= 6) return { label: `${DAYS[isoDay(parseYmd(dueYmd)) - 1].toLowerCase()} (${n} j)`, urgent: n <= 2 };
  return { label: fmtShort(parseYmd(dueYmd)), urgent: false };
}

/** Normalise une heure (« 8h30 », « 8:30 », « 0830 ») en « 08:30 ». */
export function normTime(s) {
  if (s == null) return '';
  const m = String(s).trim().match(/^(\d{1,2})\s*[:hH.]?\s*(\d{2})?$/);
  if (!m) return '';
  const h = Number(m[1]); const mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return '';
  return `${pad(h)}:${pad(mi)}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Minuscules sans accents, même longueur que l'original (pour retrouver les positions). */
export function fold(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out += n.length === 1 ? n : (n[0] || ' ');
  }
  return out;
}

/** Clé de comparaison : sans accents, sans ponctuation. */
export const keyOf = (s) => fold(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();

/** Surligne les termes (déjà « fold ») dans un texte. */
export function highlight(text, terms) {
  const f = fold(text);
  const marks = [];
  for (const t of terms) {
    let i = 0;
    while (t && (i = f.indexOf(t, i)) !== -1) { marks.push([i, i + t.length]); i += t.length; }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let out = ''; let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + esc(text.slice(pos));
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' Go' : n > 1e6 ? (n / 1e6).toFixed(0) + ' Mo' : Math.max(1, Math.round(n / 1e3)) + ' Ko');
