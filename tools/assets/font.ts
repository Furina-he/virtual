import { readFileSync } from 'node:fs'
import { workspacePath } from './paths.ts'

export function embeddedPanelFont(text: string): string {
  const root = 'node_modules/@fontsource-variable/noto-sans-sc'
  const source = readFileSync(workspacePath(`${root}/index.css`), 'utf8')
  const points = new Set(Array.from(text, (character) => character.codePointAt(0) ?? 0))
  return [...source.matchAll(/@font-face\s*\{([^}]+)\}/g)]
    .filter((match) => {
      const ranges = match[1]?.match(/unicode-range:\s*([^;]+)/)?.[1]?.split(',') ?? []
      return ranges.some((range) => {
        const [min, max = min] = range.trim().replace(/^U\+/i, '').split('-')
        return [...points].some(
          (point) => point >= Number.parseInt(min ?? '', 16) && point <= Number.parseInt(max ?? '', 16),
        )
      })
    })
    .map((match) => {
      const block = match[0]
        .replace('Noto Sans SC Variable', 'Asset Panel Font')
        .replace('font-display: swap;', 'font-display: block;')
      return block.replace(/url\(\.\/files\/([^)]+)\)/, (_url, name: string) => {
        const bytes = readFileSync(workspacePath(`${root}/files/${name}`))
        return `url(data:font/woff2;base64,${bytes.toString('base64')})`
      })
    })
    .join('\n')
}
