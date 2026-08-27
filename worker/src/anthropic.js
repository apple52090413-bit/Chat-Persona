const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 90000;

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

function isValidToolInput(input, requiredKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return requiredKeys.every(key => input[key] !== undefined && input[key] !== null);
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
export async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
  const requiredKeys = (tool.input_schema && tool.input_schema.required) || [];
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
    if (toolUse && isValidToolInput(toolUse.input, requiredKeys)) {
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
export async function callClaudePlain({ apiKey, model, system, messages, maxTokens }) {
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
