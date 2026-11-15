# 开发定位

当前代码由 66 个 ES 模块组成；`src/game.js` 只负责导入一次性初始化，再调用 `startGame()`。引擎版本、渲染参数、着色器、关卡、物理、输入和玩法保持原版行为。

## 从哪里开始修改

| 文件/目录 | 职责与主要接口 |
| --- | --- |
| `app/runtime.js` | `startGame`：创建 context、依次初始化系统、驱动主循环 |
| `app/boot-screen.js`、`diagnostics.js` | 加载进度、错误捕获、致命错误显示 |
| `core/config.js` | `WORLD_BOUNDS`、`SUN_LIGHT`、`SKY_COLORS`、`PLAYER_DIMENSIONS`、`QUALITY_PRESETS` |
| `core/events.js`、`random.js`、`math.js` | `createEventBus`、`createRandom`、`clamp`、`lerp`、`smoothstep`、`damp` |
| `core/geometry.js` | 共享几何、倒角、变换、颜色、静态合批 |
| `render/renderer.js` | `createRenderer`：场景、镜头、光照、resize、渲染通道 |
| `render/sky.js`、`shadows.js`、`postprocessing.js` | 天空着色器、软阴影和后处理 |
| `render/materials/` | `materials.js` 创建材质；`catalog.js` 定义材质数据；`surface-shaders.js` 和 `textures.js` 生成表面/纹理 |
| `world/physics.js` | `createPhysics`：碰撞、射线和导航 |
| `world/props/` | 道具尺寸和注册表、共享几何、基本/精细/角色/货物建模、`createProps` |
| `world/level/` | `createLevel`，以及建筑和物件放置辅助逻辑 |
| `world/backdrop/` | `createBackdrop`；远景几何、吊机、船舶、天空 |
| `world/ground/` | `createGround`；地面、沥青、积水和水面 |
| `input/input.js` | `createInput`、`KEY_BINDINGS`：键鼠、触屏、手柄 |
| `player/player.js` | `createPlayer`、`PLAYER_MOVEMENT`：移动、跳跃、镜头、生命和后坐力 |
| `combat/combat.js` | `createCombat`：射线命中、伤害和击杀统计 |
| `weapons/` | `weapon.js` 管理状态/射击/装填；`geometry.js` 建模；`rig.js` 装配与动画 |
| `enemies/` | `enemies.js` 管理生成/回收与 `ENEMY_TUNING`；`models.js` 建模；`walker.js`、`drone.js` 行为 |
| `effects/` | `effects.js` 创建/更新特效；`particles.js` 纹理/粒子；`pools.js` 复用池 |
| `audio/` | `synthesis.js` 合成器；`music.js` 音乐；`library.js` 音库；`audio.js` 调度/混音 |
| `ui/hud.js`、`ui/menus.js`、`ui.css` | HUD、字幕、菜单、设置、控件和布局 |
| `game/flow.js` | `createGameFlow`、`GAME_FLOW`：三中继任务、波次、撤离、暂停、死亡和结算；`mode`、`startVersus` / `respawn` / `endVersus` / `toTitle` |
| `lobby/characters.js` | 角色选择页和预览 |
| `versus/` | 1v1 对战客户端：`rules.js` 规则和出生点（与服务器共用）、`net.js`、`opponent.js`、`versus-hud.js`、`versus.js` |
| `brawl/` | 大乱斗客户端：`rules.js` 规则（与服务器共用）、`brawl.js` 流程、`brawl-hud.js`、`spectator.js` 观战镜头、`voice.js` 语音 |
| `ui/net-stats.js` | 右上角 FPS / PING 读数（`context.netStats`） |
| `../server/` | `npm run server` 对战服务器（`hub.mjs` 1v1 房间，`brawl.mjs` 大乱斗场地、排队、聊天和语音） |

常见改动可直接从这些地方入手：移动速度在 `PLAYER_MOVEMENT`，画质在 `QUALITY_PRESETS`，任务节奏在 `GAME_FLOW`，键位在 `KEY_BINDINGS`，攀爬高度在 `PLAYER_MOVEMENT.climb*`，对战规则（击杀数、伤害、重生时间）在 `DUEL_RULES`，大乱斗人数、淘汰周期、聊天和抢麦限制在 `BRAWL_RULES`（服务器也可用 `BRAWL_*` 环境变量覆盖），梯子和楼梯塔在 `world/backdrop/cranes.js`，敌人参数在对应敌人模块中。

## 依赖和运行上下文

```text
game.js
  ├─ world/props/register.js  → 按原顺序安装道具 builder
  ├─ app/diagnostics.js       → 安装错误捕获
  └─ app/runtime.js           → startGame → context → 各系统 → 主循环

vendor/three-r180.js ← core ← 各系统
```

模块依赖没有循环。系统工厂使用显式导入的函数/常量，并通过 `context` 访问正在运行的其他系统；`window.__G` 保留为诊断入口。新增逻辑应通过 context 或 `context.events` 协作，避免再增加浏览器全局变量。

