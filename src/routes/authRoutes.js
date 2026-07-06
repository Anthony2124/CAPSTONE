const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/patient/register', authController.register);
router.post('/patient/resend-otp', authController.resendOtp);
router.post('/patient/verify-otp', authController.verifyOtp);
router.post('/patient/login', authController.login);
router.post('/patient/reset', authController.reset);
router.post('/staff/login', authController.staffLogin);

module.exports = router;
