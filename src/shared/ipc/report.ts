import { z } from 'zod'

const ReportScreenshotSchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  instrumentTitle: z.string().min(1),
  title: z.string().min(1),
  dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  createdAt: z.string().min(1),
  displayMode: z.enum(['yt', 'xy']),
  frozen: z.boolean(),
  summaryText: z.string(),
})

const ChartSeriesMetaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().optional(),
  colorVar: z.string().min(1),
})

const ChartPointSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  x: z.number().finite(),
  values: z.record(z.string(), z.number().finite().nullable()),
})

const ChartDatasetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tableId: z.string().min(1),
  tableTitle: z.string().min(1),
  kind: z.enum(['line', 'scatter']),
  xKey: z.string().min(1),
  xLabel: z.string().min(1),
  xUnit: z.string().optional(),
  series: z.array(ChartSeriesMetaSchema),
  points: z.array(ChartPointSchema),
  data: z.array(z.record(z.string(), z.number().finite().nullable())),
  totalRows: z.number().int().nonnegative(),
  validPointCount: z.number().int().nonnegative(),
  droppedRowCount: z.number().int().nonnegative(),
  emptyReason: z.string().nullable(),
  hint: z.string().nullable(),
})

export const LabReportSchema = z.object({
  projectId: z.string().min(1),
  projectTitle: z.string().min(1),
  projectGroup: z.string().min(1),
  projectType: z.enum(['basic', 'integrated']),
  generatedAt: z.string().min(1),
  guideMarkdown: z.string(),
  stepSummary: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.string().min(1),
        index: z.number().int().positive(),
        text: z.string(),
        completed: z.boolean(),
      }),
    ),
  }),
  tables: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      columns: z.array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          unit: z.string().optional(),
          computed: z.string().optional(),
        }),
      ),
      rows: z.array(
        z.object({
          rowNumber: z.number().int().positive(),
          cells: z.array(
            z.object({
              columnId: z.string().min(1),
              value: z.number().finite().nullable(),
              formatted: z.string(),
            }),
          ),
        }),
      ),
      filledRows: z.number().int().nonnegative(),
      warnings: z.array(z.string()),
    }),
  ),
  charts: z.array(ChartDatasetSchema),
  screenshots: z.array(ReportScreenshotSchema),
  questions: z.array(
    z.object({
      index: z.number().int().positive(),
      prompt: z.string(),
      answer: z.string(),
    }),
  ),
  faultSummary: z
    .object({
      measurements: z.number().int().nonnegative(),
      wrongGuesses: z.number().int().nonnegative(),
      seconds: z.number().nonnegative(),
      resolvedCount: z.number().int().nonnegative(),
      resolvedFaultIds: z.array(z.string()),
    })
    .optional(),
})

export type LabReportPayload = z.infer<typeof LabReportSchema>

export type ExportReportResult =
  | { ok: true; filePath: string; bytes: number; message: string }
  | { ok: false; canceled?: boolean; message: string }
