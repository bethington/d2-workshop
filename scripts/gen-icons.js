const { PNG } = require('pngjs');
const fs = require('fs');

const size = 256;

function createPng() {
  return new PNG({ width: size, height: size });
}

function setPixel(png, x, y, r, g, b, a = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const idx = (size * y + x) << 2;
  if (a < 255 && png.data[idx + 3] > 0) {
    const srcA = a / 255;
    const dstA = 1 - srcA;
    png.data[idx] = Math.min(255, Math.floor(r * srcA + png.data[idx] * dstA));
    png.data[idx + 1] = Math.min(255, Math.floor(g * srcA + png.data[idx + 1] * dstA));
    png.data[idx + 2] = Math.min(255, Math.floor(b * srcA + png.data[idx + 2] * dstA));
    png.data[idx + 3] = 255;
  } else {
    png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a;
  }
}

function fillRect(png, x0, y0, w, h, r, g, b, a) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(png, x0 + dx, y0 + dy, r, g, b, a);
}

function fillCircle(png, cx, cy, radius, r, g, b, a = 255) {
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++)
      if (x * x + y * y <= radius * radius)
        setPixel(png, cx + x, cy + y, r, g, b, a);
}

function fillBackground(png) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grad = 1 - (y / size) * 0.4;
      setPixel(png, x, y, Math.floor(17 * grad), Math.floor(17 * grad), Math.floor(20 * grad));
    }
  }
}

function drawLine(png, x0, y0, x1, y1, r, g, b, thickness = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (dx * i) / steps;
    const y = y0 + (dy * i) / steps;
    for (let t = -thickness / 2; t <= thickness / 2; t++) {
      setPixel(png, x + t, y, r, g, b);
      setPixel(png, x, y + t, r, g, b);
    }
  }
}

// Gold colors matching d2docs.xebyte.com
const gold = [199, 179, 119];
const darkGold = [140, 120, 60];
const brightGold = [230, 210, 140];

function drawD2(png, bx, by, t, color) {
  const [r, g, b] = color;
  // D
  fillRect(png, bx, by, t, 28, r, g, b);
  fillRect(png, bx, by, 14, t, r, g, b);
  fillRect(png, bx, by + 25, 14, t, r, g, b);
  fillRect(png, bx + 14, by + 3, t, 22, r, g, b);
  // 2
  fillRect(png, bx + 22, by, 18, t, r, g, b);
  fillRect(png, bx + 37, by, t, 14, r, g, b);
  fillRect(png, bx + 22, by + 12, 18, t, r, g, b);
  fillRect(png, bx + 22, by + 12, t, 16, r, g, b);
  fillRect(png, bx + 22, by + 25, 18, t, r, g, b);
}

// ===== OPTION A: Anvil with hammer =====
{
  const png = createPng();
  fillBackground(png);

  // Anvil top (flat surface)
  fillRect(png, 55, 100, 146, 14, ...gold);
  // Anvil horn (left taper)
  for (let i = 0; i < 35; i++) {
    const w = 14 - Math.floor(i * 12 / 35);
    fillRect(png, 35 + i, 100 + Math.floor(i / 3), w, 10, ...darkGold);
  }
  // Anvil body
  fillRect(png, 75, 114, 106, 50, ...darkGold);
  // Highlight on body
  fillRect(png, 75, 114, 106, 3, ...gold);
  // Anvil base
  fillRect(png, 60, 164, 136, 16, ...gold);
  // Anvil feet
  fillRect(png, 65, 180, 35, 18, ...darkGold);
  fillRect(png, 156, 180, 35, 18, ...darkGold);
  // Highlight on top surface
  for (let x = 58; x < 198; x++) {
    setPixel(png, x, 99, ...brightGold, 220);
    setPixel(png, x, 98, ...brightGold, 100);
  }

  // Hammer (angled)
  // Handle
  for (let i = 0; i < 90; i++) {
    fillRect(png, 145 + Math.floor(i * 0.45), 25 + Math.floor(i * 0.7), 5, 5, 110, 85, 45);
  }
  // Hammer head
  fillRect(png, 128, 14, 44, 22, ...brightGold);
  fillRect(png, 125, 17, 50, 16, ...gold);
  // Hammer head highlight
  fillRect(png, 128, 14, 44, 3, 255, 240, 180);

  drawD2(png, 96, 212, 3, gold);

  fs.writeFileSync('resources/icons/icon-option-a.png', PNG.sync.write(png));
  console.log('Option A: Anvil with hammer');
}

