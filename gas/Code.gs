/**
 * アルノポケット — 家族共有バックエンド
 *
 * スプレッドシートに紐づいた（拡張機能 > Apps Script で作った）スクリプトとして動かす。
 *
 * できること（doPost の action）：
 *   sync               ... 棚・買い物・ことづての差分同期
 *   recognize          ... 棚の写真 → 品目の一覧
 *   recognize-receipt  ... レシートの写真 → 買ったものの一覧
 *   suggest-recipes    ... 手元の食材 → 献立3つ
 *
 * 差分同期の考え方：
 *   - 1レコード = 1行。行は消さず「消した印」(deleted) を立てる（削除も相手に伝えるため）
 *   - updatedAt はクライアントが打った時刻。ぶつかったら新しいほうを採る（後勝ち）
 *   - srv はサーバーが打った時刻。「前回の続きから」を取るための目印。
 *     端末の時計がずれていても取りこぼさないよう、目印は必ずサーバー時刻を使う
 *   - ext は棚・数え方・目標数・履歴をまとめた JSON。列を増やさずに機能を足せるようにしてある
 *
 * 家族コードについて：
 *   コードを知っている人だけが中身を見られる、という作り。だから推測されにくい長さが要る。
 *   AI を使う action は、シートに実績のある家だけ・1日 60 回までに制限している
 *   （URL を知っただけの相手に Gemini の枠を使わせないため）。
 *
 * 使う前に（スクリプト プロパティ）：
 *   GEMINI_API_KEY ... 写真の読み取りと献立に使う。https://aistudio.google.com/apikey で取る
 *   GEMINI_MODEL   ... 省略可。既定は gemini-3.6-flash
 */

var SHEET_NAME = 'data';
var HEADERS = ['house', 'kind', 'id', 'name', 'qty', 'unit', 'expiry',
               'addedAt', 'updatedAt', 'srv', 'deleted', 'by', 'done', 'ext'];
var KINDS = { item: 1, shop: 1, chat: 1, fridge: 1 };   // fridge は旧版のデータ用

var MIN_HOUSE = 4;          // 既存の家はここまで許す（運用中の端末を止めないため）
var MIN_NEW_HOUSE = 12;     // これから作る家に求める長さ
var AI_ACTIONS = { 'recognize': 1, 'recognize-receipt': 1, 'suggest-recipes': 1 };
var AI_DAILY_LIMIT = 60;    // 1つの家が1日に AI を使える回数
var QUOTA_KEY = 'aiQuota';

