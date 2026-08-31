import { callClaudeTool, callClaudePlain } from './anthropic.js';
import {
  SYSTEM_PROMPT_BASE,
  PERSONA_TOOL, buildPersonaMessages,
  RELATIONSHIP_TOOL, buildRelationshipMessages,
  REFINE_TOOL, buildRefineMessages,
  buildFollowupMessages,
} from './prompts.js';
import { FREE_TEXT_LIMIT, PAID_TEXT_LIMIT, assertWithinTextLimit, validateImages } from './validate.js';
import { redactAliasesFromResult } from './privacy.js';
import { logApiUsage } from './db.js';
import {
  handleLogin, handleDashboard,
  handleListCustomers, handleCreateCustomer, handleUpdateCustomer, handleDeleteCustomer,
  handleListProducts, handleCreateProduct, handleUpdateProduct, handleDeleteProduct,
  handleListOrders, handleCreateOrder, handleUpdateOrderStatus,
  handleCreatePayment, handleNewebpayNotify,
} from './adminRoutes.js';
import { handleCreatePublicOrder, handlePayStatus, handleNewebpayReturn } from './payRoutes.js';

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'content-type': 'application/json', ...headers } });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.isValidation = true;
  return err;
}

function model(env) {
  return env.ANTHROPIC_MODEL || 'claude-sonnet-5';
}

// 記錄這次呼叫花了多少 token，方便之後在後台看實際花費趨勢。
// 這裡刻意不讓記錄失敗擋住使用者拿到分析結果 —— DB 沒設定、或寫入失敗，
// 頂多就是這一筆沒記到，不應該讓整個請求跟著失敗。
async function logUsage(env, { orderId, endpoint, usage }) {
  if (!env.DB || !usage) return;
  try {
    await logApiUsage(env.DB, {
      orderId: orderId || null,
      endpoint,
      model: model(env),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });
  } catch (err) {
    console.error('logApiUsage failed:', err);
  }
}

// 呼叫 callClaudeTool，並且不管成功或失敗都記錄 token 用量
// （AI 回傳格式不完整而重試的那幾次，Anthropic 一樣有計費）。
async function callClaudeToolLogged(env, { endpoint, orderId, ...params }) {
  try {
    const { result, usage } = await callClaudeTool(params);
    await logUsage(env, { orderId, endpoint, usage });
    return result;
  } catch (err) {
    if (err.usage) await logUsage(env, { orderId, endpoint, usage: err.usage });
    throw err;
  }
}

// ---------- 免費/付費版聊天分析（需要 ANTHROPIC_API_KEY）----------

async function handlePersona(request, env, body) {
  const text = (body.text || '').trim();
  const images = validateImages(body.images);
  if (!text && images.length === 0) throw badRequest('請提供文字內容或圖片');
  assertWithinTextLimit(text, FREE_TEXT_LIMIT);
  const messages = buildPersonaMessages({ text, images });
  const result = await callClaudeToolLogged(env, {
    endpoint: 'analyze-persona',
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: PERSONA_TOOL, maxTokens: 3000,
  });
  // 保險層：不管上面的 insight 等欄位有沒有照 prompt 指示避開真實姓名，
  // 這裡都強制把 AI 回報的稱呼換成「對方」，不依賴 AI 自己是否遵守。
  // otherPartyAliases 故意保留在回傳結果裡（不刪掉）——前端不會特別去顯示
  // 這個欄位，但如果之後又有其他呼叫需要重新生成文字內容，可以沿用同一份
  // 名單繼續做遮蔽，不用重新問一次 AI。
  return redactAliasesFromResult(
    result,
    [{ aliases: result.otherPartyAliases, replacement: '對方' }],
    ['otherPartyAliases']
  );
}

async function handleRelationship(request, env, body) {
  const text = (body.text || '').trim();
  const images = validateImages(body.images);
  const relationshipType = typeof body.relationshipType === 'string' ? body.relationshipType : '曖昧';
  const milestones = Array.isArray(body.milestones)
    ? body.milestones.slice(0, 20).filter(m => m && typeof m.date === 'string' && typeof m.note === 'string')
    : [];
  if (!text && images.length === 0) throw badRequest('請提供文字內容或圖片');
  assertWithinTextLimit(text, PAID_TEXT_LIMIT);
  const messages = buildRelationshipMessages({ text, images, relationshipType, milestones });
  const result = await callClaudeToolLogged(env, {
    endpoint: 'analyze-relationship',
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: RELATIONSHIP_TOOL, maxTokens: 14000,
  });
  // 保險層：不管上面每個欄位有沒有照 prompt 指示避開真實姓名，這裡都強制把
  // AI 回報的稱呼換成「你」/「對方」，不依賴 AI 自己是否遵守指示 ——
  // 這就是使用者反映「對方名字直接跑出來」這個問題的實際防線。
  // personAAliases/personBAliases 故意保留在回傳結果裡：前端會把整個結果存成
  // lastRelationshipDraft，之後呼叫 /refine-relationship 時會整包送回來，
  // 讓 handleRefine 能沿用同一份名單繼續遮蔽新生成的文字，不用重新問一次 AI。
  return redactAliasesFromResult(
    result,
    [
      { aliases: result.personAAliases, replacement: '你' },
      { aliases: result.personBAliases, replacement: '對方' },
    ],
    ['personAAliases', 'personBAliases']
  );
}

