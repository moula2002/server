const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const {
  processProductPricing,
  applyCommission,
  calculateCustomerPrice,
  findCategoryCommission,
  calculatePricingBreakdown,
  round2,
  extractUnitSize,
  convertMeasurement,
  normalizeUnit
} = require('../utils/pricing');

// Helper to get models from req
const { getModel } = require('../utils/model_loader');
const getModels = (req) => ({
  Product: getModel('Product', req),
  Category: getModel('Category', req),
  SubCategory: getModel('SubCategory', req),
  Seller: getModel('Seller', req),
  User: getModel('User', req)
});

// Helper to gather all database connections in cluster (tenant-aware fallback)
const getAllDbConnections = async (req = null) => {
  const { connectDBByLocation, getTenantConnections } = require('../utils/db_manager');
  const connectionsMap = new Map();

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    connectionsMap.set(mongoose.connection.name || 'default', mongoose.connection);
  }

  if (req?.db && req.db.readyState === 1) {
    connectionsMap.set(req.db.name || 'scoped', req.db);
  }

  const cachedConns = getTenantConnections();
  for (const [key, conn] of Object.entries(cachedConns)) {
    if (conn && conn.readyState === 1) {
      connectionsMap.set(conn.name || key, conn);
    }
  }

  const baseTenants = ['zudo-bengaluru', 'zudo-bangalore', 'zudo-central', 'zudodb'];
  for (const name of baseTenants) {
    try {
      const conn = await connectDBByLocation(name, name);
      if (conn && conn.readyState === 1) {
        connectionsMap.set(conn.name || name, conn);
      }
    } catch (e) {}
  }

  try {
    const centralConn = connectionsMap.get('zudo-central') || connectionsMap.get('zudo-bengaluru');
    if (centralConn) {
      const LocationModel = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      const locs = await LocationModel.find({ isActive: true }).lean();
      for (const l of locs) {
        if (l.city) {
          const dbName = `zudo-${l.city.toLowerCase().replace(/\s+/g, '-')}`;
          if (!connectionsMap.has(dbName)) {
            try {
              const conn = await connectDBByLocation(l._id ? l._id.toString() : dbName, dbName);
              if (conn && conn.readyState === 1) {
                connectionsMap.set(conn.name || dbName, conn);
              }
            } catch (ce) {}
          }
        }
      }
    }
  } catch (e) {}

  return Array.from(connectionsMap.values());
};

// Helper to find a product across tenants if not found in current scoped connection
async function findProductAcrossTenants(productId, req, populate = true) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return null;
  }
  const allConns = await getAllDbConnections(req);
  for (const conn of allConns) {
    try {
      const Model = conn.models.Product || conn.model('Product', require('../models/Product').schema);
      let query = Model.findById(productId);
      if (populate) {
        query = query.populate('categoryId').populate('subCategoryId');
      }
      const item = await query.lean();
      if (item) {
        return { product: item, conn, Model };
      }
    } catch (err) {}
  }
  return null;
}

// Helper: Load all commissions from DB (tenant-aware)
async function loadCommissions(req) {
  try {
    let comms = [];
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      comms = await aggregateGET('Commission', req, {}, 'categoryId');
      if (comms && comms.length > 0) return comms;
    }

    // Direct collection query from tenant DB or req.db
    const activeDb = (req.db && req.db.db) ? req.db.db : (req.db && typeof req.db.collection === 'function' ? req.db : null);
    if (activeDb) {
      try {
        const rawComms = await activeDb.collection('commissions').find().toArray();
        if (rawComms && rawComms.length > 0) {
          const categories = await activeDb.collection('categories').find().toArray();
          const catMap = new Map(categories.map(c => [c._id.toString(), c]));
          return rawComms.map(c => ({
            ...c,
            categoryId: c.categoryId ? (catMap.get(c.categoryId.toString()) || c.categoryId) : null
          }));
        }
      } catch (err) {
        console.error('[commissions] Direct db.collection failed:', err.message);
      }
    }

    const { getModel } = require('../utils/model_loader');
    const Commission = getModel('Commission', req);
    if (Commission) {
      comms = await Commission.find().populate('categoryId').lean();
      if (comms && comms.length > 0) return comms;
    }

    return [];
  } catch (e) {
    console.error('[commissions] Failed to load:', e.message);
    return [];
  }
}

// Helper: Re-calculate all products with current commission rules
async function applyCommissionToAllProducts(req) {
  const commissions = await loadCommissions(req);
  if (!commissions || commissions.length === 0) return { updatedCount: 0, logs: [] };

  let totalUpdated = 0;

  const updateProductList = async (ProductModel) => {
    if (!ProductModel) return 0;
    const products = await ProductModel.find().lean();
    let count = 0;
    for (const p of products) {
      const updated = applyCommission(p, commissions);
      if (
        updated.price !== p.price ||
        updated.b2bPrice !== p.b2bPrice ||
        updated.sellerPrice !== p.sellerPrice ||
        updated.commissionValue !== p.commissionValue ||
        updated.commissionType !== p.commissionType ||
        updated.commissionAmount !== p.commissionAmount
      ) {
        await ProductModel.findByIdAndUpdate(p._id, {
          sellerPrice: updated.sellerPrice,
          sellerUnitPrice: updated.sellerPrice,
          sellerB2bPrice: updated.sellerB2bPrice,
          sellerPricePerBaseUnit: updated.sellerPricePerBaseUnit,
          productMeasurementUnit: updated.productMeasurementUnit,
          measurementUnit: updated.measurementUnit,
          sellerPricePerProductUnit: updated.sellerPricePerProductUnit,
          adminCommissionPerBaseUnit: updated.adminCommissionPerBaseUnit,
          commissionPerProductUnit: updated.commissionPerProductUnit,
          customerUnitBasePrice: updated.customerUnitBasePrice,
          gstAmountPerProductUnit: updated.gstAmountPerProductUnit,
          customerFinalPricePerProductUnit: updated.customerFinalPricePerProductUnit,
          totalStockWeight: updated.totalStockWeight,
          totalStockCommission: updated.totalStockCommission,
          totalSellerStockValue: updated.totalSellerStockValue,
          totalStockSubtotal: updated.totalStockSubtotal,
          totalStockValuation: updated.totalStockValuation,
          commissionType: updated.commissionType,
          commissionValue: updated.commissionValue,
          commissionRate: updated.commissionValue,
          commissionAmount: updated.commissionAmount,
          unitCommission: updated.commissionAmount,
          stockTotalCommission: updated.stockTotalCommission,
          subtotal: updated.subtotal,
          stockSubtotal: updated.stockSubtotal,
          gstAmount: updated.gstAmount,
          sellerGstAmount: updated.sellerGstAmount,
          stockGstAmount: updated.stockGstAmount,
          totalAmount: updated.totalAmount,
          stockTotalAmount: updated.stockTotalAmount,
          isGstInclusive: updated.isGstInclusive,
          unitCustomerPrice: updated.price,
          price: updated.price,
          b2bPrice: updated.b2bPrice,
          b2c: updated.b2c,
          b2b: updated.b2b,
          priceTiers: updated.priceTiers
        });
        count++;
      }
    }
    return count;
  };

  if (!req.locationId) {
    try {
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
          const TenantProduct = connection.models.Product || connection.model('Product', require('../models/Product').schema);
          totalUpdated += await updateProductList(TenantProduct);
        } catch (e) {
          console.error(`Failed to update products for tenant ${loc.city}:`, e.message);
        }
      }
    } catch (e) {}
  } else {
    const { Product } = getModels(req);
    totalUpdated += await updateProductList(Product);
  }

  return { updatedCount: totalUpdated, logs: [`Applied commissions to ${totalUpdated} products.`] };
}

