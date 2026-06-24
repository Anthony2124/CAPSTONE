const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'database.json');

// Read database
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (error) {
    console.error("Error reading database.json, reverting to memory:", error);
    return { patients: [], admissions: [], lab_results: [], diet_profiles: [], medications: [], billing_ledger: [], reference_data: {}, activity_log: [] };
  }
}

// Write database
function writeDB(data) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error("Error writing database.json:", error);
  }
}

// Helper: Broadcast WebSocket message
function broadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// Helper: Add activity log
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
  db.activity_log.unshift(newLog);
  if (db.activity_log.length > 50) {
    db.activity_log = db.activity_log.slice(0, 50);
  }
  writeDB(db);
  broadcast('activity:log', newLog);
}

// ========== REST API ==========

// --- Patient Authentication ---

app.post('/api/auth/patient/register', (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  
  const { username, password, first_name, last_name } = req.body;
  if (!username || !password || !first_name || !last_name) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const existing = db.patient_accounts.find(u => u.username === username);
  if (existing) {
    return res.status(400).json({ error: 'Username already taken.' });
  }

  const newAccount = {
    id: Date.now(),
    username,
    password, // Storing plaintext for demo
    first_name,
    last_name,
    created_at: new Date().toISOString()
  };

  db.patient_accounts.push(newAccount);
  writeDB(db);

  addActivity('auth', `New patient account created: ${username}`, null, 'info');
  res.status(201).json({ message: 'Account created successfully', user: { username, first_name, last_name } });
});

app.post('/api/auth/patient/login', (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  
  const { username, password } = req.body;
  const user = db.patient_accounts.find(u => u.username === username && u.password === password);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  res.json({ message: 'Login successful', user: { username: user.username, first_name: user.first_name, last_name: user.last_name } });
});

app.post('/api/auth/patient/reset', (req, res) => {
  const db = readDB();
  db.patient_accounts = db.patient_accounts || [];
  
  const { username } = req.body;
  const user = db.patient_accounts.find(u => u.username === username);
  
  if (!user) {
    return res.status(404).json({ error: 'Username not found.' });
  }

  // Mock reset success
  addActivity('auth', `Password reset requested for patient: ${username}`, null, 'warning');
  res.json({ message: 'A password reset link has been sent to your registered contact.' });
});

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  const db = readDB();
  const admittedCount = db.admissions.filter(a => a.status === 'active').length;
  const totalBeds = db.wards.reduce((sum, w) => sum + w.beds, 0);
  const queueCount = db.patients.filter(p => p.queue_status === 'waiting' || p.queue_status === 'in_consultation').length;
  const criticalCount = db.lab_results.filter(l => {
    const admitted = db.admissions.find(a => a.patient_id === l.patient_id && a.status === 'active');
    return admitted && l.is_critical;
  }).length;
  
  res.json({
    total_patients: db.patients.length,
    admitted: admittedCount,
    in_queue: queueCount,
    critical_flags: criticalCount,
    beds_available: totalBeds - admittedCount,
    pending_discharges: db.billing_ledger.filter(b => b.status === 'active' && b.philhealth_deduction > 0).length
  });
});

// Get patients
app.get('/api/patients', (req, res) => {
  const db = readDB();
  res.json(db.patients);
});

// Get patient details (including labs, diet, medications, active admissions)
app.get('/api/patients/:id', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const admission = db.admissions.find(a => a.patient_id === patientId && a.status === 'active');
  const labs = db.lab_results.filter(l => l.patient_id === patientId);
  const diet = db.diet_profiles.find(d => d.patient_id === patientId);
  const medications = db.medications.filter(m => m.patient_id === patientId);
  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');

  res.json({
    patient,
    admission: admission || null,
    labs,
    diet: diet || null,
    medications,
    billing: billing || null
  });
});

