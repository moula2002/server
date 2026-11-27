const express = require('express');
const router = express.Router();
const CashCollector = require('../models/CashCollector');
const { protect } = require('../middleware/auth');
const { connectDBByLocation } = require('../utils/db_manager');
const { aggregateGET } = require('../utils/aggregator');

const isAdminRequest = (req) => {
  return !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales', 'b2b_admin', 'b2c_admin', 'cash_admin'].includes(req.user?.role);
};

const requireAdmin = (req, res, next) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '403 Forbidden: Admin authorization required' });
  }
  next();
};

/**
 * Helper to locate model and document across tenant connections or central DB
 */
const findModelAndDoc = async (id, req) => {
  // 1. If tenant context exists on request
  if (req.locationId && req.models?.CashCollector) {
    const doc = await req.models.CashCollector.findById(id);
    if (doc) return { Model: req.models.CashCollector, doc };
  }

  // 2. If target location is provided in body, query, or headers
  const targetLoc = req.body?.locationId || req.query?.locationId || req.headers['x-target-location'];
  if (targetLoc) {
    try {
      const conn = await connectDBByLocation(targetLoc);
      const Model = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
      const doc = await Model.findById(id);
      if (doc) return { Model, doc };
    } catch (e) {
      console.warn(`[Cash] Failed to query targetLoc ${targetLoc}:`, e.message);
    }
  }

  // 3. Search default/central model
  const CentralModel = req.models?.CashCollector || CashCollector;
  try {
    const doc = await CentralModel.findById(id);
    if (doc) return { Model: CentralModel, doc };
  } catch (e) {
    // continue
  }

  // 4. Search across active tenant databases (Global Super Admin mode)
  try {
    const LocationModel = CentralModel.db.models.Location || CentralModel.db.model('Location', require('../models/Location').schema);
    const locations = await LocationModel.find({ isActive: true }).lean();
    for (const loc of locations) {
      try {
        const conn = await connectDBByLocation(loc._id.toString());
        const Model = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
        const doc = await Model.findById(id);
        if (doc) {
          return { Model, doc, location: loc };
        }
      } catch (e) {
        // continue
      }
    }
  } catch (err) {
    console.error('[Cash] Error searching across tenant DBs:', err.message);
  }

  return { Model: null, doc: null };
};

