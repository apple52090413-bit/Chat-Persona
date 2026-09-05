// ============================================================
// Chat Persona API — 單檔打包版（給 Cloudflare Dashboard 線上編輯器用）
// 這個檔案是 worker/src/*.js 自動合併產生的，內容完全相同，
// 只是把所有檔案的 import/export 拆解合併成一份方便貼上。
// 如果你有終端機可以用 wrangler 部署，請改用 worker/src/ 底下的原始檔案。
// ============================================================

// ---------- validate.js ----------
const FREE_TEXT_LIMIT = 80000;
const PAID_TEXT_LIMIT = 600000;
const MAX_IMAGES = 8;

// 免費版／付費版超過字數上限時直接擋下，不做「只取最近一段」的靜默截斷 ——
// 靜默截斷會讓使用者以為分析涵蓋了全部內容，但其實 AI 根本沒讀到前面的部分。
function assertWithinTextLimit(text, limit) {
  if (text && text.length > limit) {
    const err = new Error(`內容有 ${text.length.toLocaleString()} 字，超過 ${limit.toLocaleString()} 字上限`);
    err.status = 400;
    err.isValidation = true;
    err.code = 'TEXT_TOO_LONG';
    err.charCount = text.length;
    err.limit = limit;
    throw err;
  }
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
const REQUEST_TIMEOUT_MS = 240000; // 付費版最多要吃 60 萬字輸入＋較長的輸出，需要更多緩衝時間

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 呼叫 Anthropic API，遇到逾時／429／5xx 會自動重試一次（等一下再試，
// 通常就是暫時性問題）；4xx（例如請求格式錯誤）不會重試，因為重試也不會成功。
async function postToAnthropic(apiKey, body) {
  const maxAttempts = 2;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return await res.json();

      const errText = await res.text().catch(() => '');
      const err = new Error('Anthropic API error ' + res.status + ': ' + errText.slice(0, 500));
      err.status = res.status;
      err.isUpstream = true;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts - 1) throw err;
      lastErr = err;
    } catch (err) {
      if (err.name === 'AbortError') {
        lastErr = Object.assign(new Error('AI 分析逾時未回應，請稍後再試一次'), { isUpstream: true, status: 504 });
      } else if (err.isUpstream) {
        throw err; // 已經在上面判斷過不需要重試
      } else {
        lastErr = err; // fetch 本身失敗（網路層級），值得重試一次
      }
      if (attempt === maxAttempts - 1) throw lastErr;
    } finally {
      clearTimeout(timer);
    }
    await sleep(1200 * (attempt + 1));
  }
  throw lastErr;
}

// 遞迴檢查 tool_use 回傳的資料是不是真的符合 schema —— 不能只看最外層的
// 必填欄位有沒有出現，因為之前發生過「conflict 這個物件本身有出現，但裡面
// 的 tags 陣列漏掉了」這種情況：最外層檢查會誤判為合法，畫面卻因為
// d.conflict.tags.map(...) 對 undefined 呼叫方法而整個爛掉一半。
// 這裡沿著 schema 的 properties／items 往下走，任何一層漏了必填欄位、
// 陣列缺元素（不足 minItems）都會被抓出來，觸發下面的重試機制。
function isValidToolInput(input, schema) {
  if (!schema) return true;
  if (schema.type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    for (const key of schema.required || []) {
      if (input[key] === undefined || input[key] === null) return false;
    }
    for (const key of Object.keys(schema.properties || {})) {
      if (input[key] !== undefined && !isValidToolInput(input[key], schema.properties[key])) return false;
    }
    return true;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(input)) return false;
    if (schema.minItems !== undefined && input.length < schema.minItems) return false;
    if (schema.items) {
      for (const item of input) {
        if (!isValidToolInput(item, schema.items)) return false;
      }
    }
    return true;
  }
  // 基本型別（string/integer/number）不特別驗型別是否精確吻合 ——
  // 欄位存在與否、結構是否完整才是真正會讓畫面爛掉的原因。
  return true;
}

