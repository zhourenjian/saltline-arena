# Saltline × DuoWorld World Protocol

Saltline 已按 DuoWorld World Protocol 0.1.0 改造为一个可被宿主加载的 World，同时保留原来的独立网页模式。改造方式是**适配器**：物理、角色控制器、渲染器、关卡和玩法没有被替换，只在它们外面加了一层协议层。

- World ID：`saltline.harbor`（固定，不随构建变化）；World 版本 `1.1.0`
- 坐标：`+Y` 向上，yaw 0 时前方为 `-Z`，1 单位 = 1 米，右手系
- 出生点：`[-32, 0, 6]`，yaw `-π/2`（面向 `+X`），取自 `level.playerStart`
- 支持的 Avatar 接口：1.0（`setMotion`）和 1.1（`setLocomotion`，带 `playAction` / `stopAction` / `getAnchor` 可选项）

## 1. 两种运行模式

| 模式 | 入口 | 主循环 | `window.DuoWorld` |
| --- | --- | --- | --- |
| 独立模式（Standalone） | `index.html` → `src/game.js` | `RuntimeBridge` 的唯一 `requestAnimationFrame` | 由 `RuntimeBridge` 安装 |
| World Package | `world.json` → `world.js` 的 `default` 导出 | 宿主调用 `world.update(dt)` | 由宿主提供（带 `__host` 标记时 Bridge 不覆盖） |

两种模式共用同一套场景代码，都经由 `createSaltlineWorld()`（`src/duoworld/WorldAdapter.js`），没有复制任何场景代码。

### 独立模式

```sh
npm ci
npm run dev                 # http://127.0.0.1:5173/
npm run build               # 生成 dist/standalone/ 和 dist/world-package/
npm run preview             # 预览 dist/standalone/，http://127.0.0.1:4173/
```

`dist/standalone/` 只使用相对路径，可以放在任意静态 HTTP 路径下（测试中挂在 `/nested/path/standalone/` 下验证过）。必须通过 HTTP 打开，不能用 `file://`。

URL 参数（在原版参数的基础上新增）：

| 参数 | 作用 |
| --- | --- |
| `?avatar=<id>` | 初始 Avatar（优先级低于 `window.DuoWorldInitialAvatar`） |
| `?view=third` / `?view=first` | 初始镜头模式 |
| `?autostart=1` | 跳过标题直接开始任务（原版参数） |

游戏中佩戴 Avatar 时按 **T** 在第一人称和第三人称之间切换。默认仍是原版第一人称视角，不佩戴 Avatar 时画面与原版一致。

### World Package

```text
dist/world-package/
  world.json        清单：protocol、id、entry、坐标、能力、渲染能力、限制
  world.js          独立 ES 模块（Three.js、玩法、CSS 已内联，无开发服务器依赖）
  assets/fonts/     字体，运行时相对 world.js 解析
```

宿主只需要读 `world.json`：

```js
const pkg = new URL("./saltline/", location.href);            // 任意挂载路径
const manifest = await (await fetch(new URL("world.json", pkg))).json();
const { [manifest.entryExport]: createWorld } = await import(new URL(manifest.entry, pkg));

const world = createWorld({
  container: document.getElementById("mount"),  // World 在这里创建自己的 #app
  avatarRoot: "https://example.com/avatars/",     // Avatar Package 根目录
  params: { q: "low" },                           // 原版 URL 参数，可选
});
await world.load();                                // 构建全部系统（不进入循环、不响应输入）
await world.enter({ avatar: "girl-purple", cameraMode: "third-person", autostart: true });
// 宿主自己的循环：
const loop = (t) => { world.update(dt(t)); requestAnimationFrame(loop); };
await world.leave();                               // 暂停任务、释放指针锁、停止响应输入
await world.dispose();                             // 释放监听、计时器、音频、GPU 资源和 DOM
```

`tests/fixtures/host/index.html` 是一个最小的参考宿主。

## 2. 生命周期

| 方法 | 说明 |
| --- | --- |
| `load()` | 按原版启动顺序构建所有系统，挂上 AvatarHost 和 World 对象。幂等，并发调用共享同一个 Promise。 |
| `enter(ctx)` | 开始响应输入；可选 `avatar`、`cameraMode`、`autostart`。 |
| `update(dt)` | 执行一帧原版循环体（输入 → 玩法 → 玩家/武器/敌人 → frameHooks → 特效 → 渲染）。**World 没有自己的循环。** |
| `leave()` | 返回 Promise。暂停任务、关闭玩法输入、退出指针锁、暂停音频。 |
| `dispose()` | 返回 Promise。释放全部资源，之后可以再次 `load()`。加载过程中调用也安全：半成品会被完整回收，`load()` 以 `WORLD_DISPOSED` 拒绝。 |

状态：`created → loaded ⇄ entered → (dispose) → created`。同一文档同时只能有一个 Saltline World（原版系统按 id 查找 `#app` / `#view` / `#ui`），第二个会以 `WORLD_BUSY` 拒绝。

