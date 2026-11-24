---
name: "电工电子技术虚拟仿真实训"
description: "面向电工、模电、数电教学的 3D 实训台与虚拟仪器桌面工作台设计系统"
colors:
  primary: "oklch(0.546 0.245 262.881)"
  primary-foreground: "oklch(0.985 0 0)"
  background: "oklch(1 0 0)"
  foreground: "oklch(0.141 0.005 285.823)"
  card: "oklch(1 0 0)"
  secondary: "oklch(0.967 0.001 286.375)"
  secondary-foreground: "oklch(0.21 0.006 285.885)"
  muted: "oklch(0.967 0.001 286.375)"
  muted-foreground: "oklch(0.552 0.016 285.938)"
  border: "oklch(0.92 0.004 286.32)"
  ring: "oklch(0.623 0.214 259.815)"
  success: "oklch(0.627 0.194 149.214)"
  warning: "oklch(0.666 0.179 58.318)"
  destructive: "oklch(0.577 0.245 27.325)"
  scope-screen: "oklch(0.2 0.01 250)"
  scope-grid: "oklch(0.42 0.01 250)"
  scope-ch1: "oklch(0.86 0.17 95)"
  scope-ch2: "oklch(0.78 0.13 220)"
typography:
  title:
    fontFamily: "Noto Sans SC Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Noto Sans SC Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Noto Sans SC Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  mono-data:
    fontFamily: "JetBrains Mono Variable, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  lcd-readout:
    fontFamily: "DSEG7 Classic, monospace"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.1
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  instrument-panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px"
  oscilloscope-screen:
    backgroundColor: "{colors.scope-screen}"
    textColor: "{colors.scope-ch1}"
    rounded: "{rounded.sm}"
    padding: "8px"
---

# Design System: 电工电子技术虚拟仿真实训

本文件是前端界面、3D 视口构图与虚拟仪器面板的强制设计规范（派生自 [PRD](电工电子技术虚拟仿真教学软件PRD.md) 第 15 节与 [技术设计](docs/技术设计.md) §10.3、§11）。任何新增或修改前端组件、实训模块面板与仪表的会话均须遵守本规范。

## Overview

**Creative North Star: "The Precision Lab Bench（精密教学实训台）"**

软件面向高校与职业院校课堂投屏及机房实训，界面基调遵循专业 EDA 软件（KiCad、Multisim）的信息秩序与真实台式仪器（Rigol、UNI-T）的物理直觉。应用外框保持克制安静，把视觉面积与对比度集中让渡给 **3D 台面有效器材区** 与 **正在操作的仪器读数/波形**。

拒绝一切营销页、装饰性动效与“AI 模板味”视觉噪音：不使用渐变背景、毛玻璃、发光阴影、紫色/靛蓝默认主色、卡片套卡片或装饰性符号。

**Key Characteristics:**
- **阶段化空间让渡**：接线时收折冗余工具条与底栏把 3D 视口放到最大，调测时聚焦单台主仪器（支持双表对比与站内大浮层），告别双轴滚动与四面挤压。
- **免切镜高效接线**：3D 动态围绕当前有效设备构图，跨设备连线提供拉线快捷端子浮窗与原理图两点直连，特写常驻清晰插孔标注，自动极性色默认开启。
- **零冲突直觉操控**：3D 滚轮专职缩放、点击旋钮就地弹出微调浮窗，导线端点可见可拖拔改接，诊断项点哪指哪。
- **工程级数值纪律**：等宽数字对齐、SI 工程单位换算、隐藏一切代码内部标识与超长浮点尾数。

## Colors

中性锌灰（Zinc）承载安静结构外框，单一工程蓝承担主操作与焦点环，高对比语义色严格绑定电气与安全状态。所有颜色唯一真源为 `src/renderer/styles/globals.css` 中的 OKLCH 变量，`src/renderer/components/ui/` 之外禁止硬编码十六进制或 RGB 色值。

