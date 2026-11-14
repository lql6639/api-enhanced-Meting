/**
 * meting 兼容层 —— 腾讯（QQ 音乐）数据源
 *
 * 由 module/meting.js 在 server=tencent 时调用，对外表现与网易云分支完全一致：
 *   type=name|artist|url|pic|lrc|song|playlist|search
 *
 * 与 Meting-API（mi.lovlin.cn）的关键差异：
 *   Meting-API 部署在 Vercel 时会把 type=url 降级成一段 JSONP 指令
 *   （"@qq_get_url_from_json@callback@callback@https://u.y.qq.com/..."），
 *   让浏览器自己去取 vkey —— 标准 Meting 客户端（APlayer）不认识这个格式。
 *   这里改为服务端直接取 vkey 并 302 到真实直链，客户端行为与网易云分支一致。
 *
 * 已知限制：
 * - 匿名请求只能拿 128k（M500）。320k（M800）会返回 result=104003，需要
 *   带 VIP 的 QQ cookie（uin + qm_keyst）才会给出 purl，这里做了自动降级。
 * - QQ 侧接口全部要求 Referer: https://y.qq.com/，否则直接拒绝。
 */

const axios = require('axios')
const logger = require('./logger')
const { mergeLyric, buildMetingUrl } = require('./meting')

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const LYRIC_API = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
const PLAYLIST_API =
  'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
// 匿名可用的搜索接口。musicu 的 SearchCgiService 现在对未登录请求返回
// req.code=2001 并给出空列表（要求登录 + 签名），只能退回这个老接口。
const SEARCH_API = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp'
// 老接口偶尔也会空，最后兜底用联想搜索（条数少但稳定）。
const SMARTBOX_API = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
const PIC_BASE = 'https://y.gtimg.cn/music/photo_new/T002R'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// QQ 音乐要求 comm.ct/cv 为字符串形态的客户端标识，用数字会返回空列表
const COMM = { ct: '19', cv: '1859', uin: '0' }

const TIMEOUT = 10000

/**
 * 从 cookie 里取已登录的 QQ 号，用于申请高码率。
 * 匿名时返回 '0'，行为与网页未登录一致（128k）。
 *
 * @param {string} [cookie]
 * @returns {string}
 */
function uinFromCookie(cookie) {
  if (!cookie) return '0'
  const m = /(?:^|;\s*)(?:uin|p_uin)=o?(\d{5,12})/.exec(String(cookie))
  return m ? m[1] : '0'
}

function headers(cookie, referer) {
  const h = {
    'User-Agent': UA,
    Referer: referer || 'https://y.qq.com/',
  }
  if (cookie) h.Cookie = cookie
  return h
}

/**
 * 调用 musicu.fcg 网关。所有模块（搜索/详情/vkey）都走这一个入口。
 *
 * @param {object} payload
 * @param {string} [cookie]
 * @returns {Promise<object>}
 */
async function musicu(payload, cookie) {
  const res = await axios.get(MUSICU, {
    params: { format: 'json', data: JSON.stringify(payload) },
    headers: headers(cookie),
    timeout: TIMEOUT,
    validateStatus: () => true,
  })
  if (typeof res.data === 'string') {
    // 少数情况下 QQ 会返回 JSONP 包裹，剥一层再 parse
    const m = /\{[\s\S]*\}/.exec(res.data)
    return m ? JSON.parse(m[0]) : {}
  }
  return res.data || {}
}

/**
 * meting 的 br（kbps）→ QQ 的文件名前缀。
 * QQ 规则：M500=128k mp3，M800=320k mp3，F000=flac，C400=m4a 96k。
 *
 * @param {number} br
 * @returns {Array<{prefix: string, ext: string}>} 按优先级排列的候选
 */
function qualityCandidates(br) {
  if (br >= 900) {
    return [
      { prefix: 'F000', ext: '.flac' },
      { prefix: 'M800', ext: '.mp3' },
      { prefix: 'M500', ext: '.mp3' },
    ]
  }
  if (br >= 256) {
    return [
      { prefix: 'M800', ext: '.mp3' },
      { prefix: 'M500', ext: '.mp3' },
    ]
  }
  return [{ prefix: 'M500', ext: '.mp3' }]
}

