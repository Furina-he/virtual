# 电工电子技术虚拟仿真实训

基于 Electron、React、Three.js/react-three-fiber 与 ngspice 的离线电工电子虚拟实训桌面应用。

## 开发环境

- Node.js >= 22.12
- pnpm 10.12.3
- Windows 10/11 x64

```powershell
pnpm install
pnpm dev
```

## 验证命令

```powershell
pnpm test
pnpm e2e
pnpm typecheck
pnpm lint
pnpm content:lint
pnpm assets:lint
```

`pnpm e2e` 会先构建应用，再通过 Playwright 启动 Electron。`pnpm test` 包含真实 ngspice 金标准测试。

## 当前状态

- T0.9 接线编辑已完成。
- T0.10 首批资产管线与19个GLB已完成；本SD-22独立工作区另有555板，批准的跟随器适配板待引入；不包含MD-03板资产。
- T0.11 直流仪表与万用表的功能开发已完成，正式教学项目与目标机性能验收仍有遗留。
- T0.12 双通道示波器与函数信号发生器已完成，2D/3D 波形共享真实仿真采样，含内置信号源与单次触发。
- T0.15/A 的 DG-05 单表实训流程已完成：指导书、原理图、逐次测量、六列记录、步骤进度及确认重置均通过真实应用验证并录屏；T0.15 整体仍在进行中，三个代表项目按切片推进。
- T0.15/B 的 MD-03 由主会话交付，本分支不引入其专用提交，也不沿用主会话测试成绩。SD-22 在本 `codex/sd22` Worktree 开发，最终合并及三项目出口尚未关闭。
- 公共接口已支持步骤拓扑覆盖、本地模型内联、真实时间优先、扬声器差分及生命周期、有界长周期/示波器记录和长接线报告布局。TLV9001估计适配板获批准并独立交付；SD-22仍须迁移自己的接法/声明、完成真实声音流程与联合回归。
- T0.8 的 GTX 1650 级/核显目标机性能与冷启动验收尚未关闭。

当前 DG-01、DG-19 是复用现有挂箱的仪表功能验证场景，不代表正式 `mod-dc-components` 或 RC/RL 教学内容已经交付。详细进度见 [执行计划](docs/03-执行计划.md) 和 [技术设计](docs/02-技术设计.md)。

## 目录

```text
content/    数据驱动的模块、仪表、项目与 SPICE 模型
src/        Electron 主进程、preload、renderer、仿真和纯 TypeScript 领域逻辑
resources/  ngspice、HDRI 等离线运行时资源
tests/      单元、金标准与 Electron E2E 测试
tools/      内容校验和 3D 资产生成/校验工具
docs/       PRD 配套技术文档与执行计划
```

## 第三方资源

运行时资产和第三方库的许可证记录见：

- [assets/LICENSES.csv](assets/LICENSES.csv)
- [content/ASSET-NOTICES.md](content/ASSET-NOTICES.md)
- [resources/ngspice/LICENSE-NOTES.md](resources/ngspice/LICENSE-NOTES.md)

内部厂商参考图片保存在本地 `assets/reference/`，默认不纳入公开仓库。仓库本身不附开源许可证；第三方组件和资产仍分别受其许可证约束。
