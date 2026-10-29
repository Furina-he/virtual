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

/** Bundled dependencies shared by different modules must define a global model/subcircuit only once. */
export function deduplicateSpiceDefinitions(text: string): string {
  const definitions = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  const output: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const header = /^\s*\.(subckt|model)\s+(\S+)/i.exec(line)
    if (!header) {
      output.push(line)
      continue
    }
    const block = [line]
    if (header[1]?.toLowerCase() === 'subckt') {
      let depth = 1
      while (depth > 0 && i + 1 < lines.length) {
        const next = lines[++i] as string
        block.push(next)
        if (/^\s*\.subckt\b/i.test(next)) depth++
        if (/^\s*\.ends\b/i.test(next)) depth--
      }
      if (depth) throw new Error(`本地子电路未结束：${header[2]}。`)
    } else {
      while (i + 1 < lines.length && /^\s*\+/.test(lines[i + 1] as string)) block.push(lines[++i] as string)
    }
    const name = `${header[1]}:${header[2]}`.toLowerCase()
    const definition = block.join('\n')
    const previous = definitions.get(name)
    if (previous !== undefined && previous !== definition)
      throw new Error(`本地模型/子电路重复定义不一致：${header[2]}。`)
    if (previous === undefined) {
      definitions.set(name, definition)
      output.push(definition)
    }
  }
  return output.join('\n')
}
