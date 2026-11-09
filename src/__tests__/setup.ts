// Never let a developer's real credentials or mode leak into the suite.
for (const key of ['FOUNDU_ACCESS_TOKEN', 'AUTH_MODE', 'FOUNDU_TOOL_TIERS', 'CONDUIT_S2S_SECRET', 'FOUNDU_MAX_CONCURRENCY']) delete process.env[key];
// Backoff without a Retry-After header waits FOUNDU_RETRY_BASE_MS * 2^attempt; keep tests fast.
process.env.FOUNDU_RETRY_BASE_MS = '1';
