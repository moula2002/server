const express = require('express');
const { protect } = require('../middleware/auth');
const router = express.Router();

const getModel = (req, name, modelPath) => {
  if (req.models?.[name]) return req.models[name];
  if (req.db?.models?.[name]) return req.db.models[name];
  const Model = require(modelPath);
  return req.db?.model ? req.db.model(name, Model.schema) : Model;
};

const validDateRange = (value, endOfDay = false) => {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
};

const safeNumber = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};

const isInRange = (value, startDate, endDate) => {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) &&
    (!startDate || date >= startDate) &&
    (!endDate || date <= endDate);
};

const getOrderReference = (order) => {
  if (order.orderNumber !== undefined && order.orderNumber !== null) {
    return `#${String(order.orderNumber).padStart(5, '0')}`;
  }
  return order.orderRef || `#${order._id.toString().slice(-6).toUpperCase()}`;
};

const getOrderCustomer = (order) => ({
  name: order.shippingAddress?.name?.trim() || order.userId?.name?.trim() || '',
  phone: order.shippingAddress?.phone?.trim() || order.userId?.phone?.trim() || '',
  address: order.shippingAddress?.address || '',
  city: order.shippingAddress?.city || '',
  state: order.shippingAddress?.state || '',
  pincode: order.shippingAddress?.pincode || ''
});

const getItemAmount = (item) => {
  const savedAmount = safeNumber(item.finalCustomerAmount ?? item.finalCustomerPrice);
  if (savedAmount > 0) return savedAmount;
  return safeNumber(item.price ?? item.unitCustomerPrice) * safeNumber(item.quantity);
};

const toItemDetail = (item) => ({
  name: item.name || item.product?.name || '',
  quantity: safeNumber(item.quantity),
  unit: item.variantSize || item.packagingType || item.unit || item.sellingUnit || '',
  measurement: item.productUnitSize && item.productUnitSize !== 1
    ? `${item.productUnitSize} ${item.measurementBasis || item.measurementUnit || ''}`.trim()
    : '',
  unitPrice: safeNumber(item.price ?? item.unitCustomerPrice),
  amount: getItemAmount(item),
  taxAmount: safeNumber(item.gstAmount || item.totalGst)
});

const formatOrderDescription = (items) => {
  const names = items.slice(0, 3).map(item => {
    const name = item.name || 'Product';
    return `${name} x${safeNumber(item.quantity)}`;
  });
  return `${items.length} item${items.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}`;
};

const createActivity = ({
  id,
  activityType,
  activity,
  occurredAt,
  referenceId = '',
  customer = {},
  description = '',
  amount = null,
  status = '',
  source,
  recordId,
  orderId = '',
  details = {}
}) => ({
  id,
  activityType,
  activity,
  occurredAt,
  referenceId: referenceId || '',
  customer: {
    name: customer.name || '',
    phone: customer.phone || ''
  },
  description: description || '',
  amount: amount === null ? null : safeNumber(amount),
  status: status || '',
  source,
  recordId: recordId?.toString() || '',
  orderId: orderId?.toString() || '',
  details
});

