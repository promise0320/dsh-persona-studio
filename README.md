# dsh-persona-studio · 人格编译工坊

> 给 DeepSeek Harness 装一间「人格车间」：把 LLM 的**对话风格、创作习惯、反馈方式、语气语调**编译成一份可版本化、可预览、可复用的规格；
> 可以直接调用内置/自定义人格模板，也可以让它**读你过往的对话记录、归纳你的潜在需求**，自动生成人格并形成稳定的协作倾向。
> 对应的 UI 就挂在主界面（输入框工具栏 / 右下角悬浮按钮），不需要离开对话。

> **注意：本插件原名 `dsh-persona-forge`，现已改名为 `dsh-persona-studio`。**
> 原因：原名与 npm 上已有的一个插件撞名（那个是"改写你发出的消息"，与本插件"配置助手人格"不是一回事）。
> 改名后需要**重启一次 DSH** 才能生效 —— 正在运行的宿主仍然认得旧名字。
> 数据目录没有跟着改（仍是 `$DSH_HOME/persona/`），你的人格库不会因为改名而丢。

**English summary** — Compile an LLM persona inside DeepSeek Harness from six dimensions
(identity, tone, creative habits, feedback style, boundaries, run parameters), preview the compiled
text live, and inject it at the end of the system prompt. Ships six built-in templates plus a
drop-in templates folder, and drafts a persona from your own past messages — either by counting
patterns or by having the current model read them and report its rationale. Zero dependencies,
zero build step; the loader half is plain ESM and the browser half is plain JavaScript served
over the plugin's own HTTP route. Adds a panel next to the composer and a `/persona` command.

---

## 1. 它解决什么问题

普通人调「人格」的方式是写一段系统提示词 —— 不可复用、不可对比、改坏了不知道。
这个插件把人格拆成**六个维度、41 个字段**，每个字段都有明确的语义与刻度，然后编译成一段确定性的提示词：

| 维度 | 回答的问题 | 典型字段 |
| --- | --- | --- |
| 身份设定 | 你是谁、怎么称呼我 | 人格名、头衔、称呼、自称、一句话定位 |
| 对话风格 · 语气语调 | 怎么说 | 语气基调、篇幅倾向、热情度、正式度、直接程度、幽默感、emoji、比喻、标点风格、口头禅、禁用表达、语言偏好 |
| 创作习惯 | 怎么干活 | 动手前规划、回答结构、探索↔实现、验证习惯、注释与命名、交付形态、主动程度、风险偏好、自定义习惯 |
| 反馈方式 | 怎么回应我 | 不确定时怎么办、怎么指出问题、建议颗粒度、肯定频率、追问策略、过程汇报、自己犯错时、自定义规则 |
| 边界与红线 | 什么绝不让步 | 必须始终做到、绝对不做、补充说明 |
| 运行参数 | 工程细节 | temperature、开头是否重复强化、聚焦等级 |

「**聚焦等级**」是这个插件最重要的一个开关：

- `strict` —— 风格是强制约束，除非与安全/事实/你当次的显式指令冲突；
- `balanced`（默认）—— 风格只管「怎么说、怎么组织、怎么推进」，**不改变任务事实与你的显式指令**，冲突时以你的指令为准；
- `off` —— 本次不注入人格。

---

## 2. 三个核心能力

### ① 编译人格（可预览、可回滚）

「编译」标签页左边是表单、右边是**实时编译结果**——改一个刻度，右边立刻显示将被注入系统提示词的最后那段文本（用 `<persona>…</persona>` 包裹，落在 `DEPLOYMENT_PERSONA_SUFFIX` 之后，即整个系统提示词的收尾处）。
保存即生效：下一次模型请求就会带上新人格，不需要重启、不需要重开对话。

### ② 调用现成模板

- **内置 6 套**：严谨工程师、系统架构师、苏格拉底导师、中文文字匠、极简执行者、结对编程搭子；
- **自定义模板文件**：把 `*.json` 丢进 `<人格库目录>/templates/` 即可出现在「模板」页里。格式：

  ```json
  {
    "name": "我的搭子",
    "tags": ["私有"],
    "summary": "一句话说明",
    "spec": { "style": { "tone": "casual", "directness": 90 } }
  }
  ```

  只写想覆盖的字段即可，其余走默认值。也可以直接是一份裸 spec。
- 导出/导入：`GET /dsh-persona-studio/export` 会下载完整的人格库 JSON（含配置与激活记录），可跨机器迁移。

### ③ 从历史对话自动归纳

「自动归纳」页有两种模式：

- **统计归纳（默认，零成本）**：读取最近若干在线会话里"你说的话"，统计消息长度分布、列表/代码块占比、祈使句比例、礼貌用语、emoji、语气强度、报错语境、规划语境等，
  把它们映射成一份人格草案，并给出**判断依据**与**潜在需求**（例如"反复出现报错语境 → 要求跑命令验证 + 按严重度列问题"）。
- **模型深读（消耗额度，更细腻）**：复用**你当前会话正在使用的模型**（自动捕获路由，无需配置），把对话样本交给它归纳，
  要求它输出人格 JSON + 依据 + 你**没说出口但反复出现的需求**；失败会自动回落到统计归纳并说明原因。