// Get lobby triage queue
app.get('/api/queue', (req, res) => {
  const db = readDB();
  const queue = db.patients
    .filter(p => p.queue_status && p.queue_status !== 'not_queued')
    .sort((a, b) => new Date(a.queue_timestamp) - new Date(b.queue_timestamp));
  res.json(queue);
});

// Register patient in triage queue
app.post('/api/triage/register', (req, res) => {
  const db = readDB();
  const { first_name, last_name, age, gender, contact, municipality, reason_for_visit, appointment_date } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' });

  const patientId = db.patients.length > 0 ? Math.max(...db.patients.map(p => p.patient_id)) + 1 : 1;
  const tokenNumber = String(patientId).padStart(3, '0');
  const queueToken = `OPD-MED-${tokenNumber}`;

  const newPatient = {
    patient_id: patientId,
    first_name,
    last_name,
    age: parseInt(age) || 30,
    gender: gender || 'Male',
    contact: contact || '',
    municipality: municipality || 'Baler',
    reason_for_visit: reason_for_visit || 'General Consultation',
    appointment_date: appointment_date || new Date().toISOString().split('T')[0],
    queue_token: queueToken,
    queue_status: 'waiting',
    queue_timestamp: new Date().toISOString()
  };

  db.patients.push(newPatient);
  writeDB(db);

  // Calculate queue position (how many are waiting/in_consultation including this new one)
  const queuePosition = db.patients.filter(p => p.queue_status === 'waiting' || p.queue_status === 'in_consultation').length;

  addActivity('triage', `New patient registered: ${first_name} ${last_name} (${queueToken}) — ${reason_for_visit || 'General Consultation'}`, patientId, 'info');
  broadcast('queue:updated', newPatient);

  res.status(201).json({ ...newPatient, queue_position: queuePosition });
});

// Advance queue status (waiting -> in_consultation -> done)
app.post('/api/triage/advance/:id', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  let oldStatus = patient.queue_status;
  let newStatus = 'not_queued';

  if (oldStatus === 'waiting') {
    newStatus = 'in_consultation';
  } else if (oldStatus === 'in_consultation') {
    newStatus = 'done';
  } else if (oldStatus === 'done') {
    newStatus = 'not_queued';
  }

  patient.queue_status = newStatus;
  writeDB(db);

  addActivity('triage', `Patient ${patient.first_name} ${patient.last_name} advanced from ${oldStatus} to ${newStatus}.`, patientId, 'info');
  broadcast('queue:updated', patient);

  res.json(patient);
});


// Get laboratory results
app.get('/api/patients/:id/labs', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const labs = db.lab_results.filter(l => l.patient_id === patientId);
  res.json(labs);
});

