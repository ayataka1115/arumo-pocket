/**
 * アルノポケット — 家族共有バックエンド
 *
 * スプレッドシートに紐づいた（拡張機能 > Apps Script で作った）スクリプトとして動かす。
 *
 * できること（doPost の action）：
 *   sync               ... 棚・買い物・ことづての差分同期
 *   recognize          ... 棚の写真 → 品目の一覧
 *   recognize-receipt  ... レシートの写真 → 買ったものの一覧
 *   suggest-recipes    ... 手元の食材 → 今日の献立4つ
 *   plan-week          ... 手元の食材 → 7日分の夕飯と、まとめ買いの一覧
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
 *   AI を使う action は、一度でも同期しに来た家（houses 台帳に載っている家）だけ・
 *   1家1日 60 回・全体で1日 600 回までに制限している
 *   （URL を知っただけの相手に Gemini の枠を使わせないため）。
 *
 * 使う前に（スクリプト プロパティ）：
 *   GEMINI_API_KEY ... 写真の読み取りと献立に使う。https://aistudio.google.com/apikey で取る
 *   GEMINI_MODEL   ... 省略可。ここに書いたものを最優先で試す。
 *                      落ちたときは候補を頭のいい順に下りていく。
 *                      コード側がここを書き換えることはない
 *   GEMINI_MODELS  ... 省略可。候補そのものをカンマ区切りで指定する。
 *                      無料枠の中身が変わったとき、コードを触らずに直せる
 */

var SHEET_NAME = 'data';
var HEADERS = ['house', 'kind', 'id', 'name', 'qty', 'unit', 'expiry',
               'addedAt', 'updatedAt', 'srv', 'deleted', 'by', 'done', 'ext'];
var KINDS = { item: 1, shop: 1, chat: 1, fridge: 1 };   // fridge は旧版のデータ用

/* 「この家は実在する」を覚えておく台帳。data シートとは分けてある。
 * 品目が1つも無い家（入れたばかりの端末）も、ここに載れば実在すると分かる。 */
var HOUSE_SHEET = 'houses';
var HOUSE_HEADERS = ['house', 'firstSeen', 'lastSeen'];

var MIN_HOUSE = 4;          // 既存の家はここまで許す（運用中の端末を止めないため）
var MIN_NEW_HOUSE = 12;     // これから作る家に求める長さ
var AI_ACTIONS = { 'recognize': 1, 'recognize-receipt': 1, 'suggest-recipes': 1, 'plan-week': 1 };
var AI_DAILY_LIMIT = 60;    // 1つの家が1日に AI を使える回数
var AI_GLOBAL_DAILY_LIMIT = 600;   // すべての家を合わせた1日の上限（枠を空にされないための止め）
var QUOTA_KEY = 'aiQuota';

/* Gemini のモデル候補を、頭のいい順に並べたもの。上から順に試す。
 *
 * 落ちる理由は2つあって、扱いが違う：
 *   - そのモデル名がもう無い（404/400）… 名前は Google 側で入れ替わる。長めに休ませる
 *   - いま混んでいる・枠を使い切った（429/503）… しばらくすれば戻る。短く休ませる
 * どちらも「休ませる」だけで、格下げを覚え込ませはしない。
 * 上のモデルが戻ってきたら、また上から使う。 */
var GEMINI_MODELS = [
  /* 上ほど賢い。無料枠で通らなければ勝手に下へ下りるので、
   * 「無料で使えるか怪しいが、使えたら嬉しい」ものを上に置いてある。 */
  'gemini-3.7-flash',        // 2026-08-13 GA。無料枠の有無は情報が割れている
  'gemini-3.6-flash',        // 2026-07-21 GA。同上
  'gemini-3.5-flash',        // 2026-05-19 GA。2026-07-16 時点で無料枠の行あり
  'gemini-3.1-flash-lite',   // 無料枠の行が確認できているもの
  'gemini-2.5-flash',        // 無料枠あり（10 RPM / 250 RPD）。2026-10-16 終了予定
  'gemini-2.5-flash-lite',   // 無料枠あり（15 RPM / 1000 RPD）。同上。最後の砦
];
/* Pro 系は入れない。2026年4月に無料枠から外れている。
 * 2.5 系は10月に終わるが、いま確実に無料で使えるのはここなので、いちばん下に残してある。
 * 終わったら 404 になり、自動で飛ばされるだけなので置きっぱなしで害はない。
 *
 * 無料枠の中身は Google 側でよく動く。ここを書き換えなくても済むよう、
 * スクリプト プロパティ GEMINI_MODELS に「カンマ区切り」で並べれば、そちらが使われる。 */
