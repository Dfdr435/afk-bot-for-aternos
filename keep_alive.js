const express = require('express');
module.exports.keep_alive = function(port = 2323) {
  const app = express();
  app.get('/', (req, res) => res.send('Afk bot is running'));
  app.get('/health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));
  app.listen(port, () => console.log(`Afk bot keep-alive listening on http://localhost:${port}`));
}