// Tâche de fond : clic droit « Ajouter à Mode Étude » et rappels avant les dates limites.
import { loadProjects, saveProjects, dueReminders, reminderText } from './projects.js';
import { parseYmd, daysBetween } from './util.js';

const B = globalThis.browser;
const MENU = 'add-reminder';

function setupMenu() {
  B.contextMenus.removeAll().then(() => {
    B.contextMenus.create({ id: MENU, title: 'Ajouter à Mode Étude (rappel)', contexts: ['page', 'selection', 'link'] });
  });
}

B.runtime.onInstalled.addListener(() => { setupMenu(); schedule(); check(); });
B.runtime.onStartup.addListener(() => { setupMenu(); schedule(); check(); });

// Ce que le clic droit a visé : la petite fenêtre le demande en s'ouvrant.
let capture = null;

B.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU) return;
  // Un lien cliqué droit : c'est lui qu'on ajoute (son texte sert de nom).
  capture = {
    at: Date.now(), tabId: info.linkUrl ? null : tab?.id,
    url: info.linkUrl || tab?.url || '', title: info.linkUrl ? (info.linkText || '') : (tab?.title || ''),
    selection: info.selectionText || '',
  };
  // Ouvrir tout de suite, sans attendre : Firefox n'autorise l'ouverture que pendant le clic.
  B.action.openPopup().catch(() => {
    B.windows.create({ url: B.runtime.getURL('popup.html'), type: 'popup', width: 380, height: 580 });
  });
});

/* ---------- Rappels ---------- */

function schedule() { B.alarms.create('check-reminders', { periodInMinutes: 30, delayInMinutes: 1 }); }

async function check() {
  const list = await loadProjects();
  const due = dueReminders(list);
  for (const { p, key, left } of due) {
    await B.notifications.create(`proj:${p.id}`, {
      type: 'basic',
      iconUrl: B.runtime.getURL('icons/icon-96.png'),
      title: `${p.kind || 'Rappel'} · ${p.name}`,
      message: reminderText(p, left),
    });
    p.notified = [...(p.notified || []).filter((k) => k.startsWith(`${p.due}:`)), key];
  }
  if (due.length) await saveProjects(list);
  // Badge : le nombre de dates limites dans les 3 jours.
  const soon = list.filter((p) => !p.done && p.due && daysBetween(new Date(), parseYmd(p.due)) >= 0 && daysBetween(new Date(), parseYmd(p.due)) <= 3).length;
  B.action.setBadgeText({ text: soon ? String(soon) : '' });
  B.action.setBadgeBackgroundColor({ color: '#C2410C' });
}

B.alarms.onAlarm.addListener((a) => { if (a.name === 'check-reminders') check(); });
B.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'projects-changed') check();
  if (msg?.type === 'take-capture') {
    const c = capture && Date.now() - capture.at < 60000 ? capture : null;
    capture = null;
    return Promise.resolve(c);
  }
  return undefined;
});

// Clic sur le rappel : ouvre le site de la compétition (ou le tableau de bord s'il n'y a pas de lien).
B.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('proj:')) return;
  const p = (await loadProjects()).find((x) => x.id === id.slice(5));
  B.tabs.create({ url: p?.url || B.runtime.getURL('newtab.html#/') });
  B.notifications.clear(id);
});

schedule();
check();