var GEMINI_MAX_TRIES = 3;        // 1回の頼みで試すのはここまで（端末側が待ちきれなくなるため）
var GEMINI_DEAD_REST = 21600;    // 名前が無いモデルを休ませる秒数（6時間・CacheService の上限）
var GEMINI_BUSY_REST = 300;      // 混んでいるモデルを休ませる秒数（5分）

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
        /* code はクライアントが見分けるための印。
         * 「家族コードを作った直後で、まだ1回目の同期が届いていない」だけのことがあるので、
         * 受け取った側は一度同期してから、もう一度だけ頼み直す。 */
        return json({ ok: false, code: 'unknown-house',
                      error: 'この家族コードでは使えません。先に「設定 > 共有」で同期を済ませてください' });
      }
      if (!takeAiQuota(house)) {
        return json({ ok: false, error: '今日はもうたくさん使いました。また明日おねがいします' });
      }
    }

    if (req.action === 'recognize')         return json(recognizeShelf(req));
    if (req.action === 'recognize-receipt') return json(recognizeReceipt(req));
    if (req.action === 'suggest-recipes')   return json(suggestRecipes(req));
    if (req.action === 'plan-week')         return json(planWeek(req));
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
    /* 誰も答えてくれなかったぶんは、使った回数に数えない */
    if (err && err.refundAi && house) refundAiQuota(house);
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
  var maxSrv = 0;
  for (var i = 0; i < values.length; i++) {
    index[key(values[i][0], values[i][1], values[i][2])] = i;
    var srv = Number(values[i][9]) || 0;
    if (srv > maxSrv) maxSrv = srv;
  }

  /* 「前回の続き」は srv > since で切り出している。
   * 同じミリ秒に2回書き込むと srv が並んでしまい、あとから来た変更が
   * 片方の端末にだけ永久に届かなくなる（消したことが伝わらない、など）。
   * srv は必ず前より大きくなるようにして、取りこぼしを無くす。 */
  var now = Date.now();
  if (now <= maxSrv) now = maxSrv + 1;
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
    var rng = sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADERS.length);
    /* 書く前に「書式なしテキスト」にしておく。シートを作ったときに敷いた書式は
     * 最初の1000行ぶんしかないので、そこを越えると期限「2026-09-01」が
     * 勝手に日付に変換され、家族には読めない文字列になって届く。 */
    rng.setNumberFormat('@');
    rng.setValues(appends);
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

  /* 品目が1つも無くても、同期しに来た時点でこの家は実在する。
   * ここで台帳に載せておかないと、入れたばかりの端末（棚が空）は
   * いつまでも knownHouse が false のままで、写真の読み取りが使えない。 */
  registerHouse(house, now);

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

