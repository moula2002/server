/**
 * Pricing and Commission utility module for Zudo platform
 */

/**
 * Strict commercial rounding to 2 decimal places.
 */
function round2(val) {
  return Math.round((Number(val) || 0) * 100) / 100;
}

/**
 * Safe string extractor for category IDs (ObjectId, string, or populated object)
 */
function getCatIdStr(cat) {
  if (!cat) return null;
  if (typeof cat === 'string') return cat.trim();
  if (cat._id) return cat._id.toString();
  if (cat.id) return cat.id.toString();
  if (typeof cat.toString === 'function') {
    const s = cat.toString();
    if (s && s !== '[object Object]') return s;
  }
  return null;
}

/**
 * Normalize unit abbreviations for consistent matching
 */
function normalizeUnit(u) {
  if (!u || typeof u !== 'string') return '';
  const clean = u.trim().toLowerCase();
  if (clean === 'kgs' || clean === 'kilogram' || clean === 'kilograms') return 'kg';
  if (clean === 'gms' || clean === 'gm' || clean === 'gram' || clean === 'grams') return 'g';
  if (clean === 'ltrs' || clean === 'liter' || clean === 'litre' || clean === 'liters' || clean === 'litres') return 'ltr';
  if (clean === 'pieces' || clean === 'piece' || clean === 'pkts' || clean === 'pkt') return 'pcs';
  return clean;
}

/**
 * Finds the applicable commission rule from category commissions array.
 * Priority:
 * 1. Category ID + Matching Unit + Matching Pincode
 * 2. Category ID + Matching Unit + Pincode 'All'
 * 3. Category ID + Matching Unit (any pincode)
 * 4. Category ID + Matching Pincode
 * 5. Category ID + Pincode 'All'
 * 6. Category ID (fallback for any unit / pincode)
 */
function findCategoryCommission(commissions, categoryId, unit, pincode = null) {
  if (!commissions || !Array.isArray(commissions) || commissions.length === 0) return null;
  const targetCatId = getCatIdStr(categoryId);
  if (!targetCatId) return null;

  const targetUnit = normalizeUnit(unit);
  const targetPincode = (pincode || '').toString().trim().toLowerCase();

  const catComms = commissions.filter(c => getCatIdStr(c.categoryId) === targetCatId);
  if (catComms.length === 0) return null;

  // Extract possible unit from string (e.g. "20kg", "30kgs") if targetUnit is empty or "pcs"
  let extractedUnit = targetUnit;
  if (!extractedUnit || extractedUnit === 'pcs') {
    const match = (unit || '').toString().match(/[0-9.]*\s*(kg|g|ltr|pcs|gm|ltrs|kgs)/i);
    if (match && match[1]) {
      extractedUnit = normalizeUnit(match[1]);
    }
  }

  let bestCandidate = null;
  let bestScore = -1;

  for (const c of catComms) {
    const cUnit = normalizeUnit(c.unit);
    const cPin = (c.pincode || 'all').toString().trim().toLowerCase();

    const isExactUnit = targetUnit && cUnit === targetUnit;
    const isExtractedUnit = extractedUnit && cUnit === extractedUnit;
    const isUnitMatch = isExactUnit || isExtractedUnit;

    const isPinMatch = targetPincode && targetPincode !== 'all' && cPin === targetPincode;
    const isPinAll = !c.pincode || cPin === 'all';

    let score = 0;
    if (isUnitMatch && isPinMatch) score = 100;
    else if (isUnitMatch && isPinAll) score = 80;
    else if (isUnitMatch) score = 60;
    else if (isPinMatch) score = 40;
    else if (isPinAll) score = 20;
    else score = 10;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = c;
    }
  }

  return bestCandidate;
}

/**
 * Calculate customer price per unit given base seller price, commission type, and commission value.
 * Formula:
 * - Flat commission: customerPrice = sellerPrice + commissionValue
 * - Percentage commission: customerPrice = sellerPrice + (sellerPrice * commissionValue / 100)
 */
function calculateCustomerPrice(sellerPrice, commissionType, commissionValue) {
  const sPrice = typeof sellerPrice === 'number' ? sellerPrice : (parseFloat(sellerPrice) || 0);
  if (sPrice <= 0) return { customerPrice: 0, commissionAmount: 0 };

  const cVal = typeof commissionValue === 'number' ? commissionValue : (parseFloat(commissionValue) || 0);
  const cType = commissionType === 'percentage' ? 'percentage' : 'flat';

  let commissionAmount = 0;
  if (cType === 'flat') {
    commissionAmount = cVal;
  } else {
    commissionAmount = (sPrice * cVal) / 100;
  }
  commissionAmount = round2(commissionAmount);

  const finalCustomerPrice = round2(sPrice + commissionAmount);
  return {
    customerPrice: finalCustomerPrice,
    commissionAmount: commissionAmount
  };
}

