document.addEventListener('alpine:init', () => {
  // Global fetch interceptor for JWT
  const originalFetch = window.fetch;
  window.fetch = async function() {
    let [resource, config] = arguments;
    if(typeof resource === 'string' && resource.startsWith('/api/')) {
      config = config || {};
      config.headers = config.headers || {};
      const token = localStorage.getItem('diets_token');
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return originalFetch(resource, config);
  };

  Alpine.data('dietsApp', () => ({
    // ===== STATE VARIABLES =====
    view: 'dashboard',
    loading: false,

    // ===== AUTH / LOGIN =====
    isLoggedIn: false,
    currentRole: null,
    currentUser: null,
    loginForm: {
      role: 'admin',
      username: '',
      password: ''
    },
    loginError: '',
    loginSuccess: '',
    loginShake: false,

    // ===== PATIENT AUTH MODES =====
    showRegisterModal: false,
    showForgotModal: false,
    showOtpModal: false,
    otpInput: '',
    pendingEmail: '',
    patientSignupForm: {
      email: '',
      password: '',
      confirm_password: '',
      first_name: '',
      last_name: ''
    },
    patientForgotForm: {
      email: ''
    },

    // Patient Portal Records
    myRecords: null,
    myRecordsLoading: false,

    // ===== PATIENT SELF-REGISTRATION (APPOINTMENT) =====
    patientRegForm: {
      first_name: '',
      last_name: '',
      age: '',
      gender: 'Male',
      contact: '',
      municipality: 'Baler',
      reason_for_visit: 'General Consultation',
      other_reason_for_visit: '',
      appointment_date: new Date().toISOString().split('T')[0]
    },

    // Hardcoded credentials per role
    credentials: {
      admin:        { password: 'admin123', username: 'admin',        label: 'Administrator',          displayName: 'Admin',           allowedViews: ['dashboard','triage','ehr','mnt','ward','billing', 'analytics'] },
      nutritionist: { password: 'nutri123', username: 'nutritionist', label: 'Nutritionist-Dietitian', displayName: 'Dr. Anthony N.', allowedViews: ['dashboard','ehr','mnt','ward'] },
      nurse:        { password: 'nurse123', username: 'nurse',        label: 'Nurse',                  displayName: 'Nurse Station',   allowedViews: ['dashboard','triage','ehr','ward'] },
      billing:      { password: 'bill123',  username: 'billing',      label: 'Billing Clerk',          displayName: 'Billing Dept.',   allowedViews: ['dashboard','billing'] },
      frontdesk:    { password: 'desk123',  username: 'frontdesk',    label: 'Front Desk Staff',       displayName: 'Front Desk',      allowedViews: ['triage'] },
      patient:      { label: 'Patient', allowedViews: ['patient_home', 'patient_records', 'register'] } // Handled via API
    },

    // ===== PRINT SLIP =====
    showPrintSlip: false,
    printSlipData: null,
    showTrayPrintSlip: false,
    trayPrintSlipData: null,

    // Time & Date Header
    currentTime: '',
    currentDate: '',

    // Stats Counter
    stats: {
      total_patients: 0,
      admitted: 0,
      in_queue: 0,
      critical_flags: 0,
      beds_available: 0,
      pending_discharges: 0
    },

    // Triage
    queue: [],
    triageForm: {
      first_name: '',
      last_name: '',
      age: '',
      gender: 'Male',
      contact: '',
      municipality: 'Baler'
    },

    // EHR & Patients
    patients: [],
    admissions: [],
    selectedPatient: null,
    patientDetail: null,
    labForm: {
      fbs: '',
      creatinine: '',
      hemoglobin: '12.0',
      wbc: '7500',
      platelets: '200000',
      bp_systolic: '120',
      bp_diastolic: '80'
    },
    patientSearch: '',

    // Diet & MNT
    dietProfiles: [],
    mntForm: {
      patient_id: '',
      weight_kg: '',
      height_cm: '',
      age: '',
      gender: 'Male',
      activity_factor: '1.2'
    },
    mntResult: null,
    dietTemplates: [],

    // Wards
    wards: [],
    selectedWard: 1,
    assignModal: {
      show: false,
      ward: 0,
      bed: 0,
      patient_id: ''
    },
    selectedBed: null,
    kitchenTickets: [],
    activeDrugWarnings: [],
    mealPeriod: 'Breakfast',

    // Billing & PhilHealth
    selectedBillingPatientId: null,
    billingDetail: null,
    philhealthForm: {
      icd10_code: '',
      is_senior_pwd: false
    },
    addItemForm: {
      category: 'Lab',
      description: '',
      amount: ''
    },
    icd10Packages: [],

    // Activity Log
    activityLog: [],

    // Alerts/Toasts
    toasts: [],
    ws: null,

    // Analytics
    chartInstances: {},
    conditionData: {},
    conditionFilter: 'all',

    // ===== INIT INTERFACES =====
    async init() {
      this.updateClock();
      setInterval(() => this.updateClock(), 1000);

      // Watch for view changes to render charts
      this.$watch('view', (newView) => {
        if (newView === 'analytics') {
          this.loadConditionData();
          setTimeout(() => this.renderAnalytics(), 100);
        }
      });

      // Don't load data until logged in
      // Data will be loaded after successful login
    },

    // ===== AUTH METHODS =====
    async attemptLogin() {
      this.loginError = '';
      this.loginSuccess = '';
      const role = this.loginForm.role;

      if (role === 'patient') {
        // Patient uses Backend API
        if (!this.loginForm.username || !this.loginForm.password) {
          this.loginError = 'Please enter both email and password.';
          this.triggerShake();
          return;
        }

        try {
          const res = await fetch('/api/auth/patient/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: this.loginForm.username, password: this.loginForm.password })
          });
          
          if (res.ok) {
            const data = await res.json();
            localStorage.setItem('diets_token', data.token);
            this.isLoggedIn = true;
            this.currentRole = role;
            this.currentUser = `${data.user.first_name} ${data.user.last_name}`;
            this.loginForm.password = '';
            
            // Patient view logic
            this.view = 'patient_records';
            this.connectWebSocket();
            this.loadAllData();
            this.loadMyRecords();
          } else {
            const errData = await res.json();
            this.loginError = errData.error || 'Login failed.';
            this.triggerShake();
          }
        } catch (err) {
          console.error(err);
          this.loginError = 'Connection error. Please try again.';
          this.triggerShake();
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/staff/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.loginForm.username, password: this.loginForm.password, role })
        });
        
        if (res.ok) {
          const data = await res.json();
          localStorage.setItem('diets_token', data.token);
          this.isLoggedIn = true;
          this.currentRole = role;
          this.currentUser = this.credentials[role].displayName;
          this.loginError = '';
          this.loginForm.password = '';
          
          const allowed = this.credentials[role].allowedViews;
          this.view = allowed[0] || 'dashboard';
          this.connectWebSocket();
          this.loadAllData();
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Login failed.';
          this.triggerShake();
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
        this.triggerShake();
      }
    },

    async attemptPatientRegister() {
      this.loginError = '';
      this.loginSuccess = '';
      const form = this.patientSignupForm;

      if (!form.email || !form.password || !form.first_name || !form.last_name) {
        this.loginError = 'All fields are required.';
        this.triggerShake();
        return;
      }
      if (form.password !== form.confirm_password) {
        this.loginError = 'Passwords do not match.';
        this.triggerShake();
        return;
      }

      try {
        const res = await fetch('/api/auth/patient/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form)
        });

        if (res.status === 202) {
          // Success, show OTP modal
          this.pendingEmail = form.email;
          this.showRegisterModal = false;
          this.showOtpModal = true;
          this.loginSuccess = 'OTP sent to your email. Please verify.';
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Registration failed.';
          this.triggerShake();
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
        this.triggerShake();
      }
    },

    async verifyOtp() {
      this.loginError = '';
      this.loginSuccess = '';
      
      if (!this.otpInput || this.otpInput.length !== 6) {
        this.loginError = 'Please enter a valid 6-digit OTP.';
        this.triggerShake();
        return;
      }

      try {
        const res = await fetch('/api/auth/patient/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.pendingEmail, otp: this.otpInput })
        });

        if (res.ok) {
          this.loginSuccess = 'Account verified and created! You can now log in.';
          this.patientSignupForm = { email: '', password: '', confirm_password: '', first_name: '', last_name: '' };
          this.otpInput = '';
          this.pendingEmail = '';
          this.showOtpModal = false;
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Verification failed.';
          this.triggerShake();
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
        this.triggerShake();
      }
    },

    async attemptPatientForgot() {
      this.loginError = '';
      this.loginSuccess = '';
      
      if (!this.patientForgotForm.email) {
        this.loginError = 'Please enter your email.';
        this.triggerShake();
        return;
      }

      try {
        const res = await fetch('/api/auth/patient/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.patientForgotForm)
        });

        if (res.ok) {
          const data = await res.json();
          this.loginSuccess = data.message;
          this.patientForgotForm.email = '';
          this.showForgotModal = false;
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Failed to request reset.';
          this.triggerShake();
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
        this.triggerShake();
      }
    },

    async attemptResendOtp() {
      this.loginError = '';
      this.loginSuccess = '';

      if (!this.pendingEmail) {
        this.loginError = 'No pending registration found.';
        this.triggerShake();
        return;
      }

      try {
        const res = await fetch('/api/auth/patient/resend-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.pendingEmail })
        });

        if (res.ok) {
          const data = await res.json();
          this.loginSuccess = data.message;
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Failed to resend OTP.';
          this.triggerShake();
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
        this.triggerShake();
      }
    },

    triggerShake() {
      this.loginShake = true;
      setTimeout(() => { this.loginShake = false; }, 600);
    },

    // Patient self-registration submit
    async submitPatientRegistration() {
      const form = { ...this.patientRegForm };

      if (form.reason_for_visit === 'Other') {
        if (!form.other_reason_for_visit || form.other_reason_for_visit.trim() === '') {
          this.loginError = 'Please specify your reason for visit.';
          this.triggerShake();
          return;
        }
        form.reason_for_visit = form.other_reason_for_visit.trim();
      }

      if (!form.first_name || !form.last_name) {
        this.loginError = 'Please fill in your first and last name.';
        this.loginShake = true;
        setTimeout(() => { this.loginShake = false; }, 600);
        return;
      }
      if (!form.age || parseInt(form.age) < 1) {
        this.loginError = 'Please enter a valid age.';
        this.loginShake = true;
        setTimeout(() => { this.loginShake = false; }, 600);
        return;
      }

      try {
        const res = await fetch('/api/triage/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form)
        });
        if (res.ok) {
          const data = await res.json();

          // Populate the enhanced print slip data
          this.printSlipData = {
            patient_name: `${data.first_name} ${data.last_name}`,
            age: data.age,
            gender: data.gender,
            municipality: data.municipality,
            contact: data.contact || 'N/A',
            reason_for_visit: data.reason_for_visit || 'General Consultation',
            appointment_date: data.appointment_date || new Date().toISOString().split('T')[0],
            queue_token: data.queue_token,
            queue_position: data.queue_position || '—',
            registered_at: new Date().toLocaleString('en-PH', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit'
            })
          };
          this.showPrintSlip = true;

          // Reset the registration form
          this.patientRegForm = {
            first_name: '',
            last_name: '',
            age: '',
            gender: 'Male',
            contact: '',
            municipality: 'Baler',
            reason_for_visit: 'General Consultation',
            other_reason_for_visit: '',
            appointment_date: new Date().toISOString().split('T')[0]
          };
        } else {
          const errData = await res.json();
          this.loginError = errData.error || 'Registration failed. Please try again.';
          // Show a toast notification for the error
          this.addToast('Registration Failed', errData.error || 'Registration failed.', 'critical');
        }
      } catch (err) {
        console.error(err);
        this.loginError = 'Connection error. Please try again.';
      }
    },

    backToLogin() {
      this.signOut();
    },

    signOut() {
      this.isLoggedIn = false;
      this.currentRole = null;
      this.currentUser = null;
      this.view = 'dashboard';
      this.loginForm.password = '';
      this.loginError = '';
      this.loginSuccess = '';
      this.showRegisterModal = false;
      this.showForgotModal = false;
      this.showOtpModal = false;
      this.otpInput = '';
      this.pendingEmail = '';

      // Close WS
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      // Reset data
      this.patients = [];
      this.queue = [];
      this.activityLog = [];
      this.dietProfiles = [];
      this.wards = [];
      this.kitchenTickets = [];
      this.wardData = {};
      this.selectedPatient = null;
      this.patientDetail = null;
      this.billingDetail = null;
    },

    isViewAllowed(viewName) {
      if (!this.currentRole) return false;
      const cred = this.credentials[this.currentRole];
      return cred ? cred.allowedViews.includes(viewName) : false;
    },

    get roleLabel() {
      if (!this.currentRole) return '';
      const cred = this.credentials[this.currentRole];
      return cred ? cred.label : '';
    },

    // Clock Tick
    updateClock() {
      const now = new Date();
      this.currentTime = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.currentDate = now.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      
      const hour = now.getHours();
      if (hour >= 5 && hour < 11) this.mealPeriod = 'Breakfast';
      else if (hour >= 11 && hour < 15) this.mealPeriod = 'Lunch';
      else this.mealPeriod = 'Dinner';
    },

    // WS Connection
    connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        this.handleWSEvent(payload.event, payload.data);
      };

      this.ws.onclose = () => {
        console.warn("WebSocket closed. Attempting reconnect...");
        setTimeout(() => this.connectWebSocket(), 3000);
      };
    },

    // WS Broadcast handlers
    handleWSEvent(event, data) {
      console.log("WS received:", event, data);
      
      switch (event) {
        case 'connected':
          if (data && data.log) {
            this.activityLog = data.log;
          }
          break;
        case 'activity:log':
          this.activityLog.unshift(data);
          if (this.activityLog.length > 50) this.activityLog.pop();
          this.loadDashboardStats();
          break;
        case 'queue:updated':
          this.loadQueue();
          this.loadPatients();
          this.loadDashboardStats();
          break;
        case 'lab:critical':
          this.addToast('CRITICAL LAB RESULT', data.message || 'Exceeded biological thresholds.', 'critical');
          this.loadDashboardStats();
          this.loadPatients();
          this.loadMyRecords();
          if (this.selectedPatient && this.selectedPatient.patient_id === data.patient_id) {
            this.selectPatient(data.patient_id);
          }
          break;
        case 'diet:overridden':
          this.addToast('AUTOMATED DIET LOCK', data.message || 'Diet overridden by automated checks.', 'warning');
          this.loadDietProfiles();
          this.loadPatients();
          this.loadMyRecords();
          if (this.selectedPatient && this.selectedPatient.patient_id === data.patient_id) {
            this.selectPatient(data.patient_id);
          }
          break;
        case 'ward:updated':
          this.loadWards();
          this.loadKitchenTickets();
          this.loadPatients();
          this.loadDashboardStats();
          this.loadDietProfiles();
          this.loadDrugWarnings();
          this.loadMyRecords();
          if (this.selectedBillingPatientId) {
            this.selectBillingPatient(this.selectedBillingPatientId);
          }
          if (this.selectedPatient) {
            this.selectPatient(this.selectedPatient.patient_id);
          }
          break;
        case 'drug:warning':
          this.addToast('DRUG-NUTRIENT CONFLICT', data.message || 'Safety check triggered warning.', 'critical');
          this.loadDrugWarnings();
          this.loadKitchenTickets();
          break;
      }
    },

    // ===== CORE DATA LOADING =====
    async loadAllData() {
      this.loading = true;
      try {
        await Promise.all([
          this.loadDashboardStats(),
          this.loadPatients(),
          this.loadQueue(),
          this.loadDietProfiles(),
          this.loadWards(),
          this.loadKitchenTickets(),
          this.loadReferenceData()
        ]);
        await this.loadDrugWarnings();
      } catch (err) {
        console.error("Error loading data:", err);
      } finally {
        this.loading = false;
      }
    },

    async loadDashboardStats() {
      const res = await fetch('/api/stats');
      if (res.ok) this.stats = await res.json();
    },

    // Patient Portal: load this patient's own medical records
    async loadMyRecords() {
      if (this.currentRole !== 'patient') return;
      this.myRecordsLoading = true;
      try {
        const res = await fetch('/api/patient/my-records');
        if (res.ok) {
          this.myRecords = await res.json();
        } else {
          this.myRecords = null;
        }
      } catch (err) {
        console.error('Failed to load patient records:', err);
        this.myRecords = null;
      } finally {
        this.myRecordsLoading = false;
      }
    },

    async loadPatients() {
      const res = await fetch('/api/patients');
      if (res.ok) this.patients = await res.json();
    },

    async loadQueue() {
      const res = await fetch('/api/queue');
      if (res.ok) this.queue = await res.json();
    },

    async loadDietProfiles() {
      const res = await fetch('/api/patients'); // use base patient info matching or profile list
      // In server, diet profiles are loaded per patient. Let's get active profiles.
      // We will loop admitted patients and gather profiles:
      const dbRes = await fetch('/api/wards'); // just call custom loop or patients
      if (res.ok) {
        const patients = await res.json();
        const activeProfiles = [];
        for (let p of patients) {
          const detailRes = await fetch(`/api/patients/${p.patient_id}`);
          if (detailRes.ok) {
            const detail = await detailRes.json();
            if (detail.diet) {
              activeProfiles.push(detail.diet);
            }
          }
        }
        this.dietProfiles = activeProfiles;
      }
    },

    async loadWards() {
      const res = await fetch('/api/wards');
      if (res.ok) {
        this.wards = await res.json();
        // Resolve actual admissions per bed mapping
        const admissionsRes = await fetch('/api/patients'); // lets get details
        const patients = await admissionsRes.json();
        const admissionsMap = {};
        for (let p of patients) {
          const detRes = await fetch(`/api/patients/${p.patient_id}`);
          if (detRes.ok) {
            const det = await detRes.json();
            if (det.admission) {
              admissionsMap[det.admission.bed_id] = {
                admission: det.admission,
                patient: det.patient,
                diet: det.diet,
                labs: det.labs
              };
            }
          }
        }
        this.wardData = admissionsMap;
      }
    },

    async loadKitchenTickets() {
      const res = await fetch('/api/kitchen/tickets');
      if (res.ok) this.kitchenTickets = await res.json();
    },

    async loadReferenceData() {
      const icdRes = await fetch('/api/reference/icd10');
      if (icdRes.ok) this.icd10Packages = await icdRes.json();

      const templatesRes = await fetch('/api/reference/diets');
      if (templatesRes.ok) this.dietTemplates = await templatesRes.json();
    },

    async loadDrugWarnings() {
      const warnings = [];
      for (let p of this.admittedPatients) {
        const checkRes = await fetch(`/api/patients/${p.patient_id}/drug-check`);
        if (checkRes.ok) {
          const data = await checkRes.json();
          if (data.warnings && data.warnings.length > 0) {
            data.warnings.forEach(warn => {
              warnings.push({
                id: Date.now() + Math.random(),
                patient_name: `${p.first_name} ${p.last_name}`,
                drug: warn.drug,
                reason: warn.reason,
                recommendation: warn.recommendation
              });
            });
          }
        }
      }
      this.activeDrugWarnings = warnings;
    },

    // ===== INTERACTIVE HELPERS =====

    // Filter directory
    get filteredPatients() {
      if (!this.patientSearch) return this.patients;
      const term = this.patientSearch.toLowerCase();
      return this.patients.filter(p => 
        p.first_name.toLowerCase().includes(term) || 
        p.last_name.toLowerCase().includes(term) ||
        p.queue_token.toLowerCase().includes(term)
      );
    },

    // Get admitted patients list
    get admittedPatients() {
      // Find patients with active admissions
      return this.patients.filter(p => 
        this.wardData && Object.values(this.wardData).some(w => w.patient.patient_id === p.patient_id && w.admission.status === 'active')
      );
    },

    // Get outpatients (available for bed assignment)
    get outpatients() {
      return this.patients.filter(p => 
        !Object.values(this.wardData).some(w => w.patient.patient_id === p.patient_id && w.admission.status === 'active')
      );
    },

    getPatientName(id) {
      const p = this.patients.find(pt => pt.patient_id === id);
      return p ? `${p.first_name} ${p.last_name}` : 'Unknown';
    },

    getAdmissionBed(patientId) {
      const adm = Object.values(this.wardData).find(w => w.patient.patient_id === patientId);
      return adm ? adm.admission.bed_id : 'Outpatient';
    },

    getLedgerTotal(patientId) {
      // Return ledger total for patient
      const p = this.patients.find(pt => pt.patient_id === patientId);
      // Let's resolve the detail
      const billing = this.wardData ? Object.values(this.wardData).find(w => w.patient.patient_id === patientId) : null;
      // We will look up from a local cache or load. Let's make a call or fallback.
      // Wait, let's keep totals resolved from the actual billingLedger backend entries.
      // If we don't have it cached, we will fetch in background.
      return billing && billing.billing ? billing.billing.base_total : 0;
    },

    // Select Patient for EHR Detail
    async selectPatient(id) {
      this.loading = true;
      try {
        const res = await fetch(`/api/patients/${id}`);
        if (res.ok) {
          const detail = await res.json();
          this.selectedPatient = detail.patient;
          this.patientDetail = detail;

          // Set calculator form default values
          this.mntForm.patient_id = id;
          this.mntForm.weight_kg = '';
          this.mntForm.height_cm = '';
          this.mntForm.age = detail.patient.age;
          this.mntForm.gender = detail.patient.gender;

          // Setup initial lab values placeholder
          this.labForm.fbs = '';
          this.labForm.creatinine = '';
        }
      } catch (err) {
        console.error("Error selecting patient:", err);
      } finally {
        this.loading = false;
      }
    },

    // ===== SUBMIT FORMS API HANDLERS =====

    // Register Triage Queue
    async submitTriageForm() {
      try {
        const res = await fetch('/api/triage/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.triageForm)
        });
        if (res.ok) {
          const data = await res.json();
          this.addToast('Queue Token Issued', 'Added patient to triage lobby queue board.', 'info');

          // Populate print slip data
          this.printSlipData = {
            patient_name: `${data.first_name} ${data.last_name}`,
            age: data.age,
            gender: data.gender,
            municipality: data.municipality,
            contact: data.contact || 'N/A',
            queue_token: data.queue_token,
            queue_position: data.queue_position || '—',
            registered_at: new Date().toLocaleString('en-PH', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit'
            })
          };
          this.showPrintSlip = true;

          this.triageForm = { first_name: '', last_name: '', age: '', gender: 'Male', contact: '', municipality: 'Baler' };

          // Immediately refresh queue monitor so new patient appears sorted
          await this.loadQueue();
          await this.loadPatients();
          await this.loadDashboardStats();
        } else {
          const errData = await res.json();
          this.addToast('Registration Failed', errData.error || 'Failed to register patient.', 'critical');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Advance Triage queue status
    async advanceQueue(patientId) {
      try {
        const res = await fetch(`/api/triage/advance/${patientId}`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          if (data.queue_status === 'not_queued') {
            this.addToast('Patient Removed', 'Consultation finished — patient removed from queue.', 'info');
          } else {
            this.addToast('Queue Advanced', 'Outpatient flow updated.', 'info');
          }
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Remove from Triage queue
    async removeFromQueue(patientId) {
      if (!confirm('Are you sure you want to remove this patient from the queue?')) return;
      try {
        const res = await fetch(`/api/triage/remove/${patientId}`, { method: 'DELETE' });
        if (res.ok) {
          this.addToast('Queue Updated', 'Patient removed from queue.', 'warning');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Approve patient in triage queue
    async approveQueue(patientId) {
      try {
        const res = await fetch(`/api/triage/approve/${patientId}`, { method: 'POST' });
        if (res.ok) {
          this.addToast('Patient Approved', 'Patient has been approved and added to the active queue.', 'info');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Deny patient in triage queue
    async denyQueue(patientId) {
      if (!confirm('Are you sure you want to deny this patient?')) return;
      try {
        const res = await fetch(`/api/triage/deny/${patientId}`, { method: 'POST' });
        if (res.ok) {
          this.addToast('Patient Denied', 'Patient has been denied from the queue.', 'warning');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Submit Lab Result
    async submitLabForm() {
      if (!this.selectedPatient) return;
      try {
        const res = await fetch(`/api/patients/${this.selectedPatient.patient_id}/labs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.labForm)
        });
        if (res.ok) {
          this.addToast('Diagnostics Saved', 'Lab values processed against override metrics.', 'info');
          // Reload detail view
          await this.selectPatient(this.selectedPatient.patient_id);
          await this.loadAllData();
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Run Harris-Benedict Solver
    async calculateTER() {
      if (!this.mntForm.patient_id) return;
      try {
        const res = await fetch(`/api/patients/${this.mntForm.patient_id}/diet/calculate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.mntForm)
        });
        if (res.ok) {
          const detail = await res.json();
          // Find templates percent
          const template = this.dietTemplates.find(t => t.type === detail.diet_type) || this.dietTemplates[0];
          
          this.mntResult = {
            ter_kcal: detail.ter_kcal,
            bmr: Math.round(detail.ter_kcal / parseFloat(this.mntForm.activity_factor)),
            carbs_g: detail.carbs_g,
            protein_g: detail.protein_g,
            fat_g: detail.fat_g,
            carbs_pct: template.carbs_pct,
            protein_pct: template.protein_pct,
            fat_pct: template.fat_pct
          };
          this.addToast('Nutrition Calculations Complete', 'Macro profiles updated.', 'info');
          await this.loadDietProfiles();
          if (this.selectedPatient && this.selectedPatient.patient_id === parseInt(this.mntForm.patient_id)) {
            await this.selectPatient(this.selectedPatient.patient_id);
          }
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Manual diet overrides update
    async updateDietType(patientId, newDiet) {
      try {
        const res = await fetch(`/api/patients/${patientId}/diet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ diet_type: newDiet })
        });
        if (res.ok) {
          this.addToast('Diet Overridden', `Patient meal plan switched to ${newDiet}.`, 'info');
          await this.loadAllData();
          if (this.selectedPatient && this.selectedPatient.patient_id === patientId) {
            await this.selectPatient(patientId);
          }
        } else {
          const errData = await res.json();
          this.addToast('Override Blocked', errData.error, 'critical');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // ===== WARD INTERACTIVE CONTROLS =====

    getBedClass(ward, bed) {
      const bedId = `W${ward}-B${String(bed).padStart(2, '0')}`;
      const occupancy = this.wardData[bedId];
      if (!occupancy) return 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/60';
      
      const criticalCheck = occupancy.labs.some(l => l.is_critical);
      if (criticalCheck) return 'border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20';
      return 'border-indigo-500/30 bg-indigo-500/5 hover:bg-indigo-500/10';
    },

    getBedIndicatorClass(ward, bed) {
      const bedId = `W${ward}-B${String(bed).padStart(2, '0')}`;
      const occupancy = this.wardData[bedId];
      if (!occupancy) return 'bg-emerald-500';
      const criticalCheck = occupancy.labs.some(l => l.is_critical);
      if (criticalCheck) return 'bg-rose-500 animate-pulse';
      return 'bg-indigo-500';
    },

    getBedOccupant(ward, bed) {
      const bedId = `W${ward}-B${String(bed).padStart(2, '0')}`;
      return this.wardData[bedId] || null;
    },

    getBedOccupantName(ward, bed) {
      const occ = this.getBedOccupant(ward, bed);
      return occ ? `${occ.patient.first_name} ${occ.patient.last_name}` : 'Vacant';
    },

    getBedOccupantDiet(ward, bed) {
      const occ = this.getBedOccupant(ward, bed);
      return occ && occ.diet ? `${occ.diet.diet_type} Diet` : 'Available';
    },

    handleBedClick(ward, bed) {
      const occ = this.getBedOccupant(ward, bed);
      if (occ) {
        this.selectedBed = {
          bed_id: occ.admission.bed_id,
          patient_id: occ.patient.patient_id,
          patient_name: `${occ.patient.first_name} ${occ.patient.last_name}`,
          admission_date: occ.admission.admission_date,
          diagnosis: occ.admission.diagnosis,
          diet_type: occ.diet ? occ.diet.diet_type : 'Standard',
          is_locked: occ.diet ? occ.diet.is_locked : false
        };
      } else {
        this.assignModal.ward = ward;
        this.assignModal.bed = bed;
        this.assignModal.patient_id = '';
        this.assignModal.show = true;
      }
    },

    // Confirm Ward Assignment
    async submitAssignBed() {
      try {
        const res = await fetch('/api/wards/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: this.assignModal.patient_id,
            ward: this.assignModal.ward,
            bed: this.assignModal.bed
          })
        });
        if (res.ok) {
          this.addToast('Patient Admitted', 'Allocated ward bed and initialized diet ledger.', 'info');
          this.assignModal.show = false;
        } else {
          const err = await res.json();
          this.addToast('Admission Failed', err.error, 'critical');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Vacate bed / Discharge patient
    async dischargeBed(patientId) {
      try {
        const res = await fetch(`/api/wards/discharge/${patientId}`, { method: 'POST' });
        if (res.ok) {
          this.addToast('Bed Vacated', 'Patient checked out from Ward Grid.', 'info');
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Prescribe medication
    async prescribeMedication(patientId, formData) {
      try {
        const res = await fetch(`/api/patients/${patientId}/medications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        if (res.ok) {
          this.addToast('Prescription Logged', 'Medications added to patient profile.', 'info');
          await this.loadAllData();
          if (this.selectedPatient && this.selectedPatient.patient_id === patientId) {
            await this.selectPatient(patientId);
          }
        }
      } catch (err) {
        console.error(err);
      }
    },

    // Print tray ticket action
    printTrayTicket(ticket) {
      this.trayPrintSlipData = ticket;
      this.showTrayPrintSlip = true;
    },

    // ===== BILLING & PHILHEALTH DEDUCTIBLES =====

    async selectBillingPatient(id) {
      this.selectedBillingPatientId = id;
      try {
        const res = await fetch(`/api/billing/${id}`);
        if (res.ok) {
          this.billingDetail = await res.json();
          // Pre-populate dropdown
          this.philhealthForm.icd10_code = this.billingDetail.icd10_code || '';
          this.philhealthForm.is_senior_pwd = this.billingDetail.statutory_discount > 0;
        } else {
          this.billingDetail = null;
        }
      } catch (err) {
        console.error(err);
      }
    },

    getPatientFullName(patientId) {
      const p = this.patients.find(pt => pt.patient_id === patientId);
      return p ? `${p.first_name} ${p.last_name}` : 'Billing Account';
    },

    async addBillingItem() {
      if (!this.selectedBillingPatientId) return;
      try {
        const res = await fetch(`/api/billing/${this.selectedBillingPatientId}/add-item`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.addItemForm)
        });
        if (res.ok) {
          this.addToast('Charge Added', 'Ledger balances updated.', 'info');
          this.addItemForm = { category: 'Lab', description: '', amount: '' };
          await this.selectBillingPatient(this.selectedBillingPatientId);
        }
      } catch (err) {
        console.error(err);
      }
    },

    async applyPhilHealth() {
      if (!this.selectedBillingPatientId) return;
      try {
        const res = await fetch(`/api/billing/${this.selectedBillingPatientId}/philhealth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.philhealthForm)
        });
        if (res.ok) {
          this.addToast('Deduction Matrix Processed', 'PhilHealth deduction applied to account.', 'info');
          await this.selectBillingPatient(this.selectedBillingPatientId);
        }
      } catch (err) {
        console.error(err);
      }
    },

    async fastTrackDischarge() {
      if (!this.selectedBillingPatientId) return;
      if (!confirm('Are you sure you want to fast-track checkout? This settles the account and discharges the patient.')) return;
      
      try {
        const res = await fetch(`/api/billing/${this.selectedBillingPatientId}/discharge`, { method: 'POST' });
        if (res.ok) {
          this.addToast('Clearance Checked', 'Account settled and bed vacated.', 'info');
          this.selectedBillingPatientId = null;
          this.billingDetail = null;
          await this.loadAllData();
        }
      } catch (err) {
        console.error(err);
      }
    },

    async downloadBillingPdf() {
      if (!this.selectedBillingPatientId) return;
      try {
        const res = await fetch(`/api/billing/${this.selectedBillingPatientId}/export-pdf`);
        if (res.ok) {
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `Billing_Statement_${this.selectedBillingPatientId}.pdf`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          a.remove();
          this.addToast('PDF Generated', 'Billing statement downloaded.', 'info');
        } else {
          const errData = await res.json();
          this.addToast('Export Failed', errData.error || 'Could not generate PDF.', 'critical');
        }
      } catch (err) {
        console.error(err);
        this.addToast('Export Failed', 'Connection error.', 'critical');
      }
    },

    // ===== ANALYTICS & REPORTING =====

    async loadConditionData() {
      try {
        const res = await fetch('/api/analytics/conditions');
        if (res.ok) {
          this.conditionData = await res.json();
          setTimeout(() => this.renderConditionChart(), 150);
        }
      } catch (err) {
        console.error('Failed to load condition analytics:', err);
      }
    },

    getConditionDisplayCount(conditionName) {
      if (this.conditionFilter === 'all') {
        return this.conditionData.overall?.[conditionName]?.count || 0;
      }
      return this.conditionData.by_municipality?.[this.conditionFilter]?.conditions?.[conditionName]?.count || 0;
    },

    getConditionDisplayPct(conditionName) {
      if (this.conditionFilter === 'all') {
        return this.conditionData.overall?.[conditionName]?.percentage || 0;
      }
      return this.conditionData.by_municipality?.[this.conditionFilter]?.conditions?.[conditionName]?.percentage || 0;
    },

    renderConditionChart() {
      if (typeof Chart === 'undefined') return;
      const ctx = document.getElementById('conditionBarChart');
      if (!ctx) return;

      const rules = this.conditionData.condition_rules || [];
      const labels = [];
      const data = [];
      const colors = [];

      rules.forEach(rule => {
        let count = 0;
        let pct = 0;
        if (this.conditionFilter === 'all') {
          count = this.conditionData.overall?.[rule.name]?.count || 0;
          pct = this.conditionData.overall?.[rule.name]?.percentage || 0;
        } else {
          count = this.conditionData.by_municipality?.[this.conditionFilter]?.conditions?.[rule.name]?.count || 0;
          pct = this.conditionData.by_municipality?.[this.conditionFilter]?.conditions?.[rule.name]?.percentage || 0;
        }
        labels.push(rule.name);
        data.push(pct);
        colors.push(rule.color);
      });

      if (this.chartInstances.conditions) this.chartInstances.conditions.destroy();
      this.chartInstances.conditions = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'Prevalence %',
            data,
            backgroundColor: colors.map(c => c + '66'),
            borderColor: colors,
            borderWidth: 1.5,
            borderRadius: 6,
            barPercentage: 0.7
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const ruleName = labels[context.dataIndex];
                  let count = 0;
                  if (this.conditionFilter === 'all') {
                    count = this.conditionData.overall?.[ruleName]?.count || 0;
                  } else {
                    count = this.conditionData.by_municipality?.[this.conditionFilter]?.conditions?.[ruleName]?.count || 0;
                  }
                  return `${context.raw}% (${count} patients)`;
                }
              }
            }
          },
          scales: {
            x: {
              max: 100,
              grid: { color: 'rgba(255,255,255,0.03)' },
              ticks: {
                callback: (v) => v + '%',
                color: '#94a3b8'
              }
            },
            y: {
              grid: { display: false },
              ticks: { color: '#e2e8f0', font: { weight: '600', size: 11 } }
            }
          }
        }
      });
    },

    renderAnalytics() {
      if (typeof Chart === 'undefined') return;

      // Ensure canvas elements exist
      const demogCtx = document.getElementById('demographicsChart');
      const statusCtx = document.getElementById('statusChart');
      const wardCtx = document.getElementById('wardOccupancyChart');
      
      if (!demogCtx || !statusCtx || !wardCtx) return;

      // Common chart options for dark theme
      Chart.defaults.color = '#94a3b8';
      Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';
      Chart.defaults.font.family = "'Outfit', sans-serif";

      // 1. Demographics Chart Data
      const ageGroups = { '0-18': 0, '19-35': 0, '36-60': 0, '60+': 0 };
      const genders = { 'Male': 0, 'Female': 0, 'Other': 0 };
      
      this.patients.forEach(p => {
        const age = parseInt(p.age) || 0;
        if (age <= 18) ageGroups['0-18']++;
        else if (age <= 35) ageGroups['19-35']++;
        else if (age <= 60) ageGroups['36-60']++;
        else ageGroups['60+']++;
        
        if (p.gender === 'Male') genders['Male']++;
        else if (p.gender === 'Female') genders['Female']++;
        else genders['Other']++;
      });

      if (this.chartInstances.demog) this.chartInstances.demog.destroy();
      this.chartInstances.demog = new Chart(demogCtx, {
        type: 'bar',
        data: {
          labels: Object.keys(ageGroups),
          datasets: [{
            label: 'Patients by Age',
            data: Object.values(ageGroups),
            backgroundColor: 'rgba(20, 184, 166, 0.5)',
            borderColor: 'rgba(20, 184, 166, 1)',
            borderWidth: 1,
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }
        }
      });

      // 2. Admission Status Data
      const admittedCount = this.stats.admitted || 0;
      const outpatientCount = (this.stats.total_patients || 0) - admittedCount;

      if (this.chartInstances.status) this.chartInstances.status.destroy();
      this.chartInstances.status = new Chart(statusCtx, {
        type: 'doughnut',
        data: {
          labels: ['Admitted', 'Outpatient'],
          datasets: [{
            data: [admittedCount, outpatientCount],
            backgroundColor: [
              'rgba(99, 102, 241, 0.8)', // Indigo
              'rgba(148, 163, 184, 0.2)' // Slate
            ],
            borderWidth: 0,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: { legend: { position: 'bottom' } }
        }
      });

      // 3. Ward Occupancy Data
      const activeBeds = this.stats.admitted || 0;
      const emptyBeds = this.stats.beds_available || 40;

      if (this.chartInstances.ward) this.chartInstances.ward.destroy();
      this.chartInstances.ward = new Chart(wardCtx, {
        type: 'pie',
        data: {
          labels: ['Occupied Beds', 'Available Beds'],
          datasets: [{
            data: [activeBeds, emptyBeds],
            backgroundColor: [
              'rgba(244, 63, 94, 0.8)', // Rose
              'rgba(16, 185, 129, 0.8)' // Emerald
            ],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } }
        }
      });
    },

    // ===== PRINT SLIP UTILITIES =====
    printSlip() {
      window.print();
    },

    closePrintSlip() {
      this.showPrintSlip = false;
      this.printSlipData = null;
    },

    closeTrayPrintSlip() {
      this.showTrayPrintSlip = false;
      this.trayPrintSlipData = null;
    },

    // ===== ALERTS/TOAST UTILITIES =====
    addToast(title, message, type = 'info') {
      const id = Date.now();
      this.toasts.unshift({ id, title, message, type });
      if (this.toasts.length > 5) this.toasts.pop();
      setTimeout(() => {
        this.toasts = this.toasts.filter(t => t.id !== id);
      }, 5000);
    }
  }));
});
