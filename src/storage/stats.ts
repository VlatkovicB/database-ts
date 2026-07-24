import { Column, ColumnType } from "./page";

const statsBuckets = 100;
const statsMCVCount = 10;

/** MCVEntry is a most-common-value entry, mirroring pg_stats.most_common_vals/freqs. */
export interface MCVEntry {
  value: unknown;
  freq: number; // fraction of non-null rows
}

/** ColumnStats mirrors what PostgreSQL stores in pg_stats after ANALYZE. */
export class ColumnStats {
  nullFrac: number = 0;      // fraction of rows that are NULL (0.0–1.0)
  nDistinct: number = 0;     // >0 = exact count; <0 = fraction of rows (like PG: -1 = all distinct)
  avgWidth: number = 0;      // average byte width of non-null values
  histogram: unknown[] = []; // equi-height bucket boundaries (up to statsBuckets+1 values)
  mcv: MCVEntry[] = [];      // top-N most common values by frequency

  /**
   * HistogramSelectivity estimates the fraction of rows satisfying "col op val"
   * using the equi-height histogram. Returns [selectivity, ok].
   */
  histogramSelectivity(op: string, val: unknown): [number, boolean] {
    if (this.histogram.length < 2) return [0, false];
    const n = this.histogram.length - 1; // number of buckets
    const pos = histogramPosition(this.histogram, val);
    const nonNull = 1.0 - this.nullFrac;

    switch (op) {
      case "<":
      case "<=": {
        let sel = pos / n;
        if (op === "<=") sel += 1.0 / n / 2.0;
        if (sel > 1.0) sel = 1.0;
        return [sel * nonNull, true];
      }
      case ">":
      case ">=": {
        let sel = 1.0 - pos / n;
        if (op === ">=") sel += 1.0 / n / 2.0;
        if (sel > 1.0) sel = 1.0;
        return [sel * nonNull, true];
      }
    }
    return [0, false];
  }

  /**
   * EqualitySelectivity estimates selectivity of "col = val".
   * Checks MCV first, then falls back to 1/n_distinct.
   */
  equalitySelectivity(val: unknown): number {
    const key = normalizeKey(val);
    for (const m of this.mcv) {
      if (normalizeKey(m.value) === key) {
        return m.freq * (1.0 - this.nullFrac);
      }
    }
    const nd = this.nDistinct;
    if (nd < 0) {
      return 0.005; // very selective when all values are distinct
    }
    if (nd === 0) return 0;
    let mcvFrac = 0;
    for (const m of this.mcv) mcvFrac += m.freq;
    return ((1.0 - mcvFrac) / nd) * (1.0 - this.nullFrac);
  }
}

/** TableStats mirrors what PostgreSQL stores in pg_stat_user_tables after ANALYZE. */
export class TableStats {
  nLiveTup: bigint = 0n;
  nPages: number = 0;
  columns: Map<string, ColumnStats> = new Map();

  /** FormatAnalyzeOutput returns a human-readable ANALYZE report for the frontend. */
  formatAnalyzeOutput(tableName: string, cols: Column[]): string[] {
    const lines: string[] = [];
    lines.push(`ANALYZE ${tableName}`);
    lines.push(`  rows: ${this.nLiveTup}  pages: ${this.nPages}`);
    lines.push("");
    for (const col of cols) {
      const cs = this.columns.get(col.name);
      if (!cs) continue;
      const nd = cs.nDistinct;
      let ndStr = nd.toFixed(0);
      if (nd < 0) {
        ndStr = `${(-nd * Number(this.nLiveTup)).toFixed(0)} (all distinct)`;
      }
      const nullPct = cs.nullFrac * 100;
      const line = `  ${col.name.padEnd(20)}  n_distinct=${ndStr.padEnd(6)}  null_frac=${nullPct.toFixed(1)}%  avg_width=${cs.avgWidth}`;
      lines.push(line);
      if (cs.mcv.length > 0) {
        const parts = cs.mcv.map((m) => `${m.value}=${(m.freq * 100).toFixed(1)}%`);
        lines.push(`  ${"".padEnd(20)}  most_common: ${parts.join(", ")}`);
      }
      if (cs.histogram.length > 0) {
        let bounds: unknown[] = cs.histogram;
        if (bounds.length > 6) {
          bounds = [bounds[0], bounds[1], bounds[2], "...", bounds[bounds.length - 3], bounds[bounds.length - 2], bounds[bounds.length - 1]];
        }
        const parts = bounds.map((b) => String(b));
        lines.push(`  ${"".padEnd(20)}  histogram: [${parts.join(", ")}]`);
      }
    }
    return lines;
  }
}

// Table interface needed for computeStats — imported inline to avoid circular deps
export interface StatsTable {
  name: string;
  columns: Column[];
  pages: Array<{ tuples: Array<{ data: Map<string, unknown>; xmax: bigint }> }>;
}

