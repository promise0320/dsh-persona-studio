/**
 * dsh-persona-studio —— 主界面人格面板（浏览器半区，无构建步骤的纯 JS）
 *
 * 挂载策略（三级回退，谁先成功用谁）：
 *   1) 输入框工具栏右侧（贴近原生控件，最像"主界面的一部分"）
 *   2) composer 容器之后
 *   3) 右下角悬浮（兜底，一定可见）
 *
 * 所有数据来自宿主 /dsh-persona-studio/* 路由；面板自身不持有任何持久状态。
 */
;(function () {
  'use strict'

  var API = {
    state: '/dsh-persona-studio/state',
    save: '/dsh-persona-studio/save',
    preview: '/dsh-persona-studio/preview',
    generate: '/dsh-persona-studio/generate',
    importTpl: '/dsh-persona-studio/import',
    active: '/dsh-persona-studio/active',
  }

  var SOURCE_LABEL = {
    seed: '预置',
    manual: '手写',
    heuristic: '归纳',
    'heuristic-fallback': '归纳(回落)',
    llm: '深读',
    template: '模板',
    duplicate: '副本',
    import: '导入',
  }

  /**
   * 把内部取值翻成中文显示。
   * 界面只给用户看中文；内部取值（select 的 value）保持英文原样，
   * 因为它们要落盘、要跨版本兼容，翻译会破坏已经存下来的数据。
   */
  function showValue(field, value) {
    if (value === null || value === undefined || value === '') return ''
    if (field.kind === 'select' && field.optionLabels) {
      for (var i = 0; i < field.optionLabels.length; i++) {
        if (field.optionLabels[i].value === value) return field.optionLabels[i].label
      }
      return String(value)
    }
    if (field.kind === 'tags') {
      var list = Array.isArray(value) ? value : String(value).split('\n')
      return list.length + ' 条：' + list.slice(0, 3).join('、') + (list.length > 3 ? ' …' : '')
    }
    if (field.kind === 'switch') return value ? '已开启' : '已关闭'
    return String(value)
  }

  /** 每种字段类型的中文说明（规格里没写提示时用）。 */
  var KIND_HINT = {
    text: '直接输入文字即可。',
    textarea: '一段话自由描述，回车换行。',
    select: '下拉选择一种。',
    range: '拖动滑块：数值越大，这种倾向越强。',
    tags: '一行写一条，可以写多条。',
    switch: '勾选表示开启。',
  }

  function resultBody(result) {
    if (!result || !Array.isArray(result.content)) return ''
    return result.content
      .map(function (block) {
        return block && block.type === 'text' ? block.text : ''
      })
      .join('')
  }

  /**
   * 算出这份规格相对默认值改了哪些字段（返回中文标签）。
   * 用于卡片上提示"改了但还没保存"，直接回应"设置了很多简介却没变"的困惑。
   */
  function changedFieldLabels(spec) {
    var defaults = state.data && state.data.defaults
    var sections = (state.spec && state.spec.sections) || []
    if (!spec || !defaults) return []
    var labels = []
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i]
      var raw = spec[section.key] || {}
      var base = defaults[section.key] || {}
      for (var j = 0; j < section.fields.length; j++) {
        var field = section.fields[j]
        if (JSON.stringify(raw[field.key]) !== JSON.stringify(base[field.key])) labels.push(field.label)
      }
    }
    return labels
  }

  var state = {
    open: false,
    tab: 'library',
    loaded: false,
    loading: false,
    spec: null,
    data: null,
    form: null,
    busy: false,
    status: { text: '', kind: '' },
    gen: null,
    compact: false,
  }

  var el = {}

  /* ------------------------------------------------------------------ *
   * 基础设施
   * ------------------------------------------------------------------ */

  function h(tag, props, children) {
    var node = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key]
        if (value === null || value === undefined || value === false) return
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = String(value)
        else if (key === 'html') node.innerHTML = value
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
        else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value)
        else node.setAttribute(key, value === true ? '' : String(value))
      })
    }
    if (children) {
      ;(Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === null || child === undefined || child === false) return
        node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
      })
    }
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function status(text, kind) {
    state.status = { text: text || '', kind: kind || '' }
    renderStatus()
  }

  function renderStatus() {
    if (!el.status) return
    el.status.textContent = state.status.text
    el.status.dataset.kind = state.status.kind
  }

  function setThemeAttr() {
    if (!el.root) return
    var dark =
      document.documentElement.dataset.theme === 'dark' ||
      document.documentElement.classList.contains('dark') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    el.root.dataset.dpfTheme = dark ? 'dark' : 'light'
  }

  function request(url, options) {
    var opts = options || {}
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: { message: 'HTTP ' + response.status } }
      })
    })
  }

  function post(url, body) {
    return request(url, { method: 'POST', body: body })
  }

  function applyState(payload) {
    if (!payload || !payload.ok) return
    state.data = payload.state
    state.spec = state.data.spec

    // 关键保护：**有未保存改动时，任何服务端响应都不许覆盖表单**。
    // 之前的判断条件在有改动时也可能重建表单，表现就是"离开再回来，编辑内容全被重置"
    // （用户实测反馈）。这里把"不覆盖"提到最前面，避免以后再被别处的逻辑绕过。
    var hasUnsavedEdits = !!(state.form && state.form.dirty)
    if (!hasUnsavedEdits && !state.form) {
      state.form = state.data.active ? clone(state.data.active) : blankPersona()
      state.form.dirty = false
    }
    // 备注与背景设定是同一件事：以规格里的背景设定为准（那里才是真正发给 AI 的）
    if (state.form && state.form.spec && state.form.spec.identity && state.form.spec.identity.background) {
      state.form.note = state.form.spec.identity.background
    }
    if (hasUnsavedEdits) {
      // 但名字要跟住激活人格（用户可能刚在人格库切了人）
      if (state.data.active && !state.form.id) state.form.name = state.data.active.name
    }
    // 宿主里配置好的挂载位置优先（多标签页/重启后保持一致）
    var preferred = state.data.config && state.data.config.placement
    if (typeof preferred === 'string' && preferred !== desiredPlacement) {
      desiredPlacement = PLACEMENTS.indexOf(preferred) === -1 ? 'toolbar-right' : preferred
      placement = desiredPlacement
      if (el.root) el.root.dataset.placement = placement
      mount(true)
    }
    state.loaded = true
    renderAll()
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function blankPersona() {
    // 优先用宿主给的完整默认规格；克隆激活人格只作为兜底。
    // （克隆可能拿到不完整的规格，会让新人格缺字段。）
    var spec = null
    if (state.data && state.data.blankSpec) spec = clone(state.data.blankSpec)
    else if (state.data && state.data.active && state.data.active.spec) spec = clone(state.data.active.spec)
    else spec = {}
    return {
      id: null,
      name: '新人格',
      tags: [],
      note: '',
      spec: spec,
      source: 'manual',
      dirty: false,
    }
  }

  function currentSpec() {
    return (state.form && state.form.spec) || (state.data && state.data.active && state.data.active.spec) || null
  }

  function reload() {
    state.loading = true
    return request(API.state)
      .then(applyState)
      .catch(function (error) {
        status('加载失败：' + error.message, 'error')
      })
      .then(function () {
        state.loading = false
      })
  }

  /* ------------------------------------------------------------------ *
   * 渲染：外壳
   * ------------------------------------------------------------------ */

  function buildUi() {
    el.root = h('div', { class: 'dpf-root' })
    el.anchor = h('div', { class: 'dpf-anchor' })

    el.pill = h('button', { class: 'dpf-pill', type: 'button', title: '人格工坊（Ctrl+Shift+P）', onclick: toggle }, [
      h('span', { class: 'dpf-pill-dot' }),
      h('span', { class: 'dpf-pill-label', text: '人格' }),
    ])

    el.panel = h('div', { class: 'dpf-panel', dataset: { open: 'false' } })

    el.head = h('div', { class: 'dpf-head' }, [
      h('span', { class: 'dpf-title', text: '人格工坊' }),
      (el.activeName = h('span', { class: 'dpf-active-name', text: '—' })),
      h('span', { class: 'dpf-head-spacer' }),
      (el.enabled = h(
        'label',
        {
          class: 'dpf-switch',
          title:
            '「按人格说话」= 让 AI 真的照着这份人格回答。\n' +
            '打勾：每次提问都会把人格规则一起发给 AI（推荐）。\n' +
            '取消：人格库仍然保留，但 AI 不再按它说话。',
        },
        [h('input', { type: 'checkbox', onchange: onToggleEnabled }), h('span', { text: '按人格说话' })],
      )),
      h('button', { class: 'dpf-iconbtn', type: 'button', title: '刷新', text: '⟳', onclick: function () { state.form = null; reload() } }),
      h('button', { class: 'dpf-iconbtn', type: 'button', title: '关闭', text: '✕', onclick: close }),
    ])

    el.tabs = h('div', { class: 'dpf-tabs' })
    el.tabButtons = {}
    ;[
      ['library', '人格库'],
      ['templates', '模板'],
      ['editor', '编译'],
      ['generate', '自动归纳'],
      ['settings', '设置'],
    ].forEach(function (pair) {
      var button = h('button', {
        class: 'dpf-tab',
        type: 'button',
        text: pair[1],
        dataset: { tab: pair[0] },
        onclick: function () {
          state.tab = pair[0]
          renderTabs()
          renderBody()
        },
      })
      el.tabButtons[pair[0]] = button
      el.tabs.appendChild(button)
    })

    el.body = h('div', { class: 'dpf-body' })
    el.status = h('div', { class: 'dpf-status' })
    el.foot = h('div', { class: 'dpf-foot' }, [el.status])

    el.panel.appendChild(el.head)
    el.panel.appendChild(el.tabs)
    el.panel.appendChild(el.body)
    el.panel.appendChild(el.foot)
    el.anchor.appendChild(el.pill)
    el.anchor.appendChild(el.panel)
    el.root.appendChild(el.anchor)
  }

  function renderAll() {
    if (!state.loaded) return
    renderPill()
    renderTabs()
    renderBody()
    renderStatus()
  }

  function renderPill() {
    var active = state.data && state.data.active
    var enabled = state.data && state.data.config.enabled
    el.pill.dataset.on = enabled ? 'true' : 'false'
    el.pill.querySelector('.dpf-pill-label').textContent = active ? active.name : '未设置人格'
    if (el.enabled) el.enabled.querySelector('input').checked = !!enabled
    if (el.activeName) el.activeName.textContent = active ? active.name : '未设置'
  }

  function renderTabs() {
    Object.keys(el.tabButtons).forEach(function (key) {
      el.tabButtons[key].dataset.active = key === state.tab ? 'true' : 'false'
    })
  }

  function renderBody() {
    clear(el.body)
    if (state.loading && !state.loaded) {
      el.body.appendChild(h('div', { class: 'dpf-empty', text: '正在加载人格库…' }))
      return
    }
    if (state.tab === 'library') renderLibrary()
    else if (state.tab === 'templates') renderTemplates()
    else if (state.tab === 'editor') renderEditor()
    else if (state.tab === 'generate') renderGenerate()
    else renderSettings()
  }
  /* ------------------------------------------------------------------ *
   * Tab：人格库
   * ------------------------------------------------------------------ */

  function renderLibrary() {
    var personas = (state.data && state.data.personas) || []
    var activeId = state.data && state.data.activeId

    el.body.appendChild(
      h('div', { class: 'dpf-row' }, [
        h('div', { class: 'dpf-hint', text: '点击「使用」立即切换；被切换的人格会积累激活次数，作为"倾向"的记录。' }),
        h('span', { class: 'dpf-head-spacer' }),
        h('button', {
          class: 'dpf-btn',
          type: 'button',
          text: '＋ 新建空白人格',
          onclick: function () {
            state.form = blankPersona()
            state.form.name = '新人格 ' + (personas.length + 1)
            state.form.dirty = true
            state.tab = 'editor'
            renderTabs()
            renderBody()
          },
        }),
      ]),
    )

    if (personas.length === 0) {
      el.body.appendChild(h('div', { class: 'dpf-empty', text: '还没有人格，去「模板」里挑一个吧。' }))
      return
    }

    var grid = h('div', { class: 'dpf-grid', style: { marginTop: '10px' } })
    personas.forEach(function (persona) {
      // 这张卡片正在被编辑且还没保存时，明确提示"改了但没保存"，
      // 否则用户会以为"设置了很多，简介却没变"是 bug。
      var editingThis = state.form && state.form.dirty && state.form.id === persona.id
      var pendingFields = editingThis ? changedFieldLabels(state.form.spec) : null
      var card = h('div', { class: 'dpf-card', dataset: { active: persona.id === activeId ? 'true' : 'false' } }, [
        h('div', { class: 'dpf-card-top' }, [
          h('span', { class: 'dpf-card-name', text: persona.name }),
          h('span', { class: 'dpf-tag', text: SOURCE_LABEL[persona.source] || persona.source || '自定义' }),
          editingThis ? h('span', { class: 'dpf-tag', style: { color: 'var(--dpf-danger)' }, text: '未保存' }) : null,
        ]),
        h('div', {
          class: 'dpf-card-summary',
          text: editingThis
            ? '改动尚未保存。点「保存并启用」后，简介与注入内容才会按新设置更新。' +
              (pendingFields && pendingFields.length ? `（已改 ${pendingFields.length} 项：${pendingFields.slice(0, 3).join('、')}…）` : '')
            : persona.summary || '',
        }),
        h(
          'div',
          { class: 'dpf-tags' },
          (persona.tags || []).slice(0, 6).map(function (tag) {
            return h('span', { class: 'dpf-tag', text: tag })
          }),
        ),
        h('div', { class: 'dpf-card-actions' }, [
          persona.id === activeId
            ? h('span', { class: 'dpf-tag', style: { color: 'var(--dpf-accent)' }, text: '● 使用中' })
            : h('button', {
                class: 'dpf-btn',
                type: 'button',
                text: '使用',
                onclick: function () {
                  act({ action: 'activate', id: persona.id, reason: 'ui' }, '已切换到「' + persona.name + '」')
                },
              }),
          h('button', {
            class: 'dpf-btn',
            type: 'button',
            text: '编辑',
            onclick: function () {
              state.form = clone(persona)
              state.form.dirty = false
              state.tab = 'editor'
              renderTabs()
              renderBody()
            },
          }),
          h('button', {
            class: 'dpf-btn',
            type: 'button',
            text: '复制',
            onclick: function () {
              act({ action: 'duplicate', id: persona.id }, '已复制「' + persona.name + '」')
            },
          }),
          h('button', {
            class: 'dpf-btn',
            type: 'button',
            text: '删除',
            dataset: { variant: 'danger' },
            onclick: function () {
              if (!window.confirm('删除人格「' + persona.name + '」？')) return
              act({ action: 'delete', id: persona.id }, '已删除「' + persona.name + '」')
            },
          }),
        ]),
      ])
      grid.appendChild(card)
    })
    el.body.appendChild(grid)
  }

  function act(body, message) {
    state.busy = true
    status('处理中…')
    return post(API.save, body)
      .then(function (result) {
        if (!result.ok) throw new Error((result.error && result.error.message) || '操作失败')
        applyState(result)
        status(message || '完成', 'ok')
      })
      .catch(function (error) {
        status('失败：' + error.message, 'error')
      })
      .then(function () {
        state.busy = false
      })
  }

  /* ------------------------------------------------------------------ *
   * Tab：模板
   * ------------------------------------------------------------------ */

  function renderTemplates() {
    var templates = (state.data && state.data.templates) || { builtin: [], files: [] }
    el.body.appendChild(
      h('div', { class: 'dpf-hint', text: '点击模板卡片即基于它新建一个人格并立即启用；之后可在「编译」里继续微调。' }),
    )

    var builtinGrid = h('div', { class: 'dpf-grid', style: { marginTop: '10px' } })
    templates.builtin.forEach(function (template) {
      builtinGrid.appendChild(templateCard(template))
    })
    el.body.appendChild(h('div', { class: 'dpf-field-label', style: { marginTop: '14px' }, text: '内置模板' }))
    el.body.appendChild(builtinGrid)

    el.body.appendChild(
      h('div', { class: 'dpf-field-label', style: { marginTop: '16px' }, text: '自定义模板文件（' + (state.data.paths.templates || '') + '）' }),
    )
    if (!templates.files || templates.files.length === 0) {
      el.body.appendChild(
        h('div', {
          class: 'dpf-hint',
          text: '把 *.json 人格模板放进上面这个目录即可出现在这里。文件格式：{"name":"…","tags":[],"spec":{…}}（也可直接是一份 spec）。',
        }),
      )
    } else {
      var fileGrid = h('div', { class: 'dpf-grid', style: { marginTop: '8px' } })
      templates.files.forEach(function (template) {
        fileGrid.appendChild(templateCard(template))
      })
      el.body.appendChild(fileGrid)
    }
  }

  function templateCard(template) {
    return h('div', { class: 'dpf-card' }, [
      h('div', { class: 'dpf-card-top' }, [
        h('span', { class: 'dpf-card-name', text: template.name }),
        h('span', { class: 'dpf-tag', text: template.source === 'builtin' ? '内置' : '文件' }),
      ]),
      h('div', { class: 'dpf-card-summary', text: template.summary || '' }),
      h(
        'div',
        { class: 'dpf-tags' },
        (template.tags || []).map(function (tag) {
          return h('span', { class: 'dpf-tag', text: tag })
        }),
      ),
      h('div', { class: 'dpf-card-actions' }, [
        h('button', {
          class: 'dpf-btn',
          dataset: { variant: 'primary' },
          type: 'button',
          text: '用这个模板',
          onclick: function () {
            act({ action: 'create', activate: true, reason: 'template', persona: { name: template.name, spec: template.spec, tags: template.tags, source: 'template:' + template.id, sourceTemplate: template.id } }, '已基于「' + template.name + '」创建并启用')
          },
        }),
        h('button', {
          class: 'dpf-btn',
          type: 'button',
          text: '在编译器中打开',
          onclick: function () {
            state.form = {
              id: null,
              name: template.name,
              tags: (template.tags || []).slice(),
              note: '',
              spec: clone(template.spec),
              source: 'template:' + template.id,
              sourceTemplate: template.id,
              dirty: true,
            }
            state.tab = 'editor'
            renderTabs()
            renderBody()
          },
        }),
      ]),
    ])
  }

  /* ------------------------------------------------------------------ *
   * Tab：编译器
   * ------------------------------------------------------------------ */

  function renderEditor() {
    if (!state.spec) {
      el.body.appendChild(h('div', { class: 'dpf-empty', text: '规格未加载' }))
      return
    }
    // 只有第一次进编译页才从"当前激活人格"初始化表单；
    // 之后的进入都必须保留未保存的编辑（否则离开再回来就被重置）。
    if (!state.form) {
      state.form = state.data.active ? clone(state.data.active) : blankPersona()
      state.form.dirty = false
    }
    if (!state.form.spec) state.form.spec = {}

    var left = h('div')
    var right = h('div')
    var grid = h('div', { class: 'dpf-edit-grid' }, [left, right])

    // 顶部：名称 / 标签 / 说明
    left.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '基本信息' })]),
        h('div', { class: 'dpf-section-body' }, [
          labeled('人格名称', h('input', {
            class: 'dpf-input',
            value: state.form.name || '',
            oninput: function (event) {
              state.form.name = event.target.value
              // 名字要同时写回规格：编译出来的文本用的是规格里的名字，
              // 只改顶层名字会导致"名字变了、注入内容没变"（实测踩过）。
              if (!state.form.spec) state.form.spec = {}
              if (!state.form.spec.identity) state.form.spec.identity = {}
              state.form.spec.identity.name = event.target.value
              state.form.dirty = true
              schedulePreview()
            },
          })),
          h('span', {
            class: 'dpf-hint',
            text: '这个名字会出现在按钮上和注入内容的第一行；下面「身份设定」里的名字是同一个值。',
          }),
          labeled('标签（逗号分隔）', h('input', {
            class: 'dpf-input',
            value: (state.form.tags || []).join(', '),
            oninput: function (event) {
              state.form.tags = event.target.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
              state.form.dirty = true
            },
          })),
          labeled('备注（会一起发给 AI，作为背景设定）', h('textarea', {
            class: 'dpf-textarea',
            placeholder: '例如：住在主人硬盘里的蓝色鲸鱼娘女仆，自称"吃白饭的鱼"，怕饿、爱撒娇，但干活绝不含糊。',
            text: state.form.note || '',
            oninput: function (event) {
              state.form.note = event.target.value
              // 备注必须同步进规格：编译时读的是 spec.identity.background。
              // 只写 note 的话，AI 根本看不到这段设定（实测踩过）。
              if (!state.form.spec) state.form.spec = {}
              if (!state.form.spec.identity) state.form.spec.identity = {}
              state.form.spec.identity.background = event.target.value
              state.form.dirty = true
              schedulePreview()
            },
          })),
          h('span', {
            class: 'dpf-hint',
            text: '这段会作为「背景设定」进入提示词，用来交代它是什么来历、有什么脾气。',
          }),
        ]),
      ]),
    )

    // 维度分组
    state.spec.sections.forEach(function (section) {
      var body = h('div', { class: 'dpf-section-body' })
      var desc = h('div', { class: 'dpf-section-desc', text: section.desc || '' })
      var arrow = h('span', { class: 'dpf-section-arrow', text: '▾' })
      var sectionEl = h('div', { class: 'dpf-section' }, [
        h(
          'div',
          {
            class: 'dpf-section-head',
            title: '点一下可以展开 / 收起这一组设置',
            onclick: function () {
              body.style.display = body.style.display === 'none' ? '' : 'none'
              desc.style.display = body.style.display
              // 让"能点开"这件事有明确反馈（用户反馈过不知道分组可以展开）
              arrow.textContent = body.style.display === 'none' ? '▸' : '▾'
            },
          },
          [
            (arrow = h('span', { class: 'dpf-section-arrow', text: '▾' })),
            h('strong', { text: section.label }),
            h('span', { class: 'dpf-section-count', text: section.fields.length + ' 项' }),
          ],
        ),
        desc,
        body,
      ])
      section.fields.forEach(function (field) {
        body.appendChild(renderField(field, section.key))
      })
      left.appendChild(sectionEl)
    })

    // 右侧：实时预览
    var previewPre = h('pre', { text: '—' })
    var previewState = h('div', { class: 'dpf-preview-state', dataset: { kind: '' } })
    el.previewState = previewState
    right.appendChild(
      h('div', { class: 'dpf-preview' }, [
        h('div', { class: 'dpf-preview-head' }, [
          h('strong', { text: '编译结果预览' }),
          h('span', { class: 'dpf-head-spacer' }),
          h('button', {
            class: 'dpf-btn',
            type: 'button',
            text: '立即重算',
            onclick: function () {
              schedulePreview()
            },
          }),
          h('button', {
            class: 'dpf-btn',
            type: 'button',
            text: '复制',
            onclick: function () {
              copyText(previewPre.textContent)
            },
          }),
        ]),
        previewState,
        previewPre,
        h('div', { class: 'dpf-hint', text: '这就是将被注入到系统提示词最后的内容（<persona> 包裹）。改任何一项都会自动重算。' }),
      ]),
    )
    el.previewPre = previewPre

    // 底部操作条
    el.body.appendChild(grid)
    el.body.appendChild(
      h('div', { class: 'dpf-row', style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap' } }, [
        h('button', {
          class: 'dpf-btn',
          dataset: { variant: 'primary' },
          type: 'button',
          text: state.form.id ? '保存并启用' : '创建并启用',
          onclick: function () { saveForm(true) },
        }),
        h('button', {
          class: 'dpf-btn',
          type: 'button',
          text: '仅保存',
          onclick: function () { saveForm(false) },
        }),
        h('button', {
          class: 'dpf-btn',
          type: 'button',
          text: '重置为已保存版本',
          onclick: function () {
            var active = state.data.personas.filter(function (p) { return p.id === state.form.id })[0]
            state.form = active ? clone(active) : blankPersona()
            renderBody()
          },
        }),
        h('span', { class: 'dpf-head-spacer' }),
        h('button', {
          class: 'dpf-btn',
          type: 'button',
          text: '导出全部人格',
          onclick: function () {
            window.open('/dsh-persona-studio/export', '_blank')
          },
        }),
      ]),
    )

    schedulePreview()
  }

  function labeled(label, control) {
    return h('label', { class: 'dpf-field' }, [h('span', { class: 'dpf-field-label', text: label }), control])
  }

  function renderField(field, sectionKeyFromCaller) {
    var spec = currentSpec()
    // 分类名优先用调用方传进来的（渲染时一定知道自己在哪个分类），
    // 再退回字段自带的 section。绝不允许算出 undefined，
    // 否则修改会被写进 spec.undefined，界面看起来"改了没反应"。
    var sectionKey = sectionKeyFromCaller || field.section
    if (!sectionKey) {
      return h('div', {
        class: 'dpf-hint',
        style: { color: 'var(--dpf-danger)' },
        text: `字段「${field.label || field.key}」缺少分类信息，已跳过（这是插件 bug，请反馈）`,
      })
    }
    var value = spec && spec[sectionKey] ? spec[sectionKey][field.key] : undefined

    function set(next) {
      if (!state.form.spec) state.form.spec = {}
      if (!state.form.spec[sectionKey]) state.form.spec[sectionKey] = {}
      state.form.spec[sectionKey][field.key] = next
      // 名字在两处出现（顶部「人格名称」和「身份设定」里的名字），保持同步
      if (field.key === 'name' && sectionKey === 'identity') state.form.name = next
      state.form.dirty = true
      schedulePreview()
    }

    var control
    if (field.kind === 'text') {
      control = h('input', {
        class: 'dpf-input',
        value: value == null ? '' : value,
        placeholder: field.placeholder || '',
        oninput: function (event) { set(event.target.value) },
      })
    } else if (field.kind === 'textarea') {
      control = h('textarea', {
        class: 'dpf-textarea',
        placeholder: field.placeholder || '',
        text: value == null ? '' : value,
        oninput: function (event) { set(event.target.value) },
      })
    } else if (field.kind === 'select') {
      control = h(
        'select',
        {
          class: 'dpf-select',
          onchange: function (event) { set(event.target.value) },
        },
        (field.optionLabels || []).map(function (option) {
          return h('option', { value: option.value, text: option.label, selected: option.value === value })
        }),
      )
    } else if (field.kind === 'range') {
      var out = h('span', { class: 'dpf-field-value', text: String(value) })
      control = h('div', {}, [
        h('input', {
          class: 'dpf-range',
          type: 'range',
          min: field.min,
          max: field.max,
          step: field.step,
          value: value,
          oninput: function (event) {
            var next = Number(event.target.value)
            out.textContent = String(next)
            set(next)
          },
        }),
      ])
      return h('label', { class: 'dpf-field' }, [
        h('span', { class: 'dpf-field-label' }, [h('span', { text: field.label }), out, h('span', { class: 'dpf-field-value', text: '(' + showValue(field, value) + ')' })]),
        control,
        h('span', { class: 'dpf-hint', text: field.hint || KIND_HINT.range }),
      ])
    } else if (field.kind === 'switch') {
      control = h('input', {
        type: 'checkbox',
        checked: value === true,
        onchange: function (event) { set(event.target.checked) },
      })
      return h('label', { class: 'dpf-field' }, [
        h('span', { class: 'dpf-field-label' }, [control, h('span', { text: field.label })]),
        h('span', { class: 'dpf-hint', text: field.hint || KIND_HINT.switch }),
      ])
    } else {
      // tags
      control = h('textarea', {
        class: 'dpf-textarea',
        placeholder: (field.placeholderTags || []).join('\n'),
        text: Array.isArray(value) ? value.join('\n') : '',
        oninput: function (event) { set(event.target.value.split('\n').map(function (s) { return s.trim() }).filter(Boolean)) },
      })
    }

    return h('label', { class: 'dpf-field' }, [
      h('span', { class: 'dpf-field-label' }, [
        h('span', { text: field.label }),
        h('span', { class: 'dpf-field-value', text: showValue(field, value) }),
      ]),
      control,
      h('span', { class: 'dpf-hint', text: field.hint || KIND_HINT[field.kind] || '' }),
    ])
  }

  var previewTimer = null
  var diag = { preview: null, save: null, events: [] }

  function noteDiag(kind, info) {
    diag[kind] = Object.assign({ at: new Date().toLocaleTimeString() }, info)
    diag.events.push(Object.assign({ kind: kind }, info))
    if (diag.events.length > 20) diag.events.shift()
    if (el.previewState) renderPreviewState()
  }

  /** 改了几个字段（用来判断"有没有真的改到东西"）。 */
  function changedCount() {
    if (!state.form || !state.form.spec) return 0
    return changedFieldLabels(state.form.spec).length
  }

  function renderPreviewState() {
    if (!el.previewState) return
    var info = diag.preview
    var parts = []
    if (state.form && state.form.spec) parts.push('当前共 ' + changedCount() + ' 项与默认值不同')
    if (info) {
      if (info.error) parts.push('上次编译失败：' + info.error)
      else if (info.ok) parts.push('上次编译成功（' + info.at + '，' + (info.length || 0) + ' 字）')
      else parts.push('正在编译…')
    }
    el.previewState.textContent = parts.join(' · ')
    el.previewState.dataset.kind = info && info.error ? 'error' : info && info.ok ? 'ok' : ''
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer)
    renderPreviewState()
    previewTimer = setTimeout(function () {
      var spec = currentSpec()
      var focus = spec && spec.tuning ? spec.tuning.focus : undefined
      if (!spec) {
        noteDiag('preview', { error: '当前没有可编译的规格（表单为空）' })
        return
      }
      var keys = []
      try {
        for (var section in spec) {
          if (Object.prototype.hasOwnProperty.call(spec, section)) keys.push(section + ':' + Object.keys(spec[section] || {}).length)
        }
      } catch (error) {
        keys.push('读取失败')
      }
      noteDiag('preview', { pending: true, sections: keys.join(', ') })
      post(API.preview, { spec: spec, focus: focus })
        .then(function (result) {
          if (!result.ok) throw new Error((result.error && result.error.message) || '编译失败')
          if (el.previewPre) el.previewPre.textContent = result.injection
          noteDiag('preview', {
            ok: true,
            length: (result.injection || '').length,
            sections: keys.join(', '),
          })
        })
        .catch(function (error) {
          if (el.previewPre) el.previewPre.textContent = '编译失败：' + error.message
          noteDiag('preview', { error: error.message })
        })
    }, 220)
  }

  function saveForm(activate) {
    if (!state.form) return
    // 保存前统一一次名字，防止两条路径（顶层名字 / 规格里的名字）不一致
    if (state.form.spec) {
      if (!state.form.spec.identity) state.form.spec.identity = {}
      state.form.spec.identity.name = state.form.name
      // 备注与"背景设定"是同一件事：备注走卡片显示，背景设定走提示词注入。
      // 任一侧有值就同步到另一侧，避免用户以为写了却没生效。
      var bg = state.form.spec.identity.background
      if (!bg && state.form.note) state.form.spec.identity.background = state.form.note
      else if (bg && !state.form.note) state.form.note = bg
    }
    var persona = {
      id: state.form.id || undefined,
      name: state.form.name,
      tags: state.form.tags,
      note: state.form.note,
      spec: state.form.spec,
      source: state.form.source || 'manual',
      sourceTemplate: state.form.sourceTemplate || null,
    }
    act({ action: persona.id ? 'save' : 'create', activate: activate, persona: persona }, activate ? '已保存并启用' : '已保存').then(function () {
      if (state.form) state.form.dirty = false
    })
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
        status('已复制到剪贴板', 'ok')
        return
      }
    } catch (error) {
      /* 回退到 execCommand */
    }
    var area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    try { document.execCommand('copy'); status('已复制到剪贴板', 'ok') } catch (error) { status('复制失败', 'error') }
    document.body.removeChild(area)
  }

  /* ------------------------------------------------------------------ *
   * Tab：自动归纳
   * ------------------------------------------------------------------ */

  function renderGenerate() {
    var route = state.data && state.data.modelRoute
    var config = (state.data && state.data.config) || {}
    var sessions = (state.data && state.data.sessions) || []

    el.body.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '从历史对话归纳人格' })]),
        h('div', { class: 'dpf-section-desc', text: '读取最近若干会话里"你说的话"，归纳出你期望的协作方式与潜在需求，产出一份可编辑的人格草案。' }),
        h('div', { class: 'dpf-section-body' }, [
          h('div', { class: 'dpf-hint', text: '可分析的在线会话：' + sessions.length + ' 个（' + sessions.map(function (s) { return s.title || s.id }).slice(0, 4).join(' / ') + '）' }),
          h('div', { class: 'dpf-row', style: { gap: '8px', flexWrap: 'wrap' } }, [
            h('button', {
              class: 'dpf-btn',
              dataset: { variant: 'primary' },
              type: 'button',
              text: '开始归纳',
              disabled: state.busy,
              onclick: function () { runGenerate('heuristic') },
            }),
            h('button', {
              class: 'dpf-btn',
              type: 'button',
              text: '模型深读（更细腻，消耗额度）',
              disabled: state.busy,
              onclick: function () { runGenerate('llm') },
            }),
          ]),
          h('div', {
            class: 'dpf-hint',
            text: route
              ? '深读将使用：' +
                route.provider +
                ' / ' +
                route.model +
                (route.source === 'default-model' ? '（本会话还没发过请求，用的是宿主默认模型）' : '（本会话正在用的模型）')
              : '拿不到可用模型：本会话先发一条消息，或在设置里配好默认模型。',
          }),
        ]),
      ]),
    )

    if (!state.gen) {
      el.body.appendChild(h('div', { class: 'dpf-empty', text: '还没有归纳结果。点上面的按钮试试。' }))
      return
    }

    var gen = state.gen
    var evidence = gen.evidence || {}
    var evidenceBox = h('div', { class: 'dpf-evidence' })
    Object.keys(evidence).forEach(function (key) {
      if (key === 'raw') return
      evidenceBox.appendChild(h('div', { text: key + '：' + String(evidence[key]) }))
    })

    el.body.appendChild(
      h('div', { class: 'dpf-section', style: { marginTop: '12px' } }, [
        h('div', { class: 'dpf-section-head' }, [
          h('strong', { text: '归纳结果' }),
          h('span', { class: 'dpf-tag', text: '置信度 ' + (gen.confidence == null ? '—' : gen.confidence + '%') }),
          gen.source === 'llm' ? h('span', { class: 'dpf-tag', text: '模型深读' }) : h('span', { class: 'dpf-tag', text: '统计归纳' }),
        ]),
        h('div', { class: 'dpf-section-desc' }, [
          h('div', { text: gen.spec.identity.name + ' · ' + (gen.spec.identity.title || '') }),
          h('div', { class: 'dpf-hint', text: gen.spec.identity.oneLiner || '' }),
        ]),
        h('div', { class: 'dpf-section-body' }, [
          gen.note ? h('div', { class: 'dpf-danger-note', text: gen.note }) : null,
          evidenceBox,
          gen.rationale && gen.rationale.length
            ? h('div', {}, [h('strong', { text: '判断依据' }), h('ul', { class: 'dpf-list' }, gen.rationale.map(function (line) { return h('li', { text: line }) }))])
            : null,
          gen.needs && gen.needs.length
            ? h('div', {}, [h('strong', { text: '潜在需求' }), h('ul', { class: 'dpf-list' }, gen.needs.map(function (line) { return h('li', { text: line }) }))])
            : null,
          h('div', { class: 'dpf-row', style: { gap: '8px', flexWrap: 'wrap', marginTop: '6px' } }, [
            h('button', {
              class: 'dpf-btn',
              dataset: { variant: 'primary' },
              type: 'button',
              text: '采纳并启用',
              onclick: function () {
                act(
                  {
                    action: 'create',
                    activate: true,
                    reason: gen.source === 'llm' ? 'auto-llm' : 'auto-heuristic',
                    persona: {
                      name: gen.spec.identity.name,
                      spec: gen.spec,
                      tags: ['自动归纳'],
                      source: gen.source === 'llm' ? 'llm' : 'heuristic',
                      sourceTemplate: gen.templateId,
                      note: gen.note || '',
                      rationale: gen.rationale || [],
                      evidence: gen.evidence || null,
                      confidence: gen.confidence,
                    },
                  },
                  '已采纳归纳结果并启用',
                )
              },
            }),
            h('button', {
              class: 'dpf-btn',
              type: 'button',
              text: '在编译器中打开',
              onclick: function () {
                state.form = {
                  id: null,
                  name: gen.spec.identity.name,
                  tags: ['自动归纳'],
                  note: (gen.rationale || []).join('\n'),
                  spec: clone(gen.spec),
                  source: gen.source === 'llm' ? 'llm' : 'heuristic',
                  sourceTemplate: gen.templateId,
                  dirty: true,
                }
                state.tab = 'editor'
                renderTabs()
                renderBody()
              },
            }),
            h('button', {
              class: 'dpf-btn',
              type: 'button',
              text: '查看编译结果',
              onclick: function () {
                status('编译结果见「编译」标签页', 'ok')
              },
            }),
          ]),
          h('div', { class: 'dpf-hint', text: '倾向说明：采纳后该人格会被记为激活来源（' + (gen.source === 'llm' ? 'auto-llm' : 'auto-heuristic') + '），激活次数越高的模板会越优先出现在推荐位。' }),
        ]),
      ]),
    )
  }

  function runGenerate(mode) {
    state.busy = true
    status(mode === 'llm' ? '正在让模型深读历史对话…' : '正在统计历史对话…')
    post(API.generate, { mode: mode })
      .then(function (result) {
        if (!result.ok) throw new Error((result.error && result.error.message) || '归纳失败')
        state.gen = result.proposal
        applyState(result)
        status('归纳完成：' + result.history.messages + ' 条消息 / ' + result.history.sessions + ' 个会话', 'ok')
      })
      .catch(function (error) {
        status('归纳失败：' + error.message, 'error')
      })
      .then(function () {
        state.busy = false
        if (state.tab === 'generate') renderBody()
      })
  }

  /* ------------------------------------------------------------------ *
   * Tab：设置
   * ------------------------------------------------------------------ */

  function renderSettings() {
    var config = state.data.config || {}
    var paths = state.data.paths || {}
    var traces = state.data.traces || []
    var delivery = state.data.delivery || {}
    var health = state.data.health || { ok: true, issues: [] }

    // ① 数据损坏警告：放在最前面，用户一进来就能看到（不静默用默认值糊过去）
    if (!health.ok) {
      var issueLines = (health.issues || []).map(function (issue) {
        return h('li', {
          text: (issue.file || '').split(/[\\/]/).pop() + ' —— ' + (issue.error || '内容无法解析') +
            (issue.preserved ? '（已备份为 ' + issue.preserved.split(/[\\/]/).pop() + '）' : ''),
        })
      })
      el.body.appendChild(
        h('div', { class: 'dpf-section', style: { borderColor: 'var(--dpf-danger)' } }, [
          h('div', { class: 'dpf-section-head' }, [
            h('strong', { style: { color: 'var(--dpf-danger)' }, text: '⚠ 数据文件损坏' }),
          ]),
          h('div', { class: 'dpf-section-desc', text: health.summary || '检测到数据文件损坏，已暂时使用默认值，你的原始文件没有被覆盖。' }),
          h('div', { class: 'dpf-section-body' }, [
            h('ul', { class: 'dpf-list' }, issueLines),
            h('div', { class: 'dpf-hint', text: '建议：先在文件管理器里看一眼那个文件（可能是手工编辑时少了个括号）。修好了刷新即可；不想修就点下面的按钮，它会先把坏文件改名备份（加 .corrupt-时间 后缀）再重建一份空的。' }),
            h('div', { class: 'dpf-row', style: { gap: '8px', marginTop: '6px' } }, [
              h('button', {
                class: 'dpf-btn',
                dataset: { variant: 'danger' },
                type: 'button',
                text: '备份坏文件并重建',
                onclick: function () {
                  if (!window.confirm('会把损坏的文件改名备份，然后重建一份空的。\n备份文件会保留在同一目录，不会丢。要继续吗？')) return
                  act({ action: 'repair', which: 'all' }, '已备份并重建')
                },
              }),
              h('button', {
                class: 'dpf-btn',
                type: 'button',
                text: '打开数据目录',
                onclick: function () { window.open('file:///' + String(paths.root || '').replace(/\\/g, '/'), '_blank') },
              }),
            ]),
          ]),
        ]),
      )
    }

    // ② 送达自检：明确回答"我改的东西到底有没有进 AI 脑子"
    var deliveryLines = []
    deliveryLines.push(delivery.enabled ? '✔ 总开关：已开启' : '✘ 总开关：已关闭 —— AI 不会按人格回答')
    if (delivery.hasActivePersona) deliveryLines.push('✔ 当前人格：' + (delivery.personaName || '(未命名)'))
    else deliveryLines.push('✘ 没有选中的人格 —— 去「人格库」点一个「使用」')
    if (delivery.willInject) {
      deliveryLines.push('✔ 本次会注入 ' + (delivery.injectedChars || 0) + ' 个字符，约束力：' + delivery.focus)
      deliveryLines.push('→ 结论：下一条消息就会按这个人生格回答。')
    } else {
      deliveryLines.push('→ 结论：当前不会注入任何人格。')
    }
    el.body.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '人格到底生效了吗' })]),
        h('div', { class: 'dpf-section-desc', text: '这里是自检结果，用来回答"我改了设置，AI 到底收到了没有"这个最容易搞不清的问题。' }),
        h('div', { class: 'dpf-section-body' }, [
          h('ul', { class: 'dpf-list' }, deliveryLines.map(function (line) { return h('li', { text: line }) })),
          h('div', { class: 'dpf-row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } }, [
            h('button', {
              class: 'dpf-btn',
              type: 'button',
              text: '看完整注入文本',
              onclick: function () {
                var text = (state.data && state.data.injection) || ''
                if (!text) { status('当前没有可注入的内容', 'error'); return }
                window.alert(text.slice(0, 4000) + (text.length > 4000 ? '\n\n…（已截断）' : ''))
              },
            }),
            h('button', {
              class: 'dpf-btn',
              type: 'button',
              text: '复制注入文本',
              onclick: function () { copyText((state.data && state.data.injection) || '') },
            }),
          ]),
        ]),
      ]),
    )

    el.body.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '什么时候按人格说话' })]),
        h('div', { class: 'dpf-section-body' }, [
          labeled('让 AI 按这份人格回答', h('label', { class: 'dpf-row' }, [
            h('input', {
              type: 'checkbox',
              checked: config.enabled !== false,
              onchange: function (event) { saveConfig({ enabled: event.target.checked }) },
            }),
            h('span', {
              class: 'dpf-hint',
              text: '打勾＝每次提问都把人格规则一起发给 AI。取消勾选＝人格库还在，只是暂时不按它说话。',
            }),          ])),
          labeled('参与归纳的会话数上限', h('input', {
            class: 'dpf-input',
            type: 'number',
            min: 1,
            max: 30,
            value: config.maxSessions,
            onchange: function (event) { saveConfig({ maxSessions: Number(event.target.value) }) },
          })),
          labeled('面板挂载位置', h('div', {}, [
            h(
              'select',
              {
                class: 'dpf-select',
                onchange: function (event) { setPlacement(event.target.value, true) },
              },
              [
                ['toolbar-right', '输入框工具栏右侧（推荐）'],
                ['toolbar-left', '输入框工具栏左侧'],
                ['composer', '输入卡片旁（同一行，卡片外）'],
                ['floating', '右下角悬浮'],
              ].map(function (pair) {
                return h('option', { value: pair[0], text: pair[1], selected: pair[0] === placement })
              }),
            ),
            h('span', { class: 'dpf-hint', text: '宿主 DOM 找不到对应位置时会自动回退到右下角悬浮；选择会写入配置，重启后保持。' }),
          ])),
          labeled('面板形态', h('label', { class: 'dpf-row' }, [
            h('input', {
              type: 'checkbox',
              checked: state.compact === true,
              onchange: function (event) {
                state.compact = event.target.checked
                el.root.dataset.compact = state.compact ? 'true' : 'false'
              },
            }),
            h('span', { class: 'dpf-hint', text: '紧凑模式：只显示圆点，不显示人格名。' }),
          ])),
        ]),
      ]),
    )

    el.body.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '数据位置' })]),
        h('div', { class: 'dpf-section-body' }, [
          h('div', { class: 'dpf-hint', text: '人格库：' + (paths.library || '') }),
          h('div', { class: 'dpf-hint', text: '配置：' + (paths.config || '') }),
          h('div', { class: 'dpf-hint', text: '自定义模板目录：' + (paths.templates || '') }),
          h('div', { class: 'dpf-hint', text: '编译快照：' + (paths.compiled || '') }),
          h('div', { class: 'dpf-row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } }, [
            h('button', { class: 'dpf-btn', type: 'button', text: '复制注入文本', onclick: function () { copyText((state.data && state.data.injection) || '') } }),
            h('button', { class: 'dpf-btn', type: 'button', text: '导出全部数据 (JSON)', onclick: function () { window.open('/dsh-persona-studio/export', '_blank') } }),
            h('button', { class: 'dpf-btn', type: 'button', text: '重新加载', onclick: function () { state.form = null; reload() } }),
          ]),
        ]),
      ]),
    )

    el.body.appendChild(
      h('div', { class: 'dpf-section' }, [
        h('div', { class: 'dpf-section-head' }, [h('strong', { text: '最近的人格切换记录（倾向轨迹）' })]),
        h('div', { class: 'dpf-section-body' }, [
          traces.length === 0
            ? h('div', { class: 'dpf-hint', text: '暂无记录。' })
            : h('ul', { class: 'dpf-list' }, traces.slice(0, 12).map(function (trace) {
                var time = new Date(trace.time).toLocaleString()
                return h('li', { text: time + ' · ' + (trace.kind === 'activate' ? '启用' : trace.kind === 'delete' ? '删除' : trace.kind) + ' ' + (trace.name || trace.personaId || '') + (trace.reason ? '（' + trace.reason + '）' : '') })
              })),
        ]),
      ]),
    )

    el.body.appendChild(
      h('div', { class: 'dpf-hint', text: '提示：在对话里也可以用 /persona list | /persona use <名称> | /persona off 快速操作。' }),
    )
  }

  function saveConfig(patch) {
    act({ action: 'config', config: patch }, '设置已保存')
  }

  function onToggleEnabled(event) {
    saveConfig({ enabled: event.target.checked })
  }

  /* ------------------------------------------------------------------ *
   * 挂载
   *
   * 真实的宿主 DOM（从 dsh-client-ui-conversation 的客户端 bundle 里读出来的契约）：
   *   <div data-composer-seat data-conversation-region="composer">   ← 输入区外层（flex column）
   *     <div class="<hash>_composerStack">
   *       <div data-composer-card>                                   ← 输入卡片（视觉容器）
   *         <div class="<hash>_row">                                 ← 底部工具栏行
   *           <div class="<hash>_tools">   ← 左簇：附件/命令/权限/计划 + conversation.input.left
   *           <div class="<hash>_trailing"> ← 右簇：*.input.right / 模型选择 / 发送
   *         </div>
   *       </div>
   *     </div>
   *   </div>
   *
   * CSS module 的哈希前缀会随构建变化（例如 Dc7zOa_），所以只按 `_<slot>` 后缀匹配，
   * 不硬编码前缀；data-* 属性名才是稳定契约。
   * ------------------------------------------------------------------ */

  var PLACEMENTS = ['toolbar-right', 'toolbar-left', 'floating', 'composer']
  /** 用户/config 期望的位置 */
  var desiredPlacement = 'toolbar-right'
  /** 本次实际生效的位置（期望位置暂时找不到锚点时降级为 floating，下一轮会自动复原） */
  var placement = 'toolbar-right'

  var CSS_SLOT = {
    'toolbar-right': 'trailing',
    'toolbar-left': 'tools',
  }

  function findComposer() {
    var candidates = ['[data-composer-seat]', '[data-composer-card]', '[data-composer-input]']
    for (var i = 0; i < candidates.length; i++) {
      var node = document.querySelector(candidates[i])
      if (node) return node
    }
    return null
  }

  function classTokens(node) {
    var raw = (node && node.className) || ''
    if (typeof raw !== 'string') raw = node && node.getAttribute ? node.getAttribute('class') || '' : ''
    return raw.split(/\s+/).filter(Boolean)
  }

  /** 精确匹配 `_trailing` / `_tools` 这种 CSS module 后缀。 */
  function findBySlot(root, slot) {
    if (!root || !root.querySelectorAll) return null
    var suffix = '_' + slot
    var all = root.querySelectorAll('[class]')
    for (var i = 0; i < all.length; i++) {
      var tokens = classTokens(all[i])
      for (var j = 0; j < tokens.length; j++) {
        var token = tokens[j]
        if (token === slot || token.slice(-suffix.length) === suffix) return all[i]
      }
    }
    return null
  }

  function setPlacement(next, remember) {
    var value = PLACEMENTS.indexOf(next) === -1 ? 'floating' : next
    desiredPlacement = value
    placement = value
    if (el.root) el.root.dataset.placement = value
    if (remember) saveConfig({ placement: value })
    mount(true)
  }

  /**
   * 给按钮和面板定位。
   *
   * 关键点：**按钮和面板都用视口坐标固定定位**。
   *
   * 之前面板是相对"输入框工具栏那一行"做的绝对定位，踩了两个坑（用户实测反馈
   * 「编辑人格时上一个界面容易被覆盖/挡住」）：
   *   1) 输入框在窗口底部，面板往上顶出屏幕，内容被截断；
   *   2) 那一行所在的容器若有 transform / filter / contain 之类的属性，
   *      会变成 fixed 的包含块，导致面板被裁剪或压到聊天内容下面。
   *
   * 现在：按钮按锚点元素的屏幕矩形摆放（视觉上仍旧贴在那一排按钮里），
   * 面板完全用视口坐标，并自动决定往上还是往下展开。
   */
  function applyPosition() {
    var root = el.root
    var anchorRect = el.anchorEl && el.anchorEl.getBoundingClientRect ? el.anchorEl.getBoundingClientRect() : null

    // 按钮：重置内联样式，再按需要摆放
    root.style.position = ''
    root.style.right = ''
    root.style.bottom = ''
    root.style.left = ''
    root.style.top = ''
    root.style.marginLeft = ''
    root.style.alignSelf = ''

    var pillH = (root.getBoundingClientRect && root.getBoundingClientRect().height) || 30
    var viewportW = window.innerWidth || 1400
    var viewportH = window.innerHeight || 800
    var margin = 12
    var gap = 8

    if (placement === 'floating') {
      root.style.position = 'fixed'
      root.style.right = '18px'
      root.style.bottom = '84px'
      root.style.zIndex = '9998'
      anchorRect = null
    } else if (anchorRect) {
      // 贴着锚点：垂直居中于锚点（通常就是输入框那一行），水平放在锚点左侧
      var rootRect = root.getBoundingClientRect ? root.getBoundingClientRect() : { width: 100 }
      var pillW = rootRect.width || 100
      root.style.position = 'fixed'
      root.style.zIndex = '9998'
      root.style.top = Math.max(margin, Math.round(anchorRect.top + anchorRect.height / 2 - pillH / 2)) + 'px'
      root.style.left = Math.max(margin, Math.round(anchorRect.left - pillW - gap)) + 'px'
    }

    // 面板：同样固定定位，并压过聊天层
    var panel = el.panel
    panel.style.position = 'fixed'
    panel.style.zIndex = '2147483000'
    panel.style.left = 'auto'
    panel.style.right = ''
    panel.style.top = ''
    panel.style.bottom = ''
    panel.style.maxHeight = ''

    // 用按钮当前的真实位置来算展开方向（按钮此时已经摆好了）
    var rect = root.getBoundingClientRect ? root.getBoundingClientRect() : null
    if (!rect) return

    // 贴着锚点时以锚点自身为基准：按钮可能被视口边缘夹住（clamp），
    // 直接拿按钮位置会导致面板压到锚点上。
    var reference = anchorRect || rect
    var spaceAbove = reference.top - gap - margin
    var spaceBelow = viewportH - reference.bottom - gap - margin
    var openUp = spaceAbove >= Math.min(320, viewportH * 0.45) || spaceAbove >= spaceBelow
    var available = Math.max(180, Math.floor(openUp ? spaceAbove : spaceBelow))
    // 高度上限：不填满可用空间，最多占窗口的 2/3。
    // 这样面板贴着输入框往上长，视觉上仍然靠近输入框，
    // 而不是一路顶到屏幕上沿（用户反馈过"位置太上面了"）。
    var height = Math.round(Math.min(680, viewportH * 0.66, available))
    panel.style.maxHeight = height + 'px'

    if (openUp) {
      // 向上展开时用"离底部多远"定位：面板**紧贴输入框**往上长，
      // 而不是按高度反推顶部坐标。后者会把面板顶端顶到屏幕上沿，
      // 看起来"位置太上面了"（用户实测反馈）。
      // 高度已经被 maxHeight 夹在可用空间内，所以不会跑出屏幕。
      panel.style.bottom = Math.max(margin, Math.round(viewportH - reference.top + gap)) + 'px'
    } else {
      panel.style.top = Math.max(margin, Math.round(reference.bottom + gap)) + 'px'
    }

    // 水平：默认与按钮右对齐；会超出右边界就改成左对齐
    var panelRect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null
    var width = (panelRect && panelRect.width) || Math.min(880, viewportW - 32)
    var rightEdge = reference.right
    if (rightEdge - width < margin) {
      panel.style.left = margin + 'px'
      panel.style.right = 'auto'
    } else {
      panel.style.left = 'auto'
      panel.style.right = Math.max(margin, Math.round(viewportW - rightEdge)) + 'px'
    }
  }

  function place(force) {
    var composer = findComposer()
    if (!composer) return false

    if (placement === 'toolbar-right' || placement === 'toolbar-left') {
      var seat = findBySlot(composer, CSS_SLOT[placement])
      if (!seat) return false
      // 记下锚点：按钮的屏幕位置就是按它算的（见 applyPosition）
      el.anchorEl = seat
      if (el.root.parentNode !== seat) seat.appendChild(el.root)
      return true
    }

    if (placement === 'composer') {
      var seatHost = document.querySelector('[data-composer-seat]') || composer
      var host = seatHost && seatHost.parentNode
      if (!host) return false
      el.anchorEl = seatHost
      if (el.root.parentNode !== host) host.appendChild(el.root)
      return true
    }

    // floating：挂在 body 上，按视口右下角固定摆放
    el.anchorEl = null
    if (force || !el.root.parentNode || el.root.parentNode !== document.body) {
      var target = document.body || document.documentElement
      if (!target) return false
      target.appendChild(el.root)
      return true
    }
    return el.root.parentNode === document.body
  }

  function mount(force) {
    if (!el.root) return false
    // 已经挂好的话，除了强制重排，直接复用
    if (!force && el.root.parentNode && el.root.isConnected) {
      applyPosition()
      return true
    }

    // 先按期望位置放；锚点暂时不存在时降级为浮动兜底，但**不修改期望值**，
    // 这样宿主稍后渲染出输入区时，下一次 mount() 会自动回到期望位置。
    placement = desiredPlacement
    var placed = place(force)
    if (!placed) {
      placement = 'floating'
      if (el.root) el.root.dataset.placement = 'floating'
      place(true)
      applyPosition()
      return false
    }
    if (el.root) el.root.dataset.placement = placement
    applyPosition()
    return true
  }

  function open() {
    state.open = true
    el.panel.dataset.open = 'true'
    mount()
    if (!state.loaded) {
      reload().then(function () {
        renderAll()
      })
    }
    // 面板显示后尺寸才可测，这时再按实际几何重算一次位置
    // （包括"上面放不下就翻到下面"和水平方向的左右对齐）。
    requestAnimationFrame(function () {
      applyPosition()
    })
  }

  function close() {
    state.open = false
    el.panel.dataset.open = 'false'
  }

  function toggle() {
    if (state.open) close()
    else open()
  }

  function init() {
    if (document.querySelector('.dpf-root')) return
    buildUi()
    mount()
    setThemeAttr()
    // 宿主没渲染出输入区之前，先按浮动兜底；DOM 一出现就重挂到配置的位置
    var settleTimer = setTimeout(function () {
      mount(true)
    }, 600)
    document.addEventListener('keydown', function (event) {
      if (event.ctrlKey && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
        event.preventDefault()
        toggle()
      }
      if (event.key === 'Escape' && state.open) close()
    })
    document.addEventListener('click', function (event) {
      if (!state.open) return
      if (!el.root.contains(event.target)) close()
    })
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setThemeAttr)
      } catch (error) {
        /* 老浏览器忽略 */
      }
    }
    // 宿主切换主题 / 重挂 composer 时跟随
    var observer = new MutationObserver(function () {
      setThemeAttr()
      mount()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-composer-seat', 'data-composer-card'] })
    void settleTimer

    // 首屏预热一次状态，让按钮上直接显示当前人格名
    reload()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // 调试/自检入口：便于在浏览器控制台里手动重排、查看当前挂载位置与预览诊断。
  window.__DSH_PERSONA_FORGE_API__ = {
    remount: function () {
      return mount(true)
    },
    placement: function () {
      return placement
    },
    state: function () {
      return state
    },
    /** 把一份 /state 响应直接喂给面板（自检/调试用） */
    applyState: function (payload) {
      applyState(payload)
    },
    diagnostics: function () {
      return {
        preview: diag.preview,
        save: diag.save,
        events: diag.events,
        placement: placement,
        desiredPlacement: desiredPlacement,
        formId: state.form && state.form.id,
        formDirty: !!(state.form && state.form.dirty),
        changedFields: changedFieldLabels(state.form && state.form.spec),
        specSections: state.form && state.form.spec ? Object.keys(state.form.spec) : [],
      }
    },
    open: open,
    close: close,
  }
})()
