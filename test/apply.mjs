/**
 * 宿主接线自检：用假的 Cordis ctx 调用 apply()，验证：
 *   · 模块能被解析并加载（含所有 .mjs 子模块）
 *   · 系统提示词 section 注册且能读到人格文本
 *   · /dsh-persona-studio/* 路由注册齐全
 *   · index.html 注入行生效
 *   · /persona 命令与 persona 工具注册成功
 *
 * 用法：node test/apply.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makePersonaId, isAsciiId } from '../lib/spec.mjs'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-apply-'))
process.env.DSH_HOME = tmpHome

const moduleUrl = new URL('../lib/index.js', import.meta.url).href
const plugin = await import(moduleUrl)
const sections = []
const routes = []
const commands = []
const tools = []
const listeners = []
const effects = []

const fakeStore = null
void fakeStore

const ctx = {
  logger: { info: (m) => console.log(`  [info] ${m}`), warn: (m) => console.log(`  [warn] ${m}`) },
  effect(fn, label) {
    effects.push(label)
    const dispose = typeof fn === 'function' ? fn() : undefined
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, handler) {
    listeners.push(event)
    void handler
    return () => {}
  },
  get(name) {
    if (name === 'llm') {
      return {
        async *stream() {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    if (name === 'sessions') return { list: () => [], get: () => undefined }
    // 宿主的默认模型服务：用于"会话路由还没捕获到"时的兜底
    if (name === 'agentDefaultModel') {
      return {
        currentSelection: () => ({ provider: 'fake-provider', model: 'fake-default-model' }),
      }
    }
    return undefined
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
    getSectionOrder(name) {
      return name === 'DEPLOYMENT_PERSONA_SUFFIX' ? 10200 : 0
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex(transform) {
      routes.push({ tapIndex: true })
      const html = '<html><body><div id="root"></div></body></html>'
      const out = transform(html)
      assert.notEqual(out, html, 'tapIndex 应该改写 html')
      assert.ok(out.includes('/dsh-persona-studio/bootstrap.js'), 'html 里应注入 bootstrap 脚本')
      return () => {}
    },
  },
  commands: {
    register(definition) {
      commands.push(definition)
      return () => {}
    },
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  sessions: { list: () => [], get: () => undefined },
}

plugin.apply(ctx)

let passed = 0
let failed = 0
/**
 * 跑一条检查。
 * 注意必须能接住 **async 检查函数抛出的错误**：以前这里只写 try/catch 同步调用，
 * 异步检查的断言失败会变成 unhandled rejection —— 进程直接死掉、退出码 1，
 * 而汇总行却显示"全部通过"，非常容易误判。
 */
const pending = []
function check(label, fn) {
  const done = (error) => {
    if (error) {
      failed += 1
      console.log(`  ✗ ${label}`)
      console.log(`      原因：${error && error.message}`)
    } else {
      passed += 1
      console.log(`  ✓ ${label}`)
    }
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => done(null), done))
      return
    }
    done(null)
  } catch (error) {
    done(error)
  }
}

console.log(`DSH_HOME（本进程设置为临时目录）：${process.env.DSH_HOME}`)

check('插件导出 name / inject', () => {
  assert.equal(plugin.name, 'dsh-persona-studio')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('systemPrompt'))
  assert.ok(plugin.inject.includes('webServer'))
})

check('注册了系统提示词 section，且落在 persona suffix 之后', () => {
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'persona-forge:active-persona')
  assert.equal(sections[0].interpolate, false)
  assert.ok(sections[0].order > 10200)
  const text = sections[0].text()
  assert.ok(typeof text === 'string' && text.includes('<persona>'), '应产出人格块')
  assert.ok(text.includes('人格档案'))
})

check('注册了全部 HTTP 路由（含静态资源与 API）', () => {
  const paths = routes.filter((r) => r.path).map((r) => r.path)
  for (const expected of [
    '/dsh-persona-studio/bootstrap.js',
    '/dsh-persona-studio/panel.js',
    '/dsh-persona-studio/panel.css',
    '/dsh-persona-studio/state',
    '/dsh-persona-studio/list',
    '/dsh-persona-studio/active',
    '/dsh-persona-studio/save',
    '/dsh-persona-studio/preview',
    '/dsh-persona-studio/generate',
    '/dsh-persona-studio/import',
    '/dsh-persona-studio/export',
  ]) {
    assert.ok(paths.includes(expected), `缺少路由 ${expected}`)
  }
})

check('路由表与 api.mjs 里声明的端点面完全一致（防漂移）', () => {
  // 直接从源码解析 ROUTES，避免"声明了却没注册"或"注册了却没声明"。
  // 前缀只用 /dsh-persona-studio/ 这一个来源，避免改名时漏掉断言（曾经漏过一次）。
  const source = fs.readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('const ROUTES = {'), source.indexOf('const MIME'))
  const declared = [...block.matchAll(/'(\/dsh-persona-studio\/[^']+)'/g)].map((m) => m[1])
  const registered = routes.filter((r) => r.path).map((r) => r.path)
  assert.ok(declared.length > 0, '没有从 api.mjs 解析到任何路由（前缀可能改了，检查本测试的正则）')
  for (const p of declared) assert.ok(registered.includes(p), `声明了但未注册：${p}`)
  for (const p of registered) assert.ok(declared.includes(p), `注册了但未声明：${p}`)
  // 顺带钉住所有前缀都跟随包名，避免有人只改一半
  for (const p of registered) {
    assert.ok(p.startsWith('/dsh-persona-studio/'), `路由前缀与包名不一致：${p}`)
  }
})

