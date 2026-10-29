import { describe, expect, it } from 'vitest'
import { patchNetlistParameters, SimCommandSchema, SimEventSchema } from './sim'

describe('module parameter protocol', () => {
  it('keeps legacy alteration requests compatible and supports correlated acknowledgements', () => {
    const changes = [{ param: 'p_box_rw', value: 0.75 }]
    expect(SimCommandSchema.parse({ type: 'alter', changes })).toEqual({ type: 'alter', changes })
    expect(SimCommandSchema.parse({ type: 'alter', requestId: 'module-1-2', changes })).toMatchObject({
      requestId: 'module-1-2',
    })
    expect(SimEventSchema.parse({ type: 'altered', requestId: 'module-1-2', simTime: 1.25, changes })).toMatchObject({
      type: 'altered',
      requestId: 'module-1-2',
      simTime: 1.25,
    })
  })

  it.each(['x;quit', 'p_box_r=0', ''])('rejects unsafe parameter identifiers (%s)', (param) => {
    expect(SimCommandSchema.safeParse({ type: 'alter', changes: [{ param, value: 1 }] }).success).toBe(false)
  })

  it('requires finite values and nonempty changes', () => {
    expect(SimCommandSchema.safeParse({ type: 'alter', changes: [] }).success).toBe(false)
    expect(SimCommandSchema.safeParse({ type: 'alter', changes: [{ param: 'p_r', value: Number.NaN }] }).success).toBe(
      false,
    )
    expect(
      SimEventSchema.safeParse({ type: 'altered', simTime: -1, changes: [{ param: 'p_r', value: 1 }] }).success,
    ).toBe(false)
  })

  it('validates declared direct resistor targets without allowing arbitrary native commands', () => {
    const command = {
      type: 'alter',
      requestId: 'direct-1',
      changes: [{ param: 'p_box_r', value: 2000, targets: [{ element: 'r.xbox.rcharge', value: 2000 }] }],
    }
    expect(SimCommandSchema.parse(command)).toEqual(command)
    for (const element of ['r.xbox.rcharge;quit', 'v.xbox.source', '@r1', 'r..bad']) {
      expect(
        SimCommandSchema.safeParse({
          ...command,
          changes: [{ param: 'p_box_r', value: 2, targets: [{ element, value: 2 }] }],
        }).success,
      ).toBe(false)
    }
    expect(
      SimCommandSchema.safeParse({
        ...command,
        changes: [{ param: 'p_box_r', value: 2, targets: [{ element: 'R1', value: 0 }] }],
      }).success,
    ).toBe(false)
  })

  it('patches successful numeric assignments without editing device or source syntax', () => {
    const source = '* test\n.param p_box_r=1k\n.param p_box_sw=1\nR1 a b {p_box_r}\n.end'
    const patched = patchNetlistParameters(source, [
      { param: 'p_box_r', value: 2000 },
      { param: 'p_box_sw', value: 0 },
    ])
    expect(patched).toBe('* test\n.param p_box_r=2000\n.param p_box_sw=0\nR1 a b {p_box_r}\n.end')
    expect(source).toContain('p_box_r=1k')
  })

  it.each(['.param p_r=1\n.param P_R=2', '.param p_r=1 p_other=2', '.param p_other=2'])(
    'rejects unknown or ambiguous declarations before native mutation',
    (body) => {
      expect(() => patchNetlistParameters(body, [{ param: 'p_r', value: 3 }])).toThrow()
    },
  )

  it('rejects duplicate requested parameters even with different case', () => {
    expect(() =>
      patchNetlistParameters('.param p_r=1', [
        { param: 'p_r', value: 2 },
        { param: 'P_R', value: 3 },
      ]),
    ).toThrow('Duplicate')
  })
})
