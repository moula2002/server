const mongoose = require('mongoose');

const sellerPaymentSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    required: true,
    default: 'Bank Transfer'
  },
  transactionId: {
    type: String,
    default: ''
  },
  utrReference: {
    type: String,
    default: ''
  },
  proofUrl: {
    type: String,
    default: null
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  adminName: {
    type: String,
    default: 'Admin'
  },
  previousOutstanding: {
    type: Number,
    default: 0
  },
  remainingOutstanding: {
    type: Number,
    default: 0
  },
  settlementType: {
    type: String,
    enum: ['Full Settlement', 'Partial Settlement', 'Adjustment'],
    default: 'Partial Settlement'
  },
  status: {
    type: String,
    enum: ['Completed', 'Reversed'],
    default: 'Completed'
  },
  remarks: {
    type: String,
    default: ''
  },
  date: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('SellerPayment', sellerPaymentSchema);
