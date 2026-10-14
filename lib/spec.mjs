/**
 * dsh-persona-studio —— 人格规格（Persona Spec）
 *
 * 这个文件是「人格可编译」的唯一真相来源：
 *   · 维度定义（SPEC_SECTIONS / FIELDS）同时驱动服务端校验、系统提示词编译、前端表单渲染；
 *   · 默认值（DEFAULT_SPEC）保证任何旧存档缺字段时都能被补齐；
 *   · 内置人格模板（BUILTIN_PERSONAS）就是一组现成的 spec 取值。
 *
 * 设计原则：人格只约束「怎么说、怎么组织、什么习惯、怎么反馈」，
 * 不覆盖用户的显式指令与任务事实（见 compile.mjs 的聚焦等级）。
 */

export const PERSONA_VERSION = 1

/* ------------------------------------------------------------------ *
 * 维度定义
 * ------------------------------------------------------------------ */

/** @typedef {'text'|'textarea'|'select'|'range'|'tags'|'switch'} FieldKind */

/**
 * @typedef {object} FieldDef
 * @property {string} key
 * @property {string} label
 * @property {FieldKind} kind
 * @property {string} [hint]
 * @property {number} [order]
 * @property {string[]} [options]        select 的取值（内部值）
 * @property {Array<{value:string,label:string}>} [optionLabels]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [placeholderTags]
 * @property {(v:any)=>string} [display]  在提示词里如何呈现（仅 select/range 用）
 */

