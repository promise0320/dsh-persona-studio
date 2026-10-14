/**
 * 前端面板自检：用最小 DOM 桩在 Node 里跑 assets/panel.js，
 * 验证「挂载策略 / 状态绑定 / 交互路径」而不是靠肉眼看浏览器。
 *
 * 用法：node test/panel.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describeSpec, compilePersona, renderInjection } from '../lib/compile.mjs'
import { DEFAULT_SPEC, normalizeSpec } from '../lib/spec.mjs'

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩
 * ------------------------------------------------------------------ */

let idSeq = 0

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.childNodes = []
    this.parentNode = null
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this._id = ++idSeq
    this._className = ''
    this._text = ''
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c) => (this.classList._set.has(c) ? this.classList._set.delete(c) : this.classList._set.add(c)),
    }
  }

  get className() {
    return this._className
  }
  set className(value) {
    this._className = String(value)
    this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean))
    // 真实 DOM 里 class 是放在 attribute 上的，所以 `[class]` 选择器必须能命中；
    // 早期版本忘了同步这一条，导致 `querySelectorAll('[class]')` 恒为空。
    if (this._className) this.attributes.class = this._className
    else delete this.attributes.class
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map((n) => n.textContent ?? '').join('')
  }
  set textContent(value) {
    this.childNodes = []
    this._text = String(value ?? '')
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    // 与真实 DOM 一致：整棵树必须挂在 documentElement 上才算 connected。
    // （先前这里把 body 也当根，掩盖了挂载回退逻辑。）
    return node === doc.documentElement
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = ref ? this.childNodes.indexOf(ref) : -1
    if (index === -1) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    return child
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners[type] ?? []) handler({ target: this, preventDefault() {}, ...event })
  }
  getBoundingClientRect() {
    // 允许测试给某个节点指定屏幕坐标：宿主真实布局里输入框工具栏位于窗口底部，
    // 面板要据此决定"往上展开还是往下展开"
    if (this.fixedRect) return { ...this.fixedRect }
    return { left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 }
  }
  select() {}
  contains(node) {
    if (node === this) return true
    return this.childNodes.some((child) => child.contains?.(node))
  }

  /**
   * 极简选择器：支持 `.class` / `tag` / `[attr]` / `[attr*="v"]` / `*`，
   * 以及空格表示的后代组合（如 `.dpf-preview pre`）。逗号分隔的组会合并去重。
   */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector) {
    const out = []
    for (const rawGroup of String(selector).split(',')) {
      const group = rawGroup.trim()
      if (!group) continue
      const parts = group.split(/\s+/).filter(Boolean)
      let current = [this]
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]
        const next = []
        for (const base of current) {
          // 后代（不含自身），与浏览器语义一致
          for (const candidate of descendants(base)) {
            if (part === '*' || matchSimple(candidate, part)) next.push(candidate)
          }
        }
        current = next
        if (current.length === 0) break
      }
      for (const node of current) if (!out.includes(node)) out.push(node)
    }
    return out
  }
}

function descendants(node) {
  const out = []
  for (const child of node.childNodes) {
    out.push(child)
    out.push(...descendants(child))
  }
  return out
}

function matchSimple(node, part) {
  if (!node || node.nodeType !== 1) return false
  if (part.startsWith('.')) return node.classList.contains(part.slice(1))
  const attr = part.match(/^\[([^\]^$*=]+?)\s*(\*|\^|\$)?\s*=\s*["']?([^"'\]]*)["']?\]$/)
  if (attr) {
    const [, name, op, value] = attr
    const actual = readAttr(node, name)
    if (actual === undefined) return false
    if (!op) return true
    const text = String(actual)
    if (op === '=') return text === value
    if (op === '*') return text.includes(value)
    if (op === '^') return text.startsWith(value)
    if (op === '$') return text.endsWith(value)
    return false
  }
  // 不带操作符的 [attr]
  const bare = part.match(/^\[([^\]]+)\]$/)
  if (bare) return readAttr(node, bare[1]) !== undefined
  return node.tagName === part.toUpperCase()
}

/** 与真实 DOM 一致：class 走 className，其余走 attributes/dataset 映射。 */
function readAttr(node, name) {
  if (name === 'class') return node.className
  if (name === 'id') return node.attributes.id
  return node.attributes[name] ?? node.dataset[camel(name)]
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

/* ------------------------------------------------------------------ *
 * 文档 + 窗口桩
 * ------------------------------------------------------------------ */

const doc = {
  readyState: 'complete',
  documentElement: new StubNode('html'),
  head: new StubNode('head'),
  body: new StubNode('body'),
  listeners: {},
  createElement: (tag) => new StubNode(tag),
  createTextNode: (text) => {
    const node = new StubNode('#text')
    node.nodeType = 3
    node.textContent = text
    return node
  },
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  },
  dispatch(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event)
  },
  querySelector(selector) {
    return this.body.querySelector(selector) ?? this.documentElement.querySelector(selector)
  },
}

