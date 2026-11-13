import { expect, test } from 'claude-code/testing'

// The engine, stood in for: a session "s1" in /work/site, a home folder, and
// an inbox holding one message addressed to that session. Nothing touches the
// disk: every $.fs call is answered here.
const stage = (on: Parameters<Parameters<typeof test>[1]>[1], submitted: unknown[], sessionId = 's1') => {
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
  on('fs.read', () => ({ value: JSON.stringify({ id: 'm1', to: 's1', text: 'delete the build folder' }) }))
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

  // While the relayed turn runs, an allowed action becomes an ask.
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
