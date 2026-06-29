import * as vscode from "vscode";
import { findLatexSpans, spanAt, LatexSpan } from "./parser";
import { renderLatex, clearRenderCache } from "./render";
import { resolveThemeColors, clearThemeCache } from "./theme";
import {
  initMeasurer,
  requestMeasure,
  getExactDimensions,
} from "./measurer";

const LANG = "python";

let enabled = true;
// Collapses the raw $...$ source text to zero width (display:none) so the
// rendered math can take its place.
let hideDecoration: vscode.TextEditorDecorationType;
// Carries the rendered math image, attached per-span via before.contentIconPath.
let renderDecoration: vscode.TextEditorDecorationType;
// Used only to show inline error text after a span that fails to render.
let errorDecoration: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration("latexCommentPreview");
  enabled = cfg().get<boolean>("enable", true);

  hideDecoration = vscode.window.createTextEditorDecorationType({
    // Inject CSS via textDecoration to collapse the raw source to nothing.
    textDecoration: "none; display: none;",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  renderDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  errorDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  context.subscriptions.push(hideDecoration, renderDecoration, errorDecoration);

  // --- Hover provider ---------------------------------------------------------
  const hover = vscode.languages.registerHoverProvider(LANG, {
    provideHover(doc, position) {
      if (!enabled || !cfg().get<boolean>("hover", true)) {
        return undefined;
      }
      const spans = findLatexSpans(doc);
      const span = spanAt(spans, position);
      if (!span) {
        return undefined;
      }
      const md = renderToMarkdown(span, cfg().get<number>("maxRenderLength", 2000));
      if (!md) {
        return undefined;
      }
      return new vscode.Hover(md, span.range);
    },
  });
  context.subscriptions.push(hover);

  // --- Cursor-triggered inline decoration ------------------------------------
  const updateForEditor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.languageId !== LANG) {
      return;
    }
    if (!enabled || !cfg().get<boolean>("inlineOnCursor", true)) {
      clearAll(editor);
      return;
    }
    updateInlineDecorations(editor, cfg().get<number>("maxRenderLength", 2000));
  };

  // Webview measurer (TEST). Repaints when an exact measurement arrives.
  initMeasurer(context, () => updateForEditor(vscode.window.activeTextEditor));

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => updateForEditor(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((ed) => updateForEditor(ed)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document === ed.document) {
        updateForEditor(ed);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("latexCommentPreview") ||
        e.affectsConfiguration("editor.tokenColorCustomizations") ||
        e.affectsConfiguration("workbench.colorTheme")
      ) {
        enabled = cfg().get<boolean>("enable", true);
        clearThemeCache(); // theme/customizations changed → re-resolve colors
        clearRenderCache(); // color may have changed → re-render
        updateForEditor(vscode.window.activeTextEditor);
      }
    }),
    // Re-render when the user switches color theme (comment/docstring color changes).
    vscode.window.onDidChangeActiveColorTheme(() => {
      clearThemeCache();
      clearRenderCache();
      updateForEditor(vscode.window.activeTextEditor);
    })
  );

  // --- Toggle command --------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("latexCommentPreview.toggle", () => {
      enabled = !enabled;
      vscode.window.showInformationMessage(
        `LaTeX Comment Preview ${enabled ? "enabled" : "disabled"}`
      );
      updateForEditor(vscode.window.activeTextEditor);
    })
  );

  // Initial paint.
  updateForEditor(vscode.window.activeTextEditor);
}

export function deactivate() {
  clearRenderCache();
}

/** Neutral foreground for the HOVER preview (unchanged). */
function themeColor(): string {
  // VS Code doesn't expose computed theme colors to the extension host directly;
  // use a high-contrast neutral that reads on both light and dark themes.
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light ||
    kind === vscode.ColorThemeKind.HighContrastLight
    ? "#1e1e1e"
    : "#e6e6e6";
}

/**
 * Color for the INLINE render of a span, matching the editor's own color for
 * the context the span lives in (a `#` comment vs. a docstring/string token), so
 * the rendered math reads as part of the surrounding code.
 *
 * Priority:
 *   1. Explicit `renderColor` override (applies to all contexts).
 *   2. The active theme's resolved comment / docstring color (see theme.ts),
 *      including the user's tokenColorCustomizations.
 *   3. The theme's editor.foreground, then a neutral per-kind default.
 */
