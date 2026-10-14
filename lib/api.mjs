/**
 * dsh-persona-studio —— 宿主 HTTP API
 *
 * 路由（全部挂在 webServer 上，仅监听回环地址的使用场景）：
 *   GET  /dsh-persona-studio/panel.js      前端面板脚本
 *   GET  /dsh-persona-studio/panel.css     前端面板样式
 *   GET  /dsh-persona-studio/bootstrap.js  注入到 index.html 的引导脚本
 *   GET  /dsh-persona-studio/state         人格库 + 模板 + 规格 + 配置
 *   POST /dsh-persona-studio/save          新建 / 保存 / 激活 / 删除 / 复制 / 改配置
 *   POST /dsh-persona-studio/preview       编译预览（不落盘）
 *   POST /dsh-persona-studio/generate      从历史对话归纳人格（启发式 / 模型深读）
 *   POST /dsh-persona-studio/import        导入模板
 *   GET  /dsh-persona-studio/export        导出全部数据
 */

import fs from 'node:fs'
import path from 'node:path'
import { compilePersona, describeSpec, renderInjection, summarizeSpec } from './compile.mjs'
import { collectHistory, heuristicAnalyze, llmAnalyze, matchTemplate } from './analyze.mjs'
import { BUILTIN_TEMPLATES, DEFAULT_SPEC, isAsciiId, makePersonaId, normalizeSpec } from './spec.mjs'

const ROUTES = {
  bootstrap: '/dsh-persona-studio/bootstrap.js',
  panel: '/dsh-persona-studio/panel.js',
  style: '/dsh-persona-studio/panel.css',
  state: '/dsh-persona-studio/state',
  list: '/dsh-persona-studio/list',
  active: '/dsh-persona-studio/active',
  save: '/dsh-persona-studio/save',
  preview: '/dsh-persona-studio/preview',
  generate: '/dsh-persona-studio/generate',
  importTpl: '/dsh-persona-studio/import',
  exportTpl: '/dsh-persona-studio/export',
}

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 宿主必须注册的完整端点面。
 * 前端 assets/panel.js 里的 API 常量、以及 test/apply.mjs 的断言都以这份为准，
 * 任何一侧改了路径都会在这里对不上（防止静默漂移）。
 */
export const ENDPOINTS = {
  bootstrap: { path: ROUTES.bootstrap, method: 'GET', kind: 'asset' },
  panel: { path: ROUTES.panel, method: 'GET', kind: 'asset' },
  style: { path: ROUTES.style, method: 'GET', kind: 'asset' },
  state: { path: ROUTES.state, method: 'GET', kind: 'api' },
  list: { path: ROUTES.list, method: 'GET', kind: 'api' },
  active: { path: ROUTES.active, method: 'GET', kind: 'api' },
  exportTpl: { path: ROUTES.exportTpl, method: 'GET', kind: 'api' },
  save: { path: ROUTES.save, method: 'POST', kind: 'api' },
  preview: { path: ROUTES.preview, method: 'POST', kind: 'api' },
  generate: { path: ROUTES.generate, method: 'POST', kind: 'api' },
  importTpl: { path: ROUTES.importTpl, method: 'POST', kind: 'api' },
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, jsonHeaders())
  res.end(body)
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, ...value })
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ------------------------------------------------------------------ *
 * 状态快照
 * ------------------------------------------------------------------ */

function publicPersona(persona) {
  return {
    ...persona,
    summary: summarizeSpec(persona.spec),
    compiled: compilePersona(persona.spec, { focus: persona.spec?.tuning?.focus }),
  }
}

