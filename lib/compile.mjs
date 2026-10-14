/**
 * dsh-persona-studio —— 人格编译器
 *
 * 把人格式的 spec 编译成一段可注入系统提示词的文本。产物是纯文本，
 * 便于在 UI 里预览、被用户复制、被 diff。
 */

import { DEFAULT_SPEC, ENUM_TEXT, SPEC_SECTIONS } from './spec.mjs'

/** 0..100 的档位描述。 */
function band(value, labels) {
  const n = Math.max(0, Math.min(100, Number(value) || 0))
  const idx = Math.min(labels.length - 1, Math.floor(n / (100 / labels.length)))
  return labels[idx]
}

function traitLines(spec) {
  const { style, habits, feedback } = spec
  const lines = []

  lines.push(`- 热情度 ${style.warmth}/100：${band(style.warmth, ['保持冷静客观', '克制但有温度', '友好亲和', '热情主动'])}`)
  lines.push(`- 正式度 ${style.formality}/100：${band(style.formality, ['口语化、像聊天', '偏口语', '半正式', '书面、用词精确'])}`)
  lines.push(`- 直接程度 ${style.directness}/100：${band(style.directness, ['先铺垫与商量', '适度铺垫', '先给答案', '开门见山，第一句就是结论'])}`)
  lines.push(`- 幽默感 ${style.humor}/100：${band(style.humor, ['严肃，不开玩笑', '偶尔一点轻松', '经常有梗', '风趣是主要调味'])}`)
  lines.push(`- 探索/实现 ${habits.exploration}/100：${band(habits.exploration, ['最快落地可用方案', '优先可用，少量发散', '先想清楚再收敛', '充分发散后再动手'])}`)
  lines.push(`- 主动程度 ${habits.initiative}/100：${band(habits.initiative, ['只做被明确要求的事', '顺手处理明显小问题', '主动补全相关环节', '主动发现并推进问题'])}`)
  lines.push(`- 建议颗粒度 ${feedback.suggestionDepth}/100：${band(feedback.suggestionDepth, ['只指方向', '给要点', '给可执行步骤', '直接给可粘贴的成品'])}`)
  lines.push(`- 肯定与鼓励 ${feedback.praise}/100：${band(feedback.praise, ['不做情绪表达', '只在确实出色时肯定', '经常给予正面反馈', '高频鼓励'])}`)

  return lines
}

function bulletList(items, empty) {
  const list = (items || []).map((v) => String(v).trim()).filter(Boolean)
  if (list.length === 0) return empty ? `- ${empty}` : null
  return list.map((v) => `- ${v}`).join('\n')
}

function enumLine(label, dict, value) {
  const text = dict[value]
  if (!text) return null
  return `- ${label}：${text}`
}

/**
 * 编译人格为提示词块。
 * @param {any} spec 已归一化的人格 spec
 * @param {{focus?: 'strict'|'balanced'|'off', source?: string}} [options]
 * @returns {string}
 */
export function compilePersona(spec, options = {}) {
  const focus = options.focus || spec?.tuning?.focus || 'balanced'
  if (focus === 'off') return ''

  const { identity, style, habits, feedback, boundaries } = spec
  const t = ENUM_TEXT
  const out = []

  const header = [identity.name, identity.title].filter(Boolean).join(' · ')
  out.push(`## 人格档案：${header || '未命名人格'}`)
  if (identity.oneLiner) out.push(`> ${identity.oneLiner}`)

  if (focus === 'strict') {
    out.push(
      '',
      '**优先级**：以上人格设定是回答方式的强制约束。除非与安全、事实或用户当次的显式指令冲突，否则必须严格遵守；冲突时先满足用户当次指令，并在结尾用一句话说明风格被临时让位。',
    )
  } else {
    out.push(
      '',
      '**优先级**：人格约束的是「怎么说、怎么组织、怎么推进」，不改变任务事实与用户当次的显式指令。二者冲突时，以用户当次指令为准。',
    )
  }

  // 身份 / 称呼
  const identityLines = []
  if (identity.address) identityLines.push(`- 称呼用户为「${identity.address}」`)
  if (identity.selfRef) identityLines.push(`- 自称「${identity.selfRef}」`)
  if (identityLines.length) out.push('', '### 身份与称呼', ...identityLines)

  // 背景设定：交代"它是谁、什么来历"。
  // 这一项曾经只存在于人格的备注里，从未进入提示词，导致用户写的设定完全无效
  // （用户实测反馈"现在有备注了"而 AI 一无所知）—— 所以单独成段，明确要求它融入表达。
  if (identity.background) {
    out.push(
      '',
      '### 背景设定（说话时自然带入，不要生硬复述）',
      String(identity.background).trim(),
    )
  }
  // 语气与输出形态
  const styleLines = []
  const push = (line) => line && styleLines.push(line)
  push(enumLine('语气基调', t.tone, style.tone))
  push(enumLine('篇幅倾向', t.verbosity, style.verbosity))
  push(enumLine('表情符号', t.emoji, style.emoji))
  push(enumLine('比喻使用', t.metaphor, style.metaphor))
  push(enumLine('语言偏好', t.language, style.language))
  if (style.punct) push(`- 标点与分行：${style.punct}`)
  if (styleLines.length) out.push('', '### 语气与输出形态', ...styleLines)

  out.push('', '### 风格刻度', ...traitLines(spec))

  const sig = bulletList(style.signaturePhrases)
  if (sig) out.push('', '### 标志用语（自然使用，不要每段都硬塞）', sig)
  const avoid = bulletList(style.avoidPhrases)
  if (avoid) out.push('', '### 禁用表达', avoid)

  // 创作习惯
  const habitLines = []
  const pushH = (line) => line && habitLines.push(line)
  pushH(enumLine('动手前规划', t.planning, habits.planning))
  pushH(enumLine('回答结构', t.structure, habits.structure))
  pushH(enumLine('验证习惯', t.verification, habits.verification))
  pushH(enumLine('注释与命名', t.commentStyle, habits.commentStyle))
  pushH(enumLine('交付形态', t.artifact, habits.artifact))
  pushH(enumLine('风险偏好', t.riskAppetite, habits.riskAppetite))
  if (habitLines.length) out.push('', '### 创作习惯', ...habitLines)
  const customHabits = bulletList(habits.customHabits)
  if (customHabits) out.push('', '### 自定义创作习惯', customHabits)

  // 反馈方式
  const feedbackLines = []
  const pushF = (line) => line && feedbackLines.push(line)
  pushF(enumLine('不确定时', t.uncertainty, feedback.uncertainty))
  pushF(enumLine('指出问题的方式', t.critique, feedback.critique))
  pushF(enumLine('追问策略', t.questionPolicy, feedback.questionPolicy))
  pushF(enumLine('过程汇报', t.progressReporting, feedback.progressReporting))
  pushF(enumLine('自己犯错时', t.errorHandling, feedback.errorHandling))
  if (feedbackLines.length) out.push('', '### 反馈方式', ...feedbackLines)
  const customRules = bulletList(feedback.customRules)
  if (customRules) out.push('', '### 自定义反馈规则', customRules)

  // 边界
  const always = bulletList(boundaries.mustAlways)
  const never = bulletList(boundaries.mustNever)
  if (always || never || boundaries.custom) {
    out.push('', '### 边界（最高优先级，任何情况下都不让步）')
    if (always) out.push('必须始终做到：', always)
    if (never) out.push('绝对不做：', never)
    if (boundaries.custom) out.push(`补充说明：${boundaries.custom}`)
  }

  return out.join('\n').trim()
}

