// Just enough ZIP for .ds files: write one stored (uncompressed) entry, and read
// an entry back whether it's stored or deflated.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A ZIP with a single stored entry (what Dungeon Scrawl itself writes). */
export function zipOne(name: string, data: Buffer, when = new Date()): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const { time, date } = dosDateTime(when);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(10, 4); // made by
  central.writeUInt16LE(10, 6); // needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header at offset 0

  const cdOffset = local.length + nameBuf.length + data.length;
  const cdSize = central.length + nameBuf.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

/** The most an entry may unpack to (a .ds map is a few MB), so a small deflated "zip bomb" can't fill the memory. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Read one entry by name, via the central directory. Stored and deflated
 * entries are supported, up to `maxBytes` unpacked: an entry that says it is
 * bigger, or turns out bigger while it inflates, is refused (ZipError).
 */
export function unzipEntry(buf: Buffer, name: string, maxBytes = MAX_ENTRY_BYTES): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a ZIP file (no end-of-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('damaged ZIP directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const entry = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (entry === name) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) throw new ZipError('damaged ZIP entry');
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const raw = buf.subarray(start, start + csize);
      const tooBig = `the ZIP entry "${name}" is too big (at most ${mb(maxBytes)} unpacked)`;
      if (size > maxBytes || (method === 0 && raw.length > maxBytes)) throw new ZipError(tooBig);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) {
        try {
          // the stated size can lie: inflating stops at the limit whatever it says
          return inflateRawSync(raw, { maxOutputLength: maxBytes });
        } catch (e) {
          if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(tooBig);
          throw new ZipError(`damaged ZIP entry "${name}" (${(e as Error).message})`);
        }
      }
      throw new ZipError(`unsupported ZIP compression method ${method}`);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new ZipError(`the ZIP has no "${name}" entry`);
}

/**
 * A ZIP of several files, each deflated (or stored when that is no smaller),
 * with UTF-8 names and forward slashes: the desktop app's Claude Desktop
 * extension (desktop/claude-extension.ts). Not used by the web server.
 */
export function zipFiles(files: readonly { name: string; data: Buffer }[], when = new Date()): Buffer {
  const { time, date } = dosDateTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (!f.name || f.name.startsWith('/') || f.name.includes('\\') || f.name.split('/').includes('..')) throw new ZipError(`bad entry name "${f.name}"`);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data, { level: 9 });
    const method = deflated.length < f.data.length ? 8 : 0;
    const body = method === 8 ? deflated : f.data;
    const head = (sig: number, size: number) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const local = head(0x04034b50, 30);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = head(0x02014b50, 46);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