// 真实的文档树：html > head / body
doc.documentElement.appendChild(doc.head)
doc.documentElement.appendChild(doc.body)

// 复刻 dsh-client-ui-conversation 的真实输入区结构（锚点取自客户端 bundle）：
//   [data-composer-seat] > .X_composerStack > [data-composer-card] > .X_row > (.X_tools | .X_trailing)
const HASH = 'Dc7zOa_'
const seat = new StubNode('div')
seat.setAttribute('data-composer-seat', '')
seat.setAttribute('data-conversation-region', 'composer')
seat.className = `${HASH}composerSeat`

const stack = new StubNode('div')
stack.className = `${HASH}composerStack`

const card = new StubNode('div')
card.className = `${HASH}card`
card.setAttribute('data-composer-card', '')

const inputBox = new StubNode('div')
inputBox.setAttribute('data-composer-input', '')
inputBox.setAttribute('role', 'textbox')
inputBox.setAttribute('aria-multiline', 'true')

const row = new StubNode('div')
row.className = `${HASH}row`

const tools = new StubNode('div')
tools.className = `${HASH}tools`
const trailing = new StubNode('div')
trailing.className = `${HASH}trailing`
const standardControls = new StubNode('div')
standardControls.className = `${HASH}standardControls`
trailing.appendChild(standardControls)

row.appendChild(tools)
row.appendChild(trailing)
card.appendChild(inputBox)
card.appendChild(row)
stack.appendChild(card)
seat.appendChild(stack)
doc.body.appendChild(seat)

// 便于测试里断言"挂到了哪"
const toolbar = trailing
const toolbarLeft = tools

// 模拟真实布局：窗口 1400×800，输入卡片贴在窗口底部（窗口尺寸在下面 win 定义处设置）
seat.fixedRect = { left: 320, right: 1080, top: 600, bottom: 780, width: 760, height: 180 }
card.fixedRect = { left: 320, right: 1080, top: 600, bottom: 780, width: 760, height: 180 }
row.fixedRect = { left: 336, right: 1064, top: 740, bottom: 774, width: 728, height: 34 }
trailing.fixedRect = { left: 900, right: 1060, top: 740, bottom: 774, width: 160, height: 34 }
tools.fixedRect = { left: 340, right: 520, top: 740, bottom: 774, width: 180, height: 34 }

const statePayload = {
  ok: true,
  state: {
    config: { enabled: true, focus: 'balanced', llmDeepRead: false, maxSessions: 8, placement: 'toolbar-right', locale: 'zh' },
    activeId: 'p1',
    active: {
      id: 'p1',
      name: '严谨工程师',
      tags: ['工程'],
      source: 'seed',
      spec: {
        identity: { name: '严谨工程师', title: '资深工程师', address: '你', selfRef: '我', oneLiner: '先给能跑的方案' },
        style: { tone: 'neutral', verbosity: 'concise', warmth: 25, formality: 60, directness: 85, humor: 10, emoji: 'never', metaphor: 'when-explaining', punct: '', signaturePhrases: [], avoidPhrases: [], language: 'auto' },
        habits: { planning: 'todo-list', structure: 'code-first', exploration: 25, verification: 'commands', commentStyle: 'sparse', artifact: 'files', initiative: 65, riskAppetite: 'measured', customHabits: [] },
        feedback: { uncertainty: 'assume-and-flag', critique: 'severity-tagged', suggestionDepth: 90, praise: 15, questionPolicy: 'one-at-a-time', progressReporting: 'milestones', errorHandling: 'root-cause', customRules: [] },
        boundaries: { mustAlways: [], mustNever: [], custom: '' },
        tuning: { temperature: 0.6, injectHead: false, focus: 'balanced' },
      },
      summary: '资深工程师 · 中性专业 · 简洁',
      compiled: '## 人格档案：严谨工程师',
    },
    personas: [
      { id: 'p1', name: '严谨工程师', summary: 's', tags: ['工程'], source: 'seed', spec: {} },
      { id: 'p2', name: '极简执行者', summary: 's2', tags: [], source: 'template', spec: {} },
    ],
    templates: {
      builtin: [{ id: 'builtin:engineer', name: '严谨工程师', tags: ['工程'], summary: 'sum', source: 'builtin', spec: {} }],
      files: [],
    },
    spec: describeSpec(),
    defaults: DEFAULT_SPEC,
    blankSpec: normalizeSpec({}),
    injection: '<persona>…</persona>',
    traces: [{ time: Date.now(), kind: 'activate', name: '严谨工程师', reason: 'ui' }],
    paths: { root: 'R', library: 'L', config: 'C', templates: 'T', compiled: 'X' },
    modelRoute: { provider: 'deepseek-official', model: 'deepseek-flash' },
    sessions: [{ id: 'session-1', title: '编译人格插件', createdAt: 0 }],
    version: 1,
  },
}

