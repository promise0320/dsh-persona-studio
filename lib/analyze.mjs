/**
 * dsh-persona-studio —— 人格归纳器
 *
 * 两条路径：
 *   1) heuristicAnalyze()：纯统计，不调用模型，零成本、离线可用，永远成功；
 *   2) llmAnalyze()：把对话样本交给当前会话正在使用的模型，让它归纳"用户潜在需求"
 *      并给出人格建议；失败时自动回落 (1)。
 *
 * 两者的产物形状一致（Proposal），因此前端可以无差别展示与采纳。
 */

import { BUILTIN_TEMPLATES, DEFAULT_SPEC, defaultSpec, normalizeSpec } from './spec.mjs'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const CJK = /[\u4e00-\u9fff]/
const CODE_BLOCK = /```/
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/m
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

/* ------------------------------------------------------------------ *
 * 对话样本收集（宿主注入 sessions 服务后调用）
 * ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {{get?:Function,list?:Function}} deps.sessions
 * @param {{listSessions?:Function}} [deps.sessionQuery]
 * @param {{maxSessions?:number,maxUserMessages?:number}} [options]
 */
export async function collectHistory(deps, options = {}) {
  const maxSessions = options.maxSessions ?? 8
  const maxUserMessages = options.maxUserMessages ?? 120
  const roles = { user: 0, assistant: 0 }
  /** @type {Array<{sessionId:string,title:string,userTexts:string[],assistantSamples:string[],updatedAt:number}>} */
  const sessions = []

  const live = []
  try {
    const list = deps?.sessions?.list?.() ?? []
    for (const session of list) live.push(session)
  } catch {
    /* 忽略：sessions 服务不可用 */
  }

  // 按最近活动排序（有 updatedAt 就用，没有就保持原顺序）
  live.sort((a, b) => {
    const ta = a?.header?.createdAt ?? 0
    const tb = b?.header?.createdAt ?? 0
    return tb - ta
  })

  for (const session of live.slice(0, maxSessions)) {
    const entry = readLiveSession(session)
    if (entry && entry.userTexts.length > 0) sessions.push(entry)
  }

  // —— 路径二：持久化会话（重启后内存里没有，但磁盘上有） ——
  // 这是"从历史对话归纳人格"真正可用的关键：只看活会话的话，
  // 用户重启一次就再也归纳不出东西（实测踩过这个坑）。
  if (sessions.length === 0) {
    const rest = await readPersistedSessions(deps, maxSessions, options.cwd)
    for (const entry of rest) {
      if (entry.userTexts.length > 0) sessions.push(entry)
    }
  }

  for (const entry of sessions) {
    for (const text of entry.userTexts) {
      roles.user += 1
      void text
    }
    roles.assistant += entry.assistantSamples.length
  }

  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      userTexts: s.userTexts.slice(0, Math.ceil(maxUserMessages / Math.max(1, sessions.length))),
      assistantSamples: s.assistantSamples.slice(0, 2),
    })),
    stats: { roles, liveSessions: live.length, usedSessions: sessions.length },
  }
}

/**
 * 从持久化会话日志读取历史（重启后仍然可用）。
 * @param {object} deps
 * @param {number} maxSessions
 * @param {string} [cwd] 只统计同工作目录的会话，避免把别的项目混进来
 */
async function readPersistedSessions(deps, maxSessions, cwd) {
  const query = deps?.sessionQuery
  if (!query || typeof query.listSessions !== 'function') return []

  let records = []
  try {
    records = (await query.listSessions()) ?? []
  } catch {
    return []
  }

  const current = typeof cwd === 'string' && cwd ? cwd.toLowerCase() : null
  const picked = records
    .filter((record) => {
      if (!current) return true
      const recordCwd = record?.cwd ?? record?.meta?.cwd ?? record?.header?.cwd
      if (typeof recordCwd !== 'string' || !recordCwd) return true
      return recordCwd.toLowerCase() === current
    })
    .slice(0, maxSessions)

  const titles = new Map()
  if (typeof query.readTitleSnapshots === 'function') {
    try {
      const ids = picked.map((r) => r?.sessionId ?? r?.id).filter(Boolean)
      const snapshots = (await query.readTitleSnapshots(ids)) ?? []
      for (const snapshot of snapshots) {
        const id = snapshot?.sessionId ?? snapshot?.id
        const title = snapshot?.title ?? snapshot?.value?.title ?? snapshot?.snapshot?.title
        if (id && typeof title === 'string' && title) titles.set(String(id), title)
      }
    } catch {
      /* 标题拿不到就算了 */
    }
  }

  const out = []
  for (const record of picked) {
    const id = String(record?.sessionId ?? record?.id ?? '')
    if (!id) continue
    let events = []
    try {
      const snapshot = await query.readSession(id)
      events = snapshot?.events ?? snapshot ?? []
    } catch {
      continue
    }
    const userTexts = []
    const assistantSamples = []
    for (const event of Array.isArray(events) ? events : []) {
      const type = event?.type
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const message = event?.data?.message ?? event?.data
      const text = blocksToText(message?.content)
      if (!text) continue
      if (type === 'user/message') userTexts.push(text)
      else if (text.length > 80) assistantSamples.push(text)
    }
    out.push({
      sessionId: id,
      title: titles.get(id) ?? '',
      userTexts,
      assistantSamples,
      updatedAt: Number(record?.createdAt) || 0,
    })
  }
  return out
}

function readLiveSession(session) {
  try {
    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const userTexts = []
    const assistantSamples = []
    for (const message of messages) {
      const text = blocksToText(message?.content)
      if (!text) continue
      if (message.role === 'user') userTexts.push(text)
      else if (message.role === 'assistant' && text.length > 80) assistantSamples.push(text)
    }
    const header = session.header ?? {}
    return {
      sessionId: String(session.id ?? header.id ?? ''),
      title: header.title || '',
      userTexts,
      assistantSamples,
      updatedAt: header.createdAt ?? 0,
    }
  } catch {
    return null
  }
}

function blocksToText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/* ------------------------------------------------------------------ *
 * 启发式归纳
 * ------------------------------------------------------------------ */

/**
 * @param {Awaited<ReturnType<typeof collectHistory>>} history
 * @returns {{spec:any, rationale:string[], evidence:object, confidence:number, templateId:string}}
 */
export function heuristicAnalyze(history) {
  const userTexts = []
  for (const session of history?.sessions ?? []) {
    for (const text of session.userTexts ?? []) userTexts.push(text)
  }

  const spec = defaultSpec()
  const rationale = []
  /** @type {Record<string, any>} */
  const evidence = { messages: userTexts.length }

  if (userTexts.length === 0) {
    return {
      spec,
      rationale: ['历史对话为空：先给一份中性默认人格，等你用过几轮再回来重新归纳。'],
      evidence,
      confidence: 0,
      templateId: 'builtin:engineer',
    }
  }

  const lengths = userTexts.map((t) => t.length).sort((a, b) => a - b)
  const median = quantile(lengths, 0.5)
  const p90 = quantile(lengths, 0.9)
  const withList = userTexts.filter((t) => LIST_LINE.test(t)).length
  const withCode = userTexts.filter((t) => CODE_BLOCK.test(t)).length
  const withQuestion = userTexts.filter((t) => /[?？]/.test(t)).length
  const withPoliteness = userTexts.filter((t) => /(请|麻烦|谢谢|辛苦|thanks|please)/i.test(t)).length
  const withEmoji = userTexts.filter((t) => EMOJI.test(t)).length
  const withExclaim = userTexts.filter((t) => /[!！]{1,}/.test(t)).length
  const zhRatio = userTexts.filter((t) => CJK.test(t)).length / userTexts.length
  const imperative = userTexts.filter((t) => /(帮我|给我|实现|修复|改成|写成|直接|不要|必须|帮我做)/.test(t)).length
  const longForm = userTexts.filter((t) => t.length > 400).length

  const pct = (n) => Math.round((n / userTexts.length) * 100)
  Object.assign(evidence, {
    medianLength: Math.round(median),
    p90Length: Math.round(p90),
    listPercent: pct(withList),
    codePercent: pct(withCode),
    questionPercent: pct(withQuestion),
    politePercent: pct(withPoliteness),
    emojiPercent: pct(withEmoji),
    exclaimPercent: pct(withExclaim),
    imperativePercent: pct(imperative),
    zhPercent: Math.round(zhRatio * 100),
  })

  // —— 篇幅倾向：用户自己说得短，通常也想要短回复 ——
  if (median < 40) {
    spec.style.verbosity = 'terse'
    rationale.push(`你的消息中位长度只有 ${Math.round(median)} 字，倾向于极简结论式回复。`)
  } else if (median < 120) {
    spec.style.verbosity = 'concise'
    rationale.push(`你的消息中位长度 ${Math.round(median)} 字，简洁（结论+要点）最匹配。`)
  } else if (p90 > 600 || longForm / userTexts.length > 0.25) {
    spec.style.verbosity = 'detailed'
    rationale.push(`你常写长消息（P90 ${Math.round(p90)} 字），适合详细展开而非压缩。`)
  }

  // —— 结构 ——
  if (pct(withList) > 25) {
    spec.habits.structure = 'bullets'
    rationale.push(`${pct(withList)}% 的消息里你自己用了列表，这类结构对你最好读。`)
  } else if (pct(withCode) > 25) {
    spec.habits.structure = 'code-first'
    rationale.push(`${pct(withCode)}% 的消息带代码块，代码优先、解释在后更省时间。`)
  }

  // —— 交付形态 ——
  if (pct(withCode) > 30) {
    spec.habits.artifact = 'files'
  }

  // —— 直接程度：祈使句多 = 想要马上执行 ——
  if (pct(imperative) > 25) {
    spec.style.directness = 90
    spec.feedback.progressReporting = 'silent'
    spec.habits.planning = 'none'
    rationale.push(`${pct(imperative)}% 的消息是祈使指令，说明你想要"直接做完"而不是先讨论方案。`)
  } else if (pct(withQuestion) > 60) {
    spec.style.directness = 55
    spec.feedback.questionPolicy = 'batched'
    rationale.push(`${pct(withQuestion)}% 的消息是提问，回答应先把问题答完再补充。`)
  }

  // —— 礼貌与温度 ——
  if (pct(withPoliteness) > 35) {
    spec.style.warmth = 60
    spec.style.formality = 60
    rationale.push(`${pct(withPoliteness)}% 的消息带礼貌用语，回复保持温和与客气会更有配合感。`)
  } else {
    spec.style.warmth = 30
  }

  // —— emoji / 语气 ——
  if (pct(withEmoji) > 20) {
    spec.style.emoji = 'moderate'
    spec.style.tone = 'casual'
    spec.style.humor = 45
    rationale.push(`${pct(withEmoji)}% 的消息带 emoji，轻松一点的语气不会显得违和。`)
  } else {
    spec.style.emoji = 'never'
  }

  if (pct(withExclaim) > 25) {
    spec.style.tone = 'blunt'
    spec.style.directness = clamp(spec.style.directness + 10, 0, 100)
    spec.feedback.errorHandling = 'silent-fix'
    spec.feedback.praise = 10
    rationale.push(`${pct(withExclaim)}% 的消息带感叹号/强烈语气，说明你更在意效率而不是客套。`)
  }

  // —— 语言 ——
  if (zhRatio > 0.8) {
    spec.style.language = 'auto'
  } else if (zhRatio < 0.2) {
    spec.style.language = 'en'
    rationale.push('历史消息以英文为主，默认用英文回复。')
  }

  // —— 验证习惯：技术类长消息往往伴随"跑通/报错"语境 ——
  const mentionsError = userTexts.filter((t) => /(报错|错误|失败|error|exception|stack|日志|traceback)/i.test(t)).length
  if (mentionsError / userTexts.length > 0.2) {
    spec.habits.verification = 'commands'
    spec.feedback.critique = 'severity-tagged'
    spec.feedback.uncertainty = 'assume-and-flag'
    rationale.push(`${pct(mentionsError)}% 的消息涉及报错/日志，明确要求"跑命令验证 + 按严重度列问题"能减少往返。`)
  }

  // —— 创作习惯：长消息里出现规划词 ——
  const mentionsPlan = userTexts.filter((t) => /(计划|方案|设计|架构|先.*再|步骤|plan)/i.test(t)).length
  if (mentionsPlan / userTexts.length > 0.2) {
    spec.habits.planning = 'plan-mode'
    spec.habits.exploration = 70
    rationale.push(`${pct(mentionsPlan)}% 的消息在谈方案/规划，先出方案再动手更符合你的节奏。`)
  }

  // —— 名字 ——
  spec.identity.name = '归纳人格'
  spec.identity.title = '由历史对话自动归纳'
  spec.identity.oneLiner = rationale[0] ? rationale[0].replace(/。$/, '') : '按你的历史习惯定制'

  // —— 归纳出的"潜在需求"直接写进自定义条目 ——
  if (pct(imperative) > 25) {
    spec.feedback.customRules.push('默认直接执行，只有涉及破坏性操作时才停下来确认')
    spec.habits.customHabits.push('不要输出"我建议你..."这类铺垫，直接给结果')
  }
  if (pct(mentionsError) > 20) {
    spec.feedback.customRules.push('报告失败时附上原始命令与关键输出片段')
  }
  if (median < 40) {
    spec.style.punct = '短句为主，尽量控制在三行以内，除非用户要求展开'
  }

  const matched = matchTemplate(spec)
  const confidence = Math.round(clamp(Math.min(90, 25 + userTexts.length * 1.4), 20, 90))

  return { spec: normalizeSpec(spec), rationale, evidence, confidence, templateId: matched }
}

/** 找一个与归纳结果最接近的内置模板（作为"倾向"锚点）。 */
export function matchTemplate(spec) {
  let best = BUILTIN_TEMPLATES[0].id
  let bestScore = -Infinity
  for (const template of BUILTIN_TEMPLATES) {
    let score = 0
    const a = spec
    const b = template.spec
    if (a.style.verbosity === b.style.verbosity) score += 3
    if (a.style.tone === b.style.tone) score += 2
    if (a.habits.structure === b.habits.structure) score += 2
    if (a.habits.planning === b.habits.planning) score += 2
    if (a.feedback.critique === b.feedback.critique) score += 2
    if (a.habits.artifact === b.habits.artifact) score += 1
    if (a.style.emoji === b.style.emoji) score += 1
    score -= Math.abs(a.style.directness - b.style.directness) / 40
    if (score > bestScore) {
      bestScore = score
      best = template.id
    }
  }
  return best
}

/* ------------------------------------------------------------------ *
 * LLM 深读（可选）
 * ------------------------------------------------------------------ */

const LLM_SYSTEM = [
  '你是一名人格分析师。任务：阅读用户过去发出的消息样本，归纳出他真正想要 AI 用什么方式与他协作，',
  '并输出一份可执行的人格设定。',
  '',
  '判断要点：',
  '1) 他关心的是速度还是严谨？是执行还是讨论？',
  '2) 他讨厌什么（客套、废话、过度解释、擅自改需求）？',
  '3) 他没说出来但反复出现的需求（例如每次都要求"先跑通再说"）。',
  '',
  '只输出一个 JSON 对象，不要输出 Markdown 代码围栏或任何解释文字，字段如下：',
  '{',
  '  "name": "人格名（4-10字中文）",',
  '  "title": "角色头衔",',
  '  "oneLiner": "一句话定位（20字内）",',
  '  "rationale": ["判断依据，每条一句话，引用具体观察"],',
  '  "needs": ["用户未明说的潜在需求，每条一句话"],',
  '  "spec": {',
  '    "style": {"tone":"neutral|warm|formal|casual|witty|blunt|gentle","verbosity":"terse|concise|balanced|detailed|exhaustive","warmth":0-100,"formality":0-100,"directness":0-100,"humor":0-100,"emoji":"never|sparing|moderate|lively","metaphor":"never|when-explaining|often|always","language":"auto|zh-CN|zh-TW|en|bilingual","punct":"简短描述","signaturePhrases":["口头禅"],"avoidPhrases":["要避免的表达"]},',
  '    "habits": {"planning":"none|inline|todo-list|plan-mode","structure":"prose|bullets|sections|numbered-steps|code-first","exploration":0-100,"verification":"self-only|tests|commands|screenshots|full-evidence","commentStyle":"none|sparse|explanatory|verbose","artifact":"chat-only|code-inline|files|files-plus-doc","initiative":0-100,"riskAppetite":"conservative|measured|bold","customHabits":["习惯"]},',
  '    "feedback": {"uncertainty":"ask-first|assume-and-flag|best-effort|do-nothing","critique":"sandwich|direct|socratic|options-list|severity-tagged","suggestionDepth":0-100,"praise":0-100,"questionPolicy":"never|one-at-a-time|batched|aggressive","progressReporting":"silent|milestones|step-by-step","errorHandling":"brief-apology|root-cause|silent-fix","customRules":["规则"]}',
  '  }',
  '}',
  '未观察到的字段可以省略；不要编造用户没有表现出的偏好。',
].join('\n')

function buildTranscript(sessions, perSessionChars = 2600, maxChars = 12000) {
  const parts = []
  let used = 0
  for (const session of sessions) {
    const chunk = []
    chunk.push(`### 会话：${session.title || session.sessionId || '未命名'}`)
    for (const text of session.userTexts) {
      const trimmed = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
      chunk.push(`- ${trimmed.replace(/\n+/g, ' / ')}`)
      const size = trimmed.length
      if (chunk.join('\n').length > perSessionChars) break
      used += size
      if (used > maxChars) break
    }
    parts.push(chunk.join('\n'))
    if (used > maxChars) break
  }
  return parts.join('\n\n')
}