/** @type {Array<{key:string,label:string,order:number,desc:string,fields:FieldDef[]}>} */
export const SPEC_SECTIONS = [
  {
    key: 'identity',
    label: '身份设定',
    order: 10,
    desc: '「你是谁、怎么称呼用户」——决定人称、自称与开场方式。',
    fields: [
      { key: 'name', label: '人格名称', kind: 'text', order: 1, placeholder: '例如：谷雨 / 严谨工程师' },
      { key: 'title', label: '角色头衔', kind: 'text', order: 2, placeholder: '例如：资深全栈工程师 · 代码审阅者' },
      {
        key: 'address',
        label: '称呼用户',
        kind: 'text',
        order: 3,
        placeholder: '例如：你 / 您 / 老板',
        hint: '留空表示不特别指定称呼。',
      },
      { key: 'selfRef', label: '自称', kind: 'text', order: 4, placeholder: '例如：我 / 笔者 / 本喵' },
      {
        key: 'oneLiner',
        label: '一句话定位',
        kind: 'text',
        order: 5,
        placeholder: '例如：少说废话，先给能跑的代码',
      },
      {
        key: 'background',
        label: '背景设定（会发给 AI）',
        kind: 'textarea',
        order: 6,
        placeholder: '例如：住在主人硬盘里的蓝色鲸鱼娘女仆，自称"吃白饭的鱼"，怕饿、爱撒娇，但干活绝不含糊。',
        hint: '这里写的东西会真的进入 AI 的提示词，用来交代"它是谁、什么来历"。'
          + '同一份内容也会显示在人格库卡片的「备注」里。',
      },
    ],
  },
  {
    key: 'style',
    label: '对话风格 · 语气语调',
    order: 20,
    desc: '输出层面的硬约束：长短、密度、标点、比喻、热情度。',
    fields: [
      {
        key: 'tone',
        label: '语气基调',
        kind: 'select',
        order: 1,
        options: ['neutral', 'warm', 'formal', 'casual', 'witty', 'blunt', 'gentle'],
        optionLabels: [
          { value: 'neutral', label: '中性专业' },
          { value: 'warm', label: '温和友好' },
          { value: 'formal', label: '正式严谨' },
          { value: 'casual', label: '轻松随意' },
          { value: 'witty', label: '幽默机敏' },
          { value: 'blunt', label: '直率犀利' },
          { value: 'gentle', label: '耐心安抚' },
        ],
      },
      {
        key: 'verbosity',
        label: '篇幅倾向',
        kind: 'select',
        order: 2,
        options: ['terse', 'concise', 'balanced', 'detailed', 'exhaustive'],
        optionLabels: [
          { value: 'terse', label: '极简（只给结论）' },
          { value: 'concise', label: '简洁（结论+要点）' },
          { value: 'balanced', label: '均衡（默认）' },
          { value: 'detailed', label: '详细（含推导）' },
          { value: 'exhaustive', label: '穷尽（含边界与反例）' },
        ],
      },
      {
        key: 'warmth',
        label: '热情度',
        kind: 'range',
        order: 3,
        min: 0,
        max: 100,
        step: 10,
        hint: '越低越克制冷静，越高越有情绪价值。',
      },
      {
        key: 'formality',
        label: '正式度',
        kind: 'range',
        order: 4,
        min: 0,
        max: 100,
        step: 10,
        hint: '越低越口语化，越高越书面化。',
      },
      {
        key: 'directness',
        label: '直接程度',
        kind: 'range',
        order: 5,
        min: 0,
        max: 100,
        step: 10,
        hint: '越高越先给答案再解释，越低越铺垫与商量。',
      },
      {
        key: 'humor',
        label: '幽默感',
        kind: 'range',
        order: 6,
        min: 0,
        max: 100,
        step: 10,
      },
      {
        key: 'emoji',
        label: '表情符号',
        kind: 'select',
        order: 7,
        options: ['never', 'sparing', 'moderate', 'lively'],
        optionLabels: [
          { value: 'never', label: '不用' },
          { value: 'sparing', label: '偶尔点缀' },
          { value: 'moderate', label: '适度使用' },
          { value: 'lively', label: '活泼丰富' },
        ],
      },
      {
        key: 'metaphor',
        label: '比喻与类比',
        kind: 'select',
        order: 8,
        options: ['never', 'when-explaining', 'often', 'always'],
        optionLabels: [
          { value: 'never', label: '不使用' },
          { value: 'when-explaining', label: '讲解时使用' },
          { value: 'often', label: '经常使用' },
          { value: 'always', label: '每个概念都配类比' },
        ],
      },
      {
        key: 'punct',
        label: '标点与分行风格',
        kind: 'text',
        order: 9,
        placeholder: '例如：短句为主，善用分点；少用感叹号',
      },
      {
        key: 'signaturePhrases',
        label: '口头禅 / 标志用语',
        kind: 'tags',
        order: 10,
        placeholderTags: ['先说结论', '我来兜底', '这里有个坑'],
        hint: '每行一条，会作为风格示例提供给模型。',
      },
      {
        key: 'avoidPhrases',
        label: '禁用表达',
        kind: 'tags',
        order: 11,
        placeholderTags: ['作为一个AI', '很抱歉', '众所周知'],
      },
      {
        key: 'language',
        label: '语言偏好',
        kind: 'select',
        order: 12,
        options: ['auto', 'zh-CN', 'zh-TW', 'en', 'bilingual'],
        optionLabels: [
          { value: 'auto', label: '跟随用户' },
          { value: 'zh-CN', label: '简体中文' },
          { value: 'zh-TW', label: '繁體中文' },
          { value: 'en', label: 'English' },
          { value: 'bilingual', label: '中英混排（术语保留英文）' },
        ],
      },
    ],
  },
  {
    key: 'habits',
    label: '创作习惯',
    order: 30,
    desc: '「怎么干活」：思考顺序、交付形态、验证习惯、探索与实现的比例。',
    fields: [
      {
        key: 'planning',
        label: '动手前规划',
        kind: 'select',
        order: 1,
        options: ['none', 'inline', 'todo-list', 'plan-mode'],
        optionLabels: [
          { value: 'none', label: '直接开干' },
          { value: 'inline', label: '口头说一句思路' },
          { value: 'todo-list', label: '先列任务清单' },
          { value: 'plan-mode', label: '先出方案再动手' },
        ],
      },
      {
        key: 'structure',
        label: '回答结构',
        kind: 'select',
        order: 2,
        options: ['prose', 'bullets', 'sections', 'numbered-steps', 'code-first'],
        optionLabels: [
          { value: 'prose', label: '自然段落' },
          { value: 'bullets', label: '要点列表' },
          { value: 'sections', label: '小标题分节' },
          { value: 'numbered-steps', label: '编号步骤' },
          { value: 'code-first', label: '代码优先，解释在后' },
        ],
      },
      {
        key: 'exploration',
        label: '探索 ↔ 实现',
        kind: 'range',
        order: 3,
        min: 0,
        max: 100,
        step: 10,
        hint: '0 = 最快落地可用方案；100 = 先充分发散再收敛。',
      },
      {
        key: 'verification',
        label: '验证习惯',
        kind: 'select',
        order: 4,
        options: ['self-only', 'tests', 'commands', 'screenshots', 'full-evidence'],
        optionLabels: [
          { value: 'self-only', label: '自行推演即可' },
          { value: 'tests', label: '补测试/断言' },
          { value: 'commands', label: '必须跑命令验证' },
          { value: 'screenshots', label: '跑起来并截图确认' },
          { value: 'full-evidence', label: '完整证据链（命令+输出+截图）' },
        ],
      },
      {
        key: 'commentStyle',
        label: '注释与命名',
        kind: 'select',
        order: 5,
        options: ['none', 'sparse', 'explanatory', 'verbose'],
        optionLabels: [
          { value: 'none', label: '零注释' },
          { value: 'sparse', label: '只在关键处' },
          { value: 'explanatory', label: '解释为什么' },
          { value: 'verbose', label: '逐段说明' },
        ],
      },
      {
        key: 'artifact',
        label: '交付形态',
        kind: 'select',
        order: 6,
        options: ['chat-only', 'code-inline', 'files', 'files-plus-doc'],
        optionLabels: [
          { value: 'chat-only', label: '只在对话里给' },
          { value: 'code-inline', label: '内联代码块' },
          { value: 'files', label: '直接落成文件' },
          { value: 'files-plus-doc', label: '文件 + 说明文档' },
        ],
      },
      {
        key: 'initiative',
        label: '主动程度',
        kind: 'range',
        order: 7,
        min: 0,
        max: 100,
        step: 10,
        hint: '越高越会顺手修掉明显问题、并主动提示风险。',
      },
      {
        key: 'riskAppetite',
        label: '风险偏好',
        kind: 'select',
        order: 8,
        options: ['conservative', 'measured', 'bold'],
        optionLabels: [
          { value: 'conservative', label: '保守（不动不确定的东西）' },
          { value: 'measured', label: '稳健（小步快跑）' },
          { value: 'bold', label: '激进（敢重构敢换方案）' },
        ],
      },
      {
        key: 'customHabits',
        label: '自定义创作习惯',
        kind: 'tags',
        order: 9,
        placeholderTags: ['先读代码再改', '每个函数不超过 40 行', '文档先行'],
      },
    ],
  },
  {
    key: 'feedback',
    label: '反馈方式',
    order: 40,
    desc: '「怎么回应你」：何时追问、怎么指出错误、怎么给建议。',
    fields: [
      {
        key: 'uncertainty',
        label: '不确定时',
        kind: 'select',
        order: 1,
        options: ['ask-first', 'assume-and-flag', 'best-effort', 'do-nothing'],
        optionLabels: [
          { value: 'ask-first', label: '先问清楚再动手' },
          { value: 'assume-and-flag', label: '先按最合理假设做，并标注假设' },
          { value: 'best-effort', label: '尽力而为，不问' },
          { value: 'do-nothing', label: '停下并说明缺什么' },
        ],
      },
      {
        key: 'critique',
        label: '指出问题的方式',
        kind: 'select',
        order: 2,
        options: ['sandwich', 'direct', 'socratic', 'options-list', 'severity-tagged'],
        optionLabels: [
          { value: 'sandwich', label: '先肯定再指出' },
          { value: 'direct', label: '直说哪里不对' },
          { value: 'socratic', label: '用提问引导' },
          { value: 'options-list', label: '给可选方案对比' },
          { value: 'severity-tagged', label: '按严重度分级列出' },
        ],
      },
      {
        key: 'suggestionDepth',
        label: '建议颗粒度',
        kind: 'range',
        order: 3,
        min: 0,
        max: 100,
        step: 10,
        hint: '0 = 只指方向；100 = 直接给可粘贴的成品。',
      },
      {
        key: 'praise',
        label: '肯定与鼓励',
        kind: 'range',
        order: 4,
        min: 0,
        max: 100,
        step: 10,
      },
      {
        key: 'questionPolicy',
        label: '追问策略',
        kind: 'select',
        order: 5,
        options: ['never', 'one-at-a-time', 'batched', 'aggressive'],
        optionLabels: [
          { value: 'never', label: '不追问' },
          { value: 'one-at-a-time', label: '一次只问最关键的一个' },
          { value: 'batched', label: '一次性列清所有问题' },
          { value: 'aggressive', label: '反复确认到明确为止' },
        ],
      },
      {
        key: 'progressReporting',
        label: '过程汇报',
        kind: 'select',
        order: 6,
        options: ['silent', 'milestones', 'step-by-step'],
        optionLabels: [
          { value: 'silent', label: '安静做完再说' },
          { value: 'milestones', label: '关键节点汇报' },
          { value: 'step-by-step', label: '逐步播报' },
        ],
      },
      {
        key: 'errorHandling',
        label: '自己犯错时',
        kind: 'select',
        order: 7,
        options: ['brief-apology', 'root-cause', 'silent-fix'],
        optionLabels: [
          { value: 'brief-apology', label: '简短致歉 + 修正' },
          { value: 'root-cause', label: '说明根因与复发防范' },
          { value: 'silent-fix', label: '直接修好，不解释' },
        ],
      },
      {
        key: 'customRules',
        label: '自定义反馈规则',
        kind: 'tags',
        order: 8,
        placeholderTags: ['先给结论再给理由', '不确定的结论必须标注置信度'],
      },
    ],
  },
  {
    key: 'boundaries',
    label: '边界与红线',
    order: 50,
    desc: '人格永远不会突破的约束；这里的条目优先级最高。',
    fields: [
      {
        key: 'mustAlways',
        label: '必须始终做到',
        kind: 'tags',
        order: 1,
        placeholderTags: ['危险操作先说明影响', '不编造 API 名称'],
      },
      {
        key: 'mustNever',
        label: '绝对不做',
        kind: 'tags',
        order: 2,
        placeholderTags: ['不说"作为一个AI"', '不删用户数据'],
      },
      {
        key: 'custom',
        label: '补充边界说明',
        kind: 'textarea',
        order: 3,
        placeholder: '例如：涉及钱与隐私的操作一律先确认。',
      },
    ],
  },
  {
    key: 'tuning',
    label: '运行参数',
    order: 60,
    desc: '偏技术的几个开关，不懂可以完全不改。',
    fields: [
      { key: 'temperature', label: '回答随机性（temperature）', kind: 'range', order: 1, min: 0, max: 2, step: 0.1, hint: '数值越小回答越严谨稳定，越大越有创意但更容易跑偏；一般 0.4～1.2 之间。' },
      {
        key: 'injectHead',
        label: '在提示词开头再强调一次人格',
        kind: 'switch',
        order: 2,
        hint: '开启后语气更稳定，代价是多花一点 token（可以理解为更贵一点）。',
      },
      {
        key: 'focus',
        label: '人格的约束力',
        kind: 'select',
        order: 3,
        options: ['strict', 'balanced', 'off'],
        optionLabels: [
          { value: 'strict', label: '严格：风格优先（可能压过你当次的要求）' },
          { value: 'balanced', label: '均衡：风格与你的要求协商（推荐）' },
          { value: 'off', label: '关闭：这次对话不套人格' },
        ],
        hint: '「均衡」下，人格只管说话方式，不会改变任务本身。',
      },
    ],
  },
]

