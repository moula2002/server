/**
 * Pricing and Commission utility module for Zudo platform
 */

/**
 * Finds the applicable commission rule from category commissions array.
 * Priority:
 * 1. Category ID AND matching unit (case-insensitive)
 * 2. Category ID (fallback for any unit)
 */
function findCategoryCommission(commissions, categoryId, unit) {
  if (!commissions || !Array.isArray(commissions) || commissions.length === 0) return null;
  const catIdStr = categoryId?._id?.toString() || categoryId?.toString();
  if (!catIdStr) return null;

  const unitClean = (unit || '').trim().toLowerCase();

  // Try matching category + unit first
  if (unitClean) {
    const unitMatch = commissions.find(c => {
      const cCatId = c.categoryId?._id?.toString() || c.categoryId?.toString();
      const cUnit = (c.unit || '').trim().toLowerCase();
      return cCatId === catIdStr && cUnit === unitClean;
    });
    if (unitMatch) return unitMatch;
  }

  // Fallback to category only
  const catMatch = commissions.find(c => {
    const cCatId = c.categoryId?._id?.toString() || c.categoryId?.toString();
    return cCatId === catIdStr;
  });

  return catMatch || null;
}

/**
 * Calculate customer price given a base seller price, commission type, and commission value.
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

  const finalCustomerPrice = parseFloat((sPrice + commissionAmount).toFixed(2));
  return {
    customerPrice: finalCustomerPrice,
    commissionAmount: parseFloat(commissionAmount.toFixed(2))
  };
}

/**
 * Process a product payload (for create/update/recalculate), ensuring seller prices,
 * commissions, and customer prices are consistently calculated and structured.
 */
function processProductPricing(payload, commissions = []) {
  const categoryId = payload.categoryId;
  const unit = payload.unit || 'pcs';

  let commissionType = payload.commissionType;
  let commissionValue = payload.commissionValue;

  const adminRule = findCategoryCommission(commissions, categoryId, unit);

  if (commissionValue === undefined || commissionValue === null || commissionValue === '') {
    if (adminRule) {
      commissionType = adminRule.commissionType || 'flat';
      commissionValue = adminRule.commissionValue || 0;
    } else {
      commissionType = 'flat';
      commissionValue = 0;
    }
  } else {
    commissionValue = parseFloat(commissionValue) || 0;
    commissionType = commissionType === 'percentage' ? 'percentage' : 'flat';
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
      price: vCalc.customerPrice
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

  return {
    ...payload,
    sellerPrice,
    sellerB2bPrice,
    commissionType,
    commissionValue,
    commissionAmount,
    price: finalPrice,
    b2bPrice: finalB2bPrice,
    b2c: processedB2c,
    b2b: processedB2b,
    priceTiers: processedPriceTiers
  };
}

/**
 * Apply commission dynamically to a product retrieved from DB.
 * Ensures idempotent calculation: ALWAYS calculates customer price based on sellerPrice!
 * Never multiplies or inflates an already inflated price!
 */
function applyCommission(product, commissions = []) {
  if (!product) return product;

  const adminRule = findCategoryCommission(commissions, product.categoryId, product.unit);
  const commissionType = product.commissionType || (adminRule ? adminRule.commissionType : 'flat') || 'flat';
  const commissionValue = (product.commissionValue !== undefined && product.commissionValue !== null)
    ? product.commissionValue
    : (adminRule ? adminRule.commissionValue : 0);

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
    const { customerPrice: vCustomerPrice } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);
    return {
      ...v,
      sellerPrice: vSellerPrice,
      price: vCustomerPrice
    };
  });

  const newB2b = (product.b2b || []).map(v => {
    const vSellerPrice = v.sellerPrice !== undefined && v.sellerPrice !== null ? v.sellerPrice : (v.price || 0);
    const { customerPrice: vCustomerPrice } = calculateCustomerPrice(vSellerPrice, commissionType, commissionValue);

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

  return {
    ...product,
    sellerPrice,
    sellerB2bPrice,
    commissionType,
    commissionValue,
    commissionAmount,
    price: finalCustomerPrice,
    b2bPrice: finalCustomerB2bPrice,
    b2c: newB2c,
    b2b: newB2b,
    priceTiers: newPriceTiers
  };
}

module.exports = {
  findCategoryCommission,
  calculateCustomerPrice,
  processProductPricing,
  applyCommission
};
