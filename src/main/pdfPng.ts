import type { Canvas } from "@napi-rs/canvas";
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, bytes: Buffer): Buffer {
  const result = Buffer.allocUnsafe(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4, 4, "ascii");
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** Lossless RGBA PNG: favor preparation latency over expensive adaptive filters.
 * Keep the canvas resolution, transparent glyph edges and every original pixel.
 */
export function encodePdfPng(canvas: Canvas): Buffer {
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const stride = width * 4, rows = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0; // PNG filter None; zlib still compresses identical runs.
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(rows, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Eight bits per channel.
  header[9] = 6; // RGBA, including transparent native glyph layers.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 1 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
