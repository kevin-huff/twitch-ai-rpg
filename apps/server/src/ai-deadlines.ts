// The longest a single AI call may wait for a reply. Matches the most the provider accepts
// (its timeout limit is 120 seconds), so a slow call fails with a clear reason instead of hanging.
export const AI_CALL_TIMEOUT_MS = 120_000;

// The longest one whole AI request may take, across its attempts and the save. Railway closes a
// public request after 5 minutes with no data moving, and the server sets no request timeout of its
// own. Two full attempts plus the save must fit under that, so this stays below 5 minutes.
export const AI_REQUEST_BUDGET_MS = 250_000;