/** computeStats scans all rows in t and computes per-column statistics. */
export function computeStats(t: StatsTable): TableStats {
  let nRows = 0n;
  for (const pg of t.pages) {
    nRows += BigInt(pg.tuples.length);
  }

  const ts = new TableStats();
  ts.nLiveTup = nRows;
  ts.nPages = t.pages.length;

  if (nRows === 0n) {
    for (const col of t.columns) {
      ts.columns.set(col.name, new ColumnStats());
    }
    return ts;
  }

  for (const col of t.columns) {
    ts.columns.set(col.name, computeColumnStats(t, col, nRows));
  }
  return ts;
}

function computeColumnStats(t: StatsTable, col: Column, nRows: bigint): ColumnStats {
  let nullCount = 0n;
  let totalWidth = 0;
  const nonNullVals: unknown[] = [];

  for (const pg of t.pages) {
    for (const tup of pg.tuples) {
      const v = tup.data.get(col.name);
      if (v === undefined || v === null) {
        nullCount++;
        continue;
      }
      nonNullVals.push(v);
      totalWidth += estimateValueWidth(v);
    }
  }

  const cs = new ColumnStats();
  cs.nullFrac = Number(nullCount) / Number(nRows);

  if (nonNullVals.length === 0) return cs;

  cs.avgWidth = Math.floor(totalWidth / nonNullVals.length);

  // Count distinct values.
  const distinctSet = new Map<unknown, number>(); // normalizedValue → count
  for (const v of nonNullVals) {
    const key = normalizeKey(v);
    distinctSet.set(key, (distinctSet.get(key) ?? 0) + 1);
  }
  const nDistinct = distinctSet.size;

  // PG convention: if nearly every row is distinct, store as negative fraction.
  if (nDistinct > 0.2 * Number(nRows)) {
    cs.nDistinct = -1.0; // all distinct
  } else {
    cs.nDistinct = nDistinct;
  }

  // Most common values (top statsMCVCount by count).
  const freqList = Array.from(distinctSet.entries()).map(([key, count]) => ({ key, count }));
  freqList.sort((a, b) => b.count - a.count);
  const nonNullCount = nonNullVals.length;
  for (let i = 0; i < statsMCVCount && i < freqList.length; i++) {
    const freq = freqList[i].count / nonNullCount;
    if (freq < 0.01) break; // don't store rare values as MCV
    cs.mcv.push({ value: freqList[i].key, freq });
  }

  // Equi-height histogram — only for orderable types (INT, FLOAT, TEXT).
  if (col.type !== "BOOLEAN" && nDistinct > 1) {
    const sorted = sortedValues(nonNullVals, col.type);
    if (sorted !== null) {
      // Remove MCV entries from histogram population (PG does this).
      const mcvSet = new Set(cs.mcv.map((m) => normalizeKey(m.value)));
      const histVals = sorted.filter((v) => !mcvSet.has(normalizeKey(v)));
      if (histVals.length > statsBuckets) {
        const step = (histVals.length - 1) / statsBuckets;
        for (let i = 0; i <= statsBuckets; i++) {
          let idx = Math.round(i * step);
          if (idx >= histVals.length) idx = histVals.length - 1;
          cs.histogram.push(histVals[idx]);
        }
      } else if (histVals.length > 1) {
        cs.histogram = histVals;
      }
    }
  }

  return cs;
}

/**
 * normalizeKey returns a comparable key for v.
 * Collapses numeric types so that e.g. bigint and number comparisons work.
 */
export function normalizeKey(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  return v;
}

function estimateValueWidth(v: unknown): number {
  if (typeof v === "number") return 8;
  if (typeof v === "bigint") return 8;
  if (typeof v === "boolean") return 1;
  if (typeof v === "string") return v.length;
  return 4;
}

function sortedValues(vals: unknown[], colType: ColumnType): unknown[] | null {
  const out = vals.slice();
  switch (colType) {
    case "INT":
      out.sort((a, b) => toInt(a) - toInt(b));
      break;
    case "FLOAT":
      out.sort((a, b) => toFloat(a) - toFloat(b));
      break;
    case "TEXT":
      out.sort((a, b) => String(a).localeCompare(String(b)));
      break;
    default:
      return null;
  }
  return out;
}

function toInt(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function toFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return 0;
}

/** histogramPosition returns the fractional bucket position (0..n) of val. */
function histogramPosition(hist: unknown[], val: unknown): number {
  const n = hist.length;
  if (n === 0) return 0;

  const fval = toFloat64Safe(val);
  if (fval !== null) {
    // Binary search for position.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const fmid = toFloat64Safe(hist[mid]);
      if (fmid !== null && fmid <= fval) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    if (lo >= n) return n - 1;
    const flo = toFloat64Safe(hist[lo - 1])!;
    const fhi = toFloat64Safe(hist[lo])!;
    if (fhi === flo) return lo - 1;
    return (lo - 1) + (fval - flo) / (fhi - flo);
  }

  // Text comparison.
  const sval = String(val);
  for (let i = 0; i < hist.length; i++) {
    if (String(hist[i]) >= sval) return i;
  }
  return n - 1;
}

function toFloat64Safe(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}
