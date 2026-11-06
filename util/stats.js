/**
 * 调用统计核心模块
 *
 * 提供两个独立计数器（api-enhanced 整体、/meting 子集），
 * 各有 total_calls / today_calls / last_call_date 三个字段。
 *
 * 写入策略（v2）：内存累加 + 定时批量落盘
 *  - recordApi / recordMeting 只改内存，不再每请求 fs.writeFileSync，
 *    避免同步 IO 阻塞事件循环
 *  - 每 FLUSH_INTERVAL_MS 把脏数据落盘一次；进程退出 / SIGINT / SIGTERM 前补一次
 *  - 只读文件系统（Vercel 等 serverless）写失败时自动降级为「仅内存计数」，
 *    只 warn 一次，不影响 API 正常响应
 *  - 多进程 / 多实例各自计数（要精确需换 Redis），本模块只保证单进程正确
 *  - 跨日自动重置 today_calls
 *
 * 字段格式与 meting 原 PHP 版（meting/index.php:42-46）保持一致：
 *   { total_calls, today_calls, last_call_date }
 */

const fs = require('fs')
const path = require('path')
const logger = require('./logger')

const DATA_DIR = path.join(__dirname, '..', 'data')
const API_STATS_PATH = path.join(DATA_DIR, 'api_stats.json')
const METING_STATS_PATH = path.join(DATA_DIR, 'meting_stats.json')

// 落盘间隔：这段时间内的计数合并成一次写
const FLUSH_INTERVAL_MS = 10 * 1000

// 只读文件系统降级标记（写失败后不再重试，避免每 10 秒刷一次错误日志）
let writeDisabled = false
let writeWarned = false

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function emptyStats() {
  return { total_calls: 0, today_calls: 0, last_call_date: '', dirty: false }
}

function readStatsSync(filepath) {
  try {
    const raw = fs.readFileSync(filepath, 'utf-8')
    const data = JSON.parse(raw)
    return {
      total_calls: Number(data.total_calls) || 0,
      today_calls: Number(data.today_calls) || 0,
      last_call_date: data.last_call_date || '',
      dirty: false,
    }
  } catch (_) {
    // 文件不存在 / JSON 损坏 / 无读权限：从 0 开始
    return emptyStats()
  }
}

function disableWrites(e) {
  if (writeWarned) return
  writeWarned = true
  writeDisabled = true
  logger.warn(
    `统计落盘已禁用（文件系统不可写：${(e && e.code) || e}），计数仅在内存中有效`,
  )
}

function ensureFile(filepath) {
  try {
    if (!fs.existsSync(path.dirname(filepath))) {
      fs.mkdirSync(path.dirname(filepath), { recursive: true })
    }
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, JSON.stringify(emptyStats()))
    }
  } catch (e) {
    // 只读文件系统（serverless）：允许启动，计数退化为纯内存
    disableWrites(e)
  }
}

function writeStatsSync(filepath, data) {
  if (writeDisabled) return false
  try {
    fs.writeFileSync(
      filepath,
      JSON.stringify({
        total_calls: data.total_calls,
        today_calls: data.today_calls,
        last_call_date: data.last_call_date,
      }),
    )
    return true
  } catch (e) {
    disableWrites(e)
    return false
  }
}

ensureFile(API_STATS_PATH)
ensureFile(METING_STATS_PATH)

// 内存态：启动时从磁盘恢复，之后只在内存累加
const state = {
  api: readStatsSync(API_STATS_PATH),
  meting: readStatsSync(METING_STATS_PATH),
}

const paths = {
  api: API_STATS_PATH,
  meting: METING_STATS_PATH,
}

/**
 * 内存自增（同步、无 IO）
 * @param {'api'|'meting'} key
 */
function bump(key) {
  const s = state[key]
  const today = todayStr()
  if (s.last_call_date !== today) {
    s.today_calls = 0
    s.last_call_date = today
  }
  s.total_calls += 1
  s.today_calls += 1
  s.dirty = true
  return s
}

/**
 * 把脏数据落盘。失败（只读 FS）时自动关闭后续写入。
 */
function flush() {
  for (const key of Object.keys(state)) {
    const s = state[key]
    if (!s.dirty) continue
    if (writeStatsSync(paths[key], s)) {
      s.dirty = false
    }
  }
}

const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
if (typeof flushTimer.unref === 'function') flushTimer.unref()

// 进程退出前补一次，尽量不丢计数
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush()
  })
}

function recordApi() {
  return bump('api')
}

function recordMeting() {
  return bump('meting')
}

/**
 * 返回当前统计快照（内存值，含尚未落盘的增量）
 */
function getAllSync() {
  const snap = (s) => ({
    total_calls: s.total_calls,
    today_calls: s.today_calls,
    last_call_date: s.last_call_date,
  })
  return {
    api: snap(state.api),
    meting: snap(state.meting),
  }
}

module.exports = {
  recordApi,
  recordMeting,
  getAllSync,
  flush,
  // 暴露路径供调试
  _paths: { API_STATS_PATH, METING_STATS_PATH },
}
