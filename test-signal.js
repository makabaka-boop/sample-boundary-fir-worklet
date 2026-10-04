/*
 * test-signal.js —— 确定性单声道测试信号。
 *
 * 信号只由样本下标与采样率决定（三个整周期正弦的解析式叠加），无任何随机源，
 * 因此页面（填充循环 AudioBuffer）与 Node 测试（计算参考输出）得到的样本完全一致。
 * 频率取整数赫兹，length === sampleRate 时循环拼接处无缝。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TestSignal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sampleAt(n, sampleRate) {
    const t = n / sampleRate;
    return (
      0.6 * Math.sin(2 * Math.PI * 440 * t) +
      0.25 * Math.sin(2 * Math.PI * 1247 * t + 0.3) +
      0.15 * Math.sin(2 * Math.PI * 97 * t + 1.1)
    );
  }

  function makeTestSignal(length, sampleRate) {
    const out = new Float32Array(length);
    for (let n = 0; n < length; n++) out[n] = sampleAt(n, sampleRate);
    return out;
  }

  return { sampleAt, makeTestSignal };
});
