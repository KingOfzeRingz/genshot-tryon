#!/usr/bin/env node

/**
 * Run this script with Node.js to generate the extension icon PNGs:
 *   node extension/icons/generate-icons.js
 *
 * No dependencies required - uses pure JS PNG encoding.
 */

const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c = 0xffffffff;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    table[n] = v;
  }
  for (let i = 0; i < buf.length; i++)
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1,
    b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function deflateStore(data) {
  const result = [];
  const blockSize = 65535;
  for (let i = 0; i < data.length; i += blockSize) {
    const isLast = i + blockSize >= data.length;
    const block = data.slice(i, i + blockSize);
    const len = block.length;
    result.push(isLast ? 1 : 0);
    result.push(len & 0xff, (len >> 8) & 0xff);
    result.push(~len & 0xff, (~len >> 8) & 0xff);
    for (let j = 0; j < block.length; j++) result.push(block[j]);
  }
  return Buffer.from(result);
}

function zlibCompress(data) {
  const raw = deflateStore(data);
  const adl = adler32(data);
  const out = Buffer.alloc(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  raw.copy(out, 2);
  out.writeUInt32BE(adl, 2 + raw.length);
  return out;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, "ascii");
  const crcBuf = Buffer.concat([typeB, data]);
  const crcV = crc32(crcBuf);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crcV);
  return Buffer.concat([len, typeB, data, crcB]);
}

function createPNG(width, height, rgbaData) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(0);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawRows.push(rgbaData[idx], rgbaData[idx + 1], rgbaData[idx + 2], rgbaData[idx + 3]);
    }
  }
  const compressed = zlibCompress(Buffer.from(rawRows));

  return Buffer.concat([
    sig,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function generateIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const r2 = size * 0.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      let inside = true;
      if (x < r2 && y < r2) {
        inside = (x - r2) ** 2 + (y - r2) ** 2 <= r2 * r2;
      } else if (x >= size - r2 && y < r2) {
        inside = (x - (size - r2)) ** 2 + (y - r2) ** 2 <= r2 * r2;
      } else if (x < r2 && y >= size - r2) {
        inside = (x - r2) ** 2 + (y - (size - r2)) ** 2 <= r2 * r2;
      } else if (x >= size - r2 && y >= size - r2) {
        inside = (x - (size - r2)) ** 2 + (y - (size - r2)) ** 2 <= r2 * r2;
      }

      if (inside) {
        rgba[idx] = 0x6c;
        rgba[idx + 1] = 0x5c;
        rgba[idx + 2] = 0xe7;
        rgba[idx + 3] = 255;

        const cx = size / 2;
        const cy = size / 2;
        const letterR = size * 0.32;
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const innerR = letterR * 0.6;

        if (dist >= innerR && dist <= letterR) {
          const angle = Math.atan2(dy, dx);
          const deg = ((angle * 180) / Math.PI + 360) % 360;
          if (!(deg > 315 || deg < 45)) {
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
          }
        }

        const barThick = Math.max(1, size * 0.08);
        if (Math.abs(y - cy) <= barThick && x >= cx && x <= cx + letterR) {
          rgba[idx] = 255;
          rgba[idx + 1] = 255;
          rgba[idx + 2] = 255;
        }
      } else {
        rgba[idx + 3] = 0;
      }
    }
  }

  return createPNG(size, size, rgba);
}

const dir = path.dirname(__filename || process.argv[1]);

[16, 48, 128].forEach((size) => {
  const filePath = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(filePath, generateIcon(size));
  console.log(`Created ${filePath}`);
});

console.log("Done! Icons generated successfully.");
