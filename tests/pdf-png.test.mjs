import assert from 'node:assert/strict';
import { inflateSync, crc32 } from 'node:zlib';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { encodePdfPng } from '../src/main/pdfPng.ts';

// Partial alpha and antialiasing are essential to the isolated native glyphs.
const canvas=createCanvas(41,23),context=canvas.getContext('2d');
const pixels=new Uint8ClampedArray(41*23*4);
for(let i=0;i<pixels.length;i+=4){pixels[i]=i%251;pixels[i+1]=(i*3)%251;pixels[i+2]=(i*7)%251;pixels[i+3]=(i/4)%256;}
context.putImageData(new ImageData(pixels,41,23),0,0);
context.fillStyle='rgba(10,90,220,0.4)';context.fillText('Math 123',2,17);
const expected=context.getImageData(0,0,41,23).data,bytes=encodePdfPng(canvas);
assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
const chunks=[];
for(let offset=8;offset<bytes.length;){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
 assert.equal(bytes.readUInt32BE(offset+8+length),crc32(bytes.subarray(offset+4,offset+8+length)),type+' CRC');chunks.push({type,data});offset+=length+12;}
assert.deepEqual(chunks.map(chunk=>chunk.type),['IHDR','IDAT','IEND']);
const header=chunks[0].data;assert.equal(header.readUInt32BE(),41);assert.equal(header.readUInt32BE(4),23);assert.deepEqual([...header.subarray(8)],[8,6,0,0,0]);
const raw=inflateSync(chunks[1].data),stride=41*4;
for(let y=0;y<23;y++){assert.equal(raw[y*(stride+1)],0);assert.deepEqual(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),Buffer.from(expected.buffer,expected.byteOffset+y*stride,stride));}
const decoded=await loadImage(bytes),out=createCanvas(decoded.width,decoded.height);out.getContext('2d').drawImage(decoded,0,0);
assert.deepEqual(out.getContext('2d').getImageData(0,0,41,23).data,expected,'native decoder roundtrip keeps alpha and glyph pixels');
canvas.width=canvas.height=out.width=out.height=1;
console.log('Lossless PDF PNG pixels, alpha, dimensions and CRC passed');
