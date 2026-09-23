import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class JsonStore {
  constructor(dir) {
    this.dir = dir;
  }
  async read(name, fallback = null) {
    try {
      return JSON.parse(await readFile(path.join(this.dir, `${name}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }
  async write(name, value) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${name}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  }
}

export const token = () => randomBytes(32).toString('base64url');
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function signedCursor(value, key) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
export function readCursor(cursor, key) {
  if (typeof cursor !== 'string' || cursor.length > 10000) throw new ServiceError('INVALID_CURSOR');
  const [encoded, signature, extra] = cursor.split('.');
  if (!encoded || !signature || extra) throw new ServiceError('INVALID_CURSOR');
  const expected = createHmac('sha256', key).update(encoded).digest('base64url');
  if (!sameSecret(signature, expected)) throw new ServiceError('INVALID_CURSOR');
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ServiceError('INVALID_CURSOR');
  }
}
export class SerialQueue {
  current = Promise.resolve();
  run(task) {
    const next = this.current.then(task);
    this.current = next.catch(() => {});
    return next;
  }
}
