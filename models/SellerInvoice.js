const mongoose = require('mongoose');

const sellerInvoiceSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
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
  invoiceImage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvoiceImage',
    default: null
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
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller'
  }
}, { timestamps: true });

// Prevent duplicate invoice number for the same seller
sellerInvoiceSchema.index({ sellerId: 1, invoiceNumber: 1 }, { unique: true });

module.exports = mongoose.model('SellerInvoice', sellerInvoiceSchema);