const loadSellerHistory = async (req, { startDate, endDate }) => {
  const sellerId = req.user._id;
  const ProductModel = getModel(req, 'Product', '../models/Product');
  const OrderModel = getModel(req, 'Order', '../models/Order');
  const InvoiceModel = getModel(req, 'SellerInvoice', '../models/SellerInvoice');
  const PaymentModel = getModel(req, 'SellerPayment', '../models/SellerPayment');
  const PaymentAuditModel = getModel(req, 'PaymentAuditLog', '../models/PaymentAuditLog');
  const HistoryEventModel = getModel(req, 'SellerHistoryEvent', '../models/SellerHistoryEvent');

  const products = await ProductModel.find({
    $or: [{ sellerId }, { sellerId: sellerId.toString() }, { seller: sellerId }]
  }).select('_id').lean();
  const productIds = products.map(product => product._id);
  const productIdSet = new Set(productIds.map(id => id.toString()));

  const orderSellerClauses = [{ 'items.seller.sellerId': sellerId }];
  if (productIds.length) orderSellerClauses.push({ 'items.productId': { $in: productIds } });

  const orderQuery = { $or: orderSellerClauses };
  const dateRange = {};
  if (startDate) dateRange.$gte = startDate;
  if (endDate) dateRange.$lte = endDate;
  if (startDate || endDate) {
    orderQuery.$and = [{
      $or: [
        { createdAt: dateRange },
        { updatedAt: dateRange },
        { paidAt: dateRange },
        { deliveredAt: dateRange },
        { cancelledAt: dateRange },
        { returnRequestedAt: dateRange },
        { returnApprovedAt: dateRange },
        { returnRejectedAt: dateRange }
      ]
    }];
  }

  let [orders, invoices, payments, paymentAudits, historyEvents] = await Promise.all([
    OrderModel.find(orderQuery)
      .select('_id orderNumber orderRef invoiceNumber userId shippingAddress items totalAmount totalGstAmount paymentStatus paymentMethod paidAt orderStatus createdAt updatedAt deliveredAt cancelledAt cancellationReason returnStatus returnReason returnRequestedAt returnApprovedAt returnRejectedAt sellerPickups pickupCode driverId sellerSettlementStatus sellerSettledAt deliverySlot')
      .populate('userId', 'name phone')
      .populate('driverId', 'name phone')
      .sort({ createdAt: -1 })
      .lean(),
    InvoiceModel.find({
      sellerId,
      ...(startDate || endDate ? { createdAt: dateRange } : {})
    })
      .select('-invoiceImage.data')
      .sort({ createdAt: -1 })
      .lean(),
    PaymentModel.find({
      sellerId,
      ...(startDate || endDate ? { $or: [{ date: dateRange }, { createdAt: dateRange }] } : {})
    }).sort({ date: -1, createdAt: -1 }).lean(),
    PaymentAuditModel.find({
      sellerId,
      ...(startDate || endDate ? { $or: [{ date: dateRange }, { createdAt: dateRange }] } : {})
    }).sort({ date: -1, createdAt: -1 }).lean(),
    HistoryEventModel.find({
      sellerId,
      ...(startDate || endDate ? { occurredAt: dateRange } : {})
    }).sort({ occurredAt: -1 }).lean()
  ]);

  const linkedOrderIds = [...new Set([
    ...invoices.flatMap(invoice => [invoice.orderId, ...(invoice.orders || [])]
      .filter(Boolean)
      .map(orderId => orderId.toString())),
    ...paymentAudits.map(audit => audit.orderId?.toString()),
    ...historyEvents.map(event => event.orderId?.toString())
  ].filter(Boolean))].filter(id => !orders.some(order => order._id.toString() === id));
  if (linkedOrderIds.length) {
    const relatedOrders = await OrderModel.find({
      _id: { $in: linkedOrderIds },
      $or: orderSellerClauses
    })
      .select('_id orderNumber orderRef invoiceNumber userId shippingAddress items totalAmount totalGstAmount paymentStatus paymentMethod paidAt orderStatus createdAt updatedAt deliveredAt cancelledAt cancellationReason returnStatus returnReason returnRequestedAt returnApprovedAt returnRejectedAt sellerPickups pickupCode driverId sellerSettlementStatus sellerSettledAt deliverySlot')
      .populate('userId', 'name phone')
      .populate('driverId', 'name phone')
      .lean();
    orders = [...orders, ...relatedOrders];
  }

  const sellerOrders = orders.map(order => {
    const items = (order.items || []).filter(item =>
      (item.seller?.sellerId && item.seller.sellerId.toString() === sellerId.toString()) ||
      (item.productId && productIdSet.has(item.productId.toString()))
    );
    if (!items.length) return null;
    return { ...order, sellerItems: items, customer: getOrderCustomer(order) };
  }).filter(Boolean);

  const ordersById = new Map(sellerOrders.map(order => [order._id.toString(), order]));
  const rows = [];
  const hasHistoryEvent = (orderId, activityType, activity) => historyEvents.some(event =>
    event.orderId?.toString() === orderId &&
    event.activityType === activityType &&
    event.activity === activity
  );
  const add = (activity) => {
    if (isInRange(activity.occurredAt, startDate, endDate)) rows.push(activity);
  };

  for (const order of sellerOrders) {
    const orderId = order._id.toString();
    const referenceId = getOrderReference(order);
    const itemDetails = order.sellerItems.map(toItemDetail);
    const orderTotal = itemDetails.reduce((sum, item) => sum + item.amount, 0);
    const customer = order.customer;
    const orderDetails = {
      orderId,
      orderNumber: order.orderNumber ?? '',
      orderRef: order.orderRef || '',
      customer,
      items: itemDetails,
      orderStatus: order.orderStatus || '',
      paymentStatus: order.paymentStatus || '',
      paymentMethod: order.paymentMethod || '',
      paymentAmount: orderTotal,
      driver: order.driverId ? {
        name: order.driverId.name || '',
        phone: order.driverId.phone || ''
      } : null,
      pickup: (order.sellerPickups || [])
        .filter(pickup => pickup.sellerId?.toString() === sellerId.toString())
        .map(pickup => ({
          id: pickup._id?.toString() || '',
          status: pickup.status || '',
          pickupCode: pickup.pickupCode || '',
          scheduledDate: pickup.scheduledDate || pickup.pickupDate || null,
          driver: order.driverId ? {
            name: order.driverId.name || '',
            phone: order.driverId.phone || ''
          } : null
        })),
      deliverySlot: order.deliverySlot || null
    };

    add(createActivity({
      id: `order:${orderId}`,
      activityType: 'orders',
      activity: 'New Order Received',
      occurredAt: order.createdAt,
      referenceId,
      customer,
      description: formatOrderDescription(itemDetails),
      amount: orderTotal,
      status: order.orderStatus,
      source: 'order',
      recordId: orderId,
      orderId,
      details: orderDetails
    }));

    const sellerPickup = (order.sellerPickups || []).find(
      pickup => pickup.sellerId?.toString() === sellerId.toString()
    );
    if (sellerPickup) {
      add(createActivity({
        id: `pickup:${orderId}:${sellerPickup._id?.toString() || sellerId}`,
        activityType: 'pickups',
        activity: 'Pickup Record Created',
        occurredAt: order.createdAt,
        referenceId,
        customer,
        description: `Pickup record created with order${sellerPickup.status ? `; current status: ${sellerPickup.status}` : ''}`,
        amount: orderTotal,
        status: sellerPickup.status,
        source: 'order',
        recordId: orderId,
        orderId,
        details: orderDetails
      }));
    }

    if (order.paidAt && ['Paid', 'Completed'].includes(order.paymentStatus) &&
      !hasHistoryEvent(orderId, 'payments', 'Payment Received')) {
      add(createActivity({
        id: `order-payment:${orderId}:${new Date(order.paidAt).getTime()}`,
        activityType: 'payments',
        activity: 'Payment Received',
        occurredAt: order.paidAt,
        referenceId,
        customer,
        description: `${order.paymentMethod || 'Payment'} payment received for order`,
        amount: orderTotal,
        status: order.paymentStatus,
        source: 'order',
        recordId: orderId,
        orderId,
        details: orderDetails
      }));
    } else if (order.createdAt && order.paymentStatus === 'Pending' && !order.paidAt &&
      !hasHistoryEvent(orderId, 'payments', 'Payment Pending')) {
      add(createActivity({
        id: `order-payment-pending:${orderId}`,
        activityType: 'payments',
        activity: 'Payment Pending',
        occurredAt: order.createdAt,
        referenceId,
        customer,
        description: `${order.paymentMethod || 'Payment'} payment pending for order`,
        amount: orderTotal,
        status: order.paymentStatus,
        source: 'order',
        recordId: orderId,
        orderId,
        details: orderDetails
      }));
    }

    const returnItems = order.sellerItems.filter(item => item.returnStatus && item.returnStatus !== 'None');
    const returnAmount = returnItems.reduce((sum, item) => sum + getItemAmount(item), 0);
    const returnDates = [
      ['Return Requested', order.returnRequestedAt],
      ['Return Approved', order.returnApprovedAt],
      ['Return Rejected', order.returnRejectedAt]
    ];
    for (const [activity, occurredAt] of returnDates) {
      if (!occurredAt || hasHistoryEvent(orderId, 'returns', activity)) continue;
      add(createActivity({
        id: `return:${orderId}:${activity}:${new Date(occurredAt).getTime()}`,
        activityType: 'returns',
        activity,
        occurredAt,
        referenceId,
        customer,
        description: `${returnItems.length || order.sellerItems.length} return item${(returnItems.length || order.sellerItems.length) === 1 ? '' : 's'}${order.returnReason ? `; ${order.returnReason}` : ''}`,
        amount: returnAmount || orderTotal,
        status: order.returnStatus || order.orderStatus,
        source: 'order',
        recordId: orderId,
        orderId,
        details: { ...orderDetails, returnItems: returnItems.map(toItemDetail), returnReason: order.returnReason || '' }
      }));
    }

    if (order.deliveredAt && !hasHistoryEvent(orderId, 'statusUpdates', 'Order Delivered')) {
      add(createActivity({
        id: `delivery:${orderId}:${new Date(order.deliveredAt).getTime()}`,
        activityType: 'statusUpdates',
        activity: 'Order Delivered',
        occurredAt: order.deliveredAt,
        referenceId,
        customer,
        description: 'Order delivery confirmed',
        amount: orderTotal,
        status: order.orderStatus,
        source: 'order',
        recordId: orderId,
        orderId,
        details: orderDetails
      }));
    }

    if (order.cancelledAt && order.orderStatus === 'Cancelled' &&
      !hasHistoryEvent(orderId, 'statusUpdates', 'Order Cancelled')) {
      add(createActivity({
        id: `cancellation:${orderId}:${new Date(order.cancelledAt).getTime()}`,
        activityType: 'statusUpdates',
        activity: 'Order Cancelled',
        occurredAt: order.cancelledAt,
        referenceId,
        customer,
        description: order.cancellationReason || 'Order cancelled',
        amount: orderTotal,
        status: order.orderStatus,
        source: 'order',
        recordId: orderId,
        orderId,
        details: orderDetails
      }));
    }
  }

  const invoicesByOrder = new Map();
  for (const invoice of invoices) {
    const invoiceOrderIds = [...new Set([
      invoice.orderId,
      ...(invoice.orders || [])
    ].filter(Boolean).map(orderId => orderId.toString()))];
    const invoiceOrderId = invoiceOrderIds[0] || '';
    const linkedOrders = invoiceOrderIds.map(id => ordersById.get(id)).filter(Boolean);
    const order = linkedOrders[0];
    for (const id of invoiceOrderIds) {
      if (!ordersById.has(id)) continue;
      const current = invoicesByOrder.get(id) || [];
      current.push(invoice.invoiceNumber || '');
      invoicesByOrder.set(id, current);
    }
    const customer = order?.customer || {};
    const invoiceReference = invoice.invoiceNumber || invoice._id.toString();
    add(createActivity({
      id: `invoice:${invoice._id.toString()}`,
      activityType: 'invoices',
      activity: 'Invoice Generated',
      occurredAt: invoice.createdAt,
      referenceId: invoiceReference,
      customer,
      description: invoice.orderNumber
        ? `Invoice for order #${String(invoice.orderNumber).padStart(5, '0')}`
        : 'Seller invoice generated',
      amount: invoice.netAmount ?? invoice.totalAmount,
      status: invoice.status,
      source: 'invoice',
      recordId: invoice._id,
      orderId: invoiceOrderId,
      details: {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoiceReference,
        orderId: invoiceOrderId,
        orderNumber: invoice.orderNumber ?? '',
        startDate: invoice.startDate || null,
        endDate: invoice.endDate || null,
        totalAmount: safeNumber(invoice.totalAmount),
        totalCommission: safeNumber(invoice.totalCommission),
        netAmount: safeNumber(invoice.netAmount),
        status: invoice.status || '',
        order: order ? {
          orderId: invoiceOrderId,
          referenceId: getOrderReference(order),
          customer: order.customer,
          items: order.sellerItems.map(toItemDetail),
          orderStatus: order.orderStatus || ''
        } : null,
        relatedOrders: linkedOrders.map(linkedOrder => ({
          orderId: linkedOrder._id.toString(),
          referenceId: getOrderReference(linkedOrder),
          customer: linkedOrder.customer,
          items: linkedOrder.sellerItems.map(toItemDetail)
        }))
      }
    }));
  }

  for (const payment of payments) {
    const occurredAt = payment.date || payment.createdAt;
    add(createActivity({
      id: `payment:${payment._id.toString()}`,
      activityType: 'payments',
      activity: payment.status === 'Reversed' ? 'Payment Reversed' : 'Payment Received',
      occurredAt,
      referenceId: payment.receiptNumber || payment.transactionId || payment._id.toString(),
      description: [
        payment.settlementType,
        payment.paymentMethod,
        payment.transactionId && `Transaction ${payment.transactionId}`,
        payment.remarks
      ].filter(Boolean).join(' · '),
      amount: payment.amount,
      status: payment.status || '',
      source: 'payment',
      recordId: payment._id,
      details: {
        amount: safeNumber(payment.amount),
        paymentMethod: payment.paymentMethod || '',
        transactionId: payment.transactionId || '',
        utrReference: payment.utrReference || '',
        receiptNumber: payment.receiptNumber || '',
        settlementType: payment.settlementType || '',
        status: payment.status || '',
        remarks: payment.remarks || '',
        occurredAt
      }
    }));
  }

  for (const audit of paymentAudits) {
    if (audit.action === 'MANUAL_SETTLEMENT') continue;
    const orderId = audit.orderId?.toString() || '';
    const order = ordersById.get(orderId);
    if (orderId && !order) continue;
    const actionLabels = {
      COD_COLLECTED: 'Payment Received',
      COD_NOT_COLLECTED: 'Payment Pending',
      COD_VERIFIED: 'Payment Verified',
      COD_SETTLEMENT_APPROVED: 'Settlement Approved',
      COD_SETTLEMENT_REJECTED: 'Settlement Rejected',
      ONLINE_VERIFIED: 'Payment Received',
      ONLINE_SETTLEMENT_APPROVED: 'Settlement Approved',
      ONLINE_SETTLEMENT_REJECTED: 'Settlement Rejected',
      STATUS_UPDATED: 'Payment Status Updated',
      REMARKS_ADDED: 'Payment Remark Added'
    };
    add(createActivity({
      id: `payment-audit:${audit._id.toString()}`,
      activityType: 'payments',
      activity: actionLabels[audit.action] || 'Payment Status Updated',
      occurredAt: audit.date || audit.createdAt,
      referenceId: audit.transactionReference || (order ? getOrderReference(order) : audit._id.toString()),
      customer: order?.customer || {},
      description: [audit.paymentMethod, audit.remarks, audit.transactionReference].filter(Boolean).join(' · '),
      amount: audit.amount,
      status: audit.updatedStatus || '',
      source: 'paymentAudit',
      recordId: audit._id,
      orderId,
      details: {
        action: audit.action,
        previousStatus: audit.previousStatus || '',
        status: audit.updatedStatus || '',
        amount: safeNumber(audit.amount),
        paymentMethod: audit.paymentMethod || '',
        transactionReference: audit.transactionReference || '',
        remarks: audit.remarks || '',
        order: order ? {
          orderId,
          referenceId: getOrderReference(order),
          customer: order.customer,
          items: order.sellerItems.map(toItemDetail),
          orderStatus: order.orderStatus || '',
          paymentStatus: order.paymentStatus || '',
          paymentMethod: order.paymentMethod || '',
          pickup: (order.sellerPickups || [])
            .filter(pickup => pickup.sellerId?.toString() === sellerId.toString())
            .map(pickup => ({
              status: pickup.status || '',
              scheduledDate: pickup.scheduledDate || pickup.pickupDate || null,
              driver: order.driverId ? { name: order.driverId.name || '', phone: order.driverId.phone || '' } : null
            }))
        } : null
      }
    }));
  }

  for (const event of historyEvents) {
    const occurredAt = event.occurredAt;
    const orderId = event.orderId?.toString() || '';
    const order = ordersById.get(orderId);
    add(createActivity({
      id: `event:${event._id.toString()}`,
      activityType: event.activityType,
      activity: event.activity,
      occurredAt,
      referenceId: order ? getOrderReference(order) : '',
      customer: order?.customer || {},
      description: event.description,
      amount: event.amount,
      status: event.status,
      source: 'event',
      recordId: event._id,
      orderId,
      details: {
        ...event.metadata,
        status: event.status || '',
        description: event.description || '',
        order: order ? {
          orderId,
          referenceId: getOrderReference(order),
          customer: order.customer,
          items: order.sellerItems.map(toItemDetail),
          orderStatus: order.orderStatus || '',
          paymentStatus: order.paymentStatus || '',
          paymentMethod: order.paymentMethod || '',
          pickup: (order.sellerPickups || [])
            .filter(pickup => pickup.sellerId?.toString() === sellerId.toString())
            .map(pickup => ({
              status: pickup.status || '',
              scheduledDate: pickup.scheduledDate || pickup.pickupDate || null,
              driver: order.driverId ? { name: order.driverId.name || '', phone: order.driverId.phone || '' } : null
            }))
        } : null
      }
    }));
  }

  for (const row of rows) {
    if (row.orderId && row.details && invoicesByOrder.has(row.orderId)) {
      row.details.invoiceReferences = invoicesByOrder.get(row.orderId);
    }
  }

  return rows;
};

