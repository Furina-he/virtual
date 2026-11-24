import { BookOpen, FolderKanban, Home, Monitor, Moon, Settings as SettingsIcon, Sun } from 'lucide-react'
import { useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useNavigate } from 'react-router'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { projectCatalog } from '@/features/practice/practice-content'
import { SettingsDialog } from '@/features/settings/settings-dialog'
import { settingsStore, useSettings } from '@/stores/settings'
import { taskStore } from '@/stores/task'

export function GlobalCommandAndSettings() {
  const navigate = useNavigate()
  const open = useSettings((s) => s.commandOpen)
  const setOpen = useSettings((s) => s.setCommandOpen)
  const setSettingsOpen = useSettings((s) => s.setSettingsOpen)
  const settings = useSettings((s) => s.settings)
  const presentationMode = useSettings((s) => s.presentationMode)
  const togglePresentationMode = useSettings((s) => s.togglePresentationMode)
  const updateSettings = useSettings((s) => s.updateSettings)

  useEffect(() => {
    void settingsStore.getState().hydrate()
  }, [])

  // PRD 15.5：Ctrl+K 打开命令面板，F1 打开当前项目实训指导
  useHotkeys(
    'ctrl+k, meta+k',
    (event) => {
      event.preventDefault()
      setOpen(!settingsStore.getState().commandOpen)
    },
    { enableOnFormTags: true, preventDefault: true },
  )

  useHotkeys(
    'f1',
    (event) => {
      event.preventDefault()
      taskStore.setState({ leftTab: 'guide' })
      window.dispatchEvent(new CustomEvent('virtual:open-guide'))
    },
    { enableOnFormTags: true, preventDefault: true },
  )

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen} title="命令面板" description="搜索实训项目、学习模式或快捷操作">
        <Command>
          <CommandInput placeholder="搜索项目编号、名称或命令…" aria-label="搜索命令或项目" />
          <CommandList>
            <CommandEmpty>未找到匹配的项目或命令。</CommandEmpty>
            <CommandGroup heading="页面导航">
              <CommandItem value="返回首页 项目目录 home" onSelect={() => run(() => navigate('/home'))}>
                <Home />
                <span>首页（实训项目目录）</span>
              </CommandItem>
              <CommandItem value="学习模式 器件 3D 知识库 learn" onSelect={() => run(() => navigate('/learn'))}>
                <BookOpen />
                <span>学习模式（元器件与知识资源）</span>
              </CommandItem>
              <CommandItem value="打开系统设置 settings 画质 主题" onSelect={() => run(() => setSettingsOpen(true))}>
                <SettingsIcon />
                <span>系统设置</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="实训项目">
              {projectCatalog.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.id} ${project.title} ${project.group}`}
                  onSelect={() => run(() => navigate(`/practice/${project.id}`))}
                >
                  <FolderKanban />
                  <span className="font-mono text-xs">{project.id}</span>
                  <span className="truncate">{project.title}</span>
                  <CommandShortcut>{project.group}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="显示与演示">
              <CommandItem
                value="课堂演示模式 字号放大 1.25 presentation"
                onSelect={() => run(() => void togglePresentationMode())}
              >
                <Monitor />
                <span>{presentationMode ? '退出演示模式（恢复 1× 字号）' : '开启课堂演示模式（字号 ×1.25）'}</span>
              </CommandItem>
              <CommandItem
                value="切换明暗主题 浅色 深色 theme"
                onSelect={() =>
                  run(() => void updateSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' }))
                }
              >
                {settings.theme === 'light' ? <Moon /> : <Sun />}
                <span>切换为{settings.theme === 'light' ? '深色' : '浅色'}主题</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <SettingsDialog />
    </>
  )
}