初始化顺序在 `app/runtime.js` 中集中管理，仍按原版的 render、materials、physics/props/input、level、backdrop、ground、effects、audio、player/combat、weapon、enemies、HUD、game flow 顺序执行。模型构造、随机数调用和主循环更新顺序也沿用原版。

道具注册有覆盖关系：基础 builder → 精细 builder → 角色 builder → 货物 builder。`world/props/register.js` 集中保留这一顺序；其余 builder 文件只导出实现。新增道具时更新 `registry.js` 中的 `PROP_SIZES`，并在 `register.js` 显式导入并注册对应 builder。

引擎是已校验的本地 r180，实现位于 `vendor/three-r180.js`，可使用标准名称导入：

```js
import { Vector3, Mesh, Group } from "../vendor/three-r180.js";
```

该示例路径适用于 `src/` 的下一层目录。无需再安装另一份 `three`；继续使用本地导出可以避免版本和实例混用。

复杂程序化建模、着色器和声音合成内部仍保留部分原版短变量名，主要工厂和引擎类型已语义命名。改动一个功能时通常只需编辑对应系统文件。

## 原版诊断接口

这些接口本来就在游戏里，适合在浏览器开发者工具中检查：

```js
window.__ready;    // 至少完成两帧渲染
window.__fatal;    // 启动错误
window.__errors;   // 捕获的错误
window.__stats();  // 渲染统计、FPS、游戏状态
window.__G;        // 运行中的游戏上下文
```

`__G` 包含 `game`、`player`、`weapon`、`enemies`、`level`、`render`、`audio`、`physics`、`input`、`events` 等对象。不要将它们作为新的持久存储格式。

## 原版调试参数

| URL | 用途 |
| --- | --- |
| `/?q=low` | 低画质 |
| `/?q=high` | 高画质 |
| `/?seed=4207` | 固定程序化随机种子 |
| `/?autostart=1` | 跳过标题/入场，直接进入游戏 |
| `/?noaudio=1` | 禁用声音模块 |
| `/?bench=1` | 原版巡游基准和帧时间面板 |
| `/?shot=1&q=test&seed=4207&dt=0&noaudio=1&cam=-32,1.68,6,0,1.68,6` | 本次回归使用的固定时间、种子、镜头场景 |

首次启动的画质也会受到已保存设置影响；验收时应同时记录 URL 和设置。不同机器的 GPU 性能不能直接比较。

## 构建说明

Vite 将独立版的入口、ES 模块、CSS、字体和 `public/avatars/` 输出到 `dist/standalone/`；`npm run build:world` 用 `vite.world.config.js` 把 `src/duoworld/world-entry.js` 打成单文件 ES 模块，再由 `scripts/build-world-package.mjs` 写出 `dist/world-package/world.json` 并复制字体。源文件已经模块化，生产构建仍由 Vite 合并优化；完整引擎会使输出 chunk 超过默认提示大小，这不影响构建成功。

```sh
npm run check            # 检查所有模块的语法、导入/导出、循环依赖和归档完整性
npm run build            # 构建独立版和 World Package
npm test                 # 全部测试：hub、brawl、modes、ladder、brawl-e2e（headless Chrome）
npm run test:brawl       # 只跑大乱斗的单元测试和浏览器测试
npm run verify:refactor  # 可选：核对本次拆分与原始归档的代码等价性
```

`verify:refactor` 使用 `scripts/refactor-map.json` 将模块语句对应回原始归档，检查表达式、常量、着色器/模板、局部绑定及语句覆盖。只允许模块边界、作用域内改名和不改变逻辑的空 if 包裹块差异。它用于证明这次迁移，**后续有意修改游戏逻辑时预期会失败**，因此没有加入日常 `check`，也不需要为继续开发重写原始归档。

依赖版本锁定在 `package-lock.json`。完整恢复记录见 `archive/manifest.json`，字体下载来源及逐文件摘要见 `archive/font-manifest.json`。

## 警匪角色（swat-operator / masked-raider）

- 源码：`scripts/lib/soldier/{1-kit,2-body,3-anim}.js`，生成：`node scripts/build-soldier-avatars.mjs` → `public/avatars/<id>/avatar.js`。预览和截图：`scripts/soldier-preview/`。
- 玩家状态：`player.climb`（`player.js` 的 `startClimb` / `climbStep` / `attachLadder` / `ladderStep`）→ `AvatarHost` 的 locomotion tracker → `setLocomotion().climb`；网络经 `packLoco` / `sanitizeLoco`（`src/versus/rules.js`）。
- 枪：角色包不带枪。`src/weapons/held-gun.js` 用第一人称枪的几何和材质（`registerGunKit`）造一支枪，`attachHeldGun(context, instance)` 挂到包的 `weapon` 挂点，每帧 `apply(loco, act, stowed)` 写入 `loco.held`；`AvatarHost`（本地第三人称）和 `opponent.js`（对手、大乱斗、观战）共用。`opponent.muzzle()` 返回这支枪的枪口。换弹 / 检视：`weapon.heldAction()` → `packLoco(l, act)` → `loco.w` → `opponent` 的 `act`。
- 预览图：`node scripts/soldier-preview/shoot.mjs [look poses hands head mantle ladder reload inspect rhand lhand] [id]` → `tests/out/soldier/`。测试：`npm run test:soldier`。
- 第一人称手臂换色：`weapon.setArmColors`，数据来自包的 `metadata.firstPersonArms`。

