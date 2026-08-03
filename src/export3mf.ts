/**
 * Minimal 3MF exporter — builds a valid 3MF (an OPC/ZIP package) from a
 * triangle mesh, entirely client-side. Uses a tiny store-only ZIP writer with
 * CRC-32, so no dependencies. Good enough for slicers / 3D-print tools.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

/** Build a store-only (uncompressed) ZIP archive. */
function zip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const cat = (...a: Uint8Array[]) => { const len = a.reduce((s, x) => s + x.length, 0); const out = new Uint8Array(len); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };

  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = cat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), nameB, e.data,
    );
    chunks.push(local);
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB,
    ));
    offset += local.length;
  }
  const centralData = cat(...central);
  const end = cat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralData.length), u32(offset), u16(0),
  );
  return cat(...chunks, centralData, end);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function modelXML(vertices: Float32Array, indices: Uint32Array): string {
  const v: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    v.push(`<vertex x="${vertices[i].toFixed(4)}" y="${vertices[i + 1].toFixed(4)}" z="${vertices[i + 2].toFixed(4)}"/>`);
  }
  const t: string[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    t.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>
<object id="1" type="model"><mesh>
<vertices>${v.join("")}</vertices>
<triangles>${t.join("")}</triangles>
</mesh></object>
</resources>
<build><item objectid="1"/></build>
</model>`;
}

/** Build a .3mf file (bytes) from a triangle mesh. */
export function build3MF(vertices: Float32Array, indices: Uint32Array): Uint8Array {
  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(modelXML(vertices, indices)) },
  ]);
}