/**
 * 选一个可用的 CDN 域名：优先 https，避开 ws 开头的备用域名。
 */
function pickSip(sip) {
  const list = Array.isArray(sip) ? sip : []
  const https = list.find((s) => s.startsWith('https://'))
  if (https) return https
  const normal = list.find((s) => !s.startsWith('http://ws'))
  return normal || list[0] || ''
}

/**
 * 取播放直链。QQ 匿名账号拿不到 320k，按候选逐级降级。
 * 版权/VIP 歌曲（如周杰伦全集）匿名一律 result=104003，无解，只能带 VIP cookie。
 *
 * @param {string} mid  歌曲 mid
 * @param {number} br   meting 码率
 * @param {string} [cookie]
 * @returns {Promise<{url: string, reason: string}>} url 为空串表示无可用直链
 */
async function getSongUrl(mid, br, cookie) {
  const uin = uinFromCookie(cookie)
  const guid = String(Math.floor(Math.random() * 9000000) + 1000000)
  const failed = []
  let vipOnly = false

  for (const q of qualityCandidates(br)) {
    const payload = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid,
          songmid: [mid],
          songtype: [0],
          uin,
          loginflag: 1,
          platform: '20',
          filename: [`${q.prefix}${mid}${mid}${q.ext}`],
        },
      },
      comm: { ...COMM, uin, format: 'json' },
    }

    try {
      const data = await musicu(payload, cookie)
      const body = (data && data.req_0 && data.req_0.data) || {}
      const info = (body.midurlinfo || [])[0] || {}
      if (info.purl) {
        const sip = pickSip(body.sip)
        if (!sip) {
          failed.push(`${q.prefix}:no-sip`)
          continue
        }
        // 匿名只能拿 128k，成功降级时留一条 debug 便于排查音质问题
        if (q.prefix !== qualityCandidates(br)[0].prefix) {
          logger.info(
            `tencent url downgraded for ${mid}: ${qualityCandidates(br)[0].prefix} -> ${q.prefix}`,
          )
        }
        return {
          url: (sip + info.purl).replace(/^http:\/\//, 'https://'),
          reason: '',
        }
      }
      if (Number(info.result) === 104003) vipOnly = true
      failed.push(`${q.prefix}:${info.result || 'empty'}`)
    } catch (e) {
      failed.push(`${q.prefix}:${(e && e.message) || 'error'}`)
    }
  }

  logger.warn('tencent url unavailable, mid:', mid, 'tried:', failed.join(','))
  return { url: '', reason: vipOnly ? 'vip' : 'unavailable' }
}

/**
 * 自动解灰用的缓存：mid -> { url, ts, ttl }。
 * 命中过就复用，失败也记 5 分钟，避免同一首冷门 VIP 歌被反复重试打满上游。
 */
const UNBLOCK_CACHE = new Map()
const UNBLOCK_HIT_TTL = 20 * 60 * 1000
const UNBLOCK_MISS_TTL = 5 * 60 * 1000
const UNBLOCK_CACHE_MAX = 1000
// 网易云搜索页大小。带引号的关键词（"歌名" 歌手）在原版被大量翻唱挤下去时
// 仍然排得很靠前（实测「晴天」第 30 条），所以默认只打一次、只取首页 30 条。
const UNBLOCK_PAGE_SIZE = 30
// 网易云搜索有「操作频繁」风控（405），会影响该 IP 上所有网易云接口，
// 所以这里：串行 + 间隔 + 每分钟配额 + 撞到 405 立即熔断。
const NCM_MIN_GAP = 350
const NCM_BREAK_MS = 5 * 60 * 1000
const NCM_MAX_PER_MIN = 8
let ncmChain = Promise.resolve()
let ncmLastAt = 0
let ncmBreakUntil = 0
let ncmWindowStart = 0
let ncmWindowCount = 0

/**
 * 串行化的网易云搜索：同一时刻只发一个请求，间隔不小于 NCM_MIN_GAP；
 * 撞上风控后熔断 NCM_BREAK_MS，期间解灰直接放弃。
 *
 * @param {string} keywords
 * @param {number} offset
 * @returns {Promise<Array<object>|null>} null 表示风控/失败
 */
