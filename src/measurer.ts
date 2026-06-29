import * as vscode from "vscode";
import * as katex from "katex";
import * as fs from "fs";

/**
 * Webview-based measurer (TEST feature). A hidden-ish sidebar WebviewView lays
 * out each LaTeX span with real KaTeX CSS in a browser context and reports
 * getBoundingClientRect() — the pixel-exact width/height Node cannot compute.
 * Exact dimensions are cached and the repaint callback fires when they arrive.
 *
 * Gated by the `latexCommentPreview.useWebviewMeasure` setting (default false).
 */

export interface Dimensions {
  width: number;
  height: number;
}

export const MEASURER_VIEW_ID = "latexCommentPreview.measurer";

let extensionUri: vscode.Uri | undefined;
let onMeasured: (() => void) | undefined;

let view: vscode.WebviewView | undefined;
let ready = false;
const pending = new Map<string, { tex: string; display: boolean; fontPx: number }>();
const dims = new Map<string, Dimensions>();

function key(tex: string, display: boolean, fontPx: number): string {
  return `${fontPx}|${display ? 1 : 0}|${tex}`;
}

export function initMeasurer(
  context: vscode.ExtensionContext,
  repaint: () => void
): void {
  extensionUri = context.extensionUri;
  onMeasured = repaint;

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: extensionUri
          ? [vscode.Uri.joinPath(extensionUri, "node_modules", "katex", "dist")]
          : [],
      };
      webviewView.webview.html = buildHtml(webviewView.webview);
      webviewView.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === "ready") {
          ready = true;
          for (const [k, req] of pending) {
            sendMeasure(k, req.tex, req.display, req.fontPx);
          }
          return;
        }
        if (msg?.type === "measured" && typeof msg.key === "string") {
          dims.set(msg.key, {
            width: Math.ceil(msg.width),
            height: Math.ceil(msg.height),
          });
          pending.delete(msg.key);
          onMeasured?.();
        }
      });
      webviewView.onDidDispose(() => {
        view = undefined;
        ready = false;
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MEASURER_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

/** Exact dimensions if already measured. */
export function getExactDimensions(
  tex: string,
  display: boolean,
  fontPx: number
): Dimensions | undefined {
  return dims.get(key(tex, display, fontPx));
}

/** Request an exact measurement; repaint fires when it returns. */
export function requestMeasure(
  tex: string,
  display: boolean,
  fontPx: number
): void {
  const k = key(tex, display, fontPx);
  if (dims.has(k) || pending.has(k)) {
    return;
  }
  pending.set(k, { tex, display, fontPx });
  if (view && ready) {
    sendMeasure(k, tex, display, fontPx);
  } else if (!view) {
    // The WebviewView hasn't been resolved yet (it only resolves when shown at
    // least once). Proactively reveal it so it initializes; queued requests then
    // flush on "ready".
    vscode.commands.executeCommand(`${MEASURER_VIEW_ID}.focus`).then(
      () => undefined,
      () => undefined
    );
  }
}

function sendMeasure(
  k: string,
  tex: string,
  display: boolean,
  fontPx: number
): void {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "html",
      throwOnError: true,
      strict: false,
    });
  } catch {
    dims.set(k, { width: 0, height: 0 });
    pending.delete(k);
    return;
  }
  view?.webview.postMessage({ type: "measure", key: k, html, fontPx });
}

function buildHtml(webview: vscode.Webview): string {
  // Inline KaTeX CSS with its font url(fonts/...) references rewritten to webview
  // URIs. The shipped CSS uses RELATIVE font paths, which a <link> resolves
  // against the webview document URL (vscode-webview://...) — NOT the
  // asWebviewUri location — so fonts silently fail to load and measurements come
  // out wrong. Rewriting the urls fixes the actual rendering used for measuring.
  let inlineCss = "";
  if (extensionUri) {
    const dist = vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "katex",
      "dist"
    );
    const fontsBase = webview
      .asWebviewUri(vscode.Uri.joinPath(dist, "fonts"))
      .toString();
    try {
      const cssPath = vscode.Uri.joinPath(dist, "katex.min.css").fsPath;
      const raw = fs.readFileSync(cssPath, "utf8");
      inlineCss = raw.replace(
        /url\(fonts\/([^)]+)\)/g,
        (_m, file) => `url(${fontsBase}/${file})`
      );
    } catch {
      inlineCss = "";
    }
  }
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${inlineCss}</style>
<style>
  body { margin:0; padding:6px; font-family:sans-serif; color:#888; font-size:11px; }
  #stage { position:absolute; left:-9999px; top:0; visibility:hidden; white-space:nowrap; }
</style>
</head>
<body>
<div>LaTeX measurer (background) — safe to leave collapsed.</div>
<div id="stage"></div>
<script>
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  function measure(key, html, fontPx) {
    stage.innerHTML = html;
    const el = stage.querySelector('.katex') || stage;
    // KaTeX's .katex sets font-size:1.21em relative to context. To measure at a
    // known absolute size, pin the .katex element's font-size directly so the
    // measured px is in the SAME base the render uses (render fontPx).
    if (el && el.style) { el.style.fontSize = fontPx + 'px'; }
    // Force layout, then measure.
    const rect = el.getBoundingClientRect();
    vscode.postMessage({ type:'measured', key, width: rect.width, height: rect.height });
  }
  // Remember everything we measure so we can RE-measure once fonts finish
  // loading (the first measurement may happen before KaTeX fonts are applied,
  // giving a slightly-wrong width).
  const seen = new Map();
  let fontsReady = false;

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'measure') {
      seen.set(m.key, { html: m.html, fontPx: m.fontPx });
      measure(m.key, m.html, m.fontPx);
    }
  });

  // Signal ready IMMEDIATELY so queued requests flush — do NOT gate on
  // document.fonts.ready (it can hang in a webview and the handshake never
  // completes). Then, when fonts settle, re-measure everything for accuracy.
  vscode.postMessage({ type:'ready' });

  function remeasureAll() {
    fontsReady = true;
    for (const [key, req] of seen) measure(key, req.html, req.fontPx);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(remeasureAll);
    // Safety net: also re-measure after a short delay in case fonts.ready never
    // resolves but the fonts are in fact loaded.
    setTimeout(() => { if (!fontsReady) remeasureAll(); }, 600);
  } else {
    setTimeout(remeasureAll, 600);
  }
</script>
</body>
</html>`;
}
