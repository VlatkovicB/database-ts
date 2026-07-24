export enum TokenType {
  ILLEGAL,
  EOF,

  IDENT,
  INT_LIT,
  FLOAT_LIT,
  STRING_LIT,

  SELECT,
  FROM,
  WHERE,
  INSERT,
  INTO,
  VALUES,
  UPDATE,
  SET,
  DELETE,
  CREATE,
  TABLE,
  DROP,
  AND,
  OR,
  NOT,
  NULL,
  TRUE,
  FALSE,
  INT,
  TEXT,
  BOOLEAN,
  FLOAT,
  PRIMARY,
  KEY,

  JOIN,
  INNER,
  LEFT,
  OUTER,
  ON,
  AS,

  GROUP,
  BY,
  HAVING,

  DISTINCT,
  ORDER,
  ASC,
  DESC,
  LIMIT,
  OFFSET,

  IF,
  EXISTS,

  EXPLAIN,
  ANALYZE,

  INDEX,
  USING,

  BEGIN,
  COMMIT,
  ROLLBACK,

  VACUUM,

  FOREIGN,
  REFERENCES,

  WITH,
  IN,

  FOR,
  SHARE,

  LATERAL,

  ASTERISK,
  COMMA,
  SEMICOLON,
  LPAREN,
  RPAREN,
  DOT,
  EQ,
  NEQ,
  LT,
  GT,
  LTE,
  GTE,
}

export interface Token {
  type: TokenType;
  literal: string;
}

export const keywords: Record<string, TokenType> = {
  SELECT: TokenType.SELECT,
  FROM: TokenType.FROM,
  WHERE: TokenType.WHERE,
  INSERT: TokenType.INSERT,
  INTO: TokenType.INTO,
  VALUES: TokenType.VALUES,
  UPDATE: TokenType.UPDATE,
  SET: TokenType.SET,
  DELETE: TokenType.DELETE,
  CREATE: TokenType.CREATE,
  TABLE: TokenType.TABLE,
  DROP: TokenType.DROP,
  AND: TokenType.AND,
  OR: TokenType.OR,
  NOT: TokenType.NOT,
  NULL: TokenType.NULL,
  TRUE: TokenType.TRUE,
  FALSE: TokenType.FALSE,
  INT: TokenType.INT,
  TEXT: TokenType.TEXT,
  BOOLEAN: TokenType.BOOLEAN,
  FLOAT: TokenType.FLOAT,
  PRIMARY: TokenType.PRIMARY,
  KEY: TokenType.KEY,
  JOIN: TokenType.JOIN,
  INNER: TokenType.INNER,
  LEFT: TokenType.LEFT,
  OUTER: TokenType.OUTER,
  ON: TokenType.ON,
  AS: TokenType.AS,
  GROUP: TokenType.GROUP,
  BY: TokenType.BY,
  HAVING: TokenType.HAVING,
  DISTINCT: TokenType.DISTINCT,
  ORDER: TokenType.ORDER,
  ASC: TokenType.ASC,
  DESC: TokenType.DESC,
  LIMIT: TokenType.LIMIT,
  OFFSET: TokenType.OFFSET,
  IF: TokenType.IF,
  EXISTS: TokenType.EXISTS,
  EXPLAIN: TokenType.EXPLAIN,
  ANALYZE: TokenType.ANALYZE,
  INDEX: TokenType.INDEX,
  USING: TokenType.USING,
  BEGIN: TokenType.BEGIN,
  COMMIT: TokenType.COMMIT,
  ROLLBACK: TokenType.ROLLBACK,
  VACUUM: TokenType.VACUUM,
  FOREIGN: TokenType.FOREIGN,
  REFERENCES: TokenType.REFERENCES,
  WITH: TokenType.WITH,
  IN: TokenType.IN,
  FOR: TokenType.FOR,
  SHARE: TokenType.SHARE,
  LATERAL: TokenType.LATERAL,
};

