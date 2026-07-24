import { Row, Tuple } from "./page";
import { Table } from "./storage";

/**
 * checkPrimaryKey verifies that the new row does not violate any PRIMARY KEY constraint on t.
 * Returns non-null error if a duplicate or NULL PK value is found.
 */
export function checkPrimaryKey(t: Table, row: Row): Error | null {
  for (const col of t.columns) {
    if (!col.primary) continue;
    const pkVal = row.get(col.name);
    if (pkVal === undefined || pkVal === null) {
      return new Error(`null value in column "${col.name}" violates not-null constraint`);
    }
    let dup = false;
    t.scanTuples((tpl: Tuple) => {
      if (tpl.xmax !== 0n) return true;
      if (tpl.data.get(col.name) === pkVal) {
        dup = true;
        return false;
      }
      return true;
    });
    if (dup) {
      return new Error(
        `duplicate key value violates unique constraint on "${t.name}": "${col.name}"=${pkVal} already exists`
      );
    }
  }
  return null;
}

/**
 * checkForeignKeys verifies that the new row satisfies all FK constraints on t.
 * lookup must return the referenced table (or undefined if not found).
 */
export function checkForeignKeys(
  t: Table,
  row: Row,
  lookup: (name: string) => Table | undefined
): Error | null {
  for (const fk of t.foreignKeys) {
    const val = row.get(fk.column);
    if (val === undefined || val === null) continue; // NULL is allowed in FK columns
    const refT = lookup(fk.refTable);
    if (!refT) {
      return new Error(`foreign key references unknown table "${fk.refTable}"`);
    }
    let found = false;
    refT.scanTuples((tpl: Tuple) => {
      if (tpl.xmax !== 0n) return true;
      if (tpl.data.get(fk.refColumn) === val) {
        found = true;
        return false;
      }
      return true;
    });
    if (!found) {
      return new Error(
        `insert violates foreign key constraint: "${t.name}"."${fk.column}"=${val} has no match in "${fk.refTable}"."${fk.refColumn}"`
      );
    }
  }
  return null;
}

/**
 * checkFKRestrict verifies that no child table references rows in parentTable that match predicate.
 * tables is the full set of DB tables. Returns an error if any referencing row is found.
 */
export function checkFKRestrict(
  parentTable: Table,
  predicate: (row: Row) => boolean,
  tables: Map<string, Table>
): Error | null {
  for (const [childName, child] of tables) {
    for (const fk of child.foreignKeys) {
      if (fk.refTable !== parentTable.name) continue;
      let violation: Error | null = null;
      parentTable.scanTuples((tpl: Tuple) => {
        if (tpl.xmax !== 0n || !predicate(tpl.data)) return true;
        const val = tpl.data.get(fk.refColumn);
        child.scanTuples((ctpl: Tuple) => {
          if (ctpl.xmax !== 0n) return true;
          if (ctpl.data.get(fk.column) === val) {
            violation = new Error(
              `delete violates foreign key constraint: "${parentTable.name}"."${fk.refColumn}"=${val} is referenced by "${childName}"."${fk.column}"`
            );
            return false;
          }
          return true;
        });
        return violation === null;
      });
      if (violation) return violation;
    }
  }
  return null;
}