所有 DOM / window 监听都通过 `src/core/lifetime.js` 的 `listen()` 注册：`dispose()` 一次性移除，`leave()` 之后自动静默。

## 3. Avatar Package

### 安装

一个 Avatar Package 就是一个目录：

```text
public/avatars/<id>/
  avatar.js         调用 window.DuoWorldAvatars.register(...)
  model.glb …       包自己的资源，用 ctx.loadGLTF("model.glb") 相对加载
```

把目录放进 `public/avatars/`（构建时原样复制到 `dist/standalone/avatars/`），或放到宿主的 `avatarRoot` 下。**不需要修改 World 代码，也不需要重新构建。** 本仓库附带 7 个包：

| id | 名称 | 性别 | 接口 | 模型身高（metadata.height） | 说明 |
| --- | --- | --- | --- | --- | --- |
| `girl-purple` | Sakura Girl (purple scarf) | 女 | 1.1 | 1.64 m | GLB 骨骼动画（第三方包；`avatar.js` 加了持枪，`model.glb` 未修改） |
| `violet-girl` | 紫衣少女 | 女 | 1.1 | 1.58 m | 原 `lantern-girl` 去掉提灯后改名（`scripts/strip-glb-nodes.mjs`） |
| `voxel-walker` | 墨衣行者 | 男 | 1.0 | 1.96 m | metadata.height 由 1.84 改为实测 1.96（含帽子） |
| `blue-captain` | 蓝衣船长 | 男 | 1.1 | 1.60 m | 海军蓝大衣、白色船长帽、胡子 |
| `orange-mechanic` | 橙衣机师 | 男 | 1.1 | 1.60 m | 橙色连体工装、护目镜、工具包 |
| `jade-swordswoman` | 青衣侠女 | 女 | 1.1 | 1.60 m | 青色长袍、发髻马尾、背剑 |
| `red-runner` | 红衣跑者 | 女 | 1.1 | 1.60 m | 红色运动外套、短裤、发带 |

后四个由 `node scripts/build-avatar-models.mjs` 程序化生成（刚体方块部件 + 节点动画 idle / walk / run / jump / fall / land / wave，结构与 `violet-girl` 相同）；`avatar.js` 各自独立，不依赖脚本。

### 持枪姿势（包内实现，不是协议的一部分）

附带的 7 个包都自己带一支步枪并摆出双手持枪姿势。**这完全在包内部完成**：枪是包自己创建的 Object3D（挂在包自己的胸部节点下），手臂姿势在包的 `update(dt)` / `render` 里、动画混合之后覆盖。World 不提供枪模型、不读取骨骼、不知道包是否持枪，协议没有变化；不带枪的第三方包照常工作（测试用的 `probe-v1` / `probe-v11` 就没有枪）。

- 方块角色（`violet-girl`、`voxel-walker`、`blue-captain`、`orange-mechanic`、`jade-swordswoman`、`red-runner`）：手臂是挂在肩关节上的刚体方块，创建时按本模型的臂长和肩宽求一次握把位置（双手并排、略低于肩），每帧把两只手臂指向握把；枪和手臂会抵消动画里的胸部前倾，所以跑步时枪保持水平。腿、躯干、头的动画不变。枪用各自服装的配色。挥手（`duoworld:wave`）时支撑手臂平滑离开枪去挥手。
- `girl-purple`（骨骼蒙皮）：`avatar.js` 中新增 `createRifle()`，枪挂在 `upperChest`，每帧用解析式两骨骼 IK 把双臂和手掌放到握把和护木上；骨骼局部轴从骨架的 bind pose（`boneInverses`）求得。坐下时淡出持枪并隐藏枪；挥手时右臂由挥手覆盖。
- 枪只是外观：射击、枪口和命中仍按第一人称眼睛位置和固定胶囊命中盒计算，与外形无关。第一人称时身体（连同枪）不显示。


### 警匪角色和持物协议（World 1.1.0 之上的可选项）

默认角色是 `swat-operator`（SWAT：中蓝色作战服、深蓝头盔和防弹背心、护目镜、耳机、POLICE 标）和 `masked-raider`（卡其夹克、橄榄绿长裤、沙色头套、针织帽、红色围巾和臂章），不露脸。两个包由 `node scripts/build-soldier-avatars.mjs` 从 `scripts/lib/soldier/` 生成（v2.0.0）：连续蒙皮的身体（放样曲面，不是方块）、带指节的手套、织物法线贴图。两套衣服都不是深色：材质带一点自身颜色的补光，逆光或在阴影里不会变成黑色剪影（测试检查服装亮度下限）。

**角色包不带枪。** 包只提供身体和动作；进入游戏后由 World 把第一人称那支 PAC-9（同一份几何和材质，`src/weapons/held-gun.js`）放到角色手里。主菜单的角色预览是空手。以下全部是**可选**扩展，不支持的包照常工作（旧的 7 个包仍然自带外观枪，World 不给它们发枪）：

