# ngspice 分发文件许可证核对

核对日期：2026-10-28。依据 ngspice-47 官方源码包中的 `COPYING`（随本目录分发）与各子目录源文件头。

## 来源

| 包 | URL | SHA-256 |
|----|-----|---------|
| 共享库包 | https://sourceforge.net/projects/ngspice/files/ng-spice-rework/47/ngspice-47_dll_64.7z | 5bf5eec7db989f74849cdb32f7df62693f4f149cceeebcbd222eb35c2bb821eb |
| 控制台包（只取 sndfile.dll、samplerate.dll） | https://sourceforge.net/projects/ngspice/files/ng-spice-rework/47/ngspice-47_64.7z | 59225971bd68cdd1199443649aa4615a9e6d684933f205ab49006a3942518f5a |
| 源码包（许可证核对） | https://sourceforge.net/projects/ngspice/files/ng-spice-rework/47/ngspice-47.tar.gz | 894e649651f1838a14095e5a5439e7d3aa63e87ede14d283173fda4fcdef675f |

源码仓库：https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/

共享库包里的 `ngspice.dll` 静态导入 `sndfile.dll` 与 `samplerate.dll`，但共享库包本身不带这两个文件，所以从同版本控制台包里取。

## 逐文件结论

| 文件 | 来源代码 | 许可证 | 说明 |
|------|----------|--------|------|
| `ngspice.dll` | ngspice 主体 | Modified BSD（3-clause） | 内含 KLU（`src/maths/KLU`，LGPLv2）、numparam（`src/frontend/numparam`，LGPLv2+）、sparse（MIT 类）、ndev（public domain）、XSPICE 框架（public domain）、OSDI（MPL-2.0）。整体为动态库，用户可替换，满足 LGPL 动态链接条件；需随附 `COPYING` 并提供源码获取方式（上方源码 URL） |
| `lib/ngspice/analog.cm` | `src/xspice/icm/analog` | public domain + 3-clause BSD | astate、delay、multi_input_pwl、file_source 文件头为 3-clause BSD，其余继承 XSPICE public domain |
| `lib/ngspice/digital.cm` | `src/xspice/icm/digital` | public domain + 3-clause BSD | d_process 为 3-clause BSD |
| `lib/ngspice/spice2poly.cm` | `src/xspice/icm/spice2poly` | public domain | |
| `lib/ngspice/xtradev.cm` | `src/xspice/icm/xtradev` | public domain + 3-clause BSD | memristor、pswitch、sidiode 为 3-clause BSD |
| `lib/ngspice/xtraevt.cm` | `src/xspice/icm/xtraevt` | public domain | |
| `share/ngspice/scripts/spinit` | ngspice 发行脚本 | Modified BSD | 本项目已修改，见下 |
| `COPYING` | ngspice-47 源码根目录 | CC-BY-SA 4.0（文档本身） | 含 Modified BSD、XSPICE 声明与 LGPL 2.1 全文，满足 BSD 第 2 条"二进制分发须附带声明" |
| `sndfile.dll` | libsndfile 1.2.2 | LGPL-2.1-or-later | 动态库，可替换；源码 https://github.com/libsndfile/libsndfile |
| `samplerate.dll` | libsamplerate 0.2.2 | BSD-2-Clause | 源码 https://github.com/libsndfile/libsamplerate |
| `libomp140.x86_64.dll` | Microsoft Visual C++ 附带的 LLVM OpenMP 运行时 | Apache-2.0 WITH LLVM-exception（LLVM 上游）；作为 VS 可再分发文件随 ngspice 官方包分发 | 待安装包第三方声明页统一列出（见"遗留"） |

`*.cm` 每个文件都链接 `src/xspice/icm/dlmain.c`，文件头为 ngspice team 版权，属主体 Modified BSD。

## table.cm 结论

`COPYING` 原文：`ngspice/src/xspice public domain except for ngspice/src/xspice/icm/table GPLv2 or newer`。`src/xspice/icm/table/table2D/cfunc.mod`、`table3D/cfunc.mod`、`mada/*.c` 文件头均为 GPL v2 或更高版本。

结论：**table.cm 为 GPLv2+，不分发。** `spinit` 中已注释其 `codemodel` 行，本目录不含 table.cm。61 个实训项目不使用 `table2D`/`table3D` 模型。日后如有需要，须先评估 GPL 对整个产品分发的影响，不得直接加入。

同样未分发：`tlines.cm`（不需要）、全部 `*.osdi`（spinit 已 `unset osdi_enabled`）、`ivlng.dll`/`ivlng.vpi`（Verilog 协同仿真，不需要）。

## spinit 修改

- `codemodel` 路径由官方包的 `C:/Spice64/lib/ngspice/` 改为 `$SPICE_LIB_DIR/../../lib/ngspice/`。`SPICE_LIB_DIR` 由 `src/sim/ngspice.ts` 在加载 DLL 前设为 `<本目录>/share/ngspice`，ngspice 据此在 `scripts/` 下找到 spinit。
- 只加载 spice2poly、analog、digital、xtradev、xtraevt 五个代码模型。

## 遗留

- 安装包需要一个第三方声明页，列出上述各项并附 `COPYING`、libsndfile（LGPL 2.1，全文已在 `COPYING` 内）、libsamplerate（BSD-2）、LLVM OpenMP（Apache-2.0 WITH LLVM-exception）的许可证文本。