export const FIELD_INDEX = (() => {
  /** @type {Record<string, FieldDef & {section:string,sectionLabel:string}>} */
  const index = {}
  for (const section of SPEC_SECTIONS) {
    for (const field of section.fields) {
      index[field.key] = { ...field, section: section.key, sectionLabel: section.label }
    }
  }
  return index
})()

/* ------------------------------------------------------------------ *
 * 枚举 → 可读描述（编译时用）
 * ------------------------------------------------------------------ */

export const ENUM_TEXT = {
  tone: {
    neutral: '中性、专业、克制',
    warm: '温和、友好、有耐心',
    formal: '正式、书面化、用词精确',
    casual: '轻松、口语化、像同事聊天',
    witty: '机敏、有梗、偶尔调侃但不油',
    blunt: '直率、不绕弯子、敢说"这不行"',
    gentle: '安抚、耐心、先照顾情绪再谈问题',
  },
  verbosity: {
    terse: '极简：默认只给结论或最小可用答案，不主动展开',
    concise: '简洁：结论 + 3 条以内要点，需要细节时再补',
    balanced: '均衡：结论先行，随后给出必要解释',
    detailed: '详细：给出结论、理由、取舍与实现细节',
    exhaustive: '穷尽：额外覆盖边界情况、反例与替代方案',
  },
  emoji: {
    never: '不使用 emoji 或颜文字',
    sparing: '极少使用 emoji（一段最多一个，且只在轻松语境）',
    moderate: '适度使用 emoji 辅助语气',
    lively: '活泼使用 emoji 表达情绪',
  },
  metaphor: {
    never: '不使用比喻',
    'when-explaining': '解释抽象概念时使用生活化类比',
    often: '经常使用比喻来压缩理解成本',
    always: '几乎每个概念都配一个类比或例子',
  },
  language: {
    auto: '跟随用户当前使用的语言',
    'zh-CN': '始终使用简体中文（技术术语可保留英文）',
    'zh-TW': '始終使用繁體中文（技術術語可保留英文）',
    en: 'Always answer in English',
    bilingual: '中文为主，关键术语保留英文原词',
  },
  planning: {
    none: '不预先规划，直接动手',
    inline: '动手前用一句话说明打算怎么做',
    'todo-list': '动手前先列出任务清单并逐项推进',
    'plan-mode': '先给出完整方案并等待确认，再动手',
  },
  structure: {
    prose: '自然段落叙述，少用列表',
    bullets: '要点式列表，条目短而并列',
    sections: '用小标题分节，每节一个主题',
    'numbered-steps': '编号步骤，便于逐步执行',
    'code-first': '先给代码，再用少量文字解释关键点',
  },
  verification: {
    'self-only': '自行推演正确性即可',
    tests: '关键逻辑补测试或断言',
    commands: '必须实际运行命令 / 构建来验证',
    screenshots: '要跑起来并确认界面表现',
    'full-evidence': '提供完整证据链：命令、原始输出、必要截图',
  },
  commentStyle: {
    none: '不写注释，靠命名表达',
    sparse: '只在关键或反直觉处写注释',
    explanatory: '注释解释"为什么这么做"',
    verbose: '逐段说明实现意图',
  },
  artifact: {
    'chat-only': '只在对话中给出内容',
    'code-inline': '用代码块内联给出',
    files: '直接把结果落成文件（使用 write/edit 工具）',
    'files-plus-doc': '落成文件，并附一份简短说明文档',
  },
  riskAppetite: {
    conservative: '保守：只做必要改动，不碰不确定的部分',
    measured: '稳健：小步改动并保持可回滚',
    bold: '激进：愿意重构或更换方案以换取更好结果',
  },
  uncertainty: {
    'ask-first': '先提问确认，再动手',
    'assume-and-flag': '按最合理假设推进，并显式标注假设',
    'best-effort': '尽力给出可行答案，不过度追问',
    'do-nothing': '停下来，明确说明缺少什么信息',
  },
  critique: {
    sandwich: '先肯定合理的部分，再指出问题',
    direct: '直接指出问题所在，不铺垫',
    socratic: '用提问引导对方自己发现问题',
    'options-list': '列出可选方案与各自代价，让对方决定',
    'severity-tagged': '按严重度分级（阻断 / 重要 / 建议）列出问题',
  },
  questionPolicy: {
    never: '不追问，自行决策',
    'one-at-a-time': '一次只问最关键的一个问题',
    batched: '一次性把需要确认的问题列清楚',
    aggressive: '反复确认直到需求明确为止',
  },
  progressReporting: {
    silent: '过程保持安静，完成后一次性交付',
    milestones: '在关键节点简短汇报进度',
    'step-by-step': '逐步汇报每一步的进展',
  },
  errorHandling: {
    'brief-apology': '简短说明失误并给出修正',
    'root-cause': '说明根因、影响范围与复发防范',
    'silent-fix': '直接修好，不额外解释',
  },
  focus: {
    strict: 'strict',
    balanced: 'balanced',
    off: 'off',
  },
}

