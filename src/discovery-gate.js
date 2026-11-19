'use strict';

// Brave / DuckDuckGo 是按出口 IP 限流的，而 X / Rumble / TikTok 三个平台的
// 「发现」都打这两个搜索引擎。冷却状态必须共享：一个平台撞到 429/202，
// 其他平台就别再各撞一遍（否则一轮里白烧 6 个请求，还把冷却拖得更久）。
const BLOCK_MS = 10 * 60 * 1000;
const until = { brave: 0, ddg: 0 };

function available(engine) {
  return Date.now() >= (until[engine] || 0);
}

function block(engine, minutes) {
  const mins = Number(minutes) > 0 ? Number(minutes) : 10;
  until[engine] = Date.now() + mins * 60000;
}

function remainingMs(engine) {
  return Math.max(0, (until[engine] || 0) - Date.now());
}

function bothBlocked() {
  return !available('brave') && !available('ddg');
}

// 两个源都不可用时给引擎一个统一的「本轮跳过」信号。
function cooldownInfo() {
  if (!bothBlocked()) return null;
  const ms = Math.min(until.brave, until.ddg) - Date.now();
  return {
    cooldown: true,
    cooldownMinutes: Math.max(1, Math.ceil(ms / 60000))
  };
}

function reset() {
  until.brave = 0;
  until.ddg = 0;
}

module.exports = { available, block, remainingMs, bothBlocked, cooldownInfo, reset, BLOCK_MS };
