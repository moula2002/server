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
    const { Product } = getModels(req);
    const db = (Product && Product.db) ? Product.db.db : mongoose.connection.db;
    if (!db) return [];
    return await db.collection('commissions').find().toArray();
  } catch (e) {
    console.error('[commissions] Failed to load:', e.message);
    return [];
  }
}

// Helper: Re-calculate all products with current commission rules
async function applyCommissionToAllProducts(req) {
  const commissions = await loadCommissions(req);
  if (!commissions || commissions.length === 0) return { updatedCount: 0, logs: [] };

  const { Product } = getModels(req);
  const products = await Product.find().lean();
  let updatedCount = 0;

  for (const p of products) {
    const updated = applyCommission(p, commissions);
    if (updated.price !== p.price || updated.b2bPrice !== p.b2bPrice || updated.sellerPrice !== p.sellerPrice) {
      await Product.findByIdAndUpdate(p._id, {
        sellerPrice: updated.sellerPrice,
        sellerB2bPrice: updated.sellerB2bPrice,
        commissionType: updated.commissionType,
        commissionValue: updated.commissionValue,
        commissionAmount: updated.commissionAmount,
        price: updated.price,
        b2bPrice: updated.b2bPrice,
        b2c: updated.b2c,
        b2b: updated.b2b,
        priceTiers: updated.priceTiers
      });
      updatedCount++;
    }
  }

  return { updatedCount, logs: [`Checked ${products.length} products. Applied to ${updatedCount}.`] };
}

module.exports.loadCommissions = loadCommissions;
module.exports.applyCommission = applyCommission;

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

            let seller = await TenantSeller.findById(p.sellerId).select('businessName storeName name');
            if (!seller) {
              seller = await TenantUser.findById(p.sellerId).select('businessName name');
            }

            if (seller) {
              enriched = {
                ...p,
                sellerName: seller.businessName || seller.storeName || seller.name,
                sellerId: {
                  _id: p.sellerId,
                  businessName: seller.businessName || seller.storeName || seller.name,
                  name: seller.name
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
            let seller = await Seller.findById(p.sellerId).select('businessName storeName name');
            if (!seller) {
              const db = mongoose.connection.db;
              const sellerCollection = db.collection('sellers');
              seller = await sellerCollection.findOne({
                _id: p.sellerId instanceof mongoose.Types.ObjectId ? p.sellerId : new mongoose.Types.ObjectId(p.sellerId)
              });
            }
            if (!seller) {
              seller = await User.findById(p.sellerId).select('businessName name');
            }

            if (seller) {
              enriched = {
                ...p,
                sellerName: seller.businessName || seller.storeName || seller.name,
                sellerId: {
                  _id: p.sellerId,
                  businessName: seller.businessName || seller.storeName || seller.name,
                  name: seller.name
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
      commissionType: pricingPayload.commissionType,
      commissionValue: pricingPayload.commissionValue,
      commissionAmount: pricingPayload.commissionAmount,
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

// @route   GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { Product } = getModels(req);
    const product = await Product.findById(req.params.id)
      .populate('categoryId')
      .populate('subCategoryId')
      .lean();

    if (!product) return res.status(404).json({ message: 'Product not found' });

    if (product.sellerId) {
      try {
        const { Seller, User } = getModels(req);

        let seller = await Seller.findById(product.sellerId).select('businessName storeName name');
        if (!seller) {
          seller = await User.findById(product.sellerId).select('businessName name');
        }

        if (seller) {
          product.sellerId = {
            _id: product.sellerId,
            businessName: seller.businessName || seller.storeName || seller.name,
            name: seller.name
          };
        }
      } catch (e) { }
    }

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
module.exports = router;