/** 動作確認用。ブラウザで /exec を開くとこれが返る */
function doGet(e) {
  return json({ ok: true, message: 'アルノポケット 共有API 稼働中' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: '中身が空のリクエストです' });
    }
    var req = JSON.parse(e.postData.contents);
    var house = String(req.house || '').trim();
    if (house.length < MIN_HOUSE) {
      return json({ ok: false, error: '家族コードが短すぎます（' + MIN_HOUSE + '文字以上）' });
    }

    /* AI を使う action は、この URL さえ知っていれば誰でも叩けてしまい、
     * Gemini の無料枠を空にされる。以前は家族コードの「長さ」しか見ておらず、
     * でたらめな文字列でも通っていた。
     *   ① すでに同期したことのある家だけ通す（＝共有の設定を済ませた家だけ）
     *   ② そのうえで 1日の回数に上限をつける（正しいコードが漏れても被害を止める） */
    if (AI_ACTIONS[req.action]) {
      if (!knownHouse(house)) {
        return json({ ok: false, error: 'この家族コードでは使えません。先に「設定 > 共有」で同期を済ませてください' });
      }
      if (!takeAiQuota(house)) {
        return json({ ok: false, error: '今日はもうたくさん使いました。また明日おねがいします' });
      }
    }

    if (req.action === 'recognize')         return json(recognizeShelf(req));
    if (req.action === 'recognize-receipt') return json(recognizeReceipt(req));
    if (req.action === 'suggest-recipes')   return json(suggestRecipes(req));
    if (req.action !== 'sync')              return json({ ok: false, error: '不明な action です' });

    /* 新しい家をつくるときだけ、長めのコードを求める。
     * すでにある家は今までどおり通す（短いコードで運用中の端末を締め出さないため）。 */
    if (house.length < MIN_NEW_HOUSE && !knownHouse(house)) {
      return json({ ok: false, error: '新しい家族コードは' + MIN_NEW_HOUSE + '文字以上にしてください（推測されにくくするため）' });
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return json({ ok: false, error: '混み合っています。少しあとでもう一度' });
    try {
      return json(syncImpl(house, Number(req.since) || 0, req.changes || []));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ==================== 同期 ==================== */

function syncImpl(house, since, changes) {
  var sh = getSheet();
  var last = sh.getLastRow();
  var values = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEADERS.length).getValues();

  // house + kind + id  ->  values の添字
  var index = {};
  for (var i = 0; i < values.length; i++) {
    index[key(values[i][0], values[i][1], values[i][2])] = i;
  }

  var now = Date.now();
  var appends = [];
  // 送られてきたレコードは、採用しなかったものも含めて必ず返す。
  // そうしないと「古いから弾いた」ことが送り主に伝わらず、ずれたまま残る
  var touched = {};

  for (var c = 0; c < changes.length; c++) {
    var ch = changes[c];
    if (!ch || !ch.id || !KINDS[ch.kind]) continue;

    var row = [
      house,
      String(ch.kind),
      String(ch.id),
      String(ch.name || ''),
      Number(ch.qty) || 0,
      String(ch.unit || ''),
      String(ch.expiry || ''),
      Number(ch.addedAt) || now,
      Number(ch.updatedAt) || now,
      now,
      ch.deleted ? 1 : 0,
      String(ch.by || ''),
      ch.done ? 1 : 0,
      String(ch.ext || '')
    ];

    var k = key(house, ch.kind, ch.id);
    touched[k] = true;
    if (k in index) {
      var at = index[k];
      // 後勝ち。サーバー側のほうが新しければ受け取らない
      if ((Number(values[at][8]) || 0) <= row[8]) {
        values[at] = row;
        sh.getRange(at + 2, 1, 1, HEADERS.length).setValues([row]);
      }
    } else {
      index[k] = values.length;
      values.push(row);
      appends.push(row);
    }
  }

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADERS.length).setValues(appends);
  }

  // 前回の続き（srv > since）だけ返す
  var rows = [];
  for (var j = 0; j < values.length; j++) {
    var v = values[j];
    if (String(v[0]) !== house) continue;
    if ((Number(v[9]) || 0) <= since && !touched[key(v[0], v[1], v[2])]) continue;
    rows.push({
      kind: String(v[1]) === 'fridge' ? 'item' : String(v[1]),   // 旧データは棚の品目として渡す
      id: String(v[2]),
      name: String(v[3]),
      qty: Number(v[4]) || 0,
      unit: String(v[5]),
      expiry: String(v[6] || ''),
      addedAt: Number(v[7]) || 0,
      updatedAt: Number(v[8]) || 0,
      deleted: !!Number(v[10]),
      by: String(v[11] || ''),
      done: !!Number(v[12]),
      ext: String(v[13] || '')
    });
  }

  return { ok: true, now: now, rows: rows };
}

/* ==================== Gemini への取り次ぎ ==================== */

var SHELF_HINT = 'fridge=冷蔵庫 / freezer=冷凍庫 / pantry=食品棚 / daily=日用品 / tool=調理道具 / medicine=くすり箱';

function recognizeShelf(req) {
  var prompt = [
    'あなたは家庭の在庫管理アプリの目です。写真に写っている「棚に入っているもの」を1つずつ挙げてください。',
    '',
    '守ること：',
    '- 日本の家庭で普通に使う呼び名にする（例：「Milk 1L」ではなく「牛乳」）',
    '- 同じものが複数写っていたら1行にまとめ、qty に個数を入れる',
    '- 単位は 個 / g / ml / パック / 本 / 袋 / 切 / 箱 のどれかにする',
    '- 見えるラベルに賞味期限が読み取れたときだけ expiry を YYYY-MM-DD で入れる。読めなければ空文字',
    '- 棚の家具・容器・背景（棚板、かご、ラップの箱の外側など）は挙げない',
    '- はっきり見えないものほど confidence を下げる（0〜1）',
    '- 迷ったら挙げない。存在しないものを作らない',
    '',
    'shelf には次のどれかを入れる（迷ったら "' + String(req.shelf || 'fridge') + '"）：',
    SHELF_HINT,
    '',
    'JSON だけを返す。説明文もコードフェンスも付けない：',
    '{"items":[{"name":"牛乳","qty":1,"unit":"本","shelf":"fridge","expiry":"","confidence":0.9}]}'
  ].join('\n');

  var out = gemini(prompt, req.image);
  return { ok: true, items: (out && out.items) || [] };
}

