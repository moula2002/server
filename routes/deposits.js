const express = require('express');
const router = express.Router();
const Deposit = require('../models/Deposit');
const Driver = require('../models/Driver');
const { protect } = require('../middleware/auth');

// Helper to get models from req with fallback to global imports
const getModels = (req) => {
  return {
    Deposit: req.models?.Deposit || Deposit,
    Driver: req.models?.Driver || Driver
  };
};

// @route   POST /api/deposits
// @desc    Create a new deposit request
// @access  Private (Driver)
router.post('/', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
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
    if ((driver.wallet || 0) < amount) {
      return res.status(400).json({ message: 'Insufficient wallet balance' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const deposit = new DepositModel({
      driverId: req.user._id,
      amount,
      otp
    });

    const createdDeposit = await deposit.save();
    res.status(201).json(createdDeposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/deposits/verify
// @desc    Verify deposit OTP
// @access  Private (Driver)
router.post('/verify', protect, async (req, res) => {
  try {
    const { depositId, otp } = req.body;

    if (!depositId || !otp) {
      return res.status(400).json({ message: 'Deposit ID and OTP are required' });
    }

    const { Driver: DriverModel, Deposit: DepositModel } = getModels(req);
    const deposit = await DepositModel.findById(depositId);

    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    if (deposit.status !== 'Pending') {
      return res.status(400).json({ message: 'Deposit has already been processed' });
    }

    if (deposit.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    deposit.status = 'Approved';
    
    // Deduct from driver wallet
    const driver = await DriverModel.findById(deposit.driverId);
    if (driver) {
      driver.wallet = (driver.wallet || 0) - deposit.amount;
      await driver.save();
    }

    await deposit.save();
    res.json({ message: 'Deposit verified and approved', deposit });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/my
// @desc    Get logged in driver's deposit history
// @access  Private (Driver)
router.get('/my', protect, async (req, res) => {
  try {
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find({ driverId: req.user._id }).sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/all/pending
// @desc    Get all pending deposits (Admin only)
router.get('/all/pending', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find({ status: 'Pending' }).populate('driverId', 'name phone email').sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/deposits/admin
// @desc    Get all deposit requests (Admin only)
router.get('/admin', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    const { Deposit: DepositModel } = getModels(req);
    const deposits = await DepositModel.find().populate('driverId', 'name phone email').sort({ createdAt: -1 });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/deposits/:id/status
// @desc    Update deposit status (Approve/Reject)
// @route   PUT /api/deposits/:id
// @desc    Update deposit status (alias for /:id/status for frontend compatibility)
router.put('/:id', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const { status, remarks } = req.body;
    const { Driver: DriverModel, Deposit: DepositModel } = getModels(req);
    const deposit = await DepositModel.findById(req.params.id);

    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    const targetStatus = (status === 'Completed' || status === 'Approved') ? 'Approved' : (status || 'Approved');
    deposit.status = targetStatus;
    if (remarks) deposit.remarks = remarks;

    if (targetStatus === 'Approved') {
      const driver = await DriverModel.findById(deposit.driverId);
      if (driver && driver.wallet) {
        driver.wallet = Math.max(0, (driver.wallet || 0) - deposit.amount);
        await driver.save();
      }
    }

    await deposit.save();
    res.json(deposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id/status', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const { status, remarks } = req.body;
    const { Driver: DriverModel, Deposit: DepositModel } = getModels(req);
    const deposit = await DepositModel.findById(req.params.id);

    if (!deposit) {
      return res.status(404).json({ message: 'Deposit request not found' });
    }

    if (deposit.status !== 'Pending') {
      return res.status(400).json({ message: 'Deposit has already been processed' });
    }

    deposit.status = status;
    deposit.remarks = remarks || deposit.remarks;

    if (status === 'Approved') {
      // Deduct from driver wallet
      const driver = await DriverModel.findById(deposit.driverId);
      if (driver) {
        driver.wallet = (driver.wallet || 0) - deposit.amount;
        await driver.save();
      }
    }

    await deposit.save();
    res.json(deposit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
