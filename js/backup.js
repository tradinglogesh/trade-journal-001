// Backup & Restore Module
// Handles JSON export/import and cloud backup

const BACKUP = {
  // Export all user data to JSON
  exportToJSON(silent) {
    if (!allJournals?.length) {
      if (!silent) toast('⚠️ No data to export');
      return null;
    }

    try {
      const backup = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        user: AUTH.user?.email,
        data: {
          journals: allJournals,
          entries: allEntries,
          tradingPlans: allTradingPlans
        }
      };

      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trading-journal-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      if (!silent) toast('✅ Backup downloaded');
      return backup;
    } catch (e) {
      toast('⚠️ Export failed: ' + e.message);
      return null;
    }
  },

  // Import data from JSON file
  async importFromJSON(file) {
    if (!file) {
      toast('⚠️ No file selected');
      return false;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const backup = JSON.parse(e.target.result);

          if (!backup.data || !Array.isArray(backup.data.journals)) {
            throw new Error('Invalid backup file format');
          }

          if (!confirm(`Import ${backup.data.entries?.length || 0} trades from ${backup.data.journals?.length || 0} journals?`)) {
            return resolve(false);
          }

          // Merge into Supabase
          // Restore: backup version replaces rows with the same id, missing rows are added
          const mergeById = (target, items) => {
            let changed = 0;
            for (const it of items || []) {
              const i = target.findIndex(x => String(x.id) === String(it.id));
              if (i < 0) { target.push(it); changed++; }
              else if (JSON.stringify(target[i]) !== JSON.stringify(it)) { target[i] = { ...it, _u: Date.now() }; changed++; }
            }
            return changed;
          };
          let imported = mergeById(allJournals, backup.data.journals);
          imported += mergeById(allEntries, backup.data.entries);
          mergeById(allTradingPlans, backup.data.tradingPlans || backup.data.plans);

          saveToStorage();
          await DB.syncAll();
          switchTab(currentTab);

          toast(`✅ Imported ${imported} items`);
          resolve(true);
        } catch (e) {
          toast('⚠️ Import failed: ' + e.message);
          resolve(false);
        }
      };

      reader.onerror = () => {
        toast('⚠️ Failed to read file');
        resolve(false);
      };

      reader.readAsText(file);
    });
  },

  // Save backup to Supabase backups table
  async saveCloudBackup(silent) {
    if (!AUTH.isAuthenticated()) throw new Error('Not authenticated');

    try {
      const backupData = {
        version: '1.0',
        data: {
          journals: allJournals,
          entries: allEntries,
          tradingPlans: allTradingPlans
        }
      };

      const payload = {
        user_id: AUTH.user.id,
        backup_name: `Auto-backup ${new Date().toLocaleString()}`,
        backup_data: backupData,
        size_kb: Math.round(JSON.stringify(backupData).length / 1024)
      };

      const res = await fetch(
        `${AUTH.supabaseUrl}/rest/v1/backups`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
            ...AUTH.getHeaders()
          },
          body: JSON.stringify(payload)
        }
      );

      if (!res.ok) throw new Error('Failed to save backup');

      if (!silent) toast('☁️ Backup saved');
      return true;
    } catch (e) {
      console.error('Cloud backup error:', e);
      throw e;
    }
  },

  // List all cloud backups
  async listCloudBackups() {
    if (!AUTH.isAuthenticated()) throw new Error('Not authenticated');

    try {
      const res = await fetch(
        `${AUTH.supabaseUrl}/rest/v1/backups?user_id=eq.${AUTH.user.id}&order=created_at.desc&limit=10`,
        { headers: AUTH.getHeaders() }
      );

      if (!res.ok) throw new Error('Failed to fetch backups');
      return await res.json();
    } catch (e) {
      console.error('List backups error:', e);
      throw e;
    }
  },

  // Restore from cloud backup
  async restoreCloudBackup(backupId) {
    if (!AUTH.isAuthenticated()) throw new Error('Not authenticated');

    try {
      const res = await fetch(
        `${AUTH.supabaseUrl}/rest/v1/backups?id=eq.${backupId}`,
        { headers: AUTH.getHeaders() }
      );

      if (!res.ok) throw new Error('Backup not found');

      const [backup] = await res.json();
      if (!backup?.backup_data) throw new Error('Backup data missing');

      if (!confirm(`Restore to ${new Date(backup.created_at).toLocaleString()}?`)) {
        return false;
      }

      // Import the backup data
      const file = new File(
        [JSON.stringify(backup.backup_data)],
        'backup.json',
        { type: 'application/json' }
      );

      return await this.importFromJSON(file);
    } catch (e) {
      toast('⚠️ Restore failed: ' + e.message);
      return false;
    }
  },

  // Delete old backups (keep only last 10)
  async cleanupOldBackups() {
    try {
      const backups = await this.listCloudBackups();
      if (backups.length <= 10) return;
      // Never delete the largest (most complete) backup
      const best = backups.reduce((a, b) => ((b.size_kb || 0) > (a.size_kb || 0) ? b : a));

      const toDelete = backups.slice(10).filter(b => b.id !== best.id);
      for (const backup of toDelete) {
        await fetch(
          `${AUTH.supabaseUrl}/rest/v1/backups?id=eq.${backup.id}`,
          {
            method: 'DELETE',
            headers: AUTH.getHeaders()
          }
        );
      }
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }
};

