# 入戏生图（ruxi-imagegen）

「入戏（ai-rp-chat）」的生图插件：在扩展面板里配置生图接口，读取当前对话上下文生成图片，并插入对话正文。

## 用法

1. 将本仓库以「整仓直装」方式安装到入戏（`manifest.json` + `index.js` + `style.css`）。
2. 打开扩展列表 → 本扩展 →「面板」。
3. 配置：
   - **生图接口 URL**：留空时点「生成」会提示「未配置接口」。
   - **接口协议**：`自动`（按 URL 判断）/ `OpenAI images/generations` / `通用`。
   - **API Key**：可选，明文输入框（`type=password`）。留空则不发送 `Authorization` 头。
   - **模型 / 尺寸**：OpenAI 协议用；留空时模型回退 `dall-e-3`、尺寸回退 `1024x1024`。
   - **Prompt 模板**：多行文本，支持 `{{char}}` / `{{user}}` 占位符。
   - **附上最近对话上下文**：默认开启，默认取最近 6 条，可调（1–50）。
4. 点「生成」→ 显示 loading → 成功后在面板内预览缩略图，并**自动插入一次**对话正文。
   「插入对话」按钮可在生成成功后**再插一次**。

## manifest 字段

入戏扩展运行时（`client/src/lib/extension-runtime.ts` 的 `renderExtension`）解析：

- `js`：入口脚本路径（string）。缺失时回退 `index.js` → `dist/index.js`。
- `css`：样式文件路径数组（string[]），逐个内联为 `<style>`。
- `name`：扩展显示名（`extensions.ts` 的 `resolveRepoName` 读取）。

## 两种生图接口协议

### a) OpenAI `images/generations` 标准

`POST` JSON，请求头 `Authorization: Bearer <你的KEY>`：

```json
{ "model": "dall-e-3", "prompt": "...", "n": 1, "size": "1024x1024" }
```

从响应 `data[0].url`（URL）或 `data[0].b64_json`（base64）取图。`b64_json` 会转成 `data:image/png;base64,...`。

### b) 通用（返回图片 URL 或 dataURL 的任意接口）

`POST` JSON `{ "prompt": "..." }`；若 POST 失败，回退 `GET ?prompt=<urlencoded>`。
从响应体（JSON 或纯文本）中提取第一个 `data:image/...` 或 `http(s)://...(.png/.jpg/.jpeg/.webp/.gif)`。

## 占位符

| 占位符 | 含义 |
|--------|------|
| `{{char}}` | 当前角色名（`getContext().char`） |
| `{{user}}` | 当前用户名（`getContext().user`） |
| `{{name1}}` | 等价 `char` |
| `{{name2}}` | 等价 `user` |

## 插入正文规则

- 图片是外链 URL → 直接插入 `![图片](url)`。
- 图片是 dataURL 且约 > 1MB → 无外链可用时仍以 dataURL 插入，但给提示（避免撑爆 IndexedDB 时优先外链）。

## 宿主 API 挂载方式（核对要点）

入口脚本在沙箱 iframe 的 document 里执行，通过以下方式取宿主能力：

```js
var API = window.__ruxiRequire('script.js') // 对应 shim buildScript() 返回的 API 对象
// API.getContext() / API.addOneMessage() / API.saveSettingsDebounced() / API.eventSource ...
// 设置读写：全局 extension_settings（get/set 自动持久化到 ext_settings_v1）
```

## 注意事项

- 生图接口需允许跨域（`Access-Control-Allow-Origin`），沙箱 iframe 为 opaque origin（`connect-src *` 已放开网络，但目标服务端仍需 CORS 允许）。
- API Key 仅本地明文存储于浏览器 IndexedDB，请勿在 README / 代码中提交真实 Key（统一用占位 `<你的KEY>`）。

## 目录结构

```
manifest.json   扩展清单（js/css/name）
index.js        入口脚本（面板 UI + 生图逻辑 + 插入正文）
style.css       面板样式
scripts/selftest.js  开发自验脚本（node，不参与扩展运行时）
```

## 自验

```bash
node scripts/selftest.js           # manifest 入口解析 + API 调用写法核对 + 纯函数断言
node scripts/integration.test.js   # 本地 mock 服务端到端（OpenAI / 通用 / GET 回退）
node scripts/refill.test.js        # 设置回填时序（getSettings 异步回填 → 表单回填）
```

`selftest.js` 核对 manifest 入口解析、入口脚本对宿主 API 的调用写法、以及纯函数区（占位符替换 / 协议判定 / 图片提取 / base64 归一化）对固定输入的输出；`refill.test.js` 真正执行 `index.js`，模拟「boot 先渲染（settings 为空）→ getSettings 异步回填 → APP_READY / 300ms 兜底触发 `syncFormFromSettings`」的时序，断言表单控件值回填正确且不打断正在编辑的字段。
