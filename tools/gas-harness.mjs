/* GASに貼る前の検証台。Code.gs を vm で読み込み、GAS の API をスタブする。
 * 実物をデプロイせずに doPost の入口の判定（家族コード・回数上限）を確かめる。 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = process.argv[2];
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, extra)); };

function makeCtx({ rows = [], geminiOut = { recipes: [{ title: 'てすと' }] }, today = '20260823' } = {}) {
  const sheetRows = rows.map(r => [...r]);
  const props = new Map();
  const cache = new Map();
  const calls = { gemini: 0 };

  const range = (r, c, nr, nc) => ({
    getValues: () => sheetRows.slice(r - 2, r - 2 + nr).map(row => row.slice(c - 1, c - 1 + nc)),
    setValues: (v) => { v.forEach((row, i) => { sheetRows[r - 2 + i] = [...row]; }); },
    setNumberFormat: () => {},
  });
  const sheet = {
    getLastRow: () => sheetRows.length + 1,
    getLastColumn: () => 14,          // 現行の14列（ext 込み）
    getRange: range,
    setFrozenRows: () => {},
    getMaxRows: () => 1000,
  };

  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    CacheService: { getScriptCache: () => ({
      get: k => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => cache.set(k, v),
    })},
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : (k === 'GEMINI_API_KEY' ? 'dummy' : null)),
      setProperty: (k, v) => props.set(k, v),
    })},
    Utilities: { formatDate: () => today },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => { calls.gemini++; return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiOut) }] } }] }),
    }; } },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => ({ __text: t }) }), MimeType: { JSON: 'json' } },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  ctx.__calls = calls;
  ctx.__props = props;
  return ctx;
}

const post = (ctx, body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).__text);

// 既存の家（シートに行がある）
const EXISTING = 'ourhouse-2026';
const rowsFor = h => [[h, 'item', 'i1', 'たまご', '6', '個', '', '1', '1', '1', '0', '', '0', '']];

console.log('\n▸ 家族コードの検査');
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  ok('短すぎるコードは弾く', post(ctx, { action: 'sync', house: 'abc' }).error?.includes('短すぎ'));
  ok('既存の家は今までどおり同期できる', post(ctx, { action: 'sync', house: EXISTING, since: 0, changes: [] }).ok === true);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  const r = post(ctx, { action: 'sync', house: 'newshort', since: 0, changes: [] });
  ok('新しい家で短いコードは断る', r.ok === false && r.error.includes('12文字以上'), JSON.stringify(r));
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  ok('新しい家でも12文字以上なら作れる',
     post(ctx, { action: 'sync', house: 'brand-new-family-code', since: 0, changes: [] }).ok === true);
}

console.log('\n▸ AI を叩けるのは実績のある家だけ（今回の穴）');
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  const r = post(ctx, { action: 'suggest-recipes', house: 'arumo-test-probe', have: [] });
  ok('でたらめなコードでは献立を作らせない', r.ok === false && r.error.includes('この家族コードでは使えません'), JSON.stringify(r));
  ok('Gemini を1回も呼んでいない', ctx.__calls.gemini === 0, 'calls=' + ctx.__calls.gemini);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  ok('正しい家なら献立を作る', post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] }).ok === true);
  ok('Gemini を1回呼んだ', ctx.__calls.gemini === 1, 'calls=' + ctx.__calls.gemini);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  const r = post(ctx, { action: 'recognize', house: 'zzzz-unknown-house', image: 'data:image/png;base64,AAA' });
  ok('写真の読み取りも同じく止まる', r.ok === false && r.error.includes('この家族コードでは使えません'));
  ok('Gemini を呼んでいない', ctx.__calls.gemini === 0);
}

console.log('\n▸ 1日の回数の上限');
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  let last;
  for (let i = 0; i < 61; i++) last = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('61回目は断る', last.ok === false && last.error.includes('今日はもうたくさん'), JSON.stringify(last));
  ok('Gemini の呼び出しは60回で止まっている', ctx.__calls.gemini === 60, 'calls=' + ctx.__calls.gemini);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  for (let i = 0; i < 60; i++) post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  const state = JSON.parse(ctx.__props.get('aiQuota'));
  ok('数えているのは家ごと', state.counts[EXISTING] === 60, JSON.stringify(state));
  ok('日付を持っている（日が変われば戻る）', state.day === '20260823');
}
{
  // 同期は上限の対象外（家事アプリが使えなくなると困る）
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  let allOk = true;
  for (let i = 0; i < 200; i++) if (!post(ctx, { action: 'sync', house: EXISTING, since: 0, changes: [] }).ok) allOk = false;
  ok('同期は何回でも通る', allOk);
}

console.log(`\n  ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
