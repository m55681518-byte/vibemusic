/**
 * Generates VibeMusic PWA icons as real PNGs using only Node built-ins
 * (zlib deflate + hand-rolled PNG chunk writer). No dependencies.
 *
 * Icon design: gradient rounded tile + vinyl disc with grooves.
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "icons");

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, (y + 1) * stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- drawing ----------
const c1 = [139, 92, 246]; // violet #8b5cf6
const c2 = [236, 72, 153]; // pink #ec4899
const WHITE = [255, 255, 255];
const DARK = [30, 18, 60];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function roundedRectHit(x, y, size, r) {
  const qx = Math.max(r, Math.min(x, size - r));
  const qy = Math.max(r, Math.min(y, size - r));
  return Math.hypot(x - qx, y - qy) <= r;
}

function colorAt(x, y, size, o) {
  const { cornerRadius, fullBleed } = o;
  if (!fullBleed && !roundedRectHit(x, y, size, cornerRadius)) return null;

  const t = y / size;
  let r = lerp(c1[0], c2[0], t);
  let g = lerp(c1[1], c2[1], t);
  let b = lerp(c1[2], c2[2], t);

  const dx = x - o.discCx;
  const dy = y - o.discCy;
  const dist = Math.hypot(dx, dy);

  if (dist <= o.discR) {
    r = lerp(r, WHITE[0], 0.94);
    g = lerp(g, WHITE[1], 0.94);
    b = lerp(b, WHITE[2], 0.94);
    for (const frac of o.grooves) {
      const ringR = o.discR * frac;
      if (Math.abs(dist - ringR) < size * 0.004) {
        r = lerp(r, DARK[0], 0.55);
        g = lerp(g, DARK[1], 0.55);
        b = lerp(b, DARK[2], 0.55);
      }
    }
    if (dist <= o.spindle) {
      return DARK;
    }
  }

  return [r, g, b];
}

function renderIcon(size, { maskable }) {
  const buf = Buffer.alloc(size * size * 4);
  const fullBleed = maskable;
  const cornerRadius = size * 0.21;
  const o = {
    fullBleed,
    cornerRadius,
    discCx: size / 2,
    discCy: size / 2,
    discR: size * (fullBleed ? 0.30 : 0.31),
    grooves: [0.72, 0.82, 0.9],
    spindle: size * (fullBleed ? 0.045 : 0.05),
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0];
      let count = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const col = colorAt(px + sx, py + sy, size, o);
        if (col) {
          acc[0] += col[0];
          acc[1] += col[1];
          acc[2] += col[2];
          count++;
        }
      }
      const idx = (py * size + px) * 4;
      if (count === 0) {
        buf[idx + 3] = 0;
        continue;
      }
      buf[idx] = Math.round(acc[0] / count);
      buf[idx + 1] = Math.round(acc[1] / count);
      buf[idx + 2] = Math.round(acc[2] / count);
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

// ---------- output ----------
function write(size, file, opts = {}) {
  const rgba = renderIcon(size, opts);
  writeFileSync(path.join(OUT, file), encodePng(size, rgba));
  console.log(`✓ ${file} (${size}px)`);
}

mkdirSync(OUT, { recursive: true });
write(192, "icon-192.png");
write(512, "icon-512.png");
write(512, "icon-maskable-512.png", { maskable: true });
write(180, "apple-touch-icon.png");
console.log(`Done → ${OUT}`);