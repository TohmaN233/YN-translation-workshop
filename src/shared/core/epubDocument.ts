import { load, type CheerioAPI } from "cheerio";
import { isTag, isText, type AnyNode, type Text } from "domhandler";

interface TextSlice { node: Text; start: number; end: number }
export interface EpubTextUnit { text: string; slices: TextSlice[] }
export interface EpubDocument { $: CheerioAPI; units: EpubTextUnit[] }

const blockTags = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "dl", "ul", "ol", "tr", "td", "th", "caption", "figcaption", "section", "article", "header", "main", "footer", "aside", "address", "nav", "blockquote", "pre", "figure", "hr"]);
const excludedTags = new Set(["head", "script", "style", "rt", "rp", "template"]);
export const normalizeEpubText = (value: string): string => value.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ");

/** Extraction and writeback share the same DOM text slices, including br and bare text. */
export function parseEpubDocument(xhtml: string): EpubDocument {
  const $ = load(xhtml, { xml: { xmlMode: false, lowerCaseTags: false, lowerCaseAttributeNames: false,
    recognizeSelfClosing: true, withStartIndices: true, withEndIndices: true } });
  const units: EpubTextUnit[] = [];
  let slices: TextSlice[] = [];
  const flush = () => {
    const text = normalizeEpubText(slices.map(slice => slice.node.data.slice(slice.start, slice.end)).join(""));
    if (text) units.push({ text, slices });
    slices = [];
  };
  const walk = (node: AnyNode, pre = false): void => {
    if (isText(node)) {
      if (!pre) slices.push({ node, start: 0, end: node.data.length });
      else {
        let start = 0;
        for (const match of node.data.matchAll(/\r\n?|\n/g)) {
          slices.push({ node, start, end: match.index }); flush(); start = match.index + match[0].length;
        }
        slices.push({ node, start, end: node.data.length });
      }
      return;
    }
    if (!isTag(node)) return;
    const tag = node.name.toLowerCase();
    if (excludedTags.has(tag) || Object.hasOwn(node.attribs, "hidden")
      || node.attribs["aria-hidden"] === "true"
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(node.attribs.style ?? "")) return;
    if (tag === "br") { flush(); return; }
    const block = blockTags.has(tag);
    if (block) flush();
    for (const child of node.children) walk(child, pre || tag === "pre");
    if (block) flush();
  };
  const body = $("body").first();
  for (const child of body.length ? body.contents().toArray() : $.root().contents().toArray()) walk(child);
  flush();
  return { $, units };
}

export function replaceEpubUnits(document: EpubDocument, replacements: ReadonlyMap<number, string>): void {
  const edits = new Map<Text, Array<{ start: number; end: number; value: string }>>();
  for (const [index, value] of replacements) {
    const unit = document.units[index];
    if (!unit) throw new Error(`EPUB export has no text unit ${index + 1}.`);
    if (value === unit.text) continue;
    const visible = unit.slices.filter(slice => normalizeEpubText(slice.node.data.slice(slice.start, slice.end)));
    const first = visible.find(slice => {
      for (let parent = slice.node.parent; parent; parent = parent.parent) if (isTag(parent) && parent.name.toLowerCase() === "a" && parent.attribs.href) return true;
      return false;
    }) ?? visible[0];
    for (const slice of unit.slices) {
      const list = edits.get(slice.node) ?? [];
      list.push({ start: slice.start, end: slice.end, value: slice === first ? value : "" });
      edits.set(slice.node, list);
    }
  }
  for (const [node, changes] of edits) {
    for (const change of changes.sort((a, b) => b.start - a.start)) {
      node.data = node.data.slice(0, change.start) + change.value + node.data.slice(change.end);
    }
  }
}
