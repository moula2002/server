const express = require('express');
const router = express.Router();
const multer = require('multer');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const sendEmail = require('../utils/email');
const Order = require('../models/Order');
const SellerInvoice = require('../models/SellerInvoice');
const InvoiceImage = require('../models/InvoiceImage');
const Seller = require('../models/Seller');
const Admin = require('../models/Admin');
const { round2 } = require('../utils/pricing');
const { connectDBByLocation, getTenantConnections } = require('../utils/db_manager');
const { generateSellerInvoicePDF } = require('../utils/pdfInvoice');

// Configure multer to store files in memory as Buffer for MongoDB binary storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit per image
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
    const isAllowedExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);

    if (allowedTypes.includes((file.mimetype || '').toLowerCase()) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Only JPG, JPEG, PNG, and WEBP are allowed.'));
    }
  }
});

/**
 * Robust model resolver using req.models, req.tenantModels, or fallback to global imports
 */
const getModels = (req) => {
  return {
    Order: req.models?.Order || req.tenantModels?.Order || Order,
    SellerInvoice: req.models?.SellerInvoice || req.tenantModels?.SellerInvoice || SellerInvoice,
    InvoiceImage: req.models?.InvoiceImage || req.tenantModels?.InvoiceImage || InvoiceImage,
    Seller: req.models?.Seller || req.tenantModels?.Seller || Seller
  };
};

/**
 * Universal helper to find an invoice across active DB, Global DB, and all Tenant DBs.
 * Returns { invoice, models, db }
 */
const findInvoiceAcrossAllDBs = async (id, req) => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return { invoice: null, models: getModels(req), db: req.db };
  }

  // 1. Check req.models first
  const currentModels = getModels(req);
  try {
    const inv = await currentModels.SellerInvoice.findById(id);
    if (inv) {
      return { invoice: inv, models: currentModels, db: req.db };
    }
  } catch (e) {}

  // 2. Check Global connection if different
  try {
    const globalInv = await SellerInvoice.findById(id);
    if (globalInv) {
      return {
        invoice: globalInv,
        models: {
          Order,
          SellerInvoice,
          InvoiceImage,
          Seller
        },
        db: mongoose.connection
      };
    }
  } catch (e) {}

  // 3. Search across all tenant connections
  try {
    const connections = getTenantConnections();
    for (const [dbName, tenantConn] of Object.entries(connections)) {
      try {
        const TenantInvoice = tenantConn.models?.SellerInvoice || tenantConn.model('SellerInvoice', SellerInvoice.schema);
        const inv = await TenantInvoice.findById(id);
        if (inv) {
          return {
            invoice: inv,
            models: {
              Order: tenantConn.models?.Order || tenantConn.model('Order', Order.schema),
              SellerInvoice: TenantInvoice,
              InvoiceImage: tenantConn.models?.InvoiceImage || tenantConn.model('InvoiceImage', InvoiceImage.schema),
              Seller: tenantConn.models?.Seller || tenantConn.model('Seller', Seller.schema)
            },
            db: tenantConn
          };
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('Error in findInvoiceAcrossAllDBs:', err);
  }

  return { invoice: null, models: currentModels, db: req.db };
};

// router.param('id') ensures req.targetInvoice is set if found anywhere
router.param('id', async (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid invoice ID' });
  }

  try {
    const { invoice, models, db } = await findInvoiceAcrossAllDBs(id, req);
    if (invoice) {
      req.models = { ...(req.models || {}), ...(models || {}) };
      if (db) req.db = db;
      req.targetInvoice = invoice;
    }
  } catch (error) {
    console.error('Error resolving invoice id param:', error);
  }
  next();
});

// Robust image protection middleware accepting Header Bearer or Query ?token=
const protectImage = async (req, res, next) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ message: 'Authentication token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.id) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    // 1. Check Admin in Global DB
    let account = await Admin.findById(decoded.id).select('-password');
    if (account) {
      req.admin = account;
      req.user = account;
      return next();
    }

    // 2. Check Seller in Global or Tenant DBs
    account = await Seller.findById(decoded.id).select('-password');
    if (!account && decoded.locationId) {
      try {
        const tenantConn = await connectDBByLocation(decoded.locationId, decoded.dbName);
        const TenantSeller = tenantConn.models?.Seller || tenantConn.model('Seller', Seller.schema);
        account = await TenantSeller.findById(decoded.id).select('-password');
      } catch (e) {}
    }

    if (!account) {
      const connections = getTenantConnections();
      for (const [dbName, tenantConn] of Object.entries(connections)) {
        try {
          const TenantSeller = tenantConn.models?.Seller || tenantConn.model('Seller', Seller.schema);
          account = await TenantSeller.findById(decoded.id).select('-password');
          if (account) break;
        } catch (e) {}
      }
    }

    if (account) {
      req.user = account;
      req.user.role = 'seller';
      return next();
    }

    return res.status(403).json({ message: 'Not authorized' });
  } catch (err) {
    console.error('protectImage auth error:', err.message);
    return res.status(401).json({ message: 'Invalid or expired authentication token' });
  }
};

