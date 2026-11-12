const mongoose = require('mongoose');
require('dotenv').config();
const {
  calculatePricingBreakdown,
  calculateCustomerPrice,
  processProductPricing,
  applyCommission,
  convertMeasurement,
  round2
} = require('./utils/pricing');
const Order = require('./models/Order');
const Product = require('./models/Product');
const Commission = require('./models/Commission');

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING PRODUCT MEASUREMENT-BASED COMMISSION TEST SUITE');
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

  // ========================================================================
  // TEST A – One 30 KG Bag (Method A: Seller ₹50/KG, Commission ₹20/KG, Qty 1)
  // ========================================================================
  console.log('Test A: One 30 KG Bag (Method A: ₹50/KG, Admin ₹20/KG, Qty 1)');
  const testA = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 1,
    gstPercent: 0
  });

  assert(testA.unitSize === 30, `Product Unit Size is 30 KG (got ${testA.unitSize})`);
  assert(testA.sellerPricePerBaseUnit === 50, `Seller Price / KG is ₹50 (got ${testA.sellerPricePerBaseUnit})`);
  assert(testA.sellerPricePerPackage === 1500, `Seller Price Per Bag (50 * 30) is ₹1,500 (got ${testA.sellerPricePerPackage})`);
  assert(testA.commissionPerPackage === 600, `Admin Commission Per Bag (20 * 30) is ₹600 (got ${testA.commissionPerPackage})`);
  assert(testA.customerUnitBasePrice === 2100, `Customer Base Price (1500 + 600) is ₹2,100 (got ${testA.customerUnitBasePrice})`);
  assert(testA.totalSellerAmount === 1500, `Total Seller Amount for Qty 1 is ₹1,500 (got ${testA.totalSellerAmount})`);
  assert(testA.totalCommission === 600, `Total Commission for Qty 1 is ₹600 (got ${testA.totalCommission})`);
  assert(testA.subtotal === 2100, `Subtotal Before GST is ₹2,100 (got ${testA.subtotal})`);
  assert(testA.finalCustomerAmount === 2100, `Final Customer Amount is ₹2,100 (got ${testA.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST B – Two 30 KG Bags (Method A: Seller ₹50/KG, Commission ₹20/KG, Qty 2)
  // ========================================================================
  console.log('Test B: Two 30 KG Bags (Method A: ₹50/KG, Admin ₹20/KG, Qty 2)');
  const testB = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 2,
    gstPercent: 0
  });

  assert(testB.totalMeasurementQuantity === 60, `Total Weight (30 * 2) is 60 KG (got ${testB.totalMeasurementQuantity})`);
  assert(testB.sellerPricePerPackage === 1500, `Seller Price Per Bag is ₹1,500 (got ${testB.sellerPricePerPackage})`);
  assert(testB.commissionPerPackage === 600, `Commission Per Bag is ₹600 (got ${testB.commissionPerPackage})`);
  assert(testB.totalSellerAmount === 3000, `Total Seller Amount (1500 * 2) is ₹3,000 (got ${testB.totalSellerAmount})`);
  assert(testB.totalCommission === 1200, `Total Commission (600 * 2) is ₹1,200 (got ${testB.totalCommission})`);
  assert(testB.subtotal === 4200, `Subtotal Before GST (3000 + 1200) is ₹4,200 (got ${testB.subtotal})`);
  assert(testB.finalCustomerAmount === 4200, `Final Customer Amount is ₹4,200 (got ${testB.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST C – Five 30 KG Bags (Method A: Seller ₹50/KG, Commission ₹20/KG, Qty 5)
  // ========================================================================
  console.log('Test C: Five 30 KG Bags (Method A: ₹50/KG, Admin ₹20/KG, Qty 5)');
  const testC = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 5,
    gstPercent: 0
  });

  assert(testC.totalMeasurementQuantity === 150, `Total Weight (30 * 5) is 150 KG (got ${testC.totalMeasurementQuantity})`);
  assert(testC.totalSellerAmount === 7500, `Total Seller Amount (1500 * 5) is ₹7,500 (got ${testC.totalSellerAmount})`);
  assert(testC.totalCommission === 3000, `Total Commission (600 * 5) is ₹3,000 (got ${testC.totalCommission})`);
  assert(testC.subtotal === 10500, `Subtotal Before GST (7500 + 3000) is ₹10,500 (got ${testC.subtotal})`);
  assert(testC.finalCustomerAmount === 10500, `Final Customer Amount is ₹10,500 (got ${testC.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST D – Different Variants (Admin Commission: ₹20/KG)
  // Small Bag (10 KG) -> ₹200 commission
  // Medium Bag (20 KG) -> ₹400 commission
  // Large Bag (30 KG) -> ₹600 commission
  // ========================================================================
  console.log('Test D: Different Variants (Admin Commission: ₹20/KG)');
  const smallBag = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    unitSize: 10,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 1
  });
  assert(smallBag.commissionPerPackage === 200, `Small Bag (10 KG) commission per package is ₹200 (got ${smallBag.commissionPerPackage})`);
  assert(smallBag.sellerPricePerPackage === 500, `Small Bag (10 KG) seller price per package is ₹500 (got ${smallBag.sellerPricePerPackage})`);

  const mediumBag = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    unitSize: 20,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 1
  });
  assert(mediumBag.commissionPerPackage === 400, `Medium Bag (20 KG) commission per package is ₹400 (got ${mediumBag.commissionPerPackage})`);
  assert(mediumBag.sellerPricePerPackage === 1000, `Medium Bag (20 KG) seller price per package is ₹1,000 (got ${mediumBag.sellerPricePerPackage})`);

  const largeBag = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 1
  });
  assert(largeBag.commissionPerPackage === 600, `Large Bag (30 KG) commission per package is ₹600 (got ${largeBag.commissionPerPackage})`);
  assert(largeBag.sellerPricePerPackage === 1500, `Large Bag (30 KG) seller price per package is ₹1,500 (got ${largeBag.sellerPricePerPackage})`);
  console.log();

  // ========================================================================
  // TEST E – Complete Package Price (Method B: Seller enters ₹1,500 directly)
  // ========================================================================
  console.log('Test E: Complete Package Price (Method B: Seller enters ₹1,500 directly for 30 KG Bag)');
  const testE = calculatePricingBreakdown({
    sellerPrice: 1500,
    priceBasis: 'per_package',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 1
  });

  assert(testE.sellerPricePerPackage === 1500, `Seller Price Per Bag is ₹1,500 without multiplying by 30 (got ${testE.sellerPricePerPackage})`);
  assert(testE.sellerPricePerBaseUnit === 50, `Derived Seller Price Per KG (1500 / 30) is ₹50 (got ${testE.sellerPricePerBaseUnit})`);
  assert(testE.commissionPerPackage === 600, `Commission Per Bag is ₹600 (got ${testE.commissionPerPackage})`);
  assert(testE.customerUnitBasePrice === 2100, `Customer Base Price is ₹2,100 (got ${testE.customerUnitBasePrice})`);
  assert(testE.subtotal === 2100, `Subtotal Before GST is ₹2,100 (got ${testE.subtotal})`);

  // Ordered Qty 2 with Complete Package Price
  const testE2 = calculatePricingBreakdown({
    sellerPrice: 1500,
    priceBasis: 'per_package',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    quantity: 2
  });
  assert(testE2.totalSellerAmount === 3000, `Qty 2 Total Seller Amount (1500 * 2) is ₹3,000 (got ${testE2.totalSellerAmount})`);
  assert(testE2.totalCommission === 1200, `Qty 2 Total Commission (600 * 2) is ₹1,200 (got ${testE2.totalCommission})`);
  assert(testE2.subtotal === 4200, `Qty 2 Subtotal Before GST is ₹4,200 (got ${testE2.subtotal})`);
  console.log();

  // ========================================================================
  // TEST F – Unit Conversion (KG, Gram, Ton conversions)
  // ========================================================================
  console.log('Test F: Unit Conversion (KG, Gram, Ton conversions)');
  // 1 Ton = 1000 KG. Commission ₹20/KG. 1 Ton should yield ₹20,000 commission.
  const tonProduct = calculatePricingBreakdown({
    sellerUnitPrice: 50000,
    priceBasis: 'per_package',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'ton',
    measurementUnit: 'ton',
    commissionUnit: 'kg',
    unitSize: 1, // 1 Ton
    commissionType: 'flat',
    commissionValue: 20, // ₹20 per KG
    quantity: 1
  });
  assert(tonProduct.commissionPerPackage === 20000, `1 Ton at ₹20/KG yields ₹20,000 commission (got ${tonProduct.commissionPerPackage})`);

  // 500 Grams = 0.5 KG. Commission ₹20/KG. 500 Grams should yield ₹10 commission.
  const gramProduct = calculatePricingBreakdown({
    sellerUnitPrice: 30,
    priceBasis: 'per_package',
    unit: 'PACK',
    packagingType: 'PACK',
    measurementBasis: 'g',
    measurementUnit: 'g',
    commissionUnit: 'kg',
    unitSize: 500, // 500 Grams
    commissionType: 'flat',
    commissionValue: 20, // ₹20 per KG
    quantity: 1
  });
  assert(gramProduct.commissionPerPackage === 10, `500 Grams at ₹20/KG yields ₹10 commission (got ${gramProduct.commissionPerPackage})`);

  // 1 Litre = 1000 ML. Commission ₹5/Litre. 200 ML should yield ₹1 commission.
  const mlProduct = calculatePricingBreakdown({
    sellerUnitPrice: 50,
    priceBasis: 'per_package',
    unit: 'BOTTLE',
    packagingType: 'BOTTLE',
    measurementBasis: 'ml',
    measurementUnit: 'ml',
    commissionUnit: 'ltr',
    unitSize: 200, // 200 ML
    commissionType: 'flat',
    commissionValue: 5, // ₹5 per Litre
    quantity: 1
  });
  assert(mlProduct.commissionPerPackage === 1, `200 ML at ₹5/Litre yields ₹1 commission (got ${mlProduct.commissionPerPackage})`);
  console.log();

  // ========================================================================
  // TEST G – Exact 17 Snapshot Fields Contract
  // ========================================================================
  console.log('Test G: Exact 17 Order Pricing Snapshot Fields Contract');
  const snap = calculatePricingBreakdown({
    sellerPrice: 50,
    priceBasis: 'per_unit',
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    commissionUnit: 'KG',
    unitSize: 30,
    commissionType: 'flat',
    commissionValue: 20,
    orderedQuantity: 2,
    gstPercent: 5
  });

  assert(snap.packagingType === 'BAG', `packagingType is 'BAG' (got ${snap.packagingType})`);
  assert(snap.measurementBasis === 'KG', `measurementBasis is 'KG' (got ${snap.measurementBasis})`);
  assert(snap.productUnitSize === 30, `productUnitSize is 30 (got ${snap.productUnitSize})`);
  assert(snap.sellerPriceBasis === 'per_unit', `sellerPriceBasis is 'per_unit' (got ${snap.sellerPriceBasis})`);
  assert(snap.sellerPricePerPackage === 1500, `sellerPricePerPackage is 1500 (got ${snap.sellerPricePerPackage})`);
  assert(snap.adminCommissionRate === 20, `adminCommissionRate is 20 (got ${snap.adminCommissionRate})`);
  assert(snap.commissionMeasurementUnit === 'KG', `commissionMeasurementUnit is 'KG' (got ${snap.commissionMeasurementUnit})`);
  assert(snap.commissionPerPackage === 600, `commissionPerPackage is 600 (got ${snap.commissionPerPackage})`);
  assert(snap.orderedQuantity === 2, `orderedQuantity is 2 (got ${snap.orderedQuantity})`);
  assert(snap.totalMeasurementQuantity === 60, `totalMeasurementQuantity is 60 (got ${snap.totalMeasurementQuantity})`);
  assert(snap.totalSellerAmount === 3000, `totalSellerAmount is 3000 (got ${snap.totalSellerAmount})`);
  assert(snap.totalCommission === 1200, `totalCommission is 1200 (got ${snap.totalCommission})`);
  assert(snap.gstRate === 5, `gstRate is 5 (got ${snap.gstRate})`);
  assert(snap.gstAmount === 210, `gstAmount is 210 (got ${snap.gstAmount})`);
  assert(snap.finalCustomerAmount === 4410, `finalCustomerAmount is 4410 (got ${snap.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST H – Real MongoDB Product and Order Creation with Snapshot
  // ========================================================================
  console.log('Test H: Real MongoDB Product and Order Creation with Snapshot');
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    const conn = await mongoose.createConnection(mongoUri).asPromise();
    const MongoProduct = conn.models.Product || conn.model('Product', Product.schema);
    const MongoOrder = conn.models.Order || conn.model('Order', Order.schema);

    // Create a real test rice product
    const testRiceDoc = await MongoProduct.create({
      name: 'TEST RICE 30KG COMMISSION SUITE',
      categoryId: new mongoose.Types.ObjectId('6abf84deb66fc9916f480b0e'),
      packagingType: 'BAG',
      unit: 'BAG',
      measurementBasis: 'KG',
      measurementUnit: 'KG',
      unitSize: 30,
      priceBasis: 'per_unit',
      sellerPrice: 50,
      sellerPricePerBaseUnit: 50,
      sellerPricePerProductUnit: 1500,
      adminCommissionPerBaseUnit: 20,
      commissionPerProductUnit: 600,
      customerUnitBasePrice: 2100,
      price: 2100,
      b2bPrice: 2100,
      stock: 100,
      gstPercent: 0,
      isProductVisible: true,
      b2b: [
        {
          packetSize: 'Small Bag 10KG',
          sizeName: 'Small Bag',
          packagingType: 'BAG',
          measurementBasis: 'KG',
          measurementUnit: 'KG',
          unitSize: 10,
          priceBasis: 'per_unit',
          sellerPrice: 500,
          sellerPricePerBaseUnit: 50,
          sellerPricePerProductUnit: 500,
          adminCommissionPerBaseUnit: 20,
          commissionPerProductUnit: 200,
          customerUnitBasePrice: 700,
          price: 700,
          stock: 50,
          gstPercent: 0
        }
      ]
    });

    console.log(`  Created test rice product: ${testRiceDoc._id}`);

    // Create an order for 2 Bags (30 KG each)
    const orderData = calculatePricingBreakdown({
      sellerPrice: testRiceDoc.sellerPricePerBaseUnit,
      priceBasis: 'per_unit',
      packagingType: 'BAG',
      measurementBasis: 'KG',
      unitSize: 30,
      commissionType: 'flat',
      commissionValue: 20,
      orderedQuantity: 2,
      gstPercent: 0
    });

    const testOrder = await MongoOrder.create({
      userId: new mongoose.Types.ObjectId(),
      type: 'b2b',
      items: [{
        productId: testRiceDoc._id,
        variantSize: null,
        name: testRiceDoc.name,
        quantity: 2,
        orderedQuantity: 2,
        packagingType: orderData.packagingType,
        measurementBasis: orderData.measurementBasis,
        productUnitSize: orderData.unitSize,
        unitSize: orderData.unitSize,
        sellerPriceBasis: orderData.sellerPriceBasis,
        sellerPricePerBaseUnit: orderData.sellerPricePerBaseUnit,
        sellerPricePerPackage: orderData.sellerPricePerPackage,
        sellerPricePerProductUnit: orderData.sellerPricePerProductUnit,
        adminCommissionRate: orderData.adminCommissionRate,
        adminCommissionPerBaseUnit: orderData.adminCommissionPerBaseUnit,
        commissionMeasurementUnit: orderData.commissionMeasurementUnit,
        commissionPerPackage: orderData.commissionPerPackage,
        commissionPerProductUnit: orderData.commissionPerProductUnit,
        totalMeasurementQuantity: orderData.totalMeasurementQuantity,
        totalSellerAmount: orderData.totalSellerAmount,
        totalSellerPrice: orderData.totalSellerAmount,
        totalCommission: orderData.totalCommission,
        subtotal: orderData.subtotal,
        gstRate: orderData.gstRate,
        gstPercent: orderData.gstPercent,
        gstAmount: orderData.totalGst,
        totalGst: orderData.totalGst,
        finalCustomerAmount: orderData.finalCustomerAmount,
        finalCustomerPrice: orderData.finalCustomerAmount,
        price: orderData.unitCustomerPrice,
        unitCustomerPrice: orderData.unitCustomerPrice,
        customerUnitBasePrice: orderData.customerUnitBasePrice,
        normalPrice: orderData.sellerPricePerPackage,
        sellerUnitPrice: orderData.sellerPricePerPackage
      }],
      totalAmount: orderData.finalCustomerAmount,
      totalAmountWithoutCommissions: orderData.totalSellerAmount + orderData.totalGst,
      totalCommissionAmount: orderData.totalCommission,
      totalGstAmount: orderData.totalGst,
      shippingAddress: { address: '123 Market St', city: 'Bengaluru', pincode: '560001' },
      paymentMethod: 'COD',
      orderStatus: 'Pending'
    });

    console.log(`  Saved test order: ${testOrder._id}`);

    // Retrieve order and verify immutable snapshot
    const retrieved = await MongoOrder.findById(testOrder._id).lean();
    const item = retrieved.items[0];

    assert(item.packagingType === 'BAG', `Saved packagingType is BAG (got ${item.packagingType})`);
    assert(item.measurementBasis === 'KG', `Saved measurementBasis is KG (got ${item.measurementBasis})`);
    assert(item.productUnitSize === 30, `Saved productUnitSize is 30 (got ${item.productUnitSize})`);
    assert(item.sellerPriceBasis === 'per_unit', `Saved sellerPriceBasis is 'per_unit' (got ${item.sellerPriceBasis})`);
    assert(item.sellerPricePerPackage === 1500, `Saved sellerPricePerPackage is 1500 (got ${item.sellerPricePerPackage})`);
    assert(item.adminCommissionRate === 20, `Saved adminCommissionRate is 20 (got ${item.adminCommissionRate})`);
    assert(item.commissionPerPackage === 600, `Saved commissionPerPackage is 600 (got ${item.commissionPerPackage})`);
    assert(item.totalMeasurementQuantity === 60, `Saved totalMeasurementQuantity is 60 (got ${item.totalMeasurementQuantity})`);
    assert(item.totalSellerAmount === 3000, `Saved totalSellerAmount is 3000 (got ${item.totalSellerAmount})`);
    assert(item.totalCommission === 1200, `Saved totalCommission is 1200 (got ${item.totalCommission})`);
    assert(retrieved.totalCommissionAmount === 1200, `Order totalCommissionAmount is 1200 (got ${retrieved.totalCommissionAmount})`);
    assert(retrieved.totalAmount === 4200, `Order totalAmount is 4200 (got ${retrieved.totalAmount})`);

    // Clean up
    await MongoProduct.findByIdAndDelete(testRiceDoc._id);
    await MongoOrder.findByIdAndDelete(testOrder._id);
    console.log('  Cleaned up MongoDB test documents.');
    await conn.close();
  } catch (err) {
    console.error('  [ERROR] MongoDB test failed:', err);
    process.exitCode = 1;
  }

  console.log('\n================================================================');
  console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    console.log('>>> ALL MANDATORY TEST CASES (A, B, C, D, E, F, G, H) PASSED WITH 100% SUCCESS! <<<');
  } else {
    console.error('SOME TESTS FAILED!');
    process.exit(1);
  }
}

runTests();