check('人格编号是纯 ASCII（中文名也不会污染命令行传参）', () => {
  for (const name of ['严谨工程师', '极简执行者', 'Pair Programmer', '中文 English 混合 42', '']) {
    const id = makePersonaId(name)
    assert.ok(isAsciiId(id), `编号含非 ASCII 字符：${id}`)
    assert.match(id, /^persona-[a-z0-9-]*-[a-z0-9]+$/, `编号格式异常：${id}`)
  }
})

check('注册了 tapIndex 注入 + webserver/index-inject 监听', () => {
  assert.ok(routes.some((r) => r.tapIndex), 'tapIndex 未被调用')
  assert.ok(listeners.includes('webserver/index-inject'), '缺少桌面壳注入监听')
  assert.ok(listeners.includes('agent/request'), '缺少模型路由捕获监听')
})

check('/persona 命令可用且能返回状态', () => {
  assert.equal(commands.length, 1)
  const command = commands[0]
  assert.equal(command.name, 'persona')
  const result = command.handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('人格注入'))
  const list = command.handler({ rawInput: 'list' })
  assert.ok(list.text.length > 0)
  const off = command.handler({ rawInput: 'off' })
  assert.ok(off.text.includes('关闭'))
  const on = command.handler({ rawInput: 'on' })
  assert.ok(on.text.includes('开启'))
  const use = command.handler({ rawInput: `use ${list.text.split('\n')[0].replace(/^[●\s]*/, '').split(' — ')[0]}` })
  assert.equal(use.kind, 'success', use.text)
})

check('不再注册模型侧工具（避免依赖 dsh-tools 的 defineTool 契约）', () => {
  assert.equal(tools.length, 0, '不应注册 tools')
  assert.ok(!plugin.inject.includes('tools'), 'inject 不应包含 tools')
})

check('路由处理器真的能返回 JSON（走一遍真实 handler）', async () => {
  const stateRoute = routes.find((r) => r.path === '/dsh-persona-studio/state')
  assert.ok(stateRoute, '找不到 state 路由')
  let status = 0
  let body = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text ?? ''
    },
  }
  const req = {
    method: 'GET',
    url: '/dsh-persona-studio/state',
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {},
  }
  stateRoute.handler(req, res)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(status, 200, `期望 200，实际 ${status}`)
  const json = JSON.parse(body)
  assert.equal(json.ok, true)
  assert.ok(json.state.personas.length >= 1)
  assert.equal(json.state.activeId, json.state.personas[0].id)
})

