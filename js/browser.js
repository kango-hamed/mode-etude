// Accès aux fonctions de Firefox (sites les plus visités, moteur de recherche).
// Hors extension (page servie en local pour développer), on retombe sur des valeurs d'exemple.
const B = globalThis.browser;

export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u); } };

/** « (41) WhatsApp » → « WhatsApp » ; titre vide → domaine. */
export function cleanTitle(title, url) {
  const t = String(title || '').replace(/^\(\d+\+?\)\s*/, '').split(/\s[-–|·]\s/)[0].trim();
  if (t && t.length <= 40) return t;
  const h = hostOf(url).split('.');
  const name = h.length > 2 ? h[h.length - 2] : h[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const SAMPLE = [
  ['https://web.whatsapp.com/', 'WhatsApp'], ['https://www.youtube.com/', 'YouTube'], ['https://chatgpt.com/', 'ChatGPT'],
  ['https://claude.ai/', 'Claude'], ['https://www.perplexity.ai/', 'Perplexity'], ['https://github.com/', 'GitHub'],
  ['https://gemini.google.com/', 'Gemini'], ['https://anime-sama.fr/', 'Anime-Sama'],
].map(([url, title]) => ({ url, title, favicon: '' }));

export async function topSites() {
  if (!B?.topSites) return SAMPLE;
  try {
    const list = await B.topSites.get({ includeFavicon: true, newtab: true, limit: 16 });
    return list.filter((s) => s.url && /^https?:/.test(s.url)).map((s) => ({ url: s.url, title: s.title || '', favicon: s.favicon || '' }));
  } catch {
    try {
      const list = await B.topSites.get({ includeFavicon: true });
      return list.map((s) => ({ url: s.url, title: s.title || '', favicon: s.favicon || '' }));
    } catch { return []; }
  }
}

/** Recherche web avec le moteur par défaut de Firefox. */
export function webSearch(text) {
  if (B?.search?.query) return B.search.query({ text, disposition: 'CURRENT_TAB' });
  location.href = 'https://www.google.com/search?q=' + encodeURIComponent(text);
  return null;
}


