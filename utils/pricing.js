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
  if (clean === 'mls' || clean === 'milliliter' || clean === 'millilitre') return 'ml';
  if (clean === 'pieces' || clean === 'piece' || clean === 'pkts' || clean === 'pkt') return 'pcs';
  if (clean === 'tons' || clean === 'tonne' || clean === 'tonnes') return 'ton';
  if (clean === 'tins') return 'tin';
  if (clean === 'bags') return 'bag';
  return clean;
}

/**
 * Extracts numeric unit size or weight (e.g. "30 KG", "30kg", "30", 30 -> 30)
 * Defaults to 1 if not specified, 0, or invalid.
 */
function extractUnitSize(val, defaultVal = 1) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'number') return val > 0 ? val : defaultVal;
  const str = String(val).trim();
  const match = str.match(/([0-9.]+)/);
  if (match && !isNaN(parseFloat(match[1]))) {
    const parsed = parseFloat(match[1]);
    return parsed > 0 ? parsed : defaultVal;
  }
  return defaultVal;
}

/**
 * Measurement unit conversions.
 * Converts amount from fromUnit to toUnit.
 * Returns null if units are incompatible.
 */
function convertMeasurement(amount, fromUnit, toUnit) {
  const num = Number(amount);
  if (isNaN(num)) return null;
  const f = normalizeUnit(fromUnit);
  const t = normalizeUnit(toUnit);
  if (!f || !t) return null;
  if (f === t) return num;

  // Weight conversions: kg <-> g <-> ton
  if (f === 'kg' && t === 'g') return num * 1000;
  if (f === 'g' && t === 'kg') return num / 1000;
  if (f === 'ton' && t === 'kg') return num * 1000;
  if (f === 'kg' && t === 'ton') return num / 1000;
  if (f === 'ton' && t === 'g') return num * 1000000;
  if (f === 'g' && t === 'ton') return num / 1000000;

  // Volume conversions: ltr <-> ml
  if (f === 'ltr' && t === 'ml') return num * 1000;
  if (f === 'ml' && t === 'ltr') return num / 1000;

  // Incompatible (e.g. kg to ltr or unmapped custom units)
  return null;
}

/**
 * Returns conversion factor from fromUnit to toUnit (defaults to 1 if incompatible).
 */
function getUnitConversionFactor(fromUnit, toUnit) {
  const f = normalizeUnit(fromUnit);
  const t = normalizeUnit(toUnit);
  if (!f || !t || f === t) return 1;
  const converted = convertMeasurement(1, f, t);
  return converted !== null ? converted : 1;
}

const BASE_MEASUREMENT_UNITS = ['kg', 'g', 'ton', 'ltr', 'ml', 'pcs'];
const PACKAGING_UNITS = ['bag', 'tin', 'box', 'can', 'drum', 'bottle', 'jar', 'bunch', 'custom'];

/**
 * Resolve product packaging and measurement basis.
 * E.g., for 1 Bag of Rice (30 KG):
 * packagingUnit = 'bag', measurementUnit = 'kg', unitSize = 30
 */
function resolveMeasurementBasis(unit, measurementUnit, unitSizeStr) {
  const normUnit = normalizeUnit(unit);
  let normMeas = normalizeUnit(measurementUnit);

  if (!normMeas) {
    if (BASE_MEASUREMENT_UNITS.includes(normUnit)) {
      normMeas = normUnit;
    } else {
      const match = String(unitSizeStr || '').match(/[0-9.]*\s*(kg|g|ltr|pcs|gm|ltrs|kgs|ton|ml)/i);
      if (match && match[1]) {
        normMeas = normalizeUnit(match[1]);
      }
    }
  }

  const isPackaging = PACKAGING_UNITS.includes(normUnit) || !BASE_MEASUREMENT_UNITS.includes(normUnit);

  return {
    packagingUnit: normUnit || 'unit',
    measurementUnit: normMeas || (isPackaging ? null : normUnit),
    isPackagingUnit: isPackaging
  };
}

/**
 * Validates compatibility between product measurement/packaging unit and commission rule unit.
 * Implements Section 6 custom unit handling.
 */
