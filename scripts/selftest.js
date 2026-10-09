/**
 * 入戏生图 自验脚本（node，无依赖）。
 *
 * 用法：node scripts/selftest.js
 *
 * 校验三件事：
 * 1. manifest 能被 renderExtension 正确解析出入口（复刻 extension-runtime.ts 的入口解析逻辑）。
 * 2. 入口脚本 index.js 里对宿主 API 的调用写法与 shim 一致（字符串核对）。
 * 3. 纯函数区（==PURE_START==/==PURE_END==）对固定输入输出正确。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('  ok  ' + msg)
  } else {
    failures++
    console.error('  FAIL ' + msg)
  }
}
function section(title) {
  console.log('\n== ' + title + ' ==')
}

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8')
}

// ---------- 1. manifest 入口解析（复刻 renderExtension 逻辑） ----------
section('manifest 入口解析')
function resolveEntry(files) {
  const manifestFile = files.find((f) => f.path === 'manifest.json')
  let jsEntry = null
  const cssPaths = []
  if (manifestFile) {
    try {
      const m = JSON.parse(manifestFile.content)
      if (m && typeof m === 'object') {
        jsEntry = typeof m.js === 'string' ? m.js : null
        if (Array.isArray(m.css)) cssPaths.push(...m.css.filter((x) => typeof x === 'string'))
      }
    } catch (e) {
      /* manifest 非法时走缺省入口 */
    }
  }
  if (!jsEntry) {
    jsEntry =
      files.find((f) => f.path === 'index.js')?.path ??
      files.find((f) => f.path === 'dist/index.js')?.path ??
      null
  }
  return { jsEntry, cssPaths }
}

const manifestContent = read('manifest.json')
const files = [
  { path: 'manifest.json', content: manifestContent },
  { path: 'index.js', content: read('index.js') },
  { path: 'style.css', content: read('style.css') },
]
const { jsEntry, cssPaths } = resolveEntry(files)
assert(jsEntry === 'index.js', `入口解析为 index.js（实际：${jsEntry}）`)
assert(cssPaths.includes('style.css'), 'css 解析包含 style.css')
assert(
  files.some((f) => f.path === jsEntry),
  '入口文件存在于 files 树中',
)