function ncmSearch(keywords, offset) {
  const run = async () => {
    if (Date.now() < ncmBreakUntil) return null
    // 每分钟配额，防止突发流量把 IP 打进风控
    const now = Date.now()
    if (now - ncmWindowStart > 60 * 1000) {
      ncmWindowStart = now
      ncmWindowCount = 0
    }
    if (ncmWindowCount >= NCM_MAX_PER_MIN) {
      logger.warn('tencent unblock: search quota per minute reached, skip')
      return null
    }
    ncmWindowCount++

    const gap = NCM_MIN_GAP - (Date.now() - ncmLastAt)
    if (gap > 0) await new Promise((r) => setTimeout(r, gap))
    ncmLastAt = Date.now()

    const trip = (code) => {
      ncmBreakUntil = Date.now() + NCM_BREAK_MS
      logger.warn(
        `tencent unblock: netease search throttled (${code}), pause ${
          NCM_BREAK_MS / 1000
        }s`,
      )
      return null
    }

    try {
      const search = require('../module/search')
      const request = require('../util/request')
      const res = await search(
        { keywords, type: 1, limit: UNBLOCK_PAGE_SIZE, offset },
        request,
      )
      const body = (res && res.body) || {}
      if (body.code && body.code !== 200) return trip(body.code)
      return (body.result && body.result.songs) || []
    } catch (e) {
      // module 遇到 405 是 throw（e.status / e.body.code），不是正常返回
      const code = (e && (e.status || (e.body && e.body.code))) || 0
      if (code === 405) return trip(405)
      logger.warn('tencent unblock search failed:', (e && e.message) || e)
      return null
    }
  }
  const next = ncmChain.then(run, run)
  // 让链不因为单个任务异常而中断
  ncmChain = next.catch(() => {})
  return next
}

/**
 * 歌名/歌手归一化：只抹掉空格和标点，保留括号里的版本信息。
 * 「稻香(治愈版)」归一化后是「稻香治愈版」，不会和「稻香」撞车 ——
 * 解灰宁可不生效，也不能把翻唱当成原唱放出来。
 *
 * @param {string} s
 * @returns {string}
 */
function normName(s) {
  return String(s || '')
    .replace(/[\s\-_·・,，.。!！?？'"“”‘’/\\|()（）\[\]【】]/g, '')
    .toLowerCase()
}

/**
 * 由「歌名 + 歌手」在网易云找同曲 id。
 * 判定：歌名归一化后完全相等 + 歌手归一化后完全相等；多个候选时优先计时
 * 与 QQ 一致的（网易云有大量同名搬运上传，时长能把它们区分开）。
 * 宁可不解灰也不放错歌（「稻香(治愈版)」不会被当成「稻香」）。
 *
 * @param {string} name
 * @param {string} artist
 * @param {number} [interval] QQ 侧时长（秒），用于择优
 * @returns {Promise<string>} 网易云歌曲 id，找不到返回空串
 */
async function findNeteaseId(name, artist, interval) {
  const targetName = normName(name)
  const firstArtist = String(artist || '').split(' / ')[0]
  const targetArtists = String(artist || '')
    .split(' / ')
    .map(normName)
    .filter(Boolean)
  if (!targetName) return ''

  // 默认只打一次带引号的精确搜索（首页 30 条）；只有一条都没返回时才
  // 退纯歌名再试一次 —— 网易云搜索的风控会连带影响整个网易云接口。
  const songs = await ncmSearch(
    firstArtist ? `"${name}" ${firstArtist}` : name,
    0,
  )
  if (songs === null) return ''
  let list = songs
  if (list.length === 0 && firstArtist) {
    const plain = await ncmSearch(name, 0)
    if (plain === null) return ''
    list = plain
  }

  let best = null
  for (const s of list) {
    if (normName(s.name) !== targetName) continue
    const names = (s.artists || s.ar || []).map((a) => normName(a.name))
    if (!names.some((a) => a && targetArtists.includes(a))) continue

    // 择优：有专辑信息的优先（搬运上传往往没有专辑），再看时长差
    const dur = (s.duration || s.dt || 0) / 1000
    const hasAlbum = Boolean((s.album && s.album.name) || (s.al && s.al.name))
    const score =
      (hasAlbum ? 0 : 1000) + (interval && dur ? Math.abs(dur - interval) : 999)
    if (!best || score < best.score) best = { id: String(s.id), score }
  }
  return best ? best.id : ''
}

/**
 * 替代音源常返回 http 直链，https 页面播放会被浏览器当混合内容拦掉。
 * 这里探一下同路径的 https 是否可用，能用就升级，不能用保持原样。
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function upgradeToHttps(url) {
  if (!/^http:\/\//.test(url)) return url
  const httpsUrl = url.replace(/^http:\/\//, 'https://')
  try {
    const res = await axios.get(httpsUrl, {
      headers: { Range: 'bytes=0-0' },
      timeout: 5000,
      validateStatus: () => true,
    })
    if (res.status === 200 || res.status === 206) return httpsUrl
  } catch (_) {
    /* 探测失败就沿用 http */
  }
  return url
}

