/** Resolve only bundled named model libraries; runtime never opens arbitrary filesystem paths. */
export function expandLocalLibraries(
  text: string,
  libraries: Readonly<Record<string, string>>,
  stack: readonly string[] = [],
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!/^\s*\.include\b/i.test(line)) return line
      const match = /^\s*\.include\s+(?:"([A-Za-z0-9_-]+\.lib)"|([A-Za-z0-9_-]+\.lib))\s*$/i.exec(line)
      const name = match?.[1] ?? match?.[2]
      if (!name || !Object.hasOwn(libraries, name)) throw new Error(`本地模型库不存在或引用路径无效：${line.trim()}。`)
      if (stack.includes(name)) throw new Error(`本地模型库存在循环引用：${[...stack, name].join(' → ')}。`)
      return expandLocalLibraries(libraries[name] as string, libraries, [...stack, name])
    })
    .join('\n')
}
