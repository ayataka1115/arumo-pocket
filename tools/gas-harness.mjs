/* GASに貼る前の検証台。Code.gs を vm で読み込み、GAS の API をスタブする。
 * 実物をデプロイせずに doPost の入口の判定（家族コード・回数上限）を確かめる。 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = process.argv[2];
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, extra)); };

/* シート1枚ぶんの偽物。data と houses を別々に持てるようにしてある */
function makeSheet(rows = [], cols = 14) {
  const sheetRows = rows.map(r => [...r]);
  return {
    __rows: sheetRows,
    getLastRow: () => sheetRows.length + 1,
    getLastColumn: () => cols,
    getRange: (r, c, nr, nc) => ({
      getValues: () => sheetRows.slice(r - 2, r - 2 + nr).map(row => (row || []).slice(c - 1, c - 1 + nc)),
      setValues: (v) => v.forEach((row, i) => {
        const at = r - 2 + i;
        const cur = sheetRows[at] ? [...sheetRows[at]] : [];
        row.forEach((cell, j) => { cur[c - 1 + j] = cell; });
        sheetRows[at] = cur;
      }),
      setNumberFormat: () => {},
    }),
    setFrozenRows: () => {},
    getMaxRows: () => 1000,
  };
}

function makeCtx({ rows = [], houses = null, geminiOut = { recipes: [{ title: 'てすと' }] }, today = '20260823',
                   geminiCodes = null } = {}) {
  const props = new Map();
  const cache = new Map();
  const calls = { gemini: 0, models: [] };

  const sheets = { data: makeSheet(rows, 14), houses: makeSheet(houses || [], 3) };
  const sheetRows = sheets.data.__rows;

  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ({
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = sheets[n] || makeSheet([], n === 'houses' ? 3 : 14)),
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => (cache.has(k) ? cache.get(k) : null),
      put: (k, v, ttl) => cache.set(k, v) && cache.set('__ttl:' + k, ttl),
    })},
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : (k === 'GEMINI_API_KEY' ? 'dummy' : null)),
      setProperty: (k, v) => props.set(k, v),
    })},
    Utilities: { formatDate: () => today },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: (url) => {
      calls.gemini++;
      const model = String(url).match(/models\/([^:]+):/)[1];
      calls.models.push(model);
      // geminiCodes: モデル名 -> HTTP コード。無ければ全部 200
      const code = geminiCodes ? (geminiCodes[model] ?? 200) : 200;
      return {
        getResponseCode: () => code,
        getContentText: () => (code === 200
          ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiOut) }] } }] })
          : JSON.stringify({ error: { message: 'models/' + model + ' is not found' } })),
      };
    } },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => ({ __text: t }) }), MimeType: { JSON: 'json' } },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);
  ctx.__calls = calls;
  ctx.__props = props;
  ctx.__sheets = sheets;
  ctx.__cache = cache;
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

console.log('\n▸ 1週間の献立（plan-week）');
{
  const week = { days: Array.from({length:7},(_,i)=>({day:i+1,title:'献立'+(i+1),kind:i<2?'asis':'plus',have:['たまご'],buy:i<2?[]:['豚こま切れ肉 200g']})),
                 buyAll:[{name:'豚こま切れ肉 400g',for:'3日目・5日目'}] };
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiOut: week });
  const r = post(ctx, { action: 'plan-week', house: EXISTING, have: [{name:'たまご',qty:6,unit:'個',daysLeft:5}] });
  ok('7日ぶん返る', r.ok === true && r.days.length === 7, JSON.stringify(r).slice(0,120));
  ok('まとめ買いの一覧も返る', Array.isArray(r.buyAll) && r.buyAll.length === 1);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  const r = post(ctx, { action: 'plan-week', house: 'zzzz-unknown-house', have: [] });
  ok('でたらめなコードでは作らせない', r.ok === false && r.error.includes('この家族コードでは使えません'));
  ok('Gemini を呼んでいない', ctx.__calls.gemini === 0);
}
{
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });
  let last;
  for (let i = 0; i < 61; i++) last = post(ctx, { action: 'plan-week', house: EXISTING, have: [] });
  ok('1日の上限にも数えられる', last.ok === false && last.error.includes('今日はもうたくさん'));
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

