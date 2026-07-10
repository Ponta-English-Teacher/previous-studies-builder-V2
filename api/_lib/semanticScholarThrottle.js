// Keeps all outgoing Semantic Scholar requests from this serverless instance
// under the documented 1 request/second cap (cumulative across endpoints),
// and retries 429s with exponential backoff.
//
// Note: state here is per warm serverless container, not global across every
// concurrent Vercel instance. For this app's traffic (a single student's
// browser tab at a time) that keeps us comfortably under the limit; it is not
// a distributed rate limiter.

const MIN_INTERVAL_MS = 1100; // > 1000ms so we stay under 1 request/second
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

let requestQueue = Promise.resolve();
let lastRequestTime = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Serializes every outgoing request through this function so no two fire
// less than MIN_INTERVAL_MS apart, even if invocations overlap.
function scheduleThrottled(task) {
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, lastRequestTime + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();
    return task();
  });
  requestQueue = run.catch(() => {}); // keep the chain alive even if this task rejects
  return run;
}

/**
 * Fetches through the shared throttle, retrying on HTTP 429 with exponential
 * backoff (honoring a Retry-After header when Semantic Scholar sends one).
 * Always returns the final Response with its body unread, so the caller can
 * read it exactly once.
 */
async function fetchWithRetry(url, options, { maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  let attempt = 0;
  for (;;) {
    const response = await scheduleThrottled(() => fetch(url, options));

    if (response.status !== 429 || attempt >= maxRetries) {
      return response;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);

    try {
      await response.text(); // drain the discarded response body
    } catch (_) {
      // ignore
    }

    await sleep(backoffMs);
    attempt++;
  }
}

module.exports = { fetchWithRetry };
