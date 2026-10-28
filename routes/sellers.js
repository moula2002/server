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

// @route   GET /api/sellers
// @desc    Get all sellers (Admin)
router.get('/', protect, async (req, res) => {
  try {
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const sellers = await aggregateGET('Seller', req, {}, [], '-password');
      res.json(sellers);
    } else {
      const { Seller: SellerModel } = getModels(req);
      const sellers = await SellerModel.find().select('-password');
      res.json(sellers);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/sellers
// @desc    Create a new seller (Admin)
router.post('/', protect, async (req, res) => {
  const { name, email, password, b2b, b2c, creditDays, businessName, status, isVerified, locationId } = req.body;
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
      isVerified
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
    }).select('_id name price imageUrl stock');
    const productIds = sellerProducts.map(p => p._id);

    // Low stock products (stock <= 5)
    const lowStockProducts = sellerProducts.filter(p => (p.stock || 0) <= 5);

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
    
    if (!sellerProducts || sellerProducts.length === 0) {
      return res.json([]);
    }

    const productIds = sellerProducts.map(p => p._id);

    // 2. Find orders that contain ANY of these product IDs AND are in a status awaiting pickup
    const orders = await OrderModel.find({
      'items.productId': { $in: productIds },
      'orderStatus': { $in: ['Pending', 'Packed', 'Confirmed', 'Accepted', 'Processing', 'Assigned', 'Out for Delivery'] }
    })
    .populate('userId', 'name email phone')
    .populate('driverId', 'name phone')
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
  const { name, email, phone, password, businessName, businessAddress, gstNumber, panNumber, creditDays, status, isVerified, b2b, b2c } = req.body;
  try {
    const { Seller: SellerModel } = getModels(req);
    const seller = await SellerModel.findById(req.params.id);
    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    // Check if email is updated and is unique
    if (email && email !== seller.email) {
      const emailExists = await SellerModel.findOne({ email });
      if (emailExists) return res.status(400).json({ message: 'Another seller already exists with this email' });
      seller.email = email;
    }

    if (name) seller.name = name;
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

    const updatedSeller = await seller.save();
    
    // Select all fields except password
    const returnedSeller = await SellerModel.findById(updatedSeller._id).select('-password');
    res.json(returnedSeller);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/sellers/returns
// @desc    Get returns for this seller
router.get('/returns', protect, async (req, res) => {
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

    // 2. Find orders that contain ANY of these product IDs and have items with returnStatus != 'None'
    const orders = await OrderModel.find({
      'items': {
        $elemMatch: {
          productId: { $in: productIds },
          returnStatus: { $ne: 'None' }
        }
      }
    })
    .populate('userId', 'name email phone bankDetails')
    .sort({ updatedAt: -1 })
    .lean();

    const productIdsStr = productIds.map(id => id.toString());
    const filteredOrders = orders.map(order => {
      order.items = order.items.filter(item => 
        item.returnStatus && 
        item.returnStatus !== 'None' && 
        productIdsStr.includes(item.productId.toString())
      );
      return order;
    });

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
    const { Seller: SellerModel } = getModels(req);
    const seller = await SellerModel.findById(req.params.id);
    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    await SellerModel.findByIdAndDelete(req.params.id);
    res.json({ message: 'Seller account deleted successfully!' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
