// No time limit on AI calls (Kevin, 2026-11-08): the app waits as long as ClewdR takes, so a show measures real
// timings instead of cutting slow calls off. Every call still logs its time and token counts, and the director can
// stop a running plan or script with Pause, or a plan with a correction. Limits outside the app still apply: the homelab proxy in
// front of ClewdR ends a call after 10 minutes, and Railway closes a page's request after 5 minutes with no data
// moving. The server keeps working when that happens and the result reaches the page over its live connection.
export const AI_CALL_TIMEOUT_MS: number | null = null;

// The same for one whole AI request, across its attempts and the save.
export const AI_REQUEST_BUDGET_MS: number | null = null;