function extractJson(text) {
  if (!text) return null
  let cleaned = text.trim()
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) cleaned = fence[1].trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 用当前会话的模型深读历史。
 * @param {object} deps { llm }
 * @param {{provider:string, model:string}} route
 * @param {Awaited<ReturnType<typeof collectHistory>>} history
 * @param {{signal?:AbortSignal, maxTokens?:number}} [options]
 */
export async function llmAnalyze(deps, route, history, options = {}) {
  const llm = deps?.llm
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('llm 服务不可用')
  }
  if (!route?.provider || !route?.model) {
    // 正常情况下走不到这里：宿主会先退回「默认模型」服务。
    // 真的什么都没有时，说明宿主没有配置任何模型 —— 那是配置问题，不是本功能的问题。
    throw new Error('拿不到可用的模型（本会话路由未捕获，宿主的默认模型也没有配置）')
  }
  const transcript = buildTranscript(history?.sessions ?? [])
  if (!transcript.trim()) throw new Error('没有可分析的对话样本')

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `以下是用户过去的消息样本，请归纳他期望的 AI 人格：\n\n${transcript}`,
        },
      ],
    },
  ]

  let text = ''
  // 诊断信息：出错时要把"到底为什么没拿到内容"如实报出来。
  // 踩过的坑：只认 kind === 'error'，其他结束原因被静默放过，
  // 用户最后只看到一句"JSON 解析失败："（冒号后面是空的），完全不知道原因。
  let textDeltas = 0
  let finishReason = null
  let usage = null
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system: LLM_SYSTEM,
    messages,
    temperature: 0.4,
    maxTokens: options.maxTokens ?? 1800,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      textDeltas += 1
      if (typeof chunk.text === 'string') text += chunk.text
    }
    if (chunk.type === 'usage') usage = chunk
    if (chunk.type === 'finish') {
      finishReason = chunk.reason ?? null
      // 任何"非正常结束"都要报出来，而不是只认 error。
      // 例如 aborted（被取消）、max-tokens（输出被截断）。
      const kind = finishReason?.kind
      if (kind && kind !== 'stop' && kind !== 'tool-calls') {
        const failure = finishReason.failure ?? {}
        const parts = [`模型调用未正常结束（结束原因：${kind}`]
        if (failure.code) parts.push(`，错误码：${failure.code}`)
        parts.push('）')
        if (failure.message) parts.push(`：${failure.message}`)
        const error = new Error(parts.join(''))
        error.code = failure.code ?? kind
        throw error
      }
    }
  }

  // 走到这里说明流正常收尾。如果一点文本都没有，把全部诊断信息给出来 ——
  // DSH 对这种情况有专门错误码 EMPTY_RESPONSE（正常结束但零输出）。
  if (!text.trim()) {
    const detail = [
      `模型没有返回任何内容（收到 ${textDeltas} 个文本分片）`,
      `结束原因：${finishReason ? JSON.stringify(finishReason) : '未收到 finish'}`,
      usage && usage.usage ? `用量：${JSON.stringify(usage.usage)}` : null,
      '常见原因：上下文被占满、输出被截断、或账户额度受限。',
    ]
      .filter(Boolean)
      .join('；')
    const error = new Error(detail)
    error.code = 'EMPTY_RESPONSE'
    throw error
  }

  const parsed = extractJson(text)
  if (!parsed) {
    throw new Error(
      `模型返回的内容不是合法 JSON（收到 ${text.length} 字符，${textDeltas} 个文本分片）：${text.slice(0, 200)}`,
    )
  }

  const spec = defaultSpec()
  Object.assign(spec.identity, {
    name: parsed.name || '深读人格',
    title: parsed.title || '',
    oneLiner: parsed.oneLiner || '',
  })
  Object.assign(spec.style, parsed.spec?.style ?? {})
  Object.assign(spec.habits, parsed.spec?.habits ?? {})
  Object.assign(spec.feedback, parsed.spec?.feedback ?? {})
  if (Array.isArray(parsed.needs) && parsed.needs.length) {
    spec.feedback.customRules.push(...parsed.needs.map((n) => `潜在需求：${n}`))
  }
  const normalized = normalizeSpec(spec)
  return {
    spec: normalized,
    rationale: Array.isArray(parsed.rationale) ? parsed.rationale.map(String) : [],
    needs: Array.isArray(parsed.needs) ? parsed.needs.map(String) : [],
    evidence: { raw: text.slice(0, 4000), model: `${route.provider}/${route.model}` },
    confidence: 75,
    templateId: matchTemplate(normalized),
    source: 'llm',
  }
}

export { DEFAULT_SPEC }
