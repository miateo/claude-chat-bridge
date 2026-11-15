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

type Inbound = { id: string; to?: string; text: string; model?: string; effort?: string; subagentModel?: string }

// The spellings a relayed choice of model may take, checked again here: the
// value goes on to a slash command, so nothing else may ride along with it.
const MODEL = /^(fable|opus|sonnet|haiku|claude-[a-z0-9][a-z0-9.-]{2,60})$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// The default subagent model, for every session and run: none, then each step.
const SUBAGENT_CHOICES = ['', 'sonnet', 'haiku'] as const
const SUBAGENT_LABEL: Record<string, string> = { '': 'Same model', sonnet: 'Sonnet', haiku: 'Haiku' }
type Listener = { id: string; name: string; at: number }

// All of it is the module's own, for this session alone, and starts over
// from the defaults at a restart or reload.
let isListening = false
// The name the chat addresses this session by.
let heldName: string | undefined
// Run a relayed message's actions without asking: off unless --trust.
let isTrusted = false
// Submit a relayed message as typed, without the engine's frame: off unless --plain.
let isPlain = false
// What a setting is where the person has saved no default of their own: a
// session listens, asks before a relayed message's actions, and frames it.
const BUILT_IN: Record<Setting, boolean> = { listening: true, trust: false, plain: false }
// The defaults in force: the saved one as last read from `$.store`, else the built-in.
const defaults: Record<Setting, boolean> = { ...BUILT_IN }
// Background runs, as config.json has them: the chat starting Claude Code by
// itself. For every session at once, and off until the person turns them on.
type RunMode = 'ask' | 'balanced' | 'auto'
type Runs = { isEnabled: boolean; folders: readonly string[]; hasCode: boolean; mode: RunMode }
let runs: Runs = { isEnabled: false, folders: [], hasCode: false, mode: 'ask' }
const RUN_MODES: Record<RunMode, { label: string; note: string }> = {
  ask: {
    label: 'You',
    note: 'You: every action that is not a read waits in the chat until you type your approval code.',
  },
  balanced: {
    label: 'Balanced',
    note: 'Balanced: Claude Code decides the ordinary actions alone. Deleting, moving, installing, the network, git pushes and anything outside the folder still wait for your approval code.',
  },
  auto: {
    label: 'Auto mode',
    note: 'Auto mode: Claude Code decides alone and asks nobody. It does what the message asks, deleting included, if that looks like the task.',
  },
}
// A line under the runs settings saying why a change was not made.
let runsNote = ''
let sessionFolder = ''
// True inside a background run the connector started, and the mode it runs in.
let isBackgroundRun = false
let runMode = ''
// Whether the bar above the prompt shows the settings under its one line.
let isBarOpen = false
let timer: Timer | undefined
let isPolling = false
let beats = 0
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

