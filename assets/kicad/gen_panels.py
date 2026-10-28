# 生成首批 3 块挂箱面板的 KiCad 8 .kicad_pcb、jacks.csv、layout.md
# 坐标单位 mm，原点为板左上角，y 向下（KiCad 约定）。
# 用法: python -I gen_panels.py  （输出到本目录下 <module-id>/）
# 生成的文件未经 KiCad 打开校验；封装为简化内嵌版本，打开后应执行“从库更新封装”。
import math
import os
import sys
import uuid

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
OX, OY = 30.0, 30.0  # 板在图纸上的偏移

JACK_FP = {
    "R": "Connector:Banana_Cliff_FCR7350R_S16N-PC_Horizontal",
    "B": "Connector:Banana_Cliff_FCR7350B_S16N-PC_Horizontal",
    "Y": "Connector:Banana_Cliff_FCR7350Y_S16N-PC_Horizontal",
    "G": "Connector:Banana_Cliff_FCR7350G_S16N-PC_Horizontal",
}
COLOR_CN = {"R": "红", "B": "黑", "Y": "黄", "G": "绿"}
# kind -> (库封装名, [(焊盘号, dx, dy, 焊盘直径, 孔径)])
FP = {
    "R": ("Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
          [("1", 0, 0, 1.6, 0.8), ("2", 10.16, 0, 1.6, 0.8)]),
    "D": ("Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal",
          [("1", 0, 0, 2.2, 1.1), ("2", 10.16, 0, 2.2, 1.1)]),
    "CP": ("Capacitor_THT:CP_Radial_D5.0mm_P2.50mm",
           [("1", 0, 0, 1.6, 0.8), ("2", 2.5, 0, 1.6, 0.8)]),
    "C": ("Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm",
          [("1", 0, 0, 1.6, 0.8), ("2", 5.0, 0, 1.6, 0.8)]),
    "POT": ("Potentiometer_THT:Potentiometer_Alps_RK09K_Single_Vertical",
            [("1", 0, 0, 1.8, 1.0), ("2", 2.5, -7, 1.8, 1.0), ("3", 5.0, 0, 1.8, 1.0)]),
    "SPDT": ("Button_Switch_THT:SW_CuK_OS102011MA1QN1_SPDT_Angled",
             [("1", -2.0, 0, 1.8, 1.0), ("2", 0, 0, 1.8, 1.0), ("3", 2.0, 0, 1.8, 1.0)]),
    "BTN": ("Button_Switch_THT:SW_PUSH_6mm",
            [("1", 0, 0, 2.0, 1.1), ("2", 6.5, 0, 2.0, 1.1), ("1", 0, 4.5, 2.0, 1.1), ("2", 6.5, 4.5, 2.0, 1.1)]),
    "TO92": ("Package_TO_SOT_THT:TO-92_Inline",
             [("1", 0, 0, 1.05, 0.75), ("2", 1.27, 0, 1.05, 0.75), ("3", 2.54, 0, 1.05, 0.75)]),
    "DIP8": ("Package_DIP:DIP-8_W7.62mm_Socket",
             [("1", 0, 0, 1.6, 0.8), ("2", 0, 2.54, 1.6, 0.8), ("3", 0, 5.08, 1.6, 0.8), ("4", 0, 7.62, 1.6, 0.8),
              ("5", 7.62, 7.62, 1.6, 0.8), ("6", 7.62, 5.08, 1.6, 0.8), ("7", 7.62, 2.54, 1.6, 0.8), ("8", 7.62, 0, 1.6, 0.8)]),
    "SPK": ("Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
            [("1", 0, 0, 1.7, 1.0), ("2", 0, 2.54, 1.7, 1.0)]),
}


def U():
    return str(uuid.uuid4())


def rot(dx, dy, a):
    # KiCad：角度逆时针为正，y 轴向下
    r = math.radians(a)
    return dx * math.cos(r) + dy * math.sin(r), -dx * math.sin(r) + dy * math.cos(r)


def font(size):
    th = round(size * 0.15, 2)
    return f"(effects\n\t\t\t(font\n\t\t\t\t(size {size} {size})\n\t\t\t\t(thickness {th})\n\t\t\t)"


def gtext(s, x, y, size, just=None):
    j = f"\n\t\t\t(justify {just})" if just else ""
    return (f'\t(gr_text "{s}"\n\t\t(at {x + OX:.2f} {y + OY:.2f} 0)\n\t\t(layer "F.SilkS")\n\t\t(uuid "{U()}")\n'
            f"\t\t{font(size)}{j}\n\t\t)\n\t)")


