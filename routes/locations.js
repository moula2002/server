const express = require('express');
const router = express.Router();
const Location = require('../models/Location');
const Pincode = require('../models/Pincode');
const { protect, superAdmin } = require('../middleware/auth');
const { syncToCentral, removeFromCentral } = require('../utils/tenancy');
const mongoose = require('mongoose');

// @route   GET /api/locations/active
// @desc    Get all active locations (Public for login)
// @access  Public
router.get('/active', async (req, res) => {
  try {
    const conn = await getCentralConn();
    const CentralLocation = conn.models['Location'] || conn.model('Location', require('../models/Location').schema);
    const locations = await CentralLocation.find({ isActive: true });
    res.json(locations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/locations/:id/pincodes
// @desc    Get pincodes for a specific location (from tenant DB)
router.get('/:id/pincodes', protect, async (req, res) => {
  try {
    const location = await Location.findById(req.params.id);
    if (!location) return res.status(404).json({ message: 'Location not found' });

    const cityClean = location.city.toLowerCase().replace(/\s+/g, '-');
    const dbName = `zudo-${cityClean}`;
    const { connectDBByLocation } = require('../utils/db_manager');
    const tenantConn = await connectDBByLocation(req.params.id, dbName);
    
    const PincodeModel = tenantConn.models.Pincode || tenantConn.model('Pincode', Pincode.schema);
    const pincodes = await PincodeModel.find({ isActive: true }).lean();
    
    // Ensure unique pincodes by code
    const uniquePincodes = [];
    const seen = new Set();
    for (const pc of pincodes) {
      if (!seen.has(pc.code)) {
        seen.add(pc.code);
        uniquePincodes.push(pc);
      }
    }
    
    res.json(uniquePincodes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

let centralConn;
const getCentralConn = async () => {
  if (centralConn) return centralConn;
  const mongoose = require('mongoose');
  const URI = process.env.MONGODB_URI;
  const lastSlashIndex = URI.lastIndexOf('/');
  const lastQuestionIndex = URI.indexOf('?', lastSlashIndex);
  const CENTRAL_URI = URI.substring(0, lastSlashIndex + 1) + 'zudo-central' + (lastQuestionIndex !== -1 ? URI.substring(lastQuestionIndex) : '');
  centralConn = await mongoose.createConnection(CENTRAL_URI).asPromise();
  return centralConn;
};

// @route   GET /api/locations
// @desc    Get all locations from zudo-central
// @access  Public (Used by Login screen)
router.get('/', async (req, res) => {
  try {
    const conn = await getCentralConn();
    const CentralLocation = conn.models['Location'] || conn.model('Location', require('../models/Location').schema);
    
    const locations = await CentralLocation.find();
    res.json(locations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/locations
// @desc    Create a new location
// @access  Private/SuperAdmin
router.post('/', protect, superAdmin, async (req, res) => {
  try {
    const data = { ...req.body };

    if (!data.city) {
      return res.status(400).json({ message: 'City is required' });
    }
    if (!data.state) {
      return res.status(400).json({ message: 'State is required' });
    }

    // Clean up city name: lower case, hyphenated, and strip any existing 'zudo-' prefix
    let cityClean = data.city.trim().toLowerCase().replace(/\s+/g, '-');
    while (cityClean.startsWith('zudo-')) {
      cityClean = cityClean.replace('zudo-', '');
    }
    const dbName = `zudo-${cityClean}`;

    if (!data.name) {
      data.name = dbName;
    }

    // Ensure pincode is a string for the main DB model
    let pincodeString = '';
    if (Array.isArray(data.pincode)) {
      pincodeString = data.pincode.join(', ');
    } else {
      pincodeString = data.pincode || '';
    }
    data.pincode = pincodeString;

    // 1. Save/Upsert in central database (zudo-central) so it can be resolved by tenancy logic
    const centralConn = await getCentralConn();
    const CentralLocation = centralConn.models.Location || centralConn.model('Location', Location.schema);
    
    // Check if it already exists in central to get/preserve the existing _id
    let centralLoc = await CentralLocation.findOne({ city: data.city });
    if (centralLoc) {
      centralLoc = await CentralLocation.findByIdAndUpdate(centralLoc._id, data, { returnDocument: 'after' });
    } else {
      centralLoc = await CentralLocation.create(data);
    }

    // 2. Sync to current default DB (for admin tracking / backward compatibility)
    // Make sure we use the same _id so they match!
    const locationData = { _id: centralLoc._id, ...data };
    const location = await Location.findOneAndUpdate(
      { city: data.city },
      locationData,
      { upsert: true, returnDocument: 'after' }
    );

    // 3. Create/Switch to the new DB and save location there too
    const newConn = mongoose.connection.useDb(dbName, { useCache: true });
    const NewLocation = newConn.model('Location', Location.schema);
    const NewPincode = newConn.model('Pincode', Pincode.schema);

    // Upsert location in new DB
    const locInNewDb = await NewLocation.findOneAndUpdate(
      { city: data.city },
      locationData,
      { upsert: true, returnDocument: 'after' }
    );

    // 4. Create Pincode documents in the new DB
    const pcList = Array.isArray(req.body.pincode)
      ? req.body.pincode
      : (req.body.pincode || '').split(',').map(p => p.trim());

    const pincodeDocs = pcList.filter(pc => pc).map(pc => ({
      code: pc,
      locationId: locInNewDb._id,
      isActive: true
    }));

    if (pincodeDocs.length > 0) {
      await NewPincode.deleteMany({ locationId: locInNewDb._id });
      await NewPincode.insertMany(pincodeDocs);
    }

    // 5. Seed the new database with default data (Admin, Category, etc.)
    try {
      const { seedLocationDB } = require('../utils/db_seeder');
      await seedLocationDB(newConn, location._id.toString());
    } catch (seedError) {
      console.error('Non-blocking Seed Error:', seedError);
      // We don't block the whole response for seeding errors
    }

    // 6. Sync with Central Mapping
    try {
      await syncToCentral(data.city, dbName, pcList);
    } catch (syncError) {
      console.error('Non-blocking Sync Error:', syncError);
      // We don't block the whole response for central sync errors
    }

    res.status(201).json(location);
  } catch (error) {
    console.error('Location Creation Error:', error);
    res.status(400).json({ message: error.message || 'Error creating location' });
  }
});

// @route   PUT /api/locations/:id
// @desc    Update a location
// @access  Private/SuperAdmin
router.put('/:id', protect, superAdmin, async (req, res) => {
  try {
    const data = { ...req.body };

    // Clean up city name if present in updates
    if (data.city) {
      let cityClean = data.city.trim().toLowerCase().replace(/\s+/g, '-');
      while (cityClean.startsWith('zudo-')) {
        cityClean = cityClean.replace('zudo-', '');
      }
      const dbName = `zudo-${cityClean}`;
      if (!data.name) {
        data.name = dbName;
      }
    }

    // 1. Update in central database (zudo-central)
    const centralConn = await getCentralConn();
    const CentralLocation = centralConn.models.Location || centralConn.model('Location', Location.schema);
    const location = await CentralLocation.findByIdAndUpdate(req.params.id, data, { returnDocument: 'after' });
    if (!location) return res.status(404).json({ message: 'Location not found' });

    // Also update in default DB (for admin tracking)
    await Location.findByIdAndUpdate(req.params.id, data, { returnDocument: 'after' });

    // Sync changes to specific DB
    const cityClean = location.city.toLowerCase().replace(/\s+/g, '-');
    const dbName = `zudo-${cityClean}`;

    const newConn = mongoose.connection.useDb(dbName, { useCache: true });
    const NewLocation = newConn.model('Location', Location.schema);
    const NewPincode = newConn.model('Pincode', Pincode.schema);

    const locInNewDb = await NewLocation.findOneAndUpdate(
      { city: location.city },
      data,
      { upsert: true, returnDocument: 'after' }
    );

    if (data.pincode) {
      const pcList = data.pincode.split(',').map(p => p.trim());
      const pincodeDocs = pcList.map(pc => ({
        code: pc,
        locationId: locInNewDb._id,
        isActive: true
      }));

      await NewPincode.deleteMany({ locationId: locInNewDb._id });
      await NewPincode.insertMany(pincodeDocs);

      await syncToCentral(location.city, dbName, data.pincode);
    }

    res.json(location);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/locations/:id
// @desc    Permanently delete a location from central, default, and tenant DBs
// @access  Private/SuperAdmin
router.delete('/:id', protect, superAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid location ID' });
    }

    const centralConn = await getCentralConn();
    const CentralLocation = centralConn.models.Location || centralConn.model('Location', Location.schema);

    const location = await CentralLocation.findById(req.params.id);
    if (!location) {
      return res.status(404).json({ message: 'Location not found' });
    }

    let cityClean = (location.city || '').trim().toLowerCase().replace(/\s+/g, '-');
    while (cityClean.startsWith('zudo-')) {
      cityClean = cityClean.replace('zudo-', '');
    }
    const dbName = location.name || `zudo-${cityClean}`;
    const { connectDBByLocation } = require('../utils/db_manager');
    const tenantConn = await connectDBByLocation(req.params.id, dbName);

    // Check for dependent operational records before deleting (unless ?force=true)
    if (req.query.force !== 'true') {
      const counts = {};
      const modelsToCheck = [
        { name: 'Order', schema: require('../models/Order').schema, label: 'orders' },
        { name: 'Seller', schema: require('../models/Seller').schema, label: 'sellers' },
        { name: 'Driver', schema: require('../models/Driver').schema, label: 'drivers' },
        { name: 'CashCollector', schema: require('../models/CashCollector').schema, label: 'cash collections' }
      ];

      for (const m of modelsToCheck) {
        try {
          const Model = tenantConn.models[m.name] || tenantConn.model(m.name, m.schema);
          const count = await Model.countDocuments();
          if (count > 0) counts[m.label] = count;
        } catch (e) {
          // ignore if collection doesn't exist
        }
      }

      const depEntries = Object.entries(counts);
      if (depEntries.length > 0) {
        const summary = depEntries.map(([label, c]) => `${c} ${label}`).join(', ');
        return res.status(400).json({
          message: `Cannot delete "${location.city}": it has dependent records (${summary}).`,
          dependencies: counts
        });
      }
    }

    // 1. Remove pincode mapping from central
    if (location.pincode) {
      await removeFromCentral(location.pincode);
    }

    // 2. Delete from central DB (zudo-central)
    await CentralLocation.findByIdAndDelete(req.params.id);

    // 3. Delete from default DB
    await Location.findByIdAndDelete(req.params.id);
    await Location.deleteMany({ city: location.city });

    // 4. Delete location and pincode records from tenant DB
    try {
      const TenantLocation = tenantConn.models.Location || tenantConn.model('Location', Location.schema);
      const TenantPincode = tenantConn.models.Pincode || tenantConn.model('Pincode', Pincode.schema);
      await TenantLocation.deleteMany({ $or: [{ _id: location._id }, { city: location.city }] });
      await TenantPincode.deleteMany({ locationId: location._id });
    } catch (tenantErr) {
      console.warn('[Location Delete] Tenant cleanup warning:', tenantErr.message);
    }

    res.json({ message: 'Location permanently deleted', deletedId: req.params.id });
  } catch (error) {
    console.error('Location Deletion Error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
