/*
 * worklet-processor.js —— AudioWorklet 处理器。
 *
 * 本文件不单独加载：页面把 fir-engine.js 与本文件拼接成 Blob 再 audioWorklet.addModule()，
 * 因此这里可以直接使用全局 FirEngine（与 Node 对拍测试共用同一份核心代码）。
 *
 * 职责只有转发，不含任何滤波逻辑：
 *   页面 -> 处理器：{type:'reset', runId, startFrame} / {type:'command', runId, seq, target, coefs}
 *   处理器 -> 页面：{type:'ready'} / {type:'resetAck', runId, startFrame, late}
 *                   {type:'started', runId, startFrame}        —— 到达对齐起始帧，开始计样
 *                   {type:'ack', runId, seq, target, accepted, reason, supersedes, supersededBy}
 *                   {type:'applied', runId, seq, effectiveAt}   —— 实际生效位置
 *                   {type:'block', runId, start, samples}       —— 有限长度的实际输出块
 *
 * 每轮的第 0 个样本由 startFrame（渲染帧，与信号源启动时刻对齐）界定：
 * 到达该帧之前输出静音且不计入本轮时钟，保证“本轮样本 0”有确定含义。
 */
'use strict';

class FirRunProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const { FirRunEngine } = globalThis.FirEngine;
    this.engine = new FirRunEngine();
    this.silence = new Float32Array(0); // 输入缺失时的静音替补
    this.startFrame = 0; // 本轮第 0 个样本所在的渲染帧（与信号源启动时刻对齐）
    this.started = false;
    this.port.onmessage = (e) => this._onMessage(e.data);
    this.port.postMessage({ type: 'ready' });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'reset') {
      this.engine.reset(msg.runId);
      this.startFrame = msg.startFrame;
      this.started = false;
      this.port.postMessage({
        type: 'resetAck',
        runId: msg.runId,
        startFrame: msg.startFrame,
        late: currentFrame >= msg.startFrame, // 消息到得太迟，起始帧已过去（页面应告警）
      });
      return;
    }
    if (msg.type === 'command') {
      const r = this.engine.submit(msg);
      this.port.postMessage({
        type: 'ack',
        runId: msg.runId,
        seq: msg.seq,
        target: msg.target,
        accepted: r.accepted,
        reason: r.reason || null,
        supersedes: r.supersedes != null ? r.supersedes : null,
        supersededBy: r.supersededBy != null ? r.supersededBy : null,
      });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    const n = out ? out.length : 128;
    if (this.engine.runId === null) {
      // 尚未显式重置开轮：保持静音，不回传块
      if (out) out.fill(0);
      return true;
    }
    if (!this.started) {
      // 等待与信号源对齐的起始帧；到达前输出静音且不计入本轮时钟
      if (currentFrame < this.startFrame) {
        if (out) out.fill(0);
        return true;
      }
      this.started = true;
      this.port.postMessage({ type: 'started', runId: this.engine.runId, startFrame: this.startFrame });
    }
    const inCh = inputs[0] && inputs[0][0];
    let input;
    if (inCh && inCh.length === n) {
      input = inCh;
    } else {
      if (this.silence.length !== n) this.silence = new Float32Array(n);
      input = this.silence;
    }
    const { output, events } = this.engine.process(input);
    if (out) out.set(output);
    const start = this.engine.clock - n; // 本块起始样本下标（处理器本轮实际处理数）
    for (const ev of events) {
      this.port.postMessage({
        type: 'applied',
        runId: this.engine.runId,
        seq: ev.seq,
        effectiveAt: ev.effectiveAt,
      });
    }
    // 回传有限长度的实际输出块（转移底层缓冲，本块此后不再被触碰）
    this.port.postMessage(
      { type: 'block', runId: this.engine.runId, start, samples: output },
      [output.buffer]
    );
    return true;
  }
}

registerProcessor('fir-run-processor', FirRunProcessor);
