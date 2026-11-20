const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const order27 = await db.collection('orders').findOne({ orderNumber: 27 });
  if (order27) {
    const res = await db.collection('sellerhistoryevents').updateMany(
      { orderId: order27._id },
      { $set: { amount: 100000 } }
    );
    console.log('Updated Order 27 events count:', res.modifiedCount);
  }

  const activeOrders = await db.collection('orders').find({}).toArray();
  const activeOrderIds = activeOrders.map(o => o._id);
  const delRes = await db.collection('sellerhistoryevents').deleteMany({
    orderId: { $nin: activeOrderIds }
  });
  console.log('Deleted orphaned events count:', delRes.deletedCount);

  const remainingEvents = await db.collection('sellerhistoryevents').find({}).toArray();
  console.log('Remaining events in DB:', remainingEvents.map(e => ({
    id: e._id.toString(),
    orderId: e.orderId?.toString(),
    activity: e.activity,
    amount: e.amount
  })));

  await mongoose.disconnect();
}

run().catch(console.error);