def gline(x1, y1, x2, y2, w=0.3):
    return (f"\t(gr_line\n\t\t(start {x1 + OX:.2f} {y1 + OY:.2f})\n\t\t(end {x2 + OX:.2f} {y2 + OY:.2f})\n"
            f'\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type default)\n\t\t)\n\t\t(layer "F.SilkS")\n\t\t(uuid "{U()}")\n\t)')


def grect(x1, y1, x2, y2, layer, w):
    return (f"\t(gr_rect\n\t\t(start {x1 + OX:.2f} {y1 + OY:.2f})\n\t\t(end {x2 + OX:.2f} {y2 + OY:.2f})\n"
            f'\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type default)\n\t\t)\n\t\t(fill none)\n\t\t(layer "{layer}")\n\t\t(uuid "{U()}")\n\t)')


LAYERS = [(0, "F.Cu", "signal"), (31, "B.Cu", "signal"), (32, "B.Adhes", "user", "B.Adhesive"),
          (33, "F.Adhes", "user", "F.Adhesive"), (34, "B.Paste", "user"), (35, "F.Paste", "user"),
          (36, "B.SilkS", "user", "B.Silkscreen"), (37, "F.SilkS", "user", "F.Silkscreen"),
          (38, "B.Mask", "user"), (39, "F.Mask", "user"), (40, "Dwgs.User", "user", "User.Drawings"),
          (41, "Cmts.User", "user", "User.Comments"), (42, "Eco1.User", "user", "User.Eco1"),
          (43, "Eco2.User", "user", "User.Eco2"), (44, "Edge.Cuts", "user"), (45, "Margin", "user"),
          (46, "B.CrtYd", "user", "B.Courtyard"), (47, "F.CrtYd", "user", "F.Courtyard"),
          (48, "B.Fab", "user"), (49, "F.Fab", "user")]


