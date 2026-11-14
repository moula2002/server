const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');

const User = require('../models/User');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const Order = require('../models/Order');

// Helper to get models from req with fallback to global imports
const getModels = (req) => {
  return {
    User: req.models?.User || User,
    Seller: req.models?.Seller || Seller,
    Product: req.models?.Product || Product,
    Order: req.models?.Order || Order
  };
};

// Helper to gather all database connections in cluster
const getAllDbConnections = async (req = null) => {
  const mongoose = require('mongoose');
  const { connectDBByLocation, getTenantConnections } = require('../utils/db_manager');
  
  const connectionsMap = new Map();

  // 1. Add current default mongoose connection
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    connectionsMap.set(mongoose.connection.name || 'default', mongoose.connection);
  }

  // 2. Add currently scoped connection from req if available
  if (req?.db && req.db.readyState === 1) {
    connectionsMap.set(req.db.name || 'scoped', req.db);
  }

  // 3. Add all cached tenant connections from db_manager
  const cachedConns = getTenantConnections();
  for (const [key, conn] of Object.entries(cachedConns)) {
    if (conn && conn.readyState === 1) {
      connectionsMap.set(conn.name || key, conn);
    }
  }

  // 4. Ensure known tenant databases are connected
  const baseTenants = ['zudo-bengaluru', 'zudo-bangalore', 'zudo-central', 'zudodb'];
  for (const name of baseTenants) {
    try {
      const conn = await connectDBByLocation(name, name);
      if (conn && conn.readyState === 1) {
        connectionsMap.set(conn.name || name, conn);
      }
    } catch (e) {}
  }

  // 5. Discover additional tenant databases from central location documents if any
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

