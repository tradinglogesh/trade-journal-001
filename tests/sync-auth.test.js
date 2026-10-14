// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert');
const SyncMerge = require('../js/sync-merge.js');

const J = o => JSON.stringify(o);
const baseOf = (...items) => Object.fromEntries(items.map(i => [String(i.id), J(i)]));

test('merge: unchanged data produces no pushes', () => {
  const a = { id: 1, v: 'x' };
  const r = SyncMerge.mergeList([a], [a], baseOf(a));
  assert.deepStrictEqual(r.push, []);
  assert.deepStrictEqual(r.remove, []);
  assert.strictEqual(r.merged.length, 1);
});

test('merge: two devices editing different trades keeps both edits', () => {
  const t1 = { id: 1, v: 'a' }, t2 = { id: 2, v: 'b' };
  const local = [{ ...t1, v: 'a-local' }, t2];
  const cloud = [t1, { ...t2, v: 'b-cloud' }];
  const r = SyncMerge.mergeList(local, cloud, baseOf(t1, t2));
  const byId = Object.fromEntries(r.merged.map(d => [d.id, d.v]));
  assert.deepStrictEqual(byId, { 1: 'a-local', 2: 'b-cloud' });
  assert.deepStrictEqual(r.push.map(d => d.id), [1]);
});

test('merge: new local trade is pushed, new cloud trade is pulled', () => {
  const r = SyncMerge.mergeList([{ id: 1 }], [{ id: 2 }], {});
  assert.strictEqual(r.merged.length, 2);
  assert.deepStrictEqual(r.push.map(d => d.id), [1]);
});

test('merge: local delete propagates to cloud', () => {
  const a = { id: 1, v: 'x' };
  const r = SyncMerge.mergeList([], [a], baseOf(a));
  assert.deepStrictEqual(r.remove, ['1']);
  assert.strictEqual(r.merged.length, 0);
});

test('merge: cloud delete removes local copy', () => {
  const a = { id: 1, v: 'x' };
  const r = SyncMerge.mergeList([a], [], baseOf(a));
  assert.strictEqual(r.merged.length, 0);
  assert.deepStrictEqual(r.remove, []);
});

test('merge: edit beats delete from the other device', () => {
  const a = { id: 1, v: 'x' };
  const r = SyncMerge.mergeList([{ ...a, v: 'edited' }], [], baseOf(a));
  assert.strictEqual(r.merged[0].v, 'edited');
  assert.strictEqual(r.push.length, 1);
});

test('merge: true conflict resolved by newest _u stamp', () => {
  const a = { id: 1, v: 'x' };
  const l = { id: 1, v: 'L', _u: 200 }, c = { id: 1, v: 'C', _u: 100 };
  assert.strictEqual(SyncMerge.mergeList([l], [c], baseOf(a)).merged[0].v, 'L');
  const l2 = { ...l, _u: 50 };
  assert.strictEqual(SyncMerge.mergeList([l2], [c], baseOf(a)).merged[0].v, 'C');
});

// ---- AUTH with mocked fetch / localStorage / location ----
function loadAuth(fetchImpl, hash) {
  const store = {};
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  global.fetch = fetchImpl;
  global.location = { hash: hash || '', pathname: '/', search: '' };
  global.history = { replaceState() { global.location.hash = ''; } };
  delete require.cache[require.resolve('../js/supabase-auth.js')];
  const AUTH = require('../js/supabase-auth.js');
  AUTH.supabaseUrl = 'https://x.supabase.co';
  AUTH.supabaseKey = 'key';
  return { AUTH, store };
}
const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body });

test('auth: signIn stores session and authenticates', async () => {
  const { AUTH } = loadAuth(() => ok({
    access_token: 'tok', refresh_token: 'r', expires_in: 3600,
    user: { id: 'u1', email: 'a@b.c' }
  }));
  global.userProfile = { isLoggedIn: false };
  global.syncUserProfileChrome = () => {};
  await AUTH.signIn('a@b.c', 'password1');
  assert.ok(AUTH.isAuthenticated());
  assert.strictEqual(AUTH.user.id, 'u1');
});

test('auth: signIn failure does not authenticate', async () => {
  const { AUTH } = loadAuth(() => Promise.resolve({
    ok: false, status: 400, json: async () => ({ error_description: 'Invalid login credentials' })
  }));
  await assert.rejects(() => AUTH.signIn('a@b.c', 'bad'));
  assert.ok(!AUTH.isAuthenticated());
});

test('auth: ensureFresh refreshes an expired token', async () => {
  let calls = 0;
  const { AUTH } = loadAuth(() => { calls++; return ok({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, user: { id: 'u1', email: 'a@b.c' } }); });
  AUTH.session = { access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000, user: { id: 'u1' } };
  AUTH.user = { id: 'u1' };
  assert.ok(await AUTH.ensureFresh());
  assert.strictEqual(calls, 1);
  assert.strictEqual(AUTH.session.access_token, 'new');
});

test('auth: recovery token is read from URL hash and cleared', () => {
  const { AUTH } = loadAuth(() => ok({}), '#access_token=abc&type=recovery');
  assert.strictEqual(AUTH.consumeRecoveryToken(), 'abc');
  assert.strictEqual(AUTH.consumeRecoveryToken(), null);
});

test('auth: updatePassword rejects short passwords without calling the API', async () => {
  let called = false;
  const { AUTH } = loadAuth(() => { called = true; return ok({}); });
  await assert.rejects(() => AUTH.updatePassword('t', 'short'));
  assert.strictEqual(called, false);
});
