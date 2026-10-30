# 开发会话规则

所有项目协作、架构边界、任务验收、文档和分支清理规则统一以 [AGENTS.md](AGENTS.md) 为准，不在本文件维护另一份规则。

开始前先读 [项目状态](docs/项目状态.md)、[执行计划](docs/执行计划.md) 的任务卡和 [文档入口](docs/README.md)。需求与实现冲突时先报告，不自行改门槛或绕过设计。

## 常用命令

| 用途 | 命令 |
|------|------|
| 开发热更新 | `pnpm dev` |
| 只编译应用 / 打 NSIS | `pnpm build:app` / `pnpm build` |
| 类型、格式规则、文档 | `pnpm typecheck` / `pnpm lint` / `pnpm docs:lint` |
| 内容与资产校验 | `pnpm content:lint` / `pnpm assets:lint` |
| 单元与真实金标准 | `node tools/run-exclusive.ts test --maxWorkers=1` |
| 仅真实金标准 | `node tools/run-exclusive.ts test:golden` |
| 构建后完整 Electron E2E | `node tools/run-exclusive.ts e2e` |
| 10 分钟浸泡 | 设置 `SIM_SOAK_SEC=600` 后运行上述 E2E |
| 本地资产构建 | `node tools/run-exclusive.ts assets:build` |

不重叠运行重验证、不擅自删共享锁；完成时更新任务卡、唯一当前状态和归档日志。详细约束见 AGENTS.md。
