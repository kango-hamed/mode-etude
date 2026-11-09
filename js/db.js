// Stockage local (IndexedDB) : réglages, emploi du temps, devoirs, PDF et texte indexé.
const DB_NAME = 'mode-etude';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('files')) {
          const f = db.createObjectStore('files', { keyPath: 'id' });
          f.createIndex('path', 'path', { unique: true });
        }
        if (!db.objectStoreNames.contains('pages')) {
          const p = db.createObjectStore('pages', { keyPath: ['fileId', 'page'] });
          p.createIndex('fileId', 'fileId');
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (t) => req(t.objectStore('kv').get(key)));
export const kvSet = (key, value) => run('kv', 'readwrite', (t) => { t.objectStore('kv').put(value, key); });
export const kvDel = (key) => run('kv', 'readwrite', (t) => { t.objectStore('kv').delete(key); });

export const getFiles = () => run('files', 'readonly', (t) => req(t.objectStore('files').getAll()));
export const getFile = (id) => run('files', 'readonly', (t) => req(t.objectStore('files').get(id)));
export const putFile = (rec) => run('files', 'readwrite', (t) => { t.objectStore('files').put(rec); });

export const updateFile = (id, patch) => run('files', 'readwrite', async (t) => {
  const store = t.objectStore('files');
  const rec = await req(store.get(id));
  if (rec) store.put(Object.assign(rec, patch));
});

function deletePagesOf(t, fileId) {
  const idx = t.objectStore('pages').index('fileId');
  return new Promise((res, rej) => {
    const c = idx.openKeyCursor(IDBKeyRange.only(fileId));
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return res();
      t.objectStore('pages').delete(cur.primaryKey);
      cur.continue();
    };
    c.onerror = () => rej(c.error);
  });
}

export const deleteFile = (id) => run(['files', 'pages'], 'readwrite', async (t) => {
  t.objectStore('files').delete(id);
  await deletePagesOf(t, id);
});

/** Enregistre un fichier et le texte de ses pages (remplace l'ancien texte). */
export const saveIndexedFile = (rec, pages) => run(['files', 'pages'], 'readwrite', async (t) => {
  await deletePagesOf(t, rec.id);
  t.objectStore('files').put(rec);
  const ps = t.objectStore('pages');
  pages.forEach((text, i) => ps.put({ fileId: rec.id, page: i + 1, text }));
});

export const getAllPages = () => run('pages', 'readonly', (t) => req(t.objectStore('pages').getAll()));

export const clearFiles = () => run(['files', 'pages'], 'readwrite', (t) => {
  t.objectStore('files').clear();
  t.objectStore('pages').clear();
});
