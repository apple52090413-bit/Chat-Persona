// ============================================================
// Chat Persona API — 單檔打包版（給 Cloudflare Dashboard 線上編輯器用）
// 這個檔案是 worker/src/*.js 自動合併產生的，內容完全相同，
// 只是把所有檔案的 import/export 拆解合併成一份方便貼上。
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
    err.isUpstream = true;
    throw err;
  }
  return res.json();
}

function isValidToolInput(input, requiredKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return requiredKeys.every(key => input[key] !== undefined && input[key] !== null);
}

const RETRY_NUDGE = '（上一次的回覆格式不完整或把內容誤塞進單一欄位，這次請務必透過 tool use 把每一個欄位都個別正確填寫成對應的型別，不要把其他欄位的內容寫成文字塞進某一個欄位裡，也不要用 XML 或其他格式，只能用工具呼叫本身的結構化參數。）';

// Forces a structured JSON response by requiring the model to call a single tool.
// Retries once (with a corrective nudge) if the model's tool call is missing
// required fields or malforms the arguments — this does happen occasionally
// with complex nested schemas, especially on very short/sparse input.
async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
  const requiredKeys = (tool.input_schema && tool.input_schema.required) || [];
  let lastToolUse = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMessages = attempt === 0 ? messages : appendNudge(messages, RETRY_NUDGE);
    const data = await postToAnthropic(apiKey, {
      model,
      max_tokens: maxTokens || 2048,
      system,
      messages: attemptMessages,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    });
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
    if (toolUse) lastToolUse = toolUse;
    if (toolUse && isValidToolInput(toolUse.input, requiredKeys)) {
      return toolUse.input;
    }
  }

  console.error('Invalid tool_use input after retry:', JSON.stringify(lastToolUse).slice(0, 1000));
  throw new Error('AI 回傳的分析格式不完整，請重試一次。');
}

function appendNudge(messages, nudge) {
  const clone = messages.map(m => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  const last = clone[clone.length - 1];
  if (last && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: nudge });
  }
  return clone;
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
    relevantExcerpt: {
      type: 'string',
      description: '從原始對話中擷取一小段（100-250字內）跟這個事件最相關的原文或改寫重點。這段文字之後會被單獨保存，使用者針對這個事件追問時只會用這段當上下文，不會重新讀取整份對話，所以要包含足夠的具體細節（例如關鍵句子、語氣、雙方怎麼說的），不要只是重複 summary 的空泛敘述。',
    },
  },
  required: ['date', 'title', 'summary', 'interpretation', 'impact', 'relevantExcerpt'],
};

const milestoneInterpSchema = {
  type: 'object',
  properties: {
    index: { type: 'integer', description: '對應使用者標記清單中的第幾筆，從 0 開始' },
    summary: { type: 'string' },
    interpretation: { type: 'string' },
    impact: { type: 'string' },
    relevantExcerpt: {
      type: 'string',
      description: '從原始對話中擷取一小段（100-250字內）跟這個時刻最相關的原文或改寫重點，用途同 timeline 事件的 relevantExcerpt——之後使用者追問只會用這段當上下文。如果對話中確實找不到對應內容，可以填空字串。',
    },
  },
  required: ['index', 'summary', 'interpretation', 'impact', 'relevantExcerpt'],
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
- 4-6 個關係中的重要事件時間軸，每個事件要具體引用對話內容，並附上 relevantExcerpt（見下方欄位說明，之後使用者追問這個事件時只會用這段文字當依據，請確保包含足夠細節）
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
// 註：這裡刻意不重新附上整份原始對話——event.relevantExcerpt 是產生報告時
// 就已經摘錄好的相關片段，追問只依賴這一小段，避免每次追問都重燒一次
// 兩萬 token 等級的完整對話內容。

function buildFollowupMessages({ event, question }) {
  let text = `使用者正在查看關係分析報告中的一個時間軸事件：
日期：${event.date || ''}　標題：${event.title || ''}
摘要：${event.summary || ''}
解讀：${event.interpretation || ''}`;
  if (event.relevantExcerpt) {
    text += `\n相關原文摘錄：${event.relevantExcerpt}`;
  }
  text += `\n\n使用者針對這個事件提出追問：「${question}」`;
  text += '\n\n請用 2-4 句話、朋友聊天般自然的語氣直接回答使用者的問題，不要條列、不要開場白，直接進主題。全部使用繁體中文，不要提到「示範」或「正式版」。如果上面的摘錄不足以回答問題，可以老實說目前資料不夠判斷，不要憑空編造細節。';
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

// ---------- auth.js ----------
// 簡單的後台登入機制：一組密碼（存在 ADMIN_PASSWORD secret），
// 登入成功後發一個有效期 12 小時、用 HMAC-SHA256 簽名的 token，
// 之後每個 /admin/* 請求都要帶著這個 token 驗證。
// 這不是給多人多帳號用的系統，只是給網站擁有者自己用的後台鎖。

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueToken(secret, payload) {
  const body = JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS });
  const bodyB64 = toBase64Url(new TextEncoder().encode(body));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return bodyB64 + '.' + sigB64;
}

