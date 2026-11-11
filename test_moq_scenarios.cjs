const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('   SELLER MAXIMUM ORDER QUANTITY (MOQ) RESTRICTION TEST SUITE   ');
console.log('================================================================\n');

// 1. Model Schema File Verification
console.log('TEST 1: Product Schema fields verification...');
const productSchemaSource = fs.readFileSync(path.join(__dirname, 'models', 'Product.js'), 'utf8');
assert(productSchemaSource.includes('moq: { type: Number'), 'Product schema must define moq');
assert(productSchemaSource.includes('maxOrderQuantity: { type: Number'), 'Product schema must define maxOrderQuantity');
console.log('  [PASS] Product schema defines both `moq` and `maxOrderQuantity`.');

// 2. Logic simulation for order & cart validation
console.log('\nTEST 2: MOQ Validation Business Logic Tests...');

function validateOrderItems(items, productDb) {
  const combinedProductQuantities = {};
  for (const item of items) {
    const pId = (item.product || item.id || item._id)?.toString();
    const qty = parseInt(item.quantity, 10);
    if (pId) {
      combinedProductQuantities[pId] = (combinedProductQuantities[pId] || 0) + (isNaN(qty) ? 0 : qty);
    }
  }

  for (const item of items) {
    const pId = (item.product || item.id || item._id)?.toString();
    const productData = productDb[pId];
    if (!productData) {
      return { status: 404, message: `Product not found: ${pId}` };
    }

    const qty = parseInt(item.quantity, 10);
    if (!qty || isNaN(qty) || qty <= 0 || Number(item.quantity) !== qty) {
      return { status: 400, message: `Invalid quantity for product "${productData.name}". Quantity must be a positive integer.` };
    }

    const maxOrderLimit = productData.maxOrderQuantity !== undefined && productData.maxOrderQuantity !== null
      ? Number(productData.maxOrderQuantity)
      : (productData.moq !== undefined && productData.moq !== null ? Number(productData.moq) : null);

    if (maxOrderLimit && maxOrderLimit > 0) {
      const totalQtyForProduct = combinedProductQuantities[pId] || qty;
      if (totalQtyForProduct > maxOrderLimit) {
        return {
          status: 400,
          message: `Maximum ${maxOrderLimit} units allowed per order for "${productData.name}". You requested ${totalQtyForProduct} units.`,
          maxOrderQuantity: maxOrderLimit,
          productId: pId
        };
      }
    }

    if (productData.stock < qty) {
      return {
        status: 400,
        message: `Insufficient stock for product "${productData.name}". Available: ${productData.stock}, Requested: ${qty}`
      };
    }
  }

  return { status: 200, message: 'Valid' };
}

// Mock products database
const mockDb = {
  prod_sellerA_1: {
    _id: 'prod_sellerA_1',
    name: 'Seller A Sugar Bag',
    sellerId: 'seller_123',
    stock: 50,
    moq: 5,
    maxOrderQuantity: 5
  },
  prod_sellerB_1: {
    _id: 'prod_sellerB_1',
    name: 'Seller B Basmati Rice',
    sellerId: 'seller_456',
    stock: 100,
    moq: 10,
    maxOrderQuantity: 10
  },
  prod_low_stock: {
    _id: 'prod_low_stock',
    name: 'Limited Stock Oil',
    sellerId: 'seller_123',
    stock: 3,
    moq: 10,
    maxOrderQuantity: 10
  }
};

// 2.1 Single item <= MOQ
const t1 = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 1 }], mockDb);
assert.strictEqual(t1.status, 200, 'Buy 1 when MOQ=5 should succeed');
console.log('  [PASS] Buy 1 (MOQ=5): Allowed');

const t3 = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 3 }], mockDb);
assert.strictEqual(t3.status, 200, 'Buy 3 when MOQ=5 should succeed');
console.log('  [PASS] Buy 3 (MOQ=5): Allowed');

const t5 = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 5 }], mockDb);
assert.strictEqual(t5.status, 200, 'Buy 5 when MOQ=5 should succeed');
console.log('  [PASS] Buy 5 (MOQ=5): Allowed');

// 2.2 Exceeding MOQ
const t6 = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 6 }], mockDb);
assert.strictEqual(t6.status, 400, 'Buy 6 when MOQ=5 must fail');
assert(t6.message.includes('Maximum 5 units allowed'), 'Error must specify limit');
console.log('  [PASS] Buy 6 (MOQ=5): Blocked with correct message');

const t10 = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 10 }], mockDb);
assert.strictEqual(t10.status, 400, 'Buy 10 when MOQ=5 must fail');
console.log('  [PASS] Buy 10 (MOQ=5): Blocked with correct message');

