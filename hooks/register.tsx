import type { EngineInterface, Register, Timer } from 'claude-code'

// The other half is server/bridge-mcp.mjs, the connector the Claude desktop
// chat calls. Messages travel as files under ~/.claude/chat-bridge: each
// listening session keeps listeners/<session>.json fresh with its name and
// folder; the connector writes inbox/<id>.json addressed to one session; that
// session's mod marks claimed/<id>.json, submits the text as a prompt, and
// writes the turn's answer to outbox/<id>.json.
//
// A relayed message is text another model wrote, possibly steered by a page
// or file it read. So while its turn runs, every tool call the session would
// have run unasked, and that is not a read, is put to the person instead
// (`tool.check`), whatever the session's permission mode; `--trust` at
// /chat-bridge on turns that off for the session.
//
// Settings are changed from the control menu (/chat-bridge opens it as a pane)
// or by the command's options. Each lockable setting has a default kept in
// `$.store`, across sessions: the lock beside it in the menu saves its current
// value as that default, which new sessions start from.

const POLL_MS = 2000
const FRESH_MS = 15_000
const MAX_MESSAGE_CHARS = 20_000
const PANE = 'chat-bridge'

// The settings a default can be saved for, and the `$.store` key of each.
type Setting = 'listening' | 'trust' | 'plain'
const SETTINGS: readonly Setting[] = ['listening', 'trust', 'plain']
const STORE_KEY: Record<Setting, string> = {
  listening: 'default.listening',
  trust: 'default.trust',
  plain: 'default.plain',
}

type Inbound = { id: string; to?: string; text: string }
type Listener = { id: string; name: string; at: number }

// All of it is the module's own, for this session alone: listening is off
// until the person runs /chat-bridge on, and again after a restart or reload.
let isListening = false
// The name the chat addresses this session by.
let heldName: string | undefined
// Run a relayed message's actions without asking: off unless --trust.
let isTrusted = false
// Submit a relayed message as typed, without the engine's frame: off unless --plain.
let isPlain = false
// The saved defaults as last read from `$.store`; one never saved is false.
const defaults: Record<Setting, boolean> = { listening: false, trust: false, plain: false }
let timer: Timer | undefined
let isPolling = false
let isTurnRunning = false
let pendingId: string | undefined
const seen = new Set<string>()

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

async function directory($: EngineInterface): Promise<string> {
  // USERPROFILE is the home folder on Windows, where HOME is usually unset.
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined) throw new Error('no home folder in the environment')

  return `${home.replaceAll('\\', '/')}/.claude/chat-bridge`
}

function current(setting: Setting): boolean {
  return setting === 'listening' ? isListening : setting === 'trust' ? isTrusted : isPlain
}

async function loadDefaults($: EngineInterface): Promise<void> {
  for (const setting of SETTINGS) {
    defaults[setting] = (await $.store.get(STORE_KEY[setting])) === true
  }
}

// The lock: the setting's current value becomes what new sessions start from.
async function lock($: EngineInterface, setting: Setting): Promise<void> {
  defaults[setting] = current(setting)
  await $.store.set(STORE_KEY[setting], defaults[setting])
  $.ui.invalidate('ui.render')
}

async function sessionKey($: EngineInterface): Promise<string> {
  return (await $.session.id()).replace(/[^\w-]/g, '_')
}

// The name the chat addresses this session by: the one asked for, else the
// one it had, else its folder's; with a suffix where another listening
// session already answers to it.
async function chooseName($: EngineInterface, asked: string): Promise<string> {
  const dir = await directory($)
  const id = await sessionKey($)
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const folder = slug(cwd.split(/[\\/]/).filter(Boolean).pop() ?? '')
  const wanted = slug(asked) || heldName || folder || 'session'

  const entries = await $.fs.list(`${dir}/listeners`).catch(() => [])
  const taken = new Set<string>()
  for (const entry of entries) {
    if (!entry.name.endsWith('.json') || entry.name === `${id}.json`) continue
    const other = await $.fs
      .read(`${dir}/listeners/${entry.name}`)
      .then(text => JSON.parse(text) as Listener)
      .catch(() => undefined)
    if (other && now - other.at < FRESH_MS) taken.add(other.name)
  }
  const name = taken.has(wanted) ? `${wanted}-${id.slice(0, 4)}` : wanted
  heldName = name

  return name
}

