const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  title: {
    type: String,
    trim: true,
    default: ''
  },
  comment: {
    type: String,
    required: true,
    trim: true
  },
  media: [{
    url: String,
    type: {
      type: String,
      enum: ['image', 'video'],
      default: 'image'
    }
  }],
  status: {
    type: String,
    enum: ['Approved', 'Pending', 'Rejected'],
    default: 'Approved'
  },
  isVerifiedPurchase: {
    type: Boolean,
    default: false
  },
  helpfulVotes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  helpfulCount: {
    type: Number,
    default: 0
  },
  adminReply: {
    comment: { type: String, default: null },
    repliedAt: { type: Date, default: null },
    repliedBy: { type: String, default: 'Zudo Team' }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Prevent duplicate review submissions by same user for same product
reviewSchema.index({ userId: 1, productId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, status: 1 });

module.exports = mongoose.model('Review', reviewSchema);
