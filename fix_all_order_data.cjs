const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoose = require('mongoose');

async function fixData() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const orders = await db.collection('orders').find({}).toArray();
  const activeOrderIds = orders.map(o => o._id);

  console.log(`Processing ${orders.length} orders...`);

  for (const order of orders) {
    const sellerItemsNetTotal = (order.items || []).reduce((sum, item) => {
      if (item.totalSellerAmount && Number(item.totalSellerAmount) > 0) {
        return sum + Number(item.totalSellerAmount);
      }
      const normal = Number(item.normalPrice ?? item.netPrice ?? item.price ?? 0);
      const qty = Number(item.quantity) || 1;
      return sum + (normal * qty);
    }, 0);

    console.log(`Order #${order.orderNumber} pure seller total: ${sellerItemsNetTotal}`);

    // Update order document
    await db.collection('orders').updateOne(
      { _id: order._id },
      {
        $set: {
          totalAmountWithoutCommissions: sellerItemsNetTotal,
          sellerItemsNetTotal: sellerItemsNetTotal
        }
      }
    );

    // Update all history events for this order
    const eventUpdateRes = await db.collection('sellerhistoryevents').updateMany(
      { orderId: order._id },
      {
        $set: {
          amount: sellerItemsNetTotal
        }
      }
    );
    console.log(`  Updated ${eventUpdateRes.modifiedCount} history events for Order #${order.orderNumber} to amount: ${sellerItemsNetTotal}`);
  }

  // Delete orphaned history events
  const delRes = await db.collection('sellerhistoryevents').deleteMany({
    orderId: { $nin: activeOrderIds }
  });
  console.log(`Deleted ${delRes.deletedCount} orphaned history events`);

  // Verify remaining events
  const remainingEvents = await db.collection('sellerhistoryevents').find({}).toArray();
  console.log(`Remaining sellerhistoryevents in DB: ${remainingEvents.length}`);
  for (const ev of remainingEvents) {
    console.log(`  Event ${ev._id}: activity: "${ev.activity}", amount: ${ev.amount}, orderId: ${ev.orderId}`);
  }

  // Verify Order 28
  const o28 = await db.collection('orders').findOne({ orderNumber: 28 });
  console.log('Order 28 updated status:', {
    orderNumber: o28.orderNumber,
    totalAmount: o28.totalAmount,
    totalAmountWithoutCommissions: o28.totalAmountWithoutCommissions,
    sellerItemsNetTotal: o28.sellerItemsNetTotal
  });

  await mongoose.disconnect();
}

fixData().catch(console.error);