// Save lab results & trigger automated checks
app.post('/api/patients/:id/labs', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const { fbs, creatinine, hemoglobin, wbc, platelets, bp_systolic, bp_diastolic } = req.body;
  
  const fbsVal = parseFloat(fbs);
  const creatVal = parseFloat(creatinine);
  
  const isCritical = fbsVal > 126 || creatVal > 1.2;

  const newLab = {
    id: Date.now(),
    patient_id: patientId,
    fbs: fbsVal,
    creatinine: creatVal,
    hemoglobin: parseFloat(hemoglobin) || 12.0,
    wbc: parseInt(wbc) || 7500,
    platelets: parseInt(platelets) || 200000,
    blood_pressure_systolic: parseInt(bp_systolic) || 120,
    blood_pressure_diastolic: parseInt(bp_diastolic) || 80,
    timestamp: new Date().toISOString(),
    is_critical: isCritical
  };

  db.lab_results.push(newLab);

  let dietOverride = null;
  // Trigger automated overrides
  let activeDiet = db.diet_profiles.find(d => d.patient_id === patientId);

  if (creatVal > 1.2) {
    const oldDiet = activeDiet ? activeDiet.diet_type : 'None';
    if (!activeDiet) {
      activeDiet = { id: Date.now(), patient_id: patientId, diet_type: 'Renal', is_locked: true, ter_kcal: 1800, carbs_g: 270, protein_g: 45, fat_g: 60, notes: '' };
      db.diet_profiles.push(activeDiet);
    } else {
      activeDiet.diet_type = 'Renal';
      activeDiet.is_locked = true;
      activeDiet.ter_kcal = 1800;
      activeDiet.carbs_g = 270;
      activeDiet.protein_g = 45;
      activeDiet.fat_g = 60;
    }
    activeDiet.notes = `Auto-locked: Creatinine (${creatVal} mg/dL) exceeds normal (>1.2). Assigned Renal Therapy.`;
    dietOverride = { old_diet: oldDiet, new_diet: 'Renal', reason: `Creatinine level of ${creatVal} mg/dL` };
  } else if (fbsVal > 126) {
    const oldDiet = activeDiet ? activeDiet.diet_type : 'None';
    if (!activeDiet) {
      activeDiet = { id: Date.now(), patient_id: patientId, diet_type: 'Diabetic', is_locked: true, ter_kcal: 2000, carbs_g: 250, protein_g: 100, fat_g: 66, notes: '' };
      db.diet_profiles.push(activeDiet);
    } else {
      activeDiet.diet_type = 'Diabetic';
      activeDiet.is_locked = true;
      activeDiet.ter_kcal = 2000;
      activeDiet.carbs_g = 250;
      activeDiet.protein_g = 100;
      activeDiet.fat_g = 66;
    }
    activeDiet.notes = `Auto-locked: FBS (${fbsVal} mg/dL) exceeds threshold (>126). Assigned Diabetic MNT.`;
    dietOverride = { old_diet: oldDiet, new_diet: 'Diabetic', reason: `Fasting Blood Sugar of ${fbsVal} mg/dL` };
  }

  writeDB(db);

  addActivity('lab', `Lab results uploaded for ${patient.first_name} ${patient.last_name}.${isCritical ? ' CRITICAL values found!' : ''}`, patientId, isCritical ? 'critical' : 'info');

  if (isCritical) {
    broadcast('lab:critical', { patient_id: patientId, message: `CRITICAL values for ${patient.first_name} ${patient.last_name}: FBS ${fbsVal}, Creatinine ${creatVal}.` });
  }

  if (dietOverride) {
    addActivity('diet', `DIET OVERRIDE TRIGGERED: Switched ${patient.first_name} ${patient.last_name} to ${dietOverride.new_diet} diet.`, patientId, 'warning');
    broadcast('diet:overridden', { patient_id: patientId, message: `System automatically locked ${patient.first_name} ${patient.last_name} to a therapeutic ${dietOverride.new_diet} diet.`, ...dietOverride });
  }

  res.status(201).json({
    lab_result: newLab,
    critical_flags: isCritical ? ['FBS', 'Creatinine'] : [],
    diet_override: dietOverride
  });
});

