// ============================================================
// Chat Persona API — 單檔打包版（給 Cloudflare Dashboard 線上編輯器用）
// 這個檔案是 worker/src/*.js 自動合併產生的，內容完全相同，
// 只是把四個檔案的 import/export 拆解合併成一份方便貼上。
// 如果你有終端機可以用 wrangler 部署，請改用 worker/src/ 底下的原始檔案。
// ============================================================

// ---------- validate.js ----------
const MAX_TEXT_CHARS = 60000;
const MAX_IMAGES = 8;

function truncateText(text) {
  if (!text) return '';
  if (text.length <= MAX_TEXT_CHARS) return text;
  // Keep the most recent part of the conversation, matching the
  // "超過只取最近的部分" behavior described in the upload UI.
  return text.slice(text.length - MAX_TEXT_CHARS);
}

function validateImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => img && typeof img.data === 'string' && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/'))
    .slice(0, MAX_IMAGES);
}

// ---------- anthropic.js ----------
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

async function postToAnthropic(apiKey, body) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error('Anthropic API error ' + res.status + ': ' + errText.slice(0, 500));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Forces a structured JSON response by requiring the model to call a single tool.
async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
  const data = await postToAnthropic(apiKey, {
    model,
    max_tokens: maxTokens || 2048,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) {
    throw new Error('Model did not return the expected structured result.');
  }
  return toolUse.input;
}

// Plain free-text reply, used for the short follow-up chat answers.
async function callClaudePlain({ apiKey, model, system, messages, maxTokens }) {
  const data = await postToAnthropic(apiKey, {
    model,
    max_tokens: maxTokens || 400,
    system,
    messages,
  });
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ---------- prompts.js ----------
const SYSTEM_PROMPT_BASE = `你是「聊天人格分析」網站背後的分析引擎。你的任務是根據使用者提供的真實聊天紀錄，做語氣、互動模式與關係動態的分析。規則：
1. 全程使用繁體中文（台灣用語）。
2. 分析必須基於你實際讀到的文字內容，不能憑空捏造與內容矛盾的細節；文字沒有明確資訊的地方（例如確切訊息則數），可以合理估算。
3. 語氣自然、像懂心理學又懂聊天的朋友在幫忙解讀，不要說教、不要條列免責聲明、不要提到「我是AI」或「這是示範」。
4. 給分數時要根據實際觀察到的傾向給出有區分度的數字，不要每項都給 50 附近的安全值。
5. 一律透過提供的工具（tool use）回傳結構化結果，不要在工具呼叫之外輸出任何文字。
6. 如果對話內容過短或資訊不足，仍要盡力給出合理推論，並讓數字/描述反映內容確實較單薄的狀況，不要因此拒絕分析。`;

function imageBlocks(images) {
  return images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
}

function conversationBlock(text) {
  if (!text) return '';
  return '\n\n對話內容如下：\n"""\n' + text + '\n"""';
}

// ---------- 免費版：單人聊天人格分析 ----------

const PERSONA_TOOL = {
  name: 'submit_persona_analysis',
  description: '提交聊天人格分析的結構化結果',
  input_schema: {
    type: 'object',
    properties: {
      personaCode: {
        type: 'string',
        enum: ['傾聽型', '直球型', '幽默型', '穩定型', '創意型', '理性型'],
        description: '六種人格類型中最符合使用者本人聊天風格的一種',
      },
      messageCount: { type: 'integer', minimum: 1, description: '你在提供的內容中辨識出的訊息則數估計值' },
      scores: {
        type: 'object',
        properties: {
          temperature: { type: 'integer', minimum: 0, maximum: 100, description: '溫度感：語氣溫暖、關心程度' },
          initiative: { type: 'integer', minimum: 0, maximum: 100, description: '主動聊天：主動開話題、主動傳訊息的程度' },
          directness: { type: 'integer', minimum: 0, maximum: 100, description: '直球指數：講話直接、不拐彎抹角的程度' },
          investment: { type: 'integer', minimum: 0, maximum: 100, description: '關係投入：整體對這段關係的用心程度' },
        },
        required: ['temperature', 'initiative', 'directness', 'investment'],
      },
      keywords: {
        type: 'array',
        items: {
          type: 'object',
          properties: { word: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
          required: ['word', 'count'],
        },
        minItems: 4,
        maxItems: 6,
        description: '這個人在對話中最常用、最有代表性的口頭禪或詞彙，依出現頻率估算次數',
      },
      insight: { type: 'string', description: '一段 2-3 句話的個人化觀察，要具體引用對話中觀察到的模式，不要講空話' },
      monthLabels: {
        type: 'array',
        items: { type: 'string' },
        minItems: 6,
        maxItems: 6,
        description: '對應下面兩個趨勢陣列的 6 個時間標籤；若對話中看得出實際日期就用真實月份（例如「3月」），看不出來就用「第1段」～「第6段」等相對描述',
      },
      monthlySentenceCounts: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        minItems: 6,
        maxItems: 6,
        description: '把對話依時間或內容平均分成 6 段，每段的句子數估計值',
      },
      monthlyMessageCounts: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        minItems: 6,
        maxItems: 6,
        description: '每段的訊息則數估計值',
      },
    },
    required: ['personaCode', 'messageCount', 'scores', 'keywords', 'insight', 'monthLabels', 'monthlySentenceCounts', 'monthlyMessageCounts'],
  },
};

