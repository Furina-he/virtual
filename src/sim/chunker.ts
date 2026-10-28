// 把 ngspice 逐点输出（步长不均匀）线性插值到等间隔网格，攒成块（技术设计 §5.1）。
// 纯 TS，不依赖 ngspice / Electron，便于单测。

export interface Block {
  seq: number
  t0: number
  dt: number
  data: Record<string, Float32Array<ArrayBuffer>>
}

export class Chunker {
  private seq = 0
  // 下一个网格点序号；网格时间 = k * dt，用整数避免累积误差
  private k = 0
  private fill = 0
  private blockT0 = 0
  private bufs: Float32Array<ArrayBuffer>[] = []
  private prevT = Number.NaN
  private prev: Float64Array

  constructor(
    private readonly ids: string[],
    readonly dt: number,
    private readonly blockSize: number,
    private readonly emit: (block: Block) => void,
  ) {
    this.prev = new Float64Array(ids.length)
    this.alloc()
  }

  private alloc(): void {
    this.bufs = this.ids.map(() => new Float32Array(this.blockSize))
    this.fill = 0
  }

  /** 已填入当前块的点数 */
  get pending(): number {
    return this.fill
  }

  /** 送入一个仿真点；values 与 ids 一一对应，调用后即可复用 */
  push(t: number, values: ArrayLike<number>): void {
    const n = this.ids.length
    const prevT = this.prevT
    for (let g = this.k * this.dt; g <= t + this.dt * 1e-9; g = this.k * this.dt) {
      if (this.fill === 0) this.blockT0 = g
      const span = t - prevT
      const a = Number.isNaN(prevT) || span <= 0 ? 1 : (g - prevT) / span
      for (let i = 0; i < n; i++) {
        const p = Number.isNaN(prevT) ? (values[i] ?? 0) : (this.prev[i] ?? 0)
        ;(this.bufs[i] as Float32Array)[this.fill] = p + ((values[i] ?? 0) - p) * a
      }
      this.fill++
      this.k++
      if (this.fill === this.blockSize) this.flush()
    }
    this.prevT = t
    for (let i = 0; i < n; i++) this.prev[i] = values[i] ?? 0
  }

  /** 把未满的块发出去（按时间间隔定期调用） */
  flush(): void {
    if (this.fill === 0) return
    const data: Record<string, Float32Array<ArrayBuffer>> = {}
    this.ids.forEach((id, i) => {
      const buf = this.bufs[i] as Float32Array<ArrayBuffer>
      data[id] = this.fill === this.blockSize ? buf : buf.slice(0, this.fill)
    })
    const block = { seq: this.seq++, t0: this.blockT0, dt: this.dt, data }
    if (this.fill === this.blockSize) this.alloc()
    else this.fill = 0
    this.emit(block)
  }
}
