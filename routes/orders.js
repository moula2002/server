const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const sendEmail = require('../utils/email');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const Driver = require('../models/Driver');
const CashCollector = require('../models/CashCollector');
const { loadCommissions } = require('./products');
const { applyCommission, calculatePricingBreakdown, findCategoryCommission, round2 } = require('../utils/pricing');
const {
  generate6DigitOTP,
  prepareOrderDeliveryOtp,
  canResendDeliveryOtp,
  verifyOrderDeliveryOtp,
  dispatchDeliveryOtpNotification
} = require('../utils/otpService');

// Helper to get models from req with fallback to global imports

// Helper to automatically assign sequential invoice and order reference numbers
const assignInvoiceDetails = async (OrderModel) => {
  try {
    const lastSeqOrder = await OrderModel.findOne({ invoiceSequence: { $exists: true, $ne: null } })
      .sort({ invoiceSequence: -1 })
      .select('invoiceSequence');
    const nextSeq = (lastSeqOrder && typeof lastSeqOrder.invoiceSequence === 'number') 
      ? lastSeqOrder.invoiceSequence + 1 
      : (await OrderModel.countDocuments() + 1);
    const orderRef = `SNB-${700 + nextSeq}`;
    const invoiceNumber = orderRef;
    return { invoiceSequence: nextSeq, orderRef, invoiceNumber };
  } catch (err) {
    const fallbackSeq = 1;
    return { invoiceSequence: fallbackSeq, orderRef: `SNB-${700 + fallbackSeq}`, invoiceNumber: `SNB-${700 + fallbackSeq}` };
  }
};

const emitOrderRealtimeUpdate = (order, operation = 'update') => {
  try {
    const { getIO } = require('../utils/socket');
    const io = getIO();
    if (io && order) {
      const orderId = order._id ? order._id.toString() : String(order);
      const payload = {
        model: 'Order',
        operation,
        orderId,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        driverId: order.driverId,
        cashPersonId: order.cashPersonId,
        totalAmount: order.totalAmount,
        timestamp: new Date()
      };
      io.emit('data_updated', payload);
      io.emit('order:updated', payload);
      io.emit('order:status_changed', payload);
      if (order.orderStatus === 'Delivered') {
        io.emit('order:delivered', { orderId });
      }
      io.emit(`order:${orderId}`, { type: 'ORDER_STATUS_CHANGED', ...payload });
    }
  } catch (e) {
    // Socket not initialized or offline
  }
};

const getModels = (req) => {
  return {
    Order: req.models?.Order || Order,
    Product: req.models?.Product || Product,
    Seller: req.models?.Seller || Seller,
    Driver: req.models?.Driver || Driver,
    CashCollector: req.models?.CashCollector || CashCollector,
    User: req.models?.User || require('../models/User'),
    Admin: req.models?.Admin || require('../models/Admin'),
    Notification: req.models?.Notification || require('../models/Notification')
  };
};

// Middleware to resolve tenant DB for orders if accessed by global admin
router.param('id', async (req, res, next, id) => {
  console.log(`[router.param('id')] Intercepting ID: ${id}`);
  console.log(`[router.param('id')] req.isTenant: ${req.isTenant}, req.locationId: ${req.locationId}`);
  if (req.isTenant || req.locationId) return next();

  try {
    const { getTenantConnections } = require('../utils/db_manager');
    const connections = await getTenantConnections();

    for (const [dbName, tenantConn] of Object.entries(connections)) {
      const TenantOrder = tenantConn.models.Order || tenantConn.model('Order', require('../models/Order').schema);
      try {
        const orderExists = await TenantOrder.exists({ _id: id });
        if (orderExists) {
          console.log(`[router.param('id')] FOUND order in DB: ${dbName}`);
          req.models = {
            Order: TenantOrder,
            Product: tenantConn.models.Product || tenantConn.model('Product', require('../models/Product').schema),
            Seller: tenantConn.models.Seller || tenantConn.model('Seller', require('../models/Seller').schema),
            Driver: tenantConn.models.Driver || tenantConn.model('Driver', require('../models/Driver').schema),
            CashCollector: tenantConn.models.CashCollector || tenantConn.model('CashCollector', require('../models/CashCollector').schema),
            User: tenantConn.models.User || tenantConn.model('User', require('../models/User').schema),
            Admin: tenantConn.models.Admin || tenantConn.model('Admin', require('../models/Admin').schema),
            Notification: tenantConn.models.Notification || tenantConn.model('Notification', require('../models/Notification').schema)
          };
          req.db = tenantConn;
          return next();
        }
      } catch (e) {
        console.error(`[router.param('id')] Cast error in DB ${dbName} for id ${id}`);
      }
    }
    console.log(`[router.param('id')] Order NOT FOUND in any tenant DB`);
  } catch (error) {
    console.error('Error resolving order tenant:', error);
  }
  next();
});

// Helper function to get product stock (considering size variants)
const getProductStock = (product, variantSize, role) => {
  if (variantSize) {
    const variantArray = role === 'b2b' ? (product.b2b || []) : (product.b2c || []);
    let foundVariant = null;
    if (variantArray.length > 0) {
      foundVariant = variantArray.find(v => (v.packetSize || v.sizeName) === variantSize);
    }
    if (!foundVariant && product.variants && product.variants.length > 0) {
      foundVariant = product.variants.find(v => v.sizeName === variantSize);
    }
    if (!foundVariant && role === 'b2b' && product.b2c && product.b2c.length > 0) {
      foundVariant = product.b2c.find(v => (v.packetSize || v.sizeName) === variantSize);
    } else if (!foundVariant && role !== 'b2b' && product.b2b && product.b2b.length > 0) {
      foundVariant = product.b2b.find(v => (v.packetSize || v.sizeName) === variantSize);
    }

    if (foundVariant) {
      return { hasVariant: true, stock: foundVariant.stock || 0 };
    }
    return { hasVariant: false, stock: 0 };
  }
  const hasVariants = (product.b2b && product.b2b.length > 0) ||
    (product.b2c && product.b2c.length > 0) ||
    (product.variants && product.variants.length > 0);

  if (!variantSize && hasVariants) {
    // If no variantSize provided but product has variants, fallback to first variant
    let firstVariant = null;
    if (role === 'b2b') {
      firstVariant = (product.b2b && product.b2b[0]) || (product.variants && product.variants[0]) || (product.b2c && product.b2c[0]);
    } else {
      firstVariant = (product.b2c && product.b2c[0]) || (product.variants && product.variants[0]) || (product.b2b && product.b2b[0]);
    }
    if (firstVariant) {
      return { hasVariant: true, stock: firstVariant.stock || 0 };
    }
  }

  return { hasVariant: true, stock: product.stock || 0 };
};

// Helper function to adjust product/variant stock
const adjustProductStock = async (ProductModel, productId, variantSize, quantity, role) => {
  const product = await ProductModel.findById(productId);
  if (!product) return null;

  let updatedStock = 0;

  const hasVariants = (product.b2b && product.b2b.length > 0) ||
    (product.b2c && product.b2c.length > 0) ||
    (product.variants && product.variants.length > 0);

  let targetVariantSize = variantSize;
  if (!targetVariantSize && hasVariants) {
    let firstVariant = null;
    if (role === 'b2b') {
      firstVariant = (product.b2b && product.b2b[0]) || (product.variants && product.variants[0]) || (product.b2c && product.b2c[0]);
    } else {
      firstVariant = (product.b2c && product.b2c[0]) || (product.variants && product.variants[0]) || (product.b2b && product.b2b[0]);
    }
    if (firstVariant) {
      targetVariantSize = firstVariant.packetSize || firstVariant.sizeName;
    }
  }

  if (targetVariantSize) {
    let updated = false;

    const tryUpdateInArray = (arr) => {
      if (arr && arr.length > 0) {
        const v = arr.find(item => (item.packetSize || item.sizeName) === targetVariantSize);
        if (v) {
          v.stock = (v.stock || 0) + quantity;
          updatedStock = v.stock;
          updated = true;
          return true;
        }
      }
      return false;
    };

    if (role === 'b2b') {
      tryUpdateInArray(product.b2b) ||
        tryUpdateInArray(product.variants) ||
        tryUpdateInArray(product.b2c);
    } else {
      tryUpdateInArray(product.b2c) ||
        tryUpdateInArray(product.variants) ||
        tryUpdateInArray(product.b2b);
    }

    if (updated) {
      await product.save();
      return { product, updatedStock };
    }
  }

  if (!hasVariants) {
    product.stock = (product.stock || 0) + quantity;
    updatedStock = product.stock;
    await product.save();
    return { product, updatedStock };
  }

  await product.save();
  return { product, updatedStock };
};

// Helper function to send low stock notifications
const checkAndNotifyLowStock = async (result, item, req) => {
  if (result && result.updatedStock <= 10) {
    const { Notification: NotificationModel, Seller: SellerModel } = getModels(req);

    // Create Notification for Admin
    try {
      await NotificationModel.create({
        title: 'Low Stock Alert',
        message: `Product "${result.product.name}" ${item.variantSize ? `(${item.variantSize})` : ''} stock has dropped to ${result.updatedStock}.`,
        type: 'warning',
        recipient: 'all',
        locationId: req.locationId || null
      });
    } catch (e) {
      console.error('Failed to create admin low stock notification:', e);
    }

    // Send email to seller if product has sellerId
    if (result.product.sellerId) {
      const seller = await SellerModel.findById(result.product.sellerId);
      if (seller && seller.email) {
        try {
          await sendEmail({
            email: seller.email,
            subject: 'Low Stock Alert for your Product - Zudo',
            message: `Hello ${seller.name || seller.storeName || 'Seller'},\n\nYour product "${result.product.name}" ${item.variantSize ? `(${item.variantSize})` : ''} has reached a low stock level of ${result.updatedStock}.\n\nPlease restock soon to avoid missing out on orders.\n\nThank you,\nZudo Team`
          });
        } catch (e) {
          console.error('Failed to send low stock email to seller:', e);
        }
      }
    }
  }
};

// Helper function to generate OTP (defaults to 6-digit cryptographic OTP)
const generateOTP = (length = 6) => {
  if (length === 6) {
    return generate6DigitOTP();
  }
  return Math.floor(Math.pow(10, length - 1) + Math.random() * (Math.pow(10, length) - Math.pow(10, length - 1) - 1)).toString();
};