// 2.3 Combined quantity across separate cart entries for the same product
console.log('\nTEST 3: Combined cart quantity enforcement...');
const tCombinedExceed = validateOrderItems([
  { product: 'prod_sellerA_1', quantity: 3 },
  { product: 'prod_sellerA_1', quantity: 3 }
], mockDb);
assert.strictEqual(tCombinedExceed.status, 400, 'Combined 3 + 3 = 6 must fail MOQ of 5');
console.log('  [PASS] 2 line items of qty 3 for same product (total 6 > MOQ 5): Blocked');

const tCombinedOk = validateOrderItems([
  { product: 'prod_sellerA_1', quantity: 2 },
  { product: 'prod_sellerA_1', quantity: 3 }
], mockDb);
assert.strictEqual(tCombinedOk.status, 200, 'Combined 2 + 3 = 5 must pass MOQ of 5');
console.log('  [PASS] 2 line items of qty 2 and 3 for same product (total 5 <= MOQ 5): Allowed');

// 2.4 Multi-vendor isolation
console.log('\nTEST 4: Multi-vendor MOQ isolation...');
const tMultiVendor = validateOrderItems([
  { product: 'prod_sellerA_1', quantity: 5 }, // MOQ is 5
  { product: 'prod_sellerB_1', quantity: 8 }  // MOQ is 10
], mockDb);
assert.strictEqual(tMultiVendor.status, 200, 'Each product respects its own seller MOQ');
console.log('  [PASS] Seller A product qty 5 (MOQ 5) + Seller B product qty 8 (MOQ 10): Both Allowed');

const tMultiVendorOneFails = validateOrderItems([
  { product: 'prod_sellerA_1', quantity: 6 }, // Fails MOQ 5
  { product: 'prod_sellerB_1', quantity: 8 }  // Passes MOQ 10
], mockDb);
assert.strictEqual(tMultiVendorOneFails.status, 400, 'Order rejected because Seller A product exceeds limit');
assert.strictEqual(tMultiVendorOneFails.productId, 'prod_sellerA_1');
console.log('  [PASS] Seller A exceeds its MOQ while Seller B is within: Order rejected specifically for Seller A product');

// 2.5 Stock boundary takes precedence when Stock < MOQ
console.log('\nTEST 5: Stock vs MOQ priority handling...');
const tStockBoundary = validateOrderItems([{ product: 'prod_low_stock', quantity: 5 }], mockDb);
assert.strictEqual(tStockBoundary.status, 400, 'Quantity 5 is within MOQ 10 but exceeds Stock 3');
assert(tStockBoundary.message.includes('Insufficient stock'), 'Should report stock error');
console.log('  [PASS] Requesting 5 when Stock=3 and MOQ=10: Blocked by stock constraint');

// 2.6 Dynamic seller update simulation
console.log('\nTEST 6: Dynamic Seller MOQ Update...');
// Seller updates MOQ from 5 to 10
mockDb.prod_sellerA_1.moq = 10;
mockDb.prod_sellerA_1.maxOrderQuantity = 10;
const tAfterIncrease = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 8 }], mockDb);
assert.strictEqual(tAfterIncrease.status, 200, 'Buy 8 is now allowed because seller updated MOQ to 10');
console.log('  [PASS] Seller increased MOQ to 10: Buy 8 is now immediately Allowed');

// Seller reduces MOQ from 10 to 3
mockDb.prod_sellerA_1.moq = 3;
mockDb.prod_sellerA_1.maxOrderQuantity = 3;
const tAfterDecrease = validateOrderItems([{ product: 'prod_sellerA_1', quantity: 5 }], mockDb);
assert.strictEqual(tAfterDecrease.status, 400, 'Buy 5 is now blocked because seller reduced MOQ to 3');
console.log('  [PASS] Seller reduced MOQ to 3: Buy 5 is now immediately Blocked');

// 2.7 Invalid quantity tampering
console.log('\nTEST 7: Request tamper prevention (negative, float, zero)...');
assert.strictEqual(validateOrderItems([{ product: 'prod_sellerA_1', quantity: 0 }], mockDb).status, 400);
assert.strictEqual(validateOrderItems([{ product: 'prod_sellerA_1', quantity: -2 }], mockDb).status, 400);
assert.strictEqual(validateOrderItems([{ product: 'prod_sellerA_1', quantity: 2.5 }], mockDb).status, 400);
assert.strictEqual(validateOrderItems([{ product: 'prod_sellerA_1', quantity: 'abc' }], mockDb).status, 400);
console.log('  [PASS] All invalid quantity attempts (0, negative, floats, string) are rejected.');

console.log('\n================================================================');
console.log('   ALL 7 MOQ VERIFICATION TEST SUITES PASSED CLEANLY!           ');
console.log('================================================================');
