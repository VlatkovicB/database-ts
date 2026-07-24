import { Tuple } from "./page";

// btreeDegree t: each non-root node has between t-1 and 2t-1 keys.
// t=4 → max 7 keys per node, max 8 children per internal node.
const btreeDegree = 4;

type BtKey = unknown;

interface BtNode {
  isFull(): boolean;
  isLeaf(): boolean;
}

class BtLeaf implements BtNode {
  keys: BtKey[] = [];
  vals: Tuple[][] = []; // vals[i] = all tuples with keys[i] (handles duplicates)
  next: BtLeaf | null = null;

  isFull(): boolean {
    return this.keys.length >= 2 * btreeDegree - 1;
  }

  isLeaf(): boolean {
    return true;
  }
}

class BtInternal implements BtNode {
  keys: BtKey[] = [];
  children: BtNode[] = [];

  isFull(): boolean {
    return this.keys.length >= 2 * btreeDegree - 1;
  }

  isLeaf(): boolean {
    return false;
  }
}

/** cmpKeys compares two index key values. Numeric types and strings supported. */
function cmpKeys(a: BtKey, b: BtKey): number {
  const af = toNumKey(a);
  const bf = toNumKey(b);
  if (af !== null && bf !== null) {
    if (af < bf) return -1;
    if (af > bf) return 1;
    return 0;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function toNumKey(v: BtKey): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/**
 * leafPos returns the index where key is or would be inserted in keys.
 * Returns [index, true] if exact match found, [index, false] for insertion point.
 */
function leafPos(keys: BtKey[], key: BtKey): [number, boolean] {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = cmpKeys(keys[mid], key);
    if (c === 0) return [mid, true];
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return [lo, false];
}

/** childIdx returns the child index to descend into for a given key. */
function childIdx(keys: BtKey[], key: BtKey): number {
  let i = keys.length - 1;
  while (i >= 0 && cmpKeys(keys[i], key) > 0) {
    i--;
  }
  return i + 1;
}

/**
 * BTree is a B+ tree: all data lives in leaf nodes.
 * Internal nodes hold separator keys only.
 * Leaf nodes are linked for efficient forward range scans.
 */
export class BTree {
  private root: BtNode = new BtLeaf();
  size: number = 0; // total key-tuple pairs inserted

  /** Insert adds (key, tuple) into the B+ tree. */
  insert(key: BtKey, tuple: Tuple): void {
    if (this.root.isFull()) {
      const newRoot = new BtInternal();
      newRoot.children.push(this.root);
      this.splitChild(newRoot, 0);
      this.root = newRoot;
    }
    this.insertNonFull(this.root, key, tuple);
    this.size++;
  }

  private insertNonFull(node: BtNode, key: BtKey, tuple: Tuple): void {
    if (node instanceof BtLeaf) {
      const [i, found] = leafPos(node.keys, key);
      if (found) {
        node.vals[i].push(tuple);
        return;
      }
      node.keys.splice(i, 0, key);
      node.vals.splice(i, 0, [tuple]);
      return;
    }

    const internal = node as BtInternal;
    let i = childIdx(internal.keys, key);
    const child = internal.children[i];
    if (child.isFull()) {
      this.splitChild(internal, i);
      if (cmpKeys(key, internal.keys[i]) >= 0) {
        i++;
      }
    }
    this.insertNonFull(internal.children[i], key, tuple);
  }

  /** splitChild splits internal.children[ci] which must be full. */
  private splitChild(parent: BtInternal, ci: number): void {
    const child = parent.children[ci];

    if (child instanceof BtLeaf) {
      // B+ tree leaf split: right sibling gets upper half, separator key is first key of right sibling.
      const sp = btreeDegree; // left keeps [0:sp], right gets [sp:]
      const newLeaf = new BtLeaf();
      newLeaf.keys = child.keys.slice(sp);
      newLeaf.vals = child.vals.slice(sp);
      newLeaf.next = child.next;
      child.keys = child.keys.slice(0, sp);
      child.vals = child.vals.slice(0, sp);
      child.next = newLeaf;

      const promotedKey = newLeaf.keys[0];
      parent.keys.splice(ci, 0, promotedKey);
      parent.children.splice(ci + 1, 0, newLeaf);
      return;
    }

    // Internal node split: middle key is promoted up and removed from child.
    const internal = child as BtInternal;
    const mid = btreeDegree - 1;
    const promotedKey = internal.keys[mid];
    const newInternal = new BtInternal();
    newInternal.keys = internal.keys.slice(mid + 1);
    newInternal.children = internal.children.slice(mid + 1);
    internal.keys = internal.keys.slice(0, mid);
    internal.children = internal.children.slice(0, mid + 1);

    parent.keys.splice(ci, 0, promotedKey);
    parent.children.splice(ci + 1, 0, newInternal);
  }

  /** findLeaf descends to the leaf node that contains (or would contain) key. */
  private findLeaf(key: BtKey): BtLeaf {
    let node: BtNode = this.root;
    while (!node.isLeaf()) {
      const internal = node as BtInternal;
      const i = childIdx(internal.keys, key);
      node = internal.children[i];
    }
    return node as BtLeaf;
  }

  /** Search returns all tuples with the exact key. */
  search(key: BtKey): Tuple[] {
    const leaf = this.findLeaf(key);
    const [i, found] = leafPos(leaf.keys, key);
    if (!found) return [];
    return leaf.vals[i].slice();
  }

  /**
   * RangeScan returns tuples satisfying: lo loOp key hiOp hi.
   * loOp: ">" | ">=" | "=" | "" (no lower bound).
   * hiOp: "<" | "<=" | "=" | "" (no upper bound).
   * When loOp == "=" this is an exact lookup (hi is ignored).
   */
  rangeScan(lo: BtKey, loOp: string, hi: BtKey, hiOp: string): Tuple[] {
    if (loOp === "=") {
      return this.search(lo);
    }

    let startLeaf: BtLeaf;
    let startPos: number;

    if (lo !== null && lo !== undefined) {
      startLeaf = this.findLeaf(lo);
      const [i, found] = leafPos(startLeaf.keys, lo);
      if (loOp === ">" && found) {
        startPos = i + 1;
      } else {
        startPos = i;
      }
    } else {
      // Start from leftmost leaf.
      let node: BtNode = this.root;
      while (!node.isLeaf()) {
        node = (node as BtInternal).children[0];
      }
      startLeaf = node as BtLeaf;
      startPos = 0;
    }

    const results: Tuple[] = [];
    let leaf: BtLeaf | null = startLeaf;
    while (leaf !== null) {
      const start = leaf === startLeaf ? startPos : 0;
      for (let i = start; i < leaf.keys.length; i++) {
        const key = leaf.keys[i];
        if (hi !== null && hi !== undefined) {
          const c = cmpKeys(key, hi);
          if (hiOp === "<" && c >= 0) return results;
          if (hiOp === "<=" && c > 0) return results;
        }
        for (const tup of leaf.vals[i]) {
          results.push(tup);
        }
      }
      leaf = leaf.next;
    }
    return results;
  }

  /** All returns all tuples in ascending key order. */
  all(): Tuple[] {
    return this.rangeScan(null, "", null, "");
  }

  /** Depth returns the height of the tree (root = 1). */
  depth(): number {
    let d = 1;
    let node: BtNode = this.root;
    while (!node.isLeaf()) {
      d++;
      node = (node as BtInternal).children[0];
    }
    return d;
  }
}
