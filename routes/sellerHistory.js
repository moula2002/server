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
  if (item.totalSellerAmount !== undefined && item.totalSellerAmount !== null && safeNumber(item.totalSellerAmount) > 0) {
    return safeNumber(item.totalSellerAmount);
  }
  const normalPrice = item.normalPrice !== undefined && item.normalPrice !== null
    ? safeNumber(item.normalPrice)
    : (item.netPrice !== undefined && item.netPrice !== null ? safeNumber(item.netPrice) : safeNumber(item.price));
  const qty = safeNumber(item.quantity) || 1;
  return normalPrice * qty;
};

const toItemDetail = (item) => ({
  name: item.name || item.product?.name || '',
  quantity: safeNumber(item.quantity),
  unit: item.variantSize || item.packagingType || item.unit || item.sellingUnit || '',
  measurement: item.productUnitSize && item.productUnitSize !== 1
    ? `${item.productUnitSize} ${item.measurementBasis || item.measurementUnit || ''}`.trim()
    : '',
  unitPrice: item.normalPrice !== undefined && item.normalPrice !== null
    ? safeNumber(item.normalPrice)
    : (item.netPrice !== undefined && item.netPrice !== null ? safeNumber(item.netPrice) : safeNumber(item.price ?? item.unitCustomerPrice)),
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

const loadSellerHistory = async (req, { startDate, endDate, sellerId: explicitSellerId }) => {
  const sellerId = explicitSellerId || (req.user?.role === 'seller' ? req.user._id : (req.query.sellerId || req.params.sellerId));
  if (!sellerId) return [];
  const sellerIdStr = sellerId.toString();
  const ProductModel = getModel(req, 'Product', '../models/Product');
  const OrderModel = getModel(req, 'Order', '../models/Order');
  const InvoiceModel = getModel(req, 'SellerInvoice', '../models/SellerInvoice');
  const PaymentModel = getModel(req, 'SellerPayment', '../models/SellerPayment');
  const PaymentAuditModel = getModel(req, 'PaymentAuditLog', '../models/PaymentAuditLog');
  const HistoryEventModel = getModel(req, 'SellerHistoryEvent', '../models/SellerHistoryEvent');

  const products = await ProductModel.find({
    $or: [{ sellerId }, { sellerId: sellerIdStr }, { seller: sellerId }]
  }).select('_id').lean();
  const productIds = products.map(product => product._id);
  const productIdSet = new Set(productIds.map(id => id.toString()));

  const orderSellerClauses = [
    { 'sellerPickups.sellerId': sellerId },
    { 'sellerPickups.sellerId': sellerIdStr },
    { 'items.seller.sellerId': sellerId },
    { 'items.seller.sellerId': sellerIdStr },
    { 'items.sellerId': sellerId },
    { 'items.sellerId': sellerIdStr }
  ];
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
      .select('_id orderNumber orderRef invoiceNumber userId shippingAddress items totalAmount totalAmountWithoutCommissions sellerItemsNetTotal totalGstAmount paymentStatus paymentMethod paidAt orderStatus createdAt updatedAt deliveredAt cancelledAt cancellationReason returnStatus returnReason returnRequestedAt returnApprovedAt returnRejectedAt sellerPickups pickupCode driverId sellerSettlementStatus sellerSettledAt deliverySlot')
      .populate('userId', 'name phone')
      .populate('driverId', 'name phone')
      .sort({ createdAt: -1 })
      .lean(),
    InvoiceModel.find({
      $or: [{ sellerId }, { sellerId: sellerIdStr }, { seller: sellerId }],
      ...(startDate || endDate ? { createdAt: dateRange } : {})
    })
      .select('-invoiceImage.data')
      .sort({ createdAt: -1 })
      .lean(),
    PaymentModel.find({
      $or: [{ sellerId }, { sellerId: sellerIdStr }, { seller: sellerId }],
      ...(startDate || endDate ? { $or: [{ date: dateRange }, { createdAt: dateRange }] } : {})
    }).sort({ date: -1, createdAt: -1 }).lean(),
    PaymentAuditModel.find({
      $or: [{ sellerId }, { sellerId: sellerIdStr }, { seller: sellerId }],
      ...(startDate || endDate ? { $or: [{ date: dateRange }, { createdAt: dateRange }] } : {})
    }).sort({ date: -1, createdAt: -1 }).lean(),
    HistoryEventModel.find({
      $or: [{ sellerId }, { sellerId: sellerIdStr }, { seller: sellerId }],
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
      .select('_id orderNumber orderRef invoiceNumber userId shippingAddress items totalAmount totalAmountWithoutCommissions sellerItemsNetTotal totalGstAmount paymentStatus paymentMethod paidAt orderStatus createdAt updatedAt deliveredAt cancelledAt cancellationReason returnStatus returnReason returnRequestedAt returnApprovedAt returnRejectedAt sellerPickups pickupCode driverId sellerSettlementStatus sellerSettledAt deliverySlot')
      .populate('userId', 'name phone')
      .populate('driverId', 'name phone')
      .lean();
    orders = [...orders, ...relatedOrders];
  }

  const sellerOrders = orders.map(order => {
    const items = (order.items || []).filter(item => {
      const itemSellerId = item.seller?.sellerId || item.sellerId || item.seller?._id;
      const itemPid = item.productId?._id ? item.productId._id.toString() : item.productId?.toString();
      return (itemSellerId && itemSellerId.toString() === sellerIdStr) ||
             (itemPid && productIdSet.has(itemPid));
    });
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
    // Strict alignment with Seller Orders page: use seller's order total without commissions (including GST when applicable)
    const orderTotal = (order.totalAmountWithoutCommissions !== undefined && order.totalAmountWithoutCommissions !== null && safeNumber(order.totalAmountWithoutCommissions) > 0)
      ? safeNumber(order.totalAmountWithoutCommissions)
      : ((order.sellerItemsNetTotal !== undefined && order.sellerItemsNetTotal !== null && safeNumber(order.sellerItemsNetTotal) > 0)
          ? safeNumber(order.sellerItemsNetTotal)
          : itemDetails.reduce((sum, item) => sum + item.amount, 0));
    order.sellerTotalAmount = orderTotal;
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
      orderTotal,
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
      pickup => pickup.sellerId?.toString() === sellerIdStr
    );
    if (sellerPickup) {
      const isPickedUp = sellerPickup.status === 'Picked Up' || sellerPickup.status === 'Delivered' || order.orderStatus === 'Picked Up' || order.orderStatus === 'Delivered';
      const isOutForDelivery = sellerPickup.status === 'Out for Delivery' || order.orderStatus === 'Out for Delivery';
      const isScheduled = Boolean(sellerPickup.scheduledDate || sellerPickup.pickupDate);
      if (isPickedUp || isOutForDelivery || isScheduled) {
        const pickupTitle = isPickedUp
          ? 'Order Picked Up'
          : isOutForDelivery
            ? 'Pickup Dispatched'
            : 'Pickup Scheduled';
        const pickupDate = sellerPickup.scheduledDate || sellerPickup.pickupDate || order.updatedAt || order.createdAt;

        add(createActivity({
          id: `pickup:${orderId}:${sellerPickup._id?.toString() || sellerIdStr}`,
          activityType: 'pickups',
          activity: pickupTitle,
          occurredAt: pickupDate,
          referenceId,
          customer,
          description: `Pickup record; status: ${sellerPickup.status || order.orderStatus}${sellerPickup.pickupCode ? `; Code: ${sellerPickup.pickupCode}` : ''}`,
          amount: orderTotal,
          status: sellerPickup.status || order.orderStatus,
          source: 'order',
          recordId: orderId,
          orderId,
          details: orderDetails
        }));
      }
    } else if ((!order.sellerPickups || order.sellerPickups.length === 0) && (order.orderStatus === 'Picked Up' || order.orderStatus === 'Out for Delivery')) {
      add(createActivity({
        id: `pickup:${orderId}:${sellerIdStr}`,
        activityType: 'pickups',
        activity: order.orderStatus === 'Picked Up' ? 'Order Picked Up' : 'Pickup Dispatched',
        occurredAt: order.updatedAt || order.createdAt,
        referenceId,
        customer,
        description: `Pickup record; status: ${order.orderStatus}${order.pickupCode ? `; Code: ${order.pickupCode}` : ''}`,
        amount: orderTotal,
        status: order.orderStatus,
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
    }

    const returnItems = order.sellerItems.filter(item => item.returnStatus && item.returnStatus !== 'None');
    const returnAmount = returnItems.reduce((sum, item) => sum + getItemAmount(item), 0);
    const returnDates = [
      ['Return Requested', order.returnRequestedAt],
      ['Return Approved', order.returnApprovedAt],
      ['Return Rejected', order.returnRejectedAt]
    ];
    let returnEventAdded = false;
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
      returnEventAdded = true;
    }
    // Fallback if return status exists on order or item without timestamped event
    if (!returnEventAdded && (returnItems.length > 0 || ['Return Requested', 'Return Approved', 'Return Rejected', 'Returned', 'Partially Returned'].includes(order.orderStatus) || order.returnStatus)) {
      if (!hasHistoryEvent(orderId, 'returns', 'Return Requested') && !hasHistoryEvent(orderId, 'returns', order.returnStatus)) {
        const retActivity = order.returnStatus || (returnItems[0] && returnItems[0].returnStatus) || 'Return Requested';
        add(createActivity({
          id: `return:${orderId}:current`,
          activityType: 'returns',
          activity: retActivity,
          occurredAt: order.updatedAt || order.createdAt,
          referenceId,
          customer,
          description: `${returnItems.length || order.sellerItems.length} return item${(returnItems.length || order.sellerItems.length) === 1 ? '' : 's'}${order.returnReason ? `; ${order.returnReason}` : ''}`,
          amount: returnAmount || orderTotal,
          status: order.returnStatus || (returnItems[0] && returnItems[0].returnStatus) || order.orderStatus,
          source: 'order',
          recordId: orderId,
          orderId,
          details: { ...orderDetails, returnItems: returnItems.map(toItemDetail), returnReason: order.returnReason || '' }
        }));
      }
    }

    const deliveryDate = order.deliveredAt || (order.orderStatus === 'Delivered' ? (order.updatedAt || order.createdAt) : null);
    if (deliveryDate && !hasHistoryEvent(orderId, 'delivered', 'Order Delivered') && !hasHistoryEvent(orderId, 'statusUpdates', 'Order Delivered')) {
      add(createActivity({
        id: `delivery:${orderId}:${new Date(deliveryDate).getTime()}`,
        activityType: 'delivered',
        activity: 'Order Delivered',
        occurredAt: deliveryDate,
        referenceId,
        customer,
        description: 'Order delivery confirmed',
        amount: orderTotal,
        status: order.orderStatus || 'Delivered',
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
    const rawInvNum = invoice.invoiceNumber || (invoice.invoiceSequenceNumber ? `INV-${String(invoice.invoiceSequenceNumber).padStart(5, '0')}` : invoice._id.toString());
    const invoiceReference = String(rawInvNum).trim();
    for (const id of invoiceOrderIds) {
      if (!ordersById.has(id)) continue;
      const current = invoicesByOrder.get(id) || [];
      current.push(invoiceReference);
      invoicesByOrder.set(id, current);
    }
    const customer = order?.customer || {};
    const linkedOrderRef = order ? getOrderReference(order) : (invoice.orderNumber ? `#${String(invoice.orderNumber).padStart(5, '0')}` : '');
    add(createActivity({
      id: `invoice:${invoice._id.toString()}`,
      activityType: 'invoices',
      activity: 'Invoice Generated',
      occurredAt: invoice.createdAt,
      referenceId: invoiceReference,
      customer,
      description: linkedOrderRef
        ? `Invoice for order ${linkedOrderRef}`
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
        orderReference: linkedOrderRef,
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

  const orphanedAuditIds = [];
  for (const audit of paymentAudits) {
    if (audit.action === 'MANUAL_SETTLEMENT') continue;
    const orderId = audit.orderId?.toString() || '';
    const order = orderId ? ordersById.get(orderId) : null;
    if (orderId && !order) {
      orphanedAuditIds.push(audit._id);
      continue; // Skip orphaned records where order was deleted by admin
    }
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

  // Auto-purge any orphaned payment audit logs from the database asynchronously
  if (orphanedAuditIds.length > 0) {
    PaymentAuditModel.deleteMany({ _id: { $in: orphanedAuditIds } }).catch(err => {
      console.error('[SellerHistory] Auto-cleanup orphaned payment audits error:', err.message);
    });
  }

  const orphanedEventIds = [];
  for (const event of historyEvents) {
    const occurredAt = event.occurredAt;
    const orderId = event.orderId?.toString() || '';
    const order = orderId ? ordersById.get(orderId) : null;
    // Skip and collect orphaned history events where the order was deleted by admin
    if ((orderId && !order) || (!order && ['statusUpdates', 'pickups', 'returns', 'delivered'].includes(event.activityType))) {
      orphanedEventIds.push(event._id);
      continue;
    }
    let eventActivityType = event.activityType;
    if (event.activity === 'Order Delivered' || event.status === 'Delivered') {
      eventActivityType = 'delivered';
    }
    add(createActivity({
      id: `event:${event._id.toString()}`,
      activityType: eventActivityType,
      activity: event.activity,
      occurredAt,
      referenceId: order ? getOrderReference(order) : '',
      customer: order?.customer || {},
      description: event.description,
      amount: order?.sellerTotalAmount !== undefined ? order.sellerTotalAmount : event.amount,
      status: event.status,
      source: 'event',
      recordId: event._id,
      orderId,
      details: {
        ...event.metadata,
        orderTotal: order?.sellerTotalAmount !== undefined ? order.sellerTotalAmount : event.amount,
        paymentAmount: order?.sellerTotalAmount !== undefined ? order.sellerTotalAmount : event.amount,
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

  // Auto-purge any orphaned history events from the database asynchronously
  if (orphanedEventIds.length > 0) {
    HistoryEventModel.deleteMany({ _id: { $in: orphanedEventIds } }).catch(err => {
      console.error('[SellerHistory] Auto-cleanup orphaned history events error:', err.message);
    });
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
    row.customer?.name,
    row.customer?.phone,
    row.description,
    row.status,
    row.orderId,
    row.paymentMethod,
    row.paymentStatus,
    row.details?.transactionId,
    row.details?.transactionReference,
    row.details?.invoiceNumber,
    row.details?.receiptNumber,
    ...(row.activities || []).map(a => `${a.activity} ${a.description} ${a.status}`)
  ].filter(Boolean).join(' ').toLowerCase().includes(needle);
};

const publicActivity = (activity) => {
  if (!activity) return null;
  const { details, ...rest } = activity;
  return {
    ...rest,
    items: details?.items || rest.items || [],
    pickup: details?.pickup || rest.pickup || [],
    driver: details?.driver || rest.driver || null,
    paymentMethod: details?.paymentMethod || rest.paymentMethod || '',
    paymentStatus: details?.paymentStatus || rest.paymentStatus || '',
    invoiceReferences: details?.invoiceReferences || rest.invoiceReferences || [],
    returnItems: details?.returnItems || rest.returnItems || [],
    returnReason: details?.returnReason || rest.returnReason || '',
    deliverySlot: details?.deliverySlot || rest.deliverySlot || null
  };
};

const consolidateSellerHistory = (rows) => {
  const orderMap = new Map();
  const nonOrderRows = [];

  for (const row of rows) {
    if (row.orderId) {
      // Must have a valid reference, customer, or items - never accept empty ghost records from deleted orders
      const hasValidReference = Boolean(row.referenceId && row.referenceId !== '—');
      const hasCustomer = Boolean(row.customer?.name && row.customer.name.trim());
      const hasItems = Boolean(row.details?.items && row.details.items.length > 0);
      if (!hasValidReference && !hasCustomer && !hasItems) {
        continue;
      }

      if (!orderMap.has(row.orderId)) {
        orderMap.set(row.orderId, {
          id: `order:${row.orderId}`,
          orderId: row.orderId,
          referenceId: row.referenceId,
          customer: row.customer || {},
          occurredAt: row.occurredAt,
          createdAt: row.details?.createdAt || row.occurredAt,
          description: row.description,
          amount: row.amount,
          status: row.status,
          paymentStatus: row.details?.paymentStatus || '',
          paymentMethod: row.details?.paymentMethod || '',
          activityType: 'orders',
          activity: 'Order Record',
          source: 'order',
          recordId: row.orderId,
          details: { ...(row.details || {}) },
          activities: [],
          categories: new Set(['orders'])
        });
      }
      const entry = orderMap.get(row.orderId);

      // Register activity in chronological timeline
      entry.activities.push({
        id: row.id,
        activity: row.activity,
        activityType: row.activityType,
        occurredAt: row.occurredAt,
        status: row.status,
        description: row.description,
        amount: row.amount
      });

      // Track categories this order qualifies for
      if (row.activityType) entry.categories.add(row.activityType);
      if (row.activityType === 'delivered' || row.activity === 'Order Delivered' || row.details?.orderStatus === 'Delivered' || (row.status === 'Delivered' && row.activityType === 'orders')) {
        entry.categories.add('delivered');
      }
      if (row.activityType === 'pickups' || (row.activity && row.activity.toLowerCase().includes('pickup'))) {
        entry.categories.add('pickups');
      }
      if (row.activityType === 'returns' || (row.activity && row.activity.toLowerCase().includes('return'))) {
        entry.categories.add('returns');
      }
      if (row.activityType === 'payments' || ['Paid', 'Completed'].includes(row.details?.paymentStatus)) {
        entry.categories.add('payments');
      }
      if (row.activityType === 'invoices' || row.details?.invoiceReferences?.length) {
        entry.categories.add('invoices');
      }
      if (row.activityType === 'statusUpdates' || ['Cancelled', 'Rejected by Seller'].includes(row.status)) {
        entry.categories.add('statusUpdates');
      }

      // Keep latest occurredAt
      if (new Date(row.occurredAt).getTime() > new Date(entry.occurredAt).getTime()) {
        entry.occurredAt = row.occurredAt;
      }
      // If row has rich details or latest order status, keep them updated
      if (row.details?.items?.length) {
        entry.details.items = row.details.items;
      }
      if (row.details?.orderStatus) {
        entry.status = row.details.orderStatus;
      } else if (row.status && row.activityType === 'orders') {
        entry.status = row.status;
      }
      if (row.details?.pickup?.length) {
        entry.details.pickup = row.details.pickup;
      }
      if (row.details?.driver) {
        entry.details.driver = row.details.driver;
      }
      if (row.details?.invoiceReferences?.length) {
        entry.details.invoiceReferences = row.details.invoiceReferences;
      }
      if (row.details?.returnItems?.length) {
        entry.details.returnItems = row.details.returnItems;
      }
      if (row.details?.paymentStatus) {
        entry.paymentStatus = row.details.paymentStatus;
      }
      if (row.details?.paymentMethod) {
        entry.paymentMethod = row.details.paymentMethod;
      }
      // Ensure the canonical order total is preserved across all activities
      if (row.details?.orderTotal !== undefined && row.details.orderTotal !== null) {
        entry.amount = row.details.orderTotal;
      } else if (row.activityType === 'orders' && row.amount !== null && row.amount !== undefined) {
        entry.amount = row.amount;
      } else if (entry.amount === null || entry.amount === undefined) {
        entry.amount = row.amount;
      }
    } else {
      // Non-order records must have a valid reference and cannot be orphaned order activities (status updates / pickups)
      if (!row.referenceId || row.referenceId === '—' || ['statusUpdates', 'pickups'].includes(row.activityType)) {
        continue;
      }
      nonOrderRows.push({
        ...row,
        activities: [{
          id: row.id,
          activity: row.activity,
          activityType: row.activityType,
          occurredAt: row.occurredAt,
          status: row.status,
          description: row.description,
          amount: row.amount
        }],
        categories: new Set([row.activityType || 'all'])
      });
    }
  }

  // Filter out any orphaned orders that lack reference, customer, and items
  const validOrderRows = Array.from(orderMap.values()).filter(order => {
    const hasValidReference = Boolean(order.referenceId && order.referenceId !== '—');
    const hasCustomer = Boolean(order.customer?.name && order.customer.name.trim());
    const hasItems = Boolean(order.details?.items && order.details.items.length > 0);
    return hasValidReference || hasCustomer || hasItems;
  });

  for (const entry of validOrderRows) {
    entry.activities.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    entry.categories = Array.from(entry.categories);
    // Strict safeguard: preserve canonical seller order total from Seller Orders
    const targetOrderTotal = (entry.details?.orderTotal !== undefined && entry.details.orderTotal !== null && safeNumber(entry.details.orderTotal) > 0)
      ? safeNumber(entry.details.orderTotal)
      : (entry.amount !== null && entry.amount !== undefined ? safeNumber(entry.amount) : 0);

    if (targetOrderTotal > 0) {
      entry.amount = targetOrderTotal;
      if (entry.details) {
        entry.details.orderTotal = targetOrderTotal;
        entry.details.paymentAmount = targetOrderTotal;
      }
      entry.activities.forEach(a => { a.amount = targetOrderTotal; });
    }
  }
  for (const entry of nonOrderRows) {
    entry.categories = Array.from(entry.categories);
  }

  return [...validOrderRows, ...nonOrderRows];
};

const handleGetSellerHistory = async (req, res) => {
  try {
    const isSeller = req.user?.role === 'seller' && !req.admin;
    const isAdmin = !!req.admin || req.user?.role === 'admin' || req.user?.role === 'super_admin' || req.user?.role === 'manager' || req.user?.role === 'sales';
    if (!isSeller && !isAdmin) {
      return res.status(403).json({ message: 'Only sellers and admins can access business history' });
    }

    const sellerId = (isSeller && !isAdmin) ? req.user._id : (req.query.sellerId || req.params.sellerId);
    if (!sellerId) {
      return res.status(400).json({ message: 'sellerId is required for admin requests' });
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
    
    // Normalize activityType and support common aliases
    let rawType = String(req.query.activityType || 'all').trim();
    let activityType = rawType;
    const typeLower = rawType.toLowerCase();
    if (typeLower === 'all') activityType = 'all';
    else if (typeLower === 'orders' || typeLower === 'order') activityType = 'orders';
    else if (typeLower === 'delivered' || typeLower === 'deliveries') activityType = 'delivered';
    else if (typeLower === 'pickups' || typeLower === 'pickup') activityType = 'pickups';
    else if (typeLower === 'returns' || typeLower === 'return' || typeLower === 'returned') activityType = 'returns';
    else if (typeLower === 'payments' || typeLower === 'payment') activityType = 'payments';
    else if (typeLower === 'invoices' || typeLower === 'invoice') activityType = 'invoices';
    else if (typeLower === 'statusupdates' || typeLower === 'status_updates' || typeLower === 'statusupdate') activityType = 'statusUpdates';

    const allowedTypes = ['all', 'orders', 'delivered', 'pickups', 'returns', 'payments', 'invoices', 'statusUpdates'];
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
    const rawRows = await loadSellerHistory(req, { startDate, endDate, sellerId });
    const shouldConsolidate = req.query.consolidate !== 'false';
    const rows = shouldConsolidate ? consolidateSellerHistory(rawRows) : rawRows;
    const searchedRows = rows.filter(row => matchesSearch(row, search));
    const filteredRows = searchedRows.filter(row => !status || row.status.toLowerCase() === status);

    const counts = {
      all: filteredRows.length,
      orders: 0,
      delivered: 0,
      pickups: 0,
      returns: 0,
      payments: 0,
      invoices: 0,
      statusUpdates: 0
    };
    for (const row of filteredRows) {
      if (Array.isArray(row.categories)) {
        for (const cat of row.categories) {
          if (Object.prototype.hasOwnProperty.call(counts, cat)) {
            counts[cat] += 1;
          }
        }
      } else if (Object.prototype.hasOwnProperty.call(counts, row.activityType)) {
        counts[row.activityType] += 1;
      }
    }

    const categoryRows = activityType === 'all'
      ? filteredRows
      : filteredRows.filter(row => Array.isArray(row.categories) ? row.categories.includes(activityType) : row.activityType === activityType);
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
};

const handleGetSellerHistoryDetails = async (req, res) => {
  try {
    const isSeller = req.user?.role === 'seller' && !req.admin;
    const isAdmin = !!req.admin || req.user?.role === 'admin' || req.user?.role === 'super_admin' || req.user?.role === 'manager' || req.user?.role === 'sales';
    if (!isSeller && !isAdmin) {
      return res.status(403).json({ message: 'Only sellers and admins can access business history' });
    }

    const sellerId = (isSeller && !isAdmin) ? req.user._id : (req.query.sellerId || req.params.sellerId);
    if (!sellerId) {
      return res.status(400).json({ message: 'sellerId is required for admin requests' });
    }

    const activityId = String(req.query.id || '');
    if (!activityId) return res.status(400).json({ message: 'Activity ID is required' });

    const rawRows = await loadSellerHistory(req, { sellerId });
    const consolidated = consolidateSellerHistory(rawRows);

    let activity = consolidated.find(row => row.id === activityId);
    if (!activity && activityId.startsWith('order:')) {
      const orderId = activityId.slice(6);
      activity = consolidated.find(row => row.orderId === orderId);
    }
    if (!activity) {
      activity = rawRows.find(row => row.id === activityId);
    }
    if (!activity) return res.status(404).json({ message: 'History record not found' });

    const targetOrderId = activity.orderId;
    const allOrderActivities = targetOrderId
      ? rawRows
        .filter(row => row.orderId === targetOrderId)
        .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
        .map(publicActivity)
      : [publicActivity(activity)];

    const relatedTransactions = targetOrderId
      ? rawRows
        .filter(row => row.orderId === targetOrderId && row.id !== activity.id)
        .map(publicActivity)
      : [];

    return res.json({
      success: true,
      data: {
        activity: publicActivity(activity),
        details: activity.details || {},
        relatedTransactions,
        activities: allOrderActivities
      }
    });
  } catch (error) {
    console.error('Seller business history details error:', error);
    return res.status(500).json({ message: 'Failed to load history details' });
  }
};

router.get('/history', protect, handleGetSellerHistory);
router.get('/:sellerId/history', protect, handleGetSellerHistory);
router.get('/history/details', protect, handleGetSellerHistoryDetails);
router.get('/:sellerId/history/details', protect, handleGetSellerHistoryDetails);

module.exports = router;
