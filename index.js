/**
 * 入戏生图（ruxi-imagegen）—— 入口脚本
 *
 * 运行环境：入戏（ai-rp-chat）扩展运行时沙箱 iframe（buildRuntimeHostDoc 注入）。
 * - 宿主 API 通过 window.__ruxiRequire('script.js') 获取（对应 shim 的 buildScript() 返回值）。
 * - 设置通过全局 extension_settings 读写 + API.saveSettingsDebounced() 持久化（ext_settings_v1 分表）。
 * - 面板 UI = 本脚本渲染进 document.body 的 DOM；用户点扩展列表「面板」时承载 iframe 的容器变为可见。
 */
;(function () {
  'use strict'

  // ---- 宿主 API（shim 挂载方式：window.__ruxiRequire('script.js')）----
  var API = window.__ruxiRequire('script.js')

  // ---- 设置（全局 extension_settings：读写当前扩展的设置对象，自动持久化）----
  var DEFAULTS = {
    apiUrl: '',
    protocol: 'auto', // auto | openai | generic
    apiKey: '',
    model: '',
    size: '1024x1024',
    promptTemplate: '{{char}} 的插画，高质量，细节丰富',
    includeContext: true,
    contextCount: 6,
  }
  var settings = extension_settings || {}
  Object.keys(DEFAULTS).forEach(function (k) {
    if (settings[k] === undefined) settings[k] = DEFAULTS[k]
  })
  function persist() {
    API.saveSettingsDebounced()
  }

  // ---- 运行态 ----
  var state = {
    last: null, // 规范化后的图片 { url, dataUrl, bytes }
    generating: false,
  }

  // ============================================================
  // 纯函数区（自验脚本按 ==PURE_START== / ==PURE_END== 截取后独立执行）
  // ==PURE_START==

  /** 占位符替换：{{char}} / {{user}}（另兼容 {{name1}} / {{name2}}） */
  function substituteTemplate(tpl, ctx) {
    var c = ctx || {}
    return String(tpl == null ? '' : tpl)
      .replace(/\{\{\s*char\s*\}\}/gi, c.char || '')
      .replace(/\{\{\s*user\s*\}\}/gi, c.user || '')
      .replace(/\{\{\s*name1\s*\}\}/gi, c.name1 || c.char || '')
      .replace(/\{\{\s*name2\s*\}\}/gi, c.name2 || c.user || '')
  }

  /** 拼接最近 N 条对话上下文（说话人 + 内容），无可用内容返回空串 */
  function buildContextText(chat, N) {
    var n = parseInt(N, 10)
    if (!isFinite(n) || n <= 0) return ''
    var msgs = (Array.isArray(chat) ? chat : []).slice(-n)
    var lines = []
    msgs.forEach(function (m) {
      if (!m) return
      var who = m.name || (m.is_user ? '用户' : '角色')
      var text = m.mes || ''
      lines.push(who + '：' + text)
    })
    return lines.join('\n')
  }

  /** 协议判定：显式指定优先；auto 按 URL 特征（images/generations 或 openai）判定 */
  function resolveProtocol(url, explicit) {
    if (explicit === 'openai' || explicit === 'generic') return explicit
    var u = String(url || '')
    if (/images\/generations/i.test(u) || /openai/i.test(u)) return 'openai'
    return 'generic'
  }

  /** 从响应 payload 提取图片：返回 { kind: 'url'|'b64'|'dataUrl', value } 或 null */
  function extractImageFromPayload(payload) {
    if (payload == null) return null

    // 1) OpenAI images/generations：{ data: [ { url | b64_json } ] }
    if (typeof payload === 'object' && !Array.isArray(payload)) {
      if (Array.isArray(payload.data)) {
        for (var i = 0; i < payload.data.length; i++) {
          var item = payload.data[i]
          if (!item || typeof item !== 'object') continue
          var u = item.url
          if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return { kind: 'url', value: u.trim() }
          var b = item.b64_json
          if (typeof b === 'string' && b.trim()) return { kind: 'b64', value: b.trim() }
        }
      }
    }

    // 2) 通用：在字符串形态里扫描 dataURL 或 http(s) 图片 URL
    var str = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (!str) return null

    var mData = str.match(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/)
    if (mData) return { kind: 'dataUrl', value: mData[0].trim() }

    var mUrl = str.match(/https?:\/\/[^\s"'\\<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'\\<>]*)?/i)
    if (mUrl) return { kind: 'url', value: mUrl[0] }

    return null
  }

  /** dataURL 近似字节数（base64 长度 × 3/4） */
  function dataUrlApproxBytes(dataUrl) {
    var s = String(dataUrl || '')
    var comma = s.indexOf(',')
    var b64 = comma >= 0 ? s.slice(comma + 1) : s
    return Math.floor(b64.length * 3 / 4)
  }

  /** 把提取结果规范化成 { url, dataUrl, bytes }（b64 → dataURL；url 原样） */
  function normalizeImage(extracted) {
    if (!extracted) return null
    var url = null
    var dataUrl = null
    if (extracted.kind === 'url') {
      url = extracted.value
      dataUrl = extracted.value
    } else if (extracted.kind === 'dataUrl') {
      dataUrl = extracted.value
    } else if (extracted.kind === 'b64') {
      var b = String(extracted.value)
      dataUrl = /^data:image\//i.test(b) ? b : 'data:image/png;base64,' + b
    }
    if (!dataUrl) return null
    return { url: url, dataUrl: dataUrl, bytes: dataUrlApproxBytes(dataUrl) }
  }

  /** 解析响应体：JSON 则解析，否则原样返回文本 */
  async function parseBody(res) {
    var text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      return text
    }
  }

  /** 生图请求（自包含：仅依赖全局 fetch / encodeURIComponent） */
  async function requestImage(url, protocol, prompt, s) {
    var key = (s.apiKey || '').trim()
    var jsonHeaders = { 'Content-Type': 'application/json' }
    if (key) jsonHeaders['Authorization'] = 'Bearer ' + key

    if (protocol === 'openai') {
      var body = {
        model: (s.model || '').trim() || 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: (s.size || '').trim() || '1024x1024',
      }
      var res = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('接口返回 ' + res.status)
      return await parseBody(res)
    }

    // 通用：POST { prompt }，失败回退 GET ?prompt=
    try {
      var res2 = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ prompt: prompt }),
      })
      if (!res2.ok) throw new Error('POST ' + res2.status)
      return await parseBody(res2)
    } catch (err) {
      var sep = url.indexOf('?') >= 0 ? '&' : '?'
      var gUrl = url + sep + 'prompt=' + encodeURIComponent(prompt)
      var getHeaders = {}
      if (key) getHeaders['Authorization'] = 'Bearer ' + key
      var res3 = await fetch(gUrl, { method: 'GET', headers: getHeaders })
      if (!res3.ok) throw new Error('GET ' + res3.status)
      return await parseBody(res3)
    }
  }

  // ==PURE_END==
  // ============================================================

  // ---- DOM 小工具 ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k]
        else if (k === 'class') node.className = attrs[k]
        else if (k === 'rows') node.setAttribute('rows', attrs[k])
        else if (k === 'placeholder') node.setAttribute('placeholder', attrs[k])
        else if (k === 'value') node.value = attrs[k]
        else if (k === 'checked') node.checked = attrs[k]
        else if (k === 'disabled') node.disabled = attrs[k]
        else if (k === 'min') node.setAttribute('min', attrs[k])
        else if (k === 'max') node.setAttribute('max', attrs[k])
        else if (k === 'type') node.setAttribute('type', attrs[k])
        else if (k === 'title') node.setAttribute('title', attrs[k])
        else node.setAttribute(k, attrs[k])
      })
    }
    ;(children || []).forEach(function (c) {
      if (c) node.appendChild(c)
    })
    return node
  }

  function labeled(labelText, inputNode) {
    return el('div', { class: 'ruxi-ig__field' }, [
      el('label', { class: 'ruxi-ig__label', text: labelText }),
      inputNode,
    ])
  }

  var els = {}

  // ---- 状态提示 ----
  function showStatus(msg, isError) {
    els.status.textContent = msg || ''
    els.status.className = 'ruxi-ig__status' + (isError ? ' ruxi-ig__status--error' : '')
  }

  function toast(msg, type) {
    try {
      var t = window.toastr
      if (t && t[type || 'info']) t[type || 'info'](msg)
    } catch (e) {
      /* ignore */
    }
  }

  function setGenerating(b) {
    state.generating = b
    els.generate.disabled = b
    els.generate.textContent = b ? '生成中…' : '生成'
  }

  // ---- 面板 UI ----
  function buildUI() {
    var root = el('div', { id: 'ruxi-imagegen-root', class: 'ruxi-ig' })

    els.url = el('input', {
      type: 'text',
      class: 'ruxi-ig__input',
      value: settings.apiUrl,
      placeholder: 'https://example.com/v1/images/generations',
    })
    els.url.addEventListener('input', function () {
      settings.apiUrl = els.url.value
      persist()
    })

    els.protocol = el('select', { class: 'ruxi-ig__input' })
    ;[
      ['auto', '自动（按 URL 判断）'],
      ['openai', 'OpenAI images/generations'],
      ['generic', '通用（返回图片 URL / dataURL）'],
    ].forEach(function (p) {
      var o = el('option', { text: p[1] })
      o.value = p[0]
      if (settings.protocol === p[0]) o.selected = true
      els.protocol.appendChild(o)
    })
    els.protocol.addEventListener('change', function () {
      settings.protocol = els.protocol.value
      persist()
    })

    els.key = el('input', {
      type: 'password',
      class: 'ruxi-ig__input',
      value: settings.apiKey,
      placeholder: '<你的KEY>（可选）',
    })
    els.key.addEventListener('input', function () {
      settings.apiKey = els.key.value
      persist()
    })

    var modelRow = el('div', { class: 'ruxi-ig__row' })
    els.model = el('input', {
      type: 'text',
      class: 'ruxi-ig__input',
      value: settings.model,
      placeholder: 'model（如 dall-e-3）',
    })
    els.model.addEventListener('input', function () {
      settings.model = els.model.value
      persist()
    })
    els.size = el('input', {
      type: 'text',
      class: 'ruxi-ig__input',
      value: settings.size,
      placeholder: 'size（如 1024x1024）',
    })
    els.size.addEventListener('input', function () {
      settings.size = els.size.value
      persist()
    })
    modelRow.appendChild(els.model)
    modelRow.appendChild(els.size)

    els.template = el('textarea', {
      class: 'ruxi-ig__textarea',
      rows: 4,
      value: settings.promptTemplate,
    })
    els.template.addEventListener('input', function () {
      settings.promptTemplate = els.template.value
      persist()
    })

    var ctxRow = el('div', { class: 'ruxi-ig__row ruxi-ig__row--between' })
    els.includeContext = el('input', { type: 'checkbox', checked: !!settings.includeContext })
    els.includeContext.addEventListener('change', function () {
      settings.includeContext = els.includeContext.checked
      persist()
    })
    var check = el('label', { class: 'ruxi-ig__check' }, [
      els.includeContext,
      el('span', { text: '附上最近对话上下文' }),
    ])
    els.contextCount = el('input', {
      type: 'number',
      class: 'ruxi-ig__num',
      value: settings.contextCount,
      min: 1,
      max: 50,
    })
    els.contextCount.addEventListener('input', function () {
      var n = parseInt(els.contextCount.value, 10)
      settings.contextCount = isFinite(n) ? Math.max(1, Math.min(50, n)) : 6
      persist()
    })
    ctxRow.appendChild(check)
    ctxRow.appendChild(els.contextCount)

    els.generate = el('button', {
      type: 'button',
      class: 'ruxi-ig__btn ruxi-ig__btn--primary',
      text: '生成',
    })
    els.generate.addEventListener('click', onGenerate)

    els.status = el('div', { class: 'ruxi-ig__status' })

    els.previewWrap = el('div', { class: 'ruxi-ig__preview' })
    els.preview = el('img', { class: 'ruxi-ig__img', title: '预览' })
    els.preview.alt = '预览'
    els.previewWrap.appendChild(els.preview)

    els.insert = el('button', {
      type: 'button',
      class: 'ruxi-ig__btn',
      text: '插入对话',
      disabled: true,
    })
    els.insert.addEventListener('click', insertImage)

    var head = el('div', { class: 'ruxi-ig__title', text: '入戏生图' })

    ;[
      head,
      labeled('生图接口 URL', els.url),
      labeled('接口协议', els.protocol),
      labeled('API Key（可选）', els.key),
      labeled('模型 / 尺寸（OpenAI 协议）', modelRow),
      labeled('Prompt 模板（支持 {{char}} / {{user}}）', els.template),
      ctxRow,
      els.generate,
      els.status,
      els.previewWrap,
      els.insert,
    ].forEach(function (n) {
      root.appendChild(n)
    })

    document.body.appendChild(root)
  }

  // ---- 生图 ----
  function buildPrompt(ctx) {
    var prompt = substituteTemplate(settings.promptTemplate, ctx)
    if (settings.includeContext) {
      var ctxText = buildContextText(ctx.chat, settings.contextCount)
      if (ctxText) prompt = prompt + '\n\n最近对话：\n' + ctxText
    }
    return prompt
  }

  async function onGenerate() {
    var url = (settings.apiUrl || '').trim()
    if (!url) {
      showStatus('未配置接口', true)
      return
    }
    var protocol = resolveProtocol(url, settings.protocol)

    var ctx
    try {
      ctx = await API.getContext()
    } catch (e) {
      showStatus('读取上下文失败：' + (e && e.message ? e.message : e), true)
      return
    }

    var prompt = buildPrompt(ctx)
    if (!prompt) {
      showStatus('Prompt 为空', true)
      return
    }

    setGenerating(true)
    showStatus('生成中…')
    try {
      var payload = await requestImage(url, protocol, prompt, settings)
      var img = normalizeImage(extractImageFromPayload(payload))
      if (!img) throw new Error('未能从响应中提取到图片（URL 或 base64）')

      state.last = img
      els.preview.src = img.dataUrl
      els.previewWrap.style.display = 'block'
      els.insert.disabled = false
      showStatus('生成成功')

      // 生成成功后自动插一次；手动「插入对话」可再插一次
      await insertImage()
    } catch (e) {
      showStatus('出错：' + (e && e.message ? e.message : e), true)
    } finally {
      setGenerating(false)
    }
  }

  // ---- 插入正文 ----
  async function insertImage() {
    var img = state.last
    if (!img) {
      showStatus('还没有可插入的图片', true)
      return
    }
    var markdown
    if (img.url) {
      markdown = '![' + '图片' + '](' + img.url + ')'
    } else {
      if (img.bytes > 1024 * 1024) {
        toast('图片为 dataURL 且超过 1MB，无外链可用，仍以 dataURL 插入（可能较占存储）', 'warning')
      }
      markdown = '![' + '图片' + '](' + img.dataUrl + ')'
    }
    try {
      await API.addOneMessage({ role: 'assistant', content: markdown })
      showStatus('已插入对话')
    } catch (e) {
      showStatus('插入失败：' + (e && e.message ? e.message : e), true)
    }
  }

  buildUI()
})()
