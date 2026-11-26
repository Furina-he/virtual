import { FileText, PackageCheck, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSettings } from '@/stores/settings'
import appIconUrl from '../../../../resources/icon.svg?url'
import { filterAssetLicenses } from '../../../domain/licenses/catalog'
import { appLicenseBundle } from './license-data'

export function AboutDialog() {
  const open = useSettings((s) => s.aboutOpen)
  const setOpen = useSettings((s) => s.setAboutOpen)
  const [tab, setTab] = useState<'ngspice' | 'assets' | 'texts'>('ngspice')
  const [query, setQuery] = useState('')
  const [selectedTextId, setSelectedTextId] = useState<string>(appLicenseBundle.texts[0].id)

  const filteredAssets = useMemo(() => filterAssetLicenses(appLicenseBundle.assetRows, query), [query])
  const activeLicenseDoc =
    appLicenseBundle.texts.find((item) => item.id === selectedTextId) ?? appLicenseBundle.texts[0]

  const versions = typeof window !== 'undefined' ? window.api?.versions : undefined

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="about-license-dialog flex flex-col overflow-hidden" data-about-dialog>
        <DialogHeader className="shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <img src={appIconUrl} alt="" aria-hidden="true" className="size-5 shrink-0" />
            <DialogTitle>关于与第三方许可证</DialogTitle>
            <Badge variant="secondary" className="font-mono text-xs">
              v{appLicenseBundle.version}
            </Badge>
            <Badge variant="outline" className="gap-1 text-xs">
              <ShieldCheck className="size-3 text-success" />
              完全离线运行
            </Badge>
          </div>
          <DialogDescription>
            {appLicenseBundle.appName} — 随包分发的仿真引擎、第三方运行库、本地字体、HDRI 与 3D 资产许可证清单。
            {versions ? (
              <span className="ml-2 font-mono text-xs">
                Electron {versions.electron} · Chromium {versions.chrome}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          本清单直接同步自随包分发的 <span className="font-mono">resources/ngspice/LICENSE-NOTES.md</span> 与{' '}
          <span className="font-mono">content/ASSET-LICENSES.csv</span>。GPLv2+ 的{' '}
          <span className="font-mono">table.cm</span> 代码模型未随包分发；开发期参考照片与归档 KiCad
          文件均未包含在安装包内。
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'ngspice' | 'assets' | 'texts')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="w-full shrink-0 justify-start">
            <TabsTrigger value="ngspice" className="flex-none">
              仿真引擎与运行库（{appLicenseBundle.ngspiceSummary.files.length}）
            </TabsTrigger>
            <TabsTrigger value="assets" className="flex-none">
              3D 资产、字体与模型（{appLicenseBundle.assetSummary.totalRows}）
            </TabsTrigger>
            <TabsTrigger value="texts" className="flex-none">
              许可证全文（{appLicenseBundle.texts.length}）
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ngspice" className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-md border">
              <div className="space-y-4 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <PackageCheck className="size-4 text-primary" />
                    <span>ngspice-47 共享库与运行时依赖</span>
                  </div>
                  <span className="font-mono text-muted-foreground">
                    核对日期：{appLicenseBundle.ngspiceSummary.verifiedDate}
                  </span>
                </div>

                <Table className="w-full table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-1/4">随包文件</TableHead>
                      <TableHead className="w-1/5">来源组件</TableHead>
                      <TableHead className="w-1/5">许可证</TableHead>
                      <TableHead>分发说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {appLicenseBundle.ngspiceSummary.files.map((item) => (
                      <TableRow key={item.file} data-ngspice-license-row={item.file}>
                        <TableCell className="break-all whitespace-normal font-mono font-medium">{item.file}</TableCell>
                        <TableCell className="break-words whitespace-normal">{item.sourceCode}</TableCell>
                        <TableCell className="whitespace-normal">
                          <Badge
                            variant="outline"
                            className="h-auto max-w-full break-words whitespace-normal font-mono text-xs"
                          >
                            {item.license}
                          </Badge>
                        </TableCell>
                        <TableCell className="break-words whitespace-normal text-muted-foreground">
                          {item.notes}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <Separator />

                <div className="space-y-1.5">
                  <p className="font-medium text-foreground">上游源码获取地址与校验摘要（LGPL / BSD 合规）</p>
                  <p className="break-all font-mono text-muted-foreground">
                    主仓库：{appLicenseBundle.ngspiceSummary.sourceRepo}
                  </p>
                  <div className="space-y-1">
                    {appLicenseBundle.ngspiceSummary.sources.map((pkg) => (
                      <div key={pkg.name} className="rounded-sm border bg-muted/20 px-2.5 py-1.5">
                        <p className="font-medium text-foreground">{pkg.name}</p>
                        <p className="break-all font-mono text-muted-foreground">{pkg.url}</p>
                        <p className="break-all font-mono text-muted-foreground">SHA-256: {pkg.sha256}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="assets" className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="grid shrink-0 grid-cols-2 gap-2 text-xs sm:grid-cols-4" data-about-asset-summary>
              <div className="rounded-md border px-2.5 py-1.5">
                <p className="text-muted-foreground">离线 3D 模型（GLB）</p>
                <p className="font-mono text-sm font-medium">{appLicenseBundle.assetSummary.glbCount} 件</p>
              </div>
              <div className="rounded-md border px-2.5 py-1.5">
                <p className="text-muted-foreground">第三方 CC0 素材</p>
                <p className="font-mono text-sm font-medium">
                  {appLicenseBundle.assetSummary.thirdPartyRows.length} 项（HDRI + 工具网格）
                </p>
              </div>
              <div className="rounded-md border px-2.5 py-1.5">
                <p className="text-muted-foreground">本地离线字体</p>
                <p className="font-mono text-sm font-medium">{appLicenseBundle.fonts.length} 套</p>
              </div>
              <div className="rounded-md border px-2.5 py-1.5">
                <p className="text-muted-foreground">自建 SPICE 模型库</p>
                <p className="font-mono text-sm font-medium">{appLicenseBundle.spiceLibraries.length} 库</p>
              </div>
            </div>

            <div className="shrink-0">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="按资产编号、路径、许可证或 SHA-256 筛选…"
                aria-label="筛选随包资产许可证"
                className="h-8 text-xs"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-md border">
              <div className="space-y-4 p-3 text-xs">
                {!query.trim() ? (
                  <>
                    <div className="space-y-2">
                      <p className="font-medium text-foreground">第三方素材与本地字体归属</p>
                      <Table className="w-full table-fixed">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-1/5">名称 / 标识</TableHead>
                            <TableHead className="w-1/4">作者 / 来源</TableHead>
                            <TableHead className="w-1/6">许可证</TableHead>
                            <TableHead>用途与处理说明</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {appLicenseBundle.assetSummary.thirdPartyRows.map((row) => (
                            <TableRow key={row.assetId} data-third-party-asset={row.assetId}>
                              <TableCell className="break-all whitespace-normal font-mono font-medium">
                                {row.assetId}
                              </TableCell>
                              <TableCell className="break-all whitespace-normal">
                                {row.author}
                                <span className="block font-mono text-muted-foreground">{row.source}</span>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <Badge variant="secondary" className="h-auto whitespace-normal font-mono text-xs">
                                  {row.license}
                                </Badge>
                              </TableCell>
                              <TableCell className="break-words whitespace-normal text-muted-foreground">
                                {row.changes}
                              </TableCell>
                            </TableRow>
                          ))}
                          {appLicenseBundle.fonts.map((font) => (
                            <TableRow key={font.id} data-third-party-font={font.id}>
                              <TableCell className="break-words whitespace-normal font-medium">{font.name}</TableCell>
                              <TableCell className="break-all whitespace-normal">
                                {font.author}
                                <span className="block font-mono text-muted-foreground">{font.packageName}</span>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <Badge variant="secondary" className="h-auto whitespace-normal font-mono text-xs">
                                  {font.license}
                                </Badge>
                              </TableCell>
                              <TableCell className="break-words whitespace-normal text-muted-foreground">
                                {font.usage}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <Separator />
                  </>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-foreground">全部随包资产哈希登记表（ASSET-LICENSES.csv）</p>
                    <span className="font-mono text-muted-foreground">
                      显示 {filteredAssets.length} / {appLicenseBundle.assetRows.length} 项
                    </span>
                  </div>
                  <Table className="w-full table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-1/4">资产标识</TableHead>
                        <TableHead className="w-2/5">分发路径</TableHead>
                        <TableHead className="w-1/5">许可证</TableHead>
                        <TableHead>SHA-256</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAssets.map((row) => (
                        <TableRow key={row.assetId}>
                          <TableCell className="break-all whitespace-normal font-mono">{row.assetId}</TableCell>
                          <TableCell className="break-all whitespace-normal font-mono text-muted-foreground">
                            {row.path}
                          </TableCell>
                          <TableCell className="break-all whitespace-normal font-mono">{row.license}</TableCell>
                          <TableCell className="font-mono text-muted-foreground" title={row.sha256}>
                            {row.sha256.slice(0, 12)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="texts" className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {appLicenseBundle.texts.map((doc) => (
                <Button
                  key={doc.id}
                  size="sm"
                  variant={doc.id === activeLicenseDoc.id ? 'secondary' : 'outline'}
                  className="h-7 gap-1 px-2 text-xs"
                  data-license-doc-tab={doc.id}
                  onClick={() => setSelectedTextId(doc.id)}
                >
                  <FileText className="size-3" />
                  {doc.label}
                </Button>
              ))}
            </div>
            <p className="shrink-0 font-mono text-xs text-muted-foreground">随包路径：{activeLicenseDoc.file}</p>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/20">
              <pre
                data-license-doc-content={activeLicenseDoc.id}
                className="p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground"
              >
                {activeLicenseDoc.content}
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
