/**
 * CONCEPT 29 helper — makes the lab's input files with no dependencies and no downloads:
 *
 *   png()   a tiny PNG encoder (RGB, zlib) + a 5×7 bitmap font, so each image holds text the model must READ
 *   pdf()   a tiny PDF writer (Helvetica text, one content stream per page)
 *
 * Every file holds a fact that only appears inside it (an order number, a code word, a password), so the answer
 * proves the model saw the file and did not guess.
 */
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------

type RGB = [number, number, number];

export class Canvas {
  readonly px: Buffer;
  constructor(readonly w: number, readonly h: number, bg: RGB = [255, 255, 255]) {
    this.px = Buffer.alloc(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  set(x: number, y: number, [r, g, b]: RGB) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.set(i, j, c);
  }
  circle(cx: number, cy: number, r: number, c: RGB) {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) this.set(cx + i, cy + j, c);
  }
  triangle(cx: number, top: number, size: number, c: RGB) {
    for (let j = 0; j < size; j++) this.rect(cx - Math.floor(j / 2), top + j, j + 1, 1, c);
  }
  /** Draws text with the 5×7 font. `s` is the size of one font pixel. */
  text(x: number, y: number, str: string, s: number, c: RGB) {
    for (const ch of str.toUpperCase()) {
      const rows = (FONT[ch] ?? FONT[" "]).split(",");
      rows.forEach((row, j) => [...row].forEach((bit, i) => bit === "1" && this.rect(x + i * s, y + j * s, s, s, c)));
      x += 6 * s;
    }
  }
  static textWidth(str: string, s: number) {
    return str.length * 6 * s - s;
  }
  png(level = 9): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0; // filter: none
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter, no interlace
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
  }
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 5×7 font: 7 rows of 5 pixels per glyph.
const FONT: Record<string, string> = {
  " ": "00000,00000,00000,00000,00000,00000,00000",
  A: "01110,10001,10001,11111,10001,10001,10001", B: "11110,10001,10001,11110,10001,10001,11110",
  C: "01110,10001,10000,10000,10000,10001,01110", D: "11110,10001,10001,10001,10001,10001,11110",
  E: "11111,10000,10000,11110,10000,10000,11111", F: "11111,10000,10000,11110,10000,10000,10000",
  G: "01110,10001,10000,10111,10001,10001,01111", H: "10001,10001,10001,11111,10001,10001,10001",
  I: "01110,00100,00100,00100,00100,00100,01110", J: "00111,00010,00010,00010,00010,10010,01100",
  K: "10001,10010,10100,11000,10100,10010,10001", L: "10000,10000,10000,10000,10000,10000,11111",
  M: "10001,11011,10101,10101,10001,10001,10001", N: "10001,10001,11001,10101,10011,10001,10001",
  O: "01110,10001,10001,10001,10001,10001,01110", P: "11110,10001,10001,11110,10000,10000,10000",
  Q: "01110,10001,10001,10001,10101,10010,01101", R: "11110,10001,10001,11110,10100,10010,10001",
  S: "01111,10000,10000,01110,00001,00001,11110", T: "11111,00100,00100,00100,00100,00100,00100",
  U: "10001,10001,10001,10001,10001,10001,01110", V: "10001,10001,10001,10001,10001,01010,00100",
  W: "10001,10001,10001,10101,10101,10101,01010", X: "10001,10001,01010,00100,01010,10001,10001",
  Y: "10001,10001,01010,00100,00100,00100,00100", Z: "11111,00001,00010,00100,01000,10000,11111",
  "0": "01110,10001,10011,10101,11001,10001,01110", "1": "00100,01100,00100,00100,00100,00100,01110",
  "2": "01110,10001,00001,00010,00100,01000,11111", "3": "11111,00010,00100,00010,00001,10001,01110",
  "4": "00010,00110,01010,10010,11111,00010,00010", "5": "11111,10000,11110,00001,00001,10001,01110",
  "6": "00110,01000,10000,11110,10001,10001,01110", "7": "11111,00001,00010,00100,01000,01000,01000",
  "8": "01110,10001,10001,01110,10001,10001,01110", "9": "01110,10001,10001,01111,00001,00010,01100",
  "-": "00000,00000,00000,11111,00000,00000,00000", ":": "00000,01100,01100,00000,01100,01100,00000",
  ".": "00000,00000,00000,00000,00000,01100,01100", "#": "01010,01010,11111,01010,11111,01010,01010",
};