async function handleRefine(request, env, body) {
  const draft = body.draft;
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!draft || typeof draft !== 'object') throw badRequest('缺少原始分析結果');
  const messages = buildRefineMessages({ draft, answers });
  const result = await callClaudeToolLogged(env, {
    endpoint: 'refine-relationship',
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: REFINE_TOOL, maxTokens: 1024,
  });
  // 這一步是重寫兩段洞察文字，使用者補充回答的內容也可能夾帶真實姓名，
  // 所以一樣要用原本那份名單（沿用自 draft，不用重新問 AI）做同樣的保險遮蔽。
  return redactAliasesFromResult(result, [
    { aliases: draft.personAAliases, replacement: '你' },
    { aliases: draft.personBAliases, replacement: '對方' },
  ]);
}

async function handleFollowup(request, env, body) {
  const event = body.event && typeof body.event === 'object' ? body.event : {};
  const question = typeof body.question === 'string' ? body.question.slice(0, 1000).trim() : '';
  if (!question) throw badRequest('請輸入問題內容');
  const messages = buildFollowupMessages({ event, question });
  const { result: reply, usage } = await callClaudePlain({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, maxTokens: 400,
  });
  await logUsage(env, { endpoint: 'timeline-followup', usage });
  // 使用者自己打的追問問題也可能夾帶真實姓名（例如「小明為什麼會這樣」），
  // AI 回覆時可能原樣覆誦回來，所以一樣要用同一份名單做保險遮蔽。
  const { reply: redactedReply } = redactAliasesFromResult({ reply }, [
    { aliases: body.personAAliases, replacement: '你' },
    { aliases: body.personBAliases, replacement: '對方' },
  ]);
  return { reply: redactedReply };
}

// ---------- 路由表 ----------
// path 可以用 :id 這種形式表示路徑參數。
// requiresApiKey: 需要 ANTHROPIC_API_KEY 才能用（聊天分析相關）。
// raw: handler 直接回傳 Response 物件（不要包成 JSON），目前只有藍新的 webhook 用到。

const ROUTES = [
  { method: 'POST', path: '/analyze-persona', handler: handlePersona, requiresApiKey: true },
  { method: 'POST', path: '/analyze-relationship', handler: handleRelationship, requiresApiKey: true },
  { method: 'POST', path: '/refine-relationship', handler: handleRefine, requiresApiKey: true },
  { method: 'POST', path: '/timeline-followup', handler: handleFollowup, requiresApiKey: true },

  { method: 'POST', path: '/admin/login', handler: handleLogin },
  { method: 'GET', path: '/admin/dashboard', handler: handleDashboard },

  { method: 'GET', path: '/admin/customers', handler: handleListCustomers },
  { method: 'POST', path: '/admin/customers', handler: handleCreateCustomer },
  { method: 'PATCH', path: '/admin/customers/:id', handler: handleUpdateCustomer },
  { method: 'DELETE', path: '/admin/customers/:id', handler: handleDeleteCustomer },

  { method: 'GET', path: '/admin/products', handler: handleListProducts },
  { method: 'POST', path: '/admin/products', handler: handleCreateProduct },
  { method: 'PATCH', path: '/admin/products/:id', handler: handleUpdateProduct },
  { method: 'DELETE', path: '/admin/products/:id', handler: handleDeleteProduct },

  { method: 'GET', path: '/admin/orders', handler: handleListOrders },
  { method: 'POST', path: '/admin/orders', handler: handleCreateOrder },
  { method: 'PATCH', path: '/admin/orders/:id/status', handler: handleUpdateOrderStatus },

  { method: 'POST', path: '/admin/create-payment', handler: handleCreatePayment },

  { method: 'POST', path: '/webhook/newebpay', handler: handleNewebpayNotify, raw: true },

  { method: 'POST', path: '/pay/create-order', handler: handleCreatePublicOrder },
  { method: 'GET', path: '/pay/status', handler: handlePayStatus },
  { method: 'POST', path: '/return/newebpay', handler: handleNewebpayReturn, raw: true },
  { method: 'GET', path: '/return/newebpay', handler: handleNewebpayReturn, raw: true },
];

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const paramNames = [];
    const patternStr = '^' + route.path
      .split('/')
      .map(seg => {
        if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/') + '$';
    const match = pathname.match(new RegExp(patternStr));
    if (match) {
      const params = {};
      paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      return { route, params };
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    if (!matched) return json({ error: 'Not found' }, 404, headers);

    const { route, params } = matched;

    if (route.requiresApiKey && !env.ANTHROPIC_API_KEY) {
      return json({ error: 'Server not configured: missing ANTHROPIC_API_KEY secret' }, 500, headers);
    }

    if (route.raw) {
      try {
        return await route.handler(request, env, params);
      } catch (err) {
        console.error(err);
        return new Response('Internal error', { status: 500 });
      }
    }

    let body = {};
    if (request.method === 'POST' || request.method === 'PATCH') {
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400, headers);
      }
    }

    try {
      const result = await route.handler(request, env, body, params);
      return json(result, 200, headers);
    } catch (err) {
      console.error(err);
      const status = err.isValidation ? (err.status || 400) : err.isUpstream ? 502 : (err.status || 500);
      const errorBody = { error: err.message || 'Internal error' };
      // 字數超過上限這種情況，前端需要 code/charCount/limit 才能顯示「改用付費版」
      // 之類的引導文案，而不是只丟一個看不懂的錯誤訊息。
      if (err.code) errorBody.code = err.code;
      if (err.charCount !== undefined) errorBody.charCount = err.charCount;
      if (err.limit !== undefined) errorBody.limit = err.limit;
      return json(errorBody, status, headers);
    }
  },
};
