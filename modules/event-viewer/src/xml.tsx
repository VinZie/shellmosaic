// Pretty-printed event XML: as text (for copying) and as highlighted React nodes.
import type { ReactNode } from "react";

type Tok = { k: "tag" | "attr" | "val" | "text" | "plain"; s: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

function walk(el: Element, depth: number, out: Tok[]) {
  const ind = "  ".repeat(depth);
  out.push({ k: "plain", s: ind }, { k: "tag", s: `<${el.tagName}` });
  for (const a of Array.from(el.attributes)) {
    out.push({ k: "plain", s: " " }, { k: "attr", s: a.name }, { k: "plain", s: "=" }, { k: "val", s: `"${escAttr(a.value)}"` });
  }
  const kids = Array.from(el.childNodes).filter((n) => n.nodeType === 1 || ((n.nodeType === 3 || n.nodeType === 4) && (n.textContent ?? "").trim()));
  if (!kids.length) {
    out.push({ k: "tag", s: "/>" }, { k: "plain", s: "\n" });
    return;
  }
  if (kids.every((n) => n.nodeType !== 1)) {
    const text = kids.map((n) => n.textContent ?? "").join("");
    out.push({ k: "tag", s: ">" }, { k: "text", s: esc(text.replace(/\r\n?/g, "\n")) }, { k: "tag", s: `</${el.tagName}>` }, { k: "plain", s: "\n" });
    return;
  }
  out.push({ k: "tag", s: ">" }, { k: "plain", s: "\n" });
  for (const n of kids) {
    if (n.nodeType === 1) walk(n as Element, depth + 1, out);
    else out.push({ k: "plain", s: "  ".repeat(depth + 1) }, { k: "text", s: esc((n.textContent ?? "").trim()) }, { k: "plain", s: "\n" });
  }
  out.push({ k: "plain", s: ind }, { k: "tag", s: `</${el.tagName}>` }, { k: "plain", s: "\n" });
}

function tokens(xml: string): Tok[] | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) return null;
  const out: Tok[] = [];
  walk(doc.documentElement, 0, out);
  return out;
}

export function prettyXml(xml: string): string {
  const t = tokens(xml);
  return t ? t.map((x) => x.s).join("").trimEnd() : xml;
}

export function XmlView({ xml }: { xml: string }) {
  const t = tokens(xml);
  let body: ReactNode;
  if (!t) body = xml;
  else {
    body = t.map((x, i) => (x.k === "plain" ? x.s : <span key={i} className={`x-${x.k}`}>{x.s}</span>));
  }
  return <pre className="sm-code ev-xml">{body}</pre>;
}