function planWeek(req) {
  var have = (req.have || []).map(function (h) {
    return '- ' + h.name + ' ' + (h.qty || '') + (h.unit || '')
      + (h.daysLeft === null || h.daysLeft === undefined ? '' : '（あと' + h.daysLeft + '日）');
  }).join('\n');

  var people = req.people ? String(req.people) : '2人';

  var prompt = [
    'あなたは家庭の献立係です。これから1週間ぶんの夕飯を組み立ててください。',
    '',
    'いま家にあるもの：',
    have || '（ほとんど何もない）',
    '',
    '何人ぶんか：' + people,
    '',
    '**組み立ての順番（ここが最も大事）**：',
    '- **1日目と2日目は、いま家にあるものを中心にする。** 買い足しは最小限',
    '- **期限が近いものから先に使い切る**。傷ませない献立にする',
    '- 3日目以降は買い足してよいが、**買うものを増やしすぎない**',
    '',
    '**食材は使い回すこと**：',
    '- キャベツ1玉を買ったら、2〜3日に分けて使う献立にする',
    '- 1日にしか使わない食材を、何種類も買わせない',
    '- 同じ肉を2日に分けるなど、まとめ買いが活きる組み方にする',
    '',
    '**7日を似たものばかりにしない**：',
    '- 肉と魚、和洋中、こってりとあっさりを散らす',
    '- 同じ主材料が2日続かないようにする',
    '- 週の後半に1日は「簡単に済ませる日」（15分以内）を入れる',
    '',
    '各日について：',
    '- kind は "asis"（買い足し無しで作れる）か "plus"（買い足しが要る）',
    '- have には、その日に使う「いま家にあるもの」だけを入れる。無いものを入れない',
    '- buy には、その日のために買い足すものを入れる。**同じものを何日も buy に入れない**',
    '  （まとめて買って分けて使うので、最初に使う日にだけ入れる）',
    '- note は1行。なぜこの日にこれなのか（例：キャベツを使い切る、前日の残りを活かす）',
    '',
    'buyAll には、7日ぶんの買い足しを**まとめて**入れてください：',
    '- 同じものは1つにまとめ、量を合算する（例：豚こま切れ肉 400g）',
    '- for に、何日目で使うかを書く（例："2日目・5日目"）',
    '- 売り場ごとに近いものが並ぶよう、肉魚 → 野菜 → その他 の順にする',
    '',
    '守ること：',
    '- 塩・しょうゆ・みそ・砂糖・酢・油のような基本の調味料は、どの家にもある前提。buy に入れない',
    '- ただしケチャップ・カレールウ・キムチの素のような「味の方向を決める調味料」は、',
    '  家にあるなら have に入れて活かしてよい',
    '- 珍しい食材・高い食材・使い切れない量のものは入れない',
    '- **絶対に7日ぶん返す。少なく返さない**',
    '- level は「かんたん」「ふつう」「ちょっと手間」のどれか、time は「20分」など',
    '',
    'JSON だけを返す。説明文もコードフェンスも付けない：',
    '{"days":[{"day":1,"title":"","kind":"asis","level":"","time":"","have":[""],"buy":[],"note":""}],'
      + '"buyAll":[{"name":"","for":""}]}'
  ].join('\n');

  var out = gemini(prompt, null);
  return { ok: true, days: (out && out.days) || [], buyAll: (out && out.buyAll) || [] };
}