归纳结果可以「采纳并启用」，也可以先丢进编译器里改。每次采纳/切换都会写进 `traces.jsonl`（倾向轨迹），在「设置」页可以看到最近记录。

---

## 3. 界面在哪里

面板默认挂在**输入框工具栏右侧**（`conversation.input.right` 那一簇，和模型选择器同一行）。
锚点是宿主客户端 bundle 里的稳定契约，不是猜的：

```
[data-composer-seat]                     ← 输入区外层
  └ .<hash>_composerStack
      └ [data-composer-card]             ← 输入卡片
          ├ [data-composer-input]        ← 可编辑输入框
          └ .<hash>_row                  ← 底部工具栏行
              ├ .<hash>_tools            ← 左簇（附件/命令/权限/计划）
              └ .<hash>_trailing         ← 右簇（模型选择/发送）★ 默认挂这里
```

CSS module 的哈希前缀（如 `Dc7zOa_`）会随构建变化，所以只按 `_trailing` / `_tools`
后缀匹配，不硬编码前缀；找不到锚点时自动降级为右下角悬浮，**不会消失**。

| 位置 | 内容 |
| --- | --- |
| 输入框工具栏右侧（默认） | 「人格」圆形按钮：显示当前人格名，点开即面板 |
| 面板 · 人格库 | 卡片列表，一键「使用 / 编辑 / 复制 / 删除」 |
| 面板 · 模板 | 内置与文件模板，一键实例化 |
| 面板 · 编译 | 六维度表单 + 实时编译预览 + 保存并启用 |
| 面板 · 自动归纳 | 统计归纳 / 模型深读、依据与潜在需求、采纳 |
| 面板 · 设置 | 挂载位置、全局注入开关、归纳会话数上限、紧凑模式、数据路径、导出、倾向轨迹 |
| 对话内 | `/persona`、`/persona list`、`/persona use <名称或ID>`、`/persona on|off`、`/persona path` |

挂载位置可在「设置」页切换（右侧工具栏 / 左侧工具栏 / 输入卡片旁 / 右下角悬浮），
选择会写进 `config.json` 并在重启后保持。快捷键：`Ctrl+Shift+P` 开合面板，`Esc` 关闭。

浏览器控制台里还有自检入口：`__DSH_PERSONA_FORGE_API__.remount() / .placement() / .state()`。

---

## 4. 安装

### 方式 A：脚本（推荐）

```powershell
# Windows
pwsh -File scripts/install.ps1                  # 默认 profile = desktop
pwsh -File scripts/install.ps1 -Profile web     # 指定 profile
```

```bash
# macOS / Linux
bash scripts/install.sh desktop
```

脚本做三件事（幂等）：在 `<profile>/node_modules` 建目录联接、在 `package.json` 登记依赖与 bundle、在 `cordis.patch.yml` 插入挂载行。
**改完必须重启一次 DSH**（bundle 列表在启动时解析）。

### 方式 B：手动

1. 把本目录放到任意位置，并在 profile 的 `node_modules` 下建一个指向它的联接（Windows 用 junction）；
2. `<profile>/package.json`：
   ```json
   "dependencies": { "dsh-persona-studio": "0.1.0" },
   "dsh": { "profile": { "bundles": ["…", "dsh-persona-studio"] } }
   ```
3. `<profile>/cordis.patch.yml` 末尾追加：
   ```yaml
   - insert:
       - id: dsh-persona-studio
         name: dsh-persona-studio
   ```
4. 重启 DSH。

### 验证

```powershell
# 宿主路由应该返回 JSON
Invoke-WebRequest http://127.0.0.1:19387/dsh-persona-studio/state -UseBasicParsing
# 页面里应能看到 injected 的 bootstrap 脚本
(Invoke-WebRequest http://127.0.0.1:19387/ -UseBasicParsing).Content -match 'dsh-persona/bootstrap.js'
```

### 卸载

```powershell
pwsh -File scripts/uninstall.ps1                 # 保留人格库数据
pwsh -File scripts/uninstall.ps1 -RemoveData     # 连数据一起删
```

---

## 5. 数据放在哪

全部在 `$DSH_HOME/persona/`（默认 `~/.dsh/persona/`），升级 DSH 不会丢：

| 文件 | 内容 |
| --- | --- |
| `library.json` | 人格库 + 当前激活人格 |
| `config.json` | 注入开关、归纳参数等运行配置 |
| `templates/*.json` | 你放进去的自定义模板 |
| `compiled.txt` | 当前人格编译出的提示词快照（便于查看/交接） |
| `traces.jsonl` | 激活/采纳/删除记录（倾向轨迹） |

---

## 6. 自检

不启动 DSH 也能跑（用自带的 Node 即可）：

```powershell
node test/smoke.mjs     # 规格/编译/归纳/HTTP/损坏保护/送达自检/BOM 卫生（44 项）
node test/apply.mjs     # 宿主接线：section 注册、路由表、注入行、命令、损坏拒绝、模型兜底（14 项）
node test/panel.mjs     # 面板 UI：挂载、回退、预览联动、编辑保持、损坏警告（26 项）
```

