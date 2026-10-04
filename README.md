# 本地音频 FIR 实验台

一个纯本地的音频实验页：用**真实 AudioWorklet** 对**确定性单声道测试信号**做**因果 FIR**（系数 ≤ 128 个），支持按样本精度换参。不调用 `ConvolverNode`，不做 FFT、多轨或麦克风采集。

## 运行

```bash
node serve.mjs          # 然后浏览器打开 http://127.0.0.1:8080/
```

（任何静态服务器都可以，AudioWorklet 要求 localhost 等安全上下文。）

## 测试

```bash
npm install                          # 仅浏览器测试需要 playwright
npx playwright install chromium      # 首次
npm test                             # = 核心对拍 + 真实浏览器流程
npm run test:core                    # 只跑核心逻辑对拍（不需要浏览器）
npm run test:browser                 # 只跑真实浏览器 Worklet 流程
```

无 root 环境若缺 Chromium 系统库，可用 `apt-get download` 把依赖 deb 解压到
`~/.local/pw-libs`，测试脚本检测到该目录会自动注入 `LD_LIBRARY_PATH`。

## 架构

```
确定性测试信号(test-signal.js, AudioBuffer 循环)
        │
        ▼
AudioWorkletNode ── fir-engine.js（核心 FIR 状态机，与 Node 测试共用同一份代码）
        │              worklet-processor.js（只转发消息，不含滤波逻辑）
        ▼
零增益 GainNode → destination（拉动图，不放音）
        │
        └─ port 回传 ack / applied / block ──► 页面绘制 + WAV 下载
```

- `fir-engine.js` —— 核心引擎。时钟 = 本轮已处理样本数；换参指令
  `{runId, seq, target, coefs}` 在计算第 `target` 个样本**之前一次性整组换入**，
  单个输出样本绝不混用两组系数；输入历史（128 样本环形缓冲）跨渲染块保留。
- 同一 `target` 只保留 `seq` 最大者（命令序号裁决）；`target < clock` 的指令到达即
  拒绝（`late`），任何情况下不回写已生成样本。
- 只有显式重置才开新代号：时钟归零、历史与待生效指令清空；旧代号指令 `stale-run` 拒绝。
  每轮第 0 个样本由 `startFrame`（渲染帧，与信号源启动时刻对齐）界定。
- 暂停/恢复只调 `AudioContext.suspend()/resume()`，处理器状态原样保留。
- 页面绘制与 WAV 下载**只使用处理器回传的输出块**，不做任何离线卷积冒充。

## 测试覆盖

- `tests/test-core.mjs`：14 种分块长度（1…5000）× 5000 样本与逐样本参考卷积**逐位相等**；
  覆盖块内换参、系数长度 1/2/64/128/7 变化、同下标裁决、迟到拒绝、显式重置、边界校验。
- `tests/test-browser.mjs`：真实 Chromium + AudioWorklet 全流程——消息链路（接纳/生效/拒绝）、
  捕获数值与独立参考一致、暂停/恢复时钟冻结与续走、重置与旧代号隔离、WAV 下载逐位一致。