### Primary
- **Bench Action Blue** (`oklch(0.546 0.245 262.881)`): 仅用于当前主动作（如“上电”“完成当前步骤”）、选中面板内环（`ring-primary`）、键盘焦点环与 3D 悬停/待接线高亮环。

### Neutral
- **Lab Bright Canvas** (`oklch(1 0 0)`): 默认浅色背景（保障教室强光投影清晰可读；深色模式对应 `oklch(0.141 0.005 285.823)`）。
- **Console Muted Surface** (`oklch(0.967 0.001 286.375)`): 3D 视口衬底、次级工具条与未激活胶囊背景。
- **Hairline Divider** (`oklch(0.92 0.004 286.32)`): 分栏与仪器区块之间的 `1px` 结构分割线。

### Semantic & Electrical Colors
- **Energized / Pass Green** (`oklch(0.627 0.194 149.214)`): 已上电状态、拓扑检查通过、已完成步骤。
- **Range / Guardrail Amber** (`oklch(0.666 0.179 58.318)`): 超量程警告、带电改线拦截、仿真慢于实时提示、数据合理性超界提示。
- **Short / Fault Red** (`oklch(0.577 0.245 27.325)`): 断电破坏性操作、电源短接/烧表危险告警、故障报错。
- **Oscilloscope CRT Palette**: 屏幕固定暗底 `oklch(0.2 0.01 250)`，CH1 轨迹黄 `oklch(0.86 0.17 95)`，CH2 轨迹青 `oklch(0.78 0.13 220)`（与真实示波器 BNC 通道色环一致）。
- **GB/T 2681 导线色**: 正极/相线红、负极/地线黑、三相黄/绿/红、零线淡蓝、保护接地黄绿双色；所有颜色选项必须配中文文字标签。

### Named Rules
**The Semantic Purity Rule.** 红、琥珀、绿三种语义色只表达真实电气或任务状态，严禁挪作装饰徽章或背景点缀。

## Typography

**Body Font:** `Noto Sans SC Variable`（全部本地离线打包，禁止远程字体请求）
**Mono / Data Font:** `JetBrains Mono Variable`（启用等宽数字 `tabular-nums`）
**Instrument LCD Font:** `DSEG7 Classic`（仅用于万用表、稳压电源、信号发生器与频率计数码屏主读数）

### Hierarchy
- **Title** (`500`, `16px`–`18px`, `1.4`): 顶栏项目标题、弹窗标题；全应用标题上限 `18px`。
- **Section Heading** (`500`, `14px`, `1.4`): 分栏栏头（仪表柜、接线、双通道数字示波器）。
- **Body** (`400`, `14px`, `1.6`): 实训指导正文、步骤说明（阅读行宽控制在 `65–75ch` 内）。
- **Dense Table & Control** (`400`–`500`, `13px` / `12px`, `1.4`): 数据记录表、旋钮标签、状态栏；`12px`（`text-xs`）为全局最小字号下限。
- **Classroom Presentation Scale**: 开启“演示模式”（`html[data-font-scale="1.25"]`）时根字号整体放大 `1.25×`，所有布局不得出现横向截断或双滚动溢出。

### Named Rules
**The SI Spacing & Precision Rule.** 数值与 SI 单位之间固定留一个半角空格（写作 `12.0 V`、`18 kΩ`、`2.50 kHz`，不写 `12V` 或裸 `18000 Ω`）；数据表回显按仪表分辨率收敛有效位数（`title` 悬停可保留原始采集精度），禁止直接向学生展示 `3.160615444` 类浮点尾数。

## Layout

核心练习工作台采用 `react-resizable-panels` 全屏无外层滚动壳体（`1366×768` 至 `4K` 零页面级滚动溢出）：

