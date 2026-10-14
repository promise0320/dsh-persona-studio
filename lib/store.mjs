/**
 * dsh-persona-studio —— 人格库存储层
 *
 * 存放位置（全部在 $DSH_HOME/persona 下，升级 DSH 不会丢）：
 *   config.json     运行配置（注入开关、默认聚焦等级、生成参数）
 *   library.json    人格库 + 当前激活人格
 *   templates/*.json 用户自己丢进来的人格模板（可选）
 *   compiled.txt    当前激活人格编译出的提示词（只读快照，便于用户查看/交接）
 *   traces.jsonl    自动倾向的采纳记录（谁在什么时候因为什么被采纳）
 */

import fs from 'node:fs'
import path from 'node:path'
import { compilePersona, summarizeSpec } from './compile.mjs'
import { makePersonaId, normalizeSpec, BUILTIN_TEMPLATES } from './spec.mjs'

const LIBRARY_VERSION = 1

export const DEFAULT_CONFIG = {
  /** 是否把人格注入系统提示词 */
  enabled: true,
  /** 全局默认聚焦等级（人格可单独覆盖） */
  focus: 'balanced',
  /** 自动归纳时是否调用模型深读 */
  llmDeepRead: false,
  /** 每次归纳参与分析的会话数上限 */
  maxSessions: 8,
  /** 主界面面板的挂载位置：toolbar-right | toolbar-left | composer | floating */
  placement: 'toolbar-right',
  /** 界面语言 */
  locale: 'zh',
}

const PLACEMENTS = ['toolbar-right', 'toolbar-left', 'composer', 'floating']

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 读一个 JSON 文件，并区分三种结果：正常 / 文件不存在 / 文件损坏。
 *
 * 为什么要区分：以前两者都当成"读失败 → 用默认值"，后果是
 * **文件被写坏之后，下一次保存会用默认值把坏文件直接覆盖掉，用户的人格库就没了**。
 * 现在损坏会被记录（并保留原文件），由上层决定是拒绝写入还是显式恢复。
 *
 * @returns {{ value: any, state: 'ok'|'missing'|'corrupt', error?: string }}
 */
function readJsonChecked(file, fallback) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // 文件不存在属正常（首次启动）；其他读取错误当作损坏处理
    if (error && error.code === 'ENOENT') return { value: fallback, state: 'missing' }
    return { value: fallback, state: 'corrupt', error: String(error?.message ?? error) }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      return { value: fallback, state: 'corrupt', error: '内容不是 JSON 对象' }
    }
    return { value: parsed, state: 'ok' }
  } catch (error) {
    return { value: fallback, state: 'corrupt', error: String(error?.message ?? error) }
  }
}