function checkCommissionCompatibility(productBasis, commissionRuleOrUnit) {
  if (!commissionRuleOrUnit) return { isCompatible: true, conversionFactor: 1 };
  
  const commUnit = typeof commissionRuleOrUnit === 'object' 
    ? normalizeUnit(commissionRuleOrUnit.unit) 
    : normalizeUnit(commissionRuleOrUnit);

  const commType = typeof commissionRuleOrUnit === 'object' ? commissionRuleOrUnit.commissionType : 'flat';
  if (commType === 'percentage') {
    return { isCompatible: true, conversionFactor: 1, matchedOn: 'percentage' };
  }

  if (!commUnit) return { isCompatible: true, conversionFactor: 1 };

  const { packagingUnit, measurementUnit, isPackagingUnit } = productBasis;

  // 1. Direct unit match with packaging unit (e.g. Rule is Per Tin, product packaging is Tin)
  if (commUnit === packagingUnit) {
    return { isCompatible: true, conversionFactor: 1, matchedOn: 'packaging' };
  }

  // 2. Direct unit match with measurement basis (e.g. Rule is Per KG, product measurement basis is KG)
  if (measurementUnit && commUnit === measurementUnit) {
    return { isCompatible: true, conversionFactor: 1, matchedOn: 'measurement' };
  }

  // 3. Compatible measurement unit conversion (e.g. Rule is Per Ton, product measurement basis is KG)
  if (measurementUnit) {
    const factor = convertMeasurement(1, measurementUnit, commUnit);
    if (factor !== null) {
      return { isCompatible: true, conversionFactor: factor, matchedOn: 'conversion' };
    }
  }

  // 4. Missing measurement basis for packaging / custom unit (e.g. Tin without KG or LTR)
  if (isPackagingUnit && !measurementUnit) {
    return {
      isCompatible: false,
      conversionFactor: 0,
      validationMessage: `Measurement basis is missing for '${packagingUnit}'. Please specify product measurement unit (e.g. KG or Litre) to calculate commission.`
    };
  }

  // 5. Incompatible measurement units (e.g. Product in KG vs Commission in Litre)
  return {
    isCompatible: false,
    conversionFactor: 0,
    validationMessage: `Incompatible measurement units: product is in '${measurementUnit || packagingUnit}', but category commission is configured in '${commUnit}'.`
  };
}

/**
 * Finds the applicable commission rule from category commissions array.
 * Priority:
 * 1. Category ID + Matching Packaging Unit + Matching Pincode
 * 2. Category ID + Matching Measurement Unit + Matching Pincode
 * 3. Category ID + Matching Unit + Pincode 'All'
 * 4. Category ID + Matching Measurement Unit + Pincode 'All'
 * 5. Category ID + Compatible Unit Conversion (e.g. ton <-> kg)
 * 6. Category ID Fallback
 */
