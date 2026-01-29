# AFK Bot for Aternos (enhanced)

This repo contains an AFK bot for Minecraft (mineflayer) enhanced with:
- persistent registration state (so /register runs only once)
- configurable register/login templates
- confirmation of register/login via server chat before persisting
- improved reconnect/backoff with jitter
- graceful shutdown and logging to logs/bot.log
- health endpoint at /health (keep_alive.js)
- Dockerfile and .env.example for deployment

Configuration is stored in config.json or via environment variables (.env using dotenv). See .env.example.
