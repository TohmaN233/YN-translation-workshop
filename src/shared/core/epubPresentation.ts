import path from "node:path";
import { load } from "cheerio";
import type { Element } from "domhandler";

type ArchiveFiles = Record<string, string>;
type TextDirection = "ltr" | "rtl";
interface CssMask {
  text: string;
  comments: boolean[];
}

const XHTML_FILE = /\.(?:xhtml|html?)$/i;
const VERTICAL_CLASS = /^(?:tcy(?:[-_].*)?|.*[-_]tcy|upright|text[-_]upright(?:[-_].*)?)$/i;
const TITLE_CLASS = /(?:^|[-_])(?:chapter[-_]?)?(?:title|heading|subtitle|subheading|separator|divider|ornament|center|centered)(?:\d+)?(?:$|[-_])/i;
const NON_PROSE_ANCESTORS = new Set([
  "aside", "dd", "dl", "figure", "figcaption", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "nav", "ol", "pre", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

function isElement(node: unknown): node is Element {
  return Boolean(node && typeof node === "object" && "name" in node && "attribs" in node);
}

function elementName(element: Element): string {
  return element.name.split(":").at(-1)?.toLowerCase() ?? "";
}

function elements($: ReturnType<typeof load>, selector = "*"): Element[] {
  return $(selector).toArray().filter(isElement);
}

function archivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function lookupPath(files: ArchiveFiles, targetPath: string): string | undefined {
  const target = archivePath(targetPath).toLowerCase();
  return Object.keys(files).find((filePath) => archivePath(filePath).toLowerCase() === target);
}

function maskCss(source: string): CssMask {
  const characters = source.split("");
  const comments = Array<boolean>(source.length).fill(false);
  let quote = "";
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inComment) {
      comments[index] = true;
      if (character !== "\n" && character !== "\r") characters[index] = " ";
      if (character === "*" && next === "/") {
        comments[index + 1] = true;
        characters[index + 1] = " ";
        index += 1;
        inComment = false;
      }
      continue;
    }
    if (quote) {
      if (character !== "\n" && character !== "\r") characters[index] = " ";
      if (character === "\\" && index + 1 < source.length) {
        if (source[index + 1] !== "\n" && source[index + 1] !== "\r") characters[index + 1] = " ";
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "/" && next === "*") {
      comments[index] = true;
      comments[index + 1] = true;
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      inComment = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      characters[index] = " ";
    }
  }
  return { text: characters.join(""), comments };
}

function keepCommentsAndLines(source: string, comments: boolean[], start: number, end: number): string {
  let retained = "";
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    retained += comments[index] || character === "\n" || character === "\r" ? character : " ";
  }
  return retained;
}

function normalizeCss(source: string, direction: TextDirection): string {
  const masked = maskCss(source);
  const declarations = /(?:^|(?<=[;{}]))(\s*)([-_a-z][-_a-z0-9]*)(\s*:\s*)([^;{}]*)(;?)/gi;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = declarations.exec(masked.text))) {
    const [, spacing, property, colon, value, semicolon] = match;
    const name = property.toLowerCase();
    const important = value.match(/\s*!important\s*$/i)?.[0] ?? "";
    const rawValue = important ? value.slice(0, -important.length).trim() : value.trim();
    const valueStart = match.index + spacing.length + property.length + colon.length;
    const valueToken = /\S+/.exec(masked.text.slice(valueStart, valueStart + value.length));

    if (/^(?:-epub-|-webkit-|-ms-)?writing-mode$/.test(name) || name === "direction") {
      if (!valueToken) continue;
      edits.push({
        start: valueStart + valueToken.index,
        end: valueStart + valueToken.index + valueToken[0].length,
        replacement: name === "direction" ? direction : "horizontal-tb"
      });
      continue;
    }

    if (/^(?:-epub-|-webkit-)?text-orientation$/.test(name) && /^(?:upright|sideways|sideways-right)$/i.test(rawValue)) {
      edits.push({ start: match.index, end: match.index + match[0].length, replacement: keepCommentsAndLines(source, masked.comments, match.index, match.index + match[0].length) });
      continue;
    }
    if (/^(?:(?:-epub-|-webkit-)?text-combine(?:-upright|-horizontal)?|text-combine-upright)$/.test(name)) {
      edits.push({ start: match.index, end: match.index + match[0].length, replacement: keepCommentsAndLines(source, masked.comments, match.index, match.index + match[0].length) });
    }
  }

  let normalized = source;
  for (const edit of edits.reverse()) {
    normalized = normalized.slice(0, edit.start) + edit.replacement + normalized.slice(edit.end);
  }
  return normalized;
}

