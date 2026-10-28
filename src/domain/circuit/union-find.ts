// 插孔合并为网络（技术设计 §5.2 第 3 步）
export class UnionFind<T> {
  private parent = new Map<T, T>()

  add(x: T): void {
    if (!this.parent.has(x)) this.parent.set(x, x)
  }

  find(x: T): T {
    this.add(x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root) as T
    // 路径压缩
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur) as T
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: T, b: T): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }

  /** 全部分组，组内与组间都按插入顺序排列 */
  groups(): T[][] {
    const byRoot = new Map<T, T[]>()
    for (const x of this.parent.keys()) {
      const r = this.find(x)
      const g = byRoot.get(r)
      if (g) g.push(x)
      else byRoot.set(r, [x])
    }
    return [...byRoot.values()]
  }
}