function findCategoryCommission(commissions, categoryId, unit, measurementUnit = null, pincode = null) {
  if (!commissions || !Array.isArray(commissions) || commissions.length === 0) return null;
  const targetCatId = getCatIdStr(categoryId);
  if (!targetCatId) return null;

  const targetUnit = normalizeUnit(unit);
  const targetMeasUnit = normalizeUnit(measurementUnit);
  const targetPincode = (pincode || '').toString().trim().toLowerCase();

  const catComms = commissions.filter(c => getCatIdStr(c.categoryId) === targetCatId);
  if (catComms.length === 0) return null;

  let extractedUnit = targetUnit;
  if (!extractedUnit || extractedUnit === 'pcs' || extractedUnit === 'bag' || extractedUnit === 'tin') {
    const match = (unit || '').toString().match(/[0-9.]*\s*(kg|g|ltr|pcs|gm|ltrs|kgs|ton|tin|bag|ml)/i);
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
    const isMeasMatch = targetMeasUnit && cUnit === targetMeasUnit;
    const isExtractedUnit = extractedUnit && cUnit === extractedUnit;
    const isConvertible = (targetMeasUnit || extractedUnit) && convertMeasurement(1, (targetMeasUnit || extractedUnit), cUnit) !== null;

    const isUnitMatch = isExactUnit || isMeasMatch || isExtractedUnit || isConvertible;

    const isPinMatch = targetPincode && targetPincode !== 'all' && cPin === targetPincode;
    const isPinAll = !c.pincode || cPin === 'all';

    let score = 0;
    if (isExactUnit && isPinMatch) score = 120;
    else if (isExactUnit && isPinAll) score = 100;
    else if (isMeasMatch && isPinMatch) score = 95;
    else if (isMeasMatch && isPinAll) score = 90;
    else if (isExtractedUnit && isPinMatch) score = 85;
    else if (isExtractedUnit && isPinAll) score = 80;
    else if (isConvertible && isPinMatch) score = 75;
    else if (isConvertible && isPinAll) score = 70;
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
 * Calculate customer price per unit given base seller price, commission type, commission value, and unit size.
 * Formula (Sections 2, 3, 4, 6):
 * - Step 1: Seller Price Per Product Unit = Seller Price Per Base Unit * Product Unit Size (e.g. 50 * 30 = ₹1,500)
 * - Step 2: Commission Per Product Unit = Admin Commission Rate * Product Unit Size * ConversionFactor (e.g. 20 * 30 = ₹600)
 * - Step 3: Customer Unit Base Price = Seller Price Per Product Unit + Commission Per Product Unit (1500 + 600 = ₹2,100)
 * - GST Amount Per Product Unit = Customer Unit Base Price * (GST% / 100)
 * - Customer Final Price Per Product Unit = Customer Unit Base Price + GST Amount
 */
function calculateCustomerPrice(
  arg1,
  commissionType = 'flat',
  commissionValue = 0,
  unitSize = 1,
  gstPercent = 0,
  isGstInclusive = false,
  extraOpts = {}
) {
  let basePrice = 0;
  let cType = commissionType;
  let cVal = commissionValue;
  let uSize = unitSize;
  let gstRate = gstPercent;
  let isInclusive = isGstInclusive;
  let unit = 'unit';
  let measurementUnit = null;
  let commissionRuleOrUnit = null;

  if (typeof arg1 === 'object' && arg1 !== null) {
    basePrice = arg1.sellerPricePerBaseUnit !== undefined ? arg1.sellerPricePerBaseUnit : (arg1.sellerPrice !== undefined ? arg1.sellerPrice : 0);
    cType = arg1.commissionType || 'flat';
    cVal = arg1.commissionValue !== undefined ? arg1.commissionValue : (arg1.commissionRate !== undefined ? arg1.commissionRate : 0);
    uSize = arg1.unitSize !== undefined ? arg1.unitSize : 1;
    gstRate = arg1.gstPercent !== undefined ? arg1.gstPercent : 0;
    isInclusive = Boolean(arg1.isGstInclusive);
    unit = arg1.unit || 'unit';
    measurementUnit = arg1.measurementUnit || null;
    commissionRuleOrUnit = arg1.commissionRule || arg1.commissionUnit || null;
  } else {
    basePrice = arg1;
    unit = extraOpts.unit || 'unit';
    measurementUnit = extraOpts.measurementUnit || null;
    commissionRuleOrUnit = extraOpts.commissionRule || extraOpts.commissionUnit || null;
  }

  basePrice = typeof basePrice === 'number' ? basePrice : (parseFloat(basePrice) || 0);
  uSize = extractUnitSize(uSize, 1);
  cVal = typeof cVal === 'number' ? cVal : (parseFloat(cVal) || 0);
  cType = cType === 'percentage' ? 'percentage' : 'flat';
  gstRate = typeof gstRate === 'number' ? gstRate : (parseFloat(gstRate) || 0);

  const productBasis = resolveMeasurementBasis(unit, measurementUnit, uSize);
  const compatibility = checkCommissionCompatibility(productBasis, commissionRuleOrUnit);

  if (basePrice <= 0) {
    return {
      sellerPricePerBaseUnit: 0,
      productMeasurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
      measurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
      unit: productBasis.packagingUnit,
      unitSize: uSize,
      sellerPricePerProductUnit: 0,
      adminCommissionPerBaseUnit: cVal,
      commissionPerProductUnit: 0,
      customerUnitBasePrice: 0,
      gstPercent: gstRate,
      gstAmountPerProductUnit: 0,
      customerFinalPricePerProductUnit: 0,
      isCompatible: compatibility.isCompatible,
      validationMessage: compatibility.validationMessage || null,
      customerPrice: 0,
      sellerPrice: 0,
      commissionAmount: 0,
      unitCommission: 0
    };
  }

  const sPricePerProductUnit = round2(basePrice * uSize);

  let commissionPerProductUnit = 0;
  if (cType === 'flat') {
    const factor = compatibility.isCompatible ? (compatibility.conversionFactor !== undefined ? compatibility.conversionFactor : 1) : 1;
    commissionPerProductUnit = round2(cVal * factor * uSize);
  } else {
    commissionPerProductUnit = round2((sPricePerProductUnit * cVal) / 100);
  }

  const customerUnitBasePrice = round2(sPricePerProductUnit + commissionPerProductUnit);

  let gstAmountPerProductUnit = 0;
  let customerFinalPricePerProductUnit = customerUnitBasePrice;

  if (gstRate > 0) {
    if (isInclusive) {
      const baseBeforeTax = customerUnitBasePrice / (1 + gstRate / 100);
      gstAmountPerProductUnit = round2(customerUnitBasePrice - baseBeforeTax);
      customerFinalPricePerProductUnit = customerUnitBasePrice;
    } else {
      gstAmountPerProductUnit = round2(customerUnitBasePrice * (gstRate / 100));
      customerFinalPricePerProductUnit = round2(customerUnitBasePrice + gstAmountPerProductUnit);
    }
  }

  return {
    // 10 Breakdown Items (Section 5)
    sellerPricePerBaseUnit: basePrice,
    productMeasurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
    measurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
    unit: productBasis.packagingUnit,
    unitSize: uSize,
    sellerPricePerProductUnit: sPricePerProductUnit,
    adminCommissionPerBaseUnit: cVal,
    commissionPerProductUnit,
    customerUnitBasePrice,
    gstPercent: gstRate,
    gstAmountPerProductUnit,
    customerFinalPricePerProductUnit,

    // Validation & Custom Unit status (Section 6)
    isCompatible: compatibility.isCompatible,
    validationMessage: compatibility.validationMessage || null,

    // Aliases for compatibility
    sellerPrice: sPricePerProductUnit,
    customerPrice: customerUnitBasePrice,
    commissionAmount: commissionPerProductUnit,
    unitCommission: commissionPerProductUnit,
    finalPrice: customerFinalPricePerProductUnit
  };
}

/**
 * Process a product payload (for create/update/recalculate), ensuring seller prices,
 * commissions, and customer prices are consistently calculated and structured.
 */
function processProductPricing(payload, commissions = []) {
  const categoryId = payload.categoryId;
  const unit = payload.unit || 'pcs';
  const measurementUnit = payload.measurementUnit || null;
  const unitSize = extractUnitSize(payload.unitSize, 1);

  const adminRule = findCategoryCommission(commissions, categoryId, unit, measurementUnit);

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

  const extraOpts = { unit, measurementUnit, commissionRule: adminRule };
  const { customerPrice, commissionAmount } = calculateCustomerPrice(sellerPrice, commissionType, commissionValue, unitSize, 0, false, extraOpts);
  const { customerPrice: customerB2bPrice } = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue, unitSize, 0, false, extraOpts);

  // Process B2C variants
  const processedB2c = (payload.b2c || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== '' && v.sellerPrice !== null
      ? parseFloat(v.sellerPrice) || 0
      : (parseFloat(v.price) || 0);
    const vUnitSize = extractUnitSize(v.unitSize || v.packetSize, unitSize);
    const vCalc = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);
    return {
      ...v,
      unitSize: vUnitSize,
      sellerPrice: vCalc.sellerPricePerProductUnit,
      sellerPricePerBaseUnit: vCalc.sellerPricePerBaseUnit,
      sellerPricePerProductUnit: vCalc.sellerPricePerProductUnit,
      price: vCalc.customerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCalc.commissionAmount,
      unitCommission: vCalc.unitCommission
    };
  });

  // Process B2B variants
  const processedB2b = (payload.b2b || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== '' && v.sellerPrice !== null
      ? parseFloat(v.sellerPrice) || 0
      : (parseFloat(v.price) || 0);
    const vUnitSize = extractUnitSize(v.unitSize || v.packetSize, unitSize);
    const vCalc = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);

    let processedTiers = v.priceTiers;
    if (Array.isArray(v.priceTiers)) {
      processedTiers = v.priceTiers.map(tier => {
        const tSellerPrice = tier.sellerPrice !== undefined && tier.sellerPrice !== '' && tier.sellerPrice !== null
          ? parseFloat(tier.sellerPrice) || 0
          : (parseFloat(tier.price) || 0);
        const tCalc = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);
        return {
          ...tier,
          sellerPrice: tCalc.sellerPricePerProductUnit,
          sellerPricePerBaseUnit: tCalc.sellerPricePerBaseUnit,
          sellerPricePerProductUnit: tCalc.sellerPricePerProductUnit,
          price: tCalc.customerPrice
        };
      });
    }

    return {
      ...v,
      unitSize: vUnitSize,
      sellerPrice: vCalc.sellerPricePerProductUnit,
      sellerPricePerBaseUnit: vCalc.sellerPricePerBaseUnit,
      sellerPricePerProductUnit: vCalc.sellerPricePerProductUnit,
      price: vCalc.customerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCalc.commissionAmount,
      unitCommission: vCalc.unitCommission,
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
      const tCalc = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue, unitSize);
      return {
        ...tier,
        sellerPrice: tSellerPrice,
        price: tCalc.customerPrice
      };
    });
  }

  const availableStock = typeof payload.stock === 'number' ? payload.stock : (parseInt(payload.stock, 10) || 0);
  const gstRate = typeof payload.gstPercent === 'number' ? payload.gstPercent : (parseFloat(payload.gstPercent) || 0);
  const isGstInclusive = Boolean(payload.isGstInclusive);

  const primaryPricing = calculateCustomerPrice(sellerPrice, commissionType, commissionValue, unitSize, gstRate, isGstInclusive, extraOpts);
  const primaryB2bPricing = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue, unitSize, gstRate, isGstInclusive, extraOpts);

  const finalB2bPrice = (customerB2bPrice === 0 && processedB2b.length > 0) ? processedB2b[0].price : (customerB2bPrice || customerPrice);
  const finalPrice = (customerPrice === 0 && processedB2c.length > 0) ? processedB2c[0].price : (customerPrice || customerB2bPrice || finalB2bPrice);

  // New Separate Inventory Valuation (Section 6)
  const totalStockWeight = round2(unitSize * Math.max(0, availableStock));
  const totalStockCommission = round2(primaryPricing.commissionPerProductUnit * Math.max(0, availableStock));
  const totalSellerStockValue = round2(primaryPricing.sellerPricePerProductUnit * Math.max(0, availableStock));
  const totalStockSubtotal = round2(totalSellerStockValue + totalStockCommission);
  const totalStockGst = isGstInclusive ? 0 : round2(totalStockSubtotal * (gstRate / 100));
  const totalStockValuation = isGstInclusive ? totalStockSubtotal : round2(totalStockSubtotal + totalStockGst);

  return {
    ...payload,
    // 10-Step Breakdown Fields (Section 5)
    sellerPricePerBaseUnit: primaryPricing.sellerPricePerBaseUnit,
    productMeasurementUnit: primaryPricing.productMeasurementUnit,
    measurementUnit: primaryPricing.measurementUnit,
    unit: primaryPricing.unit,
    unitSize,
    sellerPricePerProductUnit: primaryPricing.sellerPricePerProductUnit,
    adminCommissionPerBaseUnit: primaryPricing.adminCommissionPerBaseUnit,
    commissionPerProductUnit: primaryPricing.commissionPerProductUnit,
    customerUnitBasePrice: primaryPricing.customerUnitBasePrice,
    gstPercent: gstRate,
    gstAmountPerProductUnit: primaryPricing.gstAmountPerProductUnit,
    customerFinalPricePerProductUnit: primaryPricing.customerFinalPricePerProductUnit,
    isCompatible: primaryPricing.isCompatible,
    validationMessage: primaryPricing.validationMessage,

    // Separate Inventory Valuation (Section 6)
    availableStock,
    totalStockWeight,
    totalStockCommission,
    totalSellerStockValue,
    totalStockSubtotal,
    totalStockValuation,

    // Aliases for backward compatibility
    sellerPrice: primaryPricing.sellerPricePerProductUnit,
    sellerUnitPrice: primaryPricing.sellerPricePerProductUnit,
    sellerB2bPrice: primaryB2bPricing.sellerPricePerProductUnit,
    commissionType,
    commissionValue,
    commissionRate: commissionValue,
    commissionAmount: primaryPricing.commissionPerProductUnit,
    unitCommission: primaryPricing.commissionPerProductUnit,
    subtotal: primaryPricing.customerUnitBasePrice,
    stockSubtotal: totalStockSubtotal,
    gstAmount: primaryPricing.gstAmountPerProductUnit,
    sellerGstAmount: primaryPricing.gstAmountPerProductUnit,
    stockGstAmount: primaryPricing.gstAmountPerProductUnit,
    totalAmount: primaryPricing.customerFinalPricePerProductUnit,
    stockTotalAmount: totalStockValuation,
    unitCustomerPrice: primaryPricing.customerFinalPricePerProductUnit,
    price: primaryPricing.customerFinalPricePerProductUnit,
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

  const unit = product.unit || 'pcs';
  const measurementUnit = product.measurementUnit || null;
  const unitSize = extractUnitSize(product.unitSize, 1);
  const adminRule = findCategoryCommission(commissions, product.categoryId, unit, measurementUnit, pincode);

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

  const extraOpts = { unit, measurementUnit, commissionRule: adminRule };
  const { customerPrice, commissionAmount } = calculateCustomerPrice(sellerPrice, commissionType, commissionValue, unitSize, 0, false, extraOpts);
  const { customerPrice: customerB2bPrice } = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue, unitSize, 0, false, extraOpts);

  const newB2c = (product.b2c || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
    const vUnitSize = extractUnitSize(v.unitSize || v.packetSize, unitSize);
    const { customerPrice: vCustomerPrice, commissionAmount: vCommAmt, sellerPricePerProductUnit: vSellerPricePerProductUnit, sellerPricePerBaseUnit: vSellerPricePerBaseUnit } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);
    return {
      ...v,
      unitSize: vUnitSize,
      sellerPrice: vSellerPricePerProductUnit,
      sellerPricePerBaseUnit: vSellerPricePerBaseUnit,
      sellerPricePerProductUnit: vSellerPricePerProductUnit,
      price: vCustomerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCommAmt,
      unitCommission: vCommAmt
    };
  });

  const newB2b = (product.b2b || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
    const vUnitSize = extractUnitSize(v.unitSize || v.packetSize, unitSize);
    const { customerPrice: vCustomerPrice, commissionAmount: vCommAmt, sellerPricePerProductUnit: vSellerPricePerProductUnit, sellerPricePerBaseUnit: vSellerPricePerBaseUnit } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);

    let newTiers = v.priceTiers;
    if (Array.isArray(v.priceTiers)) {
      newTiers = v.priceTiers.map(t => {
        const tSellerPrice = t.sellerPrice !== undefined && t.sellerPrice !== null ? t.sellerPrice : (t.price || 0);
        const { customerPrice: tCustomerPrice, sellerPricePerProductUnit: tSellerPricePerProductUnit, sellerPricePerBaseUnit: tSellerPricePerBaseUnit } = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue, vUnitSize, 0, false, extraOpts);
        return {
          ...t,
          sellerPrice: tSellerPricePerProductUnit,
          sellerPricePerBaseUnit: tSellerPricePerBaseUnit,
          sellerPricePerProductUnit: tSellerPricePerProductUnit,
          price: tCustomerPrice
        };
      });
    }

    return {
      ...v,
      unitSize: vUnitSize,
      sellerPrice: vSellerPricePerProductUnit,
      sellerPricePerBaseUnit: vSellerPricePerBaseUnit,
      sellerPricePerProductUnit: vSellerPricePerProductUnit,
      price: vCustomerPrice,
      commissionType,
      commissionValue,
      commissionAmount: vCommAmt,
      unitCommission: vCommAmt,
      priceTiers: newTiers
    };
  });

  let newPriceTiers = product.priceTiers;
  if (Array.isArray(product.priceTiers)) {
    newPriceTiers = product.priceTiers.map(t => {
      const tSellerPrice = t.sellerPrice !== undefined && t.sellerPrice !== null ? t.sellerPrice : (t.price || 0);
      const { customerPrice: tCustomerPrice } = calculateCustomerPrice(tSellerPrice, commissionType, commissionValue, unitSize, 0, false, extraOpts);
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
  const gstRate = typeof product.gstPercent === 'number' ? product.gstPercent : (parseFloat(product.gstPercent) || 0);
  const isGstInclusive = Boolean(product.isGstInclusive);

  const primaryPricing = calculateCustomerPrice(sellerPrice, commissionType, commissionValue, unitSize, gstRate, isGstInclusive, extraOpts);
  const primaryB2bPricing = calculateCustomerPrice(sellerB2bPrice, commissionType, commissionValue, unitSize, gstRate, isGstInclusive, extraOpts);

  // New Separate Inventory Valuation (Section 6)
  const totalStockWeight = round2(unitSize * Math.max(0, availableStock));
  const totalStockCommission = round2(primaryPricing.commissionPerProductUnit * Math.max(0, availableStock));
  const totalSellerStockValue = round2(primaryPricing.sellerPricePerProductUnit * Math.max(0, availableStock));
  const totalStockSubtotal = round2(totalSellerStockValue + totalStockCommission);
  const totalStockGst = isGstInclusive ? 0 : round2(totalStockSubtotal * (gstRate / 100));
  const totalStockValuation = isGstInclusive ? totalStockSubtotal : round2(totalStockSubtotal + totalStockGst);

  return {
    ...product,
    // 10-Step Breakdown Fields (Section 5)
    sellerPricePerBaseUnit: primaryPricing.sellerPricePerBaseUnit,
    productMeasurementUnit: primaryPricing.productMeasurementUnit,
    measurementUnit: primaryPricing.measurementUnit,
    unit: primaryPricing.unit,
    unitSize,
    sellerPricePerProductUnit: primaryPricing.sellerPricePerProductUnit,
    adminCommissionPerBaseUnit: primaryPricing.adminCommissionPerBaseUnit,
    commissionPerProductUnit: primaryPricing.commissionPerProductUnit,
    customerUnitBasePrice: primaryPricing.customerUnitBasePrice,
    gstPercent: gstRate,
    gstAmountPerProductUnit: primaryPricing.gstAmountPerProductUnit,
    customerFinalPricePerProductUnit: primaryPricing.customerFinalPricePerProductUnit,
    isCompatible: primaryPricing.isCompatible,
    validationMessage: primaryPricing.validationMessage,

    // Separate Inventory Valuation (Section 6)
    availableStock,
    totalStockWeight,
    totalStockCommission,
    totalSellerStockValue,
    totalStockSubtotal,
    totalStockValuation,

    // Aliases for backward compatibility
    sellerPrice: primaryPricing.sellerPricePerProductUnit,
    sellerUnitPrice: primaryPricing.sellerPricePerProductUnit,
    sellerB2bPrice: primaryB2bPricing.sellerPricePerProductUnit,
    commissionType,
    commissionValue,
    commissionRate: commissionValue,
    commissionAmount: primaryPricing.commissionPerProductUnit,
    unitCommission: primaryPricing.commissionPerProductUnit,
    subtotal: primaryPricing.customerUnitBasePrice,
    stockSubtotal: totalStockSubtotal,
    gstAmount: primaryPricing.gstAmountPerProductUnit,
    sellerGstAmount: primaryPricing.gstAmountPerProductUnit,
    stockGstAmount: primaryPricing.gstAmountPerProductUnit,
    totalAmount: primaryPricing.customerFinalPricePerProductUnit,
    stockTotalAmount: totalStockValuation,
    stockTotalCommission: totalStockCommission,
    isGstInclusive,
    unitCustomerPrice: primaryPricing.customerFinalPricePerProductUnit,
    price: primaryPricing.customerFinalPricePerProductUnit,
    b2bPrice: finalCustomerB2bPrice,
    b2c: newB2c,
    b2b: newB2b,
    priceTiers: newPriceTiers
  };
}

/**
 * Exact pricing breakdown calculation based on selected quantity, unit size, and commission rules.
 * Implements the exact centralized formula from Section 2, 3, 4, 5, 6:
 *
 * Step 1 – Seller Price Per Product Unit:
 *   Seller Price Per Bag = Seller Price Per Base Unit * Product Unit Size (e.g. 50 * 30 = ₹1,500)
 * Step 2 – Commission Per Product Unit:
 *   Commission Per Bag = Admin Commission Rate * Product Unit Size * ConversionFactor (e.g. 20 * 30 = ₹600)
 * Step 3 – Customer Unit Base Price:
 *   Customer Unit Base Price = Seller Price Per Bag + Commission Per Bag (1500 + 600 = ₹2,100)
 * Step 4 – Total Seller Amount:
 *   Total Seller Amount = Seller Price Per Bag * Ordered Quantity (1500 * 2 = ₹3,000)
 * Step 5 – Total Commission:
 *   Total Commission = Commission Per Bag * Ordered Quantity (600 * 2 = ₹1,200)
 * Step 6 – Subtotal:
 *   Subtotal = Total Seller Amount + Total Commission (3000 + 1200 = ₹4,200)
 * Step 7 – GST:
 *   GST = Subtotal * (GST Rate / 100)
 * Step 8 – Final Customer Amount:
 *   Final Customer Amount = Subtotal + GST
 */
function calculatePricingBreakdown({
  sellerUnitPrice = 0,
  sellerPricePerBaseUnit = undefined,
  commissionType = 'flat',
  commissionValue = 0,
  commissionRate = undefined,
  commissionBasisRate = undefined,
  unit = 'unit',
  measurementUnit = null,
  commissionUnit = null,
  unitSize = 1,
  gstPercent = 0,
  quantity = 1,
  orderedQuantity = undefined,
  availableStock = 0,
  isB2B = false,
  isGstInclusive = false
}) {
  const rawQty = orderedQuantity !== undefined ? orderedQuantity : quantity;
  const qty = parseInt(rawQty, 10) > 0 ? parseInt(rawQty, 10) : 1;
  const uSize = extractUnitSize(unitSize, 1);

  // Determine base seller price per unit of measurement (e.g. ₹50 / KG)
  let baseSellerPrice = 0;
  if (sellerPricePerBaseUnit !== undefined && sellerPricePerBaseUnit !== null) {
    baseSellerPrice = parseFloat(sellerPricePerBaseUnit) || 0;
  } else {
    baseSellerPrice = parseFloat(sellerUnitPrice) || 0;
  }

  const productBasis = resolveMeasurementBasis(unit, measurementUnit, uSize);
  const compatibility = checkCommissionCompatibility(productBasis, commissionUnit || unit);

  // Step 1: Seller Price Per Product Unit (e.g. 50 * 30 = 1500)
  const sellerPricePerProductUnit = round2(baseSellerPrice * uSize);

  // Step 2: Commission Per Product Unit (e.g. 20 * 30 = 600)
  const rawCommVal = commissionRate !== undefined ? commissionRate : commissionValue;
  const cVal = typeof rawCommVal === 'number' ? rawCommVal : (parseFloat(rawCommVal) || 0);
  const cType = commissionType === 'percentage' ? 'percentage' : 'flat';

  let commissionPerProductUnit = 0;
  if (commissionBasisRate !== undefined && commissionBasisRate !== null) {
    commissionPerProductUnit = round2(Number(commissionBasisRate) || 0);
  } else if (cType === 'flat') {
    const factor = compatibility.isCompatible ? (compatibility.conversionFactor !== undefined ? compatibility.conversionFactor : 1) : 1;
    commissionPerProductUnit = round2(cVal * factor * uSize);
  } else {
    commissionPerProductUnit = round2((sellerPricePerProductUnit * cVal) / 100);
  }

  // Step 3: Customer Unit Base Price (1500 + 600 = 2100)
  const customerUnitBasePrice = round2(sellerPricePerProductUnit + commissionPerProductUnit);

  // Step 4: Total Seller Amount (1500 * 2 = 3000)
  const totalSellerAmount = round2(sellerPricePerProductUnit * qty);

  // Step 5: Total Commission (600 * 2 = 1200)
  const totalCommission = round2(commissionPerProductUnit * qty);

  // Step 6: Subtotal (3000 + 1200 = 4200)
  const subtotal = round2(totalSellerAmount + totalCommission);

  // Step 7: GST
  const gstRate = typeof gstPercent === 'number' ? gstPercent : (parseFloat(gstPercent) || 0);
  let totalGst = 0;
  let finalCustomerAmount = subtotal;

  if (gstRate > 0) {
    if (isGstInclusive) {
      const baseBeforeTax = subtotal / (1 + gstRate / 100);
      totalGst = round2(subtotal - baseBeforeTax);
      finalCustomerAmount = subtotal;
    } else {
      totalGst = round2(subtotal * (gstRate / 100));
      finalCustomerAmount = round2(subtotal + totalGst);
    }
  }

  // Unit-level breakdown for display
  const unitGst = round2(totalGst / qty);
  const unitFinalCustomerPrice = round2(finalCustomerAmount / qty);
  const totalProductWeight = round2(uSize * qty);

  // Total Stock Valuation (Calculated separately for available stock)
  const stock = typeof availableStock === 'number' ? availableStock : (parseInt(availableStock, 10) || 0);
  const totalStockWeight = round2(uSize * Math.max(0, stock));
  const totalStockCommission = round2(commissionPerProductUnit * Math.max(0, stock));
  const totalSellerStockValue = round2(sellerPricePerProductUnit * Math.max(0, stock));
  const totalStockSubtotal = round2(totalSellerStockValue + totalStockCommission);
  const totalStockGst = isGstInclusive ? 0 : round2(totalStockSubtotal * (gstRate / 100));
  const totalStockValuation = isGstInclusive ? totalStockSubtotal : round2(totalStockSubtotal + totalStockGst);

  return {
    // 10-step Product Breakdown items (Section 5)
    sellerPricePerBaseUnit: baseSellerPrice,
    productMeasurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
    measurementUnit: productBasis.measurementUnit || productBasis.packagingUnit,
    unit: productBasis.packagingUnit,
    unitSize: uSize,
    sellerPricePerProductUnit,
    adminCommissionPerBaseUnit: cVal,
    commissionPerProductUnit,
    customerUnitBasePrice,
    gstPercent: gstRate,
    gstAmountPerProductUnit: unitGst,
    customerFinalPricePerProductUnit: unitFinalCustomerPrice,

    // Custom unit validation status (Section 6)
    isCompatible: compatibility.isCompatible,
    validationMessage: compatibility.validationMessage || null,

    // Ordered Quantity Totals (Section 2, 3, 4, 8)
    orderedQuantity: qty,
    quantity: qty,
    totalProductWeight,
    totalSellerAmount,
    totalCommission,
    subtotal,
    gstAmount: totalGst,
    totalGst,
    finalCustomerAmount,

    // Stock Valuation (Section 6)
    availableStock: stock,
    totalStockWeight,
    totalStockCommission,
    totalSellerStockValue,
    totalStockSubtotal,
    totalStockValuation,

    // Backward compatibility aliases
    sellerPrice: sellerPricePerProductUnit,
    sellerUnitPrice: sellerPricePerProductUnit,
    unitCommission: commissionPerProductUnit,
    commissionType: cType,
    commissionRate: cVal,
    price: customerUnitBasePrice,
    unitCustomerPrice: unitFinalCustomerPrice,
    totalAmount: finalCustomerAmount,
    stockTotalCommission: totalStockCommission,
    stockSubtotal: totalStockSubtotal,
    sellerGstAmount: unitGst,
    totalSellerPrice: totalSellerAmount,
    finalCustomerPrice: finalCustomerAmount,
    totalCustomerBase: subtotal,
    unitGst,
    isGstInclusive
  };
}

module.exports = {
  round2,
  normalizeUnit,
  extractUnitSize,
  convertMeasurement,
  getUnitConversionFactor,
  resolveMeasurementBasis,
  checkCommissionCompatibility,
  BASE_MEASUREMENT_UNITS,
  PACKAGING_UNITS,
  calculatePricingBreakdown,
  findCategoryCommission,
  calculateCustomerPrice,
  processProductPricing,
  applyCommission
};