// Balanced mode's own rule, on top of auto mode's classifier: what a
// background run may not do without the person, however the task is worded.
// A list of what is known to be risky, so it errs toward asking.
const RISKY_COMMAND =
  /(^|[\s;&|(`$])(sudo|rm|rmdir|unlink|mv|dd|shred|truncate|chmod|chown|kill|pkill|killall|launchctl|crontab|ssh|scp|sftp|rsync|curl|wget|nc|ncat|telnet|osascript|defaults|open|eval|npm|npx|pnpm|yarn|bun|pip|pip3|brew|gem|docker|kubectl|gh|git\s+(push|reset|clean|rebase|checkout|restore|remote|config|branch\s+-[dD]|stash\s+(drop|clear)))(\s|$)/

function isInside(path: string, folder: string): boolean {
  const root = folder.replace(/[\\/]+$/, '')

  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
}

function riskOf(tool: string, input: unknown, folder: string): string | undefined {
  const fields = (input ?? {}) as { command?: unknown; file_path?: unknown; notebook_path?: unknown }
  // Handing work to a subagent, or keeping a to-do list, changes nothing by
  // itself: a subagent's own actions come through this check one by one.
  if (tool === 'Agent' || tool === 'Task' || tool === 'TodoWrite') return undefined
  if (tool === 'Bash') {
    const command = typeof fields.command === 'string' ? fields.command : ''
    if (RISKY_COMMAND.test(command)) return 'it deletes, moves, installs, reaches the network or changes what is hard to undo'
    // A write (a redirect, tee) that names a path outside the run's folder.
    const isWrite = />|\btee\b/.test(command)
    const outside = (command.match(/(?:^|[\s=>"'])((?:~|\/)[^\s"'<>|;&)]*)/g) ?? [])
      .map(found => found.replace(/^[\s=>"']+/, ''))
      .filter(path => path.startsWith('~') || !isInside(path, folder))
      .filter(path => !path.startsWith('/dev/'))
    if (isWrite && outside.length > 0) return 'it writes outside the folder the run was started in'

    return undefined
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const path = typeof fields.file_path === 'string' ? fields.file_path : typeof fields.notebook_path === 'string' ? fields.notebook_path : ''

    return isInside(path, folder) ? undefined : 'it changes a file outside the folder the run was started in'
  }

  return 'it is not a read, and not a tool the bridge knows to be safe'
}

function current(setting: Setting): boolean {
  return setting === 'listening' ? isListening : setting === 'trust' ? isTrusted : isPlain
}

async function loadDefaults($: EngineInterface): Promise<void> {
  for (const setting of SETTINGS) {
    const saved = await $.store.get(STORE_KEY[setting])
    defaults[setting] = typeof saved === 'boolean' ? saved : BUILT_IN[setting]
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
    // Every fifth beat, pick up what another session changed.
    beats += 1
    if (beats % 5 === 0) await refresh($)
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
      // The model and effort the chat chose: set as the person would, with the
      // slash commands, before the message runs. They stay for the session.
      const switched: string[] = []
      if (typeof inbound.model === 'string' && MODEL.test(inbound.model)) {
        await $.command.run({ command: 'model', args: inbound.model }).catch(() => undefined)
        switched.push(`model ${inbound.model}`)
      }
      if (typeof inbound.effort === 'string' && EFFORTS.includes(inbound.effort)) {
        await $.command.run({ command: 'effort', args: inbound.effort }).catch(() => undefined)
        switched.push(`effort ${inbound.effort}`)
      }
      if (switched.length > 0) $.ui.toast(`chat-bridge: ${switched.join(', ')}`)
      const subagent =
        typeof inbound.subagentModel === 'string' && MODEL.test(inbound.subagentModel) ? inbound.subagentModel : undefined
      const text = [
        "[Relayed from the user's Claude chat by chat-bridge; the user did not type it here. The final answer of this turn goes back to that chat.]",
        ...(subagent === undefined
          ? []
          : [
              `[To keep usage down, hand self-contained work (searching the code, reading many files, running and summarising tests) to subagents with the Agent tool on the "${subagent}" model, and keep only their conclusions here. Do small work yourself.]`,
            ]),
        '',
        inbound.text,
      ].join('\n')
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

type RawRuns = { enabled?: unknown; folders?: unknown; code?: unknown; codeHash?: unknown; salt?: unknown; mode?: unknown }
type RawConfig = { runs?: RawRuns; subagentModel?: unknown; autoUpdate?: unknown }

async function readConfig($: EngineInterface): Promise<RawConfig> {
  const dir = await directory($)

  return $.fs
    .read(`${dir}/config.json`)
    .then(text => JSON.parse(text) as RawConfig)
    .catch(() => ({}))
}

function folderList(raw: RawRuns): string[] {
  return Array.isArray(raw.folders) ? raw.folders.filter((one): one is string => typeof one === 'string') : []
}

async function loadRuns($: EngineInterface): Promise<void> {
  await loadSubagentModel($)
  await loadUpdate($)
  const raw = (await readConfig($)).runs ?? {}
  const hasCode = (typeof raw.code === 'string' && raw.code !== '') || typeof raw.codeHash === 'string'
  const mode: RunMode = raw.mode === 'auto' || raw.mode === 'balanced' ? raw.mode : 'ask'
  runs = { isEnabled: raw.enabled === true && hasCode, folders: folderList(raw), hasCode, mode }
}

// Reads the file again before each change: the connector rewrites it too,
// when it replaces a typed approval code with its hash.
async function changeRuns($: EngineInterface, change: (raw: RawRuns) => RawRuns): Promise<void> {
  const dir = await directory($)
  const config = await readConfig($)
  await $.fs.write(`${dir}/config.json`, JSON.stringify({ ...config, runs: change(config.runs ?? {}) }))
  await loadRuns($)
  $.ui.invalidate('ui.render')
}

async function toggleRuns($: EngineInterface): Promise<void> {
  await loadRuns($)
  if (!runs.isEnabled && !runs.hasCode) {
    runsNote = 'Set an approval code first: the chat needs it from you to allow an action.'
    $.ui.invalidate('ui.render')

    return
  }
  runsNote = ''
  const isEnabled = !runs.isEnabled
  await changeRuns($, raw => ({ ...raw, enabled: isEnabled }))
}

// Who decides a run's actions, one step on at each press: the person, by
// approval code ('ask', the default); auto mode with the risky ones still
// the person's ('balanced'); or auto mode alone.
// The default subagent model, kept beside the runs in config.json: it holds
// for every session's relayed messages and for every background run.
let subagentModel = ''

async function loadSubagentModel($: EngineInterface): Promise<void> {
  const held = (await readConfig($)).subagentModel
  subagentModel = typeof held === 'string' && MODEL.test(held) ? held : ''
}

async function cycleSubagentModel($: EngineInterface): Promise<void> {
  await loadSubagentModel($)
  const at = SUBAGENT_CHOICES.indexOf(subagentModel as (typeof SUBAGENT_CHOICES)[number])
  const next = SUBAGENT_CHOICES[(at + 1) % SUBAGENT_CHOICES.length] ?? ''
  const dir = await directory($)
  const { subagentModel: _old, ...rest } = await readConfig($)
  await $.fs.write(`${dir}/config.json`, JSON.stringify(next === '' ? rest : { ...rest, subagentModel: next }))
  subagentModel = next
  $.ui.invalidate('ui.render')
}

// Updating itself: the person's switch, kept in config.json, and what the
// connector last did about it, in update.json. The connector does the work.
type UpdateStatus = { version?: string; checkedAt?: number; state?: string; message?: string }
let isAutoUpdate = false
let updateStatus: UpdateStatus = {}

async function loadUpdate($: EngineInterface): Promise<void> {
  isAutoUpdate = (await readConfig($)).autoUpdate === true
  const dir = await directory($)
  updateStatus = await $.fs
    .read(`${dir}/update.json`)
    .then(text => JSON.parse(text) as UpdateStatus)
    .catch(() => ({}))
}

async function toggleAutoUpdate($: EngineInterface): Promise<void> {
  const dir = await directory($)
  const { autoUpdate: _old, ...rest } = await readConfig($)
  const isOn = !isAutoUpdate
  await $.fs.write(`${dir}/config.json`, JSON.stringify(isOn ? { ...rest, autoUpdate: true } : rest))
  isAutoUpdate = isOn
  $.ui.invalidate('ui.render')
}

function updateNote(): string {
  const at = typeof updateStatus.version === 'string' ? `Version ${updateStatus.version}. ` : ''
  if (!isAutoUpdate) {
    return `${at}Off: you update by pulling the chat-bridge folder. On: the connector pulls the official repository's main branch once a day, while the desktop app runs. It then runs that code without anyone checking it first, so turn it on only if you trust the repository's owner.`
  }
  const last =
    typeof updateStatus.checkedAt === 'number' && typeof updateStatus.message === 'string'
      ? ` Last check ${new Date(updateStatus.checkedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${updateStatus.message}`
      : ' The first check runs within the hour, while the desktop app is open.'

  return `${at}The connector pulls the official repository's main branch once a day, only as a clean fast-forward.${last} For the whole computer.`
}

async function toggleRunMode($: EngineInterface): Promise<void> {
  await loadRuns($)
  const mode: RunMode = runs.mode === 'ask' ? 'balanced' : runs.mode === 'balanced' ? 'auto' : 'ask'
  runsNote = ''
  await changeRuns($, raw => ({ ...raw, mode }))
}

async function setCode($: EngineInterface, typed: string): Promise<void> {
  const code = typed.trim()
  if (code.length < 4) {
    runsNote = 'The approval code needs at least 4 characters.'
    $.ui.invalidate('ui.render')

    return
  }
  runsNote = 'Approval code saved.'
  // The connector keeps only a salted hash of it from its next read on.
  await changeRuns($, raw => ({ enabled: raw.enabled, folders: raw.folders, mode: raw.mode, code }))
}

async function allowFolder($: EngineInterface, folder: string, isAllowed: boolean): Promise<void> {
  runsNote = ''
  await changeRuns($, raw => {
    const held = folderList(raw)

    return { ...raw, folders: isAllowed ? [...new Set([...held, folder])] : held.filter(one => one !== folder) }
  })
}

// Whether the session's folder is one a person would name: not the throwaway
// folder an app makes for a session started without a project.
function isProjectFolder(folder: string): boolean {
  return folder !== '' && !/[\\/](scratch-workspaces|\.claude[\\/]spares)[\\/]/.test(folder)
}

// A folder typed into the settings: "~" is the home folder, and it has to be
// a folder that exists. Stored as the path it really is.
// A folder as typed or pasted, made a plain path: quotes around it and a
// terminal's backslash escapes (\\ before a space or a ~) are taken off, ~ is
// the home folder, and a home path written after ~ ("~/Users/me/x") is read
// as the path it spells.
function folderPath(text: string, home: string): string {
  const unquoted = text.replace(/^(['"])(.*)\1$/, '$2')
  const isWindows = /^[A-Za-z]:[\\/]/.test(unquoted)
  const plain = isWindows ? unquoted : unquoted.replace(/\\(.)/g, '$1')
  if (home !== '' && (plain.startsWith(`~${home}/`) || plain === `~${home}`)) return plain.slice(1)
  if (plain === '~') return home

  return plain.startsWith('~/') ? `${home}${plain.slice(1)}` : plain
}

async function addFolder($: EngineInterface, typed: string): Promise<void> {
  const home = ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '').replaceAll('\\', '/')
  const text = typed.trim()
  const path = folderPath(text, home)
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  const stat = isAbsolute ? await $.fs.stat(path, { resolve: true }).catch(() => undefined) : undefined
  // Claude Code will not look into a folder it counts as a network location
  // from a mod, iCloud Drive among them (Documents and Desktop too, when they
  // sync to it): `exists` rejects for such a folder alone. It is allowed as
  // typed, and the connector, which can see it, checks it whenever a run
  // would start there.
  const isCloud = stat === undefined && isAbsolute && (await $.fs.exists(path).then(() => false, () => true))
  if (isCloud) {
    const clean = path.replace(/\/+$/, '')
    await allowFolder($, clean, true)
    runsNote = `Allowed: ${clean}, and every folder inside it. It is kept in the cloud, so it was not checked here: if it is not a folder on this computer, runs there are refused.`
    $.ui.invalidate('ui.render')

    return
  }
  if (stat === undefined || stat.kind !== 'dir') {
    runsNote = `"${text}" is not a folder on this computer. Type its full path, or one starting with ~/.`
    $.ui.invalidate('ui.render')

    return
  }
  await allowFolder($, stat.realPath ?? path, true)
  runsNote = `Allowed: ${stat.realPath ?? path}, and every folder inside it.`
  $.ui.invalidate('ui.render')
}

// The settings every session shares (the saved defaults, background runs) as
// they are on disk now: another session, or the connector, may have changed them.
async function refresh($: EngineInterface): Promise<void> {
  const before = JSON.stringify([defaults, runs, subagentModel, isAutoUpdate, updateStatus])
  await loadDefaults($)
  await loadRuns($)
  if (JSON.stringify([defaults, runs, subagentModel, isAutoUpdate, updateStatus]) !== before) $.ui.invalidate('ui.render')
}

async function openBar($: EngineInterface, isOpen: boolean): Promise<void> {
  isBarOpen = isOpen
  $.ui.invalidate('ui.render')
  if (isOpen) await refresh($)
}

// The settings themselves, drawn the same in the pane and in the bar: each
// setting's switch, and beside the lockable ones the lock that saves the
// current value as the default for new sessions.
function settings($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  // Stacked rows take the surface's own small step between them (`sm`: none
  // on the terminal, a few pixels on desktop, where a button is taller than a
  // line of text and rows would otherwise touch), and a row's controls are
  // centred on its text.
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
    <Box flexDirection="column" gap="md">
      {rows.map(row => (
        <Box flexDirection="column" rowGap="sm">
          <Box gap={1} alignItems="center">
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
      <Box flexDirection="column" rowGap="sm">
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
      <Box flexDirection="column" rowGap="sm">
        <Box gap={1} alignItems="center">
          <Text bold>Subagents run on</Text>
          <Button
            key="toggle-subagent-model"
            label={SUBAGENT_LABEL[subagentModel] ?? subagentModel}
            variant={subagentModel === '' ? 'secondary' : 'primary'}
            onPress={() => cycleSubagentModel($)}
          />
        </Box>
        <Text dimColor>
          {subagentModel === ''
            ? 'Same model: Claude Code uses subagents as it sees fit. Press to have relayed messages and background runs hand searching and reading to a cheaper model.'
            : `Relayed messages and background runs hand searching, reading and test runs to subagents on ${SUBAGENT_LABEL[subagentModel] ?? subagentModel}, and keep only their conclusions. The chat can still choose otherwise for one message. For every session on this computer.`}
        </Text>
      </Box>
      <Box flexDirection="column" rowGap="sm">
        <Box gap={1} alignItems="center">
          <Text bold>Update automatically</Text>
          <Button
            key="toggle-auto-update"
            label={isAutoUpdate ? 'On' : 'Off'}
            variant={isAutoUpdate ? 'primary' : 'secondary'}
            onPress={() => toggleAutoUpdate($)}
          />
        </Box>
        <Text dimColor>{updateNote()}</Text>
      </Box>
      <Box flexDirection="column" rowGap="sm">
        <Box gap={1} alignItems="center">
          <Text bold>Background runs</Text>
          <Button
            key="toggle-runs"
            label={runs.isEnabled ? 'On' : 'Off'}
            variant={runs.isEnabled ? 'primary' : 'secondary'}
            onPress={() => toggleRuns($)}
          />
        </Box>
        <Text dimColor>
          {runs.isEnabled
            ? 'The chat can start Claude Code by itself, unattended, in the folders below.'
            : 'Off: the chat can only talk to sessions you opened. On lets it start Claude Code by itself in folders you allow.'}
        </Text>
      </Box>
      <Box flexDirection="column" rowGap="sm">
        <Box gap={1} alignItems="center">
          <Text bold>A run's actions are decided by</Text>
          <Button
            key="toggle-run-mode"
            label={RUN_MODES[runs.mode].label}
            variant={runs.mode === 'auto' ? 'secondary' : 'primary'}
            onPress={() => toggleRunMode($)}
          />
        </Box>
        <Text dimColor>{RUN_MODES[runs.mode].note} Press to change.</Text>
      </Box>
      <Box flexDirection="column" rowGap="sm">
        <Input
          key="run-code"
          label="Approval code"
          value=""
          placeholder={runs.hasCode ? 'set; type a new one to change it' : 'at least 4 characters'}
          submitLabel="save"
          onSubmit={value => setCode($, value)}
        />
        <Text dimColor>
          You type it in the chat to allow an action of a background run. Keep it to yourself; it is stored only as a hash.
        </Text>
      </Box>
      <Box flexDirection="column" rowGap="sm">
        <Text bold>Folders a background run may start in</Text>
        {runs.folders.length === 0 && <Text dimColor>None yet.</Text>}
        {runs.folders.map((folder, index) => (
          <Box gap={1} alignItems="center">
            <Text>{folder}</Text>
            <Button
              key={`run-folder-remove-${index}`}
              label="Remove"
              dimColor
              onPress={() => allowFolder($, folder, false)}
            />
          </Box>
        ))}
        <Input
          key="run-folder-new"
          label="Add a folder"
          value=""
          placeholder="~/DEV, or a full path"
          submitLabel="allow"
          onSubmit={value => addFolder($, value)}
        />
        <Text dimColor>
          An allowed folder covers every folder inside it. These settings are for the whole computer, not this session.
        </Text>
        {isProjectFolder(sessionFolder) && !runs.folders.includes(sessionFolder) && (
          <Box gap={1} alignItems="center">
            <Button
              key="run-folder-add"
              label="Allow this session's folder"
              dimColor
              onPress={() => allowFolder($, sessionFolder, true)}
            />
            <Text dimColor wrap="truncate-middle">
              {sessionFolder}
            </Text>
          </Box>
        )}
      </Box>
      {runsNote !== '' && <Text color="yellow">{runsNote}</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chat-bridge',
      description: 'Let your normal Claude chat talk to this session: on [name] [--trust] [--plain], off or status',
    })
    // A new session starts from the defaults, so it listens unless the person
    // saved "Listening: Off" as theirs. A run nobody sits at (`claude -p`, an
    // SDK host) never listens by itself: nobody could approve what a relayed
    // message asks for, or know it was listening.
    await loadDefaults($)
    sessionFolder = await $.session.cwd()
    isBackgroundRun = (await $.env.get('CHAT_BRIDGE_RUN')) !== undefined
    runMode = (await $.env.get('CHAT_BRIDGE_RUN_MODE')) ?? ''
    await loadRuns($)
    isTrusted = defaults.trust
    isPlain = defaults.plain
    // The Claude desktop app runs Claude Code through the SDK, so its sessions
    // say they are not interactive although a person sits at them: they count
    // as interactive here. A background run never listens, whatever its host.
    const isDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    const hasPerson = e.isInteractive || isDesktop
    if (defaults.listening && hasPerson && !isBackgroundRun) await setListening($, true)

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
    await refresh($)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'chat-bridge', focus: true })

    return {
      text: isPlaced
        ? `${summary()} Settings opened.`
        : `${summary()} The settings pane cannot be shown here: use /chat-bridge on [name] [--trust|--ask] [--plain|--framed] and /chat-bridge off.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => settings($, e))

  // The bar above the prompt, always there: one line saying whether this
  // session listens, with a button that opens the settings in place.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={isBarOpen ? 'md' : 0}>
        <Box gap={1} alignItems="center">
          <Text color={isListening ? 'green' : undefined} dimColor={!isListening}>
            {isListening ? '\u25CF' : '\u25CB'}
          </Text>
          <Text dimColor>
            {isListening
              ? `chat-bridge: listening as "${heldName ?? 'session'}"${isTrusted ? ', not asking before actions' : ''}`
              : 'chat-bridge: off'}
          </Text>
          <Button
            key="bar-settings"
            label={isBarOpen ? 'Hide settings' : 'Settings'}
            dimColor
            onPress={() => openBar($, !isBarOpen)}
          />
        </Box>
        {isBarOpen && settings($, e)}
      </Box>
    )
  })

  // The safeguard. `pendingId` is set from the moment a relayed message is
  // submitted until its turn ends, subagents' calls included.
  on('tool.check', async ($, e, next) => {
    // The bridge's own files (the approval code's hash, a run's decisions)
    // are never a relayed message's or a background run's to touch.
    // A subagent's brief is only words (it may repeat this very rule); the
    // subagent's own tool calls come through this check like any other.
    const isBrief = e.tool === 'Agent' || e.tool === 'Task'
    if ((pendingId !== undefined || isBackgroundRun) && !isBrief && JSON.stringify(e.input ?? {}).includes('.claude/chat-bridge')) {
      return {
        decision: 'deny',
        reason: 'chat-bridge: its own files are off limits to a relayed message or a background run.',
      }
    }
    const verdict = await next(e)
    // A balanced background run: auto mode said yes; the risky ones still go
    // to the person, through the run's permission handler.
    // (In auto mode the engine's own verdict is an `ask` its classifier then
    // settles; an ask this hook makes is a person's, which no classifier settles.)
    if (isBackgroundRun && runMode === 'balanced' && verdict.decision !== 'deny' && e.isReadOnly !== true) {
      const risk = riskOf(e.tool, e.input, sessionFolder)
      if (risk !== undefined) return { decision: 'ask', reason: `chat-bridge: ${risk}.` }
    }
    if (pendingId === undefined || isTrusted) return verdict
    // An `ask` of the engine's is made this hook's own too: in an auto-mode
    // session it would otherwise go to the classifier, not to the person.
    if (verdict.decision === 'deny' || e.isReadOnly === true) return verdict
    // Handing work to a subagent asks nothing by itself: its actions are put to
    // the person one by one, as the subagent takes them.
    if (isBrief || e.tool === 'TodoWrite') return verdict

    return {
      decision: 'ask',
      reason:
        'chat-bridge: this action comes from a message relayed from your Claude chat, not one you typed here.',
    }
  }).catch(($, e, next) =>
    pendingId === undefined && !isBackgroundRun
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