/** プロンプト（と、あれば画像）を Gemini に渡し、返ってきた JSON を object にして返す */
function gemini(prompt, dataUrl) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY が未設定です（Apps Script の「プロジェクトの設定 > スクリプト プロパティ」に入れてください）');
  }
  var parts = [{ text: prompt }];
  if (dataUrl) {
    var m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('写真の形式が読めませんでした');
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  var payload = JSON.stringify({
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
  });

  /* 頭のいい順に試す。名前が無ければ次へ、混んでいても次へ。
   * 休ませている（さっき駄目だった）モデルは飛ばすので、
   * ふだんは1回目で当たり、余分な往復は起きない。 */
  var cache = CacheService.getScriptCache();
  var models = candidateModels(props);
  var body = '', tried = 0, skipped = 0, busy = 0, lastCode = 0, lastMsg = '', keyBroken = false;

  for (var t = 0; t < models.length && tried < GEMINI_MAX_TRIES; t++) {
    var model = models[t];
    if (cache.get('rest:' + model)) { skipped++; continue; }   // いま休ませているもの

    tried++;
    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model
        + ':generateContent?key=' + encodeURIComponent(apiKey),
      { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: payload }
    );
    lastCode = res.getResponseCode();
    body = res.getContentText();
    if (lastCode === 200) break;

    try { lastMsg = JSON.parse(body).error.message; } catch (ignore) { lastMsg = body; }

    /* 鍵そのものが違うときだけは、どのモデルで試しても同じなので、ここで止める。
     * これを「403 は全部だめ」と一括りにすると、
     * 無料の鍵で有料モデルを引いたときにも止まってしまい、下りられない。 */
    if (badKey(lastMsg)) { keyBroken = true; break; }

    if (lastCode === 404) {
      // その名前のモデルはもう無い。長めに休ませて、次の頭のいいものへ
      cache.put('rest:' + model, '1', GEMINI_DEAD_REST);
      continue;
    }
    /* 400 は「こちらの送り方が悪い」ことが多い（写真が壊れている等）。
     * これをモデルのせいにして休ませると、誰かが1枚おかしな写真を送っただけで、
     * 上のモデルが家族ぜんぶに対して5分止まる。
     * モデルの名前を咎めている 400 のときだけ、モデルのせいだと見なす。 */
    if (lastCode === 400 && !aboutModel(lastMsg)) break;

    if (lastCode === 400 || lastCode === 403 || lastCode === 429 || lastCode === 503) {
      /* この鍵では使えない（無料枠に無い）／回数の上限／混み合っている。
       * どれも「少し置けば変わりうる」ので、短く休ませて次の頭のいいものへ下りる。 */
      cache.put('rest:' + model, '1', GEMINI_BUSY_REST);
      busy++;
      continue;
    }
    break;   // それ以外。どのモデルでも同じ見込みなので止める
  }

  if (lastCode !== 200) {
    if (keyBroken) {
      throw new Error('GEMINI_API_KEY が正しくありません（Apps Script の「プロジェクトの設定 > スクリプト プロパティ」を見直してください）');
    }
    if (busy || (skipped && !tried)) {
      /* Gemini には一度も答えてもらえていない。
       * この家の1日の回数を減らしたままにすると、混んでいた時間帯に
       * 何度か試しただけで、その日はもう使えなくなってしまう。 */
      var busyErr = new Error('いま混み合っています。少し待ってから、もう一度おねがいします');
      busyErr.refundAi = true;
      throw busyErr;
    }
    throw new Error('AI が答えられませんでした（' + lastCode + '）：' + lastMsg);
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

/**
 * 試すモデルを、頭のいい順に並べて返す。
 * GEMINI_MODEL に指定があればそれを先頭に置く（運用側の指定が最優先）。
 * 指定は書き換えない。上のモデルが戻ってきたら、また上から使いたいため。
 */
function candidateModels(props) {
  var list = GEMINI_MODELS;

  /* 無料枠の中身は Google 側でよく動く。コードを触らずに並べ替えられるよう、
   * スクリプト プロパティ GEMINI_MODELS（カンマ区切り）があればそちらを使う。 */
  var override = props.getProperty('GEMINI_MODELS');
  if (override) {
    var parsed = [];
    var raw = String(override).split(',');
    for (var r = 0; r < raw.length; r++) {
      var name = raw[r].trim();
      if (name) parsed.push(name);
    }
    if (parsed.length) list = parsed;
  }

  var models = [];
  var chosen = props.getProperty('GEMINI_MODEL');
  if (chosen) models.push(chosen);
  for (var i = 0; i < list.length; i++) {
    if (models.indexOf(list[i]) < 0) models.push(list[i]);
  }
  return models;
}

/** そのモデルを咎めている返事か。送った中身の問題と分けるために見る */
function aboutModel(msg) {
  var m = String(msg || '').toLowerCase();
  return m.indexOf('model') >= 0 || m.indexOf('not found') >= 0 || m.indexOf('not supported') >= 0;
}

/** 鍵そのものが通っていないか。モデルを替えても直らないのはこれだけ */
function badKey(msg) {
  var m = String(msg || '');
  return m.indexOf('API_KEY_INVALID') >= 0
      || m.indexOf('API key not valid') >= 0
      || m.indexOf('API key expired') >= 0;
}

/* ==================== 小道具 ==================== */

function key(house, kind, id) {
  return String(house) + '\t' + String(kind) + '\t' + String(id);
}

/* ==================== 家族コードの検査と回数の上限 ==================== */

/**
 * 一度でも同期しに来たことのある家かどうか。
 *
 * 以前は data シートに「行があるか」で見ていた。
 * これだと、入れたばかりで棚が空の端末は行が1つも書かれないので、
 * 家族コードを作って同期を済ませても、ずっと「使えません」と言われ続けていた
 * （そして棚を埋めるための写真の読み取りこそが、その最初の一歩だった）。
 * いまは houses 台帳で見る。同期しに来ればそれだけで載る。
 */
function knownHouse(house) {
  var cache = CacheService.getScriptCache();
  var ck = 'known:' + house;
  var hit = cache.get(ck);
  if (hit === '1') return true;
  if (hit === '0') return false;

  var found = houseRowOf(house) > 0;

  /* 台帳ができる前からある家は、data シートに行があれば実在する。
   * 見つけたら台帳にも書き写して、次からは台帳だけで済むようにする。 */
  if (!found && hasDataRows(house)) {
    registerHouse(house, Date.now());
    found = true;
  }

  /* 「ある」は5分、「ない」は30秒しか覚えない。
   * 家族コードを変えた直後は、同期が済むまで一瞬「ない」になる。
   * そこを5分も覚えていると、写真の読み取りとレシピが理由もわからず使えなくなる。 */
  cache.put(ck, found ? '1' : '0', found ? 300 : 30);
  return found;
}

/** 台帳の中の行番号（1始まり、見つからなければ 0） */
function houseRowOf(house) {
  var sh = getHouseSheet();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) === house) return i + 2;
  }
  return 0;
}