// @route   GET api/cash
// @desc    Get all cash transactions (Supports Global Aggregation and Single-Tenant)
// @access  Private (Admin)
router.get('/', protect, requireAdmin, async (req, res) => {
  try {
    if (!req.locationId) {
      const transactions = await aggregateGET('CashCollector', req, {}, ['driverId'], '', { date: -1, createdAt: -1 });
      return res.json(transactions);
    }

    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const transactions = await CashCollectorModel.find()
      .populate('driverId', 'name phone wallet')
      .sort({ date: -1, createdAt: -1 })
      .lean();

    // Enrich single-tenant transactions with location metadata if not present
    const enriched = transactions.map(t => ({
      ...t,
      locationId: t.locationId || req.locationId,
      locationName: t.locationName || req.dbName || req.locationId
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching cash logs:', err.message);
    res.status(500).json({ message: 'Server Error fetching cash collection logs' });
  }
});

// @route   POST api/cash
// @desc    Record a new cash transaction / collection
// @access  Private (Admin)
router.post('/', protect, requireAdmin, async (req, res) => {
  const { 
    type, 
    name, 
    phone, 
    email, 
    password, 
    amount, 
    description, 
    paymentMethod,
    otp,
    driverId,
    orderId,
    status,
    verification,
    date,
    locationId,
    settledBy
  } = req.body;

  const numericAmount = Number(amount);
  if (amount !== undefined && (isNaN(numericAmount) || numericAmount < 0)) {
    return res.status(400).json({ message: 'Invalid amount: must be a non-negative number' });
  }

  try {
    let CashCollectorModel = req.models?.CashCollector;
    const targetLocationId = req.locationId || locationId || req.headers['x-target-location'];

    if (!req.locationId && targetLocationId) {
      try {
        const conn = await connectDBByLocation(targetLocationId);
        CashCollectorModel = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
      } catch (connErr) {
        console.warn('[Cash] Failed switching to target location DB:', connErr.message);
      }
    }

    if (!CashCollectorModel) {
      CashCollectorModel = CashCollector;
    }

    const newTransaction = new CashCollectorModel({
      type: type || 'B2C',
      name: name || 'Cash Collection',
      phone: phone || '',
      email,
      password,
      amount: amount !== undefined ? Number(amount) : 0,
      description: description || '',
      paymentMethod: paymentMethod || 'Cash',
      otp: otp ? String(otp) : undefined,
      driverId: driverId || undefined,
      orderId: orderId || undefined,
      status: status || 'Settled',
      verification: verification || (otp ? `OTP: ${otp}` : (password ? 'Password Verified' : 'Manual Entry')),
      settledBy: settledBy || (req.user?.name || req.user?.email || 'Admin'),
      date: date ? new Date(date) : new Date()
    });

    let transaction;
    try {
      transaction = await newTransaction.save();
    } catch (saveErr) {
      if (saveErr.code === 11000 && saveErr.message.includes('phone_1')) {
        console.log('Dropping legacy phone_1 unique index from cashcollectors...');
        await CashCollectorModel.collection.dropIndex('phone_1').catch(e => console.log('Error dropping index:', e.message));
        transaction = await newTransaction.save();
      } else {
        throw saveErr;
      }
    }

    // Populate driver info if available
    let responseObj = transaction.toObject();
    if (driverId) {
      try {
        const DriverModel = CashCollectorModel.db.models.Driver || CashCollectorModel.db.model('Driver', require('../models/Driver').schema);
        const driverDoc = await DriverModel.findById(driverId).select('name phone wallet').lean();
        if (driverDoc) responseObj.driverId = driverDoc;
      } catch (e) {
        // continue
      }
    }

    if (targetLocationId) {
      responseObj.locationId = targetLocationId;
    }

    res.status(201).json(responseObj);
  } catch (err) {
    console.error('Error logging cash transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

// @route   PUT api/cash/:id
// @desc    Update a cash transaction
// @access  Private (Admin)
router.put('/:id', protect, requireAdmin, async (req, res) => {
  const { 
    type, 
    name, 
    phone, 
    email, 
    password, 
    amount, 
    description, 
    paymentMethod,
    otp,
    driverId,
    orderId,
    status,
    verification,
    date,
    settledBy
  } = req.body;

  try {
    const { Model, doc: transaction } = await findModelAndDoc(req.params.id, req);
    if (!transaction) {
      return res.status(404).json({ message: 'Cash transaction not found' });
    }

    if (type) transaction.type = type;
    if (name) transaction.name = name;
    if (phone !== undefined) transaction.phone = phone;
    if (email !== undefined) transaction.email = email;
    if (password) transaction.password = password;
    if (amount !== undefined) transaction.amount = Number(amount);
    if (description !== undefined) transaction.description = description;
    if (paymentMethod) transaction.paymentMethod = paymentMethod;
    if (otp !== undefined) transaction.otp = String(otp);
    if (driverId !== undefined) transaction.driverId = driverId;
    if (orderId !== undefined) transaction.orderId = orderId;
    if (status !== undefined) transaction.status = status;
    if (verification !== undefined) transaction.verification = verification;
    if (settledBy !== undefined) transaction.settledBy = settledBy;
    if (date) transaction.date = new Date(date);

    const updated = await transaction.save();
    res.json(updated);
  } catch (err) {
    console.error('Error updating cash transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

// @route   DELETE api/cash/:id
// @desc    Delete a cash transaction
// @access  Private (Admin)
router.delete('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const { Model, doc: transaction } = await findModelAndDoc(req.params.id, req);
    if (!transaction) {
      return res.status(404).json({ message: 'Cash transaction not found' });
    }

    await Model.findByIdAndDelete(req.params.id);
    res.json({ message: 'Transaction removed successfully' });
  } catch (err) {
    console.error('Error deleting cash transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
