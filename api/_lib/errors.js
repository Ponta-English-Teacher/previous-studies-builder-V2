// Shared helpers for mapping upstream API failures to clear, safe messages.
// Files/folders prefixed with "_" are ignored by Vercel's routing, so this
// is safe to import from other files under /api without becoming its own route.

function missingKeyResponse(res, envVarName, serviceName) {
  return res.status(500).json({
    error: `Server misconfiguration: ${envVarName} is not set. Add it to .env.local for local development, or to your Vercel project's Environment Variables for deployment.`,
    service: serviceName
  });
}

async function forwardUpstreamError(res, upstreamResponse, serviceName) {
  let bodyText = '';
  try {
    bodyText = await upstreamResponse.text();
  } catch (_) {
    // ignore body read failure
  }

  if (upstreamResponse.status === 401 || upstreamResponse.status === 403) {
    return res.status(502).json({
      error: `${serviceName} rejected the request: the API key is invalid, expired, or lacks permission. Check the key in your environment variables.`,
      service: serviceName
    });
  }

  if (upstreamResponse.status === 429) {
    return res.status(429).json({
      error: `${serviceName} rate limit or quota exceeded. Wait a moment and try again, or check your ${serviceName} account/billing.`,
      service: serviceName
    });
  }

  return res.status(502).json({
    error: `${serviceName} request failed (status ${upstreamResponse.status}). Please try again shortly.`,
    service: serviceName,
    details: bodyText ? bodyText.slice(0, 500) : undefined
  });
}

function networkErrorResponse(res, err, serviceName) {
  console.error(`${serviceName} network error:`, err);
  return res.status(502).json({
    error: `Could not reach ${serviceName}. Check your network connection and try again.`,
    service: serviceName
  });
}

module.exports = { missingKeyResponse, forwardUpstreamError, networkErrorResponse };