const RED: RGB = [214, 48, 49], GREEN: RGB = [39, 174, 96], BLUE: RGB = [41, 98, 255], INK: RGB = [30, 30, 30], ORANGE: RGB = [230, 126, 34];

/** A label: an order number, a code word, and three coloured shapes. `k` scales it (k = 6 → 2400×1440). */
export function cardPng(k = 1) {
  const c = new Canvas(400 * k, 240 * k);
  c.rect(0, 0, 400 * k, 8 * k, ORANGE);
  c.text(20 * k, 28 * k, "ORDER #4721", 4 * k, INK);
  c.text(20 * k, 72 * k, "CODE: KESTREL", 3 * k, INK);
  c.circle(70 * k, 170 * k, 38 * k, RED);
  c.rect(160 * k, 132 * k, 76 * k, 76 * k, GREEN);
  c.triangle(320 * k, 132 * k, 76 * k, BLUE);
  return c.png();
}

/** A bar chart with no numbers on it: the model must compare the bars' heights. */
export function chartPng(values = [30, 55, 80, 40], title = "SALES 2026") {
  const c = new Canvas(400, 240);
  c.text(20, 12, title, 3, INK);
  const colors = [BLUE, GREEN, RED, ORANGE];
  values.forEach((v, i) => {
    const x = 50 + i * 85;
    c.rect(x, 200 - v * 1.8, 50, v * 1.8, colors[i % 4]);
    c.text(x + 13, 208, `Q${i + 1}`, 2, INK);
  });
  c.rect(30, 200, 350, 2, INK);
  return c.png();
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

/** A PDF with one page per string array. Each line is drawn in Helvetica; the first line of a page is a heading. */
export function pdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => "\\" + m);
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length; // returns the object number
  const catalog = add(""), pagesObj = add(""), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines.map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - (i === 0 ? 0 : 20 + i * 18)} Td (${esc(l)}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objs.map((body, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A photo-like image: random pixels do not compress, so the PNG is about 11 MB. The text sits on a white band. */
export function noisyPng() {
  const c = new Canvas(2600, 1800);
  randomBytes(c.px.length).copy(c.px);
  c.rect(100, 100, 2400, 400, [255, 255, 255]);
  c.text(160, 180, "ORDER #4721", 40, INK);
  return c.png(1);
}

// The same invoice as a 3-page PDF and as plain text, to compare what each costs.
const INVOICE_PAGES = [
  ["INVOICE INV-2026-0917", "Customer: Atmira Labs, Madrid", "Date: 17 September 2026", "", "3 x Keyboard ............ 89.50 EUR each", "2 x Monitor 27in ....... 399.00 EUR each", "1 x Docking station ..... 218.00 EUR", "", "TOTAL: 1,284.50 EUR"],
  ["PAYMENT TERMS", "Pay within 30 days by bank transfer.", "Late payments add 1.5% per month.", "IBAN: ES00 0000 0000 0000 0000 0000"],
  ["APPENDIX", "Delivery instructions for the warehouse.", "Ring twice at gate 4.", "The delivery password is HERON."],
];
export const invoicePdf = () => pdf(INVOICE_PAGES);
export const INVOICE_TXT = INVOICE_PAGES.map((p) => p.join("\n")).join("\n\n") + "\n";

export const POLICY_TXT = `Returns policy (store: Northwind Outdoor)

1. Customers may return unused items within 45 days of delivery.
2. Items on clearance sale can only be exchanged, never refunded.
3. Refunds go back to the original payment method within 5 business days.
4. Tents that were set up outdoors count as used and cannot be returned.
`;
