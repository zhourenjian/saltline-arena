// ---- part 1: math, procedural textures and geometry builders ---------------------------------
// Shared by both tactical avatars; scripts/build-soldier-avatars.mjs concatenates the parts into
// each package's avatar.js. Everything is authored in the avatar's rest pose: +Y up, +Z forward,
// metres, the character's right side at -X.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => ((x = clamp((x - a) / (b - a), 0, 1)), x * x * (3 - 2 * x));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const TILE = 0.25; // metres covered by one repeat of the fabric textures

// deterministic value noise (no Math.random: the same avatar looks the same on every client)
function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function tnoise(x, y, period) {
  // tileable with the given integer period
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period);
  return lerp(lerp(w(xi, yi), w(xi + 1, yi), u), lerp(w(xi, yi + 1), w(xi + 1, yi + 1), u), v);
}
// smooth interpolation through a table of rows [key, v1, v2, ...] (Catmull-Rom on each column)
function sample(table, key) {
  const n = table.length;
  if (key <= table[0][0]) return table[0];
  if (key >= table[n - 1][0]) return table[n - 1];
  let i = 0;
  while (key > table[i + 1][0]) i++;
  const a = table[Math.max(0, i - 1)], b = table[i], c = table[i + 1], d = table[Math.min(n - 1, i + 2)];
  const t = (key - b[0]) / (c[0] - b[0]), out = [key];
  for (let k = 1; k < b.length; k++) {
    const m1 = ((c[k] - a[k]) / (c[0] - a[0])) * (c[0] - b[0]), m2 = ((d[k] - b[k]) / (d[0] - b[0])) * (c[0] - b[0]);
    const t2 = t * t, t3 = t2 * t;
    out.push((2 * t3 - 3 * t2 + 1) * b[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * c[k] + (t3 - t2) * m2);
  }
  return out;
}

function makeKit(THREE) {
  // ---- textures -------------------------------------------------------------------------------
  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function toTexture(canvas, srgb) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // height field -> tangent-space normal map
  function normalFromHeight(N, hgt, strength) {
    const c = canvasOf(N, N), g = c.getContext('2d'), img = g.createImageData(N, N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const l = hgt[y * N + ((x + N - 1) % N)], r = hgt[y * N + ((x + 1) % N)];
        const u = hgt[((y + N - 1) % N) * N + x], d = hgt[((y + 1) % N) * N + x];
        const nx = (l - r) * strength, ny = (d - u) * strength, il = 1 / Math.sqrt(nx * nx + ny * ny + 1), i = (y * N + x) * 4;
        img.data[i] = (nx * il * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * il * 0.5 + 0.5) * 255;
        img.data[i + 2] = (il * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    return toTexture(c, false);
  }
  // woven cloth: a fine twill (uniforms) or a coarse basket weave (webbing, pouches), plus soft
  // folds a few centimetres across. Returns { normal, albedo } tiles covering TILE metres.
  function fabricTextures(kind) {
    const N = 256, hgt = new Float32Array(N * N), alb = canvasOf(N, N), ag = alb.getContext('2d'), aimg = ag.createImageData(N, N);
    const thread = kind === 'web' ? 8 : 4, foldAmp = kind === 'web' ? 0.12 : 0.45;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let h;
        if (kind === 'web') {
          const cx = Math.floor(x / thread), cy = Math.floor(y / thread), over = (cx + cy) & 1;
          const fx = (x % thread) / thread - 0.5, fy = (y % thread) / thread - 0.5;
          h = over ? Math.cos(fx * Math.PI) * 0.8 + Math.cos(fy * Math.PI * 2) * 0.1 : Math.cos(fy * Math.PI) * 0.8 + Math.cos(fx * Math.PI * 2) * 0.1;
        } else if (kind === 'knit') {
          const col = (x % 8) / 8 - 0.5, row = ((y + (Math.floor(x / 8) & 1) * 3) % 6) / 6;
          h = Math.cos(col * Math.PI) * 0.7 + Math.sin(row * Math.PI) * 0.35;
        } else {
          const d = ((x + y) % thread) / thread, e = ((x - y + N) % (thread * 2)) / (thread * 2);
          h = Math.sin(d * Math.PI) * 0.55 + Math.sin(e * Math.PI) * 0.25;
        }
        const fold = tnoise(x / 42, y / 20, 6) * 0.6 + tnoise(x / 16 + 9, y / 34 + 4, 8) * 0.4;
        hgt[y * N + x] = h * 0.5 + Math.abs(fold - 0.5) * 2 * foldAmp * 3;
        const wear = 0.93 + 0.07 * tnoise(x / 30 + 3, y / 30 + 7, 8) + (h - 0.5) * 0.06 - Math.abs(fold - 0.5) * 0.05;
        const v = clamp(wear, 0, 1) * 255, i = (y * N + x) * 4;
        aimg.data[i] = aimg.data[i + 1] = aimg.data[i + 2] = v;
        aimg.data[i + 3] = 255;
      }
    ag.putImageData(aimg, 0, 0);
    return { normal: normalFromHeight(N, hgt, kind === 'web' ? 1.4 : 1.1), albedo: toTexture(alb, true) };
  }
  function labelTexture(text, fg, bg) {
    const c = canvasOf(256, 64), g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 256, 64);
    g.fillStyle = fg; g.font = '900 46px Arial, Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 35);
    const t = toTexture(c, true);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  // ---- parts: { p: [x,y,z,...], n: [...], uv: [...], i: [...] } ----------------------------------
  function computeNormals(part, rows, cols, wrap) {
    const p = part.p, n = new Float32Array(p.length), idx = part.i;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      for (const k of [a, b, c]) { n[k] += x; n[k + 1] += y; n[k + 2] += z; }
    }
    if (rows) {
      for (let r = 0; r < rows; r++) {
        const first = r * cols * 3, last = (r * cols + cols - 1) * 3;
        // a row collapsed to a point (a pole or a cap centre) shares one normal
        let same = true;
        for (let k = 1; k < cols && same; k++) { const q = (r * cols + k) * 3; same = Math.abs(p[q] - p[first]) + Math.abs(p[q + 1] - p[first + 1]) + Math.abs(p[q + 2] - p[first + 2]) < 1e-7; }
        if (same) {
          let x = 0, y = 0, z = 0;
          for (let k = 0; k < cols; k++) { const q = (r * cols + k) * 3; x += n[q]; y += n[q + 1]; z += n[q + 2]; }
          for (let k = 0; k < cols; k++) { const q = (r * cols + k) * 3; n[q] = x; n[q + 1] = y; n[q + 2] = z; }
        } else if (wrap)
          for (let k = 0; k < 3; k++) { const s = n[first + k] + n[last + k]; n[first + k] = n[last + k] = s; }
      }
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    part.n = Array.from(n);
    return part;
  }
  function flip(part) {
    for (let t = 0; t < part.i.length; t += 3) { const a = part.i[t + 1]; part.i[t + 1] = part.i[t + 2]; part.i[t + 2] = a; }
    for (let k = 0; k < part.n.length; k++) part.n[k] = -part.n[k];
    return part;
  }
  function volume(part) {
    const p = part.p, idx = part.i;
    let v = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v;
  }
  // a (rows x cols) grid of points, row by row; wrap closes each row (the last column repeats the
  // first). UVs are in fabric tiles (metres / TILE) so cloth has the same thread size everywhere.
  function gridPart(pts, rows, cols, wrap, o) {
    o = o || {};
    const p = [], uv = [], i = [];
    let per = 0;
    const rowLen = [];
    for (let r = 0; r < rows; r++) {
      let len = 0;
      for (let c = 1; c < cols; c++) { const a = pts[r * cols + c - 1], b = pts[r * cols + c]; len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
      rowLen.push(len); per = Math.max(per, len);
    }
    let uTiles = per / TILE;
    if (wrap) uTiles = Math.max(1, Math.round(uTiles));
    let v = 0;
    for (let r = 0; r < rows; r++) {
      if (r > 0) {
        let d = 0;
        for (let c = 0; c < cols; c += Math.max(1, cols >> 3)) { const a = pts[(r - 1) * cols + c], b = pts[r * cols + c]; d = Math.max(d, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
        v += d / TILE;
      }
      for (let c = 0; c < cols; c++) { const q = pts[r * cols + c]; p.push(q[0], q[1], q[2]); uv.push((c / (cols - 1)) * uTiles, v); }
    }
    for (let r = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) { const k = r * cols + c; i.push(k, k + 1, k + cols, k + 1, k + cols + 1, k + cols); }
    const part = computeNormals({ p, uv, i }, rows, cols, wrap);
    if (o.flip === true || (o.flip === undefined && volume(part) < 0)) flip(part);
    return part;
  }
  // parametric surface f(u, v) -> [x, y, z]
  function surface(nu, nv, f, wrap, o) {
    const pts = [];
    for (let b = 0; b <= nv; b++) for (let a = 0; a <= nu; a++) pts.push(f(wrap && a === nu ? 0 : a / nu, b / nv));
    return gridPart(pts, nv + 1, nu + 1, wrap, o);
  }
  // one cross-section: a superellipse around centre c in the plane spanned by U and V
  function ring(c, U, V, ru, rv, N, exp, mod) {
    const out = [], e = 2 / (exp || 2);
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      let x = Math.sign(cs) * Math.pow(Math.abs(cs), e) * ru, y = Math.sign(sn) * Math.pow(Math.abs(sn), e) * rv;
      if (mod) { const m = mod(a, x, y); x = m[0]; y = m[1]; }
      out.push([c[0] + U[0] * x + V[0] * y, c[1] + U[1] * x + V[1] * y, c[2] + U[2] * x + V[2] * y]);
    }
    return out;
  }
  const centroid = (r) => { const c = [0, 0, 0]; for (const q of r) { c[0] += q[0] / r.length; c[1] += q[1] / r.length; c[2] += q[2] / r.length; } return c; };
  // skin over a list of rings (same point count). capA / capB: 'soft' (smooth-shaded) or 'hard'.
  function loft(rings, o) {
    o = o || {};
    const N = rings[0].length, rows = [];
    const cap = (r, kind) => { const c = centroid(r), row = r.map(() => c); return kind === 'hard' ? [r, row] : [row]; };
    if (o.capA) { const c = cap(rings[0], o.capA); rows.push(...c.reverse()); }
    rows.push(...rings);
    if (o.capB) rows.push(...cap(rings[rings.length - 1], o.capB));
    const pts = [];
    for (const r of rows) { for (let k = 0; k < N; k++) pts.push(r[k]); pts.push(r[0]); }
    return gridPart(pts, rows.length, N + 1, true, o);
  }
  // a tube along a path. radii: number or per-point; o.side: reference side vector; o.flat: the
  // cross-section's second radius as a ratio of the first; o.round: hemispherical ends
  function tube(path, radii, N, o) {
    o = o || {};
    const side = o.side || [1, 0, 0], rings = [], n = path.length, R = (k) => (typeof radii === 'number' ? radii : radii[k]);
    const frame = (k) => {
      const a = path[Math.max(0, k - 1)], b = path[Math.min(n - 1, k + 1)];
      let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const tl = Math.hypot(t[0], t[1], t[2]) || 1; t = [t[0] / tl, t[1] / tl, t[2] / tl];
      const d = side[0] * t[0] + side[1] * t[1] + side[2] * t[2];
      let u = [side[0] - t[0] * d, side[1] - t[1] * d, side[2] - t[2] * d];
      const ul = Math.hypot(u[0], u[1], u[2]) || 1; u = [u[0] / ul, u[1] / ul, u[2] / ul];
      return { t, u, v: [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]] };
    };
    const flat = o.flat || 1;
    const endCap = (k, dir) => {
      const f = frame(k), r = R(k), out = [];
      for (const ang of [1.35, 0.9, 0.45]) {
        const off = Math.sin(ang) * r * flat * dir, rr = Math.cos(ang);
        out.push(ring([path[k][0] + f.t[0] * off, path[k][1] + f.t[1] * off, path[k][2] + f.t[2] * off], f.u, f.v, r * rr, r * flat * rr, N, o.exp));
      }
      return dir < 0 ? out : out.reverse();
    };
    if (o.round) rings.push(...endCap(0, -1));
    for (let k = 0; k < n; k++) { const f = frame(k); rings.push(ring(path[k], f.u, f.v, R(k), R(k) * flat, N, o.exp)); }
    if (o.round) rings.push(...endCap(n - 1, 1));
    return loft(rings, { capA: o.capA || 'soft', capB: o.capB || 'soft' });
  }
  function ellipsoid(rx, ry, rz, nu, nv) {
    return surface(nu || 16, nv || 10, (u, v) => { const a = u * Math.PI * 2, b = v * Math.PI; return [rx * Math.sin(b) * Math.cos(a), -ry * Math.cos(b), rz * Math.sin(b) * Math.sin(a)]; }, true);
  }
  // box with rounded edges (radius r), analytic normals, planar UVs per face
  function rbox(w, h, d, r, div) {
    const half = [w / 2, h / 2, d / 2];
    r = Math.min(r, half[0], half[1], half[2]);
    const coords = (hf) => {
      const out = r > 0 ? [-hf, -hf + r * 0.42, -hf + r] : [-hf];
      const inner = hf - r, m = div || 1;
      for (let k = 1; k < m; k++) out.push(-inner + (2 * inner * k) / m);
      if (r > 0) out.push(hf - r, hf - r * 0.42);
      out.push(hf);
      return out.filter((x, k, a) => k === 0 || x - a[k - 1] > 1e-6);
    };
    const part = { p: [], n: [], uv: [], i: [] };
    for (let ax = 0; ax < 3; ax++)
      for (const sg of [-1, 1]) {
        const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3, c1 = coords(half[a1]), c2 = coords(half[a2]), base = part.p.length / 3;
        for (const y of c2)
          for (const x of c1) {
            const q = [0, 0, 0];
            q[ax] = sg * half[ax]; q[a1] = x; q[a2] = y;
            const inn = q.map((v, k) => clamp(v, -(half[k] - r), half[k] - r));
            let nx = q[0] - inn[0], ny = q[1] - inn[1], nz = q[2] - inn[2];
            const l = Math.hypot(nx, ny, nz);
            if (l < 1e-9) { nx = ax === 0 ? sg : 0; ny = ax === 1 ? sg : 0; nz = ax === 2 ? sg : 0; } else { nx /= l; ny /= l; nz /= l; }
            part.p.push(inn[0] + nx * r, inn[1] + ny * r, inn[2] + nz * r);
            part.n.push(nx, ny, nz);
            part.uv.push(x / TILE, y / TILE);
          }
        for (let y = 0; y < c2.length - 1; y++)
          for (let x = 0; x < c1.length - 1; x++) {
            const k = base + y * c1.length + x, quad = sg > 0 ? [k, k + 1, k + c1.length, k + 1, k + c1.length + 1, k + c1.length] : [k, k + c1.length, k + 1, k + 1, k + c1.length, k + c1.length + 1];
            part.i.push(...quad);
          }
      }
    return part;
  }
  // a flat quad (two triangles) with 0..1 UVs, facing +Z, for label patches
  function quad(w, h) {
    return { p: [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 1, 1, 0, 1], i: [0, 1, 2, 0, 2, 3] };
  }

  // ---- transforms -------------------------------------------------------------------------------
  const m4 = new THREE.Matrix4(), m3 = new THREE.Matrix3(), v3 = new THREE.Vector3(), eu = new THREE.Euler(), qt = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  function apply(part, m) {
    m3.getNormalMatrix(m);
    const mirrored = m.determinant() < 0;
    for (let k = 0; k < part.p.length; k += 3) {
      v3.set(part.p[k], part.p[k + 1], part.p[k + 2]).applyMatrix4(m); part.p[k] = v3.x; part.p[k + 1] = v3.y; part.p[k + 2] = v3.z;
      v3.set(part.n[k], part.n[k + 1], part.n[k + 2]).applyMatrix3(m3).normalize(); part.n[k] = v3.x; part.n[k + 1] = v3.y; part.n[k + 2] = v3.z;
    }
    if (mirrored) for (let t = 0; t < part.i.length; t += 3) { const a = part.i[t + 1]; part.i[t + 1] = part.i[t + 2]; part.i[t + 2] = a; }
    return part;
  }
  // place a part: rotate (Euler XYZ, radians), scale, then move
  function put(part, pos, rot, scl) {
    m4.compose(v3.set(pos[0], pos[1], pos[2]), qt.setFromEuler(eu.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0, 'YXZ')), scl ? new THREE.Vector3(scl[0], scl[1], scl[2]) : one);
    return apply(part, m4.clone());
  }
  const mirror = (part) => apply(part, new THREE.Matrix4().makeScale(-1, 1, 1));
  const copy = (part) => ({ p: part.p.slice(), n: part.n.slice(), uv: part.uv.slice(), i: part.i.slice() });
  // move every vertex through fn([x,y,z]) -> [x,y,z]; normals follow by finite differences
  function warp(part, fn) {
    const e = 1e-4, a = new THREE.Vector3(), b = new THREE.Vector3(), nn = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
    for (let k = 0; k < part.p.length; k += 3) {
      const p = [part.p[k], part.p[k + 1], part.p[k + 2]];
      nn.set(part.n[k], part.n[k + 1], part.n[k + 2]);
      t1.set(Math.abs(nn.x) < 0.9 ? 1 : 0, Math.abs(nn.x) < 0.9 ? 0 : 1, 0).cross(nn).normalize();
      t2.crossVectors(nn, t1);
      const q = fn(p), q1 = fn([p[0] + t1.x * e, p[1] + t1.y * e, p[2] + t1.z * e]), q2 = fn([p[0] + t2.x * e, p[1] + t2.y * e, p[2] + t2.z * e]);
      a.set(q1[0] - q[0], q1[1] - q[1], q1[2] - q[2]); b.set(q2[0] - q[0], q2[1] - q[1], q2[2] - q[2]);
      nn.crossVectors(a, b).normalize();
      part.p[k] = q[0]; part.p[k + 1] = q[1]; part.p[k + 2] = q[2];
      part.n[k] = nn.x; part.n[k + 1] = nn.y; part.n[k + 2] = nn.z;
    }
    return part;
  }

  // ---- builder: collects skinned parts per material ---------------------------------------------
  function createBuilder(boneIndex) {
    const groups = {}, col = new THREE.Color();
    function add(mat, part, weight, color) {
      const g = groups[mat] || (groups[mat] = { p: [], n: [], uv: [], c: [], si: [], sw: [], i: [] });
      const base = g.p.length / 3, count = part.p.length / 3;
      for (let k = 0; k < count; k++) {
        const x = part.p[k * 3], y = part.p[k * 3 + 1], z = part.p[k * 3 + 2];
        g.p.push(x, y, z); g.n.push(part.n[k * 3], part.n[k * 3 + 1], part.n[k * 3 + 2]); g.uv.push(part.uv[k * 2], part.uv[k * 2 + 1]);
        col.set(typeof color === 'function' ? color(x, y, z) : color);
        g.c.push(col.r, col.g, col.b);
        let w = typeof weight === 'function' ? weight(x, y, z) : weight;
        if (typeof w === 'string') w = [[w, 1]];
        w = w.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
        const sum = w.reduce((s, e) => s + e[1], 0) || 1;
        for (let j = 0; j < 4; j++) {
          if (w[j] && boneIndex[w[j][0]] === undefined) throw new Error('unknown bone ' + w[j][0]);
          g.si.push(w[j] ? boneIndex[w[j][0]] : 0); g.sw.push(w[j] ? w[j][1] / sum : 0);
        }
      }
      for (const k of part.i) g.i.push(base + k);
      return part;
    }
    function build() {
      const out = {};
      for (const name in groups) {
        const g = groups[name], geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(g.c, 3));
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(g.si, 4));
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(g.sw, 4));
        geo.setIndex(g.i);
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
        geo.boundingBox = new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.6), new THREE.Vector3(0.6, 1.85, 0.6));
        out[name] = geo;
      }
      return out;
    }
    return { add, build };
  }

  return { fabricTextures, labelTexture, surface, ring, loft, tube, ellipsoid, rbox, quad, put, mirror, copy, warp, flip, createBuilder };
}