async function verifyToken(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [bodyB64, sigB64] = token.split('.');
  const key = await hmacKey(secret);
  const expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64)));
  const givenSig = fromBase64Url(sigB64);
  if (expectedSig.length !== givenSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ givenSig[i];
  if (diff !== 0) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyB64)));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// ---------- newebpay.js ----------
// ============================================================
// 藍新金流（NewebPay）MPG 介面串接工具
//
// ⚠️ 這個檔案的演算法（AES-256-CBC 加解密 + SHA256 檢查碼）是依照藍新
// 金流 MPG API 文件的標準做法寫的，但欄位名稱、後台網址等細節請在拿到
// 特約商店資格、下載到官方最新文件後，對照一次再上線使用。
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
async function buildTradeInfo({ hashKey, hashIv, params }) {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(query));
  const tradeInfo = toHex(new Uint8Array(encrypted));
  const tradeSha = await sha256Hex(`HashKey=${hashKey}&TradeInfo=${tradeInfo}&HashIV=${hashIv}`);
  return { tradeInfo, tradeSha };
}

// 驗證＋解密藍新背景通知（Notify URL）送回來的 TradeInfo / TradeSha。
// 回傳解密後的參數物件（例如 { Status, MerchantOrderNo, TradeAmt, PaymentType, ... }），
// 如果檢查碼不對會回傳 null（代表這筆通知可能被竄改，不可信任）。
async function verifyAndDecryptNotify({ hashKey, hashIv, tradeInfo, tradeSha }) {
  const expectedSha = await sha256Hex(`HashKey=${hashKey}&TradeInfo=${tradeInfo}&HashIV=${hashIv}`);
  if (expectedSha !== (tradeSha || '').toUpperCase()) return null;

  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  let decryptedBuf;
  try {
    decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, fromHex(tradeInfo));
  } catch {
    return null;
  }
  const decrypted = new TextDecoder().decode(decryptedBuf);
  const result = {};
  for (const pair of decrypted.split('&')) {
    const [k, v] = pair.split('=');
    if (k) result[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
  }
  return result;
}

// ---------- db.js ----------
// ---------- Customers ----------

async function listCustomers(db) {
  const { results } = await db.prepare('SELECT * FROM customers ORDER BY id DESC').all();
  return results;
}

async function createCustomer(db, { name, contact, note }) {
  const res = await db.prepare('INSERT INTO customers (name, contact, note) VALUES (?, ?, ?)')
    .bind(name, contact || null, note || null).run();
  return getCustomer(db, res.meta.last_row_id);
}

async function getCustomer(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
}

async function updateCustomer(db, id, fields) {
  const allowed = ['name', 'contact', 'note'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  if (!sets.length) return getCustomer(db, id);
  values.push(id);
  await db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?').bind(...values).run();
  return getCustomer(db, id);
}

async function deleteCustomer(db, id) {
  await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
}

// ---------- Products ----------

async function listProducts(db) {
  const { results } = await db.prepare('SELECT * FROM products ORDER BY id ASC').all();
  return results;
}

async function createProduct(db, { name, price, billing_cycle, active }) {
  const res = await db.prepare('INSERT INTO products (name, price, billing_cycle, active) VALUES (?, ?, ?, ?)')
    .bind(name, price, billing_cycle || 'one_time', active === false ? 0 : 1).run();
  return getProduct(db, res.meta.last_row_id);
}

async function getProduct(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
}

async function updateProduct(db, id, fields) {
  const allowed = ['name', 'price', 'billing_cycle', 'active'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]); }
  }
  if (!sets.length) return getProduct(db, id);
  values.push(id);
  await db.prepare('UPDATE products SET ' + sets.join(', ') + ' WHERE id = ?').bind(...values).run();
  return getProduct(db, id);
}

async function deleteProduct(db, id) {
  await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
}

// ---------- Orders ----------

async function listOrders(db, { status } = {}) {
  if (status) {
    const { results } = await db.prepare(
      `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
       FROM orders
       LEFT JOIN customers ON customers.id = orders.customer_id
       LEFT JOIN products ON products.id = orders.product_id
       WHERE orders.status = ?
       ORDER BY orders.id DESC`
    ).bind(status).all();
    return results;
  }
  const { results } = await db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     ORDER BY orders.id DESC`
  ).all();
  return results;
}

async function getOrder(db, id) {
  return db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     WHERE orders.id = ?`
  ).bind(id).first();
}

async function getOrderByOrderNo(db, orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
}

function generateOrderNo() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return 'ORD' + stamp + rand;
}

