// Three-way, per-row merge used by cloud sync.
// local/cloud: arrays of {id,...}; base: {id: jsonString} as of the last successful sync.
// Each row may carry `_u` (ms timestamp of its last local edit) to settle true conflicts.
const SyncMerge = (() => {
  const str = d => (d == null ? null : JSON.stringify(d));
  const stamp = (d, fb) => (d && Number(d._u)) || fb || 0;

  function mergeList(local, cloud, base, fbLocal, fbCloud) {
    base = base || {};
    const L = new Map(local.map(d => [String(d.id), d]));
    const C = new Map(cloud.map(d => [String(d.id), d]));
    const ids = new Set([...L.keys(), ...C.keys(), ...Object.keys(base)]);
    const result = new Map();
    const push = [];
    const remove = [];

    for (const id of ids) {
      const l = L.get(id) || null;
      const c = C.get(id) || null;
      const b = base[id] ?? null;
      const ls = str(l), cs = str(c);
      const lChanged = ls !== b, cChanged = cs !== b;
      let pick;

      if (ls === cs) pick = l;
      else if (!lChanged) pick = c;
      else if (!cChanged) pick = l;
      else if (!l) pick = c;                         // edited remotely beats deleted locally
      else if (!c) pick = l;                         // edited locally beats deleted remotely
      else pick = stamp(l, fbLocal) > stamp(c, fbCloud) ? l : c;

      if (pick) result.set(id, pick);
      if (pick === l && ls !== cs) {                 // local version must reach the cloud
        if (l) push.push(l); else remove.push(id);
      }
    }

    const merged = [];
    for (const d of local) { const r = result.get(String(d.id)); if (r) { merged.push(r); result.delete(String(d.id)); } }
    for (const r of result.values()) merged.push(r);

    const newBase = {};
    merged.forEach(d => { newBase[String(d.id)] = str(d); });
    return { merged, push, remove, base: newBase };
  }

  return { mergeList };
})();

if (typeof module !== 'undefined') module.exports = SyncMerge;