class Board:
    def __init__(self, mid, title, w, h, ref_note):
        self.mid, self.title, self.w, self.h, self.ref_note = mid, title, w, h, ref_note
        self.jacks, self.parts, self.texts, self.frames = [], [], [], []
        self.nopaint = {"VCC", "GND"}  # 这些网络不画面板连线

    def jack(self, jid, label, x, y, color, net, note=""):
        self.jacks.append(dict(id=jid, label=label, x=x, y=y, color=color, net=net, note=note))

    def part(self, ref, kind, value, x, y, a, nets, label=None):
        self.parts.append(dict(ref=ref, kind=kind, value=value, x=x, y=y, a=a, nets=nets, label=label))

    def text(self, s, x, y, size=2.5, just=None):
        self.texts.append((s, x, y, size, just))

    def frame(self, x1, y1, x2, y2):
        self.frames.append((x1, y1, x2, y2))

    def netmap(self):
        names = []
        for j in self.jacks:
            if j["net"] not in names:
                names.append(j["net"])
        for p in self.parts:
            for n in p["nets"]:
                if n and n not in names:
                    names.append(n)
        return {n: i + 1 for i, n in enumerate(names)}

    def pad_net(self, p, num):
        i = int(num) - 1
        return p["nets"][i] if i < len(p["nets"]) else None

    def pad_abs(self, p):
        out = []
        for num, dx, dy, _s, _d in FP[p["kind"]][1]:
            rx, ry = rot(dx, dy, p["a"])
            out.append((num, round(p["x"] + rx, 2), round(p["y"] + ry, 2)))
        return out

    def fp_block(self, nets, fpname, ref, value, x, y, a, pads):
        ang = f" {a}" if a else ""
        s = [f'\t(footprint "{fpname}"\n\t\t(layer "F.Cu")\n\t\t(uuid "{U()}")\n\t\t(at {x + OX:.2f} {y + OY:.2f}{ang})']
        for name, val, py, hide in (("Reference", ref, -7, False), ("Value", value, 7, False), ("Footprint", fpname, 0, True)):
            extra = "\n\t\t\t(unlocked yes)" if name == "Footprint" else ""
            hid = "\n\t\t\t(hide yes)" if hide else ""
            s.append(f'\t\t(property "{name}" "{val}"\n\t\t\t(at 0 {py} {a}){extra}\n\t\t\t(layer "F.Fab"){hid}\n'
                     f'\t\t\t(uuid "{U()}")\n\t\t\t{font(1)}\n\t\t\t)\n\t\t)')
        s.append("\t\t(attr through_hole)")
        for num, dx, dy, size, drill, net in pads:
            netpart = f'\n\t\t\t(net {nets[net]} "{net}")' if net else ""
            s.append(f'\t\t(pad "{num}" thru_hole circle\n\t\t\t(at {dx} {dy}{ang})\n\t\t\t(size {size} {size})\n'
                     f'\t\t\t(drill {drill})\n\t\t\t(layers "*.Cu" "*.Mask")\n\t\t\t(remove_unused_layers no){netpart}\n'
                     f'\t\t\t(uuid "{U()}")\n\t\t)')
        s.append("\t)")
        return "\n".join(s)

    def render(self):
        nets = self.netmap()
        L = ['(kicad_pcb\n\t(version 20240108)\n\t(generator "pcbnew")\n\t(generator_version "8.0")',
             '\t(general\n\t\t(thickness 1.6)\n\t\t(legacy_teardrops no)\n\t)\n\t(paper "A3")',
             f'\t(title_block\n\t\t(title "{self.title}")\n\t\t(date "2026-10-28")\n\t\t(rev "A")\n'
             f'\t\t(comment 1 "{self.mid} T0.0 手写源文件，未经 KiCad 打开校验")\n\t\t(comment 2 "{self.ref_note}")\n\t)',
             "\t(layers"]
        for lay in LAYERS:
            extra = f' "{lay[3]}"' if len(lay) > 3 else ""
            L.append(f'\t\t({lay[0]} "{lay[1]}" {lay[2]}{extra})')
        L.append("\t)")
        L.append("\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t\t(allow_soldermask_bridges_in_footprints no)\n\t)")
        L.append('\t(net 0 "")')
        for n, i in nets.items():
            L.append(f'\t(net {i} "{n}")')
        for j in self.jacks:
            L.append(self.fp_block(nets, JACK_FP[j["color"]], "JACK_" + j["id"], j["label"] or j["id"],
                                   j["x"], j["y"], 0, [("1", 0, 0, 8.0, 4.2, j["net"])]))
        for p in self.parts:
            pads = [(num, dx, dy, s, d, self.pad_net(p, num)) for num, dx, dy, s, d in FP[p["kind"]][1]]
            L.append(self.fp_block(nets, FP[p["kind"]][0], p["ref"], p["value"], p["x"], p["y"], p["a"], pads))
        L.append(grect(0, 0, self.w, self.h, "Edge.Cuts", 0.1))
        for f in self.frames:
            L.append(grect(*f, "F.SilkS", 0.3))
        # 面板印制连线：同一网络的点按出现顺序用直角折线依次相连
        pts = {}
        for j in self.jacks:
            pts.setdefault(j["net"], []).append((j["x"], j["y"]))
        for p in self.parts:
            for num, x, y in self.pad_abs(p):
                n = self.pad_net(p, num)
                if n and (x, y) not in pts.setdefault(n, []):
                    pts[n].append((x, y))
        for n, ps in pts.items():
            if n in self.nopaint:
                continue
            for a, b in zip(ps, ps[1:]):
                if a[0] != b[0]:
                    L.append(gline(a[0], a[1], b[0], a[1]))
                if a[1] != b[1]:
                    L.append(gline(b[0], a[1], b[0], b[1]))
        for j in self.jacks:
            if j["label"]:
                L.append(gtext(j["label"], j["x"], j["y"] - 7, 2.0))
        for p in self.parts:
            lab = p["label"] or f'{p["ref"]} {p["value"]}'
            if p["a"] in (0, 180):
                L.append(gtext(lab, p["x"] + (5 if p["a"] == 0 else -5), p["y"] + 5, 1.8))
            else:
                L.append(gtext(lab, p["x"] + 4, p["y"] + 5, 1.8, "left"))
        for s, x, y, size, just in self.texts:
            L.append(gtext(s, x, y, size, just))
        L.append(")")
        return "\n".join(L) + "\n"


