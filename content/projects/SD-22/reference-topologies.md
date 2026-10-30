# SD-22 完整参考拓扑

本文件由项目自行编写。每个网络可用星形或链式等效接线；仪表线另接，不纳入电路参考。正式项目默认救护车，各步骤显式提供完整 `referenceNets`，不合并前一步隐含状态。原 555 板 36 孔与全部 RC/NE555 分压保持；批准的独立适配板使用 follower1。

## 救护车参考拓扑（ambulance）

follower1 虽挂载但四孔均不接，OUT 方波直接经 R5 调制 IC2 CV。

```json
{
  "nets": [
    [
      "ins-dc-power.CH1P",
      "timer1.VCC1",
      "timer1.T1_RA_1",
      "timer1.T1_RST",
      "timer1.T2_RA_1",
      "timer1.T2_RST"
    ],
    [
      "ins-dc-power.CH1N",
      "timer1.GND1",
      "timer1.T1_CT_N",
      "timer1.T1_CC_2",
      "timer1.T2_CT_N",
      "timer1.T2_CC_2",
      "timer1.SPK_N"
    ],
    [
      "timer1.T1_RA_2",
      "timer1.T1_DIS",
      "timer1.T1_RB_1"
    ],
    [
      "timer1.T1_RB_2",
      "timer1.T1_TH",
      "timer1.T1_TR",
      "timer1.T1_CT_P"
    ],
    [
      "timer1.T1_CV",
      "timer1.T1_CC_1"
    ],
    [
      "timer1.T1_OUT",
      "timer1.R5_1"
    ],
    [
      "timer1.T2_RA_2",
      "timer1.T2_DIS",
      "timer1.T2_RB_1"
    ],
    [
      "timer1.T2_RB_2",
      "timer1.T2_TH",
      "timer1.T2_TR",
      "timer1.T2_CT_P"
    ],
    [
      "timer1.R5_2",
      "timer1.T2_CV",
      "timer1.T2_CC_1"
    ],
    [
      "timer1.T2_OUT",
      "timer1.C5_P"
    ],
    [
      "timer1.C5_N",
      "timer1.SPK_P"
    ]
  ],
  "measurePoints": [
    {
      "id": "supply",
      "kind": "voltage",
      "mode": "dcv",
      "between": [
        "timer1.VCC1",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-period",
      "kind": "waveform",
      "quantity": "period",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-mean",
      "kind": "waveform",
      "quantity": "mean",
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "speaker-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.SPK_P",
        "timer1.SPK_N"
      ]
    }
  ]
}
```

## 消防车缓冲参考拓扑（fire-buffered）

已批准独立跟随器同源 5 V/GND；TH→IN、跟随器 OUT→R5_1。原 R5/C4 与 36 个插孔不变。

```json
{
  "nets": [
    [
      "ins-dc-power.CH1P",
      "timer1.VCC1",
      "timer1.T1_RA_1",
      "timer1.T1_RST",
      "timer1.T2_RA_1",
      "timer1.T2_RST",
      "follower1.VCC"
    ],
    [
      "ins-dc-power.CH1N",
      "timer1.GND1",
      "timer1.T1_CT_N",
      "timer1.T1_CC_2",
      "timer1.T2_CT_N",
      "timer1.T2_CC_2",
      "timer1.SPK_N",
      "follower1.GND"
    ],
    [
      "timer1.T1_RA_2",
      "timer1.T1_DIS",
      "timer1.T1_RB_1"
    ],
    [
      "timer1.T1_RB_2",
      "timer1.T1_TH",
      "timer1.T1_TR",
      "timer1.T1_CT_P",
      "follower1.IN"
    ],
    [
      "timer1.T1_CV",
      "timer1.T1_CC_1"
    ],
    [
      "timer1.T2_RA_2",
      "timer1.T2_DIS",
      "timer1.T2_RB_1"
    ],
    [
      "timer1.T2_RB_2",
      "timer1.T2_TH",
      "timer1.T2_TR",
      "timer1.T2_CT_P"
    ],
    [
      "timer1.R5_2",
      "timer1.T2_CV",
      "timer1.T2_CC_1"
    ],
    [
      "timer1.T2_OUT",
      "timer1.C5_P"
    ],
    [
      "timer1.C5_N",
      "timer1.SPK_P"
    ],
    [
      "follower1.OUT",
      "timer1.R5_1"
    ]
  ],
  "measurePoints": [
    {
      "id": "supply",
      "kind": "voltage",
      "mode": "dcv",
      "between": [
        "timer1.VCC1",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-period",
      "kind": "waveform",
      "quantity": "period",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-mean",
      "kind": "waveform",
      "quantity": "mean",
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "speaker-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.SPK_P",
        "timer1.SPK_N"
      ]
    }
  ]
}
```

