const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  subCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' }, // Optional as requested
  price: { type: Number }, // Final customer selling price (B2C)
  b2bPrice: { type: Number }, // Final customer selling price (B2B)
  sellerPrice: { type: Number }, // Base seller selling price (B2C)
  sellerB2bPrice: { type: Number }, // Base seller selling price (B2B)
  commissionType: { type: String, enum: ['percentage', 'flat'], default: 'flat' },
  commissionValue: { type: Number, default: 0 },
  commissionAmount: { type: Number, default: 0 }, // Evaluated commission per unit
  gstPercent: { type: Number, default: 0 },
  moq: { type: Number, default: 1 },
  unit: { type: String, required: true },
  imageUrl: { type: String },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
  sellerName: { type: String, default: 'Zudo Official' },
  stock: { type: Number, default: 0 },
  hsn: { type: String, default: '' },
  stockStatus: { type: String, enum: ['Available', 'Out of Stock'], default: 'Available' }, // Added stock
  description: { type: String },
  pdfUrl: { type: String },
  rating: { type: Number, default: 0 },
  variants: [{
    sizeName: { type: String, required: true }, // e.g. "1kg", "500g"
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
    mrp: { type: Number },
    price: { type: Number },
    sellerPrice: { type: Number },
    stock: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 }
  }],
  b2b: [{
    packetSize: { type: String },
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
