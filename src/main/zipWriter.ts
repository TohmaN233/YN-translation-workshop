import { deflateRawSync } from "node:zlib";

interface ZipEntryInput {
  path: string;
  data: Buffer;
  store?: boolean;
}

interface CentralEntry {
  path: string;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  offset: number;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(): { time: number; date: number } {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

function localHeader(entry: CentralEntry, name: Buffer): Buffer {
  const { time, date } = dosTime();
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry: CentralEntry, name: Buffer): Buffer {
  const { time, date } = dosTime();
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

export function createZipBuffer(inputs: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const centralEntries: CentralEntry[] = [];
  let offset = 0;

  for (const input of inputs) {
    const name = Buffer.from(input.path.replace(/\\/g, "/"), "utf8");
    const compressed = input.store ? input.data : deflateRawSync(input.data);
    const entry: CentralEntry = {
      path: input.path,
      crc: crc32(input.data),
      compressedSize: compressed.length,
      uncompressedSize: input.data.length,
      method: input.store ? 0 : 8,
      offset
    };
    const header = localHeader(entry, name);
    chunks.push(header, name, compressed);
    offset += header.length + name.length + compressed.length;
    centralEntries.push(entry);
  }

  const centralOffset = offset;
  for (const entry of centralEntries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const header = centralHeader(entry, name);
    chunks.push(header, name);
    offset += header.length + name.length;
  }

  chunks.push(endOfCentralDirectory(centralEntries.length, offset - centralOffset, centralOffset));
  return Buffer.concat(chunks);
}