// @route   GET /api/sellers
// @desc    Get all sellers (Admin)
router.get('/', protect, async (req, res) => {
  try {
    const { aggregateGET } = require('../utils/aggregator');
    if (!req.locationId) {
      const sellers = await aggregateGET('Seller', req, {}, [], '-password');
      return res.json(sellers);
    } else {
      const { Seller: SellerModel } = getModels(req);
      let sellers = await SellerModel.find().select('-password');
      if (!sellers || sellers.length === 0) {
        sellers = await aggregateGET('Seller', req, {}, [], '-password');
      }
      return res.json(sellers);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/sellers
// @desc    Create a new seller (Admin)
router.post('/', protect, async (req, res) => {
  const { name, email, password, b2b, b2c, creditDays, businessName, status, isVerified, locationId, isProductVisible } = req.body;
  try {
    const { Seller: SellerModel } = getModels(req);
    const sellerExists = await SellerModel.findOne({ email });
    if (sellerExists) return res.status(400).json({ message: 'Seller already exists with this email' });

    const seller = await SellerModel.create({
      name,
      email,
      password,
      b2b,
      b2c,
      creditDays,
      businessName,
      storeName: businessName,
      status,
      isVerified,
      isProductVisible: isProductVisible !== undefined ? Boolean(isProductVisible) : true
    });

    res.status(201).json(seller);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/sellers/login
// @desc    Seller Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    let user = null;
    let foundLocationId = null;
    let foundDbName = null;

    // First try finding in the active (global or currently resolved) database
    const { Seller: SellerModel } = getModels(req);
    user = await SellerModel.findOne({ email });

    // If not found, search through all tenant DBs
    if (!user) {
      const mongoose = require('mongoose');
      const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/zudodb';
      const lastSlashIndex = URI.lastIndexOf('/');
      const lastQuestionIndex = URI.indexOf('?', lastSlashIndex);
      const CENTRAL_URI = URI.substring(0, lastSlashIndex + 1) + 'zudo-central' + (lastQuestionIndex !== -1 ? URI.substring(lastQuestionIndex) : '');
      
      const centralConn = await mongoose.createConnection(CENTRAL_URI).asPromise();
      const CentralLocation = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      const locations = await CentralLocation.find({ isActive: true }).lean();

      const { connectDBByLocation } = require('../utils/db_manager');
      for (const loc of locations) {
        const locId = loc._id.toString();
        const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
        const dbName = `zudo-${cityClean}`;
        
        try {
          const tenantConn = await connectDBByLocation(locId, dbName);
          const TenantSeller = tenantConn.models.Seller || tenantConn.model('Seller', require('../models/Seller').schema);
          
          const tenantUser = await TenantSeller.findOne({ email });
          if (tenantUser) {
            user = tenantUser;
            foundLocationId = locId;
            foundDbName = dbName;
            break; // Stop searching once found
          }
        } catch (e) {
          console.error(`Error checking tenant ${dbName} for seller login:`, e);
        }
      }
    }

    if (user && (await user.comparePassword(password))) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save();
      
      const token = jwt.sign(
        { 
          id: user._id, 
          tokenVersion: user.tokenVersion,
          locationId: foundLocationId,
          dbName: foundDbName
        }, 
        process.env.JWT_SECRET, 
        { expiresIn: '30d' }
      );
      
      // Check if profile is complete
      const businessName = user.businessName || user.storeName;
      const businessAddress = user.businessAddress || user.billingAddress;
      const isProfileComplete = user.isProfileComplete || !!(businessName && businessAddress && user.phone && user.storePic);
      
      res.json({ 
        token, 
        _id: user._id, 
        name: user.name, 
        email: user.email, 
        isProfileComplete,
        businessName: businessName,
        phone: user.phone,
        storePic: user.storePic,
        locationId: foundLocationId,
        dbName: foundDbName
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/me
// @desc    Get current seller profile
router.get('/me', protect, async (req, res) => {
  try {
    const { Seller: SellerModel } = getModels(req);
    const user = await SellerModel.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'Seller not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/sellers/profile
// @desc    Update seller profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { Seller: SellerModel } = getModels(req);
    const user = await SellerModel.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Seller not found' });

    // Update fields
    user.name = req.body.name || user.name;
    user.phone = req.body.phone || user.phone;
    user.businessName = req.body.businessName || req.body.storeName || user.businessName;
    user.businessAddress = req.body.businessAddress || req.body.billingAddress || user.businessAddress;
    user.gstNumber = req.body.gstNumber || user.gstNumber;
    user.panNumber = req.body.panNumber || user.panNumber;
    
    // Pickup Location handling (if provided as part of savedAddresses or separate field)
    if (req.body.pickupLocation) {
        user.pickupLocation = req.body.pickupLocation;
    }

    // Legal Documents
    user.storePic = req.body.storePic || user.storePic;
    user.profilePicture = req.body.storePic || req.body.profilePicture || user.profilePicture;
    user.gstDoc = req.body.gstDoc || user.gstDoc;
    user.panDoc = req.body.panDoc || user.panDoc;
    user.tradeLicenseDoc = req.body.tradeLicenseDoc || user.tradeLicenseDoc;
    user.rmcAmpcDoc = req.body.rmcAmpcDoc || user.rmcAmpcDoc;
    user.foodLicenseDoc = req.body.foodLicenseDoc || user.foodLicenseDoc;
    user.qrCodeDoc = req.body.qrCodeDoc || user.qrCodeDoc;
    user.qrOption = req.body.qrOption || user.qrOption;
    
    // Mark profile as complete
    user.isProfileComplete = true;

    const updatedUser = await user.save();
    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/products
// @desc    Get seller's products
router.get('/products', protect, async (req, res) => {
  try {
    const { Product: ProductModel } = getModels(req);
    let products = await ProductModel.find({ 
        $or: [
            { sellerId: req.user._id.toString() },
            { seller: req.user._id }
        ]
    }).populate('categoryId subCategoryId').lean();

    const sellerName = req.user.businessName || req.user.storeName || req.user.name;

    products = products.map(p => {
      const sPrice = p.sellerB2bPrice !== undefined && p.sellerB2bPrice !== null
        ? p.sellerB2bPrice
        : (p.sellerPrice !== undefined && p.sellerPrice !== null ? p.sellerPrice : (p.b2bPrice || p.price || 0));

      const cleanB2b = (p.b2b || []).map(v => {
        const vSeller = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
        return {
          ...v,
          sellerPrice: vSeller,
          price: vSeller
        };
      });

      return {
        ...p,
        sellerB2bPrice: sPrice,
        sellerPrice: sPrice,
        b2bPrice: sPrice,
        price: sPrice,
        commissionValue: 0,
        commissionAmount: 0,
        b2b: cleanB2b,
        sellerName: p.sellerName && p.sellerName !== 'Zudo Official' ? p.sellerName : sellerName,
        seller: {
          _id: req.user._id,
          name: sellerName
        }
      };
    });

    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/:id/products
// @desc    Get products uploaded by a specific seller (Admin)
router.get('/:id/products', protect, async (req, res) => {
  try {
    const sellerId = req.params.id;
    const mongoose = require('mongoose');
    const sellerObjId = mongoose.Types.ObjectId.isValid(sellerId) ? new mongoose.Types.ObjectId(sellerId) : null;

    const query = {
      $or: [
        { sellerId: sellerId },
        ...(sellerObjId ? [{ sellerId: sellerObjId }] : []),
        { 'seller._id': sellerId },
        ...(sellerObjId ? [{ 'seller._id': sellerObjId }] : [])
      ]
    };

    let products = [];
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      products = await aggregateGET('Product', req, query, ['categoryId', 'subCategoryId']);
      if (!products || products.length === 0) {
        const { Product: ProductModel } = getModels(req);
        products = await ProductModel.find(query).populate('categoryId subCategoryId').lean();
      }
    } else {
      const { Product: ProductModel } = getModels(req);
      products = await ProductModel.find(query).populate('categoryId subCategoryId').lean();
    }

    res.json(products);
  } catch (error) {
    console.error('Error fetching seller products:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/orders
// @desc    Get seller's orders
router.get('/orders', protect, async (req, res) => {
  try {
    const sellerId = req.user._id;
    const { Product: ProductModel, Order: OrderModel } = getModels(req);

    // 1. Find all products belonging to this seller
    const sellerProducts = await ProductModel.find({ 
        $or: [
            { sellerId: sellerId.toString() },
            { seller: sellerId }
        ]
    }).select('_id');
    
    if (!sellerProducts || sellerProducts.length === 0) {
      return res.json([]);
    }

    const productIds = sellerProducts.map(p => p._id);

    // 2. Find orders that contain ANY of these product IDs
    const orders = await OrderModel.find({
      'items': {
        $elemMatch: {
          productId: { $in: productIds }
        }
      }
    })
    .populate('userId', 'name email phone') // Populate customer info
    .populate('driverId', 'name phone email') // Populate driver info
    .sort({ createdAt: -1 });

    const modifiedOrders = orders.map(order => {
      const orderObj = order.toObject();
      const sellerPickup = orderObj.sellerPickups?.find(sp => sp.sellerId.toString() === sellerId.toString());
      if (sellerPickup) {
        orderObj.pickupCode = sellerPickup.pickupCode;
        orderObj.orderStatus = sellerPickup.status;
        orderObj.status = sellerPickup.status;
      } else {
        orderObj.status = orderObj.orderStatus;
      }
      return orderObj;
    });

    res.json(modifiedOrders);
  } catch (error) {
    console.error('Seller orders fetch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/stats
// @desc    Get dashboard stats
router.get('/stats', protect, async (req, res) => {
  try {
    const sellerId = req.user._id;
    const { Product: ProductModel, Order: OrderModel } = getModels(req);

    // Total Products
    const totalProducts = await ProductModel.countDocuments({ 
        $or: [
            { sellerId: sellerId.toString() },
            { seller: sellerId }
        ]
    });

    // Seller Products
    const sellerProducts = await ProductModel.find({ 
        $or: [
            { sellerId: sellerId.toString() },
            { seller: sellerId }
        ]
    }).select('_id name price imageUrl stock b2b b2c');
    const productIds = sellerProducts.map(p => p._id);

    // Helper to calculate stock using B2B variants as single source of truth
    const getProductStockSum = (p) => {
      if (Array.isArray(p.b2b) && p.b2b.length > 0) {
        return p.b2b.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
      }
      return Number(p.stock) || 0;
    };

    // Low stock products (stock <= 5)
    const lowStockProducts = sellerProducts
      .map(p => ({
        _id: p._id,
        name: p.name,
        price: p.price,
        imageUrl: p.imageUrl,
        stock: getProductStockSum(p)
      }))
      .filter(p => p.stock <= 5);

    // Orders stats
    const orders = await OrderModel.find({
      'items.productId': { $in: productIds }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = orders.filter(o => o.createdAt && new Date(o.createdAt) >= today).length;
    const activeOrders = orders.filter(o => ['Pending', 'Processing', 'Shipped'].includes(o.orderStatus)).length;

    let totalSales = 0;
    let outstandingPayments = 0;

    orders.forEach(curr => {
      const isCancelled = curr.orderStatus === 'Cancelled';
      const isPaid = curr.isSellerPaid || curr.paymentStatus === 'Paid';

      const sellerItems = curr.items.filter(item => 
        item.productId && productIds.some(pid => pid.equals(item.productId))
      );

      const sellerOrderTotal = sellerItems.reduce((s, i) => s + ((i.normalPrice || i.price || 0) * (i.quantity || 1)), 0);
      
      if (!isCancelled) {
        totalSales += sellerOrderTotal;
        if (!isPaid) {
          outstandingPayments += sellerOrderTotal;
        }
      }
    });

    res.json({
      totalProducts,
      todayOrders,
      totalOrders: orders.length,
      activeOrders,
      totalSales,
      outstandingPayments,
      lowStockCount: lowStockProducts.length,
      lowStockProducts
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/pickups
// @desc    Get orders waiting for pickup from this seller
router.get('/pickups', protect, async (req, res) => {
  try {
    const sellerId = req.user._id;
    const { Product: ProductModel, Order: OrderModel } = getModels(req);

    // 1. Find all products belonging to this seller
    const sellerProducts = await ProductModel.find({
        $or: [
            { sellerId: sellerId.toString() },
            { seller: sellerId }
        ]
    }).select('_id');

    const productIds = (sellerProducts || []).map(product => product._id);
    const sellerProductIds = new Set(productIds.map(id => id.toString()));

    // Include orders linked directly to this seller as well as older product-only records.
    const orders = await OrderModel.find({
      orderStatus: {
        $in: ['Pending', 'Packed', 'Confirmed', 'Accepted', 'Processing', 'Assigned', 'Out for Delivery', 'Picked Up', 'Shipped', 'Delivered', 'Partially Returned', 'Returned']
      },
      $or: [
        { 'sellerPickups.sellerId': sellerId },
        { 'items.seller.sellerId': sellerId },
        ...(productIds.length ? [{ 'items.productId': { $in: productIds } }] : [])
      ]
    })
    .populate('userId', 'name email phone')
    .populate('driverId', 'name phone vehicleNo vehicleDetails')
    .sort({ createdAt: -1 })
    .lean();

    const modifiedOrders = orders.map(order => {
      const orderObj = order;
      const originalOrderStatus = orderObj.orderStatus;
      const sellerPickup = orderObj.sellerPickups?.find(sp => sp.sellerId?.toString() === sellerId.toString());
      const pickupStatus = sellerPickup?.status || orderObj.orderStatus;
      if (['Cancelled', 'Rejected by Seller'].includes(pickupStatus)) return null;
      orderObj.pickupCode = sellerPickup?.pickupCode || orderObj.pickupCode;
      orderObj.orderStatus = pickupStatus;
      orderObj.status = pickupStatus;

      const shippingAddress = orderObj.shippingAddress || {};
      const customer = orderObj.userId || {};
      const driver = orderObj.driverId || null;
      const sellerItems = (orderObj.items || []).filter(item => {
        const itemSellerId = item.seller?.sellerId || item.sellerId;
        return itemSellerId?.toString() === sellerId.toString() ||
          sellerProductIds.has(item.productId?.toString());
      });
      if (!sellerItems.length) return null;

      const items = sellerItems.map(item => {
        const quantity = Number(item.quantity) || 0;
        const unitPrice = Number(item.price ?? item.unitCustomerPrice) || 0;
        const savedAmount = Number(
          item.finalCustomerAmount ??
          item.finalCustomerPrice
        );
        const amount = Number.isFinite(savedAmount) && savedAmount > 0
          ? savedAmount
          : unitPrice * quantity;

        return {
          ...item,
          name: item.name || item.product?.name || '',
          price: unitPrice,
          amount,
          unitLabel: [
            item.variantSize,
            item.productUnitSize && item.productUnitSize !== 1
              ? `${item.productUnitSize} ${item.measurementBasis || item.measurementUnit || ''}`.trim()
              : null,
            item.packagingType || item.unit || item.sellingUnit
          ].filter(Boolean).join(' · ')
        };
      });

      const taxAmount = items.reduce((sum, item) => {
        const itemTax = Number(item.gstAmount) || Number(item.totalGst) || 0;
        return sum + itemTax;
      }, 0);
      const itemAmounts = items.reduce((sum, item) => sum + item.amount, 0);
      const totalAmount = itemAmounts;
      const subtotal = Math.max(0, totalAmount - taxAmount);
      const assignmentStatus = driver
        ? 'Assigned'
        : originalOrderStatus === 'Assigned' || pickupStatus === 'Assigned'
          ? 'Assignment Pending'
          : 'Not Assigned';
      const pickupReference = sellerPickup?._id || orderObj._id;

      orderObj.pickupId = pickupReference?.toString() || '';
      orderObj.orderId = orderObj._id?.toString() || '';
      orderObj.customer = {
        name: shippingAddress.name?.trim() || customer.name?.trim() || '',
        phone: shippingAddress.phone?.trim() || customer.phone?.trim() || '',
        address: shippingAddress.address || '',
        city: shippingAddress.city || '',
        state: shippingAddress.state || '',
        pincode: shippingAddress.pincode || ''
      };
      orderObj.address = [
        orderObj.customer.address,
        orderObj.customer.city,
        orderObj.customer.state,
        orderObj.customer.pincode
      ].filter(Boolean).join(', ');
      orderObj.driver = driver;
      orderObj.assignmentStatus = assignmentStatus;
      orderObj.scheduledDate = sellerPickup?.scheduledDate ||
        sellerPickup?.pickupDate ||
        orderObj.scheduledDate ||
        orderObj.pickupDate ||
        null;
      orderObj.items = items;
      orderObj.subtotal = subtotal;
      orderObj.taxAmount = taxAmount;
      orderObj.totalAmount = totalAmount;

      return orderObj;
    }).filter(Boolean);

    res.json(modifiedOrders);
  } catch (error) {
    console.error('Seller pickups fetch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/sellers/:id/verify
// @desc    Verify/Approve a seller (Admin)
router.put('/:id/verify', protect, async (req, res) => {
  const { isVerified, status, creditDays } = req.body;
  try {
    const { Seller: SellerModel } = getModels(req);
    const seller = await SellerModel.findById(req.params.id);
    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    if (isVerified !== undefined) seller.isVerified = isVerified;
    if (status) seller.status = status;
    if (creditDays !== undefined) seller.creditDays = creditDays;

    const updatedSeller = await seller.save();
    res.json(updatedSeller);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/sellers/:id
// @desc    Update a seller's details (Admin)
router.put('/:id', protect, async (req, res) => {
  const { 
    name, email, phone, password, businessName, businessAddress, 
    gstNumber, panNumber, creditDays, status, isVerified, b2b, b2c,
    isProductVisible 
  } = req.body;
  try {
    const mongoose = require('mongoose');
    const sellerIdStr = req.params.id;
    const sellerObjId = mongoose.Types.ObjectId.isValid(sellerIdStr) ? new mongoose.Types.ObjectId(sellerIdStr) : null;

    const allConns = await getAllDbConnections(req);
    let seller = null;
    let PrimarySellerModel = null;
    let targetConn = null;

    // 1. First check currently scoped model from req
    const { Seller: ScopedSeller } = getModels(req);
    try {
      seller = await ScopedSeller.findById(sellerIdStr);
      if (seller) {
        PrimarySellerModel = ScopedSeller;
        targetConn = req.db || mongoose.connection;
      }
    } catch (e) {}

    // 2. If not found in scoped model, search across all cluster databases
    if (!seller) {
      for (const conn of allConns) {
        try {
          const Model = conn.models.Seller || conn.model('Seller', require('../models/Seller').schema);
          const found = await Model.findById(sellerIdStr);
          if (found) {
            seller = found;
            PrimarySellerModel = Model;
            targetConn = conn;
            break;
          }
        } catch (e) {}
      }
    }

    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    // Check if email is updated and is unique in primary database
    if (email && email !== seller.email && PrimarySellerModel) {
      const emailExists = await PrimarySellerModel.findOne({ email });
      if (emailExists) return res.status(400).json({ message: 'Another seller already exists with this email' });
      seller.email = email;
    }

    if (name !== undefined) seller.name = name;
    if (phone !== undefined) seller.phone = phone;
    if (password) seller.password = password; // pre-save hook handles hashing
    if (businessName !== undefined) {
      seller.businessName = businessName;
      seller.storeName = businessName;
    }
    if (businessAddress !== undefined) seller.businessAddress = businessAddress;
    if (gstNumber !== undefined) seller.gstNumber = gstNumber;
    if (panNumber !== undefined) seller.panNumber = panNumber;
    if (creditDays !== undefined) seller.creditDays = Number(creditDays) || 0;
    if (status !== undefined) seller.status = status;
    if (isVerified !== undefined) seller.isVerified = isVerified;
    if (b2b !== undefined) seller.b2b = b2b;
    if (b2c !== undefined) seller.b2c = b2c;
    
    let isVis = undefined;
    if (isProductVisible !== undefined) {
      isVis = Boolean(isProductVisible);
      seller.isProductVisible = isVis;
    }

    // Save seller model
    await seller.save();

    // Define product matching criteria precisely:
    // 1. By sellerId (ObjectId and String)
    // 2. By nested seller._id (ObjectId and String)
    // 3. By seller (ObjectId and String)
    // 4. By sellerName matching businessName, storeName, or name (excluding generic fallback 'Zudo Official')
    const prodQuery = {
      $or: [
        { sellerId: sellerIdStr },
        ...(sellerObjId ? [{ sellerId: sellerObjId }] : []),
        { 'seller._id': sellerIdStr },
        ...(sellerObjId ? [{ 'seller._id': sellerObjId }] : []),
        { seller: sellerIdStr },
        ...(sellerObjId ? [{ seller: sellerObjId }] : [])
      ]
    };

    const businessNameToMatch = (seller.businessName || seller.storeName || '').trim();
    if (businessNameToMatch && businessNameToMatch !== 'Zudo Official' && businessNameToMatch.length > 1) {
      prodQuery.$or.push({ sellerName: businessNameToMatch });
    }
    const sellerNameToMatch = (seller.name || '').trim();
    if (sellerNameToMatch && sellerNameToMatch !== 'Zudo Official' && sellerNameToMatch !== businessNameToMatch && sellerNameToMatch.length > 1) {
      prodQuery.$or.push({ sellerName: sellerNameToMatch });
    }

    const sellerUpdateFields = {};
    if (name !== undefined) sellerUpdateFields.name = name;
    if (phone !== undefined) sellerUpdateFields.phone = phone;
    if (businessName !== undefined) {
      sellerUpdateFields.businessName = businessName;
      sellerUpdateFields.storeName = businessName;
    }
    if (businessAddress !== undefined) sellerUpdateFields.businessAddress = businessAddress;
    if (gstNumber !== undefined) sellerUpdateFields.gstNumber = gstNumber;
    if (panNumber !== undefined) sellerUpdateFields.panNumber = panNumber;
    if (creditDays !== undefined) sellerUpdateFields.creditDays = Number(creditDays) || 0;
    if (status !== undefined) sellerUpdateFields.status = status;
    if (isVerified !== undefined) sellerUpdateFields.isVerified = isVerified;
    if (b2b !== undefined) sellerUpdateFields.b2b = b2b;
    if (b2c !== undefined) sellerUpdateFields.b2c = b2c;
    if (isVis !== undefined) sellerUpdateFields.isProductVisible = isVis;

    // Direct atomic updates across ALL cluster databases to guarantee 100% persistence
    for (const conn of allConns) {
      try {
        if (Object.keys(sellerUpdateFields).length > 0) {
          await conn.collection('sellers').updateMany(
            { $or: [{ _id: sellerIdStr }, ...(sellerObjId ? [{ _id: sellerObjId }] : [])] },
            { $set: sellerUpdateFields }
          );
        }

        if (isVis !== undefined) {
          const pRes = await conn.collection('products').updateMany(
            prodQuery,
            { $set: { isProductVisible: isVis } }
          );
          if (pRes.modifiedCount > 0) {
            console.log(`[Product Visibility Sync] Updated ${pRes.modifiedCount} products in ${conn.name} to isProductVisible: ${isVis}`);
          }
        }
      } catch (cErr) {
        console.error(`Error syncing seller to DB (${conn.name}):`, cErr.message);
      }
    }

    // Explicitly verify the saved database record directly from MongoDB Atlas
    const verifyDb = targetConn || mongoose.connection;
    const verifiedSeller = await verifyDb.collection('sellers').findOne({
      $or: [{ _id: sellerIdStr }, ...(sellerObjId ? [{ _id: sellerObjId }] : [])]
    });

    if (!verifiedSeller) {
      return res.status(500).json({ message: 'Verification error: Updated seller not found in database.' });
    }

    if (isVis !== undefined && verifiedSeller.isProductVisible !== isVis) {
      return res.status(500).json({ 
        message: `Database synchronization error: Seller isProductVisible failed to update in database. Expected ${isVis}, found ${verifiedSeller.isProductVisible}.`,
        expected: isVis,
        actual: verifiedSeller.isProductVisible
      });
    }

    // Broadcast real-time change via Socket.io
    try {
      const { getIO } = require('../utils/socket');
      const io = getIO();
      if (io) {
        io.emit('data_updated', { model: 'Seller', operation: 'update', timestamp: new Date() });
        if (isVis !== undefined) {
          io.emit('data_updated', { model: 'Product', operation: 'update', timestamp: new Date() });
        }
      }
    } catch (sErr) {}

    const returnedSeller = { ...verifiedSeller };
    delete returnedSeller.password;
    res.json(returnedSeller);
  } catch (error) {
    console.error('Error updating seller:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/returns
// @desc    Get returns for this seller
router.get('/returns', protect, async (req, res) => {
  try {
    const sellerId = req.user._id;
    const sellerIdStr = sellerId.toString();
    const { Product: ProductModel, Order: OrderModel } = getModels(req);

    // 1. Find all products belonging to this seller (try both ObjectId and string)
    const sellerProducts = await ProductModel.find({ 
      $or: [
        { sellerId: sellerId },
        { sellerId: sellerIdStr },
        { seller: sellerId }
      ]
    }).select('_id').lean();

    console.log(`[Seller Returns] sellerId=${sellerIdStr}, products found=${sellerProducts.length}`);

    const productIds = sellerProducts.map(p => p._id);
    const productIdsStr = productIds.map(id => id.toString());

    // 2. Find orders with return requests — search by:
    //    a) Item productId matching seller's products
    //    b) OR item.seller.sellerId matching this seller directly
    const RETURN_STATUSES = ['Return Requested', 'Return Approved', 'Return Rejected', 'Picked Up from Customer', 'Returned to Seller'];

    const orQuery = [
      {
        'items': {
          $elemMatch: {
            returnStatus: { $in: RETURN_STATUSES }
          }
        },
        ...(productIds.length > 0 ? {
          'items.productId': { $in: productIds }
        } : {})
      }
    ];

    // Also match by seller ID embedded in order items
    orQuery.push({
      'items': {
        $elemMatch: {
          'seller.sellerId': sellerId,
          returnStatus: { $in: RETURN_STATUSES }
        }
      }
    });

    const orders = await OrderModel.find({ $or: orQuery })
      .populate('userId', 'name email phone bankDetails')
      .sort({ updatedAt: -1 })
      .lean();

    console.log(`[Seller Returns] orders with returns found=${orders.length}`);

    // Filter order items to only show returned items belonging to this seller
    const filteredOrders = orders
      .map(order => {
        order.items = order.items.filter(item => {
          if (!item.returnStatus || item.returnStatus === 'None') return false;
          if (!RETURN_STATUSES.includes(item.returnStatus)) return false;

          // Match by productId OR by seller.sellerId embedded in item
          const itemProductIdStr = item.productId ? item.productId.toString() : '';
          const itemSellerIdStr = item.seller?.sellerId ? item.seller.sellerId.toString() : '';

          return productIdsStr.includes(itemProductIdStr) || itemSellerIdStr === sellerIdStr;
        });
        return order;
      })
      .filter(order => order.items.length > 0); // Remove orders with no matching items

    res.json(filteredOrders);
  } catch (error) {
    console.error('Seller returns fetch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/sellers/:id
// @desc    Delete a seller (Admin)
router.delete('/:id', protect, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const sellerIdStr = req.params.id;
    const sellerObjId = mongoose.Types.ObjectId.isValid(sellerIdStr) ? new mongoose.Types.ObjectId(sellerIdStr) : null;
    const allConns = await getAllDbConnections();
    for (const conn of allConns) {
      try {
        await conn.collection('sellers').deleteMany(
          { $or: [{ _id: sellerIdStr }, ...(sellerObjId ? [{ _id: sellerObjId }] : [])] }
        );
      } catch (e) {}
    }
    res.json({ message: 'Seller account deleted successfully!' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
