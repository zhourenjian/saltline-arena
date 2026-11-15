# girl-purple：DuoWorld Avatar 插件（协议 1.1，兼容 1.0）

这是樱花树下、紫色围巾女孩的风格化 3D 角色。它是真实的蒙皮网格，带骨骼，动作包括 idle、walk、run、起跳、上升、下落、落地、失重漂浮、坐下和挥手。

本目录完全自包含，复制到任意 DuoWorld World 的 `public/avatars/` 下即可使用：
- 不引用生成它的源项目；
- 不带 three.js；
- 不需要构建工具或开发服务器。

**1.0 World 不用做任何改动。** 1.1 新增的接口全部是可选的，World 通过特性检测使用。

```text
girl-purple/
├── avatar.js      入口：普通 <script>（非 module），执行时同步注册到 window.DuoWorldAvatars
├── model.glb      glTF 2.0 二进制：7 个蒙皮网格、22 根骨骼、10 段动画，贴图已内嵌
├── avatar.json    清单（id、版本、协议范围、入口、visual、资产、能力摘要），运行时不读取
├── README.md      本文件
└── textures/      model.glb 内嵌贴图的 PNG 副本（运行时不请求）
```

## 1. 加载（1.0 / 1.1 相同）

```html
<script src="/avatars/girl-purple/avatar.js"></script>
<script>
  window.DuoWorldInitialAvatar = "girl-purple";
</script>
```

```js
const definition = window.DuoWorldAvatars.get("girl-purple");
const avatar = await definition.create({
  THREE,                                  // World 自己的 three.js
  baseUrl: "/avatars/girl-purple/",       // 本目录的 URL（结尾有无 "/" 均可，可为绝对 URL）
  loadGLTF: (url) => gltfLoader.loadAsync(url),
});
scene.add(avatar.object3D);               // 位置 / 朝向 / 缩放由 World 设置在 object3D 上
```

## 2. 1.0 World：保持不变

```js
avatar.setMotion("walk");                 // "idle" | "walk" | "run"，可每帧重复调用
avatar.update(deltaSeconds);              // 每帧
avatar.dispose();
```

- `setMotion("walk")` 等价于"以 walk 的参考速度移动"。播放速率为 1，与 1.0 版本的行为一致。
- 未知的 motion 名（例如 `"jump"`）会被忽略，控制台只警告一次。需要跳跃请用 `setLocomotion()`。

## 3. 1.1 World：可选接口

```js
if (typeof avatar.setLocomotion === "function") {
  // 每帧，在 update() 之前，把 World 物理的结果告诉 avatar
  avatar.setLocomotion({
    grounded: true,                       // World 判断的着地状态
    speed: 1.6,                           // 水平速度 m/s（World 决定，avatar 不改它）
    velocity: { x: 0, y: 0, z: 1.6 },     // m/s，y 为竖直速度
    phase: "grounded",                    // "grounded" | "takeoff" | "airborne" | "landing"
    deltaSeconds: dt,
    // 可选提示：gravity（数值或向量，只用来识别"无重力"），mode（例如 "duoworld:float"）
  });
}
avatar.update(dt);
```

| 接口 | 说明 |
| --- | --- |
| `instance.protocol` | `"1.1"` |
| `instance.capabilities` | 运行时的权威能力表（见下）。`definition.capabilities` 与 `avatar.json` 是静态摘要 |
| `instance.visual` | `{ representation: "mesh.glb", adapter: "three", object3D }`，其中 `object3D === instance.object3D` |
| `setLocomotion(state)` | World 物理状态 → 动画。`setMotion` 与 `setLocomotion` 共用一份状态，后调用的生效 |
| `playAction(name, { params, loop })` | 返回 `Promise<void>`，动作结束时 resolve，包括播完、被停止、被打断、被替换；不支持的动作 reject |
| `stopAction(name?)` | 停止一个或全部动作，淡出回到移动动画；返回在淡出完成时 resolve 的 Promise |
| `getAnchor(name)` | 返回跟随骨骼的 `THREE.Object3D`，未知名称返回 `null` |
| `inspect()` | **仅供诊断与测试**（当前空中状态、权重、播放速率等），不属于协议，可能变化 |
| `definition.protocol` | `{ name: "duoworld-avatar", version: "1.1", compatible: ["1.0", "1.1"] }` |
| `definition.identity` / `visual` | 身份层（id、名称、身高、半径）与视觉层描述，和行为层分开 |

```json
"capabilities": {
  "locomotion": {
    "walk": { "referenceSpeed": 1.05 }, "run": { "referenceSpeed": 2.85 },
    "jump": true, "fall": true, "land": true, "modes": ["duoworld:float"]
  },
  "actions": ["duoworld:wave", "duoworld:sit"],
  "anchors": ["head", "neck", "chest", "back", "leftHand", "rightHand", "leftFoot", "rightFoot"]
}
```

### 3.1 速度适配

`referenceSpeed` 是动画循环不滑步时对应的地面速度，**只是提示，不要求 World 用这个速度**。

