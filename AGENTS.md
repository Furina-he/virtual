# 项目协作规则

电工电子技术虚拟仿真教学软件：Electron 离线桌面应用、ngspice 真实仿真、React + R3F 实训台。

## 开始工作

1. 先读 [执行计划](docs/执行计划.md)：当前状态、近期优先级、对应任务和待决策都在里面。
2. 需求以 [PRD](电工电子技术虚拟仿真教学软件PRD.md) 为准，实现以 [技术设计](docs/技术设计.md) 和 [公共模块运行接口](docs/公共模块运行接口.md) 为准。其他文档见 [文档入口](docs/README.md)。
3. 按执行计划直接开工，不需要领取、回执或评审流程。方案行不通、需要新依赖或改门槛时，先写进执行计划"待决策"并告诉用户，不在代码里绕过。

## 文档

- 进度只在执行计划维护：做完勾选状态，写一行结果，包括日期、定向验证命令（提交后补提交号），有证据时加路径；部分完成保持 ◐，并写清还差什么。
- "当前状态"的回归基线只保留最近一次完整回归快照（里程碑封板、GitHub Actions 全量通过或硬件实测后更新），日常单任务不要求为更新该表而在本地重跑全量套件；结果回填和对应代码放在同一个提交，不单独提交"记录成绩"的文档改动。
- 设计结论写进技术设计，前端视觉与交互比例写进 [DESIGN.md](DESIGN.md)，需求变化写进 PRD。不另建状态页、交接或总结文档。
- 归档文档只追加不改写；新增文档要在 [文档入口](docs/README.md) 登记。

## 硬性边界

- 依赖只用 PRD 14.2 白名单与锁定版本；新增库、模型/求解近似或阈值调整必须先审批。
- shadcn/ui 和现有白名单库能表达的行为不手写；自研只限 PRD 14.3 的领域组件。
- shadcn 组件用 `npx shadcn@4.22.1 add <name>`；CLI 带入的 `cn`、`next-themes` 从依赖移除，import 保持 `@/lib/utils`，不引入白名单外库。
- `components/ui/` 之外不写十六进制颜色、不用 Tailwind 任意值；前端空间构图、仪器面板结构（如左屏右控、旋钮步进、折叠闲置表）、数值精度与文案红线严格遵循 [DESIGN.md](DESIGN.md) 与 PRD 第 15 节，不引入渐变、玻璃、emoji 或营销布局，不向用户界面裸露内部英文 slug 或 `SLOT_*` 代码标识。
- 项目差异只在 `content/` 配置声明，不在公共代码中按项目编号分支（ADR-004）。
- 高频采样不进 React state；`src/domain/` 保持纯 TS，不引用 React/Electron。
- 运行时不访问外网；字体、HDRI、drei 与模型资源全部本地。联网获取只能是显式开发期步骤。
- 不用手填、理论值、跳步骤、另一个加速会话或修改物理/时间/PCM 门槛冒充真实验收。

## 验证（本地轻量定向 + GitHub Actions 云端重测）

- **日常单任务迭代（本地必跑）**：先跑秒级静态校验（`pnpm typecheck`、`pnpm lint`、`pnpm docs:lint`、`pnpm content:lint`；改 3D 资产时加 `pnpm assets:lint`），再只跑**本次改动直接关联的单测与 1~2 个定向 E2E**（如 `pnpm exec vitest run <对应.test.ts>`、`node tools/run-exclusive.ts e2e <对应.spec.ts>`；改电路/仪表物理逻辑时补跑对应 `tests/golden/<文件>.test.ts`）。不在本地每次重跑全量串行单测或 19 分钟全量 E2E。
- **全量回归（GitHub Actions 云端执行）**：推送或 PR 自动触发 `.github/workflows/ci.yml`，在 GitHub `windows-latest` 云端运行全量串行单元/ngspice 金标准与 Electron 功能 E2E（支持手动勾选打包 NSIS）。原超时和数值阈值不变。
- **硬件实时与里程碑封板**：强依赖物理独显帧率或声卡时钟的基准（`scene-performance`、`sd22-realtime`、`sim-audio`、`SIM_SOAK_SEC=600` 浸泡）仅在改了仿真调度/渲染管线或里程碑封板时在本地执行。
- 本地运行构建、资产、音频、E2E 等重任务仍通过 `tools/run-exclusive.ts` 使用共享锁；不重叠运行，不擅自删锁，不杀其他会话的进程。
- `pnpm build:app` 只编译，`pnpm build` 才生成 NSIS。

## Git

- 只在用户要求时提交；选择性暂存，不用 `git add -A` 混入无关改动；保留用户未提交的改动。
- 不自动推送，不强删分支，不改写历史。合入 `main` 和清理分支按 [文档入口](docs/README.md) 的分支规则执行。
