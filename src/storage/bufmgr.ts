export const DefaultBufPoolSize = 64;

export interface PageID {
  table: string;
  pageNum: number;
}

function pageIDKey(id: PageID): string {
  return `${id.table}:${id.pageNum}`;
}

/** BPStats tracks buffer pool access statistics. */
export class BPStats {
  hits: number = 0;
  misses: number = 0;
  evicted: number = 0;

  add(o: BPStats): BPStats {
    const s = new BPStats();
    s.hits = this.hits + o.hits;
    s.misses = this.misses + o.misses;
    s.evicted = this.evicted + o.evicted;
    return s;
  }

  /** FormatExplain produces a PG-style buffer accounting line. */
  formatExplain(): string {
    if (this.hits + this.misses === 0) return "";
    let out = `Buffers: shared hit=${this.hits}`;
    if (this.misses > 0) out += ` read=${this.misses}`;
    if (this.evicted > 0) out += ` evicted=${this.evicted}`;
    return out;
  }
}

interface BpSlot {
  id: PageID;
  valid: boolean;
  pinCount: number;
  usageCount: number;
  dirty: boolean;
}

/**
 * BufferPool is a fixed-size, clock-sweep buffer pool (simulates PostgreSQL's
 * shared_buffers). Table.Pages remains the authoritative data store; this pool
 * tracks access patterns and reports hit/miss for EXPLAIN ANALYZE.
 */
export class BufferPool {
  private size: number;
  private slots: BpSlot[];
  private index: Map<string, number> = new Map(); // pageIDKey → slot index
  private clockHand: number = 0;
  private hits: number = 0;
  private misses: number = 0;
  private evicted: number = 0;

  constructor(size: number = DefaultBufPoolSize) {
    this.size = size < 1 ? DefaultBufPoolSize : size;
    this.slots = Array.from({ length: this.size }, () => ({
      id: { table: "", pageNum: 0 },
      valid: false,
      pinCount: 0,
      usageCount: 0,
      dirty: false,
    }));
  }

  /**
   * FetchPage records access to a page and returns [slotIdx, hit].
   * Call unpin(slot, dirty) when done.
   */
  fetchPage(id: PageID): [number, boolean] {
    const key = pageIDKey(id);
    const existing = this.index.get(key);
    if (existing !== undefined) {
      this.slots[existing].pinCount++;
      this.slots[existing].usageCount = 2;
      this.hits++;
      return [existing, true];
    }

    const slot = this.evict();
    this.slots[slot] = { id, valid: true, pinCount: 1, usageCount: 1, dirty: false };
    this.index.set(key, slot);
    this.misses++;
    return [slot, false];
  }

  private evict(): number {
    while (true) {
      const s = this.slots[this.clockHand];
      if (!s.valid) {
        const v = this.clockHand;
        this.clockHand = (this.clockHand + 1) % this.size;
        return v;
      }
      if (s.pinCount > 0) {
        this.clockHand = (this.clockHand + 1) % this.size;
        continue;
      }
      if (s.usageCount > 0) {
        s.usageCount--;
        this.clockHand = (this.clockHand + 1) % this.size;
        continue;
      }
      this.index.delete(pageIDKey(s.id));
      this.evicted++;
      const v = this.clockHand;
      this.clockHand = (this.clockHand + 1) % this.size;
      return v;
    }
  }

  /** Unpin decrements pin count. dirty=true marks for eviction accounting. */
  unpin(slot: number, dirty: boolean): void {
    if (slot < 0 || slot >= this.size || !this.slots[slot].valid) return;
    if (this.slots[slot].pinCount > 0) this.slots[slot].pinCount--;
    if (dirty) this.slots[slot].dirty = true;
  }

  /** InvalidatePage removes a page from the pool (call after DML writes to table pages). */
  invalidatePage(id: PageID): void {
    const key = pageIDKey(id);
    const slot = this.index.get(key);
    if (slot !== undefined) {
      this.slots[slot] = { id: { table: "", pageNum: 0 }, valid: false, pinCount: 0, usageCount: 0, dirty: false };
      this.index.delete(key);
    }
  }

  /** SnapshotStats returns a point-in-time copy and resets counters for next query. */
  snapshotStats(): BPStats {
    const s = new BPStats();
    s.hits = this.hits;
    s.misses = this.misses;
    s.evicted = this.evicted;
    this.hits = 0;
    this.misses = 0;
    this.evicted = 0;
    return s;
  }
}