function addUsage(total, usage) {
  if (!usage) return total;
  return {
    input_tokens: total.input_tokens + (usage.input_tokens || 0),
    output_tokens: total.output_tokens + (usage.output_tokens || 0),
  };
}

const RETRY_NUDGE = '（上一次的回覆格式不完整或把內容誤塞進單一欄位，這次請務必透過 tool use 把每一個欄位都個別正確填寫成對應的型別，不要把其他欄位的內容寫成文字塞進某一個欄位裡，也不要用 XML 或其他格式，只能用工具呼叫本身的結構化參數。）';

// Forces a structured JSON response by requiring the model to call a single tool.
// Retries once (with a corrective nudge) if the model's tool call is missing
// required fields or malforms the arguments — this does happen occasionally
// with complex nested schemas, especially on very short/sparse input.
// Returns { result, usage } — usage is accumulated across both attempts,
// since both are billed by Anthropic even if only the second one succeeds.
async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
  let lastToolUse = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

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
    usage = addUsage(usage, data.usage);
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
    if (toolUse) lastToolUse = toolUse;
    if (toolUse && isValidToolInput(toolUse.input, tool.input_schema)) {
      return { result: toolUse.input, usage };
    }
  }

  console.error('Invalid tool_use input after retry:', JSON.stringify(lastToolUse).slice(0, 1000));
  const err = new Error('AI 回傳的分析格式不完整，請重試一次。');
  err.usage = usage; // 兩次嘗試都算過錢了，即使失敗也要讓呼叫端能記錄花費
  throw err;
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
// Returns { result, usage }.
async function callClaudePlain({ apiKey, model, system, messages, maxTokens }) {
  const data = await postToAnthropic(apiKey, {
    model,
    max_tokens: maxTokens || 400,
    system,
    messages,
  });
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return {
    result: textBlock ? textBlock.text : '',
    usage: data.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

// ---------- prompts.js ----------
const SYSTEM_PROMPT_BASE = `你是「聊天人格分析」網站背後的分析引擎。你的任務是根據使用者提供的真實聊天紀錄，做語氣、互動模式與關係動態的分析。規則：
1. 全程使用繁體中文（台灣用語）。
2. 【隱私保護，最高優先，任何情況都不能違反】對話原文裡如果出現使用者本人或對方的真實姓名、暱稱、綽號、帳號、電話、Email、地址、學校或公司全名等可以直接指認身份的資訊，你回傳的所有文字欄位（包含摘要、洞察、事件描述、原文摘錄等）一律不能原樣照抄這些身份資訊。提到使用者本人永遠只能稱「你」，提到對話中的另一方永遠只能稱「對方」——即使原文裡雙方是用真實姓名、綽號或暱稱互相稱呼，你也絕對不能把那個名字寫進回覆的任何欄位裡，包含看起來像是「原文引用」的欄位也一樣，要先換成「你」/「對方」再寫進去。如果原文裡有其他具體到可以指認身份的細節（例如完整地址、特定門牌、電話號碼、罕見的地標全名），也要用模糊、概括的方式改寫（例如「住的地方附近」「一間咖啡廳」），但不影響你對事件經過、情緒、互動模式本身的描述與解讀——你分析的是「發生了什麼、代表什麼意義」，不是要留存對話雙方的身份細節。
3. 分析必須基於你實際讀到的文字內容，不能憑空捏造與內容矛盾的細節；文字沒有明確資訊的地方（例如確切訊息則數），可以合理估算。
4. 語氣自然、像懂心理學又懂聊天的朋友在幫忙解讀，不要說教、不要條列免責聲明、不要提到「我是AI」或「這是示範」。
5. 給分數時要根據實際觀察到的傾向給出有區分度的數字，不要每項都給 50 附近的安全值。
6. 一律透過提供的工具（tool use）回傳結構化結果，不要在工具呼叫之外輸出任何文字。
7. 如果對話內容過短或資訊不足，仍要盡力給出合理推論，並讓數字/描述反映內容確實較單薄的狀況，不要因此拒絕分析。`;

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
      otherPartyAliases: {
        type: 'array',
        items: { type: 'string' },
        description: '對話原文中用來稱呼「對話中另一方」（不是使用者本人）的真實姓名、綽號或暱稱，把你在對話裡實際看到的每一種稱呼方式都列出來（同一個人可能被叫好幾種名字都要列）。如果對話中完全沒有出現對方的姓名或綽號，回傳空陣列。這個欄位只是給系統做隱私遮蔽用，不會直接顯示給使用者看，跟上面 insight 等欄位裡是否已經避開姓名無關——不管你上面寫得如何，這裡都要盡量列出你看到的所有稱呼。',
      },
    },
    required: ['personaCode', 'messageCount', 'scores', 'keywords', 'insight', 'monthLabels', 'monthlySentenceCounts', 'monthlyMessageCounts', 'otherPartyAliases'],
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

請選出最符合的一種，並呼叫 submit_persona_analysis 工具回傳完整結果。

再次提醒：下面的對話原文裡不管雙方實際上是用什麼真實姓名或綽號互相稱呼，你回傳的欄位裡提到使用者本人一律寫「你」、提到對話中的另一方一律寫「對方」，絕對不能把對話中出現的真實姓名或綽號寫進 insight 或其他任何欄位。${conversationBlock(text)}`;
  content.push({ type: 'text', text: instructions });
  return [{ role: 'user', content }];
}

// ---------- 付費版：兩人關係深度分析 ----------

const personProfileSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', description: '一個簡短的個性標籤，例如「直球型」「幽默型」，可自由發想' },
    traits: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    description: { type: 'string', description: '2 句話左右的個性描述，需具體描述對話中觀察到的互動模式（但不能直接引用對話原文裡雙方互相稱呼的姓名或綽號，一律用「你」/「對方」代稱）' },
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
      description: '從原始對話中擷取一小段（100-250字內）跟這個事件最相關的內容重點。這段文字之後會被單獨保存，使用者針對這個事件追問時只會用這段當上下文，不會重新讀取整份對話，所以要包含足夠的具體細節（例如關鍵句子、語氣、雙方怎麼說的），不要只是重複 summary 的空泛敘述。⚠️ 這裡不是逐字複製對話原文——如果原文裡雙方是用真實姓名或綽號互相稱呼，寫進這裡之前要先換成「你」/「對方」，句子內容跟語氣可以保留，但身份資訊不行。',
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
      description: '從原始對話中擷取一小段（100-250字內）跟這個時刻最相關的內容重點，用途同 timeline 事件的 relevantExcerpt——之後使用者追問只會用這段當上下文。如果對話中確實找不到對應內容，可以填空字串。同樣要注意：不能逐字複製原文中雙方互相稱呼的真實姓名或綽號，一律先換成「你」/「對方」再寫進來。',
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
      personAAliases: {
        type: 'array',
        items: { type: 'string' },
        description: '對話原文中用來稱呼「使用者本人」（也就是 personA）的真實姓名、綽號或暱稱，把你在對話裡實際看到的每一種稱呼方式都列出來（同一個人可能被叫好幾種名字都要列）。如果完全沒有出現，回傳空陣列。這個欄位只是給系統做隱私遮蔽用，不會直接顯示給使用者看——不管你上面其他欄位寫得如何，這裡都要盡量列出你看到的所有稱呼。',
      },
      personBAliases: {
        type: 'array',
        items: { type: 'string' },
        description: '對話原文中用來稱呼「對方」（也就是 personB）的真實姓名、綽號或暱稱，把你在對話裡實際看到的每一種稱呼方式都列出來。如果完全沒有出現，回傳空陣列。這個欄位只是給系統做隱私遮蔽用，不會直接顯示給使用者看。',
      },
    },
    required: [
      'chemistryScore', 'totalMessages', 'personA', 'personB', 'conflict', 'interactionSplit',
      'keywords', 'stickerMoodA', 'stickerMoodB', 'monthLabels', 'monthlyMessageCounts',
      'temperatureTrend', 'timeline', 'milestoneInterpretations', 'personalInsight', 'overallInsight', 'followUpQuestions',
      'personAAliases', 'personBAliases',
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

請呼叫 submit_relationship_analysis 工具回傳結果。全部使用繁體中文，語氣像朋友幫忙解讀對話一樣自然，不要客套或說教，數字要有區分度、符合實際觀察。

再次提醒：下面的對話原文裡不管雙方實際上是用什麼真實姓名或綽號互相稱呼，你回傳的每一個欄位（personA/personB 的描述、conflict、timeline 的 summary/interpretation/relevantExcerpt、milestoneInterpretations、personalInsight、overallInsight 全部包含在內）提到使用者本人一律寫「你」、提到另一方一律寫「對方」，絕對不能把對話中出現的真實姓名或綽號原封不動寫進任何欄位。${conversationBlock(text)}`;
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

提到使用者本人一律稱「你」、提到另一方一律稱「對方」，就算使用者補充回答裡自己打了真實姓名或綽號，也不要把那個名字寫進新的兩段文字裡。

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
  text += '\n\n請用 2-4 句話、朋友聊天般自然的語氣直接回答使用者的問題，不要條列、不要開場白，直接進主題。全部使用繁體中文，不要提到「示範」或「正式版」。如果上面的摘錄不足以回答問題，可以老實說目前資料不夠判斷，不要憑空編造細節。提到使用者本人一律稱「你」、提到另一方一律稱「對方」，不要在回覆裡寫出任何真實姓名或綽號。';
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

// ---------- privacy.js ----------
// 隱私遮蔽的「保險層」：prompts.js 裡已經有很明確的指示要求 AI 不要把真實
// 姓名/綽號寫進回覆內容，但那終究是機率性的（AI 有可能忘記、尤其是長對話）。
// 這裡加一層決定性的保護——請 AI 額外回報「對話裡用什麼稱呼指這個人」
// （personAAliases / personBAliases / otherPartyAliases），拿到之後不管
// AI 本來寫的內容有沒有照規則做，程式碼都會把這些稱呼從回傳結果的每一個
// 字串欄位裡強制換成「你」／「對方」，不依賴 AI 自己是否遵守指示。

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 只保留看起來像真的姓名/綽號的字串：至少 2 個字，且不是「你」「對方」「我」
// 這種本來就該用的代稱（避免誤判把正常代稱也拿去做全文取代，弄壞其他句子）。
function sanitizeAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  const skip = new Set(['你', '我', '他', '她', '對方', '妳']);
  return aliases
    .filter(a => typeof a === 'string')
    .map(a => a.trim())
    .filter(a => a.length >= 2 && !skip.has(a));
}

