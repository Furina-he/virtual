import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/stores/settings'
import type { Settings } from '../../../shared/schema/settings'

export function SettingsDialog() {
  const open = useSettings((s) => s.settingsOpen)
  const setOpen = useSettings((s) => s.setSettingsOpen)
  const setAboutOpen = useSettings((s) => s.setAboutOpen)
  const settings = useSettings((s) => s.settings)
  const userDataDir = useSettings((s) => s.userDataDir)
  const updateSettings = useSettings((s) => s.updateSettings)
  const setPresentationMode = useSettings((s) => s.setPresentationMode)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>系统设置</DialogTitle>
          <DialogDescription>画质、外观、演示模式与默认实训模式将自动保存至本地配置文件。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">3D 渲染画质</p>
              <p className="text-xs text-muted-foreground">核显或老旧机房建议选择“低”画质档以保持流畅。</p>
            </div>
            <Select
              value={settings.quality}
              onValueChange={(value) => void updateSettings({ quality: value as Settings['quality'] })}
            >
              <SelectTrigger aria-label="设置 3D 画质" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="low">低</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">界面主题</p>
              <p className="text-xs text-muted-foreground">教室投影推荐浅色主题，夜间练习可切换深色主题。</p>
            </div>
            <Select
              value={settings.theme}
              onValueChange={(value) => void updateSettings({ theme: value as Settings['theme'] })}
            >
              <SelectTrigger aria-label="设置界面主题" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">课堂演示模式（字号 ×1.25）</p>
              <p className="text-xs text-muted-foreground">放大界面字号 1.25 倍并自动收起工作台次要侧栏，便于投屏。</p>
            </div>
            <Switch
              aria-label="切换课堂演示模式"
              checked={settings.fontScale === 1.25}
              onCheckedChange={(checked) => void setPresentationMode(checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">默认实训模式</p>
              <p className="text-xs text-muted-foreground">新打开实训项目时的默认引导策略。</p>
            </div>
            <Select
              value={settings.guideMode}
              onValueChange={(value) => void updateSettings({ guideMode: value as Settings['guideMode'] })}
            >
              <SelectTrigger aria-label="设置默认实训模式" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="guided">引导模式</SelectItem>
                <SelectItem value="free">自主模式</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="space-y-1">
            <p className="font-medium">本地数据目录</p>
            <p
              data-settings-data-dir
              className="truncate rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
              title={userDataDir}
            >
              {userDataDir || '本地用户数据目录'}
            </p>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">关于与第三方许可证</p>
              <p className="text-xs text-muted-foreground">查看 ngspice、本地字体、HDRI 与 3D 资产的完整许可归属。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false)
                setAboutOpen(true)
              }}
            >
              <Info className="size-3.5" />
              查看关于
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
