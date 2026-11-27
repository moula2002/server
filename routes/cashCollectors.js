const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const CashCollector = require('../models/CashCollector');
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');
const { connectDBByLocation } = require('../utils/db_manager');
const { aggregateGET } = require('../utils/aggregator');

/**
 * Helper to resolve CashCollector model for the target tenant or default DB
 */
const resolveCollectorModel = async (req, explicitLocationId = null) => {
  const targetLocationId = req.locationId || explicitLocationId || req.body?.locationId || req.query?.locationId || req.headers['x-target-location'];
  if (!req.locationId && targetLocationId) {
    const conn = await connectDBByLocation(targetLocationId);
    return {
      Model: conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema),
      conn,
      locationId: targetLocationId
    };
  }
  return {
    Model: req.models?.CashCollector || CashCollector,
    conn: req.db,
    locationId: req.locationId || null
  };
};

/**
 * Helper to locate a CashCollector document across tenant DBs or central DB
 */
const findCollectorAcrossTenants = async (id, req) => {
  if (req.locationId && req.models?.CashCollector) {
    const doc = await req.models.CashCollector.findById(id);
    if (doc) return { Model: req.models.CashCollector, doc };
  }

  const targetLoc = req.body?.locationId || req.query?.locationId || req.headers['x-target-location'];
  if (targetLoc) {
    try {
      const conn = await connectDBByLocation(targetLoc);
      const Model = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
      const doc = await Model.findById(id);
      if (doc) return { Model, doc };
    } catch (e) {
      // continue
    }
  }

  const CentralModel = req.models?.CashCollector || CashCollector;
  try {
    const doc = await CentralModel.findById(id);
    if (doc) return { Model: CentralModel, doc };
  } catch (e) {
    // continue
  }

  try {
    const LocationModel = CentralModel.db.models.Location || CentralModel.db.model('Location', require('../models/Location').schema);
    const locations = await LocationModel.find({ isActive: true }).lean();
    for (const loc of locations) {
      try {
        const conn = await connectDBByLocation(loc._id.toString());
        const Model = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
        const doc = await Model.findById(id);
        if (doc) return { Model, doc, location: loc };
      } catch (e) {
        // continue
      }
    }
  } catch (err) {
    console.error('[CashCollector] Error searching across tenant DBs:', err.message);
  }

  return { Model: null, doc: null };
};