function redactValue(value, aliasMap) {
  if (typeof value === 'string') {
    let out = value;
    for (const [alias, replacement] of aliasMap) {
      out = out.replace(new RegExp(escapeRegex(alias), 'gi'), replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(v => redactValue(v, aliasMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactValue(value[key], aliasMap);
    return out;
  }
  return value;
}

// aliasGroups 例如 [{ aliases: result.personAAliases, replacement: '你' }, { aliases: result.personBAliases, replacement: '對方' }]
// 回傳一份新的物件（不修改原本的 result），並把 *Aliases 這種只給系統內部用的
// 欄位拿掉，不需要讓前端看到。
// aliasFieldNames：result 裡面「別名清單本身」放在哪幾個 key（例如
// personAAliases/personBAliases）。這幾個欄位要從取代範圍裡排除，不然清單
// 自己列出的名字會被規則自己取代掉（例如 personBAliases:['小美'] 變成
// ['對方']），之後 refine／followup 想沿用同一份名單就找不到原始名字了。
function redactAliasesFromResult(result, aliasGroups, aliasFieldNames = []) {
  const pairs = [];
  for (const { aliases, replacement } of aliasGroups) {
    for (const alias of sanitizeAliases(aliases)) pairs.push([alias, replacement]);
  }
  // 長的稱呼先換，避免短稱呼剛好是長稱呼的一部分，把長稱呼提前拆散。
  pairs.sort((a, b) => b[0].length - a[0].length);

  if (!pairs.length) return { ...result };

  const preserved = {};
  const toRedact = { ...result };
  for (const field of aliasFieldNames) {
    if (field in toRedact) {
      preserved[field] = toRedact[field];
      delete toRedact[field];
    }
  }

  return { ...redactValue(toRedact, pairs), ...preserved };
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

// WebCrypto's 'AES-CBC' always validates PKCS7 padding on decrypt and throws
// if the final block's padding isn't well-formed. That's a problem if
// NewebPay's own encryption of the Notify/Return TradeInfo doesn't produce
// standard PKCS7 padding (e.g. a zero-padded or already block-aligned
// payload) - live testing hit exactly this failure even after confirming
// (via a passing TradeSha, which could only match with the correct key/iv)
// that the key material itself is right.
//
// Workaround: append one extra block that WE encrypt with valid PKCS7
// padding (continuing the CBC chain from the real ciphertext's last block),
// so the built-in padding check passes on that appended block, then keep
// only the first N bytes of the output (the real ciphertext's decrypted
// bytes are unaffected by whatever comes after them in CBC mode).
async function decryptAesCbcTolerant(key, iv, ciphertext) {
  const blockSize = 16;
  const prevBlock = ciphertext.length >= blockSize ? ciphertext.slice(ciphertext.length - blockSize) : iv;
  const paddingBlock = new Uint8Array(blockSize).fill(blockSize);
  const dummyCipherFull = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: prevBlock }, key, paddingBlock));
  const extended = new Uint8Array(ciphertext.length + blockSize);
  extended.set(ciphertext, 0);
  extended.set(dummyCipherFull.slice(0, blockSize), ciphertext.length);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, extended));
  return plain.slice(0, ciphertext.length);
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
  // 藍新的公式是 HashKey=<key>&<原始 TradeInfo 值>&HashIV=<iv> —— 中間沒有
  // 「TradeInfo=」這個欄位名稱，只是把加密結果直接接在兩個 & 中間。
  const tradeSha = await sha256Hex(`HashKey=${hashKey}&${tradeInfo}&HashIV=${hashIv}`);
  return { tradeInfo, tradeSha };
}