// Calculate medical nutrition therapy (TER)
app.post('/api/patients/:id/diet/calculate', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const { weight_kg, height_cm, age, gender, activity_factor } = req.body;
  const wt = parseFloat(weight_kg);
  const ht = parseFloat(height_cm);
  const ag = parseInt(age);
  const act = parseFloat(activity_factor) || 1.2;

  if (!wt || !ht || !ag) return res.status(400).json({ error: 'Weight, height, and age are required for calculation' });

  // Harris-Benedict Formula
  let bmr = 0;
  if (gender === 'Male') {
    bmr = 88.362 + (13.397 * wt) + (4.799 * ht) - (5.677 * ag);
  } else {
    bmr = 447.593 + (9.247 * wt) + (3.098 * ht) - (4.330 * ag);
  }

  const ter = Math.round(bmr * act);

  // Retrieve templates
  let currentProfile = db.diet_profiles.find(d => d.patient_id === patientId);
  const dietType = currentProfile ? currentProfile.diet_type : 'Standard';

  const template = db.reference_data.diet_templates.find(t => t.type === dietType) || db.reference_data.diet_templates[0];
  
  // Calculate macros
  const carbsG = Math.round((ter * (template.carbs_pct / 100)) / 4);
  const proteinG = Math.round((ter * (template.protein_pct / 100)) / 4);
  const fatG = Math.round((ter * (template.fat_pct / 100)) / 9);

  if (!currentProfile) {
    currentProfile = {
      id: Date.now(),
      patient_id: patientId,
      diet_type: dietType,
      is_locked: false,
      ter_kcal: ter,
      carbs_g: carbsG,
      protein_g: proteinG,
      fat_g: fatG,
      notes: `MNT parameters computed via Harris-Benedict (BMR: ${Math.round(bmr)} kcal, Activity Factor: ${act}).`
    };
    db.diet_profiles.push(currentProfile);
  } else {
    currentProfile.ter_kcal = ter;
    currentProfile.carbs_g = carbsG;
    currentProfile.protein_g = proteinG;
    currentProfile.fat_g = fatG;
    currentProfile.notes = `Recalculated parameters: BMR ${Math.round(bmr)} kcal. Act level: ${act}.`;
  }

  writeDB(db);
  addActivity('diet', `MNT values recalculated for ${patient.first_name} ${patient.last_name}: TER ${ter} kcal.`, patientId, 'info');

  res.json(currentProfile);
});

// Update diet profile manually
app.post('/api/patients/:id/diet', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const { diet_type } = req.body;

  const profile = db.diet_profiles.find(d => d.patient_id === patientId);
  if (profile && profile.is_locked) {
    return res.status(400).json({ error: 'This diet is auto-locked by critical diagnostic parameters.' });
  }

  const template = db.reference_data.diet_templates.find(t => t.type === diet_type);
  if (!template) return res.status(400).json({ error: 'Invalid diet template' });

  const ter = profile ? profile.ter_kcal : 2000;
  const carbsG = Math.round((ter * (template.carbs_pct / 100)) / 4);
  const proteinG = Math.round((ter * (template.protein_pct / 100)) / 4);
  const fatG = Math.round((ter * (template.fat_pct / 100)) / 9);

  if (!profile) {
    const newProfile = {
      id: Date.now(),
      patient_id: patientId,
      diet_type,
      is_locked: false,
      ter_kcal: ter,
      carbs_g: carbsG,
      protein_g: proteinG,
      fat_g: fatG,
      notes: 'Manually assigned diet.'
    };
    db.diet_profiles.push(newProfile);
  } else {
    profile.diet_type = diet_type;
    profile.carbs_g = carbsG;
    profile.protein_g = proteinG;
    profile.fat_g = fatG;
    profile.notes = 'Manually updated diet.';
  }

  writeDB(db);
  const patient = db.patients.find(p => p.patient_id === patientId);
  addActivity('diet', `Diet type updated to ${diet_type} for patient ${patient.first_name} ${patient.last_name}.`, patientId, 'info');
  broadcast('diet:overridden', { patient_id: patientId, message: `Diet updated to ${diet_type}` });

  res.json(profile || db.diet_profiles.find(d => d.patient_id === patientId));
});