/**
 * 解灰兜底：QQ 匿名拿不到的 VIP / 版权曲，借网易云 id 交给 matchID 从
 * 酷我、咪咕、QQ 等替代源取直链（与网易云灰色歌曲同一套逻辑）。
 *
 * @param {string} mid    QQ songmid
 * @param {string} [cookie]
 * @returns {Promise<string>} 可播放直链，失败返回空串
 */
async function unblockByQQSong(mid, cookie) {
  if (String(process.env.TENCENT_UNBLOCK || '').toLowerCase() === 'off') {
    return ''
  }
  const cached = UNBLOCK_CACHE.get(mid)
  if (cached && Date.now() - cached.ts < cached.ttl) return cached.url
  if (Date.now() < ncmBreakUntil) {
    logger.warn('tencent unblock: skipped, netease under throttle')
    return ''
  }

  let url = ''
  try {
    const detail = await getSongDetail(mid, cookie)
    if (detail && detail.name) {
      const ncmId = await findNeteaseId(
        detail.name,
        detail.artist,
        detail.interval,
      )
      if (ncmId) {
        const {
          matchID,
        } = require('@neteasecloudmusicapienhanced/unblockmusic-utils')
        const res = await matchID(ncmId)
        url = (res && res.data && res.data.url) || ''
        if (url) {
          url = await upgradeToHttps(url)
          logger.info(`tencent unblock: ${mid} -> ncm ${ncmId}`)
        } else {
          logger.warn(`tencent unblock: ${mid} -> ncm ${ncmId} no url`)
        }
      } else {
        logger.warn(
          `tencent unblock: no netease match for ${mid} (${detail.name})`,
        )
      }
    }
  } catch (e) {
    logger.warn('tencent unblock failed for', mid, (e && e.message) || e)
  }

  if (UNBLOCK_CACHE.size > UNBLOCK_CACHE_MAX) {
    UNBLOCK_CACHE.delete(UNBLOCK_CACHE.keys().next().value)
  }
  UNBLOCK_CACHE.set(mid, {
    url,
    ts: Date.now(),
    ttl: url ? UNBLOCK_HIT_TTL : UNBLOCK_MISS_TTL,
  })
  return url
}

/**
 * 歌曲详情（名称 / 歌手 / 专辑 mid）。
 *
 * @param {string} mid
 * @param {string} [cookie]
 * @returns {Promise<object|null>}
 */
async function getSongDetail(mid, cookie) {
  const payload = {
    comm: { ...COMM },
    songinfo: {
      method: 'get_song_detail_yqq',
      module: 'music.pf_song_detail_svr',
      param: { song_mid: mid },
    },
  }
  const data = await musicu(payload, cookie)
  const info =
    data && data.songinfo && data.songinfo.data && data.songinfo.data.track_info
  if (!info) return null
  const album = info.album || {}
  return {
    mid,
    name: info.name || '',
    artist: (info.singer || []).map((s) => s.name).join(' / '),
    albumMid: album.mid || '',
    interval: info.interval || 0,
  }
}

