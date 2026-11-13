const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { getModel } = require('../utils/model_loader');
const { round2 } = require('../utils/pricing');
const { generatePaymentReceiptPDF } = require('../utils/pdfPaymentReceipt');

/**
 * Helper to determine if an order is Cash on Delivery (COD)
 */
const isCodOrder = (order) => {
  if (!order || !order.paymentMethod) return false;
  const m = String(order.paymentMethod).trim().toLowerCase();
  return m === 'cod' || m.includes('cash');
};

/**
 * Helper to determine if an order is Online Payment
 */
const isOnlineOrder = (order) => {
  return !isCodOrder(order);
};

/**
 * Extract seller items and financial breakdown for a seller from an order
 */
const extractSellerOrderBreakdown = (order, targetSellerIdStr, productSellerMap = {}) => {
  let sellerSales = 0;
  let sellerCommission = 0;
  let sellerGst = 0;
  let sellerPayable = 0;
  let hasSellerItem = false;
  const sellerItems = [];

  if (!order || !Array.isArray(order.items)) {
    return { hasSellerItem, sellerSales, sellerCommission, sellerGst, sellerPayable, sellerItems };
  }

  order.items.forEach(item => {
    let itemSellerId = item.seller?.sellerId?.toString() || item.sellerId?.toString();
    if (!itemSellerId && item.productId) {
      itemSellerId = productSellerMap[item.productId.toString()];
    }

    if (itemSellerId && itemSellerId === targetSellerIdStr) {
      hasSellerItem = true;
      const qty = Number(item.quantity) || 1;
      const itemPrice = Number(item.price) || 0;
      const gross = round2(itemPrice * qty);
      const comm = round2(Number(item.totalCommission) || ((Number(item.unitCommission) || Number(item.commissionAmount) || 0) * qty) || 0);
      const gst = round2(Number(item.totalGst) || Number(item.gstAmount) || 0);

      let payable = 0;
      if (item.totalSellerAmount && Number(item.totalSellerAmount) > 0) {
        payable = round2(Number(item.totalSellerAmount));
      } else if (item.sellerPricePerPackage && Number(item.sellerPricePerPackage) > 0) {
        payable = round2(Number(item.sellerPricePerPackage) * qty);
      } else if (item.sellerUnitPrice && Number(item.sellerUnitPrice) > 0) {
        payable = round2(Number(item.sellerUnitPrice) * qty);
      } else if (item.normalPrice && Number(item.normalPrice) > 0) {
        payable = round2(Number(item.normalPrice) * qty);
      } else {
        payable = round2(Math.max(0, gross - comm));
      }

      sellerSales += gross;
      sellerCommission += comm;
      sellerGst += gst;
      sellerPayable += payable;

      sellerItems.push({
        productId: item.productId,
        name: item.name,
        quantity: qty,
        unit: item.unit || item.sellingUnit || item.packagingType || 'Bag',
        price: itemPrice,
        grossAmount: gross,
        commission: comm,
        gst: gst,
        payableAmount: payable,
        returnStatus: item.returnStatus || 'None'
      });
    }
  });

  return {
    hasSellerItem,
    sellerSales: round2(sellerSales),
    sellerCommission: round2(sellerCommission),
    sellerGst: round2(sellerGst),
    sellerPayable: round2(sellerPayable),
    sellerItems
  };
};

/**
 * Universal data loader for payments (single-location vs global multi-tenant)
 */
const loadPaymentContext = async (req) => {
  if (!req.locationId) {
    const { aggregateGET } = require('../utils/aggregator');
    const [sellers, products, orders, payouts, auditLogs] = await Promise.all([
      aggregateGET('Seller', req, {}, [], '-password'),
      aggregateGET('Product', req, {}, [], '_id sellerId'),
      aggregateGET('Order', req, {}, ['userId', 'driverId']),
      aggregateGET('SellerPayment', req, {}, [], '', { date: -1 }),
      aggregateGET('PaymentAuditLog', req, {}, [], '', { createdAt: -1 })
    ]);

    const productSellerMap = {};
    products.forEach(p => {
      if (p.sellerId) {
        productSellerMap[p._id.toString()] = p.sellerId.toString();
      }
    });

    return { sellers, products, orders, payouts, auditLogs, productSellerMap, isAggregated: true };
  }

  const SellerModel = getModel('Seller', req);
  const ProductModel = getModel('Product', req);
  const OrderModel = getModel('Order', req);
  const SellerPaymentModel = getModel('SellerPayment', req);
  const PaymentAuditLogModel = getModel('PaymentAuditLog', req);

  const [sellers, products, orders, payouts, auditLogs] = await Promise.all([
    SellerModel.find().select('-password').lean(),
    ProductModel.find().select('_id sellerId').lean(),
    OrderModel.find().populate('userId', 'name email phone').populate('driverId', 'name phone').lean(),
    SellerPaymentModel.find().sort({ date: -1 }).lean(),
    PaymentAuditLogModel.find().sort({ createdAt: -1 }).lean()
  ]);

  const productSellerMap = {};
  products.forEach(p => {
    if (p.sellerId) {
      productSellerMap[p._id.toString()] = p.sellerId.toString();
    }
  });

  return { sellers, products, orders, payouts, auditLogs, productSellerMap, isAggregated: false };
};

