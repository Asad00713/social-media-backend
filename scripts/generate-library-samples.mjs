// Generates the Library's sample images (assets/library-samples/v1/*.png).
//
// Run once by hand: `node scripts/generate-library-samples.mjs`. The PNGs are
// committed; the app never runs this. Node built-ins only (zlib): the repo has
// no image library, and these are flat shapes, so a tiny anti-aliased SDF
// rasteriser plus a PNG encoder is all it takes. Colours are the app's brand
// tokens (--brand-solid #2563eb, --brand-subtle #eff4ff, --brand-text
// #1d4ed8, --text-primary #101828) with three accents.
//
// The output is versioned (v1/): files are served with an immutable cache, so
// a changed image must get a new folder, never overwrite a published one.
// Prints each file's name, size and dimensions for the manifest in
// src/media-library/samples/sample-content.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const OUT = join(process.cwd(), 'assets', 'library-samples', 'v1');

const C = {
  brand: [0x25, 0x63, 0xeb],
  brandText: [0x1d, 0x4e, 0xd8],
  brandSubtle: [0xef, 0xf4, 0xff],
  ink: [0x10, 0x18, 0x28],
  canvas: [0xef, 0xf1, 0xf5],
  white: [0xff, 0xff, 0xff],
  amber: [0xf5, 0x9e, 0x0b],
  amberSoft: [0xfe, 0xf3, 0xc7],
  emerald: [0x10, 0xb9, 0x81],
  rose: [0xf4, 0x3f, 0x5e],
  roseSoft: [0xff, 0xe4, 0xe6],
  slate: [0x94, 0xa3, 0xb8],
};

