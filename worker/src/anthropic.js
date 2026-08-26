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

function isValidToolInput(input, requiredKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return requiredKeys.every(key => input[key] !== undefined && input[key] !== null);
}

const RETRY_NUDGE = '（上一次的回覆格式不完整或把內容誤塞進單一欄位，這次請務必透過 tool use 把每一個欄位都個別正確填寫成對應的型別，不要把其他欄位的內容寫成文字塞進某一個欄位裡，也不要用 XML 或其他格式，只能用工具呼叫本身的結構化參數。）';

// Forces a structured JSON response by requiring the model to call a single tool.
// Retries once (with a corrective nudge) if the model's tool call is missing
// required fields or malforms the arguments — this does happen occasionally
// with complex nested schemas, especially on very short/sparse input.
export async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
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
export async function callClaudePlain({ apiKey, model, system, messages, maxTokens }) {
  const data = await postToAnthropic(apiKey, {
    model,
    max_tokens: maxTokens || 400,
    system,
    messages,
  });
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}
