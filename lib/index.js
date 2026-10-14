/**
 * dsh-persona-studio —— 宿主半区（Cordis 插件入口）
 *
 * 职责：
 *   1. 把当前激活人格编译成一段提示词，通过 systemPrompt.section() 注入到
 *      DEPLOYMENT_PERSONA_SUFFIX 之后（最后一次请求都会重新取值，保存即生效）；
 *   2. 在自己的作用域里注册 /dsh-persona-studio/* HTTP 路由（状态查询、保存、预览、归纳生成）；
 *   3. 把前端面板脚本注入 index.html（web 形态用 tapIndex，桌面壳用 webserver/index-inject）；
 *   4. 提供 /persona 斜杠命令与 persona 工具，让我也能自己读到/切换当前人格。
 *
 * 所有可调数据都落在 $DSH_HOME/persona 下，不写死在任何包里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi, ROUTES } from './api.mjs'
import { renderInjection } from './compile.mjs'
import { createStore } from './store.mjs'

export const name = 'dsh-persona-studio'
export const inject = ['webServer', 'commands', 'systemPrompt', 'sessions']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')

/** 解析 DSH 主目录（延迟到 apply 时求值，便于测试与热重载）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const home = os.homedir()
  const candidate = path.join(home, '.dsh')
  if (fs.existsSync(candidate)) return candidate
  return path.join(PACKAGE_ROOT, '.data')
}

const SECTION_NAME = 'persona-forge:active-persona'
const BOOTSTRAP_TAG = `<script defer src="${ROUTES.bootstrap}"></script>`
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${ROUTES.bootstrap}";s.defer=true;` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/**
 * 注入到系统提示词的文本：每次装配都会重新调用，所以保存人格后立即生效。
 */
function activeInjection(store, config) {
  try {
    if (!config.enabled) return ''
    const library = store.ensureSeeded()
    const active = library.personas.find((p) => p.id === library.activeId)
    if (!active) return ''
    const focus = active.spec?.tuning?.focus ?? config.focus ?? 'balanced'
    return renderInjection(active.spec, { focus })
  } catch {
    return ''
  }
}

