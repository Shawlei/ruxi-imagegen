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
    model: '', // 当前模型（可从下拉选择或自定义输入）
    models: [], // 「拉取模型」拉到的模型列表（持久化，供下拉建议）
    size: '1024x1024', // 预设尺寸；'custom' 表示使用 customSize
    customSize: '', // 自定义尺寸（size==='custom' 时生效）
    promptTemplate:
      '{{char}} 的精美插画，高质量，细节丰富，光影自然，构图精致，画风唯美，色彩和谐',
    includeContext: true,
    contextCount: 6,
    insertPosition: 'bottom', // bottom | top | middle（图文插入正文的位置）
    count: 1, // 生成张数（默认 1，最高 5，或自定义）
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
    images: [], // 规范化后的图片数组 [{ url, dataUrl, bytes }]
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

  /** 尺寸预设（第一项 custom 表示自定义尺寸） */
  var SIZE_PRESETS = [
    'custom',
    '1024x1024',
    '1024x1792',
    '1792x1024',
    '512x512',
    '768x1024',
    '1024x768',
  ]

  /** 解析最终尺寸：custom → customSize；空 → 缺省 1024x1024 */
  function resolveSize(s) {
    var size = String((s && s.size) || '').trim()
    if (size === 'custom') return String((s && s.customSize) || '').trim() || '1024x1024'
    return size || '1024x1024'
  }

  /** 解析最终张数：1–20 之间，非法/小于 1 → 1 */
  function resolveCount(s) {
    var n = parseInt(s && s.count, 10)
    if (!isFinite(n) || n < 1) n = 1
    return Math.min(n, 20)
  }

  /** 从生图 URL 推导模型列表接口 base（去掉 /images/generations 或末段路径） */
  function modelsBaseUrl(url) {
    var u = String(url || '').trim()
    if (!u) return ''
    u = u.replace(/[?#].*$/, '')
    var m = u.replace(/\/images\/generations\/?$/i, '')
    if (m !== u) return m.replace(/\/+$/, '')
    var seg = u.split('/')
    if (seg.length > 3) seg.pop()
    return seg.join('/').replace(/\/+$/, '')
  }

  /** 从响应 payload 提取全部图片：返回 [{ kind: 'url'|'b64'|'dataUrl', value }]（可能为空数组） */
  function extractImagesFromPayload(payload) {
    if (payload == null) return []
    var out = []

    // 1) OpenAI images/generations：{ data: [ { url | b64_json } ] }
    if (typeof payload === 'object' && !Array.isArray(payload)) {
      if (Array.isArray(payload.data)) {
        for (var i = 0; i < payload.data.length; i++) {
          var item = payload.data[i]
          if (!item || typeof item !== 'object') continue
          var u = item.url
          if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) {
            out.push({ kind: 'url', value: u.trim() })
          } else {
            var b = item.b64_json
            if (typeof b === 'string' && b.trim()) out.push({ kind: 'b64', value: b.trim() })
          }
        }
        if (out.length) return out
      }
    }

    // 2) 通用：在字符串形态里扫描 dataURL 或 http(s) 图片 URL
    var str = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (!str) return out

    var mData = str.match(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/)
    if (mData) out.push({ kind: 'dataUrl', value: mData[0].trim() })

    var mUrl = str.match(/https?:\/\/[^\s"'\\<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'\\<>]*)?/i)
    if (mUrl) out.push({ kind: 'url', value: mUrl[0] })

    return out
  }

  /** 从响应 payload 提取第一张图片：返回 { kind, value } 或 null（兼容旧签名） */
  function extractImageFromPayload(payload) {
    var arr = extractImagesFromPayload(payload)
    return arr.length ? arr[0] : null
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

  /** 生图请求（自包含：仅依赖全局 fetch / encodeURIComponent）。n 为生成张数（OpenAI 协议生效） */
  async function requestImage(url, protocol, prompt, s, n) {
    var key = (s.apiKey || '').trim()
    var jsonHeaders = { 'Content-Type': 'application/json' }
    if (key) jsonHeaders['Authorization'] = 'Bearer ' + key

    if (protocol === 'openai') {
      var body = {
        model: (s.model || '').trim() || 'dall-e-3',
        prompt: prompt,
        n: n || 1,
        size: resolveSize(s),
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

  /** 拉取模型列表：从生图 URL 推导 base 后请求 {base}/models，返回模型 id 数组（失败抛错） */
  async function requestModels(url, s) {
    var base = modelsBaseUrl(url)
    if (!base) throw new Error('无法从接口 URL 推导模型列表地址')
    var key = (s.apiKey || '').trim()
    var headers = {}
    if (key) headers['Authorization'] = 'Bearer ' + key
    var res = await fetch(base + '/models', { method: 'GET', headers: headers })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    var data = await parseBody(res)
    var ids = []
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.data)) {
      data.data.forEach(function (m) {
        if (m && typeof m.id === 'string') ids.push(m.id)
      })
    } else if (Array.isArray(data)) {
      data.forEach(function (m) {
        if (typeof m === 'string') ids.push(m)
        else if (m && typeof m.id === 'string') ids.push(m.id)
      })
    }
    return ids
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
        else if (k === 'style') node.style.cssText = attrs[k]
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

  // ---- 表单回填（幂等）----
  function isFocused(node) {
    try {
      return !!node && document.activeElement === node
    } catch (e) {
      return false
    }
  }

  // 写入文本类控件（input/text/textarea/number/select 共用 .value）
  function setText(node, value) {
    if (!node || isFocused(node)) return // 正在编辑的字段不打断
    var v = value == null ? '' : String(value)
    if (node.value !== v) node.value = v
  }

  function setChecked(node, value) {
    if (!node || isFocused(node)) return
    var b = !!value
    if (node.checked !== b) node.checked = b
  }

  function setDisplay(node, show) {
    if (!node) return
    node.style.display = show ? '' : 'none'
  }

  /** 是否正在编辑某字段（焦点落在其自身或关联控件上） */
  function anyFocused(nodes) {
    return (nodes || []).some(function (n) {
      return isFocused(n)
    })
  }

  // ---- 模型下拉（datalist 建议 + 自由输入）----
  function fillModelOptions() {
    if (!els.modelList) return
    els.modelList.textContent = ''
    var list = Array.isArray(settings.models) ? settings.models : []
    var seen = {}
    list.forEach(function (id) {
      var v = String(id || '')
      if (!v || seen[v]) return
      seen[v] = true
      var o = el('option', { value: v })
      els.modelList.appendChild(o)
    })
  }

  // ---- 尺寸 / 张数 联动 UI ----
  function updateSizeUI() {
    var s = settings.size
    var isCustom = s === 'custom'
    els.size.value = SIZE_PRESETS.indexOf(s) >= 0 ? s : 'custom'
    setDisplay(els.customSizeWrap, isCustom)
    if (!isFocused(els.customSize)) setText(els.customSize, settings.customSize)
  }

  function updateCountUI() {
    var c = resolveCount(settings)
    var preset = c >= 1 && c <= 5
    els.count.value = preset ? String(c) : 'custom'
    setDisplay(els.countCustomWrap, !preset)
    if (!isFocused(els.countCustom)) setText(els.countCustom, preset ? '' : c)
  }

  /**
   * 把当前 settings 写回表单控件（幂等，可安全多次调用）。
   * settings 引用 EXT_SETTINGS_CACHE 的同一对象：boot 的 getSettings 异步回填会
   * 直接反映到 settings，本函数即可在任意时序把已存配置同步到 UI。
   */
  function syncFormFromSettings() {
    if (!els.url) return // 表单尚未构建时安全跳过
    var s = settings
    setText(els.url, s.apiUrl)
    setText(els.protocol, s.protocol)
    setText(els.key, s.apiKey)
    setText(els.model, s.model)
    fillModelOptions()
    setText(els.template, s.promptTemplate)
    setChecked(els.includeContext, s.includeContext)
    setText(els.contextCount, s.contextCount)
    setText(els.insertPosition, s.insertPosition)
    updateSizeUI()
    updateCountUI()
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

    // 模型：下拉建议（datalist）+ 自由输入，旁挂「拉取模型」按钮
    els.modelList = el('datalist', { id: 'ruxi-ig-models' })
    els.model = el('input', {
      type: 'text',
      class: 'ruxi-ig__input',
      value: settings.model,
      placeholder: '选择或输入模型（如 dall-e-3）',
    })
    els.model.setAttribute('list', 'ruxi-ig-models')
    els.model.addEventListener('input', function () {
      settings.model = els.model.value
      persist()
    })
    els.fetchModels = el('button', {
      type: 'button',
      class: 'ruxi-ig__btn ruxi-ig__btn--small',
      text: '拉取模型',
    })
    els.fetchModels.addEventListener('click', onFetchModels)
    var modelRow = el('div', { class: 'ruxi-ig__row' })
    modelRow.appendChild(els.model)
    modelRow.appendChild(els.fetchModels)
    modelRow.appendChild(els.modelList)

    // 尺寸：预设下拉（第一项自定义）+ 自定义输入框
    els.size = el('select', { class: 'ruxi-ig__input' })
    SIZE_PRESETS.forEach(function (v) {
      var label = v === 'custom' ? '自定义尺寸' : v
      var o = el('option', { text: label })
      o.value = v
      els.size.appendChild(o)
    })
    els.size.addEventListener('change', function () {
      if (els.size.value === 'custom') {
        if (settings.size !== 'custom') settings.size = 'custom'
      } else {
        settings.size = els.size.value
      }
      persist()
      updateSizeUI()
    })
    els.customSize = el('input', {
      type: 'text',
      class: 'ruxi-ig__input',
      value: settings.customSize,
      placeholder: '如 1024x1536',
    })
    els.customSize.addEventListener('input', function () {
      settings.customSize = els.customSize.value
      persist()
    })
    els.customSizeWrap = el('div', { class: 'ruxi-ig__sub', style: 'display:none' })
    els.customSizeWrap.appendChild(els.customSize)

    // Prompt 模板
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

    // 图文插入位置
    els.insertPosition = el('select', { class: 'ruxi-ig__input' })
    ;[
      ['bottom', '正文底部'],
      ['top', '正文顶部'],
      ['middle', '正文中间'],
    ].forEach(function (p) {
      var o = el('option', { text: p[1] })
      o.value = p[0]
      if (settings.insertPosition === p[0]) o.selected = true
      els.insertPosition.appendChild(o)
    })
    els.insertPosition.addEventListener('change', function () {
      settings.insertPosition = els.insertPosition.value
      persist()
    })

    // 张数：1–5 预设 + 自定义
    els.count = el('select', { class: 'ruxi-ig__input' })
    ;[1, 2, 3, 4, 5].forEach(function (n) {
      var o = el('option', { text: n + ' 张' })
      o.value = String(n)
      els.count.appendChild(o)
    })
    ;(function () {
      var o = el('option', { text: '自定义' })
      o.value = 'custom'
      els.count.appendChild(o)
    })()
    els.count.addEventListener('change', function () {
      if (els.count.value === 'custom') {
        if (settings.count < 1 || settings.count > 5) {
          settings.count = Math.max(1, Math.min(20, settings.count || 5))
        }
      } else {
        settings.count = parseInt(els.count.value, 10)
      }
      persist()
      updateCountUI()
    })
    els.countCustom = el('input', {
      type: 'number',
      class: 'ruxi-ig__num',
      value: settings.count > 5 ? settings.count : '',
      min: 1,
      max: 20,
      placeholder: '张数',
    })
    els.countCustom.addEventListener('input', function () {
      var n = parseInt(els.countCustom.value, 10)
      settings.count = isFinite(n) ? Math.max(1, Math.min(20, n)) : 1
      persist()
    })
    els.countCustomWrap = el('div', { class: 'ruxi-ig__sub', style: 'display:none' })
    els.countCustomWrap.appendChild(els.countCustom)

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
    els.insert.addEventListener('click', insertImages)

    var head = el('div', { class: 'ruxi-ig__title', text: '入戏生图' })

    ;[
      head,
      labeled('生图接口 URL', els.url),
      labeled('接口协议', els.protocol),
      labeled('API Key（可选）', els.key),
      labeled('模型（OpenAI 协议）', modelRow),
      labeled('尺寸', els.size),
      els.customSizeWrap,
      labeled('Prompt 模板（支持 {{char}} / {{user}}）', els.template),
      ctxRow,
      labeled('图文插入位置', els.insertPosition),
      labeled('生成张数', els.count),
      els.countCustomWrap,
      els.generate,
      els.status,
      els.previewWrap,
      els.insert,
    ].forEach(function (n) {
      root.appendChild(n)
    })

    document.body.appendChild(root)
  }

  // ---- 拉取模型 ----
  async function onFetchModels() {
    var url = (settings.apiUrl || '').trim()
    if (!url) {
      showStatus('未配置接口', true)
      return
    }
    els.fetchModels.disabled = true
    els.fetchModels.textContent = '拉取中…'
    showStatus('拉取模型列表…')
    try {
      var ids = await requestModels(url, settings)
      if (!ids || ids.length === 0) {
        showStatus('未拉到模型（接口可能不支持 /models 列表）', true)
        return
      }
      settings.models = ids
      persist()
      fillModelOptions()
      showStatus('已拉到 ' + ids.length + ' 个模型，可从下拉选择')
    } catch (e) {
      showStatus('拉取模型失败：' + (e && e.message ? e.message : e), true)
    } finally {
      els.fetchModels.disabled = false
      els.fetchModels.textContent = '拉取模型'
    }
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
    var count = resolveCount(settings)

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
      var images = []
      if (protocol === 'openai') {
        // OpenAI：body.n = count，一次请求，data 数组里取全部
        var payload = await requestImage(url, protocol, prompt, settings, count)
        images = extractImagesFromPayload(payload).map(normalizeImage).filter(Boolean)
      } else {
        // 通用：循环 count 次，每次一张
        for (var i = 0; i < count; i++) {
          var p = await requestImage(url, protocol, prompt, settings, 1)
          var img = normalizeImage(extractImageFromPayload(p))
          if (img) images.push(img)
        }
      }

      if (!images.length) throw new Error('未能从响应中提取到图片（URL 或 base64）')

      state.images = images
      els.preview.src = images[0].dataUrl
      els.previewWrap.style.display = 'block'
      els.insert.disabled = false
      showStatus('生成成功（' + images.length + ' 张）')

      // 生成成功后自动插入正文；手动「插入对话」可再插一次
      await insertImages()
    } catch (e) {
      showStatus('出错：' + (e && e.message ? e.message : e), true)
    } finally {
      setGenerating(false)
    }
  }

  // ---- 插入正文 ----
  async function insertImages() {
    var imgs = state.images
    if (!imgs || imgs.length === 0) {
      showStatus('还没有可插入的图片', true)
      return
    }
    var parts = imgs.map(function (img) {
      if (img.url) return '![' + '图片' + '](' + img.url + ')'
      if (img.bytes > 1024 * 1024) {
        toast('图片为 dataURL 且超过 1MB，无外链可用，仍以 dataURL 插入（可能较占存储）', 'warning')
      }
      return '![' + '图片' + '](' + img.dataUrl + ')'
    })
    var markdown = parts.join('\n')
    try {
      await API.addOneMessage({
        role: 'assistant',
        content: markdown,
        position: settings.insertPosition || 'bottom',
      })
      showStatus('已插入对话')
    } catch (e) {
      showStatus('插入失败：' + (e && e.message ? e.message : e), true)
    }
  }

  buildUI()
  syncFormFromSettings() // 时机 1：构建后立即回填一次
  API.eventSource.on('APP_READY', function () {
    syncFormFromSettings() // 时机 2：宿主就绪（与 getSettings 回填先后不稳定，故不能只靠它）
  })
  setTimeout(function () {
    syncFormFromSettings() // 时机 3：兜底再回填一次（幂等，无害）
  }, 300)
})()
