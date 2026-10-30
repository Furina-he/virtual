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
node tools/run-exclusive.ts test --maxWorkers=1
node tools/run-exclusive.ts e2e
pnpm typecheck
pnpm lint
pnpm docs:lint
pnpm content:lint
pnpm assets:lint
```

`pnpm e2e` 会先构建应用，再通过 Playwright 启动 Electron。`pnpm test` 包含真实 ngspice 金标准测试。

## 当前状态

项目仍在 M0 技术验证：DG-05、MD-03 的功能流程已有真实证据；SD-22 内容/声音已整合，但正式实时和完整实训未通过，不宣称 M0 或正式交付完成。

唯一的当前回归、开放问题和分支快照见 [项目状态](docs/项目状态.md)；任务卡见 [执行计划](docs/执行计划.md)，规范和历史导航见 [文档入口](docs/README.md)。DG-01、DG-19 仅为仪表功能验证场景，目标机性能、正式内容/参数及教学验收仍开放。

仿真金标准、Electron E2E、音频/性能和资产构建通过 `node tools/run-exclusive.ts <任务>` 获取共享验证锁，避免跨 worktree 重叠运行。SD-22 旧工作树的独有录屏/日志已独立保留到 `build/retained-sd22/`；`build/` 虽被 Git 忽略，不可整体当缓存删除。

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
