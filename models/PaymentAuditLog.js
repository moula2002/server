const mongoose = require('mongoose');

const paymentAuditLogSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    default: null
  },
  sellerName: {
    type: String,
    default: null
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SellerPayment',
    default: null
  },
  action: {
    type: String,
    required: true,
    enum: [
      'COD_COLLECTED',
      'COD_NOT_COLLECTED',
      'COD_VERIFIED',
      'COD_SETTLEMENT_APPROVED',
      'COD_SETTLEMENT_REJECTED',
      'ONLINE_VERIFIED',
      'ONLINE_SETTLEMENT_APPROVED',
      'ONLINE_SETTLEMENT_REJECTED',
      'MANUAL_SETTLEMENT',
      'STATUS_UPDATED',
      'REMARKS_ADDED'
    ]
  },
  previousStatus: {
    type: String,
    default: null
  },
  updatedStatus: {
    type: String,
    default: null
  },
  amount: {
    type: Number,
    default: 0
  },
  paymentMethod: {
    type: String,
    default: null
  },
  transactionReference: {
    type: String,
    default: null
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
  remarks: {
    type: String,
    default: null
  },
  date: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('PaymentAuditLog', paymentAuditLogSchema);

