// =============================================================================
// history.ts — port of api/history.go
// In-memory query history store (ring-buffer of distinct SQL strings).
// The Go version uses SQLite; here we use a plain in-memory Map ordered by
// recency so that no external dependency is required.
// =============================================================================

const MAX_HISTORY = 500;

export class HistoryStore {
  // Map preserves insertion order; we move touched entries to the end to keep
  // most-recently-used ordering.  Key = SQL string.
  private seen: Map<string, true> = new Map();

  upsert(sql: string): void {
    // Delete then re-insert to move to end (most-recently-used).
    this.seen.delete(sql);
    this.seen.set(sql, true);

    // Evict oldest entry when we overflow.
    if (this.seen.size > MAX_HISTORY) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
  }

  list(): string[] {
    // Return newest first (reverse insertion order).
    return Array.from(this.seen.keys()).reverse();
  }
}