// ============================================================================
// 1. PAYMENTS DASHBOARD STATS (8 Key Metrics)
// ============================================================================
// @route   GET /api/payments/dashboard-stats
// @desc    Get top-level metrics for seller payments dashboard
router.get('/dashboard-stats', protect, async (req, res) => {
  try {
    const { sellers, orders, payouts, productSellerMap } = await loadPaymentContext(req);

    let totalSellerSales = 0;
    let totalCodSales = 0;
    let totalOnlineSales = 0;
    let totalCommission = 0;
    let totalSellerPayable = 0;
    let totalCodCollection = 0;
    let totalOnlineCollection = 0;

    const deliveredOrders = orders.filter(o => o.orderStatus === 'Delivered');

    deliveredOrders.forEach(order => {
      const isCod = isCodOrder(order);
      const isOnline = isOnlineOrder(order);
      const orderAmount = Number(order.totalAmount) || 0;

      if (isCod) {
        totalCodSales += orderAmount;
      } else if (isOnline) {
        totalOnlineSales += orderAmount;
      }
      totalSellerSales += orderAmount;

      if (Array.isArray(order.items)) {
        order.items.forEach(item => {
          const qty = Number(item.quantity) || 1;
          const comm = Number(item.totalCommission) || ((Number(item.unitCommission) || 0) * qty);
          totalCommission += comm;

          if (item.totalSellerAmount && Number(item.totalSellerAmount) > 0) {
            totalSellerPayable += Number(item.totalSellerAmount);
          } else if (item.sellerPricePerPackage && Number(item.sellerPricePerPackage) > 0) {
            totalSellerPayable += Number(item.sellerPricePerPackage) * qty;
          } else {
            totalSellerPayable += Math.max(0, (Number(item.price) || 0) * qty - comm);
          }
        });
      }
    });

    // Calculate COD Collections from orders
    orders.forEach(order => {
      if (isCodOrder(order)) {
        if (order.codCollectionStatus === 'Collected' || order.codCollectionStatus === 'Verified') {
          totalCodCollection += Number(order.codCollectedAmount) || Number(order.totalAmount) || 0;
        } else if (order.orderStatus === 'Delivered' && order.paymentStatus === 'Completed') {
          totalCodCollection += Number(order.totalAmount) || 0;
        }
      } else if (isOnlineOrder(order)) {
        if (order.paymentStatus === 'Completed' || order.paymentStatus === 'Paid' || order.onlinePaymentStatus === 'Verified') {
          totalOnlineCollection += Number(order.totalAmount) || 0;
        }
      }
    });

    // Payouts Settled
    const totalSettledAmount = payouts
      .filter(p => !p.status || p.status === 'Completed')
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    // Calculate Seller-level pending & outstanding
    let totalPendingPayments = 0;
    let totalOutstandingAmount = 0;

    sellers.forEach(seller => {
      const sellerIdStr = seller._id.toString();
      let sPayable = 0;

      deliveredOrders.forEach(order => {
        const bd = extractSellerOrderBreakdown(order, sellerIdStr, productSellerMap);
        if (bd.hasSellerItem) {
          sPayable += bd.sellerPayable;
        }
      });

      const sPaid = payouts
        .filter(p => p.sellerId?.toString() === sellerIdStr && (!p.status || p.status === 'Completed'))
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

      const sPending = Math.max(0, sPayable - sPaid);
      totalPendingPayments += sPending;
      totalOutstandingAmount += (sPayable - sPaid);
    });

    res.json({
      totalSellerSales: round2(totalSellerSales),
      totalCodSales: round2(totalCodSales),
      totalOnlineSales: round2(totalOnlineSales),
      totalSettledAmount: round2(totalSettledAmount),
      totalPendingPayments: round2(totalPendingPayments),
      totalOutstandingAmount: round2(totalOutstandingAmount),
      totalCodCollection: round2(totalCodCollection),
      totalOnlineCollection: round2(totalOnlineCollection),
      partnerMerchantsCount: sellers.length,
      deliveredOrdersCount: deliveredOrders.length,
      totalOrdersCount: orders.length
    });
  } catch (error) {
    console.error('Fetch payments dashboard stats error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 2. SELLER PAYMENT OVERVIEW TABLE
// ============================================================================
// @route   GET /api/payments/sellers
// @desc    Get all sellers with detailed payment breakdowns
router.get('/sellers', protect, async (req, res) => {
  try {
    const { sellers, orders, payouts, productSellerMap } = await loadPaymentContext(req);
    const deliveredOrders = orders.filter(o => o.orderStatus === 'Delivered');

    const sellerPaymentStats = sellers.map(seller => {
      const sellerIdStr = seller._id.toString();

      let totalSales = 0;
      let codSales = 0;
      let onlineSales = 0;
      let totalCommission = 0;
      let totalGst = 0;
      let sellerPayable = 0;
      let deliveredOrderCount = 0;
      let totalOrderCount = 0;
      let hasCod = false;
      let hasOnline = false;

      // Scan all orders for order count & payment methods
      orders.forEach(order => {
        let orderHasSeller = false;
        order.items?.forEach(item => {
          let itemSellerId = item.seller?.sellerId?.toString() || item.sellerId?.toString();
          if (!itemSellerId && item.productId) {
            itemSellerId = productSellerMap[item.productId.toString()];
          }
          if (itemSellerId === sellerIdStr) {
            orderHasSeller = true;
          }
        });

        if (orderHasSeller) {
          totalOrderCount++;
          if (isCodOrder(order)) hasCod = true;
          if (isOnlineOrder(order)) hasOnline = true;
        }
      });

      // Compute delivered sales & financials
      deliveredOrders.forEach(order => {
        const bd = extractSellerOrderBreakdown(order, sellerIdStr, productSellerMap);
        if (bd.hasSellerItem) {
          deliveredOrderCount++;
          totalSales += bd.sellerSales;
          totalCommission += bd.sellerCommission;
          totalGst += bd.sellerGst;
          sellerPayable += bd.sellerPayable;

          if (isCodOrder(order)) {
            codSales += bd.sellerSales;
          } else {
            onlineSales += bd.sellerSales;
          }
        }
      });

      const sellerPayouts = payouts.filter(p => p.sellerId?.toString() === sellerIdStr && (!p.status || p.status === 'Completed'));
      const settledAmount = round2(sellerPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
      const outstandingBalance = round2(sellerPayable - settledAmount);
      const pendingAmount = Math.max(0, outstandingBalance);

      // Method label
      let paymentMethod = 'None';
      if (hasCod && hasOnline) paymentMethod = 'Both';
      else if (hasCod) paymentMethod = 'COD';
      else if (hasOnline) paymentMethod = 'Online';

      // Status
      let paymentStatus = 'Pending';
      if (sellerPayable > 0 && settledAmount >= sellerPayable) {
        paymentStatus = 'Settled';
      } else if (settledAmount > 0) {
        paymentStatus = 'Partially Settled';
      } else if (sellerPayable === 0 && settledAmount === 0) {
        paymentStatus = 'Settled';
      }

      return {
        seller,
        totalSales: round2(totalSales),
        codSales: round2(codSales),
        onlineSales: round2(onlineSales),
        totalCommission: round2(totalCommission),
        totalGst: round2(totalGst),
        sellerPayable: round2(sellerPayable),
        settledAmount,
        totalPaid: settledAmount, // Backward compatibility
        pendingAmount,
        outstandingBalance,
        paymentMethod,
        paymentStatus,
        orderCount: deliveredOrderCount,
        deliveredOrderCount,
        totalOrderCount,
        payoutCount: sellerPayouts.length
      };
    });

    res.json(sellerPaymentStats);
  } catch (error) {
    console.error('Fetch seller payments error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 3. COD ORDER PAYMENT MANAGEMENT
// ============================================================================
// @route   GET /api/payments/cod-orders
// @desc    Get all COD orders with collection and settlement tracking
router.get('/cod-orders', protect, async (req, res) => {
  try {
    const { orders, productSellerMap } = await loadPaymentContext(req);
    const { search, sellerId, collectionStatus, settlementStatus } = req.query;

    let codOrders = orders.filter(o => isCodOrder(o));

    if (sellerId) {
      codOrders = codOrders.filter(o => 
        o.items?.some(it => {
          const sId = it.seller?.sellerId?.toString() || it.sellerId?.toString() || productSellerMap[it.productId?.toString()];
          return sId === sellerId.toString();
        })
      );
    }

    if (collectionStatus && collectionStatus !== 'All') {
      codOrders = codOrders.filter(o => (o.codCollectionStatus || 'Not Collected') === collectionStatus);
    }

    if (settlementStatus && settlementStatus !== 'All') {
      codOrders = codOrders.filter(o => (o.sellerSettlementStatus || 'Pending') === settlementStatus);
    }

    if (search && search.trim() !== '') {
      const q = search.trim().toLowerCase();
      codOrders = codOrders.filter(o => 
        (o._id?.toString() || '').toLowerCase().includes(q) ||
        (o.orderRef || '').toLowerCase().includes(q) ||
        (o.userId?.name || '').toLowerCase().includes(q) ||
        (o.userId?.phone || '').toLowerCase().includes(q) ||
        (o.shippingAddress?.name || '').toLowerCase().includes(q) ||
        (o.shippingAddress?.phone || '').toLowerCase().includes(q) ||
        (o.driverId?.name || '').toLowerCase().includes(q) ||
        (o.codReference || '').toLowerCase().includes(q)
      );
    }

    const formattedCodOrders = codOrders.map(order => {
      // Gather sellers involved in this order
      const sellerMap = new Map();
      order.items?.forEach(item => {
        const sId = item.seller?.sellerId?.toString() || item.sellerId?.toString() || productSellerMap[item.productId?.toString()];
        const sName = item.seller?.name || item.sellerName || 'Merchant Partner';
        if (sId) {
          if (!sellerMap.has(sId)) {
            sellerMap.set(sId, { sellerId: sId, sellerName: sName, itemsCount: 0, itemsSales: 0 });
          }
          const rec = sellerMap.get(sId);
          rec.itemsCount += (Number(item.quantity) || 1);
          rec.itemsSales += round2((Number(item.price) || 0) * (Number(item.quantity) || 1));
        }
      });

      const sellers = Array.from(sellerMap.values());
      const sellerNames = sellers.map(s => s.sellerName).join(', ') || 'Merchant Partner';

      return {
        _id: order._id,
        orderRef: order.orderRef || order.invoiceNumber || order._id.toString().slice(-8).toUpperCase(),
        customerName: order.userId?.name || order.shippingAddress?.name || 'Customer',
        customerPhone: order.userId?.phone || order.shippingAddress?.phone || '',
        sellerNames,
        sellers,
        orderAmount: round2(order.totalAmount || 0),
        orderStatus: order.orderStatus,
        paymentMethod: order.paymentMethod || 'COD',
        paymentStatus: order.paymentStatus || 'Pending',
        driverName: order.driverId?.name || 'Unassigned',
        driverPhone: order.driverId?.phone || '',
        deliveryDate: order.deliveredAt || order.updatedAt,
        createdAt: order.createdAt,
        codCollectionStatus: order.codCollectionStatus || (order.orderStatus === 'Delivered' && order.paymentStatus === 'Completed' ? 'Collected' : 'Not Collected'),
        codCollectedAmount: Number(order.codCollectedAmount) || (order.codCollectionStatus === 'Collected' || order.codCollectionStatus === 'Verified' ? Number(order.totalAmount) : 0),
        codCollectedAt: order.codCollectedAt,
        codCollectedBy: order.codCollectedBy,
        codVerifiedAt: order.codVerifiedAt,
        codVerifiedBy: order.codVerifiedBy,
        codReference: order.codReference || '',
        codRemarks: order.codRemarks || '',
        sellerSettlementStatus: order.sellerSettlementStatus || 'Pending',
        sellerSettledAmount: Number(order.sellerSettledAmount) || 0,
        sellerSettledAt: order.sellerSettledAt,
        sellerSettlementRemarks: order.sellerSettlementRemarks || ''
      };
    });

    res.json(formattedCodOrders);
  } catch (error) {
    console.error('Fetch COD orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/payments/cod-orders/:orderId/status
// @desc    Admin updates COD order collection status, reference, or settlement status
router.put('/cod-orders/:orderId/status', protect, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { 
      action, 
      codCollectionStatus, 
      sellerSettlementStatus, 
      codCollectedAmount, 
      codReference, 
      remarks 
    } = req.body;

    const OrderModel = getModel('Order', req);
    const PaymentAuditLogModel = getModel('PaymentAuditLog', req);

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const prevCollectionStatus = order.codCollectionStatus || 'Not Collected';
    const prevSettlementStatus = order.sellerSettlementStatus || 'Pending';
    let auditAction = 'STATUS_UPDATED';
    let updatedStatus = '';

    const adminInfo = {
      id: req.user?._id || req.admin?._id,
      name: req.user?.name || req.admin?.name || 'Admin'
    };

    if (action === 'MARK_COLLECTED') {
      order.codCollectionStatus = 'Collected';
      order.codCollectedAmount = Number(codCollectedAmount) || Number(order.totalAmount) || 0;
      order.codCollectedAt = new Date();
      order.codCollectedBy = { id: adminInfo.id, name: adminInfo.name, role: 'Admin' };
      order.paymentStatus = 'Completed';
      auditAction = 'COD_COLLECTED';
      updatedStatus = 'Collected';
    } else if (action === 'MARK_NOT_COLLECTED') {
      order.codCollectionStatus = 'Not Collected';
      order.codCollectedAmount = 0;
      order.codCollectedAt = null;
      order.codVerifiedAt = null;
      order.paymentStatus = 'Pending';
      auditAction = 'COD_NOT_COLLECTED';
      updatedStatus = 'Not Collected';
    } else if (action === 'VERIFY_COLLECTION') {
      order.codCollectionStatus = 'Verified';
      order.codVerifiedAt = new Date();
      order.codVerifiedBy = adminInfo;
      if (!order.codCollectedAmount || order.codCollectedAmount <= 0) {
        order.codCollectedAmount = Number(order.totalAmount) || 0;
      }
      order.paymentStatus = 'Completed';
      auditAction = 'COD_VERIFIED';
      updatedStatus = 'Verified';
    } else if (action === 'APPROVE_SETTLEMENT') {
      order.sellerSettlementStatus = 'Approved';
      auditAction = 'COD_SETTLEMENT_APPROVED';
      updatedStatus = 'Approved';
    } else if (action === 'REJECT_SETTLEMENT') {
      order.sellerSettlementStatus = 'Rejected';
      auditAction = 'COD_SETTLEMENT_REJECTED';
      updatedStatus = 'Rejected';
    } else {
      if (codCollectionStatus) {
        order.codCollectionStatus = codCollectionStatus;
        updatedStatus = codCollectionStatus;
      }
      if (sellerSettlementStatus) {
        order.sellerSettlementStatus = sellerSettlementStatus;
        updatedStatus = sellerSettlementStatus;
      }
    }

    if (codReference !== undefined) order.codReference = codReference;
    if (remarks !== undefined) order.codRemarks = remarks;

    await order.save();

    // Determine primary seller from first item
    const primarySellerId = order.items?.[0]?.seller?.sellerId || order.items?.[0]?.sellerId;
    const primarySellerName = order.items?.[0]?.seller?.name || order.items?.[0]?.sellerName || 'Merchant Partner';

    // Record in PaymentAuditLog
    if (PaymentAuditLogModel) {
      await PaymentAuditLogModel.create({
        orderId: order._id,
        sellerId: primarySellerId,
        sellerName: primarySellerName,
        action: auditAction,
        previousStatus: prevCollectionStatus,
        updatedStatus: updatedStatus || order.codCollectionStatus,
        amount: order.codCollectedAmount || order.totalAmount,
        paymentMethod: order.paymentMethod || 'COD',
        transactionReference: order.codReference,
        adminId: adminInfo.id,
        adminName: adminInfo.name,
        remarks: remarks || order.codRemarks || ''
      });
    }

    res.json({
      message: 'COD order status updated successfully',
      order
    });
  } catch (error) {
    console.error('Update COD order status error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 4. ONLINE ORDER PAYMENT MANAGEMENT
// ============================================================================
// @route   GET /api/payments/online-orders
// @desc    Get all online payment orders with verification and settlement status
router.get('/online-orders', protect, async (req, res) => {
  try {
    const { orders, productSellerMap } = await loadPaymentContext(req);
    const { search, sellerId, verificationStatus, settlementStatus } = req.query;

    let onlineOrders = orders.filter(o => isOnlineOrder(o));

    if (sellerId) {
      onlineOrders = onlineOrders.filter(o => 
        o.items?.some(it => {
          const sId = it.seller?.sellerId?.toString() || it.sellerId?.toString() || productSellerMap[it.productId?.toString()];
          return sId === sellerId.toString();
        })
      );
    }

    if (verificationStatus && verificationStatus !== 'All') {
      onlineOrders = onlineOrders.filter(o => (o.onlinePaymentStatus || (o.paymentStatus === 'Completed' ? 'Verified' : 'Pending')) === verificationStatus);
    }

    if (settlementStatus && settlementStatus !== 'All') {
      onlineOrders = onlineOrders.filter(o => (o.sellerSettlementStatus || 'Pending') === settlementStatus);
    }

    if (search && search.trim() !== '') {
      const q = search.trim().toLowerCase();
      onlineOrders = onlineOrders.filter(o => 
        (o._id?.toString() || '').toLowerCase().includes(q) ||
        (o.orderRef || '').toLowerCase().includes(q) ||
        (o.userId?.name || '').toLowerCase().includes(q) ||
        (o.userId?.phone || '').toLowerCase().includes(q) ||
        (o.onlineTransactionId || '').toLowerCase().includes(q) ||
        (o.onlinePaymentGateway || '').toLowerCase().includes(q)
      );
    }

    const formattedOnlineOrders = onlineOrders.map(order => {
      const sellerMap = new Map();
      order.items?.forEach(item => {
        const sId = item.seller?.sellerId?.toString() || item.sellerId?.toString() || productSellerMap[item.productId?.toString()];
        const sName = item.seller?.name || item.sellerName || 'Merchant Partner';
        if (sId) {
          if (!sellerMap.has(sId)) {
            sellerMap.set(sId, { sellerId: sId, sellerName: sName, itemsCount: 0, itemsSales: 0 });
          }
          const rec = sellerMap.get(sId);
          rec.itemsCount += (Number(item.quantity) || 1);
          rec.itemsSales += round2((Number(item.price) || 0) * (Number(item.quantity) || 1));
        }
      });

      const sellers = Array.from(sellerMap.values());
      const sellerNames = sellers.map(s => s.sellerName).join(', ') || 'Merchant Partner';

      const gateway = order.onlinePaymentGateway || 
        (String(order.paymentMethod).toLowerCase().includes('razorpay') ? 'Razorpay' : 
        String(order.paymentMethod).toLowerCase().includes('phonepe') ? 'PhonePe' : 
        String(order.paymentMethod).toLowerCase().includes('cashfree') ? 'Cashfree' : 'Direct Payment Gateway');

      const verificationStatus = order.onlinePaymentStatus || 
        (order.paymentStatus === 'Completed' ? 'Verified' : 
        order.paymentStatus === 'Failed' ? 'Failed' : 
        order.paymentStatus === 'Refunded' ? 'Refunded' : 'Pending');

      return {
        _id: order._id,
        orderRef: order.orderRef || order.invoiceNumber || order._id.toString().slice(-8).toUpperCase(),
        customerName: order.userId?.name || order.shippingAddress?.name || 'Customer',
        customerPhone: order.userId?.phone || order.shippingAddress?.phone || '',
        sellerNames,
        sellers,
        onlinePaymentAmount: round2(order.totalAmount || 0),
        paymentGateway: gateway,
        transactionId: order.onlineTransactionId || order.pickupCode || order._id.toString(),
        paymentDate: order.paidAt || order.createdAt,
        orderStatus: order.orderStatus,
        paymentVerificationStatus: verificationStatus,
        onlineVerifiedAt: order.onlineVerifiedAt,
        onlineVerifiedBy: order.onlineVerifiedBy,
        sellerSettlementStatus: order.sellerSettlementStatus || 'Pending',
        sellerSettledAmount: Number(order.sellerSettledAmount) || 0,
        sellerSettledAt: order.sellerSettledAt,
        remarks: order.onlineRemarks || '',
        paymentScreenshot: order.paymentScreenshot || null
      };
    });

    res.json(formattedOnlineOrders);
  } catch (error) {
    console.error('Fetch online orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/payments/online-orders/:orderId/status
// @desc    Admin updates Online order verification and settlement status
router.put('/online-orders/:orderId/status', protect, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { 
      action, 
      onlinePaymentStatus, 
      sellerSettlementStatus, 
      transactionId, 
      remarks 
    } = req.body;

    const OrderModel = getModel('Order', req);
    const PaymentAuditLogModel = getModel('PaymentAuditLog', req);

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const prevVerificationStatus = order.onlinePaymentStatus || (order.paymentStatus === 'Completed' ? 'Verified' : 'Pending');
    const prevSettlementStatus = order.sellerSettlementStatus || 'Pending';
    let auditAction = 'STATUS_UPDATED';
    let updatedStatus = '';

    const adminInfo = {
      id: req.user?._id || req.admin?._id,
      name: req.user?.name || req.admin?.name || 'Admin'
    };

    if (action === 'VERIFY_PAYMENT') {
      order.onlinePaymentStatus = 'Verified';
      order.paymentStatus = 'Completed';
      order.onlineVerifiedAt = new Date();
      order.onlineVerifiedBy = adminInfo;
      auditAction = 'ONLINE_VERIFIED';
      updatedStatus = 'Verified';
    } else if (action === 'APPROVE_SETTLEMENT') {
      order.sellerSettlementStatus = 'Approved';
      auditAction = 'ONLINE_SETTLEMENT_APPROVED';
      updatedStatus = 'Approved';
    } else if (action === 'REJECT_SETTLEMENT') {
      order.sellerSettlementStatus = 'Rejected';
      auditAction = 'ONLINE_SETTLEMENT_REJECTED';
      updatedStatus = 'Rejected';
    } else {
      if (onlinePaymentStatus) {
        order.onlinePaymentStatus = onlinePaymentStatus;
        updatedStatus = onlinePaymentStatus;
      }
      if (sellerSettlementStatus) {
        order.sellerSettlementStatus = sellerSettlementStatus;
        updatedStatus = sellerSettlementStatus;
      }
    }

    if (transactionId) order.onlineTransactionId = transactionId;
    if (remarks !== undefined) order.onlineRemarks = remarks;

    await order.save();

    const primarySellerId = order.items?.[0]?.seller?.sellerId || order.items?.[0]?.sellerId;
    const primarySellerName = order.items?.[0]?.seller?.name || order.items?.[0]?.sellerName || 'Merchant Partner';

    if (PaymentAuditLogModel) {
      await PaymentAuditLogModel.create({
        orderId: order._id,
        sellerId: primarySellerId,
        sellerName: primarySellerName,
        action: auditAction,
        previousStatus: prevVerificationStatus,
        updatedStatus: updatedStatus || order.onlinePaymentStatus,
        amount: order.totalAmount,
        paymentMethod: order.paymentMethod || 'Online',
        transactionReference: order.onlineTransactionId,
        adminId: adminInfo.id,
        adminName: adminInfo.name,
        remarks: remarks || order.onlineRemarks || ''
      });
    }

    res.json({
      message: 'Online order payment status updated successfully',
      order
    });
  } catch (error) {
    console.error('Update online order status error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 5. MANUAL SELLER PAYMENT SETTLEMENT
// ============================================================================
// @route   POST /api/payments/settle
// @desc    Manually settle seller payment with full validation, proof & audit trail
router.post('/settle', protect, async (req, res) => {
  const { 
    sellerId, 
    amount, 
    paymentMethod, 
    transactionId, 
    utrReference, 
    remarks, 
    proofUrl, 
    paymentDate 
  } = req.body;

  if (!sellerId || !amount) {
    return res.status(400).json({ message: 'Seller ID and settlement amount are required' });
  }

  const numericAmount = round2(parseFloat(amount));
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ message: 'Settlement amount must be greater than zero' });
  }

  try {
    const SellerModel = getModel('Seller', req);
    const OrderModel = getModel('Order', req);
    const SellerPaymentModel = getModel('SellerPayment', req);
    const PaymentAuditLogModel = getModel('PaymentAuditLog', req);
    const ProductModel = getModel('Product', req);

    const seller = await SellerModel.findById(sellerId);
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    // Map products to sellerId
    const products = await ProductModel.find().select('_id sellerId').lean();
    const productSellerMap = {};
    products.forEach(p => {
      if (p.sellerId) productSellerMap[p._id.toString()] = p.sellerId.toString();
    });

    // Compute backend payable from delivered orders
    const sellerIdStr = seller._id.toString();
    const deliveredOrders = await OrderModel.find({ orderStatus: 'Delivered' }).lean();

    let totalSellerPayable = 0;
    deliveredOrders.forEach(order => {
      const bd = extractSellerOrderBreakdown(order, sellerIdStr, productSellerMap);
      if (bd.hasSellerItem) {
        totalSellerPayable += bd.sellerPayable;
      }
    });
    totalSellerPayable = round2(totalSellerPayable);

    // Compute previously settled amount
    const previousPayouts = await SellerPaymentModel.find({ 
      sellerId, 
      status: { $ne: 'Reversed' } 
    }).lean();

    const previouslySettled = round2(previousPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
    const currentOutstanding = round2(totalSellerPayable - previouslySettled);

    // Prevent duplicate settlement (submitted within 30s with identical amount and transaction reference)
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    const recentDuplicate = await SellerPaymentModel.findOne({
      sellerId,
      amount: numericAmount,
      transactionId: transactionId || utrReference || '',
      createdAt: { $gte: thirtySecondsAgo }
    });

    if (recentDuplicate) {
      return res.status(409).json({ 
        message: 'Duplicate settlement detected. A payout with this exact amount and reference was just submitted.' 
      });
    }

    const remainingOutstanding = round2(currentOutstanding - numericAmount);
    const settlementType = numericAmount >= currentOutstanding ? 'Full Settlement' : 'Partial Settlement';

    // Compute sequential receipt number
    const lastPayment = await SellerPaymentModel.findOne({ 
      receiptSequence: { $exists: true, $ne: null } 
    }).sort({ receiptSequence: -1 }).lean();
    const countAll = await SellerPaymentModel.countDocuments();
    const nextSeq = (lastPayment?.receiptSequence && lastPayment.receiptSequence >= countAll)
      ? (lastPayment.receiptSequence + 1)
      : (countAll + 1);
    const receiptNumber = 'ZUDO-PAY-' + String(nextSeq).padStart(4, '0');

    const adminInfo = {
      id: req.user?._id || req.admin?._id,
      name: req.user?.name || req.admin?.name || 'Super Admin'
    };

    const newPayout = new SellerPaymentModel({
      sellerId,
      receiptNumber,
      receiptSequence: nextSeq,
      totalPayableAtSettlement: totalSellerPayable,
      previouslySettledAtSettlement: previouslySettled,
      amount: numericAmount,
      paymentMethod: paymentMethod || 'Bank Transfer',
      transactionId: transactionId || utrReference || '',
      utrReference: utrReference || transactionId || '',
      proofUrl: proofUrl || null,
      adminId: adminInfo.id,
      adminName: adminInfo.name,
      previousOutstanding: currentOutstanding,
      remainingOutstanding,
      settlementType,
      status: 'Completed',
      remarks: remarks || '',
      date: paymentDate ? new Date(paymentDate) : new Date()
    });

    const savedPayout = await newPayout.save();

    // Settle specific orders if passed from UI
    const { orderIds, generateSeparateInvoices } = req.body;
    let settledInvoicesCount = 0;
    if (Array.isArray(orderIds) && orderIds.length > 0) {
      await OrderModel.updateMany(
        { _id: { $in: orderIds } },
        { $set: { sellerSettlementStatus: 'Settled', sellerSettledAt: new Date(), paymentId: savedPayout._id } }
      );

      // Optionally auto-generate separate invoices for each settled order
      if (generateSeparateInvoices) {
        const InvoiceModel = getModel('SellerInvoice', req) || require('../models/SellerInvoice');
        if (InvoiceModel) {
          const ordersToInvoice = await OrderModel.find({ _id: { $in: orderIds } });
          for (const ord of ordersToInvoice) {
            const exists = await InvoiceModel.findOne({
              sellerId,
              $or: [{ orders: ord._id }, { orderId: ord._id }],
              status: { $nin: ['Cancelled', 'Rejected'] }
            });
            if (!exists) {
              const bd = extractSellerOrderBreakdown(ord, sellerIdStr, productSellerMap);
              const humanOrderId = ord.orderNumber ? String(ord.orderNumber).padStart(5, '0') : (ord.orderId || ord._id.toString().slice(-6).toUpperCase());
              await InvoiceModel.create({
                sellerId,
                invoiceNumber: humanOrderId,
                invoiceSequenceNumber: ord.orderNumber || 1,
                startDate: ord.createdAt,
                endDate: ord.deliveredAt || ord.createdAt,
                totalAmount: round2(bd.sellerSales),
                totalCommission: round2(bd.sellerCommission),
                netAmount: round2(bd.sellerPayable),
                orderCount: 1,
                orders: [ord._id],
                orderId: ord._id,
                orderNumber: ord.orderNumber || null,
                orderRef: ord.orderRef || null,
                status: 'Cleared',
                hasInvoiceImage: false,
                imageIds: [],
                generatedBy: adminInfo.id
              });
              settledInvoicesCount++;
            }
          }
        }
      }
    }

    // Record audit log
    if (PaymentAuditLogModel) {
      await PaymentAuditLogModel.create({
        sellerId: seller._id,
        sellerName: seller.name || seller.businessName || 'Seller',
        paymentId: savedPayout._id,
        action: 'MANUAL_SETTLEMENT',
        previousStatus: currentOutstanding <= 0 ? 'Settled' : 'Pending',
        updatedStatus: remainingOutstanding <= 0 ? 'Settled' : 'Partially Settled',
        amount: numericAmount,
        paymentMethod: paymentMethod || 'Bank Transfer',
        transactionReference: utrReference || transactionId || '',
        proofUrl: proofUrl || null,
        adminId: adminInfo.id,
        adminName: adminInfo.name,
        remarks: remarks || `Settled ₹${numericAmount.toLocaleString('en-IN')}. Remaining: ₹${remainingOutstanding.toLocaleString('en-IN')}`
      });
    }

    res.status(201).json({
      message: `Successfully settled ₹${numericAmount.toLocaleString('en-IN')} for ${seller.name}!`,
      payout: savedPayout,
      totalSellerPayable,
      previouslySettled: previouslySettled + numericAmount,
      remainingOutstanding,
      paymentStatus: remainingOutstanding <= 0 ? 'Settled' : 'Partially Settled'
    });
  } catch (error) {
    console.error('Create settlement error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Backward compatibility alias for clear
router.post('/clear', protect, async (req, res) => {
  req.url = '/settle';
  return router.handle(req, res);
});

// @route   GET /api/payments/receipt/:paymentId/download
// @desc    Download official payment receipt PDF for a settlement
router.get('/receipt/:paymentId/download', protect, async (req, res) => {
  try {
    const SellerPaymentModel = getModel('SellerPayment', req) || require('../models/SellerPayment');
    const SellerModel = getModel('Seller', req) || require('../models/Seller');
    const payment = await SellerPaymentModel.findById(req.params.paymentId).lean();
    if (!payment) {
      return res.status(404).json({ message: 'Payment settlement record not found' });
    }
    const seller = await SellerModel.findById(payment.sellerId).lean();

    const receiptNum = payment.receiptNumber || (payment.receiptSequence 
      ? `ZUDO-PAY-${String(payment.receiptSequence).padStart(4, '0')}` 
      : `ZUDO-PAY-${payment._id.toString().slice(-4).toUpperCase()}`);

    const pdfBuffer = await generatePaymentReceiptPDF({
      payment: { ...payment, receiptNumber: receiptNum },
      seller
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Payment_Receipt_${receiptNum}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download payment receipt error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/payments/sellers/:sellerId/receipts/download-all
// @desc    Download latest or combined payment receipts for a seller
router.get('/sellers/:sellerId/receipts/download-all', protect, async (req, res) => {
  try {
    const SellerPaymentModel = getModel('SellerPayment', req) || require('../models/SellerPayment');
    const SellerModel = getModel('Seller', req) || require('../models/Seller');
    const seller = await SellerModel.findById(req.params.sellerId).lean();
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    const payments = await SellerPaymentModel.find({ 
      sellerId: req.params.sellerId,
      status: { $ne: 'Reversed' }
    }).sort({ createdAt: -1 }).lean();

    if (!payments.length) {
      return res.status(400).json({ message: 'No payment settlement records found for this seller' });
    }

    const latest = payments[0];
    const receiptNum = latest.receiptNumber || (latest.receiptSequence 
      ? `ZUDO-PAY-${String(latest.receiptSequence).padStart(4, '0')}` 
      : `ZUDO-PAY-${latest._id.toString().slice(-4).toUpperCase()}`);

    const pdfBuffer = await generatePaymentReceiptPDF({
      payment: { ...latest, receiptNumber: receiptNum },
      seller
    });

    const safeName = (seller.name || seller.businessName || 'Seller').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Settlement_Receipt_${safeName}_${receiptNum}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Download all seller receipts error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 6. SELLER-WISE DETAILED PAYMENT LEDGER & HISTORY
// ============================================================================
// @route   GET /api/payments/sellers/:sellerId/details
// @desc    Get detailed seller profile, orders breakdown ledger, and payouts
router.get('/sellers/:sellerId/details', protect, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { sellers, orders, payouts, auditLogs, productSellerMap } = await loadPaymentContext(req);

    const seller = sellers.find(s => s._id.toString() === sellerId.toString());
    if (!seller) {
      return res.status(404).json({ message: 'Seller not found' });
    }

    const sellerIdStr = seller._id.toString();

    let totalOrders = 0;
    let deliveredOrdersCount = 0;
    let codOrdersCount = 0;
    let onlineOrdersCount = 0;
    let totalSales = 0;
    let codSales = 0;
    let onlineSales = 0;
    let totalCommission = 0;
    let totalGst = 0;
    let totalSellerPayable = 0;

    const sellerOrderLedger = [];

    orders.forEach(order => {
      const bd = extractSellerOrderBreakdown(order, sellerIdStr, productSellerMap);
      if (bd.hasSellerItem) {
        totalOrders++;
        const isCod = isCodOrder(order);
        if (isCod) codOrdersCount++;
        else onlineOrdersCount++;

        if (order.orderStatus === 'Delivered') {
          deliveredOrdersCount++;
          totalSales += bd.sellerSales;
          totalCommission += bd.sellerCommission;
          totalGst += bd.sellerGst;
          totalSellerPayable += bd.sellerPayable;

          if (isCod) codSales += bd.sellerSales;
          else onlineSales += bd.sellerSales;
        }

        sellerOrderLedger.push({
          orderId: order._id,
          orderRef: order.orderRef || order.invoiceNumber || order._id.toString().slice(-8).toUpperCase(),
          customerName: order.userId?.name || order.shippingAddress?.name || 'Customer',
          customerPhone: order.userId?.phone || order.shippingAddress?.phone || '',
          orderDate: order.createdAt,
          deliveredAt: order.deliveredAt,
          orderStatus: order.orderStatus,
          paymentMethod: isCod ? 'COD' : 'Online',
          paymentChannel: order.paymentMethod,
          codCollectionStatus: isCod ? (order.codCollectionStatus || 'Not Collected') : null,
          onlinePaymentStatus: !isCod ? (order.onlinePaymentStatus || (order.paymentStatus === 'Completed' ? 'Verified' : 'Pending')) : null,
          sellerSettlementStatus: order.sellerSettlementStatus || 'Pending',
          items: bd.sellerItems,
          itemsCount: bd.sellerItems.reduce((acc, it) => acc + it.quantity, 0),
          sellerGrossSales: bd.sellerSales,
          sellerCommission: bd.sellerCommission,
          sellerGst: bd.sellerGst,
          sellerPayable: bd.sellerPayable
        });
      }
    });

    // Payouts
    const sellerPayouts = payouts.filter(p => p.sellerId?.toString() === sellerIdStr);
    const settledAmount = round2(sellerPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
    const outstandingBalance = round2(totalSellerPayable - settledAmount);
    const pendingAmount = Math.max(0, outstandingBalance);

    // Audit logs for this seller
    const sellerAuditLogs = auditLogs.filter(a => a.sellerId?.toString() === sellerIdStr);

    let paymentStatus = 'Pending';
    if (totalSellerPayable > 0 && settledAmount >= totalSellerPayable) {
      paymentStatus = 'Settled';
    } else if (settledAmount > 0) {
      paymentStatus = 'Partially Settled';
    } else if (totalSellerPayable === 0 && settledAmount === 0) {
      paymentStatus = 'Settled';
    }

    res.json({
      seller,
      summary: {
        totalOrders,
        deliveredOrdersCount,
        codOrdersCount,
        onlineOrdersCount,
        totalSales: round2(totalSales),
        codSales: round2(codSales),
        onlineSales: round2(onlineSales),
        totalCommission: round2(totalCommission),
        totalGst: round2(totalGst),
        totalSellerPayable: round2(totalSellerPayable),
        settledAmount,
        totalPaid: settledAmount,
        pendingAmount,
        outstandingBalance,
        paymentStatus,
        payoutCount: sellerPayouts.length
      },
      orders: sellerOrderLedger.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate)),
      payouts: sellerPayouts,
      auditLogs: sellerAuditLogs
    });
  } catch (error) {
    console.error('Fetch seller payment details error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Backward compatibility alias for history
router.get('/sellers/:sellerId/history', protect, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { orders, payouts, productSellerMap } = await loadPaymentContext(req);

    const sellerPayouts = payouts.filter(p => p.sellerId?.toString() === sellerId.toString());
    const sales = [];

    orders.filter(o => o.orderStatus === 'Delivered').forEach(order => {
      const bd = extractSellerOrderBreakdown(order, sellerId.toString(), productSellerMap);
      if (bd.hasSellerItem) {
        bd.sellerItems.forEach(it => {
          sales.push({
            orderId: order._id,
            customerName: order.userId?.name || order.shippingAddress?.name || 'Customer',
            productName: it.name,
            quantity: it.quantity,
            price: it.price,
            total: it.grossAmount,
            date: order.createdAt
          });
        });
      }
    });

    res.json({
      payouts: sellerPayouts,
      sales
    });
  } catch (error) {
    console.error('Fetch seller history error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================================
// 7. PAYMENT AUDIT LOGS
// ============================================================================
// @route   GET /api/payments/audit-logs
// @desc    Get complete payment history and audit trail
router.get('/audit-logs', protect, async (req, res) => {
  try {
    const { auditLogs } = await loadPaymentContext(req);
    const { sellerId, action, search } = req.query;

    let filtered = auditLogs;
    if (sellerId) {
      filtered = filtered.filter(a => a.sellerId?.toString() === sellerId.toString());
    }
    if (action && action !== 'All') {
      filtered = filtered.filter(a => a.action === action);
    }
    if (search && search.trim() !== '') {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(a => 
        (a.sellerName || '').toLowerCase().includes(q) ||
        (a.adminName || '').toLowerCase().includes(q) ||
        (a.transactionReference || '').toLowerCase().includes(q) ||
        (a.remarks || '').toLowerCase().includes(q) ||
        (a.orderId?.toString() || '').toLowerCase().includes(q)
      );
    }

    res.json(filtered);
  } catch (error) {
    console.error('Fetch payment audit logs error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
