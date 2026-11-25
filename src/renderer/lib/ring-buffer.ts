// 每个探针一个 Float32Array 环形缓冲（技术设计 §4.2）。
// 写入来自数据端口，读取在 rAF / useFrame 中进行；不进 React state。

export class RingBuffer {
  readonly data: Float32Array
  /** 已写入的总点数（单调递增），可用于判断是否有新数据 */
  written = 0
  /** 最近一次在线参数变更（alter）时的写入位置；自动测量只取变更后的新采样，原始缓冲仍保留连续显示历史 */
  boundary = 0
  /** 最新一点对应的仿真时间 */
  lastTime = 0
  dt = 0

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity)
  }

  get length(): number {
    return Math.min(this.written, this.capacity)
  }

  /** 自最近一次在线参数变更边界起，当前缓冲内可用的有效新点数 */
  get sinceBoundary(): number {
    return Math.min(this.length, Math.max(0, this.written - this.boundary))
  }

  /** 标记在线参数变更边界，不清空缓冲内已保留的连续显示波形 */
  markBoundary(): void {
    this.boundary = this.written
  }

  /** 追加一段等间隔采样，t0 为 samples[0] 的时间 */
  push(samples: Float32Array, t0 = 0, dt = 0): void {
    const n = samples.length
    if (n === 0) return
    const cap = this.capacity
    // 超过容量只保留尾部
    const src = n > cap ? samples.subarray(n - cap) : samples
    const start = (this.written + n - src.length) % cap
    const first = Math.min(src.length, cap - start)
    this.data.set(src.subarray(0, first), start)
    if (first < src.length) this.data.set(src.subarray(first), 0)
    this.written += n
    this.dt = dt
    this.lastTime = t0 + (n - 1) * dt
  }

  /** 第 i 个最新点（0 为最新） */
  latest(i = 0): number {
    if (i >= this.length) return Number.NaN
    return this.data[(this.written - 1 - i) % this.capacity] ?? Number.NaN
  }

  /** 把最近 out.length 个点按时间顺序拷入 out，返回实际拷贝点数（不足时右对齐） */
  copyLatest(out: Float32Array): number {
    const n = Math.min(out.length, this.length)
    const cap = this.capacity
    const start = (this.written - n) % cap
    const first = Math.min(n, cap - start)
    const offset = out.length - n
    out.set(this.data.subarray(start, start + first), offset)
    if (first < n) out.set(this.data.subarray(0, n - first), offset + first)
    return n
  }

  clear(): void {
    this.written = 0
    this.boundary = 0
    this.lastTime = 0
  }
}