| 项 | 内容 |
| --- | --- |
| 挂点 `weapon` | 由 Avatar 拥有并移动的 Object3D：原点 = 惯用手握把位置，+Z 沿枪管，+Y 向上。World 把自己的枪挂在这里；World 不改 Avatar 的其他节点 |
| 挂点 `weaponStow` | 可选。双手被占用（攀爬、爬梯）时枪挂在这里（背后） |
| `setLocomotion().held` | `{ kind: "rifle", grip, support, action }`。`grip` / `support` 是 `weapon` 挂点坐标系下的抓握框 `{ position, quaternion, radius }`：原点在被握住的杆的中心，+Y 沿杆指向拇指，+Z 沿手指；`grip` 给右手，`support` 给左手（可为 `null`）。`action`：`null` / `"reload"` / `"inspect"`。没有 `held` = 空手 |
| `setLocomotion().aimPitch` | 俯仰角（弧度，向上为正），包用来抬放枪口 |
| `setLocomotion().climb` | `{ kind: "mantle"\|"ladder", progress 0..1, ledgeHeight, ledgeDistance, climbSpeed, crouchEnd }`；翻越时 `ledgeHeight` = 脚到边沿的高度差，`ledgeDistance` = 身体到边沿的水平距离 |
| 动作 `duoworld:fire` | 开火后坐，World 在每次开火（本地第三人称或对手）时调用 |
| metadata `firstPersonArms {sleeve, glove}` | `#rrggbb`，World 据此给第一人称手臂换色，使其与身体服装一致 |

握姿：右手握手枪式握把，左手握护木下的垂直握把（和第一人称一致），枪托抵在右肩窝，头向枪托侧倾。握把、垂直握把、弹匣、拉机柄位置来自枪模本身，World 每帧把抓握框传给包，包用两骨骼 IK 把手腕放到位、手指按杆的半径卷曲（食指伸进护圈扣在扳机上），所以手一定握在枪上，不会乱扭。火光和曳光从这支枪的枪口出发（`heldRig.muzzle()`），不再读包的 `muzzle` 挂点。

**换弹和检视同步。** 第一人称的换弹（2.1 s，空仓 2.72 s，多一次拉机柄）和检视（闲置 24 s 后自动，3.5 s，枪向两侧翻转）由 `weapon.heldAction()` 给出 `{ a, t, empty }`。`heldGunPose(action, t, empty)` 是纯函数：同一个调用驱动本地第三人称身体和每个远端玩家——枪身倾斜、弹匣跟着左手离开和插回、拉机柄。联网时客户端在 `loco` 里带 `w: [动作 1|2, 秒, 空仓 0|1]`（`packLoco`），服务器 `sanitizeLoco` 限幅后转发，接收端在两次快照之间用自己的时钟推进。1v1、大乱斗和观众看到的都是同一套。

`w` 是对战协议 2 新增的（`DUEL_PROTOCOL = 2`）：服务器进程改代码后必须重启，仍在跑旧代码的服务器会以协议版本不符拒绝连接，而不是悄悄丢掉这个字段。

联网时 `loco` 经 `sanitizeLoco`（服务器）和 `packLoco`（客户端）中转，字段全部限幅，不能夹带其他内容（`held` 不上线，接收端自己重建）。旧角色仍然安装并可用 `?avatar=` 加载。

### 默认 Avatar

在 `index.html` 里用普通 `<script src>` 预加载包，并指定默认 Avatar：

```html
<script src="./duoworld/avatar-registry.js"></script>
<script src="./avatars/girl-purple/avatar.js"></script>
<script>window.DuoWorldInitialAvatar = "girl-purple";</script>
<script type="module" src="/src/game.js"></script>
```

普通脚本在 Vite 构建之后仍然有效：`/duoworld/avatar-registry.js` 由构建插件输出，`avatars/` 来自 `public/`。没有预加载的包会在 `setAvatar(id)` 时按 `<avatarRoot>/<id>/avatar.js` 自动注入。

### 运行时切换

```js
await window.DuoWorld.setAvatar("violet-girl");  // 不刷新页面、不重新加载 World
window.DuoWorld.getAvatar();                       // { id, interface: "1.1", representation, optional, ... } 或 null
window.DuoWorld.listAvatars();                     // 已注册的包，带 supported / loaded
await window.DuoWorld.setAvatar(null);             // 卸下，回到原版第一人称玩家
window.DuoWorld.setCameraMode("third-person");     // "first-person" | "third-person"
await window.DuoWorld.playAction("duoworld:wave"); // { ok, reason }，从不抛异常
window.DuoWorld.getAnchor("head");                 // Object3D 或 null
window.DuoWorld.objects.list();                    // WorldObjectDescriptor[]
```

切换规则：

- 新 Avatar 完整创建成功后才替换旧的；失败时旧 Avatar 继续使用，World 保持可玩。
- 位置、朝向、速度、跳跃状态、任务状态、镜头模式在切换中保持不变。
- 连续调用时以最后一次为准，被取代的调用以 `AVATAR_SUPERSEDED` 拒绝，结果不会被挂上场景。
- 被替换的实例一定会调用 `dispose()`。

