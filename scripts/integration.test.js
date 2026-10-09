/**
 * 入戏生图 集成自验（node，无依赖，需要真实执行 fetch）：
 * 起一个本地 HTTP 服务，用 index.js 纯函数区里真正的 requestImage + extractImageFromPayload
 * 跑通 OpenAI / 通用两种协议，并断言请求体、请求头与图片提取结果。
 *
 * 用法：node scripts/integration.test.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('  ok  ' + msg)
  else {
    failures++
    console.error('  FAIL ' + msg)
  }
}

// 截取并执行纯函数区
const sIdx = indexSrc.indexOf('// ==PURE_START==')
const eIdx = indexSrc.indexOf('// ==PURE_END==')
const pureCode = indexSrc.slice(sIdx + '// ==PURE_START=='.length, eIdx)
const factory = new Function(
  pureCode +
    '\nreturn { extractImageFromPayload, normalizeImage, requestImage };',
)
const fns = factory()

// 本地 mock 服务
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    if (req.url.startsWith('/openai') && req.method === 'POST') {
      // 断言 OpenAI 协议请求体与请求头
      const parsed = JSON.parse(body || '{}')
      assert(parsed.model === 'dall-e-3', 'OpenAI 请求体 model 正确')
      assert(parsed.prompt === '测试 prompt', 'OpenAI 请求体 prompt 正确')
      assert(parsed.n === 1, 'OpenAI 请求体 n=1')
      assert(parsed.size === '1024x1024', 'OpenAI 请求体 size 正确')
      assert(req.headers.authorization === 'Bearer test-key', 'OpenAI Authorization 头正确')
      send(200, { created: 1, data: [{ url: 'http://127.0.0.1:PORT/x.png' }] })
      return
    }

    if (req.url.startsWith('/generic-post') && req.method === 'POST') {
      const parsed = JSON.parse(body || '{}')
      assert(parsed.prompt === '测试 prompt', '通用 POST 请求体 prompt 正确')
      assert(!req.headers.authorization, '通用（无 key）不带 Authorization 头')
      send(200, { image: 'data:image/png;base64,QUFBQQ==' })
      return
    }

    if (req.url.startsWith('/generic-get')) {
      if (req.method === 'POST') {
        res.writeHead(405)
        res.end('method not allowed')
        return
      }
      assert(req.url.includes('prompt='), '通用 GET 回退带 prompt 查询参数')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('data:image/webp;base64,QkJCQg==')
      return
    }

    send(404, { error: 'not found' })
  })
})

const PORT = 32187

function run() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', resolve)
    server.on('error', reject)
  })
}

;(async () => {
  console.log('== 本地 mock 服务端到端验证 ==')
  await run()
  const base = 'http://127.0.0.1:' + PORT

  try {
    // OpenAI 协议
    const oaiPayload = await fns.requestImage(
      base + '/openai',
      'openai',
      '测试 prompt',
      { apiKey: 'test-key', model: '', size: '' },
    )
    const oaiImg = fns.normalizeImage(fns.extractImageFromPayload(oaiPayload))
    assert(
      oaiImg && oaiImg.url === 'http://127.0.0.1:PORT/x.png',
      'OpenAI 端到端：提取到 data[0].url（实际：' + JSON.stringify(oaiImg) + '）',
    )

    // 通用 POST
    const genPayload = await fns.requestImage(base + '/generic-post', 'generic', '测试 prompt', {
      apiKey: '',
    })
    const genImg = fns.normalizeImage(fns.extractImageFromPayload(genPayload))
    assert(
      genImg && genImg.dataUrl === 'data:image/png;base64,QUFBQQ==',
      '通用 POST 端到端：提取到 dataURL（实际：' + JSON.stringify(genImg) + '）',
    )

    // 通用 GET 回退
    const getPayload = await fns.requestImage(base + '/generic-get', 'generic', '测试 prompt', {
      apiKey: '',
    })
    const getImg = fns.normalizeImage(fns.extractImageFromPayload(getPayload))
    assert(
      getImg && getImg.dataUrl === 'data:image/webp;base64,QkJCQg==',
      '通用 GET 回退端到端：提取到 dataURL（实际：' + JSON.stringify(getImg) + '）',
    )
  } catch (e) {
    failures++
    console.error('  FAIL 集成验证抛错：' + (e && e.message ? e.message : e))
  } finally {
    server.close()
  }

  console.log('\n' + (failures === 0 ? '✅ 集成验证通过' : '❌ 有 ' + failures + ' 项失败'))
  process.exit(failures === 0 ? 0 : 1)
})()