function buildPersonaMessages({ text, images }) {
  const content = [];
  if (images.length) {
    content.push(...imageBlocks(images));
    content.push({ type: 'text', text: '以上是聊天截圖，請先在心裡辨識畫面中的對話文字，再依照下面的指示分析，不用把逐字稿寫出來。' });
  }
  const instructions = `你會看到一段使用者提供的真實聊天紀錄。請分析「使用者本人」在這段對話中的聊天風格（如果文字裡有明確的說話者標示，例如「我：」「他：」，「我」就是使用者本人；沒有明確標示時，以看起來主動貼上這份紀錄、視角在對話中比較主動的一方為準）。

六種人格類型：
1. 傾聽型 - 溫柔且擅長傾聽
2. 直球型 - 熱烈直接、有話直說
3. 幽默型 - 幽默閃躲、話中有話
4. 穩定型 - 穩定可靠、細水長流
5. 創意型 - 想像力豐富、跳躍思考
6. 理性型 - 理性觀察、字字斟酌

請選出最符合的一種，並呼叫 submit_persona_analysis 工具回傳完整結果。${conversationBlock(text)}`;
  content.push({ type: 'text', text: instructions });
  return [{ role: 'user', content }];
}

// ---------- 付費版：兩人關係深度分析 ----------

const personProfileSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', description: '一個簡短的個性標籤，例如「直球型」「幽默型」，可自由發想' },
    traits: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    description: { type: 'string', description: '2 句話左右的個性描述，需具體引用對話中的互動模式' },
  },
  required: ['code', 'traits', 'description'],
};

const moodSchema = {
  type: 'object',
  properties: {
    positive: { type: 'integer', minimum: 0, maximum: 100 },
    neutral: { type: 'integer', minimum: 0, maximum: 100 },
    negative: { type: 'integer', minimum: 0, maximum: 100 },
  },
  required: ['positive', 'neutral', 'negative'],
  description: '三者總和應接近 100',
};

const timelineEventSchema = {
  type: 'object',
  properties: {
    date: { type: 'string', description: '事件發生的時間點描述，若對話中有日期就用實際日期/月份，否則用「約第2週」等相對描述' },
    title: { type: 'string', description: '一句話標題，例如「第一次單獨出去，話題變得更私人」' },
    summary: { type: 'string', description: '具體描述當時對話內容發生了什麼' },
    interpretation: { type: 'string', description: '對這個事件的解讀，說明代表的意義' },
    impact: { type: 'string', description: '這個事件之後對關係造成的後續影響' },
  },
  required: ['date', 'title', 'summary', 'interpretation', 'impact'],
};

