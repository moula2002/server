const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const {
  calculatePricingBreakdown,
  calculateCustomerPrice,
  processProductPricing,
  applyCommission,
  convertMeasurement,
  checkCommissionCompatibility,
  round2
} = require('./utils/pricing');
const Order = require('./models/Order');
const Product = require('./models/Product');
const Commission = require('./models/Commission');

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING SIMPLIFIED COMMISSION & PRODUCT PRICING TEST SUITE   ');
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
  // TEST CASE 1 – Without GST (Section 13)
  // Unit Size = 10 KG, Seller Unit Price = ₹100, Admin Commission = ₹5/KG, GST = 0%
  // ========================================================================
  console.log('Test Case 1 – Without GST:');
  const tc1 = calculatePricingBreakdown({
    sellerUnitPrice: 100,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 10,
    commissionType: 'flat',
    commissionValue: 5,
    quantity: 1,
    gstPercent: 0
  });

  assert(tc1.commissionPerProductUnit === 50, `Commission is ₹50 (got ${tc1.commissionPerProductUnit})`);
  assert(tc1.customerUnitBasePrice === 150, `Customer Base Price is ₹150 (got ${tc1.customerUnitBasePrice})`);
  assert(tc1.gstAmount === 0, `GST Amount is ₹0 (got ${tc1.gstAmount})`);
  assert(tc1.finalCustomerAmount === 150, `Final Price is ₹150 (got ${tc1.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST CASE 2 – With GST (Section 13)
  // Unit Size = 10 KG, Seller Unit Price = ₹100, Admin Commission = ₹5/KG, GST = 5%
  // ========================================================================
  console.log('Test Case 2 – With GST:');
  const tc2 = calculatePricingBreakdown({
    sellerUnitPrice: 100,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 10,
    commissionType: 'flat',
    commissionValue: 5,
    quantity: 1,
    gstPercent: 5
  });

  assert(tc2.commissionPerProductUnit === 50, `Commission is ₹50 (got ${tc2.commissionPerProductUnit})`);
  assert(tc2.customerUnitBasePrice === 150, `Customer Base Price is ₹150 (got ${tc2.customerUnitBasePrice})`);
  assert(tc2.gstAmount === 7.50, `GST Amount is ₹7.50 (got ${tc2.gstAmount})`);
  assert(tc2.finalCustomerAmount === 157.50, `Final Price is ₹157.50 (got ${tc2.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST CASE 3 – Multiple Quantity (Section 13 & Section 8)
  // Quantity = 3, Unit Size = 10 KG, Seller Unit Price = ₹100, Admin Commission = ₹5/KG, GST = 5%
  // ========================================================================
  console.log('Test Case 3 – Multiple Quantity (Quantity = 3):');
  const tc3 = calculatePricingBreakdown({
    sellerUnitPrice: 100,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 10,
    commissionType: 'flat',
    commissionValue: 5,
    quantity: 3,
    gstPercent: 5
  });

  assert(tc3.totalCommission === 150, `Total Commission (3 × 10 × 5) is ₹150 (got ${tc3.totalCommission})`);
  assert(tc3.totalSellerAmount === 300, `Seller Total Price (3 × 100) is ₹300 (got ${tc3.totalSellerAmount})`);
  assert(tc3.subtotal === 450, `Customer Base Price (300 + 150) is ₹450 (got ${tc3.subtotal})`);
  assert(tc3.totalGst === 22.50, `GST Amount (450 × 5%) is ₹22.50 (got ${tc3.totalGst})`);
  assert(tc3.finalCustomerAmount === 472.50, `Final Price (450 + 22.50) is ₹472.50 (got ${tc3.finalCustomerAmount})`);
  console.log();

  // ========================================================================
  // TEST SUITE 4 – Multiple Quantity Scaling (Section 8 Full Matrix)
  // ========================================================================
  console.log('Test Suite 4 – Multiple Quantity Matrix (1, 2, 3, 5 Packages):');
  const qMatrix = [
    { qty: 1, expComm: 50, expSeller: 100, expBase: 150, expGst: 7.50, expFinal: 157.50 },
    { qty: 2, expComm: 100, expSeller: 200, expBase: 300, expGst: 15.00, expFinal: 315.00 },
    { qty: 3, expComm: 150, expSeller: 300, expBase: 450, expGst: 22.50, expFinal: 472.50 },
    { qty: 5, expComm: 250, expSeller: 500, expBase: 750, expGst: 37.50, expFinal: 787.50 }
  ];

  qMatrix.forEach(row => {
    const res = calculatePricingBreakdown({
      sellerUnitPrice: 100,
      unit: 'BAG',
      packagingType: 'BAG',
      measurementBasis: 'KG',
      measurementUnit: 'KG',
      commissionUnit: 'KG',
      unitSize: 10,
      commissionType: 'flat',
      commissionValue: 5,
      quantity: row.qty,
      gstPercent: 5
    });

    assert(res.totalCommission === row.expComm, `Qty ${row.qty}: Total Commission is ₹${row.expComm} (got ${res.totalCommission})`);
    assert(res.totalSellerAmount === row.expSeller, `Qty ${row.qty}: Seller Total Price is ₹${row.expSeller} (got ${res.totalSellerAmount})`);
    assert(res.subtotal === row.expBase, `Qty ${row.qty}: Base Price is ₹${row.expBase} (got ${res.subtotal})`);
    assert(res.totalGst === row.expGst, `Qty ${row.qty}: GST Amount is ₹${row.expGst} (got ${res.totalGst})`);
    assert(res.finalCustomerAmount === row.expFinal, `Qty ${row.qty}: Final Price is ₹${row.expFinal} (got ${res.finalCustomerAmount})`);
  });
  console.log();

  // ========================================================================
  // TEST SUITE 5 – Supported Units & Dynamic Unit Size (Section 9)
  // ========================================================================
  console.log('Test Suite 5 – Supported Measurement Units & Conversions:');

  // Example 1: 1 BAG = 10 KG, Admin Commission = ₹5/KG -> Commission = ₹50
  const bagRice = calculateCustomerPrice({
    sellerPrice: 100,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementUnit: 'KG',
    unitSize: 10,
    commissionUnit: 'KG',
    commissionValue: 5,
    commissionType: 'flat',
    gstPercent: 5
  });
  assert(bagRice.commissionPerProductUnit === 50, `1 BAG = 10 KG at ₹5/KG yields ₹50 commission (got ${bagRice.commissionPerProductUnit})`);
  assert(bagRice.customerFinalPricePerProductUnit === 157.50, `Customer Final Price is ₹157.50 (got ${bagRice.customerFinalPricePerProductUnit})`);

  // Example 2: 1 BOX = 10 LTR, Admin Commission = ₹20/LTR -> Commission = ₹200
  const boxOil = calculateCustomerPrice({
    sellerPrice: 1200,
    unit: 'BOX',
    packagingType: 'BOX',
    measurementUnit: 'LTR',
    unitSize: 10,
    commissionUnit: 'LTR',
    commissionValue: 20,
    commissionType: 'flat',
    gstPercent: 5
  });
  assert(boxOil.commissionPerProductUnit === 200, `1 BOX = 10 LTR at ₹20/LTR yields ₹200 commission (got ${boxOil.commissionPerProductUnit})`);
  assert(boxOil.customerUnitBasePrice === 1400, `Customer Base Price (1200 + 200) is ₹1,400 (got ${boxOil.customerUnitBasePrice})`);
  assert(boxOil.customerFinalPricePerProductUnit === 1470, `Customer Final Price (1400 + 5%) is ₹1,470 (got ${boxOil.customerFinalPricePerProductUnit})`);

  // Example 3: TON unit conversion (1 TON = 1000 KG at ₹5/KG -> Commission = ₹5,000)
  const tonGrain = calculateCustomerPrice({
    sellerPrice: 25000,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementUnit: 'TON',
    unitSize: 1,
    commissionUnit: 'KG',
    commissionValue: 5,
    commissionType: 'flat',
    gstPercent: 0
  });
  assert(tonGrain.commissionPerProductUnit === 5000, `1 TON at ₹5/KG yields ₹5,000 commission (got ${tonGrain.commissionPerProductUnit})`);

  // Incompatible unit check: Product in KG vs Admin Commission in LTR
  const incomp = checkCommissionCompatibility(
    { packagingUnit: 'BAG', measurementUnit: 'KG', isPackagingUnit: true, normPackagingUnit: 'bag', normMeasurementUnit: 'kg' },
    { unit: 'ltr', commissionType: 'flat' }
  );
  assert(incomp.isCompatible === false, `Incompatible units (KG vs LTR) correctly flagged isCompatible: false`);
  assert(typeof incomp.validationMessage === 'string' && incomp.validationMessage.includes('Incompatible'), `Validation message clearly informs about incompatibility`);
  console.log();

  // ========================================================================
  // TEST SUITE 6 – Stock Commission Calculation (Section 11)
  // Available Stock = 50 Packages, Product Unit Size = 10 KG, Admin Commission = ₹5/KG
  // Total Stock Weight = 50 × 10 = 500 KG
  // Total Stock Commission = 500 × ₹5 = ₹2,500
  // ========================================================================
  console.log('Test Suite 6 – Stock Commission Calculation:');
  const stockTest = calculatePricingBreakdown({
    sellerUnitPrice: 100,
    unit: 'BAG',
    packagingType: 'BAG',
    measurementBasis: 'KG',
    measurementUnit: 'KG',
    commissionUnit: 'KG',
    unitSize: 10,
    commissionType: 'flat',
    commissionValue: 5,
    quantity: 1,
    availableStock: 50,
    gstPercent: 5
  });

  assert(stockTest.totalStockWeight === 500, `Total Stock Weight (50 × 10) is 500 KG (got ${stockTest.totalStockWeight})`);
  assert(stockTest.totalStockCommission === 2500, `Total Stock Commission (500 × ₹5) is ₹2,500 (got ${stockTest.totalStockCommission})`);
  assert(stockTest.totalSellerStockValue === 5000, `Total Seller Stock Value (50 × ₹100) is ₹5,000 (got ${stockTest.totalSellerStockValue})`);
  assert(stockTest.totalStockSubtotal === 7500, `Stock Subtotal (5000 + 2500) is ₹7,500 (got ${stockTest.totalStockSubtotal})`);
  assert(stockTest.totalStockValuation === 7875, `Total Stock Valuation with 5% GST is ₹7,875 (got ${stockTest.totalStockValuation})`);
  // Ensure stock commission was NOT added to the order
  assert(stockTest.totalCommission === 50, `Order Total Commission for Qty 1 remains ₹50 and is separate from stock commission`);
  console.log();

  // ========================================================================
  // TEST SUITE 7 – Real MongoDB Product and Order Creation with Snapshot
  // ========================================================================
  console.log('Test Suite 7 – Real MongoDB Product and Order Creation with Snapshot:');
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    const conn = await mongoose.createConnection(mongoUri).asPromise();
    const MongoProduct = conn.models.Product || conn.model('Product', Product.schema);
    const MongoOrder = conn.models.Order || conn.model('Order', Order.schema);

    // Create a product with new simplified pricing
    const testRiceDoc = await MongoProduct.create({
      name: 'TEST RICE 10KG SIMPLIFIED COMMISSION SUITE',
      categoryId: new mongoose.Types.ObjectId('6abf84deb66fc9916f480b0e'),
      packagingType: 'BAG',
      unit: 'BAG',
      measurementBasis: 'KG',
      measurementUnit: 'KG',
      unitSize: 10,
      sellerPrice: 100,
      sellerUnitPrice: 100,
      sellerPricePerBaseUnit: 10,
      sellerPricePerProductUnit: 100,
      adminCommissionPerBaseUnit: 5,
      commissionPerProductUnit: 50,
      customerUnitBasePrice: 150,
      price: 157.50,
      b2bPrice: 157.50,
      stock: 50,
      gstPercent: 5,
      isProductVisible: true
    });

    console.log(`  Created test rice product: ${testRiceDoc._id}`);

    // Create an order for 3 Packages
    const orderData = calculatePricingBreakdown({
      sellerUnitPrice: testRiceDoc.sellerUnitPrice,
      packagingType: 'BAG',
      measurementBasis: 'KG',
      unitSize: 10,
      commissionType: 'flat',
      commissionValue: 5,
      quantity: 3,
      gstPercent: 5
    });

    const testOrder = await MongoOrder.create({
      userId: new mongoose.Types.ObjectId(),
      type: 'b2b',
      items: [{
        productId: testRiceDoc._id,
        variantSize: null,
        name: testRiceDoc.name,
        quantity: 3,
        orderedQuantity: 3,
        packagingType: orderData.packagingType,
        measurementBasis: orderData.measurementBasis,
        productUnitSize: orderData.unitSize,
        unitSize: orderData.unitSize,
        sellerPriceBasis: 'per_package',
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
        sellerUnitPrice: orderData.sellerPricePerProductUnit,
        unitCommission: orderData.commissionPerProductUnit,
        availableStock: 50,
        stockTotalCommission: 2500
      }],
      totalAmount: orderData.finalCustomerAmount,
      totalAmountWithoutCommissions: orderData.totalSellerAmount + orderData.totalGst,
      totalCommissionAmount: orderData.totalCommission,
      totalGstAmount: orderData.totalGst,
      shippingAddress: {
        name: 'Test Store',
        phone: '9999999999',
        address: 'MG Road',
        city: 'Bangalore',
        pincode: '560001',
        state: 'Karnataka'
      },
      paymentMethod: 'COD',
      paymentStatus: 'Pending',
      orderStatus: 'Pending'
    });

    console.log(`  Saved test order: ${testOrder._id}`);

    assert(testOrder.items[0].productUnitSize === 10, `Saved productUnitSize is 10 (got ${testOrder.items[0].productUnitSize})`);
    assert(testOrder.items[0].sellerPricePerProductUnit === 100, `Saved sellerPricePerProductUnit is ₹100 (got ${testOrder.items[0].sellerPricePerProductUnit})`);
    assert(testOrder.items[0].totalSellerAmount === 300, `Saved totalSellerAmount is ₹300 (got ${testOrder.items[0].totalSellerAmount})`);
    assert(testOrder.items[0].totalCommission === 150, `Saved totalCommission is ₹150 (got ${testOrder.items[0].totalCommission})`);
    assert(testOrder.items[0].subtotal === 450, `Saved subtotal is ₹450 (got ${testOrder.items[0].subtotal})`);
    assert(testOrder.items[0].totalGst === 22.50, `Saved totalGst is ₹22.50 (got ${testOrder.items[0].totalGst})`);
    assert(testOrder.items[0].finalCustomerAmount === 472.50, `Saved finalCustomerAmount is ₹472.50 (got ${testOrder.items[0].finalCustomerAmount})`);
    assert(testOrder.totalAmount === 472.50, `Order totalAmount is ₹472.50 (got ${testOrder.totalAmount})`);
    assert(testOrder.totalCommissionAmount === 150, `Order totalCommissionAmount is ₹150 (got ${testOrder.totalCommissionAmount})`);
    assert(testOrder.totalGstAmount === 22.50, `Order totalGstAmount is ₹22.50 (got ${testOrder.totalGstAmount})`);

    // Clean up
    await MongoProduct.findByIdAndDelete(testRiceDoc._id);
    await MongoOrder.findByIdAndDelete(testOrder._id);
    console.log('  Cleaned up MongoDB test documents.');
    await conn.close();
  } catch (err) {
    console.error('  MongoDB integration check error:', err.message);
  }

  console.log('\n================================================================');
  console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
  } else {
    console.log('SOME TESTS FAILED!');
  }
}

runTests().catch(err => {
  console.error('Unexpected error running tests:', err);
  process.exit(1);
});