avatar 按 World 给的实际速度调整播放速率：
1. idle、walk、run 的权重随平滑后的速度连续变化。
2. 播放速率 = 实际速度 ÷ 当前混合的参考速度，范围限制在 0.3–2.2。
3. walk 和 run 共用一个步态相位。

所以速度变化时不会每帧重启动画，也没有权重跳变。实测着地脚沿行进方向的滑动见第 5 节。

### 3.2 跳跃、空中与落地

**原 Viewer 和 1.0 插件都没有跳跃。** 本版新增了 4 段动画（JumpTakeoff、JumpRise、JumpFall、JumpLand）和一段 Float。

| World 给的 phase | avatar 的表现 |
| --- | --- |
| `takeoff` | 下蹲蓄力、蹬伸（0.3 s 一次性动画） |
| `airborne` | 按 `velocity.y` 连续混合：上升时收腿、手臂前上方；下落时腿向下够地、手臂张开 |
| `landing` 或 `grounded:true` | 落地缓冲。下蹲深度随着地前 World 报告的竖直速度变化，移动中落地缓冲较浅，然后回到 idle、walk 或 run |
| `airborne` + `mode:"duoworld:float"`（或 `gravity` 提示 < 0.3） | 失重漂浮姿态，直到 World 说着地为止，不会自行"落地" |

- **不假设重力值**：
  - 不用 9.81 推算轨迹，也不判断"应该落地了"；
  - 动画状态只由 World 给的 `phase` 和 `velocity` 决定。
  - 在 9.81、3.72、1.62、24.79 m/s² 和 0 重力下都已验证。
- **不推断输入**：avatar 不监听键盘，也不根据速度猜测"跳跃键"。
- **不移动世界位置**：所有动画都在原地。根节点的 y 就是 World 设置的 y；起跳和落地下蹲只在骨架内部降低骨盆，脚保持原位。
- 没有 `phase` 字段的旧式调用：`grounded:false` 时视为 airborne。

### 3.3 动作（Action）

| 名称 | 层 | 默认 | 参数 | 行为 |
| --- | --- | --- | --- | --- |
| `duoworld:wave` | 上半身 | 播一次 | `params.cycles`（默认 2） | 只驱动右臂，走、跑、跳时都可以叠加，腿部动画不受影响；`loop:true` 时一直挥，直到 `stopAction` |
| `duoworld:sit` | 全身 | 循环 | `params.duration`（`loop:false` 时，默认 2.5 s） | 坐在约 0.43 m 高的座面上，脚不离开原点，骨盆后移 0.37 m |

- 简写 `"wave"` / `"sit"` 也被接受。
- **不支持的动作明确报错，不伪装成功**：
  - 例如 `duoworld:swim`、`duoworld:fly`、`creator.example:*`，Promise 会 reject；
  - 返回 `Error`，`error.code === "ACTION_UNSUPPORTED"`，`error.action` 为动作名，错误消息里列出支持的动作；
  - `dispose()` 之后调用返回 `AVATAR_DISPOSED`。
- **动作不会覆盖 World 的移动**：
  - World 的速度超过 0.3 m/s 或离开地面时，`sit` 自动结束；
  - 结束后回到 walk、run 或空中动画，Promise 照常 resolve；
  - avatar 永远不改 `object3D` 的位置。
- 同一层上的新动作会替换旧动作，旧 Promise 随之 resolve。打断或停止后按时间常数淡回移动动画，没有姿态跳变。

### 3.4 挂点（Anchor）

`getAnchor(name)` 返回挂在**现有骨骼**上的空 `Object3D`。没有重建骨骼，也没有新增骨骼。

| 挂点 | 骨骼 | 偏移（骨骼空间，米） |
| --- | --- | --- |
| `head` | head | 头顶 `[0, 0.11, 0.01]` |
| `neck` | neck | `[0, 0.03, 0]` |
| `chest` | upperChest | 胸前 `[0, 0.02, 0.11]` |
| `back` | upperChest | 背后 `[0, 0, -0.14]`（背包外侧） |
| `leftHand` / `rightHand` | left/rightHand | 手心附近 `[±0.07, 0, 0]` |
| `leftFoot` / `rightFoot` | left/rightFoot | 鞋底附近 `[0, -0.07, 0.04]` |

- 每次调用返回同一个节点，World 可以把自己的物体 `add()` 上去，物体会跟随动画骨骼运动。
- `dispose()` 只释放 avatar 自己的资源，**不会**释放 World 挂上去的物体的几何体或材质，但这些物体会随角色一起从场景中移除。
- 本包不提供装备、换装或交易系统，挂点只是坐标系。

### 3.5 视觉层与预留接口

- Identity（身份）、Behavior（行为状态机）、Visual（`mesh.glb` + three 适配器）在 `avatar.js` 内是三个独立模块。
  - 行为层与渲染无关，只通过 `has / duration / pose / overlay / anchor / dispose` 访问视觉层。
  - 以后可以换成 3D Gaussian Splatting 或 Hybrid 表现（`representation: "gaussian-splat" | "hybrid"`），而不改协议和行为层。
