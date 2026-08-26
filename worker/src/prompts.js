export const SYSTEM_PROMPT_BASE = `你是「聊天人格分析」網站背後的分析引擎。你的任務是根據使用者提供的真實聊天紀錄，做語氣、互動模式與關係動態的分析。規則：
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

export const PERSONA_TOOL = {
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

export function buildPersonaMessages({ text, images }) {
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

export const RELATIONSHIP_TOOL = {
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

export function buildRelationshipMessages({ text, images, relationshipType, milestones }) {
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

export const REFINE_TOOL = {
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

export function buildRefineMessages({ draft, answers }) {
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

export function buildFollowupMessages({ event, question }) {
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