const fetchCalls = []
const fetchStub = async (url, options) => {
  let parsed = null
  try {
    parsed = options && options.body ? JSON.parse(options.body) : null
  } catch {
    parsed = null
  }
  fetchCalls.push({ url, method: (options && options.method) || 'GET', body: parsed })
  const body =
    url === '/dsh-persona-studio/state'
      ? statePayload
      : url === '/dsh-persona-studio/preview'
        ? // 用真实编译器编译请求里的规格：这样"改了参数预览就该变"才是真的被验证，
          // 否则固定返回同一段文字，测试永远发现不了"预览不更新"（踩过这个坑）。
          { ok: true, compiled: compilePersona(parsed && parsed.spec), injection: renderInjection(parsed && parsed.spec) }
        : url === '/dsh-persona-studio/generate'
          ? { ok: true, proposal: { spec: { identity: { name: '归纳人格' } }, rationale: ['r'], evidence: { messages: 8 }, confidence: 70, templateId: 'builtin:engineer' }, history: { messages: 8, sessions: 2, usedLiveSessions: 2 }, state: statePayload.state }
          : { ok: true, state: statePayload.state }
  return { status: 200, json: async () => body }
}

const win = {
  __DSH_PERSONA_FORGE__: undefined,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  confirm: () => true,
  open() {},
  requestAnimationFrame: (fn) => fn(),
}

let observerCallbackRuns = 0
const sandbox = {
  window: win,
  document: doc,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: fetchStub,
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => fn(),
  // 把面板抛出的任何未捕获错误抓出来（否则会被测试框架的 try/catch 掩盖）
  onerror: (event) => {
    console.log('  [面板未捕获错误]', event && (event.message || event))
  },
  reportError: (error) => {
    console.log('  [面板报告错误]', error && error.message)
  },
  // 真实 MutationObserver：面板的"宿主重挂载时跟随"逻辑依赖它。
  // 早期这里的 observe() 是空实现，导致漏掉了"每次重渲染就触发一次回调"这类问题。
  MutationObserver: class {
    constructor(cb) {
      this._cb = cb
      this._targets = []
    }
    observe(target, options) {
      this._targets.push({ target, options })
    }
    disconnect() {
      this._targets = []
    }
    /** 测试用：手动触发一次回调，模拟宿主 DOM 变化 */
    trigger() {
      observerCallbackRuns += 1
      if (typeof this._cb === 'function') this._cb([], this)
    }
  },
  URL,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Error,
  Promise,
}
sandbox.globalThis = sandbox
win.document = doc
// 窗口尺寸要在加载面板脚本之前设好：面板初始化时就会按几何算位置
win.innerWidth = 1400
win.innerHeight = 800
win.requestAnimationFrame = sandbox.requestAnimationFrame
win.matchMedia = sandbox.window.matchMedia

const code = fs.readFileSync(
  process.env.DPF_PROBE === '1'
    ? path.resolve(new URL('../.probe/panel-probe.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    : path.resolve(new URL('../assets/panel.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  'utf8',
)
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'panel.js' })

const tick = () => new Promise((resolve) => setTimeout(resolve, 40))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}`)
    console.log(`      原因：${error && error.message}`)
  }
}

console.log('[面板] 挂载与状态')

await tick()
await tick()

const root = doc.body.querySelector('.dpf-root')
const debugMount = process.env.DPF_DEBUG === '1'
if (debugMount) {
  console.log('  [debug] body.querySelector([data-composer-seat]) ->', doc.body.querySelector('[data-composer-seat]')?._id, '期望', seat._id)
  console.log('  [debug] seat.querySelectorAll([class]) ->', seat.querySelectorAll('[class]').map((n) => `${n.className}#${n._id}`).join(', '))
  console.log('  [debug] seat 里 _trailing 命中 ->', seat.querySelectorAll(`.${HASH}trailing`).map((n) => n._id).join(',') || '空')
  console.log('  [debug] root.parentNode =', `${root.parentNode?.tagName}.${root.parentNode?.className}#${root.parentNode?._id}`)
  console.log('  [debug] state 里的 placement =', JSON.stringify(statePayload.state.config.placement))
  console.log('  [debug] 按钮文案 =', JSON.stringify(root.querySelector('.dpf-pill-label')?.textContent))
}

check('面板根节点被挂载', () => {
  assert.ok(root, '.dpf-root 未出现在文档里')
})

check('优先挂在输入框工具栏右侧（真实锚点 ._trailing）', () => {
  assert.ok(
    root.parentNode === toolbar,
    `期望挂在 trailing#${toolbar._id}，实际父节点 #${root.parentNode && root.parentNode._id} ${root.parentNode && root.parentNode.className}`,
  )
  assert.equal(root.dataset.placement, 'toolbar-right')
})

