const express = require('express');
const router = express.Router();
const CashCollector = require('../models/CashCollector');

// @route   GET api/cash
// @desc    Get all cash transactions
// @access  Private (Admin)
router.get('/', async (req, res) => {
  try {
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const transactions = await aggregateGET('CashCollector', req, {}, ['driverId'], '', { date: -1, createdAt: -1 });
      return res.json(transactions);
    }
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const transactions = await CashCollectorModel.find().populate('driverId', 'name phone wallet').sort({ date: -1, createdAt: -1 });
    res.json(transactions);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST api/cash
// @desc    Record a new cash transaction / collector
// @access  Private (Admin)
router.post('/', async (req, res) => {
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
    date
  } = req.body;

  try {
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
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
      status: status || 'Verified',
      verification: verification || (otp ? 'Verified (OTP)' : 'Manual Entry'),
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

    res.json(transaction);
  } catch (err) {
    console.error('Error logging transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

// @route   PUT api/cash/:id
// @desc    Update a cash transaction
// @access  Private (Admin)
router.put('/:id', async (req, res) => {
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
    date
  } = req.body;

  try {
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    let transaction = await CashCollectorModel.findById(req.params.id);
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

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
    if (date) transaction.date = new Date(date);

    transaction = await transaction.save();
    res.json(transaction);
  } catch (err) {
    console.error('Error updating transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

// @route   DELETE api/cash/:id
// @desc    Delete a cash transaction
// @access  Private (Admin)
router.delete('/:id', async (req, res) => {
  try {
    const CashCollectorModel = req.models?.CashCollector || CashCollector;
    const transaction = await CashCollectorModel.findById(req.params.id);
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    
    await CashCollectorModel.findByIdAndDelete(req.params.id);
    res.json({ message: 'Transaction removed' });
  } catch (err) {
    console.error('Error deleting transaction:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
