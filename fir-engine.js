/*
 * fir-engine.js —— 核心 FIR 引擎（与运行环境无关）。
 *
 * 同一份代码被两处使用：
 *   1. AudioWorklet 处理器（页面把本文件与 worklet-processor.js 拼接成 Blob 后 addModule）；
 *   2. Node 对拍测试（test-core.mjs 直接 require 本文件）。
 *
 * 语义约定：
 *   - 时钟 clock = 本轮已处理样本数，只随 process() 前进，与墙钟/页面计时器无关；
 *   - 换参指令 {runId, seq, target, coefs}：在计算第 target 个样本之前一次性整组换入，
 *     单个输出样本永远只用一组系数计算，绝不混用；
 *   - 同一 target 只保留 seq 最大者（命令序号裁决）；
 *   - 指令到达时 target < clock（已错过目标）即明确拒绝，且任何情况下都不回写已生成样本；
 *   - 输入历史（最多 128 个样本）跨渲染块保留；AudioContext 暂停/恢复不动本状态；
 *   - 只有 reset(newRunId) 才开新一轮：时钟归零、历史与待生效指令清空；
 *     旧代号指令一律以 'stale-run' 拒绝。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FirEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TAPS = 128; // 滤波系数上限

  class FirRunEngine {
    constructor() {
      this.runId = null; // null 表示尚未开始任何一轮
      this._clearState();
    }

    _clearState() {
      this.clock = 0; // 本轮已处理样本数
      this.history = new Float32Array(MAX_TAPS); // 输入样本环形缓冲
      this.histWrite = 0; // 下一个写入位置（histWrite-1 即最新样本）
      this.coefs = new Float32Array([1]); // 初始为恒等滤波
      this.pending = new Map(); // target -> {seq, coefs}，每个目标下标至多一条
    }

    /* 显式重置：开始新代号，清空时钟、输入历史与全部待生效指令。 */
    reset(runId) {
      this.runId = runId;
      this._clearState();
    }

    /*
     * 提交换参指令。返回：
     *   {accepted:true, supersedes?}      接纳；若顶掉了同下标的待生效指令，给出其 seq
     *   {accepted:true, supersededBy?}    接纳但立即被同下标更高 seq 的待生效指令裁决出局
     *   {accepted:false, reason}          拒绝：stale-run / no-active-run / bad-seq /
     *                                     bad-target / bad-coefs / late
     */
    submit(cmd) {
      if (this.runId === null) return { accepted: false, reason: 'no-active-run' };
      if (!cmd || cmd.runId !== this.runId) return { accepted: false, reason: 'stale-run' };
      if (!Number.isInteger(cmd.seq) || cmd.seq < 0) return { accepted: false, reason: 'bad-seq' };
      if (!Number.isInteger(cmd.target) || cmd.target < 0) {
        return { accepted: false, reason: 'bad-target' };
      }
      const raw = cmd.coefs;
      if (
        !(Array.isArray(raw) || ArrayBuffer.isView(raw)) ||
        raw.length < 1 ||
        raw.length > MAX_TAPS ||
        !Array.prototype.every.call(raw, (v) => Number.isFinite(v))
      ) {
        return { accepted: false, reason: 'bad-coefs' };
      }
      if (cmd.target < this.clock) return { accepted: false, reason: 'late' };

      const coefs = Float32Array.from(raw); // 拷贝一份，防止调用方事后修改
      const existing = this.pending.get(cmd.target);
      if (existing) {
        if (cmd.seq > existing.seq) {
          this.pending.set(cmd.target, { seq: cmd.seq, coefs });
          return { accepted: true, supersedes: existing.seq };
        }
        return { accepted: true, supersededBy: existing.seq };
      }
      this.pending.set(cmd.target, { seq: cmd.seq, coefs });
      return { accepted: true };
    }

    /*
     * 处理一个输入块（长度任意），返回 {output, events}。
     * events 含 {type:'applied', seq, effectiveAt}：某条指令在 effectiveAt 样本前实际生效。
     * 换参判断逐样本进行，因此目标下标落在块内也会在该样本前精确换组。
     */
    process(input) {
      const n = input.length;
      const output = new Float32Array(n);
      const events = [];
      const hist = this.history;
      let coefs = this.coefs;
      for (let i = 0; i < n; i++) {
        if (this.pending.size !== 0) {
          const hit = this.pending.get(this.clock);
          if (hit) {
            this.pending.delete(this.clock);
            coefs = hit.coefs; // 一次性整组换入
            this.coefs = coefs;
            events.push({ type: 'applied', seq: hit.seq, effectiveAt: this.clock });
          }
        }
        hist[this.histWrite] = input[i];
        // 因果 FIR：y[n] = Σ_{k=0..M-1} b[k]·x[n-k]，整份输出只用当前这一组系数
        let y = 0;
        let idx = this.histWrite;
        const M = coefs.length;
        for (let k = 0; k < M; k++) {
          y += coefs[k] * hist[idx];
          idx = idx === 0 ? MAX_TAPS - 1 : idx - 1;
        }
        this.histWrite = this.histWrite + 1 === MAX_TAPS ? 0 : this.histWrite + 1;
        output[i] = y;
        this.clock++;
      }
      return { output, events };
    }

    /* 调试/页面状态用快照。 */
    snapshot() {
      return {
        runId: this.runId,
        clock: this.clock,
        taps: this.coefs.length,
        pending: [...this.pending.entries()].map(([target, c]) => ({ target, seq: c.seq })),
      };
    }
  }

  return { MAX_TAPS, FirRunEngine };
});
