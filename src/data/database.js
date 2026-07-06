const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../../database.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (error) {
    console.error("Error reading database.json, reverting to memory:", error);
    return { patients: [], admissions: [], lab_results: [], diet_profiles: [], medications: [], billing_ledger: [], reference_data: {}, activity_log: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error("Error writing database.json:", error);
  }
}

module.exports = { readDB, writeDB, dbPath };
