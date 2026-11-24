# 开发会话规则

协作、文档和验证规则以 [AGENTS.md](AGENTS.md) 为准，本文件只列常用命令。

开始前先读 [执行计划](docs/执行计划.md) 的当前状态和近期优先级。需求与实现冲突时先告诉用户，不自行改门槛或绕过设计。

## 常用命令（日常本地只跑轻量定向，全量重测交由 GitHub Actions）

| 用途 | 命令 |
|------|------|
| 开发热更新 | `pnpm dev` |
| 只编译应用 / 打 NSIS | `pnpm build:app` / `pnpm build` |
| 类型、格式规则、文档 | `pnpm typecheck` / `pnpm lint` / `pnpm docs:lint` |
| 内容与资产校验 | `pnpm content:lint` / `pnpm assets:lint` |
| 定向单测（日常优先） | `pnpm exec vitest run <对应.test.ts>` |
| 定向 Electron E2E（日常优先） | `node tools/run-exclusive.ts e2e <对应.spec.ts>` |
| 仅受影响金标准（改电路/仪表时） | `node tools/run-exclusive.ts test tests/golden/<对应.test.ts> --maxWorkers=1` |
| 全量单元/金标准与功能 E2E | 推送后由 `.github/workflows/ci.yml`（GitHub Actions `windows-latest`）自动执行；仅里程碑封板或本地排障时手动全跑 |
| 本地资产构建 | `node tools/run-exclusive.ts assets:build` |

日常迭代只跑静态校验 + 受影响单测/定向 E2E，不在本地每次重跑全量套件；本地跑重任务仍通过 `run-exclusive.ts` 串行执行，不擅自删共享锁。
