// Petite fenêtre du bouton de la barre d'outils (ou du clic droit) : ajoute la page en cours comme rappel.
import { PROJECT_KINDS, REMINDERS, DEFAULT_REMIND, findDates, loadProjects, saveProjects, addProject, announce } from './projects.js';
import { parseYmd, fmtLong, daysBetween } from './util.js';
import { hostOf } from './browser.js';

const B = globalThis.browser;
const $ = (s) => document.querySelector(s);
const form = $('#addForm');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Titre d'onglet → nom lisible : « Hackathon 2026 | Devpost » → « Hackathon 2026 ». */
function niceName(title, url) {
  const t = String(title || '').replace(/^\(\d+\+?\)\s*/, '').split(/\s[-–|·:]\s/)[0].trim();
  if (t) return t.slice(0, 90);
  return hostOf(url);
}

/** La page à ajouter : celle du clic droit, sinon l'onglet actif, sinon (développement) l'adresse de la fenêtre. */
async function source() {
  const params = new URLSearchParams(location.search);
  if (!B?.tabs) return { title: params.get('title') || '', url: params.get('url') || '', text: params.get('text') || '', selection: params.get('selection') || '' };
  const cap = await B.runtime.sendMessage({ type: 'take-capture' }).catch(() => null);
  const [active] = await B.tabs.query({ active: true, currentWindow: true });
  const tab = cap ? { id: cap.tabId, title: cap.title, url: cap.url } : active;
  let text = ''; let selection = cap?.selection || '';
  if (tab?.id) {
    try {
      const [res] = await B.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ text: (document.body?.innerText || '').slice(0, 60000), selection: String(getSelection() || '') }),
      });
      text = res.result?.text || '';
      selection ||= res.result?.selection || '';
    } catch { /* page interne de Firefox : pas d'accès au texte */ }
  }
  return { title: tab?.title || '', url: tab?.url || '', text, selection };
}

function fillSelect(sel, items, value) {
  sel.innerHTML = items.map((i) => `<option value="${esc(i.v)}" ${String(i.v) === String(value) ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
}

let existing = null;

async function init() {
  const src = await source();
  const list = await loadProjects();
  const web = /^https?:/i.test(src.url);
  existing = web ? list.find((p) => p.url && p.url.split('#')[0] === src.url.split('#')[0]) : null;

  fillSelect(form.kind, PROJECT_KINDS.map((k) => ({ v: k, label: k })), existing?.kind || 'Compétition');
  fillSelect(form.remind, REMINDERS, existing?.remind ?? DEFAULT_REMIND);
  form.name.value = existing?.name || niceName(src.title, src.url);
  form.url.value = existing?.url || (web ? src.url : '');
  form.next.value = existing?.next || '';
  $('#host').textContent = web ? hostOf(src.url) : '';

  // Dates trouvées dans la sélection, sinon dans la page : celles qui suivent « date limite », « deadline »… d'abord.
  const dates = findDates(src.selection).concat(findDates(src.text)).filter((d, i, a) => a.findIndex((x) => x.ymd === d.ymd) === i);
  // Préremplie seulement si on est sûr : date sélectionnée, ou date juste après « date limite », « deadline »…
  form.due.value = existing?.due || findDates(src.selection)[0]?.ymd || dates.find((d) => d.key)?.ymd || '';
  if (dates.length) {
    const box = $('#dates');
    box.hidden = false;
    box.innerHTML = `<span class="muted small">Dates trouvées sur la page :</span>${dates.slice(0, 5).map((d) =>
      `<button type="button" class="chip ${d.ymd === form.due.value ? 'on' : ''}" data-ymd="${d.ymd}" title="${d.key ? 'Près de « date limite », « deadline »…' : ''}">${esc(fmtLong(parseYmd(d.ymd)))}${d.key ? ' ★' : ''}</button>`).join('')}`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ymd]'); if (!b) return;
      form.due.value = b.dataset.ymd;
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    });
  }
  if (existing) {
    $('#already').hidden = false;
    $('#already').textContent = 'Cette page est déjà dans tes projets : tu peux mettre le rappel à jour.';
    form.querySelector('[type=submit]').textContent = 'Mettre à jour';
  }
  form.name.focus(); form.name.select();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = { name: form.name.value.trim(), kind: form.kind.value, due: form.due.value, remind: Number(form.remind.value),
    next: form.next.value.trim(), url: form.url.value.trim() };
  if (existing) {
    const list = await loadProjects();
    const p = list.find((x) => x.id === existing.id);
    if (p) { if (p.due !== fields.due) p.notified = []; Object.assign(p, fields); }
    await saveProjects(list); announce();
  } else {
    await addProject(fields);
  }
  const r = REMINDERS.find((x) => x.v === fields.remind);
  const left = fields.due ? daysBetween(new Date(), parseYmd(fields.due)) : null;
  $('#done').hidden = false;
  $('#done').innerHTML = `<b>${existing ? 'Mis à jour' : 'Ajouté'} ✓</b> ${fields.due
    ? `${esc(fmtLong(parseYmd(fields.due)))}${left >= 0 ? ` (dans ${left} j)` : ''} · ${fields.remind < 0 ? 'sans rappel' : `rappel : ${esc(r.label.toLowerCase())}`}`
    : 'Sans date limite : pense à en ajouter une pour être prévenu.'}`;
  form.querySelector('[type=submit]').disabled = true;
  if (B?.tabs) setTimeout(() => window.close(), 1600);
});

$('#openApp').addEventListener('click', (e) => {
  if (!B?.tabs) return;
  e.preventDefault();
  B.tabs.create({ url: B.runtime.getURL('newtab.html#/') }); window.close();
});

init();
