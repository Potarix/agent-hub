const https = require('https');
const http = require('http');

function makeRequest(url, options, body) {
  const timeout = options.timeout || 120000;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function makeStreamRequest(url, options, body, event, requestId) {
  const timeout = options.timeout || 120000;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(url, options, (res) => {
      let buffer = '';
      let done = false;
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              if (!done) { done = true; event.sender.send('agent:stream-done', requestId, {}); }
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) event.sender.send('agent:stream-chunk', requestId, content);
              } catch (e) { /* skip */ }
            }
          }
        }
      });
      res.on('end', () => { if (!done) event.sender.send('agent:stream-done', requestId, {}); resolve(); });
    });
    req.on('error', (err) => { event.sender.send('agent:stream-error', requestId, err.message); reject(err); });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { makeRequest, makeStreamRequest };
