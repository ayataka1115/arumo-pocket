/* 通しの検証台。js/sync.js（端末側）と gas/Code.gs（サーバー側）を
 * fetch でつないで、実際の流れをそのまま走らせる。
 * 「入れたばかりの端末が棚をパチリする」が通ることを、両側そろえて確かめるため。 */
import fs from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, extra));
};

/* ---------- サーバー（GAS） ---------- */
function makeSheet(rows = [], cols = 14) {
  const r0 = rows.map(r => [...r]);
  return {
    __rows: r0,
    getLastRow: () => r0.length + 1,
    getLastColumn: () => cols,
    getRange: (r, c, nr, nc) => ({
      getValues: () => r0.slice(r - 2, r - 2 + nr).map(row => (row || []).slice(c - 1, c - 1 + nc)),
      setValues: v => v.forEach((row, i) => {
        const at = r - 2 + i, cur = r0[at] ? [...r0[at]] : [];
        row.forEach((cell, j) => { cur[c - 1 + j] = cell; });
        r0[at] = cur;
      }),
      setNumberFormat: () => {},
    }),
    setFrozenRows: () => {},
    getMaxRows: () => 1000,
  };
}

function makeServer(geminiItems = [{ name: '牛乳', qty: 1, unit: '本', shelf: 'fridge', confidence: 0.9 }]) {
  const props = new Map(), cache = new Map();
  const sheets = { data: makeSheet([], 14), houses: makeSheet([], 3) };
  const calls = { gemini: 0, sync: 0 };
  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ({
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = sheets[n] || makeSheet([], n === 'houses' ? 3 : 14)),
    }) },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : (k === 'GEMINI_API_KEY' ? 'dummy' : null)),
      setProperty: (k, v) => props.set(k, v),
    }) },
    Utilities: { formatDate: () => '20260823' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => { calls.gemini++; return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: geminiItems }) }] } }] }),
    }; } },
    ContentService: { createTextOutput: t => ({ setMimeType: () => ({ __text: t }) }), MimeType: { JSON: 'json' } },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), ctx);
  return {
    sheets, calls,
    handle(bodyText) {
      const body = JSON.parse(bodyText);
      if (body.action === 'sync') calls.sync++;
      return JSON.parse(ctx.doPost({ postData: { contents: bodyText } }).__text);
    },
  };
}

/* ---------- 端末（js/sync.js） ---------- */
function makeClient(server, { url = 'https://example.test/exec', house = '' } = {}) {
  const store = new Map();
  const timers = [];
  const client = {
    console,
    $: () => null,
    LS: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    toast: () => {},
    settings: { url, house },
    items: [], shop: [], chat: [],
    since: 0,
    pendingEnter: new Set(),
    normalize: it => Object.assign({}, it, { dirty: it.dirty ?? true }),
    prune: l => l,
    saveAll: () => {},
    renderAll: () => {},
    AbortController,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
    clearTimeout,
    setInterval: () => 0,          // 定期同期は検証では動かさない
    addEventListener: () => {},
    document: { addEventListener: () => {}, createElement: () => ({ getContext: () => ({ drawImage(){} }), toDataURL: () => '' }) },
    navigator: { onLine: true },
    Image: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    fetch: async (u, opt) => {
      const out = server.handle(opt.body);
      return { ok: true, json: async () => out };
    },
  };
  vm.createContext(client);
  vm.runInContext(fs.readFileSync('js/sync.js', 'utf8'), client);
  client.__stop = () => timers.forEach(clearTimeout);
  return client;
}

/* 端末側の needsAI と同じ作り方（js/app.js から写したもの） */
const newHouseCode = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c = ''; for (let i = 0; i < 14; i++) c += abc[Math.floor(Math.random() * abc.length)];
  return c;
};