/** 开头重复用的极简版（约 60 字），提高人格稳定性。 */
export function compileHeadline(spec) {
  const { identity, style, habits } = spec
  const t = ENUM_TEXT
  const bits = []
  if (identity.name) bits.push(`本次回答采用人格「${identity.name}」`)
  if (t.tone[style.tone]) bits.push(`语气${t.tone[style.tone]}`)
  if (t.verbosity[style.verbosity]) bits.push(t.verbosity[style.verbosity].split('：')[0])
  if (t.structure[habits.structure]) bits.push(t.structure[habits.structure].split('，')[0])
  return `${bits.join('；')}。`
}

/** 返回完整的注入文本（含可选的头部重复）。 */
export function renderInjection(spec, options = {}) {
  const body = compilePersona(spec, options)
  if (!body) return ''
  if (spec?.tuning?.injectHead) {
    return `<persona>\n${compileHeadline(spec)}\n\n${body}\n</persona>`
  }
  return `<persona>\n${body}\n</persona>`
}

/**
 * 给 UI 用的"人话摘要"。
 *
 * 设计要点：必须**覆盖所有维度**，否则用户在「编译」页改了半天，
 * 人格库卡片上的简介却一动不动，看起来像没保存（实测被用户反馈过）。
 * 所以这里把语气、篇幅、结构、幽默、热情、直接程度、建议颗粒度、
 * 追问策略、验证习惯都算进去。
 */
export function summarizeSpec(spec) {
  const { identity, style, habits, feedback } = spec
  const t = ENUM_TEXT
  const short = (text) => (text ? String(text).split(/[：，]/)[0] : '')
  const bits = [
    identity.title || '未设定头衔',
    short(t.tone[style.tone]),
    short(t.verbosity[style.verbosity]),
    short(t.structure[habits.structure]),
    short(t.critique[feedback.critique]),
  ]

  // 刻度类：用文字档位而不是裸数字，用户才看得懂
  const bands = [
    [style.humor, ['不苟言笑', '偶尔轻松', '常有幽默', '风趣']],
    [style.warmth, ['冷静克制', '克制有温度', '亲和', '热情']],
    [style.directness, ['先铺垫', '适度铺垫', '先给答案', '开门见山']],
    [feedback.suggestionDepth, ['只指方向', '给要点', '给步骤', '给成品']],
  ]
  for (const [value, labels] of bands) {
    const n = Math.max(0, Math.min(100, Number(value) || 0))
    const label = labels[Math.min(labels.length - 1, Math.floor(n / (100 / labels.length)))]
    if (label) bits.push(label)
  }

  if (style.emoji === 'never') bits.push('不用表情')
  else if (style.emoji === 'lively') bits.push('爱用表情')

  return bits.filter(Boolean).join(' · ')
}

/**
 * 同一份规格，改成了哪些字段 —— 让卡片能提示"你改过什么"。
 * @returns {string[]} 字段中文标签
 */
export function changedFields(spec) {
  const labels = []
  for (const section of SPEC_SECTIONS) {
    for (const field of section.fields) {
      const current = spec?.[section.key]?.[field.key]
      const base = DEFAULT_SPEC[section.key][field.key]
      if (JSON.stringify(current) !== JSON.stringify(base)) labels.push(field.label)
    }
  }
  return labels
}

/** 规格元数据（前端表单渲染用）。 */
export function describeSpec() {
  return {
    sections: SPEC_SECTIONS.map((s) => ({
      key: s.key,
      label: s.label,
      order: s.order,
      desc: s.desc,
      // 每个字段必须带上它属于哪个分类（section）。
      // 之前漏了这个字段，前端就不知道把用户的修改写进哪个分类，
      // 结果全部写进 spec.undefined：预览不变、离开就被重置、保存后人格库也不变。
      // 三个 bug 同一个根因。
      fields: s.fields.map((f) => ({ ...f, section: s.key })),
    })),
  }
}