# ---------------- mod-dc-circuit 电路基础实验挂箱（一） ----------------
def dc_circuit():
    b = Board("mod-dc-circuit", "电路基础实验挂箱（一）", 290, 470, "参照天煌 DGJ-03 电路基础实验挂箱")
    J, P = b.jack, b.part
    b.text("电路基础实验（一）", 145, 8, 4.0)
    b.frame(8, 18, 282, 232)
    b.text("基尔霍夫定律 / 叠加原理", 145, 26, 3.0)
    J("KH_U1P", "U1+", 18, 90, "R", "E1P")
    J("KH_U1N", "U1-", 18, 140, "B", "E")
    J("KH_U2P", "U2+", 272, 90, "R", "E2P")
    J("KH_U2N", "U2-", 272, 140, "B", "C")
    J("KH_F", "F", 45, 60, "Y", "F")
    J("KH_A", "A", 145, 45, "Y", "A")
    J("KH_B", "B", 245, 60, "Y", "B")
    J("KH_E", "E", 45, 190, "Y", "E")
    J("KH_D", "D", 145, 190, "Y", "D")
    J("KH_C", "C", 245, 190, "Y", "C")
    J("KH_I1A", "I1", 98, 60, "G", "nFA", "电流插座 I1 左（常闭，插电流插头断开）")
    J("KH_I1B", "", 118, 60, "G", "A", "电流插座 I1 右")
    J("KH_I2A", "I2", 172, 60, "G", "A", "电流插座 I2 左")
    J("KH_I2B", "", 192, 60, "G", "nBA", "电流插座 I2 右")
    J("KH_I3A", "I3", 145, 85, "G", "A", "电流插座 I3 上")
    J("KH_I3B", "", 145, 105, "G", "nAD", "电流插座 I3 下")
    P("R1", "R", "510Ω", 62, 60, 0, ["F", "nFA"])
    P("R2", "R", "1kΩ", 205, 60, 0, ["nBA", "B"])
    P("R3", "R", "510Ω", 145, 125, 270, ["nAD", "D"])
    P("R4", "R", "510Ω", 85, 190, 0, ["E", "D"])
    P("R5", "R", "330Ω", 178, 172, 0, ["D", "nDC1"])
    P("VD1", "D", "1N4007", 190, 208, 180, ["nDC2", "D"])
    P("K1", "SPDT", "U1/短路", 45, 115, 90, ["E1P", "F", "E"], "K1")
    P("K2", "SPDT", "U2/短路", 245, 115, 90, ["E2P", "B", "C"], "K2")
    P("K3", "SPDT", "R5/VD1", 220, 190, 90, ["nDC2", "C", "nDC1"], "K3")
    P("SB1", "BTN", "故障1", 72, 218, 0, [None, None], "故障1")
    P("SB2", "BTN", "故障2", 142, 218, 0, [None, None], "故障2")
    P("SB3", "BTN", "故障3", 212, 218, 0, [None, None], "故障3")
    b.frame(8, 242, 282, 462)
    b.text("戴维南定理 / 有源二端网络", 145, 250, 3.0)
    J("TH_USP", "Us+", 20, 300, "R", "TUSP")
    J("TH_USN", "Us-", 20, 410, "B", "TCOM")
    J("TH_ISP", "Is+", 175, 330, "R", "TN2")
    J("TH_ISN", "Is-", 175, 410, "B", "TCOM")
    J("TH_IA", "I", 240, 300, "G", "TN3", "电流插座左")
    J("TH_IB", "", 262, 300, "G", "TA", "电流插座右")
    J("TH_A", "A", 262, 355, "Y", "TA")
    J("TH_B", "B", 262, 410, "B", "TCOM")
    P("R6", "R", "330Ω", 50, 300, 0, ["TUSP", "TN1"])
    P("R7", "R", "510Ω", 90, 330, 270, ["TN1", "TCOM"])
    P("R8", "R", "10Ω", 115, 300, 0, ["TN1", "TN2"])
    P("R9", "R", "510Ω", 205, 300, 0, ["TN2", "TN3"])
    b.text("Us 接直流稳压电源，Is 接恒流源", 145, 440, 2.2)
    return b


