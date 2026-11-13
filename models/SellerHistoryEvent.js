const mongoose = require('mongoose');

const sellerHistoryEventSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  activityType: {
    type: String,
    enum: ['payments', 'returns', 'pickups', 'statusUpdates'],
    required: true
  },
  activity: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  amount: {
    type: Number,
    default: null
  },
  status: {
    type: String,
    default: ''
  },
  occurredAt: {
    type: Date,
    required: true
  },
  eventKey: {
    type: String,
    required: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, { timestamps: true });

sellerHistoryEventSchema.index({ sellerId: 1, eventKey: 1 }, { unique: true });
sellerHistoryEventSchema.index({ sellerId: 1, occurredAt: -1 });
sellerHistoryEventSchema.index({ orderId: 1, occurredAt: -1 });

module.exports = mongoose.model('SellerHistoryEvent', sellerHistoryEventSchema);
