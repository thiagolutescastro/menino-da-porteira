'use strict';
// Gera build/icon.png (512x512) sem dependências: rasteriza formas simples com antialiasing
// e codifica o PNG manualmente (zlib do Node). Rode com: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = new Float32Array(S * S * 4); // RGBA 0..1

const clamp = (v) => Math.max(0, Math.min(1, v));
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function blend(x, y, [r, g, b], a) {
  if (a <= 0) return;
  const i = (y * S + x) * 4;
  const da = px[i + 3];
  const oa = a + da * (1 - a);
  px[i] = (r * a + px[i] * da * (1 - a)) / oa;
  px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa;
  px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa;
  px[i + 3] = oa;
}

// Desenha uma forma a partir de uma função de distância assinada (negativa = dentro).
function fill(sdf, color, alpha = 1) {
  const c = typeof color === 'function' ? color : () => color;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      blend(x, y, c(x, y), clamp(0.5 - d) * alpha);
    }
  }
}

const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
const polygon = (pts) => (x, y) => {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const ex = bx - ax, ey = by - ay;
    const t = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -d : d;
};

// Fundo: quadrado arredondado com gradiente azul.
const top = hex('#1e88e5');
const bottom = hex('#0b3d91');
fill(roundRect(256, 256, 232, 232, 96), (x, y) => {
  const t = (x + y) / (2 * S);
  return top.map((v, k) => v + (bottom[k] - v) * t);
});

// Batente da porta (contorno) e porta entreaberta em perspectiva.
const white = hex('#ffffff');
fill((x, y) => {
  const outer = roundRect(222, 266, 104, 150, 14)(x, y);
  const inner = roundRect(222, 266, 80, 126, 6)(x, y);
  return Math.max(outer, -inner);
}, white);
fill(polygon([[142, 140], [248, 176], [248, 386], [142, 392]]), white);
fill(circle(226, 282, 11), hex('#1565c0'));

// Globo saindo pela porta: a "URL pública".
const gx = 352, gy = 176;
fill(circle(gx, gy, 74), hex('#0b3d91'));
fill(circle(gx, gy, 62), hex('#43d17a'));
// Linhas do globo, recortadas pelo círculo (max = interseção de SDFs).
const line = hex('#0b3d91');
const inGlobe = circle(gx, gy, 62);
fill(ring(gx, gy, 62, 10), line);
fill((x, y) => Math.max(Math.abs(y - gy) - 5, inGlobe(x, y)), line);
fill((x, y) => Math.max(Math.abs(x - gx) - 5, inGlobe(x, y)), line);
fill((x, y) => Math.max(Math.abs(Math.hypot((x - gx) * 2.1, y - gy) - 62) - 5, inGlobe(x, y)), line);

// ---------- Redimensionamento (média por área, com alpha pré-multiplicado) ----------
function resize(size) {
  const out = new Float32Array(size * size * 4);
  const k = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * k); sy < Math.ceil((y + 1) * k); sy++) {
        for (let sx = Math.floor(x * k); sx < Math.ceil((x + 1) * k); sx++) {
          const i = (sy * S + sx) * 4;
          const al = px[i + 3];
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
    }
  }
  return out;
}

// ---------- Codificação PNG ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 4; c++) raw[o + c] = Math.round(clamp(pixels[i + c]) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO com imagens PNG embutidas (formato aceito desde o Windows Vista).
function encodeIco(sizes) {
  const images = sizes.map((s) => encodePng(s === S ? px : resize(s), s));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // tipo: ícone
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    header[e] = sizes[i] >= 256 ? 0 : sizes[i];
    header[e + 1] = sizes[i] >= 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, e + 4); // planos
    header.writeUInt16LE(32, e + 6); // bits por pixel
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...images]);
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), encodePng(px, S));
fs.writeFileSync(path.join(dir, 'icon.ico'), encodeIco([256, 128, 64, 48, 32, 24, 16]));
console.log(`Ícones gerados em ${dir} (icon.png, icon.ico)`);
