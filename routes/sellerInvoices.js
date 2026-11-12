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

// Configure multer to store file in memory as Buffer for MongoDB binary storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
    const isAllowedExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);

    if (allowedTypes.includes(file.mimetype.toLowerCase()) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Only JPG, JPEG, PNG, and WEBP are allowed.'));
    }
  }
});

const getModels = (req) => {
  return {
    Order: req.models?.Order || Order,
    SellerInvoice: req.models?.SellerInvoice || SellerInvoice,
    InvoiceImage: req.models?.InvoiceImage || InvoiceImage,
    Seller: req.models?.Seller || Seller
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
        const TenantInvoice = tenantConn.models.SellerInvoice || tenantConn.model('SellerInvoice', SellerInvoice.schema);
        const inv = await TenantInvoice.findById(id);
        if (inv) {
          return {
            invoice: inv,
            models: {
              Order: tenantConn.models.Order || tenantConn.model('Order', Order.schema),
              SellerInvoice: TenantInvoice,
              InvoiceImage: tenantConn.models.InvoiceImage || tenantConn.model('InvoiceImage', InvoiceImage.schema),
              Seller: tenantConn.models.Seller || tenantConn.model('Seller', Seller.schema)
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
      // Merge models onto req.models to preserve User, Seller, Location, etc. loaded by tenant/auth middleware
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
        const TenantSeller = tenantConn.models.Seller || tenantConn.model('Seller', Seller.schema);
        account = await TenantSeller.findById(decoded.id).select('-password');
      } catch (e) {}
    }

    if (!account) {
      // Check across known tenant connections
      const connections = getTenantConnections();
      for (const [dbName, tenantConn] of Object.entries(connections)) {
        try {
          const TenantSeller = tenantConn.models.Seller || tenantConn.model('Seller', Seller.schema);
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

    const { SellerInvoice: InvoiceModel } = getModels(req);
    const existingInvoices = await InvoiceModel.find({ sellerId })
      .select('invoiceNumber invoiceSequenceNumber createdAt')
      .sort({ createdAt: 1 });

    const usedNumbers = [];
    const usedNumericSequences = [];

    existingInvoices.forEach(inv => {
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
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/seller-invoices/generate
// @desc    Generate a new invoice for a seller with optional/required image upload
router.post('/generate', protect, (req, res, next) => {
  upload.single('invoiceImage')(req, res, (err) => {
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

    if (!rawInvoiceNumber || !rawInvoiceNumber.toString().trim()) {
      return res.status(400).json({ message: 'Manual invoice number is required (e.g. 1, 2, 3...)' });
    }

    const trimmedInvoiceNumber = rawInvoiceNumber.toString().trim();

    if (!/^\d+$/.test(trimmedInvoiceNumber)) {
      return res.status(400).json({ 
        message: 'Invoice number must be a sequential positive number (1, 2, 3, 4...).' 
      });
    }

    const numericInvoiceNumber = parseInt(trimmedInvoiceNumber, 10);
    if (numericInvoiceNumber <= 0) {
      return res.status(400).json({ message: 'Invoice number must be greater than 0.' });
    }

    const { Order: OrderModel, SellerInvoice: InvoiceModel, InvoiceImage: InvoiceImageModel, Seller: SellerModel } = getModels(req);

    // 1. Check for duplicate invoice number for this seller
    const duplicate = await InvoiceModel.findOne({
      sellerId: sellerId,
      invoiceNumber: trimmedInvoiceNumber
    });

    if (duplicate) {
      return res.status(400).json({ 
        message: `Invoice number "${trimmedInvoiceNumber}" has already been used by you. Duplicate invoice numbers are not allowed.` 
      });
    }

    // 2. Validate sequential order against previously generated invoices
    const allSellerInvoices = await InvoiceModel.find({ sellerId }).select('invoiceNumber invoiceSequenceNumber').lean();
    const usedNumericSequences = [];
    allSellerInvoices.forEach(inv => {
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

    if (numericInvoiceNumber !== nextExpectedNumber) {
      return res.status(400).json({
        message: `Sequential numbering required. The next expected invoice number is ${nextExpectedNumber}. You entered ${numericInvoiceNumber}. Skipping or regressing numbers is not permitted.`
      });
    }

    // Check for overlapping cleared/pending invoices
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    const overlappingInvoice = await InvoiceModel.findOne({
      sellerId: sellerId,
      startDate: { $lte: end },
      endDate: { $gte: start }
    });

    if (overlappingInvoice) {
      return res.status(400).json({ 
        message: 'You already have an invoice generated that overlaps with this date range. Status: ' + overlappingInvoice.status 
      });
    }

    const seller = await SellerModel.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    // Query all Delivered orders within date range
    const orders = await OrderModel.find({
      orderStatus: { $in: ['Delivered', 'Partially Returned', 'Returned'] },
      createdAt: { $gte: start, $lte: end }
    }).populate('items.productId');

    let totalAmount = 0;
    let totalCommission = 0;
    let orderIds = [];
    const validOrders = [];

    // Calculate totals specifically for this seller's items
    orders.forEach(order => {
      let sellerItemsInOrder = order.items.filter(item => {
        const matchesSellerObj = item.seller && item.seller.sellerId && item.seller.sellerId.toString() === sellerId.toString();
        const matchesProductRef = item.productId && item.productId.sellerId && item.productId.sellerId.toString() === sellerId.toString();
        const matchesName = item.sellerName && seller.name && item.sellerName.toLowerCase() === seller.name.toLowerCase();
        const matchesStore = item.sellerName && seller.storeName && item.sellerName.toLowerCase() === seller.storeName.toLowerCase();
        const matchesBusiness = item.sellerName && seller.businessName && item.sellerName.toLowerCase() === seller.businessName.toLowerCase();
        const productMatchesName = item.product && item.product.sellerName && seller.name && item.product.sellerName.toLowerCase() === seller.name.toLowerCase();
        const productMatchesStore = item.product && item.product.sellerName && seller.storeName && item.product.sellerName.toLowerCase() === seller.storeName.toLowerCase();
        
        return matchesSellerObj || matchesProductRef || matchesName || matchesStore || matchesBusiness || productMatchesName || productMatchesStore;
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

    if (orderIds.length === 0) {
      return res.status(400).json({ message: 'No delivered orders found in this date range.' });
    }

    const roundedTotalAmount = round2(totalAmount);
    const roundedTotalCommission = round2(totalCommission);
    const roundedNetAmount = round2(totalAmount);

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
      orderCount: orderIds.length,
      orders: orderIds,
      status: 'Pending',
      hasInvoiceImage: Boolean(req.file),
      generatedBy: req.user ? req.user._id : sellerId
    });

    let uploadedImageBuffer = null;
    let uploadedImageMime = null;

    // Store raw binary Buffer directly in MongoDB
    if (req.file) {
      uploadedImageBuffer = req.file.buffer;
      uploadedImageMime = req.file.mimetype;

      newInvoice.invoiceImage = {
        data: req.file.buffer,
        contentType: req.file.mimetype,
        fileName: `${trimmedInvoiceNumber}_${Date.now()}_${req.file.originalname}`,
        size: req.file.size
      };

      newInvoice.imageMetadata = {
        filename: newInvoice.invoiceImage.fileName,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
      };

      // Also save in InvoiceImage collection for dual-layer compatibility
      try {
        const invoiceImageDoc = new InvoiceImageModel({
          invoiceId: newInvoice._id,
          sellerId: sellerId,
          filename: newInvoice.invoiceImage.fileName,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          data: req.file.buffer
        });
        await invoiceImageDoc.save();
      } catch (err) {
        console.warn('Could not save to InvoiceImage collection:', err.message);
      }
    }

    await newInvoice.save();
    
    // Generate Redesigned Professional PDF Invoice with Embedded Image
    try {
      const pdfBuffer = await generateSellerInvoicePDF({
        invoice: newInvoice,
        seller,
        orders: validOrders,
        imageBuffer: uploadedImageBuffer,
        imageMimeType: uploadedImageMime
      });

      // Email Admin
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
          <p><strong>Total Orders:</strong> ${orderIds.length}</p>
          ${req.file ? `<p><strong>Attached Invoice Image:</strong> ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)</p>` : ''}
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

    // Strip binary buffer from JSON response for efficiency
    const invoiceResp = newInvoice.toObject();
    if (invoiceResp.invoiceImage) {
      delete invoiceResp.invoiceImage.data;
    }

    res.status(201).json(invoiceResp);
  } catch (error) {
    console.error('Error generating invoice:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/seller-invoices/:id/image
// @desc    Retrieve raw invoice image from MongoDB binary storage (Auth via Bearer OR ?token=)
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

    // 1. Try invoice.invoiceImage.data (embedded buffer)
    if (invoice.invoiceImage && invoice.invoiceImage.data) {
      binaryData = invoice.invoiceImage.data;
      mimeType = invoice.invoiceImage.contentType || invoice.imageMetadata?.mimeType || 'image/jpeg';
      filename = invoice.invoiceImage.fileName || invoice.imageMetadata?.filename || filename;
    }

    // 2. Fallback to InvoiceImage collection
    if (!binaryData) {
      const InvoiceImageModel = models.InvoiceImage || InvoiceImage;
      const imageDoc = await InvoiceImageModel.findOne({ invoiceId: invoice._id });
      if (imageDoc && imageDoc.data) {
        binaryData = imageDoc.data;
        mimeType = imageDoc.mimeType || 'image/jpeg';
        filename = imageDoc.filename || filename;
      }
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
    if (req.user.role !== 'seller') {
      return res.status(403).json({ message: 'Only sellers can access this' });
    }
    const { SellerInvoice: InvoiceModel } = getModels(req);
    const invoices = await InvoiceModel.find({ sellerId: req.user._id })
      .select('-invoiceImage.data')
      .populate('sellerId', 'businessName name email storeName')
      .sort({ createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
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
      return res.json(invoices);
    } else {
      const { SellerInvoice: InvoiceModel } = getModels(req);
      const invoices = await InvoiceModel.find()
        .select('-invoiceImage.data')
        .populate('sellerId', 'businessName name email storeName phone')
        .sort({ createdAt: -1 });
      return res.json(invoices);
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

    const invObj = invoice.toObject ? invoice.toObject() : { ...invoice };
    if (invObj.invoiceImage && invObj.invoiceImage.data) {
      delete invObj.invoiceImage.data;
    }

    res.json({
      ...invObj,
      ordersList: orders
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
// @desc    Download redesigned professional invoice PDF with embedded tax invoice image
router.get('/:id/download', protect, async (req, res) => {
  try {
    const { invoice, models } = req.targetInvoice 
      ? { invoice: req.targetInvoice, models: req.models }
      : await findInvoiceAcrossAllDBs(req.params.id, req);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';

    // Auth check: Allow invoice owner (seller) or any authenticated admin
    const isOwner = req.user && req.user._id && req.user._id.toString() === sellerIdStr;
    const isAdmin = !!req.admin || (req.user && (req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'sales'));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const SellerModel = models.Seller || Seller;
    const OrderModel = models.Order || Order;
    const InvoiceImageModel = models.InvoiceImage || InvoiceImage;

    // Fetch seller and orders
    const seller = await SellerModel.findById(invoice.sellerId);
    const orders = await OrderModel.find({ _id: { $in: invoice.orders } });

    // Retrieve raw binary image buffer from MongoDB
    let imageBuffer = null;
    let imageMimeType = null;

    if (invoice.invoiceImage && invoice.invoiceImage.data) {
      imageBuffer = invoice.invoiceImage.data;
      imageMimeType = invoice.invoiceImage.contentType || invoice.imageMetadata?.mimeType;
    }

    if (!imageBuffer) {
      const imgDoc = await InvoiceImageModel.findOne({ invoiceId: invoice._id });
      if (imgDoc && imgDoc.data) {
        imageBuffer = imgDoc.data;
        imageMimeType = imgDoc.mimeType;
      }
    }

    // Generate the professional PDF
    const pdfBuffer = await generateSellerInvoicePDF({
      invoice,
      seller,
      orders,
      imageBuffer,
      imageMimeType
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

    // Clean up stored image in InvoiceImage collection if exists
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