// @route   GET /api/orders/slots
// @desc    Get active delivery slots
// @access  Private
router.get('/slots', protect, async (req, res) => {
  try {
    const { DeliverySlot: DeliverySlotModel } = req.models;
    const LocationModel = req.models?.Location || require('../models/Location');
    
    let slots = await DeliverySlotModel.find({ isActive: true });

    let locationId = req.locationId || req.user.locationId;
    let isBangalore = true;
    if (locationId) {
      const loc = await LocationModel.findById(locationId);
      if (loc && !loc.name.toLowerCase().includes('bangalore') && !loc.name.toLowerCase().includes('bengaluru')) {
        isBangalore = false;
      }
    }

    if (!isBangalore) {
      const currentDay = new Date().getDay(); // 0 is Sunday, 6 is Saturday
      let deliveryDay = '';
      if ([6, 0, 1, 2].includes(currentDay)) { // Saturday, Sunday, Monday, Tuesday
        deliveryDay = 'Wednesday';
      } else { // Wednesday, Thursday, Friday
        deliveryDay = 'Saturday';
      }
      
      slots = slots.map(slot => {
        let slotObj = slot.toObject();
        if (slotObj.startTime && slotObj.startTime !== '*') {
          if (!slotObj.startTime.includes(deliveryDay)) {
             slotObj.startTime = `${deliveryDay}, ${slotObj.startTime}`;
          }
        }
        return slotObj;
      });
    }

    res.json(slots);
  } catch (error) {
    console.error('Fetch slots error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/:id/driver-location
// @desc    Get live driver location for active picked-up order
// @access  Private (Customer only)
router.get('/:id/driver-location', protect, async (req, res) => {
  try {
    const { Order: OrderModel, Driver: DriverModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Verify ownership
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to track this order' });
    }

    // Enabled only when the order status is Picked Up or Out for Delivery
    if (order.orderStatus !== 'Picked Up' && order.orderStatus !== 'Out for Delivery') {
      return res.status(400).json({ message: 'Tracking is only enabled once the order is picked up' });
    }

    if (!order.driverId) {
      return res.status(404).json({ message: 'No driver assigned to this order' });
    }

    const driver = await DriverModel.findById(order.driverId);
    if (!driver || !driver.currentLocation || driver.currentLocation.lat == null) {
      return res.status(404).json({ message: 'Driver location not available' });
    }

    res.json({
      lat: driver.currentLocation.lat,
      lng: driver.currentLocation.lng,
      updatedAt: driver.currentLocation.updatedAt,
      driverName: driver.name,
      driverPhone: driver.phone
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/validate-cart
// @desc    Validate cart quantities against MongoDB stock and seller Maximum Order Quantity (MOQ)
// @access  Public or Private (Customer & Admin)
router.post('/validate-cart', async (req, res) => {
  try {
    const { items, role = 'b2c' } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cart items are required for validation', valid: false });
    }

    const { Product: ProductModel } = getModels(req);

    // Calculate combined quantity per product across variants or separate lines
    const combinedProductQuantities = {};
    for (const item of items) {
      const pId = (item.productId || item.product || item.id || item._id)?.toString();
      const qty = parseInt(item.quantity, 10);
      if (pId) {
        combinedProductQuantities[pId] = (combinedProductQuantities[pId] || 0) + (isNaN(qty) ? 0 : qty);
      }
    }

    const errors = [];
    const validatedItems = [];

    for (const item of items) {
      const pId = item.productId || item.product || item.id || item._id;
      if (!pId) {
        errors.push({ message: 'Missing product ID in item', item });
        continue;
      }

      const productData = await ProductModel.findById(pId);
      if (!productData) {
        errors.push({ productId: pId, message: `Product not found: ${item.name || pId}` });
        continue;
      }

      const qty = parseInt(item.quantity, 10);
      if (!qty || isNaN(qty) || qty <= 0 || Number(item.quantity) !== qty) {
        errors.push({
          productId: pId,
          message: `Invalid quantity for product "${productData.name}". Quantity must be a positive integer.`
        });
        continue;
      }

      const maxOrderLimit = productData.maxOrderQuantity !== undefined && productData.maxOrderQuantity !== null
        ? Number(productData.maxOrderQuantity)
        : (productData.moq !== undefined && productData.moq !== null ? Number(productData.moq) : null);

      const totalQtyForProduct = combinedProductQuantities[pId.toString()] || qty;

      if (maxOrderLimit && maxOrderLimit > 0 && totalQtyForProduct > maxOrderLimit) {
        errors.push({
          productId: pId,
          productName: productData.name,
          maxOrderQuantity: maxOrderLimit,
          requestedQuantity: totalQtyForProduct,
          message: `Maximum ${maxOrderLimit} units allowed per order for "${productData.name}". You requested ${totalQtyForProduct} units.`
        });
      }

      const targetSize = item.variantSize || item.selectedPacketSize;
      const stockInfo = getProductStock(productData, targetSize, role);
      if (stockInfo.stock < qty) {
        errors.push({
          productId: pId,
          productName: productData.name,
          availableStock: stockInfo.stock,
          requestedQuantity: qty,
          message: `Insufficient stock for product "${productData.name}"${targetSize ? ` (${targetSize})` : ''}. Available: ${stockInfo.stock}, Requested: ${qty}`
        });
      }

      validatedItems.push({
        productId: pId,
        productName: productData.name,
        quantity: qty,
        maxOrderQuantity: maxOrderLimit || null,
        availableStock: stockInfo.stock,
        allowedQuantity: maxOrderLimit ? Math.min(maxOrderLimit, stockInfo.stock) : stockInfo.stock
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        valid: false,
        message: errors[0].message,
        errors,
        validatedItems
      });
    }

    return res.status(200).json({
      valid: true,
      message: 'All cart items are within allowed limits and stock',
      validatedItems
    });
  } catch (error) {
    res.status(500).json({ message: error.message, valid: false });
  }
});

// @route   POST /api/orders
// @desc    Create new order
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const { items, totalAmount, shippingAddress, paymentMethod, deliverySlot } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No order items' });
    }

    const { Product: ProductModel, Seller: SellerModel, Order: OrderModel } = getModels(req);

    // Resolve target B2B user and their role for pricing if placing on behalf by Sales Associate
    let targetUserId = req.user._id;
    let targetUserRole = req.user.role;
    let isSalesOrder = false;
    let salesAssociateId = null;

    if (req.user.role === 'sales') {
      const { customerId } = req.body;
      if (!customerId) {
        return res.status(400).json({ message: 'Customer ID is required when order is placed by Sales Associate' });
      }
      const { getModel } = require('../utils/model_loader');
      const UserModel = getModel('User', req);
      const customer = await UserModel.findById(customerId);
      if (!customer) {
        return res.status(404).json({ message: 'Target customer B2B account not found' });
      }
      targetUserId = customer._id;
      targetUserRole = customer.role;
      isSalesOrder = true;
      salesAssociateId = req.user._id;
    }

    // Early deduplication check: prevent accidental double-submission within 5 seconds
    const recentDuplicate = await OrderModel.findOne({
      userId: targetUserId,
      orderStatus: 'Pending',
      createdAt: { $gte: new Date(Date.now() - 5000) }
    }).sort({ createdAt: -1 });

    if (recentDuplicate && recentDuplicate.items.length === items.length) {
      const isExactMatch = items.every(it => {
        const pId = (it.product || it.id || it._id)?.toString();
        const vSize = it.variantSize || it.selectedPacketSize;
        return recentDuplicate.items.some(di =>
          di.productId?.toString() === pId &&
          Number(di.quantity) === Number(it.quantity) &&
          (!vSize || di.variantSize === vSize)
        );
      });
      if (isExactMatch) {
        return res.status(200).json(recentDuplicate);
      }
    }

    // Validate product existence, quantity, stock, and seller maximum order quantity (MOQ)
    // Also track combined quantity per product across variants or duplicate entries
    const combinedProductQuantities = {};
    for (const item of items) {
      const pId = (item.product || item.id || item._id)?.toString();
      const qty = parseInt(item.quantity, 10);
      if (pId) {
        combinedProductQuantities[pId] = (combinedProductQuantities[pId] || 0) + (isNaN(qty) ? 0 : qty);
      }
    }

    for (const item of items) {
      const pId = item.product || item.id || item._id;
      const productData = await ProductModel.findById(pId);
      if (!productData) {
        return res.status(404).json({ message: `Product not found: ${item.name || pId}` });
      }

      // Enforce positive integer quantity
      const qty = parseInt(item.quantity, 10);
      if (!qty || isNaN(qty) || qty <= 0 || Number(item.quantity) !== qty) {
        return res.status(400).json({
          message: `Invalid quantity for product "${productData.name}". Quantity must be a positive integer.`
        });
      }
      item.quantity = qty;

      // Validate Seller Maximum Order Quantity (MOQ) restriction directly from database
      const maxOrderLimit = productData.maxOrderQuantity !== undefined && productData.maxOrderQuantity !== null
        ? Number(productData.maxOrderQuantity)
        : (productData.moq !== undefined && productData.moq !== null ? Number(productData.moq) : null);

      if (maxOrderLimit && maxOrderLimit > 0) {
        const totalQtyForProduct = combinedProductQuantities[pId.toString()] || qty;
        if (totalQtyForProduct > maxOrderLimit) {
          return res.status(400).json({
            message: `Maximum ${maxOrderLimit} units allowed per order for "${productData.name}". You requested ${totalQtyForProduct} units.`,
            maxOrderQuantity: maxOrderLimit,
            productId: pId
          });
        }
      }

      const targetSize = item.variantSize || item.selectedPacketSize;
      const stockInfo = getProductStock(productData, targetSize, targetUserRole);
      if (targetSize && !stockInfo.hasVariant) {
        return res.status(400).json({
          message: `Variant "${item.variantSize}" not found for product "${productData.name}"`
        });
      }
      if (stockInfo.stock < item.quantity) {
        return res.status(400).json({
          message: `Insufficient stock for product "${productData.name}"${item.variantSize ? ` (${item.variantSize})` : ''}. Available: ${stockInfo.stock}, Requested: ${item.quantity}`
        });
      }
    }

    let calculatedTotal = 0;
    let calculatedTotalWithoutCommissions = 0;
    let totalGstCollected = 0;
    let totalCommissionCollected = 0;
    const commissions = await loadCommissions(req);

    const enrichedItems = await Promise.all(items.map(async (item) => {
      const pId = item.product || item.id || item._id;
      let name = item.name;
      let image = item.image || item.imageUrl;
      let finalPrice = item.price;
      let rawPrice = item.price;
      let gstPercent = 0;
      let gstAmount = 0;
      let sellerInfo = null;

      let targetSize = item.variantSize || item.selectedPacketSize || null;
      let basePriceObj = null;
      let rawBasePriceObj = null;
      let enrichedProduct = null;

      const productData = await ProductModel.findById(pId);
      if (productData) {
        gstPercent = productData.gstPercent || 0;
        // Apply commission price inflation dynamically
        const pDataObj = productData.toObject();
        enrichedProduct = applyCommission(pDataObj, commissions, shippingAddress?.pincode);

        name = name || enrichedProduct.name;
        image = image || enrichedProduct.imageUrl || enrichedProduct.image;

        basePriceObj = enrichedProduct;
        rawBasePriceObj = pDataObj;
        const variantArray = targetUserRole === 'b2b' ? (enrichedProduct.b2b || []) : (enrichedProduct.b2c || []);
        const rawVariantArray = targetUserRole === 'b2b' ? (pDataObj.b2b || []) : (pDataObj.b2c || []);

        if (targetSize && variantArray.length > 0) {
          const variant = variantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
          const rawVariant = rawVariantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
          if (variant) {
            basePriceObj = variant;
            if (rawVariant) rawBasePriceObj = rawVariant;
            const sizeStr = variant.packetSize || variant.sizeName;
            if (sizeStr && !name.includes(sizeStr)) {
              name = `${name} - ${sizeStr}`;
            }
          }
        } else if (targetSize && enrichedProduct.variants && enrichedProduct.variants.length > 0) {
          // Fallback to old variants array just in case
          const variant = enrichedProduct.variants.find(v => v.sizeName === targetSize);
          const rawVariant = (pDataObj.variants || []).find(v => v.sizeName === targetSize);
          if (variant) {
            basePriceObj = variant;
            if (rawVariant) rawBasePriceObj = rawVariant;
            if (variant.sizeName && !name.includes(variant.sizeName)) {
              name = `${name} - ${variant.sizeName}`;
            }
          }
        }

        // Fallback to first variant if root price is 0 and no variant was specified
        if (!targetSize && (!basePriceObj.price || basePriceObj.price === 0)) {
          const fallbackArray = targetUserRole === 'b2b' ?
            (enrichedProduct.b2b?.length ? enrichedProduct.b2b : enrichedProduct.variants) :
            (enrichedProduct.b2c?.length ? enrichedProduct.b2c : enrichedProduct.variants);
          const rawFallbackArray = targetUserRole === 'b2b' ?
            (pDataObj.b2b?.length ? pDataObj.b2b : pDataObj.variants) :
            (pDataObj.b2c?.length ? pDataObj.b2c : pDataObj.variants);
          if (fallbackArray && fallbackArray.length > 0) {
            basePriceObj = fallbackArray[0];
            if (rawFallbackArray && rawFallbackArray.length > 0) {
              rawBasePriceObj = rawFallbackArray[0];
            }
          }
        }

        // Calculate seller price based on target user role and quantity tiers
        rawPrice = targetUserRole === 'b2b'
          ? (rawBasePriceObj.sellerB2bPrice !== undefined && rawBasePriceObj.sellerB2bPrice !== null ? rawBasePriceObj.sellerB2bPrice : (rawBasePriceObj.b2bPrice || rawBasePriceObj.sellerPrice || rawBasePriceObj.price))
          : (rawBasePriceObj.sellerPrice !== undefined && rawBasePriceObj.sellerPrice !== null ? rawBasePriceObj.sellerPrice : rawBasePriceObj.price);

        if (targetUserRole === 'b2b' && basePriceObj.priceTiers && basePriceObj.priceTiers.length > 0) {
          const sortedTiers = [...basePriceObj.priceTiers].sort((a, b) => b.minQty - a.minQty);
          const applicableTier = sortedTiers.find(t => item.quantity >= t.minQty);
          if (applicableTier && rawBasePriceObj.priceTiers && rawBasePriceObj.priceTiers.length > 0) {
            const rawApplicableTier = rawBasePriceObj.priceTiers.find(t => t.minQty === applicableTier.minQty);
            if (rawApplicableTier) {
              rawPrice = rawApplicableTier.sellerPrice !== undefined ? rawApplicableTier.sellerPrice : rawApplicableTier.price;
            }
          }
        }

        if (productData.sellerId) {
          const seller = await SellerModel.findById(productData.sellerId);
          if (seller) {
            sellerInfo = {
              sellerId: seller._id,
              name: seller.name || seller.storeName,
              phone: seller.phone,
              address: seller.pickupLocation?.address || seller.businessAddress,
              lat: seller.pickupLocation?.lat,
              lng: seller.pickupLocation?.lng,
              gstNumber: seller.gstNumber
            };
          }
        }
      }

      const commRule = productData ? findCategoryCommission(commissions, productData.categoryId, productData.unit, shippingAddress?.pincode) : null;
      const commType = commRule?.commissionType || basePriceObj?.commissionType || enrichedProduct?.commissionType || 'flat';
      const commVal = commRule ? commRule.commissionValue : (basePriceObj?.commissionValue ?? enrichedProduct?.commissionValue ?? 0);

      const breakdown = calculatePricingBreakdown({
        sellerUnitPrice: Number(rawPrice) || 0,
        commissionType: commType,
        commissionValue: Number(commVal) || 0,
        gstPercent: gstPercent,
        quantity: item.quantity,
        availableStock: productData ? (productData.stock || 0) : 0,
        isB2B: targetUserRole === 'b2b'
      });

      calculatedTotal += breakdown.finalCustomerPrice;
      calculatedTotalWithoutCommissions += (breakdown.totalSellerPrice + breakdown.totalGst);
      totalGstCollected += breakdown.totalGst;
      totalCommissionCollected += breakdown.totalCommission;

      return {
        productId: pId,
        variantSize: targetSize,
        name: name || 'Unknown Product',
        quantity: item.quantity,
        orderedQuantity: item.quantity,
        price: breakdown.unitCustomerPrice,
        unitCustomerPrice: breakdown.unitCustomerPrice,
        normalPrice: breakdown.sellerUnitPrice,
        sellerUnitPrice: breakdown.sellerUnitPrice,
        commissionType: breakdown.commissionType,
        commissionValue: breakdown.commissionRate,
        commissionRate: breakdown.commissionRate,
        commissionAmount: breakdown.unitCommission,
        unitCommission: breakdown.unitCommission,
        totalCommission: breakdown.totalCommission,
        totalSellerPrice: breakdown.totalSellerPrice,
        finalCustomerPrice: breakdown.finalCustomerPrice,
        availableStock: breakdown.availableStock,
        stockTotalCommission: breakdown.stockTotalCommission,
        gstPercent: breakdown.gstPercent,
        gstAmount: breakdown.unitGst,
        totalGst: breakdown.totalGst,
        image: image,
        seller: sellerInfo,
        product: {
          name: name || 'Unknown Product',
          image: image,
          imageUrl: image
        }
      };
    }));

    // --- Minimum Bill Amount Enforcement ---
    const db = (req.db && req.db.db) ? req.db.db : mongoose.connection.db;
    let minBillAmount = 2000; // Default ₹2,000
    const minBillKey = targetUserRole === 'b2b' ? 'minimumBillAmountB2B' : 'minimumBillAmountB2C';
    try {
      const setting = await db.collection('settings').findOne({ key: minBillKey });
      if (setting && typeof setting.value === 'number') {
        minBillAmount = setting.value;
      } else {
        // Fallback to legacy key if new specific keys aren't found yet
        const legacySetting = await db.collection('settings').findOne({ key: 'minimumBillAmount' });
        if (legacySetting && typeof legacySetting.value === 'number') minBillAmount = legacySetting.value;
      }
    } catch (e) { /* use default */ }

    // If minBillAmount is 0, we don't need to enforce it
    if (minBillAmount > 0 && calculatedTotal < minBillAmount) {
      return res.status(400).json({
        message: `Minimum bill amount is ₹${minBillAmount}. Your current total is ₹${calculatedTotal.toFixed(2)}.`,
        minimumBillAmount: minBillAmount,
        currentTotal: calculatedTotal
      });
    }
    // --- End Minimum Bill Check ---

    // Generate Pickup OTPs
    const globalPickupOtp = generateOTP(6);
    const uniqueSellerIds = [...new Set(enrichedItems.filter(i => i.seller?.sellerId).map(i => i.seller.sellerId.toString()))];
    const isMultiSeller = uniqueSellerIds.length > 1;

    const sellerPickups = uniqueSellerIds.map(id => ({
      sellerId: id,
      status: 'Pending',
      pickupCode: isMultiSeller ? generateOTP(6) : globalPickupOtp
    }));

    let finalDeliverySlot = deliverySlot;
    let locationIdForCheck = req.locationId || req.user.locationId;
    let isBangalore = true;
    if (locationIdForCheck && finalDeliverySlot) {
      const LocationModel = req.models?.Location || require('../models/Location');
      const loc = await LocationModel.findById(locationIdForCheck);
      if (loc && !loc.name.toLowerCase().includes('bangalore') && !loc.name.toLowerCase().includes('bengaluru')) {
        isBangalore = false;
      }
    }

    if (!isBangalore && finalDeliverySlot && finalDeliverySlot.startTime) {
      const currentDay = new Date().getDay(); // 0 is Sunday, 6 is Saturday
      let deliveryDay = '';
      if ([6, 0, 1, 2].includes(currentDay)) { // Saturday, Sunday, Monday, Tuesday
        deliveryDay = 'Wednesday';
      } else { // Wednesday, Thursday, Friday
        deliveryDay = 'Saturday';
      }
      
      if (finalDeliverySlot.startTime !== '*' && !finalDeliverySlot.startTime.includes(deliveryDay)) {
        finalDeliverySlot.startTime = `${deliveryDay}, ${finalDeliverySlot.startTime}`;
      }
    }

    const calculatedTotalRounded = round2(calculatedTotal);
    const calculatedTotalWithoutCommissionsRounded = round2(calculatedTotalWithoutCommissions);
    const totalCommissionCollectedRounded = round2(totalCommissionCollected);
    const totalGstCollectedRounded = round2(totalGstCollected);

    const { invoiceSequence, orderRef, invoiceNumber } = await assignInvoiceDetails(OrderModel);

    const order = new OrderModel({
      userId: targetUserId,
      type: targetUserRole === 'b2b' ? 'b2b' : 'b2c',
      items: enrichedItems,
      totalAmount: calculatedTotalRounded, // Use server-calculated total for security
      totalAmountWithoutCommissions: calculatedTotalWithoutCommissionsRounded,
      totalCommissionAmount: totalCommissionCollectedRounded,
      totalGstAmount: totalGstCollectedRounded,
      shippingAddress,
      paymentMethod,
      paymentStatus: (paymentMethod === 'COD' || paymentMethod === 'Cash at Delivery' || paymentMethod === 'UPI at Delivery') ? 'Pending' : 'Completed',
      orderStatus: 'Pending',
      pickupCode: globalPickupOtp,
      sellerPickups: sellerPickups,
      deliveryOtp: null,
      deliverySlot: finalDeliverySlot,
      placedBySalesAssociate: isSalesOrder,
      salesAssociateId: salesAssociateId,
      invoiceSequence,
      orderRef,
      invoiceNumber
    });

    const createdOrder = await order.save();

    // Decrease stock for each item now that the order is successfully created
    for (const item of enrichedItems) {
      const result = await adjustProductStock(ProductModel, item.productId, item.variantSize, -item.quantity, targetUserRole);
      await checkAndNotifyLowStock(result, item, req);
    }

    res.status(201).json(createdOrder);
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/myorders
// @desc    Get logged in user orders
// @access  Private
router.get('/myorders', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const orders = await OrderModel.find({ userId: req.user._id })
      .populate('cashPersonId')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/admin/all
// @desc    Get all orders (Admin only)
// @access  Private
router.get('/admin/all', protect, async (req, res) => {
  try {
    let orderFilter = {};
    if (req.portal === 'B2B' || req.portal === 'B2C') {
      const { User: UserModel } = getModels(req);
      const userFilter = { role: req.portal.toLowerCase() };
      const users = await UserModel.find(userFilter).select('_id');
      const userIds = users.map(u => u._id);
      orderFilter.userId = { $in: userIds };
    }

    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const orders = await aggregateGET('Order', req, orderFilter, ['userId', 'driverId', 'returnDriverId', 'cashPersonId', 'items.productId', 'items.seller.sellerId'], '', { createdAt: -1 });
      res.json(orders);
    } else {
      const { Order: OrderModel } = getModels(req);
      const orders = await OrderModel.find(orderFilter)
        .populate('userId', 'name email role bankDetails phone businessName companyName')
        .populate('driverId', 'name phone vehicleNo vehicleDetails')
        .populate('returnDriverId', 'name phone vehicleNo vehicleDetails')
        .populate('cashPersonId', 'name phone')
        .populate('items.productId').populate('items.seller.sellerId', 'name businessName storeName companyName qrCodeDoc qrOption')
        .sort({ createdAt: -1 });
      res.json(orders);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/bulk-print-status
// @desc    Update isPrinted status for multiple orders
// @access  Private
router.post('/bulk-print-status', protect, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) {
      return res.status(400).json({ message: 'orderIds array is required' });
    }
    const { Order: OrderModel } = getModels(req);
    await OrderModel.updateMany(
      { _id: { $in: orderIds } },
      { $set: { isPrinted: true } }
    );
    res.json({ message: 'Orders marked as printed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/assigned-cash
// @desc    Get orders assigned to the logged-in cash collector
router.get('/assigned-cash', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const orders = await OrderModel.find({ cashPersonId: req.user._id })
      .populate('userId', 'name email phone businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/driver/assigned
// @desc    Get orders assigned to the logged-in driver
router.get('/driver/assigned', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const orders = await OrderModel.find({
      $or: [
        {
          driverId: req.user._id,
          orderStatus: { $in: ['Packed', 'Shipped', 'Picked Up', 'Out for Delivery', 'Confirmed', 'Accepted', 'Pending'] }
        },
        {
          returnDriverId: req.user._id,
          returnStatus: { $in: ['Requested', 'Approved'] }
        }
      ]
    })
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .populate('returnDriverId', 'name phone vehicleNo vehicleDetails')
      .populate('cashPersonId', 'name phone')
      .sort({ createdAt: -1 });

    // Map orderStatus for return orders so they don't get hidden by the 'delivered' filter in the app
    const modifiedOrders = orders.map(order => {
      const orderObj = order.toObject();
      if (orderObj.returnDriverId && orderObj.returnDriverId._id.toString() === req.user._id.toString()) {
        if (orderObj.orderStatus === 'Delivered') {
          orderObj.orderStatus = 'Return Pickup';
        }

        // Flag for the Flutter app
        orderObj.isReturn = true;

        // 1. Show only returned items
        orderObj.items = orderObj.items.filter(i =>
          i.returnStatus === 'Return Requested' ||
          i.returnStatus === 'Return Approved' ||
          i.returnStatus === 'Picked Up from Customer'
        );

        if (orderObj.items.length > 0) {
          // 2. Swap addresses
          const originalCustomerAddress = orderObj.shippingAddress;
          const customerName = orderObj.userId?.name || 'Customer';
          const customerPhone = originalCustomerAddress?.phone || orderObj.userId?.phone;

          // In Mongoose, seller info is either in `item.seller` object or flat `item.sellerName`
          const firstItem = orderObj.items[0];
          const originalSeller = firstItem.seller || {
            name: firstItem.sellerName,
            address: firstItem.sellerAddress,
            phone: firstItem.sellerPhone,
            lat: firstItem.sellerLat,
            lng: firstItem.sellerLng
          };

          // Make the customer the "pickup location" (Seller list in app)
          orderObj.items.forEach(item => {
            item.seller = {
              sellerId: orderObj.userId?._id || 'customer-id',
              name: customerName,
              address: `${originalCustomerAddress?.address || ''}, ${originalCustomerAddress?.city || ''}, ${originalCustomerAddress?.state || ''} - ${originalCustomerAddress?.pincode || ''}`,
              phone: customerPhone,
              lat: originalCustomerAddress?.lat,
              lng: originalCustomerAddress?.lng
            };
          });

          // Make the seller the "delivery location" (shippingAddress in app)
          if (originalSeller) {
            orderObj.shippingAddress = {
              name: originalSeller.name || 'Seller',
              address: originalSeller.address || 'Seller Address',
              city: originalSeller.city || '',
              state: originalSeller.state || '',
              pincode: originalSeller.pincode || '',
              phone: originalSeller.phone || '',
              email: originalSeller.email || '',
              lat: originalSeller.lat,
              lng: originalSeller.lng
            };
            orderObj.userId = {
              name: originalSeller.name || 'Seller',
              phone: originalSeller.phone || ''
            };
          }
        }
      }
      if (req.user.role === 'driver') {
        // Driver must collect the 6-digit OTP from the customer directly; do not expose it in driver's query response!
        orderObj.deliveryOtp = undefined;
        orderObj.otpVerificationRequired = true;
      }
      return orderObj;
    });

    res.json(modifiedOrders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/driver/history
// @desc    Get order history for the logged-in driver
router.get('/driver/history', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const orders = await OrderModel.find({
      $or: [
        {
          driverId: req.user._id,
          orderStatus: 'Delivered'
        },
        {
          returnDriverId: req.user._id,
          returnStatus: 'Completed'
        }
      ]
    }).sort({ updatedAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/ship
// @desc    Ship an order and assign driver
router.put('/:id/ship', protect, async (req, res) => {
  try {
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales', 'b2b_admin', 'b2c_admin'].includes(req.user?.role);
    if (!isAdmin) {
      return res.status(403).json({ message: '403 Forbidden: Only Admins have permission to assign drivers and dispatch orders.' });
    }

    const { Order: OrderModel, Driver: DriverModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (['Delivered', 'Cancelled'].includes(order.orderStatus)) {
      return res.status(400).json({ message: `Cannot ship an order that is already ${order.orderStatus}.` });
    }

    // Status updates to Out for Delivery when admin assigns driver to ship
    order.driverId = req.body.driverId;
    if (order.orderStatus === 'Out for Delivery' || req.body.outForDelivery !== false || order.orderStatus === 'Packed') {
      order.orderStatus = 'Out for Delivery';
      const otp = prepareOrderDeliveryOtp(order);
      await dispatchDeliveryOtpNotification({ order, otp, user: order.userId });
    }
    await order.save();
    emitOrderRealtimeUpdate(order, 'update');

    // Populate user to check role
    await order.populate('userId', 'role');

    // Only increment wallet for B2C COD orders
    if ((order.paymentMethod === 'COD' || order.paymentMethod === 'Cash at Delivery' || order.paymentMethod === 'UPI at Delivery') && order.userId?.role === 'b2c') {
      await DriverModel.findByIdAndUpdate(req.body.driverId, {
        $inc: { wallet: order.totalAmount }
      });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/assign-cash
// @desc    Assign a cash member to an order
router.put('/:id/assign-cash', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.cashPersonId = req.body.cashPersonId;
    await order.save();
    emitOrderRealtimeUpdate(order, 'update');

    const populatedOrder = await OrderModel.findById(order._id)
      .populate('userId', 'name email role businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .populate('cashPersonId', 'name phone');

    res.json(populatedOrder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/cancel
// @desc    Cancel an order
router.put('/:id/cancel', protect, async (req, res) => {
  try {
    const { Order: OrderModel, Product: ProductModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id).populate('userId', 'role');
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const isCustomer = order.userId?._id?.toString() === req.user._id.toString();
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales', 'b2b_admin', 'b2c_admin'].includes(req.user.role);
    const isDriver = req.user.role === 'driver' || order.driverId?.toString() === req.user._id.toString() || order.returnDriverId?.toString() === req.user._id.toString();

    // Drivers are strictly forbidden from cancelling orders
    if (isDriver && !isAdmin) {
      return res.status(403).json({ message: '403 Forbidden: Drivers are not permitted to cancel orders. Only Admins have permission to cancel orders.' });
    }

    if (!isAdmin && !isCustomer) {
      return res.status(403).json({ message: '403 Forbidden: Not authorized to cancel this order.' });
    }

    if (isCustomer && !isAdmin && order.orderStatus !== 'Pending') {
      return res.status(400).json({ message: 'Customers can only cancel orders in Pending status.' });
    }

    if (order.orderStatus === 'Cancelled') {
      return res.status(400).json({ message: 'Order is already cancelled' });
    }

    if (order.orderStatus === 'Delivered') {
      return res.status(400).json({ message: 'Delivered orders cannot be cancelled.' });
    }

    order.orderStatus = 'Cancelled';
    order.cancelledAt = new Date();
    if (req.body.cancellationReason) {
      order.cancellationReason = req.body.cancellationReason;
    }

    if (order.sellerPickups && order.sellerPickups.length > 0) {
      order.sellerPickups.forEach(sp => {
        sp.status = 'Cancelled';
      });
    }

    await order.save();
    emitOrderRealtimeUpdate(order, 'cancel');

    // Restore stock
    for (const item of order.items) {
      await adjustProductStock(ProductModel, item.productId, item.variantSize, item.quantity, order.userId?.role);
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT/POST /api/orders/:id/status
// @desc    Update order status
router.all('/:id/status', protect, async (req, res) => {
  try {
    let { status } = req.body;
    const { Order: OrderModel, Product: ProductModel } = getModels(req);

    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    console.log(`[PUT /:id/status] Processing update for ID: ${req.params.id}`);
    const order = await OrderModel.findById(req.params.id).populate('userId', 'name email role businessName companyName');
    console.log(`[PUT /:id/status] Order found: ${!!order}`);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Authorization check
    const isCustomer = order.userId?._id?.toString() === req.user._id.toString();
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales', 'b2b_admin', 'b2c_admin'].includes(req.user.role);
    const isDriver = req.user.role === 'driver' || order.driverId?.toString() === req.user._id.toString() || order.returnDriverId?.toString() === req.user._id.toString();
    const isCollector = order.cashPersonId?.toString() === req.user._id.toString();
    const isSeller = req.user.role === 'seller';

    if (!isCustomer && !isAdmin && !isDriver && !isCollector && !isSeller) {
      return res.status(403).json({ message: '403 Forbidden: Not authorized to update this order' });
    }

    // 1. Restrict already updated/locked statuses:
    // If order is already in Out for Delivery, Delivered, or Cancelled, lock from manual status changes
    const lockedCurrentStatuses = ['Out for Delivery', 'Delivered', 'Cancelled'];
    if (lockedCurrentStatuses.includes(order.orderStatus)) {
      const isReturnAction = status === 'Returned' && order.returnDriverId?.toString() === req.user._id.toString();
      if (!isReturnAction) {
        return res.status(403).json({
          message: `403 Forbidden: Order is currently '${order.orderStatus}' and is locked from manual status changes. Repeated status transitions are restricted.`
        });
      }
    }

    // 2. Drivers cannot manually update ANY order status via this endpoint
    if (isDriver && !isAdmin) {
      return res.status(403).json({
        message: '403 Forbidden: Drivers are not permitted to manually change order statuses. Delivery completion requires customer 6-digit OTP verification via /api/orders/:id/verify-delivery-otp.'
      });
    }

    // 3. Reject manual selection of Out for Delivery, Delivered, or Cancelled
    const normalizedTargetStatus = (status || '').trim();
    if (normalizedTargetStatus === 'Out for Delivery') {
      return res.status(403).json({
        message: "403 Forbidden: 'Out for Delivery' cannot be set manually. Please use the authorized Dispatch Hub / Assign Driver workflow."
      });
    }
    if (normalizedTargetStatus === 'Delivered') {
      return res.status(403).json({
        message: "403 Forbidden: 'Delivered' cannot be set manually. Orders must be completed through the customer 6-digit OTP verification workflow."
      });
    }
    if (normalizedTargetStatus === 'Cancelled') {
      return res.status(403).json({
        message: "403 Forbidden: 'Cancelled' cannot be set manually via status updates. Please use the authorized Cancel Order workflow."
      });
    }

    // 4. Allowed manual status options for Admin: Only Pending and Packed
    const allowedManualAdminStatuses = ['Pending', 'Packed'];
    if (isAdmin && !allowedManualAdminStatuses.includes(normalizedTargetStatus)) {
      return res.status(403).json({
        message: "403 Forbidden: Only 'Pending' and 'Packed' statuses can be manually updated in the Orders panel."
      });
    }

    // 5. Customers can only cancel their own orders via the /cancel endpoint
    if (isCustomer && !isAdmin) {
      return res.status(403).json({
        message: '403 Forbidden: Customers must use the authorized Cancel Order endpoint.'
      });
    }

    // 6. Sellers can only mark Packed or Rejected by Seller for their items
    if (isSeller && !isAdmin && !isCustomer && !isDriver) {
      if (!['Packed', 'Rejected by Seller'].includes(status)) {
        return res.status(403).json({ message: `403 Forbidden: Sellers are not permitted to set status to '${status}'.` });
      }
    }

    // Update returnStatus to Completed when return driver marks as Returned
    if (status === 'Returned' && order.returnDriverId?.toString() === req.user._id.toString()) {
      order.returnDriverId && (order.returnStatus = 'Completed');
    }

        const previousStatus = order.orderStatus;

    // Handle multi-seller pickup status logic
    let shouldUpdateGlobalStatus = true;

    if (order.sellerPickups && order.sellerPickups.length > 1) {
      if (isSeller && (status === 'Packed' || status === 'Rejected by Seller')) {
        const sellerPickup = order.sellerPickups.find(sp => sp.sellerId.toString() === req.user._id.toString());
        if (sellerPickup) {
          sellerPickup.status = status;

          // Only update global status if ALL sellers have processed (Packed/Rejected/Out for Delivery)
          const allProcessed = order.sellerPickups.every(sp =>
            sp.status === 'Packed' || sp.status === 'Rejected by Seller' || sp.status === 'Out for Delivery'
          );
          if (!allProcessed) {
            shouldUpdateGlobalStatus = false;
          }
        }
      }

      if (isDriver && status === 'Out for Delivery' && req.body.sellerId) {
        const sellerPickup = order.sellerPickups.find(sp => sp.sellerId.toString() === req.body.sellerId);
        if (sellerPickup) {
          sellerPickup.status = 'Out for Delivery';

          // Only update global status if ALL sellers have been picked up
          const allPickedUp = order.sellerPickups.every(sp => sp.status === 'Out for Delivery');
          if (!allPickedUp) {
            shouldUpdateGlobalStatus = false;
          }
        }
      }
    }

    if (shouldUpdateGlobalStatus) {
      order.orderStatus = status;

      // Update status for all seller pickups to match the global order status
      if (order.sellerPickups && order.sellerPickups.length > 0) {
        order.sellerPickups.forEach(sp => {
          sp.status = status;
        });
      }
    }

    // If status is 'Returned', save reason and image
    if (req.body.status === 'Returned') {
      order.returnReason = req.body.returnReason || null;
      order.returnComment = req.body.returnComment || null;
      order.returnImage = req.body.returnImage || null;

      // Send email notification for Return Request
      try {
        const adminEmail = process.env.EMAIL_USER;
        const userEmail = order.userId ? order.userId.email : null;
        const customerName = order.userId ? order.userId.name : 'Valued Customer';
        const orderIdShort = order._id.toString().slice(-6).toUpperCase();

        // 1. Send to Admin
        await sendEmail({
          to: adminEmail,
          subject: `Return Request: Order #${orderIdShort}`,
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
              <div style="background-color: #f59e0b; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0;">New Return Request</h1>
              </div>
              <div style="padding: 20px;">
                <p><strong>Order ID:</strong> #${order._id}</p>
                <p><strong>Customer:</strong> ${customerName} (${userEmail || 'N/A'})</p>
                <p><strong>Reason:</strong> ${order.returnReason}</p>
                <p><strong>Comment:</strong> ${order.returnComment || 'No comment'}</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                ${order.returnImage ? `<p><strong>Evidence:</strong> <br/><img src="${order.returnImage.startsWith('http') ? order.returnImage : (process.env.BASE_URL || 'https://snbtradingco.in') + order.returnImage}" style="max-width: 100%; border-radius: 10px; margin-top: 10px;"/></p>` : ''}
              </div>
              <div style="background-color: #f4f4f4; padding: 10px; text-align: center; font-size: 12px; color: #777;">
                Sent from Zudo Admin Panel
              </div>
            </div>
          `
        });

        // 2. Send confirmation to User
        if (userEmail) {
          await sendEmail({
            to: userEmail,
            subject: `Return Request Received: Order #${orderIdShort}`,
            html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #059669; color: white; padding: 20px; text-align: center;">
                  <h1 style="margin: 0;">Hello ${customerName}!</h1>
                </div>
                <div style="padding: 20px;">
                  <p>We have received your return request for <strong>Order #${orderIdShort}</strong>.</p>
                  <p>Our team will review the details and evidence provided and get back to you shortly regarding the next steps.</p>
                  <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <p style="margin: 0;"><strong>Reason:</strong> ${order.returnReason}</p>
                    <p style="margin: 0; font-size: 12px; color: #666; margin-top: 5px;">Your request is being processed.</p>
                  </div>
                  <p>Best regards,<br/><strong>Team Zudo</strong></p>
                </div>
                <div style="background-color: #f4f4f4; padding: 10px; text-align: center; font-size: 12px; color: #777;">
                  This is an automated response. Please do not reply directly to this email.
                </div>
              </div>
            `
          });
        }
      } catch (emailError) {
        console.error('Return request email notification failed:', emailError);
      }
    }

    // If cancelled, also update payment status if it was COD
    if (status === 'Cancelled' && (order.paymentMethod === 'COD' || order.paymentMethod === 'Cash at Delivery' || order.paymentMethod === 'UPI at Delivery')) {
      order.paymentStatus = 'Cancelled';
    }

    if (status === 'Delivered') {
      order.deliveredAt = order.deliveredAt || new Date();
      order.deliveryOtp = null; // Prevent OTP reuse!
      order.deliveryOtpExpiresAt = null;

      try {
        const { getIO } = require('../utils/socket');
        const io = getIO();
        if (io) {
          io.emit('order:delivered', { orderId: order._id.toString() });
          io.emit(`order:${order._id.toString()}`, { type: 'ORDER_DELIVERED', orderId: order._id.toString() });
        }
      } catch (e) {}
    }

    await order.save();
    emitOrderRealtimeUpdate(order, 'update');

    // If status changed to Cancelled, restore stock
    if (status === 'Cancelled' && previousStatus !== 'Cancelled') {
      for (const item of order.items) {
        await adjustProductStock(ProductModel, item.productId, item.variantSize, item.quantity, order.userId?.role);
      }
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/payment
// @desc    Update payment info (screenshot and status)
router.put('/:id/payment', protect, async (req, res) => {
  try {
    const { paymentScreenshot, paymentStatus, isCash } = req.body;
    const { Order: OrderModel, Driver: DriverModel, CashCollector: CashCollectorModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (paymentScreenshot) order.paymentScreenshot = paymentScreenshot;
    if (paymentStatus) order.paymentStatus = paymentStatus;

    // Handle Cash Payment logic
    if (isCash) {
      if (order.cashPersonId) {
        // Update Cash Collector wallet
        const collector = await CashCollectorModel.findById(order.cashPersonId);
        if (collector) {
          collector.amount = (collector.amount || 0) + order.totalAmount;
          await collector.save();
        }
      } else if (order.driverId) {
        // Update Driver wallet
        const driver = await DriverModel.findById(order.driverId);
        if (driver) {
          driver.wallet = (driver.wallet || 0) + order.totalAmount;
          await driver.save();
        }
      }
      order.paymentMethod = 'Cash';
      order.paymentStatus = 'Completed';
    }

    order.paidAt = Date.now();

    await order.save();
    res.json(order);
  } catch (error) {
    console.error('Update payment error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/:id/delivery-otp
// @desc    Generate/Regenerate 6-digit delivery OTP (Admin/Driver)
router.post('/:id/delivery-otp', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id).populate('userId', 'name email phone fcmToken role');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.orderStatus === 'Delivered') {
      return res.status(400).json({ message: 'Order is already delivered' });
    }

    // Generate 6-digit OTP
    const newOtp = prepareOrderDeliveryOtp(order);
    await order.save();

    // Dispatch SMS, Push, Email notification to customer
    await dispatchDeliveryOtpNotification({ order, otp: newOtp, user: order.userId });

    res.json({
      success: true,
      message: '6-digit Delivery OTP generated and sent to customer',
      deliveryOtp: newOtp,
      expiresAt: order.deliveryOtpExpiresAt
    });
  } catch (error) {
    console.error('OTP generation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/:id/resend-delivery-otp
// @desc    Resend 6-digit delivery OTP to customer mobile (Driver/Customer/Admin)
// @access  Private
router.post('/:id/resend-delivery-otp', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id).populate('userId', 'name email phone fcmToken role');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Authorization check: User, Driver, or Admin
    const isCustomer = order.userId?._id?.toString() === req.user._id.toString();
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales'].includes(req.user.role);
    const isDriver = order.driverId?.toString() === req.user._id.toString();

    if (!isCustomer && !isAdmin && !isDriver) {
      return res.status(403).json({ message: 'Not authorized to resend OTP for this order' });
    }

    // Check resend limits & cooldown
    const check = canResendDeliveryOtp(order);
    if (!check.allowed) {
      return res.status(429).json({ message: check.message, retryAfterSeconds: check.retryAfterSeconds });
    }

    // Generate fresh 6-digit OTP
    const otp = prepareOrderDeliveryOtp(order);
    order.deliveryOtpResendCount = (order.deliveryOtpResendCount || 0) + 1;
    order.deliveryOtpLastResentAt = new Date();
    await order.save();

    // Dispatch SMS, Push, Email
    await dispatchDeliveryOtpNotification({ order, otp, user: order.userId });

    res.json({
      success: true,
      message: '6-digit Delivery OTP has been resent to customer registered mobile number.',
      resendCount: order.deliveryOtpResendCount,
      expiresAt: order.deliveryOtpExpiresAt
    });
  } catch (error) {
    console.error('Resend delivery OTP error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/:id/verify-delivery-otp
// @desc    Verify customer 6-digit OTP and complete delivery (Driver/Admin)
// @access  Private (Driver or Admin)
router.post('/:id/verify-delivery-otp', protect, async (req, res) => {
  try {
    const { otp, paymentStatus, isCash } = req.body;
    const { Order: OrderModel, Driver: DriverModel, CashCollector: CashCollectorModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id).populate('userId', 'name email role phone');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Authorization check: Assigned Driver or Admin
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager', 'logistics', 'sales'].includes(req.user.role);
    const isDriver = order.driverId?.toString() === req.user._id.toString();

    if (!isAdmin && !isDriver) {
      return res.status(403).json({ message: 'Not authorized to verify delivery for this order' });
    }

    if (!otp) {
      return res.status(400).json({ message: 'Please provide the 6-digit Delivery OTP collected from the customer.' });
    }

    // Perform secure OTP verification
    const verifyResult = verifyOrderDeliveryOtp(order, otp);
    if (!verifyResult.success) {
      await order.save(); // Persist attempt counter
      return res.status(400).json({
        message: verifyResult.message,
        remainingAttempts: verifyResult.remainingAttempts,
        code: verifyResult.code
      });
    }

    // Handle multi-seller pickups status sync
    if (order.sellerPickups && order.sellerPickups.length > 0) {
      order.sellerPickups.forEach(sp => {
        sp.status = 'Delivered';
      });
    }

    // Handle payment update if delivered with Cash
    if (isCash || req.body.isCash) {
      if (order.cashPersonId) {
        const collector = await CashCollectorModel.findById(order.cashPersonId);
        if (collector) {
          collector.amount = (collector.amount || 0) + order.totalAmount;
          await collector.save();
        }
      } else if (order.driverId) {
        const driver = await DriverModel.findById(order.driverId);
        if (driver) {
          driver.wallet = (driver.wallet || 0) + order.totalAmount;
          await driver.save();
        }
      }
      order.paymentMethod = 'Cash';
      order.paymentStatus = 'Completed';
      order.paidAt = new Date();
    } else if (paymentStatus) {
      order.paymentStatus = paymentStatus;
    }

    await order.save();
    emitOrderRealtimeUpdate(order, 'update');

    // Emit Socket.IO delivery event
    try {
      const { getIO } = require('../utils/socket');
      const io = getIO();
      if (io) {
        io.emit('order:delivered', { orderId: order._id.toString() });
        io.emit(`order:${order._id.toString()}`, { type: 'ORDER_DELIVERED', orderId: order._id.toString() });
      }
    } catch (e) {}

    // Send confirmation email
    if (order.userId?.email) {
      sendEmail({
        to: order.userId.email,
        subject: `Package Delivered! Order #${order._id.toString().slice(-6).toUpperCase()}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #059669; color: white; padding: 24px; text-align: center;">
              <h1 style="margin: 0; font-size: 24px;">Order Delivered Successfully!</h1>
            </div>
            <div style="padding: 24px;">
              <p>Hello <strong>${order.userId?.name || 'Customer'}</strong>,</p>
              <p>Your order <strong>#${order._id.toString().slice(-6).toUpperCase()}</strong> has been delivered via verified OTP on ${new Date().toLocaleString('en-IN')}.</p>
              <p>Thank you for shopping with Zudo!</p>
            </div>
          </div>
        `
      }).catch(err => console.error('Delivery confirmation email failed:', err.message));
    }

    res.json({
      success: true,
      message: 'OTP verified successfully. Order marked as Delivered!',
      order
    });
  } catch (error) {
    console.error('Verify delivery OTP error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/orders/:id/track
// @desc    Get order tracking status and driver live location (User/Customer only)
// @access  Private (Customer only)
router.get('/:id/track', protect, async (req, res) => {
  try {
    const OrderModel = getModels(req).Order;
    const order = await OrderModel.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Verify this is the user's order or request is by an admin
    if (order.userId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to track this order' });
    }

    const response = {
      orderId: order._id,
      orderStatus: order.orderStatus,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalAmount: order.totalAmount,
      shippingAddress: order.shippingAddress,
      deliveryOtp: order.orderStatus === 'Out for Delivery' ? order.deliveryOtp : null,
      deliveryOtpExpiresAt: order.orderStatus === 'Out for Delivery' ? order.deliveryOtpExpiresAt : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };

    if (order.driverId && ['Picked Up', 'Out for Delivery'].includes(order.orderStatus)) {
      const DriverModel = getModels(req).Driver;
      const driver = await DriverModel.findById(order.driverId).select('name phone vehicleDetails currentLocation');
      if (driver) {
        response.driver = {
          name: driver.name,
          phone: driver.phone,
          vehicleDetails: driver.vehicleDetails,
          currentLocation: driver.currentLocation && driver.currentLocation.lat != null ? driver.currentLocation : null
        };
      }
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/orders/admin/create
// @desc    Admin manually create order for a user
// @access  Private (Admin only)
router.post('/admin/create', protect, async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ message: 'Not authorized, admin only' });
    }

    const { userId, items, shippingAddress, paymentMethod } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No items in order' });
    }

    const { User: UserModel, Order: OrderModel, Product: ProductModel, Seller: SellerModel } = getModels(req);
    const targetUser = await UserModel.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Validate stock, quantity, and seller maximum order quantity (MOQ)
    const adminCombinedQuantities = {};
    for (const item of items) {
      const pId = (item.productId || item.product || item.id || item._id)?.toString();
      const qty = parseInt(item.quantity, 10);
      if (pId) {
        adminCombinedQuantities[pId] = (adminCombinedQuantities[pId] || 0) + (isNaN(qty) ? 0 : qty);
      }
    }

    for (const item of items) {
      const pId = item.productId || item.product || item.id || item._id;
      const productData = await ProductModel.findById(pId);
      if (!productData) {
        return res.status(404).json({ message: `Product not found: ${item.name || pId}` });
      }

      // Enforce positive integer quantity
      const qty = parseInt(item.quantity, 10);
      if (!qty || isNaN(qty) || qty <= 0 || Number(item.quantity) !== qty) {
        return res.status(400).json({
          message: `Invalid quantity for product "${productData.name}". Quantity must be a positive integer.`
        });
      }
      item.quantity = qty;

      // Validate Seller Maximum Order Quantity (MOQ) restriction
      const maxOrderLimit = productData.maxOrderQuantity !== undefined && productData.maxOrderQuantity !== null
        ? Number(productData.maxOrderQuantity)
        : (productData.moq !== undefined && productData.moq !== null ? Number(productData.moq) : null);

      if (maxOrderLimit && maxOrderLimit > 0) {
        const totalQtyForProduct = adminCombinedQuantities[pId.toString()] || qty;
        if (totalQtyForProduct > maxOrderLimit) {
          return res.status(400).json({
            message: `Maximum ${maxOrderLimit} units allowed per order for "${productData.name}". You requested ${totalQtyForProduct} units.`,
            maxOrderQuantity: maxOrderLimit,
            productId: pId
          });
        }
      }

      const targetSize = item.variantSize || item.selectedPacketSize;
      const stockInfo = getProductStock(productData, targetSize, targetUser.role);
      if (targetSize && !stockInfo.hasVariant) {
        return res.status(400).json({
          message: `Variant "${item.variantSize}" not found for product "${productData.name}"`
        });
      }
      if (stockInfo.stock < item.quantity) {
        return res.status(400).json({
          message: `Insufficient stock for product "${productData.name}"${item.variantSize ? ` (${item.variantSize})` : ''}. Available: ${stockInfo.stock}, Requested: ${item.quantity}`
        });
      }
    }

    let calculatedTotal = 0;
    let calculatedTotalWithoutCommissions = 0;
    let totalGstCollected = 0;
    let totalCommissionCollected = 0;
    const commissions = await loadCommissions(req);

    const enrichedItems = await Promise.all(items.map(async (item) => {
      const pId = item.productId || item.product;
      const productData = await ProductModel.findById(pId);
      if (!productData) {
        throw new Error(`Product not found: ${pId}`);
      }

      const pDataObj = productData.toObject ? productData.toObject() : productData;
      const enrichedProduct = applyCommission(pDataObj, commissions, shippingAddress?.pincode);

      let basePriceObj = enrichedProduct;
      let rawBasePriceObj = pDataObj;
      let name = item.name || enrichedProduct.name || productData.name;
      let gstPercent = productData.gstPercent || 0;

      const variantArray = targetUser.role === 'b2b' ? (enrichedProduct.b2b || []) : (enrichedProduct.b2c || []);
      const rawVariantArray = targetUser.role === 'b2b' ? (pDataObj.b2b || []) : (pDataObj.b2c || []);
      const targetSize = item.variantSize || item.selectedPacketSize;

      if (targetSize && variantArray.length > 0) {
        const variant = variantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
        const rawVariant = rawVariantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
        if (variant) {
          basePriceObj = variant;
          if (rawVariant) rawBasePriceObj = rawVariant;
          const sizeStr = variant.packetSize || variant.sizeName;
          if (sizeStr && !name.includes(sizeStr)) {
            name = `${name} - ${sizeStr}`;
          }
        }
      } else if (targetSize && enrichedProduct.variants && enrichedProduct.variants.length > 0) {
        const variant = enrichedProduct.variants.find(v => v.sizeName === targetSize);
        const rawVariant = (pDataObj.variants || []).find(v => v.sizeName === targetSize);
        if (variant) {
          basePriceObj = variant;
          if (rawVariant) rawBasePriceObj = rawVariant;
          if (variant.sizeName && !name.includes(variant.sizeName)) {
            name = `${name} - ${variant.sizeName}`;
          }
        }
      }

      // Fallback to first variant if root price is 0 and no variant was specified
      if (!targetSize && (!basePriceObj.price || basePriceObj.price === 0)) {
        const fallbackArray = targetUser.role === 'b2b' ?
          (enrichedProduct.b2b?.length ? enrichedProduct.b2b : enrichedProduct.variants) :
          (enrichedProduct.b2c?.length ? enrichedProduct.b2c : enrichedProduct.variants);
        const rawFallbackArray = targetUser.role === 'b2b' ?
          (pDataObj.b2b?.length ? pDataObj.b2b : pDataObj.variants) :
          (pDataObj.b2c?.length ? pDataObj.b2c : pDataObj.variants);
        if (fallbackArray && fallbackArray.length > 0) {
          basePriceObj = fallbackArray[0];
          if (rawFallbackArray && rawFallbackArray.length > 0) {
            rawBasePriceObj = rawFallbackArray[0];
          }
        }
      }

      let rawPrice = targetUser.role === 'b2b'
        ? (rawBasePriceObj.sellerB2bPrice !== undefined && rawBasePriceObj.sellerB2bPrice !== null ? rawBasePriceObj.sellerB2bPrice : (rawBasePriceObj.b2bPrice || rawBasePriceObj.sellerPrice || rawBasePriceObj.price))
        : (rawBasePriceObj.sellerPrice !== undefined && rawBasePriceObj.sellerPrice !== null ? rawBasePriceObj.sellerPrice : rawBasePriceObj.price);

      if (targetUser.role === 'b2b' && basePriceObj.priceTiers && basePriceObj.priceTiers.length > 0) {
        const sortedTiers = [...basePriceObj.priceTiers].sort((a, b) => b.minQty - a.minQty);
        const applicableTier = sortedTiers.find(t => item.quantity >= t.minQty);
        if (applicableTier && rawBasePriceObj.priceTiers && rawBasePriceObj.priceTiers.length > 0) {
          const rawApplicableTier = rawBasePriceObj.priceTiers.find(t => t.minQty === applicableTier.minQty);
          if (rawApplicableTier) {
            rawPrice = rawApplicableTier.sellerPrice !== undefined ? rawApplicableTier.sellerPrice : rawApplicableTier.price;
          }
        }
      }

      const commRule = findCategoryCommission(commissions, productData.categoryId, productData.unit, shippingAddress?.pincode);
      const commType = commRule?.commissionType || basePriceObj.commissionType || enrichedProduct?.commissionType || 'flat';
      const commVal = commRule ? commRule.commissionValue : (basePriceObj.commissionValue ?? enrichedProduct?.commissionValue ?? 0);

      const breakdown = calculatePricingBreakdown({
        sellerUnitPrice: Number(rawPrice) || 0,
        commissionType: commType,
        commissionValue: Number(commVal) || 0,
        gstPercent: gstPercent,
        quantity: item.quantity,
        availableStock: productData ? (productData.stock || 0) : 0,
        isB2B: targetUser.role === 'b2b'
      });

      let sellerInfo = null;
      if (productData.sellerId) {
        const seller = await SellerModel.findById(productData.sellerId);
        if (seller) {
          sellerInfo = {
            sellerId: seller._id,
            name: seller.name || seller.storeName,
            phone: seller.phone,
            address: seller.pickupLocation?.address || seller.businessAddress,
            lat: seller.pickupLocation?.lat,
            lng: seller.pickupLocation?.lng,
            gstNumber: seller.gstNumber
          };
        }
      }

      calculatedTotal += breakdown.finalCustomerPrice;
      calculatedTotalWithoutCommissions += (breakdown.totalSellerPrice + breakdown.totalGst);
      totalGstCollected += breakdown.totalGst;
      totalCommissionCollected += breakdown.totalCommission;

      return {
        productId: pId,
        variantSize: targetSize,
        name: name,
        quantity: item.quantity,
        orderedQuantity: item.quantity,
        price: breakdown.unitCustomerPrice,
        unitCustomerPrice: breakdown.unitCustomerPrice,
        normalPrice: breakdown.sellerUnitPrice,
        sellerUnitPrice: breakdown.sellerUnitPrice,
        commissionType: breakdown.commissionType,
        commissionValue: breakdown.commissionRate,
        commissionRate: breakdown.commissionRate,
        commissionAmount: breakdown.unitCommission,
        unitCommission: breakdown.unitCommission,
        totalCommission: breakdown.totalCommission,
        totalSellerPrice: breakdown.totalSellerPrice,
        finalCustomerPrice: breakdown.finalCustomerPrice,
        availableStock: breakdown.availableStock,
        stockTotalCommission: breakdown.stockTotalCommission,
        gstPercent: breakdown.gstPercent,
        gstAmount: breakdown.unitGst,
        totalGst: breakdown.totalGst,
        image: productData.imageUrl || productData.image,
        seller: sellerInfo,
        product: {
          name: productData.name,
          image: productData.imageUrl || productData.image,
          imageUrl: productData.imageUrl || productData.image
        }
      };
    }));

    // Generate Pickup OTPs
    const globalPickupOtp = generateOTP(6);
    const uniqueSellerIds = [...new Set(enrichedItems.filter(i => i.seller?.sellerId).map(i => i.seller.sellerId.toString()))];
    const isMultiSeller = uniqueSellerIds.length > 1;

    const sellerPickups = uniqueSellerIds.map(id => ({
      sellerId: id,
      status: 'Pending',
      pickupCode: isMultiSeller ? generateOTP(6) : globalPickupOtp
    }));

    const calculatedTotalRounded = round2(calculatedTotal);
    const calculatedTotalWithoutCommissionsRounded = round2(calculatedTotalWithoutCommissions);
    const totalCommissionCollectedRounded = round2(totalCommissionCollected);
    const totalGstCollectedRounded = round2(totalGstCollected);

    const { invoiceSequence: adminInvSeq, orderRef: adminOrdRef, invoiceNumber: adminInvNum } = await assignInvoiceDetails(OrderModel);

    const order = new OrderModel({
      userId,
      type: targetUser.role === 'b2b' ? 'b2b' : 'b2c',
      items: enrichedItems,
      totalAmount: calculatedTotalRounded,
      totalAmountWithoutCommissions: calculatedTotalWithoutCommissionsRounded,
      totalCommissionAmount: totalCommissionCollectedRounded,
      totalGstAmount: totalGstCollectedRounded,
      shippingAddress,
      paymentMethod,
      paymentStatus: paymentMethod === 'COD' ? 'Pending' : 'Completed',
      orderStatus: 'Pending',
      pickupCode: globalPickupOtp,
      sellerPickups: sellerPickups,
      deliveryOtp: null,
      invoiceSequence: adminInvSeq,
      orderRef: adminOrdRef,
      invoiceNumber: adminInvNum
    });

    const createdOrder = await order.save();

    // Decrease stock for each item now that the order is successfully created
    for (const item of enrichedItems) {
      const result = await adjustProductStock(ProductModel, item.productId, item.variantSize, -item.quantity, targetUser.role);
      await checkAndNotifyLowStock(result, item, req);
    }

    // Populate populated order
    const populated = await OrderModel.findById(createdOrder._id)
      .populate('userId', 'name email role businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .populate('cashPersonId', 'name phone');

    res.status(201).json(populated);
  } catch (error) {
    console.error('Admin manual order creation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/admin/:id/items
// @desc    Admin update order items and recalculate total
// @access  Private (Admin only)
router.put('/admin/:id/items', protect, async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ message: 'Not authorized, admin only' });
    }

    const { items } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Items list cannot be empty' });
    }

    const { Order: OrderModel, User: UserModel, Product: ProductModel, Seller: SellerModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const targetUser = await UserModel.findById(order.userId);
    const userRole = targetUser ? targetUser.role : 'b2c';

    let calculatedTotal = 0;
    let calculatedTotalWithoutCommissions = 0;
    let totalGstCollected = 0;
    let totalCommissionCollected = 0;
    const commissions = await loadCommissions(req);

    const enrichedItems = await Promise.all(items.map(async (item) => {
      const pId = item.productId || item.product;
      const productData = await ProductModel.findById(pId);
      if (!productData) {
        throw new Error(`Product not found: ${pId}`);
      }

      // Enforce positive integer quantity
      const qty = parseInt(item.quantity, 10);
      if (!qty || isNaN(qty) || qty <= 0 || Number(item.quantity) !== qty) {
        throw new Error(`Invalid quantity for product "${productData.name}". Quantity must be a positive integer.`);
      }
      item.quantity = qty;

      const pDataObj = productData.toObject ? productData.toObject() : productData;
      const enrichedProduct = applyCommission(pDataObj, commissions, order.shippingAddress?.pincode);

      let basePriceObj = enrichedProduct;
      let rawBasePriceObj = pDataObj;
      let name = item.name || enrichedProduct.name || productData.name;
      let gstPercent = productData.gstPercent || 0;

      const variantArray = userRole === 'b2b' ? (enrichedProduct.b2b || []) : (enrichedProduct.b2c || []);
      const rawVariantArray = userRole === 'b2b' ? (pDataObj.b2b || []) : (pDataObj.b2c || []);
      const targetSize = item.variantSize || item.selectedPacketSize;

      if (targetSize && variantArray.length > 0) {
        const variant = variantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
        const rawVariant = rawVariantArray.find(v => (v.packetSize || v.sizeName) === targetSize);
        if (variant) {
          basePriceObj = variant;
          if (rawVariant) rawBasePriceObj = rawVariant;
          const sizeStr = variant.packetSize || variant.sizeName;
          if (sizeStr && !name.includes(sizeStr)) {
            name = `${name} - ${sizeStr}`;
          }
        }
      } else if (targetSize && enrichedProduct.variants && enrichedProduct.variants.length > 0) {
        const variant = enrichedProduct.variants.find(v => v.sizeName === targetSize);
        const rawVariant = (pDataObj.variants || []).find(v => v.sizeName === targetSize);
        if (variant) {
          basePriceObj = variant;
          if (rawVariant) rawBasePriceObj = rawVariant;
          if (variant.sizeName && !name.includes(variant.sizeName)) {
            name = `${name} - ${variant.sizeName}`;
          }
        }
      }

      if (!targetSize && (!basePriceObj.price || basePriceObj.price === 0)) {
        const fallbackArray = userRole === 'b2b' ?
          (enrichedProduct.b2b?.length ? enrichedProduct.b2b : enrichedProduct.variants) :
          (enrichedProduct.b2c?.length ? enrichedProduct.b2c : enrichedProduct.variants);
        const rawFallbackArray = userRole === 'b2b' ?
          (pDataObj.b2b?.length ? pDataObj.b2b : pDataObj.variants) :
          (pDataObj.b2c?.length ? pDataObj.b2c : pDataObj.variants);
        if (fallbackArray && fallbackArray.length > 0) {
          basePriceObj = fallbackArray[0];
          if (rawFallbackArray && rawFallbackArray.length > 0) {
            rawBasePriceObj = rawFallbackArray[0];
          }
        }
      }

      let rawPrice = userRole === 'b2b'
        ? (rawBasePriceObj.sellerB2bPrice !== undefined && rawBasePriceObj.sellerB2bPrice !== null ? rawBasePriceObj.sellerB2bPrice : (rawBasePriceObj.b2bPrice || rawBasePriceObj.sellerPrice || rawBasePriceObj.price))
        : (rawBasePriceObj.sellerPrice !== undefined && rawBasePriceObj.sellerPrice !== null ? rawBasePriceObj.sellerPrice : rawBasePriceObj.price);

      if (userRole === 'b2b' && basePriceObj.priceTiers && basePriceObj.priceTiers.length > 0) {
        const sortedTiers = [...basePriceObj.priceTiers].sort((a, b) => b.minQty - a.minQty);
        const applicableTier = sortedTiers.find(t => item.quantity >= t.minQty);
        if (applicableTier && rawBasePriceObj.priceTiers && rawBasePriceObj.priceTiers.length > 0) {
          const rawApplicableTier = rawBasePriceObj.priceTiers.find(t => t.minQty === applicableTier.minQty);
          if (rawApplicableTier) {
            rawPrice = rawApplicableTier.sellerPrice !== undefined ? rawApplicableTier.sellerPrice : rawApplicableTier.price;
          }
        }
      }

      // Check Maximum Order Quantity (MOQ) limit
      const maxOrderLimit = productData.maxOrderQuantity !== undefined && productData.maxOrderQuantity !== null
        ? Number(productData.maxOrderQuantity)
        : (productData.moq !== undefined && productData.moq !== null ? Number(productData.moq) : null);

      if (maxOrderLimit && maxOrderLimit > 0 && item.quantity > maxOrderLimit) {
        throw new Error(`Maximum ${maxOrderLimit} units allowed per order for "${productData.name}". Requested: ${item.quantity}`);
      }

      // Check stock limit
      const targetSizeCheck = item.variantSize || item.selectedPacketSize;
      const stockInfo = getProductStock(productData, targetSizeCheck, userRole);
      if (stockInfo.stock < item.quantity) {
        throw new Error(`Insufficient stock for product "${productData.name}"${targetSizeCheck ? ` (${targetSizeCheck})` : ''}. Available: ${stockInfo.stock}, Requested: ${item.quantity}`);
      }

      const commRule = findCategoryCommission(commissions, productData.categoryId, productData.unit, order.shippingAddress?.pincode);
      const commType = commRule?.commissionType || basePriceObj.commissionType || enrichedProduct?.commissionType || 'flat';
      const commVal = commRule ? commRule.commissionValue : (basePriceObj.commissionValue ?? enrichedProduct?.commissionValue ?? 0);

      const breakdown = calculatePricingBreakdown({
        sellerUnitPrice: Number(rawPrice) || 0,
        commissionType: commType,
        commissionValue: Number(commVal) || 0,
        gstPercent: gstPercent,
        quantity: item.quantity,
        availableStock: productData ? (productData.stock || 0) : 0,
        isB2B: userRole === 'b2b'
      });

      let sellerInfo = null;
      if (productData.sellerId) {
        const seller = await SellerModel.findById(productData.sellerId);
        if (seller) {
          sellerInfo = {
            sellerId: seller._id,
            name: seller.name || seller.storeName,
            phone: seller.phone,
            address: seller.pickupLocation?.address || seller.businessAddress,
            lat: seller.pickupLocation?.lat,
            lng: seller.pickupLocation?.lng
          };
        }
      }

      calculatedTotal += breakdown.finalCustomerPrice;
      calculatedTotalWithoutCommissions += (breakdown.totalSellerPrice + breakdown.totalGst);
      totalGstCollected += breakdown.totalGst;
      totalCommissionCollected += breakdown.totalCommission;

      return {
        productId: pId,
        variantSize: targetSize,
        name: name,
        quantity: item.quantity,
        orderedQuantity: item.quantity,
        price: breakdown.unitCustomerPrice,
        unitCustomerPrice: breakdown.unitCustomerPrice,
        normalPrice: breakdown.sellerUnitPrice,
        sellerUnitPrice: breakdown.sellerUnitPrice,
        commissionType: breakdown.commissionType,
        commissionValue: breakdown.commissionRate,
        commissionRate: breakdown.commissionRate,
        commissionAmount: breakdown.unitCommission,
        unitCommission: breakdown.unitCommission,
        totalCommission: breakdown.totalCommission,
        totalSellerPrice: breakdown.totalSellerPrice,
        finalCustomerPrice: breakdown.finalCustomerPrice,
        availableStock: breakdown.availableStock,
        stockTotalCommission: breakdown.stockTotalCommission,
        gstPercent: breakdown.gstPercent,
        gstAmount: breakdown.unitGst,
        totalGst: breakdown.totalGst,
        image: productData.imageUrl || productData.image,
        seller: sellerInfo,
        product: {
          name: productData.name,
          image: productData.imageUrl || productData.image,
          imageUrl: productData.imageUrl || productData.image
        }
      };
    }));

    order.items = enrichedItems;
    order.totalAmount = round2(calculatedTotal);
    order.totalAmountWithoutCommissions = round2(calculatedTotalWithoutCommissions);
    order.totalCommissionAmount = round2(totalCommissionCollected);
    order.totalGstAmount = round2(totalGstCollected);
    await order.save();

    const populated = await OrderModel.findById(order._id)
      .populate('userId', 'name email role businessName companyName')
      .populate('driverId', 'name phone vehicleNo vehicleDetails')
      .populate('cashPersonId', 'name phone');

    res.json(populated);
  } catch (error) {
    console.error('Admin order items update error:', error);
    res.status(500).json({ message: error.message });
  }
});


// --------------------------------------------------------
// REVERSE LOGISTICS: INDIVIDUAL PRODUCT RETURN ENDPOINTS
// --------------------------------------------------------

// @route   POST /api/orders/:id/items/:itemId/return
// @desc    Customer requests a return for a specific item
router.post('/:id/items/:itemId/return', protect, async (req, res) => {
  try {
    const { returnReason, returnComment, returnImage } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.orderStatus !== 'Delivered' && order.orderStatus !== 'Partially Returned') {
      return res.status(400).json({ message: 'Can only return items from delivered orders' });
    }

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'Item not found in order' });

    if (item.returnStatus !== 'None' && item.returnStatus !== 'Return Rejected') {
      return res.status(400).json({ message: 'Return already requested for this item' });
    }

    item.returnStatus = 'Return Requested';
    item.returnReason = returnReason || null;
    item.returnComment = returnComment || null;
    item.returnImage = returnImage || null;
    item.refundAccountName = req.body.refundAccountName || null;
    item.refundBankName = req.body.refundBankName || null;
    item.refundAccountNumber = req.body.refundAccountNumber || null;
    item.refundIfscCode = req.body.refundIfscCode || null;

    order.returnStatus = 'Requested';

    if (order.orderStatus === 'Delivered') {
      order.orderStatus = 'Return Requested';
    }

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/return-approve
// @desc    Admin approves full order return
router.put('/:id/return-approve', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.returnStatus = 'Approved';
    order.items.forEach(item => {
      if (item.returnStatus === 'Return Requested') {
        item.returnStatus = 'Return Approved';
      }
    });

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/return-reject
// @desc    Admin rejects full order return
router.put('/:id/return-reject', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.returnStatus = 'Rejected';
    order.items.forEach(item => {
      if (item.returnStatus === 'Return Requested') {
        item.returnStatus = 'Return Rejected';
      }
    });

    // Check if we need to revert orderStatus
    if (order.orderStatus === 'Return Requested') {
      order.orderStatus = 'Delivered';
    }

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/items/:itemId/return-status
// @desc    Admin/Seller approves or rejects a return request
router.put('/:id/items/:itemId/return-status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const item = order.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'Item not found in order' });

    if (item.returnStatus !== 'Return Requested') {
      return res.status(400).json({ message: 'Item is not awaiting return approval' });
    }

    item.returnStatus = status;

    if (status === 'Return Rejected') {
      const anyStillRequested = order.items.some(i => i.returnStatus === 'Return Requested');
      const anyApproved = order.items.some(i => ['Return Approved', 'Picked Up from Customer', 'Returned to Seller'].includes(i.returnStatus));
      if (!anyStillRequested && !anyApproved) {
        order.orderStatus = 'Delivered';
      }
    }

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/assign-return-driver
// @desc    Admin assigns a driver for return pickup and generates OTPs
router.put('/:id/assign-return-driver', protect, async (req, res) => {
  try {
    const { driverId } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const approvedItems = order.items.filter(i => i.returnStatus === 'Return Approved');
    if (approvedItems.length === 0) {
      return res.status(400).json({ message: 'No items are approved for return' });
    }

    order.returnDriverId = driverId;
    order.returnCustomerOtp = generateOTP(6);
    order.orderStatus = 'Return Driver Assigned';

    const uniqueSellerIds = [...new Set(approvedItems.map(i => i.seller.sellerId.toString()))];
    order.sellerReturnPickups = uniqueSellerIds.map(sId => ({
      sellerId: sId,
      status: 'Pending',
      returnOtp: generateOTP(6)
    }));

    await order.save();

    const populated = await OrderModel.findById(order._id)
      .populate('userId', 'name email phone businessName companyName')
      .populate('returnDriverId', 'name phone vehicleNo vehicleDetails');

    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/return-pickup
// @desc    Driver picks up items from customer
router.put('/:id/return-pickup', protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.returnCustomerOtp !== otp) {
      return res.status(400).json({ message: 'Invalid customer return OTP' });
    }

    let updatedCount = 0;
    order.items.forEach(item => {
      if (item.returnStatus === 'Return Approved') {
        item.returnStatus = 'Picked Up from Customer';
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      order.orderStatus = 'Out for Return';
    }

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/return-delivery
// @desc    Driver drops off items to a specific seller
router.put('/:id/return-delivery', protect, async (req, res) => {
  try {
    const { sellerId, otp } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const sellerPickup = order.sellerReturnPickups.find(sp => sp.sellerId.toString() === sellerId);
    if (!sellerPickup) return res.status(400).json({ message: 'Seller return info not found' });
    if (sellerPickup.returnOtp !== otp) return res.status(400).json({ message: 'Invalid seller return OTP' });

    sellerPickup.status = 'Returned to Seller';

    order.items.forEach(item => {
      if (item.returnStatus === 'Picked Up from Customer' && item.seller.sellerId.toString() === sellerId) {
        item.returnStatus = 'Returned to Seller';
      }
    });

    const allReturnsComplete = order.sellerReturnPickups.every(sp => sp.status === 'Returned to Seller');
    if (allReturnsComplete) {
      const totalItems = order.items.length;
      const returnedItemsCount = order.items.filter(i => i.returnStatus === 'Returned to Seller').length;

      if (returnedItemsCount === totalItems) {
        order.orderStatus = 'Returned';
      } else {
        order.orderStatus = 'Partially Returned';
      }
    }

    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/orders/admin/:id
// @desc    Admin deletes an order
router.delete('/admin/:id', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/qrcode
// @desc    Update order QR Code (Seller)
// @access  Private (Seller/Admin)
router.put('/:id/qrcode', protect, async (req, res) => {
  const { qrCodeDoc, qrOption } = req.body;
  try {
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    
    if (qrCodeDoc !== undefined) order.qrCodeDoc = qrCodeDoc;
    if (qrOption !== undefined) order.qrOption = qrOption;
    
    const updatedOrder = await order.save();
    res.json(updatedOrder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/orders/:id/routes
// @desc    Update order route assignments (Route 1, Route 2, Route 3)
router.put('/:id/routes', protect, async (req, res) => {
  try {
    const { route1, route2, route3 } = req.body;
    const { Order: OrderModel } = getModels(req);
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (route1 !== undefined) order.route1 = route1;
    if (route2 !== undefined) order.route2 = route2;
    if (route3 !== undefined) order.route3 = route3;

    await order.save();
    res.json({ message: 'Order routes updated successfully', order });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// @route   PUT /api/orders/:id/invoice-number
// @desc    Update custom invoice number and order ref for an order
// @access  Private
router.put('/:id/invoice-number', protect, async (req, res) => {
  try {
    const { Order: OrderModel } = getModels(req);
    const { invoiceNumber, orderRef } = req.body;
    const order = await OrderModel.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (invoiceNumber) order.invoiceNumber = invoiceNumber;
    if (orderRef) order.orderRef = orderRef;
    await order.save();
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
