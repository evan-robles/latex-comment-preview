# LaTeX Comment Preview

Preview LaTeX math written inside **Python comments** — `#` line comments and
`'''` / `"""` docstrings — without leaving the editor. Inspired by inline-math
preview extensions, scoped to comments so your math notation in code reads as math.

## What it does

- **Hover preview** — hover the mouse over a `$...$` or `$$...$$` span inside a
  comment and a popup shows the rendered math.
- **Cursor preview** — move the caret (or make a selection) into a math span and
  a rendered image appears inline, just after the span. Updates live as you move.
- Only text between `$...$` (inline) and `$$...$$` (display) is rendered, so
  ordinary prose in a comment is never treated as math.
- Rendering is done by **KaTeX, bundled offline** — no network access required.

### Scope

| Detected | Example |
|---|---|
| `#` line comments | `# energy $E = mc^2$` |
| `"""` / `'''` docstrings (incl. multi-line) | `"""Fock matrix $F = h + J - K$."""` |

Math inside ordinary string literals is **not** rendered (only comments), and a
`#` or `$` inside a normal string is correctly ignored.

## Install

From the packaged `.vsix`:

```bash
code --install-extension latex-comment-preview-0.1.0.vsix
```

Or in VS Code: **Extensions panel → ⋯ menu → Install from VSIX…**

## Develop / run from source

```bash
npm install
npm run build          # bundle to dist/extension.js
# then press F5 in VS Code to launch an Extension Development Host
```

Open `sample.py` in the dev host to try it.

## Example

The repo's [`sample.py`](sample.py) demonstrates what does and doesn't render —
hover the math, or move the caret onto a math line to reveal the source:

```python
# The overlap matrix element is the inner product $S_{\mu\nu} = \langle \phi_\mu | \phi_\nu \rangle$.

# Display math also works: $$F\mathbf{c} = \epsilon S \mathbf{c}$$

def scf_energy():
    """
    Computes the SCF energy.

    The Fock matrix is $F = h + J - K$ where the exchange term keeps
    same-spin electrons apart. Total energy:

    $$E = \sum_{\mu\nu} P_{\mu\nu} (h_{\mu\nu} + F_{\mu\nu}) / 2$$
    """
    pass

# Plain prose with no math is never rendered, even in a # comment.
# Escaped \$5.00 is not a delimiter.

x = "a string with a # and a $ inside should be ignored"  # but $E=mc^2$ here renders
```

Note the last line: `#`/`$` inside a normal string literal are ignored — only the
`$E=mc^2$` in the trailing comment renders.

## Settings

| Setting | Default | Description |
|---|---|---|
| `latexCommentPreview.enable` | `true` | Master on/off. |
| `latexCommentPreview.hover` | `true` | Show the hover popup. |
| `latexCommentPreview.inlineOnCursor` | `true` | Show the inline render when the cursor is in a span. |
| `latexCommentPreview.maxRenderLength` | `2000` | Skip spans longer than this (safety guard). |

Command: **LaTeX Comment Preview: Toggle** (`latexCommentPreview.toggle`).

## How it works

1. A lightweight line scanner tracks comment / docstring / string state and
   extracts `$...$` and `$$...$$` spans with exact document ranges
   (`src/parser.ts`).
2. Each span is rendered by KaTeX to MathML, wrapped in an SVG `foreignObject`,
   and embedded as a `data:` URI so it can appear in both a Markdown hover and a
   `contentIconPath` decoration (`src/render.ts`). Results are cached.
3. The extension registers a `HoverProvider` and listens to selection changes to
   paint the cursor-triggered inline decoration (`src/extension.ts`).

## Known limitations

- The scanner is line-based, not a full Python grammar; exotic nesting of quotes
  may occasionally mis-classify a region. Real-world code is handled correctly.
- Math color is a neutral tone chosen for contrast on both light and dark themes
  (the extension host does not expose computed theme colors).
- A `$x$` that you wrote as *prose about the syntax* will still render as math —
  that is `$...$` doing its job.

## License

MIT

---

**Author:** Evan S. Robles
**Contact:** [GitHub @evan-robles](https://github.com/evan-robles)
