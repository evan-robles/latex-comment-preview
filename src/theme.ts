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

/**
 * Find the on-disk JSON path for the active theme.
 *
 * `workbench.colorTheme` stores a theme's `id` when it has one (built-in default
 * themes like "Dark+", "Dark Modern" rely on this), otherwise its `label`.
 * Built-in themes set `label` to an NLS placeholder ("%darkModernThemeLabel%"),
 * so matching on `label` alone fails for them — which is why ONLY the default
 * themes were missing their color. We match `id` first, then `label`, and search
 * `id`-less themes by label too.
 */
function findThemePath(idOrLabel: string): string | undefined {
  let labelFallback: string | undefined;
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const t of themes) {
      if (typeof t.path !== "string") {
        continue;
      }
      // Primary: id match (the value built-in themes store in colorTheme).
      if (t.id && t.id === idOrLabel) {
        return path.join(ext.extensionPath, t.path);
      }
      // Secondary: literal label match (extension themes without an id).
      if (t.label && t.label === idOrLabel && !labelFallback) {
        labelFallback = path.join(ext.extensionPath, t.path);
      }
    }
  }
  return labelFallback;
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
  // The ONLY reliably-correct base string color is the bare `string` scope.
  // Language-qualified scopes (string.quoted.pug, string.quoted.double.xml, ...)
  // carry that language's string color, not the general one, and must NOT be used
  // as the docstring color — doing so picks up e.g. pug/xml blue instead of the
  // real Python string color.
  if (scope === "string") {
    return true;
  }
  // Accept only the *generic* quoted forms with no further language qualifier:
  //   string.quoted.double / string.quoted.single  (exactly, nothing after).
  // Reject string.quoted.double.xml, string.quoted.pug, etc.
  if (scope === "string.quoted.double" || scope === "string.quoted.single") {
    return true;
  }
  return false;
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

/**
 * Parse JSON-with-comments (theme files are JSONC). Strips // line comments and
 * block comments while respecting string literals, then removes trailing commas,
 * then JSON.parse. A regex approach is unsafe here because comments can appear
 * INLINE (e.g. `"scope" // see https://...`) and `//` also occurs inside string
 * URLs — a string-aware scanner is required. VS Code's own theme files contain
 * inline `//` comments, so without this they fail to parse and yield no colors.
 */
function parseJsonc(text: string): any {
  let out = "";
  let i = 0;
  const n = text.length;
  let inStr = false;
  let quote = "";

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    if (inStr) {
      out += ch;
      if (ch === "\\") {
        // copy the escaped char verbatim
        if (i + 1 < n) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        inStr = false;
      }
      i++;
      continue;
    }

    // not in a string
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      // line comment — skip to end of line
      i += 2;
      while (i < n && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // block comment — skip to */
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  // Remove trailing commas before } or ] (also valid in JSONC, invalid in JSON).
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}