/**
 * Process a product payload (for create/update/recalculate), ensuring seller prices,
 * commissions, and customer prices are consistently calculated and structured.
 */
function processProductPricing(payload, commissions = []) {
  const categoryId = payload.categoryId;
  const unit = payload.unit || 'pcs';

  const adminRule = findCategoryCommission(commissions, categoryId, unit);

  let commissionType = 'flat';
  let commissionValue = 0;

  if (adminRule) {
    commissionType = adminRule.commissionType === 'percentage' ? 'percentage' : 'flat';
    commissionValue = Number(adminRule.commissionValue) || 0;
  } else if (payload.commissionValue !== undefined && payload.commissionValue !== null && payload.commissionValue !== '') {
    commissionValue = parseFloat(payload.commissionValue) || 0;
    commissionType = payload.commissionType === 'percentage' ? 'percentage' : 'flat';
  }

  const sellerB2bPrice = payload.sellerB2bPrice !== undefined && payload.sellerB2bPrice !== '' && payload.sellerB2bPrice !== null
    ? parseFloat(payload.sellerB2bPrice) || 0
    : (payload.sellerPrice !== undefined && payload.sellerPrice !== '' && payload.sellerPrice !== null
        ? parseFloat(payload.sellerPrice) || 0
        : (parseFloat(payload.b2bPrice) || parseFloat(payload.price) || 0));

  const sellerPrice = payload.sellerPrice !== undefined && payload.sellerPrice !== '' && payload.sellerPrice !== null
    ? parseFloat(payload.sellerPrice) || 0
    : (payload.sellerB2bPrice !== undefined && payload.sellerB2bPrice !== '' && payload.sellerB2bPrice !== null
        ? parseFloat(payload.sellerB2bPrice) || 0
        : (parseFloat(payload.price) || parseFloat(payload.b2bPrice) || 0));

  const { customerPrice, commissionAmount } = calculateCustomerPrice(sellerPrice, commissionType, commissionValue);
  const { customerPrice: customerB2bPrice } = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue);

  // Process B2C variants
  const processedB2c = (payload.b2c || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== '' && v.sellerPrice !== null
      ? parseFloat(v.sellerPrice) || 0
      : (parseFloat(v.price) || 0);
    const vCalc = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);
    return {
      ...v,
      sellerPrice: vSellerPrice,
      price: vCalc.customerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCalc.commissionAmount
    };
  });

  // Process B2B variants
  const processedB2b = (payload.b2b || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== '' && v.sellerPrice !== null
      ? parseFloat(v.sellerPrice) || 0
      : (parseFloat(v.price) || 0);
    const vCalc = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);

    let processedTiers = v.priceTiers;
    if (Array.isArray(v.priceTiers)) {
      processedTiers = v.priceTiers.map(tier => {
        const tSellerPrice = tier.sellerPrice !== undefined && tier.sellerPrice !== '' && tier.sellerPrice !== null
          ? parseFloat(tier.sellerPrice) || 0
          : (parseFloat(tier.price) || 0);
        const tCalc = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue);
        return {
          ...tier,
          sellerPrice: tSellerPrice,
          price: tCalc.customerPrice
        };
      });
    }

    return {
      ...v,
      sellerPrice: vSellerPrice,
      price: vCalc.customerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCalc.commissionAmount,
      priceTiers: processedTiers
    };
  });

  // Process root priceTiers if present
  let processedPriceTiers = payload.priceTiers;
  if (Array.isArray(payload.priceTiers)) {
    processedPriceTiers = payload.priceTiers.map(tier => {
      const tSellerPrice = tier.sellerPrice !== undefined && tier.sellerPrice !== '' && tier.sellerPrice !== null
        ? parseFloat(tier.sellerPrice) || 0
        : (parseFloat(tier.price) || 0);
      const tCalc = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue);
      return {
        ...tier,
        sellerPrice: tSellerPrice,
        price: tCalc.customerPrice
      };
    });
  }

  const finalB2bPrice = (customerB2bPrice === 0 && processedB2b.length > 0) ? processedB2b[0].price : (customerB2bPrice || customerPrice);
  const finalPrice = (customerPrice === 0 && processedB2c.length > 0) ? processedB2c[0].price : (customerPrice || customerB2bPrice || finalB2bPrice);

  const availableStock = typeof payload.stock === 'number' ? payload.stock : (parseInt(payload.stock, 10) || 0);
  const stockTotalCommission = round2(commissionAmount * Math.max(0, availableStock));

  return {
    ...payload,
    sellerPrice,
    sellerUnitPrice: sellerPrice,
    sellerB2bPrice,
    commissionType,
    commissionValue,
    commissionRate: commissionValue,
    commissionAmount,
    unitCommission: commissionAmount,
    availableStock,
    stockTotalCommission,
    unitCustomerPrice: finalPrice,
    price: finalPrice,
    b2bPrice: finalB2bPrice,
    b2c: processedB2c,
    b2b: processedB2b,
    priceTiers: processedPriceTiers
  };
}

