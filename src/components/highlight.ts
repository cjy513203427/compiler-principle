// Display-only syntax colouring for code snippets. It never feeds a compiler stage.

export type SnippetLanguage = 'grammar' | 'regex' | 'c' | 'asm' | 'shell' | 'text';
export type TokenClass =
  'comment' | 'keyword' | 'string' | 'number' | 'type' | 'name' | 'operator' | 'function' | 'plain';
export interface Piece {
  text: string;
  kind: TokenClass;
}

const C_KEYWORDS = new Set([
  'int',
  'bool',
  'long',
  'char',
  'void',
  'return',
  'if',
  'else',
  'while',
  'for',
  'true',
  'false',
  'static',
  'const',
  'unsigned',
  'struct',
  'print',
  '__attribute__',
]);
const REGISTER =
  /^(r[a-d]x|r[sd]i|r[sb]p|r(?:8|9|1[0-5])[dwb]?|e[a-d]x|e[sd]i|e[sb]p|[a-d][xlh]|[sd]il?|[sb]pl?|rip|xmm\d+)$/i;

function scan(
  line: string,
  rules: [RegExp, TokenClass | ((match: string) => TokenClass)][],
): Piece[] {
  const pieces: Piece[] = [];
  let rest = line;
  while (rest.length) {
    let matched = false;
    for (const [pattern, kind] of rules) {
      const m = pattern.exec(rest);
      if (m && m.index === 0 && m[0].length) {
        pieces.push({ text: m[0], kind: typeof kind === 'function' ? kind(m[0]) : kind });
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const last = pieces.at(-1);
      if (last?.kind === 'plain') last.text += rest[0];
      else pieces.push({ text: rest[0], kind: 'plain' });
      rest = rest.slice(1);
    }
  }
  return pieces;
}

export function highlightLine(line: string, language: SnippetLanguage): Piece[] {
  switch (language) {
    case 'grammar':
      return scan(line, [
        [/^#.*/, 'comment'],
        [/^(->|→|⇒|⇓|\|)/, 'keyword'],
        [/^(ε|\$)/, 'number'],
        [/^[a-z_][A-Za-z0-9_]*'*/, 'name'],
        [/^[A-Z][A-Za-z0-9_]*/, 'type'],
        [/^[0-9]+/, 'number'],
        [/^[+\-*/=;(){}<>]/, 'operator'],
      ]);
    case 'regex':
      return scan(line, [
        [/^#.*/, 'comment'],
        [/^[A-Za-z_][A-Za-z0-9_]*(?=\s*:)/, 'function'],
        [/^\[(?:\\.|[^\]])*\]/, 'string'],
        [/^\\./, 'string'],
        [/^[*+?|()]/, 'keyword'],
        [/^(—\S*→|→|ε)/, 'operator'],
        [/^[0-9]+/, 'number'],
      ]);
    case 'c':
      return scan(line, [
        [/^\/\/.*/, 'comment'],
        [/^"(?:\\.|[^"])*"/, 'string'],
        [/^[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, (w) => (C_KEYWORDS.has(w) ? 'keyword' : 'function')],
        [/^[A-Za-z_][A-Za-z0-9_]*/, (w) => (C_KEYWORDS.has(w) ? 'keyword' : 'name')],
        [/^(0x[0-9a-fA-F]+|[0-9]+)/, 'number'],
        [/^[+\-*/=<>!&|%^~?:;,.{}()[\]]/, 'operator'],
      ]);
    case 'asm': {
      let first = true;
      return scan(line, [
        [/^[;#].*/, 'comment'],
        [/^\.?[A-Za-z_][\w.$]*:/, 'function'],
        [/^\.[A-Za-z_]\w*/, 'type'],
        [
          /^[A-Za-z_][A-Za-z0-9_]*/,
          (w) => {
            if (REGISTER.test(w)) return 'name';
            if (/^(DWORD|QWORD|WORD|BYTE|PTR|OFFSET|FLAT)$/i.test(w)) return 'type';
            if (first) {
              first = false;
              return 'keyword';
            }
            return 'plain';
          },
        ],
        [/^-?(0x[0-9a-fA-F]+|[0-9]+)/, 'number'],
        [/^[[\]+\-*,%()]/, 'operator'],
      ]);
    }
    case 'shell':
      return scan(line, [
        [/^#.*/, 'comment'],
        [/^(gcc|bash|npm|node|wsl\.exe)\b/, 'function'],
        [/^--?[A-Za-z][\w=-]*/, 'keyword'],
        [/^[\w./-]+\.(c|s|sh)\b/, 'string'],
      ]);
    case 'text':
      return scan(line, [[/^#.*/, 'comment']]);
  }
}
