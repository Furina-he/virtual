# SD-22 参考拓扑

本文件由项目自行编写，用于电气审核和金标准测试，不是当前运行时已支持的第二套项目配置。每个 `nets` 子数组表示同一电气网络，允许等效的星形或链式导线；不要求逐根导线一致。仪表测量线由学员另接，不加入参考网络。模块内部只有两片芯片的 VCC/GND 共用电源铜箔，RA、RB、电容、R5、扬声器两端均由学员连接。

当前 `project.json.reference` 采用救护车接法。公共 `Step.referenceNets` 就绪后，应将消防车的 `nets` 分配到消防车步骤，不得同时接受两种调制线，亦不得将第二个 JSON 文件放入 `content/` 绕开 schema 校验。

## 救护车参考拓扑（ambulance）

IC1 OUT 经 R5 调制 IC2 CV；正常低频约 0.99 Hz。CV 低平台对应较高音调，CV 高平台对应较低音调。以下数据只用于接线和测量位置，不包含预填读数。

```json
{
  "nets": [
    ["ins-dc-power.CH1P", "timer1.VCC1", "timer1.T1_RA_1", "timer1.T1_RST", "timer1.T2_RA_1", "timer1.T2_RST"],
    ["ins-dc-power.CH1N", "timer1.GND1", "timer1.T1_CT_N", "timer1.T1_CC_2", "timer1.T2_CT_N", "timer1.T2_CC_2", "timer1.SPK_N"],
    ["timer1.T1_RA_2", "timer1.T1_DIS", "timer1.T1_RB_1"],
    ["timer1.T1_RB_2", "timer1.T1_TH", "timer1.T1_TR", "timer1.T1_CT_P"],
    ["timer1.T1_CV", "timer1.T1_CC_1"],
    ["timer1.T1_OUT", "timer1.R5_1"],
    ["timer1.T2_RA_2", "timer1.T2_DIS", "timer1.T2_RB_1"],
    ["timer1.T2_RB_2", "timer1.T2_TH", "timer1.T2_TR", "timer1.T2_CT_P"],
    ["timer1.R5_2", "timer1.T2_CV", "timer1.T2_CC_1"],
    ["timer1.T2_OUT", "timer1.C5_P"],
    ["timer1.C5_N", "timer1.SPK_P"]
  ],
  "measurePoints": [
    { "id": "supply", "kind": "voltage", "mode": "dcv", "between": ["timer1.VCC1", "timer1.GND1"] },
    { "id": "lf-out", "kind": "waveform", "between": ["timer1.T1_OUT", "timer1.GND1"] },
    { "id": "lf-cap", "kind": "waveform", "between": ["timer1.T1_TH", "timer1.GND1"] },
    { "id": "hf-out", "kind": "waveform", "between": ["timer1.T2_OUT", "timer1.GND1"] },
    { "id": "hf-cap", "kind": "waveform", "between": ["timer1.T2_TH", "timer1.GND1"] },
    { "id": "control", "kind": "waveform", "between": ["timer1.T2_CV", "timer1.GND1"] },
    { "id": "speaker", "kind": "waveform", "between": ["timer1.SPK_P", "timer1.SPK_N"] }
  ]
}
```

## 消防车原型参考拓扑（fire-prototype）

此接法忠实于原型说明：只将 `T1_OUT→R5_1` 改成 `T1_TH→R5_1`。`T1_OUT` 不再连接 R5，因此其单独节点不写入长度至少为二的网络。不得同时保留两条调制线。

**该原型不能实现持续音调渐变。** NE555 的 CV 输入不是高阻输入：内部 5 kΩ、5 kΩ、5 kΩ 分压链的等效源为 3.333 V、3.333 kΩ。经 R5=10 kΩ，C1 的放电支路受到约 13.333 kΩ 的上拉负载。RB1=150 kΩ 时，放电平衡约为 3.061 V，高于 IC1 的下阈值 1.667 V；IC1 无法再次触发。

真实 ngspice 对原型的四秒验证得到 IC1 OUT 保持 0 V、C1 约 3.062 V、IC2 CV 约 3.265 V、载频近似不变。该结果是电路缺陷的回归证据，不是完成消防车模式的证据。高输入阻抗缓冲方案须审批后另行更新电路、原理图、完整拓扑和真实测试。

```json
{
  "nets": [
    ["ins-dc-power.CH1P", "timer1.VCC1", "timer1.T1_RA_1", "timer1.T1_RST", "timer1.T2_RA_1", "timer1.T2_RST"],
    ["ins-dc-power.CH1N", "timer1.GND1", "timer1.T1_CT_N", "timer1.T1_CC_2", "timer1.T2_CT_N", "timer1.T2_CC_2", "timer1.SPK_N"],
    ["timer1.T1_RA_2", "timer1.T1_DIS", "timer1.T1_RB_1"],
    ["timer1.T1_RB_2", "timer1.T1_TH", "timer1.T1_TR", "timer1.T1_CT_P", "timer1.R5_1"],
    ["timer1.T1_CV", "timer1.T1_CC_1"],
    ["timer1.T2_RA_2", "timer1.T2_DIS", "timer1.T2_RB_1"],
    ["timer1.T2_RB_2", "timer1.T2_TH", "timer1.T2_TR", "timer1.T2_CT_P"],
    ["timer1.R5_2", "timer1.T2_CV", "timer1.T2_CC_1"],
    ["timer1.T2_OUT", "timer1.C5_P"],
    ["timer1.C5_N", "timer1.SPK_P"]
  ],
  "measurePoints": [
    { "id": "supply", "kind": "voltage", "mode": "dcv", "between": ["timer1.VCC1", "timer1.GND1"] },
    { "id": "lf-out", "kind": "waveform", "between": ["timer1.T1_OUT", "timer1.GND1"] },
    { "id": "lf-cap", "kind": "waveform", "between": ["timer1.T1_TH", "timer1.GND1"] },
    { "id": "hf-out", "kind": "waveform", "between": ["timer1.T2_OUT", "timer1.GND1"] },
    { "id": "hf-cap", "kind": "waveform", "between": ["timer1.T2_TH", "timer1.GND1"] },
    { "id": "control", "kind": "waveform", "between": ["timer1.T2_CV", "timer1.GND1"] },
    { "id": "speaker", "kind": "waveform", "between": ["timer1.SPK_P", "timer1.SPK_N"] }
  ]
}
```

## 测量与接线约束

- 供电测量用固定电压表或万用表 DCV 档，正端接 VCC1、负端接 GND1。
- 示波器 GND 接测量负端；所有单端波形以 GND1 为参考。扬声器差分量为 `SPK_P−SPK_N`，不能假定悬空的 SPK_N 必定等于全局零节点。
- CH1/CH2 由学员选择；`measurePoints` 定义电气位置，不将特定仪表实例或通道固定到参考拓扑。
- 高频采样来自真实仿真，低频调制和声音用真实时间推进；改变时基不改变警笛节奏。
- 当前公共记录通道尚不支持波形标量和第二套步骤拓扑；本文用于内容审核与金标准，不意味着应用集成完成。