1. **水平三栏与阶段化布局预设（The Stage-Aware Bench Rule）**：
   - 默认标准态：**左栏 `18%`**（`minSize: 220px`，实训指导 / 交互原理图 / 步骤）: **中区 `62%`** : **右栏 `20%`**（`minSize: 220px`，可折叠仪表柜 + 接线/模块控件/排故）；中区默认 **上 `66%` 3D 视口 : 下 `34%` 底栏工作台**（`minSize: 160px`）。
   - 顶栏提供场景预设与三栏快捷开关：**`接线专注`**（自动收起底栏与仪表柜，将 3D 视口高度最大化）、**`调测专注`**（自动收起右栏并扩高底栏至约 `46%`，便于完整观察示波器/电源与实时读数），以及一键“专注台面”全收/全开。
   - 右栏“仪表柜”在放置完台式仪表后支持一键折叠为紧凑单行（显示已放台数与快捷展开），不长期挤占接线与诊断高度；右侧栏严禁将同一条状态提示在仪表柜与接线区重复渲染两次。
2. **3D 视口单一顶条与动态有效构图（The Content-Aware Framing Rule）**：
   - **视口 Chrome 减法**：3D 视口只保留**单行紧凑工具条**（预设视角、聚焦设备下拉、参考接线、导线透视、插孔标注、紧凑画质三档），**严禁叠加第二行带横向滚动条的设备胶囊栏或常驻底部长文字说明栏**；右上角放置极简电源状态徽章（就近上电/断电）；首次操作指引改为不遮挡主设备的轻量提示并在首次点击台面时自动收起。
   - **动态围绕有效器材构图**：默认 `work`（操作视角）不再框死整台 `1.78 m` 空机架，而是围绕**当前项目已挂载实验挂箱 + 控制屏电源 + 已放置台式表 + 已接线固定表**的联合包围盒动态计算视距（裁除 `Y < 0.78 m` 桌腿与右侧空挂箱洞）；开始从仪表柜拖拽新表时平滑拉远至全桌位可见视图（确保 `SLOT_DESK_1..4`、`SLOT_SCOPE` 均可见落点）。实验挂箱密集插孔在全景下仍保持 `< 14 px` 间距（单击进正对特写，防误触插孔）。
3. **底栏仪器坞“主表大视图 + 统一活跃切换条”（The Focused-Stage Dock Rule）**：
   - **默认隐藏未接线固定表**：底栏不再把 5~7 台仪器强行塞进同一排横向滚动条，也不再单占一行“折叠未接线仪表”说明条。活跃仪器定义为：**已放置台式仪器 + 项目主电源 + 已接线固定仪表 + 用户手动展开的固定仪表**；其余未接线固定表统一收拢至顶行右侧的 **`+ 其他固定表`** 下拉入口，点选即加入活跃条并切为主表。
   - **统一读数切换条**：底栏顶部 `TabsList` 右侧的实时读数条同时承担**活跃仪器切换器**职责（展示各活跃仪器名称与 10 Hz 节流实时读数），无论处于“仪表”“数据记录”还是“曲线”页均常驻可见。
   - **单表舒展 + 双表对比 + 站内大浮层**：默认**单主表独占 100% 底栏宽度**（无横向滚动条；示波器左屏右控，直流电源与信号发生器同步采用宽容器横排双栏布局，避免 130px 矮槽竖向狂滚）；提供一键 **`[单表 | 双表]`** 对比切换（最多并排 2 台正在用的表，满足 PRD 15.3 嵌套可调分栏）；每台仪表面板标题栏同时提供 **站内放大（居中大尺寸 `Dialog`，零滚动完整调参）** 与 **弹出为独立窗口**（供双屏/投屏）。

## Elevation & Depth

界面静止态采用**扁平 `1px` 边框分层（Flat-By-Default）**，不在面板内部叠加阴影卡片。

