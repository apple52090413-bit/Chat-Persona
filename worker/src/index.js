import { callClaudeTool, callClaudePlain } from './anthropic.js';
import {
  SYSTEM_PROMPT_BASE,
  PERSONA_TOOL, buildPersonaMessages,
  RELATIONSHIP_TOOL, buildRelationshipMessages,
  REFINE_TOOL, buildRefineMessages,
  buildFollowupMessages,
} from './prompts.js';
import { truncateText, validateImages } from './validate.js';
import {
  handleLogin, handleDashboard,
  handleListCustomers, handleCreateCustomer, handleUpdateCustomer, handleDeleteCustomer,
  handleListProducts, handleCreateProduct, handleUpdateProduct, handleDeleteProduct,
  handleListOrders, handleCreateOrder, handleUpdateOrderStatus,
  handleCreatePayment, handleNewebpayNotify,
} from './adminRoutes.js';

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

// ---------- 免費/付費版聊天分析（需要 ANTHROPIC_API_KEY）----------

async function handlePersona(request, env, body) {
  const text = truncateText(body.text || '');
  const images = validateImages(body.images);
  if (!text && images.length === 0) throw badRequest('請提供文字內容或圖片');
  const messages = buildPersonaMessages({ text, images });
  return callClaudeTool({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: PERSONA_TOOL, maxTokens: 2048,
  });
}

async function handleRelationship(request, env, body) {
  const text = truncateText(body.text || '');
  const images = validateImages(body.images);
  const relationshipType = typeof body.relationshipType === 'string' ? body.relationshipType : '曖昧';
  const milestones = Array.isArray(body.milestones)
    ? body.milestones.slice(0, 20).filter(m => m && typeof m.date === 'string' && typeof m.note === 'string')
    : [];
  if (!text && images.length === 0) throw badRequest('請提供文字內容或圖片');
  const messages = buildRelationshipMessages({ text, images, relationshipType, milestones });
  return callClaudeTool({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: RELATIONSHIP_TOOL, maxTokens: 4096,
  });
}

async function handleRefine(request, env, body) {
  const draft = body.draft;
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!draft || typeof draft !== 'object') throw badRequest('缺少原始分析結果');
  const messages = buildRefineMessages({ draft, answers });
  return callClaudeTool({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: REFINE_TOOL, maxTokens: 1024,
  });
}

async function handleFollowup(request, env, body) {
  const event = body.event && typeof body.event === 'object' ? body.event : {};
  const question = typeof body.question === 'string' ? body.question.slice(0, 1000).trim() : '';
  const contextText = truncateText(body.text || '');
  if (!question) throw badRequest('請輸入問題內容');
  const messages = buildFollowupMessages({ event, question, contextText });
  const reply = await callClaudePlain({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, maxTokens: 400,
  });
  return { reply };
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
      return json({ error: err.message || 'Internal error' }, status, headers);
    }
  },
};
