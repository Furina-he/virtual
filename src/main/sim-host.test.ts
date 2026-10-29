import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SIM_CHANNEL, type SimCommand } from '../shared/ipc/sim'
import { SimHost } from './sim-host'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, command: unknown) => void>(),
  fork: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'workspace', on: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, command: unknown) => void) =>
      fixture.handlers.set(channel, handler),
  },
  utilityProcess: { fork: fixture.fork },
  MessageChannelMain: vi.fn(),
}))

class Child extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
  pid = 1
}

const load: Extract<SimCommand, { type: 'load' }> = {
  type: 'load',
  netlist: 'Module replay\n.param p_box_r=1000\nR1 a 0 {p_box_r}\n.end',
  probes: [],
  analysis: { kind: 'tran', step: 1e-4, continuous: true },
  parameterTargets: [{ param: 'p_box_r', elements: ['R1'] }],
}
function command(command: SimCommand) {
  fixture.handlers.get(SIM_CHANNEL.command)?.({}, command)
}
function ack(child: Child, requestId: string, value: number) {
  child.emit('message', {
    type: 'altered',
    event: { type: 'altered', requestId, simTime: 0.2, changes: [{ param: 'p_box_r', value }] },
  })
}
function replay(child: Child) {
  return child.postMessage.mock.calls.flatMap(([message]) =>
    message.type === 'command' ? [message.command as SimCommand] : [],
  )
}

beforeEach(() => {
  fixture.handlers.clear()
  fixture.fork.mockReset()
})

describe('successful module parameters survive simulation process restart', () => {
  it('replays the latest acknowledged parameters and pacing, never unacknowledged requests', () => {
    const first = new Child()
    const second = new Child()
    fixture.fork.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const host = new SimHost()
    host.start()
    command(load)
    command({ type: 'setPacing', mode: 'realtime' })
    command({ type: 'run' })
    command({ type: 'alter', requestId: 'first', changes: [{ param: 'p_box_r', value: 2000 }] })
    command({ type: 'alter', requestId: 'second', changes: [{ param: 'p_box_r', value: 3000 }] })
    ack(first, 'first', 2000)
    ack(first, 'second', 3000)
    command({ type: 'alter', requestId: 'pending', changes: [{ param: 'p_box_r', value: 4000 }] })
    first.emit('exit', 1)
    const commands = replay(second)
    expect(commands.map((entry) => entry.type)).toEqual(['load', 'setPacing', 'run'])
    expect(commands[0]).toMatchObject({
      netlist: expect.stringContaining('p_box_r=3000'),
      parameterTargets: load.parameterTargets,
    })
    expect(commands[1]).toEqual({ type: 'setPacing', mode: 'realtime' })
  })

  it('ignores a late acknowledgement from a replaced load', () => {
    const first = new Child()
    const second = new Child()
    fixture.fork.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const host = new SimHost()
    host.start()
    command(load)
    command({ type: 'alter', requestId: 'old', changes: [{ param: 'p_box_r', value: 2000 }] })
    command({ ...load, netlist: load.netlist.replace('=1000', '=5000') })
    ack(first, 'old', 2000)
    first.emit('exit', 1)
    expect(replay(second)[0]).toMatchObject({ netlist: expect.stringContaining('p_box_r=5000') })
  })

  it('does not resume a session that reported a parameter failure', () => {
    const first = new Child()
    const second = new Child()
    fixture.fork.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const host = new SimHost()
    host.start()
    command(load)
    command({ type: 'run' })
    command({ type: 'alter', requestId: 'failed', changes: [{ param: 'p_box_r', value: 2000 }] })
    first.emit('message', {
      type: 'parameter-error',
      event: { type: 'error', requestId: 'failed', code: 'model', message: 'invalid parameter' },
    })
    first.emit('exit', 1)
    expect(replay(second).map((entry) => entry.type)).toEqual(['load'])
    expect(replay(second)[0]).toMatchObject({ netlist: expect.stringContaining('p_box_r=1000') })
  })
})
