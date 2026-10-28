#### mod-555-app 555 定时器应用实验板

外形 264×184 mm（板面，原点左上角，x 向右、y 向下，坐标为插孔/元件中心）。参照天煌数电挂箱 555 应用区，元件位按 SD-13/SD-22 补齐。

| 锚点 | 丝印 | x | y | 颜色 | 内部网络 | 说明 |
|---|---|---|---|---|---|---|
| `JACK_VCC1` | +5V | 252 | 20 | 红 | VCC |  |
| `JACK_GND1` | GND | 252 | 165 | 黑 | GND |  |
| `JACK_R5_1` | R5 | 238 | 118 | 黄 | nR5a |  |
| `JACK_R5_2` | — | 238 | 145 | 黄 | nR5b |  |
| `JACK_T1_TR` | 2 TR | 25 | 105 | 黄 | N1_TR |  |
| `JACK_T1_TH` | 6 TH | 25 | 80 | 黄 | N1_TH |  |
| `JACK_T1_DIS` | 7 DIS | 62 | 60 | 黄 | N1_DIS |  |
| `JACK_T1_RST` | 4 R | 45 | 130 | 黄 | N1_RST |  |
| `JACK_T1_CV` | 5 CV | 85 | 130 | 黄 | N1_CV |  |
| `JACK_T1_OUT` | 3 OUT | 100 | 92 | 黄 | N1_OUT |  |
| `JACK_T1_RA_1` | RA1 | 15 | 35 | 黄 | N1_RAa |  |
| `JACK_T1_RA_2` | — | 45 | 35 | 黄 | N1_RAb |  |
| `JACK_T1_RB_1` | RB1 | 65 | 35 | 黄 | N1_RBa |  |
| `JACK_T1_RB_2` | — | 95 | 35 | 黄 | N1_RBb |  |
| `JACK_T1_CT_P` | C1+ | 15 | 160 | 黄 | N1_CTp |  |
| `JACK_T1_CT_N` | — | 45 | 160 | 黄 | N1_CTn |  |
| `JACK_T1_CC_1` | C3 | 65 | 160 | 黄 | N1_CCa |  |
| `JACK_T1_CC_2` | — | 95 | 160 | 黄 | N1_CCb |  |
| `JACK_T2_TR` | 2 TR | 149 | 105 | 黄 | N2_TR |  |
| `JACK_T2_TH` | 6 TH | 149 | 80 | 黄 | N2_TH |  |
| `JACK_T2_DIS` | 7 DIS | 186 | 60 | 黄 | N2_DIS |  |
| `JACK_T2_RST` | 4 R | 169 | 130 | 黄 | N2_RST |  |
| `JACK_T2_CV` | 5 CV | 209 | 130 | 黄 | N2_CV |  |
| `JACK_T2_OUT` | 3 OUT | 224 | 92 | 黄 | N2_OUT |  |
| `JACK_T2_RA_1` | RA2 | 139 | 35 | 黄 | N2_RAa |  |
| `JACK_T2_RA_2` | — | 169 | 35 | 黄 | N2_RAb |  |
| `JACK_T2_RB_1` | RB2 | 189 | 35 | 黄 | N2_RBa |  |
| `JACK_T2_RB_2` | — | 219 | 35 | 黄 | N2_RBb |  |
| `JACK_T2_CT_P` | C2+ | 139 | 160 | 黄 | N2_CTp |  |
| `JACK_T2_CT_N` | — | 169 | 160 | 黄 | N2_CTn |  |
| `JACK_T2_CC_1` | C4 | 189 | 160 | 黄 | N2_CCa |  |
| `JACK_T2_CC_2` | — | 219 | 160 | 黄 | N2_CCb |  |
| `JACK_SPK_P` | SPK | 252 | 45 | 黄 | nSPKp |  |
| `JACK_SPK_N` | — | 252 | 75 | 黑 | nSPKn |  |
| `JACK_C5_P` | C5+ | 252 | 105 | 黄 | nC5p |  |
| `JACK_C5_N` | — | 252 | 135 | 黄 | nC5n |  |

| 位号 | 值 | 封装 | x | y | 角度 | 引脚 1/2/3… 网络 |
|---|---|---|---|---|---|---|
| R5 | 10kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 238 | 126 | 270 | nR5a / nR5b |
| IC1 | NE555 | `DIP-8_W7.62mm_Socket` | 58.19 | 88.19 | 0 | GND / N1_TR / N1_OUT / N1_RST / N1_CV / N1_TH / N1_DIS / VCC |
| RA1 | 10kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 25 | 35 | 0 | N1_RAa / N1_RAb |
| RB1 | 150kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 75 | 35 | 0 | N1_RBa / N1_RBb |
| C1 | 4.7μF | `CP_Radial_D5.0mm_P2.50mm` | 29 | 160 | 0 | N1_CTp / N1_CTn |
| C3 | 0.01μF | `C_Disc_D5.0mm_W2.5mm_P5.00mm` | 77.5 | 160 | 0 | N1_CCa / N1_CCb |
| IC2 | NE555 | `DIP-8_W7.62mm_Socket` | 182.19 | 88.19 | 0 | GND / N2_TR / N2_OUT / N2_RST / N2_CV / N2_TH / N2_DIS / VCC |
| RA2 | 10kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 149 | 35 | 0 | N2_RAa / N2_RAb |
| RB2 | 10kΩ | `R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal` | 199 | 35 | 0 | N2_RBa / N2_RBb |
| C2 | 0.047μF | `C_Disc_D5.0mm_W2.5mm_P5.00mm` | 153 | 160 | 0 | N2_CTp / N2_CTn |
| C4 | 0.01μF | `C_Disc_D5.0mm_W2.5mm_P5.00mm` | 201.5 | 160 | 0 | N2_CCa / N2_CCb |
| LS1 | 8Ω 0.5W | `PinHeader_1x02_P2.54mm_Vertical` | 252 | 58 | 0 | nSPKp / nSPKn |
| C5 | 100μF | `CP_Radial_D5.0mm_P2.50mm` | 252 | 118 | 270 | nC5p / nC5n |

区块丝印：555 定时器应用；IC1 NE555；IC2 NE555；扬声器 8Ω/0.5W（装于背面）。每个插孔上方印插孔名，每个元件旁印“位号 值”，同一网络之间印连线。
