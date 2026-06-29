import * as vscode from "vscode";

export type SpanContext = "comment" | "docstring";

export interface LatexSpan {
  /** The LaTeX source between the delimiters (without the $ / $$). */
  tex: string;
  /** True for $$...$$ (display mode), false for $...$ (inline mode). */
  display: boolean;
  /** Range covering the full delimited span, including the $ delimiters. */
  range: vscode.Range;
  /** Whether this span lives in a `#` comment or a triple-quoted docstring. */
  context: SpanContext;
}

/**
 * Find all renderable LaTeX spans inside comments of a Python document.
 *
 * Scope:
 *  - `#` line comments (the part after the first unquoted #)
 *  - triple-quoted docstrings (''' ''' and """ """), including multi-line
 *
 * Only text between $...$ (inline) or $$...$$ (display) delimiters is returned,
 * so plain prose in a comment is never treated as math.
 *
 * This is a deliberately lightweight scanner: it tracks string/comment state
 * line-by-line well enough for real code, not a full Python grammar.
 */
export function findLatexSpans(doc: vscode.TextDocument): LatexSpan[] {
  const spans: LatexSpan[] = [];
  const lineCount = doc.lineCount;

  // Docstring state carried across lines.
  let inDocstring = false;
  let docstringDelim: '"""' | "'''" | null = null;

  for (let line = 0; line < lineCount; line++) {
    const text = doc.lineAt(line).text;

    if (inDocstring) {
      // Look for the closing delimiter on this line.
      const closeIdx = text.indexOf(docstringDelim!);
      if (closeIdx === -1) {
        // Whole line is inside the docstring → scan it all for math.
        collectMathInRegion(doc, line, 0, text.length, text, spans, "docstring");
      } else {
        // Up to the closing delimiter is docstring content.
        collectMathInRegion(doc, line, 0, closeIdx, text, spans, "docstring");
        inDocstring = false;
        const afterClose = closeIdx + docstringDelim!.length;
        docstringDelim = null;
        // Process the remainder of the line as normal code (may open a new
        // docstring or contain a # comment).
        scanCodeLine(doc, line, afterClose, text, spans, (open, delim) => {
          inDocstring = open;
          docstringDelim = delim;
        });
      }
      continue;
    }

    scanCodeLine(doc, line, 0, text, spans, (open, delim) => {
      inDocstring = open;
      docstringDelim = delim;
    });
  }

  return spans;
}

/**
 * Scan a (portion of a) code line that is NOT currently inside a docstring.
 * Detects: a # comment (rest of line), a single-line triple-quoted string, or
 * the opening of a multi-line docstring (reported via onDocstringStateChange).
 *
 * Regular single/double-quoted string literals are skipped so that a `#` or `$`
 * inside a normal string is not misread.
 */
function scanCodeLine(
  doc: vscode.TextDocument,
  line: number,
  startCol: number,
  text: string,
  spans: LatexSpan[],
  onDocstringStateChange: (open: boolean, delim: '"""' | "'''" | null) => void
): void {
  let i = startCol;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const triple = text.substr(i, 3);

    // Triple-quoted string.
    if (triple === '"""' || triple === "'''") {
      const delim = triple as '"""' | "'''";
      const closeIdx = text.indexOf(delim, i + 3);
      if (closeIdx === -1) {
        // Opens a multi-line docstring; content starts after the delimiter.
        collectMathInRegion(doc, line, i + 3, n, text, spans, "docstring");
        onDocstringStateChange(true, delim);
        return;
      } else {
        // Single-line triple-quoted string: treat its body as a docstring region.
        collectMathInRegion(doc, line, i + 3, closeIdx, text, spans, "docstring");
        i = closeIdx + 3;
        continue;
      }
    }

    // Ordinary string literal — skip to its matching quote so inner # / $ are ignored.
    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(text, i, ch);
      continue;
    }

    // Line comment — everything after # is comment text.
    if (ch === "#") {
      collectMathInRegion(doc, line, i + 1, n, text, spans, "comment");
      return;
    }

    i++;
  }
}

/** Return the index just past a closing quote of an ordinary string literal. */
function skipStringLiteral(text: string, start: number, quote: string): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    if (text[i] === "\\") {
      i += 2; // skip escaped char
      continue;
    }
    if (text[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return n; // unterminated on this line
}

/**
 * Within a comment/docstring region [startCol, endCol) of `text` on `line`,
 * find $...$ and $$...$$ spans and append them to `spans`.
 */
function collectMathInRegion(
  doc: vscode.TextDocument,
  line: number,
  startCol: number,
  endCol: number,
  text: string,
  spans: LatexSpan[],
  context: SpanContext
): void {
  let i = startCol;
  while (i < endCol) {
    if (text[i] !== "$") {
      i++;
      continue;
    }

    const isDisplay = text[i + 1] === "$";
    const delimLen = isDisplay ? 2 : 1;
    const contentStart = i + delimLen;

    // Find the matching closing delimiter within the region.
    const closeIdx = findClosingDollar(text, contentStart, endCol, isDisplay);
    if (closeIdx === -1) {
      // No close on this region — stop (don't swallow the rest).
      break;
    }

    const tex = text.substring(contentStart, closeIdx).trim();
    if (tex.length > 0) {
      const spanEnd = closeIdx + delimLen;
      spans.push({
        tex,
        display: isDisplay,
        range: new vscode.Range(line, i, line, spanEnd),
        context,
      });
    }
    i = closeIdx + delimLen;
  }
}

/** Find the closing $ (or $$) starting from `from`, within [.., endCol). */
function findClosingDollar(
  text: string,
  from: number,
  endCol: number,
  isDisplay: boolean
): number {
  let i = from;
  while (i < endCol) {
    if (text[i] === "\\") {
      i += 2; // an escaped \$ is not a delimiter
      continue;
    }
    if (text[i] === "$") {
      if (isDisplay) {
        if (text[i + 1] === "$") {
          return i;
        }
        // a single $ inside a $$ block is fine, keep scanning
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/** Return the LaTeX span whose range contains `position`, if any. */
export function spanAt(
  spans: LatexSpan[],
  position: vscode.Position
): LatexSpan | undefined {
  return spans.find((s) => s.range.contains(position));
}