async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const dir = await directory($)
    const id = await sessionKey($)
    const at = await $.clock.now()
    const cwd = await $.session.cwd()
    const name = heldName ?? 'session'
    await $.fs.write(`${dir}/listeners/${id}.json`, JSON.stringify({ id, name, cwd, at }))
    if (pendingId !== undefined || isTurnRunning) return

    const entries = await $.fs.list(`${dir}/inbox`).catch(() => [])
    const names = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort()
    for (const file of names) {
      const messageId = file.slice(0, -'.json'.length)
      if (seen.has(messageId)) continue
      seen.add(messageId)
      const inbound = JSON.parse(await $.fs.read(`${dir}/inbox/${file}`)) as Inbound
      if (inbound.to !== id) continue
      if (await $.fs.exists(`${dir}/claimed/${messageId}.json`)) continue
      if (typeof inbound.text !== 'string' || inbound.text.trim() === '') continue
      if (inbound.text.length > MAX_MESSAGE_CHARS) continue

      await $.fs.write(`${dir}/claimed/${messageId}.json`, JSON.stringify({ id: messageId, at }))
      pendingId = messageId
      $.ui.toast('Message from your Claude chat')
      // Framed by the engine as a plugin's message unless the person chose
      // --plain; the label keeps where it came from in front of the model
      // either way.
      const text = `[Relayed from the user's Claude chat by chat-bridge; the user did not type it here. The final answer of this turn goes back to that chat.]\n\n${inbound.text}`
      await $.prompt.submit(isPlain ? { text, asUser: true } : { text })

      return
    }
  } catch (error) {
    $.ui.status(`chat-bridge: ${String(error)}`.slice(0, 80))
  } finally {
    isPolling = false
  }
}

function start($: EngineInterface, name: string): void {
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => void poll($))
  $.ui.status(`chat-bridge: listening as ${name}`)
  void poll($)
}

async function stop($: EngineInterface): Promise<void> {
  timer?.cancel()
  timer = undefined
  $.ui.status(undefined)
  // An old heartbeat tells the connector at once that this session left.
  const dir = await directory($)
  const id = await sessionKey($)
  await $.fs.write(`${dir}/listeners/${id}.json`, JSON.stringify({ id, name: '', at: 0 }))
}

async function setListening($: EngineInterface, isOn: boolean, asked = ''): Promise<string> {
  if (isOn) {
    const name = await chooseName($, asked)
    isListening = true
    start($, name)
    $.ui.invalidate('ui.render')

    return name
  }
  isListening = false
  await stop($)
  $.ui.invalidate('ui.render')

  return heldName ?? ''
}

async function toggle($: EngineInterface, setting: Setting): Promise<void> {
  if (setting === 'listening') {
    await setListening($, !isListening)

    return
  }
  if (setting === 'trust') isTrusted = !isTrusted
  else isPlain = !isPlain
  $.ui.invalidate('ui.render')
}

// The name typed in the menu; a listening session answers to it at once.
async function rename($: EngineInterface, asked: string): Promise<void> {
  await chooseName($, asked)
  if (isListening) {
    $.ui.status(`chat-bridge: listening as ${heldName ?? 'session'}`)
    void poll($)
  }
  $.ui.invalidate('ui.render')
}