- **目前只实现了 `mesh.glb` + `three`。** 包里没有任何 GS 依赖或代码。
- 预留但未实现：
  - swim、fly 等移动模式：未知的 `mode` 会被忽略，警告一次，只按 `phase` 和 `velocity` 处理；
  - 其他 action 名会返回 `ACTION_UNSUPPORTED`。

## 4. 约定与运行边界

| 项目 | 值 |
| --- | --- |
| 上方向 / 正面 / 单位 | +Y / +Z / 1 单位 = 1 米 |
| 原点 | 两脚之间的地面（鞋底在 y = 0） |
| 默认姿态 | 自然站立（`create()` 返回时已是 idle 第一帧） |
| 动画 | 全部原地播放。Idle、Walk、Run 只有步态自带的骨盆起伏和毫米级重心移动 |
| 不做的事 | 不监听输入；不运行自己的循环（只在 `update()` 里推进）；不创建 Renderer、Camera 或 Scene；不改物理；不读写其他玩家、账户或经济系统；不依赖 World 源码；不引入 three.js 副本 |
| 多实例 | 每次 `create()` 深拷贝节点、骨骼和 Skeleton，并各自使用一个 AnimationMixer。动作、挂点和空中状态都是实例级的 |
| `dispose()` | 停止 mixer 并清除其缓存；结束进行中的动作；从父节点移除；几何、材质和贴图按引用计数释放 |

## 5. 兼容性报告（`npm run verify:package` 实测，全部通过）

| # | 测试 | 结果 |
| --- | --- | --- |
| 1 | 1.0 World 加载新包 | 未改动的 1.0 测试世界在 3 种挂载路径下加载正常；每帧重复 `setMotion` 与只调用一次结果相同；未知 motion 被忽略 |
| 2 | 1.1 World 使用 `setLocomotion` | `test-world/v11.html` 有自己的物理，只调用 `setLocomotion`，接口和能力表完整 |
| 3 | 跳跃、空中、落地 | 4 种重力下：takeoff → 上升（vy>0）→ 下落（vy<0）→ landing → ground 每帧都正确；根节点 y 等于 World 设置的 y |
| 4 | 不同速度的滑步 | 沿行进方向的着地脚滑动（m/s）：0.5→0.014、0.8→0.018、1.05→0.028、1.5→0.067、2.0→0.173、2.85→0.051、3.5→0.076、4.5→0.096。作为对比，固定速率（1.0 行为）分别为 0.56、0.27、0.03、0.44、0.90、0.06、0.60、1.60 |
| 5 | Viewer 不回归 | 静止 idle、walk、run 姿态与原动画一致（最大差 0.0005）；Viewer 截图与过渡测试通过 |
| 6 | 多实例 | 3 个实例分别处于空中、行走、坐下，互不影响 |
| 7 | dispose 回收 | GPU 几何体 51 → 2，贴图 59 → 3，仅剩 World 自己的；挂上的 World 物体不被释放；之后可以再创建实例 |
| 8 | 不支持的动作 | `duoworld:swim`、`creator.example:deploy-wings`、`dance` 和空字符串都 reject，错误码为 `ACTION_UNSUPPORTED` |
| 9 | 自定义重力 | 1.62、3.72、24.79、0 m/s² 都没有错误逻辑；没有 `gravity` 提示时不会误入漂浮；0 重力时不会自行落地 |
| 10 | 挂点跟随骨骼 | 8 个挂点与骨骼的相对偏移漂移为 0；行走时手部挂点移动 0.52 m |
| 11 | 独立 HTTP 服务 | 包被复制到项目外，用纯 Node 静态服务器提供；所有请求都在包目录内 |
| 12 | 纯 Three.js 加载 GLB | 不经过 avatar.js，`GLTFLoader` 直接加载出 7 个蒙皮网格和 10 段动画，AnimationMixer 可以直接播放 Walk |

## 6. 已知限制

- 自建注册中心时附带的 `get / has / list` 是本包自己的约定；真实 World 有自己的注册中心时以 World 的为准。
- 速度适配：
  - 2.0 m/s 左右正处于 walk 与 run 的混合区，滑动最大（约 0.17 m/s），因为两种步态的混合姿态不是严格的接触约束。
  - 播放速率被限制在 0.3–2.2，超出 0.3–6 m/s 左右范围时会重新出现滑步。
  - 步态自带几厘米的骨盆左右摆动，着地脚有轻微横向移动，这一点与速度无关。
- 跳跃是 World 驱动的姿态动画，不是物理模拟：
  - 起跳时长由 World 决定（本包动画 0.3 s，World 的 takeoff 更短时会提前进入空中姿态）；
  - 没有二段跳、翻滚或攀爬。
- `duoworld:sit` 只提供坐姿，不寻找椅子，也不移动角色。World 负责把角色放到座位前方：座面前缘在原点后方约 0.1 m，座面高约 0.43 m。
- 没有表情、眨眼、手指骨骼或头发物理；材质为标准 glTF PBR，外观依赖 World 的灯光。
- `textures/` 只是副本，修改 PNG 不会改变 `model.glb`。
- 只在 three r187 和本仓库的两个测试世界里实测过，未在真实 DuoWorld World 中实测。
