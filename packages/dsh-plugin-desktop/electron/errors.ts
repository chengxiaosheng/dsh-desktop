/**
 * Boot failure formatting for the Electron main.
 */

/** Flatten a boot/loader failure into one line per underlying error (aggregates + causes). */
export function formatBootError(error: unknown): string[] {
  const lines: string[] = []
  const seen = new Set<unknown>()
  const visit = (err: unknown): void => {
    if (err === undefined || err === null || seen.has(err)) return
    seen.add(err)
    const record = err as { message?: unknown; errors?: unknown[]; cause?: unknown }
    lines.push(String(record.message ?? err))
    if (Array.isArray(record.errors)) for (const child of record.errors) visit(child)
    visit(record.cause)
  }
  visit(error)
  return lines
}