function setStyleDeclaration(style: string | undefined, property: string, value: string): string {
  const expression = new RegExp(`(^|;)\\s*${property}\\s*:[^;]*`, "i");
  if (style && expression.test(style)) return style.replace(expression, (_match, boundary: string) => `${boundary} ${property}: ${value}`);
  const existing = style?.trim() ?? "";
  return `${existing}${existing && !existing.endsWith(";") ? ";" : ""}${existing ? " " : ""}${property}: ${value}`;
}

function classTokens(element: Element): string[] {
  return (element.attribs.class ?? "").split(/\s+/).filter(Boolean);
}

function removeVerticalClasses(element: Element): void {
  const remaining = classTokens(element)
    .map((className) => className.toLowerCase() === "vrtl" ? "hltr" : className)
    .filter((className) => !VERTICAL_CLASS.test(className));
  if (remaining.length) element.attribs.class = remaining.join(" ");
  else delete element.attribs.class;
}

function localHrefTarget(currentPath: string, href: string): { path: string; fragment: string } | undefined {
  const hash = href.indexOf("#");
  if (hash < 0 || hash === href.length - 1) return undefined;
  const hrefPath = href.slice(0, hash).split("?", 1)[0] ?? "";
  let fragment: string;
  let decodedPath: string;
  try {
    fragment = decodeURIComponent(href.slice(hash + 1));
    decodedPath = decodeURIComponent(hrefPath);
  } catch (error) {
    throw new Error(`EPUB presentation normalization failed: invalid local href ${href}.`, { cause: error });
  }
  return {
    path: archivePath(path.posix.normalize(path.posix.join(path.posix.dirname(archivePath(currentPath)), decodedPath || path.posix.basename(currentPath)))),
    fragment
  };
}

function directionForLanguage(targetLanguage: string): TextDirection {
  return /^(?:ar|fa|he|ur|ps|dv|yi)(?:[-_]|$)/i.test(targetLanguage) ? "rtl" : "ltr";
}

function referencedIdsByDocument(files: ArchiveFiles): Map<string, Set<string>> {
  const referenced = new Map<string, Set<string>>();
  for (const [filePath, content] of Object.entries(files)) {
    if (!XHTML_FILE.test(filePath) && !/\.ncx$/i.test(filePath)) continue;
    const $ = load(content, { xmlMode: true });
    for (const reference of elements($, "a[href], content[src]")) {
      const href = reference.attribs.href ?? reference.attribs.src ?? "";
      const target = localHrefTarget(filePath, href);
      if (!target) continue;
      const key = target.path.toLowerCase();
      const ids = referenced.get(key) ?? new Set<string>();
      ids.add(target.fragment);
      referenced.set(key, ids);
    }
  }
  return referenced;
}

function unwrapKoboSpan($: ReturnType<typeof load>, spanElement: Element, keepId: boolean, direction: TextDirection): void {
  const span = $(spanElement);
  const id = spanElement.attribs.id;
  const classes = classTokens(spanElement).filter((className) => !/^kobospan$/i.test(className));
  const style = spanElement.attribs.style ? normalizeCss(spanElement.attribs.style, direction).trim().replace(/;\s*$/, "") : "";
  const meaningfulAttributes = Object.keys(spanElement.attribs).filter((name) => !["class", "id", "style"].includes(name.toLowerCase()));

  if (classes.length || style || meaningfulAttributes.length) {
    if (classes.length) span.attr("class", classes.join(" "));
    else span.removeAttr("class");
    if (style) span.attr("style", style);
    else span.removeAttr("style");
    if (!keepId) span.removeAttr("id");
    return;
  }

  if (keepId && id) span.before($("<a></a>").attr("id", id));
  span.replaceWith(span.contents());
}

function isKoboScript(element: Element, source: string): boolean {
  const identity = [element.attribs.src, element.attribs.id, element.attribs.class].filter(Boolean).join(" ");
  return /(?:^|[\\/.\s_-])(?:kobo\d*|kepub\d*)(?:$|[\\/.\s_-])/i.test(identity)
    || /\bkoboSpan\b|\bKobo\.(?:Reader|Utilities|Annotations|Navigation|Config)\b|\bkepub(?:Reader|Location|Span)\b/i.test(source);
}

function supportedCenterSelector(selector: string): boolean {
  if (!selector || selector.includes("::") || selector.includes("/*") || selector.includes("|") || selector.trimStart().startsWith("@")) return false;
  const supportedPseudos = new Set([
    "empty", "first-child", "first-of-type", "last-child", "last-of-type", "not", "nth-child", "nth-last-child", "nth-last-of-type", "nth-of-type", "only-child", "only-of-type", "root"
  ]);
  return [...selector.matchAll(/:([a-z-]+)/gi)].every((match) => supportedPseudos.has(match[1].toLowerCase()));
}