错误码：

| code | 场景 |
| --- | --- |
| `AVATAR_ID_INVALID` | id 不符合 `^[a-z0-9][a-z0-9._-]*$`（防止路径穿越） |
| `AVATAR_NOT_FOUND` | `<avatarRoot>/<id>/avatar.js` 加载失败或未注册 |
| `REPRESENTATION_UNSUPPORTED` | 包声明了本 World 不支持的表示（如 `gaussian-splat`） |
| `AVATAR_PROTOCOL_UNSUPPORTED` | 声明的 Avatar 协议主版本不是 1 |
| `AVATAR_CREATE_FAILED` / `AVATAR_CREATE_TIMEOUT` | `create()` 抛错、资源加载失败或超过 30 秒 |
| `AVATAR_INVALID` | 实例缺少 `object3D` / `setMotion` / `update` / `dispose` |
| `AVATAR_SUPERSEDED` | 被后一次 `setAvatar` 取代 |

### Avatar 看到的接口

`create(ctx)` 收到的 `AvatarContext`：

```js
{
  THREE,                // World 自己的 Three.js r180 命名空间（不会出现第二份 Three）
  baseUrl,              // 包目录的绝对 URL，以 "/" 结尾
  loadGLTF(url),        // 相对 baseUrl 解析，使用 World 的 GLTFLoader
  coordinates,          // { up: "+Y", forward: "+Z", metersPerUnit: 1 }，Avatar 的建模约定
}
```

World 每帧调用：

- 1.1 包：`setLocomotion({ grounded, speed, velocity, phase, deltaSeconds, mode, gravity, stance, sprinting })`，数据全部来自真实物理。`phase` 为 `takeoff`（真实起跳事件）→ `airborne` → `landing`（落地后保持 0.14 秒）→ `grounded`；没有起跳的下落直接从 `airborne` 开始。
- 1.0 包：只在变化时调用 `setMotion("idle" | "walk" | "run")`。
- 所有包：`update(dt)`。暂停时不调用。

动作：只有当实例的 `capabilities.actions` 包含 `duoworld:interact` 时，切断中继（按住 E）才会触发 `playAction("duoworld:interact", { target })`，松开或完成时调用 `stopAction`。缺少可选方法时返回 `{ ok: false, reason: "ACTION_UNSUPPORTED" }`。

## 4. 职责划分

```text
Scene
└─ DuoWorld:PlayerControlRoot   ← 位置 = player.pos（脚底），rotation.y = player.yaw   [World 唯一写入者]
   └─ DuoWorld:WorldScale       ← 实例级缩放 1，rotation.y = π（Avatar +Z 前 → World -Z 前）
      └─ DuoWorld:HeightNormalize ← 统一身高：等比缩放 1.75 / metadata.height
         └─ instance.object3D   ← Avatar Visual Root，Avatar 只能改它内部
```

**统一身高。** 所有身体（玩家自己、第三人称、角色预览、1v1 对手、内置 Operator）都按同一条规则显示为 `AVATAR_TUNING.standardHeight` = 1.75 m（与 1.8 m 的玩家胶囊、1.68 m 眼高相配）：缩放 = 1.75 / `metadata.height`；包没有声明 `height` 时用 Avatar 外形的包围盒实测，缩放限制在 0.25–4。缩放写在 World 自己的 `DuoWorld:HeightNormalize` 节点上，不改 Avatar 的 Visual Root，也不改包文件。`createInstance()` 返回的 entry 带 `object3D`（这个包装节点，调用方应放它而不是 `instance.object3D`）、`visualScale`、`modelHeight`、`visualHeight`。第三人称跟随高度同样乘以这个缩放。对战命中盒是固定胶囊（半径 0.42 m、高 1.8 m，蹲下 1.2 m），本来就与外形无关；统一身高之后看到的身体也与命中盒一致。测试 #13 在 headless Chrome 中逐顶点测量 7 个包穿戴时和作为独立实例时的高度，全部在 1.75 m ±3% 内（实测 1.750–1.757 m）。

| World 负责 | Avatar 负责 |
| --- | --- |
| 输入、物理、重力、碰撞、移动速度、跳跃 | 模型、材质、骨骼、动画混合 |
| 玩家变换（唯一写入者） | 根据 `setLocomotion` / `setMotion` 选动画 |
| 镜头（第一 / 第三人称、镜头碰撞） | 可选的动作和挂点 |
| 射击、交互、任务规则 | 自己资源的加载和释放 |

World 不读取 Avatar 的骨骼名或网格名，不遍历 Avatar 的节点树，也没有针对任何 Avatar id 的分支（由测试 #14 静态检查）。第三人称跟随高度来自包的 metadata：`eyeHeight`，没有时取 `height × 0.92`，再乘以统一身高的缩放，限制在 0.6–3.2 米。Avatar 不能安装自己的镜头控制器。