/**
 * 歌单全部歌曲。QQ 一次返回整张歌单，分页在本地切片。
 *
 * @param {string} disstid 歌单 id
 * @param {string} [cookie]
 * @returns {Promise<Array<object>>}
 */
async function getPlaylistTracks(disstid, cookie) {
  const res = await axios.get(PLAYLIST_API, {
    params: {
      type: 1,
      json: 1,
      utf8: 1,
      onlysong: 0,
      disstid,
      format: 'json',
      g_tk: 5381,
      loginUin: 0,
      hostUin: 0,
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    },
    headers: headers(cookie),
    timeout: TIMEOUT,
    validateStatus: () => true,
  })
  const cd = ((res.data && res.data.cdlist) || [])[0]
  if (!cd) return []
  return (cd.songlist || [])
    .filter((s) => s && s.songmid)
    .map((s) => ({
      mid: s.songmid,
      name: s.songname || s.name || '',
      artist: (s.singer || []).map((x) => x.name).join(' / '),
      albumMid: s.albummid || '',
    }))
}

/**
 * 搜索（主接口）。匿名可用，返回体是老的 data.song.list 结构。
 *
 * @param {string} keyword
 * @param {number} limit
 * @param {number} page  从 1 开始
 * @param {string} [cookie]
 * @returns {Promise<Array<object>>}
 */
async function searchPaged(keyword, limit, page, cookie) {
  const res = await axios.get(SEARCH_API, {
    params: {
      w: keyword,
      p: page,
      n: limit,
      format: 'json',
      g_tk: 5381,
      loginUin: 0,
      hostUin: 0,
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    },
    headers: headers(cookie),
    timeout: TIMEOUT,
    validateStatus: () => true,
  })
  const list =
    (res.data && res.data.data && res.data.data.song
      ? res.data.data.song.list
      : []) || []
  return list
    .filter((s) => s && s.songmid)
    .map((s) => ({
      mid: s.songmid,
      name: s.songname || s.name || '',
      artist: (s.singer || []).map((x) => x.name).join(' / '),
      albumMid: s.albummid || '',
    }))
}

/**
 * 搜索（兜底）。联想接口一次只给 4 条左右，但几乎不会被风控。
 *
 * @param {string} keyword
 * @param {number} limit
 * @param {string} [cookie]
 * @returns {Promise<Array<object>>}
 */
async function searchSmartbox(keyword, limit, cookie) {
  const res = await axios.get(SMARTBOX_API, {
    params: { key: keyword, format: 'json' },
    headers: headers(cookie),
    timeout: TIMEOUT,
    validateStatus: () => true,
  })
  const list =
    (res.data && res.data.data && res.data.data.song
      ? res.data.data.song.itemlist
      : []) || []
  return list.slice(0, limit).map((s) => ({
    mid: s.mid,
    name: s.name || '',
    artist: s.singer || '',
    albumMid: '',
  }))
}

/**
 * 搜索入口：先走分页搜索，空了再退联想。
 *
 * @param {string} keyword
 * @param {number} limit
 * @param {number} page
 * @param {string} [cookie]
 * @returns {Promise<Array<object>>}
 */
async function searchSongs(keyword, limit, page, cookie) {
  try {
    const paged = await searchPaged(keyword, limit, page, cookie)
    if (paged.length) return paged
  } catch (e) {
    logger.warn('tencent search paged failed:', (e && e.message) || e)
  }
  try {
    return await searchSmartbox(keyword, limit, cookie)
  } catch (e) {
    logger.warn('tencent search smartbox failed:', (e && e.message) || e)
    return []
  }
}

/**
 * 歌词（原文 + 翻译）。
 *
 * @param {string} mid
 * @param {string} [cookie]
 * @returns {Promise<{lyric: string, trans: string}>}
 */
async function getLyric(mid, cookie) {
  const res = await axios.get(LYRIC_API, {
    params: {
      songmid: mid,
      format: 'json',
      nobase64: 1,
      g_tk: 5381,
      loginUin: 0,
      hostUin: 0,
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    },
    headers: headers(cookie, 'https://y.qq.com/portal/player.html'),
    timeout: TIMEOUT,
    validateStatus: () => true,
  })
  const data = res.data || {}
  return { lyric: data.lyric || '', trans: data.trans || '' }
}

