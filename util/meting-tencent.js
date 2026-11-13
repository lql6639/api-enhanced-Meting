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
 *
 * @param {string} mid  歌曲 mid
 * @param {number} br   meting 码率
 * @param {string} [cookie]
 * @returns {Promise<string>} 空串表示无可用直链
 */
async function getSongUrl(mid, br, cookie) {
  const uin = uinFromCookie(cookie)
  const guid = String(Math.floor(Math.random() * 9000000) + 1000000)
  const failed = []

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
        return (sip + info.purl).replace(/^http:\/\//, 'https://')
      }
      failed.push(`${q.prefix}:${info.result || 'empty'}`)
    } catch (e) {
      failed.push(`${q.prefix}:${(e && e.message) || 'error'}`)
    }
  }

  logger.warn('tencent url unavailable, mid:', mid, 'tried:', failed.join(','))
  return ''
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
 * 搜索。用 musicu 的 SearchCgiService（老的 c.y.qq.com/soso 接口已 404）。
 *
 * @param {string} keyword
 * @param {number} limit
 * @param {number} page  从 1 开始
 * @param {string} [cookie]
 * @returns {Promise<Array<object>>}
 */
async function searchSongs(keyword, limit, page, cookie) {
  const payload = {
    comm: { ...COMM },
    req: {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: page,
        query: keyword,
        search_type: 0,
      },
    },
  }
  const data = await musicu(payload, cookie)
  const body =
    data && data.req && data.req.data && data.req.data.body
      ? data.req.data.body
      : {}
  const list = (body.song && body.song.list) || []
  return list
    .filter((s) => s && s.mid)
    .map((s) => ({
      mid: s.mid,
      name: s.name || s.title || '',
      artist: (s.singer || []).map((x) => x.name).join(' / '),
      albumMid: (s.album && s.album.mid) || '',
    }))
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
      const url = await getSongUrl(mid, opts.br, cookie)
      if (!url) {
        return {
          status: 404,
          body: { code: 404, msg: 'No playable URL found', server: 'tencent' },
        }
      }
      return { status: 302, body: '', redirectUrl: url }
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

module.exports = { handleMeting, getSongUrl, getSongDetail, searchSongs }
