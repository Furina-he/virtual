# 开发会话规则

电工电子技术虚拟仿真教学软件：Electron 单机桌面应用，ngspice 仿真，React + R3F 3D 实训台。

## 开始工作前

1. 在 `docs/03-执行计划.md` 找到要做的任务卡，按卡上的"参考"读 PRD 和 `docs/02-技术设计.md` 的对应章节。
2. 需求以 `电工电子技术虚拟仿真教学软件PRD.md` 为准，实现方式以技术设计为准。发现两者冲突或设计行不通，停下来报告，不要在代码里绕过去。

## 硬性规则

- 依赖只能用 PRD 14.2 白名单内的库和锁定版本。需要新依赖先提出，经同意后再加。
- shadcn/ui 已有的组件和白名单库能表达的行为不许手写（PRD 14.3）。自研只限 6 个领域组件。
- `components/ui/` 之外不写十六进制颜色、不用 Tailwind 任意值；UI 遵循 PRD 第 15 节，不要渐变、玻璃、emoji、营销文案。
- 项目差异只写在 `content/` 配置里，代码中不出现按项目编号分支（ADR-004）。
- 高频仿真数据不进 React state（技术设计 §4.2）。
- 运行时不得访问外网；drei 资源、字体、HDRI 全部本地。
- `src/domain/` 保持纯 TS，不引用 React/Electron。

## 命令

- `pnpm dev`：开发模式启动（electron-vite，热更新）
- `pnpm build`：构建并打 NSIS 安装包，产物在 `dist/`；只编译不打包用 `pnpm build:app`
- `pnpm test`：vitest 单元测试（`src/**/*.test.ts`）
- `pnpm e2e`：先构建，再跑 Playwright `_electron`（`tests/e2e/`）；仿真长时运行测试默认 20 s，`SIM_SOAK_SEC=600 pnpm e2e` 跑满 10 分钟
- `pnpm lint`：Biome 检查（`pnpm format` 自动格式化）；`pnpm typecheck`：tsc 类型检查
- `pnpm test:golden`：用真实 ngspice.dll 跑仿真金标准（`tests/golden/`）
- `pnpm content:lint`：校验 `content/` 全部 JSON（schema + 跨文件引用）；`node tools/content-lint.ts <目录>` 可校验其他目录
- shadcn 组件：`npx shadcn@4.22.1 add <name>`。CLI 会往 package.json 加 `cn`、`next-themes`，加完要删掉，并把 import 改回 `@/lib/utils`

## 任务完成时

逐条核对任务卡的验收标准，把任务状态改为 ☑，在执行计划末尾的进度日志追加一行。