第三人称镜头（`src/player/third-person-camera.js`）在模拟之后、渲染之前移动渲染镜头，用 World 的 `physics.raycast` 防止穿墙。射击、枪口和交互仍以第一人称眼睛位置为准。

## 5. 能力声明

`world.json`、`world.capabilities` 和 `window.DuoWorld.world.capabilities` 是同一份常量（`src/duoworld/protocol/protocol.js`），只列出已实现并有测试覆盖的能力：

| 能力 | 实现 | 测试 |
| --- | --- | --- |
| `duoworld.lifecycle@1` | `WorldAdapter` | #12 |
| `duoworld.avatar-host@1` | `AvatarHost.setAvatar` / `getAvatar` / `listAvatars` | #2 #7 #10 |
| `duoworld.avatar-locomotion@1.1` | `createLocomotionTracker` | #3 #6 |
| `duoworld.avatar-actions@1.1` | 中继交互 → `duoworld:interact`；`playAction` / `stopAction` / `getAnchor` 透传 | #13 |
| `duoworld.world-objects@1` | `WorldObjects`：3 个 `saltline:uplink-relay` + 1 个 `saltline:extraction` | #13 |
| `duoworld.camera-modes@1` | `first-person`、`third-person` | #4 #9 #13 |

渲染能力：

```json
{
  "backend": "three.webgl2@r180",
  "representations": ["three.object3d", "mesh.glb", "mesh.gltf"],
  "composition": { "sharedCamera": true, "meshSplatOcclusion": false, "depthTexture": false, "transparentComposition": true }
}
```

**不支持 3D Gaussian Splatting。** World 没有 splat 渲染器，声明 `gaussian-splat` / `3dgs` / `hybrid` 的包会以 `REPRESENTATION_UNSUPPORTED` 明确拒绝，不会伪装支持，也不会悄悄换成别的表示。

## 6. 安全边界

- **没有沙箱。** Avatar Package 脚本以页面权限运行。普通 JS 模块之间的 API 约定不构成安全隔离。目前只适合加载可信的本地 Creator 代码；**不可信第三方代码的隔离（iframe / Worker / 独立 origin）尚未实现。** `window.DuoWorld.sandbox` 明确报告 `{ untrustedCode: "not-isolated" }`，`world.json` 的 `security.sandbox` 为 `false`。
- World 运行时不修改 Avatar 包的原始资源，只读取。（`voxel-walker` 的 `metadata.height` 在仓库中由作者改为实测值 1.96；`girl-purple` 的 `model.glb` 与来源逐字节相同，`avatar.js` 由作者加入了持枪代码 `createRifle()`；方块角色的 `avatar.js` 同样加入了持枪代码。这些都是仓库里的源文件修改，不是运行时修改。）
- World 不接触平台账号、用户永久资产或其他 World 的数据，也没有绕过 Runtime 权限读取隐私数据的代码。World 自己只在 `localStorage` 的 `saltline.settings.v1` 保存原版设置。
- Avatar id 经过正则校验，不能拼出包目录以外的路径。
- 1v1 对战的 WebSocket 只连接玩家在菜单中输入（或 `?server=` 给出）的地址，不会自动连接其他服务。对手的 Avatar id 来自网络，同样经过正则校验，并且只从本 World 的 avatarRoot 加载；对手不能让我方加载任意 URL。对手昵称只以 `textContent` 显示。
- 对战服务器不是反作弊系统：血量、伤害、击杀、比分和出生点由服务器决定，但"打中了谁、打中哪里"由客户端上报，服务器只做频率限制和距离检查。修改过的客户端仍然可以作弊。
- World 额外在 `localStorage` 保存 `saltline.character.v1`（角色选择）和 `saltline.versus.v1`（服务器地址、昵称），不保存其他数据。

## 7. 新增和修改的文件

新增：

| 文件 | 作用 |
| --- | --- |
| `src/duoworld/protocol/protocol.js` | 协议常量、能力、坐标、错误类型、JSDoc 类型 |
| `src/duoworld/WorldAdapter.js` | 生命周期适配器，`createSaltlineWorld()` |
| `src/duoworld/AvatarHost.js` | Avatar 加载、校验、切换、变换、运动状态、动作 |
| `src/duoworld/WorldObjects.js` | World Interaction Adapter |
| `src/duoworld/RuntimeBridge.js` | 独立模式的主循环和 `window.DuoWorld` |
| `src/duoworld/compatibility/avatar-registry.js` | 普通脚本可用的 `window.DuoWorldAvatars` |
| `src/duoworld/manifest.js`、`src/duoworld/world-entry.js` | `world.json` 生成和 World Package 入口 |
| `src/core/lifetime.js` | 可释放、可静默的监听和计时器 |
| `src/player/third-person-camera.js` | 第三人称镜头 |
| `src/vendor/three-r180-gltf-loader.js`、`three-r180-buffer-geometry-utils.js` | 与 r180 对应的 GLTFLoader |
| `vite.world.config.js`、`scripts/build-world-package.mjs` | World Package 构建 |
| `tests/` | 自动化兼容性测试、测试用 Avatar、参考宿主 |
| `scripts/lib/glb.mjs`、`scripts/strip-glb-nodes.mjs`、`scripts/build-avatar-models.mjs` | GLB 读写 / 删节点（生成 `violet-girl`）/ 程序化生成方块角色 |

