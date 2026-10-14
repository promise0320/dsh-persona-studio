/**
 * 离线自检：不起 DSH，直接跑纯逻辑与 HTTP 处理器。
 * 用法：node test/smoke.mjs
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'

import { createStore } from '../lib/store.mjs'
import { createApi, ROUTES } from '../lib/api.mjs'
import { compilePersona, renderInjection, describeSpec } from '../lib/compile.mjs'
import { normalizeSpec, defaultSpec, BUILTIN_TEMPLATES, SPEC_SECTIONS } from '../lib/spec.mjs'
import { collectHistory, heuristicAnalyze, llmAnalyze } from '../lib/analyze.mjs'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-test-'))
const store = createStore(tmpHome)
const assetsDir = path.resolve(new URL('../assets', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

let passed = 0
let failed = 0
function check(label, fn) {
  // 允许传入异步检查；异步的失败也必须被计到 failed 里，
  // 否则断言失败会静默溜走（曾经出现"汇总说全过、其实挂了"和退出码为 0 的情况）。
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
const pending = []

console.log(`临时 DSH_HOME：${tmpHome}`)

console.log('\n[0] 文件卫生（这几条以前让插件直接启动失败）')
check('BOM 规则：.ps1 必须有、其他文件必须没有', () => {
  // 两边的坑都踩过：
  //  · package.json / cordis.patch.yml 带上 BOM → JSON.parse 直接抛错，宿主加载不了插件；
  //  · .ps1 不带 BOM → PowerShell 5.1 按 ANSI 读，中文注释变乱码并把脚本语法弄坏。
  // 所以规则按文件类型区分，而不是"一律不许有 BOM"。
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const skip = /node_modules|[\\/]\.git|[\\/]\.probe/
  const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const wrongBom = []
  const missingBom = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (skip.test(full)) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(js|mjs|json|yml|md|css|ps1|sh|txt)$/.test(entry.name)) continue
      const bom = hasBom(fs.readFileSync(full))
      const relative = path.relative(root, full)
      if (entry.name.endsWith('.ps1')) {
        if (!bom) missingBom.push(relative)
      } else if (bom) {
        wrongBom.push(relative)
      }
    }
  }
  walk(root)
  assert.deepEqual(wrongBom, [], `这些文件不该有 BOM（会导致解析失败）：${wrongBom.join(', ')}`)
  assert.deepEqual(missingBom, [], `这些 .ps1 缺 BOM（PowerShell 5.1 会读成乱码）：${missingBom.join(', ')}`)
})

check('安装脚本不再用会写 BOM 的 PowerShell 写法', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    const text = fs.readFileSync(path.join(root, 'scripts', name), 'utf8')
    // 这两句在 PowerShell 5.1 下都会写入 BOM，绝不能用来写 profile 的配置文件
    const lines = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
    const offenders = lines.filter((line) => /(Set-Content|Add-Content)\s+[^\n]*-Encoding\s+UTF8/.test(line))
    assert.deepEqual(offenders, [], `${name} 里仍有用 BOM 写文件的语句：${offenders.join(' | ')}`)
    assert.ok(text.includes('Write-Utf8NoBom'), `${name} 应使用 Write-Utf8NoBom 写文件`)
  }
})

check('package.json / cordis.patch.yml 能被严格解析，且名字一致', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-persona-studio')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  // patch 行必须与包名一致，否则 loader 只 warn 然后跳过这一行（插件"没生效但不报错"）
  const patchText = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patchText, new RegExp(`name: ${pkg.name}\\b`), 'cordis.patch.yml 里的包名与 package.json 不一致')
  assert.equal(fs.existsSync(path.join(root, 'LICENSE')), true, '缺 LICENSE')
  assert.equal((pkg.files || []).includes('LICENSE'), true, 'LICENSE 没被列入 files')
})

console.log('\n[1] 存储与预置')
check('首次读取会预置一个人格并设为激活', () => {
  const library = store.ensureSeeded()
  assert.equal(library.personas.length, 1)
  assert.equal(library.activeId, library.personas[0].id)
  assert.ok(fs.existsSync(store.files.library))
})
check('编译快照可写', () => {
  const library = store.readLibraryRaw()
  const active = library.personas[0]
  store.writeCompiled(active, compilePersona(active.spec))
  const text = fs.readFileSync(store.files.compiled, 'utf8')
  assert.match(text, /人格档案/)
})
check('老数据迁移：只有备注、没有背景设定的人格会被自动补上', () => {
  // 老版本里"备注"只存不发，AI 完全看不到。读取时要把备注补进背景设定。
  const legacy = store.normalizeStoredPersona({
    id: 'persona-legacy',
    name: '老数据',
    note: '由 logo 衍生出的蓝色鲸鱼娘女仆形象',
    spec: defaultSpec(),
  })
  assert.equal(legacy.note, '由 logo 衍生出的蓝色鲸鱼娘女仆形象', '备注本身不能被改动')
  assert.equal(
    legacy.spec.identity.background,
    '由 logo 衍生出的蓝色鲸鱼娘女仆形象',
    '备注没有迁移进背景设定',
  )
  // 已经写过背景设定的，不能被备注覆盖（幂等、不倒退）
  const configured = defaultSpec()
  configured.identity.background = '我精心写好的背景'
  const kept = store.normalizeStoredPersona({ id: 'p2', name: 'x', note: '旧备注', spec: configured })
  assert.equal(kept.spec.identity.background, '我精心写好的背景', '迁移覆盖了用户已写好的背景设定')
  // 两边都空时也不该凭空造出内容
  const empty = store.normalizeStoredPersona({ id: 'p3', name: 'x', note: '', spec: defaultSpec() })
  assert.equal(empty.spec.identity.background, '')
})
check('自定义模板文件：部分字段会被补全，坏文件被跳过，带说明文字也能解析', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-tpl-'))
  const tplStore = createStore(home)
  try {
    assert.equal(tplStore.listTemplates().files.length, 0, '空目录不该有文件模板')
    fs.writeFileSync(
      path.join(tplStore.files.templates, '夜猫子.json'),
      JSON.stringify({ name: '夜猫子', tags: ['夜间'], spec: { style: { tone: 'casual', humor: 60 } } }),
      'utf8',
    )
    fs.writeFileSync(
      path.join(tplStore.files.templates, '带说明.md'),
      `# 说明\n下面是配置：\n${JSON.stringify({ name: '带说明的', spec: { style: { verbosity: 'terse' } } }, null, 2)}`,
      'utf8',
    )
    fs.writeFileSync(path.join(tplStore.files.templates, '坏文件.json'), '{ 这不是合法 JSON', 'utf8')

    const files = tplStore.listTemplates().files
    assert.equal(files.length, 2, `坏文件应被跳过，实际读到 ${files.length} 个`)

    const cat = files.find((t) => t.name === '夜猫子')
    assert.ok(cat, '没读到 JSON 模板')
    assert.equal(cat.spec.style.tone, 'casual')
    assert.equal(cat.spec.style.humor, 60)
    // 只写了两个字段，其余必须补默认值，且六个分类齐全
    assert.equal(cat.spec.style.verbosity, 'balanced', '未指定的字段没有补默认值')
    assert.equal(Object.keys(cat.spec).length, 6, '分类没有补全')

    const md = files.find((t) => t.name === '带说明的')
    assert.ok(md, '从带说明文字的文件里没能解析出模板')
    assert.equal(md.spec.style.verbosity, 'terse')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
check('损坏保护：人格库被写坏时拒绝覆盖、保留原文件、并提供恢复出口', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-corrupt-'))
  const s = createStore(home)
  try {
    // 先正常建立一份人格库
    const seeded = s.ensureSeeded()
    assert.ok(seeded.personas.length >= 1)
    assert.equal(s.integrityReport().ok, true, '正常状态不应报损坏')

    // 模拟"被写坏"：截断成半个 JSON（真实场景：断电 / 磁盘满 / 手工编辑出错）
    const good = fs.readFileSync(s.files.library, 'utf8')
    fs.writeFileSync(s.files.library, good.slice(0, Math.floor(good.length / 2)), 'utf8')

    // 1) 读出来要能发现自己坏了
    const broken = s.readLibraryRaw()
    assert.equal(broken.personas.length, 0, '坏文件读出来应为空库')
    const report = s.integrityReport()
    assert.equal(report.ok, false, '应当报告数据损坏')
    assert.ok(report.issues.some((i) => i.file === s.files.library), '损坏报告里应包含人格库文件')
    assert.ok(report.summary.length > 0, '应给人话说明')

    // 2) 此时的写入必须被拒绝 —— 否则会用空库把用户数据抹掉
    assert.throws(() => s.writeLibrary({ activeId: null, personas: [] }), /损坏/, '损坏状态下写入没有被拒绝')

    // 3) ensureSeeded 不能在损坏状态下"顺手种默认人格"并覆盖
    const afterSeed = s.ensureSeeded()
    assert.equal(afterSeed.personas.length, 0, '损坏状态不应种入默认人格')

    // 4) 恢复出口：备份坏文件 + 写入默认内容
    const reset = s.resetIntegrity('library')
    assert.equal(reset.preserved.length, 1, '应保留一份坏文件备份')
    assert.ok(reset.preserved[0].includes('.corrupt-'), `备份文件名应含 .corrupt-，实际 ${reset.preserved[0]}`)
    assert.ok(fs.existsSync(reset.preserved[0]), '坏文件备份应当真实存在')
    assert.equal(
      fs.readFileSync(reset.preserved[0], 'utf8').slice(0, 20),
      good.slice(0, 20),
      '备份内容应与损坏前的内容一致（不能丢原文件）',
    )
    // 恢复后写入恢复正常
    assert.equal(s.integrityReport().ok, true, '恢复后不应再报损坏')
    const revived = s.ensureSeeded()
    assert.ok(revived.personas.length >= 1, '恢复后应能重新预置人格')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
check('损坏保护：配置被写坏时同样拒绝覆盖并可恢复', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-corrupt2-'))
  const s = createStore(home)
  try {
    s.ensureConfigFile()
    fs.writeFileSync(s.files.config, '{ 半个 JSON', 'utf8')
    const cfg = s.readConfig()
    assert.equal(cfg.enabled, true, '配置坏了应回落默认值而不是崩')
    assert.equal(s.integrityReport().ok, false, '应报告配置损坏')
    assert.throws(() => s.writeConfig({ enabled: false }), /损坏/, '损坏状态下写配置没有被拒绝')
    const reset = s.resetIntegrity('config')
    assert.ok(reset.preserved[0].includes('.corrupt-'))
    assert.equal(s.integrityReport().ok, true)
    // 恢复后能正常改配置
    assert.equal(s.writeConfig({ enabled: false }).enabled, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

console.log('\n[2] 规格归一化')
check('缺失字段回落默认值', () => {
  const spec = normalizeSpec({ style: { tone: 'warm' } })
  assert.equal(spec.style.tone, 'warm')
  assert.equal(spec.style.verbosity, defaultSpec().style.verbosity)
  assert.equal(spec.tuning.focus, 'balanced')
})
check('非法枚举被丢弃', () => {
  const spec = normalizeSpec({ style: { tone: '不存在的语气' } })
  assert.equal(spec.style.tone, defaultSpec().style.tone)
})
check('range 会被夹到区间内', () => {
  const spec = normalizeSpec({ style: { warmth: 999 } })
  assert.equal(spec.style.warmth, 100)
})
check('tags 支持字符串与数组', () => {
  assert.deepEqual(normalizeSpec({ style: { avoidPhrases: 'a\n\nb ' } }).style.avoidPhrases, ['a', 'b'])
  assert.deepEqual(normalizeSpec({ style: { avoidPhrases: ['x', 'y'] } }).style.avoidPhrases, ['x', 'y'])
})

console.log('\n[3] 人格编译')
check('编译产物包含关键维度与边界', () => {
  const template = BUILTIN_TEMPLATES[0]
  const text = compilePersona(template.spec)
  assert.match(text, /人格档案/)
  assert.match(text, /风格刻度/)
  assert.match(text, /创作习惯/)
  assert.match(text, /反馈方式/)
  assert.match(text, /边界/)
})
check('聚焦等级 off 不产出内容', () => {
  assert.equal(compilePersona(BUILTIN_TEMPLATES[0].spec, { focus: 'off' }), '')
})
check('背景设定会进入编译结果（备注曾经只存不发，AI 完全看不到）', () => {
  const spec = defaultSpec()
  spec.identity.name = '测试鱼'
  spec.identity.background = '住在硬盘里的蓝色鲸鱼娘女仆，被称为吃白饭的鱼。'
  const text = compilePersona(spec)
  assert.match(text, /### 背景设定/)
  assert.ok(text.includes('蓝色鲸鱼娘女仆'), '背景设定的正文没有进入编译结果')
  assert.ok(renderInjection(spec).includes('吃白饭的鱼'), '注入文本里没有背景设定')
  // 没写背景设定时不应出现空标题
  assert.equal(
    compilePersona(defaultSpec()).includes('### 背景设定'),
    false,
    '空背景不应产生标题',
  )
})
check('strict 与 balanced 的优先级措辞不同', () => {
  const strict = renderInjection(BUILTIN_TEMPLATES[0].spec, { focus: 'strict' })
  const balanced = renderInjection(BUILTIN_TEMPLATES[0].spec, { focus: 'balanced' })
  assert.match(strict, /强制约束/)
  assert.match(balanced, /以用户当次指令为准/)
  assert.ok(strict.startsWith('<persona>') && strict.endsWith('</persona>'))
})
check('规格元数据可序列化且含全部维度', () => {
  const meta = describeSpec()
  assert.ok(meta.sections.length >= 6)
  assert.ok(meta.sections.every((s) => s.fields.length > 0))
  assert.doesNotThrow(() => JSON.stringify(meta))
})
check('每个字段都带 section 标记（否则前端会把修改写进 spec.undefined）', () => {
  // 回归锁：曾经漏掉 section，导致前端所有编辑都写进 spec.undefined，
  // 表现为"改参数预览不变、离开编译页就重置、保存后人格库也不变"三个 bug 同时出现。
  const meta = describeSpec()
  for (const section of meta.sections) {
    for (const field of section.fields) {
      assert.equal(field.section, section.key, `字段 ${field.key} 的 section 应为 ${section.key}，实际 ${field.section}`)
    }
  }
  // 序列化后也必须还在（undefined 会被 JSON.stringify 丢掉）
  const roundTripped = JSON.parse(JSON.stringify(meta))
  for (const section of roundTripped.sections) {
    for (const field of section.fields) {
      assert.ok(field.section, `序列化后字段 ${field.key} 丢了 section`)
    }
  }
})

console.log('\n[4] 历史归纳（启发式）')
const fakeHistory = {
  sessions: [
    {
      sessionId: 's1',
      title: '重构订单模块',
      userTexts: [
        '帮我修一下这个报错\n```\nTypeError: x is undefined\n```',
        '不要改公共 API，直接修',
        '跑一下测试看看',
        '这个日志里还有别的异常，一起看',
        '先别写文档，实现就行',
      ],
      assistantSamples: [],
    },
    {
      sessionId: 's2',
      title: '写周报',
      userTexts: ['把这段改短一点', '语气再正式些', '谢谢'],
      assistantSamples: [],
    },
  ],
  stats: { roles: { user: 8, assistant: 0 }, liveSessions: 2, usedSessions: 2 },
}
let proposal
check('归纳产出完整 spec 与依据', () => {
  proposal = heuristicAnalyze(fakeHistory)
  assert.ok(proposal.spec.identity.name)
  assert.ok(proposal.rationale.length > 0)
  assert.ok(proposal.evidence.messages === 8 || proposal.evidence.messages === 8)
  assert.equal(typeof proposal.confidence, 'number')
  assert.ok(proposal.templateId.startsWith('builtin:'))
})
check('祈使句占比高 → 更直接、更安静', () => {
  assert.ok(proposal.spec.style.directness >= 70)
})
check('空历史也能给出中性草案', () => {
  const empty = heuristicAnalyze({ sessions: [], stats: { roles: {}, liveSessions: 0, usedSessions: 0 } })
  assert.equal(empty.confidence, 0)
  assert.ok(empty.spec.identity.name)
})

console.log('\n[5] 持久化历史读取（重启后归纳依然可用）')
await (async () => {
  // 模拟 sessionQuery 服务：活会话为空，但磁盘上有多条历史
  const fakeQuery = {
    async listSessions() {
      return [
        { sessionId: 's-old-1', cwd: 'C:\\proj\\mine', createdAt: 3 },
        { sessionId: 's-old-2', cwd: 'C:\\proj\\mine', createdAt: 2 },
        { sessionId: 's-other', cwd: 'C:\\proj\\other', createdAt: 1 },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({ sessionId: id, title: `标题-${id}` }))
    },
    async readSession(id) {
      if (id === 's-other') {
        return { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '别的项目：请帮我写周报，要正式一点' }] } }] }
      }
      return {
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '帮我修一下这个报错' }] } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x'.repeat(120) }] } } },
          { type: 'user/message', data: { content: [{ type: 'text', text: '直接改，不要问我' }] } },
          { type: 'session/end-seed' },
        ],
      }
    },
  }

  const history = await collectHistory(
    { sessions: { list: () => [] }, sessionQuery: fakeQuery },
    { maxSessions: 5, cwd: 'C:\\proj\\mine' },
  )

  assert.equal(history.stats.liveSessions, 0, '活会话应为 0')
  assert.equal(history.sessions.length, 2, `应读到 2 条同目录历史，实际 ${history.sessions.length}`)
  assert.ok(
    history.sessions.every((s) => s.sessionId !== 's-other'),
    '不同工作目录的会话不应混进来',
  )
  assert.equal(history.sessions[0].title, '标题-s-old-1')
  const total = history.sessions.reduce((n, s) => n + s.userTexts.length, 0)
  assert.equal(total, 4, `应收集到 4 条用户消息，实际 ${total}`)

  const proposal = heuristicAnalyze(history)
  assert.ok(proposal.confidence > 0, '有历史时置信度应大于 0')
  assert.ok(proposal.evidence.messages === 4, `证据里的消息数应为 4，实际 ${proposal.evidence.messages}`)
  passed += 1
  console.log('  ✓ 活会话为空时回落读持久化历史，并按工作目录过滤')
})()

console.log('\n[5b] 模型深读（用假 llm 服务）')
const fakeLlm = {
  async *stream() {
    yield { type: 'text-delta', text: '```json\n' }
    yield {
      type: 'text-delta',
      text: JSON.stringify({
        name: '务实搭子',
        title: '务实派',
        oneLiner: '先跑通再说',
        rationale: ['反复要求先修报错'],
        needs: ['不要写多余的文档'],
        spec: {
          style: { tone: 'casual', verbosity: 'terse', directness: 95 },
          habits: { planning: 'none', structure: 'code-first', verification: 'commands' },
          feedback: { critique: 'direct', questionPolicy: 'never' },
        },
      }),
    }
    yield { type: 'text-delta', text: '\n```' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
await (async () => {
  const result = await llmAnalyze({ llm: fakeLlm }, { provider: 'p', model: 'm' }, fakeHistory)
  assert.equal(result.spec.identity.name, '务实搭子')
  assert.equal(result.spec.style.directness, 95)
  assert.ok(result.spec.feedback.customRules.some((r) => r.includes('潜在需求')))
  passed += 1
  console.log('  ✓ 模型输出的 JSON 被正确解析并合并进 spec')
})()

// 深读失败的诊断：以前只认 kind === 'error'，其他结束原因被静默放过，
// 用户只看到"无法解析为 JSON："（冒号后面空的），根本不知道原因。这里三种场景都要说清。
await (async () => {
  const run = (chunks) =>
    llmAnalyze({ llm: { async *stream() { for (const c of chunks) yield c } } }, { provider: 'p', model: 'm' }, fakeHistory)

  // ① 非正常结束（例如输出被截断）：必须报出结束原因
  let e1 = null
  try {
    await run([
      { type: 'text-delta', text: '{"name":' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
  } catch (error) {
    e1 = error
  }
  assert.ok(e1, 'max-tokens 结束应报错，而不是静默当成正常结束')
  assert.match(e1.message, /max-tokens/, `错误信息应包含结束原因，实际：${e1.message}`)

  // ② 正常结束但零输出（DSH 专门有 EMPTY_RESPONSE 错误码）：信息要够排查
  let e2 = null
  try {
    await run([{ type: 'finish', reason: { kind: 'stop' } }])
  } catch (error) {
    e2 = error
  }
  assert.ok(e2, '零输出应报错')
  assert.equal(e2.code, 'EMPTY_RESPONSE', `应带上 EMPTY_RESPONSE 错误码，实际 ${e2.code}`)
  assert.match(e2.message, /没有返回任何内容/, `错误信息应说清现象，实际：${e2.message}`)
  assert.match(e2.message, /结束原因/, '错误信息应包含结束原因（便于区分额度/截断）')
  assert.match(e2.message, /0 个文本分片|收到 0/, '错误信息应包含收到多少分片')

  // ③ 有内容但不是 JSON：报错要带上实际内容
  let e3 = null
  try {
    await run([
      { type: 'text-delta', text: '我觉得你应该更简洁一点' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  } catch (error) {
    e3 = error
  }
  assert.ok(e3, '非 JSON 内容应报错')
  assert.match(e3.message, /不是合法 JSON/, `错误信息应说清是格式问题，实际：${e3.message}`)
  assert.match(e3.message, /我觉得你应该更简洁一点/, '错误信息应带上实际收到的内容片段')

  // ④ 错误结束：要把错误码带出来
  let e4 = null
  try {
    await run([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '额度不足' } } },
    ])
  } catch (error) {
    e4 = error
  }
  assert.ok(e4, '错误结束应抛错')
  assert.equal(e4.code, 'QUOTA', `应带上错误码，实际 ${e4.code}`)
  assert.match(e4.message, /额度不足/)

  passed += 1
  console.log('  ✓ 深读失败的四种情形都能说清原因（结束原因/错误码/收到多少内容）')
})()

console.log('\n[6] HTTP API')
// 让 collectHistory 走上面造好的假会话（真机上这里接的是 ctx.sessions）
const fakeSessions = [
  {
    id: 's1',
    header: { createdAt: 2, title: '重构订单模块' },
    deriveMessages: () =>
      fakeHistory.sessions[0].userTexts.map((text) => ({ role: 'user', content: [{ type: 'text', text }] })),
  },
  {
    id: 's2',
    header: { createdAt: 1, title: '写周报' },
    deriveMessages: () =>
      fakeHistory.sessions[1].userTexts.map((text) => ({ role: 'user', content: [{ type: 'text', text }] })),
  },
]

const api = createApi({
  store,
  assetsDir,
  getLastRoute: () => ({ provider: 'fake', model: 'fake-model' }),
  getLiveSessionSummaries: () => [{ id: 's1', title: 't', createdAt: 0 }],
  sessions: {
    list: () => fakeSessions,
    get: (id) => fakeSessions.filter((s) => s.id === id)[0],
  },
  llm: fakeLlm,
  logger: (message) => console.log(`    [host] ${message}`),
})

function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: '/',
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text ?? ''
    },
  }
}

async function call(method, pathname, body) {
  const res = makeRes()
  await api.handle(makeReq(method, body), res, new URL(pathname, 'http://127.0.0.1:19387'))
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, json, text: res.body }
}

await (async () => {
  const stateRes = await call('GET', ROUTES.state)
  assert.equal(stateRes.status, 200)
  assert.equal(stateRes.json.ok, true)
  assert.ok(stateRes.json.state.personas.length >= 1)
  assert.equal(stateRes.json.state.templates.builtin.length, BUILTIN_TEMPLATES.length)
  passed += 1
  console.log('  ✓ GET /state 返回人格库 + 模板 + 规格')

  // 「送达」自检：把"配置到底有没有进提示词"算清楚，回应"改了不生效"这类问题
  const delivery = stateRes.json.state.delivery
  assert.ok(delivery, '/state 应带 delivery 字段')
  assert.equal(delivery.enabled, true)
  assert.equal(delivery.hasActivePersona, true)
  assert.equal(delivery.willInject, true, '开启且有激活人格时 willInject 应为 true')
  assert.ok(delivery.injectedChars > 0, '注入字符数应大于 0')
  assert.equal(delivery.personaName, stateRes.json.state.active.name)
  assert.ok(stateRes.json.state.health && stateRes.json.state.health.ok === true, '正常状态 health.ok 应为 true')
  passed += 1
  console.log('  ✓ /state 带「送达」自检与数据健康报告')

  const preview = await call('POST', ROUTES.preview, { spec: BUILTIN_TEMPLATES[1].spec })
  assert.equal(preview.json.ok, true)
  assert.match(preview.json.injection, /<persona>/)
  passed += 1
  console.log('  ✓ POST /preview 返回编译结果')

  const created = await call('POST', ROUTES.save, {
    action: 'create',
    activate: true,
    persona: { name: '测试人格', spec: BUILTIN_TEMPLATES[2].spec, tags: ['test'] },
  })
  assert.equal(created.json.ok, true)
  const newId = created.json.persona.id
  assert.equal(created.json.state.activeId, newId)
  passed += 1
  console.log('  ✓ POST /save action=create 新建并激活')

  // 备注 ↔ 背景设定必须双向同步：
  //  · 新建时只给备注 → 背景设定要自动补上（否则 AI 收不到这段设定）
  //  · 只给背景设定 → 备注要自动补上（否则卡片上不显示）
  const noteOnly = await call('POST', ROUTES.save, {
    action: 'create',
    activate: false,
    persona: { name: '备注同步测试', spec: normalizeSpec({}), note: '这是一段只写在备注里的背景' },
  })
  assert.equal(
    noteOnly.json.persona.spec.identity.background,
    '这是一段只写在备注里的背景',
    '新建时备注没有同步进背景设定',
  )
  assert.ok(
    noteOnly.json.persona.compiled.includes('这是一段只写在备注里的背景'),
    '备注内容没有出现在编译结果里',
  )
  const bgOnly = await call('POST', ROUTES.save, {
    action: 'create',
    activate: false,
    persona: { name: '背景同步测试', spec: normalizeSpec({ identity: { background: '只写在背景里的设定' } }) },
  })
  assert.equal(bgOnly.json.persona.note, '只写在背景里的设定', '背景设定没有同步进备注')
  // 清理这两个测试人格
  for (const p of [noteOnly.json.persona, bgOnly.json.persona]) {
    await call('POST', ROUTES.save, { action: 'delete', id: p.id })
  }
  passed += 1
  console.log('  ✓ 备注 ↔ 背景设定双向同步（新建时也不会漏）')

  const updated = await call('POST', ROUTES.save, {
    action: 'save',
    activate: true,
    persona: { id: newId, name: '测试人格改名', spec: { ...BUILTIN_TEMPLATES[2].spec, style: { tone: 'blunt' } } },
  })
  assert.equal(updated.json.persona.name, '测试人格改名')
  assert.equal(updated.json.persona.spec.style.tone, 'blunt')
  passed += 1
  console.log('  ✓ POST /save 更新已有的人格')

  // 完整性回归：把每个分类各改一项保存，全部都要活下来（曾经出现"改了预览不变/保存丢字段"）
  const fullSpec = normalizeSpec(BUILTIN_TEMPLATES[2].spec)
  fullSpec.identity.title = '完整性测试头衔'
  fullSpec.style.humor = 90
  fullSpec.habits.exploration = 80
  fullSpec.feedback.praise = 85
  fullSpec.boundaries.custom = '完整性测试边界'
  fullSpec.tuning.temperature = 1.4
  const whole = await call('POST', ROUTES.save, {
    action: 'save',
    activate: true,
    persona: { id: newId, name: '完整性测试', spec: fullSpec },
  })
  const kept = whole.json.persona.spec
  assert.equal(kept.identity.title, '完整性测试头衔', 'identity 字段丢失')
  assert.equal(kept.style.humor, 90, 'style 字段丢失')
  assert.equal(kept.habits.exploration, 80, 'habits 字段丢失')
  assert.equal(kept.feedback.praise, 85, 'feedback 字段丢失')
  assert.equal(kept.boundaries.custom, '完整性测试边界', 'boundaries 字段丢失')
  assert.equal(kept.tuning.temperature, 1.4, 'tuning 字段丢失')
  // 每个分类的字段数都要齐全
  for (const section of SPEC_SECTIONS) {
    assert.equal(
      Object.keys(kept[section.key]).length,
      section.fields.length,
      `分类 ${section.key} 保存后字段数不对`,
    )
  }
  // 编译结果必须体现这些改动
  assert.match(whole.json.persona.compiled, /完整性测试头衔/)
  assert.match(whole.json.persona.compiled, /完整性测试边界/)
  // 存盘后重新读一遍，确认不是只在内存里对
  const reread = await call('GET', ROUTES.state)
  const fromDisk = reread.json.state.personas.filter((p) => p.id === newId)[0]
  assert.equal(fromDisk.spec.style.humor, 90, '重新读取后 style.humor 丢失')
  assert.equal(fromDisk.spec.tuning.temperature, 1.4, '重新读取后 tuning.temperature 丢失')
  passed += 1
  console.log('  ✓ 六个分类的改动保存后全部保真（含重新读盘校验）')

  const gen = await call('POST', ROUTES.generate, { mode: 'llm' })
  assert.equal(gen.json.ok, true)
  assert.equal(gen.json.proposal.spec.identity.name, '务实搭子')
  passed += 1
  console.log('  ✓ POST /generate mode=llm 走通深读')

  const imported = await call('POST', ROUTES.importTpl, { kind: 'template', templateId: 'builtin:writer' })
  assert.equal(imported.json.ok, true)
  assert.equal(imported.json.persona.name, '中文文字匠')
  passed += 1
  console.log('  ✓ POST /import 由模板实例化人格')

  const dup = await call('POST', ROUTES.save, { action: 'duplicate', id: newId })
  assert.equal(dup.json.ok, true)
  assert.match(dup.json.persona.name, /副本/)
  passed += 1
  console.log('  ✓ POST /save action=duplicate 复制人格')

  const listRes = await call('GET', ROUTES.list)
  assert.equal(listRes.json.ok, true)
  assert.ok(listRes.json.personas.length >= 4)
  passed += 1
  console.log('  ✓ GET /list 返回精简人格列表')

  const activeRes = await call('GET', ROUTES.active)
  assert.equal(activeRes.json.ok, true)
  assert.ok(activeRes.json.injection.includes('<persona>'))
  passed += 1
  console.log('  ✓ GET /active 返回当前人格与注入文本')

  const bad = await call('POST', ROUTES.preview, undefined)
  assert.equal(bad.json.ok, true)
  passed += 1
  console.log('  ✓ POST /preview 空体不崩（回落默认 spec）')

  const del = await call('POST', ROUTES.save, { action: 'delete', id: newId })
  assert.equal(del.json.ok, true)
  passed += 1
  console.log('  ✓ POST /save action=delete 删除人格')

  const cfg = await call('POST', ROUTES.save, { action: 'config', config: { enabled: false, maxSessions: 99 } })
  assert.equal(cfg.json.config.enabled, false)
  assert.equal(cfg.json.config.maxSessions, 30)
  passed += 1
  console.log('  ✓ POST /save action=config 写配置并夹取范围')

  const placeOk = await call('POST', ROUTES.save, { action: 'config', config: { placement: 'toolbar-left' } })
  assert.equal(placeOk.json.config.placement, 'toolbar-left')
  const placeBad = await call('POST', ROUTES.save, { action: 'config', config: { placement: '不存在的锚点' } })
  assert.equal(placeBad.json.config.placement, 'toolbar-right', '非法挂载位置应回落默认值')
  passed += 1
  console.log('  ✓ 挂载位置配置被校验（非法值回落 toolbar-right）')

  // 损坏逃生口：把人格库写坏，确认 /state 报告损坏、写入被拒、repair 能救回来
  fs.writeFileSync(store.files.library, '{ "personas": [ 半个', 'utf8')
  const brokenState = await call('GET', ROUTES.state)
  assert.equal(brokenState.json.state.health.ok, false, '损坏后 health.ok 应为 false')
  assert.ok(
    brokenState.json.state.health.issues.some((i) => i.file.endsWith('library.json')),
    '健康报告应指出是哪个文件坏了',
  )
  const blocked = await call('POST', ROUTES.save, { action: 'activate', id: 'whatever' })
  assert.equal(blocked.json.ok, false, '损坏状态下写入应被拒绝')
  const repaired = await call('POST', ROUTES.save, { action: 'repair', which: 'library' })
  assert.equal(repaired.json.ok, true, `修复动作应成功：${JSON.stringify(repaired.json.error ?? {})}`)
  assert.ok(repaired.json.preserved.length >= 1, '修复应保留坏文件的备份')
  assert.equal(repaired.json.state.health.ok, true, '修复后应恢复健康')
  assert.ok(repaired.json.state.personas.length >= 1, '修复后应重新预置人格')
  passed += 1
  console.log('  ✓ 人格库损坏 → 界面可见 → 写入被拒 → repair 可恢复')

  const exported = await call('GET', ROUTES.exportTpl)
  assert.equal(exported.status, 200)
  const payload = JSON.parse(exported.text)
  assert.equal(payload.kind, 'dsh-persona-studio/export')
  passed += 1
  console.log('  ✓ GET /export 导出合法 JSON')

  const missing = await call('POST', '/dsh-persona-studio/nope', {})
  assert.equal(missing.status, 404)
  passed += 1
  console.log('  ✓ 未知路由返回 404')
})()

// 等所有异步检查落定再汇总，避免"汇总说全过、其实有失败"
await Promise.all(pending)

console.log(`\n全部通过：${passed} 项，失败 ${failed} 项。`)
// 失败必须体现为退出码，否则提 PR 前的自检会"绿着通过"
if (failed > 0 || passed === 0) process.exitCode = 1
fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('已清理临时目录。')
