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
export async function callClaudeTool({ apiKey, model, system, messages, tool, maxTokens }) {
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