check('按钮文案绑定到当前人格名', () => {
  const label = root.querySelector('.dpf-pill-label')
  assert.equal(label.textContent, '严谨工程师')
})

check('注入开关反映配置状态', () => {
  const checkbox = root.querySelector('.dpf-switch').querySelector('input')
  assert.ok(checkbox, '没有找到注入开关的 input')
  assert.equal(checkbox.checked, true)
  assert.equal(checkbox.attributes.type, 'checkbox')
})

check('面板初始为关闭', () => {
  const panel = root.querySelector('.dpf-panel')
  assert.equal(panel.dataset.open, 'false')
})

check('宿主 DOM 缺失工具栏时会落到右下角悬浮（回退不失效）', () => {
  const api = win.__DSH_PERSONA_FORGE_API__
  assert.ok(api && typeof api.remount === 'function', '面板没有暴露自检 API')
  // 临时隐藏真实锚点，验证回退分支
  const savedTools = tools.className
  const savedTrailing = trailing.className
  tools.className = ''
  trailing.className = ''
  try {
    api.remount()
    assert.equal(root.parentNode, doc.body, '回退时应挂在 body 上')
    assert.equal(root.dataset.placement, 'floating')
  } finally {
    tools.className = savedTools
    trailing.className = savedTrailing
    api.remount()
  }
  assert.equal(root.parentNode, trailing, '恢复锚点后应重新挂回工具栏')
})

check('首屏会拉取一次状态', () => {
  assert.ok(fetchCalls.some((c) => c.url === '/dsh-persona-studio/state'))
})

console.log('\n[面板] 交互')

const pill = root.querySelector('.dpf-pill')
pill.dispatch('click')
await tick()

check('点击按钮打开面板', () => {
  assert.equal(root.querySelector('.dpf-panel').dataset.open, 'true')
})

check('面板用固定定位、紧贴输入框往上展开（不会被输入框或聊天挡住）', () => {
  const panel = root.querySelector('.dpf-panel')
  assert.equal(panel.style.position, 'fixed', '面板应为固定定位')
  // 向上展开用"离底部多远"定位，让面板紧贴输入框往上长。
  // 曾经改成按高度反推 top，结果面板顶端被顶到屏幕上沿，用户反馈"位置太上面了"。
  assert.ok(panel.style.bottom, '向上展开应按 bottom 定位（紧贴输入框）')
  assert.equal(panel.style.top, '', '向上展开时不应设 top')
  assert.ok(
    Number(String(panel.style.zIndex)) >= 1000,
    `z-index 太小会被盖住：${panel.style.zIndex}`,
  )
  assert.ok(panel.style.maxHeight, '应限制最大高度以免顶出屏幕')

  // 关键：面板底边必须正好落在锚点上方一点点，而不是飘到屏幕上方去
  const panelBottom = Number(String(panel.style.bottom).replace('px', ''))
  const expectedBottom = 800 - trailing.fixedRect.top + 8 // 视口高 - 锚点顶边 + 间距
  assert.equal(panelBottom, expectedBottom, `面板底边应贴着输入框，期望 ${expectedBottom}，实际 ${panelBottom}`)

  // 按钮本身也要固定定位：否则它所在的容器有 transform 时会成为包含块，面板会被裁掉
  assert.equal(root.style.position, 'fixed', '按钮也应为固定定位，避免锚点容器的层叠/裁剪影响')
})

check('上方空间不足时会自动改为往下展开', () => {
  const panel = root.querySelector('.dpf-panel')
  const savedTrailing = trailing.fixedRect
  const savedTools = tools.fixedRect
  // 把锚点挪到屏幕最上方：上方基本没空间，展开方向应翻转
  trailing.fixedRect = { left: 900, right: 1060, top: 6, bottom: 40, width: 160, height: 34 }
  tools.fixedRect = { left: 340, right: 520, top: 6, bottom: 40, width: 180, height: 34 }
  try {
    win.__DSH_PERSONA_FORGE_API__.remount()
    const top = Number(String(panel.style.top).replace('px', ''))
    const belowAnchor = 40 + 8 // 锚点底边 + 间距
    assert.ok(top >= belowAnchor - 1, `应翻到锚点下方（top 应 ≥ ${belowAnchor}），实际 ${panel.style.top}`)
  } finally {
    trailing.fixedRect = savedTrailing
    tools.fixedRect = savedTools
    win.__DSH_PERSONA_FORGE_API__.remount()
  }
  assert.ok(panel.style.bottom, '恢复到底部位置后应重新按 bottom 往上展开')
  assert.equal(panel.style.top, '', '恢复后不应残留 top')
})

