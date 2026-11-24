import { Maximize2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { projectSchematic, projectSchematicSvg } from '@/features/practice/practice-content'
import { circuitStore, jackName, useCircuit, useWiringJacks } from '@/features/practice/wiring-state'
import { useBenchView } from '@/three/bench-view'
import type { Project } from '../../../shared/schema/project'
import { extractSchematicJackLinks, resolveJackRefFromElement, resolveSchematicJackClick } from './schematic-link'

function InteractiveSvgCanvas({
  schematicUrl,
  svgText,
  imageAlt,
  availableJackRefs,
  activeJack,
  pendingJack,
  syncBenchHover = true,
  onHoverJack,
  onClickJack,
}: {
  schematicUrl: string
  svgText: string
  imageAlt: string
  availableJackRefs: readonly string[]
  activeJack: string | null
  pendingJack: string | null
  syncBenchHover?: boolean
  onHoverJack: (jackRef: string | null) => void
  onClickJack: (jackRef: string, options: { shiftKey: boolean; focusBench: boolean }) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const linkedElementsRef = useRef<Map<string, Element[]>>(new Map())

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.tagName.toLowerCase() !== 'svg') return

    // 防御性移除潜在脚本；移除标题/描述避免与底图 <img> 在无障碍树中重复暴露为第二张图片
    for (const bad of Array.from(svg.querySelectorAll('script, title, desc'))) bad.remove()
    svg.removeAttribute('role')
    svg.removeAttribute('aria-label')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

    const imported = document.importNode(svg, true)
    container.replaceChildren(imported)

    const map = new Map<string, Element[]>()
    const cleanups: (() => void)[] = []

    const candidates = Array.from(imported.querySelectorAll('[data-jack], [data-jack-id], [id^="JACK_"]'))
    for (const element of candidates) {
      const resolved = resolveJackRefFromElement(
        {
          dataJack: element.getAttribute('data-jack'),
          dataJackId: element.getAttribute('data-jack-id'),
          id: element.getAttribute('id'),
        },
        availableJackRefs,
      )
      if (!resolved) continue
      const jackRef = resolved.jackRef
      element.setAttribute('data-linked-jack', jackRef)
      element.setAttribute('role', 'button')
      element.setAttribute('tabindex', '0')
      element.setAttribute('aria-label', `原理图插孔 ${jackRef}`)

      const group = map.get(jackRef) ?? []
      group.push(element)
      map.set(jackRef, group)

      const onEnter = () => {
        onHoverJack(jackRef)
        if (syncBenchHover) {
          useBenchView.getState().setHover({ hoveredJack: jackRef })
        }
      }
      const onLeave = () => {
        onHoverJack(null)
        if (syncBenchHover && useBenchView.getState().hoveredJack === jackRef) {
          useBenchView.getState().setHover({ hoveredJack: null })
        }
      }
      const onActivate = (event: Event) => {
        event.stopPropagation()
        const shiftKey = 'shiftKey' in event ? Boolean((event as MouseEvent | KeyboardEvent).shiftKey) : false
        if (syncBenchHover) {
          useBenchView.getState().setHover({ hoveredJack: jackRef })
        }
        onClickJack(jackRef, { shiftKey, focusBench: syncBenchHover })
      }
      const onKeyDown = (event: Event) => {
        const keyEvent = event as KeyboardEvent
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault()
          onActivate(event)
        }
      }

      element.addEventListener('mouseenter', onEnter)
      element.addEventListener('mouseleave', onLeave)
      element.addEventListener('focus', onEnter)
      element.addEventListener('blur', onLeave)
      element.addEventListener('click', onActivate)
      element.addEventListener('keydown', onKeyDown)
      cleanups.push(() => {
        element.removeEventListener('mouseenter', onEnter)
        element.removeEventListener('mouseleave', onLeave)
        element.removeEventListener('focus', onEnter)
        element.removeEventListener('blur', onLeave)
        element.removeEventListener('click', onActivate)
        element.removeEventListener('keydown', onKeyDown)
      })
    }

    linkedElementsRef.current = map
    return () => {
      for (const cleanup of cleanups) cleanup()
      linkedElementsRef.current = new Map()
    }
  }, [svgText, availableJackRefs, syncBenchHover, onHoverJack, onClickJack])

  useEffect(() => {
    for (const [jackRef, elements] of linkedElementsRef.current.entries()) {
      const highlighted = activeJack === jackRef
      const isPending = pendingJack === jackRef
      for (const element of elements) {
        if (highlighted) element.setAttribute('data-schematic-highlighted', 'true')
        else element.removeAttribute('data-schematic-highlighted')
        if (isPending) element.setAttribute('data-schematic-pending', 'true')
        else element.removeAttribute('data-schematic-pending')
      }
    }
  }, [activeJack, pendingJack])

  return (
    <div className="relative overflow-hidden rounded-md border bg-background">
      <img src={schematicUrl} alt={imageAlt} className="block w-full select-none object-contain" />
      <div ref={containerRef} className="schematic-viewer absolute inset-0" />
    </div>
  )
}

