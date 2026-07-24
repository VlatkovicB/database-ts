// =============================================================================
// trace.ts — port of api/trace.go
// AST + token serialisation helpers for the /query response.
// =============================================================================

import { Token, TokenType, tokenName, tokenCategory } from '../lexer/token';
import {
  Statement,
  Expression,
  SelectExpr,
  ColSelectExpr,
  AggSelectExpr,
} from '../parser/ast';

// ---------------------------------------------------------------------------
// Token trace
// ---------------------------------------------------------------------------

export interface TraceToken {
  typeName: string;
  literal: string;
  category: string;
}

/** Convert a raw token array into the lightweight trace format. */
export function serializeTokens(tokens: Token[]): TraceToken[] {
  const out: TraceToken[] = [];
  for (const t of tokens) {
    if (t.type === TokenType.EOF || t.type === TokenType.SEMICOLON) continue;
    const lit =
      t.type === TokenType.STRING_LIT ? `'${t.literal}'` : t.literal;
    out.push({
      typeName: tokenName(t.type),
      literal: lit,
      category: tokenCategory(t.type),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AST trace
// ---------------------------------------------------------------------------

/** Convert a parsed Statement into a plain JSON-serialisable object. */
export function stmtToTrace(stmt: Statement): Record<string, unknown> {
  switch (stmt.kind) {
    case 'select': {
      let exprList: unknown = '*';
      if (stmt.exprs !== null) {
        const items: unknown[] = [];
        for (const ex of stmt.exprs) {
          if (ex.kind === 'col') {
            items.push((ex as ColSelectExpr).col);
          } else if (ex.kind === 'agg') {
            const agg = ex as AggSelectExpr;
            items.push(`${agg.func}(${agg.arg})`);
          }
        }
        exprList = items;
      }

      const joins = stmt.joins.map((j) => ({
        type: j.type,
        table: j.table,
        alias: j.alias,
        on: exprToTrace(j.condition),
      }));

      const orderBy = stmt.orderBy.map((ob) => ({
        col: ob.col,
        dir: ob.desc ? 'DESC' : 'ASC',
      }));

      return {
        type: 'SelectStatement',
        distinct: stmt.distinct,
        table: stmt.table,
        alias: stmt.alias,
        joins,
        columns: exprList,
        where: exprToTrace(stmt.where),
        groupBy: stmt.groupBy,
        having: exprToTrace(stmt.having),
        orderBy,
        limit: stmt.limit !== null ? String(stmt.limit) : null,
        offset: stmt.offset !== null ? String(stmt.offset) : null,
      };
    }

    case 'insert': {
      const cols: unknown =
        stmt.columns.length > 0 ? stmt.columns : '<positional>';
      return {
        type: 'InsertStatement',
        table: stmt.table,
        columns: cols,
        values: stmt.values,
      };
    }

    case 'update':
      return {
        type: 'UpdateStatement',
        table: stmt.table,
        assignments: stmt.assignments,
        where: exprToTrace(stmt.where),
      };

    case 'delete':
      return {
        type: 'DeleteStatement',
        table: stmt.table,
        where: exprToTrace(stmt.where),
      };

    case 'createTable': {
      const cols = stmt.columns.map((c) => ({
        name: c.name,
        type: c.type,
        primary: c.primary,
      }));
      return {
        type: 'CreateTableStatement',
        table: stmt.table,
        columns: cols,
      };
    }

    case 'dropTable':
      return {
        type: 'DropTableStatement',
        table: stmt.table,
      };

    case 'explain': {
      const mode = stmt.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN';
      return {
        type: 'ExplainStatement',
        mode,
        inner: stmtToTrace(stmt.stmt),
      };
    }

    case 'createIndex':
      return {
        type: 'CreateIndex',
        name: stmt.name,
        table: stmt.table,
        column: stmt.column,
      };

    case 'dropIndex':
      return {
        type: 'DropIndex',
        name: stmt.name,
        ifExists: stmt.ifExists,
      };

    case 'analyze':
      return {
        type: 'AnalyzeStatement',
        table: stmt.table,
      };

    case 'begin':
      return { type: 'BeginStatement' };

    case 'commit':
      return { type: 'CommitStatement' };

    case 'rollback':
      return { type: 'RollbackStatement' };

    case 'vacuum':
      return { type: 'VacuumStatement', table: stmt.table };

    default:
      return { type: 'Unknown' };
  }
}

/** Convert an Expression node into a plain JSON-serialisable object. */
export function exprToTrace(expr: Expression | null): unknown {
  if (expr === null || expr === undefined) return null;

  switch (expr.kind) {
    case 'binary':
      return {
        type: 'BinaryExpr',
        op: expr.op,
        left: exprToTrace(expr.left),
        right: exprToTrace(expr.right),
      };

    case 'ident': {
      const m: Record<string, unknown> = { type: 'IdentExpr', name: expr.name };
      if (expr.table) m['table'] = expr.table;
      return m;
    }

    case 'literal':
      return { type: 'LiteralExpr', value: expr.value };

    case 'aggFunc': {
      const arg: unknown =
        expr.arg !== null ? exprToTrace(expr.arg) : '*';
      return { type: 'AggFuncExpr', func: expr.func, arg };
    }

    default:
      return null;
  }
}
