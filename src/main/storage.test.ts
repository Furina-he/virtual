import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVE_SCHEMA_VERSION, type SaveFile } from '../shared/schema/save'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

import { ProjectStorage } from './storage'

function sampleSave(overrides: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    projectId: 'DG-05',
    updatedAt: '2026-11-24T03:00:00.000Z',
    circuit: {
      placedInstruments: [],
      wires: [{ id: 'w-1', a: 'ins-dc-power.CH1P', b: 'dc1.KH_U1P', color: 'red', slack: 0.12 }],
      controlValues: { 'ins-dc-power.ch1_v': 6, 'ins-dc-power.ch2_v': 12 },
    },
    completedSteps: ['prepare', 'wire'],
    tables: {
      kirchhoff: [{ i1: 0.00191, i2: -0.00595, i3: 0.00784, 'u-fa': 0.982, 'u-ad': 4.04, 'u-de': 0.982 }],
    },
    answers: { '0': 'I2 与参考方向相反。' },
    guideMode: 'guided',
    ...overrides,
  }
}

describe('T1.7 WIR-05 NFR-04 SaveFile 序列化校验、原子写入与损坏文件回退', () => {
  let root: string
  let storage: ProjectStorage

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'virtual-storage-test-'))
    storage = new ProjectStorage(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('WIR-05 原子写入手动存档与自动存档，绝不残留临时文件且不保存 powered 状态', async () => {
    const saveWithExtraPowered = {
      ...sampleSave(),
      circuit: {
        ...sampleSave().circuit,
        powered: true,
      },
    }

    const autoRes = await storage.writeAutosave(saveWithExtraPowered)
    expect(autoRes.ok).toBe(true)

    const rawAutosave = JSON.parse(await readFile(storage.autosavePath('DG-05'), 'utf8')) as Record<string, unknown>
    expect((rawAutosave.circuit as Record<string, unknown>).powered).toBeUndefined()

    const loadedAuto = await storage.readAutosave('DG-05')
    expect(loadedAuto.status).toBe('ok')
    if (loadedAuto.status === 'ok') {
      expect(loadedAuto.save.circuit.wires).toHaveLength(1)
      expect(loadedAuto.save.tables.kirchhoff?.[0]?.i1).toBe(0.00191)
    }

    // 手动保存原子落盘并自动清理旧 .autosave
    const manualRes = await storage.saveManual(sampleSave({ updatedAt: '2026-11-24T03:05:00.000Z' }))
    expect(manualRes.ok).toBe(true)
    const files = await readdir(storage.savesDir)
    expect(files).toEqual(['DG-05.json'])
    expect((await storage.readAutosave('DG-05')).status).toBe('missing')

    const loadedManual = await storage.loadManual('DG-05')
    expect(loadedManual.status).toBe('ok')
  })

  it('NFR-04 拒绝非法 SaveFile 写入，并在 .autosave 损坏时安全回退到手动存档', async () => {
    // 非法版本号与非法日期拒绝写入
    const invalid = await storage.writeAutosave({
      ...sampleSave(),
      schemaVersion: 99,
      updatedAt: 'not-an-iso-date',
    })
    expect(invalid.ok).toBe(false)

    // 先写入有效手动存档，再模拟掉电截断导致 .autosave 损坏
    await storage.saveManual(sampleSave({ updatedAt: '2026-11-24T03:10:00.000Z' }))
    await writeFile(storage.autosavePath('DG-05'), '{"schemaVersion":1,"projectId":"DG-05",BROKEN', 'utf8')

    const recovery = await storage.checkRecovery('DG-05')
    expect(recovery.hasAutosave).toBe(false)
    expect(recovery.autosaveCorrupt).toBe(true)
    expect(recovery.corruptMessage).toContain('损坏')
    expect(recovery.hasManualSave).toBe(true)
    expect(recovery.manualSave?.projectId).toBe('DG-05')
  })

  it('WIR-05 列出全部项目存档摘要并支持设置原子读写与损坏回退', async () => {
    await storage.saveManual(sampleSave({ projectId: 'DG-05', updatedAt: '2026-11-24T03:00:00.000Z' }))
    await storage.writeAutosave(
      sampleSave({
        projectId: 'MD-07',
        updatedAt: '2026-11-24T04:00:00.000Z',
        completedSteps: ['wire'],
        tables: {},
      }),
    )

    const list = await storage.listSaves()
    expect(list.map((entry) => entry.projectId)).toEqual(['MD-07', 'DG-05'])
    expect(list[0]?.hasAutosave).toBe(true)
    expect(list[1]?.hasManualSave).toBe(true)

    const savedSettings = await storage.writeSettings({ theme: 'dark', fontScale: 1.25, guideMode: 'free' })
    expect(savedSettings.theme).toBe('dark')
    expect(savedSettings.fontScale).toBe(1.25)

    // 设置文件损坏时回退默认值
    await writeFile(storage.settingsPath, '{corrupt', 'utf8')
    const fallback = await storage.readSettings()
    expect(fallback.corruptFallback).toBe(true)
    expect(fallback.settings.theme).toBe('light')
    expect(fallback.settings.fontScale).toBe(1)
  })
})
