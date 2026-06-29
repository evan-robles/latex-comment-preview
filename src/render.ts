import * as katex from "katex";

export interface RenderResult {
  /** A data: URI (SVG) suitable for a Markdown image or decoration. */
  dataUri: string;
  /** Approximate rendered width/height in px (for decoration sizing hints). */
  width: number;
  height: number;
}

interface CacheEntry {
  color: string;
  result: RenderResult | null;
  error: string | null;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tex: string, display: boolean): string {
  return (display ? "D|" : "I|") + tex;
}

/**
 * Render a LaTeX string to an SVG data URI via KaTeX (MathML output wrapped in
 * an SVG <foreignObject>). Returns null result + an error string on failure.
 *
 * `color` should be the editor foreground (CSS color) so math matches the theme.
 */
export function renderLatex(
  tex: string,
  display: boolean,
  color: string,
  clampToLine = false,
  exactWidth?: number
): { result: RenderResult | null; error: string | null } {
  const key =
    (clampToLine ? "C|" : "") +
    (exactWidth ? `W${exactWidth}|` : "") +
    cacheKey(tex, display);
  const cached = cache.get(key);
  if (cached && cached.color === color) {
    return { result: cached.result, error: cached.error };
  }

  // Auto-wrap top-level alignment (&) / row-break (\\) content in an `aligned`
  // environment. `&` and `\\` are only valid inside an alignment environment;
  // a bare `Q_{ij} &= ...` is the common intent for display math, so wrap it
  // instead of failing with "Expected 'EOF', got '&'".
  const prepared = maybeWrapAligned(tex, display);

  let mathml: string;
  try {
    // output: "mathml" gives clean, self-contained markup that survives inside
    // an SVG foreignObject without KaTeX's CSS stylesheet.
    mathml = katex.renderToString(prepared, {
      displayMode: display,
      output: "mathml",
      throwOnError: true,
      strict: false,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const entry: CacheEntry = { color, result: null, error };
    cache.set(key, entry);
    return { result: null, error };
  }

  const fontPx = clampToLine ? 14 : display ? 20 : 16;

  // Width estimate from KaTeX's *rendered* HTML glyph stream, not the source.
  // We render an HTML copy purely to measure: sum the em-based inter-atom
  // spacings KaTeX emits (margin-right) plus a per-glyph advance from a small
  // metric table. This adapts to what actually renders (superscripts, fractions,
  // big operators) far better than counting source characters, so the box hugs
  // the math. Node can't get true pixel width (KaTeX leaves it to the browser),
  // so we still err slightly generous (+ small pad) — a few harmless px beats
  // clipping. Rows split on \\ for multi-line aligned blocks.
  let widthEm = 0;
  let measureHtml = "";
  try {
    measureHtml = katex.renderToString(prepared, {
      displayMode: display,
      output: "html",
      throwOnError: true,
      strict: false,
    });
    widthEm = estimateEmFromHtml(measureHtml);
  } catch {
    widthEm = Math.max(prepared.length * 0.5, 1); // fallback
  }
  const rows = prepared.split(/\\\\/).length;
  // Width: prefer an exact measurement (from the webview measurer) when given.
  // Otherwise fall back to the font-metric em estimate at full scale + small pad,
  // which errs GENEROUS on purpose (a slight gap beats clipping; a tighter
  // calibration was tried and clipped). True pixel width is not computable in
  // Node — see README.
  // Trailing math-italic glyphs (d, r, f, ...) have italic side-bearing that
  // getBoundingClientRect does not fully include, so a small guard is required or
  // the tail clips. +9 never clips; it can leave a few px of gap on short
  // expressions — that tradeoff (gap, never clip) is intentional.
  const MEASURE_GUARD = 9;
  const width =
    exactWidth && exactWidth > 0
      ? Math.min(
          clampToLine ? 600 : 900,
          Math.max(8, Math.round(exactWidth) + MEASURE_GUARD)
        )
      : Math.min(
          clampToLine ? 600 : 900,
          Math.max(20, Math.round(widthEm * fontPx) + 8)
        );
  const metrics = measuredMetricsPx(prepared, display, fontPx);
  let height: number;
  if (clampToLine) {
    // Grow the box to the true content height so tall math (fractions, sums with
    // limits) renders full size; the editor line grows to fit. Floor at 22px so
    // ordinary inline math keeps a little headroom. (Adjacent-line spacing for
    // very tall math is handled by the author leaving a blank line.)
    height = Math.max(22, metrics.total + 6);
  } else {
    const lineH = display ? 30 : 26;
    height = rows > 1 ? rows * lineH + 12 : display ? 56 : 30;
  }

  const svg = buildSvg(mathml, width, height, color, fontPx);
  const dataUri =
    "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

  const result: RenderResult = { dataUri, width, height };
  cache.set(key, { color, result, error: null });
  return { result, error: null };
}

/**
 * Rendered metrics (px) from KaTeX's dom tree: `height` above the baseline,
 * `depth` below, and `total`. Used to grow the inline box for tall content
 * (fractions) and to baseline-align the image so `E =` etc. sit on the text
 * baseline instead of overlapping neighboring lines.
 */
function measuredMetricsPx(
  tex: string,
  display: boolean,
  fontPx: number
): { height: number; depth: number; total: number } {
  try {
    const k = katex as unknown as {
      __renderToDomTree?: (
        t: string,
        o: object
      ) => { height: number; depth: number };
    };
    if (typeof k.__renderToDomTree === "function") {
      const tree = k.__renderToDomTree(tex, {
        displayMode: display,
        throwOnError: false,
      });
      const h = Math.ceil(tree.height * fontPx);
      const d = Math.ceil(tree.depth * fontPx);
      return { height: h, depth: d, total: h + d };
    }
  } catch {
    // fall through
  }
  return { height: 12, depth: 4, total: 16 };
}

/**
 * Estimate the rendered width (in em) of KaTeX HTML output. KaTeX renders each
 * atom as a span and inserts spacing as `margin-right:<em>`; the glyph advance
 * widths come from the fonts. We sum the explicit margins and add a per-glyph
 * advance from a small metric table keyed by character class. This tracks what
 * actually rendered (incl. superscripts/fractions/operators), unlike counting
 * source characters. It's an estimate (true width needs a browser), erring
 * slightly generous so the box never clips.
 */
function estimateEmFromHtml(html: string): number {
  // Sum the inter-atom spacing KaTeX emits.
  let em = 0;
  for (const m of html.matchAll(/margin-right:([0-9.]+)em/g)) {
    em += parseFloat(m[1]);
  }
  // Sum per-glyph advances from the visible text (tags stripped).
  const text = html.replace(/<[^>]+>/g, "");
  for (const ch of text) {
    em += glyphAdvanceEm(ch);
  }
  return Math.max(em, 0.5);
}

/** Approximate advance width (em) for a single rendered glyph, by class. */
function glyphAdvanceEm(ch: string): number {
  if (/[A-Za-z0-9]/.test(ch)) return 0.5;
  if (/[=+\-<>*/]/.test(ch)) return 0.6;
  if (/[(){}\[\]|.,;:'"]/.test(ch)) return 0.32;
  if (/[∑∫∏√∮⨊]/.test(ch)) return 0.7; // large operators
  if (/\s/.test(ch)) return 0.2;
  return 0.55; // greek / misc symbols
}

function buildSvg(
  mathml: string,
  width: number,
  height: number,
  color: string,
  fontPx: number
): string {
  // foreignObject lets the webview/markdown engine lay out the MathML; we only
  // supply a viewport and the theme color.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${fontPx}px;color:${color};display:flex;align-items:center;justify-content:flex-start;height:${height}px;line-height:1;white-space:nowrap;">
      ${mathml}
    </div>
  </foreignObject>
</svg>`;
}

/**
 * If `tex` uses top-level alignment (`&`) or row breaks (`\\`) but is not
 * already inside an environment, wrap it in `aligned` so KaTeX accepts it.
 *
 * Bare `&`/`\\` are only legal inside an alignment environment; the common
 * intent (`Q_{ij} &= ...`, or multi-line equations) is an aligned block, so we
 * supply one rather than erroring.
 */
function maybeWrapAligned(tex: string, display: boolean): string {
  // Already inside an environment? Leave it alone.
  if (/\\begin\{/.test(tex)) {
    return tex;
  }
  // Does it contain an UNescaped & or a \\ row break?
  const hasAlign = /(^|[^\\])&/.test(tex);
  const hasRowBreak = /\\\\/.test(tex);
  if (!hasAlign && !hasRowBreak) {
    return tex;
  }
  // `aligned` needs display mode to look right; if this was an inline $...$ span
  // with alignment, render it display-style inside the wrap.
  void display;
  return `\\begin{aligned}${tex}\\end{aligned}`;
}

export function clearRenderCache(): void {
  cache.clear();
}