// @route   GET /api/seller-invoices/next-number
// @desc    Get the current invoice sequence status for the logged-in seller
router.get('/next-number', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'seller' && !req.admin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    let sellerId = req.user?._id;
    if (req.admin && req.query.sellerId) {
      sellerId = req.query.sellerId;
    }

    if (!sellerId) {
      return res.status(400).json({ message: 'Seller ID is required' });
    }

    const { SellerInvoice: InvoiceModel } = getModels(req);
    if (!InvoiceModel) {
      return res.status(503).json({ message: 'Database service unavailable. Please check database connection.' });
    }

    const existingInvoices = await InvoiceModel.find({ sellerId })
      .select('invoiceNumber invoiceSequenceNumber createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const usedNumbers = [];
    const usedNumericSequences = [];

    (existingInvoices || []).forEach(inv => {
      const numStr = (inv.invoiceNumber || '').toString().trim();
      if (numStr) usedNumbers.push(numStr);

      const parsed = parseInt(numStr, 10);
      if (/^\d+$/.test(numStr) && !isNaN(parsed) && parsed > 0) {
        usedNumericSequences.push(parsed);
      } else if (inv.invoiceSequenceNumber && inv.invoiceSequenceNumber > 0) {
        usedNumericSequences.push(inv.invoiceSequenceNumber);
      }
    });

    const maxNumeric = usedNumericSequences.length > 0 ? Math.max(...usedNumericSequences) : 0;
    const nextExpectedNumber = maxNumeric + 1;

    res.json({
      totalInvoices: existingInvoices.length,
      lastInvoiceNumber: existingInvoices.length > 0 ? existingInvoices[existingInvoices.length - 1].invoiceNumber : null,
      maxSequentialNumber: maxNumeric,
      nextExpectedNumber,
      usedNumbers
    });
  } catch (error) {
    console.error('Error fetching next invoice number:', error);
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongooseServerSelectionError') {
      return res.status(503).json({ message: 'Database connection failed. Please try again in a moment.' });
    }
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
});

/**
 * Helper to calculate un-invoiced orders and totals for a given seller and date range.
 */
const calculateSellerOrdersForRange = async ({ OrderModel, InvoiceModel, sellerId, seller, start, end }) => {
  const existingSellerInvoices = await InvoiceModel.find({
    sellerId: sellerId,
    status: { $nin: ['Cancelled', 'Rejected'] }
  }).select('orders invoiceNumber').lean();

  const alreadyInvoicedOrderIds = new Set();
  (existingSellerInvoices || []).forEach(inv => {
    (inv.orders || []).forEach(oId => {
      if (oId) alreadyInvoicedOrderIds.add(oId.toString());
    });
  });

  const orders = await OrderModel.find({
    orderStatus: { $in: ['Delivered', 'Partially Returned', 'Returned'] },
    createdAt: { $gte: start, $lte: end }
  }).populate('items.productId');

  let totalAmount = 0;
  let totalCommission = 0;
  const orderIds = [];
  const validOrders = [];

  (orders || []).forEach(order => {
    if (alreadyInvoicedOrderIds.has(order._id.toString())) {
      return;
    }

    let sellerItemsInOrder = (order.items || []).filter(item => {
      const matchesSellerObj = item.seller && item.seller.sellerId && item.seller.sellerId.toString() === sellerId.toString();
      const matchesDirectSellerId = item.sellerId && item.sellerId.toString() === sellerId.toString();
      const matchesProductRef = item.productId && item.productId.sellerId && item.productId.sellerId.toString() === sellerId.toString();
      const matchesName = item.sellerName && seller.name && item.sellerName.toLowerCase() === seller.name.toLowerCase();
      const matchesStore = item.sellerName && seller.storeName && item.sellerName.toLowerCase() === seller.storeName.toLowerCase();
      const matchesBusiness = item.sellerName && seller.businessName && item.sellerName.toLowerCase() === seller.businessName.toLowerCase();
      const productMatchesName = item.product && item.product.sellerName && seller.name && item.product.sellerName.toLowerCase() === seller.name.toLowerCase();
      const productMatchesStore = item.product && item.product.sellerName && seller.storeName && item.product.sellerName.toLowerCase() === seller.storeName.toLowerCase();
      
      return matchesSellerObj || matchesDirectSellerId || matchesProductRef || matchesName || matchesStore || matchesBusiness || productMatchesName || productMatchesStore;
    });

    if (sellerItemsInOrder.length > 0) {
      orderIds.push(order._id);
      validOrders.push(order);
      sellerItemsInOrder.forEach(item => {
        if (item.returnStatus !== 'Returned to Seller') {
          const qty = Number(item.quantity) || 1;
          const itemCommission = Number(item.totalCommission) || ((Number(item.unitCommission) || 0) * qty) || 0;
          const itemSellerPrice = (Number(item.sellerUnitPrice) || Number(item.normalPrice) || Number(item.price) || 0) * qty;
          totalAmount += itemSellerPrice;
          totalCommission += itemCommission;
        }
      });
    }
  });

  return {
    orderIds,
    validOrders,
    totalAmount,
    totalCommission,
    allOrdersInRangeCount: (orders || []).length,
    alreadyInvoicedOrderCount: alreadyInvoicedOrderIds.size,
    existingInvoiceNumbers: (existingSellerInvoices || []).map(i => i.invoiceNumber).filter(Boolean)
  };
};