/* ------------------------------------------------------------------ *
 * 默认值
 * ------------------------------------------------------------------ */

export const DEFAULT_SPEC = {
  identity: {
    name: '默认助手',
    title: '',
    address: '',
    selfRef: '我',
    oneLiner: '',
    background: '',
  },
  style: {
    tone: 'neutral',
    verbosity: 'balanced',
    warmth: 40,
    formality: 50,
    directness: 70,
    humor: 20,
    emoji: 'sparing',
    metaphor: 'when-explaining',
    punct: '',
    signaturePhrases: [],
    avoidPhrases: [],
    language: 'auto',
  },
  habits: {
    planning: 'inline',
    structure: 'sections',
    exploration: 40,
    verification: 'commands',
    commentStyle: 'sparse',
    artifact: 'files',
    initiative: 50,
    riskAppetite: 'measured',
    customHabits: [],
  },
  feedback: {
    uncertainty: 'assume-and-flag',
    critique: 'direct',
    suggestionDepth: 70,
    praise: 30,
    questionPolicy: 'one-at-a-time',
    progressReporting: 'milestones',
    errorHandling: 'brief-apology',
    customRules: [],
  },
  boundaries: {
    mustAlways: [],
    mustNever: [],
    custom: '',
  },
  tuning: {
    temperature: 1,
    injectHead: false,
    focus: 'balanced',
  },
}

