// Minimal glTF 2.0 binary (.glb) reader / writer / compactor for the bundled avatar tools.
// Only what the rigid-part avatar models need: one buffer, no extensions with buffer data.

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export function readGLB(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error("not a GLB file");
  let off = 12,
    json = null,
    bin = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off),
      type = buf.readUInt32LE(off + 4),
      data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString("utf8"));
    else if (type === BIN_CHUNK) bin = Buffer.from(data);
    off += 8 + len;
  }
  return { json, bin };
}

function pad(b, fill) {
  const extra = (4 - (b.length % 4)) % 4;
  return extra ? Buffer.concat([b, Buffer.alloc(extra, fill)]) : b;
}

export function writeGLB({ json, bin }) {
  const binPadded = pad(bin, 0);
  json.buffers = binPadded.length ? [{ byteLength: binPadded.length }] : [];
  const jsonBuf = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const total = 12 + 8 + jsonBuf.length + (binPadded.length ? 8 + binPadded.length : 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return [h, data];
  };
  return Buffer.concat([
    head,
    ...chunk(JSON_CHUNK, jsonBuf),
    ...(binPadded.length ? chunk(BIN_CHUNK, binPadded) : []),
  ]);
}

// Removes the named nodes (with their whole subtrees) and the animation channels that target
// them, then drops meshes, materials, accessors and buffer views nothing references any more.
export function removeNodes(gltf, names) {
  const { json } = gltf;
  const doomed = new Set();
  const mark = (i) => {
    if (doomed.has(i)) return;
    doomed.add(i);
    for (const c of json.nodes[i].children || []) mark(c);
  };
  json.nodes.forEach((n, i) => names.includes(n.name) && mark(i));
  const missing = names.filter((n) => !json.nodes.some((x) => x.name === n));
  if (missing.length) throw new Error(`nodes not found: ${missing.join(", ")}`);
  const remap = new Map();
  const nodes = [];
  json.nodes.forEach((n, i) => doomed.has(i) || (remap.set(i, nodes.length), nodes.push(n)));
  for (const n of nodes) {
    if (!n.children) continue;
    n.children = n.children.filter((c) => !doomed.has(c)).map((c) => remap.get(c));
    n.children.length || delete n.children;
  }
  json.nodes = nodes;
  for (const s of json.scenes || []) s.nodes = s.nodes.filter((c) => !doomed.has(c)).map((c) => remap.get(c));
  for (const a of json.animations || []) {
    const keep = a.channels.filter((c) => !doomed.has(c.target.node));
    const used = [...new Set(keep.map((c) => c.sampler))];
    a.samplers = used.map((s) => a.samplers[s]);
    a.channels = keep.map((c) => ({ ...c, sampler: used.indexOf(c.sampler), target: { ...c.target, node: remap.get(c.target.node) } }));
  }
  json.animations = (json.animations || []).filter((a) => a.channels.length);
  json.animations.length || delete json.animations;
  return compact(gltf);
}

// garbage-collects meshes → materials → accessors → bufferViews and repacks the binary chunk
export function compact(gltf) {
  const { json, bin } = gltf;
  const reindex = (list, used) => {
    const map = new Map(),
      out = [];
    list.forEach((x, i) => used.has(i) && (map.set(i, out.length), out.push(x)));
    return { map, out };
  };
  // meshes
  const usedMeshes = new Set(json.nodes.filter((n) => n.mesh != null).map((n) => n.mesh));
  const meshes = reindex(json.meshes || [], usedMeshes);
  json.meshes = meshes.out;
  for (const n of json.nodes) n.mesh != null && (n.mesh = meshes.map.get(n.mesh));
  // materials
  const usedMats = new Set();
  for (const m of json.meshes) for (const p of m.primitives) p.material != null && usedMats.add(p.material);
  const mats = reindex(json.materials || [], usedMats);
  json.materials = mats.out;
  for (const m of json.meshes) for (const p of m.primitives) p.material != null && (p.material = mats.map.get(p.material));
  // accessors
  const usedAcc = new Set();
  for (const m of json.meshes)
    for (const p of m.primitives) {
      Object.values(p.attributes).forEach((a) => usedAcc.add(a));
      p.indices != null && usedAcc.add(p.indices);
    }
  for (const a of json.animations || []) for (const s of a.samplers) (usedAcc.add(s.input), usedAcc.add(s.output));
  const acc = reindex(json.accessors || [], usedAcc);
  json.accessors = acc.out;
  for (const m of json.meshes)
    for (const p of m.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = acc.map.get(p.attributes[k]);
      p.indices != null && (p.indices = acc.map.get(p.indices));
    }
  for (const a of json.animations || []) for (const s of a.samplers) ((s.input = acc.map.get(s.input)), (s.output = acc.map.get(s.output)));
  // buffer views, repacked into a fresh binary chunk
  const usedBV = new Set(json.accessors.map((a) => a.bufferView).filter((v) => v != null));
  const parts = [];
  let size = 0;
  const bvMap = new Map();
  const views = [];
  (json.bufferViews || []).forEach((bv, i) => {
    if (!usedBV.has(i)) return;
    const data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const align = (4 - (size % 4)) % 4;
    align && (parts.push(Buffer.alloc(align)), (size += align));
    bvMap.set(i, views.length);
    views.push({ ...bv, buffer: 0, byteOffset: size });
    parts.push(data);
    size += data.length;
  });
  json.bufferViews = views;
  for (const a of json.accessors) a.bufferView != null && (a.bufferView = bvMap.get(a.bufferView));
  return { json, bin: Buffer.concat(parts) };
}