// @route   POST /api/cashcollectors/login
// @desc    Authenticate cash collector and return JWT token (supports email or phone + multi-tenant)
// @access  Public
router.post('/login', async (req, res) => {
  const { email, phone, password, locationId } = req.body;
  try {
    if ((!email && !phone) || !password) {
      return res.status(400).json({ message: 'Email/phone and password are required' });
    }

    const query = email
      ? { email: new RegExp(`^\\s*${email.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }
      : { phone: phone.trim() };

    const AdminSchema = require('../models/Admin').schema;
    let collector = null;
    let resolvedLocId = req.locationId || locationId || null;
    let resolvedDbName = req.dbName || null;

    // 1. Try current tenant/default model (CashCollector, then Admin with role cash_collector)
    const { Model: PrimaryModel, conn: primaryConn, locationId: primaryLoc } = await resolveCollectorModel(req, locationId);
    collector = await PrimaryModel.findOne(query);
    if (!collector) {
      const PrimaryAdminModel = (primaryConn?.models?.Admin) || (primaryConn ? primaryConn.model('Admin', AdminSchema) : require('../models/Admin'));
      collector = await PrimaryAdminModel.findOne({ ...query, role: 'cash_collector' });
    }
    if (collector && primaryLoc) resolvedLocId = primaryLoc;

    // 2. Fallback: search across active tenant DBs if not found and no explicit location was set
    if (!collector && !req.locationId && !locationId) {
      try {
        const { connectDBByLocation } = require('../utils/db_manager');
        const URI = process.env.MONGODB_URI;
        const lastSlash = URI.lastIndexOf('/');
        const lastQ = URI.indexOf('?', lastSlash);
        const CENTRAL_URI = URI.substring(0, lastSlash + 1) + 'zudo-central' + (lastQ !== -1 ? URI.substring(lastQ) : '');
        const centralConn = await require('mongoose').createConnection(CENTRAL_URI).asPromise();
        const LocModel = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
        const locations = await LocModel.find({ isActive: true }).lean();
        await centralConn.close().catch(() => {});

        for (const loc of locations) {
          const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
          const dbName = loc.dbName || `zudo-${cityClean}`;
          const conn = await connectDBByLocation(loc._id.toString(), dbName);
          const TenantModel = conn.models.CashCollector || conn.model('CashCollector', CashCollector.schema);
          let found = await TenantModel.findOne(query);
          if (!found) {
            const TenantAdmin = conn.models.Admin || conn.model('Admin', AdminSchema);
            found = await TenantAdmin.findOne({ ...query, role: 'cash_collector' });
          }
          if (found) {
            collector = found;
            resolvedLocId = loc._id.toString();
            resolvedDbName = conn.name;
            break;
          }
        }
      } catch (searchErr) {
        console.warn('[CashCollector Login] Multi-tenant search error:', searchErr.message);
      }
    }

    if (collector && (await collector.comparePassword(password))) {
      if (collector.status === 'inactive') {
        return res.status(403).json({ message: 'Account is inactive. Please contact admin.' });
      }
      collector.tokenVersion = (collector.tokenVersion || 0) + 1;
      await collector.save();

      const token = jwt.sign(
        {
          id: collector._id,
          role: 'cash_collector',
          locationId: resolvedLocId || undefined,
          dbName: resolvedDbName || undefined,
          tokenVersion: collector.tokenVersion
        },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.json({
        token,
        user: {
          _id: collector._id,
          name: collector.name,
          email: collector.email,
          role: 'cash_collector',
          phone: collector.phone,
          status: collector.status,
          locationId: resolvedLocId || undefined,
          wallet: collector.amount || 0
        }
      });
    }

    res.status(401).json({ message: 'Invalid credentials' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/cashcollectors/profile
// @desc    Get logged-in cash collector profile
// @access  Private
router.get('/profile', protect, async (req, res) => {
  try {
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const collector = await CashCollectorModel.findById(req.user._id).select('-password');
    if (!collector) {
      return res.status(404).json({ message: 'Cash collector not found' });
    }
    res.json(collector);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/cashcollectors/assigned-orders
// @desc    Get orders assigned to the logged-in cash collector (or ?collectorId=...)
// @access  Private
router.get('/assigned-orders', protect, async (req, res) => {
  try {
    const collectorId = req.query.collectorId || req.user._id;
    const OrderModel = req.models?.Order || Order;
    const orders = await OrderModel.find({ cashPersonId: collectorId })
      .populate('userId', 'name email phone businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/cashcollectors
// @desc    Get all cash collectors (supports global multi-tenant aggregation & single-tenant)
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    if (!req.locationId) {
      const collectors = await aggregateGET('CashCollector', req, filter, ['driverId'], '-password', { createdAt: -1 });
      return res.json(collectors);
    }

    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const collectors = await CashCollectorModel.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();
    res.json(collectors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/cashcollectors/:id
// @desc    Get cash collector by ID
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const { doc: collector } = await findCollectorAcrossTenants(req.params.id, req);
    if (!collector) {
      return res.status(404).json({ message: 'Cash collector not found' });
    }
    const obj = collector.toObject();
    delete obj.password;
    res.json(obj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/cashcollectors
// @desc    Create a new cash collector
// @access  Private (Admin)
router.post('/', protect, async (req, res) => {
  try {
    const { name, phone, email, password, type, status, amount, description, locationId } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const { Model: CashCollectorModel, locationId: resolvedLocId } = await resolveCollectorModel(req, locationId);

    if (email) {
      const existing = await CashCollectorModel.findOne({ email: email.trim() });
      if (existing) {
        return res.status(400).json({ message: 'A cash collector with this email already exists' });
      }
    }

    const collector = new CashCollectorModel({
      name: name.trim(),
      phone: phone || '',
      email: email ? email.trim() : undefined,
      password: password || undefined,
      type: type || 'Account',
      status: status || 'active',
      amount: amount !== undefined ? Number(amount) : 0,
      description: description || ''
    });

    const saved = await collector.save();
    const obj = saved.toObject();
    delete obj.password;
    if (resolvedLocId) obj.locationId = resolvedLocId;

    res.status(201).json(obj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/cashcollectors/:id
// @desc    Update a cash collector
// @access  Private (Admin)
router.put('/:id', protect, async (req, res) => {
  try {
    const { doc: collector } = await findCollectorAcrossTenants(req.params.id, req);
    if (!collector) {
      return res.status(404).json({ message: 'Cash collector not found' });
    }

    const { name, phone, email, password, type, status, amount, description } = req.body;
    if (name !== undefined) collector.name = name;
    if (phone !== undefined) collector.phone = phone;
    if (email !== undefined) collector.email = email;
    if (password) collector.password = password;
    if (type !== undefined) collector.type = type;
    if (status !== undefined) collector.status = status;
    if (amount !== undefined) collector.amount = Number(amount);
    if (description !== undefined) collector.description = description;

    const updated = await collector.save();
    const obj = updated.toObject();
    delete obj.password;
    res.json(obj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/cashcollectors/:id
// @desc    Delete a cash collector
// @access  Private (Admin)
router.delete('/:id', protect, async (req, res) => {
  try {
    const { Model, doc: collector } = await findCollectorAcrossTenants(req.params.id, req);
    if (!collector) {
      return res.status(404).json({ message: 'Cash collector not found' });
    }

    await Model.findByIdAndDelete(req.params.id);
    res.json({ message: 'Cash collector removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
