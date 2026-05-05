import { deflateSync } from 'node:zlib';

const WIDTH = 1600;
const HEIGHT = 720;
const WHITE = [255, 255, 255, 255];
const SOFT_WHITE = [210, 210, 210, 255];

export function createWelcomeCard({ guildName = 'TU SERVIDOR' } = {}) {
  const image = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  fillBackground(image);
  drawGrid(image);
  drawHalo(image, 390, 350, 210);
  drawLogo(image, 390, 350);
  drawWord(image, 'GRACIAS', 700, 150, 13, WHITE, 2);
  drawWord(image, 'POR CONFIAR EN', 704, 340, 6, SOFT_WHITE, 2);
  drawWord(image, 'NEXADESK', 704, 435, 11, WHITE, 2);
  drawWord(image, trimToBlockText(guildName).slice(0, 18), 704, 595, 4, [150, 150, 150, 255], 2);
  drawCircuitLines(image);
  return encodePng(image, WIDTH, HEIGHT);
}

function fillBackground(image) {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      const radial = Math.max(0, 1 - distance(x, y, 760, 330) / 980);
      const vignette = Math.max(0, distance(x, y, WIDTH / 2, HEIGHT / 2) / 900);
      const value = Math.round(5 + radial * 18 - vignette * 8);
      image[i] = Math.max(0, value);
      image[i + 1] = Math.max(0, value);
      image[i + 2] = Math.max(0, value);
      image[i + 3] = 255;
    }
  }
}

function drawGrid(image) {
  for (let x = 0; x < WIDTH; x += 86) {
    drawLine(image, x, 0, x, HEIGHT, [255, 255, 255, x % 172 === 0 ? 30 : 16]);
  }
  for (let y = 0; y < HEIGHT; y += 86) {
    drawLine(image, 0, y, WIDTH, y, [255, 255, 255, y % 172 === 0 ? 30 : 16]);
  }
}

function drawHalo(image, cx, cy, radius) {
  for (let r = radius + 90; r >= radius - 45; r -= 1) {
    const alpha = Math.max(0, 34 - Math.abs(r - radius) * 0.45);
    drawCircle(image, cx, cy, r, [255, 255, 255, alpha]);
  }
  drawCircle(image, cx, cy, radius, [255, 255, 255, 255], 18);
  drawCircle(image, cx, cy, radius + 78, [255, 255, 255, 58], 5);
  drawCircle(image, cx, cy, radius - 2, [255, 255, 255, 34], 2);
}

function drawLogo(image, cx, cy) {
  const bubble = [
    [cx - 92, cy - 62],
    [cx + 72, cy - 62],
    [cx + 92, cy - 44],
    [cx + 92, cy + 38],
    [cx + 42, cy + 38],
    [cx + 4, cy + 78],
    [cx + 8, cy + 38],
    [cx - 92, cy + 38]
  ];
  drawPolyline(image, bubble, [255, 255, 255, 240], 10, true);
  drawLine(image, cx - 50, cy - 22, cx + 50, cy - 22, [255, 255, 255, 210], 9);
  drawLine(image, cx - 50, cy + 2, cx + 34, cy + 2, [255, 255, 255, 160], 8);
  drawLine(image, cx - 50, cy + 26, cx + 64, cy + 26, [255, 255, 255, 190], 8);
}

function drawCircuitLines(image) {
  const color = [255, 255, 255, 55];
  drawLine(image, 80, 625, 620, 625, color, 3);
  drawLine(image, 620, 625, 680, 565, color, 3);
  drawLine(image, 1180, 110, 1510, 110, color, 3);
  drawLine(image, 1130, 610, 1520, 610, color, 3);
  for (const [x, y] of [[92, 625], [620, 625], [1180, 110], [1510, 110], [1130, 610], [1520, 610]]) {
    fillCircle(image, x, y, 8, [255, 255, 255, 150]);
  }
}

function drawWord(image, text, x, y, scale, color, spacing = 4) {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    if (char === ' ') {
      cursor += scale * 4;
      continue;
    }
    const glyph = FONT[char] || FONT['?'];
    drawGlyph(image, glyph, cursor, y, scale, color);
    cursor += (glyph[0].length + spacing) * scale;
  }
}

function drawGlyph(image, glyph, x, y, scale, color) {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let col = 0; col < glyph[row].length; col += 1) {
      if (glyph[row][col] !== '1') continue;
      fillRect(image, x + col * scale, y + row * scale, scale * 0.82, scale * 0.82, color);
    }
  }
}

function drawPolyline(image, points, color, width = 1, closed = false) {
  for (let i = 0; i < points.length - 1; i += 1) {
    drawLine(image, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], color, width);
  }
  if (closed) {
    drawLine(image, points[points.length - 1][0], points[points.length - 1][1], points[0][0], points[0][1], color, width);
  }
}

function drawLine(image, x0, y0, x1, y1, color, width = 1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps ? i / steps : 0;
    fillCircle(image, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), width / 2, color);
  }
}

function drawCircle(image, cx, cy, radius, color, width = 1) {
  const steps = Math.max(240, Math.round(radius * 6));
  for (let i = 0; i < steps; i += 1) {
    const angle = (Math.PI * 2 * i) / steps;
    fillCircle(image, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, width / 2, color);
  }
}

function fillCircle(image, cx, cy, radius, color) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (distance(x, y, cx, cy) <= radius) blendPixel(image, x, y, color);
    }
  }
}

function fillRect(image, x, y, width, height, color) {
  for (let yy = Math.floor(y); yy < Math.floor(y + height); yy += 1) {
    for (let xx = Math.floor(x); xx < Math.floor(x + width); xx += 1) {
      blendPixel(image, xx, yy, color);
    }
  }
}

function blendPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (Math.floor(y) * WIDTH + Math.floor(x)) * 4;
  const alpha = (color[3] ?? 255) / 255;
  image[i] = Math.round(image[i] * (1 - alpha) + color[0] * alpha);
  image[i + 1] = Math.round(image[i + 1] * (1 - alpha) + color[1] * alpha);
  image[i + 2] = Math.round(image[i + 2] * (1 - alpha) + color[2] * alpha);
  image[i + 3] = 255;
}

function encodePng(pixels, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', buildIhdr(width, height)),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function buildIhdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function trimToBlockText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/gi, '')
    .trim()
    .toUpperCase() || 'TU SERVIDOR';
}

const CRC_TABLE = buildCrcTable();

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '11110'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100']
};