// Builds a GLB from plain data: boxes as meshes, a node tree and node (TRS) animations.
//   parts: [{ name, parent?, t?, box?: [[x0,y0,z0],[x1,y1,z1]], material? }]
//   materials: { key: { color: [r,g,b] (linear), roughness?, metalness?, emissive? } }
//   clips: [{ name, tracks: [{ node, path: "rotation" | "translation", times, values }] }]
export function buildRigidGLB({ rootName, parts, materials, clips, generator }) {
  const chunks = [];
  let size = 0;
  const json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ name: rootName, nodes: [0] }],
    nodes: [{ name: rootName, children: [] }],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
  };
  const view = (buf, target, stride) => {
    const align = (4 - (size % 4)) % 4;
    align && (chunks.push(Buffer.alloc(align)), (size += align));
    const bv = { buffer: 0, byteOffset: size, byteLength: buf.length };
    target && (bv.target = target);
    stride && (bv.byteStride = stride);
    json.bufferViews.push(bv);
    chunks.push(buf);
    size += buf.length;
    return json.bufferViews.length - 1;
  };
  const floats = (arr, type, target, withBounds) => {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const buf = Buffer.from(new Float32Array(arr).buffer);
    const acc = { bufferView: view(buf, target, target ? n * 4 : 0), componentType: 5126, count: arr.length / n, type };
    if (withBounds) {
      acc.min = [];
      acc.max = [];
      for (let k = 0; k < n; k++) {
        let lo = Infinity,
          hi = -Infinity;
        for (let i = k; i < arr.length; i += n) ((lo = Math.min(lo, arr[i])), (hi = Math.max(hi, arr[i])));
        acc.min.push(Math.fround(lo));
        acc.max.push(Math.fround(hi));
      }
    }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };
  const matIndex = new Map();
  for (const [key, m] of Object.entries(materials)) {
    const mat = {
      name: key,
      pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metalness ?? 0, roughnessFactor: m.roughness ?? 0.82 },
    };
    m.emissive && (mat.emissiveFactor = m.emissive);
    matIndex.set(key, json.materials.length);
    json.materials.push(mat);
  }
  let boxIdx = null;
  const boxMesh = ([a, b], material) => {
    const [x0, y0, z0] = a,
      [x1, y1, z1] = b;
    const P = [],
      N = [],
      U = [],
      I = [];
    const face = (n, corners) => {
      const base = P.length / 3;
      for (const c of corners) P.push(...c);
      for (let i = 0; i < 4; i++) N.push(...n);
      U.push(0, 1, 1, 1, 1, 0, 0, 0);
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    face([1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]);
    face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
    face([0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
    face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
    face([0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]);
    if (boxIdx == null) {
      const ib = Buffer.from(new Uint16Array(I).buffer);
      json.accessors.push({ bufferView: view(ib, 34963), componentType: 5123, count: I.length, type: "SCALAR", min: [0], max: [23] });
      boxIdx = json.accessors.length - 1;
    }
    json.meshes.push({
      primitives: [
        {
          mode: 4,
          attributes: { POSITION: floats(P, "VEC3", 34962, !0), NORMAL: floats(N, "VEC3", 34962), TEXCOORD_0: floats(U, "VEC2", 34962) },
          indices: boxIdx,
          material: matIndex.get(material),
        },
      ],
    });
    return json.meshes.length - 1;
  };
  const byName = new Map([[rootName, 0]]);
  for (const p of parts) {
    if (byName.has(p.name)) throw new Error(`duplicate node ${p.name}`);
    if (p.box && !matIndex.has(p.material)) throw new Error(`unknown material ${p.material} on ${p.name}`);
    const node = { name: p.name };
    p.t && p.t.some((v) => v !== 0) && (node.translation = p.t);
    p.r && (node.rotation = p.r);
    p.box && (node.mesh = boxMesh(p.box, p.material));
    const parent = byName.get(p.parent || rootName);
    if (parent == null) throw new Error(`unknown parent ${p.parent} for ${p.name}`);
    json.nodes.push(node);
    byName.set(p.name, json.nodes.length - 1);
    (json.nodes[parent].children ||= []).push(json.nodes.length - 1);
  }
  json.animations = clips.map((c) => {
    const samplers = [],
      channels = [];
    for (const tr of c.tracks) {
      const node = byName.get(tr.node);
      if (node == null) throw new Error(`clip ${c.name}: unknown node ${tr.node}`);
      samplers.push({ input: floats(tr.times, "SCALAR", 0, !0), output: floats(tr.values, tr.path === "rotation" ? "VEC4" : "VEC3"), interpolation: "LINEAR" });
      channels.push({ sampler: samplers.length - 1, target: { node, path: tr.path } });
    }
    return { name: c.name, samplers, channels };
  });
  return { json, bin: Buffer.concat(chunks) };
}

// glTF colour factors are linear; designs are written in sRGB hex
export function srgb(hex) {
  return [16, 8, 0].map((s) => {
    const c = ((hex >> s) & 255) / 255;
    return +(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)).toFixed(5);
  });
}
