const mongoose = require('mongoose');
const Counter = require('../models/Counter');

/**
 * Atomically generates the next sequential order number using MongoDB $inc.
 * Thread-safe, process-safe, and crash-proof (stored permanently in MongoDB).
 * 
 * @param {mongoose.Model} [CounterModel] - Optional tenant/custom Counter model
 * @param {mongoose.Model} [OrderModel] - Optional Order model used for initial seeding/migration
 * @returns {Promise<number>} Next sequential order number (e.g. 1, 2, 3...)
 */
async function getNextOrderNumber(CounterModel = Counter, OrderModel = null) {
  const Model = CounterModel || Counter;
  
  // 1. Atomically increment the order sequence
  let counter = await Model.findByIdAndUpdate(
    'orderNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: false }
  );

  // 2. If the counter does not exist yet, initialize it safely based on existing orders
  if (!counter) {
    let startingSeq = 0;
    if (OrderModel) {
      const maxOrder = await OrderModel.findOne({ orderNumber: { $exists: true, $ne: null } })
        .sort({ orderNumber: -1 })
        .select('orderNumber')
        .lean();
      if (maxOrder && typeof maxOrder.orderNumber === 'number') {
        startingSeq = maxOrder.orderNumber;
      } else {
        const count = await OrderModel.countDocuments();
        startingSeq = count;
      }
    }

    try {
      counter = await Model.findByIdAndUpdate(
        'orderNumber',
        { $setOnInsert: { seq: startingSeq + 1 } },
        { new: true, upsert: true }
      );
    } catch (err) {
      // If concurrent insert occurred, increment it
      counter = await Model.findByIdAndUpdate(
        'orderNumber',
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
    }
  }

  return counter.seq;
}

module.exports = {
  getNextOrderNumber
};

