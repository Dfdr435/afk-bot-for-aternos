const mineflayer = require('mineflayer')
const fs = require('fs');
const path = require('path');
const { keep_alive } = require("./keep_alive");

// load config
let rawdata = fs.readFileSync('config.json');
let data = JSON.parse(rawdata);
const host = data["ip"];
const port = data["port"] || 25565;
const username = data["name"] || 'afk bot';

// state file to persist whether we've already registered
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
    try {
        const s = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(s);
    } catch (e) {
        return { registered: false };
    }
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to write state file:', e);
    }
}

let state = loadState();

// AFK movement vars (preserved)
var lasttime = -1;
var moving = 0;
var connected = 0;
var actions = [ 'forward', 'back', 'left', 'right']
var lastaction;
var pi = 3.14159;
var moveinterval = 2; // 2 second movement interval
var maxrandom = 5; // 0-5 seconds added to movement interval (randomly)

function getRandomArbitrary(min, max) {
    return Math.random() * (max - min) + min;
}

// Reconnect/backoff settings
const RECONNECT_DELAY_MS = 5000; // wait 5s before reconnect
const MAX_RECONNECT_DELAY_MS = 60000; // cap backoff at 60s
let reconnectDelay = RECONNECT_DELAY_MS;

// Keep a reference to current bot
let bot = null;

function createBot() {
    console.log(`Creating bot for ${username}@${host}:${port}`);
    bot = mineflayer.createBot({
        host: host,
        port: port,
        username: username,
        // add options (version, auth) here if required
    });

    bot.on('login', function() {
        console.log("Logged In")
    });

    bot.on('spawn', function() {
        console.log("Spawned in the world");
        connected = 1;
        reconnectDelay = RECONNECT_DELAY_MS; // reset backoff on success

        // If never registered (persistent state), do register once then login.
        // Otherwise just login.
        if (!state.registered) {
            console.log("Registering account (one-time) then logging in...");
            bot.chat('/register husu20009 husu20009');
            // mark as registered immediately so it won't try again across restarts
            state.registered = true;
            saveState(state);
            // send login after short delay
            setTimeout(() => {
                bot.chat('/login husu20009');
            }, 2000);
        } else {
            console.log("Logging in on spawn...");
            setTimeout(() => {
                bot.chat('/login husu20009');
            }, 1500);
        }
    });

    bot.on('time', function() {
        if (connected < 1) {
            return;
        }
        if (lasttime < 0) {
            lasttime = bot.time.age;
        } else {
            var randomadd = Math.random() * maxrandom * 20;
            var interval = moveinterval * 20 + randomadd;
            if (bot.time.age - lasttime > interval) {
                if (moving == 1) {
                    bot.setControlState(lastaction, false);
                    moving = 0;
                    lasttime = bot.time.age;
                } else {
                    var yaw = Math.random() * pi - (0.5 * pi);
                    var pitch = Math.random() * pi - (0.5 * pi);
                    bot.look(yaw, pitch, false);
                    lastaction = actions[Math.floor(Math.random() * actions.length)];
                    bot.setControlState(lastaction, true);
                    moving = 1;
                    lasttime = bot.time.age;
                    try {
                        bot.activateItem();
                    } catch (e) {
                        // ignore if no item
                    }
                }
            }
        }
    });

    bot.on('end', function() {
        console.log(`Disconnected (end). Will attempt to reconnect in ${reconnectDelay/1000}s`);
        connected = 0;
        cleanupBot();
        scheduleReconnect();
    });

    bot.on('kicked', function(reason) {
        console.log('Kicked from server for reason:', reason);
        connected = 0;
        cleanupBot();
        scheduleReconnect();
    });

    bot.on('error', function(err) {
        console.log('Bot error:', err && err.message ? err.message : err);
        connected = 0;
        cleanupBot();
        scheduleReconnect();
    });
}

// clear event handlers & controls for safety
function cleanupBot() {
    try {
        if (!bot) return;
        actions.forEach(a => {
            try { bot.setControlState(a, false); } catch (e) {}
        });
        bot.removeAllListeners();
    } catch (e) {}
    bot = null;
}

function scheduleReconnect() {
    setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        createBot();
    }, reconnectDelay);
}

// start keep-alive server if present
try {
    if (typeof keep_alive === 'function') {
        keep_alive();
    }
} catch (e) {}

// create initial bot
createBot();
