import { callClaudeTool, callClaudePlain } from './anthropic.js';
import {
  SYSTEM_PROMPT_BASE,
  PERSONA_TOOL, buildPersonaMessages,
  RELATIONSHIP_TOOL, buildRelationshipMessages,
  REFINE_TOOL, buildRefineMessages,
  buildFollowupMessages,
} from './prompts.js';
import { truncateText, validateImages } from './validate.js';

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

async function handlePersona(body, env) {
  const text = truncateText(body.text || '');
  const images = validateImages(body.images);
  if (!text && images.length === 0) throw badRequest('請提供文字內容或圖片');
  const messages = buildPersonaMessages({ text, images });
  return callClaudeTool({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: PERSONA_TOOL, maxTokens: 2048,
  });
}

async function handleRelationship(body, env) {
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

async function handleRefine(body, env) {
  const draft = body.draft;
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!draft || typeof draft !== 'object') throw badRequest('缺少原始分析結果');
  const messages = buildRefineMessages({ draft, answers });
  return callClaudeTool({
    apiKey: env.ANTHROPIC_API_KEY, model: model(env),
    system: SYSTEM_PROMPT_BASE, messages, tool: REFINE_TOOL, maxTokens: 1024,
  });
}

async function handleFollowup(body, env) {
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

const ROUTES = {
  '/analyze-persona': handlePersona,
  '/analyze-relationship': handleRelationship,
  '/refine-relationship': handleRefine,
  '/timeline-followup': handleFollowup,
};

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Server not configured: missing ANTHROPIC_API_KEY secret' }, 500, headers);
    }

    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: 'Not found' }, 404, headers);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, headers);
    }

    try {
      const result = await handler(body, env);
      return json(result, 200, headers);
    } catch (err) {
      console.error(err);
      const status = err.isValidation ? 400 : (err.status ? 502 : 500);
      return json({ error: err.message || 'Internal error' }, status, headers);
    }
  },
};