// Add medication
app.post('/api/patients/:id/medications', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const { drug_name, dosage, frequency, route } = req.body;

  if (!drug_name) return res.status(400).json({ error: 'Drug name is required' });

  const newMed = {
    id: Date.now(),
    patient_id: patientId,
    drug_name,
    dosage: dosage || '',
    frequency: frequency || '',
    route: route || 'PO',
    prescribed_date: new Date().toISOString()
  };

  db.medications.push(newMed);
  writeDB(db);

  const patient = db.patients.find(p => p.patient_id === patientId);
  addActivity('ward', `Medication ${drug_name} prescribed to ${patient.first_name} ${patient.last_name}.`, patientId, 'info');

  // Trigger drug-nutrient warning check
  const activeDiet = db.diet_profiles.find(d => d.patient_id === patientId);
  const dietType = activeDiet ? activeDiet.diet_type : 'Standard';
  const conflict = db.reference_data.drug_nutrient_conflicts.find(c => c.drug.toLowerCase() === drug_name.toLowerCase() && c.conflict_diet === dietType);

  const warnings = [];
  if (conflict) {
    warnings.push(conflict);
    addActivity('alert', `DRUG-NUTRIENT CONFLICT: ${drug_name} conflicts with active ${dietType} diet for ${patient.first_name}.`, patientId, 'critical');
    broadcast('drug:warning', { patient_id: patientId, message: `Conflict detected: ${drug_name} + ${dietType} Diet. ${conflict.reason}`, conflict });
  }

  res.status(201).json({ medication: newMed, warnings });
});

// Run drug-nutrient check
app.get('/api/patients/:id/drug-check', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const medications = db.medications.filter(m => m.patient_id === patientId);
  const diet = db.diet_profiles.find(d => d.patient_id === patientId);
  const dietType = diet ? diet.diet_type : 'Standard';

  const warnings = [];
  medications.forEach(med => {
    const conflict = db.reference_data.drug_nutrient_conflicts.find(c => c.drug.toLowerCase() === med.drug_name.toLowerCase() && c.conflict_diet === dietType);
    if (conflict) {
      warnings.push({
        drug: med.drug_name,
        conflict_diet: dietType,
        reason: conflict.reason,
        recommendation: conflict.recommendation
      });
    }
  });

  res.json({ warnings });
});

// Get ward bed layouts
app.get('/api/wards', (req, res) => {
  const db = readDB();
  res.json(db.wards);
});

// Assign patient to bed
app.post('/api/wards/assign', (req, res) => {
  const db = readDB();
  const { patient_id, ward, bed } = req.body;
  const pId = parseInt(patient_id);
  const wardId = parseInt(ward);
  const bedNum = parseInt(bed);

  const patient = db.patients.find(p => p.patient_id === pId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  // Check if patient is already admitted
  const existingAdmission = db.admissions.find(a => a.patient_id === pId && a.status === 'active');
  if (existingAdmission) return res.status(400).json({ error: 'Patient is already admitted to bed ' + existingAdmission.bed_id });

  // Check if bed is occupied
  const bedId = `W${wardId}-B${String(bedNum).padStart(2, '0')}`;
  const isOccupied = db.admissions.some(a => a.bed_id === bedId && a.status === 'active');
  if (isOccupied) return res.status(400).json({ error: `Bed ${bedId} is already occupied` });

  const admission = {
    id: Date.now(),
    patient_id: pId,
    bed_id: bedId,
    ward: wardId,
    bed: bedNum,
    admission_date: new Date().toISOString(),
    status: 'active',
    diagnosis: 'Pending clinical assessment'
  };

  db.admissions.push(admission);

  // Initialize standard billing ledger if not existing
  let billing = db.billing_ledger.find(b => b.patient_id === pId && b.status === 'active');
  if (!billing) {
    billing = {
      id: Date.now(),
      patient_id: pId,
      items: [
        { category: 'Room', description: `Room Admission Ward ${wardId} Bed ${bedNum}`, amount: 1500 }
      ],
      base_total: 1500,
      philhealth_deduction: 0,
      statutory_discount: 0,
      net_total: 1500,
      icd10_code: '',
      status: 'active'
    };
    db.billing_ledger.push(billing);
  }

  // Initialize diet profile if not exists
  let diet = db.diet_profiles.find(d => d.patient_id === pId);
  if (!diet) {
    diet = {
      id: Date.now(),
      patient_id: pId,
      diet_type: 'Standard',
      is_locked: false,
      ter_kcal: 2000,
      carbs_g: 275,
      protein_g: 75,
      fat_g: 66,
      notes: 'Initial admission diet.'
    };
    db.diet_profiles.push(diet);
  }

  writeDB(db);

  addActivity('ward', `Admitted ${patient.first_name} ${patient.last_name} to Bed ${bedId}`, pId, 'info');
  broadcast('ward:updated', { admission, patient });

  res.status(201).json(admission);
});

// Discharge bed / checkout patient
app.post('/api/wards/discharge/:patientId', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.patientId);

  const admission = db.admissions.find(a => a.patient_id === patientId && a.status === 'active');
  if (!admission) return res.status(404).json({ error: 'Active admission not found' });

  // Check if billing is settled
  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  if (billing && billing.status === 'active') {
    // If not settled, discharge requires settling ledger first or will be closed by fast-track api
  }

  admission.status = 'discharged';
  writeDB(db);

  const patient = db.patients.find(p => p.patient_id === patientId);
  addActivity('ward', `Patient ${patient.first_name} ${patient.last_name} checked out from Bed ${admission.bed_id}`, patientId, 'info');
  broadcast('ward:updated', { admission });

  res.json({ message: 'Patient discharged successfully', admission });
});

