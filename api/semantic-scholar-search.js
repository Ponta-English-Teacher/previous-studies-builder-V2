const { forwardUpstreamError, networkErrorResponse } = require('./_lib/errors');
const { fetchWithRetry } = require('./_lib/semanticScholarThrottle');

// Proxies Semantic Scholar paper search so the API key never reaches the browser.
// Expects: GET /api/semantic-scholar-search?topic=...
// Semantic Scholar's search endpoint works without a key (lower rate limit),
// so a missing key is not a hard failure here -- we still perform the search
// and attach a "warning" field so the UI/console can surface a clear notice.
//
// Outgoing requests are throttled to under 1/second (cumulative, per the
// Semantic Scholar rate limit) and retried with exponential backoff on 429
// before giving up -- see api/_lib/semanticScholarThrottle.js.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const topic = req.query && req.query.topic;
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Query parameter "topic" is required.' });
  }

  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const warning = apiKey
    ? undefined
    : 'SEMANTIC_SCHOLAR_API_KEY is not set. Searching without a key using the public rate limit. Add SEMANTIC_SCHOLAR_API_KEY to .env.local for higher limits.';

  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(topic)}&limit=3&fields=title,authors,year,url,abstract,journal`;

  try {
    const upstream = await fetchWithRetry(url, {
      headers: apiKey ? { 'x-api-key': apiKey } : {}
    });

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return res.status(429).json({
          error: 'Semantic Scholar is still rate-limiting requests after several retries. Please wait a minute and try again.',
          service: 'Semantic Scholar'
        });
      }
      if (apiKey && (upstream.status === 401 || upstream.status === 403)) {
        return res.status(502).json({
          error: 'Semantic Scholar rejected the request: the API key is invalid or expired. Check SEMANTIC_SCHOLAR_API_KEY, or remove it to fall back to the public (unauthenticated) rate limit.',
          service: 'Semantic Scholar'
        });
      }
      return forwardUpstreamError(res, upstream, 'Semantic Scholar');
    }

    const data = await upstream.json();
    return res.status(200).json({ data: data.data || [], warning });
  } catch (err) {
    return networkErrorResponse(res, err, 'Semantic Scholar');
  }
};
