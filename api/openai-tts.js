const { missingKeyResponse, forwardUpstreamError, networkErrorResponse } = require('./_lib/errors');

// Proxies OpenAI text-to-speech so the API key never reaches the browser.
// Expects: POST { text: string, voice?: string }
// Responds with raw audio/mpeg bytes on success, or JSON { error } on failure.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return missingKeyResponse(res, 'OPENAI_API_KEY', 'OpenAI');
  }

  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Request body must include a non-empty "text" string.' });
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: voice || 'alloy',
        input: text
      })
    });

    if (!upstream.ok) {
      return forwardUpstreamError(res, upstream, 'OpenAI');
    }

    const arrayBuffer = await upstream.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (err) {
    return networkErrorResponse(res, err, 'OpenAI');
  }
};
