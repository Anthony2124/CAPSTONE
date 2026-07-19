require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// Email transporter configuration
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ========== Security Middleware ==========

// Security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts/styles for the SPA
}));

// CORS — restrict origins in production
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Request body size limit (prevents DoS via large payloads)
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting on authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                  // max 20 requests per window per IP
  message: { error: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const { readDB, writeDB } = require('./src/data/database');
const { setWss, broadcast } = require('./src/utils/websocket');
const { addActivity } = require('./src/services/activityService');
const exportController = require('./src/controllers/exportController');

// Initialize websocket service with our WSS instance
setWss(wss);

// ========== REST API ==========

// --- Authentication Routes (rate-limited) ---
const authRoutes = require('./src/routes/authRoutes');
app.use('/api/auth', authLimiter, authRoutes);

// Secure all other API routes
const { requireAuth, requireRole } = require('./src/utils/authMiddleware');
app.use('/api', requireAuth);

// Patient Portal — returns the logged-in patient's own medical records
app.get('/api/patient/my-records', (req, res) => {
  const db = readDB();
  const user = req.user; // from JWT: { id, email, role }

  if (!user || user.role !== 'patient') {
    return res.status(403).json({ error: 'Only patients can access this endpoint.' });
  }

  // Find the patient account to get first/last name
  db.patient_accounts = db.patient_accounts || [];
  const account = db.patient_accounts.find(a => a.email === user.email);
  if (!account) {
    return res.status(404).json({ error: 'Patient account not found.' });
  }

  // Match by first + last name (case-insensitive) against the hospital patients list
  const patient = db.patients.find(p =>
    p.first_name.toLowerCase() === account.first_name.toLowerCase() &&
    p.last_name.toLowerCase() === account.last_name.toLowerCase()
  );

  if (!patient) {
    return res.json({
      linked: false,
      message: 'No hospital record found for your account yet. Please register at the front desk or use the Appointment Form.',
      account: { first_name: account.first_name, last_name: account.last_name, email: account.email }
    });
  }

  // Gather all related records
  const admission = db.admissions.find(a => a.patient_id === patient.patient_id && a.status === 'active');
  const labs = db.lab_results.filter(l => l.patient_id === patient.patient_id).sort((a, b) => new Date(b.date) - new Date(a.date));
  const diet = db.diet_profiles.find(d => d.patient_id === patient.patient_id);
  const medications = db.medications.filter(m => m.patient_id === patient.patient_id);
  const billing = db.billing_ledger.find(b => b.patient_id === patient.patient_id && b.status === 'active');

  res.json({
    linked: true,
    patient,
    admission: admission || null,
    labs,
    diet: diet || null,
    medications,
    billing: billing || null
  });
});

// Get dashboard stats (staff only)
app.get('/api/stats', requireRole(['admin', 'nutritionist', 'nurse', 'billing', 'frontdesk']), (req, res) => {
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

// Get patients (staff only)
app.get('/api/patients', requireRole(['admin', 'nutritionist', 'nurse', 'billing', 'frontdesk']), (req, res) => {
  const db = readDB();
  res.json(db.patients);
});

// Get patient details (staff only)
app.get('/api/patients/:id', requireRole(['admin', 'nutritionist', 'nurse', 'billing', 'frontdesk']), (req, res) => {
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

// Get lobby triage queue (staff only)
app.get('/api/queue', requireRole(['admin', 'nurse', 'frontdesk']), (req, res) => {
  const db = readDB();
  const queue = db.patients
    .filter(p => p.queue_status && p.queue_status !== 'not_queued' && p.queue_status !== 'denied')
    .sort((a, b) => new Date(a.queue_timestamp) - new Date(b.queue_timestamp));
  res.json(queue);
});

// Register patient in triage queue (staff + patients)
app.post('/api/triage/register', requireRole(['admin', 'nurse', 'frontdesk', 'patient']), (req, res) => {
  const db = readDB();
  const { first_name, last_name, age, gender, contact, municipality, reason_for_visit, appointment_date } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' });

  // Prevent duplicate registration if already in the queue
  const existingPatientInQueue = db.patients.find(p => 
    p.first_name.toLowerCase() === first_name.toLowerCase() &&
    p.last_name.toLowerCase() === last_name.toLowerCase() &&
    p.queue_status && p.queue_status !== 'not_queued' && p.queue_status !== 'denied'
  );

  if (existingPatientInQueue) {
    return res.status(400).json({ error: 'Patient is already registered and currently in the queue.' });
  }

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
    queue_status: 'pending_approval',
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

// Advance queue status (staff only)
app.post('/api/triage/advance/:id', requireRole(['admin', 'nurse', 'frontdesk']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  let oldStatus = patient.queue_status;
  let newStatus = 'not_queued';

  if (oldStatus === 'pending_approval') {
    newStatus = 'waiting';
  } else if (oldStatus === 'waiting') {
    newStatus = 'in_consultation';
  } else if (oldStatus === 'in_consultation') {
    // Skip 'done' — instantly remove from queue
    newStatus = 'not_queued';
  }

  patient.queue_status = newStatus;
  writeDB(db);

  const logMessage = newStatus === 'not_queued' && oldStatus === 'in_consultation'
    ? `Patient ${patient.first_name} ${patient.last_name} consultation finished — removed from queue.`
    : `Patient ${patient.first_name} ${patient.last_name} advanced from ${oldStatus} to ${newStatus}.`;
  addActivity('triage', logMessage, patientId, 'info');
  broadcast('queue:updated', patient);

  res.json(patient);
});

// Remove patient from triage queue (staff only)
app.delete('/api/triage/remove/:id', requireRole(['admin', 'nurse', 'frontdesk']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  patient.queue_status = 'not_queued';
  writeDB(db);

  addActivity('triage', `Patient ${patient.first_name} ${patient.last_name} removed from queue.`, patientId, 'warning');
  broadcast('queue:updated', patient);

  res.json({ message: 'Patient removed from queue' });
});

// Approve patient in triage queue (staff only)
app.post('/api/triage/approve/:id', requireRole(['admin', 'nurse', 'frontdesk']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  if (patient.queue_status !== 'pending_approval') {
    return res.status(400).json({ error: 'Patient is not pending approval.' });
  }

  patient.queue_status = 'waiting';
  writeDB(db);

  addActivity('triage', `Patient ${patient.first_name} ${patient.last_name} APPROVED for queue. Reason: ${patient.reason_for_visit || 'General Consultation'}`, patientId, 'info');
  broadcast('queue:updated', patient);

  res.json(patient);
});

// Deny patient in triage queue (staff only)
app.post('/api/triage/deny/:id', requireRole(['admin', 'nurse', 'frontdesk']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  if (patient.queue_status !== 'pending_approval') {
    return res.status(400).json({ error: 'Patient is not pending approval.' });
  }

  patient.queue_status = 'denied';
  writeDB(db);

  addActivity('triage', `Patient ${patient.first_name} ${patient.last_name} DENIED from queue. Reason was: ${patient.reason_for_visit || 'General Consultation'}`, patientId, 'warning');
  broadcast('queue:updated', patient);

  res.json({ message: 'Patient denied from queue' });
});


// Get laboratory results (staff only)
app.get('/api/patients/:id/labs', requireRole(['admin', 'nutritionist', 'nurse']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const labs = db.lab_results.filter(l => l.patient_id === patientId);
  res.json(labs);
});

// Save lab results & trigger automated checks (clinical staff only)
app.post('/api/patients/:id/labs', requireRole(['admin', 'nurse']), (req, res) => {
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

// Calculate medical nutrition therapy (TER) (nutritionist/admin)
app.post('/api/patients/:id/diet/calculate', requireRole(['admin', 'nutritionist']), (req, res) => {
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

// Update diet profile manually (nutritionist/admin)
app.post('/api/patients/:id/diet', requireRole(['admin', 'nutritionist']), (req, res) => {
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

// Add medication (clinical staff only)
app.post('/api/patients/:id/medications', requireRole(['admin', 'nurse']), (req, res) => {
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

// Run drug-nutrient check (clinical staff)
app.get('/api/patients/:id/drug-check', requireRole(['admin', 'nutritionist', 'nurse']), (req, res) => {
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

// Get ward bed layouts (staff only)
app.get('/api/wards', requireRole(['admin', 'nurse', 'frontdesk', 'billing']), (req, res) => {
  const db = readDB();
  res.json(db.wards);
});

// Assign patient to bed (admin/nurse only)
app.post('/api/wards/assign', requireRole(['admin', 'nurse']), (req, res) => {
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

// Discharge bed / checkout patient (admin/nurse only)
app.post('/api/wards/discharge/:patientId', requireRole(['admin', 'nurse']), (req, res) => {
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

  // Also clear patient from the queue so they disappear instantly
  const patient = db.patients.find(p => p.patient_id === patientId);
  if (patient && patient.queue_status && patient.queue_status !== 'not_queued') {
    patient.queue_status = 'not_queued';
  }

  writeDB(db);

  addActivity('ward', `Patient ${patient.first_name} ${patient.last_name} discharged from Bed ${admission.bed_id} — removed from all queues.`, patientId, 'info');
  broadcast('ward:updated', { admission });
  broadcast('queue:updated', patient);

  res.json({ message: 'Patient discharged successfully', admission });
});

// Get kitchen tray tickets (nutrition/admin staff)
app.get('/api/kitchen/tickets', requireRole(['admin', 'nutritionist', 'nurse']), (req, res) => {
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

// Export Billing PDF (billing/admin only)
app.get('/api/billing/:id/export-pdf', requireRole(['admin', 'billing']), exportController.exportBillingPdf);

// Get billing ledger (billing/admin only)
app.get('/api/billing/:id', requireRole(['admin', 'billing']), (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');
  if (!billing) return res.status(404).json({ error: 'Active billing ledger not found' });
  res.json(billing);
});

// Add ledger item (billing/admin only)
app.post('/api/billing/:id/add-item', requireRole(['admin', 'billing']), (req, res) => {
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

// Apply PhilHealth Case Rate & Statutory Discounts (billing/admin only)
app.post('/api/billing/:id/philhealth', requireRole(['admin', 'billing']), (req, res) => {
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

// Fast-Track Discharge Settle (billing/admin only)
app.post('/api/billing/:id/discharge', requireRole(['admin', 'billing']), (req, res) => {
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

// ========== ANALYTICS API ==========

// Get condition/symptom analytics by municipality (staff only)
app.get('/api/analytics/conditions', requireRole(['admin', 'nutritionist', 'nurse']), (req, res) => {
  const db = readDB();

  // Define condition detection rules based on diagnosis text, diet, and lab data
  const conditionRules = [
    {
      name: 'Diabetes',
      color: '#f59e0b',
      detect: (patient, admission, diet, labs) => {
        if (admission && /diabet|dka|ketoacidosis/i.test(admission.diagnosis)) return true;
        if (diet && diet.diet_type === 'Diabetic') return true;
        if (labs.some(l => l.fbs > 126)) return true;
        return false;
      }
    },
    {
      name: 'Hypertension',
      color: '#ef4444',
      detect: (patient, admission, diet, labs) => {
        if (admission && /hypertens|htn/i.test(admission.diagnosis)) return true;
        if (labs.some(l => l.blood_pressure_systolic >= 140 || l.blood_pressure_diastolic >= 90)) return true;
        return false;
      }
    },
    {
      name: 'Chronic Kidney Disease',
      color: '#8b5cf6',
      detect: (patient, admission, diet, labs) => {
        if (admission && /ckd|kidney|renal/i.test(admission.diagnosis)) return true;
        if (diet && diet.diet_type === 'Renal') return true;
        if (labs.some(l => l.creatinine > 1.2)) return true;
        return false;
      }
    },
    {
      name: 'Heart Disease',
      color: '#ec4899',
      detect: (patient, admission, diet, labs) => {
        if (admission && /heart|cardiac|cardio/i.test(admission.diagnosis)) return true;
        if (diet && diet.diet_type === 'Cardiac') return true;
        return false;
      }
    },
    {
      name: 'Pneumonia',
      color: '#06b6d4',
      detect: (patient, admission, diet, labs) => {
        if (admission && /pneumonia|respiratory/i.test(admission.diagnosis)) return true;
        if (labs.some(l => l.wbc > 12000)) return true;
        return false;
      }
    },
    {
      name: 'Anemia',
      color: '#f97316',
      detect: (patient, admission, diet, labs) => {
        if (labs.some(l => l.hemoglobin < 10)) return true;
        return false;
      }
    },
    {
      name: 'Cancer',
      color: '#64748b',
      detect: (patient, admission, diet, labs) => {
        if (admission && /cancer|tumor|malignant|carcinoma|oncol/i.test(admission.diagnosis)) return true;
        return false;
      }
    },
    {
      name: 'Appendicitis',
      color: '#14b8a6',
      detect: (patient, admission, diet, labs) => {
        if (admission && /appendic/i.test(admission.diagnosis)) return true;
        return false;
      }
    },
    {
      name: 'Gastroenteritis',
      color: '#a3e635',
      detect: (patient, admission, diet, labs) => {
        if (admission && /gastro|diarr|vomit/i.test(admission.diagnosis)) return true;
        return false;
      }
    },
    {
      name: 'Asthma',
      color: '#3b82f6',
      detect: (patient, admission, diet, labs) => {
        if (admission && /asthma|bronch/i.test(admission.diagnosis)) return true;
        return false;
      }
    }
  ];

  // Get all municipalities
  const municipalities = [...new Set(db.patients.map(p => p.municipality).filter(Boolean))].sort();

  // For each patient, detect all conditions
  const patientConditions = db.patients.map(p => {
    const admissions = db.admissions.filter(a => a.patient_id === p.patient_id);
    const activeAdmission = admissions.find(a => a.status === 'active') || admissions[0] || null;
    const diet = db.diet_profiles.find(d => d.patient_id === p.patient_id) || null;
    const labs = db.lab_results.filter(l => l.patient_id === p.patient_id);

    const detected = [];
    conditionRules.forEach(rule => {
      if (rule.detect(p, activeAdmission, diet, labs)) {
        detected.push(rule.name);
      }
    });

    return {
      patient_id: p.patient_id,
      name: `${p.first_name} ${p.last_name}`,
      municipality: p.municipality || 'Unknown',
      age: p.age,
      gender: p.gender,
      conditions: detected
    };
  });

  // Build municipality breakdown
  const byMunicipality = {};
  municipalities.forEach(m => {
    const patientsInMunicipality = patientConditions.filter(pc => pc.municipality === m);
    const total = patientsInMunicipality.length;
    const conditionCounts = {};

    conditionRules.forEach(rule => {
      const count = patientsInMunicipality.filter(pc => pc.conditions.includes(rule.name)).length;
      conditionCounts[rule.name] = {
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0
      };
    });

    byMunicipality[m] = {
      total_patients: total,
      conditions: conditionCounts
    };
  });

  // Build overall totals
  const totalPatients = patientConditions.length;
  const overallConditions = {};
  conditionRules.forEach(rule => {
    const count = patientConditions.filter(pc => pc.conditions.includes(rule.name)).length;
    overallConditions[rule.name] = {
      count,
      percentage: totalPatients > 0 ? Math.round((count / totalPatients) * 100) : 0
    };
  });

  // Build condition-focused view (which municipalities have highest rate per condition)
  const conditionsByType = conditionRules.map(rule => {
    const municipalityBreakdown = municipalities.map(m => {
      const data = byMunicipality[m].conditions[rule.name];
      return {
        municipality: m,
        count: data.count,
        percentage: data.percentage,
        total_patients: byMunicipality[m].total_patients
      };
    }).filter(mb => mb.count > 0).sort((a, b) => b.percentage - a.percentage);

    return {
      condition: rule.name,
      color: rule.color,
      total_affected: overallConditions[rule.name].count,
      overall_percentage: overallConditions[rule.name].percentage,
      by_municipality: municipalityBreakdown
    };
  });

  res.json({
    municipalities,
    total_patients: totalPatients,
    condition_rules: conditionRules.map(r => ({ name: r.name, color: r.color })),
    by_municipality: byMunicipality,
    overall: overallConditions,
    conditions_detail: conditionsByType,
    patient_conditions: patientConditions
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

// ========== WebSocket Events (with JWT authentication) ==========
wss.on('connection', (ws, req) => {
  // Authenticate WebSocket connections via token query parameter
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      ws.user = decoded;
    }
  } catch (err) {
    // Allow unauthenticated connections but mark them — they get limited data
    ws.user = null;
  }

  console.log(`WS Client connected (${ws.user ? ws.user.role || ws.user.email : 'anonymous'})`);
  
  // Only send activity log to authenticated staff users
  if (ws.user && ws.user.role && ws.user.role !== 'patient') {
    const db = readDB();
    ws.send(JSON.stringify({ event: 'connected', data: { log: db.activity_log } }));
  } else {
    ws.send(JSON.stringify({ event: 'connected', data: { log: [] } }));
  }

  ws.on('close', () => console.log('WS Client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`D.I.E.T.S. Ecosystem running on http://localhost:${PORT}`));
