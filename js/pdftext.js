// Extraction du texte des PDF, page par page, avec pdf.js (embarqué dans vendor/).
import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export async function extractPages(blob, { maxPages = 600 } = {}) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  try {
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
        .join('')
        .replace(/[ \t ]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
      pages.push(text);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