function summary(): string {
  if (!isListening) return 'chat-bridge is off.'

  return `chat-bridge is on as "${heldName ?? 'session'}"${isTrusted ? ', trusted' : ', asking before each action of a relayed message'}${isPlain ? ', plain messages' : ''}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chat-bridge',
      description: 'Let your normal Claude chat talk to this session: on [name] [--trust] [--plain], off or status',
    })
    // A new session starts from the saved defaults; a default of listening
    // is the person's own choice to have every session listen.
    await loadDefaults($)
    isTrusted = defaults.trust
    isPlain = defaults.plain
    if (defaults.listening) await setListening($, true)

    return next(e)
  })

  on('command.run', { command: 'chat-bridge' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const word = verb.toLowerCase()
    if (word === 'on') {
      const flags = rest.filter(part => part.startsWith('--')).map(part => part.toLowerCase())
      const unknown = flags.find(flag => !['--trust', '--ask', '--plain', '--framed'].includes(flag))
      if (unknown !== undefined) {
        return {
          text: `chat-bridge: unknown option ${unknown}. Use /chat-bridge on [name] [--trust|--ask] [--plain|--framed].`,
        }
      }
      // An option left out keeps the setting as it stands.
      if (flags.includes('--trust')) isTrusted = true
      if (flags.includes('--ask')) isTrusted = false
      if (flags.includes('--plain')) isPlain = true
      if (flags.includes('--framed')) isPlain = false
      const name = await setListening($, true, rest.filter(part => !part.startsWith('--')).join(' '))

      return {
        text: [
          `chat-bridge is on as "${name}": messages your Claude chat sends to "${name}" run here as prompts, and each answer goes back to the chat.`,
          isTrusted
            ? 'Trusted: what a relayed message leads to runs under this session\'s own permissions, with nothing extra asked.'
            : 'While a relayed message runs, you are asked to approve each action that is not a read.',
          '/chat-bridge opens the settings.',
        ].join(' '),
      }
    }
    if (word === 'off') {
      await setListening($, false)

      return { text: 'chat-bridge is off: this session no longer takes messages from your Claude chat.' }
    }
    if (word === 'status') return { text: summary() }
    if (word !== '' && word !== 'menu') {
      return { text: 'chat-bridge: use /chat-bridge (the settings), /chat-bridge on [name], /chat-bridge off or /chat-bridge status.' }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'chat-bridge', focus: true })

    return {
      text: isPlaced
        ? `${summary()} Settings opened.`
        : `${summary()} The settings pane cannot be shown here: use /chat-bridge on [name] [--trust|--ask] [--plain|--framed] and /chat-bridge off.`,
    }
  })

  // The control menu: each setting's switch, and beside the lockable ones the
  // lock that saves the current value as the default for new sessions.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const rows: readonly { setting: Setting; label: string; isOn: boolean; note: string }[] = [
      {
        setting: 'listening',
        label: 'Listening',
        isOn: isListening,
        note: 'This session takes messages from your Claude chat.',
      },
      {
        setting: 'trust',
        label: 'Ask before actions',
        isOn: !isTrusted,
        note: isTrusted
          ? 'Off: what a relayed message leads to runs with nothing extra asked.'
          : 'You approve each action of a relayed message that is not a read.',
      },
      {
        setting: 'plain',
        label: 'Plain messages',
        isOn: isPlain,
        note: isPlain
          ? 'Relayed messages arrive as if you typed them.'
          : 'Relayed messages arrive marked as sent by the chat-bridge plugin.',
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        {rows.map(row => (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text bold>{row.label}</Text>
              <Button
                key={`toggle-${row.setting}`}
                label={row.isOn ? 'On' : 'Off'}
                variant={row.isOn ? 'primary' : 'secondary'}
                onPress={() => toggle($, row.setting)}
              />
              {current(row.setting) === defaults[row.setting] ? (
                <Text dimColor>{'\u{1F512}'} default</Text>
              ) : (
                <Button
                  key={`lock-${row.setting}`}
                  label={'\u{1F513} Make default'}
                  dimColor
                  onPress={() => lock($, row.setting)}
                />
              )}
            </Box>
            <Text dimColor>{row.note}</Text>
          </Box>
        ))}
        <Box flexDirection="column">
          <Input
            key="name"
            label="Name"
            value={heldName ?? ''}
            placeholder="this session's folder"
            submitLabel="rename"
            onSubmit={value => rename($, value)}
          />
          <Text dimColor>What the chat calls this session. Enter to rename.</Text>
        </Box>
        <Text dimColor>
          A lock saves the setting as it is now as the default for new sessions.
        </Text>
      </Box>
    )
  })

  // The safeguard. `pendingId` is set from the moment a relayed message is
  // submitted until its turn ends, subagents' calls included.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (pendingId === undefined || isTrusted) return verdict
    if (verdict.decision !== 'allow' || e.isReadOnly === true) return verdict

    return {
      decision: 'ask',
      reason:
        'chat-bridge: this action comes from a message relayed from your Claude chat, not one you typed here.',
    }
  }).catch(($, e, next) =>
    pendingId === undefined
      ? next(e)
      : { decision: 'deny', reason: 'chat-bridge: its check of a relayed message\'s action failed.' },
  )

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      const id = pendingId
      if (id !== undefined) {
        pendingId = undefined
        const dir = await directory($)
        await $.fs.write(
          `${dir}/outbox/${id}.json`,
          JSON.stringify({ id, answer: e.answer, reason: e.reason }),
        )
      }
    }

    return next(e)
  })
}