function picUrl(albumMid, size) {
  if (!albumMid) return ''
  return `${PIC_BASE}${size}x${size}M000${albumMid}.jpg`
}

/**
 * 组装 meting 协议的返回项，字段与网易云分支保持一致。
 */
function buildItem(song, opts) {
  const urlOpts = { br: opts.br, req: opts.req }
  const picOpts = { cover: opts.cover, req: opts.req }
  const lrcOpts = { req: opts.req }
  return {
    name: song.name || '',
    artist: song.artist || '',
    url: buildMetingUrl('url', song.mid, 'tencent', urlOpts),
    pic: buildMetingUrl('pic', song.mid, 'tencent', picOpts),
    lrc: buildMetingUrl('lrc', song.mid, 'tencent', lrcOpts),
  }
}

/**
 * meting 请求入口（server=tencent）。
 *
 * @param {string} type
 * @param {string} id
 * @param {object} query   原始 query（取 cookie / limit / page 等）
 * @param {object} opts    { br, cover, req }
 * @returns {Promise<{status: number, body: any, redirectUrl?: string}>}
 */
async function handleMeting(type, id, query, opts) {
  const cookie = query.cookie || ''
  const mid = String(id)

  switch (type) {
    case 'name': {
      const song = await getSongDetail(mid, cookie)
      return { status: 200, body: (song && song.name) || '' }
    }

    case 'artist': {
      const song = await getSongDetail(mid, cookie)
      return { status: 200, body: (song && song.artist) || '' }
    }

    case 'url': {
      const { url, reason } = await getSongUrl(mid, opts.br, cookie)
      if (url) return { status: 302, body: '', redirectUrl: url }

      // VIP / 版权曲匿名无解，自动解灰走替代音源（酷我、咪咕、QQ 等）
      if (reason === 'vip') {
        const alt = await unblockByQQSong(mid, cookie)
        if (alt) return { status: 302, body: '', redirectUrl: alt }
      }

      return {
        status: 404,
        body: {
          code: 404,
          msg:
            reason === 'vip'
              ? 'No playable URL: VIP or copyright restricted, and no alternative source matched'
              : 'No playable URL found',
          reason,
          server: 'tencent',
        },
      }
    }

    case 'pic': {
      const song = await getSongDetail(mid, cookie)
      const url = picUrl(song && song.albumMid, opts.cover)
      if (!url) {
        return { status: 404, body: { code: 404, msg: 'No cover found' } }
      }
      return { status: 302, body: '', redirectUrl: url }
    }

    case 'lrc': {
      const { lyric, trans } = await getLyric(mid, cookie)
      return { status: 200, body: mergeLyric(lyric, trans) }
    }

    case 'song': {
      const song = await getSongDetail(mid, cookie)
      if (!song) return { status: 200, body: '[]' }
      return { status: 200, body: JSON.stringify([buildItem(song, opts)]) }
    }

    case 'playlist': {
      const all = await getPlaylistTracks(mid, cookie)
      if (all.length === 0) return { status: 200, body: '[]' }
      const offset = Math.max(0, parseInt(query.offset, 10) || 0)
      const limitRaw = parseInt(query.limit, 10)
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : all.length
      const tracks = all.slice(offset, offset + limit)
      return {
        status: 200,
        body: JSON.stringify(tracks.map((t) => buildItem(t, opts))),
      }
    }

    case 'search': {
      const limit = parseInt(query.limit, 10) || 30
      const page = parseInt(query.page, 10) || 1
      const songs = await searchSongs(mid, limit, page, cookie)
      return {
        status: 200,
        body: JSON.stringify(songs.map((s) => buildItem(s, opts))),
      }
    }

    default:
      return {
        status: 400,
        body: { code: 400, msg: 'unknown type', type, server: 'tencent' },
      }
  }
}

module.exports = {
  handleMeting,
  getSongUrl,
  getSongDetail,
  searchSongs,
  unblockByQQSong,
  findNeteaseId,
}