/**
 * Apply commission dynamically to a product retrieved from DB.
 * Prioritizes active MongoDB category commission configuration.
 * Ensures idempotent calculation: ALWAYS calculates customer price based on sellerPrice!
 * Never multiplies or inflates an already inflated price!
 */
function applyCommission(product, commissions = [], pincode = null) {
  if (!product) return product;

  const adminRule = findCategoryCommission(commissions, product.categoryId, product.unit, pincode);

  let commissionType = 'flat';
  let commissionValue = 0;

  if (adminRule) {
    commissionType = adminRule.commissionType === 'percentage' ? 'percentage' : 'flat';
    commissionValue = Number(adminRule.commissionValue) || 0;
  } else if (product.commissionValue !== undefined && product.commissionValue !== null && product.commissionValue !== '') {
    commissionType = product.commissionType === 'percentage' ? 'percentage' : 'flat';
    commissionValue = Number(product.commissionValue) || 0;
  }

  const sellerB2bPrice = product.sellerB2bPrice !== undefined && product.sellerB2bPrice !== null
    ? product.sellerB2bPrice
    : (product.sellerPrice !== undefined && product.sellerPrice !== null
        ? product.sellerPrice
        : (product.b2bPrice || product.price || 0));

  const sellerPrice = product.sellerPrice !== undefined && product.sellerPrice !== null
    ? product.sellerPrice
    : (product.sellerB2bPrice !== undefined && product.sellerB2bPrice !== null
        ? product.sellerB2bPrice
        : (product.price || product.b2bPrice || 0));

  const { customerPrice, commissionAmount } = calculateCustomerPrice(sellerPrice, commissionType, commissionValue);
  const { customerPrice: customerB2bPrice } = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue);

  const newB2c = (product.b2c || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
    const { customerPrice: vCustomerPrice, commissionAmount: vCommAmt } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);
    return {
      ...v,
      sellerPrice: vSellerPrice,
      price: vCustomerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCommAmt
    };
  });

  const newB2b = (product.b2b || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
    const { customerPrice: vCustomerPrice, commissionAmount: vCommAmt } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);

    let newTiers = v.priceTiers;
    if (Array.isArray(v.priceTiers)) {
      newTiers = v.priceTiers.map(t => {
        const tSellerPrice = t.sellerPrice !== undefined && t.sellerPrice !== null ? t.sellerPrice : (t.price || 0);
        const { customerPrice: tCustomerPrice } = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue);
        return {
          ...t,
          sellerPrice: tSellerPrice,
          price: tCustomerPrice
        };
      });
    }

    return {
      ...v,
      sellerPrice: vSellerPrice,
      price: vCustomerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCommAmt,
      priceTiers: newTiers
    };
  });

  let newPriceTiers = product.priceTiers;
  if (Array.isArray(product.priceTiers)) {
    newPriceTiers = product.priceTiers.map(t => {
      const tSellerPrice = t.sellerPrice !== undefined && t.sellerPrice !== null ? t.sellerPrice : (t.price || 0);
      const { customerPrice: tCustomerPrice } = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue);
      return {
        ...t,
        sellerPrice: tSellerPrice,
        price: tCustomerPrice
      };
    });
  }

  const finalCustomerB2bPrice = (customerB2bPrice === 0 && newB2b.length > 0) ? newB2b[0].price : (customerB2bPrice || customerPrice);
  const finalCustomerPrice = (customerPrice === 0 && newB2c.length > 0) ? newB2c[0].price : (customerPrice || customerB2bPrice || finalCustomerB2bPrice);

  const availableStock = typeof product.stock === 'number' ? product.stock : (parseInt(product.stock, 10) || 0);
  const stockTotalCommission = round2(commissionAmount * Math.max(0, availableStock));

  return {
    ...product,
    sellerPrice,
    sellerUnitPrice: sellerPrice,
    sellerB2bPrice,
    commissionType,
    commissionValue,
    commissionRate: commissionValue,
    commissionAmount,
    unitCommission: commissionAmount,
    availableStock,
    stockTotalCommission,
    unitCustomerPrice: finalCustomerPrice,
    price: finalCustomerPrice,
    b2bPrice: finalCustomerB2bPrice,
    b2c: newB2c,
    b2b: newB2b,
    priceTiers: newPriceTiers
  };
}

