const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { processProductPricing, applyCommission, calculateCustomerPrice, findCategoryCommission } = require('../utils/pricing');

// Helper to get models from req
const { getModel } = require('../utils/model_loader');
const getModels = (req) => ({
  Product: getModel('Product', req),
  Category: getModel('Category', req),
  SubCategory: getModel('SubCategory', req),
  Seller: getModel('Seller', req),
  User: getModel('User', req)
});

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
          commissionType: updated.commissionType,
          commissionValue: updated.commissionValue,
          commissionRate: updated.commissionValue,
          commissionAmount: updated.commissionAmount,
          unitCommission: updated.commissionAmount,
          stockTotalCommission: updated.stockTotalCommission,
          subtotal: updated.subtotal,
          stockSubtotal: updated.stockSubtotal,
          gstAmount: updated.gstAmount,
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
  }

  const { Product } = getModels(req);
  totalUpdated += await updateProductList(Product);

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

    const filter = {};
    if (req.portal === 'B2B') filter.b2b = { $exists: true, $not: { $size: 0 } };
    if (req.portal === 'B2C') filter.b2c = { $exists: true, $not: { $size: 0 } };

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

    res.json(productsWithSeller);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/products
// @desc    Create a single product with image and/or pdf upload
router.post('/', protect, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, categoryId, subCategoryId, price, b2bPrice, moq, unit, sellerId, stock, description, gstPercent } = req.body;
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

    const comms = await loadCommissions(req);
    const pricingPayload = processProductPricing({
      categoryId,
      unit,
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

    const product = await Product.create({
      name,
      categoryId,
      subCategoryId: subCategoryId || null,
      price: pricingPayload.price,
      b2bPrice: pricingPayload.b2bPrice,
      sellerPrice: pricingPayload.sellerPrice,
      sellerB2bPrice: pricingPayload.sellerB2bPrice,
      sellerUnitPrice: pricingPayload.sellerUnitPrice,
      commissionType: pricingPayload.commissionType,
      commissionValue: pricingPayload.commissionValue,
      commissionRate: pricingPayload.commissionRate,
      commissionAmount: pricingPayload.commissionAmount,
      unitCommission: pricingPayload.unitCommission,
      stockTotalCommission: pricingPayload.stockTotalCommission,
      subtotal: pricingPayload.subtotal,
      stockSubtotal: pricingPayload.stockSubtotal,
      gstAmount: pricingPayload.gstAmount,
      stockGstAmount: pricingPayload.stockGstAmount,
      totalAmount: pricingPayload.totalAmount,
      stockTotalAmount: pricingPayload.stockTotalAmount,
      isGstInclusive: pricingPayload.isGstInclusive,
      unitCustomerPrice: pricingPayload.unitCustomerPrice,
      gstPercent: gstPercent || 0,
      moq,
      unit,
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

        await product.save();
      } else {
        // Create Product
        product = await ProductModel.create({
          name: item.Name,
          categoryId: category._id,
          subCategoryId: subCategory ? subCategory._id : null,
          price: item.Price || item.B2C_Price || 0,
          b2bPrice: item.B2BPrice || item.B2B_Price || 0,
          gstPercent: item.GST || 0,
          moq: item.MOQ || 1,
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

// Helper to extract stock for variant
function getProductAvailableStock(product, variantSize, role = 'b2c') {
  if (variantSize) {
    const variantArray = role === 'b2b' ? (product.b2b || []) : (product.b2c || []);
    let found = (variantArray || []).find(v => (v.packetSize || v.sizeName) === variantSize);
    if (!found && product.variants) {
      found = product.variants.find(v => (v.packetSize || v.sizeName) === variantSize);
    }
    if (found) return found.stock !== undefined ? found.stock : 0;
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

      const stock = getProductAvailableStock(product, variantSize, isB2B ? 'b2b' : 'b2c');
      if (stock < targetQty) {
        return res.status(400).json({
          message: `Insufficient stock for product "${product.name}". Available: ${stock}, Requested: ${targetQty}`
        });
      }

      const commissions = await loadCommissions(req);
      const rule = findCategoryCommission(commissions, product.categoryId, product.unit, pincode);

      const commType = rule?.commissionType || commissionType || product.commissionType || 'flat';
      const commVal = rule ? rule.commissionValue : (commissionRate ?? commissionValue ?? product.commissionValue ?? 0);

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

      const effectiveGst = gstPercent !== undefined ? gstPercent : (product.gstPercent || 0);

      const breakdown = calculatePricingBreakdown({
        sellerUnitPrice: unitPrice,
        commissionType: commType,
        commissionValue: commVal,
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
      commissionType: commissionType || 'flat',
      commissionValue: commissionRate !== undefined ? commissionRate : (commissionValue || 0),
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
    const { Product } = getModels(req);
    const product = await Product.findById(req.params.id)
      .populate('categoryId')
      .populate('subCategoryId')
      .lean();

    if (!product) return res.status(404).json({ message: 'Product not found' });

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
    const { Product } = getModels(req);
    const comms = await loadCommissions(req);
    const updatedPayload = processProductPricing(req.body, comms);
    if (!updatedPayload.subCategoryId || updatedPayload.subCategoryId === '' || updatedPayload.subCategoryId === 'null' || updatedPayload.subCategoryId === 'undefined') {
      updatedPayload.subCategoryId = null;
    }
    const product = await Product.findByIdAndUpdate(req.params.id, updatedPayload, { returnDocument: 'after' });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/products/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const { Product } = getModels(req);
    const product = await Product.findByIdAndDelete(req.params.id);
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