/** data シートに1行でもあるか（台帳ができる前からある家の救済） */
function hasDataRows(house) {
  var sh = getSheet();
  var last = sh.getLastRow();
  if (last < 2) return false;
  var col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) === house) return true;
  }
  return false;
}

/**
 * 台帳に載せる（すでにあれば最終利用日を書き直す）。
 * 同期は端末ごとに1分おきに来るので、毎回書くと無駄が多い。
 * 「載っている」と覚えているあいだ（5分）は何もしない。
 */
function registerHouse(house, now) {
  var cache = CacheService.getScriptCache();
  if (cache.get('known:' + house) === '1') return;

  var sh = getHouseSheet();
  var at = houseRowOf(house);
  if (at) sh.getRange(at, 3, 1, 1).setValues([[now]]);
  else    sh.getRange(sh.getLastRow() + 1, 1, 1, HOUSE_HEADERS.length).setValues([[house, now, now]]);
  cache.put('known:' + house, '1', 300);
}

/** 台帳シート。無ければ作る */
function getHouseSheet() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) {
    throw new Error('スプレッドシートに紐づいていません。'
      + 'スプレッドシートの「拡張機能 > Apps Script」から作り直してください');
  }
  var sh = ss.getSheetByName(HOUSE_SHEET);
  if (!sh) {
    /* 同時に2つ走ると、片方の insertSheet が「同じ名前がある」で落ちる。
     * 落ちたほうは、先に作られたシートを拾い直せばいい */
    try {
      sh = ss.insertSheet(HOUSE_SHEET);
    } catch (err) {
      return ss.getSheetByName(HOUSE_SHEET);
    }
    sh.getRange(1, 1, sh.getMaxRows(), HOUSE_HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HOUSE_HEADERS.length).setValues([HOUSE_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
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

  /* 家ごとの上限だけだと、コードを次々に作れば抜けられてしまう。
   * 全体にも上限を置いて、Gemini の枠が一気に空くことだけは防ぐ。 */
  var all = (state.counts['*'] || 0) + 1;
  if (all > AI_GLOBAL_DAILY_LIMIT) return false;

  state.counts[house] = n;
  state.counts['*'] = all;
  props.setProperty(QUOTA_KEY, JSON.stringify(state));
  return true;
}

/** 使えなかった1回ぶんを戻す（Gemini に届かなかったときだけ） */
function refundAiQuota(house) {
  var props = PropertiesService.getScriptProperties();
  var state;
  try { state = JSON.parse(props.getProperty(QUOTA_KEY) || '{}'); } catch (err) { return; }
  if (!state.counts) return;
  if (state.counts[house]) state.counts[house]--;
  if (state.counts['*']) state.counts['*']--;
  props.setProperty(QUOTA_KEY, JSON.stringify(state));
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