console.log('\n▸ 入れたばかりの端末（棚が空）でも写真の読み取りが使えること');
{
  /* 今回の不具合そのもの。
   * 「新しく作る」→ 同期（送るものは無い）→ そのままパチリ、が通らなければならない。 */
  const ctx = makeCtx();
  const FRESH = 'abcdefghjkmn12';   // s-house-make が作る14文字
  const sy = post(ctx, { action: 'sync', house: FRESH, since: 0, changes: [] });
  ok('棚が空でも同期そのものは通る', sy.ok === true);
  ok('台帳に載る（data には1行も書かれていない）',
     ctx.__sheets.houses.__rows.length === 1 && ctx.__sheets.data.__rows.length === 0);
  const r = post(ctx, { action: 'recognize', house: FRESH, image: 'data:image/jpeg;base64,AAA' });
  ok('そのままパチリできる', r.ok === true, JSON.stringify(r));
  ok('Gemini に届いている', ctx.__calls.gemini === 1);
}
{
  // 招待リンクで入ってきた端末も、同じく一度同期すれば使える
  const ctx = makeCtx();
  const H = 'invited-family-code';
  post(ctx, { action: 'sync', house: H, since: 0, changes: [] });
  ok('招待された端末も献立を作れる', post(ctx, { action: 'suggest-recipes', house: H, have: [] }).ok === true);
}
{
  // 同期しに来ていない家は、今までどおり断る
  const ctx = makeCtx();
  const r = post(ctx, { action: 'recognize', house: 'never-synced-code', image: 'data:image/jpeg;base64,AAA' });
  ok('一度も同期していない家は断る', r.ok === false && r.error.includes('この家族コードでは使えません'));
  ok('Gemini を呼んでいない', ctx.__calls.gemini === 0);
}
{
  // 台帳ができる前からある家（data に行だけある）を締め出さない
  const ctx = makeCtx({ rows: rowsFor(EXISTING) });   // houses は空
  ok('台帳より前からある家も使える', post(ctx, { action: 'recognize', house: EXISTING, image: 'data:image/jpeg;base64,AAA' }).ok === true);
  ok('見つけた家は台帳に書き写される', ctx.__sheets.houses.__rows.length === 1);
}
{
  // 同期を繰り返しても台帳が太らない
  const ctx = makeCtx();
  const H = 'repeat-sync-house';
  for (let i = 0; i < 30; i++) post(ctx, { action: 'sync', house: H, since: 0, changes: [] });
  ok('台帳の行は1つだけ', ctx.__sheets.houses.__rows.length === 1, 'rows=' + ctx.__sheets.houses.__rows.length);
}

console.log('\n▸ 全体の1日の上限');
{
  const ctx = makeCtx();
  let last, houses = 0;
  for (let h = 0; h < 20; h++) {
    const H = 'throwaway-house-' + String(h).padStart(3, '0');
    post(ctx, { action: 'sync', house: H, since: 0, changes: [] });
    for (let i = 0; i < 60; i++) last = post(ctx, { action: 'suggest-recipes', house: H, have: [] });
    if (last.ok) houses++;
  }
  ok('家を作り足しても全体600回で止まる', ctx.__calls.gemini === 600, 'calls=' + ctx.__calls.gemini);
  ok('止まったあとは断り文句が返る', last.ok === false && last.error.includes('今日はもうたくさん'));
}

