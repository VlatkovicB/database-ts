export const PageSize = 8192;
export const PageHeaderSize = 24;
export const TupleHeaderSize = 23;
export const ItemIdSize = 4; // sizeof(ItemIdData) — each line pointer entry in the item array

export type Row = Map<string, unknown>;

export type ColumnType = "INT" | "TEXT" | "BOOLEAN" | "FLOAT";

export interface Column {
  name: string;
  type: ColumnType;
  primary: boolean;
}

/**
 * Tuple is a stored row with its physical location identifier.
 * xmin is the transaction ID that inserted this tuple (0n = auto-committed / pre-MVCC, always visible).
 * xmax is the transaction ID that deleted this tuple (0n = live, not yet deleted).
 */
export interface Tuple {
  pageNum: number;
  slotNum: number;
  data: Row;
  xmin: bigint; // txid that inserted this tuple
  xmax: bigint; // txid that deleted this tuple (0n = live)
}

/**
 * Returns the PostgreSQL-style tuple identifier, e.g. "(0,1)".
 * PG uses 1-based slot numbers.
 */
export function tupleCTID(t: Tuple): string {
  return `(${t.pageNum},${t.slotNum + 1})`;
}

/**
 * PageHeader mirrors PostgreSQL's PageHeaderData for the physical 8KB page layout.
 *
 * PostgreSQL page layout (8192 bytes):
 *   [PageHeader 24B][ItemId array → ][free space][← tuple data][special space]
 *
 * pd_lower grows right (each new ItemId entry), pd_upper grows left (each new tuple).
 * Free space = pd_upper - pd_lower.
 */
export class PageHeader {
  lsn: bigint = 0n;    // pd_lsn: WAL sequence number of last change to this page
  flags: number = 0;   // pd_flags: PD_HAS_FREE_LINES, PD_PAGE_FULL, etc.
  lower: number;       // pd_lower: byte offset to end of line pointer array (grows →)
  upper: number;       // pd_upper: byte offset to start of tuple area (grows ←)
  special: number;     // pd_special: offset to special space (= PageSize for heap pages)

  constructor() {
    this.lower = PageHeaderSize;
    this.upper = PageSize;
    this.special = PageSize;
  }

  /** Returns the number of usable bytes between the item pointer array and tuple data. */
  freeSpace(): number {
    if (this.upper <= this.lower) return 0;
    return this.upper - this.lower;
  }

  /**
   * HasRoom returns true if a new tuple of dataSize bytes fits on this page.
   * Each tuple consumes ItemIdSize bytes in the line pointer array plus dataSize bytes of data.
   */
  hasRoom(dataSize: number): boolean {
    return this.freeSpace() >= ItemIdSize + dataSize;
  }

  /** Updates lower and upper to reflect inserting a tuple of dataSize bytes. */
  addTuple(dataSize: number): void {
    this.lower += ItemIdSize;
    this.upper -= dataSize;
  }
}

/** Page simulates one 8KB PostgreSQL heap page. */
export interface Page {
  header: PageHeader;
  tuples: Tuple[];
}

export function newPage(): Page {
  return { header: new PageHeader(), tuples: [] };
}

/**
 * estimateTupleSize estimates bytes per tuple from column types.
 * Uses TupleHeaderSize (23 bytes, like PG's HeapTupleHeaderData) plus column data.
 */
export function estimateTupleSize(cols: Column[]): number {
  let size = TupleHeaderSize;
  for (const c of cols) {
    switch (c.type) {
      case "INT":
        size += 8;
        break;
      case "FLOAT":
        size += 8;
        break;
      case "BOOLEAN":
        size += 1;
        break;
      case "TEXT":
        size += 50; // average estimate
        break;
      default:
        size += 8;
    }
  }
  return size;
}

/** TuplesPerPage returns how many tuples fit on one 8KB page given the table's columns. */
export function tuplesPerPage(cols: Column[]): number {
  const usable = PageSize - PageHeaderSize;
  const ts = estimateTupleSize(cols);
  if (ts <= 0) return 100;
  const n = Math.floor(usable / ts);
  return n < 1 ? 1 : n;
}