// @route   POST /api/seller-invoices/generate
// @desc    Generate a single invoice (supporting multiple images: 1-5)
router.post('/generate', protect, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Image upload error' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (req.user?.role !== 'seller' && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to generate invoices' });
    }

    const { startDate, endDate } = req.body;
    const rawInvoiceNumber = req.body.invoiceNumber;
    let sellerId = req.user?._id;

    if (req.admin) {
      if (!req.body.sellerId) {
        return res.status(400).json({ message: 'sellerId is required when generating as admin' });
      }
      sellerId = req.body.sellerId;
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start date and end date are required' });
    }

    const uploadedFiles = req.files || [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ message: 'At least one invoice image is required (minimum 1, maximum 5).' });
    }
    if (uploadedFiles.length > 5) {
      return res.status(400).json({ message: 'Maximum 5 images allowed per invoice.' });
    }

    const { Order: OrderModel, SellerInvoice: InvoiceModel, InvoiceImage: InvoiceImageModel, Seller: SellerModel } = getModels(req);

    const seller = await SellerModel.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    // 1. Calculate next sequential invoice number
    const allSellerInvoices = await InvoiceModel.find({ sellerId }).select('invoiceNumber invoiceSequenceNumber').lean();
    const usedNumericSequences = [];
    (allSellerInvoices || []).forEach(inv => {
      const numStr = (inv.invoiceNumber || '').toString().trim();
      const p = parseInt(numStr, 10);
      if (/^\d+$/.test(numStr) && !isNaN(p) && p > 0) {
        usedNumericSequences.push(p);
      } else if (inv.invoiceSequenceNumber && inv.invoiceSequenceNumber > 0) {
        usedNumericSequences.push(inv.invoiceSequenceNumber);
      }
    });

    const maxNumeric = usedNumericSequences.length > 0 ? Math.max(...usedNumericSequences) : 0;
    const nextExpectedNumber = maxNumeric + 1;

    let trimmedInvoiceNumber = rawInvoiceNumber ? rawInvoiceNumber.toString().trim() : '';
    let numericInvoiceNumber = parseInt(trimmedInvoiceNumber, 10);

    if (!trimmedInvoiceNumber) {
      trimmedInvoiceNumber = String(nextExpectedNumber);
      numericInvoiceNumber = nextExpectedNumber;
    } else if (/^\d+$/.test(trimmedInvoiceNumber)) {
      numericInvoiceNumber = parseInt(trimmedInvoiceNumber, 10);
      if (numericInvoiceNumber <= 0) {
        return res.status(400).json({ message: 'Invoice number must be greater than 0.' });
      }
    } else {
      numericInvoiceNumber = nextExpectedNumber;
    }

    // Check for duplicate invoice number for this seller
    const duplicate = await InvoiceModel.findOne({
      sellerId: sellerId,
      invoiceNumber: trimmedInvoiceNumber,
      status: { $nin: ['Cancelled', 'Rejected'] }
    });

    if (duplicate) {
      return res.status(400).json({ 
        message: `Invoice number "${trimmedInvoiceNumber}" has already been used for this seller. Duplicate invoice numbers are not allowed.` 
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const {
      orderIds,
      validOrders,
      totalAmount,
      totalCommission
    } = await calculateSellerOrdersForRange({ OrderModel, InvoiceModel, sellerId, seller, start, end });

    let finalOrderIds = orderIds;
    let finalOrders = validOrders;
    let finalTotalAmount = totalAmount;
    let finalTotalCommission = totalCommission;

    if (finalOrderIds.length === 0) {
      const allOrdersInRange = await OrderModel.find({
        orderStatus: { $in: ['Delivered', 'Partially Returned', 'Returned'] },
        createdAt: { $gte: start, $lte: end }
      }).populate('items.productId');

      (allOrdersInRange || []).forEach(order => {
        let sellerItemsInOrder = (order.items || []).filter(item => {
          const matchesSellerObj = item.seller && item.seller.sellerId && item.seller.sellerId.toString() === sellerId.toString();
          const matchesDirectSellerId = item.sellerId && item.sellerId.toString() === sellerId.toString();
          const matchesProductRef = item.productId && item.productId.sellerId && item.productId.sellerId.toString() === sellerId.toString();
          const matchesName = item.sellerName && seller.name && item.sellerName.toLowerCase() === seller.name.toLowerCase();
          return matchesSellerObj || matchesDirectSellerId || matchesProductRef || matchesName;
        });
        if (sellerItemsInOrder.length > 0) {
          finalOrderIds.push(order._id);
          finalOrders.push(order);
          sellerItemsInOrder.forEach(item => {
            if (item.returnStatus !== 'Returned to Seller') {
              const qty = Number(item.quantity) || 1;
              const itemCommission = Number(item.totalCommission) || ((Number(item.unitCommission) || 0) * qty) || 0;
              const itemSellerPrice = (Number(item.sellerUnitPrice) || Number(item.normalPrice) || Number(item.price) || 0) * qty;
              finalTotalAmount += itemSellerPrice;
              finalTotalCommission += itemCommission;
            }
          });
        }
      });
    }

    const roundedTotalAmount = round2(finalTotalAmount);
    const roundedTotalCommission = round2(finalTotalCommission);
    const roundedNetAmount = round2(finalTotalAmount);

    // Create Invoice Record
    const newInvoice = new InvoiceModel({
      sellerId: sellerId,
      invoiceNumber: trimmedInvoiceNumber,
      invoiceSequenceNumber: numericInvoiceNumber,
      startDate: start,
      endDate: end,
      totalAmount: roundedTotalAmount,
      totalCommission: roundedTotalCommission,
      netAmount: roundedNetAmount,
      orderCount: finalOrderIds.length,
      orders: finalOrderIds,
      status: 'Pending',
      hasInvoiceImage: uploadedFiles.length > 0,
      imageIds: [],
      generatedBy: req.user ? req.user._id : sellerId
    });

    await newInvoice.save();

    // Store raw binary images in MongoDB
    const savedImageDocs = [];
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const filename = `${trimmedInvoiceNumber}_${Date.now()}_${i + 1}_${file.originalname}`;
      
      const imageDoc = new InvoiceImageModel({
        invoiceId: newInvoice._id,
        sellerId: sellerId,
        filename: filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        fileSize: file.size,
        data: file.buffer,
        imageData: file.buffer
      });
      await imageDoc.save();
      savedImageDocs.push(imageDoc);
      newInvoice.imageIds.push(imageDoc._id);
    }

    if (uploadedFiles.length > 0) {
      const firstFile = uploadedFiles[0];
      newInvoice.invoiceImage = {
        data: firstFile.buffer,
        contentType: firstFile.mimetype,
        fileName: `${trimmedInvoiceNumber}_${Date.now()}_${firstFile.originalname}`,
        size: firstFile.size
      };
      newInvoice.imageMetadata = {
        filename: newInvoice.invoiceImage.fileName,
        originalName: firstFile.originalname,
        mimeType: firstFile.mimetype,
        size: firstFile.size
      };
    }

    await newInvoice.save();

    // Generate PDF & Email Admin in background
    try {
      const pdfBuffer = await generateSellerInvoicePDF({
        invoice: newInvoice,
        seller,
        orders: finalOrders,
        images: savedImageDocs.map(img => ({
          data: img.data || img.imageData,
          mimeType: img.mimeType,
          filename: img.originalName || img.filename
        }))
      });

      const adminEmail = process.env.EMAIL_USER;
      sendEmail({
        to: adminEmail,
        subject: `New Seller Invoice: ${seller.businessName || seller.name}`,
        html: `
          <h3>New Invoice Generated</h3>
          <p><strong>Seller:</strong> ${seller.businessName || seller.name}</p>
          <p><strong>Invoice Number:</strong> ${trimmedInvoiceNumber}</p>
          <p><strong>Date Range:</strong> ${start.toDateString()} to ${end.toDateString()}</p>
          <p><strong>Total Amount:</strong> ₹${roundedTotalAmount}</p>
          <p><strong>Total Commission:</strong> ₹${roundedTotalCommission}</p>
          <p><strong>Net Payable:</strong> ₹${roundedNetAmount}</p>
          <p><strong>Total Orders:</strong> ${finalOrderIds.length}</p>
          <p><strong>Attached Images:</strong> ${uploadedFiles.length} file(s)</p>
        `,
        attachments: [
          {
            filename: `Invoice_${(seller.businessName || seller.name || 'Seller').replace(/\s+/g, '_')}_${trimmedInvoiceNumber}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }
        ]
      }).catch(e => console.error('Error emailing invoice:', e.message));
    } catch (pdfErr) {
      console.error('Error generating initial PDF for email:', pdfErr.message);
    }

    const invoiceResp = newInvoice.toObject();
    if (invoiceResp.invoiceImage) {
      delete invoiceResp.invoiceImage.data;
    }
    invoiceResp.imageCount = savedImageDocs.length;
    invoiceResp.images = savedImageDocs.map(doc => ({
      _id: doc._id,
      filename: doc.filename,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.fileSize || doc.size
    }));

    res.status(201).json(invoiceResp);
  } catch (error) {
    console.error('Error generating invoice:', error);
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongooseServerSelectionError') {
      return res.status(503).json({ message: 'Database connection failed. Please try again in a moment.' });
    }
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
});

// @route   POST /api/seller-invoices/generate-batch
// @desc    Generate multiple invoices in a single transaction/operation
router.post('/generate-batch', protect, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Image upload error' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (req.user?.role !== 'seller' && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to generate invoices' });
    }

    let sellerId = req.user?._id;
    if (req.admin && req.body.sellerId) {
      sellerId = req.body.sellerId;
    }

    if (!sellerId) {
      return res.status(400).json({ message: 'Seller ID is required' });
    }

    const { Order: OrderModel, SellerInvoice: InvoiceModel, InvoiceImage: InvoiceImageModel, Seller: SellerModel } = getModels(req);

    const seller = await SellerModel.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    let invoicesMetadata = [];
    try {
      invoicesMetadata = typeof req.body.invoices === 'string' 
        ? JSON.parse(req.body.invoices) 
        : (req.body.invoices || []);
    } catch (e) {
      return res.status(400).json({ message: 'Invalid invoices JSON structure' });
    }

    if (!Array.isArray(invoicesMetadata) || invoicesMetadata.length === 0) {
      return res.status(400).json({ message: 'At least one invoice entry is required.' });
    }

    const uploadedFiles = req.files || [];

    const filesByInvoiceIndex = {};
    uploadedFiles.forEach(file => {
      const match = file.fieldname.match(/invoice_(\d+)_image/);
      if (match) {
        const invIdx = parseInt(match[1], 10);
        if (!filesByInvoiceIndex[invIdx]) filesByInvoiceIndex[invIdx] = [];
        filesByInvoiceIndex[invIdx].push(file);
      }
    });

    const batchNumbers = new Set();
    for (let i = 0; i < invoicesMetadata.length; i++) {
      const item = invoicesMetadata[i];
      const trimmed = (item.invoiceNumber || '').toString().trim();
      if (!trimmed) {
        return res.status(400).json({ message: `Invoice #${i + 1} has an empty invoice number.` });
      }
      if (batchNumbers.has(trimmed)) {
        return res.status(400).json({ message: `Duplicate invoice number "${trimmed}" within this submission.` });
      }
      batchNumbers.add(trimmed);

      const itemFiles = filesByInvoiceIndex[i] || [];
      if (itemFiles.length === 0) {
        return res.status(400).json({ message: `Invoice #${trimmed} must have at least 1 image uploaded.` });
      }
      if (itemFiles.length > 5) {
        return res.status(400).json({ message: `Invoice #${trimmed} exceeds the maximum of 5 images.` });
      }
    }

    const existingDuplicates = await InvoiceModel.find({
      sellerId: sellerId,
      invoiceNumber: { $in: Array.from(batchNumbers) },
      status: { $nin: ['Cancelled', 'Rejected'] }
    }).select('invoiceNumber');

    if (existingDuplicates && existingDuplicates.length > 0) {
      const dupList = existingDuplicates.map(d => d.invoiceNumber).join(', ');
      return res.status(400).json({ 
        message: `Invoice number(s) "${dupList}" have already been used for this seller.` 
      });
    }

    const createdInvoices = [];

    for (let i = 0; i < invoicesMetadata.length; i++) {
      const item = invoicesMetadata[i];
      const trimmedInvNum = (item.invoiceNumber || '').toString().trim();
      const numSeq = /^\d+$/.test(trimmedInvNum) ? parseInt(trimmedInvNum, 10) : i + 1;
      const start = new Date(item.startDate);
      const end = new Date(item.endDate);
      end.setHours(23, 59, 59, 999);

      const itemFiles = filesByInvoiceIndex[i] || [];

      const {
        orderIds,
        validOrders,
        totalAmount,
        totalCommission
      } = await calculateSellerOrdersForRange({ OrderModel, InvoiceModel, sellerId, seller, start, end });

      let finalOrderIds = orderIds;
      let finalOrders = validOrders;
      let finalTotalAmount = totalAmount;
      let finalTotalCommission = totalCommission;

      if (finalOrderIds.length === 0) {
        const allOrdersInRange = await OrderModel.find({
          orderStatus: { $in: ['Delivered', 'Partially Returned', 'Returned'] },
          createdAt: { $gte: start, $lte: end }
        }).populate('items.productId');

        (allOrdersInRange || []).forEach(order => {
          let sellerItemsInOrder = (order.items || []).filter(it => {
            const matchesSellerObj = it.seller && it.seller.sellerId && it.seller.sellerId.toString() === sellerId.toString();
            const matchesDirectSellerId = it.sellerId && it.sellerId.toString() === sellerId.toString();
            const matchesProductRef = it.productId && it.productId.sellerId && it.productId.sellerId.toString() === sellerId.toString();
            const matchesName = it.sellerName && seller.name && it.sellerName.toLowerCase() === seller.name.toLowerCase();
            return matchesSellerObj || matchesDirectSellerId || matchesProductRef || matchesName;
          });
          if (sellerItemsInOrder.length > 0) {
            finalOrderIds.push(order._id);
            finalOrders.push(order);
            sellerItemsInOrder.forEach(it => {
              if (it.returnStatus !== 'Returned to Seller') {
                const qty = Number(it.quantity) || 1;
                const itemCommission = Number(it.totalCommission) || ((Number(it.unitCommission) || 0) * qty) || 0;
                const itemSellerPrice = (Number(it.sellerUnitPrice) || Number(it.normalPrice) || Number(it.price) || 0) * qty;
                finalTotalAmount += itemSellerPrice;
                finalTotalCommission += itemCommission;
              }
            });
          }
        });
      }

      const roundedTotalAmount = round2(finalTotalAmount);
      const roundedTotalCommission = round2(finalTotalCommission);
      const roundedNetAmount = round2(finalTotalAmount);

      const newInvoice = new InvoiceModel({
        sellerId: sellerId,
        invoiceNumber: trimmedInvNum,
        invoiceSequenceNumber: numSeq,
        startDate: start,
        endDate: end,
        totalAmount: roundedTotalAmount,
        totalCommission: roundedTotalCommission,
        netAmount: roundedNetAmount,
        orderCount: finalOrderIds.length,
        orders: finalOrderIds,
        status: 'Pending',
        hasInvoiceImage: itemFiles.length > 0,
        imageIds: [],
        generatedBy: req.user ? req.user._id : sellerId
      });

      await newInvoice.save();

      const savedDocs = [];
      for (let fIdx = 0; fIdx < itemFiles.length; fIdx++) {
        const file = itemFiles[fIdx];
        const filename = `${trimmedInvNum}_${Date.now()}_${fIdx + 1}_${file.originalname}`;
        const imageDoc = new InvoiceImageModel({
          invoiceId: newInvoice._id,
          sellerId: sellerId,
          filename: filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          fileSize: file.size,
          data: file.buffer,
          imageData: file.buffer
        });
        await imageDoc.save();
        savedDocs.push(imageDoc);
        newInvoice.imageIds.push(imageDoc._id);
      }

      if (itemFiles.length > 0) {
        newInvoice.invoiceImage = {
          data: itemFiles[0].buffer,
          contentType: itemFiles[0].mimetype,
          fileName: `${trimmedInvNum}_${Date.now()}_${itemFiles[0].originalname}`,
          size: itemFiles[0].size
        };
        newInvoice.imageMetadata = {
          filename: newInvoice.invoiceImage.fileName,
          originalName: itemFiles[0].originalname,
          mimeType: itemFiles[0].mimetype,
          size: itemFiles[0].size
        };
      }

      await newInvoice.save();

      try {
        const pdfBuffer = await generateSellerInvoicePDF({
          invoice: newInvoice,
          seller,
          orders: finalOrders,
          images: savedDocs.map(img => ({
            data: img.data || img.imageData,
            mimeType: img.mimeType,
            filename: img.originalName || img.filename
          }))
        });

        const adminEmail = process.env.EMAIL_USER;
        sendEmail({
          to: adminEmail,
          subject: `New Seller Invoice: ${seller.businessName || seller.name} (#${trimmedInvNum})`,
          html: `
            <h3>New Invoice Generated (Batch)</h3>
            <p><strong>Seller:</strong> ${seller.businessName || seller.name}</p>
            <p><strong>Invoice Number:</strong> ${trimmedInvNum}</p>
            <p><strong>Date Range:</strong> ${start.toDateString()} to ${end.toDateString()}</p>
            <p><strong>Net Payable:</strong> ₹${roundedNetAmount}</p>
            <p><strong>Total Orders:</strong> ${finalOrderIds.length}</p>
            <p><strong>Attached Images:</strong> ${itemFiles.length} file(s)</p>
          `,
          attachments: [
            {
              filename: `Invoice_${(seller.businessName || seller.name || 'Seller').replace(/\s+/g, '_')}_${trimmedInvNum}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf'
            }
          ]
        }).catch(e => console.error('Error emailing batch invoice:', e.message));
      } catch (pdfErr) {
        console.error('Error generating batch PDF:', pdfErr.message);
      }

      const invObj = newInvoice.toObject();
      if (invObj.invoiceImage) delete invObj.invoiceImage.data;
      invObj.imageCount = savedDocs.length;
      invObj.images = savedDocs.map(d => ({
        _id: d._id,
        filename: d.filename,
        originalName: d.originalName,
        mimeType: d.mimeType,
        size: d.fileSize || d.size
      }));
      createdInvoices.push(invObj);
    }

    res.status(201).json({
      message: `Successfully generated ${createdInvoices.length} invoice(s)`,
      invoices: createdInvoices
    });
  } catch (error) {
    console.error('Error generating batch invoices:', error);
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
});

// @route   GET /api/seller-invoices/:id/images
// @desc    List all images uploaded for this invoice
router.get('/:id/images', protect, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    if (!isOwner && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to view images for this invoice' });
    }

    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;
    const images = await InvoiceImageModel.find({ invoiceId: invoice._id })
      .select('-data -imageData')
      .sort({ createdAt: 1 })
      .lean();

    if ((!images || images.length === 0) && (invoice.hasInvoiceImage || invoice.invoiceImage)) {
      return res.json([{
        _id: 'legacy',
        invoiceId: invoice._id,
        filename: invoice.invoiceImage?.fileName || invoice.imageMetadata?.filename || 'invoice-image.jpg',
        originalName: invoice.imageMetadata?.originalName || 'invoice-image.jpg',
        mimeType: invoice.invoiceImage?.contentType || invoice.imageMetadata?.mimeType || 'image/jpeg',
        size: invoice.invoiceImage?.size || invoice.imageMetadata?.size || 0
      }]);
    }

    res.json(images || []);
  } catch (error) {
    console.error('Error fetching invoice images list:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/:id/images/:imageId
// @desc    Retrieve specific raw image from MongoDB binary storage by imageId
router.get('/:id/images/:imageId', protectImage, async (req, res) => {
  try {
    const { id, imageId } = req.params;
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(id, req);

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    if (!isOwner && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to view this invoice image' });
    }

    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;

    let imageDoc = null;
    if (imageId !== 'legacy' && mongoose.Types.ObjectId.isValid(imageId)) {
      imageDoc = await InvoiceImageModel.findOne({ _id: imageId, invoiceId: invoice._id });
    }

    let binaryData = null;
    let mimeType = 'image/jpeg';
    let filename = `invoice-${invoice.invoiceNumber || invoice._id}`;

    if (imageDoc) {
      binaryData = imageDoc.data || imageDoc.imageData;
      mimeType = imageDoc.mimeType || 'image/jpeg';
      filename = imageDoc.originalName || imageDoc.filename || filename;
    } else if (invoice.invoiceImage && invoice.invoiceImage.data) {
      binaryData = invoice.invoiceImage.data;
      mimeType = invoice.invoiceImage.contentType || invoice.imageMetadata?.mimeType || 'image/jpeg';
      filename = invoice.invoiceImage.fileName || invoice.imageMetadata?.filename || filename;
    }

    if (!binaryData) {
      return res.status(404).json({ message: 'Image not found' });
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', binaryData.length);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.send(binaryData);
  } catch (error) {
    console.error('Error retrieving image by id:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/:id/image
// @desc    Retrieve primary raw invoice image from MongoDB binary storage (Auth via Bearer OR ?token=)
router.get('/:id/image', protectImage, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    if (!isOwner && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to view this invoice image' });
    }

    let binaryData = null;
    let mimeType = 'image/jpeg';
    let filename = `invoice-${invoice.invoiceNumber || invoice._id}`;

    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;
    const imageDoc = await InvoiceImageModel.findOne({ invoiceId: invoice._id }).sort({ createdAt: 1 });
    if (imageDoc && (imageDoc.data || imageDoc.imageData)) {
      binaryData = imageDoc.data || imageDoc.imageData;
      mimeType = imageDoc.mimeType || 'image/jpeg';
      filename = imageDoc.originalName || imageDoc.filename || filename;
    }

    if (!binaryData && invoice.invoiceImage && invoice.invoiceImage.data) {
      binaryData = invoice.invoiceImage.data;
      mimeType = invoice.invoiceImage.contentType || invoice.imageMetadata?.mimeType || 'image/jpeg';
      filename = invoice.invoiceImage.fileName || invoice.imageMetadata?.filename || filename;
    }

    if (!binaryData) {
      return res.status(404).json({ message: 'No image uploaded for this invoice' });
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', binaryData.length);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.send(binaryData);
  } catch (error) {
    console.error('Error retrieving invoice image:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/my-invoices
// @desc    Get all invoices for logged in seller (excludes large image binary data from JSON payload)
router.get('/my-invoices', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'seller') {
      return res.status(403).json({ message: 'Only sellers can access this' });
    }

    const sellerId = req.user?._id;
    if (!sellerId) {
      return res.status(400).json({ message: 'Seller ID is required' });
    }

    const { SellerInvoice: InvoiceModel, InvoiceImage: InvoiceImageModel } = getModels(req);
    if (!InvoiceModel) {
      return res.json([]);
    }

    const invoices = await InvoiceModel.find({ sellerId })
      .select('-invoiceImage.data')
      .populate('sellerId', 'businessName name email storeName')
      .sort({ createdAt: -1 })
      .lean();

    if (!invoices || invoices.length === 0) {
      return res.json([]);
    }

    const invoiceIds = invoices.map(i => i._id);
    let allImages = [];
    if (InvoiceImageModel) {
      try {
        allImages = await InvoiceImageModel.find({ invoiceId: { $in: invoiceIds } })
          .select('_id invoiceId filename originalName mimeType size fileSize createdAt')
          .sort({ createdAt: 1 })
          .lean();
      } catch (imgErr) {
        console.warn('Could not query InvoiceImageModel:', imgErr.message);
      }
    }

    const imagesByInvoice = {};
    (allImages || []).forEach(img => {
      const invId = img.invoiceId?.toString();
      if (invId) {
        if (!imagesByInvoice[invId]) imagesByInvoice[invId] = [];
        imagesByInvoice[invId].push({
          _id: img._id,
          filename: img.filename,
          originalName: img.originalName,
          mimeType: img.mimeType,
          size: img.fileSize || img.size
        });
      }
    });

    const enrichedInvoices = invoices.map(inv => {
      const invIdStr = inv._id.toString();
      const imgs = imagesByInvoice[invIdStr] || [];
      const hasImg = imgs.length > 0 || inv.hasInvoiceImage || Boolean(inv.invoiceImage);
      return {
        ...inv,
        hasInvoiceImage: hasImg,
        imageCount: imgs.length || (hasImg ? 1 : 0),
        images: imgs
      };
    });

    res.json(enrichedInvoices || []);
  } catch (error) {
    console.error('Error fetching seller invoices:', error);
    if (error.name === 'MongoServerSelectionError' || error.name === 'MongooseServerSelectionError') {
      return res.status(503).json({ message: 'Database connection failed. Please try again in a moment.' });
    }
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
});

// @route   GET /api/seller-invoices/admin/all
// @desc    Get all invoices for admin (excludes large image binary data from list)
router.get('/admin/all', protect, async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ message: 'Admin only' });
    }
    
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const invoices = await aggregateGET(
        'SellerInvoice', 
        req, 
        {}, 
        [{ path: 'sellerId', select: 'businessName name email storeName phone' }], 
        '-invoiceImage.data', 
        { createdAt: -1 }
      );
      return res.json(invoices || []);
    } else {
      const { SellerInvoice: InvoiceModel } = getModels(req);
      const invoices = await InvoiceModel.find()
        .select('-invoiceImage.data')
        .populate('sellerId', 'businessName name email storeName phone')
        .sort({ createdAt: -1 });
      return res.json(invoices || []);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/:id
// @desc    Get single invoice details for Seller or Admin
router.get('/:id', protect, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    if (!isOwner && !req.admin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const OrderModel = models.Order || Order;
    const orders = await OrderModel.find({ _id: { $in: invoice.orders } }).select('orderId totalAmount orderStatus createdAt items paymentMethod');

    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;
    const imageDocs = await InvoiceImageModel.find({ invoiceId: invoice._id })
      .select('-data -imageData')
      .sort({ createdAt: 1 })
      .lean();

    const invObj = invoice.toObject ? invoice.toObject() : { ...invoice };
    if (invObj.invoiceImage && invObj.invoiceImage.data) {
      delete invObj.invoiceImage.data;
    }

    invObj.images = imageDocs || [];
    invObj.imageCount = (imageDocs && imageDocs.length > 0) ? imageDocs.length : (invObj.hasInvoiceImage ? 1 : 0);

    res.json({
      ...invObj,
      ordersList: orders || []
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/seller-invoices/admin/:id/clear
// @desc    Mark invoice as cleared
router.put('/admin/:id/clear', protect, async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ message: 'Admin only' });
    }
    const { invoice } = req.targetInvoice 
      ? { invoice: req.targetInvoice }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    
    invoice.status = 'Cleared';
    await invoice.save();
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/:id/download
// @desc    Download professional invoice PDF with all embedded tax invoice images
router.get('/:id/download', protect, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';

    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    const isAdmin = !!req.admin || (req.user && (req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'sales'));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const SellerModel = models.Seller || Seller;
    const OrderModel = models.Order || Order;
    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;

    const seller = await SellerModel.findById(invoice.sellerId);
    const orders = await OrderModel.find({ _id: { $in: invoice.orders } });

    const imageDocs = await InvoiceImageModel.find({ invoiceId: invoice._id }).sort({ createdAt: 1 });
    const images = [];

    (imageDocs || []).forEach(doc => {
      const buf = doc.data || doc.imageData;
      if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
        images.push({
          data: buf,
          mimeType: doc.mimeType,
          filename: doc.originalName || doc.filename
        });
      }
    });

    if (images.length === 0 && invoice.invoiceImage && invoice.invoiceImage.data) {
      images.push({
        data: invoice.invoiceImage.data,
        mimeType: invoice.invoiceImage.contentType || invoice.imageMetadata?.mimeType,
        filename: invoice.invoiceImage.fileName || invoice.imageMetadata?.filename || 'Invoice Image'
      });
    }

    const pdfBuffer = await generateSellerInvoicePDF({
      invoice,
      seller,
      orders: orders || [],
      images
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename=Invoice_${invoice.invoiceNumber || invoice._id}.pdf`);

    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error downloading invoice PDF:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/seller-invoices/:id
// @desc    Delete an invoice (only creator seller or admin) and clean up its raw binary images
router.delete('/:id', protect, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    if (!isOwner && !req.admin) {
      return res.status(403).json({ message: 'Not authorized to delete this invoice' });
    }

    try {
      const InvoiceImageModel = models.InvoiceImage || InvoiceImage;
      await InvoiceImageModel.deleteMany({ invoiceId: invoice._id });
    } catch (e) {
      console.warn('Could not clean InvoiceImage records:', e.message);
    }

    const InvoiceModel = models.SellerInvoice || SellerInvoice;
    await InvoiceModel.findByIdAndDelete(invoice._id);

    res.json({ 
      message: `Invoice #${invoice.invoiceNumber || invoice._id} deleted successfully`,
      deletedId: invoice._id 
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
