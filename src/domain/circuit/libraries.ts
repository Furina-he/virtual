/** Resolve only bundled named model libraries; runtime never opens arbitrary filesystem paths. */
export function expandLocalLibraries(
  text: string,
  libraries: Readonly<Record<string, string>>,
  stack: readonly string[] = [],
): string {
  const included = new Set<string>()
  const expand = (source: string, ancestors: readonly string[]): string =>
    source
      .split(/\r?\n/)
      .map((line) => {
        if (!/^\s*\.(?:include|inc|lib)\b/i.test(line)) return line
        const match = /^\s*\.include\s+(?:"([A-Za-z0-9_-]+\.lib)"|([A-Za-z0-9_-]+\.lib))\s*$/i.exec(line)
        const name = match?.[1] ?? match?.[2]
        if (!name || !Object.hasOwn(libraries, name))
          throw new Error(`本地模型库不存在或引用路径无效：${line.trim()}。`)
        if (ancestors.includes(name)) throw new Error(`本地模型库存在循环引用：${[...ancestors, name].join(' → ')}。`)
        if (included.has(name)) return ''
        included.add(name)
        return expand(libraries[name] as string, [...ancestors, name])
      })
      .join('\n')
  return expand(text, stack)
}