## 消防车原型参考拓扑（fire-prototype，仅诊断）

历史原型 TH→R5→CV 会因输入分压加载停振。本网络只用于停振回归，不是当前步骤操作或模式验收。

```json
{
  "nets": [
    [
      "ins-dc-power.CH1P",
      "timer1.VCC1",
      "timer1.T1_RA_1",
      "timer1.T1_RST",
      "timer1.T2_RA_1",
      "timer1.T2_RST"
    ],
    [
      "ins-dc-power.CH1N",
      "timer1.GND1",
      "timer1.T1_CT_N",
      "timer1.T1_CC_2",
      "timer1.T2_CT_N",
      "timer1.T2_CC_2",
      "timer1.SPK_N"
    ],
    [
      "timer1.T1_RA_2",
      "timer1.T1_DIS",
      "timer1.T1_RB_1"
    ],
    [
      "timer1.T1_RB_2",
      "timer1.T1_TH",
      "timer1.T1_TR",
      "timer1.T1_CT_P",
      "timer1.R5_1"
    ],
    [
      "timer1.T1_CV",
      "timer1.T1_CC_1"
    ],
    [
      "timer1.T2_RA_2",
      "timer1.T2_DIS",
      "timer1.T2_RB_1"
    ],
    [
      "timer1.T2_RB_2",
      "timer1.T2_TH",
      "timer1.T2_TR",
      "timer1.T2_CT_P"
    ],
    [
      "timer1.R5_2",
      "timer1.T2_CV",
      "timer1.T2_CC_1"
    ],
    [
      "timer1.T2_OUT",
      "timer1.C5_P"
    ],
    [
      "timer1.C5_N",
      "timer1.SPK_P"
    ]
  ],
  "measurePoints": [
    {
      "id": "supply",
      "kind": "voltage",
      "mode": "dcv",
      "between": [
        "timer1.VCC1",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-period",
      "kind": "waveform",
      "quantity": "period",
      "minCycles": 2,
      "between": [
        "timer1.T1_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "lf-cap-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T1_TH",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-frequency",
      "kind": "waveform",
      "quantity": "frequency",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "carrier-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.T2_OUT",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-mean",
      "kind": "waveform",
      "quantity": "mean",
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-min",
      "kind": "waveform",
      "quantity": "min",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "control-max",
      "kind": "waveform",
      "quantity": "max",
      "minCycles": 2,
      "between": [
        "timer1.T2_CV",
        "timer1.GND1"
      ]
    },
    {
      "id": "speaker-vpp",
      "kind": "waveform",
      "quantity": "vpp",
      "minCycles": 2,
      "between": [
        "timer1.SPK_P",
        "timer1.SPK_N"
      ]
    }
  ]
}
```

## 测量与边界

- 消防车正式步骤只使用缓冲网络，不允许 TH→R5_1 或 T1_OUT→R5_1 与缓冲 OUT 同时连接。救护车不经缓冲。
- 原型停振证据保留：C1≈3.0616 V > 1.667 V 下阈值、OUT 无低频上升沿；CV 约 3.2654 V。该缺陷回归不作为消防车功能通过。
- 供电取 VCC1−GND1，扬声器取 SPK_P−SPK_N，均由真实已接线仪表或声明差分采样获得，不默认悬空负端为零。
- frequency/period 要求至少两个完整有效周期；周期性极值也显式 minCycles=2。静态 CV 平台 mean 不强求周期，但须使用平台中间的完整短窗口。
- 渐变载频和 CV 均值分别保留实际来源窗口，不将独立窗口均值伪称同步瞬时电压；三个分段取点不是完整连续轨迹。
- 所有声音来自同一实时仿真差分采样后的基频/包络合成，不加载固定警笛。真实时间和全流程录屏验收必须另行完成，不以公共接口存在或金标准通过代替。
