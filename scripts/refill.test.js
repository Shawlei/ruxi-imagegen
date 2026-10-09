/**
 * 入戏生图 回填自验（node，无依赖，真正执行 index.js 入口）：
 * 模拟「boot 先执行 → 扩展入口同步渲染（settings 为空）→ getSettings 异步回填」的时序，
 * 断言 syncFormFromSettings 在 APP_READY / setTimeout 兜底两个时机都能把已存配置写回表单控件。
 *
 * 用法：node scripts/refill.test.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

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

// ---- 最小 DOM 桩 ----
const nodes = []
function makeNode(tag) {
  const n = {
    tagName: tag,
    children: [],
    _listeners: {},
    value: '',
    checked: false,
    selected: false,
    disabled: false,
    className: '',
    textContent: '',
    type: '',
    placeholder: '',
    title: '',
    style: {},
    setAttribute(k, v) {
      n.attrs = n.attrs || {}
      n.attrs[k] = String(v)
      if (k === 'type') n.type = String(v)
      else if (k === 'placeholder') n.placeholder = String(v)
      else if (k === 'rows') n.rows = String(v)
      else if (k === 'min') n.min = String(v)
      else if (k === 'max') n.max = String(v)
      else if (k === 'title') n.title = String(v)
      else if (k === 'id') n.id = String(v)
    },
    addEventListener(type, fn) {
      n._listeners[type] = fn
    },
    appendChild(c) {
      n.children.push(c)
      return c
    },
  }
  return n
}

const document = {
  createElement(tag) {
    const n = makeNode(tag)
    nodes.push(n)
    return n
  },
  body: { appendChild() {} },
  activeElement: null,
}

// ---- 宿主 API 桩 ----
let appReadyHandler = null
const apiStub = {
  eventSource: {
    on(type, cb) {
      if (type === 'APP_READY') appReadyHandler = cb
    },
  },
  getContext() {
    return Promise.resolve({ chat: [], char: '', user: '', name1: '', name2: '' })
  },
  addOneMessage() {
    return Promise.resolve({ ok: true })
  },
  saveSettingsDebounced() {},
}

let timeoutFn = null
let timeoutMs = null

// ---- 设置缓存（EXT_SETTINGS_CACHE 的模拟）----
const cache = {}

const sandbox = {
  document,
  extension_settings: cache, // 裸标识符全局
  __ruxiRequire: () => apiStub,
  setTimeout(fn, ms) {
    timeoutFn = fn
    timeoutMs = ms
    return 1
  },
  console,
}
sandbox.window = sandbox // window.__ruxiRequire / window.toastr 走这里
sandbox.toastr = { info() {}, warning() {}, error() {}, success() {} }

function findBy(pred) {
  return nodes.find(pred)
}

;(() => {
  console.log('== 回填时序自验（真正执行 index.js） ==')

  // 1. 执行入口：此刻 settings 为空对象，表单以默认值渲染
  vm.createContext(sandbox)
  try {
    vm.runInContext(indexSrc, sandbox)
  } catch (e) {
    assert(false, '入口脚本执行抛错：' + (e && e.message ? e.message : e))
    console.log('\n' + '❌ 有 ' + failures + ' 项失败')
    process.exit(1)
  }

  assert(typeof appReadyHandler === 'function', '已注册 APP_READY 监听')
  assert(typeof timeoutFn === 'function' && timeoutMs === 300, '已注册 300ms 兜底 setTimeout')

  // 定位控件
  const urlNode = findBy((n) => n.tagName === 'input' && n.placeholder === 'https://example.com/v1/images/generations')
  const keyNode = findBy((n) => n.tagName === 'input' && n.type === 'password')
  const modelNode = findBy((n) => n.tagName === 'input' && n.placeholder === 'model（如 dall-e-3）')
  const sizeNode = findBy((n) => n.tagName === 'input' && n.placeholder === 'size（如 1024x1024）')
  const tplNode = findBy((n) => n.tagName === 'textarea')
  const chkNode = findBy((n) => n.tagName === 'input' && n.type === 'checkbox')
  const numNode = findBy((n) => n.tagName === 'input' && n.type === 'number')
  const selNode = findBy((n) => n.tagName === 'select')

  assert(
    urlNode && keyNode && modelNode && sizeNode && tplNode && chkNode && numNode && selNode,
    '定位到全部表单控件',
  )

  // 初始（未回填）应为默认值
  assert(urlNode.value === '', '初始 URL 为空（默认值）')

  // 2. 模拟 getSettings 异步回填：往 cache（= settings 引用的同一对象）写入已存配置
  Object.assign(cache, {
    apiUrl: 'https://saved.example.com/v1/images/generations',
    protocol: 'openai',
    apiKey: 'sk-saved-key',
    model: 'dall-e-3-saved',
    size: '512x512',
    promptTemplate: '{{char}} 已保存模板',
    includeContext: false,
    contextCount: 3,
  })

  // 3. 时机 2：APP_READY 触发 syncFormFromSettings
  appReadyHandler()
  assert(urlNode.value === 'https://saved.example.com/v1/images/generations', 'APP_READY 回填 apiUrl')
  assert(keyNode.value === 'sk-saved-key', 'APP_READY 回填 apiKey')
  assert(modelNode.value === 'dall-e-3-saved', 'APP_READY 回填 model')
  assert(sizeNode.value === '512x512', 'APP_READY 回填 size')
  assert(tplNode.value === '{{char}} 已保存模板', 'APP_READY 回填 promptTemplate')
  assert(chkNode.checked === false, 'APP_READY 回填 includeContext=false')
  assert(numNode.value === '3', 'APP_READY 回填 contextCount=3')
  assert(selNode.value === 'openai', 'APP_READY 回填 protocol')

  // 4. 时机 3：setTimeout 兜底（幂等，多次调用结果一致）
  timeoutFn()
  assert(urlNode.value === 'https://saved.example.com/v1/images/generations', '兜底 setTimeout 再次回填一致')

  // 5. 焦点保护：正在编辑的字段不被覆盖
  document.activeElement = urlNode
  cache.apiUrl = 'https://user-typing.example.com'
  appReadyHandler()
  assert(urlNode.value === 'https://saved.example.com/v1/images/generations', '焦点字段不被打断（保留用户输入）')
  document.activeElement = null
  appReadyHandler()
  assert(urlNode.value === 'https://user-typing.example.com', '失焦后再回填生效')

  console.log('\n' + (failures === 0 ? '✅ 回填自验通过' : '❌ 有 ' + failures + ' 项失败'))
  process.exit(failures === 0 ? 0 : 1)
})()
