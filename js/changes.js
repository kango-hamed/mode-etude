// Changements entre deux versions d'un emploi du temps : cours déplacés, ajoutés, annulés, changés de salle.
import { parseYmd, daysBetween } from './util.js';

/**
 * occ : séances datées { date (AAAA-MM-JJ), start, end, subjectId, room, type }.
 * Retour : [{ kind: 'moved' | 'time' | 'room' | 'added' | 'removed', subjectId, date, old, new }] trié par date.
 * « date » est la date à surveiller : la nouvelle (ou celle du cours annulé).
 */
export function diffOccurrences(oldOcc, newOcc) {
  const group = (list) => {
    const m = new Map();
    for (const o of list) {
      const k = `${o.date}|${o.subjectId}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(o);
    }
    for (const v of m.values()) v.sort((a, b) => a.start.localeCompare(b.start));
    return m;
  };
  const before = group(oldOcc); const after = group(newOcc);
  const out = []; const removed = []; const added = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(k) || []; const b = after.get(k) || [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const o = a[i]; const x = b[i];
      if (o.start !== x.start || (o.end || '') !== (x.end || '')) out.push({ kind: 'time', subjectId: x.subjectId, date: x.date, old: o, new: x });
      else if ((o.room || '') !== (x.room || '') && x.room) out.push({ kind: 'room', subjectId: x.subjectId, date: x.date, old: o, new: x });
    }
    removed.push(...a.slice(n)); added.push(...b.slice(n));
  }
  // Un cours annulé et un cours ajouté de la même matière à moins d'une semaine : c'est un déplacement.
  for (const o of removed) {
    let best = -1; let gap = 99;
    added.forEach((x, i) => {
      if (!x || x.subjectId !== o.subjectId || (x.type || '') !== (o.type || '')) return;
      const g = Math.abs(daysBetween(parseYmd(o.date), parseYmd(x.date)));
      if (g <= 6 && g < gap) { gap = g; best = i; }
    });
    if (best >= 0) { out.push({ kind: 'moved', subjectId: o.subjectId, date: added[best].date, old: o, new: added[best] }); added[best] = null; }
    else out.push({ kind: 'removed', subjectId: o.subjectId, date: o.date, old: o, new: null });
  }
  for (const x of added) if (x) out.push({ kind: 'added', subjectId: x.subjectId, date: x.date, old: null, new: x });
  const at = (c) => c.date + (c.new || c.old).start;
  return out.sort((p, q) => at(p).localeCompare(at(q)));
}
