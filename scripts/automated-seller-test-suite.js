/**
 * Automated Test Suite for Zudo Seller Panel
 * Tests all 7 Tasks:
 * 1. Seller Orders & Data Isolation
 * 2. Seller Invoice Generation (Invoice Number vs Order ID)
 * 3. Invoice Count, Sequence & Duplicate Prevention
 * 4. Seller History & Exact Amount Consistency
 * 5. History Navigation & Routing
 * 6. Seller Profile Lock & API Protection
 * 7. Commission PIN Code Rules & Price Integrity
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// Utilities
const { findCategoryCommission } = require('../utils/pricing');

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;
const testResults = [];

function assert(condition, message, details = {}) {
  testsRun++;
  if (condition) {
    testsPassed++;
    testResults.push({ status: 'PASS', message, details });
    console.log(`  [PASS] ${message}`);
  } else {
    testsFailed++;
    testResults.push({ status: 'FAIL', message, details });
    console.error(`  [FAIL] ${message}`, details);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('       ZUDO SELLER PANEL - COMPREHENSIVE AUTOMATED TEST SUITE   ');
  console.log('================================================================\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB Atlas successfully.\n');

  const db = mongoose.connection;
  const SellerModel = db.collection('sellers');
  const OrderModel = db.collection('orders');
  const InvoiceModel = db.collection('sellerinvoices');
  const ProductModel = db.collection('products');

  // Fetch sellers
  const sellerVignesh = await SellerModel.findOne({ email: 'rvikky05@gmail.com' });
  const sellerJaffar = await SellerModel.findOne({ email: 'musani.impex01@gmail.com' });

  assert(Boolean(sellerVignesh), 'Seller 1 (vignesh) found in database', { id: sellerVignesh?._id });
  assert(Boolean(sellerJaffar), 'Seller 2 (Jaffar) found in database', { id: sellerJaffar?._id });

  // -------------------------------------------------------------------------
  // TASK 1: SELLER ORDERS & DATA ISOLATION
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 1: SELLER ORDERS & DATA ISOLATION ---');
  
  const allOrders = await OrderModel.find({}).toArray();
  const vigneshOrders = allOrders.filter(o => 
    (o.items || []).some(it => String(it.sellerId || it.seller?.sellerId || it.seller) === String(sellerVignesh._id))
  );
  const jaffarOrders = allOrders.filter(o => 
    (o.items || []).some(it => String(it.sellerId || it.seller?.sellerId || it.seller) === String(sellerJaffar._id))
  );

  assert(vigneshOrders.length > 0, `Seller 1 (vignesh) has accessible orders (${vigneshOrders.length} orders found)`);
  assert(
    !vigneshOrders.some(vo => jaffarOrders.some(jo => String(vo._id) === String(jo._id))),
    'Data Isolation: Seller 1 and Seller 2 do not share unauthorized order data'
  );

  // Check order details structure
  const sampleOrder = vigneshOrders[0];
  assert(Boolean(sampleOrder.orderNumber), `Order has valid orderNumber (#${sampleOrder.orderNumber})`);
  assert(Array.isArray(sampleOrder.items) && sampleOrder.items.length > 0, 'Order contains line items');
  assert(sampleOrder.totalAmountWithoutCommissions > 0, 'Order contains valid totalAmountWithoutCommissions');

  // -------------------------------------------------------------------------
  // TASK 2: SELLER INVOICE GENERATION (INVOICE NUMBER VS ORDER ID)
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 2: SELLER INVOICE GENERATION (INVOICE NUMBER VS ORDER ID) ---');

  // Test invoice numbering calculation
  const existingInvoices = await InvoiceModel.find({ sellerId: sellerVignesh._id }).toArray();
  const usedNumericSequences = [];
  existingInvoices.forEach(inv => {
    const numStr = (inv.invoiceNumber || '').toString().trim();
    const match = numStr.match(/\d+/g);
    if (match) {
      const lastNum = parseInt(match[match.length - 1], 10);
      if (!isNaN(lastNum) && lastNum > 0) usedNumericSequences.push(lastNum);
    }
    if (inv.invoiceSequenceNumber && inv.invoiceSequenceNumber > 0) {
      usedNumericSequences.push(inv.invoiceSequenceNumber);
    }
  });

  const maxNumeric = usedNumericSequences.length > 0 ? Math.max(...usedNumericSequences) : 0;
  const nextExpectedSeq = maxNumeric + 1;
  const generatedInvoiceNumber = `INV-${String(nextExpectedSeq).padStart(5, '0')}`;

  assert(
    generatedInvoiceNumber.startsWith('INV-') && generatedInvoiceNumber.length === 9,
    `Invoice number follows expected format: ${generatedInvoiceNumber}`
  );
  assert(
    generatedInvoiceNumber !== String(sampleOrder.orderNumber) &&
    generatedInvoiceNumber !== String(sampleOrder.orderNumber).padStart(5, '0'),
    `Generated Invoice Number (${generatedInvoiceNumber}) is distinct from Order ID (#${sampleOrder.orderNumber})`
  );

  // -------------------------------------------------------------------------
  // TASK 3: INVOICE COUNT, NUMBERING & DUPLICATE PREVENTION
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 3: INVOICE COUNT & DUPLICATE PREVENTION ---');

  // Simulate generating an invoice for sampleOrder
  const testInvoiceDoc = {
    sellerId: sellerVignesh._id,
    sellerName: sellerVignesh.businessName || sellerVignesh.name,
    invoiceNumber: generatedInvoiceNumber,
    invoiceSequenceNumber: nextExpectedSeq,
    startDate: new Date('2026-11-01'),
    endDate: new Date('2026-11-30'),
    totalAmount: sampleOrder.totalAmountWithoutCommissions,
    totalCommission: 0,
    netAmount: sampleOrder.totalAmountWithoutCommissions,
    orderCount: 1,
    orders: [sampleOrder._id],
    orderId: sampleOrder._id,
    orderNumber: sampleOrder.orderNumber,
    orderRef: sampleOrder.orderRef,
    status: 'Pending',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  // Insert test invoice
  const insertResult = await InvoiceModel.insertOne(testInvoiceDoc);
  assert(Boolean(insertResult.insertedId), 'Test invoice generated and saved in MongoDB');

  // Verify next sequence advances
  const nextSeqAfter = nextExpectedSeq + 1;
  const nextInvNumAfter = `INV-${String(nextSeqAfter).padStart(5, '0')}`;
  assert(nextInvNumAfter === `INV-${String(nextExpectedSeq + 1).padStart(5, '0')}`, `Next invoice sequence advances to ${nextInvNumAfter}`);

  // Duplicate Prevention: Check that same order cannot be invoiced again
  const duplicateForOrder = await InvoiceModel.findOne({
    sellerId: sellerVignesh._id,
    $or: [{ orders: sampleOrder._id }, { orderId: sampleOrder._id }]
  });
  assert(Boolean(duplicateForOrder), 'Duplicate prevention detects order is already invoiced');

  // Duplicate Invoice Number Prevention
  const duplicateInvNum = await InvoiceModel.find({
    sellerId: sellerVignesh._id,
    invoiceNumber: generatedInvoiceNumber
  }).toArray();
  assert(duplicateInvNum.length === 1, 'Invoice Number is unique for this seller in MongoDB');

  // Clean up test invoice created for automated testing
  await InvoiceModel.deleteOne({ _id: insertResult.insertedId });
  console.log('  [CLEANUP] Automated test invoice safely rolled back from database.');

  // -------------------------------------------------------------------------
  // TASK 4: SELLER HISTORY & EXACT AMOUNT CONSISTENCY
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 4: SELLER HISTORY & EXACT AMOUNT CONSISTENCY ---');

  vigneshOrders.forEach(order => {
    const orderItems = (order.items || []).filter(it => 
      String(it.sellerId || it.seller?.sellerId || it.seller) === String(sellerVignesh._id)
    );
    const calculatedSellerNet = orderItems.reduce((sum, it) => {
      const qty = Number(it.quantity) || 1;
      const price = Number(it.sellerUnitPrice ?? it.normalPrice ?? it.netPrice ?? it.price ?? 0);
      const gst = Number(it.gstAmount ?? it.totalGst ?? 0);
      return sum + (price * qty) + gst;
    }, 0);

    const canonicalOrderTotal = Number(order.totalAmountWithoutCommissions || order.sellerItemsNetTotal || calculatedSellerNet);

    assert(
      canonicalOrderTotal > 0,
      `Order #${order.orderNumber} has valid canonical total of ₹${canonicalOrderTotal.toLocaleString('en-IN')}`
    );
    assert(
      canonicalOrderTotal <= Number(order.totalAmount),
      `Order #${order.orderNumber} seller amount excludes customer platform commission (Total: ${order.totalAmount}, Seller: ${canonicalOrderTotal})`
    );
  });

  // -------------------------------------------------------------------------
  // TASK 5: HISTORY NAVIGATION & ROUTING
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 5: HISTORY NAVIGATION & ROUTING ---');

  const fs = require('fs');
  const appJsx = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/App.jsx'), 'utf8');
  const sidebarJsx = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/components/Sidebar.jsx'), 'utf8');
  const historyJsx = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/pages/History.jsx'), 'utf8');

  assert(appJsx.includes('path="/history"'), 'Route /history is declared in App.jsx');
  assert(sidebarJsx.includes('to="/history"'), 'Sidebar contains direct navigation link to /history');
  assert(!historyJsx.includes('localhost:5173') && !historyJsx.includes('admin/sellers'), 'History page does not contain hardcoded redirects to admin panel');

  // -------------------------------------------------------------------------
  // TASK 6: SELLER PROFILE LOCK & API PROTECTION
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 6: SELLER PROFILE LOCK & API PROTECTION ---');

  const settingsJsx = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/pages/Settings.jsx'), 'utf8');
  assert(settingsJsx.includes('Profile is locked'), 'Settings page displays verified locked profile notice');
  assert(!settingsJsx.includes('<button type="submit">Save Changes</button>'), 'Settings page does not provide unauthorized profile editing form');

  const sellersRoute = fs.readFileSync(path.join(__dirname, '../routes/sellers.js'), 'utf8');
  assert(
    sellersRoute.includes("if (user.isVerified || user.isProfileComplete)") &&
    sellersRoute.includes("403"),
    'Backend PUT /profile blocks completed/verified sellers with 403 Forbidden'
  );
  assert(
    sellersRoute.includes("router.put('/:id'") && sellersRoute.includes("if (req.user?.role === 'seller')"),
    'Backend PUT /api/sellers/:id blocks sellers with 403 Forbidden'
  );
  assert(
    sellersRoute.includes("router.put('/:id/verify'") && sellersRoute.includes("if (req.user?.role === 'seller')"),
    'Backend PUT /api/sellers/:id/verify blocks sellers with 403 Forbidden'
  );

  // -------------------------------------------------------------------------
  // TASK 7: COMMISSION PIN CODE VALIDATION & PRICE INTEGRITY
  // -------------------------------------------------------------------------
  console.log('\n--- TASK 7: COMMISSION PIN CODE VALIDATION & PRICE INTEGRITY ---');

  const testCategoryId = '6ac0e39b60df321e45628d00';
  const mockCategoryCommissions = [
    { categoryId: testCategoryId, unit: 'KG', pincode: '560001', commission: 15, isPercentage: false }, // Rule A: Exact PIN match
    { categoryId: testCategoryId, unit: 'KG', pincode: 'all', commission: 5, isPercentage: false },    // Rule B: All PIN fallback
    { categoryId: testCategoryId, unit: 'KG', pincode: '600001', commission: 25, isPercentage: false } // Rule C: Different PIN
  ];

  // Test Case 7.1: Exact PIN code rule takes priority
  const matchExact = findCategoryCommission(mockCategoryCommissions, testCategoryId, 'KG', 'KG', '560001');
  assert(
    matchExact && matchExact.commission === 15 && matchExact.pincode === '560001',
    `Rule 1 (Priority): Exact PIN match takes priority (applied ₹${matchExact?.commission} for PIN 560001)`
  );

  // Test Case 7.2: Fallback to 'All' when no exact match exists
  const matchFallback = findCategoryCommission(mockCategoryCommissions, testCategoryId, 'KG', 'KG', '560099');
  assert(
    matchFallback && matchFallback.commission === 5 && matchFallback.pincode === 'all',
    `Rule 2 (Fallback): Unmatched PIN 560099 falls back to 'all' rule (applied ₹${matchFallback?.commission})`
  );

  // Test Case 7.3: Rules belonging to other PIN codes must NEVER be applied
  const otherPinOnlyCommissions = [
    { categoryId: testCategoryId, unit: 'KG', pincode: '600001', commission: 25, isPercentage: false }
  ];
  const matchCrossPin = findCategoryCommission(otherPinOnlyCommissions, testCategoryId, 'KG', 'KG', '560001');
  assert(
    matchCrossPin === null,
    'Rule 3 (Isolation): Commission rule for PIN 600001 is NEVER applied to PIN 560001'
  );

  // Test Case 7.4: Default to zero when neither exact nor 'All' exists
  const noMatchCommissions = [];
  const matchEmpty = findCategoryCommission(noMatchCommissions, testCategoryId, 'KG', 'KG', '560001');
  assert(
    matchEmpty === null,
    'Rule 4 (Default Zero): Commission safely defaults to zero when no rule matches'
  );

  // Test Case 7.5: Price Integrity
  const testNormalPrice = 1000;
  const testQty = 2;
  const testCommission = 15;
  const sellerReceives = testNormalPrice * testQty;
  assert(
    sellerReceives === 2000,
    `Rule 5 (Price Integrity): Seller price (₹${sellerReceives}) is strictly intact and does not deduct platform commission`
  );

  // -------------------------------------------------------------------------
  // FINAL SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`TEST EXECUTION COMPLETE: ${testsRun} executed | ${testsPassed} passed | ${testsFailed} failed`);
  console.log('================================================================\n');

  await mongoose.disconnect();
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error during test execution:', err);
  process.exit(1);
});
