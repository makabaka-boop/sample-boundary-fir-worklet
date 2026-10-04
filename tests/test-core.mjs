/*
 * test-core.mjs —— 核心处理逻辑对拍测试。
 *
 * 用多种分块长度把同一段输入喂给 FirRunEngine，与逐样本参考卷积逐一比对
 * （两者浮点运算顺序一致，要求完全相等）。覆盖：
 *   - 块内换参（目标下标落在渲染块中间）
 *   - 系数长度变化（1 -> 64 -> 128 -> 1 -> 7）
 *   - 同一下标多命令按序号裁决
 *   - 迟到指令拒绝且不影响已生成样本
 *   - 显式重置：时钟归零、历史清空、旧代号指令被拒、旧待生效指令失效
 */
import assert from 'node:assert/strict';
import FirEnginePkg from '../fir-engine.js';
import TestSignalPkg from '../test-signal.js';

const { FirRunEngine, MAX_TAPS } = FirEnginePkg;
const { makeTestSignal } = TestSignalPkg;

const SR = 48000;

/* 确定性系数组生成（仅测试用，与页面无关） */
function lowpass(m, fc) {
  const h = new Float32Array(m);
  const mid = (m - 1) / 2;
  let sum = 0;
  for (let k = 0; k < m; k++) {
    const x = k - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (m - 1));
    h[k] = sinc * win;
    sum += sinc * win;
  }
  for (let k = 0; k < m; k++) h[k] /= sum;
  return h;
}

/* 逐样本参考卷积：第 n 个样本前若存在目标为 n 的指令则整组换入，零初始历史。 */
function referenceRun(input, commands) {
  const byTarget = new Map(commands.map((c) => [c.target, Float32Array.from(c.coefs)]));
  let coefs = new Float32Array([1]);
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const hit = byTarget.get(n);
    if (hit) coefs = hit;
    let y = 0;
    for (let k = 0; k < coefs.length && k <= n; k++) y += coefs[k] * input[n - k];
    out[n] = y;
  }
  return out;
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/* 以固定分块长度驱动引擎，预先提交全部指令。 */
function runEngine(input, blockSize, commands, runId = 'run-1') {
  const eng = new FirRunEngine();
  eng.reset(runId);
  for (const c of commands) {
    const r = eng.submit({ runId, seq: c.seq, target: c.target, coefs: c.coefs });
    assert.equal(r.accepted, true, `命令 seq=${c.seq} 应被接纳，实际 ${JSON.stringify(r)}`);
  }
  const chunks = [];
  const events = [];
  for (let off = 0; off < input.length; off += blockSize) {
    const { output, events: ev } = eng.process(input.subarray(off, Math.min(off + blockSize, input.length)));
    chunks.push(output);
    events.push(...ev);
  }
  return { output: concat(chunks), events, eng };
}