export function apply(ctx) {
  const dshHome = resolveDshHome()
  const store = createStore(dshHome)
  try {
    store.ensureSeeded()
    // 首次启动就把默认配置写出来：否则用户没动过设置页时 config.json 不存在，
    // 想手动翻看/改配置的人会找不到文件（实测踩过）。
    store.ensureConfigFile()
  } catch (error) {
    ctx.logger?.warn?.(`[persona-forge] 初始化人格库失败：${String(error?.message ?? error)}`)
  }

  /* ---- 0) 尽早注册桌面壳的注入行（桌面端只在启动时收集一次） ---- */
  const rowDisposers = []
  ctx.effect(() => () => {
    for (const dispose of rowDisposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
  })
  rowDisposers.push(
    ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === ROUTES.bootstrap) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(ROUTES.bootstrap)) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch {
        /* 忽略 */
      }
    }),
  )

  /* ---- 1) 解析"深读该用哪个模型" ----
   *
   * 三层兜底，从最贴近本会话的往下退：
   *   ① 监听 agent/request 捕获本会话真实在用的 provider/model（最准）
   *   ② 拿不到就问宿主的「默认模型」服务（agentDefaultModel.currentSelection()）
   *   ③ 都没有才报错
   *
   * 踩过的坑：原来只有第 ① 层。而它**只有在本次进程里发过一次模型请求之后**才有值，
   * 所以刚重启就点「模型深读」必然报"尚未捕获到可用的模型路由" —— 用户看到完全摸不着头脑。
   */
  let lastRoute = null
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    try {
      if (config?.provider && config?.model) {
        lastRoute = { provider: String(config.provider), model: String(config.model) }
      }
    } catch {
      /* 忽略 */
    }
    return config
  })

  /** 返回 { provider, model, source } 或 null。 */
  function resolveModelRoute() {
    if (lastRoute?.provider && lastRoute?.model) {
      return { provider: lastRoute.provider, model: lastRoute.model, source: 'session' }
    }
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
      if (selection?.provider && selection?.model) {
        return {
          provider: String(selection.provider),
          model: String(selection.model),
          source: 'default-model',
        }
      }
    } catch {
      /* 忽略：服务不存在或调用失败，继续往下退 */
    }
    return null
  }

  /* ---- 2) 系统提示词注入 ---- */
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1,
        text: () => activeInjection(store, store.readConfig()),
        interpolate: false,
      }),
    'persona-forge: persona section',
  )

  /* ---- 3) HTTP 路由 + 前端资源 ---- */
  const deps = {}

  /**
   * 取会话服务。
   * 优先 `inject` 注入的 `ctx.sessions`；再退回 `ctx.get('sessions')`。
   * 两条都试是为了避免"插件没声明依赖 → 属性不存在 → 静默返回空会话"这种
   * 让人误以为"归纳不好用"的故障（实测踩过）。
   */
  function sessionsService() {
    try {
      if (ctx.sessions && typeof ctx.sessions.list === 'function') return ctx.sessions
    } catch {
      /* 忽略 */
    }
    try {
      const service = ctx.get('sessions')
      if (service && typeof service.list === 'function') return service
    } catch {
      /* 忽略 */
    }
    return null
  }

  const api = createApi({
    store,
    assetsDir: ASSETS_DIR,
    // 传给 API 的是"解析结果"而不是原始捕获值：拿不到会话路由时会退回宿主默认模型，
    // 这样"刚重启就点深读"也能用。
    getLastRoute: () => resolveModelRoute(),
    getLiveSessionSummaries: () => {
      const service = sessionsService()
      if (!service) return []
      try {
        return service.list().slice(0, 20).map((session) => ({
          id: String(session.id),
          title: session.header?.title || '',
          createdAt: session.header?.createdAt ?? 0,
        }))
      } catch {
        return []
      }
    },
    sessions: {
      list: () => {
        const service = sessionsService()
        if (!service) return []
        try {
          return service.list()
        } catch {
          return []
        }
      },
      get: (id) => {
        const service = sessionsService()
        if (!service) return undefined
        try {
          return service.get(id)
        } catch {
          return undefined
        }
      },
    },
    // 持久化会话查询：重启后内存里的活会话没了，靠它才能读到历史（归纳人格的关键路径）
    sessionQuery: {
      get listSessions() {
        const service = ctx.get('sessionQuery')
        return service && typeof service.listSessions === 'function' ? service.listSessions.bind(service) : undefined
      },
      get readSession() {
        const service = ctx.get('sessionQuery')
        return service && typeof service.readSession === 'function' ? service.readSession.bind(service) : undefined
      },
      get readTitleSnapshots() {
        const service = ctx.get('sessionQuery')
        return service && typeof service.readTitleSnapshots === 'function'
          ? service.readTitleSnapshots.bind(service)
          : undefined
      },
    },
    cwd: () => {
      try {
        return process.cwd()
      } catch {
        return undefined
      }
    },
    llm: {
      // 延迟取值：llm 服务可能比我晚挂载，每次调用时再解析。
      stream(options) {
        const service = deps.llm ?? ctx.get('llm')
        if (!service || typeof service.stream !== 'function') {
          throw new Error('llm 服务当前不可用')
        }
        return service.stream(options)
      },
    },
    logger: (message) => ctx.logger?.info?.(`[persona-forge] ${message}`),
  })
  const routes = [
    { path: ROUTES.bootstrap, methods: ['GET'] },
    { path: ROUTES.panel, methods: ['GET'] },
    { path: ROUTES.style, methods: ['GET'] },
    { path: ROUTES.state, methods: ['GET'] },
    { path: ROUTES.active, methods: ['GET'] },
    { path: ROUTES.list, methods: ['GET'] },
    { path: ROUTES.exportTpl, methods: ['GET'] },
    { path: ROUTES.save, methods: ['POST'] },
    { path: ROUTES.preview, methods: ['POST'] },
    { path: ROUTES.generate, methods: ['POST'] },
    { path: ROUTES.importTpl, methods: ['POST'] },
  ]

  for (const route of routes) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: (req, res) => {
            try {
              aclCheck(req, res)
            } catch {
              return
            }
            const url = new URL(req.url ?? route.path, `http://${req.headers.host ?? '127.0.0.1'}`)
            if (!route.methods.includes(req.method ?? 'GET')) {
              res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: req.method } }))
              return
            }
            Promise.resolve(api.handle(req, res, url)).catch((error) => {
              try {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error?.message ?? error) } }))
              } catch {
                /* 响应已发出 */
              }
            })
          },
        }),
      `persona-forge: route ${route.path}`,
    )
  }

  /* ---- 4) 把面板脚本挂进 index.html（浏览器形态） ---- */
  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string') return html
        if (html.includes(ROUTES.bootstrap)) return html
        if (html.includes('</body>')) return html.replace('</body>', `${BOOTSTRAP_TAG}</body>`)
        return html + BOOTSTRAP_TAG
      }),
    'persona-forge: index bootstrap',
  )

  /* ---- 5) /persona 斜杠命令 ---- */
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'persona',
        description: '查看 / 切换 / 关闭 LLM 人格（dsh-persona-studio）',
        input: { hint: '[list|use <名称或ID>|on|off|reload|path]' },
        handler: ({ rawInput }) => {
          const line = String(rawInput ?? '').trim()
          const [verb, ...rest] = line.split(/\s+/).filter(Boolean)
          const arg = rest.join(' ')
          const library = store.ensureSeeded()
          const config = store.readConfig()
          const active = library.personas.find((p) => p.id === library.activeId) ?? null

          if (!verb || verb === 'status') {
            return {
              kind: 'success',
              text: [
                `人格注入：${config.enabled ? '已开启' : '已关闭'}`,
                `当前人格：${active ? `${active.name}（${active.id}）` : '未设置'}`,
                active ? `风格：${active.spec.style.tone} / ${active.spec.style.verbosity} / 直接度 ${active.spec.style.directness}` : '',
                `人格库：${library.personas.length} 个 · 目录 ${store.root}`,
                '用法：/persona list | use <名称> | on | off',
              ]
                .filter(Boolean)
                .join('\n'),
            }
          }

          if (verb === 'list') {
            return {
              kind: 'success',
              text: library.personas
                .map((p) => `${p.id === library.activeId ? '● ' : '  '}${p.name} — ${p.id}`)
                .join('\n'),
            }
          }

          if (verb === 'on' || verb === 'off') {
            const next = store.writeConfig({ enabled: verb === 'on' })
            api.writeAndSync(library)
            return { kind: 'success', text: `人格注入已${next.enabled ? '开启' : '关闭'}。` }
          }

          if (verb === 'path') {
            return { kind: 'success', text: `人格库目录：${store.root}` }
          }

          if (verb === 'use') {
            const needle = arg.trim()
            const found =
              library.personas.find((p) => p.id === needle) ??
              library.personas.find((p) => p.name === needle) ??
              library.personas.find((p) => p.name.includes(needle) || needle.includes(p.name))
            if (!found) {
              return { kind: 'error', text: `找不到人格「${needle}」。可用：/persona list` }
            }
            found.activationCount = (found.activationCount ?? 0) + 1
            found.lastActivatedAt = Date.now()
            library.activeId = found.id
            api.writeAndSync(library)
            store.appendTrace({ kind: 'activate', personaId: found.id, name: found.name, reason: 'command' })
            return { kind: 'success', text: `已切换到人格「${found.name}」，下一次请求即生效。` }
          }

          return { kind: 'error', text: `未知子命令「${verb}」。用法：/persona [list|use <名称>|on|off|path]` }
        },
      }),
    'persona-forge: /persona command',
  )

  /* ---- 6) 无模型侧工具：人格的读取/切换走 /persona 命令与主界面面板 ----
   * 刻意不注册 ctx.tools 工具：dsh-tools 的工具定义契约是 defineTool(...)，
   * 而本插件的设计目标之一是"不依赖任何 DSH 内部包、零构建"，所以不引入 @deepseek-ai/dsh-tools。
   * 人格相关的可编程入口：/persona 命令（人用）+ /dsh-persona-studio/* HTTP 路由（面板用）。
   */
  try {
    const cfg = store.readConfig()
    ctx.logger?.debug?.(`[persona-forge] 注入${cfg.enabled ? "已开启" : "已关闭"}，人格库：${store.root}`)
  } catch {
    /* 忽略 */
  }

  ctx.logger?.info?.(`[persona-forge] 已加载，人格库：${store.root}`)
}

/**
 * 轻量访问控制：拒绝明显跨站的请求，避免本机浏览器被第三方页面借刀调用。
 * （DSH 自带的 connection 信任栅栏仍在其上游生效。）
 */
function aclCheck(req, res) {
  const host = String(req.headers.host ?? '')
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: { code: 'cross-site', message: 'cross-site request blocked' } }))
    throw new Error('cross-site')
  }
  if (origin) {
    try {
      const originHost = new URL(origin).host
      if (host && originHost !== host) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'origin-mismatch', message: 'origin mismatch' } }))
        throw new Error('origin-mismatch')
      }
    } catch (error) {
      if (String(error?.message) === 'origin-mismatch') throw error
      /* origin 不是合法 URL：忽略 */
    }
  }
}
