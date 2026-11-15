# Saltline Arena

**免费的浏览器多人 FPS：港口里的自由混战，手机和电脑都能玩，不用下载、不用注册。**

## 在线试玩

**[https://saltline.kakoola.com/](https://saltline.kakoola.com/)** — 点 **Play** 进入大乱斗。

- 一局最多 6 人同场混战，满了就自动排队并旁观；每隔一段时间淘汰最后一名，让位给排队的人。
- 手机：用 Safari / Chrome 打开，**添加到主屏幕**可以全屏玩（游戏里有图文教程）。电脑：WASD + 鼠标。
- 两个角色可选（SWAT Operator / Masked Raider），旁观者可以文字聊天、按住说话（对讲）。
- 想单人玩原版任务，或者找朋友 1v1：主菜单 **More modes** 里有 Mission 和 1v1 Duel。

## 来源和关系

Saltline Arena 是在 **[realskyrin/fps3ademo-saltline](https://github.com/realskyrin/fps3ademo-saltline)**（原项目，一个把 Claude Artifact 里的 Saltline 单机游戏恢复成可运行、可分析的本地项目）的基础上，独立发展出来的**多人联机版本**：

- **来自原项目**：Saltline 的单人任务、港口关卡、武器、音效、画面和菜单风格，以及模块化后的代码结构。原游戏最早来自 [Claude Artifact](https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp)。
- **本项目新增**：联机服务器（`server/`）、1v1 对战、6 人大乱斗（排队、旁观、聊天、对讲）、DuoWorld World Package 适配和 Avatar（SWAT Operator、Masked Raider，持枪动作和换弹同步）、攀爬、手机触控与 Home Screen 全屏支持、自适应画质与 30 fps 兜底。
- **目的不同**：原项目的目的是还原并分析 Saltline 的代码结构；本项目是以扩展玩法、让更多人在线玩为目的的独立项目，不是原仓库的镜像，也不会向原仓库提交。

> 许可说明：原项目仓库没有附带 LICENSE 文件。本项目里来自原项目的部分，版权归原作者；仓库里 Three.js 和字体的许可文本在 `licenses/`。本项目新增部分的许可证见 `LICENSE`（如果还没有，请先询问维护者再复用）。

## 自己部署一个服务器

`deploy/` 里有现成的 systemd 单元（`saltline-arena.service`）、nginx 配置（`nginx-saltline.conf`：静态站点 + `/ws` 反向代理到游戏服务器）和 `deploy.sh`（构建并同步到服务器）。游戏服务器只有 Node，没有额外依赖。页面在 HTTPS 站点默认端口上时，会自动连同域名下的 `wss://<域名>/ws`。

## 游戏截图

![Saltline 港口战斗场景](docs/screenshots/saltline-harbor.png)

![Saltline 仓库内换弹动作](docs/screenshots/saltline-reload.png)

![Saltline 港口交火场景](docs/screenshots/saltline-combat.png)

## 本地开发

需要 Node.js 20.19+ 或 22.12+。推荐使用当前 LTS 和 Chrome/Edge 等支持 WebGL 2 的浏览器。

```sh
git clone https://github.com/zhourenjian/saltline-arena.git
cd saltline-arena
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173/>，点击 **Play** 进入大乱斗（本地需要先 `npm run server`），或在 **More modes** 里选 Mission 单人。修改脚本或样式后浏览器会重新加载，当前局会重置。

依赖已经安装时，直接执行 `npm run dev`。游戏、Three.js 和全部字体均在本地，运行期间不需要 Claude、Google Fonts 或其他在线服务，也不需要 API Key。

## 构建和预览

```sh
npm run check
npm run build
npm run preview
```

`npm run build` 生成两份产物：

- `dist/standalone/`：独立网页版，预览地址 <http://127.0.0.1:4173/>。只使用相对路径，可以放到任意静态 HTTP 服务的任意子路径下；应通过 HTTP 打开，以便脚本模块和浏览器输入正常工作。
- `dist/world-package/`：DuoWorld World Package（`world.json` + `world.js` + `assets/`），供 DuoWorld 宿主加载，见下文。

## 主菜单、角色选择、1v1 对战和大乱斗

主菜单提供 **MISSION**（原版单人任务）、**1V1 DUEL**、**BRAWL**（大乱斗）、**CHARACTER**、**SETTINGS** 和 **CONTROLS**。

- **角色选择（CHARACTER）**：在已安装的 Avatar 包之间选择，右侧实时预览，两个警匪风格角色（都戴头套、不露脸）：**SWAT Operator**（中蓝色作战服、头盔、护目镜、防弹背心）和 **Masked Raider**（卡其色夹克、橄榄绿长裤、沙色头套、红围巾），两套都是亮色，在场景里容易分辨。角色本身不带枪，预览时空手；进入游戏后手里拿的就是第一人称那支 PAC-9。选择会保存在 `localStorage`（`saltline.character.v1`）。URL 的 `?avatar=` 和宿主指定的 Avatar 优先于保存的选择。列表由 `index.html` 里的 `window.SaltlineCharacters` 控制：现在只显示这两个，新玩家默认穿 `swat-operator`；原 Operator 和其余 7 个旧角色被隐藏但仍然安装着，`?avatar=girl-purple` 照样能用；以前保存了隐藏角色的玩家会换成默认角色。
- **攀爬**：在箱子或矮墙前按住 **W** 再按 **Space** 翻上去。站在地上能翻 0.62–1.65 m 高的边沿，跳起后在空中能抓住 2.25 m 以内的边沿，更高的墙不能攀爬。攀爬时不能开火。翻越时第三人称身体有具体动作：双手抓住边沿、膝盖蹬上、枪背到身后；爬梯子是交替抓握。换弹和检视（闲置时把枪侧过来看）会同步给其他玩家：别人能看到你卸弹匣、插弹匣、拉机柄。对手的火光和曳光从对方手里那支枪的枪口喷出，第一人称手臂的袖子和手套颜色会按所穿角色换色。
- **1v1 对战**：先启动自带的对战服务器，然后一人创建房间，另一人输入 4 位房间码加入。港口地图，没有 AI，先拿到 5 杀的一方获胜，阵亡 3 秒后在远处重生。

```sh
npm run server                 # 默认监听 0.0.0.0:8787
PORT=9000 npm run server       # 换端口
ALLOWED_ORIGINS=https://example.github.io npm run server   # 只接受这些页面的连接
```

两台电脑在同一局域网时，在对战菜单里填 `ws://<服务器电脑的 IP>:8787`。GitHub Pages 版本是 HTTPS 页面，浏览器要求使用 `wss://`：需要把服务器部署在带 TLS 的反向代理后面。也可以用 `?server=wss://duel.example.com` 预填地址。

对战服务器决定血量、伤害、击杀、比分和出生点，但命中由客户端上报。服务器只做频率和距离检查，**不防作弊**，只适合和朋友对战。

- **伤害**：1v1 和大乱斗中打身体 20、打头 50（满血 100：爆头 2 枪、身体 5 枪）。单人任务里敌人的弱点伤害 ×2.2。
- **名牌**：对手头顶的名字只在镜头到头部之间没有遮挡时显示，并随距离淡出，不会透过集装箱或墙暴露位置。
- **角落读数**：右上角显示 FPS；连上对战服务器时同时显示延时（PING，往返毫秒，绿 / 黄 / 红）。

### 大乱斗（BRAWL）

所有人连到同一个服务器排队。一个场地最多 6 人（可配置）。

- **进入**：大乱斗页面有 **Join the brawl** 和 **Watch only** 两个按钮。Join 不再弹「加入 / 观战」框：有空位直接上场（只有 1 个人时也可以在场地里自由走动，等别人来），满员直接排队观战。Watch only 只观战不排队，之后可以按 J 或底栏按钮排队。
- **有人加入 / 离开**：场地里所有人在屏幕中上方看到提示。
- **满员**：排队并观战。每 60 秒按战绩（击杀多、阵亡少）淘汰最后 1 名（排队 ≥ 6 人时淘汰 2 名），刚进场不满 45 秒的人不会被淘汰；一次上场阵亡 10 次也会下场。被淘汰的人自动重新排到队尾。轮到排队的人时有 15 秒确认（J 或点按钮），超时让给下一位。
- **防卡位**：有人排队时，45 秒不动或 12 秒没有网络数据的玩家会被请下场。
- **人多时**：所有场地都满且排队 ≥ 4 人时开新场地（最多 3 个）。
- **观战**：Q / E 切换跟随的玩家，F 切换上帝视角（WASD 自由飞行，Space / C 升降；只在自己的客户端移动），[ / ] 切换场地。按 **Tab** 释放鼠标（不暂停），可以拖聊天滚动条、点 👎；点一下画面或再按 Tab 回到视角控制。
- **等待名单**：观众在右上角（记分板下面）看到最多 10 个名字。排队的人在前，带号码；只观战的人在后，显示 👁、不显示号码，最新进来的排前面。最后一行是自己的情况：「You are #N of Q in the queue」或「Not in the queue · watching only」。排到第 1 名或座位已经留给自己时，这一行会闪烁提醒。
- **文字聊天**：Enter 打开。每条消息可以被其他观众点 👎，每人对每条只算一次；每个 👎 让作者 10 s × 👎 数之内不能发言。每分钟最多 6 条。
- **语音**：按住 V 或 🎤 按钮抢麦。同时说话的其他人不超过 2 个时可以说 10 秒，最后 5 秒倒计时；每分钟最多抢 3 次。语音自动播放：浏览器要求页面先有一次点击或按键才允许出声，进入大乱斗的那次点击就会解锁；如果还没解锁，会提示「点击或按任意键收听」。**说话的一方必须用 `https://` 或本机地址（`localhost` / `127.0.0.1`）打开页面**：浏览器在 `http://<局域网 IP>` 页面上不提供麦克风，这时会提示原因，但仍能听到别人。
- **聊天和语音只在观众之间**，场上玩家收不到，避免观众给场上的人报点。场上玩家可以在暂停菜单选 **Leave seat · watch** 下场观战。
- **麦克风**：只在按下抢麦时请求权限并录音，松开即关闭；音频只经服务器转发，不保存。

```sh
BRAWL_MAX_PLAYERS=4 BRAWL_CULL_SECONDS=120 BRAWL_CULL_COUNT=2 npm run server
```

可配置项（默认值）：`BRAWL_MAX_PLAYERS`（6，2–12）、`BRAWL_CULL_SECONDS`（60，30–600）、`BRAWL_CULL_COUNT`（1）、`BRAWL_CULL_COUNT_BUSY`（2）、`BRAWL_BUSY_QUEUE`（6）、`BRAWL_DEATH_LIMIT`（10）、`BRAWL_MAX_ARENAS`（3）、`BRAWL_OPEN_ARENA_QUEUE`（4）、`BRAWL_OFFER_SECONDS`（15）、`BRAWL_AFK_SECONDS`（45）、`BRAWL_STALLED_SECONDS`（12）、`BRAWL_MAX_QUEUE`（200）、`BRAWL_MAX_SPECTATORS`（500）、`MAX_CONNECTIONS`（1000）、`MAX_CONNECTIONS_PER_IP`（4）、`TRUST_PROXY=1`（在反向代理后面时从 `X-Forwarded-For` 取地址）。`GET /health` 返回在线人数。

禁言按「IP 地址 + 昵称」记录：同一网络下的其他人不受影响，断线重连也不会解除；但换昵称重连可以绕过。

## DuoWorld World

Saltline 实现了 DuoWorld World Protocol 0.1.0（World ID `saltline.harbor`），可以作为 World Package 被宿主加载，也可以穿戴 Avatar Package。不佩戴 Avatar 时玩法和画面与原版一致。

```js
await window.DuoWorld.setAvatar("girl-purple");   // 运行时切换，不刷新页面
window.DuoWorld.setCameraMode("third-person");    // 或在游戏中按 T
```

- 安装 Avatar：把包目录放进 `public/avatars/<id>/`（入口 `avatar.js`），不需要改 World 代码。警匪角色 `swat-operator`、`masked-raider` 由 `node scripts/build-soldier-avatars.mjs` 生成（程序化身体和动作；包不带枪，枪由 World 通过 `weapon` 挂点和 `held` 抓握框交到手里，见 `docs/DUOWORLD.md`）。另有 7 个旧角色：`girl-purple`（Sakura Girl），以及 6 个方块角色 `violet-girl` 紫衣少女、`voxel-walker` 墨衣行者、`blue-captain` 蓝衣船长、`orange-mechanic` 橙衣机师、`jade-swordswoman` 青衣侠女、`red-runner` 红衣跑者（新角色由 `node scripts/build-avatar-models.mjs` 生成）。
- 统一身高：World 把每个 Avatar 的外形按 `1.75 / metadata.height` 等比缩放，所有角色画面上一样高；对战命中盒本来就是固定胶囊（半径 0.42 m、高 1.8 m），与外形无关。
- 默认 Avatar：在 `index.html` 中设置 `window.DuoWorldInitialAvatar = "<id>"`，或使用 URL 参数 `?avatar=<id>&view=third`。
- 测试：`npm test`（headless Chrome，覆盖协议要求的 15 个测试项，结果写入 `tests/out/`）。
- Avatar 脚本以页面权限运行，**没有对不可信代码做沙箱隔离**。

接口、生命周期、能力声明、安全边界、兼容性测试结果和已知限制见 [`docs/DUOWORLD.md`](docs/DUOWORLD.md)。

## GitHub Pages 部署

仓库已启用 GitHub Pages，发布来源为 **GitHub Actions**。[部署工作流](https://github.com/realskyrin/fps3ademo-saltline/actions/workflows/pages.yml) 在推送到 `main` 时自动运行，也可通过 **Run workflow** 手动触发。工作流检查 Pages 配置，执行 `npm ci`、`npm run check` 和 `npm run build`，然后发布 `dist/standalone/`。

在其他仓库使用这套工作流时，需要先到 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，否则部署接口会返回 404。

## 继续修改

| 文件 | 内容 |
| --- | --- |
| `index.html` | 页面入口、画布、启动界面 |
| `src/game.js` | 启动入口：创建 World 和 RuntimeBridge |
| `src/duoworld/` | DuoWorld 协议层：WorldAdapter、AvatarHost、RuntimeBridge、World 对象、清单和 World Package 入口 |
| `public/avatars/` | Avatar Package（每个目录一个包） |
| `src/app/` | 系统装配、主循环、启动界面、诊断和基准模式 |
| `src/vendor/three-r180.js` | 独立保存的原版 Three.js r180，提供标准命名的导出 |
| `src/core/` | 世界/画质配置、事件、随机数、数学、通用几何和降级实现 |
| `src/render/` | 渲染器、天空、阴影、后处理、材质、纹理和着色器 |
| `src/world/` | 碰撞、道具注册与建模、关卡、远景、地面和水面 |
| `src/input/`、`src/player/`、`src/combat/` | 输入、玩家和战斗判定 |
| `src/weapons/`、`src/enemies/` | 武器/敌人的模型、动画和行为 |
| `src/audio/`、`src/effects/` | 声音合成、音库、混音、粒子和特效 |
| `src/ui/`、`src/game/` | HUD、菜单、设置和任务流程 |
| `src/ui.css` | 原版 HUD、菜单、移动端布局和动效 |
| `src/fonts.css`、`public/fonts/` | 原版三组字体的本地副本 |
| `vite.config.js` | 开发服务器、独立版构建和 source map 配置 |
| `vite.world.config.js`、`scripts/build-world-package.mjs` | World Package 构建 |
| `src/versus/`、`src/brawl/`、`server/` | 1v1 对战、大乱斗客户端和零依赖 WebSocket 服务器 |
| `tests/` | DuoWorld 兼容性、对战、大乱斗、梯子的自动化测试，测试用 Avatar 和参考宿主 |
| `docs/DUOWORLD.md` | DuoWorld 接入说明和兼容性报告 |
| `archive/original.html` | 与原站发布清单逐字节校验一致的原始单文件 |
| `archive/manifest.json` | 来源、发布版本、原始大小与 SHA-256 |
| `docs/DEVELOPMENT.md` | 游戏代码定位和诊断入口 |
| `docs/VALIDATION.md` | 本次恢复的验收结果 |
| `docs/REFACTOR_VALIDATION.md` | 模块拆分的代码、场景、截图与操作回归记录 |
| `licenses/` | Three.js 与字体的许可文本 |

**源码边界：**公开链接只提供一个已打包的 `index.html`，没有发布前的多文件源码、原始变量名或 source map。本地在恢复完整产物后，将它重新组织为 66 个 ES 模块，并为引擎导入、主要工厂函数和上下文参数补充了可读名称。复杂算法内部仍有原版压缩过的局部变量名。模块边界是本地重建的，构建生成的 source map 对应当前本地文件。

## 操作

| 动作 | 按键 |
| --- | --- |
| 移动 / 视角 | WASD / 鼠标 |
| 开火 / 瞄准 | 鼠标左键 / 右键 |
| 换弹 / 近战 | R / F |
| 跳跃 / 冲刺 | Space / Shift |
| 攀爬 | 在矮墙或箱子前按住 W + Space |
| 爬梯子 | 在梯子前按 E（或按住 W + Space）抓住，W / S 上下，Space 跳离；码头起重机腿旁的梯子通往楼梯塔、中层走道和吊臂走道 |
| 蹲下 | C 或 Ctrl |
| 切断中继 | 在中继附近按住 E |
| 暂停 | Esc 或 P |
| 大乱斗：接受上场 / 观战切人 / 上帝视角 / 聊天 / 抢麦 / 切场地 / 释放鼠标 | J / Q E / F / Enter / 按住 V / [ ] / Tab |
| 第一 / 第三人称（佩戴 Avatar 时） | T |

浏览器无法锁定鼠标时，原版也支持按住鼠标拖动视角，或方向键 / IJKL 转向、Enter 开火。触屏和手柄支持沿用原版，具体布局在 **CONTROLS** 中查看。

设置保存在当前浏览器的 `localStorage`：设置在 `saltline.settings.v1`，角色选择在 `saltline.character.v1`，对战服务器地址和昵称在 `saltline.versus.v1`。本地地址与原站的浏览器存储相互独立。

## 原件校验

恢复日期：2026-11-10；公开版本：`1794242702-61c7`。

```sh
npm run verify:archive
```

原件大小为 1,423,413 字节，SHA-256：

```text
f7081ef7b2fde5880e3c58184c720b2aa3b9115efe58ff71b48f6820d4f16f90
```

原件保留原始 Google Fonts 链接；本地开发入口使用已下载的字体。Claude 的页面外壳与注入运行时未加入本地游戏。

## 手机和平板

浏览器标签页里地址栏和工具栏会占掉屏幕，旋转时还可能错位。用 Safari（iOS）分享 ▸ 添加到主屏幕，或 Chrome（Android）菜单 ▸ 安装应用，再从主屏幕图标打开，就是全屏。游戏在标题页会给出分平台的步骤。大乱斗里右上角的 MENU 按钮打开暂停菜单（调整设置、退出比赛）。大乱斗是无限弹药。
