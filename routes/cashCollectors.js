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

const handleGetAssignedOrders = async (req, res) => {
  try {
    const collectorId = req.query.collectorId || req.user._id;
    const OrderModel = req.models?.Order || Order;
    const orders = await OrderModel.find({
      $or: [{ cashPersonId: collectorId }, { driverId: collectorId }]
    })
      .populate('userId', 'name email phone role businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .populate('cashPersonId', 'name phone email type')
      .sort({ createdAt: -1 })
      .lean();

    const enriched = orders.map(o => {
      const expectedAmount = Math.round((Number(o.totalAmount) || 0) * 100) / 100;
      const collectedAmount = Math.round((Number(o.codCollectedAmount) || 0) * 100) / 100;
      const pendingAmount = Math.max(0, Math.round((expectedAmount - collectedAmount) * 100) / 100);
      let collectionStatus = 'Pending';
      if (o.orderStatus === 'Cancelled' || o.codCollectionStatus === 'Cancelled' || o.codCollectionStatus === 'Failed') {
        collectionStatus = o.codCollectionStatus === 'Failed' ? 'Failed' : 'Cancelled';
      } else if ((expectedAmount > 0 && pendingAmount <= 0) || ['Collected', 'Verified'].includes(o.codCollectionStatus)) {
        collectionStatus = 'Completed';
      } else if (collectedAmount > 0 && pendingAmount > 0) {
        collectionStatus = 'Partial';
      }
      return {
        ...o,
        orderRef: o.orderRef || (o.orderNumber ? String(o.orderNumber).padStart(5, '0') : o._id.toString().slice(-6).toUpperCase()),
        customerName: o.userId?.businessName || o.userId?.companyName || o.userId?.name || o.shippingAddress?.name || 'Customer',
        customerPhone: o.userId?.phone || o.shippingAddress?.phone || '',
        customerAddress: o.shippingAddress
          ? [o.shippingAddress.addressLine || o.shippingAddress.address || o.shippingAddress.street, o.shippingAddress.city, o.shippingAddress.state, o.shippingAddress.pincode].filter(Boolean).join(', ')
          : '',
        customerLat: o.shippingAddress?.lat ?? null,
        customerLng: o.shippingAddress?.lng ?? null,
        expectedAmount,
        collectedAmount,
        pendingAmount,
        collectionStatus
      };
    });

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route   GET /api/cashcollectors/assigned-orders
// @desc    Get orders assigned to the logged-in cash collector (or ?collectorId=...)
// @access  Private
router.get('/assigned-orders', protect, handleGetAssignedOrders);

const requireAdminRole = (req, res, next) => {
  const isAdmin = !!req.admin || ['super_admin', 'superadmin', 'normal_admin', 'manager', 'logistics', 'sales', 'accounting', 'b2b_admin', 'b2c_admin'].includes(req.user?.role);
  if (!isAdmin) {
    return res.status(403).json({ message: '403 Forbidden: Admin authorization required' });
  }
  next();
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const computeOrderTask = (o) => {
  const expectedAmount = round2(o.totalAmount || 0);
  const collectedAmount = round2(o.codCollectedAmount || 0);
  const pendingAmount = Math.max(0, round2(expectedAmount - collectedAmount));
  let collectionStatus = 'Pending';
  if (o.orderStatus === 'Cancelled' || o.codCollectionStatus === 'Cancelled') {
    collectionStatus = 'Cancelled';
  } else if (o.codCollectionStatus === 'Failed' || o.codCollectionStatus === 'Disputed') {
    collectionStatus = 'Failed';
  } else if ((expectedAmount > 0 && pendingAmount <= 0) || ['Collected', 'Verified'].includes(o.codCollectionStatus)) {
    collectionStatus = 'Completed';
  } else if (collectedAmount > 0 && pendingAmount > 0) {
    collectionStatus = 'Partial';
  }

  const assignedObj = o.cashPersonId || o.driverId || null;
  const assignedRole = o.cashPersonId ? 'Cash Collector' : (o.driverId ? 'Driver' : null);

  return {
    _id: o._id,
    orderRef: o.orderRef || (o.orderNumber ? String(o.orderNumber).padStart(5, '0') : o._id.toString().slice(-6).toUpperCase()),
    orderStatus: o.orderStatus,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    customerSegment: String(o.userId?.role || '').toLowerCase() === 'b2b' ? 'B2B' : 'B2C',
    customerName: o.userId?.businessName || o.userId?.companyName || o.userId?.name || o.shippingAddress?.name || 'Customer',
    customerPhone: o.userId?.phone || o.shippingAddress?.phone || '',
    customerAddress: o.shippingAddress
      ? [o.shippingAddress.addressLine || o.shippingAddress.address || o.shippingAddress.street, o.shippingAddress.city, o.shippingAddress.state, o.shippingAddress.pincode].filter(Boolean).join(', ')
      : '',
    customerLat: o.shippingAddress?.lat ?? null,
    customerLng: o.shippingAddress?.lng ?? null,
    assignedCollectorId: assignedObj?._id || assignedObj || null,
    assignedCollectorName: assignedObj?.name || null,
    assignedCollectorPhone: assignedObj?.phone || null,
    assignedRole,
    expectedAmount,
    collectedAmount,
    pendingAmount,
    collectionStatus,
    codAssignedAt: o.codAssignedAt || o.updatedAt || o.createdAt,
    codCollectedAt: o.codCollectedAt || null,
    codCollectionHistory: Array.isArray(o.codCollectionHistory) ? o.codCollectionHistory : [],
    createdAt: o.createdAt
  };
};

// @route   GET /api/cashcollectors/reconciliation
// @desc    Automatic cash collection summary, collector-wise reconciliation & order tasks (Admin)
// @access  Private (Admin)
router.get('/reconciliation', protect, requireAdminRole, async (req, res) => {
  try {
    const OrderModel = req.models?.Order || Order;
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const DriverModel = req.models?.Driver || require('../models/Driver');

    const [orders, collectors, drivers] = await Promise.all([
      OrderModel.find({
        $or: [
          { cashPersonId: { $ne: null } },
          { paymentMethod: { $in: ['COD', 'cod', 'Cash', 'cash', 'Cash at Delivery', 'UPI at Delivery'] } }
        ]
      })
        .populate('userId', 'name email phone role businessName companyName')
        .populate('cashPersonId', 'name phone email type status')
        .populate('driverId', 'name phone vehicleNo type cashManagement')
        .sort({ createdAt: -1 })
        .lean(),
      CashCollectorModel.find({ status: { $ne: 'inactive' } }).select('-password').lean(),
      DriverModel.find({}).select('name phone vehicleNo vehicleDetails type cashManagement wallet').lean()
    ]);

    const tasks = orders.map(computeOrderTask);
    const assignedTasks = tasks.filter(t => t.assignedCollectorId);

    const summaryMap = new Map();
    const ensureBucket = (id, name, phone, roleLabel, typeLabel) => {
      const key = String(id);
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          collectorId: key,
          name: name || 'Unknown',
          phone: phone || '',
          role: roleLabel,
          type: typeLabel || 'B2C',
          assignedTasks: 0,
          totalExpected: 0,
          totalCollected: 0,
          totalPending: 0,
          completedCount: 0,
          partialCount: 0,
          pendingCount: 0,
          failedCancelledCount: 0,
          overallStatus: 'Idle'
        });
      }
      return summaryMap.get(key);
    };

    collectors.forEach(c => {
      if (c.email || c.type === 'Account' || c.status === 'active' || c.status === 'Verified') {
        ensureBucket(c._id, c.name, c.phone, 'Cash Collector', c.type || 'B2B');
      }
    });
    drivers.forEach(d => {
      ensureBucket(d._id, d.name, d.phone, 'Driver', String(d.type || 'b2c').toUpperCase());
    });

    for (const t of assignedTasks) {
      const bucket = ensureBucket(t.assignedCollectorId, t.assignedCollectorName, t.assignedCollectorPhone, t.assignedRole || 'Cash Collector', t.customerSegment);
      bucket.assignedTasks += 1;
      bucket.totalExpected = round2(bucket.totalExpected + t.expectedAmount);
      bucket.totalCollected = round2(bucket.totalCollected + t.collectedAmount);
      bucket.totalPending = round2(bucket.totalPending + t.pendingAmount);
      if (t.collectionStatus === 'Completed') bucket.completedCount += 1;
      else if (t.collectionStatus === 'Partial') bucket.partialCount += 1;
      else if (t.collectionStatus === 'Failed' || t.collectionStatus === 'Cancelled') bucket.failedCancelledCount += 1;
      else bucket.pendingCount += 1;
    }

    const collectorSummaries = Array.from(summaryMap.values())
      .map(b => {
        if (b.assignedTasks > 0) {
          if (b.totalPending <= 0 && b.completedCount > 0) b.overallStatus = 'Completed';
          else if (b.totalCollected > 0 && b.totalPending > 0) b.overallStatus = 'Partial';
          else b.overallStatus = 'Pending';
        }
        return b;
      })
      .sort((a, b) => b.assignedTasks - a.assignedTasks || b.totalExpected - a.totalExpected);

    const totalExpectedCash = round2(assignedTasks.reduce((s, t) => s + t.expectedAmount, 0));
    const totalCashCollected = round2(assignedTasks.reduce((s, t) => s + t.collectedAmount, 0));
    const totalPendingCash = round2(assignedTasks.reduce((s, t) => s + t.pendingAmount, 0));
    const collectionProgress = totalExpectedCash > 0 ? Math.min(100, Math.round((totalCashCollected / totalExpectedCash) * 100)) : 0;

    res.json({
      summary: {
        totalExpectedCash,
        totalCashCollected,
        totalPendingCash,
        collectionProgress,
        totalAssignedTasks: assignedTasks.length,
        completedCount: assignedTasks.filter(t => t.collectionStatus === 'Completed').length,
        partialCount: assignedTasks.filter(t => t.collectionStatus === 'Partial').length,
        pendingCount: assignedTasks.filter(t => t.collectionStatus === 'Pending').length,
        failedCancelledCount: assignedTasks.filter(t => t.collectionStatus === 'Failed' || t.collectionStatus === 'Cancelled').length
      },
      collectorSummaries,
      tasks: assignedTasks,
      eligibleOrders: tasks.filter(t => t.collectionStatus !== 'Completed' && t.collectionStatus !== 'Cancelled'),
      collectors: collectors.map(c => ({ _id: c._id, name: c.name, phone: c.phone, email: c.email, type: c.type, status: c.status })),
      drivers: drivers.map(d => ({ _id: d._id, name: d.name, phone: d.phone, vehicleNo: d.vehicleNo || d.vehicleDetails, type: d.type, cashManagement: Boolean(d.cashManagement), wallet: d.wallet || 0 }))
    });
  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/cashcollectors/assign
// @desc    Assign a Cash Collector or Driver to an order (expected amount derived automatically from Order)
// @access  Private (Admin)
router.post('/assign', protect, requireAdminRole, async (req, res) => {
  try {
    const { orderId, collectorId, collectorType = 'cash_collector', notes = '' } = req.body;
    if (!orderId || !collectorId) {
      return res.status(400).json({ message: 'orderId and collectorId are required' });
    }

    const OrderModel = req.models?.Order || Order;
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const DriverModel = req.models?.Driver || require('../models/Driver');

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const expectedAmount = round2(order.totalAmount || 0);
    const collectedAmount = round2(order.codCollectedAmount || 0);
    if (order.codCashCredited || (expectedAmount > 0 && collectedAmount >= expectedAmount)) {
      return res.status(400).json({ message: 'Order cash collection is already completed' });
    }
    if (order.orderStatus === 'Cancelled') {
      return res.status(400).json({ message: 'Cannot assign cash collection for a cancelled order' });
    }

    let assigneeName = '';
    const isReassign = Boolean(order.driverId || order.cashPersonId);
    if (collectorType === 'driver') {
      const driver = await DriverModel.findById(collectorId).select('name cashManagement');
      if (!driver) return res.status(404).json({ message: 'Driver not found' });
      order.driverId = collectorId;
      order.cashPersonId = null;
      assigneeName = driver.name;
    } else {
      const collector = await CashCollectorModel.findById(collectorId).select('name');
      if (!collector) return res.status(404).json({ message: 'Cash collector not found' });
      order.cashPersonId = collectorId;
      assigneeName = collector.name;
    }

    order.codAssignedAt = new Date();
    if (!order.codCollectionStatus || order.codCollectionStatus === 'Not Collected') {
      order.codCollectionStatus = 'Pending';
    }
    if (!Array.isArray(order.codCollectionHistory)) order.codCollectionHistory = [];
    order.codCollectionHistory.push({
      amount: 0,
      collectorId,
      collectorName: assigneeName,
      collectorRole: collectorType === 'driver' ? 'Driver' : 'Cash Collector',
      status: isReassign ? 'Reassigned' : 'Pending',
      notes: notes || `${isReassign ? 'Reassigned' : 'Assigned'} to ${assigneeName} (Expected ₹${expectedAmount})`,
      collectedAt: new Date()
    });

    await order.save();
    const populated = await OrderModel.findById(order._id)
      .populate('userId', 'name email phone role businessName companyName')
      .populate('cashPersonId', 'name phone email type')
      .populate('driverId', 'name phone vehicleNo')
      .lean();

    res.json({
      message: `Cash collection assigned to ${assigneeName}`,
      task: computeOrderTask(populated)
    });
  } catch (error) {
    console.error('Assign collector error:', error);
    res.status(500).json({ message: error.message });
  }
});

const handleConfirmCollection = async (req, res) => {
  try {
    const { orderId, collectedAmount: rawCollectedAmount, action = 'collect', notes = '' } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: 'orderId is required' });
    }

    const OrderModel = req.models?.Order || Order;
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const DriverModel = req.models?.Driver || require('../models/Driver');

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const isAdmin = !!req.admin || ['super_admin', 'superadmin', 'normal_admin', 'manager', 'logistics', 'sales', 'accounting', 'b2b_admin', 'b2c_admin'].includes(req.user?.role);
    const isAssignedCollector = order.cashPersonId && order.cashPersonId.toString() === req.user._id.toString();
    const isAssignedDriver = order.driverId && order.driverId.toString() === req.user._id.toString();

    if (!isAdmin && !isAssignedCollector && !isAssignedDriver) {
      return res.status(403).json({ message: '403 Forbidden: Only the assigned cash collector or driver can confirm this collection' });
    }

    const expectedAmount = round2(order.totalAmount || 0);
    const alreadyCollected = round2(order.codCollectedAmount || 0);
    const remaining = Math.max(0, round2(expectedAmount - alreadyCollected));

    if (action === 'fail' || action === 'cancel') {
      if (order.codCashCredited || (expectedAmount > 0 && remaining <= 0)) {
        return res.status(400).json({ message: 'Cannot mark a completed collection as failed or cancelled' });
      }
      const nextStatus = action === 'cancel' ? 'Cancelled' : 'Failed';
      order.codCollectionStatus = nextStatus;
      order.codRemarks = notes || `Marked ${nextStatus} by ${req.user?.name || req.user?.role}`;
      if (!Array.isArray(order.codCollectionHistory)) order.codCollectionHistory = [];
      order.codCollectionHistory.push({
        amount: 0,
        collectorId: req.user._id,
        collectorName: req.user?.name || 'Collector',
        collectorRole: req.user?.role || 'cash_collector',
        status: nextStatus,
        notes: notes || `Collection ${nextStatus.toLowerCase()}`,
        collectedAt: new Date()
      });
      await order.save();
      return res.json({ message: `Collection marked as ${nextStatus}`, task: computeOrderTask(order.toObject()) });
    }

    if (order.codCashCredited || remaining <= 0) {
      return res.status(400).json({ message: 'Collection for this order is already completed' });
    }

    const amountToCollect = rawCollectedAmount !== undefined && rawCollectedAmount !== null && rawCollectedAmount !== ''
      ? round2(rawCollectedAmount)
      : remaining;

    if (isNaN(amountToCollect) || amountToCollect <= 0) {
      return res.status(400).json({ message: 'Collected amount must be greater than 0' });
    }
    if (amountToCollect > remaining) {
      return res.status(400).json({ message: `Collected amount (₹${amountToCollect}) cannot exceed pending balance (₹${remaining})` });
    }

    const newTotalCollected = round2(alreadyCollected + amountToCollect);
    const newPending = Math.max(0, round2(expectedAmount - newTotalCollected));
    const isFull = newPending <= 0;

    // Atomic compare-and-swap on codCollectedAmount to prevent duplicate concurrent submissions
    const updatedOrder = await OrderModel.findOneAndUpdate(
      { _id: order._id, codCashCredited: { $ne: true }, codCollectedAmount: alreadyCollected },
      {
        $set: {
          codCollectedAmount: newTotalCollected,
          codCollectionStatus: isFull ? 'Collected' : 'Partial',
          codCollectedAt: new Date(),
          codCollectedBy: { id: req.user._id, name: req.user?.name || 'Collector', role: req.user?.role || 'cash_collector' },
          ...(isFull ? { paymentStatus: 'Completed', paidAt: new Date(), codCashCredited: true, codCashCreditedAt: new Date() } : {})
        },
        $push: {
          codCollectionHistory: {
            amount: amountToCollect,
            collectorId: req.user._id,
            collectorName: req.user?.name || 'Collector',
            collectorRole: req.user?.role || 'cash_collector',
            status: isFull ? 'Completed' : 'Partial',
            notes: notes || (isFull ? 'Full cash collected' : `Partial collection of ₹${amountToCollect}`),
            collectedAt: new Date()
          }
        }
      },
      { returnDocument: 'after' }
    )
      .populate('userId', 'name email phone role businessName companyName')
      .populate('cashPersonId', 'name phone email type')
      .populate('driverId', 'name phone vehicleNo');

    if (!updatedOrder) {
      return res.status(409).json({ message: 'Collection was already updated by another request. Please refresh.' });
    }

    // Credit incremental cash collected to assigned CashCollector or eligible Driver wallet
    if (updatedOrder.cashPersonId?._id || updatedOrder.cashPersonId) {
      const cpId = updatedOrder.cashPersonId._id || updatedOrder.cashPersonId;
      await CashCollectorModel.findByIdAndUpdate(cpId, { $inc: { amount: amountToCollect } });
    } else if (updatedOrder.driverId?._id || updatedOrder.driverId) {
      const drvId = updatedOrder.driverId._id || updatedOrder.driverId;
      const drv = await DriverModel.findById(drvId).select('cashManagement');
      if (drv && drv.cashManagement) {
        await DriverModel.findByIdAndUpdate(drvId, { $inc: { wallet: amountToCollect } });
      }
    }

    res.json({
      message: isFull ? `Full collection of ₹${amountToCollect} confirmed` : `Partial collection of ₹${amountToCollect} recorded. Pending: ₹${newPending}`,
      task: computeOrderTask(updatedOrder.toObject())
    });
  } catch (error) {
    console.error('Confirm collection error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @route   POST /api/cashcollectors/confirm-collection
// @desc    Confirm full, partial, or failed/cancelled cash collection from Cash Collector / Driver app
// @access  Private (Assigned Cash Collector, Assigned Driver, or Admin)
router.post('/confirm-collection', protect, handleConfirmCollection);

router.handleGetAssignedOrders = handleGetAssignedOrders;
router.handleConfirmCollection = handleConfirmCollection;

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
