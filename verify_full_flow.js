const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const SELLER_ID = '6ace1562862dc39e8c2972c0';

async function verifyInDb(expectedValue, stepLabel) {
  const URI = process.env.MONGODB_URI;
  const conn = await mongoose.createConnection(URI).asPromise();
  
  const seller = await conn.collection('sellers').findOne({ _id: new mongoose.Types.ObjectId(SELLER_ID) });
  console.log(`\n[${stepLabel}] --- Direct DB Verification ---`);
  console.log(`Seller "${seller.name}" (${seller._id}):`);
  console.log(`  isProductVisible: ${seller.isProductVisible} (Expected: ${expectedValue})`);
  console.log(`  updatedAt: ${seller.updatedAt}`);

  if (seller.isProductVisible !== expectedValue) {
    throw new Error(`FAIL: Seller isProductVisible is ${seller.isProductVisible}, expected ${expectedValue}`);
  }

  const prodQuery = {
    $or: [
      { sellerId: new mongoose.Types.ObjectId(SELLER_ID) },
      { sellerId: SELLER_ID },
      { 'seller._id': new mongoose.Types.ObjectId(SELLER_ID) },
      { 'seller._id': SELLER_ID },
      { seller: new mongoose.Types.ObjectId(SELLER_ID) },
      { seller: SELLER_ID },
      { sellerName: seller.businessName },
      { sellerName: seller.name }
    ]
  };

  const products = await conn.collection('products').find(prodQuery).toArray();
  console.log(`Associated Products count: ${products.length}`);
  for (const p of products) {
    console.log(`  Product "${p.name}" (${p._id}): isProductVisible = ${p.isProductVisible} (Expected: ${expectedValue})`);
    if (p.isProductVisible !== expectedValue) {
      throw new Error(`FAIL: Product ${p.name} isProductVisible is ${p.isProductVisible}, expected ${expectedValue}`);
    }
  }

  await conn.close();
  return true;
}

async function run() {
  const URI = process.env.MONGODB_URI;
  await mongoose.connect(URI);
  
  // Find super admin or an admin to sign a token
  const Admin = require('./models/Admin');
  let adminDoc = await Admin.findOne({ email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@zudo.com' });
  if (!adminDoc) {
    adminDoc = await Admin.findOne();
  }
  if (!adminDoc) throw new Error('No admin found');

  const token = jwt.sign(
    { 
      id: adminDoc._id, 
      role: adminDoc.role || 'super_admin',
      tokenVersion: adminDoc.tokenVersion || 0
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  await mongoose.disconnect();

  console.log('====================================================');
  console.log('TEST 1 – HIDE: Change SHOW to HIDDEN (isProductVisible: false)');
  console.log('====================================================');

  // 1. Call API PUT /api/sellers/:id with isProductVisible: false
  const hideRes = await fetch(`http://localhost:5000/api/sellers/${SELLER_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      isProductVisible: false,
      businessName: 'Moula Hussain',
      name: 'Moula Hussain'
    })
  });

  const hideData = await hideRes.json();
  console.log('API Response status:', hideRes.status);
  console.log('API Returned isProductVisible:', hideData.isProductVisible);

  if (hideRes.status !== 200) {
    throw new Error(`API returned error: ${JSON.stringify(hideData)}`);
  }

  // Verify in MongoDB Atlas
  await verifyInDb(false, 'TEST 1 - HIDE');
  console.log('>>> TEST 1 PASSED: Seller & Products are all FALSE in MongoDB Atlas! <<<\n');

  console.log('====================================================');
  console.log('TEST 2 – SHOW: Change HIDDEN to SHOW (isProductVisible: true)');
  console.log('====================================================');

  // 2. Call API PUT /api/sellers/:id with isProductVisible: true
  const showRes = await fetch(`http://localhost:5000/api/sellers/${SELLER_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      isProductVisible: true,
      businessName: 'Moula Hussain',
      name: 'Moula Hussain'
    })
  });

  const showData = await showRes.json();
  console.log('API Response status:', showRes.status);
  console.log('API Returned isProductVisible:', showData.isProductVisible);

  if (showRes.status !== 200) {
    throw new Error(`API returned error: ${JSON.stringify(showData)}`);
  }

  // Verify in MongoDB Atlas
  await verifyInDb(true, 'TEST 2 - SHOW');
  console.log('>>> TEST 2 PASSED: Seller & Products are all TRUE in MongoDB Atlas! <<<\n');

  console.log('====================================================');
  console.log('ALL MANDATORY TESTS PASSED 100% DIRECTLY AGAINST MONGODB ATLAS!');
  console.log('====================================================');
}

run().catch((err) => {
  console.error('Test Execution Failed:', err);
  process.exit(1);
});
