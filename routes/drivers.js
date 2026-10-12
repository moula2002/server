const express = require('express');
const router = express.Router();
const Driver = require('../models/Driver');
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

// Helper to get model safely (supports both req.models and model_loader)
const getModelSafe = (modelName, req, fallbackModel) => {
  if (req.models && req.models[modelName]) return req.models[modelName];
  try {
    const { getModel } = require('../utils/model_loader');
    return getModel(modelName, req);
  } catch (err) {
    return fallbackModel;
  }
};

// @route   GET /api/drivers
// @desc    Get all drivers
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.portal === 'B2B') filter.type = 'b2b';
    if (req.portal === 'B2C') filter.type = 'b2c';

    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const drivers = await aggregateGET('Driver', req, filter);
      res.json(drivers);
    } else {
      const DriverModel = getModelSafe('Driver', req, Driver);
      const drivers = await DriverModel.find(filter);
      res.json(drivers);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/drivers
// @desc    Create a driver profile
router.post('/', protect, async (req, res) => {
  const { name, phone, email, password, licenseNumber, vehicleDetails, type, cashManagement, documents, vehicleNo, drivingLicense, aadharNumber } = req.body;
  try {
    const DriverModel = getModelSafe('Driver', req, Driver);
    
    // Hash password manually before creating to ensure it is encrypted
    let hashedPassword = password;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password, salt);
    }
    
    const driverData = { name, phone, password: hashedPassword, licenseNumber, vehicleDetails, cashManagement, vehicleNo, drivingLicense, aadharNumber };
    if (email && email.trim() !== '') driverData.email = email;
    if (type) driverData.type = type.toLowerCase();
    if (documents) {
      driverData.documents = documents.filter(d => d.url && d.validityDate);
    }

    const driver = await DriverModel.create(driverData);
    res.status(201).json(driver);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/drivers/location
// @desc    Update driver live location
// @access  Private (Driver only)
router.post('/location', protect, async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ message: 'Latitude and Longitude are required' });
  }
  try {
    const DriverModel = getModelSafe('Driver', req, Driver);
    const OrderModel = getModelSafe('Order', req, Order);
    
    const activeOrder = await OrderModel.findOne({
      driverId: req.user._id,
      orderStatus: { $in: ['Picked Up', 'Out for Delivery'] }
    });

    const driver = await DriverModel.findByIdAndUpdate(
      req.user._id,
      { 
        currentLocation: { 
          lat, 
          lng, 
          updatedAt: new Date() 
        } 
      },
      { returnDocument: 'after' }
    );
    
    res.json({ 
      message: 'Location updated successfully', 
      currentLocation: driver.currentLocation,
      activeTrip: Boolean(activeOrder),
      orderId: activeOrder?._id || null
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/drivers/attendance/mark
// @desc    Mark attendance for the current day
// @access  Private (Driver only)
router.post('/attendance/mark', protect, async (req, res) => {
  try {
    const AttendanceModel = getModelSafe('Attendance', req, null);
    if (!AttendanceModel) return res.status(500).json({ message: 'Attendance model not found' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let attendance = await AttendanceModel.findOne({ driverId: req.user._id, date: today });
    if (attendance) {
      return res.status(400).json({ message: 'Attendance already marked for today' });
    }

    attendance = new AttendanceModel({
      driverId: req.user._id,
      date: today,
      status: 'Present',
      checkInTime: new Date(),
    });

    await attendance.save();
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/drivers/attendance
// @desc    Get driver attendance history (last 7 days) from database
// @access  Private (Driver only)
router.get('/attendance', protect, async (req, res) => {
  try {
    const AttendanceModel = getModelSafe('Attendance', req, null);
    const OrderModel = getModelSafe('Order', req, Order);
    if (!AttendanceModel) return res.status(500).json({ message: 'Attendance model not found' });

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    const attendanceHistory = [];
    
    // Loop through the last 7 days (including today as index 0)
    for (let i = 0; i < 7; i++) {
      const endOfDay = new Date(today);
      endOfDay.setDate(endOfDay.getDate() - i);
      
      const startOfDay = new Date(endOfDay);
      startOfDay.setHours(0, 0, 0, 0);
      
      const record = await AttendanceModel.findOne({
        driverId: req.user._id,
        date: { $gte: startOfDay, $lte: endOfDay }
      });

      let deliveriesCount = 0;
      if (OrderModel) {
        deliveriesCount = await OrderModel.countDocuments({
          driverId: req.user._id,
          orderStatus: 'Delivered',
          updatedAt: { $gte: startOfDay, $lte: endOfDay }
        });
      }
      
      attendanceHistory.push({
        date: startOfDay.toISOString(),
        deliveriesCompleted: record && record.deliveriesCompleted !== undefined ? record.deliveriesCompleted : deliveriesCount,
        status: record ? record.status : 'Absent',
        checkInTime: record ? record.checkInTime : null,
        target: 5
      });
    }
    
    res.json(attendanceHistory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/drivers/:id/location
// @desc    Fetch driver's current location (Admin only)
// @access  Private (Admin only)
router.get('/:id/location', protect, async (req, res) => {
  if (!req.admin && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can fetch driver location directly' });
  }
  try {
    const DriverModel = getModelSafe('Driver', req, Driver);
    const OrderModel = getModelSafe('Order', req, Order);

    const activeOrder = await OrderModel.findOne({
      driverId: req.params.id,
      orderStatus: { $in: ['Picked Up', 'Out for Delivery'] }
    });

    const driver = await DriverModel.findById(req.params.id);
    if (!driver) return res.status(404).json({ message: 'Driver not found' });

    if (!driver.currentLocation || driver.currentLocation.lat == null) {
      return res.status(404).json({ message: 'Driver location not available' });
    }

    res.json({
      lat: driver.currentLocation.lat,
      lng: driver.currentLocation.lng,
      updatedAt: driver.currentLocation.updatedAt,
      activeTrip: Boolean(activeOrder),
      orderId: activeOrder?._id || null
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/drivers/:id
// @desc    Update a driver profile (e.g., wallet balance, password)
router.put('/:id', protect, async (req, res) => {
  try {
    if (req.body.type) req.body.type = req.body.type.toLowerCase();
    const DriverModel = getModelSafe('Driver', req, Driver);
    const driver = await DriverModel.findById(req.params.id);
    if (!driver) return res.status(404).json({ message: 'Driver not found' });
    
    // Assign fields (skip password to hash manually)
    Object.keys(req.body).forEach(key => {
      if (key !== 'password') {
        driver[key] = req.body[key];
      }
    });

    // Hash password manually before saving to ensure it is encrypted
    if (req.body.password) {
      const salt = await bcrypt.genSalt(10);
      driver.password = await bcrypt.hash(req.body.password, salt);
    }
    
    await driver.save();
    res.json(driver);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/drivers/:id/attendance
// @desc    Get a specific driver's attendance history (last 7 days) (Admin only)
// @access  Private (Admin only)
router.get('/:id/attendance', protect, async (req, res) => {
  if (!req.admin && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can fetch driver attendance history directly' });
  }
  try {
    const AttendanceModel = getModelSafe('Attendance', req, null);
    if (!AttendanceModel) return res.status(500).json({ message: 'Attendance model not found' });

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    const attendanceHistory = [];
    
    // Loop through the last 7 days (including today as index 0)
    for (let i = 0; i < 7; i++) {
      const endOfDay = new Date(today);
      endOfDay.setDate(endOfDay.getDate() - i);
      
      const startOfDay = new Date(endOfDay);
      startOfDay.setHours(0, 0, 0, 0);
      
      const attendanceDoc = await AttendanceModel.findOne({
        driverId: req.params.id,
        date: { $gte: startOfDay, $lte: endOfDay }
      });
      
      attendanceHistory.push({
        date: startOfDay.toISOString(),
        deliveriesCompleted: attendanceDoc ? (attendanceDoc.deliveriesCompleted || 0) : 0,
        status: attendanceDoc ? (attendanceDoc.status || 'Absent') : 'Absent',
        target: 5
      });
    }
    
    res.json(attendanceHistory);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/drivers/:id
// @desc    Delete a driver
router.delete('/:id', protect, async (req, res) => {
  try {
    const DriverModel = getModelSafe('Driver', req, Driver);
    const driver = await DriverModel.findById(req.params.id);
    if (!driver) return res.status(404).json({ message: 'Driver not found' });
    
    await DriverModel.findByIdAndDelete(req.params.id);
    res.json({ message: 'Driver deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
