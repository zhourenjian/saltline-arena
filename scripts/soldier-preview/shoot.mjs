// Renders pose sheets of the soldier avatars into tests/out/soldier/ (headless Chrome).
//   node scripts/soldier-preview/shoot.mjs [sheet ...]     (sheet names: look poses hands head mantle ladder reload inspect)
import { launch } from '../../tests/lib/browser.mjs';
import { serve } from '../../tests/lib/serve.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'tests/out/soldier'); mkdirSync(out, { recursive: true });
const srv = await serve([['/', root]]);
const chrome = await launch({ width: 1280, height: 720 });
const page = await chrome.open(srv.url + '/scripts/soldier-preview/index.html', { wait: 'window.READY === true', window: true });
const only = process.argv.slice(2).filter((a) => !a.includes('-'));
const idArg = process.argv.slice(2).filter((a) => a.includes('-'));
const ids = idArg.length ? idArg : ['swat-operator', 'masked-raider'];
const want = (n) => !only.length || only.includes(n);
// a sheet = cells {az, el, dist, target, setup (js), after (js), label} laid out in a grid
async function sheet(name, id, cells, cols) {
  const r = await page.ev(`return JSON.stringify(await P.make(${JSON.stringify(id)}))`); console.log(name, r);
  const rows = Math.ceil(cells.length / cols), cw = Math.floor(1280 / cols), ch = Math.floor(720 / rows);
  await page.ev(`P.renderer.setSize(${cw},${ch}); P.cam.aspect=${cw}/${ch}; P.cam.updateProjectionMatrix();`);
  const parts = [];
  for (const c of cells) {
    await page.ev(`P.arm(true); P.oneHand=false; P.gun.object3D.visible=true; P.act=[0,0,false]; P.holder.position.set(0,0,0); P.ledge.visible=false; P.ladder.visible=false; P.step({}, 60); ${c.setup || ''}; P.view(${c.az ?? 0.6}, ${c.el ?? 0.1}, ${c.dist ?? 4}, ${typeof c.target === 'string' ? 'P.anchorPos(' + JSON.stringify(c.target) + ')' : JSON.stringify(c.target || [0, 1.0, 0])}); ${c.after || ''}`);
    parts.push(await page.ev(`return P.renderer.domElement.toDataURL('image/jpeg',0.92)`));
  }
  await page.ev(`window.__parts=${JSON.stringify(parts)};
    const cv=document.createElement('canvas'); cv.width=1280; cv.height=720; const g=cv.getContext('2d'); g.fillStyle='#111'; g.fillRect(0,0,1280,720);
    await Promise.all(window.__parts.map((u,i)=>new Promise(res=>{const im=new Image(); im.onload=()=>{g.drawImage(im,(i%${cols})*${cw},Math.floor(i/${cols})*${ch}); g.fillStyle='#fff'; g.font='14px sans-serif'; g.fillText(${JSON.stringify(cells.map((c) => c.label || ''))}[i],(i%${cols})*${cw}+8,Math.floor(i/${cols})*${ch}+18); res();}; im.src=u;})));
    P.renderer.domElement.style.display='none'; document.body.appendChild(cv); window.__cv=cv;`);
  writeFileSync(join(out, name + '-' + id + '.jpg'), await page.screenshot(90)); console.log('saved', name + '-' + id);
  await page.ev(`window.__cv.remove(); P.renderer.domElement.style.display='block'`);
}
const run = (loc, n) => `P.step(${JSON.stringify(loc)}, ${n})`;
const walk = { speed: 3.8, velocity: { x: 0, y: 0, z: -3.8 } }, sprint = { speed: 6.4, velocity: { x: 0, y: 0, z: -6.4 }, sprinting: true };
for (const id of ids) {
  if (want('look')) await sheet('look', id, [
    { label: 'front', az: 0, dist: 3.4 }, { label: '3/4', az: 0.7, dist: 3.4 }, { label: 'side (right)', az: -Math.PI / 2, dist: 3.4 },
    { label: 'back', az: Math.PI, dist: 3.4 }, { label: 'unarmed front', az: 0.3, dist: 3.4, setup: 'P.arm(false);' + run({}, 60) }, { label: 'unarmed back 3/4', az: 2.5, dist: 3.4, setup: 'P.arm(false);' + run({}, 60) },
  ].map((c) => ({ target: [0, 0.95, 0], ...c })), 3);
  if (want('head')) await sheet('head', id, [
    { label: 'front', az: 0 }, { label: '3/4', az: 0.7 }, { label: 'side', az: Math.PI / 2 }, { label: 'back 3/4', az: 2.4 }, { label: 'above', az: 0.5, el: 0.7 }, { label: 'below', az: -0.5, el: -0.4 },
  ].map((c) => ({ dist: 0.95, target: 'head', setup: 'P.arm(false);' + run({}, 60), ...c })), 3);
  if (want('hands')) await sheet('hands', id, [
    { label: 'R grip from right', az: -Math.PI / 2 + 0.2, el: 0.05, target: 'rightHand' }, { label: 'R grip from left-front', az: 0.9, el: 0.1, target: 'rightHand' }, { label: 'R grip from below', az: -0.6, el: -0.8, target: 'rightHand' },
    { label: 'L support from left', az: Math.PI / 2, el: 0, target: 'leftHand' }, { label: 'L support from below-front', az: 0.5, el: -0.7, target: 'leftHand' }, { label: 'L support from right', az: -Math.PI / 2, el: 0.1, target: 'leftHand' },
    { label: 'both, front 3/4', az: 0.8, el: 0.15, dist: 1.5, target: [0, 1.4, 0.3] }, { label: 'both, right side', az: -Math.PI / 2, el: 0.05, dist: 1.6, target: [0, 1.4, 0.3] }, { label: 'relaxed hand', az: 1.2, el: 0, target: 'leftHand', setup: 'P.arm(false);' + run({}, 60) },
  ].map((c) => ({ dist: 0.6, ...c })), 3);
  if (only.includes('rhand')) await sheet('rhand', id, [
    { label: 'from right', az: -Math.PI / 2, el: 0 }, { label: 'from front-left', az: 0.8, el: 0.1 }, { label: 'from below', az: -0.4, el: -1.0 }, { label: 'from behind-right', az: -2.4, el: 0.2 },
    { label: 'no gun, from left', az: Math.PI / 2, el: 0, after: '' , setup: 'P.oneHand=true; P.gun.object3D.visible=false;' + run({}, 40) }, { label: 'no gun, from front', az: 0.3, el: 0.2, setup: 'P.oneHand=true; P.gun.object3D.visible=false;' + run({}, 40) },
  ].map((c) => ({ dist: 0.45, target: 'rightHand', setup: 'P.oneHand=true;' + run({}, 40), ...c })), 3);
  if (only.includes('lhand')) await sheet('lhand', id, [
    { label: 'from left', az: Math.PI / 2, el: 0 }, { label: 'from front', az: 0.2, el: 0.1 }, { label: 'from below', az: 0.6, el: -1.1 }, { label: 'from right', az: -Math.PI / 2, el: 0.1 },
    { label: 'no gun, from right', az: -Math.PI / 2, el: 0.2, setup: 'P.gun.object3D.visible=false;' }, { label: 'no gun, from above-front', az: 0.3, el: 0.9, setup: 'P.gun.object3D.visible=false;' },
  ].map((c) => ({ dist: 0.45, target: 'leftHand', ...c })), 3);
  if (only.includes('hold')) await sheet('hold', id, [
    { label: 'right side', az: -Math.PI / 2, el: 0.05 }, { label: 'right front (user view)', az: -0.75, el: 0.25, dist: 1.2 }, { label: 'front', az: 0, el: 0.1 },
    { label: 'left side', az: Math.PI / 2, el: 0.05 }, { label: 'right hand from front-right', az: -0.6, el: 0.1, dist: 0.5, target: 'rightHand' }, { label: 'behind right', az: -2.5, el: 0.3 },
    { label: 'left hand close', az: 1.3, el: -0.1, dist: 0.55, target: 'leftHand' }, { label: 'right hand close', az: -1.3, el: 0, dist: 0.5, target: 'rightHand' },
  ].map((c) => ({ dist: 1.7, target: [0, 1.38, 0.15], ...c })), 4);
  if (only.includes('unarmed')) await sheet('unarmed', id, [
    { label: 'front', az: 0 }, { label: '3/4', az: 0.7 }, { label: 'side', az: Math.PI / 2 }, { label: 'back', az: Math.PI },
  ].map((c) => ({ dist: 2.2, el: 0.05, target: [0, 1.4, 0], setup: 'P.arm(false);' + run({}, 60), ...c })), 4);
  if (want('poses')) await sheet('poses', id, [
    { label: 'walk', setup: run(walk, 47), az: -1.2 }, { label: 'walk +', setup: run(walk, 58), az: -1.2 }, { label: 'sprint', setup: run(sprint, 50), az: -1.2 }, { label: 'sprint +', setup: run(sprint, 57), az: 0.9 },
    { label: 'crouch', setup: run({ stance: 'crouching' }, 60), az: -1.0 }, { label: 'crouch front', setup: run({ stance: 'crouching' }, 60), az: 0.4 }, { label: 'aim up', setup: run({ aimPitch: 0.8 }, 60), az: -1.3 }, { label: 'aim down', setup: run({ aimPitch: -0.8 }, 60), az: -1.3 },
    { label: 'jump', setup: run({ grounded: false, phase: 'airborne', velocity: { x: 0, y: 4, z: -3 }, speed: 3 }, 12), az: -1.3 }, { label: 'fall', setup: run({ grounded: false, phase: 'airborne', velocity: { x: 0, y: -6, z: -3 }, speed: 3 }, 20), az: -1.3 },
    { label: 'unarmed walk', setup: 'P.arm(false);' + run(walk, 50), az: -1.2 }, { label: 'strafe left', setup: run({ speed: 3.8, velocity: { x: -3.8, y: 0, z: 0 } }, 50), az: 0.3 },
  ].map((c) => ({ target: [0, 0.95, 0], dist: 4.4, ...c })), 4);
  if (want('mantle')) await sheet('mantle', id, [[1.4, 0.4, 0.05], [1.2, 0.4, 0.2], [0.9, 0.4, 0.35], [0.6, 0.35, 0.45], [0.3, 0.3, 0.55], [0.05, 0.15, 0.62], [-0.01, 0.05, 0.8], [1.9, 0.4, 0.05]].map(([h, d, p]) => ({
    label: 'mantle h=' + h, az: -1.25, dist: 5, target: [0, 1.1 + (1.4 - h), 0.3],
    setup: `P.arm('stow'); P.ledge.visible=true; P.holder.position.set(0,${1.4 - h},0); P.ledge.position.set(0, 1.4-0.5, ${d}+0.3+0.6); P.step({mode:'duoworld:climb',grounded:false,velocity:{x:0,y:2,z:0},speed:2,climb:{kind:'mantle',progress:${p},ledgeHeight:${h},ledgeDistance:${d},climbSpeed:2}},45)`,
  })), 4);
  if (want('ladder')) await sheet('ladder', id, [8, 16, 24, 32, 40, 48, 56, 64].map((c, i) => ({
    label: 'ladder f' + c, az: i < 4 ? -1.3 : 2.6, dist: 5, target: [0, 1.2 + (c / 60) * 1.5, 0.2],
    setup: `P.arm('stow'); P.ladder.visible=true; P.ladder.position.set(0,0,0.4); P.step({mode:'duoworld:climb',grounded:false,velocity:{x:0,y:1.5,z:0},speed:1.5,climb:{kind:'ladder',progress:0,climbSpeed:0}},40); for(let i=0;i<${c};i++){ P.holder.position.y+=1.5/60; P.step({mode:'duoworld:climb',grounded:false,velocity:{x:0,y:1.5,z:0},speed:1.5,climb:{kind:'ladder',progress:0,climbSpeed:1.5}},1);}`,
  })), 4);
  const act = (a, t, e) => `P.act=[${a},${t},${e}]; P.step({},40)`;
  if (want('reload')) await sheet('reload', id, [0.2, 0.42, 0.7, 0.9, 1.2, 1.4, 2.05, 2.3].map((t, i) => ({ label: 'reload(empty) t=' + t, az: i % 2 ? 0.9 : -1.0, el: 0.1, dist: 2.0, target: [0, 1.3, 0.2], setup: act(1, t, true) })), 4);
  if (want('inspect')) await sheet('inspect', id, [0.3, 0.9, 1.7, 2.3, 2.6, 3.2].map((t, i) => ({ label: 'inspect t=' + t, az: i % 2 ? 0.9 : -0.6, el: 0.1, dist: 2.0, target: [0, 1.3, 0.2], setup: act(2, t, false) })), 3);
}
console.log(await page.ev(`return JSON.stringify(P.measure())`));
console.log(page.logs.slice(-20).join('\n'));
chrome.kill(); srv.close();
