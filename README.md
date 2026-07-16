# TH07 Web - Perfect Cherry Blossom

**在线游玩 / Play online: <https://agentmystia.github.io/th07_web/>**

[中文](#中文) | [English](#english)

## 中文

> 这里是米斯蒂娅·萝蕾拉。我把这份复刻当作一首需要反复校音的夜曲：
> 原作数据和 `Th07.exe` 能回答的地方，就不凭印象补写。

这是《东方妖々梦 ～ Perfect Cherry Blossom》(TH07) 的 TypeScript
浏览器复刻。引擎直接解析并执行内嵌的原作 ECL / STD / ANM / MSG / SHT
二进制数据，以此驱动关卡、弹幕、Boss、自机、背景、对话与 UI；从
`Th07.exe` 逆向得到的常量会在代码中标明版本、地址和依据。

本项目延续自 TH06 Web 的开发经验；TH06 版本完整保留在
[th6_web](https://github.com/AgentMystia/th6_web) 的 `legacy-vanilla`
分支，本仓库只包含 TH07 浏览器应用及其运行资源。

### 当前状态

- **Stage 1-8 均由原作数据驱动并可游玩。** 当前高还原目标是主线
  Stage 1-6；Extra / Phantasm 已可进入和通关，但验证置信度较低。
- 标题、难度、角色与符卡类型选择使用原作 `title01.anm` 脚本和美术；
  支持灵梦 / 魔理沙 / 咲夜各 A/B，以及 Extra Start。
- 自机直接读取原作 `.sht`：移动速度、判定、擦弹、火力分段、
  Deathbomb 窗口和 30 帧射击周期均来自数据。自机弹使用逐发 ANM VM，
  包括魔理沙 B 持续激光和魔理沙 A 重复命中的爆炸。
- 12 种聚焦状态锁定的 Bomb 形态使用各自的移动攻击槽；咲夜 B 的时停
  脉冲、空间消弹和伤害范围不再使用统一的全屏近似。
- Cherry / CherryMax / Cherry+ 与 **森罗结界** 已实现：50000 Cherry+
  触发 540 帧结界，被弹或 Bomb 会执行灵击式 Border Break，并把取消弹
  转为自动回收的小樱点。
- STD 相机、雾、透视地面和层叠树木构成 3D 舞台背景；Boss 战循环、
  全局慢速和后段背景 ANM bank 均由原始脚本推进。
- Stage Clear 使用原作 `capture.anm` 捕获画面和 12x14 翻片动画，平滑
  进入下一关；分数、残机、Bomb、Power、Graze 与 Cherry 会随流程继承，
  并实现三次 Continue。
- HUD 使用 `front.png` / `ascii.png`，BGM 全曲目按 `thbgm.fmt` 的采样级
  循环点无缝播放，音效来自原作 WAV。

> 还原度不是一句“能运行”就算完成。主要近似与证据状态见
> [AGENTS.md §7](AGENTS.md#7-approximations-registry-known-flagged-improvable)；
> 发现差异时，欢迎附上关卡、难度、机体、帧数或截图反馈。

### 操作

- 方向键：移动
- `Shift`：低速（显示判定点）
- `Z` / `Enter`：确认 / 射击
- `X`：Bomb / 返回
- `Ctrl`：快进对话
- `Esc`：暂停

低延迟画面输出默认开启：支持的浏览器（Chrome/Edge）会绕过合成器队列，
输入到上屏的延迟减少 1–2 个垂直同步周期；Firefox/Safari 自动走标准
路径，行为不变。若遇到画面异常（闪烁、黑屏），在地址栏加 `?desync=0`
即可关闭。

### 本地运行

```sh
npm ci
npm run build      # 生成 dist/th07.js（esbuild IIFE）
# 然后直接打开 index.html，或：
npm run dev        # 监听构建并启动本地静态服务
```

完整校验：

```sh
npm run check
npm run build
npm test
node scripts/dev-shot.mjs /tmp/s.png 800 "difficulty=3"
node scripts/pixel-report.mjs /tmp/s.png
```

无头工具会输出游戏状态快照和画面区域统计；视觉或玩法改动不能只靠
“编译通过”判断。

### 项目地图

目录与运行边界见 [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)。
格式事实、验证流程和协作规范见 [AGENTS.md](AGENTS.md)。

### 本地参考资料（不提交）

`reference/` 已被 git 忽略，浏览器运行时不会读取它。继续做高还原度
开发，需要从合法持有的 TH07 原版解包 `reference/th07-original/`，并在
本地准备 `reference/Th07.exe` v1.00b 以及
`reference/ECL7|DSTD7|MSG7|ANM7` 的可读反汇编。常用工具来自
[thtk](https://github.com/thpatch/thtk)：`thdat -x7`、`thecl -d7`、
`thstd -d7`、`thmsg -d7`、`thanm -l7`。

准备完成后，可运行 `npm run generate-data` 重建内嵌数据，或运行
`npm run generate-bgm` 按原循环点切分 BGM。`reference/` 中的内容绝不
提交、发布或由浏览器加载。

### 已知差距

- 已建成基于原版 .rpy replay 的逐帧黄金验证工作流（`npm run replay:verify`，
  解析器 `src/formats/rpy.ts`，规格 reference/re-specs/exe-replay.md）：以原作
  引擎写下的逐面状态快照为校验点、以「原局玩家不该死」为存活不变量逐帧回放。
  当前尚未全面通过（对齐战役进行中），因此仍不宣称逐帧一致——但差距首次可
  机判、可定位到帧。
- Extra / Phantasm 的覆盖与逆向证据少于 Stage 1-6；其开局 Bomb / Power
  仍采用社区惯例，状态为 PROBABLE。
- Practice Start 已接入；Replay 可在浏览器中选择并播放本地原版 `.rpy`
  （含关卡选择与三种原版播放模式）。Result、Music Room、Option、Quit
  尚未接入；结局、replay 保存和 `score.dat` 持久化也未实现。
- Bomb 的共享演出层、符卡宣言、Boss 底部位置标记和部分后段大弹贴图
  映射仍有已标记的近似。更多细节见
  [AGENTS.md §7](AGENTS.md#7-approximations-registry-known-flagged-improvable)。

### 支持（可选）

觉得这个项目有趣，想请我喝杯咖啡的话：**USDT (ERC-20)**

```text
0x906BEA71D60EB556a70DFfc51B0057FC853470A4
```

### 版权

本项目是非商业粉丝复刻与技术研究项目。东方 Project 及
《东方妖々梦》的角色、音乐、图像等版权归上海爱丽丝幻乐团 (ZUN) 与
相关权利方所有。仓库仅包含浏览器运行所需的资源子集，不分发原版游戏。

---

## English

> Mystia Lorelei here. I treat this remake like a night song that needs
> careful tuning: when the original data or `Th07.exe` can answer a question,
> I do not fill it in from memory.

This is a TypeScript browser reimplementation of *Touhou Youyoumu ~ Perfect
Cherry Blossom* (TH07). The engine embeds, parses, and executes the original
ECL / STD / ANM / MSG / SHT binaries to drive stages, danmaku, bosses, the
player, backgrounds, dialogue, and UI. Constants recovered from `Th07.exe`
carry version, address, and provenance comments in the source.

The project builds on experience from TH06 Web. That version is preserved in
full on the `legacy-vanilla` branch of
[th6_web](https://github.com/AgentMystia/th6_web); this repository contains
only the TH07 browser application and its runtime assets.

### Current status

- **Stages 1-8 are data-driven and playable.** Original-grade Stage 1-6
  fidelity is the current target. Extra and Phantasm can be entered and
  cleared, but have lower verification confidence.
- Title, difficulty, character, and shot-type selection use the original
  `title01.anm` scripts and artwork. Reimu, Marisa, and Sakuya A/B are
  available, along with Extra Start.
- Player behavior comes from the original `.sht` files: speed, hitboxes,
  graze radii, power brackets, deathbomb windows, and the 30-frame firing
  cycle. Every shot runs its own ANM VM, including Marisa B's persistent
  beams and Marisa A's repeat-hit explosions.
- All 12 focus-latched bomb forms use their own moving attack slots. Sakuya
  B's time-stop pulses, cancellation regions, and damage are no longer a
  shared full-screen approximation.
- Cherry / CherryMax / Cherry+ and the **Supernatural Border** are present.
  The Border triggers at 50,000 Cherry+, lasts 540 frames, and a hit or bomb
  performs the spiritual-strike-style Border Break, turning cancelled bullets
  into auto-collecting small Cherry items.
- STD camera, fog, perspective ground, and sprite-stacked trees build the 3D
  stage backgrounds. Boss loops, global slow motion, and late-stage ANM banks
  are advanced by the original scripts.
- Stage Clear uses the original `capture.anm` playfield capture and 12x14 tile
  wipe for a smooth handoff to the next stage. Score, lives, bombs, power,
  graze, and Cherry carry forward, and the three-continue flow is implemented.
- The HUD uses `front.png` / `ascii.png`. The complete soundtrack loops at
  sample-exact `thbgm.fmt` points, with sound effects from the original WAVs.

> Fidelity is more than reaching a playable screen. The maintained registry
> of major approximations and evidence status lives in
> [AGENTS.md §7](AGENTS.md#7-approximations-registry-known-flagged-improvable).
> When reporting a mismatch, stage, difficulty, shot type, frame, or screenshot
> details are useful.

### Controls

- Arrow keys: move
- `Shift`: focus (shows the hitbox)
- `Z` / `Enter`: confirm / shoot
- `X`: bomb / back
- `Ctrl`: fast-forward dialogue
- `Esc`: pause

Low-latency presentation is on by default: browsers that support it
(Chrome/Edge) bypass the compositor queue, cutting input-to-photon latency
by 1–2 vsyncs; Firefox/Safari automatically use the standard path,
unchanged. If you ever see rendering artifacts (flicker, black screen),
append `?desync=0` to the URL to turn it off.

### Run locally

```sh
npm ci
npm run build      # generate dist/th07.js (esbuild IIFE)
# then open index.html directly, or:
npm run dev        # watch builds and serve the static app
```

Full validation:

```sh
npm run check
npm run build
npm test
node scripts/dev-shot.mjs /tmp/s.png 800 "difficulty=3"
node scripts/pixel-report.mjs /tmp/s.png
```

The headless tools print state snapshots and numeric image-region reports.
Gameplay and rendering changes are not considered verified merely because
they compile.

### Project map

See [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) for the repository
layout and runtime boundary. File-format facts, verification rules, and the
contributor workflow live in [AGENTS.md](AGENTS.md).

### Local reference corpus (never committed)

`reference/` is git-ignored and is never read by the browser runtime.
High-fidelity work requires a legally owned TH07 copy unpacked into
`reference/th07-original/`, `reference/Th07.exe` v1.00b, and readable
disassemblies under `reference/ECL7|DSTD7|MSG7|ANM7`. The usual tools come
from [thtk](https://github.com/thpatch/thtk): `thdat -x7`, `thecl -d7`,
`thstd -d7`, `thmsg -d7`, and `thanm -l7`.

With those files prepared, `npm run generate-data` rebuilds the embedded data
and `npm run generate-bgm` re-slices BGM at the original loop points. Nothing
under `reference/` is committed, deployed, or loaded by the browser.

### Known gaps

- A frame-by-frame replay-golden verification workflow now exists
  (`npm run replay:verify`; parser `src/formats/rpy.ts`; spec
  reference/re-specs/exe-replay.md): original .rpy replays are replayed
  headlessly against per-stage snapshots the original engine recorded, with
  "the original player must survive" as a per-frame invariant. It does not
  fully pass yet (the alignment campaign is ongoing), so frame-level parity
  is still not claimed — but the gap is now machine-checkable and localized
  to exact frames.
- Extra and Phantasm have less coverage and executable evidence than Stages
  1-6. Their initial bomb/power values remain community-convention PROBABLEs.
- Practice Start is wired, and Replay can load and play a browser-local
  original `.rpy` with stage selection and the three original playback modes.
  Result, Music Room, Option, and Quit are not wired. Endings, replay saving,
  and persistent `score.dat` state are not implemented.
- The shared bomb presentation layer, spell declaration, bottom-edge boss
  marker, and some late-stage large-bullet texture mapping remain explicitly
  marked approximations. See
  [AGENTS.md §7](AGENTS.md#7-approximations-registry-known-flagged-improvable)
  for further details.

### Support (optional)

If you enjoyed the project and feel like leaving a coffee-sized tip:
**USDT (ERC-20)**

```text
0x906BEA71D60EB556a70DFfc51B0057FC853470A4
```

### Copyright

This is a non-commercial fan reimplementation and technical research project.
Touhou Project and *Perfect Cherry Blossom*, including their characters,
music, and artwork, belong to Team Shanghai Alice (ZUN) and their respective
rights holders. The repository ships only the runtime asset subset and does
not distribute the original game.
