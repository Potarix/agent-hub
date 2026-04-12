const { makeRequest, makeStreamRequest } = require('../lib/http');

async function chatOpenAI(agent, messages) {
  const url = `${agent.baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages,
    max_tokens: agent.maxTokens || 16384,
    temperature: agent.temperature ?? 0.7,
  });
  const res = await makeRequest(url, { method: 'POST', headers }, body);
  const data = JSON.parse(res.body);
  if (res.status !== 200) return { error: data.error?.message || res.body };
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content || '',
    thinking: msg?.reasoning_content || null,
  };
}

async function streamOpenAI(event, requestId, agent, messages) {
  const url = `${agent.baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages,
    max_tokens: agent.maxTokens || 16384,
    temperature: agent.temperature ?? 0.7,
    stream: true,
  });
  await makeStreamRequest(url, { method: 'POST', headers }, body, event, requestId);
}

module.exports = { chatOpenAI, streamOpenAI };
