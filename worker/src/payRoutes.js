// ============================================================
// 客戶自助結帳（雙人關係報告，NT$99）
//
// 跟 adminRoutes.js 裡的藍新相關 handler 不一樣：這裡的 route 是給「一般訪客」
// 直接呼叫的，不需要登入後台。安全性靠的是 client_token（見 db.js），不是
// 帳號密碼 —— 每筆訂單建立時都會產生一組隨機權杖，只有拿得到這組權杖的人
// （也就是剛剛建立這筆訂單的那個瀏覽器分頁）才能查詢/確認這筆訂單的付款狀態。
// ============================================================

import * as db from './db.js';
import { buildTradeInfo, verifyAndDecryptNotifyDiagnostic, readTradeFields } from './newebpay.js';

const PAID_REPORT_AMOUNT = 99;
const PAID_REPORT_PRODUCT_NAME = '雙人關係報告（單次）';
// 付款完成後，藍新的 Return URL 會把瀏覽器導回這裡（不是導回 Worker 本身）。
const SITE_URL = 'https://chatpersonachatlab.com';

// 名稱刻意加 pay 前綴，避免跟 index.js 的 badRequest()、adminRoutes.js 的
// requireDb() 撞名 —— worker/build-bundle.py 會把所有檔案攤平合併成一個
// 檔案給 Cloudflare 網頁編輯器貼上，撞名會變成同一個作用域裡的重複宣告。
function payBadRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.isValidation = true;
  return err;
}

function payNotFound(message) {
  const err = new Error(message);
  err.status = 404;
  err.isValidation = true;
  return err;
}

function payRequireDb(env) {
  if (!env.DB) {
    const err = new Error('Server not configured: missing DB (D1) binding');
    err.status = 500;
    throw err;
  }
  return env.DB;
}

// ---------- 建立訂單 + 藍新 TradeInfo/TradeSha（給付款頁「前往藍新金流付款」用）----------
export async function handleCreatePublicOrder(request, env) {
  if (!env.NEWEBPAY_MERCHANT_ID || !env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) {
    const err = new Error('尚未設定藍新金流金鑰，暫時無法付款，請稍後再試或聯絡客服。');
    err.status = 400;
    err.isValidation = true;
    throw err;
  }
  const dbc = payRequireDb(env);
  const product = await db.getProductByName(dbc, PAID_REPORT_PRODUCT_NAME);
  const order = await db.createOrder(dbc, {
    customer_id: null,
    product_id: product ? product.id : null,
    amount: PAID_REPORT_AMOUNT,
    note: '客戶自助結帳（雙人關係報告）',
  });

  const now = new Date();
  const params = {
    MerchantID: env.NEWEBPAY_MERCHANT_ID,
    RespondType: 'JSON',
    TimeStamp: Math.floor(now.getTime() / 1000).toString(),
    Version: '2.0',
    MerchantOrderNo: order.order_no,
    Amt: String(PAID_REPORT_AMOUNT),
    ItemDesc: '雙人關係深度報告',
    ReturnURL: env.NEWEBPAY_RETURN_URL || '',
    NotifyURL: env.NEWEBPAY_NOTIFY_URL || '',
  };
  const { tradeInfo, tradeSha } = await buildTradeInfo({
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    params,
  });

  return {
    orderNo: order.order_no,
    clientToken: order.client_token,
    gatewayUrl: env.NEWEBPAY_GATEWAY_URL || 'https://core.newebpay.com/MPG/mpg_gateway',
    merchantId: env.NEWEBPAY_MERCHANT_ID,
    version: params.Version,
    tradeInfo,
    tradeSha,
  };
}

// ---------- 查詢訂單付款狀態（付款完從藍新導回本站後，前端用來確認是否真的付款成功）----------
export async function handlePayStatus(request, env) {
  const url = new URL(request.url);
  const orderNo = url.searchParams.get('orderNo') || '';
  const token = url.searchParams.get('token') || '';
  if (!orderNo || !token) throw payBadRequest('缺少 orderNo 或 token');

  const order = await db.getOrderByOrderNo(payRequireDb(env), orderNo);
  if (!order || order.client_token !== token) throw payNotFound('找不到這筆訂單');

  return { status: order.status };
}

// ---------- 藍新 Return URL：使用者付款完，瀏覽器被藍新導回來的落地頁 ----------
// 這是瀏覽器導頁（POST），不是伺服器對伺服器的背景通知，所以拿到 TradeInfo 就
// 順手直接把訂單標記為付款完成（跟 webhook/newebpay 的背景通知邏輯重複沒關係，
// markOrderPaidByOrderNo 本身是幂等的），這樣使用者不用等背景通知送達就能立刻
// 解鎖付費功能，不會有延遲感。驗證完（不管成功或失敗）一律把瀏覽器導回靜態網站，
// 網址帶 ?paid=1 或 ?paid=0，前端看到後還會再打一次 /pay/status 用權杖二次確認，
// 不會只憑這個網址參數就放行。
export async function handleNewebpayReturn(request, env) {
  // debug 參數只帶一個簡短原因代碼（不含金鑰或完整雜湊值），純粹是暫時的
  // 除錯輔助——還沒辦法順利查看 Cloudflare Logs，所以先讓失敗原因直接顯示在
  // 使用者畫面上，之後確認問題解決就可以把這段拿掉。
  const redirectTo = (paid, debugReason) =>
    Response.redirect(SITE_URL + '/?paid=' + paid + (debugReason ? '&debug=' + encodeURIComponent(debugReason) : ''), 302);

  if (!env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) return redirectTo(0, 'not_configured');

  const { tradeInfo, tradeSha } = await readTradeFields(request);
  if (!tradeInfo || !tradeSha) return redirectTo(0, 'no_fields_method' + request.method + '_ct' + (request.headers.get('content-type') || 'none'));

  const { result: decoded, reason } = await verifyAndDecryptNotifyDiagnostic({
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    tradeInfo,
    tradeSha,
  });
  if (!decoded) return redirectTo(0, reason || 'unknown');

  if (decoded.Status === 'SUCCESS' && decoded.MerchantOrderNo) {
    try {
      await db.markOrderPaidByOrderNo(payRequireDb(env), decoded.MerchantOrderNo, { payment_type: decoded.PaymentType });
    } catch (err) {
      console.error('markOrderPaidByOrderNo (return) failed:', err);
    }
    return redirectTo(1);
  }
  return redirectTo(0, 'status_' + (decoded.Status || 'missing'));
}