// ===== OPTION B: Horadric Cube =====
{
  const png = createPng();
  fillBackground(png);

  const cx = 128, cy = 110;
  const s = 58;

  // Front face
  fillRect(png, cx - s, cy - s + 18, s * 2, s * 2, 26, 26, 32);
  // Border
  for (let i = 0; i < 4; i++) {
    fillRect(png, cx - s + i, cy - s + 18 + i, s * 2 - i * 2, 1, ...gold);
    fillRect(png, cx - s + i, cy + s + 17 - i, s * 2 - i * 2, 1, ...gold);
    fillRect(png, cx - s + i, cy - s + 18 + i, 1, s * 2 - i * 2, ...gold);
    fillRect(png, cx + s - 1 - i, cy - s + 18 + i, 1, s * 2 - i * 2, ...gold);
  }

  // Top face (parallelogram)
  for (let row = 0; row < 28; row++) {
    const offset = 28 - row;
    const bright = 0.35 + row * 0.023;
    fillRect(png, cx - s + offset + 4, cy - s + 18 - 28 + row, s * 2 - 8, 1,
      Math.floor(gold[0] * bright), Math.floor(gold[1] * bright), Math.floor(gold[2] * bright));
  }
  drawLine(png, cx - s + 4, cy - s + 18, cx - s + 32, cy - s - 10, ...gold, 2);
  drawLine(png, cx + s - 4, cy - s + 18, cx + s + 24, cy - s - 10, ...gold, 2);
  drawLine(png, cx - s + 32, cy - s - 10, cx + s + 24, cy - s - 10, ...gold, 2);

  // Right face
  for (let row = 0; row < s * 2; row++) {
    const offset = Math.floor(28 * (1 - row / (s * 2)));
    fillRect(png, cx + s, cy - s + 18 + row, offset + 4, 1,
      Math.floor(15), Math.floor(15), Math.floor(18));
  }
  drawLine(png, cx + s, cy - s + 18, cx + s + 28, cy - s - 10, ...gold, 2);
  drawLine(png, cx + s + 28, cy - s - 10, cx + s + 28, cy + s - 10, ...darkGold, 2);
  drawLine(png, cx + s, cy + s + 17, cx + s + 28, cy + s - 10, ...darkGold, 2);

  // Decorative diamond on front face
  const gx = cx, gy = cy + 18;
  for (let i = 0; i < 22; i++) {
    fillRect(png, gx - i, gy - 22 + i, i * 2, 1, ...brightGold, 180);
  }
  for (let i = 0; i < 22; i++) {
    fillRect(png, gx - 22 + i, gy + i, (22 - i) * 2, 1, ...darkGold, 180);
  }

  // Lid line
  fillRect(png, cx - s + 5, cy - s + 22, s * 2 - 10, 2, ...brightGold);
  // Clasp
  fillRect(png, cx - 6, cy - s + 15, 12, 10, ...brightGold);

  drawD2(png, 96, 210, 3, gold);

  fs.writeFileSync('resources/icons/icon-option-b.png', PNG.sync.write(png));
  console.log('Option B: Horadric Cube');
}

// ===== OPTION C: Rune stone =====
{
  const png = createPng();
  fillBackground(png);

  const sx = 68, sy = 25, sw = 120, sh = 175;

  // Stone tablet
  for (let y = 0; y < sh; y++) {
    const topRound = y < 20 ? Math.floor(Math.sqrt(400 - (20 - y) * (20 - y))) : 20;
    const botRound = y > sh - 20 ? Math.floor(Math.sqrt(400 - (y - sh + 20) * (y - sh + 20))) : 20;
    const inset = 20 - Math.min(topRound, botRound);
    const shade = 0.8 + Math.sin(y * 0.05) * 0.08;
    fillRect(png, sx + inset, sy + y, sw - inset * 2, 1,
      Math.floor(50 * shade), Math.floor(45 * shade), Math.floor(40 * shade));
  }

  // Border glow
  for (let y = 0; y < sh; y++) {
    const topRound = y < 20 ? Math.floor(Math.sqrt(400 - (20 - y) * (20 - y))) : 20;
    const botRound = y > sh - 20 ? Math.floor(Math.sqrt(400 - (y - sh + 20) * (y - sh + 20))) : 20;
    const inset = 20 - Math.min(topRound, botRound);
    setPixel(png, sx + inset, sy + y, ...gold, 220);
    setPixel(png, sx + inset + 1, sy + y, ...gold, 100);
    setPixel(png, sx + sw - inset - 1, sy + y, ...gold, 220);
    setPixel(png, sx + sw - inset - 2, sy + y, ...gold, 100);
  }
  for (let x = sx + 20; x < sx + sw - 20; x++) {
    setPixel(png, x, sy, ...gold, 220);
    setPixel(png, x, sy + 1, ...gold, 100);
    setPixel(png, x, sy + sh - 1, ...gold, 220);
    setPixel(png, x, sy + sh - 2, ...gold, 100);
  }

  // Rune symbol (Ber-rune inspired - tree/branch shape)
  const rcx = 128, rcy = 90;
  // Main vertical
  fillRect(png, rcx - 3, rcy - 40, 6, 85, ...brightGold);
  // Top branches (V shape)
  drawLine(png, rcx, rcy - 40, rcx - 30, rcy - 15, ...gold, 4);
  drawLine(png, rcx, rcy - 40, rcx + 30, rcy - 15, ...gold, 4);
  // Middle branches
  drawLine(png, rcx, rcy - 5, rcx - 25, rcy + 15, ...gold, 4);
  drawLine(png, rcx, rcy - 5, rcx + 25, rcy + 15, ...gold, 4);
  // Dots at ends
  fillCircle(png, rcx - 30, rcy - 15, 5, ...brightGold);
  fillCircle(png, rcx + 30, rcy - 15, 5, ...brightGold);
  fillCircle(png, rcx - 25, rcy + 15, 5, ...brightGold);
  fillCircle(png, rcx + 25, rcy + 15, 5, ...brightGold);
  fillCircle(png, rcx, rcy + 45, 5, ...brightGold);

  // Glow ring
  for (let angle = 0; angle < 360; angle += 1) {
    const rad = angle * Math.PI / 180;
    for (let r = 50; r < 58; r++) {
      setPixel(png, rcx + Math.cos(rad) * r, rcy + Math.sin(rad) * r, ...gold, Math.floor(50 - (r - 50) * 6));
    }
  }

  drawD2(png, 96, 160, 3, brightGold);

  fs.writeFileSync('resources/icons/icon-option-c.png', PNG.sync.write(png));
  console.log('Option C: Rune stone');
}

