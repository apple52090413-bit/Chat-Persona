// ============================================================
// 藍新金流（NewebPay）MPG 介面串接工具
//
// ⚠️ 這個檔案的演算法（AES-256-CBC 加解密 + SHA256 檢查碼）是依照藍新
// 金流 MPG API 文件的標準做法寫的。曾經在 TradeSha 的組字串裡多寫了一段
// 「TradeInfo=」，導致藍新回報「交易資料 SHA 256 檢查不符合」——正確格式
// 是 HashKey=<key>&<加密後的 TradeInfo 值>&HashIV=<iv>，中間沒有欄位名稱，
// 已對照多份公開範例程式碼修正。如果之後又遇到簽章不符的錯誤，這裡是第一個
// 該回頭檢查的地方。
//
// 需要的三個值（申請特約商店通過後，藍新後台會給你）：
//   MerchantID — 商店代號
//   HashKey    — 32 字元
//   HashIV     — 16 字元
// ============================================================

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest)).toUpperCase();
}

async function importAesKey(hashKey) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(hashKey), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

// 建立要送去藍新收銀台的 TradeInfo / TradeSha（用在「前往付款」那一步，
// 把使用者導去藍新的付款頁）。
export async function buildTradeInfo({ hashKey, hashIv, params }) {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(query));
  const tradeInfo = toHex(new Uint8Array(encrypted));
  // 藍新的公式是 HashKey=<key>&<原始 TradeInfo 值>&HashIV=<iv> —— 中間沒有
  // 「TradeInfo=」這個欄位名稱，只是把加密結果直接接在兩個 & 中間。
  const tradeSha = await sha256Hex(`HashKey=${hashKey}&${tradeInfo}&HashIV=${hashIv}`);
  return { tradeInfo, tradeSha };
}

// 驗證＋解密藍新背景通知（Notify URL）送回來的 TradeInfo / TradeSha。
// 回傳解密後的參數物件（例如 { Status, MerchantOrderNo, TradeAmt, PaymentType, ... }），
// 如果檢查碼不對會回傳 null（代表這筆通知可能被竄改，不可信任）。
export async function verifyAndDecryptNotify({ hashKey, hashIv, tradeInfo, tradeSha }) {
  const { result } = await verifyAndDecryptNotifyDiagnostic({ hashKey, hashIv, tradeInfo, tradeSha });
  return result;
}

// 跟上面一樣，但同時回傳一個簡短、不含金鑰/完整雜湊值的失敗原因代碼
// （sha_mismatch / decrypt_fail），方便在還沒辦法順利看到 Cloudflare Logs
// 的情況下，直接把原因帶回前端畫面顯示出來除錯。
export async function verifyAndDecryptNotifyDiagnostic({ hashKey, hashIv, tradeInfo, tradeSha }) {
  const expectedSha = await sha256Hex(`HashKey=${hashKey}&${tradeInfo}&HashIV=${hashIv}`);
  if (expectedSha !== (tradeSha || '').toUpperCase()) {
    console.log('[newebpay] TradeSha mismatch:', JSON.stringify({ expectedSha, receivedSha: tradeSha, tradeInfoLength: (tradeInfo || '').length }));
    return { result: null, reason: 'sha_mismatch:exp' + expectedSha.slice(0, 6) + ':got' + (tradeSha || '').slice(0, 6) };
  }

  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  let decryptedBuf;
  try {
    decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, fromHex(tradeInfo));
  } catch (err) {
    console.log('[newebpay] AES decrypt failed despite valid TradeSha:', err.message);
    return { result: null, reason: 'decrypt_fail:' + err.message.slice(0, 40) };
  }
  const decrypted = new TextDecoder().decode(decryptedBuf);
  const result = {};
  for (const pair of decrypted.split('&')) {
    const [k, v] = pair.split('=');
    if (k) result[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
  }
  return { result, reason: null };
}

// 從藍新的 Notify/Return 請求裡取出 TradeInfo / TradeSha。文件對 RespondType
// 是否也會改變這兩個背景/導回請求的請求格式（表單 vs JSON、POST vs GET
// 查詢字串）寫得不清楚，與其賭對哪一種，這裡都接受：先看 body（JSON 或表單），
// 沒有的話再看網址上的查詢字串。
//
// 之前這裡猜過一次格式問題，猜錯了，Notify 還是失敗——所以這次一律先把
// request 複製一份、把原始 body 文字印進 console.log，不管後面解析成不成功
// 都留下診斷紀錄，下次失敗就不用再用猜的，直接去 Cloudflare 的 Observability
// / Logs 看實際收到的內容長怎樣。
export async function readTradeFields(request) {
  const contentType = request.headers.get('content-type') || '';
  let rawBodyForLog = '(no body / not read)';
  try {
    rawBodyForLog = await request.clone().text();
  } catch (err) {
    rawBodyForLog = '(failed to read body for logging: ' + err.message + ')';
  }
  console.log('[newebpay] incoming request:', JSON.stringify({
    method: request.method,
    url: request.url,
    contentType,
    bodyPreview: rawBodyForLog.slice(0, 2000),
  }));

  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (body.TradeInfo && body.TradeSha) return { tradeInfo: body.TradeInfo, tradeSha: body.TradeSha };
    } else if (request.method === 'POST') {
      const form = await request.formData();
      const tradeInfo = form.get('TradeInfo');
      const tradeSha = form.get('TradeSha');
      if (tradeInfo && tradeSha) return { tradeInfo, tradeSha };
    }
  } catch (err) {
    console.log('[newebpay] body parse failed:', err.message);
  }
  const url = new URL(request.url);
  const fromQuery = {
    tradeInfo: url.searchParams.get('TradeInfo'),
    tradeSha: url.searchParams.get('TradeSha'),
  };
  if (!fromQuery.tradeInfo || !fromQuery.tradeSha) {
    console.log('[newebpay] could not find TradeInfo/TradeSha in body or query string');
  }
  return fromQuery;
}