export function createApi(deps) {
  const {
    store,
    assetsDir,
    getLastRoute,
    getLiveSessionSummaries,
    logger = () => {},
  } = deps

  function readAsset(name) {
    const full = path.join(assetsDir, name)
    return { text: fs.readFileSync(full, 'utf8'), ext: path.extname(name) }
  }

  function buildState() {
    const library = store.ensureSeeded()
    const config = store.readConfig()
    // 读的时候就做一次字段迁移：老版本只存在于 note 里的"备注"要补进
    // spec.identity.background，否则用户重启后仍会看到"我写了备注但 AI 不知道"。
    // 迁移是幂等的，且只在背景为空时补值。
    const personas = library.personas.map((p) => {
      const migrated = store.normalizeStoredPersona(p)
      const changed =
        migrated.spec.identity.background !== (p.spec?.identity?.background ?? '') ||
        migrated.note !== p.note
      return changed ? migrated : p
    })
    const activeId = library.activeId
    const active = personas.find((p) => p.id === activeId) ?? null
    // 编译一次给两处用：注入文本本身 + 「送达」自检的长度
    const injectionText =
      config.enabled !== false && active ? renderInjection(active.spec, { focus: active.spec?.tuning?.focus }) : ''
    return {
      config,
      activeId,
      active: active ? publicPersona(active) : null,
      personas: personas
        .slice()
        .sort((a, b) => (b.lastActivatedAt ?? b.updatedAt) - (a.lastActivatedAt ?? a.updatedAt))
        .map(publicPersona),
      templates: store.listTemplates(),
      spec: describeSpec(),
      /** 默认规格：前端据此算出"改了哪些字段"，用于卡片上的未保存提示 */
      defaults: DEFAULT_SPEC,
      /** 一份补全了所有分类与字段的空白规格，新建人格时用（避免半截规格） */
      blankSpec: normalizeSpec({}),
      injection: injectionText,
      traces: store.readTraces(20),
      /** 数据健康报告：文件损坏时界面要如实提示，不能静默用默认值糊过去 */
      health: store.integrityReport(),
      /**
       * 「送达」自检：把"当前配置到底有没有真的进入提示词"算清楚给用户看。
       * 这一项是回应"改了配置却不生效"这类最难排查的问题 —— 让用户能一眼看到
       * 注入开关、当前人格、编译长度、以及最终发给模型的文本里有没有人格块。
       */
      delivery: {
        enabled: config.enabled !== false,
        hasActivePersona: !!active,
        personaName: active?.name ?? null,
        focus: active?.spec?.tuning?.focus ?? config.focus ?? 'balanced',
        injectedChars: active && config.enabled !== false ? injectionText.length : 0,
        willInject: config.enabled !== false && !!active && injectionText.length > 0,
      },
      paths: {
        root: store.root,
        library: store.files.library,
        config: store.files.config,
        templates: store.files.templates,
        compiled: store.files.compiled,
      },
      modelRoute: getLastRoute() ?? null,
      sessions: typeof getLiveSessionSummaries === 'function' ? getLiveSessionSummaries() : [],
      version: 1,
    }
  }

  function requirePersona(library, id) {
    const persona = library.personas.find((p) => p.id === id)
    if (!persona) throw new Error(`人格不存在：${id}`)
    return persona
  }

  function toPersona(input, { existing } = {}) {
    const spec = normalizeSpec(input?.spec ?? input)
    const now = Date.now()
    const base = existing
      ? { ...existing }
      : {
          id: makePersonaId(input?.name || spec.identity.name),
          createdAt: now,
          activationCount: 0,
          lastActivatedAt: null,
        }
    // 备注与「背景设定」是同一件事的两面：备注用于卡片显示，背景设定进入提示词。
    // 迁移必须**双向**，否则会出现"写了备注但 AI 看不到"（新建时踩过）：
    //   · 有备注、背景为空 → 补背景（否则 AI 收不到这段设定）
    //   · 背景有值、备注为空 → 补备注（否则卡片上不显示）
    const incomingNote = typeof input?.note === 'string' && input.note.trim() ? input.note.slice(0, 2000) : ''
    const resolvedNote = incomingNote || existing?.note || spec.identity.background || ''
    if (!spec.identity.background && resolvedNote) spec.identity.background = resolvedNote

    const persona = {
      ...base,
      id: base.id,
      name: String(input?.name || spec.identity.name || base.name || '未命名人格').slice(0, 80),
      spec,
      tags: Array.isArray(input?.tags)
        ? input.tags.map(String).slice(0, 12)
        : existing?.tags ?? [],
      source: existing?.source ?? String(input?.source ?? 'manual'),
      sourceTemplate: input?.sourceTemplate ?? existing?.sourceTemplate ?? null,
      note: resolvedNote,
      rationale: Array.isArray(input?.rationale)
        ? input.rationale.map(String).slice(0, 40)
        : existing?.rationale ?? [],
      evidence: input?.evidence ?? existing?.evidence ?? null,
      confidence: Number.isFinite(input?.confidence) ? input.confidence : existing?.confidence ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      activationCount: existing?.activationCount ?? 0,
      lastActivatedAt: existing?.lastActivatedAt ?? null,
    }
    return persona
  }

  function activate(library, persona, reason) {
    library.activeId = persona.id
    persona.activationCount = (persona.activationCount ?? 0) + 1
    persona.lastActivatedAt = Date.now()
    writeAndSync(library)
    store.appendTrace({
      kind: 'activate',
      personaId: persona.id,
      name: persona.name,
      reason: reason ?? 'manual',
    })
  }

  /**
   * 数据损坏时，**任何写操作整体拒绝**。
   *
   * 为什么要有这个前置检查：写入路径上如果只靠 `writeLibrary` 自己抛错，
   * 那么"先写配置、后写人格库"这类顺序里，前半截已经落盘了 —— 用户会看到
   * "保存成功了"的假象，实际只改了一半（实测：人格库坏了时改配置仍返回 200）。
   * 所以这里在动手之前就先拦下来，保证要么全成功、要么全不动。
   */
  function assertWritable() {
    const health = store.integrityReport()
    if (!health.ok) {
      const files = health.issues.map((i) => i.file.split(/[\\/]/).pop()).join('、')
      throw new Error(
        `数据文件损坏（${files}），为避免覆盖你的数据，本次操作被拒绝。` +
          '请在设置页点「备份坏文件并重建」，它会先把坏文件改名备份再重建。',
      )
    }
  }

  function writeAndSync(library) {
    assertWritable()
    store.writeLibrary(library)
    const active = library.personas.find((p) => p.id === library.activeId)
    const config = store.readConfig()
    const injection = config.enabled && active ? renderInjection(active.spec, { focus: active.spec?.tuning?.focus }) : ''
    store.writeCompiled(active, injection)
  }

  async function handle(req, res, url) {
    const pathname = url.pathname

    // ---- 静态资源 ----
    if (pathname === ROUTES.bootstrap || pathname === ROUTES.panel || pathname === ROUTES.style) {
      const name = pathname === ROUTES.bootstrap ? 'bootstrap.js' : pathname === ROUTES.panel ? 'panel.js' : 'panel.css'
      try {
        const asset = readAsset(name)
        res.writeHead(200, {
          'Content-Type': MIME[asset.ext] ?? 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(asset.text)
      } catch (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`missing asset: ${name}`)
      }
      return
    }

    // ---- GET /state ----
    if (pathname === ROUTES.state) {
      try {
        ok(res, { state: buildState() })
      } catch (error) {
        fail(res, 500, 'state-failed', String(error?.message ?? error))
      }
      return
    }

    // ---- GET /export ----
    if (pathname === ROUTES.exportTpl) {
      try {
        const library = store.ensureSeeded()
        const payload = {
          kind: 'dsh-persona-studio/export',
          version: 1,
          exportedAt: new Date().toISOString(),
          config: store.readConfig(),
          activeId: library.activeId,
          personas: library.personas,
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="dsh-persona-export.json"',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(payload, null, 2))
      } catch (error) {
        fail(res, 500, 'export-failed', String(error?.message ?? error))
      }
      return
    }

    let body = {}
    if (req.method === 'POST') {
      try {
        body = await readBody(req)
      } catch (error) {
        fail(res, 400, 'bad-body', String(error?.message ?? error))
        return
      }
    } else if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', `不支持的方法：${req.method}`)
      return
    }

    try {
      switch (pathname) {
        // ---- GET /list ----
        case ROUTES.list: {
          const library = store.ensureSeeded()
          const active = library.personas.find((p) => p.id === library.activeId) ?? null
          ok(res, {
            activeId: library.activeId,
            active: active ? publicPersona(active) : null,
            personas: library.personas.map((p) => ({
              id: p.id,
              name: p.name,
              summary: summarizeSpec(p.spec),
              tags: p.tags,
              source: p.source,
              updatedAt: p.updatedAt,
            })),
          })
          return
        }

        // ---- GET /active ----
        case ROUTES.active: {
          const library = store.ensureSeeded()
          const active = library.personas.find((p) => p.id === library.activeId) ?? null
          const config = store.readConfig()
          ok(res, {
            enabled: config.enabled,
            persona: active ? publicPersona(active) : null,
            injection: config.enabled && active ? renderInjection(active.spec) : '',
          })
          return
        }

        // ---- 编译预览 ----
        case ROUTES.preview: {
          const spec = normalizeSpec(body.spec ?? body)
          const focus = body.focus ?? spec.tuning.focus
          ok(res, {
            compiled: compilePersona(spec, { focus }),
            injection: renderInjection(spec, { focus }),
          })
          return
        }

        // ---- 保存 / 激活 / 删除 / 复制 / 配置 / 修复损坏文件 ----
        case ROUTES.save: {
          const action = String(body.action ?? 'save')

          if (action === 'repair') {
            // 损坏逃生口：把坏掉的文件改名留存（.corrupt-<时间>），再写入默认内容。
            // 只有用户显式点这个动作才执行，正常路径永远不会自动覆盖坏文件。
            // 注意：repair 必须在损坏检查**之前**放行，它本来就是用来救数据的。
            const which = body.which === 'config' || body.which === 'library' ? body.which : 'all'
            const result = store.resetIntegrity(which)
            store.appendTrace({ kind: 'repair', which, preserved: result.preserved })
            ok(res, { repaired: which, preserved: result.preserved, state: buildState() })
            return
          }

          // ⚠️ 守卫必须在**任何** store 访问之前。
          // 踩过的坑：把 `store.ensureSeeded()` 写在守卫前面 —— 而 ensureSeeded 发现
          // 人格库为空时会"顺手"写回一份默认库，等于把损坏文件洗成健康的，
          // 守卫随后检查就一切正常，于是脏数据被静默覆盖。
          assertWritable()

          const library = store.ensureSeeded()

          if (action === 'config') {
            const config = store.writeConfig(body.config ?? {})
            writeAndSync(library)
            ok(res, { config, state: buildState() })
            return
          }

          if (action === 'activate') {
            const persona = requirePersona(library, String(body.id ?? ''))
            activate(library, persona, body.reason)
            ok(res, { activeId: persona.id, state: buildState() })
            return
          }

          if (action === 'delete') {
            const id = String(body.id ?? '')
            const index = library.personas.findIndex((p) => p.id === id)
            if (index === -1) throw new Error(`人格不存在：${id}`)
            if (library.personas.length === 1) throw new Error('至少保留一个人格')
            library.personas.splice(index, 1)
            if (library.activeId === id) library.activeId = library.personas[0].id
            writeAndSync(library)
            store.appendTrace({ kind: 'delete', personaId: id })
            ok(res, { state: buildState() })
            return
          }

          if (action === 'duplicate') {
            const source = requirePersona(library, String(body.id ?? ''))
            const copy = toPersona(
              {
                name: String(body.name || `${source.name} 副本`),
                spec: JSON.parse(JSON.stringify(source.spec)),
                tags: source.tags,
                source: 'duplicate',
                sourceTemplate: source.sourceTemplate,
                note: source.note,
                rationale: source.rationale,
                evidence: source.evidence,
                confidence: source.confidence,
              },
              {},
            )
            library.personas.push(copy)
            writeAndSync(library)
            ok(res, { persona: publicPersona(copy), state: buildState() })
            return
          }

          if (action === 'create') {
            const persona = toPersona(body.persona ?? body, {})
            library.personas.push(persona)
            if (body.activate !== false) {
              activate(library, persona, body.reason ?? `create:${persona.source}`)
            } else {
              writeAndSync(library)
            }
            ok(res, { persona: publicPersona(persona), state: buildState() })
            return
          }

          // 默认：save（有 id 则更新，无 id 则新建）
          const id = body.persona?.id ?? body.id
          if (id || body.rename) {
            const existing = id
              ? library.personas.find((p) => p.id === id)
              : library.personas.find((p) => p.name === String(body.persona?.name ?? ''))
            if (!existing) throw new Error(`人格不存在：${id ?? body.persona?.name}`)
            const previousId = existing.id
            const updated = toPersona(body.persona ?? body, { existing })
            Object.assign(existing, updated)
            // 兼容旧数据：早期版本直接拿中文名做编号（persona-严谨工程师-xxx），
            // 在命令行/终端里会乱码。保存时顺手换成纯 ASCII 编号。
            if (!isAsciiId(existing.id)) {
              existing.id = makePersonaId(existing.name)
              if (library.activeId === previousId) library.activeId = existing.id
            }
            if (body.activate === true) activate(library, existing, 'save-and-activate')
            else writeAndSync(library)
            ok(res, { persona: publicPersona(existing), state: buildState() })
          } else {
            const persona = toPersona(body.persona ?? body, {})
            library.personas.push(persona)
            if (body.activate !== false) activate(library, persona, 'save-new')
            else writeAndSync(library)
            ok(res, { persona: publicPersona(persona), state: buildState() })
          }
          return
        }

        // ---- 从模板实例化 ----
        case ROUTES.importTpl: {
          const library = store.ensureSeeded()
          const kind = String(body.kind ?? 'template')

          if (kind === 'payload') {
            // 直接导入 export 出来的整体数据
            const personas = Array.isArray(body.payload?.personas) ? body.payload.personas : []
            let added = 0
            for (const raw of personas) {
              const persona = toPersona({ ...raw, source: 'import' }, {})
              persona.id = makePersonaId(persona.name)
              library.personas.push(persona)
              added += 1
            }
            if (body.payload?.config) store.writeConfig(body.payload.config)
            writeAndSync(library)
            ok(res, { added, state: buildState() })
            return
          }

          let spec = null
          let name = String(body.name ?? '导入模板')
          let source = 'template'
          if (typeof body.templateId === 'string') {
            const builtin = BUILTIN_TEMPLATES.find((t) => t.id === body.templateId)
            if (builtin) {
              spec = builtin.spec
              name = body.name || builtin.name
              source = `template:${builtin.id}`
            } else {
              const fileTpl = store.readUserTemplates().find((t) => t.id === body.templateId)
              if (fileTpl) {
                spec = fileTpl.spec
                name = body.name || fileTpl.name
                source = `file:${fileTpl.id}`
              }
            }
          } else if (body.spec) {
            spec = body.spec
          }
          if (!spec) throw new Error('未找到要导入的模板')
          const persona = toPersona(
            { name, spec, tags: body.tags ?? [], source, sourceTemplate: body.templateId ?? null },
            {},
          )
          library.personas.push(persona)
          if (body.activate !== false) activate(library, persona, `template:${body.templateId ?? 'inline'}`)
          else writeAndSync(library)
          ok(res, { persona: publicPersona(persona), state: buildState() })
          return
        }

        // ---- 归纳生成 ----
        case ROUTES.generate: {
          const mode = String(body.mode ?? 'heuristic')
          const options = {
            maxSessions: Number(body.maxSessions) || store.readConfig().maxSessions,
            cwd: typeof deps.cwd === 'function' ? deps.cwd() : undefined,
          }
          const history = await collectHistory(deps, options)
          let proposal
          if (mode === 'llm') {
            const route = body.route ?? getLastRoute()
            try {
              proposal = await llmAnalyze(deps, route, history, { signal: body.__signal })
            } catch (error) {
              logger(`深读失败，回落到启发式：${String(error?.message ?? error)}`)
              const fallback = heuristicAnalyze(history)
              proposal = {
                ...fallback,
                note: `模型深读失败（${String(error?.message ?? error)}），已回落到统计归纳。`,
                source: 'heuristic-fallback',
              }
            }
          } else {
            proposal = heuristicAnalyze(history)
          }
          ok(res, {
            proposal: {
              ...proposal,
              templateId: proposal.templateId ?? matchTemplate(proposal.spec),
            },
            history: {
              sessions: history.sessions.length,
              messages: history.sessions.reduce((n, s) => n + s.userTexts.length, 0),
              usedLiveSessions: history.stats.usedSessions,
            },
            state: buildState(),
          })
          return
        }

        default:
          fail(res, 404, 'not-found', `未知路由：${pathname}`)
      }
    } catch (error) {
      fail(res, 400, 'request-failed', String(error?.message ?? error))
    }
  }

  return { handle, buildState, ROUTES, writeAndSync }
}

export { ROUTES }
