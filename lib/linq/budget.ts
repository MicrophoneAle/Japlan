// How long a Linq call is allowed to take. Its own module on purpose: tests
// routinely stub `./client` (it pulls in the SDK), and a budget that came
// through the stub would arrive undefined, turning every timeout into 0ms.
// Nothing here imports the SDK, so nobody has a reason to mock it.
//
// Every Linq call is on the webhook path, inside `after()`, under
// maxDuration=60. The SDK ships with no per-request timeout and maxRetries=2,
// so one unresponsive socket used to hang the whole dispatch: the person got
// nothing back and the log just stopped, which is the exact shape of the
// outages we keep chasing. A bounded failure is recoverable, silence is not.

// Per HTTP attempt. Aborts the underlying fetch, so it covers the direct
// client users too (chats.retrieve in bootstrap, polls in group-decisions,
// live location), not just the send helpers.
export const LINQ_REQUEST_TIMEOUT_MS = 6_000;

// One retry, not two. A send that has already burned 6s has to leave room for
// the rest of the dispatch.
export const LINQ_MAX_RETRIES = 1;

// Ceiling on a whole operation, retry included. The SDK's own timer does not
// cover the backoff between attempts, a hang before the fetch starts, or a
// helper that makes two calls in one op (markRead does), so this bounds the
// wall clock the caller actually waits.
export const LINQ_OP_TIMEOUT_MS =
  LINQ_REQUEST_TIMEOUT_MS * (LINQ_MAX_RETRIES + 1) + 2_000;