// ===== OPTION D: Gem/Crystal =====
{
  const png = createPng();
  fillBackground(png);

  const cx = 128, cy = 100;

  // Top facets
  for (let i = 0; i < 60; i++) {
    const w = Math.floor(i * 1.5);
    const bright = 0.5 + (i / 60) * 0.5;
    fillRect(png, cx - w, cy - 60 + i, w * 2, 1,
      Math.floor(gold[0] * bright), Math.floor(gold[1] * bright), Math.floor(gold[2] * bright));
  }

  // Bottom facets
  for (let i = 0; i < 85; i++) {
    const maxW = 90;
    const w = maxW - Math.floor(i * maxW / 85);
    const bright = 0.75 - (i / 85) * 0.45;
    fillRect(png, cx - w, cy + i, w * 2, 1,
      Math.floor(gold[0] * bright), Math.floor(gold[1] * bright), Math.floor(gold[2] * bright));
  }

  // Facet lines - top
  drawLine(png, cx, cy - 60, cx - 45, cy, ...brightGold, 2);
  drawLine(png, cx, cy - 60, cx + 45, cy, ...brightGold, 2);
  drawLine(png, cx, cy - 60, cx - 20, cy, ...brightGold, 1);
  drawLine(png, cx, cy - 60, cx + 20, cy, ...brightGold, 1);

  // Horizontal facet
  fillRect(png, cx - 90, cy - 1, 180, 3, ...brightGold);

  // Facet lines - bottom
  drawLine(png, cx - 90, cy, cx, cy + 85, ...darkGold, 2);
  drawLine(png, cx + 90, cy, cx, cy + 85, ...darkGold, 2);
  drawLine(png, cx - 45, cy, cx, cy + 85, ...darkGold, 1);
  drawLine(png, cx + 45, cy, cx, cy + 85, ...darkGold, 1);

  // Sparkle at apex
  for (let r = 1; r < 18; r++) {
    const a = Math.floor(255 - r * 14);
    setPixel(png, cx, cy - 60 - r, 255, 255, 220, a);
    setPixel(png, cx, cy - 60 + r, 255, 255, 220, Math.floor(a * 0.5));
    setPixel(png, cx - r, cy - 60, 255, 255, 220, Math.floor(a * 0.7));
    setPixel(png, cx + r, cy - 60, 255, 255, 220, Math.floor(a * 0.7));
  }
  // Diagonal sparkle rays
  for (let r = 1; r < 12; r++) {
    const a = Math.floor(180 - r * 14);
    setPixel(png, cx - r, cy - 60 - r, 255, 255, 220, a);
    setPixel(png, cx + r, cy - 60 - r, 255, 255, 220, a);
  }

  drawD2(png, 96, 208, 3, gold);

  fs.writeFileSync('resources/icons/icon-option-d.png', PNG.sync.write(png));
  console.log('Option D: Gem/Crystal');
}

console.log('All 4 icons generated in resources/icons/');
