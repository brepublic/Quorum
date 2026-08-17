const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 digest is already complete.');
    this.bytesHashed += data.byteLength;
    let offset = 0;
    while (offset < data.byteLength) {
      const length = Math.min(64 - this.bufferLength, data.byteLength - offset);
      this.buffer.set(data.subarray(offset, offset + length), this.bufferLength);
      this.bufferLength += length;
      offset += length;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error('SHA-256 digest is already complete.');
    this.finished = true;
    const bitLength = this.bytesHashed * 8;
    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.buffer);
    return Array.from(this.state, value => value.toString(16).padStart(8, '0')).join('');
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15] as number;
      const recent = words[index - 2] as number;
      const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      words[index] = ((words[index - 16] as number) + sigma0 + (words[index - 7] as number) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const upper1 = rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const choose = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const first = ((h as number) + upper1 + choose + (ROUND_CONSTANTS[index] as number) + (words[index] as number)) >>> 0;
      const upper0 = rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const majority = ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const second = (upper0 + majority) >>> 0;
      h = g; g = f; f = e; e = ((d as number) + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.state[0] = ((this.state[0] as number) + (a as number)) >>> 0;
    this.state[1] = ((this.state[1] as number) + (b as number)) >>> 0;
    this.state[2] = ((this.state[2] as number) + (c as number)) >>> 0;
    this.state[3] = ((this.state[3] as number) + (d as number)) >>> 0;
    this.state[4] = ((this.state[4] as number) + (e as number)) >>> 0;
    this.state[5] = ((this.state[5] as number) + (f as number)) >>> 0;
    this.state[6] = ((this.state[6] as number) + (g as number)) >>> 0;
    this.state[7] = ((this.state[7] as number) + (h as number)) >>> 0;
  }
}

function cancelled(): DOMException {
  return new DOMException('Hashing cancelled.', 'AbortError');
}

function readChunk(blob: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const finish = () => signal?.removeEventListener('abort', abort);
    reader.onload = () => { finish(); resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { finish(); reject(reader.error ?? new Error('File chunk could not be read.')); };
    reader.onabort = () => { finish(); reject(cancelled()); };
    if (signal?.aborted) { reject(cancelled()); return; }
    signal?.addEventListener('abort', abort, {once: true});
    reader.readAsArrayBuffer(blob);
  });
}

export async function sha256File(file: Blob, options: {
  signal?: AbortSignal;
  chunkBytes?: number;
  onProgress?: (processedBytes: number, totalBytes: number) => void;
} = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Hash chunk size is invalid.');
  const hash = new IncrementalSha256();
  options.onProgress?.(0, file.size);
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (options.signal?.aborted) throw cancelled();
    const end = Math.min(file.size, offset + chunkBytes);
    const chunk = await readChunk(file.slice(offset, end), options.signal);
    if (options.signal?.aborted) throw cancelled();
    hash.update(chunk);
    options.onProgress?.(end, file.size);
  }
  if (options.signal?.aborted) throw cancelled();
  return hash.digestHex();
}
