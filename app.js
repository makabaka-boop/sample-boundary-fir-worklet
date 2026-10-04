/*
 * app.js —— 页面逻辑。
 *
 * 数据流（无任何离线卷积，页面展示与下载只用处理器回传的块）：
 *   确定性测试信号(AudioBuffer 循环) -> AudioWorkletNode(因果 FIR) -> 零增益 -> destination
 *                                        |
 *                                        +-- port 回传 block/applied/ack --> 绘制 + 下载
 *
 * 时间基准：换参目标一律是“处理器本轮已处理样本数”这一时钟，页面不用任何计时器调度。
 */
'use strict';

const $ = (id) => document.getElementById(id);

const app = {
  ctx: null,
  node: null,
  gain0: null,
  source: null,
  runId: 0, // 0 = 尚未开轮；每次显式重置 +1
  seq: 0, // 本轮已发命令数（下一条命令序号 = seq+1）
  clock: 0, // 由 block 消息推得的处理器本轮已处理样本数
  capturedChunks: [], // 处理器回传的输出块（原样保存，追加即只读）
  capturedLen: 0,
  contiguous: true, // 块下标是否严丝合缝
  currentTaps: 1,
  sentCommands: new Map(), // seq -> coefs（用于在生效时显示系数组长度）
  appliedMarks: [], // 生效位置标记（画竖线）
  drawRing: new Float32Array(8192), // 最近样本的滚动窗口（仅用于绘制）
  drawLen: 0,
  drawPos: 0,
  dirty: true,
  events: [], // 全部 worklet 消息（测试钩子也用）
};

