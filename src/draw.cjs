'use strict';

const { PNG } = require('pngjs');

const glyphs = {
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 1, 14],
  '-': [0, 0, 0, 31, 0, 0, 0],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  R: [30, 17, 17, 30, 20, 18, 17],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  W: [17, 17, 17, 21, 21, 21, 10],
};

const palette = {
  unknown: [0x323940, 0xffffff],
  idle: [0x323940, 0xffffff],
  running: [0x006343, 0xffffff],
  waiting: [0xffce57, 0x221702],
  error: [0xa01c32, 0xffffff],
};

function dimension(value) {
  return Number.isInteger(value) && value >= 40 && value <= 256 ? value : 64;
}

function rectangle(png, x, y, width, height, color) {
  const rgba = Buffer.from([(color >>> 16) & 255, (color >>> 8) & 255, color & 255, 255]);
  for (let row = y; row < y + height; row += 1) {
    const start = (row * png.width + x) * 4;
    png.data.fill(rgba, start, start + width * 4);
  }
}

function centeredText(png, line, top, scale, color) {
  const width = (line.length * 6 - 1) * scale;
  const left = Math.floor((png.width - width) / 2);
  for (let index = 0; index < line.length; index += 1) {
    const rows = glyphs[line[index]];
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        if ((rows[y] & (16 >> x)) !== 0) {
          rectangle(png, left + (index * 6 + x) * scale, top + y * scale, scale, scale, color);
        }
      }
    }
  }
}

function linesFor(view) {
  const count = String(view.active);
  switch (view.state) {
    case 'unknown': return ['-', 'HOOK'];
    case 'idle': return [count, 'IDLE'];
    case 'running': return [count, 'RUN'];
    case 'waiting': return [count, 'WAIT ' + view.waiting];
    case 'error': return [count, 'ERR ' + view.failed];
    default: throw new Error('Invalid display state');
  }
}

function renderKey(view, rawWidth, rawHeight) {
  const width = dimension(rawWidth);
  const height = dimension(rawHeight);
  const image = new PNG({ width, height });
  const [background, foreground] = palette[view.state];
  rectangle(image, 0, 0, width, height, background);
  const [number, fullLabel] = linesFor(view);
  const label = (fullLabel.length * 6 - 1) <= width - 4
    ? fullLabel : fullLabel.replace('WAIT', 'W').replace('ERR', 'E');
  const mainScale = Math.max(1,
    Math.min(Math.floor((width - 6) / (number.length * 6 - 1)), Math.floor(height * 0.56 / 7)));
  const labelScale = Math.max(1,
    Math.min(Math.floor((width - 4) / (label.length * 6 - 1)), Math.floor(height * 0.16 / 7)));
  const gap = Math.max(3, Math.floor(height * 0.08));
  const top = Math.floor((height - 7 * (mainScale + labelScale) - gap) / 2);
  centeredText(image, number, top, mainScale, foreground);
  centeredText(image, label, top + 7 * mainScale + gap, labelScale, foreground);
  return PNG.sync.write(image, { colorType: 2, deflateLevel: 3 });
}

module.exports = { renderKey, dimension, linesFor };
