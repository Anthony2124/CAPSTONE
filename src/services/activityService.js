const { readDB, writeDB } = require('../data/database');
const { broadcast } = require('../utils/websocket');

function addActivity(type, message, patientId = null, severity = 'info') {
  const db = readDB();
  const newLog = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    type,
    message,
    patient_id: patientId ? parseInt(patientId) : null,
    severity
  };
  db.activity_log = db.activity_log || [];
  db.activity_log.unshift(newLog);
  if (db.activity_log.length > 50) {
    db.activity_log = db.activity_log.slice(0, 50);
  }
  writeDB(db);
  broadcast('activity:log', newLog);
}

module.exports = { addActivity };
