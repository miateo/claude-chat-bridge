#!/usr/bin/env node
// Sets chat-bridge up on this computer from this folder:
//   1. adds the connector to the Claude desktop app's config (a backup of the
//      config is written beside it first), pointing at server/bridge-mcp.mjs here
//   2. installs the mod into Claude Code from this folder
// Run it again after moving the folder. Keep the folder: both halves run from it.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, 'server', 'bridge-mcp.mjs')

const configDir =
  platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Claude')
    : platform() === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude')
const configPath = join(configDir, 'claude_desktop_config.json')

// 1. The desktop app's connector.
let config = {}
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    console.error(`Could not read ${configPath} as JSON; left it untouched.`)
    process.exit(1)
  }
  copyFileSync(configPath, `${configPath}.before-chat-bridge`)
} else {
  mkdirSync(configDir, { recursive: true })
}
// The node on PATH where there is one: a package manager's own path to the
// running binary (Homebrew's Cellar) stops existing at its next upgrade.
const found = spawnSync(platform() === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' })
const node = (found.status === 0 && found.stdout.split(/\r?\n/)[0].trim()) || process.execPath
config.mcpServers = { ...config.mcpServers, 'chat-bridge': { command: node, args: [server] } }
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Connector added to ${configPath}`)

// Where Claude Code is installed, for background runs: the desktop app starts
// the connector with a short PATH that may not hold it.
const which = spawnSync(platform() === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
const claudePath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : ''
if (claudePath !== '') {
  const bridgeDir = join(homedir(), '.claude', 'chat-bridge')
  const bridgeConfig = join(bridgeDir, 'config.json')
  mkdirSync(bridgeDir, { recursive: true, mode: 0o700 })
  let held = {}
  try {
    held = JSON.parse(readFileSync(bridgeConfig, 'utf8'))
  } catch {}
  writeFileSync(bridgeConfig, JSON.stringify({ ...held, claudePath }), { mode: 0o600 })
}

// 2. The Claude Code mod.
const claude = (...args) => spawnSync('claude', args, { stdio: 'inherit', shell: platform() === 'win32' }).status === 0
const isInstalled =
  (claude('plugin', 'marketplace', 'add', here) || claude('plugin', 'marketplace', 'update', 'chat-bridge-marketplace')) &&
  claude('plugin', 'install', 'chat-bridge@chat-bridge-marketplace', '--scope', 'user')

console.log('')
if (isInstalled) {
  console.log('Mod installed into Claude Code.')
} else {
  console.log('Could not install the mod automatically. Run these yourself:')
  console.log(`  claude plugin marketplace add "${here}"`)
  console.log('  claude plugin install chat-bridge@chat-bridge-marketplace')
}
console.log('')
console.log('Next: quit and reopen the Claude desktop app, then run /chat-bridge on in a new Claude Code session.')