// Get kitchen tray tickets
app.get('/api/kitchen/tickets', (req, res) => {
  const db = readDB();
  const activeAdmissions = db.admissions.filter(a => a.status === 'active');
  
  const hour = new Date().getHours();
  let mealPeriod = 'Breakfast';
  if (hour >= 11 && hour < 15) mealPeriod = 'Lunch';
  else if (hour >= 15) mealPeriod = 'Dinner';

  const tickets = activeAdmissions.map(adm => {
    const patient = db.patients.find(p => p.patient_id === adm.patient_id);
    const diet = db.diet_profiles.find(d => d.patient_id === adm.patient_id);
    const meds = db.medications.filter(m => m.patient_id === adm.patient_id);

    let warningNotes = '';
    // Look up active drug warnings
    meds.forEach(med => {
      const conflict = db.reference_data.drug_nutrient_conflicts.find(c => c.drug.toLowerCase() === med.drug_name.toLowerCase() && c.conflict_diet === (diet ? diet.diet_type : 'Standard'));
      if (conflict) {
        warningNotes += `[ALERT: ${med.drug_name} conflict! No high-K / high-potassium foods] `;
      }
    });

    return {
      patient_id: adm.patient_id,
      patient_name: `${patient.first_name} ${patient.last_name}`,
      ward: adm.ward,
      bed: adm.bed,
      bed_id: adm.bed_id,
      diet_type: diet ? diet.diet_type : 'Standard',
      meal_period: mealPeriod,
      special_notes: warningNotes || (diet && diet.is_locked ? 'Therapeutic Lock - Do Not Swap' : 'Regular Service')
    };
  });

  res.json(tickets);
});

// Get billing ledger
app.get('/api/billing/:id', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  if (!billing) return res.status(404).json({ error: 'Active billing ledger not found' });
  res.json(billing);
});

// Add ledger item
app.post('/api/billing/:id/add-item', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const { category, description, amount } = req.body;
  const amt = parseFloat(amount);

  if (!description || !amt) return res.status(400).json({ error: 'Description and amount are required' });

  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  if (!billing) return res.status(404).json({ error: 'Active billing ledger not found' });

  billing.items.push({
    category: category || 'General',
    description,
    amount: amt
  });

  // Recompute total
  billing.base_total = billing.items.reduce((sum, item) => sum + item.amount, 0);
  
  // Re-apply discounts if Philhealth exists
  const icd = db.reference_data.icd10_packages.find(pkg => pkg.code === billing.icd10_code);
  billing.philhealth_deduction = icd ? icd.case_rate : 0;
  
  const discountable = billing.base_total - billing.philhealth_deduction;
  const netBeforeDiscount = discountable > 0 ? discountable : 0;
  
  // Assume discount status is stored or re-evaluated from current setup
  const hasSeniorDiscount = billing.statutory_discount > 0;
  if (hasSeniorDiscount) {
    billing.statutory_discount = Math.round(netBeforeDiscount * 0.20);
  }
  
  billing.net_total = billing.base_total - billing.philhealth_deduction - billing.statutory_discount;
  if (billing.net_total < 0) billing.net_total = 0;

  writeDB(db);
  const patient = db.patients.find(p => p.patient_id === patientId);
  addActivity('billing', `Added ledger charge: ${description} (₱${amt}) to ${patient.first_name}'s bill.`, patientId, 'info');

  res.json(billing);
});