module.exports.loadCommissions = loadCommissions;
module.exports.applyCommission = applyCommission;
module.exports.applyCommissionToAllProducts = applyCommissionToAllProducts;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.jfif') {
      ext = '.jpeg';
    }
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WEBP and PDF are allowed.'));
    }
  }
});

// @route   GET /api/products
// @desc    Get all products
router.get('/', async (req, res) => {
  const fs = require('fs');
  fs.appendFileSync('debug-products.txt', `[DEBUG-PRODUCTS] GET /api/products hit! locationId: ${req.locationId}, dbName: ${req.dbName}\n`);
  try {
    let productsWithSeller = [];
    const commissions = await loadCommissions(req);

    // Check if request is from an authenticated admin
    let isAdmin = false;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          const Admin = require('../models/Admin');
          const adminAcc = await Admin.findById(decoded.id);
          if (adminAcc) isAdmin = true;
        }
      } catch (e) {}
    }

    const filter = {};
    if (req.portal === 'B2B') filter.b2b = { $exists: true, $not: { $size: 0 } };
    if (req.portal === 'B2C') filter.b2c = { $exists: true, $not: { $size: 0 } };
    if (!isAdmin) {
      filter.isProductVisible = { $ne: false };
    }
    if (req.query.sellerId) {
      const sId = req.query.sellerId;
      const sObjId = mongoose.Types.ObjectId.isValid(sId) ? new mongoose.Types.ObjectId(sId) : null;
      filter.$or = [
        { sellerId: sId },
        ...(sObjId ? [{ sellerId: sObjId }] : []),
        { 'seller._id': sId },
        ...(sObjId ? [{ 'seller._id': sObjId }] : [])
      ];
    }

    if (!req.locationId) {
      // Global Access - Aggregate from all active tenant databases!
      const { aggregateGET } = require('../utils/aggregator');
      const products = await aggregateGET('Product', req, filter, ['categoryId', 'subCategoryId']);

      productsWithSeller = await Promise.all(products.map(async (p) => {
        let enriched = { ...p, sellerName: 'Zudo Official' };
        if (p.sellerId) {
          try {
            const { connectDBByLocation } = require('../utils/db_manager');
            const cityClean = p.locationName.toLowerCase().replace(/\s+/g, '-');
            const dbName = `zudo-${cityClean}`;
            const tenantConn = await connectDBByLocation(p.locationId.toString(), dbName);
            const TenantSeller = tenantConn.models.Seller || tenantConn.model('Seller', require('../models/Seller').schema);
            const TenantUser = tenantConn.models.User || tenantConn.model('User', require('../models/User').schema);

            let seller = await TenantSeller.findById(p.sellerId).select('businessName storeName name gstNumber panNumber');
            if (!seller) {
              seller = await TenantUser.findById(p.sellerId).select('businessName name gstNumber');
            }

            if (seller) {
              const sName = seller.businessName || seller.storeName || seller.name || 'Zudo Official';
              const sGst = seller.gstNumber || null;
              enriched = {
                ...p,
                sellerName: sName,
                sellerGstNumber: sGst,
                sellerId: {
                  _id: p.sellerId,
                  businessName: sName,
                  name: seller.name,
                  gstNumber: sGst
                }
              };
            }
          } catch (e) {
            console.error('Error fetching seller in global access:', e);
          }
        }
        return applyCommission(enriched, commissions);
      }));
    } else {
      const { Product, Seller, User } = getModels(req);
      const products = await Product.find(filter)
        .populate('categoryId')
        .populate('subCategoryId')
        .lean();

      fs.appendFileSync('debug-products.txt', `[DEBUG-PRODUCTS] DB: ${Product.db ? Product.db.name : 'unknown'}, Collection: ${Product.collection.collectionName}, Count: ${products.length}\n`);

      productsWithSeller = await Promise.all(products.map(async (p) => {
        let enriched = { ...p, sellerName: 'Zudo Official' };

        if (p.sellerId) {
          try {
            let seller = await Seller.findById(p.sellerId).select('businessName storeName name gstNumber panNumber');
            if (!seller) {
              const db = mongoose.connection.db;
              const sellerCollection = db.collection('sellers');
              seller = await sellerCollection.findOne({
                _id: p.sellerId instanceof mongoose.Types.ObjectId ? p.sellerId : new mongoose.Types.ObjectId(p.sellerId)
              });
            }
            if (!seller) {
              seller = await User.findById(p.sellerId).select('businessName name gstNumber');
            }

            if (seller) {
              const sName = seller.businessName || seller.storeName || seller.name || 'Zudo Official';
              const sGst = seller.gstNumber || null;
              enriched = {
                ...p,
                sellerName: sName,
                sellerGstNumber: sGst,
                sellerId: {
                  _id: p.sellerId,
                  businessName: sName,
                  name: seller.name,
                  gstNumber: sGst
                }
              };
            }
          } catch (e) {
            console.error('Error fetching seller for product:', e);
          }
        }
        return applyCommission(enriched, commissions);
      }));
    }

    if (!isAdmin) {
      productsWithSeller = productsWithSeller.filter(p => p.isProductVisible !== false && p.sellerId?.isProductVisible !== false);
    }
    res.json(productsWithSeller);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/products/custom-units
