// Statement discriminated union — every SQL command is one of these.
export type Statement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | CreateTableStatement
  | DropTableStatement
  | ExplainStatement
  | CreateIndexStatement
  | DropIndexStatement
  | AnalyzeStatement
  | BeginStatement
  | CommitStatement
  | RollbackStatement
  | VacuumStatement;

// SelectExpr discriminated union — items in the SELECT column list.
export type SelectExpr = ColSelectExpr | AggSelectExpr | ExprSelectExpr;

// Expression discriminated union — used in WHERE / HAVING clauses.
export type Expression =
  | BinaryExpr
  | IdentExpr
  | LiteralExpr
  | AggFuncExpr
  | SubqueryExpr
  | InSubqueryExpr
  | ExistsExpr;

// ---------------------------------------------------------------------------
// Select expression nodes
// ---------------------------------------------------------------------------

/** Plain column reference: "col", "alias.col", "alias.*". */
export interface ColSelectExpr {
  kind: 'col';
  col: string;
}

/** Aggregate in the SELECT list: COUNT(*), SUM(col), etc. */
export interface AggSelectExpr {
  kind: 'agg';
  func: string; // COUNT, SUM, AVG, MIN, MAX
  arg: string;  // column name or "*"
}

/** Scalar subquery or expression in the SELECT list with an alias. */
export interface ExprSelectExpr {
  kind: 'expr';
  expr: Expression;
  alias: string;
}

// ---------------------------------------------------------------------------
// Join types
// ---------------------------------------------------------------------------

export type JoinType = 'INNER' | 'LEFT';

export interface JoinClause {
  type: JoinType;
  table: string;             // empty when joinSubquery != null
  alias: string;             // required alias for both table and subquery joins
  condition: Expression | null;
  joinSubquery: SelectStatement | null; // non-null for JOIN (SELECT ...) AS alias ON ...
  lateral: boolean;          // true for JOIN LATERAL — re-evaluated per outer row
}

export interface OrderByExpr {
  col: string; // column name or aggregate key e.g. "COUNT(*)"
  desc: boolean;
}

// ---------------------------------------------------------------------------
// CTE
// ---------------------------------------------------------------------------

/** One WITH clause entry. */
export interface CTEDef {
  name: string;
  query: SelectStatement;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface SelectStatement {
  kind: 'select';
  with: CTEDef[];
  distinct: boolean;
  exprs: SelectExpr[] | null; // null = SELECT *
  table: string;
  alias: string;              // defaults to table name
  fromSubquery: SelectStatement | null; // non-null for FROM (SELECT ...) AS alias
  joins: JoinClause[];
  where: Expression | null;
  groupBy: string[];
  having: Expression | null;
  orderBy: OrderByExpr[];
  limit: bigint | null;
  offset: bigint | null;
  forLock: string;            // "FOR UPDATE", "FOR SHARE", or ""
}

export interface InsertStatement {
  kind: 'insert';
  table: string;
  columns: string[];
  values: unknown[];
}

export interface UpdateStatement {
  kind: 'update';
  table: string;
  assignments: Record<string, unknown>;
  where: Expression | null;
}

export interface DeleteStatement {
  kind: 'delete';
  table: string;
  where: Expression | null;
}

export interface ColumnDef {
  name: string;
  type: string;
  primary: boolean;
}

export interface ForeignKeyConstraint {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface CreateTableStatement {
  kind: 'createTable';
  table: string;
  columns: ColumnDef[];
  foreignKeys: ForeignKeyConstraint[];
}

export interface DropTableStatement {
  kind: 'dropTable';
  table: string;
  ifExists: boolean;
}

export interface ExplainStatement {
  kind: 'explain';
  analyze: boolean;
  stmt: Statement;
}

export interface CreateIndexStatement {
  kind: 'createIndex';
  name: string;  // index name
  table: string;
  column: string;
}

export interface DropIndexStatement {
  kind: 'dropIndex';
  name: string;  // index name
  ifExists: boolean;
}

/** Computes column statistics for a table (like PostgreSQL ANALYZE). */
export interface AnalyzeStatement {
  kind: 'analyze';
  table: string;
}

// Transaction control statements (MVCC).
export interface BeginStatement {
  kind: 'begin';
}

export interface CommitStatement {
  kind: 'commit';
}

export interface RollbackStatement {
  kind: 'rollback';
}

/** Reclaims dead tuples from a table. */
export interface VacuumStatement {
  kind: 'vacuum';
  table: string;
}

// ---------------------------------------------------------------------------
// Expression nodes
// ---------------------------------------------------------------------------

/** Covers comparisons (=, !=, <, >, <=, >=) and logic (AND, OR). */
export interface BinaryExpr {
  kind: 'binary';
  left: Expression;
  op: string;
  right: Expression;
}

/** Column reference like `age` or qualified `alias.col`. */
export interface IdentExpr {
  kind: 'ident';
  table: string; // optional alias qualifier
  name: string;
}

/** Concrete value: number, string, boolean, or null. */
export interface LiteralExpr {
  kind: 'literal';
  value: number | string | boolean | null;
}

/** Aggregate function used in HAVING: COUNT(*), AVG(col), etc. */
export interface AggFuncExpr {
  kind: 'aggFunc';
  func: string;           // COUNT, SUM, AVG, MIN, MAX
  arg: Expression | null; // null means COUNT(*)
}

/** Scalar subquery used as an expression: (SELECT AVG(x) FROM t) */
export interface SubqueryExpr {
  kind: 'subquery';
  query: SelectStatement;
}

/** Handles col IN (subquery), col IN (val1, val2, ...), and NOT IN variants. */
export interface InSubqueryExpr {
  kind: 'inSubquery';
  left: Expression;
  not: boolean;
  query: SelectStatement | null;  // non-null for subquery form
  values: Expression[] | null;    // non-null for literal list form
}

/** Handles EXISTS (subquery) and NOT EXISTS (subquery). */
export interface ExistsExpr {
  kind: 'exists';
  not: boolean;
  query: SelectStatement;
}
