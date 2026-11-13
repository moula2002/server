const Counter = require('../models/Counter');

/**
 * Migration script to backfill sequential order numbers for all existing orders
 * that don't have an orderNumber assigned yet.
 * Also synchronizes the Counter collection to the maximum assigned orderNumber.
 * 
 * @param {mongoose.Model} OrderModel - The Order model to migrate
 * @param {mongoose.Model} [CounterModel] - The Counter model to update
 */
async function migrateExistingOrders(OrderModel, CounterModel = Counter) {
  if (!OrderModel) return;

  const CModel = CounterModel || Counter;

  // 1. Find the highest existing orderNumber if any
  const highestOrder = await OrderModel.findOne({ orderNumber: { $exists: true, $ne: null } })
    .sort({ orderNumber: -1 })
    .select('orderNumber')
    .lean();

  let currentMax = (highestOrder && typeof highestOrder.orderNumber === 'number') ? highestOrder.orderNumber : 0;

  // 2. Fetch all orders missing orderNumber, sorted chronologically (oldest first)
  const unnumberedOrders = await OrderModel.find({
    $or: [
      { orderNumber: { $exists: false } },
      { orderNumber: null }
    ]
  }).sort({ createdAt: 1, _id: 1 });

  if (unnumberedOrders.length > 0) {
    console.log(`[OrderSequenceMigration] Found ${unnumberedOrders.length} existing orders without orderNumber. Migrating...`);

    for (const ord of unnumberedOrders) {
      currentMax += 1;
      await OrderModel.updateOne(
        { _id: ord._id },
        { $set: { orderNumber: currentMax } }
      );
    }

    console.log(`[OrderSequenceMigration] Successfully assigned sequential order numbers up to #${String(currentMax).padStart(5, '0')}.`);
  }

  // 3. Ensure the Counter document reflects at least currentMax
  const counterDoc = await CModel.findById('orderNumber');
  if (!counterDoc) {
    await CModel.create({ _id: 'orderNumber', seq: currentMax });
    console.log(`[OrderSequenceMigration] Initialized orderNumber counter at ${currentMax}.`);
  } else if (counterDoc.seq < currentMax) {
    await CModel.findByIdAndUpdate('orderNumber', { $set: { seq: currentMax } });
    console.log(`[OrderSequenceMigration] Updated orderNumber counter to ${currentMax}.`);
  }
}

module.exports = {
  migrateExistingOrders
};