function recognizeReceipt(req) {
  var prompt = [
    'あなたは家庭の在庫管理アプリの目です。レシートの写真から「買った品物」を読み取ってください。',
    '',
    '守ること：',
    '- レシートの略称を、家庭で使う呼び名に直す（例：「ﾎｯｶｲﾄﾞｳｷﾞｭｳﾆｭｳ」→「牛乳」）',
    '- 小計・合計・税・釣銭・ポイント・店名・電話番号は品物ではないので挙げない',
    '- 割引行やレジ袋も挙げない',
    '- 個数がレシートにあれば qty に入れる。無ければ 1',
    '- 読めない行は挙げない。confidence を正直に下げる',
    '',
    'shelf には置き場所として妥当なものを入れる：',
    SHELF_HINT,
    '',
    'JSON だけを返す。説明文もコードフェンスも付けない：',
    '{"store":"","date":"","items":[{"name":"牛乳","qty":1,"unit":"本","shelf":"fridge","confidence":0.9}]}'
  ].join('\n');

  var out = gemini(prompt, req.image);
  return { ok: true, store: (out && out.store) || '', date: (out && out.date) || '', items: (out && out.items) || [] };
}

function suggestRecipes(req) {
  var have = (req.have || []).map(function (h) {
    return '- ' + h.name + ' ' + (h.qty || '') + (h.unit || '')
      + (h.daysLeft === null || h.daysLeft === undefined ? '' : '（あと' + h.daysLeft + '日）');
  }).join('\n');

  var avoid = (req.avoid || []).length ? '\n次の献立は今回は出さない：' + req.avoid.join('、') : '';

  var prompt = [
    'あなたは家庭の献立係です。いま家にある食材をもとに、今日の献立を4つ提案してください。',
    '',
    'いま家にあるもの：',
    have,
    avoid,
    '',
    '4つの内訳（ここが最も大事）：',
    '- **2つは kind:"asis"** ... いま家にあるものだけで作れる献立。buy は必ず空配列にする',
    '- **2つは kind:"plus"** ... 1〜3品 買い足せば作れる、ひと味よくなる献立。buy にその品を入れる',
    '- asis が2つ思いつかないほど食材が少ないときは、asis を1つに減らして plus を3つにしてよい',
    '',
    'kind:"plus" のとき：',
    '- buy に入れるのは、スーパーで普通に買えて、その献立に本当に効くものだけ',
    '- note に「なぜそれを足すのか」を1行で書く（例：豚肉を足すと主菜になり、キャベツも一緒に使い切れる）',
    '- 珍しい食材・高い食材・使い切れない量のものは入れない',
    '',
    'kind:"asis" のとき：',
    '- note には「買い足しなしで作れる」ことが伝わる一言を書く（例：冷蔵庫のもので今すぐできる）',
    '',
    '**家に主な食材が少ないときこそ、ここが大事**：',
    '- 調味料や飲みものしか無い場合でも、**絶対に0件で返さない**。asis を0にして plus を4つにしてよい',
    '- その場合は「いまある調味料を活かす」方向で考える',
    '  （例：キムチの素があるなら豚肉を買い足してキムチ炒め、牛乳があるなら鶏肉を買い足してミルク煮）',
    '- 買い足すのは、その調味料が主役として活きる、ありふれた食材にする',
    '',
    '共通で守ること：',
    '- 期限が近いものを優先して使い切る献立にする',
    '- have には、その献立で実際に使う「いま家にあるもの」だけを入れる。無いものを入れない',
    '- 4つはそれぞれ別の系統にする（例：主菜・副菜・汁物・作り置き）',
    '- 塩・しょうゆ・みそ・砂糖・酢・油のような基本の調味料は、どの家にもある前提。buy に入れない',
    '- ただし**ケチャップ・キムチの素・カレールウ・マヨネーズのような「味の方向を決める調味料」は、',
    '  家にあるなら献立に活かしてよい**（have に入れてよい）。味の起点として使う',
    '- steps は3〜6行。1行1動作で、分量は目安でよい',
    '- level は「かんたん」「ふつう」「ちょっと手間」のどれか、time は「15分」など、serves は「2人ぶん」など',
    '',
    'JSON だけを返す。説明文もコードフェンスも付けない：',
    '{"recipes":[{"kind":"asis","title":"","level":"","time":"","serves":"","have":[""],"buy":[],"note":"","steps":[""]}]}'
  ].join('\n');

  var out = gemini(prompt, null);
  return { ok: true, recipes: (out && out.recipes) || [] };
}