// ---------- 2. index.js 宿主 API 调用写法核对 ----------
section('index.js 宿主 API 调用写法')
const indexSrc = read('index.js')
const checks = [
  ['取 API', /window\.__ruxiRequire\(['"]script\.js['"]\)/],
  ['getContext', /API\.getContext\(\)/],
  ['addOneMessage', /API\.addOneMessage\(\s*\{\s*role:\s*['"]assistant['"],\s*content:/],
  ['saveSettingsDebounced', /API\.saveSettingsDebounced\(\)/],
  ['全局 extension_settings', /extension_settings/],
  ['入口为纯脚本（无 import/export 语句）', !/\bimport\s|\bexport\s/.test(indexSrc)],
]
checks.forEach(([name, ok]) => assert(ok, name))

// 确认无真实 API Key 硬编码（sk- + 20+ 位）
const keyLeak = /sk-[A-Za-z0-9]{20,}/.test(indexSrc + '\n' + read('README.md'))
assert(!keyLeak, '代码 / README 中无真实 API Key')

// ---------- 3. 纯函数区输出校验 ----------
section('纯函数区（截取 index.js 后独立执行）')
const startMark = '// ==PURE_START=='
const endMark = '// ==PURE_END=='
const sIdx = indexSrc.indexOf(startMark)
const eIdx = indexSrc.indexOf(endMark)
assert(sIdx >= 0 && eIdx > sIdx, '能找到纯函数区标记')

let fns = null
if (sIdx >= 0 && eIdx > sIdx) {
  const pureCode = indexSrc.slice(sIdx + startMark.length, eIdx)
  try {
    const factory = new Function(
      pureCode +
        '\nreturn { substituteTemplate: substituteTemplate, buildContextText: buildContextText, resolveProtocol: resolveProtocol, resolveSize: resolveSize, resolveCount: resolveCount, modelsBaseUrl: modelsBaseUrl, extractImagesFromPayload: extractImagesFromPayload, extractImageFromPayload: extractImageFromPayload, dataUrlApproxBytes: dataUrlApproxBytes, normalizeImage: normalizeImage };',
    )
    fns = factory()
    assert(true, '纯函数区可独立编译执行')
  } catch (e) {
    assert(false, '纯函数区编译失败：' + e.message)
  }
}

if (fns) {
  // substituteTemplate
  assert(
    fns.substituteTemplate('{{char}} 与 {{user}} 的场景', { char: '小明', user: '小红' }) === '小明 与 小红 的场景',
    'substituteTemplate 替换 {{char}}/{{user}}',
  )
  assert(
    fns.substituteTemplate('{{ name1 }}|{{ name2 }}', { name1: 'A', name2: 'B' }) === 'A|B',
    'substituteTemplate 兼容 name1/name2 与空格',
  )

  // buildContextText
  const chat = [
    { name: '小明', is_user: false, mes: '你好' },
    { name: '小红', is_user: true, mes: '在吗' },
    { name: '小明', is_user: false, mes: '在的' },
  ]
  const ctxText = fns.buildContextText(chat, 2)
  assert(ctxText === '小红：在吗\n小明：在的', 'buildContextText 取最近 N 条并拼接说话人（实际：' + JSON.stringify(ctxText) + '）')

  // resolveProtocol
  assert(fns.resolveProtocol('https://x/v1/images/generations', 'auto') === 'openai', 'auto 识别 images/generations → openai')
  assert(fns.resolveProtocol('https://api.openai.com/v1/images/generations', 'auto') === 'openai', 'auto 识别 openai 域名 → openai')
  assert(fns.resolveProtocol('https://x/api/draw', 'auto') === 'generic', 'auto 其它 URL → generic')
  assert(fns.resolveProtocol('https://x/api/draw', 'openai') === 'openai', '显式 openai 覆盖')

  // resolveSize / resolveCount / modelsBaseUrl
  assert(fns.resolveSize({ size: '1024x1792' }) === '1024x1792', 'resolveSize 预设原样返回')
  assert(fns.resolveSize({ size: 'custom', customSize: '1024x1536' }) === '1024x1536', 'resolveSize custom → customSize')
  assert(fns.resolveSize({ size: 'custom', customSize: '' }) === '1024x1024', 'resolveSize custom 空 → 缺省 1024x1024')
  assert(fns.resolveSize({ size: '' }) === '1024x1024', 'resolveSize 空 → 缺省 1024x1024')
  assert(fns.resolveCount({ count: 3 }) === 3, 'resolveCount 预设张数')
  assert(fns.resolveCount({ count: 7 }) === 7, 'resolveCount 自定义张数')
  assert(fns.resolveCount({ count: 0 }) === 1, 'resolveCount 非法 → 1')
  assert(fns.resolveCount({ count: 999 }) === 20, 'resolveCount 超上限 → 20')
  assert(fns.modelsBaseUrl('https://api.openai.com/v1/images/generations') === 'https://api.openai.com/v1', 'modelsBaseUrl 去掉 /images/generations')
  assert(fns.modelsBaseUrl('https://x.com/api/draw') === 'https://x.com/api', 'modelsBaseUrl 去掉末段路径')

  // extractImagesFromPayload — 多图提取
  const m1 = fns.extractImagesFromPayload({ data: [{ url: 'https://cdn.x/a.png' }, { url: 'https://cdn.x/b.png' }] })
  assert(m1.length === 2 && m1[0].value === 'https://cdn.x/a.png' && m1[1].value === 'https://cdn.x/b.png', 'extractImagesFromPayload 提取 OpenAI data 多张')
  const m2 = fns.extractImagesFromPayload({ data: [] })
  assert(Array.isArray(m2) && m2.length === 0, 'extractImagesFromPayload 空 data → 空数组')

  // extractImageFromPayload — OpenAI 格式
  const e1 = fns.extractImageFromPayload({ data: [{ url: 'https://cdn.x/a.png' }] })
  assert(e1 && e1.kind === 'url' && e1.value === 'https://cdn.x/a.png', 'OpenAI url 提取')

  const e2 = fns.extractImageFromPayload({ data: [{ b64_json: 'AAAA' }] })
  assert(e2 && e2.kind === 'b64' && e2.value === 'AAAA', 'OpenAI b64_json 提取')

  const e3 = fns.extractImageFromPayload({ data: [] })
  assert(e3 === null, 'OpenAI data 为空 → null')

  // extractImageFromPayload — 通用格式
  const e4 = fns.extractImageFromPayload({ url: 'https://x/b.jpg?t=1' })
  assert(e4 && e4.kind === 'url' && e4.value === 'https://x/b.jpg?t=1', '通用 {url} 提取')

  const e5 = fns.extractImageFromPayload({ image: 'data:image/webp;base64,BBBB' })
  assert(e5 && e5.kind === 'dataUrl' && e5.value === 'data:image/webp;base64,BBBB', '通用 dataURL 提取')

  const e6 = fns.extractImageFromPayload('https://x/c.gif')
  assert(e6 && e6.kind === 'url' && e6.value === 'https://x/c.gif', '纯文本 URL 提取')

  const e7 = fns.extractImageFromPayload('data:image/png;base64,AAAA==')
  assert(e7 && e7.kind === 'dataUrl', '纯文本 dataURL 提取')

  // dataUrlApproxBytes
  assert(fns.dataUrlApproxBytes('data:image/png;base64,AAAA') === 3, 'dataUrlApproxBytes 计算正确')

  // normalizeImage
  const n1 = fns.normalizeImage({ kind: 'b64', value: 'AAAA' })
  assert(n1 && n1.url === null && n1.dataUrl === 'data:image/png;base64,AAAA' && n1.bytes === 3, 'normalizeImage b64 → dataURL')

  const n2 = fns.normalizeImage({ kind: 'url', value: 'https://x/a.png' })
  assert(n2 && n2.url === 'https://x/a.png' && n2.dataUrl === 'https://x/a.png', 'normalizeImage url 原样')

  const n3 = fns.normalizeImage({ kind: 'b64', value: 'data:image/png;base64,AAAA' })
  assert(n3 && n3.dataUrl === 'data:image/png;base64,AAAA', 'normalizeImage 已带 data: 前缀不重复拼接')
}

// ---------- 结果 ----------
console.log('\n' + (failures === 0 ? '✅ 全部通过' : '❌ 有 ' + failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
