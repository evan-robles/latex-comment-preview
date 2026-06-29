import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface ThemeColors {
  comment?: string;
  /** Color for Python docstrings (string token). */
  docstring?: string;
  /** Editor default foreground, as a final fallback. */
  foreground?: string;
}

let cached: { themeName: string; colors: ThemeColors } | null = null;

/**
 * Resolve the active color theme's `comment` and `string`/docstring foreground
 * colors by locating and parsing the theme's JSON file (the only place these
 * token colors are actually exposed to an extension).
 *
 * Best-effort: returns whatever it can find. Honors `include` chains and the
 * user's `editor.tokenColorCustomizations` overrides (which win).
 */
export function resolveThemeColors(): ThemeColors {
  const themeName = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme", "");

  if (cached && cached.themeName === themeName) {
    return cached.colors;
  }

  let colors: ThemeColors = {};

  const themePath = findThemePath(themeName);
  if (themePath) {
    try {
      colors = parseThemeFile(themePath, 0);
    } catch {
      // ignore — fall through to customizations/defaults
    }
  }

  // User token customizations override the theme file.
  applyUserCustomizations(colors, themeName);

  cached = { themeName, colors };
  return colors;
}

export function clearThemeCache(): void {
  cached = null;
}

/** Find the on-disk JSON path for a theme by its display label. */
function findThemePath(label: string): string | undefined {
  for (const ext of vscode.extensions.all) {
    const contributes = ext.packageJSON?.contributes;
    const themes = contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const t of themes) {
      if (t.label === label || t.id === label) {
        if (typeof t.path === "string") {
          return path.join(ext.extensionPath, t.path);
        }
      }
    }
  }
  return undefined;
}

/** Parse a theme JSON file, following `include` up to a small depth limit. */
function parseThemeFile(filePath: string, depth: number): ThemeColors {
  if (depth > 8) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const json = parseJsonc(raw);

  // Start from any included base theme (resolved relative to this file).
  let result: ThemeColors = {};
  if (typeof json.include === "string") {
    const basePath = path.join(path.dirname(filePath), json.include);
    try {
      result = parseThemeFile(basePath, depth + 1);
    } catch {
      // ignore missing base
    }
  }

  // Editor foreground from the `colors` map (fallback color).
  if (json.colors && typeof json.colors["editor.foreground"] === "string") {
    result.foreground = json.colors["editor.foreground"];
  }

  // tokenColors: array of { scope, settings: { foreground } }.
  const tokenColors = json.tokenColors;
  if (Array.isArray(tokenColors)) {
    for (const rule of tokenColors) {
      const fg = rule?.settings?.foreground;
      if (typeof fg !== "string") {
        continue;
      }
      const scopes = normalizeScopes(rule.scope);
      for (const scope of scopes) {
        // Comment color.
        if (scope === "comment" || scope.startsWith("comment")) {
          result.comment = fg;
        }
        // Base string color — but EXCLUDE string sub-scopes that are not the
        // ordinary string color: `string.comment` (a comment-colored scope that
        // would clobber the real string color), `string.regexp`, `string.other`,
        // and any scope that is really about embedded/punctuation/quotes.
        if (isBaseStringScope(scope)) {
          result.docstring = fg;
        }
      }
    }

    // A specific Python docstring scope, if the theme defines one, wins over the
    // generic base-string color. Second pass so it always overrides.
    for (const rule of tokenColors) {
      const fg = rule?.settings?.foreground;
      if (typeof fg !== "string") {
        continue;
      }
      for (const scope of normalizeScopes(rule.scope)) {
        if (
          scope.includes("docstring") ||
          scope.startsWith("string.quoted.docstring")
        ) {
          result.docstring = fg;
        }
      }
    }
  }

  return result;
}

/** Apply the user's `editor.tokenColorCustomizations` (highest priority). */
function applyUserCustomizations(colors: ThemeColors, themeName: string): void {
  const tc = vscode.workspace
    .getConfiguration("editor")
    .get<any>("tokenColorCustomizations");
  if (!tc || typeof tc !== "object") {
    return;
  }
  const blocks = [tc];
  if (themeName && tc[`[${themeName}]`]) {
    blocks.push(tc[`[${themeName}]`]); // per-theme block wins, applied last
  }
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const c = block.comments;
    if (typeof c === "string") {
      colors.comment = c;
    } else if (c && typeof c.foreground === "string") {
      colors.comment = c.foreground;
    }
    const s = block.strings;
    if (typeof s === "string") {
      colors.docstring = s;
    } else if (s && typeof s.foreground === "string") {
      colors.docstring = s.foreground;
    }
  }
}

/**
 * True if `scope` is the ordinary "string" foreground (the color a docstring
 * gets), and NOT a string sub-scope that carries a different color — such as
 * `string.comment` (comment-colored), `string.regexp`, `string.other.link`, or
 * embedded/punctuation/quoted-section scopes.
 */
function isBaseStringScope(scope: string): boolean {
  if (scope === "string") {
    return true;
  }
  if (!scope.startsWith("string")) {
    return false;
  }
  const excluded = [
    "string.comment",
    "string.regexp",
    "string.other",
    "string.unquoted",
  ];
  if (excluded.some((e) => scope.startsWith(e))) {
    return false;
  }
  // Reject scopes whose color is about embedded source / punctuation rather than
  // the string body itself.
  if (/embedded|punctuation|section|variable/.test(scope)) {
    return false;
  }
  // Accept the common quoted forms: string.quoted.*, string.quoted.double, etc.
  return scope.startsWith("string.quoted") || scope.startsWith("string ");
}

function normalizeScopes(scope: unknown): string[] {
  if (typeof scope === "string") {
    // A scope string may be comma-separated.
    return scope.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(scope)) {
    return scope.filter((s) => typeof s === "string").map((s) => s.trim());
  }
  return [];
}

/** Minimal JSONC parse: strip // and /* *​/ comments, then JSON.parse. */
function parseJsonc(text: string): any {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(noLine);
}