function addCenterSelectors(source: string, selectors: Set<string>, headingSelectors: Set<string>): void {
  const masked = maskCss(source).text;
  for (const rule of masked.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = source.slice(rule.index, rule.index + rule[1].length).trim();
    if (!supportedCenterSelector(selector)) continue;
    if (/\btext-align\s*:\s*(?:center|right|end)\b/i.test(rule[2])) selectors.add(selector);
    const size = rule[2].match(/\bfont-size\s*:\s*(\d+(?:\.\d+)?)\s*(em|rem|%)(?=\s|;|$)/i);
    if (size && Number(size[1]) > (size[2] === "%" ? 100 : 1)) headingSelectors.add(selector);
  }
}

function centeredSelectorsInCss(files: ArchiveFiles): { centered: string[]; headings: string[] } {
  const centered = new Set<string>();
  const headings = new Set<string>();
  for (const [filePath, source] of Object.entries(files)) {
    if (/\.css$/i.test(filePath)) addCenterSelectors(source, centered, headings);
    else if (XHTML_FILE.test(filePath)) {
      const $ = load(source, { xmlMode: true });
      $("style").each((_index, style) => addCenterSelectors($(style).text(), centered, headings));
    }
  }
  return { centered: [...centered], headings: [...headings] };
}

function shouldIndentParagraph($: ReturnType<typeof load>, paragraph: Element, selectors: { centered: string[]; headings: string[] }): boolean {
  const node = $(paragraph);
  if (node.parents().toArray().some((ancestor) => isElement(ancestor) && NON_PROSE_ANCESTORS.has(elementName(ancestor)))) return false;
  if (node.find("h1, h2, h3, h4, h5, h6, img, svg, math, table, pre").length) return false;
  const ancestors = node.parents().toArray().filter(isElement);
  const classes = [paragraph, ...ancestors].flatMap(classTokens);
  if (classes.some((className) => TITLE_CLASS.test(className) || /^(?:no[-_]?indent|non[-_]?prose|caption|page[-_]?number)$/i.test(className))) return false;
  if ([paragraph, ...ancestors].some((element) => /\btext-align\s*:\s*(?:center|right|end)\b/i.test(element.attribs.style ?? "")
    || selectors.centered.some((selector) => $(element).is(selector)))) return false;
  if (selectors.headings.some(selector => node.is(selector))) return false;
  const fontSize = (paragraph.attribs.style ?? "").match(/\bfont-size\s*:\s*(\d+(?:\.\d+)?)\s*(em|rem|%)(?=\s|;|$)/i);
  if (fontSize && Number(fontSize[1]) > (fontSize[2] === "%" ? 100 : 1)) return false;
  const visibleText = node.text().replace(/\u00a0/g, " ").trim();
  return visibleText.length > 0 && !/^[\s\p{P}\p{S}]+$/u.test(visibleText)
    && !/^(?:\p{N}+|[IVXLCDM]+|[一二三四五六七八九十百千〇零]+)[.)、]?$/iu.test(visibleText);
}

function normalizeXhtml(
  filePath: string,
  source: string,
  targetLanguage: string,
  direction: TextDirection,
  referenced: Map<string, Set<string>>,
  centeredSelectors: { centered: string[]; headings: string[] }
): string {
  const $ = load(source, { xmlMode: true });
  const ids = referenced.get(archivePath(filePath).toLowerCase()) ?? new Set<string>();

  $("rt, rp").remove();
  $("ruby").each((_index, ruby) => {
    if (isElement(ruby) && ruby.attribs.id && ids.has(ruby.attribs.id)) {
      $(ruby).before($("<a></a>").attr("id", ruby.attribs.id));
    }
    $(ruby).replaceWith($(ruby).contents());
  });
  $("script").each((_index, script) => {
    if (isElement(script) && isKoboScript(script, $(script).text())) $(script).remove();
  });
  $("span").each((_index, span) => {
    if (!isElement(span) || !/^span$/i.test(span.name) || !classTokens(span).some((name) => /^kobospan$/i.test(name))) return;
    unwrapKoboSpan($, span, Boolean(span.attribs.id && ids.has(span.attribs.id)), direction);
  });

  for (const element of elements($)) {
    removeVerticalClasses(element);
    if (element.attribs.style) element.attribs.style = normalizeCss(element.attribs.style, direction);
  }
  $("style").each((_index, style) => {
    $(style).text(normalizeCss($(style).text(), direction));
  });

  if (/^zh(?:[-_]|$)/i.test(targetLanguage)) {
    $("p").each((_index, paragraph) => {
      if (!isElement(paragraph) || !shouldIndentParagraph($, paragraph, centeredSelectors)) return;
      paragraph.attribs.style = setStyleDeclaration(paragraph.attribs.style, "text-indent", "2em !important");
    });
  }

  const html = $("html").first();
  if (html.length) {
    if (targetLanguage) {
      html.attr("lang", targetLanguage);
      html.attr("xml:lang", targetLanguage);
    }
    html.attr("dir", direction);
    html.attr("style", setStyleDeclaration(html.attr("style"), "writing-mode", "horizontal-tb"));
    html.attr("style", setStyleDeclaration(html.attr("style"), "direction", direction));
  }
  $("body").each((_index, body) => {
    const node = $(body);
    node.attr("dir", direction);
    node.attr("style", setStyleDeclaration(node.attr("style"), "writing-mode", "horizontal-tb"));
    node.attr("style", setStyleDeclaration(node.attr("style"), "direction", direction));
  });

  return $.xml();
}