// @desc    Get all custom packaging and measurement units for the authenticated seller
router.get('/custom-units', async (req, res) => {
  try {
    const { Product, Seller } = getModels(req);
    let sellerId = null;

    // Optional extraction from auth header if present
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          sellerId = decoded.id;
        }
      } catch (e) {}
    }
    if (!sellerId && req.query.sellerId) {
      sellerId = req.query.sellerId;
    }

    let sellerPackagingCustom = [];
    let sellerMeasurementCustom = [];

    // 1. Fetch from Seller profile if available
    if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
      try {
        const sellerDoc = await Seller.findById(sellerId).select('customUnits customPackagingUnits customMeasurementUnits customVariantUnits').lean();
        if (sellerDoc) {
          if (Array.isArray(sellerDoc.customPackagingUnits)) {
            sellerPackagingCustom.push(...sellerDoc.customPackagingUnits);
          }
          if (Array.isArray(sellerDoc.customUnits)) {
            sellerPackagingCustom.push(...sellerDoc.customUnits);
          }
          if (Array.isArray(sellerDoc.customMeasurementUnits)) {
            sellerMeasurementCustom.push(...sellerDoc.customMeasurementUnits);
          }
          if (Array.isArray(sellerDoc.customVariantUnits)) {
            sellerMeasurementCustom.push(...sellerDoc.customVariantUnits);
          }
        }
      } catch (e) {}
    }

    // 2. Fetch distinct custom units from products belonging to this seller
    const productFilter = sellerId && mongoose.Types.ObjectId.isValid(sellerId) ? { sellerId } : {};
    try {
      const prods = await Product.find(productFilter).select('unit packagingType measurementBasis measurementUnit customUnits customPackagingUnits customMeasurementUnits b2b').lean();

      const BUILTIN_PKG = new Set(['BAG', 'BOX', 'bag', 'box']);
      const BUILTIN_MEAS = new Set(['BAG', 'BOX', 'bag', 'box']);

      for (const p of prods) {
        // Packaging from product fields
        const pPkg = String(p.packagingType || p.unit || '').trim().toUpperCase();
        if (pPkg && !BUILTIN_PKG.has(pPkg)) {
          sellerPackagingCustom.push(pPkg);
        }
        if (Array.isArray(p.customPackagingUnits)) {
          sellerPackagingCustom.push(...p.customPackagingUnits.map(u => String(u || '').trim().toUpperCase()));
        }
        if (Array.isArray(p.customUnits)) {
          sellerPackagingCustom.push(...p.customUnits.map(u => String(u || '').trim().toUpperCase()));
        }

        // Measurement from product fields
        const pMeas = String(p.measurementBasis || p.measurementUnit || '').trim().toUpperCase();
        if (pMeas && !BUILTIN_MEAS.has(pMeas)) {
          sellerMeasurementCustom.push(pMeas);
        }
        if (Array.isArray(p.customMeasurementUnits)) {
          sellerMeasurementCustom.push(...p.customMeasurementUnits.map(u => String(u || '').trim().toUpperCase()));
        }

        // Inspect variants
        if (Array.isArray(p.b2b)) {
          for (const v of p.b2b) {
            if (v) {
              if (v.packagingType) {
                const vp = String(v.packagingType).trim().toUpperCase();
                if (vp && !BUILTIN_PKG.has(vp)) {
                  sellerPackagingCustom.push(vp);
                }
              }
              if (v.packetSizeUnit) {
                const vm = String(v.packetSizeUnit).trim().toUpperCase();
                if (vm && !BUILTIN_MEAS.has(vm)) {
                  sellerMeasurementCustom.push(vm);
                }
              } else if (v.packetSize) {
                const valMatch = String(v.packetSize).match(/^[\d\.]+/);
                const val = valMatch ? valMatch[0] : '';
                const unit = String(v.packetSize).slice(val.length).trim().toUpperCase();
                if (unit && !BUILTIN_MEAS.has(unit)) {
                  sellerMeasurementCustom.push(unit);
                }
              }
            }
          }
        }
      }
    } catch (e) {}

    const BUILTIN_PKG_SET = new Set(['BAG', 'BOX']);
    const cleanPackaging = Array.from(new Set(sellerPackagingCustom))
      .filter(u => u && !BUILTIN_PKG_SET.has(u));

    const BUILTIN_MEAS_SET = new Set(['BAG', 'BOX']);
    const cleanMeasurement = Array.from(new Set(sellerMeasurementCustom))
      .filter(u => u && !BUILTIN_MEAS_SET.has(u));

    res.json({
      mainUnits: cleanPackaging,         // Backward-compatible for packaging
      packagingUnits: cleanPackaging,    // Explicit packaging
      measurementUnits: cleanMeasurement,// Explicit measurement
      variantUnits: cleanMeasurement     // Backward-compatible alias
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products/custom-units
// @desc    Add a new custom unit (packaging or measurement)
router.post('/custom-units', async (req, res) => {
  try {
    const { unit, type } = req.body;
    if (!unit || typeof unit !== 'string' || !unit.trim()) {
      return res.status(400).json({ message: 'Unit name is required and cannot be empty' });
    }
    const cleanUnit = unit.trim().toUpperCase();

    // Determine category: 'packaging' or 'measurement'
    const isMeasurement = type === 'measurement' || type === 'variant';
    const isPackaging = !isMeasurement;

    // Validate against built-in units
    const DEFAULT_PACKAGING = ['BAG', 'BOX'];
    if (isPackaging && DEFAULT_PACKAGING.includes(cleanUnit)) {
      return res.status(400).json({ message: `"${cleanUnit}" is already a default packaging type` });
    }

    const DEFAULT_MEASUREMENTS = ['BAG', 'BOX'];
    if (isMeasurement && DEFAULT_MEASUREMENTS.includes(cleanUnit)) {
      return res.status(400).json({ message: `"${cleanUnit}" is already a default measurement unit` });
    }

    const { Seller } = getModels(req);
    let sellerId = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          sellerId = decoded.id;
        }
      } catch (e) {}
    }
    if (!sellerId && req.body.sellerId) {
      sellerId = req.body.sellerId;
    }

    // Persist to Seller document if identified
    if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
      try {
        const updateField = isMeasurement
          ? { customMeasurementUnits: cleanUnit, customVariantUnits: cleanUnit }
          : { customPackagingUnits: cleanUnit, customUnits: cleanUnit };
        await Seller.findByIdAndUpdate(sellerId, { $addToSet: updateField });
      } catch (e) {
        console.error('Failed to persist custom unit to seller profile:', e.message);
      }
    }

    res.status(201).json({
      success: true,
      message: `Custom ${isMeasurement ? 'measurement unit' : 'packaging type'} "${cleanUnit}" added successfully`,
      unit: cleanUnit,
      type: isMeasurement ? 'measurement' : 'packaging'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/products/custom-units
// @desc    Delete a custom unit (packaging or measurement) after verifying it is not in use
router.delete('/custom-units', async (req, res) => {
  try {
    const { unit, type } = req.body;
    if (!unit || typeof unit !== 'string' || !unit.trim()) {
      return res.status(400).json({ message: 'Unit name is required' });
    }
    const cleanUnit = unit.trim().toUpperCase();

    // Guard against deleting permanent defaults
    const DEFAULT_PACKAGING = ['BAG', 'BOX'];
    if (DEFAULT_PACKAGING.includes(cleanUnit)) {
      return res.status(400).json({ message: `Cannot delete permanent default packaging "${cleanUnit}"` });
    }
    const DEFAULT_MEASUREMENTS = ['BAG', 'BOX'];
    if (DEFAULT_MEASUREMENTS.includes(cleanUnit)) {
      return res.status(400).json({ message: `Cannot delete permanent default measurement "${cleanUnit}"` });
    }

    const { Product, Seller } = getModels(req);
    let sellerId = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          sellerId = decoded.id;
        }
      } catch (e) {}
    }
    if (!sellerId && req.body.sellerId) {
      sellerId = req.body.sellerId;
    }

    const sellerQuery = sellerId && mongoose.Types.ObjectId.isValid(sellerId) ? { sellerId } : {};

    const isMeasurement = type === 'measurement' || type === 'variant';
    const isPackaging = type === 'packaging' || type === 'main' || !type;

    // 1. Check if unit is in use by any product's packaging fields
    if (isPackaging) {
      const packagingInUse = await Product.findOne({
        ...sellerQuery,
        $or: [
          { unit: { $regex: new RegExp(`^${cleanUnit}$`, 'i') } },
          { packagingType: { $regex: new RegExp(`^${cleanUnit}$`, 'i') } },
          { 'b2b.packagingType': { $regex: new RegExp(`^${cleanUnit}$`, 'i') } }
        ]
      }).select('name').lean();

      if (packagingInUse) {
        return res.status(400).json({
          message: `Cannot delete packaging type "${cleanUnit}". It is currently used by product: "${packagingInUse.name}". Please reassign or update the product first.`,
          inUse: true,
          productName: packagingInUse.name
        });
      }
    }

    // 2. Check if unit is in use by any product's measurement fields
    if (isMeasurement) {
      const variantRegex = new RegExp(`[\\d\\.]*\\s*${cleanUnit}$`, 'i');
      const measurementInUse = await Product.findOne({
        ...sellerQuery,
        $or: [
          { measurementBasis: { $regex: new RegExp(`^${cleanUnit}$`, 'i') } },
          { measurementUnit: { $regex: new RegExp(`^${cleanUnit}$`, 'i') } },
          { 'b2b.packetSizeUnit': { $regex: new RegExp(`^${cleanUnit}$`, 'i') } },
          { 'b2b.packetSize': { $regex: variantRegex } }
        ]
      }).select('name b2b').lean();

      if (measurementInUse) {
        return res.status(400).json({
          message: `Cannot delete measurement unit "${cleanUnit}". It is currently used by product: "${measurementInUse.name}". Please update the product or variant first.`,
          inUse: true,
          productName: measurementInUse.name
        });
      }
    }

    // 3. Remove from custom lists in Product documents of this seller
    await Product.updateMany(
      sellerQuery,
      {
        $pull: {
          customUnits: cleanUnit,
          customPackagingUnits: cleanUnit,
          customMeasurementUnits: cleanUnit
        }
      }
    );

    // 4. Remove from Seller document if stored there
    if (sellerId) {
      const pullUpdate = isMeasurement
        ? { customMeasurementUnits: cleanUnit, customVariantUnits: cleanUnit }
        : { customPackagingUnits: cleanUnit, customUnits: cleanUnit };
      await Seller.findByIdAndUpdate(sellerId, { $pull: pullUpdate });
    }

    res.json({
      success: true,
      message: `Custom unit "${cleanUnit}" deleted successfully`,
      deletedUnit: cleanUnit
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products
// @desc    Create a single product with image and/or pdf upload
router.post('/', protect, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, categoryId, subCategoryId, price, b2bPrice, moq, maxOrderQuantity, unit, sellerId, stock, description, gstPercent } = req.body;
    let parsedPriceTiers = [];
    let parsedB2b = [];
    let parsedB2c = [];
    try {
      if (req.body.priceTiers) parsedPriceTiers = typeof req.body.priceTiers === 'string' ? JSON.parse(req.body.priceTiers) : req.body.priceTiers;
      if (req.body.b2b) parsedB2b = typeof req.body.b2b === 'string' ? JSON.parse(req.body.b2b) : req.body.b2b;
      if (req.body.b2c) parsedB2c = typeof req.body.b2c === 'string' ? JSON.parse(req.body.b2c) : req.body.b2c;
    } catch (e) {
      console.error("Failed to parse priceTiers, b2b, or b2c", e);
    }

    // Validate and resolve Maximum Order Quantity (moq / maxOrderQuantity)
    const rawMoq = moq !== undefined && moq !== null && moq !== '' ? moq : maxOrderQuantity;
    let parsedMoq = 1;
    if (rawMoq !== undefined && rawMoq !== null && rawMoq !== '') {
      parsedMoq = parseInt(rawMoq, 10);
      if (isNaN(parsedMoq) || parsedMoq < 1) {
        return res.status(400).json({ message: 'Maximum order quantity must be an integer greater than 0' });
      }
    }

    const productionDomain = process.env.PRODUCTION_DOMAIN || 'https://snbtradingco.in';
    let imageUrl = req.body.imageUrl || '';
    if (req.files && req.files['image']) {
      imageUrl = `${productionDomain}/uploads/${req.files['image'][0].filename}`;
    }

    let pdfUrl = req.body.pdfUrl || '';
    if (req.files && req.files['pdf']) {
      pdfUrl = `${productionDomain}/uploads/${req.files['pdf'][0].filename}`;
    }
    const { Product, Seller, User } = getModels(req);

    let finalSellerName = 'Zudo Official';
    if (sellerId) {
      let seller = await Seller.findById(sellerId).select('businessName storeName name');
      if (!seller) seller = await User.findById(sellerId).select('businessName name');
      if (seller) finalSellerName = seller.businessName || seller.storeName || seller.name;
    }

    // Sanitize unit and customUnits
    const cleanUnit = (unit ? String(unit).trim().toUpperCase() : 'BOX') || 'BOX';
    let cleanCustomUnits = [];
    if (req.body.customUnits) {
      try {
        const rawCustom = typeof req.body.customUnits === 'string' ? JSON.parse(req.body.customUnits) : req.body.customUnits;
        if (Array.isArray(rawCustom)) {
          cleanCustomUnits = rawCustom
            .map(u => String(u || '').trim().toUpperCase())
            .filter(u => u.length > 0 && u !== 'BOX' && u !== 'BAG');
        }
      } catch (e) {
        console.error('Failed to parse customUnits:', e);
      }
    }
    if (cleanUnit !== 'BOX' && cleanUnit !== 'BAG' && !cleanCustomUnits.includes(cleanUnit)) {
      cleanCustomUnits.push(cleanUnit);
    }
    cleanCustomUnits = Array.from(new Set(cleanCustomUnits));

    const comms = await loadCommissions(req);
    const packagingType = req.body.packagingType || cleanUnit;
    const measurementBasis = req.body.measurementBasis || req.body.measurementUnit || 'KG';
    const priceBasis = req.body.priceBasis || (req.body.isPackagePrice ? 'per_package' : 'per_unit');

    const pricingPayload = processProductPricing({
      name,
      categoryId,
      unit: cleanUnit,
      packagingType,
      measurementBasis,
      measurementUnit: measurementBasis,
      priceBasis,
      unitSize: req.body.unitSize !== undefined ? req.body.unitSize : 1,
      sellerPrice: req.body.sellerPrice || req.body.sellerB2bPrice || price,
      sellerB2bPrice: req.body.sellerB2bPrice || req.body.sellerPrice || b2bPrice || price,
      price,
      b2bPrice,
      commissionType: req.body.commissionType,
      commissionValue: req.body.commissionValue,
      commissionAmount: req.body.commissionAmount,
      stock: stock !== undefined ? stock : (req.body.stock || 0),
      gstPercent: gstPercent || 0,
      isGstInclusive: req.body.isGstInclusive !== undefined ? req.body.isGstInclusive : false,
      b2c: parsedB2c,
      b2b: parsedB2b,
      priceTiers: parsedPriceTiers
    }, comms);

    let isProductVisible = true;
    if (sellerId) {
      try {
        let sel = await Seller.findById(sellerId).select('isProductVisible');
        if (sel && sel.isProductVisible === false) {
          isProductVisible = false;
        }
      } catch (e) {}
    }

    const product = await Product.create({
      name,
      categoryId,
      subCategoryId: subCategoryId || null,
      isProductVisible,
      price: pricingPayload.price,
      b2bPrice: pricingPayload.b2bPrice,
      sellerPrice: pricingPayload.sellerPrice,
      sellerB2bPrice: pricingPayload.sellerB2bPrice,
      sellerUnitPrice: pricingPayload.sellerUnitPrice,
      sellerPricePerBaseUnit: pricingPayload.sellerPricePerBaseUnit,
      productMeasurementUnit: pricingPayload.productMeasurementUnit,
      measurementBasis: pricingPayload.measurementBasis || measurementBasis,
      measurementUnit: pricingPayload.measurementUnit || measurementBasis,
      packagingType: pricingPayload.packagingType || packagingType,
      priceBasis: pricingPayload.priceBasis || priceBasis,
      sellerPricePerProductUnit: pricingPayload.sellerPricePerProductUnit,
      sellerPricePerPackage: pricingPayload.sellerPricePerPackage || pricingPayload.sellerPricePerProductUnit,
      customerPricePerPackage: pricingPayload.customerPricePerPackage || pricingPayload.customerFinalPricePerProductUnit,
      adminCommissionPerBaseUnit: pricingPayload.adminCommissionPerBaseUnit,
      commissionPerProductUnit: pricingPayload.commissionPerProductUnit,
      customerUnitBasePrice: pricingPayload.customerUnitBasePrice,
      gstAmountPerProductUnit: pricingPayload.gstAmountPerProductUnit,
      customerFinalPricePerProductUnit: pricingPayload.customerFinalPricePerProductUnit,
      totalStockWeight: pricingPayload.totalStockWeight,
      totalStockCommission: pricingPayload.totalStockCommission,
      totalSellerStockValue: pricingPayload.totalSellerStockValue,
      totalStockSubtotal: pricingPayload.totalStockSubtotal,
      totalStockValuation: pricingPayload.totalStockValuation,
      commissionType: pricingPayload.commissionType,
      commissionValue: pricingPayload.commissionValue,
      commissionRate: pricingPayload.commissionRate,
      commissionAmount: pricingPayload.commissionAmount,
      unitCommission: pricingPayload.unitCommission,
      stockTotalCommission: pricingPayload.stockTotalCommission,
      subtotal: pricingPayload.subtotal,
      stockSubtotal: pricingPayload.stockSubtotal,
      gstAmount: pricingPayload.gstAmount,
      sellerGstAmount: pricingPayload.sellerGstAmount,
      stockGstAmount: pricingPayload.stockGstAmount,
      totalAmount: pricingPayload.totalAmount,
      stockTotalAmount: pricingPayload.stockTotalAmount,
      isGstInclusive: pricingPayload.isGstInclusive,
      unitCustomerPrice: pricingPayload.unitCustomerPrice,
      gstPercent: gstPercent || 0,
      moq: parsedMoq,
      maxOrderQuantity: parsedMoq,
      unit: cleanUnit,
      unitSize: pricingPayload.unitSize || req.body.unitSize || 1,
      customUnits: cleanCustomUnits,
      sellerId,
      sellerName: finalSellerName,
      stock: stock || 0,
      sku: req.body.sku || '',
      hsn: req.body.hsn || '',
      stockStatus: req.body.stockStatus || 'Available',
      description,
      imageUrl,
      pdfUrl,
      rating: 0,
      variants: [],
      priceTiers: pricingPayload.priceTiers,
      b2b: pricingPayload.b2b,
      b2c: pricingPayload.b2c
    });

    // Also persist customUnits to Seller profile if available
    if (sellerId && cleanCustomUnits.length > 0) {
      try {
        await Seller.findByIdAndUpdate(sellerId, {
          $addToSet: { customUnits: { $each: cleanCustomUnits } }
        });
      } catch (e) {
        console.error('Failed to update seller customUnits:', e.message);
      }
    }

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const excelUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    cb(null, true); // Accept Excel sheets or spreadsheets unconditionally
  }
});

// @route   POST /api/products/bulk-upload
// @desc    Bulk upload products via Excel
router.post('/bulk-upload', protect, excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  try {
    const { Category: CategoryModel, SubCategory: SubCategoryModel, Product: ProductModel } = getModels(req);
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const results = [];
    for (const item of data) {
      if (!item.Name || !item.Category) continue;

      let determinedSellerId = null;
      if (req.user && req.user.role === 'seller') {
        determinedSellerId = req.user._id;
      } else if (item.SellerId) {
        determinedSellerId = item.SellerId;
      }

      // Find or create Category
      let category = await CategoryModel.findOne({ name: item.Category });
      if (!category) {
        category = await CategoryModel.create({
          name: item.Category,
          imageUrl: item.CategoryImageUrl || 'https://snbtradingco.in/uploads/default-category.png'
        });
      }

      // Find or create SubCategory
      let subCategory = null;
      if (item.SubCategory) {
        subCategory = await SubCategoryModel.findOne({ name: item.SubCategory, categoryId: category._id });
        if (!subCategory) {
          subCategory = await SubCategoryModel.create({
            name: item.SubCategory,
            imageUrl: item.SubCategoryImageUrl || 'https://snbtradingco.in/uploads/default-subcategory.png',
            categoryId: category._id
          });
        }
      }

      // Extract price tiers
      let priceTiers = [];
      for (let i = 1; i <= 5; i++) {
        if (item[`Tier${i}_Qty`] && item[`Tier${i}_Price`]) {
          priceTiers.push({ minQty: item[`Tier${i}_Qty`], price: item[`Tier${i}_Price`] });
        }
      }

      let b2cArray = [];
      let b2bArray = [];

      const sizeName = item.SizeName || item.Size;
      if (sizeName) {
        b2cArray.push({
          packetSize: sizeName,
          price: item.Price || item.B2C_Price || 0,
          stock: item.Stock !== undefined ? item.Stock : (item.B2C_Stock !== undefined ? item.B2C_Stock : 0)
        });

        b2bArray.push({
          packetSize: sizeName,
          price: item.B2BPrice || item.B2B_Price || 0,
          stock: item.Stock !== undefined ? item.Stock : (item.B2C_Stock !== undefined ? item.B2C_Stock : 0),
          priceTiers: priceTiers
        });
      } else {
        if (item.B2C_Size) {
          b2cArray.push({
            packetSize: item.B2C_Size,
            price: item.B2C_Price || 0,
            stock: item.B2C_Stock !== undefined ? item.B2C_Stock : 0
          });
        }
        if (item.B2B_Size) {
          b2bArray.push({
            packetSize: item.B2B_Size,
            price: item.B2B_Price || 0,
            stock: item.B2B_Stock !== undefined ? item.B2B_Stock : 0,
            priceTiers: priceTiers
          });
        }
      }

      let product = await ProductModel.findOne({ name: item.Name });
      if (product) {
        if (b2cArray.length > 0) {
          b2cArray.forEach(variant => {
            let existingVariantIndex = product.b2c.findIndex(v => v.packetSize === variant.packetSize);
            if (existingVariantIndex >= 0) {
              product.b2c[existingVariantIndex] = variant;
            } else {
              product.b2c.push(variant);
            }
          });
        }
        if (b2bArray.length > 0) {
          b2bArray.forEach(variant => {
            let existingVariantIndex = product.b2b.findIndex(v => v.packetSize === variant.packetSize);
            if (existingVariantIndex >= 0) {
              product.b2b[existingVariantIndex] = variant;
            } else {
              product.b2b.push(variant);
            }
          });
        }

        if (item.Description && !product.description) product.description = item.Description;
        if (item.PdfUrl && !product.pdfUrl) product.pdfUrl = item.PdfUrl;
        if (determinedSellerId && !product.sellerId) product.sellerId = determinedSellerId;
        const bulkMoq = parseInt(item.MOQ || item.MaxOrderQuantity || item.moq, 10);
        if (!isNaN(bulkMoq) && bulkMoq >= 1) {
          product.moq = bulkMoq;
          product.maxOrderQuantity = bulkMoq;
        }

        await product.save();
      } else {
        const bulkMoq = parseInt(item.MOQ || item.MaxOrderQuantity || item.moq, 10) || 1;
        // Create Product
        product = await ProductModel.create({
          name: item.Name,
          categoryId: category._id,
          subCategoryId: subCategory ? subCategory._id : null,
          price: item.Price || item.B2C_Price || 0,
          b2bPrice: item.B2BPrice || item.B2B_Price || 0,
          gstPercent: item.GST || 0,
          moq: bulkMoq,
          maxOrderQuantity: bulkMoq,
          unit: item.Unit || 'pcs',
          imageUrl: item.ImageUrl || 'https://snbtradingco.in/uploads/default-product.png',
          description: item.Description || '',
          pdfUrl: item.PdfUrl || null,
          sellerId: determinedSellerId,
          rating: item.Rating || 0,
          variants: [],
          b2c: b2cArray,
          b2b: b2bArray,
          priceTiers: (b2bArray.length > 0 || b2cArray.length > 0) ? [] : priceTiers
        });
        results.push(product);
      }
    }

    // Clean up the uploaded Excel file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error('Failed to unlink uploaded file:', e.message);
    }

    res.status(201).json({ message: `Successfully uploaded ${results.length} products`, count: results.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper to extract stock for variant (B2B Size Variants as single source of truth)
function getProductAvailableStock(product, variantSize, role = 'b2c') {
  if (variantSize) {
    const variantArray = role === 'b2b' ? (product.b2b || []) : (product.b2c || []);
    let found = (variantArray || []).find(v => (v.packetSize || v.sizeName) === variantSize);
    if (!found && product.variants) {
      found = product.variants.find(v => (v.packetSize || v.sizeName) === variantSize);
    }
    if (found) return found.stock !== undefined ? found.stock : 0;
  }
  // Single source of truth: If B2B product has variants, use B2B variant stock
  if (role === 'b2b' && product.b2b && product.b2b.length > 0) {
    return product.b2b[0].stock !== undefined ? product.b2b[0].stock : 0;
  }
  return product.stock !== undefined ? product.stock : 0;
}

// @route   POST /api/products/calculate-pricing (and /api/products/calculate-price)
// @desc    Returns exact pricing response contract
router.post(['/calculate-pricing', '/calculate-price'], async (req, res) => {
  try {
    const {
      productId,
      quantity,
      orderedQuantity,
      variantSize,
      pincode,
      isB2B,
      sellerUnitPrice,
      commissionType,
      commissionRate,
      commissionValue,
      availableStock,
      gstPercent
    } = req.body;

    const targetQty = parseInt(orderedQuantity !== undefined ? orderedQuantity : quantity, 10);
    if (!targetQty || isNaN(targetQty) || targetQty <= 0) {
      return res.status(400).json({ message: 'Quantity must be a positive integer.' });
    }

    if (productId) {
      const { Product } = getModels(req);
      const product = await Product.findById(productId).lean();
      if (!product) return res.status(404).json({ message: 'Product not found' });

    // Check if request is from an authenticated admin
    let isAdminForId = false;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          const Admin = require('../models/Admin');
          const adminAcc = await Admin.findById(decoded.id);
          if (adminAcc) isAdminForId = true;
        }
      } catch (e) {}
    }

    if (!isAdminForId && product.isProductVisible === false) {
      return res.status(404).json({ message: 'Product not found' });
    }

      const stock = getProductAvailableStock(product, variantSize, isB2B ? 'b2b' : 'b2c');
      if (stock < targetQty) {
        return res.status(400).json({
          message: `Insufficient stock for product "${product.name}". Available: ${stock}, Requested: ${targetQty}`
        });
      }

      let unitPrice = 0;
      let targetUnitSize = product.unitSize || 1;
      let targetPackagingType = product.packagingType || product.unit || 'BAG';
      let targetMeasurementBasis = product.measurementBasis || product.measurementUnit || 'KG';
      let targetPriceBasis = product.priceBasis || 'per_unit';
      let targetSellerPricePerBaseUnit = product.sellerPricePerBaseUnit;
      let targetSellerPricePerProductUnit = product.sellerPricePerProductUnit;

      if (isB2B) {
        unitPrice = product.sellerB2bPrice !== undefined ? product.sellerB2bPrice : (product.sellerPrice || product.b2bPrice || product.price || 0);
      } else {
        unitPrice = product.sellerPrice !== undefined ? product.sellerPrice : (product.price || 0);
      }

      if (variantSize) {
        const vArray = isB2B ? (product.b2b || []) : (product.b2c || []);
        const vFound = vArray.find(v => (v.packetSize || v.sizeName) === variantSize);
        if (vFound) {
          unitPrice = vFound.sellerPrice !== undefined ? vFound.sellerPrice : (vFound.price || unitPrice);
          targetUnitSize = extractUnitSize(vFound.unitSize || vFound.packetSizeVal || vFound.packetSize, targetUnitSize);
          targetPackagingType = vFound.packagingType || targetPackagingType;
          targetMeasurementBasis = vFound.measurementBasis || vFound.measurementUnit || targetMeasurementBasis;
          targetPriceBasis = vFound.priceBasis || 'per_package';
          targetSellerPricePerBaseUnit = vFound.sellerPricePerBaseUnit;
          targetSellerPricePerProductUnit = vFound.sellerPricePerProductUnit;
        }
      }

      const commissions = await loadCommissions(req);
      const rule = findCategoryCommission(commissions, product.categoryId, targetPackagingType, targetMeasurementBasis, pincode);

      const commType = rule?.commissionType || commissionType || product.commissionType || 'flat';
      const commVal = rule ? rule.commissionValue : (commissionRate ?? commissionValue ?? product.commissionValue ?? 0);
      const effectiveGst = gstPercent !== undefined ? gstPercent : (product.gstPercent || 0);

      const breakdown = calculatePricingBreakdown({
        sellerUnitPrice: unitPrice,
        sellerPrice: unitPrice,
        sellerPricePerBaseUnit: targetSellerPricePerBaseUnit,
        sellerPricePerProductUnit: targetSellerPricePerProductUnit,
        priceBasis: targetPriceBasis,
        packagingType: targetPackagingType,
        measurementBasis: targetMeasurementBasis,
        unit: targetPackagingType,
        measurementUnit: targetMeasurementBasis,
        commissionUnit: rule?.unit || targetMeasurementBasis,
        commissionType: commType,
        commissionValue: commVal,
        unitSize: targetUnitSize,
        gstPercent: effectiveGst,
        quantity: targetQty,
        availableStock: stock,
        isB2B: !!isB2B,
        isGstInclusive: req.body.isGstInclusive !== undefined ? req.body.isGstInclusive : (product.isGstInclusive || false)
      });

      return res.json(breakdown);
    }

    const breakdown = calculatePricingBreakdown({
      sellerUnitPrice: sellerUnitPrice || 0,
      sellerPrice: req.body.sellerPrice || sellerUnitPrice || 0,
      sellerPricePerBaseUnit: req.body.sellerPricePerBaseUnit,
      sellerPricePerProductUnit: req.body.sellerPricePerProductUnit,
      priceBasis: req.body.priceBasis,
      packagingType: req.body.packagingType || req.body.unit || 'BAG',
      measurementBasis: req.body.measurementBasis || req.body.measurementUnit || 'KG',
      unit: req.body.unit || req.body.packagingType || 'BAG',
      measurementUnit: req.body.measurementUnit || req.body.measurementBasis || 'KG',
      commissionType: commissionType || 'flat',
      commissionValue: commissionRate !== undefined ? commissionRate : (commissionValue || 0),
      unitSize: req.body.unitSize || 1,
      gstPercent: gstPercent || 0,
      quantity: targetQty,
      availableStock: availableStock || 0,
      isB2B: !!isB2B,
      isGstInclusive: req.body.isGstInclusive !== undefined ? req.body.isGstInclusive : false
    });

    return res.json(breakdown);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   GET /api/products/:id/pricing
// @desc    Returns exact pricing response contract for a specific product
router.get('/:id/pricing', async (req, res) => {
  try {
    const { Product } = getModels(req);
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });

    let isAdmin = false;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          const Admin = require('../models/Admin');
          const adminAcc = await Admin.findById(decoded.id);
          if (adminAcc) isAdmin = true;
        }
      } catch (e) {}
    }

    if (!isAdmin && product.isProductVisible === false) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const quantityParam = req.query.orderedQuantity || req.query.quantity || 1;
    const targetQty = parseInt(quantityParam, 10);
    if (!targetQty || isNaN(targetQty) || targetQty <= 0) {
      return res.status(400).json({ message: 'Quantity must be a positive integer.' });
    }

    const isB2B = req.query.isB2B === 'true' || req.query.role === 'b2b';
    const variantSize = req.query.variantSize || null;
    const stock = getProductAvailableStock(product, variantSize, isB2B ? 'b2b' : 'b2c');

    const commissions = await loadCommissions(req);
    const rule = findCategoryCommission(commissions, product.categoryId, product.unit, req.query.pincode);

    const commType = rule?.commissionType || product.commissionType || 'flat';
    const commVal = rule ? rule.commissionValue : (product.commissionValue || 0);

    let unitPrice = 0;
    if (isB2B) {
      unitPrice = product.sellerB2bPrice !== undefined ? product.sellerB2bPrice : (product.sellerPrice || product.b2bPrice || product.price || 0);
    } else {
      unitPrice = product.sellerPrice !== undefined ? product.sellerPrice : (product.price || 0);
    }

    if (variantSize) {
      const vArray = isB2B ? (product.b2b || []) : (product.b2c || []);
      const vFound = vArray.find(v => (v.packetSize || v.sizeName) === variantSize);
      if (vFound) {
        unitPrice = vFound.sellerPrice !== undefined ? vFound.sellerPrice : (vFound.price || unitPrice);
      }
    }

    const breakdown = calculatePricingBreakdown({
      sellerUnitPrice: unitPrice,
      commissionType: commType,
      commissionValue: commVal,
      gstPercent: product.gstPercent || 0,
      quantity: targetQty,
      availableStock: stock,
      isB2B,
      isGstInclusive: req.query.isGstInclusive !== undefined ? (req.query.isGstInclusive === 'true') : (product.isGstInclusive || false)
    });

    return res.json(breakdown);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null' || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    const { Product } = getModels(req);
    let product = await Product.findById(id)
      .populate('categoryId')
      .populate('subCategoryId')
      .lean();

    // Cross-tenant fallback lookup if not found in current scoped tenant DB
    if (!product) {
      const crossTenant = await findProductAcrossTenants(id, req, true);
      if (crossTenant) {
        product = crossTenant.product;
      }
    }

    if (!product) return res.status(404).json({ message: 'Product not found' });

    let isAdmin = false;
    let isSellerOwner = false;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded && decoded.id) {
          const Admin = require('../models/Admin');
          const adminAcc = await Admin.findById(decoded.id);
          if (adminAcc) isAdmin = true;

          // Check if the requester is the seller who owns this product
          if (product.sellerId && String(product.sellerId) === String(decoded.id)) {
            isSellerOwner = true;
          }
        }
      } catch (e) {}
    }

    if (!isAdmin && !isSellerOwner && product.isProductVisible === false) {
      return res.status(404).json({ message: 'Product not found' });
    }

    let sellerGstNumber = null;
    let sellerName = 'Zudo Official';

    if (product.sellerId) {
      try {
        const { Seller, User } = getModels(req);

        let seller = await Seller.findById(product.sellerId).select('businessName storeName name gstNumber panNumber');
        if (!seller) {
          seller = await User.findById(product.sellerId).select('businessName name gstNumber');
        }

        if (seller) {
          sellerName = seller.businessName || seller.storeName || seller.name || 'Zudo Official';
          sellerGstNumber = seller.gstNumber || null;
          product.sellerId = {
            _id: product.sellerId,
            businessName: sellerName,
            name: seller.name,
            gstNumber: sellerGstNumber
          };
        }
      } catch (e) { }
    }

    product.sellerName = sellerName;
    product.sellerGstNumber = sellerGstNumber;

    // Apply commission price inflation
    const commissions = await loadCommissions(req);
    const enriched = applyCommission(product, commissions);

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/products/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null' || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    let { Product } = getModels(req);
    let targetProductModel = Product;

    let existingProd = await Product.findById(id).select('sellerId customUnits unit packagingType measurementBasis measurementUnit unitSize priceBasis sellerPrice sellerB2bPrice b2b b2c variants name');
    if (!existingProd) {
      const crossTenant = await findProductAcrossTenants(id, req, false);
      if (crossTenant) {
        existingProd = crossTenant.product;
        targetProductModel = crossTenant.Model;
      }
    }

    if (!existingProd) return res.status(404).json({ message: 'Product not found' });

    // If seller is updating, ensure they own the product
    if (req.user && req.user.role === 'seller') {
      if (existingProd.sellerId && existingProd.sellerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to update products of another seller' });
      }
    }

    // Merge and sanitize customUnits and unit if provided
    if (req.body.unit) {
      req.body.unit = String(req.body.unit).trim().toUpperCase();
    }
    if (req.body.customUnits !== undefined || req.body.unit) {
      let existingCustom = Array.isArray(existingProd.customUnits) ? existingProd.customUnits : [];
      let incomingCustom = [];
      if (req.body.customUnits) {
        try {
          const raw = typeof req.body.customUnits === 'string' ? JSON.parse(req.body.customUnits) : req.body.customUnits;
          if (Array.isArray(raw)) {
            incomingCustom = raw.map(u => String(u || '').trim().toUpperCase()).filter(Boolean);
          }
        } catch (e) {
          console.error('Failed to parse customUnits in PUT:', e);
        }
      }
      const combined = [...existingCustom, ...incomingCustom]
        .filter(u => u !== 'BOX' && u !== 'BAG' && u.length > 0);
      if (req.body.unit && req.body.unit !== 'BOX' && req.body.unit !== 'BAG') {
        combined.push(req.body.unit);
      }
      req.body.customUnits = Array.from(new Set(combined));
    }

    // Validate moq / maxOrderQuantity if provided
    const rawMoq = req.body.moq !== undefined ? req.body.moq : req.body.maxOrderQuantity;
    if (rawMoq !== undefined && rawMoq !== null && rawMoq !== '') {
      const parsedMoq = parseInt(rawMoq, 10);
      if (isNaN(parsedMoq) || parsedMoq < 1) {
        return res.status(400).json({ message: 'Maximum order quantity must be an integer greater than 0' });
      }
      req.body.moq = parsedMoq;
      req.body.maxOrderQuantity = parsedMoq;
    }

    const comms = await loadCommissions(req);
    if ((req.body.unitSize === undefined || Number(req.body.unitSize) <= 1) && existingProd.unitSize > 1) {
      req.body.unitSize = existingProd.unitSize;
    }
    if (req.body.measurementUnit === undefined && (existingProd.measurementUnit || existingProd.measurementBasis)) {
      req.body.measurementUnit = existingProd.measurementUnit || existingProd.measurementBasis;
    }
    if (req.body.measurementBasis === undefined && (existingProd.measurementBasis || existingProd.measurementUnit)) {
      req.body.measurementBasis = existingProd.measurementBasis || existingProd.measurementUnit;
    }
    if (req.body.packagingType === undefined && (existingProd.packagingType || existingProd.unit)) {
      req.body.packagingType = existingProd.packagingType || existingProd.unit;
    }
    if (req.body.priceBasis === undefined && existingProd.priceBasis) {
      req.body.priceBasis = existingProd.priceBasis;
    }

    const pricingInput = {
      ...(typeof existingProd.toObject === 'function' ? existingProd.toObject() : existingProd),
      ...req.body,
      name: req.body.name || existingProd.name,
      b2b: req.body.b2b !== undefined ? req.body.b2b : existingProd.b2b
    };

    const updatedPayload = processProductPricing(pricingInput, comms);
    if (!updatedPayload.subCategoryId || updatedPayload.subCategoryId === '' || updatedPayload.subCategoryId === 'null' || updatedPayload.subCategoryId === 'undefined') {
      updatedPayload.subCategoryId = null;
    }
    if (req.body.customUnits) {
      updatedPayload.customUnits = req.body.customUnits;
    }
    if (req.body.unit) {
      updatedPayload.unit = req.body.unit;
    }
    if (req.body.packagingType) {
      updatedPayload.packagingType = req.body.packagingType;
    }
    if (req.body.measurementBasis !== undefined) {
      updatedPayload.measurementBasis = req.body.measurementBasis;
    }
    if (req.body.measurementUnit !== undefined) {
      updatedPayload.measurementUnit = req.body.measurementUnit;
    }
    if (req.body.priceBasis !== undefined) {
      updatedPayload.priceBasis = req.body.priceBasis;
    }
    if (req.body.unitSize !== undefined) {
      updatedPayload.unitSize = req.body.unitSize;
    }
    if (updatedPayload.sellerPricePerPackage === undefined && updatedPayload.sellerPricePerProductUnit !== undefined) {
      updatedPayload.sellerPricePerPackage = updatedPayload.sellerPricePerProductUnit;
    }
    if (updatedPayload.customerPricePerPackage === undefined && updatedPayload.customerFinalPricePerProductUnit !== undefined) {
      updatedPayload.customerPricePerPackage = updatedPayload.customerFinalPricePerProductUnit;
    }
    const product = await targetProductModel.findByIdAndUpdate(id, updatedPayload, { returnDocument: 'after' });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Also persist customUnits to Seller profile if available
    const sellerIdToUpdate = existingProd.sellerId || (req.user ? req.user._id : null);
    if (sellerIdToUpdate && Array.isArray(req.body.customUnits) && req.body.customUnits.length > 0) {
      try {
        const { Seller } = getModels(req);
        await Seller.findByIdAndUpdate(sellerIdToUpdate, {
          $addToSet: { customUnits: { $each: req.body.customUnits } }
        });
      } catch (e) {
        console.error('Failed to update seller customUnits in PUT:', e.message);
      }
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/products/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null' || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    let { Product } = getModels(req);
    let targetProductModel = Product;

    let existing = await Product.findById(id).select('sellerId');
    if (!existing) {
      const crossTenant = await findProductAcrossTenants(id, req, false);
      if (crossTenant) {
        existing = crossTenant.product;
        targetProductModel = crossTenant.Model;
      }
    }

    if (!existing) return res.status(404).json({ message: 'Product not found' });

    if (req.user && req.user.role === 'seller') {
      if (existing.sellerId && existing.sellerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to delete products of another seller' });
      }
    }

    const product = await targetProductModel.findByIdAndDelete(id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products/apply-commissions
// @desc    Re‑calculate product prices using current commission settings
router.post('/apply-commissions', protect, async (req, res) => {
  try {
    const result = await applyCommissionToAllProducts(req);
    res.json({ message: 'Commission applied', ...result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Optional initialization route that just triggers commission application
router.get('/initialize', protect, async (req, res) => {
  try {
    const result = await applyCommissionToAllProducts(req);
    res.json({ message: 'Initialization complete', ...result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.loadCommissions = loadCommissions;
router.applyCommission = applyCommission;
router.applyCommissionToAllProducts = applyCommissionToAllProducts;
module.exports = router;