console.log('\n▸ 入れたばかりの端末が、棚をパチリする');
{
  const server = makeServer();
  const cl = makeClient(server);
  // 「パチリ」を押した瞬間：家族コードが無いので作り、同期は後追いで始まる（await しない）
  cl.settings.house = newHouseCode();
  const bg = cl.sync();
  // 写真を撮って送る
  const res = await vm.runInContext('aiRecognize', cl)('data:image/jpeg;base64,AAA', 'fridge');
  await bg;
  ok('品目が返ってくる', res.ok === true && res.items.length === 1, JSON.stringify(res));
  ok('Gemini に1回だけ届いた', server.calls.gemini === 1, 'gemini=' + server.calls.gemini);
  cl.__stop();
}
{
  /* 同期が間に合わなかった場合。パチリが先に着いて断られる。
   * postAI が合わせ直して、もう一度だけ頼むはず */
  const server = makeServer();
  const cl = makeClient(server);
  cl.settings.house = newHouseCode();          // 同期はまだ1度も走っていない
  const res = await vm.runInContext('aiRecognize', cl)('data:image/jpeg;base64,AAA', 'fridge');
  ok('断られても、合わせ直して結果が返る', res.ok === true && res.items.length === 1, JSON.stringify(res));
  ok('間に同期が1回入っている', server.calls.sync === 1, 'sync=' + server.calls.sync);
  ok('Gemini に届いたのは1回だけ（断られたぶんは呼んでいない）', server.calls.gemini === 1, 'gemini=' + server.calls.gemini);
  cl.__stop();
}
{
  // 頼み直しても駄目なときは、諦めて理由を返す（無限に繰り返さない）
  const server = makeServer();
  const cl = makeClient(server, { url: '' });
  let msg = '';
  try { await vm.runInContext('aiRecognize', cl)('data:image/jpeg;base64,AAA', 'fridge'); }
  catch (err) { msg = String(err.message || err); }
  ok('つなぎ先が無ければ、その理由が返る', msg.includes('共有URL'), msg);
  cl.__stop();
}

console.log('\n▸ 家族2台が同じ中身になる');
{
  const server = makeServer();
  const HOUSE = newHouseCode();
  const a = makeClient(server, { house: HOUSE });
  const b = makeClient(server, { house: HOUSE });

  a.items.push({ id: 'x1', name: 'たまご', qty: 6, unit: '個', expiry: '2026-09-01',
                 addedAt: 1, updatedAt: 100, deleted: false, dirty: true, shelf: 'fridge' });
  ok('A が送れた', await a.sync() === true);
  ok('B が受け取れた', await b.sync() === true);
  ok('B に同じ品目がある', b.items.length === 1 && b.items[0].name === 'たまご', JSON.stringify(b.items));
  ok('期限が文字のまま届く', b.items[0].expiry === '2026-09-01', String(b.items[0].expiry));
  ok('受け取ったぶんは送り返さない', b.items[0].dirty === false);

  // B が数を減らして、A に返る
  b.items[0].qty = 4; b.items[0].updatedAt = 200; b.items[0].dirty = true;
  await b.sync();
  await a.sync();
  ok('A に変更が返る', a.items[0].qty === 4, JSON.stringify(a.items[0]));

  // A が消して、B からも消える
  a.items[0].deleted = true; a.items[0].updatedAt = 300; a.items[0].dirty = true;
  await a.sync();
  await b.sync();
  ok('消したことも伝わる', b.items[0].deleted === true);

  // 古い変更は後勝ちで弾かれる
  b.items[0].qty = 99; b.items[0].updatedAt = 50; b.items[0].dirty = true;
  await b.sync();
  const fresh = makeClient(server, { house: HOUSE });
  await fresh.sync();
  ok('古い変更は採られない', fresh.items[0].qty !== 99, JSON.stringify(fresh.items[0]));
  [a, b, fresh].forEach(c => c.__stop());
}
{
  // 招待リンクで入ってきた3台目が、いきなり全部受け取れる
  const server = makeServer();
  const HOUSE = newHouseCode();
  const a = makeClient(server, { house: HOUSE });
  a.items.push({ id: 'y1', name: 'ぎゅうにゅう', qty: 1, unit: '本', expiry: '',
                 addedAt: 1, updatedAt: 100, deleted: false, dirty: true, shelf: 'fridge' });
  a.shop.push({ id: 's1', name: 'パン', qty: 1, unit: '個', expiry: '',
                addedAt: 1, updatedAt: 100, deleted: false, dirty: true, done: false });
  await a.sync();
  const c = makeClient(server, { house: HOUSE });
  await c.sync();
  ok('棚も買うものも届く', c.items.length === 1 && c.shop.length === 1,
     JSON.stringify({ items: c.items.length, shop: c.shop.length }));
  ok('その端末も写真の読み取りが使える',
     (await vm.runInContext('aiRecognize', c)('data:image/jpeg;base64,AAA', 'fridge')).ok === true);
  [a, c].forEach(x => x.__stop());
}

console.log(`\n  ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
