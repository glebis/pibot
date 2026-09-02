/**
 * gen-schema — deterministic pipeline-schema renderer.
 *
 * Input:  docs/schemas/<name>.json (declarative spec: nodes with explicit
 *         coordinates, edges as explicit polylines, footer code map)
 * Output: docs/schemas/<name>.svg
 *
 * Determinism contract: the SVG is a pure function of the spec — no clocks,
 * no randomness, fixed number formatting. Same spec → byte-identical SVG.
 * Layout is explicit (spec carries x/y/w/h) so nothing depends on rendering
 * quirks or environment.
 *
 * Usage:  npx tsx scripts/gen-schema.mts <name>   # reads docs/schemas/<name>.json
 *         npx tsx scripts/gen-schema.mts <name> --png /tmp/out.png  (via rsvg-convert)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ── tones: the only styling vocabulary ──────────────────────────────────────
type Tone = "trigger" | "neutral" | "goal" | "gate" | "reject" | "promote" | "review" | "amberText";

const TONES: Record<Tone, { stroke: string; title: string; body: string; bg?: string }> = {
  trigger: { stroke: "#38bdf8", title: "#7dd3fc", body: "#94a3b8" },
  neutral: { stroke: "#334155", title: "#e2e8f0", body: "#94a3b8" },
  goal:    { stroke: "#475569", title: "#e2e8f0", body: "#94a3b8" },
  gate:    { stroke: "#f59e0b", title: "#fbbf24", body: "#94a3b8" },
  reject:  { stroke: "#ef4444", title: "#f87171", body: "#94a3b8", bg: "#1a1116" },
  promote: { stroke: "#10b981", title: "#34d399", body: "#a7f3d0", bg: "#0f1a15" },
  review:  { stroke: "#8b5cf6", title: "#c4b5fd", body: "#cbd5e1" },
  amberText: { stroke: "#f59e0b", title: "#fbbf24", body: "#94a3b8" },
};

const BG = "#0b1220";
const EDGE = "#64748b";

interface Node {
  id: string;
  kind?: "box" | "pill";
  tone: Tone;
  x: number; y: number; w: number; h: number;
  title: string;
  lines?: string[];
  rx?: number;
}
interface Edge {
  points: Array<[number, number]>;
  label?: string;
  labelAt?: [number, number];
  labelColor?: string;
  arrowless?: boolean;
  color?: string;
}
interface Panel {
  x: number; y: number; w: number; h: number;
  label: string;
  tone?: "review";
}
interface FooterEntry { path: string; desc: string }
interface SchemaSpec {
  title: string;
  subtitle: string;
  width: number;
  height: number;
  panels?: Panel[];
  nodes: Node[];
  edges?: Edge[];
  notes?: Array<{ x: number; y: number; text: string; color?: string; bold?: boolean; size?: number }>;
  footerLabel?: string;
  footer?: FooterEntry[];
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n1 = (x: number): string => String(Math.round(x * 10) / 10); // fixed 1-decimal, no locale noise

function nodeSvg(nd: Node): string {
  if (nd.kind === "pill") {
    return [
      `<rect x="${n1(nd.x)}" y="${n1(nd.y)}" width="${n1(nd.w)}" height="${n1(nd.h)}" rx="${n1(nd.h / 2)}" fill="#8b5cf6"/>`,
      `<text x="${n1(nd.x + 12)}" y="${n1(nd.y + nd.h / 2 + 4.5)}" font-size="11.5" font-weight="700" fill="#ffffff">${esc(nd.title)}</text>`,
    ].join("\n  ");
  }
  const t = TONES[nd.tone] ?? TONES.neutral;
  const out: string[] = [];
  const rx = nd.rx ?? 10;
  out.push(`<rect x="${n1(nd.x)}" y="${n1(nd.y)}" width="${n1(nd.w)}" height="${n1(nd.h)}" rx="${n1(rx)}" fill="${t.bg ?? "#111a2e"}" stroke="${t.stroke}" stroke-width="1.2"/>`);
  out.push(`<text x="${n1(nd.x + 20)}" y="${n1(nd.y + 23)}" font-size="14" font-weight="600" fill="${t.title}">${esc(nd.title)}</text>`);
  (nd.lines ?? []).forEach((line, i) => {
    out.push(`<text x="${n1(nd.x + 20)}" y="${n1(nd.y + 43 + 18 * i)}" font-size="12" fill="${t.body}">${esc(line)}</text>`);
  });
  return out.join("\n  ");
}

function edgeSvg(e: Edge): string {
  const color = e.color ?? EDGE;
  const d = e.points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${n1(x)} ${n1(y)}`).join(" ");
  const marker = e.arrowless ? "" : ` marker-end="url(#arr)"`;
  const out = [`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"${marker}/>`];
  if (e.label) {
    const [lx, ly] = e.labelAt ?? e.points[0];
    out.push(`<text x="${n1(lx)}" y="${n1(ly)}" font-size="11" fill="${e.labelColor ?? color}">${esc(e.label)}</text>`);
  }
  return out.join("\n  ");
}

export function renderSchema(spec: SchemaSpec): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif">`);
  parts.push(`  <rect width="${spec.width}" height="${spec.height}" fill="${BG}"/>`);
  parts.push(`  <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${EDGE}"/></marker></defs>`);
  parts.push(`  <text x="60" y="60" font-size="26" font-weight="700" fill="#f1f5f9">${esc(spec.title)}</text>`);
  parts.push(`  <text x="60" y="88" font-size="13.5" fill="#94a3b8">${esc(spec.subtitle)}</text>`);
  for (const p of spec.panels ?? []) {
    const tone = TONES[p.tone ?? "review"];
    parts.push(`  <rect x="${n1(p.x)}" y="${n1(p.y)}" width="${n1(p.w)}" height="${n1(p.h)}" rx="14" fill="#14102b" stroke="${tone.stroke}" stroke-width="1.4"/>`);
    parts.push(`  <text x="${n1(p.x + 30)}" y="${n1(p.y + 34)}" font-size="13" font-weight="700" fill="${tone.title}" letter-spacing="1.5">${esc(p.label)}</text>`);
  }
  for (const nd of spec.nodes) parts.push(`  ${nodeSvg(nd)}`);
  for (const e of spec.edges ?? []) parts.push(`  ${edgeSvg(e)}`);
  for (const nt of spec.notes ?? []) {
    parts.push(`  <text x="${n1(nt.x)}" y="${n1(nt.y)}" font-size="${nt.size ?? 13}" ${nt.bold ? 'font-weight="600" ' : ""}fill="${nt.color ?? "#cbd5e1"}">${esc(nt.text)}</text>`);
  }
  if (spec.footer?.length) {
    parts.push(`  <text x="60" y="${n1(spec.height - spec.footer.length * 24 - 118)}" font-size="13" font-weight="700" fill="#64748b" letter-spacing="1.5">${esc(spec.footerLabel ?? "WHERE IT LIVES")}</text>`);
    spec.footer.forEach((f, i) => {
      const y = spec.height - spec.footer.length * 24 - 94 + i * 24;
      parts.push(`  <text x="60" y="${n1(y)}" font-size="12.5" font-family="Menlo, monospace" fill="#7dd3fc">${esc(f.path)}</text>`);
      parts.push(`  <text x="260" y="${n1(y)}" font-size="12.5" fill="#94a3b8">${esc(f.desc)}</text>`);
    });
  }
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

// ── cli ─────────────────────────────────────────────────────────────────────
function main(): void {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: tsx scripts/gen-schema.mts <schema-name> [--png /out/path.png]");
    process.exit(1);
  }
  const specPath = path.join("docs", "schemas", `${name}.json`);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as SchemaSpec;
  const svg = renderSchema(spec);
  const outPath = path.join("docs", "schemas", `${name}.svg`);
  fs.writeFileSync(outPath, svg);
  console.log(`wrote ${outPath} (${svg.length} bytes)`);

  const pngIdx = process.argv.indexOf("--png");
  if (pngIdx !== -1 && process.argv[pngIdx + 1]) {
    execFileSync("rsvg-convert", ["-w", "1440", outPath, "-o", process.argv[pngIdx + 1]], { stdio: "inherit" });
    console.log(`wrote ${process.argv[pngIdx + 1]}`);
  }
}
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invoked) main();