- **Surface Separation**: 靠 `1px solid var(--border)` 与背景/次级底色（`--background` vs `--muted/30`）区分区域。
- **Floating Overlays Only**: 柔和阴影（`shadow-sm` / `shadow-md`）仅用于脱离文档流的浮层——下拉菜单、命令面板（`Ctrl+K`）、站内大仪器浮层、拉线快捷端子浮窗、3D 旋钮就地微调浮窗、导线端点操作条与 3D 插孔 `<Html>` 标签。
- **3D Scene Depth**: 仅使用本地 CC0 影棚 HDRI 与台面高度（`workSurface.max[1]`）接触阴影，禁止开启泛光（Bloom）、景深（DoF）或 SSAO 后期。

## Shapes

沿用 `shadcn/ui`（`radix-nova`）预设圆角阶梯（基础 `--radius: 0.625rem`），不自行放大圆角：
- 面板分割区直角相接（`rounded-none`），内部独立控件框与按钮使用 `rounded-md`（`8px`），紧凑状态胶囊与插孔标签使用 `rounded-sm`（`6px`），物理旋钮使用正圆 `rounded-full`。
- 禁止使用大于 `1px` 的彩色左/右装饰粗边框（如 `border-l-4`）充当卡片样式。

## Components

只使用 `shadcn/ui` 标准原语（含通过锁定 `shadcn@4.22.1` 引入的 `Popover`、`Collapsible`、`Command`、`Dialog` 等）与 PRD 14.3 批准的 6 个专业领域组件，严禁手写模态遮罩、拖拽分栏、右键菜单定位或自定义图表坐标轴。

### 1. 横版主仪表面板（示波器 / 直流稳压电源 / 函数信号发生器）
- **左屏右控铁律**：示波器（`OscilloscopeControls`）、直流稳压电源与函数信号发生器在 `@md` 及以上宽容器下统一采用横版双栏布局——左侧固定读数/波形屏与核心动作栏，右侧双列紧凑排布通道与参数旋钮，确保单表模式下无需反复上下滚动即可边调边看。
- 示波器保留 `运行/停止`、`冻结波形`、`单次`、`自动设置`、`X-Y 模式`、`截图入报告` 全套动作，并支持一键打开站内大尺寸面板（`Dialog`）无遮挡完整调参。

### 2. 仪器旋钮（`RotaryKnob`）与 3D 就地微调浮窗
- **四合一顺手操控**：2D 连续量旋钮统一由 **44px 圆钮（支持上下拖拽 + 滚轮微调 + `Shift+滚轮` 粗调）+ `−` / `+` 单步微调按钮 + 精确值输入框 + 右上角工程单位换算标（如 `18 kΩ`）** 组成；直流电源提供 `5 V / 6 V / 12 V` 快捷预设，信号发生器提供 `100 Hz / 1 kHz / 10 kHz` 快捷预设。
- **3D 零滚轮冲突铁律（The Scroll-Purity Rule）**：3D 画布滚轮永远专职缩放镜头，**严禁鼠标路过 3D 旋钮时抢占滚轮导致意外缩放或误调参数**。悬停 3D `KNOB_`/`SW_` 仅显示高亮圆环与当前值；单击开关直接切换，单击旋钮弹出**就地迷你微调浮窗**（含 `−/+`、滑块、预设与浮窗内滚轮调节），双向同步 2D 面板与 3D `MOVING_` 模型。

