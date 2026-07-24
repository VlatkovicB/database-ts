import { type Token, TokenType, keywords } from "./token";

export class Lexer {
  private input: string;
  private pos: number;

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const ch = this.input[this.pos];

      if (ch === "*") {
        tokens.push({ type: TokenType.ASTERISK, literal: "*" });
        this.pos++;
      } else if (ch === ",") {
        tokens.push({ type: TokenType.COMMA, literal: "," });
        this.pos++;
      } else if (ch === ";") {
        tokens.push({ type: TokenType.SEMICOLON, literal: ";" });
        this.pos++;
      } else if (ch === "(") {
        tokens.push({ type: TokenType.LPAREN, literal: "(" });
        this.pos++;
      } else if (ch === ")") {
        tokens.push({ type: TokenType.RPAREN, literal: ")" });
        this.pos++;
      } else if (ch === "=") {
        tokens.push({ type: TokenType.EQ, literal: "=" });
        this.pos++;
      } else if (ch === "!" && this.peek() === "=") {
        tokens.push({ type: TokenType.NEQ, literal: "!=" });
        this.pos += 2;
      } else if (ch === "<" && this.peek() === "=") {
        tokens.push({ type: TokenType.LTE, literal: "<=" });
        this.pos += 2;
      } else if (ch === ">" && this.peek() === "=") {
        tokens.push({ type: TokenType.GTE, literal: ">=" });
        this.pos += 2;
      } else if (ch === "<") {
        tokens.push({ type: TokenType.LT, literal: "<" });
        this.pos++;
      } else if (ch === ">") {
        tokens.push({ type: TokenType.GT, literal: ">" });
        this.pos++;
      } else if (ch === ".") {
        tokens.push({ type: TokenType.DOT, literal: "." });
        this.pos++;
      } else if (ch === "'") {
        tokens.push(this.readString());
      } else if (isDigit(ch)) {
        tokens.push(this.readNumber());
      } else if (isLetter(ch) || ch === "_") {
        tokens.push(this.readIdent());
      } else {
        this.pos++;
      }
    }

    tokens.push({ type: TokenType.EOF, literal: "" });
    return tokens;
  }

  private peek(): string {
    if (this.pos + 1 >= this.input.length) return "\0";
    return this.input[this.pos + 1];
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && isWhitespace(this.input[this.pos])) {
      this.pos++;
    }
  }

  private readString(): Token {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.input.length && this.input[this.pos] !== "'") {
      this.pos++;
    }
    const val = this.input.slice(start, this.pos);
    this.pos++;
    return { type: TokenType.STRING_LIT, literal: val };
  }

  private readNumber(): Token {
    const start = this.pos;
    let isFloat = false;
    while (
      this.pos < this.input.length &&
      (isDigit(this.input[this.pos]) || this.input[this.pos] === ".")
    ) {
      if (this.input[this.pos] === ".") isFloat = true;
      this.pos++;
    }
    const literal = this.input.slice(start, this.pos);
    return { type: isFloat ? TokenType.FLOAT_LIT : TokenType.INT_LIT, literal };
  }

  private readIdent(): Token {
    const start = this.pos;
    while (
      this.pos < this.input.length &&
      (isLetter(this.input[this.pos]) ||
        this.input[this.pos] === "_" ||
        isDigit(this.input[this.pos]))
    ) {
      this.pos++;
    }
    const word = this.input.slice(start, this.pos);
    const upper = word.toUpperCase();
    if (upper in keywords) {
      return { type: keywords[upper], literal: upper };
    }
    return { type: TokenType.IDENT, literal: word };
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