/** プロンプト（と、あれば画像）を Gemini に渡し、返ってきた JSON を object にして返す */
function gemini(prompt, dataUrl) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY が未設定です（Apps Script の「プロジェクトの設定 > スクリプト プロパティ」に入れてください）');
  }
  var model = props.getProperty('GEMINI_MODEL') || 'gemini-3.6-flash';

  var parts = [{ text: prompt }];
  if (dataUrl) {
    var m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('写真の形式が読めませんでした');
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey),
    {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
      })
    }
  );

  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    var msg = body;
    try { msg = JSON.parse(body).error.message; } catch (ignore) {}
    throw new Error('AI が答えられませんでした（' + code + '）：' + msg);
  }

  var data = JSON.parse(body);
  var cand = data.candidates && data.candidates[0];
  var text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(function (p) { return p.text || ''; }).join('')
    : '';
  if (!text) throw new Error('AI からの返事が空でした');

  // responseMimeType を指定しても、稀にコードフェンスが付いて返ることがある
  text = text.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('AI の返事を読めませんでした');
  }
}

/* ==================== 小道具 ==================== */

function key(house, kind, id) {
  return String(house) + '\t' + String(kind) + '\t' + String(id);
}

/* ==================== 家族コードの検査と回数の上限 ==================== */

/** すでにシートに行がある家かどうか。毎回シートを読むと遅いので5分だけ覚えておく */
function knownHouse(house) {
  var cache = CacheService.getScriptCache();
  var ck = 'known:' + house;
  var hit = cache.get(ck);
  if (hit === '1') return true;
  if (hit === '0') return false;

  var sh = getSheet();
  var last = sh.getLastRow();
  var found = false;
  if (last >= 2) {
    var col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (String(col[i][0]) === house) { found = true; break; }
    }
  }
  /* 「ある」は5分、「ない」は30秒しか覚えない。
   * 家族コードを変えた直後は、同期が済むまで一瞬「ない」になる。
   * そこを5分も覚えていると、写真の読み取りとレシピが理由もわからず使えなくなる。 */
  cache.put(ck, found ? '1' : '0', found ? 300 : 30);
  return found;
}

/**
 * AI を1回ぶん使う。使えたら true。
 * 1つのプロパティに {day, counts} をまとめて持ち、日付が変わったら丸ごと捨てる。
 * 家ごとにキーを増やすと、古いキーが残り続けるので避けている。
 */
function takeAiQuota(house) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  var state;
  try { state = JSON.parse(props.getProperty(QUOTA_KEY) || '{}'); } catch (err) { state = {}; }
  if (state.day !== today) state = { day: today, counts: {} };

  var n = (state.counts[house] || 0) + 1;
  if (n > AI_DAILY_LIMIT) return false;
  state.counts[house] = n;
  props.setProperty(QUOTA_KEY, JSON.stringify(state));
  return true;
}

function getSheet() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) {
    throw new Error('スプレッドシートに紐づいていません。'
      + 'スプレッドシートの「拡張機能 > Apps Script」から作り直してください');
  }
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    // 日付や長い数値を勝手に変換されないよう、全部「書式なしテキスト」にしておく
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
    return sh;
  }
  // 旧版（ext 列が無い13列）のシートを、中身を消さずに広げる
  if (sh.getLastColumn() < HEADERS.length) {
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/** 初回に1回だけエディタから実行して、シートを用意する（任意） */
function setup() {
  getSheet();
  Logger.log('準備できました: ' + SpreadsheetApp.getActive().getUrl());
}

/** 鍵がちゃんと入っているかの確認用。エディタから実行してログを見る */
function testGemini() {
  Logger.log(JSON.stringify(gemini('{"ok":true} という JSON だけを返してください。', null)));
}