// Scheduled backups: cloud copy daily; download reminder popup every 10 min.
// Runs at startup (if due) and then hourly while the app stays open.
const BACKUP_CLOUD_MS = 24 * 60 * 60 * 1000;
let backupTimer, backupRemindTimer, backupFirstTimer;

async function runScheduledBackups() {
  if (!AUTH.isAuthenticated() || !navigator.onLine || !allJournals?.length || !allEntries?.length) return;
  if (runScheduledBackups.running) return;
  runScheduledBackups.running = true;
  try { await _runScheduledBackups(); } finally { runScheduledBackups.running = false; }
}

async function _runScheduledBackups() {
  const uid = AUTH.user.id;
  const now = Date.now();
  const lastCloud = Number(localStorage.getItem('tj_last_cloud_backup_' + uid)) || 0;

  if (now - lastCloud >= BACKUP_CLOUD_MS) {
    try {
      await BACKUP.saveCloudBackup(true);
      await BACKUP.cleanupOldBackups();
      localStorage.setItem('tj_last_cloud_backup_' + uid, String(now));
    } catch (e) { console.warn('Scheduled cloud backup failed:', e.message); }
  }
}

// Generic popup (used by Restore and the backup prompt)
function showModal(title, html) {
  closeDynModal();
  const el = document.createElement('div');
  el.id = 'tjDynModal';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99999;';
  el.innerHTML = `<div style="background:var(--surface,#1e1e2e);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:12px;min-width:300px;max-width:92vw;box-shadow:0 10px 40px rgba(0,0,0,.5);">
    <div style="padding:14px 16px;font-weight:800;border-bottom:1px solid var(--border,#333);">${title}</div>${html}</div>`;
  el.addEventListener('click', e => { if (e.target === el) closeDynModal(); });
  document.body.appendChild(el);
}
function closeDynModal() { document.getElementById('tjDynModal')?.remove(); }

// Popup with Download JSON / Sync / Cancel. onDone runs after an action (or skip).
function askBackupThen(title, text, onDone, skipLabel, onCancel, showSync) {
  window._backupDone = () => { closeDynModal(); if (onDone) onDone(); };
  window._backupDownload = () => { BACKUP.exportToJSON(); window._backupDone(); };
  window._backupSync = () => { if (typeof syncNow === 'function') syncNow(); window._backupDone(); };
  window._backupCancel = () => { closeDynModal(); if (onCancel) onCancel(); };
  const btn = 'padding:10px 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;flex:1;border:1px solid var(--border,#333);background:var(--surface2,#2a2a3c);color:inherit;';
  const primary = 'background:#6366f1;color:#fff;border-color:#6366f1;';
  showModal(title, `<div style="padding:18px;text-align:center;">
    <div style="font-size:14px;margin-bottom:16px;">${text}</div>
    <div style="display:flex;gap:8px;">
      <button style="${btn}${primary}" onclick="_backupDownload()">📥 Download JSON</button>
      ${showSync ? `<button style="${btn}" onclick="_backupSync()">🔄 Sync</button>` : ''}
      <button style="${btn}" onclick="_backupCancel()">✖ Cancel</button>
    </div>
    ${skipLabel ? `<div style="margin-top:12px;"><a href="#" style="font-size:12px;color:var(--muted,#999);" onclick="_backupDone();return false;">${skipLabel}</a></div>` : ''}
  </div>`);
}

// Reminder popup every 10 minutes while the app is open
const BACKUP_REMIND_MS = 10 * 60 * 1000;
function checkBackupReminder() {
  if (!AUTH.isAuthenticated() || !allEntries?.length || document.getElementById('tjDynModal')) return;
  askBackupThen('🔔 Reminder', 'Backup or sync your trades?', null, null, null, true);
}

function scheduleAutoBackup() {
  if (!AUTH.isAuthenticated()) return;
  clearInterval(backupTimer);
  clearInterval(backupRemindTimer);
  clearTimeout(backupFirstTimer);
  backupFirstTimer = setTimeout(runScheduledBackups, 15000);
  backupTimer = setInterval(runScheduledBackups, 60 * 60 * 1000);
  backupRemindTimer = setInterval(checkBackupReminder, BACKUP_REMIND_MS);
}
// Manual backup button handler

// Manual restore handler