修改（行为不变，只是让系统可以被干净地释放和重复加载）：

- `src/app/runtime.js`：把启动和单帧循环拆成 `boot()` / `frame(dt)` / `teardown()`，加入 `frameHooks`；不再自己开循环。
- `src/input/input.js`、`src/ui/menus.js`、`src/ui/hud.js`、`src/render/renderer.js`、`src/audio/audio.js`、`src/game/flow.js`：监听和计时器改用 `listen()` / `lifetime.timeout`。
- `src/world/props/geometry.js`、`detail-geometry.js`、`detailed-builders.js`：道具模板缓存原来是模块级 `Map`，会让每次 `dispose()` 后的 World（约 160 MB）一直留在内存，并在第二次加载时复用上一个 World 的材质。现在改为按材质库的 `WeakMap`。
- `src/app/boot-screen.js`：延迟查找元素，可以在 World 挂载后再创建 DOM。
- `src/game.js`：改为创建 World 和 RuntimeBridge。
- `index.html`：加入 Avatar 注册表和包的 `<script src>`。
- `vite.config.js`、`package.json`、`.github/workflows/pages.yml`：输出改到 `dist/standalone/`，新增 `build:world` 和 `test`。

## 7a. 主菜单、角色选择、攀爬和 1v1 对战

| 文件 | 作用 |
| --- | --- |
| `src/ui/menus.js` | 主菜单（MISSION / 1V1 DUEL / CHARACTER / SETTINGS / CONTROLS）、角色页、对战大厅、对战结算页；发出 `menu:action`、`menu:screen` |
| `src/lobby/characters.js` | 角色选择：列表 = Operator + `listAvatars()` + `avatars/catalog.json`，再按宿主的 `window.SaltlineCharacters`（`builtIn`、`hide`、`default`）筛选，实时预览，保存选择 |
| `src/player/player.js` | 攀爬（`findLedge`）、`player:climb` 事件、`damageFilter` |
| `src/versus/rules.js` | 协议版本、规则、出生点、名字 / Avatar id / 房间码清洗；客户端和服务器共用 |
| `src/versus/net.js` | WebSocket 客户端 |
| `src/versus/opponent.js` | 对手：插值、Avatar、命中盒（胶囊 + 头部球）、死亡和重生 |
| `src/versus/versus-hud.js` | 比分、倒计时、重生提示、对手名牌 |
| `src/versus/versus.js` | 大厅 ⇄ 服务器 ⇄ 游戏流程 |
| `server/` | `npm run server`：零依赖 WebSocket 服务器（`websocket.mjs`）和对战逻辑（`hub.mjs`） |
| `tests/hub.test.mjs`、`tests/modes.test.mjs` | 服务器单元测试；菜单、角色、攀爬和两个浏览器对战的端到端测试 |

AvatarHost 新增 `createInstance(id | null)` / `releaseInstance(entry)`：为预览和对手创建独立的 Avatar 实例，不影响玩家自己穿戴的 Avatar。`describeAvatar(id)` 返回包的名称和表示方式，不加载脚本。

服务器环境变量：`PORT`（默认 8787）、`HOST`（默认 `0.0.0.0`）、`ALLOWED_ORIGINS`（逗号分隔；设置后拒绝其他页面的连接）。客户端可用 `?server=ws://host:port` 预填地址。

对战中暂停只关闭本地菜单，对手仍然可以击中你。

## 7b. 大乱斗、名牌遮挡和角落读数

| 文件 | 作用 |
| --- | --- |
| `src/brawl/rules.js` | 大乱斗规则和全部默认值（客户端和服务器共用），`brawlRulesFromEnv` 读取 `BRAWL_*` 环境变量 |
| `server/brawl.mjs` | 场地、排队、上场确认、按战绩淘汰、AFK / 掉线清理、开新场地、观众快照、聊天、👎 禁言、抢麦和语音转发 |
| `src/brawl/brawl.js` | 客户端流程：大厅 → 排队 / 上场 → 观战，远端玩家，按键 |
| `src/brawl/brawl-hud.js` | 中上方提示、记分板和淘汰倒计时、确认框、观战栏、聊天框、麦克风按钮（全部用 `textContent` 写入） |
| `src/brawl/spectator.js` | 本地观战镜头：跟随（Q / E 切人）和上帝视角，不向服务器发送任何位置 |
| `src/brawl/voice.js` | 8 kHz µ-law 单声道录音和播放；只在按下抢麦后打开麦克风 |
| `src/ui/net-stats.js` | 右上角 FPS 和服务器 PING |
| `tests/brawl.test.mjs`、`tests/brawl-e2e.test.mjs` | 服务器单元测试（假时钟）；4 个浏览器窗口的端到端测试 |

