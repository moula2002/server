const mongoose = require('mongoose');

const sellerInvoiceSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },
  sellerName: {
    type: String,
    trim: true
  },
  invoiceNumber: {
    type: String,
    required: true,
    trim: true
  },
  invoiceSequenceNumber: {
    type: Number,
    required: false,
    index: true
  },
  imageIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvoiceImage'
  }],
  invoiceImage: {
    data: {
      type: Buffer,
      default: null
    },
    contentType: {
      type: String,
      default: null
    },
    fileName: {
      type: String,
      default: null
    },
    size: {
      type: Number,
      default: null
    }
  },
  hasInvoiceImage: {
    type: Boolean,
    default: false
  },
  imageMetadata: {
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  totalAmount: {
    type: Number,
    required: true,
    default: 0
  },
  totalCommission: {
    type: Number,
    required: true,
    default: 0
  },
  netAmount: {
    type: Number,
    required: true,
    default: 0
  },
  orderCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['Pending', 'Cleared'],
    default: 'Pending'
  },
  orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  }],
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  orderNumber: {
    type: Number,
    default: null
  },
  orderRef: {
    type: String,
    default: null
  },
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller'
  }
}, { timestamps: true });

// Prevent duplicate invoice number for the same seller
sellerInvoiceSchema.index({ sellerId: 1, invoiceNumber: 1 }, { unique: true });
sellerInvoiceSchema.index({ sellerId: 1, createdAt: -1 });

module.exports = mongoose.model('SellerInvoice', sellerInvoiceSchema);