// 驗證＋解密藍新背景通知（Notify URL）送回來的 TradeInfo / TradeSha。
// 回傳解密後的參數物件（例如 { Status, MerchantOrderNo, TradeAmt, PaymentType, ... }），
// 如果檢查碼不對會回傳 null（代表這筆通知可能被竄改，不可信任）。
async function verifyAndDecryptNotify({ hashKey, hashIv, tradeInfo, tradeSha }) {
  const { result } = await verifyAndDecryptNotifyDiagnostic({ hashKey, hashIv, tradeInfo, tradeSha });
  return result;
}

// 跟上面一樣，但同時回傳一個簡短、不含金鑰/完整雜湊值的失敗原因代碼
// （sha_mismatch / decrypt_fail），方便在還沒辦法順利看到 Cloudflare Logs
// 的情況下，直接把原因帶回前端畫面顯示出來除錯。
async function verifyAndDecryptNotifyDiagnostic({ hashKey, hashIv, tradeInfo, tradeSha }) {
  const expectedSha = await sha256Hex(`HashKey=${hashKey}&${tradeInfo}&HashIV=${hashIv}`);
  if (expectedSha !== (tradeSha || '').toUpperCase()) {
    console.log('[newebpay] TradeSha mismatch:', JSON.stringify({ expectedSha, receivedSha: tradeSha, tradeInfoLength: (tradeInfo || '').length }));
    return { result: null, reason: 'sha_mismatch:exp' + expectedSha.slice(0, 6) + ':got' + (tradeSha || '').slice(0, 6) };
  }

  // TradeSha 通過了，代表 hashKey/hashIv 這兩個值本身是對的（NewebPay 用同樣
  // 的字串才會算出一樣的雜湊）；如果接下來 AES 解密還是失敗，問題應該出在
  // tradeInfo 這個 16 進位字串本身有問題（長度不是偶數、含非 16 進位字元等），
  // 先做個檢查，把診斷資訊直接附進失敗原因，不用再靠 log。
  const hexLen = (tradeInfo || '').length;
  const isValidHex = /^[0-9a-fA-F]+$/.test(tradeInfo || '');
  const key = await importAesKey(hashKey);
  const iv = new TextEncoder().encode(hashIv);
  const ciphertext = fromHex(tradeInfo);
  let decryptedBuf;
  let usedTolerant = false;
  try {
    decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  } catch (err) {
    // 標準 PKCS7 驗證失敗——嘗試繞過填充檢查再解一次，因為簽章已經證明金鑰是對的，
    // 唯一合理的解釋是藍新這邊送出的加密內容本身不是標準 PKCS7 填充。
    try {
      decryptedBuf = await decryptAesCbcTolerant(key, iv, ciphertext);
      usedTolerant = true;
    } catch (err2) {
      const diag = 'len' + hexLen + '_hex' + (isValidHex ? '1' : '0') + '_mod16-' + (hexLen % 32);
      console.log('[newebpay] AES decrypt failed (both strict and tolerant):', err.message, err2.message, diag);
      return { result: null, reason: 'decrypt_fail:' + diag + ':' + err.message.slice(0, 25) };
    }
  }
  // 沒有標準 PKCS7 填充可以拿掉時，結尾可能還留著一些填充用的位元組
  // （例如全部補 0），解成文字後把結尾這些看不見的控制字元清掉再切割欄位。
  let decrypted = new TextDecoder().decode(decryptedBuf);
  if (usedTolerant) decrypted = decrypted.replace(/[\x00-\x1f]+$/, '');

  // 解密後的內容格式跟 RespondType 有關：'String' 是 key=value&key=value，
  // 'JSON' 是 {"Status":...,"Message":...,"Result":{...實際交易欄位...}}。
  // 這裡兩種都接受，優先當 JSON 解析，失敗才當 key=value 字串解析。
  let result;
  try {
    const parsed = JSON.parse(decrypted);
    result = { Status: parsed.Status, Message: parsed.Message, ...(parsed.Result || {}) };
  } catch {
    result = {};
    for (const pair of decrypted.split('&')) {
      const [k, v] = pair.split('=');
      if (k) result[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
    }
  }
  if (usedTolerant) console.log('[newebpay] decrypted via tolerant (non-PKCS7) fallback:', JSON.stringify(result));
  return { result, reason: null, rawDecrypted: decrypted };
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
async function readTradeFields(request) {
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

async function getProductByName(db, name) {
  return db.prepare('SELECT * FROM products WHERE name = ? LIMIT 1').bind(name).first();
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

// 給客戶自助結帳流程用：一組隨機、無法猜測的權杖，付款完成從藍新導回本站後，
// 前端要拿這組權杖（不是只憑 order_no）跟後端確認這筆訂單真的已經付款，
// 避免有人自己編一個 order_no 或猜別人的訂單就解鎖付費功能。
function generateClientToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createOrder(db, { customer_id, product_id, amount, note }) {
  const orderNo = generateOrderNo();
  const clientToken = generateClientToken();
  const res = await db.prepare(
    'INSERT INTO orders (order_no, customer_id, product_id, amount, note, status, client_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(orderNo, customer_id || null, product_id || null, amount, note || null, 'pending', clientToken).run();
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
  const usage = await getUsageStats(db);
  return {
    monthlyRevenue: revenueRow ? revenueRow.total : 0,
    monthlyPaidOrders: paidCountRow ? paidCountRow.n : 0,
    pendingOrders: pendingRow ? pendingRow.n : 0,
    recentOrders,
    monthlyApiCalls: usage.monthlyApiCalls,
    monthlyInputTokens: usage.monthlyInputTokens,
    monthlyOutputTokens: usage.monthlyOutputTokens,
  };
}

// ---------- API 用量記錄 ----------
// 每一次呼叫 Claude API 都記一筆，orderId 可以是 null（例如免費版分析目前還沒有
// 對應的訂單）。這個表只是用來看花費趨勢，不影響任何分析結果本身。

async function logApiUsage(db, { orderId, endpoint, model, inputTokens, outputTokens }) {
  await db.prepare(
    'INSERT INTO api_usage (order_id, endpoint, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
  ).bind(orderId || null, endpoint, model, inputTokens || 0, outputTokens || 0).run();
}

async function getUsageStats(db) {
  const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const row = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input_total, COALESCE(SUM(output_tokens), 0) AS output_total
     FROM api_usage WHERE substr(created_at, 1, 7) = ?`
  ).bind(monthPrefix).first();
  return {
    monthlyApiCalls: row ? row.n : 0,
    monthlyInputTokens: row ? row.input_total : 0,
    monthlyOutputTokens: row ? row.output_total : 0,
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
  getProductByName,
  listOrders,
  getOrder,
  getOrderByOrderNo,
  createOrder,
  updateOrderStatus,
  markOrderPaidByOrderNo,
  getDashboardStats,
  logApiUsage,
  getUsageStats,
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

// ---------- payRoutes.js ----------
// ============================================================
// 客戶自助結帳（雙人關係報告，NT$99）
//
// 跟 adminRoutes.js 裡的藍新相關 handler 不一樣：這裡的 route 是給「一般訪客」
// 直接呼叫的，不需要登入後台。安全性靠的是 client_token（見 db.js），不是
// 帳號密碼 —— 每筆訂單建立時都會產生一組隨機權杖，只有拿得到這組權杖的人
// （也就是剛剛建立這筆訂單的那個瀏覽器分頁）才能查詢/確認這筆訂單的付款狀態。
// ============================================================

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
async function handleCreatePublicOrder(request, env) {
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
async function handlePayStatus(request, env) {
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
async function handleNewebpayReturn(request, env) {
  const redirectTo = (paid) => Response.redirect(SITE_URL + '/?paid=' + paid, 302);

  if (!env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) return redirectTo(0);

  const { tradeInfo, tradeSha } = await readTradeFields(request);
  if (!tradeInfo || !tradeSha) return redirectTo(0);

  // 用 …Diagnostic 版本（而不是簡化過的 verifyAndDecryptNotify）純粹是為了
  // 保留 console.log 診斷紀錄，方便未來萬一又出問題時查——但失敗原因不會
  // 再顯示在使用者畫面上了（之前串接除錯用，問題已解決，不該讓真正的顧客
  // 看到這些內部技術細節）。
  const { result: decoded, reason } = await verifyAndDecryptNotifyDiagnostic({
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    tradeInfo,
    tradeSha,
  });
  if (!decoded) {
    console.error('[newebpay] return verify failed:', reason);
    return redirectTo(0);
  }

  if (decoded.Status === 'SUCCESS' && decoded.MerchantOrderNo) {
    try {
      await db.markOrderPaidByOrderNo(payRequireDb(env), decoded.MerchantOrderNo, { payment_type: decoded.PaymentType });
    } catch (err) {
      console.error('markOrderPaidByOrderNo (return) failed:', err);
    }
    return redirectTo(1);
  }
  console.error('[newebpay] return decoded but not a success status:', decoded.Status, decoded.MerchantOrderNo);
  return redirectTo(0);
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

// 跟 index.html 裡 ?internal=chatpersona-team-preview-2026 用的是同一組通關密語
// （不是 ADMIN_PASSWORD，那個絕對不能出現在前端程式碼裡）。這裡只用來讓「網站
// 老闆自己內部測試/錄影片素材」的請求跳過付費版的字數上限，最壞情況就是有人
// 拿到這組密語去跑一次超長文字分析、多花一點 Claude API 費用，不是帳號或金流
// 安全性問題，風險等級跟前端那道門檻一致。
const INTERNAL_TEST_KEY = 'chatpersona-team-preview-2026';

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
  if (body.internalTestKey !== INTERNAL_TEST_KEY) assertWithinTextLimit(text, PAID_TEXT_LIMIT);
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