设计决定：

- **聊天和语音只在观众之间**，场上玩家收不到，避免报点。
- **禁言键是「IP + 小写昵称」**，进场时固定。同一 NAT 后的室友不会被连带禁言；断线重连不解除；换昵称重连可以绕过（这是为了不误伤共享 IP 的取舍）。同一条消息的 👎 按客户端和地址各去重一次，同一地址开多个窗口不能刷票。
- **淘汰和 AFK 清理只在有人排队时进行**；被淘汰和阵亡过多的玩家自动重新排队，AFK 的不会。
- **名牌**：每帧从镜头到对手头部做 `physics.lineOfSight` 检查，被挡住或超过距离就淡出隐藏。没有采用把名字画在衣服上的方案：Avatar 外形各不相同，衣服上的字在远处读不清，而且从背后仍然能看出是谁。
- **爆头**：1v1 和大乱斗身体 20、头 50，由服务器按客户端上报的部位计算。
- **镜头和暂停**：观众打开聊天或按 Tab 释放鼠标时 `game.keepPlayingOnUnlock = true`，释放鼠标不会进入暂停。点画面或再按 Tab 重新锁定。
- **进入流程**：Join 直接请求上场（有空位就上场，满员就排队），不再弹「Play / Watch」框；Watch only 只观战。
- **等待名单**：服务器每次刷新大厅（`br.lobby`）时，给非上场成员附上 `list`。队列在前（带号码），然后是只观战的人（最新进入的在前），共 `BRAWL_RULES.waitListSize` = 10 条。上场玩家不收这个列表。
- **语音播放**：浏览器的自动播放策略会让未经点击创建的 AudioContext 保持 suspended，收到的语音会被静默丢弃。客户端在进入大乱斗的那次点击里解锁声音，之后每次点击或按键都会再试一次；未解锁时提示「click or press any key to hear voice」。录音需要安全上下文（https 或本机），否则提示原因。
- **菜单按钮**：原版的 `.loc-card` 地点说明卡是一个透明层，盖在菜单按钮上，挡住了按钮文字处的鼠标：悬停和点击都失效，只有按钮边缘的空白处有效。现在它是 `pointer-events: none`。`tests/modes.test.mjs` 在标题、角色和大乱斗页面用 `elementFromPoint` 逐点检查按钮。

规则默认值和环境变量见 README「大乱斗」一节。服务器只在内存中保存场地、队列和最近 60 条聊天，不保存语音，不写日志。

## 8. 测试

```sh
npm run build
npm test                                  # 无 dist/ 时会先构建；--build 强制重建
BASELINE=/path/to/original/dist npm test  # 与改造前的构建对比（默认 /tmp/saltline-base/dist）
SALTLINE_DIST=/tmp/build npm test         # 测试放在别处的构建（<dir>/standalone、<dir>/world-package），不会自动构建
node scripts/build-avatar-models.mjs      # 重新生成 4 个方块角色的 model.glb（--check 只打印尺寸）
```

测试在 headless Chrome 中运行真实构建（`CHROME` 环境变量可指定浏览器路径），用 DevTools 协议发送真实键盘事件，用 `getEventListeners`、WebGL 上下文计数、堆快照和 `renderer.info` 检查资源。结果写入 `tests/out/results.md`、`results.json` 和截图。每一项只有全部子检查都实际运行并通过时才记为 PASS。

最近一次结果（2026-11-14，与改造前构建对比）：

| # | 项目 | 结果 |
| --- | --- | --- |
| 1 | 原 World 无 Avatar 时正常（移动 3.10 m / 原版 3.10 m，跳跃高度 0.999 m / 0.999 m，射击、3 个中继） | PASS |
| 2 | 1.0 Avatar 加载（voxel-walker、probe-v1；setMotion 收到 idle→walk→run→idle） | PASS |
| 3 | 1.1 Avatar 加载（girl-purple GLB 骨骼、violet-girl、probe-v11；AvatarContext 正确） | PASS |
| 4 | Avatar 跟随原控制器移动（控制根与 player.pos 误差 0） | PASS |
| 5 | 物理和重力不变（跳跃高度 ≈ v²/2g，g = 21，与原版一致） | PASS |
| 6 | 起跳、下落、落地协调（takeoff→airborne→landing→grounded；无起跳下落不含 takeoff） | PASS |
| 7 | 不刷新页面动态切换（位置、朝向、状态保持；并发切换以最后一次为准） | PASS |
| 8 | 连续 49 次切换后无重复渲染器 / 控制器 / 监听（1 个 WebGL 上下文，监听数不变，实例全部释放） | PASS |
| 9 | 切换后碰撞和镜头正确（停在墙前，镜头不穿墙、背墙时拉近） | PASS |
| 10 | 加载失败时保留旧 Avatar 或回到原版玩家（5 类失败） | PASS |
| 11 | 独立模式（任意子路径、`?avatar=`、`DuoWorldInitialAvatar`、无 404） | PASS |
| 12 | 重复 load / enter / leave / dispose 5 次无泄漏（堆 12.3 → 13.2 MB，GPU 资源数一致，加载中 dispose 安全） | PASS |
| 13 | 能力声明与实现一致（清单 = 运行时，出生点 = 关卡，动作 / 对象 / 镜头 / 渲染能力实测） | PASS |
| 14 | 无 Avatar id 硬编码、不按骨骼 / 网格名查找 | PASS |
| 15 | 3DGS mesh / splat 遮挡 | N/A：未实现 splat 渲染，作为限制报告，不记为通过 |

