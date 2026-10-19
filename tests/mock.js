// Fake signed-in account for tests: an in-memory stand-in for the app's database and user APIs, seeded from window.SEED.
(() => {
  const docs = JSON.parse(localStorage.getItem('mockdb') || 'null') || window.SEED || {};
  const subs = new Set();
  const save = () => localStorage.setItem('mockdb', JSON.stringify(docs));
  const fire = () => subs.forEach((f) => f());
  const snap = (p) => ({ exists: p in docs, id: p.split('/').pop(), data: () => docs[p] });
  const list = (c) => { const ks = Object.keys(docs).filter((k) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).sort(); const d = ks.map(snap); return { docs: d, size: d.length, empty: !d.length }; };
  const docRef = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p), set: async (b) => { docs[p] = JSON.parse(JSON.stringify(b)); save(); fire(); },
    update: async (b) => { docs[p] = { ...docs[p], ...b }; save(); fire(); }, delete: async () => { delete docs[p]; save(); fire(); },
    acquire: async () => ({ acquired: true }), onSnapshot: (fn) => { const f = () => fn(snap(p)); subs.add(f); setTimeout(f); return () => subs.delete(f); } });
  const filt = (c, w) => { const r = list(c); if (!w) return r; const d = r.docs.filter((x) => (x.data()[w[0]] || []).includes(w[2])); return { docs: d, size: d.length, empty: !d.length }; };
  const col = (c, w) => ({ doc: (id) => docRef(c + '/' + id), where: (f, op, v) => col(c, [f, op, v]), get: async () => filt(c, w), onSnapshot: (fn) => { const f = () => fn(filt(c, w)); subs.add(f); setTimeout(f); return () => subs.delete(f); } });
  const db = { doc: docRef, collection: (c) => col(c) };
  const user = { me: async () => ({ id: 'me', name: 'John', avatarUrl: '' }), profiles: async (ids) => Object.fromEntries(ids.map((i) => [i, { name: { me: 'John', u2: 'Marcus', u3: 'Dee', u4: 'Tony' }[i] || 'Player' }])) };
  window.claude = { use: async (k) => k === 'user' ? user : k === 'db' ? db : null };
})();