console.log('\n▸ モデルが落ちたら、次の頭のいいモデルへ下りる');
{
  // 名前がもう無い（404）とき
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-3.7-flash': 404 } });
  const r = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('次の候補で答えが返る', r.ok === true, JSON.stringify(r).slice(0, 120));
  ok('頭のいい順に下りている', ctx.__calls.models.join(',') === 'gemini-3.7-flash,gemini-3.6-flash',
     ctx.__calls.models.join(','));
  ok('落ちたモデルは長めに休ませる', ctx.__cache.get('__ttl:rest:gemini-3.7-flash') === 21600);
  ctx.__calls.models.length = 0;
  post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('次からは休ませているぶんを飛ばして1回で当たる',
     ctx.__calls.models.join(',') === 'gemini-3.6-flash', ctx.__calls.models.join(','));
  ok('指定は書き換えない（上が戻ったらまた上を使う）', ctx.__props.get('GEMINI_MODEL') === undefined);
}
{
  // 回数の上限に当たった（429）とき
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-3.7-flash': 429 } });
  const r = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('429 でも次の頭のいいモデルが答える', r.ok === true, JSON.stringify(r).slice(0, 120));
  ok('休ませるのは短く（戻ってくるので）', ctx.__cache.get('__ttl:rest:gemini-3.7-flash') === 300);
}
{
  // 混み合っている（503）とき
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-3.7-flash': 503 } });
  ok('503 でも次のモデルが答える', post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] }).ok === true);
}
{
  // 上から2つとも駄目でも、3つ目まで下りる
  const ctx = makeCtx({ rows: rowsFor(EXISTING),
                        geminiCodes: { 'gemini-3.7-flash': 429, 'gemini-3.6-flash': 404 } });
  const r = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('3つ目で答えが返る', r.ok === true, JSON.stringify(r).slice(0, 120));
  ok('3つ順に試した', ctx.__calls.models.join(',') === 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash',
     ctx.__calls.models.join(','));
}
{
  // どれも混んでいるときは、その理由が伝わる文面で返す
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: {
    'gemini-3.7-flash': 429, 'gemini-3.6-flash': 429, 'gemini-3.5-flash': 429,
    'gemini-3.5-flash-lite': 429 } });
  const r = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('混み合っていると伝える', r.ok === false && r.error.includes('混み合っています'), JSON.stringify(r));
  ok('1回の頼みで試すのは3つまで', ctx.__calls.gemini === 3, 'calls=' + ctx.__calls.gemini);
  // もう一度頼まれたら、休ませている3つは飛ばして、まだ試していない残りへ下りる
  ctx.__calls.models.length = 0;
  const r2 = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('次は残りの候補へ下りる',
     ctx.__calls.models.join(',') === 'gemini-3.5-flash-lite', ctx.__calls.models.join(','));
  ok('そのときも混み合っていると伝える', r2.ok === false && r2.error.includes('混み合っています'), JSON.stringify(r2));
  // 全部休ませ切ったら、もう叩きに行かない（無駄な往復をしない）
  ctx.__calls.gemini = 0;
  const r3 = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('全部休ませたら叩きに行かない', ctx.__calls.gemini === 0, 'calls=' + ctx.__calls.gemini);
  ok('待つように伝える', r3.ok === false && r3.error.includes('混み合っています'), JSON.stringify(r3));
}
{
  // どれも混んでいて Gemini に届かなかったぶんは、1日の回数に数えない
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: {
    'gemini-3.7-flash': 429, 'gemini-3.6-flash': 429, 'gemini-3.5-flash': 429,
    'gemini-3.5-flash-lite': 429 } });
  for (let i = 0; i < 5; i++) post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  const state = JSON.parse(ctx.__props.get('aiQuota'));
  ok('混んでいて答えが無かったぶんは減らさない',
     (state.counts[EXISTING] || 0) === 0 && (state.counts['*'] || 0) === 0, JSON.stringify(state));
}
{
  // 答えが返ったぶんは、今までどおり数える
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-3.7-flash': 429 } });
  for (let i = 0; i < 3; i++) post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  const state = JSON.parse(ctx.__props.get('aiQuota'));
  ok('答えが返ったぶんは数える', state.counts[EXISTING] === 3, JSON.stringify(state));
}
{
  // 鍵が違う（403）なら、どのモデルでも同じなので下りない
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-3.7-flash': 403 } });
  const r = post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('403 はそのまま返す', r.ok === false && r.error.includes('403'), JSON.stringify(r));
  ok('1回しか呼んでいない', ctx.__calls.gemini === 1, 'calls=' + ctx.__calls.gemini);
}
{
  // 運用側が GEMINI_MODEL を指定していれば、それを最優先で試す
  const ctx = makeCtx({ rows: rowsFor(EXISTING), geminiCodes: { 'gemini-2.5-flash': 404 } });
  ctx.__props.set('GEMINI_MODEL', 'gemini-2.5-flash');
  post(ctx, { action: 'suggest-recipes', house: EXISTING, have: [] });
  ok('指定が先頭、落ちたら頭のいい順に下りる',
     ctx.__calls.models.join(',') === 'gemini-2.5-flash,gemini-3.7-flash', ctx.__calls.models.join(','));
}

console.log(`\n  ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