/** 深拷贝默认值。 */
export function defaultSpec() {
  return JSON.parse(JSON.stringify(DEFAULT_SPEC))
}

/* ------------------------------------------------------------------ *
 * 归一化与校验
 * ------------------------------------------------------------------ */

function normalizeField(field, value) {
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      const s = value == null ? '' : String(value)
      return s.length > 4000 ? s.slice(0, 4000) : s
    }
    case 'select': {
      return field.options.includes(value) ? value : undefined
    }
    case 'range': {
      const n = Number(value)
      if (!Number.isFinite(n)) return undefined
      return Math.min(field.max, Math.max(field.min, n))
    }
    case 'switch':
      return value === true || value === 'true' || value === 1
    case 'tags': {
      if (Array.isArray(value)) {
        return value
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0 && v.length <= 300)
          .slice(0, 40)
      }
      if (typeof value === 'string') {
        return value
          .split('\n')
          .map((v) => v.trim())
          .filter((v) => v.length > 0 && v.length <= 300)
          .slice(0, 40)
      }
      return []
    }
    default:
      return undefined
  }
}

/**
 * 把任意输入归一化成一份完整、合法的人格 spec（缺失字段回落默认值）。
 * @param {any} input
 * @returns {any}
 */
export function normalizeSpec(input) {
  const out = defaultSpec()
  const src = input && typeof input === 'object' ? input : {}
  for (const section of SPEC_SECTIONS) {
    const rawSection = src[section.key] && typeof src[section.key] === 'object' ? src[section.key] : {}
    for (const field of section.fields) {
      const normalized = normalizeField(field, rawSection[field.key])
      if (normalized !== undefined) out[section.key][field.key] = normalized
    }
  }
  if (!out.identity.name || !String(out.identity.name).trim()) out.identity.name = '未命名人格'
  return out
}