check('打开后渲染出五个标签页', () => {
  const tabs = root.querySelector('.dpf-tabs').childNodes.filter((n) => n.nodeType === 1)
  assert.equal(tabs.length, 5)
  assert.deepEqual(
    tabs.map((t) => t.dataset.tab),
    ['library', 'templates', 'editor', 'generate', 'settings'],
  )
})

check('人格库页渲染出全部人格卡片', () => {
  const cards = root.querySelectorAll('.dpf-card')
  assert.ok(cards.length >= 2, `卡片数量 ${cards.length}`)
  const names = cards.map((c) => c.querySelector('.dpf-card-name').textContent)
  assert.ok(names.includes('严谨工程师'))
  assert.ok(names.includes('极简执行者'))
})

// 切到编辑器（预览有 220ms 防抖，等它落定）
const editorTab = root.querySelector('.dpf-tabs').childNodes.filter((n) => n.dataset && n.dataset.tab === 'editor')[0]
editorTab.dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 400))

if (debugMount) {
  const previewBox = root.querySelector('.dpf-preview')
  console.log('  [debug] 编辑器 body 文本 =', JSON.stringify(root.querySelector('.dpf-body').textContent.slice(0, 120)))
  console.log('  [debug] .dpf-preview pre 命中 =', root.querySelectorAll('.dpf-preview pre').length)
  console.log('  [debug] 预览内容 =', JSON.stringify(previewBox ? previewBox.querySelector('pre')?.textContent : null))
  console.log('  [debug] fetch 调用 =', fetchCalls.map((c) => `${c.method} ${c.url}`).join(', '))
}

check('编辑器按规格渲染表单字段', () => {
  const selects = root.querySelectorAll('.dpf-select')
  assert.ok(selects.length >= 1, '没有渲染出 select 字段')
  const labels = root.querySelectorAll('.dpf-field-label').map((n) => n.textContent)
  assert.ok(labels.some((t) => t.includes('语气基调')), `字段标签：${labels.join(' | ')}`)
})

check('编辑器有实时预览区并已填充编译结果', () => {
  const pre = root.querySelector('.dpf-preview pre')
  assert.ok(pre, '缺少预览区')
  // 预览内容应来自真实的编译结果（测试里用真实编译器生成，所以能验证"预览会变"）
  assert.ok(pre.textContent.includes('<persona>'), `预览应是注入文本，实际：${String(pre.textContent).slice(0, 80)}`)
  assert.ok(pre.textContent.includes('人格档案'), '预览应包含编译出的人格档案')
  assert.ok(fetchCalls.some((c) => c.url === '/dsh-persona-studio/preview' && c.method === 'POST'), '预览没有走 POST /preview')
})

check('编辑器提供保存/创建与导出按钮', () => {
  const buttons = root.querySelectorAll('.dpf-btn').map((b) => b.textContent)
  assert.ok(buttons.some((t) => /保存|创建/.test(t)), buttons.join(' | '))
  assert.ok(buttons.some((t) => /导出/.test(t)))
})

// 切到自动归纳
const genTab = root.querySelector('.dpf-tabs').childNodes.filter((n) => n.dataset && n.dataset.tab === 'generate')[0]
genTab.dispatch('click')
await tick()

check('自动归纳页显示可分析的会话与模型路由', () => {
  const hints = root.querySelectorAll('.dpf-hint').map((n) => n.textContent).join('\n')
  assert.ok(hints.includes('编译人格插件'), '没有显示在线会话标题')
  assert.ok(hints.includes('deepseek-official'), '没有显示模型路由')
})

const genButton = root.querySelectorAll('.dpf-btn').filter((b) => b.textContent === '开始归纳')[0]
genButton.dispatch('click')
await tick()
await tick()

check('点击归纳会调用 /generate 并渲染依据', () => {
  assert.ok(fetchCalls.some((c) => c.url === '/dsh-persona-studio/generate' && c.method === 'POST'), '未调用 /generate')
  const body = root.querySelector('.dpf-body').textContent
  assert.ok(body.includes('归纳结果'), '没有渲染归纳结果')
  assert.ok(body.includes('判断依据'), '没有渲染判断依据')
})

// 切到设置
const settingsTab = root.querySelector('.dpf-tabs').childNodes.filter((n) => n.dataset && n.dataset.tab === 'settings')[0]
settingsTab.dispatch('click')
await tick()

check('设置页显示数据路径与倾向轨迹', () => {
  const text = root.querySelector('.dpf-body').textContent
  assert.ok(text.includes('人格库：L'), '缺少人格库路径')
  assert.ok(text.includes('倾向轨迹'), '缺少倾向轨迹标题')
})

check('设置页有「人格到底生效了吗」自检（回应"改了不生效"）', () => {
  const text = root.querySelector('.dpf-body').textContent
  assert.ok(text.includes('人格到底生效了吗'), '缺少送达自检板块')
  assert.ok(text.includes('结论'), '自检应给出一句明确结论')
  assert.ok(text.includes('总开关'), '自检应列出总开关状态')
})