# ---------------- mod-analog-amp 共射极单管放大器实验板 ----------------
def analog_amp():
    b = Board("mod-analog-amp", "共射极单管放大器实验板", 264, 184, "参照天煌模电挂箱配套共射极单管放大器实验板")
    J, P = b.jack, b.part
    b.text("共射极单管放大器", 132, 7, 3.5)
    J("AMP_VCC", "+12V", 245, 16, "R", "VCC")
    J("AMP_GND1", "GND", 245, 170, "B", "GND")
    J("AMP_GND2", "GND", 16, 170, "B", "GND")
    J("AMP_US", "Us", 16, 95, "Y", "US")
    J("AMP_UI", "Ui", 55, 95, "Y", "UI")
    J("AMP_UB", "B", 108, 95, "Y", "B")
    J("AMP_UC", "C", 158, 70, "Y", "C")
    J("AMP_UE", "E", 158, 122, "Y", "E")
    J("AMP_UO", "Uo", 222, 70, "Y", "UO")
    J("AMP_RL", "RL", 222, 110, "Y", "RLP")
    P("R1", "R", "5.1kΩ", 27, 95, 0, ["US", "UI"], "R 5.1kΩ")
    P("C1", "CP", "10μF", 80, 95, 180, ["B", "UI"])
    P("RW", "POT", "100kΩ", 105, 32, 0, ["VCC", "nRW", "nRW"])
    P("RB1", "R", "20kΩ", 108, 50, 270, ["nRW", "B"])
    P("RB2", "R", "20kΩ", 108, 112, 270, ["B", "GND"])
    P("VT1", "TO92", "3DG6", 132, 95, 0, ["E", "B", "C"])
    P("RC", "R", "2.4kΩ", 158, 30, 270, ["VCC", "C"])
    P("RE", "R", "1kΩ", 158, 140, 270, ["E", "GND"])
    P("KCE", "SPDT", "CE接入/断开", 185, 122, 0, ["E", "nCE", None], "K CE")
    P("CE", "CP", "47μF", 185, 145, 270, ["nCE", "GND"])
    P("C2", "CP", "10μF", 190, 70, 0, ["C", "UO"])
    P("RL", "R", "2.4kΩ", 222, 130, 270, ["RLP", "GND"])
    b.text("Uo 与 RL 用短接线相连即接入负载", 132, 178, 2.0)
    return b


# ---------------- mod-555-app 555 定时器应用实验板 ----------------
def ic555():
    b = Board("mod-555-app", "555 定时器应用实验板", 264, 184, "参照天煌数电挂箱 555 应用区，元件位按 SD-13/SD-22 补齐")
    J, P = b.jack, b.part
    b.text("555 定时器应用", 132, 7, 3.5)
    J("VCC1", "+5V", 252, 20, "R", "VCC")
    J("GND1", "GND", 252, 165, "B", "GND")
    J("R5_1", "R5", 238, 118, "Y", "nR5a")
    J("R5_2", "", 238, 145, "Y", "nR5b")
    P("R5", "R", "10kΩ", 238, 126, 270, ["nR5a", "nR5b"])
    for k, dx, vals in ((1, 0, ("10kΩ", "150kΩ", "4.7μF", "0.01μF")), (2, 124, ("10kΩ", "10kΩ", "0.047μF", "0.01μF"))):
        t, n = f"T{k}_", f"N{k}_"
        ra, rb, c, cv = vals
        b.frame(6 + dx, 14, 112 + dx, 176)
        b.text(f"IC{k} NE555", 62 + dx, 20, 2.5)
        P(f"IC{k}", "DIP8", "NE555", 58.19 + dx, 88.19, 0,
          ["GND", n + "TR", n + "OUT", n + "RST", n + "CV", n + "TH", n + "DIS", "VCC"], f"IC{k}")
        J(t + "TR", "2 TR", 25 + dx, 105, "Y", n + "TR")
        J(t + "TH", "6 TH", 25 + dx, 80, "Y", n + "TH")
        J(t + "DIS", "7 DIS", 62 + dx, 60, "Y", n + "DIS")
        J(t + "RST", "4 R", 45 + dx, 130, "Y", n + "RST")
        J(t + "CV", "5 CV", 85 + dx, 130, "Y", n + "CV")
        J(t + "OUT", "3 OUT", 100 + dx, 92, "Y", n + "OUT")
        J(t + "RA_1", f"RA{k}", 15 + dx, 35, "Y", n + "RAa")
        J(t + "RA_2", "", 45 + dx, 35, "Y", n + "RAb")
        P(f"RA{k}", "R", ra, 25 + dx, 35, 0, [n + "RAa", n + "RAb"])
        J(t + "RB_1", f"RB{k}", 65 + dx, 35, "Y", n + "RBa")
        J(t + "RB_2", "", 95 + dx, 35, "Y", n + "RBb")
        P(f"RB{k}", "R", rb, 75 + dx, 35, 0, [n + "RBa", n + "RBb"])
        J(t + "CT_P", f"C{k}+", 15 + dx, 160, "Y", n + "CTp")
        J(t + "CT_N", "", 45 + dx, 160, "Y", n + "CTn")
        P(f"C{k}", "CP" if k == 1 else "C", c, 29 + dx, 160, 0, [n + "CTp", n + "CTn"])
        J(t + "CC_1", f"C{k + 2}", 65 + dx, 160, "Y", n + "CCa")
        J(t + "CC_2", "", 95 + dx, 160, "Y", n + "CCb")
        P(f"C{k + 2}", "C", cv, 77.5 + dx, 160, 0, [n + "CCa", n + "CCb"])
    J("SPK_P", "SPK", 252, 45, "Y", "nSPKp")
    J("SPK_N", "", 252, 75, "B", "nSPKn")
    P("LS1", "SPK", "8Ω 0.5W", 252, 58, 0, ["nSPKp", "nSPKn"], "LS1 8Ω")
    J("C5_P", "C5+", 252, 105, "Y", "nC5p")
    J("C5_N", "", 252, 135, "Y", "nC5n")
    P("C5", "CP", "100μF", 252, 118, 270, ["nC5p", "nC5n"])
    b.text("扬声器 8Ω/0.5W（装于背面）", 200, 180, 1.8)
    return b