const matchesSearch = (row, search) => {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [
    row.referenceId,
    row.activity,
    row.customer.name,
    row.customer.phone,
    row.description,
    row.status,
    row.orderId,
    row.details?.transactionId,
    row.details?.transactionReference,
    row.details?.invoiceNumber,
    row.details?.receiptNumber
  ].filter(Boolean).join(' ').toLowerCase().includes(needle);
};

const publicActivity = ({ details, ...activity }) => activity;

router.get('/history', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'seller') {
      return res.status(403).json({ message: 'Only sellers can access business history' });
    }

    const startDate = validDateRange(req.query.startDate);
    const endDate = validDateRange(req.query.endDate, true);
    if (startDate === undefined || endDate === undefined) {
      return res.status(400).json({ message: 'Dates must use YYYY-MM-DD format' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ message: 'Start date must be on or before end date' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const activityType = String(req.query.activityType || 'all');
    const allowedTypes = ['all', 'orders', 'payments', 'invoices', 'returns', 'pickups', 'statusUpdates'];
    if (!allowedTypes.includes(activityType)) {
      return res.status(400).json({ message: 'Invalid activity type' });
    }
    const sortFields = {
      date: 'occurredAt',
      activity: 'activity',
      referenceId: 'referenceId',
      customer: 'customer.name',
      amount: 'amount',
      status: 'status'
    };
    const sortBy = sortFields[req.query.sortBy] || 'occurredAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const search = String(req.query.search || '').trim().slice(0, 100);
    const status = String(req.query.status || '').trim().slice(0, 80).toLowerCase();
    const rows = await loadSellerHistory(req, { startDate, endDate });
    const searchedRows = rows.filter(row => matchesSearch(row, search));
    const filteredRows = searchedRows.filter(row => !status || row.status.toLowerCase() === status);

    const counts = {
      all: filteredRows.length,
      orders: 0,
      payments: 0,
      invoices: 0,
      returns: 0,
      pickups: 0,
      statusUpdates: 0
    };
    for (const row of filteredRows) {
      if (Object.prototype.hasOwnProperty.call(counts, row.activityType)) {
        counts[row.activityType] += 1;
      }
    }

    const categoryRows = activityType === 'all'
      ? filteredRows
      : filteredRows.filter(row => row.activityType === activityType);
    categoryRows.sort((left, right) => {
      const leftValue = sortBy === 'customer.name' ? left.customer.name : left[sortBy];
      const rightValue = sortBy === 'customer.name' ? right.customer.name : right[sortBy];
      if (sortBy === 'occurredAt') {
        return (new Date(leftValue).getTime() - new Date(rightValue).getTime()) * sortOrder;
      }
      if (sortBy === 'amount') return (safeNumber(leftValue) - safeNumber(rightValue)) * sortOrder;
      return String(leftValue || '').localeCompare(String(rightValue || ''), undefined, { sensitivity: 'base' }) * sortOrder;
    });

    const totalRecords = categoryRows.length;
    const totalPages = Math.ceil(totalRecords / limit);
    const data = categoryRows.slice((page - 1) * limit, page * limit).map(publicActivity);
    const statuses = [...new Set(searchedRows.map(row => row.status).filter(Boolean))].sort();

    return res.json({
      success: true,
      data,
      pagination: { totalRecords, currentPage: page, totalPages, limit },
      counts,
      statuses
    });
  } catch (error) {
    console.error('Seller business history fetch error:', error);
    return res.status(500).json({ message: 'Failed to load business history' });
  }
});

router.get('/history/details', protect, async (req, res) => {
  try {
    if (req.user?.role !== 'seller') {
      return res.status(403).json({ message: 'Only sellers can access business history' });
    }
    const activityId = String(req.query.id || '');
    if (!activityId) return res.status(400).json({ message: 'Activity ID is required' });

    const rows = await loadSellerHistory(req, {});
    const activity = rows.find(row => row.id === activityId);
    if (!activity) return res.status(404).json({ message: 'History record not found' });

    const relatedTransactions = activity.orderId
      ? rows
        .filter(row => row.orderId === activity.orderId && row.id !== activity.id)
        .map(publicActivity)
      : [];
    return res.json({
      success: true,
      data: {
        activity: publicActivity(activity),
        details: activity.details || {},
        relatedTransactions
      }
    });
  } catch (error) {
    console.error('Seller business history details error:', error);
    return res.status(500).json({ message: 'Failed to load history details' });
  }
});

module.exports = router;
