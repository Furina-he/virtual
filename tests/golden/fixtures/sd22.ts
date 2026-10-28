// SD-22 救护车报警电路测试网表（PRD 第 7 节，SIM-13 音频验证用）。
// IC1 低频多谐（约 0.7 Hz）输出经 RM 调制 IC2 的 CTRL 脚，IC2 音频多谐（约 0.6~1.1 kHz 往复），
// 输出经 100 µF 耦合电容推 8 Ω 扬声器（串 0.1 mH 音圈电感）。
import { resolve, sep } from 'node:path'

export const SPICE_LIB_DIR = resolve(import.meta.dirname, '../../../content/models/spice')

const inc = (file: string) => `.include "${resolve(SPICE_LIB_DIR, file).replaceAll(sep, '/')}"`

/** 扬声器两端节点（spk 对地） */
export const SD22_SPEAKER = 'spk'

export function sd22Netlist(): string {
  return [
    'SD-22 ambulance siren',
    inc('timers.lib'),
    'VCC vcc 0 DC 6',
    // IC1：f = 1.44/((RA1+2RB1)C1) ≈ 0.69 Hz
    'RA1 vcc dis1 10k',
    'RB1 dis1 th1 100k',
    'C1 th1 0 10u',
    'C51 ctrl1 0 10n',
    'X1 0 th1 out1 vcc ctrl1 th1 dis1 vcc NE555',
    // IC1 输出调制 IC2 的控制电压
    'RM out1 ctrl2 10k',
    // IC2：CTRL 悬空时 f = 1.44/((RA2+2RB2)C2) ≈ 1.0 kHz
    'RA2 vcc dis2 10k',
    'RB2 dis2 th2 10k',
    'C2 th2 0 47n',
    'X2 0 th2 out2 vcc ctrl2 th2 dis2 vcc NE555',
    'CO out2 spk 100u',
    'RSPK spk sp1 8',
    'LSPK sp1 0 0.1m',
    '.end',
  ].join('\n')
}