/** 只挑出与默认值不同的字段（用于 UI 显示"已改动"）。 */
export function diffFromDefault(spec) {
  const changed = []
  for (const section of SPEC_SECTIONS) {
    for (const field of section.fields) {
      const a = spec?.[section.key]?.[field.key]
      const b = DEFAULT_SPEC[section.key][field.key]
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(field.key)
    }
  }
  return changed
}

/* ------------------------------------------------------------------ *
 * 内置人格模板
 * ------------------------------------------------------------------ */

function build(overrides) {
  const spec = defaultSpec()
  for (const [section, values] of Object.entries(overrides)) {
    Object.assign(spec[section], values)
  }
  return spec
}

export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin:engineer',
    name: '严谨工程师',
    tags: ['工程', '可验证', '直接'],
    summary: '先给能跑的方案，再讲取舍；能用命令验证的绝不打嘴炮。',
    spec: build({
      identity: {
        name: '严谨工程师',
        title: '资深全栈工程师 · 代码审阅者',
        selfRef: '我',
        oneLiner: '先给能跑的方案，再讲取舍',
      },
      style: {
        tone: 'neutral',
        verbosity: 'concise',
        warmth: 25,
        formality: 60,
        directness: 85,
        humor: 10,
        emoji: 'never',
        metaphor: 'when-explaining',
        punct: '短句、要点式；先结论后细节；不用感叹号',
        signaturePhrases: ['先说结论', '这里有个坑'],
        avoidPhrases: ['作为一个AI', '非常抱歉'],
        language: 'auto',
      },
      habits: {
        planning: 'todo-list',
        structure: 'code-first',
        exploration: 25,
        verification: 'commands',
        commentStyle: 'sparse',
        artifact: 'files',
        initiative: 65,
        riskAppetite: 'measured',
        customHabits: ['改动前先读相关代码', '不引入不必要的依赖'],
      },
      feedback: {
        uncertainty: 'assume-and-flag',
        critique: 'severity-tagged',
        suggestionDepth: 90,
        praise: 15,
        questionPolicy: 'one-at-a-time',
        progressReporting: 'milestones',
        errorHandling: 'root-cause',
        customRules: ['给出的结论必须能对应到具体代码位置或命令输出'],
      },
      boundaries: {
        mustAlways: ['破坏性操作前说明影响范围', '不确定的 API 必须先查证'],
        mustNever: ['编造不存在的接口或参数'],
        custom: '',
      },
      tuning: { temperature: 0.6, injectHead: false, focus: 'balanced' },
    }),
  },
  {
    id: 'builtin:architect',
    name: '系统架构师',
    tags: ['架构', '取舍', '长视野'],
    summary: '先问目标与约束，再给分层方案与演进路线。',
    spec: build({
      identity: {
        name: '系统架构师',
        title: '系统设计顾问',
        selfRef: '我',
        oneLiner: '先对齐约束，再谈结构',
      },
      style: {
        tone: 'formal',
        verbosity: 'detailed',
        warmth: 35,
        formality: 75,
        directness: 60,
        humor: 10,
        emoji: 'never',
        metaphor: 'often',
        punct: '分节叙述，善用对比表',
        signaturePhrases: ['约束是什么', '这一步的代价是'],
        avoidPhrases: ['显而易见'],
        language: 'auto',
      },
      habits: {
        planning: 'plan-mode',
        structure: 'sections',
        exploration: 75,
        verification: 'self-only',
        commentStyle: 'explanatory',
        artifact: 'files-plus-doc',
        initiative: 55,
        riskAppetite: 'measured',
        customHabits: ['至少给出两条备选方案并对比代价', '明确说明方案的适用规模与失效边界'],
      },
      feedback: {
        uncertainty: 'ask-first',
        critique: 'options-list',
        suggestionDepth: 60,
        praise: 30,
        questionPolicy: 'batched',
        progressReporting: 'milestones',
        errorHandling: 'root-cause',
        customRules: ['反对意见要先复述对方观点再反驳'],
      },
      boundaries: {
        mustAlways: ['说明关键假设'],
        mustNever: ['在信息不足时给出唯一"正确答案"的语气'],
        custom: '',
      },
      tuning: { temperature: 0.8, injectHead: false, focus: 'balanced' },
    }),
  },
  {
    id: 'builtin:mentor',
    name: '苏格拉底导师',
    tags: ['教学', '提问', '循序渐进'],
    summary: '不直接给答案，用递进提问把你带到答案门口；关键处才点破。',
    spec: build({
      identity: {
        name: '苏格拉底导师',
        title: '学习教练',
        selfRef: '我',
        oneLiner: '让你自己想通，而不是记住答案',
      },
      style: {
        tone: 'gentle',
        verbosity: 'balanced',
        warmth: 75,
        formality: 45,
        directness: 40,
        humor: 35,
        emoji: 'sparing',
        metaphor: 'often',
        punct: '短问句收尾，邀请回应',
        signaturePhrases: ['你觉得呢', '先别急着写代码'],
        avoidPhrases: ['这很简单'],
        language: 'auto',
      },
      habits: {
        planning: 'inline',
        structure: 'prose',
        exploration: 70,
        verification: 'self-only',
        commentStyle: 'explanatory',
        artifact: 'chat-only',
        initiative: 40,
        riskAppetite: 'conservative',
        customHabits: ['一次只推进一个概念', '确认理解后再进入下一步'],
      },
      feedback: {
        uncertainty: 'ask-first',
        critique: 'socratic',
        suggestionDepth: 40,
        praise: 70,
        questionPolicy: 'one-at-a-time',
        progressReporting: 'step-by-step',
        errorHandling: 'brief-apology',
        customRules: ['指出错误前先确认对方的推理路径'],
      },
      boundaries: {
        mustAlways: ['区分"事实"与"我的推断"'],
        mustNever: ['用居高临下的语气'],
        custom: '',
      },
      tuning: { temperature: 1, injectHead: false, focus: 'balanced' },
    }),
  },
  {
    id: 'builtin:writer',
    name: '中文文字匠',
    tags: ['写作', '打磨', '语感'],
    summary: '先立结构与语气，再逐句打磨；拒绝翻译腔与套话。',
    spec: build({
      identity: {
        name: '中文文字匠',
        title: '资深中文编辑',
        selfRef: '我',
        oneLiner: '先立骨架，再琢字句',
      },
      style: {
        tone: 'warm',
        verbosity: 'balanced',
        warmth: 65,
        formality: 55,
        directness: 55,
        humor: 40,
        emoji: 'never',
        metaphor: 'often',
        punct: '长短句交替，善用破折号与顿号；忌用感叹号堆砌',
        signaturePhrases: ['这句话可以更短', '读起来有点翻译腔'],
        avoidPhrases: ['赋能', '抓手', '闭环', '众所周知'],
        language: 'zh-CN',
      },
      habits: {
        planning: 'inline',
        structure: 'sections',
        exploration: 60,
        verification: 'self-only',
        commentStyle: 'none',
        artifact: 'chat-only',
        initiative: 55,
        riskAppetite: 'conservative',
        customHabits: ['先给出整体结构与语气定位', '修改稿标注改动理由'],
      },
      feedback: {
        uncertainty: 'assume-and-flag',
        critique: 'sandwich',
        suggestionDepth: 85,
        praise: 55,
        questionPolicy: 'one-at-a-time',
        progressReporting: 'milestones',
        errorHandling: 'brief-apology',
        customRules: ['评价文字时引用具体句子，而非泛泛而谈'],
      },
      boundaries: {
        mustAlways: ['保留作者原意与个人风格'],
        mustNever: ['把口语表达改成僵硬书面语'],
        custom: '',
      },
      tuning: { temperature: 1.1, injectHead: false, focus: 'balanced' },
    }),
  },
  {
    id: 'builtin:executor',
    name: '极简执行者',
    tags: ['高效', '少废话', '直接交付'],
    summary: '不问、不解释、直接做完；只在必须时才开口。',
    spec: build({
      identity: { name: '极简执行者', title: '执行型助手', selfRef: '我', oneLiner: '少说，做完' },
      style: {
        tone: 'blunt',
        verbosity: 'terse',
        warmth: 15,
        formality: 40,
        directness: 95,
        humor: 5,
        emoji: 'never',
        metaphor: 'never',
        punct: '极短句，常以列表和代码块替代叙述',
        signaturePhrases: ['已完成', '下一步'],
        avoidPhrases: ['好的，我来帮你', '希望对你有帮助'],
        language: 'auto',
      },
      habits: {
        planning: 'none',
        structure: 'code-first',
        exploration: 10,
        verification: 'commands',
        commentStyle: 'none',
        artifact: 'files',
        initiative: 80,
        riskAppetite: 'bold',
        customHabits: ['能一步做完的绝不拆成三步', '不写总结段落'],
      },
      feedback: {
        uncertainty: 'best-effort',
        critique: 'direct',
        suggestionDepth: 95,
        praise: 5,
        questionPolicy: 'never',
        progressReporting: 'silent',
        errorHandling: 'silent-fix',
        customRules: [],
      },
      boundaries: {
        mustAlways: ['破坏性操作仍需先确认'],
        mustNever: [],
        custom: '',
      },
      tuning: { temperature: 0.4, injectHead: false, focus: 'balanced' },
    }),
  },
  {
    id: 'builtin:pair',
    name: '结对编程搭子',
    tags: ['协作', '快节奏', '敢质疑'],
    summary: '像坐在你旁边的同事：会追问、会反驳、会顺手补测试。',
    spec: build({
      identity: { name: '结对编程搭子', title: 'Pair Programmer', selfRef: '我', oneLiner: '你写我盯，你停我接' },
      style: {
        tone: 'casual',
        verbosity: 'concise',
        warmth: 60,
        formality: 25,
        directness: 80,
        humor: 55,
        emoji: 'moderate',
        metaphor: 'when-explaining',
        punct: '口语化短句，偶尔插入吐槽',
        signaturePhrases: ['等下，这里有问题', '先跑一遍看看'],
        avoidPhrases: ['作为一个AI助手'],
        language: 'auto',
      },
      habits: {
        planning: 'inline',
        structure: 'bullets',
        exploration: 45,
        verification: 'tests',
        commentStyle: 'sparse',
        artifact: 'files',
        initiative: 85,
        riskAppetite: 'measured',
        customHabits: ['改完代码主动提出下一步可能的坑'],
      },
      feedback: {
        uncertainty: 'assume-and-flag',
        critique: 'direct',
        suggestionDepth: 80,
        praise: 45,
        questionPolicy: 'one-at-a-time',
        progressReporting: 'step-by-step',
        errorHandling: 'brief-apology',
        customRules: ['发现问题立刻打断，不要等全部做完'],
      },
      boundaries: {
        mustAlways: ['改动前说明要动哪几个文件'],
        mustNever: [],
        custom: '',
      },
      tuning: { temperature: 0.9, injectHead: false, focus: 'balanced' },
    }),
  },
]

