// Removes named nodes (and their subtrees, animation channels and now-unused meshes,
// materials, accessors) from a .glb:
//   node scripts/strip-glb-nodes.mjs <in.glb> <out.glb> [--rename old=new ...] <nodeName> [nodeName ...]
// Used once to derive public/avatars/violet-girl/model.glb from the former lantern-girl
// model with its "lantern" subtree removed:
//   node scripts/strip-glb-nodes.mjs lantern-girl/model.glb violet-girl/model.glb --rename LanternGirl=VioletGirl lantern
import { readFileSync, writeFileSync } from "node:fs";
import { readGLB, writeGLB, removeNodes } from "./lib/glb.mjs";

const [input, output, ...rest] = process.argv.slice(2);
const renames = [],
  names = [];
for (let i = 0; i < rest.length; i++)
  rest[i] === "--rename" ? renames.push(rest[++i].split("=")) : names.push(rest[i]);
if (!input || !output || !names.length) {
  console.error("usage: node scripts/strip-glb-nodes.mjs <in.glb> <out.glb> <nodeName> [nodeName ...]");
  process.exit(2);
}
const gltf = readGLB(readFileSync(input));
const before = gltf.json.nodes.length;
const out = removeNodes(gltf, names);
for (const [from, to] of renames) for (const n of out.json.nodes) n.name === from && (n.name = to);
writeFileSync(output, writeGLB(out));
console.log(`${input} → ${output}: ${before} → ${out.json.nodes.length} nodes, ${out.json.meshes.length} meshes, ${out.json.materials.length} materials`);
