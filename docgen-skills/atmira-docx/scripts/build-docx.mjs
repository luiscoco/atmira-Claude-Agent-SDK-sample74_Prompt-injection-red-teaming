#!/usr/bin/env node
// atmira-docx builder: JSON spec -> branded .docx. No dependencies (a .docx is a zip of XML parts).
//
//   node .claude/skills/atmira-docx/scripts/build-docx.mjs <name>.spec.json out/<name>.docx
//
// Exit codes: 0 built (prints a JSON summary), 2 the spec or the paths are wrong (prints SPEC ERROR lines the
// model can act on), 1 anything else. The output is deterministic: the same spec gives the same bytes.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const brand = JSON.parse(readFileSync(new URL("../assets/brand.json", import.meta.url), "utf8"));
const INCIDENT_SECTIONS = ["Summary", "Impact", "Timeline", "Root cause", "Action items"];

// ---------------------------------------------------------------------------------------------
// 1. Validate. Every message names the JSON path and says what to change.
// ---------------------------------------------------------------------------------------------

const isRealDate = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

export function validateSpec(spec) {
  const errors = [];
  const err = (where, message) => errors.push(`${where}: ${message}`);
  const text = (where, value, min, max) => {
    if (typeof value !== "string") return err(where, `must be a string`);
    if (value.trim().length < min) return err(where, `must not be empty`);
    if (value.length > max) err(where, `is ${value.length} characters; the limit is ${max}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) err(where, `contains control characters`);
  };
  const only = (where, value, allowed) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) err(`${where}.${key}`, `unknown field (allowed: ${allowed.join(", ")})`);
  };
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["spec: must be a JSON object"];
  only("spec", spec, ["kind", "title", "subtitle", "author", "date", "classification", "blocks"]);
  if (!["general", "incident-report"].includes(spec.kind)) err("spec.kind", `must be "general" or "incident-report"`);
  text("spec.title", spec.title, 1, 90);
  if (spec.subtitle !== undefined) text("spec.subtitle", spec.subtitle, 1, 120);
  text("spec.author", spec.author, 1, 80);
  if (typeof spec.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(spec.date) || !isRealDate(spec.date)) err("spec.date", `must be a real date written YYYY-MM-DD`);
  if (!brand.classifications.includes(spec.classification)) err("spec.classification", `must be one of ${brand.classifications.map((c) => `"${c}"`).join(", ")}`);
  if (!Array.isArray(spec.blocks) || spec.blocks.length < 1 || spec.blocks.length > 120) {
    err("spec.blocks", "must be an array of 1–120 blocks");
    return errors;
  }
  spec.blocks.forEach((block, i) => {
    const at = `blocks[${i}]`;
    if (!block || typeof block !== "object") return err(at, "must be an object");
    switch (block.type) {
      case "heading":
        only(at, block, ["type", "level", "text"]);
        if (block.level !== 1 && block.level !== 2) err(`${at}.level`, "must be 1 or 2");
        text(`${at}.text`, block.text, 1, 120); break;
      case "paragraph":
        only(at, block, ["type", "text"]); text(`${at}.text`, block.text, 1, 1500); break;
      case "callout":
        only(at, block, ["type", "tone", "text"]);
        if (!["info", "warning"].includes(block.tone)) err(`${at}.tone`, `must be "info" or "warning"`);
        text(`${at}.text`, block.text, 1, 600); break;
      case "bullets": case "numbered":
        only(at, block, ["type", "items"]);
        if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 20) err(`${at}.items`, "must be an array of 1–20 strings");
        else block.items.forEach((item, j) => text(`${at}.items[${j}]`, item, 1, 400));
        break;
      case "table": {
        only(at, block, ["type", "columns", "rows"]);
        const cols = Array.isArray(block.columns) ? block.columns : [];
        if (cols.length < 1 || cols.length > 6) err(`${at}.columns`, "must be an array of 1–6 strings");
        cols.forEach((c, j) => text(`${at}.columns[${j}]`, c, 1, 60));
        if (!Array.isArray(block.rows) || block.rows.length < 1 || block.rows.length > 40) { err(`${at}.rows`, "must be an array of 1–40 rows"); break; }
        block.rows.forEach((row, r) => {
          if (!Array.isArray(row)) return err(`${at}.rows[${r}]`, "must be an array of strings");
          if (row.length !== cols.length) err(`${at}.rows[${r}]`, `has ${row.length} cells but there are ${cols.length} columns`);
          row.forEach((cell, j) => text(`${at}.rows[${r}][${j}]`, cell, 1, 400));
        });
        break;
      }
      default:
        err(`${at}.type`, `unknown block type ${JSON.stringify(block.type)} (use heading, paragraph, bullets, numbered, table or callout)`);
    }
  });
  if (spec.kind === "incident-report") {
    // Required sections, in order (other headings may sit between them).
    const h1 = spec.blocks.filter((b) => b?.type === "heading" && b.level === 1).map((b) => String(b.text).trim().toLowerCase());
    let from = 0;
    for (const section of INCIDENT_SECTIONS) {
      const at = h1.indexOf(section.toLowerCase(), from);
      if (at === -1) err("spec.blocks", `an incident report needs a level-1 heading "${section}"${h1.includes(section.toLowerCase()) ? " after the previous required section" : ""} (order: ${INCIDENT_SECTIONS.join(" → ")})`);
      else from = at + 1;
    }
    const actions = sectionBlocks(spec.blocks, "Action items").find((b) => b.type === "table");
    const names = (actions?.columns ?? []).map((c) => String(c).toLowerCase());
    if (!actions) err("spec.blocks", `the "Action items" section needs a table`);
    else for (const column of ["Owner", "Due"]) if (!names.includes(column.toLowerCase())) err("spec.blocks", `the "Action items" table needs a "${column}" column`);
  }
  return errors;
}

function sectionBlocks(blocks, heading) {
  const start = blocks.findIndex((b) => b?.type === "heading" && b.level === 1 && String(b.text).trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return [];
  const end = blocks.findIndex((b, i) => i > start && b?.type === "heading" && b.level === 1);
  return blocks.slice(start + 1, end === -1 ? undefined : end).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// 2. Render WordprocessingML. All text goes through esc(), so "<w:p>" in a spec is printed, never parsed.
// ---------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const C = brand.colors;
const TEXT_WIDTH = 11906 - 2 * 1304; // A4 width minus the margins, in twentieths of a point

/** "**bold** rest" -> runs. Only ** is markup. */
function runs(textValue, extraRpr = "") {
  return String(textValue).split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => {
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    const value = bold ? part.slice(2, -2) : part;
    const rPr = bold || extraRpr ? `<w:rPr>${bold ? "<w:b/>" : ""}${extraRpr}</w:rPr>` : "";
    return `<w:r>${rPr}<w:t xml:space="preserve">${esc(value)}</w:t></w:r>`;
  }).join("");
}
const para = (style, content, numPr = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${numPr}</w:pPr>${content}</w:p>`;

function table(block) {
  const n = block.columns.length; const col = Math.floor(TEXT_WIDTH / n);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${C.rule}"/>`;
  const cell = (value, header) => `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/>${header ? `<w:shd w:val="clear" w:color="auto" w:fill="${C.tableHeader}"/>` : ""}</w:tcPr>${para("TableText", runs(value, header ? "<w:b/>" : ""))}</w:tc>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${col * n}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>`
    + `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${block.columns.map(() => `<w:gridCol w:w="${col}"/>`).join("")}</w:tblGrid>`
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.columns.map((c) => cell(c, true)).join("")}</w:tr>`
    + block.rows.map((row) => `<w:tr>${row.map((c) => cell(c, false)).join("")}</w:tr>`).join("")
    + `</w:tbl>${para("Normal", "")}`; // an empty paragraph after a table keeps tables from touching
}

export function renderParts(spec) {
  let numId = 1; const numbered = []; // each numbered list restarts at 1, so it gets its own w:num
  const body = [
    para("Title", runs(spec.title)),
    spec.subtitle ? para("Subtitle", runs(spec.subtitle)) : "",
    para("Meta", runs(`${spec.author} · ${spec.date} · ${spec.classification}`)),
    ...spec.blocks.map((b) => {
      switch (b.type) {
        case "heading": return para(`Heading${b.level}`, runs(b.text));
        case "paragraph": return para("Normal", runs(b.text));
        case "callout": return para(b.tone === "warning" ? "CalloutWarning" : "CalloutInfo", runs(b.text));
        case "bullets": return b.items.map((item) => para("ListParagraph", runs(item), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`)).join("");
        case "numbered": { const id = ++numId; numbered.push(id); return b.items.map((item) => para("ListParagraph", runs(item), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`)).join(""); }
        case "table": return table(b);
      }
    }),
  ].join("");
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1304" w:right="1304" w:bottom="1304" w:left="1304" w:header="708" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}${sect}</w:body></w:document>`;

  const font = (f) => `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`;
  const style = (id, name, pPr, rPr, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`;
  const callout = (fill, line) => `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${line}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:spacing w:before="120" w:after="200"/><w:ind w:left="170" w:right="113"/>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}>`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${font(brand.fonts.body)}<w:color w:val="${C.text}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + style("Title", "Title", `<w:spacing w:after="60"/>`, `${font(brand.fonts.heading)}<w:color w:val="${C.primary}"/><w:sz w:val="52"/><w:szCs w:val="52"/>`, `<w:next w:val="Normal"/>`)
    + style("Subtitle", "Subtitle", `<w:spacing w:after="60"/>`, `${font(brand.fonts.heading)}<w:color w:val="${C.muted}"/><w:sz w:val="30"/><w:szCs w:val="30"/>`, `<w:next w:val="Normal"/>`)
    + style("Meta", "Meta", `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="${C.primary}"/></w:pBdr><w:spacing w:after="240"/>`, `<w:color w:val="${C.muted}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`)
    + style("Heading1", "heading 1", `<w:keepNext/><w:spacing w:before="320" w:after="100"/><w:outlineLvl w:val="0"/>`, `${font(brand.fonts.heading)}<w:b/><w:color w:val="${C.primary}"/><w:sz w:val="32"/><w:szCs w:val="32"/>`, `<w:next w:val="Normal"/>`)
    + style("Heading2", "heading 2", `<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>`, `${font(brand.fonts.heading)}<w:b/><w:color w:val="${C.text}"/><w:sz w:val="26"/><w:szCs w:val="26"/>`, `<w:next w:val="Normal"/>`)
    + style("ListParagraph", "List Paragraph", `<w:spacing w:after="60"/><w:ind w:left="720"/>`, "")
    + style("TableText", "Table Text", `<w:spacing w:before="40" w:after="40"/>`, `<w:sz w:val="20"/><w:szCs w:val="20"/>`)
    + style("CalloutInfo", "Callout Info", callout(C.info, C.infoBorder), "")
    + style("CalloutWarning", "Callout Warning", callout(C.warning, C.warningBorder), "")
    + style("Footer", "footer", "", `<w:color w:val="${C.muted}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`)
    + `</w:styles>`;

  const level = (fmt, text) => `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}>`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${level("bullet", "•")}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level("decimal", "%1.")}</w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
    + numbered.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("")
    + `</w:numbering>`;

  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>`
    + `<w:r><w:t xml:space="preserve">${esc(brand.footer)} · ${esc(spec.classification)} · Page </w:t></w:r>`
    + `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

  const rel = (id, type, target) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const REL = (inner) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
  const CT = "application/vnd.openxmlformats-officedocument";
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/word/document.xml" ContentType="${CT}.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="${CT}.wordprocessingml.styles+xml"/>`
      + `<Override PartName="/word/numbering.xml" ContentType="${CT}.wordprocessingml.numbering+xml"/>`
      + `<Override PartName="/word/footer1.xml" ContentType="${CT}.wordprocessingml.footer+xml"/>`
      + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
      + `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/></Types>`,
    "_rels/.rels": REL(rel("rId1", `${OD}/officeDocument`, "word/document.xml")
      + rel("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml")
      + rel("rId3", `${OD}/extended-properties`, "docProps/app.xml")),
    "word/_rels/document.xml.rels": REL(rel("rId1", `${OD}/styles`, "styles.xml") + rel("rId2", `${OD}/numbering`, "numbering.xml") + rel("rId3", `${OD}/footer`, "footer1.xml")),
    "word/document.xml": document,
    "word/styles.xml": styles,
    "word/numbering.xml": numbering,
    "word/footer1.xml": footer,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dc:title>${esc(spec.title)}</dc:title><dc:creator>${esc(spec.author)}</dc:creator><cp:keywords>${esc(spec.kind)}</cp:keywords>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${spec.date}T00:00:00Z</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>atmira-docx skill</Application><Company>${esc(brand.company)}</Company></Properties>`,
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Zip (stored order matters: [Content_Types].xml first). Fixed timestamps keep the bytes deterministic.
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = zlib.crc32 ?? ((buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

export function zip(files) {
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8"); const packed = zlib.deflateRawSync(data, { level: 9 }); const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals); const count = Object.keys(files).length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------------------------------------
// 4. CLI. Paths are relative to the working directory: the spec is a .json file there, the output goes to out/.
// ---------------------------------------------------------------------------------------------

function fail(code, lines) { for (const line of lines) console.error(line); process.exit(code); }

function main([specArg, outArg]) {
  const usage = "Usage: node .claude/skills/atmira-docx/scripts/build-docx.mjs <name>.spec.json out/<name>.docx";
  if (!specArg || !outArg) fail(2, ["SPEC ERROR args: expected two arguments", usage]);
  const pathErrors = [];
  if (!/^[\w.-]+\.json$/.test(specArg)) pathErrors.push(`SPEC ERROR args: the spec must be a .json file in the working directory (got ${JSON.stringify(specArg)})`);
  if (!/^out\/[\w.-]+\.docx$/.test(outArg.replaceAll("\\", "/")) || outArg.includes("..")) pathErrors.push(`SPEC ERROR args: the output must be out/<name>.docx (got ${JSON.stringify(outArg)})`);
  if (pathErrors.length) fail(2, [...pathErrors, usage]);
  if (!existsSync(specArg)) fail(2, [`SPEC ERROR args: ${specArg} does not exist; write it first`]);

  let spec;
  try { spec = JSON.parse(readFileSync(specArg, "utf8")); }
  catch (e) { fail(2, [`SPEC ERROR ${specArg}: not valid JSON (${e.message})`]); }
  const errors = validateSpec(spec);
  if (errors.length) fail(2, [...errors.map((e) => `SPEC ERROR ${e}`), `${errors.length} error(s). Fix the spec and run the same command again.`]);

  const parts = renderParts(spec);
  const bytes = zip(parts);
  mkdirSync(path.dirname(outArg), { recursive: true });
  writeFileSync(outArg, bytes);
  const words = spec.blocks.flatMap((b) => [b.text, ...(b.items ?? []), ...(b.columns ?? []), ...(b.rows ?? []).flat()]).filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
  console.log(JSON.stringify({ ok: true, output: outArg.replaceAll("\\", "/"), bytes: bytes.length, blocks: spec.blocks.length, words }));
}

// Run as a CLI only (the host's tests import the functions above).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { fail(1, [`BUILD FAILED: ${e instanceof Error ? e.message : String(e)}`]); }
}
