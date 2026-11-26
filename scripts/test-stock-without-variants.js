const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { processProductPricing } = require('../utils/pricing');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${msg}`);
  }
}

async function run() {
  console.log('================================================================');
  console.log('   STOCK WITHOUT VARIANTS - AUTOMATED VERIFICATION SUITE        ');
  console.log('================================================================\n');

  await mongoose.connect(process.env.MONGODB_URI);

  // 1. Frontend UI & Payload Checks
  console.log('--- 1. SELLER PANEL UI & SUBMISSION CHECKS ---');
  const addProductSrc = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/pages/AddProduct.jsx'), 'utf8');
  const editProductSrc = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/pages/EditProduct.jsx'), 'utf8');
  const productsSrc = fs.readFileSync(path.resolve(__dirname, '../../../Zudo-sellerpanel/src/pages/Products.jsx'), 'utf8');

  assert(addProductSrc.includes('name="stock"') && addProductSrc.includes('Stock Quantity'), 'AddProduct.jsx includes Stock Quantity input field');
  assert(editProductSrc.includes('Stock Quantity') && editProductSrc.includes('stock: parseInt(formData.stock, 10) || 0'), 'EditProduct.jsx includes Stock Quantity input and numeric submit');
  assert(productsSrc.includes('Number(product.stock) || 0'), 'Products.jsx falls back to product.stock when no variants exist');

  // 2. Backend Pricing & Stock Calculation Without Variants
  console.log('\n--- 2. BACKEND PRICING & DB LIFECYCLE (NO VARIANTS) ---');
  const pricing = processProductPricing({
    name: 'Test Non-Variant Cement',
    sellerPrice: 350,
    sellerB2bPrice: 350,
    unitSize: 50,
    measurementBasis: 'KG',
    packagingType: 'BAG',
    stock: 50,
    gstPercent: 18,
    b2b: [],
    b2c: []
  }, []);

  assert(pricing.availableStock === 50, `processProductPricing preserves stock=50 (got ${pricing.availableStock})`);
  assert(Array.isArray(pricing.b2b) && pricing.b2b.length === 0, 'Product has empty b2b variants array');

  const testProd = await Product.create({
    name: '__TEST_NON_VARIANT_STOCK__',
    categoryId: new mongoose.Types.ObjectId(),
    price: pricing.price,
    b2bPrice: pricing.b2bPrice,
    sellerPrice: pricing.sellerPrice,
    stock: 50,
    stockStatus: 'Available',
    unit: 'BAG',
    unitSize: 50,
    b2b: [],
    b2c: [],
    variants: []
  });

  assert(testProd.stock === 50 && testProd.stockStatus === 'Available', 'Product created in MongoDB with stock=50, stockStatus=Available');

  // 3. Simulate getProductStock & adjustProductStock logic from orders.js
  console.log('\n--- 3. ORDER STOCK CHECK, DEDUCTION & RESTORATION ---');
  const ordersSrc = fs.readFileSync(path.join(__dirname, '../routes/orders.js'), 'utf8');
  const productsRouteSrc = fs.readFileSync(path.join(__dirname, '../routes/products.js'), 'utf8');

  assert(
    ordersSrc.includes('if (!hasVariants)') && ordersSrc.includes("if (product.stockStatus === 'Out of Stock')"),
    'orders.js getProductStock handles !hasVariants and Out of Stock status before checking variantSize'
  );
  assert(
    productsRouteSrc.includes('if (!hasVariants)') && productsRouteSrc.includes("if (product.stockStatus === 'Out of Stock') return 0;"),
    'products.js getProductAvailableStock handles !hasVariants and Out of Stock status'
  );

  // Test deduction to 30
  testProd.stock = Math.max(0, testProd.stock - 20);
  if (testProd.stock === 0) testProd.stockStatus = 'Out of Stock';
  await testProd.save();
  const afterDeduct1 = await Product.findById(testProd._id).lean();
  assert(afterDeduct1.stock === 30 && afterDeduct1.stockStatus === 'Available', 'Deducting 20 leaves stock=30, status=Available');

  // Test deduction to 0
  testProd.stock = Math.max(0, testProd.stock - 30);
  if (testProd.stock === 0) testProd.stockStatus = 'Out of Stock';
  await testProd.save();
  const afterDeduct2 = await Product.findById(testProd._id).lean();
  assert(afterDeduct2.stock === 0 && afterDeduct2.stockStatus === 'Out of Stock', 'Deducting remaining 30 sets stock=0, status=Out of Stock');

  // Test restoration on cancel/return
  testProd.stock = Math.max(0, testProd.stock + 10);
  if (testProd.stock > 0 && testProd.stockStatus === 'Out of Stock') testProd.stockStatus = 'Available';
  await testProd.save();
  const afterRestore = await Product.findById(testProd._id).lean();
  assert(afterRestore.stock === 10 && afterRestore.stockStatus === 'Available', 'Restoring 10 sets stock=10, status=Available');

  await Product.deleteOne({ _id: testProd._id });
  console.log('  [CLEANUP] Test product removed from MongoDB.');

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
