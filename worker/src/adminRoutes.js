import * as db from './db.js';
import { issueToken, verifyToken, getBearerToken } from './auth.js';
import { buildTradeInfo, verifyAndDecryptNotify, readTradeFields } from './newebpay.js';

function adminBadRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.isValidation = true;
  return err;
}

function unauthorized(message) {
  const err = new Error(message || '未登入或登入已過期');
  err.status = 401;
  err.isValidation = true;
  return err;
}

export async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    const err = new Error('Server not configured: missing ADMIN_PASSWORD secret');
    err.status = 500;
    throw err;
  }
  const token = getBearerToken(request);
  const payload = await verifyToken(env.ADMIN_PASSWORD, token);
  if (!payload) throw unauthorized();
  return payload;
}

export async function handleLogin(request, env, body) {
  if (!env.ADMIN_PASSWORD) {
    const err = new Error('Server not configured: missing ADMIN_PASSWORD secret');
    err.status = 500;
    throw err;
  }
  if (!body || body.password !== env.ADMIN_PASSWORD) throw unauthorized('密碼錯誤');
  const token = await issueToken(env.ADMIN_PASSWORD, { role: 'admin' });
  return { token };
}

function requireDb(env) {
  if (!env.DB) {
    const err = new Error('Server not configured: missing DB (D1) binding');
    err.status = 500;
    throw err;
  }
  return env.DB;
}

// ---------- Dashboard ----------
export async function handleDashboard(request, env) {
  await requireAdmin(request, env);
  return db.getDashboardStats(requireDb(env));
}

// ---------- Customers ----------
export async function handleListCustomers(request, env) {
  await requireAdmin(request, env);
  return { customers: await db.listCustomers(requireDb(env)) };
}

export async function handleCreateCustomer(request, env, body) {
  await requireAdmin(request, env);
  if (!body || !body.name) throw adminBadRequest('請填寫客戶姓名');
  return db.createCustomer(requireDb(env), body);
}

export async function handleUpdateCustomer(request, env, body, params) {
  await requireAdmin(request, env);
  return db.updateCustomer(requireDb(env), params.id, body || {});
}

export async function handleDeleteCustomer(request, env, body, params) {
  await requireAdmin(request, env);
  await db.deleteCustomer(requireDb(env), params.id);
  return { ok: true };
}

// ---------- Products ----------
export async function handleListProducts(request, env) {
  await requireAdmin(request, env);
  return { products: await db.listProducts(requireDb(env)) };
}

export async function handleCreateProduct(request, env, body) {
  await requireAdmin(request, env);
  if (!body || !body.name || typeof body.price !== 'number') throw adminBadRequest('請填寫商品名稱與價格');
  return db.createProduct(requireDb(env), body);
}

export async function handleUpdateProduct(request, env, body, params) {
  await requireAdmin(request, env);
  return db.updateProduct(requireDb(env), params.id, body || {});
}

export async function handleDeleteProduct(request, env, body, params) {
  await requireAdmin(request, env);
  await db.deleteProduct(requireDb(env), params.id);
  return { ok: true };
}

// ---------- Orders ----------
export async function handleListOrders(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  return { orders: await db.listOrders(requireDb(env), { status }) };
}

export async function handleCreateOrder(request, env, body) {
  await requireAdmin(request, env);
  if (!body || typeof body.amount !== 'number') throw adminBadRequest('請填寫訂單金額');
  return db.createOrder(requireDb(env), body);
}

export async function handleUpdateOrderStatus(request, env, body, params) {
  await requireAdmin(request, env);
  if (!body || !['pending', 'paid', 'failed', 'cancelled'].includes(body.status)) {
    throw adminBadRequest('狀態必須是 pending / paid / failed / cancelled 其中之一');
  }
  return db.updateOrderStatus(requireDb(env), params.id, body);
}

// ---------- 藍新金流：建立付款請求（給前端「前往付款」按鈕用）----------
export async function handleCreatePayment(request, env, body) {
  await requireAdmin(request, env);
  if (!env.NEWEBPAY_MERCHANT_ID || !env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) {
    const err = new Error('尚未設定藍新金流金鑰（NEWEBPAY_MERCHANT_ID / NEWEBPAY_HASH_KEY / NEWEBPAY_HASH_IV），還沒申請到特約商店資格前無法使用真實付款。');
    err.status = 400;
    err.isValidation = true;
    throw err;
  }
  const orderId = body && body.orderId;
  if (!orderId) throw adminBadRequest('缺少 orderId');
  const order = await db.getOrder(requireDb(env), orderId);
  if (!order) throw adminBadRequest('找不到這筆訂單');

  const now = new Date();
  const params = {
    MerchantID: env.NEWEBPAY_MERCHANT_ID,
    RespondType: 'JSON',
    TimeStamp: Math.floor(now.getTime() / 1000).toString(),
    Version: '2.0',
    MerchantOrderNo: order.order_no,
    Amt: String(order.amount),
    ItemDesc: (order.product_name || 'Chat Persona 訂閱').slice(0, 50),
    ReturnURL: env.NEWEBPAY_RETURN_URL || '',
    NotifyURL: env.NEWEBPAY_NOTIFY_URL || '',
  };
  const { tradeInfo, tradeSha } = await buildTradeInfo({
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    params,
  });
  return {
    gatewayUrl: env.NEWEBPAY_GATEWAY_URL || 'https://core.newebpay.com/MPG/mpg_gateway',
    merchantId: env.NEWEBPAY_MERCHANT_ID,
    version: params.Version,
    tradeInfo,
    tradeSha,
  };
}

// ---------- 藍新金流：背景通知（Notify URL，藍新伺服器對伺服器呼叫，不經過使用者瀏覽器）----------
export async function handleNewebpayNotify(request, env) {
  if (!env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) {
    return new Response('Not configured', { status: 500 });
  }
  const { tradeInfo, tradeSha } = await readTradeFields(request);
  if (!tradeInfo || !tradeSha) return new Response('Bad Request', { status: 400 });

  const decoded = await verifyAndDecryptNotify({
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    tradeInfo,
    tradeSha,
  });
  if (!decoded) return new Response('Invalid signature', { status: 400 });

  if (decoded.Status === 'SUCCESS' && decoded.MerchantOrderNo) {
    await db.markOrderPaidByOrderNo(requireDb(env), decoded.MerchantOrderNo, { payment_type: decoded.PaymentType });
  }
  // 藍新規定 Notify URL 一定要回應 "1|OK" 純文字，不然它會重複重試通知。
  return new Response('1|OK', { status: 200, headers: { 'content-type': 'text/plain' } });
}
