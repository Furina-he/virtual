import type { AssetDefinition, PanelText } from './types.ts'

const ink = 'hsl(210, 15%, 23%)'
const rule = 'hsl(210, 9%, 57%)'
const paper = 'hsl(45, 18%, 94%)'
const accent = 'hsl(197, 27%, 31%)'

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    }
    return entities[character] ?? character
  })
}

function text(item: PanelText, fill = ink): string {
  return `<text x="${item.x}" y="${item.y}" font-size="${item.size}" text-anchor="${item.align ?? 'middle'}" font-weight="${item.weight ?? 500}" fill="${fill}">${escapeXml(item.text)}</text>`
}

export function panelSvg(definition: AssetDefinition): string {
  const width = definition.dimensionsMm[0]
  const height = definition.bodyStyle === 'bench' ? 80 : definition.dimensionsMm[1]
  const [textureWidth, textureHeight] = definition.textureSize ?? [1024, 1024]
  const panel = definition.panel
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${textureWidth}" height="${textureHeight}" viewBox="0 0 ${width} ${height}">`,
    '<g font-family="Noto Sans SC, Microsoft YaHei, sans-serif" stroke-linecap="round" stroke-linejoin="round">',
    `<rect width="${width}" height="${height}" fill="${paper}"/>`,
  ]

  if (definition.bodyStyle === 'bench') {
    elements.push(
      `<rect x="0" y="0" width="12" height="${height}" fill="${accent}"/>`,
      text({ text: panel?.title ?? definition.name, x: width / 2, y: 34, size: 22, weight: 700 }),
      text({ text: panel?.subtitle ?? '', x: width / 2, y: 59, size: 11.5 }, accent),
      '</g></svg>',
    )
    return elements.join('\n')
  }

  const isModule = definition.bodyStyle === 'module'
  const titleSize = panel?.titleSize ?? Math.min(5, width / 25)
  const titleY = definition.bodyStyle === 'supply' ? 19 : isModule ? 12 : 10
  elements.push(
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="2" fill="none" stroke="${rule}" stroke-width="0.5"/>`,
    text({ text: panel?.title ?? definition.name, x: width / 2, y: titleY, size: titleSize, weight: 700 }),
  )
  if (panel?.subtitle) {
    elements.push(text({ text: panel.subtitle, x: width / 2, y: titleY + 10, size: titleSize * 0.5 }, accent))
  }

  for (const frame of panel?.frames ?? []) {
    elements.push(
      `<rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="2" fill="none" stroke="${rule}" stroke-width="0.6"/>`,
    )
    if (frame.label) {
      elements.push(
        text(
          {
            text: frame.label,
            x: frame.x + frame.width / 2,
            y: frame.y + 10,
            size: Math.min(4.2, frame.width / 59),
            weight: 700,
          },
          accent,
        ),
      )
    }
  }

  // These lines are printed internal circuit symbols, never simulated patch cords.
  for (const line of panel?.lines ?? []) {
    elements.push(
      `<polyline points="${line.points.map((point) => point.join(',')).join(' ')}" fill="none" stroke="${ink}" stroke-width="${line.width ?? 0.6}"/>`,
    )
  }
  for (const symbol of panel?.symbols ?? []) {
    const half = symbol.length / 2
    const bodyHalf = Math.min(half * 0.55, 7)
    const inner =
      symbol.kind === 'resistor'
        ? `<rect x="${-bodyHalf}" y="-3" width="${bodyHalf * 2}" height="6" fill="${paper}"/>`
        : `<path d="M -4 -3 L 4 0 L -4 3 Z M 4 -3.5 V 3.5" fill="${paper}"/>`
    elements.push(
      `<g transform="translate(${symbol.x} ${symbol.y}) rotate(${symbol.angle ?? 0})" stroke="${ink}" stroke-width="0.65"><path d="M ${-half} 0 H ${half}" fill="none"/>${inner}</g>`,
      text({
        text: symbol.label,
        x: symbol.labelX ?? symbol.x,
        y: symbol.labelY ?? symbol.y + 10,
        size: 3.1,
      }),
    )
  }

  for (const screen of definition.screens) {
    elements.push(
      `<rect x="${screen.x - screen.width / 2 - 2}" y="${screen.y - screen.height / 2 - 2}" width="${screen.width + 4}" height="${screen.height + 4}" rx="1.5" fill="${ink}"/>`,
    )
  }
  for (const jack of definition.jacks) {
    const label = jack.silkLabel ?? jack.label
    if (label) {
      elements.push(
        text({
          text: label,
          x: jack.labelX ?? jack.x,
          y: jack.labelY ?? jack.y - (jack.kind === 'bnc' ? 9 : 7.5),
          size: isModule ? 3.5 : Math.min(3.5, width / 33),
          weight: 650,
        }),
      )
    }
  }
  for (const control of definition.controls) {
    const radius = control.radiusMm ?? (control.kind === 'knob' ? 8 : 4)
    if (control.kind === 'knob') {
      for (let index = 0; index <= 10; index++) {
        const angle = ((135 + index * 27) * Math.PI) / 180
        const inner = radius + 2
        const outer = inner + (index % 5 === 0 ? 2.4 : 1.3)
        elements.push(
          `<path d="M ${control.x + Math.cos(angle) * inner} ${control.y + Math.sin(angle) * inner} L ${control.x + Math.cos(angle) * outer} ${control.y + Math.sin(angle) * outer}" stroke="${rule}" stroke-width="0.55"/>`,
        )
      }
    }
    elements.push(
      text({
        text: control.label,
        x: control.labelX ?? control.x,
        y: control.labelY ?? control.y + radius + 6,
        size: Math.min(3.3, width / 34),
      }),
    )
  }
  for (const led of definition.leds ?? []) {
    elements.push(text({ text: led.label, x: led.x + 4, y: led.y + 1, size: 2.7, align: 'start' }))
  }
  for (const item of panel?.texts ?? []) elements.push(text(item))
  if (panel?.footer) {
    elements.push(text({ text: panel.footer, x: width / 2, y: height - 9, size: Math.min(3.5, width / 60) }, accent))
  }
  elements.push('</g></svg>')
  return elements.join('\n')
}
