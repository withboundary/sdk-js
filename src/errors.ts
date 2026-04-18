// Default error sink. Logs once per unique message so a bad backend doesn't
// spam the user's stderr. Silent after the first warn-per-category.
const warned = new Set<string>();

export function defaultOnError(err: unknown): void {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (warned.has(message)) return;
  warned.add(message);
  // eslint-disable-next-line no-console -- user-facing warning is the point
  console.warn(`[@withboundary/sdk] ${message}`);
}
