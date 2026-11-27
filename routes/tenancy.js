const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// We connect to zudo-central for this route
const CENTRAL_DB_NAME = 'zudo-central';
let centralConn;

const getCentralConn = async () => {
  if (centralConn) return centralConn;
  const URI = process.env.MONGODB_URI;
  const lastSlashIndex = URI.lastIndexOf('/');
  const lastQuestionIndex = URI.indexOf('?', lastSlashIndex);
  const CENTRAL_URI = URI.substring(0, lastSlashIndex + 1) + CENTRAL_DB_NAME + (lastQuestionIndex !== -1 ? URI.substring(lastQuestionIndex) : '');
  centralConn = await mongoose.createConnection(CENTRAL_URI).asPromise();
  return centralConn;
};

// @route   GET /api/tenancy/find/:pincode
// @desc    Find database by pincode
router.get('/find/:pincode', async (req, res) => {
  try {
    const { pincode } = req.params;
    console.log(`Tenancy: Looking for pincode: ${pincode}`);
    const conn = await getCentralConn();
    const Mapping = conn.models['PincodeMapping'] || conn.model('PincodeMapping', new mongoose.Schema({
      pincode: String,
      dbName: String,
      city: String
    }, { collection: 'pincodemappings' }));

    const mapping = await Mapping.findOne({ pincode: pincode.trim() });
    if (!mapping) {
      console.log(`Tenancy: Pincode ${pincode} not found in central mapping.`);
      return res.status(404).json({ message: 'Location not served yet' });
    }

    console.log(`Tenancy: Found mapping for ${pincode}: ${mapping.city} (${mapping.dbName})`);
    res.json(mapping);
  } catch (error) {
    console.error('Tenancy Find Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/tenancy/locations
// @desc    Get all available active locations from zudo-central (for website selection)
router.get('/locations', async (req, res) => {
  try {
    const conn = await getCentralConn();
    const CentralLocation = conn.models['Location'] || conn.model('Location', require('../models/Location').schema);
    const activeLocs = await CentralLocation.find({ isActive: true }).lean();

    const locations = activeLocs.map(loc => {
      let cityClean = (loc.city || '').trim().toLowerCase().replace(/\s+/g, '-');
      while (cityClean.startsWith('zudo-')) {
        cityClean = cityClean.replace('zudo-', '');
      }
      return {
        _id: loc._id,
        city: loc.city,
        state: loc.state,
        pincode: loc.pincode,
        dbName: loc.name || `zudo-${cityClean}`
      };
    });

    console.log(`Tenancy: Returning ${locations.length} active locations.`);
    res.json(locations);
  } catch (error) {
    console.error('Tenancy Locations Error:', error);
    res.status(500).json({ message: error.message });
  }
});

const nodemailer = require('nodemailer');

// @route   POST /api/tenancy/report-unserved
// @desc    Report an unserved pincode and notify admin
router.post('/report-unserved', async (req, res) => {
  try {
    const { pincode, email, phone } = req.body;
    console.log(`Tenancy: Reporting unserved pincode: ${pincode}`);

    // Setup nodemailer (User should configure these in .env)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER || 'zudo.notifications@gmail.com',
        pass: process.env.EMAIL_PASS || 'your-app-password'
      }
    });

    const mailOptions = {
      from: 'Zudo Notifications',
      to: process.env.SUPER_ADMIN_EMAIL || 'superadmin@zudo.com',
      subject: '🚨 New Location Request: Unserved Pincode',
      html: `
        <h3>New Location Interest Detected</h3>
        <p>A user has requested Zudo services in an unserved area:</p>
        <ul>
          <li><strong>Pincode:</strong> ${pincode}</li>
          <li><strong>Contact Email:</strong> ${email || 'Not provided'}</li>
          <li><strong>Contact Phone:</strong> ${phone || 'Not provided'}</li>
        </ul>
        <p>Please consider adding this location to the service area.</p>
      `
    };

    // We don't await the email to avoid delaying the response, or we do if we want confirmation
    await transporter.sendMail(mailOptions);

    res.json({ message: 'Request reported successfully' });
  } catch (error) {
    console.error('Report Unserved Error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
