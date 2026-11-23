const SellerHistoryEvent = require('../models/SellerHistoryEvent');

const getHistoryEventModel = (req) => {
  if (req.models?.SellerHistoryEvent) return req.models.SellerHistoryEvent;
  if (req.db?.models?.SellerHistoryEvent) return req.db.models.SellerHistoryEvent;
  if (req.db?.model) {
    return req.db.model('SellerHistoryEvent', SellerHistoryEvent.schema);
  }
  return SellerHistoryEvent;
};

const getSellerIdsFromOrder = (order) => [...new Set(
  (order.items || [])
    .map(item => item.seller?.sellerId)
    .filter(Boolean)
    .map(id => id.toString())
)];

const getSellerAmount = (order, sellerId) => {
  if (order.totalAmountWithoutCommissions !== undefined && order.totalAmountWithoutCommissions !== null && Number(order.totalAmountWithoutCommissions) > 0) {
    return Number(order.totalAmountWithoutCommissions);
  }
  if (order.sellerItemsNetTotal !== undefined && order.sellerItemsNetTotal !== null && Number(order.sellerItemsNetTotal) > 0) {
    return Number(order.sellerItemsNetTotal);
  }
  const sellerItems = (order.items || [])
    .filter(item => item.seller?.sellerId?.toString() === sellerId || item.sellerId?.toString() === sellerId);
  if (!sellerItems.length) return 0;

  // Strict alignment with Seller Orders page: seller items without commissions (including GST when applicable)
  return sellerItems.reduce((total, item) => {
    const lineTotal = item.totalSellerAmount !== undefined && item.totalSellerAmount !== null && Number(item.totalSellerAmount) > 0
      ? Number(item.totalSellerAmount)
      : ((Number(item.normalPrice ?? item.netPrice ?? item.price ?? 0)) * (Number(item.quantity) || 1));
    const lineGst = Number(item.gstAmount ?? item.totalGst ?? 0);
    return total + lineTotal + lineGst;
  }, 0);
};

const recordSellerHistoryEvent = async (req, order, event) => {
  try {
    const sellerIds = event.sellerIds?.length
      ? event.sellerIds.map(id => id.toString())
      : getSellerIdsFromOrder(order);
    if (!sellerIds.length) return;

    const EventModel = getHistoryEventModel(req);
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('Invalid seller history event timestamp');
    }

    await Promise.all(sellerIds.map(sellerId => {
      const eventKey = event.eventKey || [
        order._id.toString(),
        event.activityType,
        event.activity,
        event.fromStatus || '',
        event.status || '',
        occurredAt.getTime()
      ].join(':');

      return EventModel.findOneAndUpdate(
        { sellerId, eventKey },
        {
          $setOnInsert: {
            sellerId,
            orderId: order._id,
            activityType: event.activityType,
            activity: event.activity,
            description: event.description || '',
            amount: event.amount ?? getSellerAmount(order, sellerId),
            status: event.status || '',
            occurredAt,
            eventKey,
            metadata: event.metadata || null
          }
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      ).catch(error => {
        if (error.code === 11000) return null;
        throw error;
      });
    }));
  } catch (error) {
    console.error('[SellerHistory] Failed to record order activity:', error);
  }
};

module.exports = { recordSellerHistoryEvent };
