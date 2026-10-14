// Private image storage on Supabase Storage (one folder per user).
// Entries keep only "sb:<path>" references; base64 images are migrated on sync.
const STORE = {
  bucket: 'trade-images',
  _signed: {},

  isRef(v) { return typeof v === 'string' && v.startsWith('sb:'); },

  _base() { return `${AUTH.supabaseUrl}/storage/v1`; },

  async upload(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `${AUTH.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const res = await fetch(`${this._base()}/object/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { ...AUTH.getHeaders(), 'Content-Type': blob.type, 'x-upsert': 'false' },
      body: blob
    });
    if (!res.ok) throw new Error('Image upload failed (' + res.status + ')');
    return 'sb:' + path;
  },

  // Turn a stored value into something an <img> can show
  async resolve(v) {
    if (!this.isRef(v)) return v;
    const path = v.slice(3);
    const hit = this._signed[path];
    if (hit && hit.exp > Date.now()) return hit.url;
    await AUTH.ensureFresh();
    const res = await fetch(`${this._base()}/object/sign/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH.getHeaders() },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!res.ok) return '';
    const { signedURL } = await res.json();
    const url = this._base() + signedURL;
    this._signed[path] = { url, exp: Date.now() + 50 * 60 * 1000 };
    return url;
  },

  async remove(paths) {
    if (!paths.length) return;
    await fetch(`${this._base()}/object/${this.bucket}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH.getHeaders() },
      body: JSON.stringify({ prefixes: paths })
    });
  },

  // Upload any base64 charts in entries; returns true if anything changed
  async migrateEntries(entries) {
    let changed = false;
    for (const e of entries) {
      const list = e.chart_urls || (e.chart_url ? [e.chart_url] : []);
      if (!list.some(u => typeof u === 'string' && u.startsWith('data:image/'))) continue;
      const out = [];
      for (const u of list) {
        if (typeof u === 'string' && u.startsWith('data:image/')) {
          try { out.push(await this.upload(u)); } catch (err) { console.error(err); out.push(u); }
        } else out.push(u);
      }
      if (out.some((u, i) => u !== list[i])) {
        e.chart_urls = out;
        e.chart_url = out[0] || '';
        changed = true;
      }
    }
    return changed;
  },

  // Remove stored files no entry references (only files older than 1 hour)
  async cleanupOrphans(entries) {
    const used = new Set();
    entries.forEach(e => (e.chart_urls || []).forEach(u => { if (this.isRef(u)) used.add(u.slice(3)); }));
    const res = await fetch(`${this._base()}/object/list/${this.bucket}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH.getHeaders() },
      body: JSON.stringify({ prefix: AUTH.user.id, limit: 1000 })
    });
    if (!res.ok) return;
    const files = await res.json();
    const old = Date.now() - 3600 * 1000;
    const orphans = files
      .filter(f => f.name && f.created_at && new Date(f.created_at).getTime() < old)
      .map(f => `${AUTH.user.id}/${f.name}`)
      .filter(p => !used.has(p));
    await this.remove(orphans);
  }
};