### 3. 免切镜跨设备接线、特写标注与多入口协同（`BenchViewport3D` / `SchematicViewer` / `WiringPanel`）
- **拉线快捷端子浮窗（Quick-Target Wiring Dock）**：3D 中点击插孔进入 `pendingJack` 待接线态或改接态时，视口一侧自动浮出紧凑的外部端子快捷落点面板（含顶部模糊过滤、按设备分组的常用插孔芯片、悬停实时预览 3D 真实落点、单击即落线），同时支持 `Shift`（或勾选“连续从此孔引出”）保持源端连续拉多根线（适合共地 `GND` / `+5V`）。跨设备连线全程无需甩走当前挂箱特写镜头。
- **特写常驻防重叠插孔标注**：单设备特写且相邻插孔间距 `≥ 24 px` 时，默认对该设备可见插孔展示清晰防重叠短标签（工具栏可开关“插孔标注”），告别拿鼠标在板面扫雷。
- **自动极性色默认开启 & 可视化导线拔插改接**：新导线“自动极性色”**默认开启**（电源正极红、地/负极黑、测量与信号线自动区分蓝/绿/黄；手动选色立即生效）。选中导线或悬停导线时，两个端点显示可交互拔插圆球与微型操作条（`改接起点` / `改接终点` / `换色` / `删除`），支持左键拖插头改接，并保留右键菜单与 `Alt+点击` 兼容。
- **原理图两点直连 & `Command` 模糊搜索选孔**：交互式原理图（`SchematicViewer`，含放大弹窗）支持直接“点起点 → 点终点”完成真实接线（走同一断电校验、重复检查与 `zundo` 撤销契约）；右栏接线列表升级为 `Popover + Command` 模糊搜索选孔，支持按中文名/英文插孔 ID 快速检索。

### 4. 结构化可定位诊断、仪表柜与就近安全反馈
- **点哪指哪的诊断与步骤引导**：接线检查结果以结构化问题卡片列表展示（`起点 → 终点 [定位]`），不再拼成一大段橙色纯文本墙；悬停单条诊断项只高亮对应 3D 插孔与虚线，点击“定位”推近对应设备并脉冲提示插孔（绝不代学生连线）。引导模式下当前步骤的待连项同步支持悬停高亮与定位；自主模式严格隐藏参考虚线与过程定位提示。
- **双模式放表与位置净化**：仪表柜保留 `@dnd-kit` 拖拽到指定槽位与“`+ 上台`”单击放置；拖放期间 3D 视口自动平滑显露全部桌位；已放列表面向学生只展示中文位置名（如“台面左位”“示波器位”），内部 `SLOT_*` 与 `instanceId` 仅置于 `data-*` / `title`。
- **就近电源与安全恢复**：3D 视口右上角常驻极简上电/断电状态徽章；带电误操作同时通过 `sonner` Toast 就近提示并附 **`[立即断电]`** 按钮。

## Do's and Don'ts

### Do:
- **Do** 在新增任何仪表面板时优先保证主读数屏/波形屏固定可见，宽容器采用左屏右控双栏，杜绝单表出现横向滚动或 130px 矮槽双轴滚动。
- **Do** 保持高频仿真采样走 `RingBuffer` + `requestAnimationFrame` / `useFrame`，UI 文本读数同步不超过 `10 Hz`。
- **Do** 为所有仅图标按钮提供 `Tooltip` 与快捷键 `<Kbd>` 标注，为颜色与电平状态同步提供文字说明（如 `H/L`、导线色名）。
- **Do** 在 `1366×768`、`1920×1080` 及 `1.25×` 演示字号下检查面板是否零溢出、主读数是否完整可见。

### Don't:
- **Don't** 在界面主文案（含左栏步骤结果回显、仪表柜已放列表、诊断报告）中向学生直接暴露代码内部标识（如 `SLOT_DESK_1`、`generator1`、`carrier-frequency`、`1. prepare`、`mp-vcc`、`table-supply`）或未收敛的长浮点尾数（自动化所需内部键仅放 `data-*` 或 `aria-label`）。
- **Don't** 在 `components/ui/` 之外手写十六进制颜色、RGB 颜色或 Tailwind 任意值（如 `w-[327px]`、`bg-[#1a1a1a]`）。
- **Don't** 在 3D 视口叠加多行横向溢出工具栏、让默认视角框入大片空机架/桌腿、或在鼠标路过 3D 旋钮时劫持滚轮缩放。
- **Don't** 引入渐变字、毛玻璃浮层、卡片嵌套卡片、列表逐项滑入动画、emoji 或“智能赋能/沉浸式体验”类营销措辞。