const tokenNames: Record<TokenType, string> = {
  [TokenType.ILLEGAL]: "ILLEGAL",
  [TokenType.EOF]: "EOF",
  [TokenType.IDENT]: "IDENT",
  [TokenType.INT_LIT]: "INT_LIT",
  [TokenType.FLOAT_LIT]: "FLOAT_LIT",
  [TokenType.STRING_LIT]: "STRING_LIT",
  [TokenType.SELECT]: "SELECT",
  [TokenType.FROM]: "FROM",
  [TokenType.WHERE]: "WHERE",
  [TokenType.INSERT]: "INSERT",
  [TokenType.INTO]: "INTO",
  [TokenType.VALUES]: "VALUES",
  [TokenType.UPDATE]: "UPDATE",
  [TokenType.SET]: "SET",
  [TokenType.DELETE]: "DELETE",
  [TokenType.CREATE]: "CREATE",
  [TokenType.TABLE]: "TABLE",
  [TokenType.DROP]: "DROP",
  [TokenType.AND]: "AND",
  [TokenType.OR]: "OR",
  [TokenType.NOT]: "NOT",
  [TokenType.NULL]: "NULL",
  [TokenType.TRUE]: "TRUE",
  [TokenType.FALSE]: "FALSE",
  [TokenType.INT]: "INT",
  [TokenType.TEXT]: "TEXT",
  [TokenType.BOOLEAN]: "BOOLEAN",
  [TokenType.FLOAT]: "FLOAT",
  [TokenType.PRIMARY]: "PRIMARY",
  [TokenType.KEY]: "KEY",
  [TokenType.JOIN]: "JOIN",
  [TokenType.INNER]: "INNER",
  [TokenType.LEFT]: "LEFT",
  [TokenType.OUTER]: "OUTER",
  [TokenType.ON]: "ON",
  [TokenType.AS]: "AS",
  [TokenType.GROUP]: "GROUP",
  [TokenType.BY]: "BY",
  [TokenType.HAVING]: "HAVING",
  [TokenType.DISTINCT]: "DISTINCT",
  [TokenType.ORDER]: "ORDER",
  [TokenType.ASC]: "ASC",
  [TokenType.DESC]: "DESC",
  [TokenType.LIMIT]: "LIMIT",
  [TokenType.OFFSET]: "OFFSET",
  [TokenType.IF]: "IF",
  [TokenType.EXISTS]: "EXISTS",
  [TokenType.EXPLAIN]: "EXPLAIN",
  [TokenType.ANALYZE]: "ANALYZE",
  [TokenType.INDEX]: "INDEX",
  [TokenType.USING]: "USING",
  [TokenType.BEGIN]: "BEGIN",
  [TokenType.COMMIT]: "COMMIT",
  [TokenType.ROLLBACK]: "ROLLBACK",
  [TokenType.VACUUM]: "VACUUM",
  [TokenType.FOREIGN]: "FOREIGN",
  [TokenType.REFERENCES]: "REFERENCES",
  [TokenType.WITH]: "WITH",
  [TokenType.IN]: "IN",
  [TokenType.FOR]: "FOR",
  [TokenType.SHARE]: "SHARE",
  [TokenType.LATERAL]: "LATERAL",
  [TokenType.ASTERISK]: "*",
  [TokenType.COMMA]: ",",
  [TokenType.SEMICOLON]: ";",
  [TokenType.LPAREN]: "(",
  [TokenType.RPAREN]: ")",
  [TokenType.DOT]: ".",
  [TokenType.EQ]: "=",
  [TokenType.NEQ]: "!=",
  [TokenType.LT]: "<",
  [TokenType.GT]: ">",
  [TokenType.LTE]: "<=",
  [TokenType.GTE]: ">=",
};

export function tokenName(t: TokenType): string {
  return tokenNames[t] ?? "UNKNOWN";
}

export function tokenCategory(t: TokenType): string {
  switch (t) {
    case TokenType.SELECT:
    case TokenType.FROM:
    case TokenType.WHERE:
    case TokenType.INSERT:
    case TokenType.INTO:
    case TokenType.VALUES:
    case TokenType.UPDATE:
    case TokenType.SET:
    case TokenType.DELETE:
    case TokenType.CREATE:
    case TokenType.TABLE:
    case TokenType.DROP:
    case TokenType.AND:
    case TokenType.OR:
    case TokenType.NOT:
    case TokenType.NULL:
    case TokenType.TRUE:
    case TokenType.FALSE:
    case TokenType.JOIN:
    case TokenType.INNER:
    case TokenType.LEFT:
    case TokenType.OUTER:
    case TokenType.ON:
    case TokenType.AS:
    case TokenType.GROUP:
    case TokenType.BY:
    case TokenType.HAVING:
    case TokenType.DISTINCT:
    case TokenType.ORDER:
    case TokenType.ASC:
    case TokenType.DESC:
    case TokenType.LIMIT:
    case TokenType.OFFSET:
    case TokenType.IF:
    case TokenType.EXISTS:
    case TokenType.EXPLAIN:
    case TokenType.ANALYZE:
    case TokenType.INDEX:
    case TokenType.USING:
    case TokenType.BEGIN:
    case TokenType.COMMIT:
    case TokenType.ROLLBACK:
    case TokenType.VACUUM:
    case TokenType.FOREIGN:
    case TokenType.REFERENCES:
    case TokenType.WITH:
    case TokenType.IN:
    case TokenType.FOR:
    case TokenType.SHARE:
    case TokenType.LATERAL:
      return "keyword";
    case TokenType.INT:
    case TokenType.TEXT:
    case TokenType.BOOLEAN:
    case TokenType.FLOAT:
    case TokenType.PRIMARY:
    case TokenType.KEY:
      return "type";
    case TokenType.IDENT:
      return "ident";
    case TokenType.INT_LIT:
    case TokenType.FLOAT_LIT:
    case TokenType.STRING_LIT:
      return "literal";
    case TokenType.EQ:
    case TokenType.NEQ:
    case TokenType.LT:
    case TokenType.GT:
    case TokenType.LTE:
    case TokenType.GTE:
      return "operator";
    case TokenType.ASTERISK:
    case TokenType.COMMA:
    case TokenType.SEMICOLON:
    case TokenType.LPAREN:
    case TokenType.RPAREN:
    case TokenType.DOT:
      return "punct";
    default:
      return "other";
  }
}
