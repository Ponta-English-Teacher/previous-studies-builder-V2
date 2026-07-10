const { missingKeyResponse, forwardUpstreamError, networkErrorResponse } = require('./_lib/errors');

// Proxies OpenAI chat completions so the API key never reaches the browser.
// Expects: POST { prompt: string, model?: string, temperature?: number, max_tokens?: number }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return missingKeyResponse(res, 'OPENAI_API_KEY', 'OpenAI');
  }

  const { prompt, model, temperature, max_tokens } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Request body must include a non-empty "prompt" string.' });
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: max_tokens || 800,
        temperature: temperature === undefined ? 0.7 : temperature
      })
    });

    if (!upstream.ok) {
      return forwardUpstreamError(res, upstream, 'OpenAI');
    }

    const data = await upstream.json();
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (!content) {
      return res.status(502).json({ error: 'OpenAI returned an unexpected response with no content.' });
    }

    return res.status(200).json({ content });
  } catch (err) {
    return networkErrorResponse(res, err, 'OpenAI');
  }
};
