const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Deposit = require('../models/Deposit');
const Driver = require('../models/Driver');
const { protect } = require('../middleware/auth');
const { connectDBByLocation } = require('../utils/db_manager');
const { aggregateGET } = require('../utils/aggregator');

// Helper to get models from req with fallback to global imports
const getModels = (req) => {
  return {
    Deposit: req.models?.Deposit || Deposit,
    Driver: req.models?.Driver || Driver
  };
};

const isAdminRequest = (req) => {
  return !!req.admin || ['admin', 'super_admin', 'normal_admin', 'manager', 'cash_admin'].includes(req.user?.role);
};

/**
 * Locate Deposit & matching Driver model across tenant DBs if in global mode
 */
const findDepositAcrossTenants = async (depositId, req) => {
  if (!mongoose.Types.ObjectId.isValid(depositId)) {
    return { DepositModel: null, DriverModel: null, deposit: null };
  }

  const { Deposit: DefaultDeposit, Driver: DefaultDriver } = getModels(req);
  const doc = await DefaultDeposit.findById(depositId);
  if (doc) {
    return { DepositModel: DefaultDeposit, DriverModel: DefaultDriver, deposit: doc };
  }

  if (!req.locationId) {
    try {
      const LocationModel = DefaultDeposit.db.models.Location || DefaultDeposit.db.model('Location', require('../models/Location').schema);
      const locations = await LocationModel.find({ isActive: true }).lean();
      for (const loc of locations) {
        try {
          const conn = await connectDBByLocation(loc._id.toString());
          const TenantDeposit = conn.models.Deposit || conn.model('Deposit', Deposit.schema);
          const found = await TenantDeposit.findById(depositId);
          if (found) {
            const TenantDriver = conn.models.Driver || conn.model('Driver', Driver.schema);
            return { DepositModel: TenantDeposit, DriverModel: TenantDriver, deposit: found };
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return { DepositModel: DefaultDeposit, DriverModel: DefaultDriver, deposit: null };
};

/**
 * Atomically settle or reject a Pending deposit inside a MongoDB transaction
 * Prevents double-debit, negative wallets, and concurrent race conditions.
 */
const processDepositAtomically = async ({ DepositModel, DriverModel, depositId, targetStatus, remarks, requiredOtp = null }) => {
  const dbConn = DepositModel.db || mongoose.connection;
  const session = await dbConn.startSession();
  let resultDeposit = null;
  let errorStatus = null;
  let errorMessage = null;

  try {
    await session.withTransaction(async () => {
      const existing = await DepositModel.findById(depositId).session(session);
      if (!existing) {
        errorStatus = 404;
        errorMessage = 'Deposit request not found';
        throw new Error(errorMessage);
      }

      if (existing.status !== 'Pending') {
        errorStatus = 400;
        errorMessage = 'Deposit has already been processed';
        throw new Error(errorMessage);
      }

      if (requiredOtp !== null && String(existing.otp).trim() !== String(requiredOtp).trim()) {
        errorStatus = 400;
        errorMessage = 'Invalid OTP';
        throw new Error(errorMessage);
      }

      const updateFields = { status: targetStatus };
      if (remarks !== undefined) updateFields.remarks = remarks;

      const updatedDeposit = await DepositModel.findOneAndUpdate(
        { _id: depositId, status: 'Pending' },
        { $set: updateFields },
        { session, returnDocument: 'after' }
      );

      if (!updatedDeposit) {
        errorStatus = 400;
        errorMessage = 'Deposit has already been processed';
        throw new Error(errorMessage);
      }

      if (targetStatus === 'Approved') {
        const debitAmount = Number(updatedDeposit.amount) || 0;
        const updatedDriver = await DriverModel.findOneAndUpdate(
          { _id: updatedDeposit.driverId, wallet: { $gte: debitAmount } },
          { $inc: { wallet: -debitAmount } },
          { session, returnDocument: 'after' }
        );

        if (!updatedDriver) {
          errorStatus = 400;
          errorMessage = 'Insufficient driver wallet balance for settlement';
          throw new Error(errorMessage);
        }
      }

      resultDeposit = updatedDeposit;
    });
  } catch (err) {
    if (!errorStatus) {
      errorStatus = 500;
      errorMessage = err.message;
    }
  } finally {
    await session.endSession();
  }

  return { deposit: resultDeposit, errorStatus, errorMessage };
};

// @route   POST /api/deposits
// @desc    Create a new deposit request
// @access  Private (Driver)
router.post('/', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'driver') {
      return res.status(403).json({ message: '403 Forbidden: Only drivers can submit deposit requests' });
    }

    const numericAmount = Number(req.body.amount);
    if (!numericAmount || isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ message: 'Amount is required and must be positive' });
    }

    const { Driver: DriverModel, Deposit: DepositModel } = getModels(req);

    // Check driver wallet and cash management permission
    const driver = await DriverModel.findById(req.user._id);
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }
    if (!driver.cashManagement) {
      return res.status(403).json({ message: 'Cash management is disabled for this driver. Contact administrator.' });
    }

    // Account for existing Pending deposits to prevent concurrent pending overdrafts
    const pendingDeposits = await DepositModel.find({
      driverId: req.user._id,
      status: 'Pending'
    }).select('amount').lean();

    const pendingTotal = pendingDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    const availableBalance = (Number(driver.wallet) || 0) - pendingTotal;

    if (availableBalance < numericAmount) {
      return res.status(400).json({
        message: 'Insufficient available wallet balance (accounting for pending deposits)',
        walletBalance: Number(driver.wallet) || 0,
        pendingAmount: pendingTotal,
        availableBalance: Math.max(0, availableBalance)
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const deposit = new DepositModel({
      driverId: req.user._id,
      amount: numericAmount,
      otp
    });

    const createdDeposit = await deposit.save();
    res.status(201).json(createdDeposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/deposits/verify
// @desc    Verify deposit OTP and atomically settle
// @access  Private (Admin or owning Driver)
router.post('/verify', protect, async (req, res) => {
  try {
    const { depositId, otp } = req.body;

    if (!depositId || !otp) {
      return res.status(400).json({ message: 'Deposit ID and OTP are required' });
    }

    const { DepositModel, DriverModel, deposit } = await findDepositAcrossTenants(depositId, req);
    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    const isAdmin = isAdminRequest(req);
    const isOwningDriver = req.user?.role === 'driver' && deposit.driverId?.toString() === req.user._id.toString();
    if (!isAdmin && !isOwningDriver) {
      return res.status(403).json({ message: '403 Forbidden: Not authorized to verify this deposit' });
    }

    const result = await processDepositAtomically({
      DepositModel,
      DriverModel,
      depositId,
      targetStatus: 'Approved',
      requiredOtp: otp
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ message: result.errorMessage });
    }

    res.json({ message: 'Deposit verified and approved', deposit: result.deposit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/my
// @desc    Get logged in driver's deposit history
// @access  Private (Driver)
router.get('/my', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'driver') {
      return res.status(403).json({ message: '403 Forbidden: Driver access only' });
    }
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find({ driverId: req.user._id }).sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/all/pending
// @desc    Get all pending deposits (Admin only, supports multi-tenant global mode)
router.get('/all/pending', protect, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    if (!req.locationId) {
      const deposits = await aggregateGET('Deposit', req, { status: 'Pending' }, ['driverId'], '', { createdAt: -1 });
      return res.json(deposits);
    }
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find({ status: 'Pending' }).populate('driverId', 'name phone email').sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/admin
// @desc    Get all deposit requests (Admin only, supports multi-tenant global mode)
router.get('/admin', protect, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    if (!req.locationId) {
      const deposits = await aggregateGET('Deposit', req, {}, ['driverId'], '', { createdAt: -1 });
      return res.json(deposits);
    }
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find().populate('driverId', 'name phone email').sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/deposits/:id
// @desc    Update deposit status atomically (Admin only)
router.put('/:id', protect, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const { status, remarks, otp } = req.body;
    const { DepositModel, DriverModel, deposit } = await findDepositAcrossTenants(req.params.id, req);
    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    const targetStatus = (status === 'Completed' || status === 'Approved') ? 'Approved' : (status || 'Approved');
    if (!['Approved', 'Rejected'].includes(targetStatus)) {
      return res.status(400).json({ message: 'Invalid deposit target status' });
    }

    const result = await processDepositAtomically({
      DepositModel,
      DriverModel,
      depositId: req.params.id,
      targetStatus,
      remarks,
      requiredOtp: otp !== undefined ? otp : null
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ message: result.errorMessage });
    }

    res.json(result.deposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/deposits/:id/status
// @desc    Update deposit status atomically (Approve/Reject, Admin only)
router.put('/:id/status', protect, async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const { status, remarks, otp } = req.body;
    const { DepositModel, DriverModel, deposit } = await findDepositAcrossTenants(req.params.id, req);
    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    const targetStatus = (status === 'Completed' || status === 'Approved') ? 'Approved' : (status || 'Approved');
    if (!['Approved', 'Rejected'].includes(targetStatus)) {
      return res.status(400).json({ message: 'Invalid deposit target status' });
    }

    const result = await processDepositAtomically({
      DepositModel,
      DriverModel,
      depositId: req.params.id,
      targetStatus,
      remarks,
      requiredOtp: otp !== undefined ? otp : null
    });

    if (result.errorStatus) {
      return res.status(result.errorStatus).json({ message: result.errorMessage });
    }

    res.json(result.deposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
