const { makeRequest, makeStreamRequest } = require('../lib/http');

// Transform messages to handle image content
function transformMessagesForAPI(messages) {
  return messages.map(msg => {
    if (msg.images && msg.images.length > 0) {
      // For messages with images, use the multi-part content format
      const content = [
        { type: 'text', text: msg.content || '' }
      ];

      msg.images.forEach(img => {
        if (img.base64) {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`
            }
          });
        } else if (img.url) {
          content.push({
            type: 'image_url',
            image_url: { url: img.url }
          });
        }
      });

      return { ...msg, content, images: undefined };
    }
    return msg;
  });
}

async function chatOpenAI(agent, messages) {
  const url = `${agent.baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;

  // Transform messages to handle images
  const transformedMessages = transformMessagesForAPI(messages);

  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages: transformedMessages,
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

  // Transform messages to handle images
  const transformedMessages = transformMessagesForAPI(messages);

  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages: transformedMessages,
    max_tokens: agent.maxTokens || 16384,
    temperature: agent.temperature ?? 0.7,
    stream: true,
  });
  await makeStreamRequest(url, { method: 'POST', headers }, body, event, requestId);
}

module.exports = { chatOpenAI, streamOpenAI };