/** An RGB canvas with alpha-blended, anti-aliased shapes. */
class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }

  /** Blends `color` wherever the signed distance `sdf(x, y)` is below 0. */
  shape(bbox, sdf, color, opacity = 1) {
    const x0 = Math.max(0, Math.floor(bbox[0]) - 1);
    const y0 = Math.max(0, Math.floor(bbox[1]) - 1);
    const x1 = Math.min(this.w, Math.ceil(bbox[2]) + 1);
    const y1 = Math.min(this.h, Math.ceil(bbox[3]) + 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        const a = Math.min(1, Math.max(0, 0.5 - d)) * opacity;
        if (a <= 0) continue;
        const i = (y * this.w + x) * 3;
        for (let k = 0; k < 3; k++) {
          this.px[i + k] = Math.round(this.px[i + k] * (1 - a) + color[k] * a);
        }
      }
    }
  }

  circle(cx, cy, r, color, opacity) {
    this.shape(
      [cx - r, cy - r, cx + r, cy + r],
      (x, y) => Math.hypot(x - cx, y - cy) - r,
      color,
      opacity,
    );
  }

  ring(cx, cy, r, t, color, opacity) {
    this.shape(
      [cx - r - t, cy - r - t, cx + r + t, cy + r + t],
      (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - t / 2,
      color,
      opacity,
    );
  }

  rect(x, y, w, h, r, color, opacity) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    this.shape(
      [x, y, x + w, y + h],
      (px, py) => {
        const qx = Math.abs(px - cx) - w / 2 + r;
        const qy = Math.abs(py - cy) - h / 2 + r;
        return (
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
          Math.min(Math.max(qx, qy), 0) -
          r
        );
      },
      color,
      opacity,
    );
  }

  /** Paints `color` outside a rounded rect, inside its box: clips its corners. */
  outsideRect(x, y, w, h, r, color) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    this.shape(
      [x, y, x + w, y + h],
      (px, py) => {
        const qx = Math.abs(px - cx) - w / 2 + r;
        const qy = Math.abs(py - cy) - h / 2 + r;
        return -(
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
          Math.min(Math.max(qx, qy), 0) -
          r
        );
      },
      color,
    );
  }

  /** A convex polygon, points clockwise in screen space. */
  poly(points, color, opacity) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const edges = points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // Outward normal of a clockwise edge.
      return { a, nx: (b[1] - a[1]) / len, ny: -(b[0] - a[0]) / len };
    });
    this.shape(
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      (x, y) =>
        Math.max(
          ...edges.map((e) => (x - e.a[0]) * e.nx + (y - e.a[1]) * e.ny),
        ),
      color,
      opacity,
    );
  }

  /** Placeholder "text": rounded bars. */
  lines(x, y, widths, h, gap, color, opacity) {
    widths.forEach((w, i) =>
      this.rect(x, y + i * (h + gap), w, h, h / 2, color, opacity),
    );
  }

  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      const row = y * (this.w * 3 + 1);
      raw[row] = 2; // filter: Up (flat shapes compress to runs of zeros)
      for (let x = 0; x < this.w * 3; x++) {
        const cur = this.px[y * this.w * 3 + x];
        const up = y > 0 ? this.px[(y - 1) * this.w * 3 + x] : 0;
        raw[row + 1 + x] = (cur - up) & 0xff;
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const IMAGES = {
  // 1:1 — a launch post: confetti around a badge.
  'launch-announcement.png': () => {
    const c = new Canvas(1080, 1080, C.brand);
    c.circle(860, 200, 260, C.brandText, 0.6);
    c.circle(160, 960, 220, C.brandText, 0.5);
    c.rect(170, 250, 740, 580, 48, C.white);
    c.circle(540, 430, 110, C.brandSubtle);
    c.poly(
      [
        [540, 350],
        [600, 470],
        [480, 470],
      ],
      C.brand,
    );
    c.lines(330, 590, [420, 320], 34, 26, C.ink, 0.85);
    c.lines(390, 720, [300], 26, 0, C.slate);
    const confetti = [
      [120, 140, C.amber],
      [300, 90, C.emerald],
      [980, 520, C.amber],
      [90, 560, C.rose],
      [940, 900, C.emerald],
      [700, 990, C.rose],
      [520, 120, C.white],
      [40, 360, C.white],
    ];
    for (const [x, y, col] of confetti) c.rect(x, y, 46, 18, 9, col);
    return c;
  },

  // 4:5 — a product on a plinth, soft brand background.
  'product-spotlight.png': () => {
    const c = new Canvas(1080, 1350, C.brandSubtle);
    c.circle(540, 560, 360, C.white);
    c.rect(400, 330, 280, 470, 60, C.brand);
    c.rect(470, 270, 140, 90, 24, C.brandText);
    c.rect(440, 480, 200, 150, 20, C.white, 0.9);
    c.lines(470, 515, [140, 100], 22, 18, C.brand, 0.8);
    c.rect(250, 800, 580, 70, 35, C.slate, 0.35);
    c.rect(300, 860, 480, 150, 30, C.white);
    c.lines(210, 1110, [660, 480], 40, 30, C.ink, 0.85);
    c.circle(860, 260, 54, C.amber);
    return c;
  },

  // 9:16 — a story frame: mountains at dawn, a "sticker" and text bars.
  'behind-the-scenes-story.png': () => {
    const c = new Canvas(1080, 1920, C.ink);
    c.rect(60, 220, 960, 1240, 56, C.brandText);
    c.circle(760, 620, 150, C.amber);
    c.poly(
      [
        [60, 1460],
        [420, 860],
        [780, 1460],
      ],
      C.brand,
    );
    c.poly(
      [
        [440, 1460],
        [760, 1000],
        [1020, 1340],
        [1020, 1460],
      ],
      C.white,
      0.18,
    );
    c.rect(60, 1300, 960, 160, 0, C.ink, 0.25);
    c.outsideRect(60, 220, 960, 1240, 56, C.ink);
    c.rect(100, 90, 880, 12, 6, C.white, 0.35);
    c.rect(100, 90, 420, 12, 6, C.white);
    c.circle(150, 170, 40, C.rose);
    c.lines(210, 150, [260], 28, 0, C.white, 0.9);
    c.rect(640, 1500, 340, 120, 60, C.white);
    c.lines(690, 1540, [240], 40, 0, C.brand);
    c.lines(100, 1560, [500, 380], 44, 30, C.white, 0.9);
    c.lines(100, 1720, [620], 30, 0, C.slate);
    return c;
  },

  // 16:9 — an event banner: a calendar with one day picked.
  'event-banner.png': () => {
    const c = new Canvas(1920, 1080, C.canvas);
    c.circle(1700, 160, 300, C.brandSubtle);
    c.circle(200, 1000, 240, C.amberSoft);
    c.rect(1060, 200, 640, 680, 48, C.white);
    c.rect(1060, 200, 640, 150, 48, C.brand);
    c.rect(1060, 300, 640, 50, 0, C.brand);
    c.rect(1180, 160, 36, 110, 18, C.ink);
    c.rect(1544, 160, 36, 110, 18, C.ink);
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 5; k++) {
        const picked = r === 1 && k === 3;
        c.rect(
          1110 + k * 112,
          400 + r * 112,
          84,
          84,
          18,
          picked ? C.rose : C.canvas,
        );
      }
    }
    c.lines(180, 330, [700, 560], 70, 40, C.ink, 0.9);
    c.lines(180, 590, [620, 520, 380], 32, 26, C.slate);
    c.rect(180, 820, 320, 96, 48, C.brand);
    c.lines(230, 853, [220], 30, 0, C.white);
    return c;
  },

  // 1:1 — a tip post: a light bulb on amber.
  'quick-tip.png': () => {
    const c = new Canvas(1080, 1080, C.amber);
    c.circle(540, 400, 230, C.amberSoft, 0.5);
    c.circle(540, 400, 170, C.white);
    c.rect(470, 540, 140, 130, 28, C.white);
    c.rect(480, 690, 120, 34, 17, C.ink);
    c.rect(500, 740, 80, 30, 15, C.ink);
    for (let k = 0; k < 7; k++) {
      const a = Math.PI + (k * Math.PI) / 6;
      const x = 540 + Math.cos(a) * 280;
      const y = 400 + Math.sin(a) * 280;
      c.circle(x, y, 18, C.white);
    }
    c.lines(250, 850, [580, 420], 40, 30, C.ink, 0.85);
    return c;
  },

  // 4:5 — a team quote: big quote marks, an avatar, the quote as bars.
  'team-quote.png': () => {
    const c = new Canvas(1080, 1350, C.roseSoft);
    c.rect(90, 120, 900, 1110, 56, C.white);
    // Two closing quote marks: a dot with a tail curling down-left.
    for (const x of [180, 320]) {
      c.circle(x + 50, 320, 50, C.rose);
      c.poly(
        [
          [x + 52, 320],
          [x + 100, 320],
          [x + 46, 452],
          [x + 18, 436],
        ],
        C.rose,
      );
    }
    c.lines(180, 520, [720, 690, 720, 480], 46, 34, C.ink, 0.85);
    c.circle(250, 1040, 80, C.brand);
    c.circle(250, 1015, 30, C.white);
    c.rect(200, 1055, 100, 50, 25, C.white);
    c.lines(370, 1000, [300, 220], 34, 22, C.slate);
    return c;
  },
};

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const [file, draw] of Object.entries(IMAGES)) {
  const canvas = draw();
  const png = canvas.png();
  writeFileSync(join(OUT, file), png);
  manifest.push({
    file,
    width: canvas.w,
    height: canvas.h,
    bytes: png.length,
  });
}
console.log(JSON.stringify(manifest, null, 2));
console.log(
  `total ${(manifest.reduce((s, m) => s + m.bytes, 0) / 1024).toFixed(1)} KB`,
);
