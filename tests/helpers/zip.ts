import zlib from 'node:zlib';

/** A small ZIP writer for fixtures (stored or deflated entries). */
export function makeZip(entries: { name: string; text: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.text, 'utf8');
    const body = e.deflate ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}


/** Search Console export files as English Search Console writes them (fixture). */
export const GSC_FIXTURE = {
  pages: 'Top pages,Clicks,Impressions,CTR,Position\nhttps://celeb.example/tom-kaulitz/,"1,204",23411,5.14%,7.2\nhttps://celeb.example/bill-kaulitz/,88,9001,0.98%,14.6\n',
  queries: 'Top queries,Clicks,Impressions,CTR,Position\ntom kaulitz,700,9000,7.78%,3.1\n"tom kaulitz, heidi klum",12,400,3%,9\n',
  dates: 'Date,Clicks,Impressions,CTR,Position\n2026-10-14,40,900,4.44%,8.1\n2026-10-13,38,880,4.32%,8.3\n',
  filters: 'Filter,Value\nSearch type,Web\nDate,Last 28 days\n',
};
