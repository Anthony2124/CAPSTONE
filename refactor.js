const fs = require('fs');
let code = fs.readFileSync('c:\\CAPS\\server.js', 'utf8');
const lines = code.split('\n');
const newLines = [
  ...lines.slice(0, 24),
  "const { readDB, writeDB } = require('./src/data/database');",
  "const { setWss, broadcast } = require('./src/utils/websocket');",
  "const { addActivity } = require('./src/services/activityService');",
  "",
  "// Initialize websocket service with our WSS instance",
  "setWss(wss);",
  "",
  "// ========== REST API ==========",
  "",
  "// --- Authentication Routes ---",
  "const authRoutes = require('./src/routes/authRoutes');",
  "app.use('/api/auth', authRoutes);",
  ...lines.slice(281)
];
fs.writeFileSync('c:\\CAPS\\server.js', newLines.join('\n'));
