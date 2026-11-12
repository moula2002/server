const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  subCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' }, // Optional as requested
  price: { type: Number }, // Final customer selling price (B2C)
  b2bPrice: { type: Number }, // Final customer selling price (B2B)
  sellerPrice: { type: Number }, // Base seller selling price (B2C)
  sellerB2bPrice: { type: Number }, // Base seller selling price (B2B)
  sellerUnitPrice: { type: Number },
  commissionType: { type: String, enum: ['percentage', 'flat'], default: 'flat' },
  commissionValue: { type: Number, default: 0 },
  commissionRate: { type: Number, default: 0 },
  commissionAmount: { type: Number, default: 0 }, // Evaluated commission per unit
  unitCommission: { type: Number, default: 0 },
  stockTotalCommission: { type: Number, default: 0 },
  subtotal: { type: Number, default: 0 },
  stockSubtotal: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  sellerGstAmount: { type: Number, default: 0 },
  stockGstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  stockTotalAmount: { type: Number, default: 0 },
  isGstInclusive: { type: Boolean, default: false },
  unitCustomerPrice: { type: Number },
  gstPercent: { type: Number, default: 0 },
  moq: { type: Number, default: 1 },
  maxOrderQuantity: { type: Number, default: null },
  unit: { type: String, required: true },
  sellingUnit: { type: String, default: 'BOX' },
  unitSize: { type: Number, default: 1 },
  measurementUnit: { type: String, default: null },
  sellerPricePerBaseUnit: { type: Number, default: 0 },
  sellerPricePerProductUnit: { type: Number, default: 0 },
  adminCommissionPerBaseUnit: { type: Number, default: 0 },
  commissionPerProductUnit: { type: Number, default: 0 },
  customerUnitBasePrice: { type: Number, default: 0 },
  gstAmountPerProductUnit: { type: Number, default: 0 },
  customerFinalPricePerProductUnit: { type: Number, default: 0 },
  totalStockWeight: { type: Number, default: 0 },
  totalSellerStockValue: { type: Number, default: 0 },
  totalStockSubtotal: { type: Number, default: 0 },
  totalStockValuation: { type: Number, default: 0 },
  customUnits: [{ type: String }],
  imageUrl: { type: String },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
  sellerName: { type: String, default: 'Zudo Official' },
  stock: { type: Number, default: 0 },
  hsn: { type: String, default: '' },
  stockStatus: { type: String, enum: ['Available', 'Out of Stock'], default: 'Available' }, // Added stock
  isProductVisible: { type: Boolean, default: true },
  description: { type: String },
  pdfUrl: { type: String },
  rating: { type: Number, default: 0 },
  numReviews: { type: Number, default: 0 },
  variants: [{
    sizeName: { type: String, required: true }, // e.g. "1kg", "500g"
    unitSize: { type: Number, default: 1 },
    price: { type: Number, required: true },
    sellerPrice: { type: Number },
    b2bPrice: { type: Number, required: true },
    stock: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    priceTiers: [{
      minQty: { type: Number, required: true },
      price: { type: Number, required: true },
      sellerPrice: { type: Number }
    }]
  }],
  b2c: [{
    packetSize: { type: String },
    unitSize: { type: Number, default: 1 },
    mrp: { type: Number },
    price: { type: Number },
    sellerPrice: { type: Number },
    stock: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 }
  }],
  b2b: [{
    packetSize: { type: String },
    unitSize: { type: Number, default: 1 },
    mrp: { type: Number },
    price: { type: Number },
    sellerPrice: { type: Number },
    stock: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    priceTiers: [{
      minQty: { type: Number, required: true },
      price: { type: Number, required: true },
      sellerPrice: { type: Number }
    }]
  }],
  priceTiers: [{
    minQty: { type: Number, required: true },
    price: { type: Number, required: true },
    sellerPrice: { type: Number }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