主菜单、角色选择、攀爬和 1v1 对战另有两组测试（`npm test` 会一起运行）：

- `npm run test:hub`：对战服务器的 17 个单元测试（含换弹 / 检视字段 `w` 的限幅），覆盖房间、协议版本、伤害、击杀、重生、出生点、胜负、再来一局、离开、限流和 `ALLOWED_ORIGINS`。
- `npm run test:modes`：两个真实浏览器窗口连接真实服务器，13 项端到端测试。覆盖主菜单、菜单按钮没有被遮挡、角色预览和保存、隐藏角色和默认角色、`?avatar=` 优先级、攀爬和拒绝攀爬高墙、建房和加入、看到对手并击中、5 杀结算、再来一局、坠落伤害经由服务器、对手离开、服务器不可达。截图写入 `tests/out/modes-*.jpg`。

- `npm run test:ladder`：起重机梯子和楼梯塔，8 项。
- `npm run test:soldier`：警匪角色和持物协议，16 项。包里没有枪、服装亮度下限、预览空手；每个角色：枪挂在 `weapon` 挂点、右手腕在握把上、左手掌离垂直握把不超过 0.07 m（不是托着护木）、枪托在肩窝而不是胸口正中、枪管沿视线、第一人称手臂换色；第三人称火光在手里那支枪的枪口；换弹 / 检视时枪和左手在动；爬梯和翻越时枪收到背后、手在梯级 / 边沿上、结束后重新持枪；切换角色不泄漏几何体；联网：对手手里有枪、火光位置、换弹和检视同步（时钟误差 < 0.6 s）、对手爬梯时枪在背后。截图写入 `tests/out/soldier/`。
- `npm run test:brawl`：大乱斗服务器 25 项单元测试（排队、确认超时、淘汰、宽限期、阵亡上限、AFK、开新场地、聊天限流、👎 禁言和去重、抢麦上限、语音限流、等待名单）和 12 项浏览器测试（菜单、单人直接上场、角落读数、加入提示、满员直接排队和右上角等待名单、跟随 / 上帝视角、名牌遮挡、Watch only、聊天、抢麦、Tab 释放鼠标后真实点击 👎、让出座位、退出）。

最近一次结果（2026-11-14）：hub 17/17，brawl 25/25，modes 13/13，ladder 8/8，brawl-e2e 12/12，上表 #1–14 PASS。

## 9. 已知限制

- 不支持 Gaussian splat / hybrid 表示，也没有 mesh / splat 深度遮挡。
- 第三人称下子弹仍从第一人称眼睛位置射出，靠近障碍物时准星和枪口有视差。
- Avatar 网格不参与碰撞和子弹判定（原版物理基于独立碰撞体）。敌人不会因为 Avatar 外形而改变瞄准。
- 默认镜头仍是第一人称，此时看不到 Avatar 身体；按 T 或 `?view=third` 显示。
- 没有不可信代码沙箱（见第 6 节）。
- 同一文档只能有一个 Saltline World 实例。
- 大乱斗的命中同样由客户端上报，不防作弊；没有反外挂，也没有账号，禁言可以通过换昵称绕过。语音是 8 kHz 单声道，延时约 0.3–0.5 s。
- 爬梯子时没有屏幕提示；第一人称武器仍然显示（第三人称和别人看到的是枪背在身后）。
- 警匪角色是程序化建模（连续蒙皮身体、头盔 / 头套、战术装备、织物法线），不是照片级扫描，也没有布料解算；持枪、换弹、检视、攀爬都是程序动画（IK），不是动捕。远端的换弹 / 检视按 20 Hz 快照对时，起止可能有约 0.1 s 误差。检视只在闲置 24 s 后自动触发，没有专门按键。
- 1v1 对战只有 1 对 1、港口地图；没有延迟补偿，命中以射击方画面为准。GitHub Pages 的 HTTPS 页面只能连接 `wss://` 服务器。
- `npm run verify:refactor` 是对首次模块拆分的逐语句等价审计，现在会如预期地失败（首个差异在 `render/renderer.js`：监听改用 `listen()`）。日常 `npm run check` 通过。
- 构建 World Package 时 Vite 会提示 `/fonts/*.woff2 didn't resolve at build time`，这是预期的：字体在运行时改写为相对 `world.js` 的 `assets/fonts/`。