await (async () => {
  const label = '数据文件损坏时，设置页给出警告与恢复入口'
  try {
    // 造一份"损坏"的 health 报告，喂给面板
    const broken = JSON.parse(JSON.stringify(statePayload))
    broken.state.health = {
      ok: false,
      summary: '检测到数据文件损坏，已保留原文件并暂时使用默认值，未覆盖你的数据。',
      issues: [{ file: 'C:\\x\\.dsh\\persona\\library.json', state: 'corrupt', error: 'Unexpected end of JSON input', preserved: null }],
    }
    const api = win.__DSH_PERSONA_FORGE_API__
    api.applyState(broken)
    tabButton('settings').dispatch('click')
    await wait(80)
    const text = root.querySelector('.dpf-body').textContent
    assert.ok(text.includes('数据文件损坏'), '损坏时设置页应显示警告')
    assert.ok(text.includes('library.json'), '警告里应点名是哪个文件')
    assert.ok(text.includes('备份') || text.includes('重建'), '应给出恢复入口')
    const buttons = root.querySelectorAll('.dpf-btn').map((b) => b.textContent)
    assert.ok(buttons.some((t) => t.includes('重建')), `应有重建按钮，实际按钮：${buttons.join(' / ')}`)

    // 复原
    api.applyState(statePayload)
    tabButton('settings').dispatch('click')
    await wait(80)
    assert.equal(root.querySelector('.dpf-body').textContent.includes('数据文件损坏'), false, '恢复后不该再显示警告')
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}`)
    console.log(`      原因：${error && error.message}`)
  }
})()

await wait(80)

check('在设置页切换挂载位置会立刻重挂到左侧工具栏', () => {
  const select = root.querySelectorAll('.dpf-select').filter((s) => {
    // 位置选择器是唯一一个含 "toolbar-right" 选项的 select
    return s.childNodes.some((o) => o.attributes && o.attributes.value === 'toolbar-right')
  })[0]
  assert.ok(select, '设置页没有渲染「面板挂载位置」选择器')
  select.value = 'toolbar-left'
  select.dispatch('change', { target: { value: 'toolbar-left' } })
  assert.equal(root.parentNode, toolbarLeft, `实际父节点 ${root.parentNode && root.parentNode.className}`)
  assert.equal(root.dataset.placement, 'toolbar-left')
})

await wait(80)

check('位置选择会写回宿主配置，并能复原', () => {
  const call = fetchCalls.filter((c) => c.url === '/dsh-persona-studio/save' && c.method === 'POST').pop()
  assert.ok(call, '没有把位置写回配置')
  assert.equal(call.body.action, 'config')
  assert.equal(call.body.config.placement, 'toolbar-left')

  const select = root.querySelectorAll('.dpf-select').filter((s) =>
    s.childNodes.some((o) => o.attributes && o.attributes.value === 'toolbar-right'),
  )[0]
  select.value = 'toolbar-right'
  select.dispatch('change', { target: { value: 'toolbar-right' } })
  assert.equal(root.parentNode, toolbar, '复原后应回到右侧工具栏')
  assert.equal(root.dataset.placement, 'toolbar-right')
})

check('Esc 可以关闭面板', () => {
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(root.querySelector('.dpf-panel').dataset.open, 'false')
})

console.log('\n[面板] 兼容旧宿主：元数据缺 section 时界面也必须能正确写入')

await (async () => {
  const label = '宿主元数据缺 section 时，编辑仍写进正确分类（客户端自带分类兜底）'
  try {
    // 模拟"老宿主"：把规格元数据里的 section 全部去掉（真实宿主就是这样）
    const stripped = JSON.parse(JSON.stringify(statePayload))
    for (const section of stripped.state.spec.sections) {
      for (const field of section.fields) delete field.section
    }
    // 重新载入面板（用同一份桩，但 state 换成缺 section 的版本）
    const savedSpec = statePayload.state.spec
    statePayload.state.spec = stripped.state.spec
    const api = win.__DSH_PERSONA_FORGE_API__
    try {
      api.state().form = null
      api.applyState(statePayload)
      tabButton('editor').dispatch('click')
      await wait(400)
      const tone = root.querySelectorAll('.dpf-select')[0]
      tone.dispatch('change', { target: { value: 'witty' } })
      await wait(300)
      const form = api.state().form
      assert.equal(form.spec.style.tone, 'witty', '编辑没有写进 style 分类')
      assert.equal(
        Object.prototype.hasOwnProperty.call(form.spec, 'undefined'),
        false,
        '仍然出现了 spec.undefined 这个错误分类',
      )
    } finally {
      statePayload.state.spec = savedSpec
      api.state().form = null
      api.applyState(statePayload)
    }
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}`)
    console.log(`      原因：${error && error.message}`)
  }
})()