## 手机和平板

- **全屏 / 主屏幕**：`index.html` 带 `apple-mobile-web-app-capable`、`black-translucent` 状态栏、`manifest.webmanifest`（`display: fullscreen`，相对路径）和 `public/icons/`（`node scripts/build-icons.mjs` 用无头 Chrome 重画）。`src/ui/install-guide.js`：触屏且不是主屏幕模式时，标题页出现“Add to Home Screen”链接，并在首次访问时自动弹出分平台的步骤（iOS：分享 ▸ 添加到主屏幕；Android：菜单 ▸ 安装应用，浏览器给出 `beforeinstallprompt` 时有“Install now”，另有 Fullscreen API 按钮）；“稍后”记 7 天（`localStorage saltline.install.hideUntil`）；`?noinstall=1` 关闭，`?install=1` 强制。
- **横竖屏**：`#app` 是 `position: fixed; inset: 0`（不再用 `innerHeight` 设像素，避免主屏幕模式下底部 home bar 处留黑边）；`src/app/viewport.js` 量的是 `#app` 的布局尺寸，旋转后 1.6 s 内多次重测（iOS 会先报旧尺寸），页面滚动位置钉在 0，尺寸变化时派发 `saltline-viewport`，渲染器和 HUD 都听它。
- **主屏幕底部黑边（iOS 26+）**：`viewport-fit=cover` + `black-translucent` 的主屏幕应用里，只要文档本身比屏幕矮，WebKit 就把视口缩短一个状态栏高度（WebKit bug 301108），底部那一条不绘制（真机截图黑条 ≈ 62 css px）。`position: fixed` 的 html 没有自己的高度，所以 `viewport.js` 在主屏幕模式给 html 加 `is-standalone`，CSS 让 html/body 成为 `100lvh` 的普通盒子，视口即恢复整屏；`--fill` 兜底保留。参考：frappe-ui PR #1284/#1289、yuvomi PR #2546。
- **菜单按钮**：触屏右上角固定有 `MENU`（原 ESC），FPS / PING 读数和大乱斗排行榜在触屏上让开它和弹药数。
- **性能**：手机默认 `low` 再减（阴影图 1024、体积光 8 步、雨 0.35）；动态分辨率下限在触屏上是 0.45（桌面 0.6）；低档 + 最低分辨率仍 > 22 ms 连续三个窗口则锁 30 fps（隔帧渲染，更稳更凉），`?fps=30` 可强制，`context.frameCap` 由 `WorldAdapter.frameCap()` 交给 `RuntimeBridge`。
- **大乱斗弹药**：`weapon.js` 在 `game.mode === "brawl"` 时不扣备弹、备弹为 0 也能换弹，HUD 显示 ∞（`weapon.infiniteAmmo`）。
- **手机版面**：触屏上标题页没有电影黑边（`.m-bars` 隐藏）；`.menu` z-index 50，高于大乱斗各层，PAUSED 永远在最上；观战（`html.br-watch`）隐藏跳/换弹/瞄/开火/使用按钮，只留摇杆和 MENU；观战时在玩列表在左上角、排队列表在右上角（`.br-side` 在触屏上 `display: contents`），中间留空，底部 Play / Follow / Free cam 条是一行小按钮，提示条（toast）在上方中间；选角界面竖屏卡片贴底、横屏贴左，`src/lobby/characters.js` 用 `camera.setViewOffset` + 视场角把人物放到剩下的区域，离开时清除。
- **观战 UI（手机和桌面）**：底部条只有 Follow / Free cam 两段开关（Follow 已选时再点切到下一个玩家），不再重复排队人数、聊天、对讲提示；`Q/E`、`Tab` 等键盘提示放在 `.br-desk` 里，触屏隐藏。Play / Join queue / Watch only / Take the seat 按钮在排队列表下面（`setWaitButtons`）。聊天像直播弹幕：无底板、带文字阴影、顶部渐隐、更高。触屏右下角多一个 CROUCH 开关（点一下蹲、再点站起；蹲下让碰撞盒从 1.9 m 降到 1.15 m，也用于钻矮缝和攀爬收尾），观战时隐藏。
- **跟随观战的平滑**：旁观者每秒只收到 10 个快照，原来固定 0.1 s 插值延迟几乎没有缓冲，网络一抖就停顿/跳变。`opponent.js` 现在按快照到达间隔（`gap`）和抖动（`dev`）自适应延迟（上限 0.6 s），外推时间也随间隔加长；`spectator.js` 再对被跟随者的位置和朝向做一次指数滤波（相机不再直接贴着 10 Hz 的值）。
- **呼号**：3–8 个字符（按码点算），必须含字母或数字（任何文字），否则服务端回退为 `Breacher`；客户端在连接前和改名时给出提示（`nameProblem`）。
- 测试：`npm run test:mobile`（手机尺寸 + 触摸模拟，12 项）。
