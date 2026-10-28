const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const mongoose = require('mongoose');

const getModels = (req) => req.models || {
  Commission: require('../models/Commission'),
  Category: require('../models/Category')
};

// @route   GET /api/commissions
// @desc    Get all commissions
router.get('/', protect, async (req, res) => {
  try {
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const commissions = await aggregateGET('Commission', req);
      return res.json(commissions);
    }
    const { Commission } = getModels(req);
    const commissions = await Commission.find();
    res.json(commissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// @route   GET /api/commissions/category/:categoryId
// @desc    Get commissions for a specific category
router.get('/category/:categoryId', protect, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { Commission } = getModels(req);
    const comms = await Commission.find({ categoryId });
    res.json(comms);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/commissions/category/:categoryId
// @desc    Bulk save commissions for a category
router.put('/category/:categoryId', protect, async (req, res) => {
  const { categoryId } = req.params;
  const { commissions } = req.body; // Array of { unit, commissionType, commissionValue }
  
  // Filter unique rules to prevent unique index violation
  const rulesToInsert = [];
  if (commissions && commissions.length > 0) {
    const seen = new Set();
    for (const comm of commissions) {
      const unit = comm.unit;
      const pincode = comm.pincode || 'All';
      const key = `${unit.toLowerCase()}-${pincode.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        rulesToInsert.push({
          categoryId,
          unit,
          commissionType: comm.commissionType,
          commissionValue: comm.commissionValue,
          pincode
        });
      }
    }
  }

  try {
    if (!req.locationId) {
      // Global Access - Update commissions across all active tenant databases
      const centralConn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
      const CentralLocation = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      const locations = await CentralLocation.find({ isActive: true }).lean();
      await centralConn.close();

      for (const loc of locations) {
        try {
          const { connectDBByLocation } = require('../utils/db_manager');
          const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
          const dbName = `zudo-${cityClean}`;
          const connection = await connectDBByLocation(loc._id.toString(), dbName);
          
          const Commission = connection.models.Commission || connection.model('Commission', require('../models/Commission').schema);
          
          // 1. Delete all existing rules for this category
          await Commission.deleteMany({ categoryId });

          // 2. Insert new ones
          if (rulesToInsert.length > 0) {
            await Commission.insertMany(rulesToInsert);
          }
        } catch (err) {
          console.error(`Failed to update commissions for ${loc.city}:`, err.message);
        }
      }
      try {
        const { applyCommissionToAllProducts } = require('./products');
        await applyCommissionToAllProducts(req);
      } catch (err) {}
      return res.json({ message: 'Commissions updated successfully across all branches.' });
    } else {
      const { Commission } = getModels(req);
      
      // 1. Delete all existing rules for this category to overwrite
      await Commission.deleteMany({ categoryId });

      // 2. Insert new ones
      if (rulesToInsert.length > 0) {
        await Commission.insertMany(rulesToInsert);
      }

      try {
        const { applyCommissionToAllProducts } = require('./products');
        await applyCommissionToAllProducts(req);
      } catch (err) {}
      const updated = await Commission.find({ categoryId });
      res.json(updated);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/commissions/minimum-billing
// @desc    Get minimum billing amount config (Admin)
router.get('/minimum-billing', protect, async (req, res) => {
  try {
    if (!req.locationId) {
      // Global Access - Aggregate from all active tenant databases!
      const centralConn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
      const CentralLocation = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      const locations = await CentralLocation.find({ isActive: true }).lean();
      await centralConn.close();

      const results = [];
      for (const loc of locations) {
        try {
          const { connectDBByLocation } = require('../utils/db_manager');
          const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
          const dbName = `zudo-${cityClean}`;
          const connection = await connectDBByLocation(loc._id.toString(), dbName);
          const settingB2B = await connection.db.collection('settings').findOne({ key: 'minimumBillAmountB2B' });
          const settingB2C = await connection.db.collection('settings').findOne({ key: 'minimumBillAmountB2C' });
          const settingOld = await connection.db.collection('settings').findOne({ key: 'minimumBillAmount' });
          results.push({
            locationId: loc._id,
            city: loc.city,
            minimumBillAmountB2B: settingB2B ? settingB2B.value : (settingOld ? settingOld.value : 0),
            minimumBillAmountB2C: settingB2C ? settingB2C.value : (settingOld ? settingOld.value : 0)
          });
        } catch (err) {
          console.error(`Failed to get minimum billing for ${loc.city}:`, err.message);
        }
      }
      res.json({ isGlobal: true, data: results });
    } else {
      const db = req.db || mongoose.connection;
      const settingB2B = await db.collection('settings').findOne({ key: 'minimumBillAmountB2B' });
      const settingB2C = await db.collection('settings').findOne({ key: 'minimumBillAmountB2C' });
      const settingOld = await db.collection('settings').findOne({ key: 'minimumBillAmount' });
      res.json({
        isGlobal: false,
        minimumBillAmountB2B: settingB2B ? settingB2B.value : (settingOld ? settingOld.value : 0),
        minimumBillAmountB2C: settingB2C ? settingB2C.value : (settingOld ? settingOld.value : 0)
      });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/commissions/minimum-billing
// @desc    Update minimum billing amount config (Admin)
router.put('/minimum-billing', protect, async (req, res) => {
  try {
    const { minimumBillAmountB2B, minimumBillAmountB2C, targetLocationId } = req.body;
    const valueB2B = parseFloat(minimumBillAmountB2B);
    const valueB2C = parseFloat(minimumBillAmountB2C);
    
    if (isNaN(valueB2B) || valueB2B < 0 || isNaN(valueB2C) || valueB2C < 0) {
      return res.status(400).json({ message: 'Invalid minimum billing amounts' });
    }

    if (!req.locationId) {
      // Global Access edit. If targetLocationId is passed, update that specific location.
      // Otherwise, update all locations!
      const centralConn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
      const CentralLocation = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      const locations = await CentralLocation.find({ isActive: true }).lean();
      await centralConn.close();

      const targetLocs = targetLocationId 
        ? locations.filter(l => l._id.toString() === targetLocationId)
        : locations;

      for (const loc of targetLocs) {
        try {
          const { connectDBByLocation } = require('../utils/db_manager');
          const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
          const dbName = `zudo-${cityClean}`;
          const connection = await connectDBByLocation(loc._id.toString(), dbName);
          await connection.db.collection('settings').updateOne(
            { key: 'minimumBillAmountB2B' },
            { $set: { value: valueB2B } },
            { upsert: true }
          );
          await connection.db.collection('settings').updateOne(
            { key: 'minimumBillAmountB2C' },
            { $set: { value: valueB2C } },
            { upsert: true }
          );
        } catch (err) {
          console.error(`Failed to update minimum billing for ${loc.city}:`, err.message);
        }
      }
      res.json({ message: 'Minimum billing amount updated successfully' });
    } else {
      const db = req.db || mongoose.connection;
      await db.collection('settings').updateOne(
        { key: 'minimumBillAmountB2B' },
        { $set: { value: valueB2B } },
        { upsert: true }
      );
      await db.collection('settings').updateOne(
        { key: 'minimumBillAmountB2C' },
        { $set: { value: valueB2C } },
        { upsert: true }
      );
      res.json({ message: 'Minimum billing amount updated successfully', minimumBillAmountB2B: valueB2B, minimumBillAmountB2C: valueB2C });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/commissions/public/minimum-billing
// @desc    Get minimum billing amounts (Public for apps)
router.get('/public/minimum-billing', async (req, res) => {
  try {
    const db = req.db || mongoose.connection;
    const settingB2B = await db.collection('settings').findOne({ key: 'minimumBillAmountB2B' });
    const settingB2C = await db.collection('settings').findOne({ key: 'minimumBillAmountB2C' });
    const settingOld = await db.collection('settings').findOne({ key: 'minimumBillAmount' });

    res.json({
      minimumBillAmountB2B: settingB2B ? settingB2B.value : (settingOld ? settingOld.value : 0),
      minimumBillAmountB2C: settingB2C ? settingB2C.value : (settingOld ? settingOld.value : 0)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