function assertExactEqual(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: 长度不一致`);
  let bad = -1;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      bad = i;
      break;
    }
  }
  assert.equal(bad, -1, `${label}: 样本 ${bad} 不一致，${bad >= 0 ? actual[bad] : ''} != ${bad >= 0 ? expected[bad] : ''}`);
}

/* ---------- 1. 分块长度扫频对拍：块内换参 + 系数长度变化 ---------- */

const input = makeTestSignal(5000, SR);
const commands = [
  { seq: 1, target: 0, coefs: [0.5, 0.5] },          // 第 0 个样本前就换：2 点
  { seq: 2, target: 100, coefs: lowpass(64, 0.08) }, // 块内（块长 128 时位于首块中部）：64 点
  { seq: 3, target: 333, coefs: lowpass(128, 0.04) },// 升到满长 128 点
  { seq: 4, target: 1024, coefs: [0.25] },           // 骤降到 1 点
  { seq: 5, target: 2000, coefs: [1, -2, 3, -4, 5, -6, 7].map((v) => v / 7) }, // 7 点
  { seq: 6, target: 4999, coefs: [2] },              // 最后一个样本
];
const expected = referenceRun(input, commands);

const blockSizes = [1, 2, 3, 5, 7, 16, 64, 127, 128, 129, 256, 333, 1000, 5000];
for (const bs of blockSizes) {
  const { output, events } = runEngine(input, bs, commands);
  assertExactEqual(output, expected, `分块长度 ${bs}`);
  assert.deepEqual(
    events.map((e) => [e.seq, e.effectiveAt]),
    commands.map((c) => [c.seq, c.target]),
    `分块长度 ${bs}: 生效事件与目标下标应一一对应`
  );
}
console.log(`✓ 分块对拍：${blockSizes.length} 种分块长度 × ${input.length} 样本，与逐样本参考卷积完全相等（含块内换参、系数长度 1/2/64/128/7 变化）`);

/* ---------- 2. 同一下标按命令序号裁决 ---------- */

{
  const A = [1, -1];
  const B = [0.25, 0.25, 0.25, 0.25];
  const refB = referenceRun(input, [{ target: 500, coefs: B }]);

  // 先发低序号：高序号顶掉低序号
  let r = runEngine(input, 128, [
    { seq: 1, target: 500, coefs: A },
    { seq: 2, target: 500, coefs: B },
  ]);
  assertExactEqual(r.output, refB, '裁决：高序号应生效');
  assert.deepEqual(r.events.map((e) => e.seq), [2], '裁决：只有 seq=2 生效');

  // 先发高序号：低序号被裁决出局，结果不变
  const eng = new FirRunEngine();
  eng.reset('run-1');
  const r1 = eng.submit({ runId: 'run-1', seq: 2, target: 500, coefs: B });
  const r2 = eng.submit({ runId: 'run-1', seq: 1, target: 500, coefs: A });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  assert.equal(r2.supersededBy, 2, '低序号后到应被裁决出局');
  const chunks = [];
  const events = [];
  for (let off = 0; off < input.length; off += 96) {
    const res = eng.process(input.subarray(off, Math.min(off + 96, input.length)));
    chunks.push(res.output);
    events.push(...res.events);
  }
  assertExactEqual(concat(chunks), refB, '裁决：先发高序号时结果不变');
  assert.deepEqual(events.map((e) => e.seq), [2]);

  // 顶掉时引擎应报告被顶掉的序号
  const eng2 = new FirRunEngine();
  eng2.reset('run-1');
  eng2.submit({ runId: 'run-1', seq: 1, target: 500, coefs: A });
  const r3 = eng2.submit({ runId: 'run-1', seq: 2, target: 500, coefs: B });
  assert.equal(r3.supersedes, 1, '高序号顶掉低序号时应报告 supersedes');
}
console.log('✓ 同一下标裁决：高序号生效、低序号出局，两种提交顺序结果一致');

/* ---------- 3. 迟到指令：明确拒绝且不回写已生成样本 ---------- */

{
  const eng = new FirRunEngine();
  eng.reset('run-1');
  const before = [];
  for (let b = 0; b < 3; b++) before.push(eng.process(input.subarray(b * 128, b * 128 + 128)).output);
  assert.equal(eng.clock, 384);

  const late = eng.submit({ runId: 'run-1', seq: 1, target: 383, coefs: [0.5, 0.5] });
  assert.deepEqual(late, { accepted: false, reason: 'late' }, 'target < clock 应拒绝为 late');

  // 目标恰好是下一个待算样本：允许
  const ok = eng.submit({ runId: 'run-1', seq: 2, target: 384, coefs: [0.5, 0.5] });
  assert.equal(ok.accepted, true);

  const after = [];
  for (let b = 3; b < 10; b++) after.push(eng.process(input.subarray(b * 128, b * 128 + 128)).output);

  const ref = referenceRun(input.subarray(0, 1280), [{ target: 384, coefs: [0.5, 0.5] }]);
  assertExactEqual(concat([...before, ...after]), ref, '迟到拒绝后输出应只含被接纳命令的效果');
}
console.log('✓ 迟到指令：target<clock 拒绝（late），已生成样本不被回写，target==clock 仍可生效');

/* ---------- 4. 显式重置：新代号、清时钟与历史、旧代号指令失效 ---------- */

{
  const eng = new FirRunEngine();
  // 未开轮时任何指令都拒绝
  assert.equal(eng.submit({ runId: 'run-1', seq: 1, target: 0, coefs: [1] }).accepted, false);

  eng.reset('run-1');
  eng.submit({ runId: 'run-1', seq: 1, target: 1000, coefs: lowpass(128, 0.04) }); // 未来才生效
  eng.process(input.subarray(0, 500));
  assert.equal(eng.clock, 500);

  eng.reset('run-2'); // 显式重置：开新代号
  assert.equal(eng.clock, 0, '重置后时钟归零');
  assert.equal(eng.snapshot().pending.length, 0, '重置后待生效指令清空');

  // 旧代号指令不得影响新一轮
  const stale = eng.submit({ runId: 'run-1', seq: 2, target: 100, coefs: [9, 9] });
  assert.deepEqual(stale, { accepted: false, reason: 'stale-run' });

  // 新一轮的正常指令
  const coefsY = [0.5, 0.25, 0.25];
  assert.equal(eng.submit({ runId: 'run-2', seq: 1, target: 100, coefs: coefsY }).accepted, true);

  const chunks = [];
  const events = [];
  for (let off = 0; off < 2000; off += 128) {
    const res = eng.process(input.subarray(off, Math.min(off + 128, 2000)));
    chunks.push(res.output);
    events.push(...res.events);
  }
  // 参考：全新零历史（说明旧历史已清空），且只有 run-2 的命令（说明旧待生效指令已清空）
  const ref = referenceRun(input.subarray(0, 2000), [{ target: 100, coefs: coefsY }]);
  assertExactEqual(concat(chunks), ref, '重置后输出应等于零历史 + 仅新代号命令的参考');
  assert.deepEqual(events.map((e) => [e.seq, e.effectiveAt]), [[1, 100]], '旧代号待生效指令不得在新一轮生效');
}
console.log('✓ 显式重置：时钟归零、历史与待生效指令清空、旧代号指令 stale-run 拒绝');

/* ---------- 5. 系数个数与取值边界 ---------- */

{
  const eng = new FirRunEngine();
  eng.reset('run-1');
  assert.equal(eng.submit({ runId: 'run-1', seq: 1, target: 0, coefs: [] }).reason, 'bad-coefs');
  assert.equal(eng.submit({ runId: 'run-1', seq: 2, target: 0, coefs: new Array(MAX_TAPS + 1).fill(1) }).reason, 'bad-coefs');
  assert.equal(eng.submit({ runId: 'run-1', seq: 3, target: 0, coefs: [1, NaN] }).reason, 'bad-coefs');
  assert.equal(eng.submit({ runId: 'run-1', seq: 4, target: 0, coefs: [1, Infinity] }).reason, 'bad-coefs');
  assert.equal(eng.submit({ runId: 'run-1', seq: 5, target: -1, coefs: [1] }).reason, 'bad-target');
  assert.equal(eng.submit({ runId: 'run-1', seq: 6, target: 0.5, coefs: [1] }).reason, 'bad-target');
  assert.equal(eng.submit({ runId: 'run-1', seq: 7, target: 0, coefs: new Array(MAX_TAPS).fill(1 / MAX_TAPS) }).accepted, true, '128 个系数应接纳');
  assert.equal(eng.snapshot().pending.length, 1);
}
console.log(`✓ 边界：0/129/非有限值系数、非整数目标拒绝；${MAX_TAPS} 个系数接纳`);

console.log('\n核心逻辑对拍测试全部通过。');
