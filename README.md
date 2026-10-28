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
- T0.10 首批资产管线与 19 个 GLB 已完成。
- T0.11 直流仪表与万用表的功能开发已完成，正式教学项目与目标机性能验收仍有遗留。
- T0.8 的 GTX 1650 级/核显目标机性能与冷启动验收尚未关闭。

当前 DG-01 是复用现有挂箱的仪表功能验证场景，不代表正式 `mod-dc-components` 教学内容已经交付。详细进度见 [执行计划](docs/03-执行计划.md) 和 [技术设计](docs/02-技术设计.md)。

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
