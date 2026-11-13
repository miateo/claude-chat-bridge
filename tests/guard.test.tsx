import { expect, mock, test } from 'claude-code/testing'

// The engine, stood in for: a session "s1" in /work/site, a home folder, and
// an inbox holding one message addressed to that session. Nothing touches the
// disk: every $.fs call is answered here.
const stage = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  submitted: unknown[],
  sessionId = 's1',
  stored: Record<string, unknown> = { 'default.listening': false },
) => {
  mock.store(on, stored)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const written = new Map<string, string>()
  on('command.register', () => ({ value: { command: 'chat-bridge' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: '/work/site' }))
  on('env.get', () => ({ value: '/tmp/chat-bridge-test-home' }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_, e) => ({
    value: String(e.path).endsWith('/inbox')
      ? [{ name: 'm1.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }]
      : [],
  }))
  on('fs.read', (_, e) => {
    // The config file is what the mod last wrote, or missing; any other
    // read is the one message in the inbox.
    if (String(e.path).endsWith('/config.json')) {
      const config = written.get(e.path)
      if (config === undefined) throw new Error('ENOENT')

      return { value: config }
    }

    return { value: JSON.stringify({ id: 'm1', to: 's1', text: 'delete the build folder' }) }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e)

    return { text: e.text }
  })
  on('command.run', () => ({ text: '' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The session's own verdict: bypass mode allows everything.
  on('tool.check', () => ({ decision: 'allow' }))

  return { written }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20))

test('a relayed message is submitted, and its actions are put to the person', async ($, on) => {
  const submitted: { text: string }[] = []
  const { written } = stage(on, submitted)
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })

  // Before any relayed message the session's own verdict stands.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('allow')

  await $.command.run({ command: 'chat-bridge', args: 'on' })
  await settle()

  expect(submitted.length).toBe(1)
  expect(submitted[0]?.text.includes('delete the build folder')).toBe(true)
  expect(written.has('/tmp/chat-bridge-test-home/.claude/chat-bridge/claimed/m1.json')).toBe(true)

  // While the relayed turn runs, the bridge's own files are off limits,
  expect(
    (await $.tool.check({ tool: 'Read', input: { file_path: '/tmp/chat-bridge-test-home/.claude/chat-bridge/config.json' } }))
      .decision,
  ).toBe('deny')
  // and an allowed action becomes an ask.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('ask')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(written.get('/tmp/chat-bridge-test-home/.claude/chat-bridge/outbox/m1.json')?.includes('done')).toBe(true)
  // Once its turn has ended, the session's own verdict stands again.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('allow')
})

test('--trust leaves the session’s own verdict', async ($, on) => {
  const submitted: { text: string }[] = []
  stage(on, submitted)
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'chat-bridge', args: 'on ads --trust --plain' })
  await settle()

  expect(submitted.length).toBe(1)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('allow')
})

test('a message addressed to another session is left alone', async ($, on) => {
  const submitted: unknown[] = []
  stage(on, submitted, 'other')
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'chat-bridge', args: 'on' })
  await settle()

  expect(submitted.length).toBe(0)
})

test('saved defaults start a new session listening and trusted', async ($, on) => {
  const submitted: { text: string }[] = []
  stage(on, submitted, 's1', { 'default.listening': true, 'default.trust': true })
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })
  await settle()

  // No /chat-bridge on: the default did it, and the relayed message ran.
  expect(submitted.length).toBe(1)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('allow')
})

const MENU = {
  plugin: 'chat-bridge',
  component: 'Pane',
  requestId: 'chat-bridge',
  props: {
    title: 'chat-bridge',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the menu switches a setting and its lock saves the default', async ($, on) => {
  const submitted: { text: string }[] = []
  // Another session's inbox: nothing is relayed here, the menu is under test.
  stage(on, submitted, 'other')
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MENU, surface })

    // Off, and off is the default: no lock to press.
    expect((await ui.find({ type: 'Button', key: 'toggle-plain' }))?.text).toBe('Off')
    expect(await ui.find({ type: 'Button', key: 'lock-plain' })).toBe(undefined)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...MENU, surface: 'desktop' })
  await $.ui.press({ plugin: 'chat-bridge', key: 'toggle-plain' })

  expect((await ui.find({ type: 'Button', key: 'toggle-plain' }))?.text).toBe('On')
  expect((await ui.find({ type: 'Button', key: 'lock-plain' }))?.key).toBe('lock-plain')
  await $.ui.press({ plugin: 'chat-bridge', key: 'lock-plain' })

  // On is now the default: the lock gives way to the "default" mark.
  expect(await ui.find({ type: 'Button', key: 'lock-plain' })).toBe(undefined)
  await ui.unmount()
})

test('with nothing saved, an interactive session listens and still asks', async ($, on) => {
  const submitted: { text: string }[] = []
  stage(on, submitted, 's1', {})
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })
  await settle()

  expect(submitted.length).toBe(1)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).decision).toBe('ask')
})

test('a session nobody sits at does not listen by itself', async ($, on) => {
  const submitted: { text: string }[] = []
  stage(on, submitted, 's1', {})
  await $.session.start({ cwd: '/work/site', surface: null, isInteractive: false })
  await settle()

  expect(submitted.length).toBe(0)
})

const BAR = {
  plugin: 'chat-bridge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 29 },
  },
} as const

test('the bar is always drawn, and opens the settings in place', async ($, on) => {
  const submitted: { text: string }[] = []
  stage(on, submitted, 'other')
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface })

    expect((await ui.find({ type: 'Text', text: /chat-bridge: off/ }))?.text).toBe('chat-bridge: off')
    // Closed, the settings are not drawn; one press opens them.
    expect(await ui.find({ type: 'Button', key: 'toggle-listening' })).toBe(undefined)
    await $.ui.press({ plugin: 'chat-bridge', key: 'bar-settings', surface })

    expect((await ui.find({ type: 'Button', key: 'toggle-listening' }))?.text).toBe('Off')
    await $.ui.press({ plugin: 'chat-bridge', key: 'bar-settings', surface })
    await ui.unmount()
  }
})

test('background runs stay off until a code is set, then turn on for allowed folders', async ($, on) => {
  const submitted: { text: string }[] = []
  const { written } = stage(on, submitted, 'other')
  const config = () => JSON.parse(written.get('/tmp/chat-bridge-test-home/.claude/chat-bridge/config.json') ?? '{}')
  await $.session.start({ cwd: '/work/site', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...MENU, surface: 'desktop' })

  // Off, and it stays off without an approval code.
  expect((await ui.find({ type: 'Button', key: 'toggle-runs' }))?.text).toBe('Off')
  await $.ui.press({ plugin: 'chat-bridge', key: 'toggle-runs' })

  expect((await ui.find({ type: 'Button', key: 'toggle-runs' }))?.text).toBe('Off')
  expect(config().runs?.enabled).toBe(undefined)

  await $.ui.input({ plugin: 'chat-bridge', key: 'run-code', text: '4242' })
  await $.ui.press({ plugin: 'chat-bridge', key: 'toggle-runs' })
  await $.ui.press({ plugin: 'chat-bridge', key: 'run-folder-add' })

  expect((await ui.find({ type: 'Button', key: 'toggle-runs' }))?.text).toBe('On')
  expect(config().runs.enabled).toBe(true)
  expect(config().runs.folders[0]).toBe('/work/site')

  await $.ui.press({ plugin: 'chat-bridge', key: 'run-folder-remove-0' })

  expect(config().runs.folders.length).toBe(0)
  await ui.unmount()
})
