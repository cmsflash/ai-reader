import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 128];
const iconDirectory = fileURLToPath(new URL("../icons/", import.meta.url));

mkdirSync(iconDirectory, { recursive: true });

for (const size of sizes) {
  const pixels = rasterizeIcon(size);
  const png = encodePng(size, size, pixels);
  writeFileSync(`${iconDirectory}/icon${size}.png`, png);
}

function rasterizeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = insideRoundedRectangle(x + 0.5, y + 0.5, size, radius);
      const pageTop = size * 0.24;
      const pageBottom = size * 0.76;
      const pageOuter = size * 0.2;
      const gutter = size * 0.5;
      const onLeftPage =
        x >= pageOuter && x < gutter - size * 0.045 && y >= pageTop && y <= pageBottom;
      const onRightPage =
        x > gutter + size * 0.045 && x <= size - pageOuter && y >= pageTop && y <= pageBottom;
      const onPage = inside && (onLeftPage || onRightPage);

      if (!inside) {
        pixels[offset + 3] = 0;
        continue;
      }

      if (onPage) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
        continue;
      }

      const shade = Math.round(18 * (y / Math.max(1, size - 1)));
      pixels[offset] = 29;
      pixels[offset + 1] = 78 + shade;
      pixels[offset + 2] = 216 + Math.round(shade * 0.7);
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

function insideRoundedRectangle(x, y, size, radius) {
  const nearestX = Math.max(radius, Math.min(x, size - radius));
  const nearestY = Math.max(radius, Math.min(y, size - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function encodePng(width, height, rgbaPixels) {
  const rowLength = width * 4;
  const rawRows = Buffer.alloc((rowLength + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const targetOffset = y * (rowLength + 1);
    rawRows[targetOffset] = 0;
    rgbaPixels.copy(rawRows, targetOffset + 1, y * rowLength, (y + 1) * rowLength);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rawRows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