function propertyTokens(element: Element): string[] {
  return (element.attribs.properties ?? "").split(/\s+/).filter(Boolean);
}

function propertyTail(token: string): string {
  return token.split(":").at(-1)?.toLowerCase() ?? "";
}

function manifestPath(opfPath: string, href: string): string {
  const hrefPath = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
  return archivePath(path.posix.normalize(path.posix.join(path.posix.dirname(archivePath(opfPath)), hrefPath)));
}

function normalizeOpf(opfPath: string, source: string, targetLanguage: string, direction: TextDirection, files: ArchiveFiles): string {
  const $ = load(source, { xmlMode: true });
  const packageElements = elements($);
  const languages = packageElements.filter((element) => elementName(element) === "language" && element.name.toLowerCase().startsWith("dc:"));
  if (targetLanguage) {
    if (languages.length) {
      for (const language of languages) $(language).text(targetLanguage);
    } else {
      const root = packageElements.find((element) => elementName(element) === "package");
      if (root && !root.attribs["xmlns:dc"]) $(root).attr("xmlns:dc", "http://purl.org/dc/elements/1.1/");
      let metadata = $("metadata").first();
      if (!metadata.length && root) {
        $(root).append("<metadata></metadata>");
        metadata = $(root).children().filter((_index, child) => isElement(child) && elementName(child) === "metadata").last();
      }
      if (metadata.length) {
        const escapedLanguage = targetLanguage.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        metadata.append(`<dc:language>${escapedLanguage}</dc:language>`);
      }
    }
  }

  for (const element of packageElements) {
    if (elementName(element) === "spine") $(element).attr("page-progression-direction", direction);
    const properties = element.attribs.properties;
    if (!properties) continue;
    const retained = propertyTokens(element).filter((token) => !["page-spread-left", "page-spread-right"].includes(propertyTail(token)));
    if (retained.length) element.attribs.properties = retained.join(" ");
    else delete element.attribs.properties;
  }

  for (const item of packageElements.filter((element) => elementName(element) === "item")) {
    const properties = propertyTokens(item);
    if (!properties.some((token) => propertyTail(token) === "scripted") || !item.attribs.href) continue;
    const filePath = lookupPath(files, manifestPath(opfPath, item.attribs.href));
    if (!filePath || !XHTML_FILE.test(filePath) || load(files[filePath], { xmlMode: true })("script").length) continue;
    const retained = properties.filter((token) => propertyTail(token) !== "scripted");
    if (retained.length) item.attribs.properties = retained.join(" ");
    else delete item.attribs.properties;
  }
  return $.xml();
}

export function normalizeTranslatedEpubPresentation(files: ArchiveFiles, targetLanguage: string): ArchiveFiles {
  const nextFiles = { ...files };
  const direction = directionForLanguage(targetLanguage);
  const referenced = referencedIdsByDocument(files);
  const centeredSelectors = centeredSelectorsInCss(files);

  for (const [filePath, content] of Object.entries(files)) {
    if (XHTML_FILE.test(filePath)) nextFiles[filePath] = normalizeXhtml(filePath, content, targetLanguage, direction, referenced, centeredSelectors);
    else if (/\.css$/i.test(filePath)) nextFiles[filePath] = normalizeCss(content, direction);
  }
  for (const [filePath, content] of Object.entries(nextFiles)) {
    if (/\.opf$/i.test(filePath)) nextFiles[filePath] = normalizeOpf(filePath, content, targetLanguage, direction, nextFiles);
  }
  return nextFiles;
}