/**
 * Exact pricing breakdown calculation based on selected quantity and commission rules.
 * Handles:
 * - Flat commission: Flat Commission Per Unit * Ordered Quantity
 * - Percentage commission: (Seller Unit Price * (Commission Rate / 100)) * Ordered Quantity
 * - Stock-level commission: Unit Commission * Available Stock (for display only)
 * - GST rules:
 *     - B2B: GST added on top of totalCustomerBase (totalCustomerBase * (gstPercent / 100))
 *     - B2C: GST is inclusive in totalCustomerBase (totalCustomerBase - (totalCustomerBase / (1 + gstPercent / 100)))
 *     - 0% GST: final price is seller price plus commission
 * - Stock limit enforcement & positive quantity validation
 */
function calculatePricingBreakdown({
  sellerUnitPrice = 0,
  commissionType = 'flat',
  commissionValue = 0,
  commissionRate = undefined,
  gstPercent = 0,
  quantity = 1,
  orderedQuantity = undefined,
  availableStock = 0,
  isB2B = false
}) {
  const rawQty = orderedQuantity !== undefined ? orderedQuantity : quantity;
  const qty = parseInt(rawQty, 10) > 0 ? parseInt(rawQty, 10) : 1;
  const sUnitPrice = typeof sellerUnitPrice === 'number' ? sellerUnitPrice : (parseFloat(sellerUnitPrice) || 0);

  const rawCommVal = commissionRate !== undefined ? commissionRate : commissionValue;
  const cVal = typeof rawCommVal === 'number' ? rawCommVal : (parseFloat(rawCommVal) || 0);
  const cType = commissionType === 'percentage' ? 'percentage' : 'flat';

  let unitCommission = 0;
  if (cType === 'flat') {
    unitCommission = cVal;
  } else {
    unitCommission = (sUnitPrice * cVal) / 100;
  }
  unitCommission = round2(unitCommission);

  const stock = typeof availableStock === 'number' ? availableStock : (parseInt(availableStock, 10) || 0);
  const stockTotalCommission = round2(unitCommission * Math.max(0, stock));

  const totalSellerPrice = round2(sUnitPrice * qty);
  const totalCommission = round2(unitCommission * qty);
  const totalCustomerBase = round2(totalSellerPrice + totalCommission);

  let totalGst = 0;
  let finalCustomerPrice = totalCustomerBase;

  const gstRate = typeof gstPercent === 'number' ? gstPercent : (parseFloat(gstPercent) || 0);
  if (isB2B) {
    totalGst = round2(totalCustomerBase * (gstRate / 100));
    finalCustomerPrice = round2(totalCustomerBase + totalGst);
  } else {
    if (gstRate > 0) {
      const baseBeforeTax = totalCustomerBase / (1 + gstRate / 100);
      totalGst = round2(totalCustomerBase - baseBeforeTax);
    }
    finalCustomerPrice = totalCustomerBase;
  }

  const unitCustomerPrice = round2(finalCustomerPrice / qty);
  const unitGst = round2(totalGst / qty);

  return {
    sellerUnitPrice: sUnitPrice,
    commissionType: cType,
    commissionRate: cVal,
    unitCommission,
    availableStock: stock,
    stockTotalCommission,
    unitCustomerPrice,
    gstPercent: gstRate,
    orderedQuantity: qty,
    totalCommission,
    totalSellerPrice,
    totalGst,
    finalCustomerPrice,
    // backwards compatibility aliases
    quantity: qty,
    commissionValue: cVal,
    commissionAmount: unitCommission,
    totalCustomerBase,
    unitGst
  };
}

module.exports = {
  round2,
  calculatePricingBreakdown,
  findCategoryCommission,
  calculateCustomerPrice,
  processProductPricing,
  applyCommission
};