function spanColor(context: "comment" | "docstring"): string {
  const cfg = vscode.workspace.getConfiguration("latexCommentPreview");
  const override = cfg.get<string>("renderColor", "");
  if (override && override.trim()) {
    return override.trim();
  }

  const theme = resolveThemeColors();
  const fromTheme = context === "docstring" ? theme.docstring : theme.comment;
  if (fromTheme) {
    return fromTheme;
  }
  if (theme.foreground) {
    return theme.foreground;
  }

  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light ||
    kind === vscode.ColorThemeKind.HighContrastLight
    ? "#1e1e1e"
    : "#e6e6e6";
}

function renderToMarkdown(
  span: LatexSpan,
  maxLen: number
): vscode.MarkdownString | undefined {
  if (span.tex.length > maxLen) {
    return undefined;
  }
  const { result, error } = renderLatex(span.tex, span.display, themeColor());
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  if (error || !result) {
    md.appendMarkdown(`**LaTeX error:** \`${escapeMd(error ?? "render failed")}\``);
    return md;
  }
  md.appendMarkdown(`![latex](${result.dataUri})`);
  return md;
}

function clearAll(editor: vscode.TextEditor): void {
  editor.setDecorations(hideDecoration, []);
  editor.setDecorations(renderDecoration, []);
  editor.setDecorations(errorDecoration, []);
}

function updateInlineDecorations(editor: vscode.TextEditor, maxLen: number): void {
  const doc = editor.document;
  const spans = findLatexSpans(doc);
  if (spans.length === 0) {
    clearAll(editor);
    return;
  }

  // Color is chosen per-span from the theme based on the span's context
  // (comment vs docstring); hover keeps the neutral themeColor.
  const hideRanges: vscode.Range[] = [];      // raw source to collapse
  const renderOpts: vscode.DecorationOptions[] = [];  // math images in place
  const errorOpts: vscode.DecorationOptions[] = [];   // inline error text

  for (const span of spans) {
    // Reveal raw text (no render) when the caret is on the span's line, so you
    // can edit the LaTeX. Render-and-replace it otherwise.
    const caretOnLine = editor.selections.some(
      (sel) =>
        sel.active.line === span.range.start.line &&
        sel.active.line === span.range.end.line
    );
    if (caretOnLine) {
      continue;
    }

    if (span.tex.length > maxLen) {
      continue;
    }

    const color = spanColor(span.context);

    // TEST: if webview measuring is on, use the exact measured width when ready,
    // otherwise request it (repaint fires when it returns) and use the estimate
    // in the meantime.
    const useMeasure = vscode.workspace
      .getConfiguration("latexCommentPreview")
      .get<boolean>("useWebviewMeasure", false);
    let exactWidth: number | undefined;
    if (useMeasure) {
      const fontPx = 14; // inline clamp font size (matches render.ts clampToLine)
      const exact = getExactDimensions(span.tex, span.display, fontPx);
      if (exact && exact.width > 0) {
        exactWidth = exact.width;
      } else {
        requestMeasure(span.tex, span.display, fontPx);
      }
    }

    const { result, error } = renderLatex(
      span.tex,
      span.display,
      color,
      true,
      exactWidth
    );

    if (error || !result) {
      // Don't hide on error — keep the raw source visible and append a hint so
      // the user can see and fix the broken LaTeX.
      errorOpts.push({
        range: new vscode.Range(span.range.end, span.range.end),
        renderOptions: {
          after: {
            contentText: `  ⚠ ${truncate(error ?? "render failed", 60)}`,
            color: "#c0863a",
            fontStyle: "italic",
          },
        },
      });
      continue;
    }

    // Hide the raw $...$ source and draw the rendered math where it began.
    hideRanges.push(span.range);
    renderOpts.push({
      // Anchor the image at the start of the (now-collapsed) span.
      range: new vscode.Range(span.range.start, span.range.start),
      renderOptions: {
        before: {
          contentIconPath: vscode.Uri.parse(result.dataUri),
          // Pin explicit width/height so VS Code renders the SVG at its true
          // size instead of squashing tall content (fractions) to line height.
          width: `${result.width}px`,
          height: `${result.height}px`,
          textDecoration: "none; vertical-align: middle; line-height: 1;",
        },
      },
    });
  }

  editor.setDecorations(hideDecoration, hideRanges);
  editor.setDecorations(renderDecoration, renderOpts);
  editor.setDecorations(errorDecoration, errorOpts);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeMd(s: string): string {
  return s.replace(/`/g, "\\`");
}
