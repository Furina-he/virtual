#### mod-dc-circuit 电路基础实验挂箱（一）

外形 290×470 mm（板面，原点左上角，x 向右、y 向下，坐标为插孔/元件中心）。参照天煌 DGJ-03 电路基础实验挂箱。

| 锚点 | 丝印 | x | y | 颜色 | 内部网络 | 说明 |
|---|---|---|---|---|---|---|
| `JACK_KH_U1P` | U1+ | 18 | 90 | 红 | E1P |  |
| `JACK_KH_U1N` | U1- | 18 | 140 | 黑 | E |  |
| `JACK_KH_U2P` | U2+ | 272 | 90 | 红 | E2P |  |
| `JACK_KH_U2N` | U2- | 272 | 140 | 黑 | C |  |
| `JACK_KH_F` | F | 45 | 60 | 黄 | F |  |
| `JACK_KH_A` | A | 145 | 45 | 黄 | A |  |
| `JACK_KH_B` | B | 245 | 60 | 黄 | B |  |
| `JACK_KH_E` | E | 45 | 190 | 黄 | E |  |
| `JACK_KH_D` | D | 145 | 190 | 黄 | D |  |
| `JACK_KH_C` | C | 245 | 190 | 黄 | C |  |
| `JACK_KH_I1A` | I1 | 98 | 60 | 绿 | nFA | 电流插座 I1 左（常闭，插电流插头断开） |
| `JACK_KH_I1B` | — | 118 | 60 | 绿 | A | 电流插座 I1 右 |
| `JACK_KH_I2A` | I2 | 172 | 60 | 绿 | A | 电流插座 I2 左 |
| `JACK_KH_I2B` | — | 192 | 60 | 绿 | nBA | 电流插座 I2 右 |
| `JACK_KH_I3A` | I3 | 145 | 85 | 绿 | A | 电流插座 I3 上 |
| `JACK_KH_I3B` | — | 145 | 105 | 绿 | nAD | 电流插座 I3 下 |
| `JACK_TH_USP` | Us+ | 20 | 300 | 红 | TUSP |  |
| `JACK_TH_USN` | Us- | 20 | 410 | 黑 | TCOM |  |
| `JACK_TH_ISP` | Is+ | 175 | 330 | 红 | TN2 |  |
| `JACK_TH_ISN` | Is- | 175 | 410 | 黑 | TCOM |  |
| `JACK_TH_IA` | I | 240 | 300 | 绿 | TN3 | 电流插座左 |
| `JACK_TH_IB` | — | 262 | 300 | 绿 | TA | 电流插座右 |
| `JACK_TH_A` | A | 262 | 355 | 黄 | TA |  |
| `JACK_TH_B` | B | 262 | 410 | 黑 | TCOM |  |

| 位号 | 值 | 封装 | x | y | 角度 | 引脚 1/2/3… 网络 |
|---|---|---|---|---|---|---|
| R1 | 510Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 62 | 60 | 0 | F / nFA |
| R2 | 1kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 205 | 60 | 0 | nBA / B |
| R3 | 510Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 145 | 125 | 270 | nAD / D |
| R4 | 510Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 85 | 190 | 0 | E / D |
| R5 | 330Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 178 | 172 | 0 | D / nDC1 |
| VD1 | 1N4007 | `D_DO-41_SOD81_P10.16mm_Horizontal` | 190 | 208 | 180 | nDC2 / D |
| K1 | U1/短路 | `SW_CuK_OS102011MA1QN1_SPDT_Angled` | 45 | 115 | 90 | E1P / F / E |
| K2 | U2/短路 | `SW_CuK_OS102011MA1QN1_SPDT_Angled` | 245 | 115 | 90 | E2P / B / C |
| K3 | R5/VD1 | `SW_CuK_OS102011MA1QN1_SPDT_Angled` | 220 | 190 | 90 | nDC2 / C / nDC1 |
| SB1 | 故障1 | `SW_PUSH_6mm` | 72 | 218 | 0 | — / — |
| SB2 | 故障2 | `SW_PUSH_6mm` | 142 | 218 | 0 | — / — |
| SB3 | 故障3 | `SW_PUSH_6mm` | 212 | 218 | 0 | — / — |
| R6 | 330Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 50 | 300 | 0 | TUSP / TN1 |
| R7 | 510Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 90 | 330 | 270 | TN1 / TCOM |
| R8 | 10Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 115 | 300 | 0 | TN1 / TN2 |
| R9 | 510Ω | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 205 | 300 | 0 | TN2 / TN3 |

区块丝印：电路基础实验（一）；基尔霍夫定律 / 叠加原理；戴维南定理 / 有源二端网络；Us 接直流稳压电源，Is 接恒流源。每个插孔上方印插孔名，每个元件旁印“位号 值”，同一网络之间印连线。
