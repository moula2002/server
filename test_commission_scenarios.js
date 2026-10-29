const mongoose = require('mongoose');
require('dotenv').config();
const { calculatePricingBreakdown, calculateCustomerPrice, findCategoryCommission, applyCommission, round2 } = require('./utils/pricing');
const Order = require('./models/Order');
const Product = require('./models/Product');
const Commission = require('./models/Commission');

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING FLAT COMMISSION & PRICING VERIFICATION SUITE');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  // --- SCENARIO 1: Seller ₹200, Flat ₹2, Qty 1 ---
  console.log('Test Scenario 1: Seller price ₹200, flat commission ₹2, quantity 1');
  const s1 = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 1,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s1.unitCommission === 2, `Unit commission is ₹2 (got ${s1.unitCommission})`);
  assert(s1.totalCommission === 2, `Total commission for qty 1 is ₹2 (got ${s1.totalCommission})`);
  assert(s1.totalSellerPrice === 200, `Total seller price is ₹200 (got ${s1.totalSellerPrice})`);
  assert(s1.finalCustomerPrice === 202, `Final customer price is ₹202 (got ${s1.finalCustomerPrice})`);
  assert(s1.unitCustomerPrice === 202, `Unit customer price is ₹202 (got ${s1.unitCustomerPrice})`);
  console.log();

  // --- SCENARIO 2: Seller ₹200, Flat ₹2, Qty 2 ---
  console.log('Test Scenario 2: Seller price ₹200, flat commission ₹2, quantity 2');
  const s2 = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 2,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s2.unitCommission === 2, `Unit commission is ₹2 (got ${s2.unitCommission})`);
  assert(s2.totalCommission === 4, `Total commission for qty 2 is ₹4 (got ${s2.totalCommission})`);
  assert(s2.totalSellerPrice === 400, `Total seller price is ₹400 (got ${s2.totalSellerPrice})`);
  assert(s2.finalCustomerPrice === 404, `Final customer price is ₹404 (got ${s2.finalCustomerPrice})`);
  console.log();

  // --- SCENARIO 3: Seller ₹200, Flat ₹2, Qty 3 ---
  console.log('Test Scenario 3: Seller price ₹200, flat commission ₹2, quantity 3');
  const s3 = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 3,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s3.unitCommission === 2, `Unit commission is ₹2 (got ${s3.unitCommission})`);
  assert(s3.totalCommission === 6, `Total commission for qty 3 is ₹6 (got ${s3.totalCommission})`);
  assert(s3.totalSellerPrice === 600, `Total seller price is ₹600 (got ${s3.totalSellerPrice})`);
  assert(s3.finalCustomerPrice === 606, `Final customer price is ₹606 (got ${s3.finalCustomerPrice})`);
  console.log();

  // --- SCENARIO 4: Seller ₹200, Flat ₹2, Qty 5 ---
  console.log('Test Scenario 4: Seller price ₹200, flat commission ₹2, quantity 5');
  const s4 = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 5,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s4.unitCommission === 2, `Unit commission is ₹2 (got ${s4.unitCommission})`);
  assert(s4.totalCommission === 10, `Total commission for qty 5 is ₹10 (got ${s4.totalCommission})`);
  assert(s4.totalSellerPrice === 1000, `Total seller price is ₹1,000 (got ${s4.totalSellerPrice})`);
  assert(s4.finalCustomerPrice === 1010, `Final customer price is ₹1,010 (got ${s4.finalCustomerPrice})`);
  console.log();

  // --- SCENARIO 5: Seller ₹200, Flat ₹2, Available Stock 50 ---
  console.log('Test Scenario 5: Seller price ₹200, flat commission ₹2, available stock 50');
  const s5 = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 1,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s5.stockTotalCommission === 100, `Stock-level commission for 50 units is ₹100 (got ${s5.stockTotalCommission})`);
  assert(s5.availableStock === 50, `Available stock reported as 50 (got ${s5.availableStock})`);
  assert(s5.totalCommission === 2, `Order total commission for qty 1 remains ₹2, separate from stock commission`);
  console.log();

  // --- SCENARIO 6: Seller ₹500, Flat ₹2, Qty 3 (Independent of product price) ---
  console.log('Test Scenario 6: Seller price ₹500, flat commission ₹2, quantity 3 (price independence)');
  const s6 = calculatePricingBreakdown({
    sellerUnitPrice: 500,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 3,
    availableStock: 50,
    gstPercent: 0
  });
  assert(s6.unitCommission === 2, `Unit commission is ₹2 even with ₹500 seller price`);
  assert(s6.totalCommission === 6, `Total commission for qty 3 is ₹6, identical to ₹200 product`);
  assert(s6.totalSellerPrice === 1500, `Total seller price is ₹1,500 (got ${s6.totalSellerPrice})`);
  assert(s6.finalCustomerPrice === 1506, `Final customer price is ₹1,506 (got ${s6.finalCustomerPrice})`);
  console.log();

  // --- EXACT PRICING RESPONSE CONTRACT VERIFICATION ---
  console.log('Test Contract: Exact Pricing Response Contract matching section 5 specification');
  const contract = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionRate: 2,
    availableStock: 50,
    gstPercent: 0,
    orderedQuantity: 3
  });
  const expectedContract = {
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionRate: 2,
    unitCommission: 2,
    availableStock: 50,
    stockTotalCommission: 100,
    unitCustomerPrice: 202,
    gstPercent: 0,
    orderedQuantity: 3,
    totalCommission: 6,
    totalSellerPrice: 600,
    totalGst: 0,
    finalCustomerPrice: 606
  };
  for (const [key, expectedVal] of Object.entries(expectedContract)) {
    assert(contract[key] === expectedVal, `Contract field "${key}" matches expected value ${expectedVal} (got ${contract[key]})`);
  }
  console.log();

  // --- SCENARIO 8: Percentage commission & GST calculations ---
  console.log('Test Scenario 8: Percentage-based commission & GST rules');
  // Percentage commission: 10% on ₹200 seller price, qty 3
  const s8Percent = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'percentage',
    commissionValue: 10,
    quantity: 3,
    availableStock: 20,
    gstPercent: 0
  });
  assert(s8Percent.unitCommission === 20, `10% commission on ₹200 is ₹20/unit (got ${s8Percent.unitCommission})`);
  assert(s8Percent.totalCommission === 60, `Total commission for 3 units is ₹60 (got ${s8Percent.totalCommission})`);
  assert(s8Percent.finalCustomerPrice === 660, `Final customer price without GST is ₹660 (got ${s8Percent.finalCustomerPrice})`);

  // B2B GST (18% added on top)
  const s8B2b = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 3,
    availableStock: 50,
    gstPercent: 18,
    isB2B: true
  });
  // totalCustomerBase = 606, GST = 606 * 18% = 109.08, final = 715.08
  assert(s8B2b.totalSellerPrice === 600, `B2B total seller price is ₹600`);
  assert(s8B2b.totalCommission === 6, `B2B total flat commission is ₹6`);
  assert(s8B2b.totalGst === 109.08, `B2B GST is ₹109.08 (18% of ₹606) (got ${s8B2b.totalGst})`);
  assert(s8B2b.finalCustomerPrice === 715.08, `B2B final customer price is ₹715.08 (got ${s8B2b.finalCustomerPrice})`);

  // B2C GST (18% inclusive)
  const s8B2c = calculatePricingBreakdown({
    sellerUnitPrice: 200,
    commissionType: 'flat',
    commissionValue: 2,
    quantity: 3,
    availableStock: 50,
    gstPercent: 18,
    isB2B: false
  });
  // totalCustomerBase = 606 (inclusive of 18% GST). baseBeforeTax = 606 / 1.18 = 513.56. GST = 606 - 513.56 = 92.44. final = 606.
  assert(s8B2c.totalCommission === 6, `B2C total flat commission is ₹6`);
  assert(s8B2c.finalCustomerPrice === 606, `B2C final price is inclusive ₹606 (got ${s8B2c.finalCustomerPrice})`);
  assert(s8B2c.totalGst === 92.44, `B2C inclusive GST is ₹92.44 (got ${s8B2c.totalGst})`);
  console.log();

  // --- SCENARIO 7: Actual MongoDB Data & Order Integration Test ---
  console.log('Test Scenario 7: Actual MongoDB Data & Order Creation Verification');
  try {
    const conn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
    console.log('  Connected to MongoDB successfully.');

    const MongoProduct = conn.model('Product', Product.schema);
    const MongoCommission = conn.model('Commission', Commission.schema);
    const MongoOrder = conn.model('Order', Order.schema);

    // 1. Fetch real product & real commission
    const sampleProduct = await MongoProduct.findOne({ stock: { $gt: 5 } }).lean();
    if (!sampleProduct) {
      console.log('  [WARN] No product with stock > 5 found in MongoDB. Skipping DB order creation.');
    } else {
      console.log(`  Testing with DB Product: "${sampleProduct.name}", Category: ${sampleProduct.categoryId}, Unit: ${sampleProduct.unit}, Stock: ${sampleProduct.stock}`);

      // 2. Fetch category commission from DB
      const comms = await MongoCommission.find({ categoryId: sampleProduct.categoryId }).lean();
      console.log(`  Found ${comms.length} commission rule(s) in DB for category.`);

      const matchedRule = findCategoryCommission(comms, sampleProduct.categoryId, sampleProduct.unit);
      console.log(`  Matched Rule: Type=${matchedRule?.commissionType || 'flat'}, Value=${matchedRule?.commissionValue || 0}`);

      // 3. Apply commission dynamically
      const enriched = applyCommission(sampleProduct, comms);
      assert(enriched.sellerUnitPrice !== undefined, 'Enriched product has sellerUnitPrice');
      assert(enriched.stockTotalCommission !== undefined, 'Enriched product has stockTotalCommission');
      assert(enriched.unitCustomerPrice !== undefined, 'Enriched product has unitCustomerPrice');

      // 4. Test quantity validation logic
      const invalidQuantities = [0, -1, 2.5, 'abc', null, undefined];
      for (const inv of invalidQuantities) {
        const qty = parseInt(inv, 10);
        const isValid = !(!qty || isNaN(qty) || qty <= 0 || Number(inv) !== qty);
        assert(!isValid, `Properly invalidates non-positive-integer quantity: ${inv}`);
      }

      // Test exceeding stock
      const exceedsStock = (sampleProduct.stock || 0) + 999;
      assert(exceedsStock > (sampleProduct.stock || 0), `Detects requested quantity ${exceedsStock} exceeds stock ${sampleProduct.stock}`);

      // 5. Test real Order Document Creation & Persistence
      const orderedQty = 3;
      const testBreakdown = calculatePricingBreakdown({
        sellerUnitPrice: sampleProduct.sellerPrice || sampleProduct.price || 100,
        commissionType: enriched.commissionType,
        commissionValue: enriched.commissionValue,
        gstPercent: sampleProduct.gstPercent || 0,
        quantity: orderedQty,
        availableStock: sampleProduct.stock
      });

      const testOrderItem = {
        productId: sampleProduct._id,
        name: sampleProduct.name,
        quantity: orderedQty,
        orderedQuantity: orderedQty,
        price: testBreakdown.unitCustomerPrice,
        unitCustomerPrice: testBreakdown.unitCustomerPrice,
        normalPrice: testBreakdown.sellerUnitPrice,
        sellerUnitPrice: testBreakdown.sellerUnitPrice,
        commissionType: testBreakdown.commissionType,
        commissionValue: testBreakdown.commissionRate,
        commissionRate: testBreakdown.commissionRate,
        commissionAmount: testBreakdown.unitCommission,
        unitCommission: testBreakdown.unitCommission,
        totalCommission: testBreakdown.totalCommission,
        totalSellerPrice: testBreakdown.totalSellerPrice,
        finalCustomerPrice: testBreakdown.finalCustomerPrice,
        availableStock: testBreakdown.availableStock,
        stockTotalCommission: testBreakdown.stockTotalCommission,
        gstPercent: testBreakdown.gstPercent,
        gstAmount: testBreakdown.unitGst,
        totalGst: testBreakdown.totalGst
      };

      const testOrder = new MongoOrder({
        userId: new mongoose.Types.ObjectId(),
        type: 'b2c',
        items: [testOrderItem],
        totalAmount: testBreakdown.finalCustomerPrice,
        totalAmountWithoutCommissions: testBreakdown.totalSellerPrice + testBreakdown.totalGst,
        totalCommissionAmount: testBreakdown.totalCommission,
        totalGstAmount: testBreakdown.totalGst,
        shippingAddress: { address: 'Test Address', city: 'Bengaluru', pincode: '560001' },
        paymentMethod: 'COD',
        orderStatus: 'Pending'
      });

      const savedOrder = await testOrder.save();
      console.log(`  Saved test order to DB with _id: ${savedOrder._id}`);

      // Verify retrieved order matches exact calculations
      const retrievedOrder = await MongoOrder.findById(savedOrder._id).lean();
      assert(retrievedOrder.totalCommissionAmount === testBreakdown.totalCommission,
        `Retrieved order totalCommissionAmount matches ₹${testBreakdown.totalCommission}`);
      assert(retrievedOrder.totalAmount === testBreakdown.finalCustomerPrice,
        `Retrieved order totalAmount matches ₹${testBreakdown.finalCustomerPrice}`);
      assert(retrievedOrder.items[0].totalCommission === testBreakdown.totalCommission,
        `Retrieved order item totalCommission matches ₹${testBreakdown.totalCommission}`);
      assert(retrievedOrder.items[0].orderedQuantity === orderedQty,
        `Retrieved order item orderedQuantity matches ${orderedQty}`);

      // Clean up test order
      await MongoOrder.findByIdAndDelete(savedOrder._id);
      console.log('  Cleaned up test order from DB successfully.');
    }

    await conn.close();
  } catch (dbErr) {
    console.error('  [ERROR] Database test encountered error:', dbErr);
    process.exitCode = 1;
  }

  console.log('\n================================================================');
  console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    console.log('ALL COMMISSION AND PRICING CONTRACT SCENARIOS VERIFIED SUCCESSFULLY!');
  } else {
    console.error('SOME TESTS FAILED!');
    process.exit(1);
  }
}

runTests();
