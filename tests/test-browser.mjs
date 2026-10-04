/*
 * test-browser.mjs —— 真实浏览器 AudioWorklet 流程测试（Playwright + Chromium）。
 *
 * 验证消息与捕获链路的真实行为：
 *   1. 页面加载 worklet、开轮后收到连续且下标严丝合缝的实际输出块；
 *   2. 捕获数据与 Node 端独立计算的参考卷积一致（恒等段逐位相等，换参后容差 1e-6），
 *      证明页面绘制/下载用的就是处理器真实输出，而非另做的离线卷积；
 *   3. 换参指令被接纳并在目标样本精确生效（applied.effectiveAt === target）；
 *   4. 暂停时时钟冻结、恢复后续走且历史保留（输出数值不间断地与参考一致）；
 *   5. 迟到指令被明确拒绝（late）；
 *   6. 显式重置开新代号、时钟归零，旧代号指令 stale-run 拒绝；
 *   7. 下载的 WAV 与捕获数据逐位一致。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStaticServer } from '../serve.mjs';
import TestSignalPkg from '../test-signal.js';

// 无 root 环境下本地解压的 Chromium 运行库（存在才注入）
const pwLibs = path.join(os.homedir(), '.local/pw-libs');
if (existsSync(pwLibs)) {
  process.env.LD_LIBRARY_PATH = [
    path.join(pwLibs, 'lib/aarch64-linux-gnu'),
    path.join(pwLibs, 'usr/lib/aarch64-linux-gnu'),
    process.env.LD_LIBRARY_PATH,
  ]
    .filter(Boolean)
    .join(':');
}

const { makeTestSignal } = TestSignalPkg;

const server = createStaticServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[页面错误]', err.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);

  const state = () => page.evaluate(() => window.__app.state());
  const nonBlockEvents = () =>
    page.evaluate(() => window.__app.events.filter((e) => e.type !== 'block'));
  const capturedArray = () => page.evaluate(() => Array.from(window.__app.capturedSamples()));

  /* ---------- 1. 开轮，等待捕获流动 ---------- */
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__app && window.__app.state().runId === 1);
  await page.waitForFunction(() => window.__app.state().capturedLen >= 8192, null, { timeout: 15000 });

  let st = await state();
  assert.equal(st.ctxState, 'running', `AudioContext 应在运行，实际 ${st.ctxState}`);
  assert.equal(st.contiguous, true, '输出块下标应连续');
  assert.ok(st.sampleRate > 0);
  const sr = st.sampleRate;
  console.log(`✓ 开轮：运行代号 1，采样率 ${sr}，输出块连续流动（时钟 ${st.clock}）`);

  /* ---------- 2. 恒等段数值校验（信号 -> worklet -> 捕获链路） ---------- */
  const sig = makeTestSignal(sr, sr); // 页面循环缓冲的内容
  const expectedX = (n) => sig[n % sr];
  {
    const cap = await capturedArray();
    assert.ok(cap.length >= 8192);
    for (let n = 0; n < cap.length; n++) {
      assert.equal(cap[n], expectedX(n), `恒等段样本 ${n} 应逐位等于测试信号`);
    }
  }
  console.log('✓ 捕获链路数值：恒等段输出与确定性测试信号逐位一致');

  /* ---------- 3. 换程换参：接纳 + 精确生效 + 数值符合参考卷积 ---------- */
  st = await state();
  const target = st.clock + 16384; // 留出充足余量，避免慢机器上指令到达时目标已过期
  await page.fill('#coefs', '0.5, 0.5');
  await page.fill('#target', String(target));
  await page.click('#btnSend');
  await page.waitForFunction(
    () => window.__app.events.some((e) => e.type === 'ack'),
    null,
    { timeout: 15000 }
  );
  {
    const evs = await nonBlockEvents();
    const ack = evs.find((e) => e.type === 'ack' && e.seq === 1);
    assert.ok(ack, '应收到命令 #1 的 ack');
    assert.ok(ack.accepted, `命令 #1 应被接纳，实际 ${JSON.stringify(ack)}`);
  }
  await page.waitForFunction(
    (t) => window.__app.events.some((e) => e.type === 'applied' && e.effectiveAt === t),
    target,
    { timeout: 15000 }
  );
  await page.waitForFunction((t) => window.__app.state().capturedLen >= t + 300, target, {
    timeout: 15000,
  });
  {
    const evs = await nonBlockEvents();
    const applied = evs.find((e) => e.type === 'applied' && e.seq === 1);
    assert.equal(applied.effectiveAt, target, '实际生效位置应等于目标下标');

    const cap = await capturedArray();
    // 边界前一样本仍是恒等
    assert.equal(cap[target - 1], expectedX(target - 1), '生效前一样本仍属旧系数组');
    // 生效后满足 y[n] = 0.5·x[n] + 0.5·x[n-1]（Node 端独立参考，容差为 float32 量化量级）
    for (let n = target; n < target + 300; n++) {
      const ref = 0.5 * expectedX(n) + 0.5 * expectedX(n - 1);
      assert.ok(Math.abs(cap[n] - ref) <= 1e-6, `样本 ${n}：${cap[n]} 与参考 ${ref} 偏差过大`);
    }
  }
  console.log(`✓ 换参链路：命令 #1 在样本 ${target} 精确生效，输出与独立参考卷积一致`);

  /* ---------- 4. 暂停 / 恢复：时钟冻结与续走 ---------- */
  await page.click('#btnPause');
  await page.waitForFunction(() => window.__app.state().ctxState === 'suspended');
  await new Promise((r) => setTimeout(r, 300)); // 排空暂停生效前已在途的块消息
  const frozen = await state();
  await new Promise((r) => setTimeout(r, 400));
  const frozen2 = await state();
  assert.equal(frozen2.clock, frozen.clock, '暂停期间处理器时钟不得前进');
  assert.equal(frozen2.capturedLen, frozen.capturedLen, '暂停期间不得产生新输出块');
  await page.click('#btnResume');
  await page.waitForFunction((c) => window.__app.state().clock > c, frozen.clock, { timeout: 15000 });
  {
    // 恢复后输出仍与参考严丝合缝（历史保留）：检查恢复点前后各一段
    const cap = await capturedArray();
    const from = frozen.clock - 64;
    for (let n = from; n < cap.length; n++) {
      const ref = 0.5 * expectedX(n) + 0.5 * expectedX(n - 1);
      assert.ok(Math.abs(cap[n] - ref) <= 1e-6, `恢复后样本 ${n} 与参考不符`);
    }
  }
  console.log(`✓ 暂停/恢复：时钟冻结于 ${frozen.clock}，恢复后续走且滤波历史保留`);

  /* ---------- 5. 迟到指令明确拒绝 ---------- */
  st = await state();
  const lateTarget = st.clock - 4096;
  assert.ok(lateTarget >= 0, '测试前提：时钟应已超过 4096');
  await page.fill('#coefs', '1');
  await page.fill('#target', String(lateTarget));
  await page.click('#btnSend');
  await page.waitForFunction(
    () => window.__app.events.filter((e) => e.type === 'ack').length >= 2
  );
  {
    const evs = await nonBlockEvents();
    const ack = evs.filter((e) => e.type === 'ack').at(-1);
    assert.equal(ack.accepted, false, '迟到指令应被拒绝');
    assert.equal(ack.reason, 'late', `拒绝原因应为 late，实际 ${ack.reason}`);
    assert.equal(ack.target, lateTarget);
  }
  console.log(`✓ 迟到指令：目标 ${lateTarget} 被明确拒绝（late），已生成样本不受影响`);

  /* ---------- 6. 显式重置：新代号、时钟归零、旧代号指令失效 ---------- */
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__app.state().runId === 2);
  await page.waitForFunction(
    () => window.__app.events.some((e) => e.type === 'block' && e.runId === 2 && e.start === 0),
    null,
    { timeout: 15000 }
  );
  {
    const evs = await nonBlockEvents();
    assert.ok(evs.some((e) => e.type === 'resetAck' && e.runId === 2), '应收到代号 2 的 resetAck');
  }
  // 旧代号指令不得影响新一轮
  await page.evaluate(() => window.__app.sendRawCommand({ runId: 1, seq: 99, target: 10, coefs: [1] }));
  await page.waitForFunction(() =>
    window.__app.events.some((e) => e.type === 'ack' && e.seq === 99)
  );
  {
    const evs = await nonBlockEvents();
    const ack = evs.find((e) => e.type === 'ack' && e.seq === 99);
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'stale-run', `旧代号指令应 stale-run，实际 ${ack.reason}`);
  }
  // 新一轮从零下标起仍与信号逐位一致（历史确已清空）
  await page.waitForFunction(() => window.__app.state().capturedLen >= 2048, null, { timeout: 15000 });
  {
    const cap = await capturedArray();
    for (let n = 0; n < cap.length; n++) {
      assert.equal(cap[n], expectedX(n), `新一轮样本 ${n} 应等于零历史恒等输出`);
    }
  }
  console.log('✓ 显式重置：代号 2 从样本 0 重新开始，旧代号指令 stale-run 拒绝，历史清空');

  /* ---------- 7. 下载的 WAV 与捕获数据逐位一致 ---------- */
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnDownload'),
  ]);
  const wavPath = await download.path();
  {
    const buf = await readFile(wavPath);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt16LE(20), 3, '应为 IEEE float 格式');
    assert.equal(buf.readUInt16LE(22), 1, '应为单声道');
    assert.equal(buf.readUInt32LE(24), sr, '采样率应与 AudioContext 一致');
    const n = buf.readUInt32LE(40) / 4;
    assert.equal(buf.length, 44 + n * 4);
    const cap = await capturedArray();
    assert.ok(n > 0 && n <= cap.length, 'WAV 样本数应不超过已捕获数');
    for (let i = 0; i < n; i++) {
      assert.equal(buf.readFloatLE(44 + i * 4), cap[i], `WAV 样本 ${i} 应与捕获数据逐位一致`);
    }
    console.log(`✓ 下载链路：WAV（${n} 样本）与处理器回传数据逐位一致`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log('\n真实浏览器 Worklet 流程测试全部通过。');