async function createOrder(db, { customer_id, product_id, amount, note }) {
  const orderNo = generateOrderNo();
  const res = await db.prepare(
    'INSERT INTO orders (order_no, customer_id, product_id, amount, note, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(orderNo, customer_id || null, product_id || null, amount, note || null, 'pending').run();
  return getOrder(db, res.meta.last_row_id);
}

async function updateOrderStatus(db, id, { status, payment_type }) {
  const paidAt = status === 'paid' ? new Date().toISOString() : null;
  await db.prepare('UPDATE orders SET status = ?, payment_type = COALESCE(?, payment_type), paid_at = COALESCE(?, paid_at) WHERE id = ?')
    .bind(status, payment_type || null, paidAt, id).run();
  return getOrder(db, id);
}

async function markOrderPaidByOrderNo(db, orderNo, { payment_type } = {}) {
  await db.prepare("UPDATE orders SET status = 'paid', payment_type = COALESCE(?, payment_type), paid_at = ? WHERE order_no = ?")
    .bind(payment_type || null, new Date().toISOString(), orderNo).run();
  return getOrderByOrderNo(db, orderNo);
}

// ---------- Dashboard ----------

async function getDashboardStats(db) {
  const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const revenueRow = await db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?"
  ).bind(monthPrefix).first();
  const paidCountRow = await db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?"
  ).bind(monthPrefix).first();
  const pendingRow = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").first();
  const { results: recentOrders } = await db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     ORDER BY orders.id DESC LIMIT 8`
  ).all();
  return {
    monthlyRevenue: revenueRow ? revenueRow.total : 0,
    monthlyPaidOrders: paidCountRow ? paidCountRow.n : 0,
    pendingOrders: pendingRow ? pendingRow.n : 0,
    recentOrders,
  };
}

// db.js 原本是用 `import * as db` 呼叫，這裡重建一個等價的 db 物件，
// 讓下面 adminRoutes.js 的 db.xxx(...) 呼叫方式維持不變。
const db = {
  listCustomers,
  createCustomer,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  listOrders,
  getOrder,
  getOrderByOrderNo,
  createOrder,
  updateOrderStatus,
  markOrderPaidByOrderNo,
  getDashboardStats,
};

// ---------- adminRoutes.js ----------
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

async function requireAdmin(request, env) {
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

async function handleLogin(request, env, body) {
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
async function handleDashboard(request, env) {
  await requireAdmin(request, env);
  return db.getDashboardStats(requireDb(env));
}

// ---------- Customers ----------
async function handleListCustomers(request, env) {
  await requireAdmin(request, env);
  return { customers: await db.listCustomers(requireDb(env)) };
}

async function handleCreateCustomer(request, env, body) {
  await requireAdmin(request, env);
  if (!body || !body.name) throw adminBadRequest('請填寫客戶姓名');
  return db.createCustomer(requireDb(env), body);
}

async function handleUpdateCustomer(request, env, body, params) {
  await requireAdmin(request, env);
  return db.updateCustomer(requireDb(env), params.id, body || {});
}

async function handleDeleteCustomer(request, env, body, params) {
  await requireAdmin(request, env);
  await db.deleteCustomer(requireDb(env), params.id);
  return { ok: true };
}

// ---------- Products ----------
async function handleListProducts(request, env) {
  await requireAdmin(request, env);
  return { products: await db.listProducts(requireDb(env)) };
}

async function handleCreateProduct(request, env, body) {
  await requireAdmin(request, env);
  if (!body || !body.name || typeof body.price !== 'number') throw adminBadRequest('請填寫商品名稱與價格');
  return db.createProduct(requireDb(env), body);
}

async function handleUpdateProduct(request, env, body, params) {
  await requireAdmin(request, env);
  return db.updateProduct(requireDb(env), params.id, body || {});
}

async function handleDeleteProduct(request, env, body, params) {
  await requireAdmin(request, env);
  await db.deleteProduct(requireDb(env), params.id);
  return { ok: true };
}

// ---------- Orders ----------
async function handleListOrders(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  return { orders: await db.listOrders(requireDb(env), { status }) };
}

async function handleCreateOrder(request, env, body) {
  await requireAdmin(request, env);
  if (!body || typeof body.amount !== 'number') throw adminBadRequest('請填寫訂單金額');
  return db.createOrder(requireDb(env), body);
}

async function handleUpdateOrderStatus(request, env, body, params) {
  await requireAdmin(request, env);
  if (!body || !['pending', 'paid', 'failed', 'cancelled'].includes(body.status)) {
    throw adminBadRequest('狀態必須是 pending / paid / failed / cancelled 其中之一');
  }
  return db.updateOrderStatus(requireDb(env), params.id, body);
}

// ---------- 藍新金流：建立付款請求（給前端「前往付款」按鈕用）----------
async function handleCreatePayment(request, env, body) {
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
async function handleNewebpayNotify(request, env) {
  if (!env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) {
    return new Response('Not configured', { status: 500 });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const tradeInfo = form.get('TradeInfo');
  const tradeSha = form.get('TradeSha');
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

// ---------- index.js ----------
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
  if (!question) throw badRequest('請輸入問題內容');
  const messages = buildFollowupMessages({ event, question });
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