def check(path, b):
    s = open(path, encoding="utf-8").read()
    depth, inq = 0, False
    for ch in s:
        if ch == '"':
            inq = not inq
        elif not inq:
            depth += (ch == "(") - (ch == ")")
            assert depth >= 0, "括号提前闭合"
    assert depth == 0 and not inq, "括号或引号不配平"
    ids = [j["id"] for j in b.jacks]
    assert len(ids) == len(set(ids)), "插孔 ID 重复"
    for j in b.jacks:
        assert j["id"].replace("_", "").isalnum(), j["id"]
        assert 6 <= j["x"] <= b.w - 6 and 6 <= j["y"] <= b.h - 6, j["id"]
    return min(math.dist((a["x"], a["y"]), (c["x"], c["y"]))
               for i, a in enumerate(b.jacks) for c in b.jacks[i + 1:])


def write(b):
    d = os.path.join(HERE, b.mid)
    os.makedirs(d, exist_ok=True)
    pcb = os.path.join(d, b.mid + ".kicad_pcb")
    with open(pcb, "w", encoding="utf-8", newline="\n") as f:
        f.write(b.render())
    with open(os.path.join(d, "jacks.csv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("anchor,jack_id,label,x_mm,y_mm,color,net,note\n")
        for j in b.jacks:
            f.write(f'JACK_{j["id"]},{j["id"]},{j["label"]},{j["x"]},{j["y"]},{COLOR_CN[j["color"]]},{j["net"]},{j["note"]}\n')
    md = [f"#### {b.mid} {b.title}", "",
          f"外形 {b.w}×{b.h} mm（板面，原点左上角，x 向右、y 向下，坐标为插孔/元件中心）。{b.ref_note}。", "",
          "| 锚点 | 丝印 | x | y | 颜色 | 内部网络 | 说明 |", "|---|---|---|---|---|---|---|"]
    for j in b.jacks:
        md.append(f'| `JACK_{j["id"]}` | {j["label"] or "—"} | {j["x"]} | {j["y"]} | {COLOR_CN[j["color"]]} | {j["net"]} | {j["note"]} |')
    md += ["", "| 位号 | 值 | 封装 | x | y | 角度 | 引脚 1/2/3… 网络 |", "|---|---|---|---|---|---|---|"]
    for p in b.parts:
        md.append(f'| {p["ref"]} | {p["value"]} | `{FP[p["kind"]][0].split(":")[1]}` | {p["x"]} | {p["y"]} | {p["a"]} | '
                  f'{" / ".join(n or "—" for n in p["nets"])} |')
    md += ["", "区块丝印：" + "；".join(t[0] for t in b.texts) + "。每个插孔上方印插孔名，每个元件旁印“位号 值”，同一网络之间印连线。", ""]
    with open(os.path.join(d, "layout.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(md))
    mind = check(pcb, b)
    print(f"{b.mid}: 插孔 {len(b.jacks)}，元件 {len(b.parts)}，最小插孔中心距 {mind:.1f} mm")


if __name__ == "__main__":
    for board in (dc_circuit(), analog_amp(), ic555()):
        write(board)