/** 兼容旧调用点：只关心值的地方继续用它。 */
function readJson(file, fallback) {
  return readJsonChecked(file, fallback).value
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 把损坏的文件改名留存，绝不直接删掉用户的数据。 */
function preserveCorrupt(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  try {
    fs.renameSync(file, target)
    return target
  } catch {
    return null
  }
}

export function createStore(homeDir) {
  const root = path.join(homeDir, 'persona')
  const files = {
    root,
    config: path.join(root, 'config.json'),
    library: path.join(root, 'library.json'),
    templates: path.join(root, 'templates'),
    compiled: path.join(root, 'compiled.txt'),
    traces: path.join(root, 'traces.jsonl'),
  }
  ensureDir(root)
  ensureDir(files.templates)

  // ---------------- config ----------------

  // 文件健康状态：读坏过的文件记在这里，界面要如实告诉用户，
  // 并且在这些文件被修复前拒绝自动覆盖（否则会用默认值把用户数据抹掉）。
  /** @type {Map<string, {state:string, error?:string, preserved?:string}>} */
  const integrity = new Map()

  function noteIntegrity(file, info) {
    if (info.state === 'ok') integrity.delete(file)
    else integrity.set(file, info)
  }

  /** 给上层/界面看的数据健康报告。 */
  function integrityReport() {
    // 先各自读一遍，保证状态是最新的（例如用户刚在文件管理器里修好了）
    readConfigChecked()
    readLibraryRaw()
    const issues = []
    for (const [file, info] of integrity) {
      issues.push({
        file,
        state: info.state,
        error: info.error ?? null,
        preserved: info.preserved ?? null,
      })
    }
    return {
      ok: issues.length === 0,
      issues,
      /** 为了让用户看得懂，附带一句人话 */
      summary: issues.length === 0 ? '' : '检测到数据文件损坏，已保留原文件并暂时使用默认值，未覆盖你的数据。',
    }
  }

  /**
   * 读配置并顺带更新完整性状态。
   * 返回 { value, state }，value 已经合并过默认值。
   */
  function readConfigChecked() {
    const checked = readJsonChecked(files.config, {})
    if (checked.state === 'missing') {
      integrity.delete(files.config)
      return { value: { ...DEFAULT_CONFIG }, state: 'missing' }
    }
    if (checked.state === 'corrupt') {
      noteIntegrity(files.config, { state: 'corrupt', error: checked.error ?? '配置内容无法解析' })
      return { value: { ...DEFAULT_CONFIG }, state: 'corrupt' }
    }
    integrity.delete(files.config)
    return { value: { ...DEFAULT_CONFIG, ...(checked.value ?? {}) }, state: 'ok' }
  }

  function readConfig() {
    return readConfigChecked().value
  }

  function writeConfig(patch) {
    // 同样的损坏保护：配置读坏了就拒绝自动写回，免得把用户手改的内容抹掉。
    const known = integrity.get(files.config)
    if (known && known.state === 'corrupt') {
      throw new Error(
        '配置文件已损坏，为避免覆盖你的设置，本次写入被拒绝。' +
          '请在设置页点「重置损坏的数据文件」（会先把坏文件备份成 .corrupt-*）。',
      )
    }
    const next = { ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) }
    if (typeof next.enabled !== 'boolean') next.enabled = true
    if (!['strict', 'balanced', 'off'].includes(next.focus)) next.focus = 'balanced'
    if (!PLACEMENTS.includes(next.placement)) next.placement = DEFAULT_CONFIG.placement
    next.maxSessions = Math.max(1, Math.min(30, Number(next.maxSessions) || 8))
    writeJsonAtomic(files.config, next)
    integrity.delete(files.config)
    return next
  }

  /**
   * 首次启动就把默认配置落盘。
   * 不落盘的话，用户没动过设置页时 config.json 不存在，
   * 想手动改配置的人会找不到文件（实测踩过）。
   */
  function ensureConfigFile() {
    if (fs.existsSync(files.config)) return readConfig()
    return writeConfig({})
  }

  // ---------------- library ----------------

  function readLibraryRaw() {
    const checked = readJsonChecked(files.library, null)
    if (checked.state === 'missing') {
      integrity.delete(files.library)
      return { version: LIBRARY_VERSION, activeId: null, personas: [] }
    }
    if (checked.state === 'corrupt') {
      noteIntegrity(files.library, { state: 'corrupt', error: checked.error })
      return { version: LIBRARY_VERSION, activeId: null, personas: [] }
    }
    const raw = checked.value
    if (!raw || !Array.isArray(raw.personas)) {
      // 语法合法但结构不对：同样按损坏处理，避免后续用空库覆盖它
      noteIntegrity(files.library, { state: 'corrupt', error: '缺少 personas 数组' })
      return { version: LIBRARY_VERSION, activeId: null, personas: [] }
    }
    integrity.delete(files.library)
    return {
      version: LIBRARY_VERSION,
      activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
      personas: raw.personas.filter((p) => p && typeof p === 'object' && typeof p.id === 'string'),
    }
  }

  function normalizeStoredPersona(raw, { now = Date.now() } = {}) {
    const spec = normalizeSpec(raw.spec)
    const note = typeof raw.note === 'string' ? raw.note.slice(0, 2000) : ''
    // 一次性迁移：老版本里"备注"只存不发，AI 看不到。
    // 这里把已有备注补进 spec.identity.background（真正会被编译进提示词的位置），
    // 用户不必重新输入一遍。只在背景为空时补，绝不覆盖用户后来写的值。
    if (!spec.identity.background && note) spec.identity.background = note
    return {
      id: String(raw.id),
      name: String(raw.name || spec.identity.name || '未命名人格'),
      spec,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
      source: typeof raw.source === 'string' ? raw.source : 'manual',
      sourceTemplate: raw.sourceTemplate ? String(raw.sourceTemplate) : null,
      note,
      rationale: Array.isArray(raw.rationale) ? raw.rationale.map(String).slice(0, 40) : [],
      evidence: raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : null,
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now,
      activationCount: Number(raw.activationCount) || 0,
      lastActivatedAt: Number(raw.lastActivatedAt) || null,
    }
  }

  function writeLibrary(library) {
    // 损坏保护：人格库读出来是坏的（但语法/结构问题）时，绝不自动覆盖 ——
    // 一覆盖就等于用一份空库把用户攒的人格抹掉了。要恢复必须走 resetIntegrity()。
    const known = integrity.get(files.library)
    if (known && known.state === 'corrupt') {
      throw new Error(
        '人格库文件已损坏，为避免覆盖你的数据，本次写入被拒绝。' +
          '请在设置页点「重置损坏的数据文件」（会先把坏文件备份成 .corrupt-*），或在文件管理器里手动修复。',
      )
    }
    writeJsonAtomic(files.library, {
      version: LIBRARY_VERSION,
      activeId: library.activeId,
      personas: library.personas,
    })
    integrity.delete(files.library)
    return library
  }

  /**
   * 损坏逃生口：把坏掉的文件改名留存，然后写入一份全新的默认内容。
   * 用户点界面上的"重置损坏数据"时走这里。
   */
  function resetIntegrity(which = 'all') {
    const targets = which === 'all' ? [files.library, files.config] : [files[which]].filter(Boolean)
    const preserved = []
    for (const file of targets) {
      const known = integrity.get(file)
      if (!known || known.state !== 'corrupt') continue
      const target = preserveCorrupt(file)
      if (target) preserved.push(target)
      integrity.delete(file)
    }
    if (targets.includes(files.library)) writeLibrary({ version: LIBRARY_VERSION, activeId: null, personas: [] })
    if (targets.includes(files.config)) writeConfig({})
    return { preserved }
  }

  /** 首次启动时把内置模板里最"中性"的一个落成默认人格。 */
  function ensureSeeded() {
    const library = readLibraryRaw()
    if (library.personas.length > 0) return library
    // 人格库损坏时不要"顺手种一个默认人格"——那会触发写入并（在保护生效前）
    // 覆盖坏文件。此时直接返回空库，由界面提示用户去重置。
    const known = integrity.get(files.library)
    if (known && known.state === 'corrupt') return library
    const seed = BUILTIN_TEMPLATES[0]
    const persona = normalizeStoredPersona({
      id: makePersonaId(seed.name),
      name: seed.name,
      spec: seed.spec,
      tags: seed.tags,
      source: 'seed',
      sourceTemplate: seed.id,
      note: '首次启动预置：可编辑、可复制、可删除。',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    library.personas.push(persona)
    library.activeId = persona.id
    writeLibrary(library)
    return library
  }

  // ---------------- templates ----------------

  /** 用户丢进 templates/ 的自定义模板：JSON 或「front matter + JSON」都可。 */
  function readUserTemplates() {
    const out = []
    let names = []
    try {
      names = fs.readdirSync(files.templates)
    } catch {
      return out
    }
    for (const name of names) {
      if (!/\.(json|txt|md)$/i.test(name)) continue
      const full = path.join(files.templates, name)
      try {
        let text = fs.readFileSync(full, 'utf8')
        if (!/\.json$/i.test(name)) {
          const start = text.indexOf('{')
          const end = text.lastIndexOf('}')
          if (start === -1 || end <= start) continue
          text = text.slice(start, end + 1)
        }
        const parsed = JSON.parse(text)
        const spec = normalizeSpec(parsed.spec ?? parsed)
        out.push({
          id: `file:${name}`,
          name: String(parsed.name || spec.identity.name || name.replace(/\.[^.]+$/, '')),
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : ['自定义文件'],
          summary: typeof parsed.summary === 'string' ? parsed.summary : summarizeSpec(spec),
          source: 'file',
          file: full,
          spec,
        })
      } catch {
        /* 跳过损坏的模板文件 */
      }
    }
    return out
  }

  function listTemplates() {
    return {
      builtin: BUILTIN_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        tags: t.tags,
        summary: t.summary,
        source: 'builtin',
        spec: t.spec,
      })),
      files: readUserTemplates(),
    }
  }

  // ---------------- compile snapshot ----------------

  function writeCompiled(persona, injection) {
    const header = [
      `# 人格：${persona?.name ?? '(无)'}`,
      `# 生成时间：${new Date().toISOString()}`,
      `# 说明：这是 dsh-persona-studio 注入系统提示词的只读快照，每次切换/保存人格都会刷新。`,
      '',
    ].join('\n')
    writeTextAtomic(files.compiled, `${header}${injection || '(当前未启用人格注入)'}\n`)
  }

  // ---------------- traces ----------------

  function appendTrace(entry) {
    try {
      ensureDir(root)
      fs.appendFileSync(files.traces, `${JSON.stringify({ time: Date.now(), ...entry })}\n`, 'utf8')
    } catch {
      /* 记录失败不影响主流程 */
    }
  }

  function readTraces(limit = 40) {
    try {
      const lines = fs.readFileSync(files.traces, 'utf8').split('\n').filter(Boolean)
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .reverse()
    } catch {
      return []
    }
  }

  return {
    files,
    root,
    readConfig,
    writeConfig,
    ensureConfigFile,
    readLibraryRaw,
    writeLibrary,
    normalizeStoredPersona,
    ensureSeeded,
    listTemplates,
    readUserTemplates,
    writeCompiled,
    appendTrace,
    readTraces,
    /** 数据健康报告（损坏时界面要如实告知） */
    integrityReport,
    /** 损坏逃生口：备份坏文件后写入默认内容 */
    resetIntegrity,
    compileOf(persona) {
      return compilePersona(persona.spec, { focus: persona.spec?.tuning?.focus })
    },
  }
}
