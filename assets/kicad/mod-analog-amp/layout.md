#### mod-analog-amp 共射极单管放大器实验板

外形 264×184 mm（板面，原点左上角，x 向右、y 向下，坐标为插孔/元件中心）。参照天煌模电挂箱配套共射极单管放大器实验板。

| 锚点 | 丝印 | x | y | 颜色 | 内部网络 | 说明 |
|---|---|---|---|---|---|---|
| `JACK_AMP_VCC` | +12V | 245 | 16 | 红 | VCC |  |
| `JACK_AMP_GND1` | GND | 245 | 170 | 黑 | GND |  |
| `JACK_AMP_GND2` | GND | 16 | 170 | 黑 | GND |  |
| `JACK_AMP_US` | Us | 16 | 95 | 黄 | US |  |
| `JACK_AMP_UI` | Ui | 55 | 95 | 黄 | UI |  |
| `JACK_AMP_UB` | B | 108 | 95 | 黄 | B |  |
| `JACK_AMP_UC` | C | 158 | 70 | 黄 | C |  |
| `JACK_AMP_UE` | E | 158 | 122 | 黄 | E |  |
| `JACK_AMP_UO` | Uo | 222 | 70 | 黄 | UO |  |
| `JACK_AMP_RL` | RL | 222 | 110 | 黄 | RLP |  |

| 位号 | 值 | 封装 | x | y | 角度 | 引脚 1/2/3… 网络 |
|---|---|---|---|---|---|---|
| R1 | 5.1kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 27 | 95 | 0 | US / UI |
| C1 | 10μF | `CP_Radial_D5.0mm_P2.50mm` | 80 | 95 | 180 | B / UI |
| RW | 100kΩ | `Potentiometer_Alps_RK09K_Single_Vertical` | 105 | 32 | 0 | VCC / nRW / nRW |
| RB1 | 20kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 108 | 50 | 270 | nRW / B |
| RB2 | 20kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 108 | 112 | 270 | B / GND |
| VT1 | 3DG6 | `TO-92_Inline` | 132 | 95 | 0 | E / B / C |
| RC | 2.4kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 158 | 30 | 270 | VCC / C |
| RE | 1kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 158 | 140 | 270 | E / GND |
| KCE | CE接入/断开 | `SW_CuK_OS102011MA1QN1_SPDT_Angled` | 185 | 122 | 0 | E / nCE / — |
| CE | 47μF | `CP_Radial_D5.0mm_P2.50mm` | 185 | 145 | 270 | nCE / GND |
| C2 | 10μF | `CP_Radial_D5.0mm_P2.50mm` | 190 | 70 | 0 | C / UO |
| RL | 2.4kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 222 | 130 | 270 | RLP / GND |

区块丝印：共射极单管放大器；Uo 与 RL 用短接线相连即接入负载。每个插孔上方印插孔名，每个元件旁印“位号 值”，同一网络之间印连线。
