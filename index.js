const mineflayer = require('mineflayer')
const fs = require('fs')
const path = require('path')

// try to load dotenv if available (optional)
try { require('dotenv').config(); } catch (e) {}

const { keep_alive } = require('./keep_alive')

// load config (config.json) and allow env overrides
const rawConfig = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
const config = JSON.parse(rawConfig)

const HOST = process.env.MC_HOST || config.ip
const PORT = process.env.MC_PORT || config.port || 25565
let USERNAME = process.env.MC_USERNAME || config.name
const AUTH = process.env.MC_AUTH || config.auth || 'mojang'

// commands and templates
const REGISTER_CMD = process.env.REGISTER_CMD || config.registerCommand || '/register {user} {pass}'
const LOGIN_CMD = process.env.LOGIN_CMD || config.loginCommand || '/login {pass}'
const LOGIN_DELAY_MS = parseInt(process.env.LOGIN_DELAY_MS || config.loginDelayMs || 1500, 10)

// support for multiple alternate usernames (optional)
const ALT_USERNAMES = config.altUsernames || []

// state file to persist registration across restarts
const STATE_FILE = path.join(__dirname, 'state.json')
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) { return { registered: false } }
}
function saveState(state) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8') } catch (e) { log('error', 'Failed to write state file: '+e) } }
let state = loadState()

// basic file logger
const LOG_DIR = path.join(__dirname, 'logs')
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR) } catch (e) {}
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(path.join(LOG_DIR, 'bot.log'), line + '\n') } catch (e) {}
}

// AFK movement (preserved from original)
let lasttime = -1
let moving = 0
let connected = 0
const actions = ['forward','back','left','right']
let lastaction
const pi = 3.14159
const moveinterval = config.moveInterval || 2
const maxrandom = config.maxRandom || 5
function getRandomArbitrary(min, max) { return Math.random() * (max - min) + min }

// reconnect/backoff with jitter
const BASE_DELAY = config.baseReconnectMs || 5000
const MAX_DELAY = config.maxReconnectMs || 60000
let reconnectAttempt = 0
function computeDelay() {
  const exp = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt), MAX_DELAY)
  const jitter = Math.floor(Math.random() * (config.reconnectJitterMs || 1000))
  return exp + jitter
}

let bot = null
let shuttingDown = false

function formatTemplate(tpl, ctx) {
  return tpl.replace(/\{(user|pass)\}/g, (m, p1) => ctx[p1] || '')
}

function createBot(usernameOverride) {
  if (shuttingDown) return
  const user = usernameOverride || USERNAME
  log('info', `Creating bot for ${user}@${HOST}:${PORT}`)
  bot = mineflayer.createBot({ host: HOST, port: PORT, username: user, auth: AUTH })

  // chat/listener helpers
  function onChatJson(jsonMsg) {
    try {
      const text = jsonMsg.toString().toLowerCase()
      log('debug', `chat: ${text}`)
      // check for registration success keywords
      if (pendingRegister) {
        if (/registered|registration|successfully registered|you are registered/.test(text)) {
          log('info', 'Detected registration success in chat, persisting state')
          state.registered = true; saveState(state); pendingRegister = false
        } else if (/already registered|registered before|passwords do not match|error|failed/.test(text)) {
          log('warn', 'Registration appears to have failed or already exists; not persisting yet')
          pendingRegister = false
        }
      }
      if (pendingLogin) {
        if (/logged in|successfully logged in|welcome|you are now logged in|login successful/.test(text)) {
          log('info', 'Detected login success')
          pendingLogin = false
        }
      }
    } catch (e) { log('error', 'onChatJson error:'+e) }
  }

  bot.on('message', onChatJson)

  bot.once('login', () => log('info', 'Logged in event received'))

  bot.on('spawn', () => {
    log('info', 'Spawned')
    connected = 1
    reconnectAttempt = 0 // reset backoff

    // On first-time ever registration: send register command and wait for confirmation from chat
    if (!state.registered) {
      log('info', 'No persisted registration found. Sending register command (one-time)')
      const regCmd = formatTemplate(REGISTER_CMD, { user: user, pass: config.password })
      try { bot.chat(regCmd); pendingRegister = true } catch (e) { log('error', 'Failed to send register command: '+e) }
      // schedule login after registerDelay (configurable)
      setTimeout(() => {
        const loginCmd = formatTemplate(LOGIN_CMD, { user: user, pass: config.password })
        try { bot.chat(loginCmd); pendingLogin = true } catch (e) { log('error', 'Failed to send login command: '+e) }
      }, config.registerToLoginDelayMs || 2000)
    } else {
      log('info', 'Persisted registration found. Sending login command on spawn')
      setTimeout(() => {
        const loginCmd = formatTemplate(LOGIN_CMD, { user: user, pass: config.password })
        try { bot.chat(loginCmd); pendingLogin = true } catch (e) { log('error', 'Failed to send login command: '+e) }
      }, LOGIN_DELAY_MS)
    }
  })

  // AFK movement time loop
  bot.on('time', () => {
    if (connected < 1) return
    if (lasttime < 0) lasttime = bot.time.age
    else {
      const randomadd = Math.random() * maxrandom * 20
      const interval = moveinterval * 20 + randomadd
      if (bot.time.age - lasttime > interval) {
        if (moving === 1) {
          bot.setControlState(lastaction, false)
          moving = 0; lasttime = bot.time.age
        } else {
          const yaw = Math.random()*pi - (0.5*pi)
          const pitch = Math.random()*pi - (0.5*pi)
          bot.look(yaw, pitch, false)
          lastaction = actions[Math.floor(Math.random() * actions.length)]
          bot.setControlState(lastaction, true)
          moving = 1; lasttime = bot.time.age
          try { bot.activateItem() } catch (e) {}
        }
      }
    }
  })

  bot.on('end', () => {
    log('warn', 'Disconnected (end)')
    connected = 0
    cleanupBot()
    scheduleReconnect()
  })

  bot.on('kicked', (reason) => {
    log('warn', `Kicked: ${reason}`)
    connected = 0
    cleanupBot()
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    log('error', `Bot error: ${err && err.message ? err.message : err}`)
    connected = 0
    cleanupBot()
    scheduleReconnect()
  })

  // helpers per bot
  let pendingRegister = false
  let pendingLogin = false

  // try alternate usernames on name in use
  bot.on('kicked', (reason) => {
    const text = (reason || '').toLowerCase()
    if (/name.*in use|username .* taken|duplicate name/.test(text) && ALT_USERNAMES.length > 0) {
      const next = ALT_USERNAMES.shift()
      log('info', `Name in use; retrying with alternate username ${next}`)
      cleanupBot()
      setTimeout(() => createBot(next), 1000 + Math.floor(Math.random()*2000))
    }
  })
}

function cleanupBot() {
  try {
    if (!bot) return
    actions.forEach(a => { try { bot.setControlState(a,false) } catch (e) {} })
    bot.removeAllListeners()
    try { bot.quit && bot.quit() } catch (e) {}
  } catch (e) { log('error', 'cleanupBot error:'+e) }
  bot = null
}

function scheduleReconnect() {
  if (shuttingDown) return
  reconnectAttempt++
  const delay = computeDelay()
  log('info', `Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay/1000)}s`)
  setTimeout(() => { if (!shuttingDown) createBot() }, delay)
}

// graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', `Received ${sig}, shutting down`)
  cleanupBot()
  process.exit(0)
}

// start keep-alive HTTP server (exposes /health and /metrics)
try { keep_alive(config.keepAlivePort || 2323) } catch (e) { log('warn', 'keep_alive start failed: '+e) }

// start initial bot
createBot()