check('接线层面也带上了「送达」自检与数据健康报告', async () => {
  // 这两块是后加的；只在 API 层和界面层测过，宿主接线层也必须验一遍，
  // 否则"路由返回的内容缺字段"这类问题会漏网。
  const stateRoute = routes.find((r) => r.path === '/dsh-persona-studio/state')
  let body = ''
  const res = { writeHead() {}, end(text) { body = text ?? '' } }
  stateRoute.handler(
    {
      method: 'GET',
      url: '/dsh-persona-studio/state',
      headers: { host: '127.0.0.1:19387' },
      async *[Symbol.asyncIterator]() {},
    },
    res,
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const state = JSON.parse(body).state
  assert.ok(state.delivery, 'state 缺 delivery 字段')
  assert.equal(state.delivery.willInject, true, '开启且有激活人格时应会注入')
  assert.ok(state.delivery.injectedChars > 0, '注入字符数应大于 0')
  assert.ok(state.health, 'state 缺 health 字段')
  assert.equal(state.health.ok, true, '正常状态 health.ok 应为 true')
  assert.ok(state.blankSpec, 'state 缺 blankSpec（新建人格要用）')
  assert.ok(state.defaults, 'state 缺 defaults（未保存提示要用）')
})

check('损坏时 /save 会如实报错而不是静默失败', async () => {
  // 用户点保存时，若人格库坏了，必须收到一句能看懂的错误，而不是"像是保存了其实没有"
  const saveRoute = routes.find((r) => r.path === '/dsh-persona-studio/save')
  assert.ok(saveRoute, '找不到 save 路由')
  const libraryFile = path.join(process.env.DSH_HOME, 'persona', 'library.json')
  const good = fs.readFileSync(libraryFile, 'utf8')
  fs.writeFileSync(libraryFile, good.slice(0, Math.floor(good.length / 2)), 'utf8')
  if (process.env.DPF_DEBUG === '1') {
    console.log('  [debug] 已破坏文件 =', libraryFile)
    console.log('  [debug] 破坏后大小 =', fs.statSync(libraryFile).size, '原大小 =', good.length)
    console.log('  [debug] 破坏后开头 =', JSON.stringify(fs.readFileSync(libraryFile, 'utf8').slice(0, 40)))
  }
  try {
    let status = 0
    let body = ''
    const payload = JSON.stringify({ action: 'config', config: { enabled: true } })
    const res = { writeHead(code) { status = code }, end(text) { body = text ?? '' } }
    saveRoute.handler(
      {
        method: 'POST',
        url: '/dsh-persona-studio/save',
        headers: { host: '127.0.0.1:19387' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(payload, 'utf8')
        },
      },
      res,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (process.env.DPF_DEBUG === '1') {
      console.log('  [debug] 损坏后 /save 状态 =', status)
      console.log('  [debug] 文件大小（请求后） =', fs.statSync(libraryFile).size, '（破坏后是', Math.floor(good.length / 2), '）')
      console.log('  [debug] 文件开头（请求后） =', JSON.stringify(fs.readFileSync(libraryFile, 'utf8').slice(0, 60)))
    }
    assert.equal(status, 400, `损坏状态下应返回 400，实际 ${status}`)
    const json = JSON.parse(body)
    assert.equal(json.ok, false)
    assert.match(json.error.message, /损坏/, `错误信息应说明原因，实际：${json.error.message}`)
    assert.match(json.error.message, /备份|拒绝/, '错误信息应告诉用户怎么办')
  } finally {
    fs.writeFileSync(libraryFile, good, 'utf8')
  }
})

check('人格库写在临时 DSH_HOME 下（没有污染真实 profile）', () => {
  const expected = path.join(process.env.DSH_HOME, 'persona', 'library.json')
  assert.ok(fs.existsSync(expected), `期望 ${expected} 存在`)
})

check('会话路由拿不到时，退回宿主默认模型（不再报"尚未捕获到模型路由"）', async () => {
  // 背景：原来深读只认"监听到的会话路由"，而它要等本次进程发过一次模型请求才有值，
  // 所以刚重启就点深读必然失败。现在必须能退回 agentDefaultModel。
  const stateRoute = routes.find((r) => r.path === '/dsh-persona-studio/state')
  let body = ''
  stateRoute.handler(
    { method: 'GET', url: '/dsh-persona-studio/state', headers: { host: '127.0.0.1:19387' }, async *[Symbol.asyncIterator]() {} },
    { writeHead() {}, end(t) { body = t ?? '' } },
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const route = JSON.parse(body).state.modelRoute
  assert.ok(route, '拿不到模型路由（兜底没生效）')
  assert.equal(route.provider, 'fake-provider')
  assert.equal(route.model, 'fake-default-model')
  assert.equal(route.source, 'default-model', '应标明这条路由来自默认模型兜底')
})

check('前端用到的接口路径，宿主每一条都注册了', () => {
  // 客户端与宿主是靠字符串路径对接的，改了一边漏另一边不会报错，
  // 只会表现为"面板某个功能点了没反应"。这里把两边对齐。
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const panel = fs.readFileSync(path.join(root, 'assets', 'panel.js'), 'utf8')
  const block = panel.slice(panel.indexOf('var API = {'), panel.indexOf('}', panel.indexOf('var API = {')))
  const clientPaths = [...block.matchAll(/'(\/dsh-persona-studio\/[^']+)'/g)].map((m) => m[1])
  assert.ok(clientPaths.length >= 5, `没解析到前端接口常量（实际 ${clientPaths.length} 条）`)
  const registered = routes.filter((r) => r.path).map((r) => r.path)
  for (const p of clientPaths) {
    assert.ok(registered.includes(p), `前端在用 ${p}，但宿主没有注册这条路由`)
  }
  // bootstrap.js 的路径是"前缀 + 文件名"拼出来的，所以要先把前缀解析出来。
  // （这条断言曾经误报，就是因为直接去找字面量 /dsh-persona-studio/panel.css。）
  const bootstrap = fs.readFileSync(path.join(root, 'assets', 'bootstrap.js'), 'utf8')
  const baseMatch = bootstrap.match(/var BASE = '([^']+)'/)
  assert.ok(baseMatch, 'bootstrap.js 里没找到路径前缀 BASE')
  const base = baseMatch[1]
  for (const file of ['panel.css', 'panel.js']) {
    assert.ok(bootstrap.includes(`'/${file}'`), `bootstrap.js 没有引用 ${file}`)
    const full = `${base}/${file}`
    assert.ok(registered.includes(full), `bootstrap.js 会请求 ${full}，但宿主没注册这条路由`)
  }
})

// 等所有异步检查做完再汇总，否则会出现"汇总说全过、实际有失败"
await Promise.all(pending)

console.log(`\n宿主接线自检：通过 ${passed} 项，失败 ${failed} 项。`)
// 失败必须以非零退出码体现，否则 CI / 提 PR 前的自检会"绿着通过"（这里曾经踩过）
if (failed > 0 || passed === 0) process.exitCode = 1
fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('已清理临时目录。')