// Apply PhilHealth Case Rate & Statutory Discounts
app.post('/api/billing/:id/philhealth', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const { icd10_code, is_senior_pwd } = req.body;

  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  if (!billing) return res.status(404).json({ error: 'Active billing ledger not found' });

  const icd = db.reference_data.icd10_packages.find(pkg => pkg.code === icd10_code);
  if (!icd) return res.status(400).json({ error: 'Invalid ICD-10 Code' });

  billing.icd10_code = icd10_code;
  billing.philhealth_deduction = icd.case_rate;

  const remaining = billing.base_total - billing.philhealth_deduction;
  const taxable = remaining > 0 ? remaining : 0;

  if (is_senior_pwd) {
    billing.statutory_discount = Math.round(taxable * 0.20);
  } else {
    billing.statutory_discount = 0;
  }

  billing.net_total = billing.base_total - billing.philhealth_deduction - billing.statutory_discount;
  if (billing.net_total < 0) billing.net_total = 0;

  writeDB(db);

  const patient = db.patients.find(p => p.patient_id === patientId);
  addActivity('billing', `Applied PhilHealth case rate deduction: ${icd10_code} (₱${icd.case_rate}) for ${patient.first_name}.`, patientId, 'info');

  res.json({
    billing,
    case_rate_applied: icd.description,
    deduction: billing.philhealth_deduction,
    discount: billing.statutory_discount,
    net_total: billing.net_total
  });
});

// Fast-Track Discharge Settle
app.post('/api/billing/:id/discharge', (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);

  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  const admission = db.admissions.find(a => a.patient_id === patientId && a.status === 'active');
  const patient = db.patients.find(p => p.patient_id === patientId);

  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  if (billing) billing.status = 'settled';
  if (admission) admission.status = 'discharged';

  // Unlock diet
  const diet = db.diet_profiles.find(d => d.patient_id === patientId);
  if (diet) {
    diet.is_locked = false;
  }

  writeDB(db);

  addActivity('billing', `Discharge Cleared: ${patient.first_name} ${patient.last_name} billed & discharged.`, patientId, 'info');
  broadcast('ward:updated', { patient_id: patientId, status: 'discharged' });

  res.json({
    message: 'Discharge cleared and ledger archived.',
    patient_name: `${patient.first_name} ${patient.last_name}`,
    base_total: billing ? billing.base_total : 0,
    net_total: billing ? billing.net_total : 0,
    discharge_date: new Date().toISOString()
  });
});

// Reference data accessors
app.get('/api/reference/icd10', (req, res) => {
  const db = readDB();
  res.json(db.reference_data.icd10_packages);
});

app.get('/api/reference/diets', (req, res) => {
  const db = readDB();
  res.json(db.reference_data.diet_templates);
});

app.get('/api/reference/drug-conflicts', (req, res) => {
  const db = readDB();
  res.json(db.reference_data.drug_nutrient_conflicts);
});

// ========== WebSocket Events ==========
wss.on('connection', (ws) => {
  console.log('WS Client connected');
  
  // Send current stats & log immediately
  const db = readDB();
  ws.send(JSON.stringify({ event: 'connected', data: { log: db.activity_log } }));

  ws.on('close', () => console.log('WS Client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`D.I.E.T.S. Ecosystem running on http://localhost:${PORT}`));