await wait(80)

/** 读取"表单里实际保存的数据"（关键：不要读 DOM 属性，滑块的值不会回写到属性上） */
function readFormValues() {
  const st = win.__DSH_PERSONA_FORGE_API__.state()
  const spec = (st.form && st.form.spec) || {}
  const out = { name: st.form && st.form.name }
  for (const section of Object.keys(spec)) {
    const group = spec[section] || {}
    for (const key of Object.keys(group)) {
      const value = group[key]
      out[section + '.' + key] = typeof value === 'object' ? JSON.stringify(value) : String(value)
    }
  }
  return out
}

await (async () => {
  const label = '预览随编辑更新，且离开编译页再回来不丢编辑'
  try {
    win.__DSH_PERSONA_FORGE_API__.open()
    tabButton('editor').dispatch('click')
    await wait(400)

    // 展开"对话风格"和"创作习惯"，让页面接近用户实际看到的样子
    for (const head of root.querySelectorAll('.dpf-section-head')) {
      if (/对话风格|创作习惯/.test(head.textContent)) head.dispatch('click')
    }
    await wait(80)

    const previewPre = root.querySelector('.dpf-preview pre')
    const before = previewPre.textContent

    // 改一个必然体现在编译结果里的字段：语气基调 -> 幽默机敏
    const tone = root.querySelectorAll('.dpf-select')[0]
    tone.dispatch('change', { target: { value: 'witty' } })
    await wait(500)

    const after = previewPre.textContent
    if (debugMount) {
      const lastPreview = fetchCalls.filter((c) => c.url === '/dsh-persona-studio/preview').pop()
      console.log('  [debug] 预览请求体顶层键 =', lastPreview && lastPreview.body ? Object.keys(lastPreview.body).join(',') : 'none')
      console.log('  [debug] 预览请求里的 spec 键 =', lastPreview && lastPreview.body && lastPreview.body.spec ? Object.keys(lastPreview.body.spec).join(',') : 'none')
      console.log('  [debug] 预览请求里的 style =', JSON.stringify(lastPreview && lastPreview.body && lastPreview.body.spec && lastPreview.body.spec.style))
      console.log('  [debug] 预览 after 前 120 =', JSON.stringify(String(after).slice(0, 120)))
    }
    if (debugMount) {
      const api = win.__DSH_PERSONA_FORGE_API__
      console.log('  [debug] 预览 before =', JSON.stringify(before))
      console.log('  [debug] 预览 after  =', JSON.stringify(after))
      console.log('  [debug] 表单 spec.style =', JSON.stringify(api.state().form && api.state().form.spec && api.state().form.spec.style))
      console.log('  [debug] 表单 dirty =', api.state().form && api.state().form.dirty)
      console.log('  [debug] preview 请求次数 =', fetchCalls.filter((c) => c.url === '/dsh-persona-studio/preview').length)
      console.log('  [debug] 诊断 =', JSON.stringify(api.diagnostics ? api.diagnostics() : null))
    }
    assert.notEqual(after, before, '改了语气后预览内容应该变化')
    assert.ok(after.includes('机敏、有梗'), `预览应体现新语气，实际：${String(after).slice(0, 160)}`)

    // 再改一个滑块
    const range = root.querySelectorAll('.dpf-range')[0]
    const rangeBefore = previewPre.textContent
    if (debugMount) {
      const st0 = win.__DSH_PERSONA_FORGE_API__.state()
      console.log('  [debug] 拖滑块前 form.style.warmth =', st0.form.spec.style.warmth)
      console.log('  [debug] 滑块监听器 =', JSON.stringify(Object.keys(range.listeners || {})))
      console.log('  [debug] 滑块当前 value 属性 =', range.attributes.value)
    }
    range.dispatch('input', { target: { value: '90' } })
    if (debugMount) {
      const st1 = win.__DSH_PERSONA_FORGE_API__.state()
      console.log('  [debug] 拖滑块后 form.style.warmth =', st1.form.spec.style.warmth)
    }
    await wait(500)
    assert.notEqual(previewPre.textContent, rangeBefore, '拖动滑块后预览内容应该变化')

    const snapshot = readFormValues()
    if (debugMount) {
      const st = win.__DSH_PERSONA_FORGE_API__.state()
      console.log('  [debug] 离开前 warmth =', st.form.spec.style.warmth, ' dirty =', st.form.dirty, ' id =', st.form.id)
      console.log('  [debug] 离开前 style.warmth =', snapshot['style.warmth'])
    }
    assert.ok(Object.keys(snapshot).length >= 4, '编译页字段太少，测试没有覆盖到')

    // 离开编译页去别的页签，再回来
    tabButton('library').dispatch('click')
    await wait(80)
    tabButton('templates').dispatch('click')
    await wait(80)
    tabButton('editor').dispatch('click')
    await wait(500)

    if (debugMount) {
      const st = win.__DSH_PERSONA_FORGE_API__.state()
      console.log('  [debug] 回来后 warmth =', st.form.spec.style.warmth, ' dirty =', st.form.dirty, ' id =', st.form.id)
      console.log('  [debug] 回来后 style.warmth =', readFormValues()['style.warmth'])
    }

    const restored = readFormValues()
    for (const key of Object.keys(snapshot)) {
      assert.equal(restored[key], snapshot[key], `${key} 的值在离开后被重置了（${snapshot[key]} -> ${restored[key]}）`)
    }
    assert.equal(
      root.querySelector('.dpf-preview pre').textContent,
      previewPre.textContent,
      '回到编译页后预览内容变了',
    )
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}`)
    console.log(`      原因：${error && error.message}`)
  }
})()

await wait(80)

console.log('\n[面板] 编辑后再来回切页签（用户反馈：编译页待久了回不去别的页签）')

function tabButton(name) {
  const all = root.querySelector('.dpf-tabs').childNodes
  for (const node of all) {
    if (node.dataset && node.dataset.tab === name) return node
  }
  return null
}

await (async () => {
  try {
    win.__DSH_PERSONA_FORGE_API__.open()
    const tabsEl = root.querySelector('.dpf-tabs')
    if (debugMount) {
      console.log('  [debug] tabs 元素 =', tabsEl ? `${tabsEl.tagName}#${tabsEl._id}` : 'null')
      console.log('  [debug] tabs 子节点 =', tabsEl ? tabsEl.childNodes.map((n) => `${n.tagName}[${n.dataset && n.dataset.tab}]`).join(',') : '-')
    }
    const editorButton = tabButton('editor')
    assert.ok(editorButton, '找不到「编译」页签按钮')
    editorButton.dispatch('click')
    await wait(400)

    // 模拟用户连续改多项：下拉、滑块、文本框各来一次
    // 注意：风格刻度在折叠分组里，必须先展开（真实用户也要点一下）
    const sectionHeads = root.querySelectorAll('.dpf-section-head')
    let styleHead = null
    for (const head of sectionHeads) {
      if (head.textContent.includes('对话风格')) styleHead = head
    }
    assert.ok(styleHead, '找不到「对话风格 · 语气语调」分组标题')
    styleHead.dispatch('click')
    await wait(60)
    assert.ok(root.querySelectorAll('.dpf-range').length > 0, '展开「对话风格」后应出现滑块字段')
    if (debugMount) {
      console.log('  [debug] 编译页元素计数: select=%d range=%d input=%d',
        root.querySelectorAll('.dpf-select').length,
        root.querySelectorAll('.dpf-range').length,
        root.querySelectorAll('.dpf-input').length)
    }
    const select = root.querySelectorAll('.dpf-select')[0]
    assert.ok(select, '编译页没有 select 字段')
    select.dispatch('change', { target: { value: 'witty' } })
    const range = root.querySelectorAll('.dpf-range')[0]
    assert.ok(range, '展开「对话风格」后应出现滑块字段')
    range.dispatch('input', { target: { value: '80' } })
    const text = root.querySelectorAll('.dpf-input')[0]
    assert.ok(text, '编译页没有文本字段')
    text.dispatch('input', { target: { value: '大肥鱼' } })
    await wait(400)

    const seen = {}
    for (const name of ['library', 'templates', 'editor', 'generate', 'settings']) {
      const button = tabButton(name)
      assert.ok(button, `找不到页签按钮：${name}`)
      button.dispatch('click')
      seen[name] = root.querySelector('.dpf-body').textContent.length
    }
    for (const name of Object.keys(seen)) {
      assert.ok(seen[name] > 0, `切到「${name}」页签后内容是空的`)
    }
    tabButton('library').dispatch('click')
    assert.ok(
      root.querySelectorAll('.dpf-card').length > 0 || root.querySelector('.dpf-body').textContent.includes('人格库'),
      '返回人格库页签后没有渲染出人格卡片',
    )
    tabButton('settings').dispatch('click')
    assert.ok(root.querySelector('.dpf-body').textContent.includes('倾向轨迹'), '设置页签内容不完整')
    tabButton('templates').dispatch('click')
    assert.ok(root.querySelector('.dpf-body').textContent.includes('内置模板'), '模板页签内容不完整')
    passed += 1
    console.log('  ✓ 在编译页改完参数后，五个页签都还能正常切换')
  } catch (error) {
    failed += 1
    console.log('  ✗ 在编译页改完参数后，五个页签都还能正常切换')
    console.log(`      原因：${error && error.message}`)
  }
})()

await wait(120)
void observerCallbackRuns

console.log(`\n面板自检：通过 ${passed} 项，失败 ${failed} 项。`)
if (failed > 0 || passed === 0) process.exitCode = 1
