// Supabase Database Sync
// Each journal / entry / plan is one row (JSON document) in app_journals / app_entries /
// app_plans, protected by Row Level Security. Sync is a per-row three-way merge
// (see sync-merge.js) so edits made on two devices don't overwrite each other.
// Other devices are picked up by polling the tiny app_sync_meta row.

const DB = {
  supabaseUrl: AUTH.supabaseUrl,
  supabaseKey: AUTH.supabaseKey,
  _syncing: false,
  _seenMeta: 0,
  _pollTimer: null,
  POLL_MS: 20000,
  TABLES: [['app_journals', 'journals'], ['app_entries', 'entries'], ['app_plans', 'plans']],

  _headers(extra) {
    return { 'Content-Type': 'application/json', ...AUTH.getHeaders(), ...(extra || {}) };
  },

  async _get(table, query) {
    const res = await fetch(`${AUTH.supabaseUrl}/rest/v1/${table}?${query}`, { headers: this._headers() });
    if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async _upsert(table, rows, conflict) {
    if (!rows.length) return;
    const res = await fetch(`${AUTH.supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: this._headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows)
    });
    if (!res.ok) throw new Error(`Save ${table} failed: ${res.status} ${await res.text()}`);
  },

  async _delete(table, ids) {
    for (let i = 0; i < ids.length; i += 50) {
      const list = ids.slice(i, i + 50).map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const res = await fetch(`${AUTH.supabaseUrl}/rest/v1/${table}?id=in.(${encodeURIComponent(list)})`, {
        method: 'DELETE', headers: this._headers()
      });
      if (!res.ok) throw new Error(`Delete ${table} failed: ${res.status}`);
    }
  },

  async fetchMeta() {
    const meta = await this._get('app_sync_meta', 'select=data_updated_at');
    return Number(meta[0]?.data_updated_at) || 0;
  },

  async fetchCloud() {
    const [journals, entries, plans, updatedAt] = await Promise.all([
      this._get('app_journals', 'select=id,data'),
      this._get('app_entries', 'select=id,data'),
      this._get('app_plans', 'select=id,data'),
      this.fetchMeta()
    ]);
    return {
      journals: journals.map(r => r.data),
      entries: entries.map(r => r.data),
      plans: plans.map(r => r.data),
      updatedAt,
      hasData: journals.length + entries.length + plans.length > 0
    };
  },

  // Per-user record of what each row looked like at the last successful sync
  _baseKey() { return 'tj_sync_base_' + AUTH.user.id; },
  _loadBase() {
    try { return JSON.parse(localStorage.getItem(this._baseKey())) || {}; } catch (e) { return {}; }
  },
  _saveBase(base) { localStorage.setItem(this._baseKey(), JSON.stringify(base)); },
  clearBase(uid) { localStorage.removeItem('tj_sync_base_' + uid); },

  _localLists() {
    return { journals: allJournals, entries: allEntries, plans: allTradingPlans };
  },

  // Treat current local arrays as identical to the cloud (after a full download)
  rebase(updatedAt) {
    const base = {};
    for (const [table, key] of this.TABLES) {
      base[table] = {};
      this._localLists()[key].forEach(d => { base[table][String(d.id)] = JSON.stringify(d); });
    }
    this._saveBase(base);
    this._seenMeta = updatedAt || 0;
  },

  // Download cloud data and replace local arrays
  async fetchAll() {
    if (!AUTH.isAuthenticated()) throw new Error('Not authenticated');
    const cloud = await this.fetchCloud();
    allJournals = cloud.journals;
    allEntries = cloud.entries;
    allTradingPlans = cloud.plans;
    dataUpdatedAt = cloud.updatedAt || Date.now();
    this.rebase(cloud.updatedAt);
    return true;
  },

  async syncAll() {
    if (!AUTH.isAuthenticated()) return false;
    if (this._syncing) return true;
    this._syncing = true;
    try {
      setSyncState('syncing');
      if (!(await AUTH.ensureFresh())) throw new Error('Session expired');
      const uid = AUTH.user.id;

      if (await STORE.migrateEntries(allEntries)) saveToStorage(true);

      const cloud = await this.fetchCloud();
      const allBase = this._loadBase();
      const newBase = {};
      const merged = {};
      let remoteChanged = false;
      let pushed = false;

      // Safety: a journal list is never legitimately empty. If it is, local state was
      // wiped, so pull from the cloud instead of deleting cloud rows.
      const wiped = !allJournals?.length && cloud.journals.length > 0;
      if (wiped) console.warn('Local data empty - restoring from cloud instead of deleting');

      for (const [table, key] of this.TABLES) {
        const local = wiped ? [] : this._localLists()[key];
        const r = SyncMerge.mergeList(local, cloud[key], wiped ? {} : allBase[table], dataUpdatedAt, cloud.updatedAt);
        merged[key] = r.merged;
        newBase[table] = r.base;
        if (JSON.stringify(r.merged) !== JSON.stringify(local)) remoteChanged = true;
        if (r.push.length) {
          await this._upsert(table, r.push.map(d => ({ user_id: uid, id: String(d.id), data: d, updated_at: new Date().toISOString() })), 'user_id,id');
          pushed = true;
        }
        if (r.remove.length) { await this._delete(table, r.remove); pushed = true; }
      }

      let meta = cloud.updatedAt;
      if (pushed || !meta) {
        meta = Date.now();
        await this._upsert('app_sync_meta', [{ user_id: uid, data_updated_at: meta }], 'user_id');
      }
      this._saveBase(newBase);
      this._seenMeta = meta;

      if (remoteChanged) {
        allJournals = merged.journals;
        allEntries = merged.entries;
        allTradingPlans = merged.plans;
        dataUpdatedAt = Math.max(dataUpdatedAt || 0, meta);
        saveToStorage(true);
        if (typeof currentScreenId !== 'undefined' && currentScreenId === 'mainScreen') switchTab(currentTab);
      } else {
        saveToStorage(true);
      }
      STORE.cleanupOrphans(allEntries).catch(() => {});

      setSyncState('synced');
      lastSyncedAt = Date.now();
      return true;
    } catch (e) {
      console.error('Sync failed:', e);
      setSyncState(navigator.onLine ? 'error' : 'offline');
      return false;
    } finally {
      this._syncing = false;
    }
  },

  scheduleSync() {
    if (!AUTH.isAuthenticated()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      if (!navigator.onLine) return setSyncState('offline');
      await this.syncAll();
    }, 3000);
  },

  // Pick up changes made on other devices
  async pollOnce() {
    if (document.hidden || !navigator.onLine || this._syncing || !AUTH.isAuthenticated()) return;
    try {
      if (!(await AUTH.ensureFresh())) return;
      const meta = await this.fetchMeta();
      if (meta && meta !== this._seenMeta) await this.syncAll();
    } catch (e) { console.warn('Poll failed:', e.message); }
  },

  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollOnce(), this.POLL_MS);
  },

  stopPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
};

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) DB.pollOnce(); });
}