function logLine(text) {
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += text + '\n';
  const lines = el.textContent.split('\n');
  if (lines.length > 400) el.textContent = lines.slice(-400).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function ensureGraph() {
  if (app.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  app.ctx = new AC();
  app.sampleRate = app.ctx.sampleRate;

  // 核心引擎与处理器拼接后从 Blob 加载，保证 worklet 跑的就是 fir-engine.js 本身
  const [engineSrc, processorSrc] = await Promise.all([
    fetch('fir-engine.js').then((r) => r.text()),
    fetch('worklet-processor.js').then((r) => r.text()),
  ]);
  const blob = new Blob([engineSrc, '\n', processorSrc], { type: 'application/javascript' });
  await app.ctx.audioWorklet.addModule(URL.createObjectURL(blob));

  // 确定性单声道测试信号：1 秒循环缓冲，频率为整数赫兹故循环处无缝
  const len = app.ctx.sampleRate;
  app.signalBuf = app.ctx.createBuffer(1, len, app.ctx.sampleRate);
  app.signalBuf.copyToChannel(TestSignal.makeTestSignal(len, app.ctx.sampleRate), 0);

  app.node = new AudioWorkletNode(app.ctx, 'fir-run-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  app.node.port.onmessage = (e) => onWorkletMessage(e.data);

  app.gain0 = app.ctx.createGain(); // 零增益监听：只为拉动图，不放音
  app.gain0.gain.value = 0;
  app.node.connect(app.gain0);
  app.gain0.connect(app.ctx.destination);
}

function onWorkletMessage(msg) {
  // 事件日志只存元信息（块数据进 capturedChunks），并限制总长度
  if (msg.type === 'block') {
    app.events.push({ type: 'block', runId: msg.runId, start: msg.start, length: msg.samples.length });
  } else {
    app.events.push(msg);
  }
  if (app.events.length > 20000) app.events.splice(0, app.events.length - 20000);
  switch (msg.type) {
    case 'ready':
      logLine('[worklet] 处理器就绪');
      break;
    case 'resetAck':
      logLine(
        `[worklet] 新一轮已就绪：运行代号 ${msg.runId}，起始帧 ${msg.startFrame}` +
          (msg.late ? '（警告：重置消息到达时起始帧已过去，本轮起点可能与信号源不对齐）' : '，时钟与历史已清空')
      );
      break;
    case 'started':
      logLine(`[worklet] 第 ${msg.runId} 轮在渲染帧 ${msg.startFrame} 开始计样`);
      break;
    case 'ack': {
      if (msg.accepted) {
        let extra = '';
        if (msg.supersedes != null) extra = `，顶掉同下标命令 #${msg.supersedes}`;
        if (msg.supersededBy != null) extra = `，但被同下标命令 #${msg.supersededBy} 裁决出局`;
        logLine(`[接纳] 命令 #${msg.seq}（目标样本 ${msg.target}）${extra}`);
      } else {
        logLine(`[拒绝] 命令 #${msg.seq}（目标样本 ${msg.target}）：${msg.reason}`);
      }
      break;
    }
    case 'applied': {
      const coefs = app.sentCommands.get(msg.seq);
      app.currentTaps = coefs ? coefs.length : app.currentTaps;
      app.appliedMarks.push({ at: msg.effectiveAt, seq: msg.seq });
      logLine(`[生效] 命令 #${msg.seq} 在实际样本位置 ${msg.effectiveAt} 整组换入`);
      break;
    }
    case 'block': {
      if (msg.runId !== app.runId) {
        logLine(`[警告] 丢弃旧代号 ${msg.runId} 的输出块（当前代号 ${app.runId}）`);
        break;
      }
      if (msg.start !== app.capturedLen) {
        app.contiguous = false;
        logLine(`[警告] 输出块下标不连续：期望 ${app.capturedLen}，实到 ${msg.start}`);
      }
      app.capturedChunks.push(msg.samples);
      app.capturedLen += msg.samples.length;
      app.clock = msg.start + msg.samples.length;
      // 写入滚动绘制窗口
      for (let i = 0; i < msg.samples.length; i++) {
        app.drawRing[app.drawPos] = msg.samples[i];
        app.drawPos = (app.drawPos + 1) % app.drawRing.length;
      }
      app.drawLen = Math.min(app.drawLen + msg.samples.length, app.drawRing.length);
      app.dirty = true;
      break;
    }
  }
  app.dirty = true;
}

/* 开始 / 显式重置：开新代号、清空时钟与历史；旧代号指令从此一律被拒绝。
   信号源与处理器门控对齐到同一渲染帧，使本轮样本 0 恰好是信号缓冲的第 0 个样本。 */
async function startNewRun() {
  await ensureGraph();
  app.runId += 1;
  app.seq = 0;
  app.clock = 0;
  app.capturedChunks = [];
  app.capturedLen = 0;
  app.contiguous = true;
  app.currentTaps = 1;
  app.sentCommands.clear();
  app.appliedMarks = [];
  app.drawRing.fill(0);
  app.drawLen = 0;
  app.drawPos = 0;
  app.dirty = true;
  if (app.source) {
    try {
      app.source.stop();
    } catch (_) {
      /* 旧源可能已停 */
    }
    app.source.disconnect();
  }
  // 对齐到渲染量边界：源在该帧启动，处理器在同一帧开始计样
  const nowFrame = Math.ceil(app.ctx.currentTime * app.ctx.sampleRate);
  const startFrame = Math.ceil((nowFrame + 4096) / 128) * 128;
  app.source = app.ctx.createBufferSource();
  app.source.buffer = app.signalBuf;
  app.source.loop = true;
  app.source.connect(app.node);
  app.source.start(startFrame / app.ctx.sampleRate);
  app.node.port.postMessage({ type: 'reset', runId: app.runId, startFrame });
  if (app.ctx.state !== 'running') await app.ctx.resume();
  logLine(`[页面] 开始第 ${app.runId} 轮（显式重置），起始帧 ${startFrame}`);
  updateStatus();
}

/* 暂停/恢复：只动 AudioContext，处理器时钟与滤波历史原样保留。 */
async function pauseCtx() {
  if (app.ctx && app.ctx.state === 'running') {
    await app.ctx.suspend();
    logLine(`[页面] AudioContext 已暂停（处理器时钟停在样本 ${app.clock}，历史保留）`);
  }
  updateStatus();
}

async function resumeCtx() {
  if (app.ctx && app.ctx.state === 'suspended') {
    await app.ctx.resume();
    logLine('[页面] AudioContext 已恢复，时钟与历史从暂停处继续');
  }
  updateStatus();
}

function parseCoefs(text) {
  const parts = text.split(/[\s,;]+/).filter((s) => s.length > 0);
  const coefs = parts.map(Number);
  if (coefs.length < 1 || coefs.length > 128) {
    throw new Error(`系数个数须在 1..128 之间，当前 ${coefs.length}`);
  }
  if (!coefs.every(Number.isFinite)) throw new Error('系数必须全部是有限数值');
  return coefs;
}

/* 发送换参指令：{runId, seq, target, coefs}，序号由页面按轮递增。 */
function sendCommand() {
  if (!app.node || app.runId === 0) {
    logLine('[页面] 尚未开轮，请先点击“开始 / 新一轮”');
    return;
  }
  let coefs;
  try {
    coefs = parseCoefs($('coefs').value);
  } catch (err) {
    logLine(`[页面] 系数无效：${err.message}`);
    return;
  }
  const target = Number($('target').value);
  if (!Number.isInteger(target) || target < 0) {
    logLine('[页面] 目标样本下标必须是非负整数');
    return;
  }
  app.seq += 1;
  app.sentCommands.set(app.seq, coefs);
  app.node.port.postMessage({ type: 'command', runId: app.runId, seq: app.seq, target, coefs });
  logLine(`[发送] 命令 #${app.seq}：代号 ${app.runId}，目标样本 ${target}，${coefs.length} 个系数`);
  updateStatus();
}

/* 下载：把处理器回传的块原样拼成 Float32 单声道 WAV，绝不再做离线卷积。 */
function capturedSamples() {
  const out = new Float32Array(app.capturedLen);
  let off = 0;
  for (const c of app.capturedChunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeWavFloat32(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 4);
  const v = new DataView(buf);
  const wstr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 4, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  wstr(36, 'data');
  v.setUint32(40, samples.length * 4, true);
  for (let i = 0; i < samples.length; i++) v.setFloat32(44 + i * 4, samples[i], true);
  return buf;
}

function downloadWav() {
  if (app.capturedLen === 0) {
    logLine('[页面] 尚无捕获数据可下载');
    return;
  }
  const samples = capturedSamples();
  const blob = new Blob([encodeWavFloat32(samples, app.ctx.sampleRate)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fir-run-${app.runId}-${samples.length}samples.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  logLine(`[页面] 已导出 ${samples.length} 个样本（运行代号 ${app.runId} 的实际输出）`);
}

/* ---------- 界面刷新与绘制 ---------- */

function updateStatus() {
  $('runId').textContent = app.runId === 0 ? '（未开轮）' : String(app.runId);
  $('clock').textContent = String(app.clock);
  $('ctxState').textContent = app.ctx ? app.ctx.state : '未创建';
  $('captured').textContent = `${app.capturedLen}${app.contiguous ? '' : '（不连续！）'}`;
  $('taps').textContent = String(app.currentTaps);
  $('nextSeq').textContent = String(app.seq + 1);
}

function draw() {
  requestAnimationFrame(draw);
  if (!app.dirty) return;
  app.dirty = false;
  updateStatus();
  const canvas = $('plot');
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = '#101418';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a3138';
  g.beginPath();
  g.moveTo(0, H / 2);
  g.lineTo(W, H / 2);
  g.stroke();
  const win = Math.min(app.drawLen, 4096);
  if (win < 2) return;
  const startIdx = app.capturedLen - win; // 窗口第一个样本的绝对下标
  const ringStart = (app.drawPos - win + app.drawRing.length) % app.drawRing.length;
  g.strokeStyle = '#4fc3f7';
  g.beginPath();
  for (let i = 0; i < win; i++) {
    const v = app.drawRing[(ringStart + i) % app.drawRing.length];
    const x = (i / (win - 1)) * W;
    const y = H / 2 - (v * H) / 2.4;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  // 生效位置竖线标记
  g.strokeStyle = '#ffb74d';
  g.fillStyle = '#ffb74d';
  g.font = '11px monospace';
  for (const m of app.appliedMarks) {
    if (m.at < startIdx || m.at >= app.capturedLen) continue;
    const x = ((m.at - startIdx) / (win - 1)) * W;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
    g.fillText(`#${m.seq}@${m.at}`, Math.min(x + 3, W - 90), 12);
  }
}

/* ---------- 预设系数（仅编辑系数组，与输出计算无关） ---------- */

function presetLowpass(taps, fc) {
  const h = [];
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const x = k - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)); // Hamming
    h.push(sinc * win);
    sum += sinc * win;
  }
  return h.map((v) => v / sum);
}

function setPreset(name) {
  let c;
  if (name === 'identity') c = [1];
  else if (name === 'avg2') c = [0.5, 0.5];
  else if (name === 'diff') c = [1, -1];
  else if (name === 'avg8') c = new Array(8).fill(1 / 8);
  else if (name === 'lp64') c = presetLowpass(64, 0.08);
  else if (name === 'lp128') c = presetLowpass(128, 0.04);
  $('coefs').value = c.map((v) => Number(v.toFixed(8))).join(', ');
}

/* ---------- 测试钩子（浏览器自动化用，页面行为不变） ---------- */

window.__app = {
  state: () => ({
    runId: app.runId,
    seq: app.seq,
    clock: app.clock,
    capturedLen: app.capturedLen,
    contiguous: app.contiguous,
    currentTaps: app.currentTaps,
    ctxState: app.ctx ? app.ctx.state : 'none',
    sampleRate: app.ctx ? app.ctx.sampleRate : 0,
  }),
  events: app.events,
  capturedSamples,
  sendRawCommand: (cmd) => app.node && app.node.port.postMessage({ type: 'command', ...cmd }),
  startNewRun,
  pauseCtx,
  resumeCtx,
};

$('btnStart').addEventListener('click', () => startNewRun());
$('btnPause').addEventListener('click', () => pauseCtx());
$('btnResume').addEventListener('click', () => resumeCtx());
$('btnSend').addEventListener('click', () => sendCommand());
$('btnDownload').addEventListener('click', () => downloadWav());
document.querySelectorAll('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => setPreset(b.dataset.preset))
);
updateStatus();
requestAnimationFrame(draw);