const milestoneInterpSchema = {
  type: 'object',
  properties: {
    index: { type: 'integer', description: '對應使用者標記清單中的第幾筆，從 0 開始' },
    summary: { type: 'string' },
    interpretation: { type: 'string' },
    impact: { type: 'string' },
  },
  required: ['index', 'summary', 'interpretation', 'impact'],
};

const RELATIONSHIP_TOOL = {
  name: 'submit_relationship_analysis',
  description: '提交兩人關係深度分析的結構化結果',
  input_schema: {
    type: 'object',
    properties: {
      chemistryScore: { type: 'integer', minimum: 0, maximum: 100 },
      totalMessages: { type: 'integer', minimum: 1 },
      personA: personProfileSchema,
      personB: personProfileSchema,
      conflict: {
        type: 'object',
        properties: {
          frequency: { type: 'string', description: '平均每月衝突次數，例如 "1.2"' },
          unit: { type: 'string', description: '例如 "次爭吵／月"' },
          tags: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, count: { type: 'integer' } }, required: ['label', 'count'] },
            minItems: 2,
            maxItems: 5,
          },
          description: { type: 'string' },
        },
        required: ['frequency', 'unit', 'tags', 'description'],
      },
      interactionSplit: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, userPct: { type: 'integer', minimum: 0, maximum: 100 } },
          required: ['label', 'userPct'],
        },
        minItems: 4,
        maxItems: 4,
        description: '固定四個指標，依序為「主動聊天佔比」「情緒表達佔比」「已讀回覆速度」「話題延續佔比」，每項給「你」的佔比（對方 = 100 - 你）',
      },
      keywords: {
        type: 'array',
        items: { type: 'object', properties: { word: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['word', 'count'] },
        minItems: 4,
        maxItems: 6,
      },
      stickerMoodA: moodSchema,
      stickerMoodB: moodSchema,
      monthLabels: { type: 'array', items: { type: 'string' }, minItems: 6, maxItems: 6 },
      monthlyMessageCounts: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 6, maxItems: 6 },
      temperatureTrend: {
        type: 'array',
        items: { type: 'integer', minimum: 0, maximum: 100 },
        minItems: 6,
        maxItems: 6,
        description: '六段關係溫度分數，反映每段時間的親密/熱絡程度',
      },
      timeline: { type: 'array', items: timelineEventSchema, minItems: 4, maxItems: 6 },
      milestoneInterpretations: {
        type: 'array',
        items: milestoneInterpSchema,
        description: '針對使用者自己標記的重要時刻，逐一給出摘要、解讀、後續影響；數量與 index 需對應輸入的使用者標記清單，若使用者沒有標記任何時刻則回傳空陣列',
      },
      personalInsight: { type: 'string', description: '對使用者本人的一段洞察，2-3 句話' },
      overallInsight: { type: 'string', description: '對整段關係的一段洞察，2-3 句話' },
      followUpQuestions: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 3,
        description: '2-3 個你想向使用者確認、能幫助你把分析寫得更準確的問題，必須針對這段對話中你觀察到但無法單從文字判斷的地方提問',
      },
    },
    required: [
      'chemistryScore', 'totalMessages', 'personA', 'personB', 'conflict', 'interactionSplit',
      'keywords', 'stickerMoodA', 'stickerMoodB', 'monthLabels', 'monthlyMessageCounts',
      'temperatureTrend', 'timeline', 'milestoneInterpretations', 'personalInsight', 'overallInsight', 'followUpQuestions',
    ],
  },
};