/** 交互式原理图查看器（PRD 14.3 #6、TSK-02、T1.9B）：与 3D 台面双向高亮联动并支持两点直连。 */
export function SchematicViewer({ project }: { project: Project }) {
  const schematicUrl = projectSchematic(project)
  const svgText = projectSchematicSvg(project)
  const jacks = useWiringJacks()
  const hoveredJack = useBenchView((s) => s.hoveredJack)
  const pendingJack = useCircuit((s) => s.pendingJack)
  const pendingRewire = useCircuit((s) => s.pendingRewire)
  const wires = useCircuit((s) => s.wires)
  const [localHover, setLocalHover] = useState<string | null>(null)
  const [selectedJack, setSelectedJack] = useState<string | null>(null)

  const availableJackRefs = useMemo(() => jacks.map((jack) => jack.ref), [jacks])
  const links = useMemo(
    () => (svgText ? extractSchematicJackLinks(svgText, availableJackRefs) : []),
    [svgText, availableJackRefs],
  )
  const activeJack = hoveredJack ?? localHover ?? pendingJack ?? selectedJack

  const handleJackClick = useCallback((jackRef: string, options: { shiftKey: boolean; focusBench: boolean }) => {
    setSelectedJack(jackRef)
    const state = circuitStore.getState()
    if (state.pendingRewire) {
      state.completeConnection(jackRef)
      return
    }
    const decision = resolveSchematicJackClick(state.pendingJack, jackRef)
    if (decision.action === 'start') {
      if (state.setPendingJack(decision.source) && options.focusBench) {
        const [instanceId] = jackRef.split('.')
        if (instanceId) useBenchView.getState().focus(instanceId)
      }
      return
    }
    if (decision.action === 'cancel') {
      state.cancelConnection()
      return
    }
    state.completeConnection(decision.target, { keepSource: options.shiftKey })
  }, [])

  if (!svgText || !schematicUrl) return <p className="p-3 text-muted-foreground">该项目的原理图尚未交付。</p>

  const activeWireCount = activeJack ? wires.filter((wire) => wire.a === activeJack || wire.b === activeJack).length : 0

  return (
    <section
      aria-label="交互式原理图"
      data-schematic-project={project.id}
      data-schematic-linked-count={links.length}
      data-schematic-active-jack={activeJack ?? ''}
      data-schematic-pending-jack={pendingJack ?? ''}
      className="space-y-3 p-3"
    >
      <InteractiveSvgCanvas
        schematicUrl={schematicUrl}
        svgText={svgText}
        imageAlt={`${project.id} 原理图`}
        availableJackRefs={availableJackRefs}
        activeJack={activeJack}
        pendingJack={pendingJack}
        onHoverJack={setLocalHover}
        onClickJack={handleJackClick}
      />

      <div className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">
            已关联插孔：<span className="font-mono text-foreground">{links.length}</span>
          </span>
          {pendingJack ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label="取消原理图待接线"
              onClick={() => circuitStore.getState().cancelConnection()}
            >
              <X className="size-3" />
              取消待接线
            </Button>
          ) : (
            activeJack && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  circuitStore.getState().setPendingJack(activeJack)
                }}
              >
                设为接线起点
              </Button>
            )
          )}
        </div>
        <p data-schematic-status className="font-mono text-xs text-muted-foreground">
          {pendingJack
            ? `${pendingRewire ? '待改接固定端' : '待接线起点'}：${jackName(pendingJack)}（${pendingJack}）· 点击另一插孔直接连线`
            : activeJack
              ? `高亮插孔：${jackName(activeJack)}（${activeJack}）· 已连导线 ${activeWireCount} 根`
              : '点击原理图上任意两个插孔可直接连线；悬停可与 3D 实训台双向高亮。'}
        </p>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (open) useBenchView.getState().setHover({ hoveredJack: null })
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Maximize2 />
            放大原理图
          </Button>
        </DialogTrigger>
        <DialogContent
          className="sm:max-w-5xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement).focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{project.title}：原理图</DialogTitle>
            <DialogDescription>
              {pendingJack
                ? `当前起点：${jackName(pendingJack)} — 点击另一插孔直接完成真实接线，再次点击同孔或按 Esc 取消。`
                : '插孔编号与当前挂箱一致；依次点击两个插孔可直接完成真实接线（走断电与重复线校验）。'}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-128 overflow-auto">
            <InteractiveSvgCanvas
              schematicUrl={schematicUrl}
              svgText={svgText}
              imageAlt={`${project.id} 放大原理图`}
              availableJackRefs={availableJackRefs}
              activeJack={activeJack}
              pendingJack={pendingJack}
              syncBenchHover={false}
              onHoverJack={setLocalHover}
              onClickJack={handleJackClick}
            />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