`test/panel.mjs` 用最小 DOM 桩在 Node 里真实执行 `assets/panel.js`，并且**复刻了宿主真实的
输入区结构**（`[data-composer-seat] > _composerStack > [data-composer-card] > _row > _trailing`），
所以"按钮挂在输入框工具栏右侧""锚点缺失时降级到悬浮""切换位置立即重挂并落盘"
"改参数预览跟着变""离开编译页回来不丢编辑""数据坏了会警告"这些行为不需要开浏览器就能回归验证。

其中 `/preview` 的测试桩**用真实编译器编译请求里的规格**，所以"预览随编辑变化"是被真验证的，
而不是固定返回同一段文字 —— 这一点曾经让测试漏掉了"预览不更新"的真实 bug，已修正。

三个测试脚本在**断言失败时都会以非零退出码结束**，并且都接得住异步检查里的失败\n（`apply.mjs` / `smoke.mjs` 曾经漏了这两条：失败既不计数也不改退出码，\n汇总行还会打印"全部通过" —— 这类"绿着失败"的测试比没有测试更危险，已修）。

## 7. 数据安全

人格库和配置都在 `$DSH_HOME/persona/` 下，是本插件的"家底"。做了这几层保护：

| 保护 | 行为 |
| --- | --- |
| 原子写入 | 先写临时文件再 `rename`，中途断电/崩溃不会留下半份文件 |
| 损坏检测 | 读取时区分"文件不存在"和"内容坏了"，不再一律当成空 |
| **拒绝覆盖** | 文件内容坏了时，**所有写操作整体被拒绝**（不是"改一半"），避免用一份空数据把你的人格抹掉 |
| 保留原件 | 恢复动作不会删除坏文件，而是改名成 `xxx.json.corrupt-<时间>` 存着 |
| 界面可见 | 损坏时设置页顶部出现红色警告，点名是哪个文件、什么错、并提供恢复按钮 |
| 逃生口 | 警告里的「备份坏文件并重建」＝先备份再写默认值，坏文件始终留着 |

> 为什么值得做：以前的实现把"读失败"和"文件不存在"一起处理，
> 结果是**坏文件会在下一次保存时被默认值静默覆盖**。现在这条路径被堵住了。

### 已修复的重要 bug（留作前车之鉴）

| 现象 | 根因 |
| --- | --- |
| 改参数预览不变 / 离开编译页编辑被重置 / 保存后人格库不变 | `describeSpec()` 漏给字段带 `section`，前端把修改全写进 `spec.undefined`。**同一个根因导致三个现象** |
| 命令行发中文请求被拒（400） | 人格编号含中文，终端二次编码损坏。现在编号纯 ASCII，保存旧编号会自动升级 |
| 面板被输入框或聊天内容挡住 | 面板相对工具栏定位，锚点容器若有 transform 会成为包含块。现在按钮与面板都用视口坐标定位，并自动决定向上/向下展开 |
| 在编译页待久了回不到其他页签 | 表单变长后页签栏被滚走。现在页签吸顶 |
| **插件完全不加载（连报错都很少）** | `package.json` / `cordis.patch.yml` 开头被写入了 **BOM**（不可见字符），JSON 直接解析失败 |
| **安装脚本运行到一半报"缺少 Text 参数"** | PowerShell 的管道输出不会自动绑到普通函数的参数上，须先收进变量再按名字传 |
| **`.ps1` 脚本里的中文变乱码、语法坏掉** | 脚本自身缺 UTF-8 BOM，PowerShell 5.1 按 ANSI 读取 |

### BOM 这件事的结论（值得记住）

同一个「BOM」在两类文件上要求**正好相反**，测试里按扩展名分开钉住：

| 文件 | 要不要 BOM | 为什么 |
| --- | --- | --- |
| `package.json`、`cordis.patch.yml`、`.js` / `.mjs` / `.css` / `.md` | **绝不能有** | `JSON.parse` 会把 BOM 当非法字符直接抛错 |
| `.ps1`（PowerShell 脚本） | **必须有** | PowerShell 5.1 没有 BOM 时按 ANSI 读，中文注释会变乱码并破坏语法 |

配套规则：写 profile 的配置文件**只能用** `Write-Utf8NoBom`（脚本内已提供），
不能用 `Set-Content -Encoding UTF8` —— 后者在 PowerShell 5.1 下会加 BOM。

---

## 8. 设计约束（为什么它不会「越权」）

- 人格只注入**提示词**，不修改任何工具行为、权限或沙箱策略；
- `balanced` 下人格永远让位于你的显式指令与任务事实；
- 路由只监听本机回环，且拒绝 `Sec-Fetch-Site: cross-site` 与跨源 `Origin`；
- 所有写入都是「临时文件 + 原子重命名」；文件损坏时**拒绝覆盖**而不是默默回落；
- 前端面板是纯 DOM + 前缀类名（`.dpf-`），不依赖任何构建产物，改完刷新页面即生效。

## 9. 许可

MIT