function buildRelationshipMessages({ text, images, relationshipType, milestones }) {
  const content = [];
  if (images.length) {
    content.push(...imageBlocks(images));
    content.push({ type: 'text', text: '以上是兩人對話的聊天截圖，請先在心裡辨識畫面中的對話文字（含雙方訊息與大致時間），再依照下面的指示分析。' });
  }
  let milestoneBlock = '';
  if (milestones && milestones.length) {
    milestoneBlock = '\n\n使用者另外標記了以下他自己覺得重要的時刻，請在分析時特別去對話內容中比對這些時間點附近實際發生了什麼，並在 milestoneInterpretations 中依序給出摘要、解讀、後續影響（index 對應下面清單的序號，從 0 開始，順序需完全一致）：\n' +
      milestones.map((m, i) => i + '. 日期：' + m.date + '　備註：' + m.note).join('\n');
  }
  const instructions = `你會看到使用者提供的一段「兩人之間」的真實聊天紀錄，使用者選擇的關係類型是：${relationshipType}。${milestoneBlock}

請完整分析這段對話，包含：
- 雙方（你＝訊息中我方；對方＝另一方）的個性側寫
- 化學反應分數（chemistryScore）：這段關係目前的熱度／契合度
- 衝突頻率與常見衝突主題
- 互動指標對比（主動聊天佔比、情緒表達佔比、已讀回覆速度、話題延續佔比，都以「你」的佔比表示）
- 雙方常用字詞
- 訊息／貼圖情緒的正面中性負面比例
- 依時間分成六段的訊息量與關係溫度趨勢
- 4-6 個關係中的重要事件時間軸，每個事件要具體引用對話內容
- 一段對使用者個人的洞察與一段對整段關係的洞察
- 2-3 個你想向使用者確認、能幫助你把分析寫得更準確的追問

請呼叫 submit_relationship_analysis 工具回傳結果。全部使用繁體中文，語氣像朋友幫忙解讀對話一樣自然，不要客套或說教，數字要有區分度、符合實際觀察。${conversationBlock(text)}`;
  content.push({ type: 'text', text: instructions });
  return [{ role: 'user', content }];
}

// ---------- 付費版：根據使用者補充回答，重寫兩段洞察 ----------

const REFINE_TOOL = {
  name: 'submit_refined_insight',
  description: '根據使用者補充回答的內容，更新兩段洞察文字',
  input_schema: {
    type: 'object',
    properties: {
      personalInsight: { type: 'string' },
      overallInsight: { type: 'string' },
    },
    required: ['personalInsight', 'overallInsight'],
  },
};

function buildRefineMessages({ draft, answers }) {
  const answeredLines = (answers || [])
    .map(a => (a.answer ? 'Q: ' + a.question + '\nA: ' + a.answer : 'Q: ' + a.question + '\nA: （使用者跳過未回答）'))
    .join('\n\n');
  const text = `以下是先前針對這段關係做的分析草稿中的兩段洞察文字，以及使用者針對追問的回答。請根據使用者的回答，重新改寫這兩段洞察文字，讓內容更準確、更個人化，自然地把使用者補充的資訊融入描述中（不要寫「根據你的回答」這種生硬字句，要寫得像本來就知道這些細節一樣）。如果使用者所有問題都跳過未回答，就維持原本的內容重新潤飾即可。

原本的個人洞察：${draft.personalInsight || ''}
原本的整體洞察：${draft.overallInsight || ''}

使用者的補充回答：
${answeredLines || '（無）'}

請呼叫 submit_refined_insight 工具回傳新的兩段文字。`;
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

// ---------- 付費版：時間軸事件的追問對話 ----------

function buildFollowupMessages({ event, question, contextText }) {
  let text = `使用者正在查看關係分析報告中的一個時間軸事件：
日期：${event.date || ''}　標題：${event.title || ''}
摘要：${event.summary || ''}
解讀：${event.interpretation || ''}

使用者針對這個事件提出追問：「${question}」`;
  if (contextText) {
    text += `\n\n以下是原始對話紀錄，可參考其中真實內容來回答：\n"""\n${contextText}\n"""`;
  }
  text += '\n\n請用 2-4 句話、朋友聊天般自然的語氣直接回答使用者的問題，不要條列、不要開場白，直接進主題。全部使用繁體中文，不要提到「示範」或「正式版」。';
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

// ---------- index.js ----------
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
