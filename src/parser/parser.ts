import { Token, TokenType } from '../lexer/token';
import {
  Statement,
  SelectStatement,
  SelectExpr,
  ColSelectExpr,
  AggSelectExpr,
  ExprSelectExpr,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  CreateTableStatement,
  DropTableStatement,
  ExplainStatement,
  CreateIndexStatement,
  DropIndexStatement,
  AnalyzeStatement,
  BeginStatement,
  CommitStatement,
  RollbackStatement,
  VacuumStatement,
  JoinClause,
  JoinType,
  OrderByExpr,
  CTEDef,
  ColumnDef,
  ForeignKeyConstraint,
  Expression,
  BinaryExpr,
  IdentExpr,
  LiteralExpr,
  AggFuncExpr,
  SubqueryExpr,
  InSubqueryExpr,
  ExistsExpr,
} from './ast';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // --- token primitives ---

  current(): Token {
    if (this.pos >= this.tokens.length) {
      return { type: TokenType.EOF, literal: '' };
    }
    return this.tokens[this.pos];
  }

  advance(): Token {
    const t = this.current();
    this.pos++;
    return t;
  }

  private expect(tt: TokenType): Token {
    const t = this.current();
    if (t.type !== tt) {
      throw new Error(`expected token type ${tt}, got "${t.literal}"`);
    }
    this.pos++;
    return t;
  }

  private is(tt: TokenType): boolean {
    return this.current().type === tt;
  }

  // --- shared helpers ---

  private isAggFunc(name: string): boolean {
    switch (name.toUpperCase()) {
      case 'COUNT':
      case 'SUM':
      case 'AVG':
      case 'MIN':
      case 'MAX':
        return true;
    }
    return false;
  }

  // parseOptionalAlias consumes [AS] ident or a bare ident alias, falling back to fallback.
  private parseOptionalAlias(fallback: string, ctx: string): string {
    if (this.is(TokenType.AS)) {
      this.advance();
      try {
        const a = this.expect(TokenType.IDENT);
        return a.literal;
      } catch {
        throw new Error(`${ctx}: expected alias after AS`);
      }
    }
    if (this.is(TokenType.IDENT)) {
      return this.advance().literal;
    }
    return fallback;
  }

  // parseOptionalWhere consumes WHERE expr if present.
  private parseOptionalWhere(): Expression | null {
    if (!this.is(TokenType.WHERE)) {
      return null;
    }
    this.advance();
    return this.parseExpression();
  }

  // parseAggParen consumes (col_or_star) for an aggregate and returns the arg string.
  private parseAggParen(fn: string): string {
    this.advance(); // consume (
    let arg = '*';
    if (this.is(TokenType.ASTERISK)) {
      this.advance();
    } else {
      let col: Token;
      try {
        col = this.expect(TokenType.IDENT);
      } catch {
        throw new Error(`${fn}: expected column or *`);
      }
      arg = col.literal;
      if (this.is(TokenType.DOT)) {
        this.advance();
        let col2: Token;
        try {
          col2 = this.expect(TokenType.IDENT);
        } catch {
          throw new Error(`${fn}: expected column after .`);
        }
        arg = col.literal + '.' + col2.literal;
      }
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error(`${fn}: expected )`);
    }
    return arg;
  }

  // parseIntKeyword consumes keyword + integer literal. Returns null if keyword not present.
  private parseIntKeyword(kw: TokenType, name: string): bigint | null {
    if (!this.is(kw)) {
      return null;
    }
    this.advance();
    const val = this.parseLiteral();
    if (typeof val !== 'bigint' && typeof val !== 'number') {
      throw new Error(`${name}: expected integer`);
    }
    if (typeof val === 'number') {
      if (!Number.isInteger(val)) {
        throw new Error(`${name}: expected integer, got float`);
      }
      return BigInt(val);
    }
    return val as bigint;
  }

  // --- entry point ---

  parse(): Statement {
    switch (this.current().type) {
      case TokenType.WITH:
        return this.parseWithSelect();
      case TokenType.SELECT:
        return this.parseSelect();
      case TokenType.INSERT:
        return this.parseInsert();
      case TokenType.UPDATE:
        return this.parseUpdate();
      case TokenType.DELETE:
        return this.parseDelete();
      case TokenType.CREATE:
        return this.parseCreate();
      case TokenType.DROP:
        return this.parseDrop();
      case TokenType.EXPLAIN:
        return this.parseExplain();
      case TokenType.ANALYZE:
        return this.parseAnalyze();
      case TokenType.BEGIN:
        this.advance();
        return { kind: 'begin' } as BeginStatement;
      case TokenType.COMMIT:
        this.advance();
        return { kind: 'commit' } as CommitStatement;
      case TokenType.ROLLBACK:
        this.advance();
        return { kind: 'rollback' } as RollbackStatement;
      case TokenType.VACUUM:
        return this.parseVacuum();
      default:
        throw new Error(
          `unexpected token "${this.current().literal}" — expected WITH, SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, EXPLAIN, ANALYZE, BEGIN, COMMIT, ROLLBACK, or VACUUM`
        );
    }
  }

  // --- statement parsers ---

  private parseSelect(): SelectStatement {
    this.advance(); // consume SELECT
    const stmt: SelectStatement = {
      kind: 'select',
      with: [],
      distinct: false,
      exprs: null,
      table: '',
      alias: '',
      fromSubquery: null,
      joins: [],
      where: null,
      groupBy: [],
      having: null,
      orderBy: [],
      limit: null,
      offset: null,
      forLock: '',
    };

    if (this.is(TokenType.DISTINCT)) {
      stmt.distinct = true;
      this.advance();
    }

    if (this.is(TokenType.ASTERISK)) {
      this.advance(); // SELECT *
    } else {
      stmt.exprs = [];
      while (true) {
        const expr = this.parseSelectColumn();
        stmt.exprs.push(expr);
        if (!this.is(TokenType.COMMA)) {
          break;
        }
        this.advance();
      }
    }

    try {
      this.expect(TokenType.FROM);
    } catch {
      throw new Error('SELECT: expected FROM');
    }

    // Derived table: FROM (SELECT ...) AS alias
    if (this.is(TokenType.LPAREN)) {
      const saved = this.pos;
      this.advance(); // consume (
      if (this.is(TokenType.SELECT)) {
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`FROM subquery: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('FROM subquery: expected )');
        }
        const alias = this.parseOptionalAlias('', 'FROM subquery');
        if (alias === '') {
          throw new Error('FROM subquery: alias required (use AS alias)');
        }
        stmt.table = alias;
        stmt.alias = alias;
        stmt.fromSubquery = subSel;
      } else {
        this.pos = saved;
        let t: Token;
        try {
          t = this.expect(TokenType.IDENT);
        } catch {
          throw new Error('SELECT: expected table name');
        }
        stmt.table = t.literal;
        stmt.alias = this.parseOptionalAlias(t.literal, 'SELECT FROM');
      }
    } else {
      let t: Token;
      try {
        t = this.expect(TokenType.IDENT);
      } catch {
        throw new Error('SELECT: expected table name');
      }
      stmt.table = t.literal;
      stmt.alias = this.parseOptionalAlias(t.literal, 'SELECT FROM');
    }

    while (this.is(TokenType.JOIN) || this.is(TokenType.INNER) || this.is(TokenType.LEFT)) {
      const join = this.parseJoin();
      stmt.joins.push(join);
    }

    stmt.where = this.parseOptionalWhere();

    if (this.is(TokenType.GROUP)) {
      this.advance();
      try {
        this.expect(TokenType.BY);
      } catch {
        throw new Error('SELECT: expected BY after GROUP');
      }
      while (true) {
        let col: Token;
        try {
          col = this.expect(TokenType.IDENT);
        } catch {
          throw new Error('GROUP BY: expected column name');
        }
        let colName = col.literal;
        if (this.is(TokenType.DOT)) {
          this.advance();
          let colPart: Token;
          try {
            colPart = this.expect(TokenType.IDENT);
          } catch {
            throw new Error("GROUP BY: expected column after '.'");
          }
          colName = col.literal + '.' + colPart.literal;
        }
        stmt.groupBy.push(colName);
        if (!this.is(TokenType.COMMA)) {
          break;
        }
        this.advance();
      }
    }

    if (this.is(TokenType.HAVING)) {
      this.advance();
      stmt.having = this.parseExpression();
    }

    if (this.is(TokenType.ORDER)) {
      this.advance();
      try {
        this.expect(TokenType.BY);
      } catch {
        throw new Error('SELECT: expected BY after ORDER');
      }
      while (true) {
        const col = this.parseOrderByCol();
        stmt.orderBy.push(col);
        if (!this.is(TokenType.COMMA)) {
          break;
        }
        this.advance();
      }
    }

    stmt.limit = this.parseIntKeyword(TokenType.LIMIT, 'LIMIT');
    stmt.offset = this.parseIntKeyword(TokenType.OFFSET, 'OFFSET');

    // FOR UPDATE / FOR SHARE locking clause
    if (this.is(TokenType.FOR)) {
      this.advance(); // consume FOR
      if (this.is(TokenType.UPDATE)) {
        stmt.forLock = 'FOR UPDATE';
        this.advance();
      } else if (this.is(TokenType.SHARE)) {
        stmt.forLock = 'FOR SHARE';
        this.advance();
      } else {
        throw new Error('SELECT: expected UPDATE or SHARE after FOR');
      }
    }

    return stmt;
  }

  private parseOrderByCol(): OrderByExpr {
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('ORDER BY: expected column name');
    }
    let col = t.literal;
    if (this.is(TokenType.DOT)) {
      this.advance();
      let colPart: Token;
      try {
        colPart = this.expect(TokenType.IDENT);
      } catch {
        throw new Error("ORDER BY: expected column after '.'");
      }
      col = t.literal + '.' + colPart.literal;
    } else if (this.is(TokenType.LPAREN) && this.isAggFunc(col)) {
      const fn = col.toUpperCase();
      const arg = this.parseAggParen(fn);
      col = fn + '(' + arg + ')';
    }
    let desc = false;
    if (this.is(TokenType.DESC)) {
      desc = true;
      this.advance();
    } else if (this.is(TokenType.ASC)) {
      this.advance();
    }
    return { col, desc };
  }

  private parseSelectColumn(): SelectExpr {
    // Handle scalar subquery in SELECT list: (SELECT ...) [AS alias]
    if (this.is(TokenType.LPAREN)) {
      const saved = this.pos;
      this.advance(); // consume (
      if (this.is(TokenType.SELECT)) {
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`SELECT subquery: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('SELECT subquery: expected )');
        }
        let alias = 'subquery';
        if (this.is(TokenType.AS)) {
          this.advance();
          try {
            const a = this.expect(TokenType.IDENT);
            alias = a.literal;
          } catch {
            throw new Error('SELECT subquery: expected alias after AS');
          }
        } else if (this.is(TokenType.IDENT)) {
          alias = this.advance().literal;
        }
        const expr: ExprSelectExpr = {
          kind: 'expr',
          expr: { kind: 'subquery', query: subSel } as SubqueryExpr,
          alias,
        };
        return expr;
      }
      // Not a subquery — restore position and fall through
      this.pos = saved;
    }

    // Handle literal values in SELECT list: SELECT 1, SELECT NULL, etc.
    if (
      this.is(TokenType.INT_LIT) ||
      this.is(TokenType.FLOAT_LIT) ||
      this.is(TokenType.STRING_LIT) ||
      this.is(TokenType.NULL) ||
      this.is(TokenType.TRUE) ||
      this.is(TokenType.FALSE)
    ) {
      const val = this.parseLiteral();
      let alias = String(val);
      if (this.is(TokenType.AS)) {
        this.advance();
        try {
          const a = this.expect(TokenType.IDENT);
          alias = a.literal;
        } catch {
          // keep val as alias
        }
      } else if (this.is(TokenType.IDENT)) {
        alias = this.advance().literal;
      }
      const expr: ExprSelectExpr = {
        kind: 'expr',
        expr: { kind: 'literal', value: val as number | string | boolean | null } as LiteralExpr,
        alias,
      };
      return expr;
    }

    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error(
        `SELECT: expected column name or aggregate, got "${this.current().literal}"`
      );
    }

    if (this.is(TokenType.LPAREN) && this.isAggFunc(t.literal)) {
      const fn = t.literal.toUpperCase();
      const arg = this.parseAggParen(fn);
      return { kind: 'agg', func: fn, arg } as AggSelectExpr;
    }

    if (this.is(TokenType.DOT)) {
      this.advance();
      if (this.is(TokenType.ASTERISK)) {
        this.advance();
        return { kind: 'col', col: t.literal + '.*' } as ColSelectExpr;
      }
      let col: Token;
      try {
        col = this.expect(TokenType.IDENT);
      } catch {
        throw new Error(`SELECT: expected column name after "${t.literal}".`);
      }
      return { kind: 'col', col: t.literal + '.' + col.literal } as ColSelectExpr;
    }

    return { kind: 'col', col: t.literal } as ColSelectExpr;
  }

  private parseJoin(): JoinClause {
    let jt: JoinType = 'INNER';
    if (this.is(TokenType.LEFT)) {
      jt = 'LEFT';
      this.advance();
      if (this.is(TokenType.OUTER)) {
        this.advance();
      }
    } else if (this.is(TokenType.INNER)) {
      this.advance();
    }
    try {
      this.expect(TokenType.JOIN);
    } catch {
      throw new Error('JOIN: expected JOIN keyword');
    }
    let lateral = false;
    if (this.is(TokenType.LATERAL)) {
      lateral = true;
      this.advance();
    }
    // Derived table: JOIN [LATERAL] (SELECT ...) AS alias ON ...
    if (this.is(TokenType.LPAREN)) {
      const saved = this.pos;
      this.advance(); // consume (
      if (this.is(TokenType.SELECT)) {
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`JOIN subquery: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('JOIN subquery: expected )');
        }
        const alias = this.parseOptionalAlias('', 'JOIN subquery');
        if (alias === '') {
          throw new Error('JOIN subquery: alias required');
        }
        try {
          this.expect(TokenType.ON);
        } catch {
          throw new Error('JOIN subquery: expected ON');
        }
        const cond = this.parseExpression();
        return {
          type: jt,
          table: alias,
          alias,
          joinSubquery: subSel,
          condition: cond,
          lateral,
        };
      }
      this.pos = saved;
    }
    if (lateral) {
      throw new Error('JOIN LATERAL: expected (SELECT ...)');
    }
    let tbl: Token;
    try {
      tbl = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('JOIN: expected table name');
    }
    const alias = this.parseOptionalAlias(tbl.literal, 'JOIN');
    try {
      this.expect(TokenType.ON);
    } catch {
      throw new Error('JOIN: expected ON');
    }
    const cond = this.parseExpression();
    return {
      type: jt,
      table: tbl.literal,
      alias,
      joinSubquery: null,
      condition: cond,
      lateral: false,
    };
  }

  private parseInsert(): InsertStatement {
    this.advance(); // consume INSERT
    try {
      this.expect(TokenType.INTO);
    } catch {
      throw new Error('INSERT: expected INTO');
    }
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('INSERT: expected table name');
    }
    const stmt: InsertStatement = {
      kind: 'insert',
      table: t.literal,
      columns: [],
      values: [],
    };

    if (this.is(TokenType.LPAREN)) {
      this.advance();
      while (!this.is(TokenType.RPAREN) && !this.is(TokenType.EOF)) {
        let col: Token;
        try {
          col = this.expect(TokenType.IDENT);
        } catch {
          throw new Error('INSERT: expected column name');
        }
        stmt.columns.push(col.literal);
        if (this.is(TokenType.COMMA)) {
          this.advance();
        }
      }
      try {
        this.expect(TokenType.RPAREN);
      } catch {
        throw new Error('INSERT: expected ) after column list');
      }
    }

    try {
      this.expect(TokenType.VALUES);
    } catch {
      throw new Error('INSERT: expected VALUES');
    }
    try {
      this.expect(TokenType.LPAREN);
    } catch {
      throw new Error('INSERT: expected ( before values');
    }
    while (!this.is(TokenType.RPAREN) && !this.is(TokenType.EOF)) {
      let val: unknown;
      try {
        val = this.parseLiteral();
      } catch (e) {
        throw new Error(`INSERT: ${(e as Error).message}`);
      }
      stmt.values.push(val);
      if (this.is(TokenType.COMMA)) {
        this.advance();
      }
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error('INSERT: expected ) after values');
    }
    return stmt;
  }

  private parseUpdate(): UpdateStatement {
    this.advance(); // consume UPDATE
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('UPDATE: expected table name');
    }
    const stmt: UpdateStatement = {
      kind: 'update',
      table: t.literal,
      assignments: {},
      where: null,
    };

    try {
      this.expect(TokenType.SET);
    } catch {
      throw new Error('UPDATE: expected SET');
    }
    while (true) {
      let col: Token;
      try {
        col = this.expect(TokenType.IDENT);
      } catch {
        throw new Error('UPDATE: expected column name');
      }
      try {
        this.expect(TokenType.EQ);
      } catch {
        throw new Error(`UPDATE: expected = after column "${col.literal}"`);
      }
      let val: unknown;
      try {
        val = this.parseLiteral();
      } catch (e) {
        throw new Error(`UPDATE: ${(e as Error).message}`);
      }
      stmt.assignments[col.literal] = val;
      if (!this.is(TokenType.COMMA)) {
        break;
      }
      this.advance();
    }
    stmt.where = this.parseOptionalWhere();
    return stmt;
  }

  private parseDelete(): DeleteStatement {
    this.advance(); // consume DELETE
    try {
      this.expect(TokenType.FROM);
    } catch {
      throw new Error('DELETE: expected FROM');
    }
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('DELETE: expected table name');
    }
    const where = this.parseOptionalWhere();
    return { kind: 'delete', table: t.literal, where };
  }

  private parseCreate(): Statement {
    this.advance(); // consume CREATE
    if (this.is(TokenType.INDEX)) {
      return this.parseCreateIndex();
    }
    try {
      this.expect(TokenType.TABLE);
    } catch {
      throw new Error('CREATE: expected TABLE or INDEX');
    }
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('CREATE: expected table name');
    }
    const stmt: CreateTableStatement = {
      kind: 'createTable',
      table: t.literal,
      columns: [],
      foreignKeys: [],
    };

    try {
      this.expect(TokenType.LPAREN);
    } catch {
      throw new Error('CREATE TABLE: expected (');
    }
    while (!this.is(TokenType.RPAREN) && !this.is(TokenType.EOF)) {
      if (this.is(TokenType.FOREIGN)) {
        const fk = this.parseForeignKeyConstraint();
        stmt.foreignKeys.push(fk);
      } else {
        const col = this.parseColumnDef();
        stmt.columns.push(col);
      }
      if (this.is(TokenType.COMMA)) {
        this.advance();
      }
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error('CREATE TABLE: expected )');
    }
    return stmt;
  }

  private parseCreateIndex(): CreateIndexStatement {
    this.advance(); // consume INDEX
    let name: Token;
    try {
      name = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('CREATE INDEX: expected index name');
    }
    try {
      this.expect(TokenType.ON);
    } catch {
      throw new Error('CREATE INDEX: expected ON');
    }
    let table: Token;
    try {
      table = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('CREATE INDEX: expected table name');
    }
    try {
      this.expect(TokenType.LPAREN);
    } catch {
      throw new Error('CREATE INDEX: expected (');
    }
    let col: Token;
    try {
      col = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('CREATE INDEX: expected column name');
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error('CREATE INDEX: expected )');
    }
    return { kind: 'createIndex', name: name.literal, table: table.literal, column: col.literal };
  }

  private parseColumnDef(): ColumnDef {
    let name: Token;
    try {
      name = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('column def: expected column name');
    }
    const col: ColumnDef = {
      name: name.literal,
      type: this.advance().literal.toUpperCase(),
      primary: false,
    };
    if (this.is(TokenType.PRIMARY)) {
      this.advance();
      try {
        this.expect(TokenType.KEY);
      } catch {
        throw new Error('column def: expected KEY after PRIMARY');
      }
      col.primary = true;
    }
    return col;
  }

  private parseForeignKeyConstraint(): ForeignKeyConstraint {
    this.advance(); // consume FOREIGN
    try {
      this.expect(TokenType.KEY);
    } catch {
      throw new Error('foreign key: expected KEY after FOREIGN');
    }
    try {
      this.expect(TokenType.LPAREN);
    } catch {
      throw new Error('foreign key: expected (');
    }
    let col: Token;
    try {
      col = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('foreign key: expected column name');
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error('foreign key: expected )');
    }
    try {
      this.expect(TokenType.REFERENCES);
    } catch {
      throw new Error('foreign key: expected REFERENCES');
    }
    let refTable: Token;
    try {
      refTable = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('foreign key: expected referenced table name');
    }
    try {
      this.expect(TokenType.LPAREN);
    } catch {
      throw new Error('foreign key: expected (');
    }
    let refCol: Token;
    try {
      refCol = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('foreign key: expected referenced column name');
    }
    try {
      this.expect(TokenType.RPAREN);
    } catch {
      throw new Error('foreign key: expected )');
    }
    return { column: col.literal, refTable: refTable.literal, refColumn: refCol.literal };
  }

  private parseDrop(): Statement {
    this.advance(); // consume DROP
    if (this.is(TokenType.INDEX)) {
      return this.parseDropIndex();
    }
    try {
      this.expect(TokenType.TABLE);
    } catch {
      throw new Error('DROP: expected TABLE or INDEX');
    }
    let ifExists = false;
    if (this.is(TokenType.IF)) {
      this.advance();
      try {
        this.expect(TokenType.EXISTS);
      } catch {
        throw new Error('DROP: expected EXISTS after IF');
      }
      ifExists = true;
    }
    let t: Token;
    try {
      t = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('DROP: expected table name');
    }
    return { kind: 'dropTable', table: t.literal, ifExists } as DropTableStatement;
  }

  private parseDropIndex(): DropIndexStatement {
    this.advance(); // consume INDEX
    let ifExists = false;
    if (this.is(TokenType.IF)) {
      this.advance();
      try {
        this.expect(TokenType.EXISTS);
      } catch {
        throw new Error('DROP INDEX: expected EXISTS after IF');
      }
      ifExists = true;
    }
    let name: Token;
    try {
      name = this.expect(TokenType.IDENT);
    } catch {
      throw new Error('DROP INDEX: expected index name');
    }
    return { kind: 'dropIndex', name: name.literal, ifExists };
  }

  private parseAnalyze(): AnalyzeStatement {
    this.advance(); // consume ANALYZE
    if (!this.is(TokenType.IDENT)) {
      throw new Error('ANALYZE: expected table name');
    }
    const name = this.advance().literal;
    return { kind: 'analyze', table: name };
  }

  private parseVacuum(): VacuumStatement {
    this.advance(); // consume VACUUM
    if (!this.is(TokenType.IDENT)) {
      throw new Error('VACUUM: expected table name');
    }
    const name = this.advance().literal;
    return { kind: 'vacuum', table: name };
  }

  // parseWithSelect parses: WITH name AS (SELECT ...) SELECT ...
  private parseWithSelect(): SelectStatement {
    this.advance(); // consume WITH
    const ctes: CTEDef[] = [];
    while (true) {
      let name: Token;
      try {
        name = this.expect(TokenType.IDENT);
      } catch {
        throw new Error('WITH: expected CTE name');
      }
      try {
        this.expect(TokenType.AS);
      } catch {
        throw new Error(`WITH ${name.literal}: expected AS`);
      }
      try {
        this.expect(TokenType.LPAREN);
      } catch {
        throw new Error(`WITH ${name.literal}: expected (`);
      }
      let subSel: SelectStatement;
      try {
        subSel = this.parseSelect();
      } catch (e) {
        throw new Error(`WITH ${name.literal}: ${(e as Error).message}`);
      }
      try {
        this.expect(TokenType.RPAREN);
      } catch {
        throw new Error(`WITH ${name.literal}: expected )`);
      }
      ctes.push({ name: name.literal, query: subSel });
      if (!this.is(TokenType.COMMA)) {
        break;
      }
      this.advance();
    }
    // Parse the outer SELECT
    let sel: SelectStatement;
    try {
      sel = this.parseSelect();
    } catch (e) {
      throw new Error(`WITH: outer SELECT: ${(e as Error).message}`);
    }
    sel.with = ctes;
    return sel;
  }

  private parseExplain(): ExplainStatement {
    this.advance(); // consume EXPLAIN
    let analyze = false;
    if (this.is(TokenType.ANALYZE)) {
      analyze = true;
      this.advance();
    }
    let inner: Statement;
    try {
      inner = this.parse();
    } catch (e) {
      throw new Error(`EXPLAIN: ${(e as Error).message}`);
    }
    return { kind: 'explain', analyze, stmt: inner };
  }

  // --- expression parsing: OR > AND > comparison > primary ---

  private parseExpression(): Expression {
    return this.parseOr();
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.is(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'binary', left, op: 'OR', right } as BinaryExpr;
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseComparison();
    while (this.is(TokenType.AND)) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: 'binary', left, op: 'AND', right } as BinaryExpr;
    }
    return left;
  }

  private parseComparison(): Expression {
    const left = this.parsePrimary();

    // IN / NOT IN
    let not = false;
    if (this.is(TokenType.NOT)) {
      this.advance();
      not = true;
    }
    if (this.is(TokenType.IN)) {
      this.advance(); // consume IN
      try {
        this.expect(TokenType.LPAREN);
      } catch {
        throw new Error('IN: expected (');
      }
      // Check if it's a subquery or a literal list
      if (this.is(TokenType.SELECT)) {
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`IN subquery: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('IN subquery: expected )');
        }
        return { kind: 'inSubquery', left, not, query: subSel, values: null } as InSubqueryExpr;
      }
      // Literal list: IN ('a', 'b', ...)
      const values: Expression[] = [];
      while (!this.is(TokenType.RPAREN) && !this.is(TokenType.EOF)) {
        let val: unknown;
        try {
          val = this.parseLiteral();
        } catch (e) {
          throw new Error(`IN list: ${(e as Error).message}`);
        }
        values.push({ kind: 'literal', value: val as number | string | boolean | null } as LiteralExpr);
        if (this.is(TokenType.COMMA)) {
          this.advance();
        }
      }
      try {
        this.expect(TokenType.RPAREN);
      } catch {
        throw new Error('IN list: expected )');
      }
      return { kind: 'inSubquery', left, not, query: null, values } as InSubqueryExpr;
    }
    // If we consumed NOT but didn't see IN, that's an error
    if (not) {
      throw new Error('expected IN after NOT');
    }

    const cur = this.current();
    switch (cur.type) {
      case TokenType.EQ:
      case TokenType.NEQ:
      case TokenType.LT:
      case TokenType.GT:
      case TokenType.LTE:
      case TokenType.GTE: {
        const op = this.advance().literal;
        const right = this.parsePrimary();
        return { kind: 'binary', left, op, right } as BinaryExpr;
      }
    }
    return left;
  }

  private parsePrimary(): Expression {
    // EXISTS (subquery)
    if (this.is(TokenType.EXISTS)) {
      this.advance();
      try {
        this.expect(TokenType.LPAREN);
      } catch {
        throw new Error('EXISTS: expected (');
      }
      let subSel: SelectStatement;
      try {
        subSel = this.parseSelect();
      } catch (e) {
        throw new Error(`EXISTS: ${(e as Error).message}`);
      }
      try {
        this.expect(TokenType.RPAREN);
      } catch {
        throw new Error('EXISTS: expected )');
      }
      return { kind: 'exists', not: false, query: subSel } as ExistsExpr;
    }

    // NOT EXISTS (subquery) or NOT IN (...)
    if (this.is(TokenType.NOT)) {
      this.advance();
      if (this.is(TokenType.EXISTS)) {
        this.advance();
        try {
          this.expect(TokenType.LPAREN);
        } catch {
          throw new Error('NOT EXISTS: expected (');
        }
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`NOT EXISTS: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('NOT EXISTS: expected )');
        }
        return { kind: 'exists', not: true, query: subSel } as ExistsExpr;
      }
      // NOT without EXISTS — error
      throw new Error('expected EXISTS after NOT');
    }

    // (SELECT ...) — scalar subquery as expression
    if (this.is(TokenType.LPAREN)) {
      const saved = this.pos;
      this.advance(); // consume (
      if (this.is(TokenType.SELECT)) {
        let subSel: SelectStatement;
        try {
          subSel = this.parseSelect();
        } catch (e) {
          throw new Error(`scalar subquery: ${(e as Error).message}`);
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error('scalar subquery: expected )');
        }
        return { kind: 'subquery', query: subSel } as SubqueryExpr;
      }
      // Not a subquery — restore and fall through to literal
      this.pos = saved;
    }

    const t = this.current();
    if (this.is(TokenType.IDENT)) {
      this.advance();
      if (this.is(TokenType.LPAREN) && this.isAggFunc(t.literal)) {
        const fn = t.literal.toUpperCase();
        this.advance(); // consume (
        let arg: Expression | null = null;
        if (this.is(TokenType.ASTERISK)) {
          this.advance();
        } else {
          arg = this.parseExpression();
        }
        try {
          this.expect(TokenType.RPAREN);
        } catch {
          throw new Error(`${fn}(): expected )`);
        }
        return { kind: 'aggFunc', func: fn, arg } as AggFuncExpr;
      }
      if (this.is(TokenType.DOT)) {
        this.advance();
        let col: Token;
        try {
          col = this.expect(TokenType.IDENT);
        } catch {
          throw new Error(`expected column name after "${t.literal}".`);
        }
        return { kind: 'ident', table: t.literal, name: col.literal } as IdentExpr;
      }
      return { kind: 'ident', table: '', name: t.literal } as IdentExpr;
    }

    const val = this.parseLiteral();
    return { kind: 'literal', value: val as number | string | boolean | null } as LiteralExpr;
  }

  private parseLiteral(): unknown {
    const t = this.advance();
    switch (t.type) {
      case TokenType.INT_LIT: {
        const n = BigInt(t.literal);
        // Return as number if it fits safely, otherwise bigint
        // Go uses int64, we mirror with bigint but callers can use number
        return n;
      }
      case TokenType.FLOAT_LIT: {
        const f = parseFloat(t.literal);
        if (isNaN(f)) {
          throw new Error(`invalid float "${t.literal}"`);
        }
        return f;
      }
      case TokenType.STRING_LIT:
        return t.literal;
      case TokenType.TRUE:
        return true;
      case TokenType.FALSE:
        return false;
      case TokenType.NULL:
        return null;
      default:
        throw new Error(`expected literal value, got "${t.literal}"`);
    }
  }
}

// Convenience function
export function parse(sql: string, tokens: Token[]): Statement {
  const p = new Parser(tokens);
  return p.parse();
}
