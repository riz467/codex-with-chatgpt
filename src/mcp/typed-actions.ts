/**
 * Bounded typed-action implementation seam.
 *
 * Bootstrap intentionally contains no executable action. Future bounded
 * control-plane tasks may edit this file, src/mcp/server.ts, and the matching
 * test file only. The profile gate itself remains outside that edit scope.
 */
export const typedActionBootstrap = Object.freeze({ version: 1 as const });