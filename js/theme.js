// Suivre le thème de Firefox : ses couleurs (celles prévues pour le nouvel onglet en priorité) et, au choix, son image.
// Les fonds d'écran de la page Nouvel onglet de Firefox, eux, ne sont pas accessibles aux extensions.

const api = () => globalThis.browser?.theme;
export const themeSupported = () => !!api()?.getCurrent;

export async function currentTheme() {
  try { return (await api()?.getCurrent?.()) || null; } catch { return null; }
}

export function onThemeChange(fn) {
  try { api()?.onUpdated?.addListener(() => fn()); } catch { /* hors extension */ }
}

/* ---------- Couleurs ---------- */

const ctx = document.createElement('canvas').getContext('2d');

/** Couleur de thème (« #fff », « rgb(…) », nom CSS ou [r, g, b]) → [r, g, b], ou null. */
function rgb(c) {
  if (c == null || c === '') return null;
  if (Array.isArray(c)) return c.slice(0, 3).map(Number);
  ctx.fillStyle = '#010203';
  ctx.fillStyle = String(c);
  const v = ctx.fillStyle;
  if (v === '#010203' && String(c).toLowerCase() !== '#010203') return null; // couleur illisible
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  const m = v.match(/[\d.]+/g);
  if (!m) return null;
  if (m.length === 4 && Number(m[3]) === 0) return null; // transparent : inutilisable comme fond
  return m.slice(0, 3).map(Number);
}

const hex = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t); // t = part de b
function lum(c) {
  const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const first = (...cs) => cs.map(rgb).find(Boolean) || null;

const WHITE = [255, 255, 255];
const STATUS = {
  light: { '--warn': '#C2410C', '--warn-soft': '#FFF7ED', '--warn-line': '#FCD9B6', '--warn-ink': '#7C2D12', '--ok': '#0F766E', '--ok-soft': '#E6F4F1', '--mark': '#FDE68A' },
  dark: { '--warn': '#F08A4B', '--warn-soft': '#2A1E16', '--warn-line': '#5A3A22', '--warn-ink': '#F7C9A8', '--ok': '#4FC3B1', '--ok-soft': '#16302C', '--mark': '#6B5A12' },
};

/**
 * Variables CSS de la page tirées du thème : fond et texte du nouvel onglet (ou de la barre d'onglets),
 * cartes un peu plus claires que le fond, accent du thème s'il reste lisible sous du texte blanc.
 */
export function paletteFrom(theme) {
  const c = theme?.colors || {};
  const bg = first(c.ntp_background, c.frame, c.accentcolor);
  if (!bg) return null;
  const dark = lum(bg) < 0.2;
  let ink = first(c.ntp_text, c.tab_background_text, c.textcolor, c.toolbar_text);
  if (!ink || contrast(ink, bg) < 4) ink = dark ? [236, 238, 242] : [22, 24, 29];
  let accent = first(c.tab_line, c.icons_attention, c.popup_highlight, c.toolbar_field_border_focus, c.button_background_active);
  if (!accent || contrast(accent, WHITE) < 2.6 || contrast(accent, bg) < 1.6) accent = dark ? [124, 156, 255] : [47, 91, 234];
  const card = dark ? mix(bg, WHITE, 0.06) : mix(bg, WHITE, 0.75);
  return {
    dark,
    vars: {
      '--bg': hex(bg),
      '--card': hex(card),
      '--soft': hex(mix(card, ink, 0.04)),
      '--line': hex(mix(card, ink, dark ? 0.16 : 0.12)),
      '--line-2': hex(mix(card, ink, dark ? 0.1 : 0.07)),
      '--ink': hex(ink),
      '--ink-2': hex(mix(ink, bg, 0.18)),
      '--muted': hex(mix(ink, bg, 0.4)),
      '--accent': hex(accent),
      '--accent-ink': hex(mix(accent, ink, 0.35)),
      '--accent-soft': hex(mix(card, accent, dark ? 0.22 : 0.12)),
      ...STATUS[dark ? 'dark' : 'light'],
    },
  };
}

/** Image du thème (celle de la barre d'onglets, ou la première image d'arrière-plan). */
export function themeImage(theme) {
  const im = theme?.images || {};
  return im.theme_frame || im.headerURL || (im.additional_backgrounds || [])[0] || '';
}

/** Vrai si l'image peut être affichée par la page (certains thèmes la gardent pour eux). */
export function canLoad(url) {
  return new Promise((res) => {
    if (!url) { res(false); return; }
    const img = new Image();
    const t = setTimeout(() => res(false), 4000);
    img.onload = () => { clearTimeout(t); res(img.naturalWidth > 0); };
    img.onerror = () => { clearTimeout(t); res(false); };
    img.src = url;
  });
}
