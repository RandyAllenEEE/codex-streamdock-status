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
  '/': [1, 1, 2, 4, 8, 16, 16],
};

const palette = {
  unknown: [0x323940, 0xffffff],
  idle: [0x323940, 0xffffff],
  running: [0x006343, 0xffffff],
  completed: [0x1264ae, 0xffffff],
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

function centeredText(png, line, top, scale, color, spacing = 1) {
  const width = (line.length * (5 + spacing) - spacing) * scale;
  const left = Math.floor((png.width - width) / 2);
  for (let index = 0; index < line.length; index += 1) {
    const rows = glyphs[line[index]];
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        if ((rows[y] & (16 >> x)) !== 0) {
          rectangle(png, left + (index * (5 + spacing) + x) * scale, top + y * scale, scale, scale, color);
        }
      }
    }
  }
}

function linesFor(view) {
  const count = String(view.running);
  switch (view.state) {
    case 'unknown': return ['-'];
    case 'idle':
    case 'running': return [count];
    case 'completed': return [view.unviewed + '/' + count];
    case 'waiting': return [view.waiting + '/' + count];
    case 'error': return [view.failed + '/' + count];
    default: throw new Error('Invalid display state');
  }
}

function renderKey(view, rawWidth, rawHeight) {
  const width = dimension(rawWidth);
  const height = dimension(rawHeight);
  const image = new PNG({ width, height });
  const [background, foreground] = palette[view.state];
  rectangle(image, 0, 0, width, height, background);
  const [number] = linesFor(view);
  const spacing = number.length * 6 - 1 > width - 4 ? 0 : 1;
  const numberWidth = number.length * (5 + spacing) - spacing;
  const usableHeight = Math.floor(height * 0.8);
  const scale = Math.max(1, Math.min(Math.floor((width - 4) / numberWidth), Math.floor(usableHeight * 0.7 / 7)));
  centeredText(image, number, Math.floor((usableHeight - 7 * scale) / 2), scale, foreground, spacing);
  return PNG.sync.write(image, { colorType: 2, deflateLevel: 3 });
}

module.exports = { renderKey, dimension, linesFor };