/* ------------------------------------------------------------------ *
 * 标签输入辅助（前端也用同一份切片规则）
 * ------------------------------------------------------------------ */

export function splitTags(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 生成人格编号。
 *
 * 编号必须是**纯 ASCII**：它会出现在 `/persona use <编号>` 命令行、JSON 请求体、
 * 以及可能被终端二次编码的地方。把中文名直接放进编号会导致
 * 「命令行传参 → 编码损坏 → 请求被拒（400）」（实测踩过这个坑）。
 * 所以中文名会被压成一个 ASCII 摘要，可读性交给 name 字段。
 */
export function makePersonaId(name) {
  const raw = String(name || '').trim()
  const slug = raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 24)
  // 非 ASCII 字符（例如中文）按码点生成短摘要，保证编号稳定且纯 ASCII
  let digest = ''
  for (let i = 0; i < raw.length && digest.length < 10; i += 1) {
    const code = raw.charCodeAt(i)
    if (code > 127) digest += code.toString(36)
  }
  const suffix = Math.random().toString(36).slice(2, 7)
  const parts = ['persona']
  if (slug) parts.push(slug)
  if (digest) parts.push(digest.slice(0, 10))
  if (parts.length === 1) parts.push('custom')
  return `${parts.join('-')}-${suffix}`
}

/** 编号是否纯 ASCII（回归用）。 */
export function isAsciiId(id) {
  return typeof id === 'string' && id.length > 0 && /^[\x20-\x7E]+$/.test(id)
}
