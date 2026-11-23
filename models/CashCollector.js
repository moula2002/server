const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const cashCollectorSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['B2C', 'B2B', 'B2C (Driver)', 'B2C Driver', 'Account', 'Other'],
    default: 'B2C'
  },
  name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: false,
    default: ''
  },
  email: {
    type: String
  },
  password: {
    type: String
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'Verified', 'Pending', 'Completed', 'Settled'],
    default: 'Verified'
  },
  amount: {
    type: Number,
    default: 0
  },
  description: {
    type: String
  },
  paymentMethod: {
    type: String,
    default: 'Cash'
  },
  otp: {
    type: String
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver'
  },
  orderId: {
    type: String
  },
  verification: {
    type: String,
    default: 'Verified'
  },
  settledBy: {
    type: String
  },
  date: {
    type: Date,
    default: Date.now
  },
  tokenVersion: {
    type: Number,
    default: 0
  }
}, { 
  timestamps: true,
  collection: 'cashcollectors' 
});

// Hash password before saving
cashCollectorSchema.pre('save', async function() {
  if (!this.isModified('password') || !this.password) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
cashCollectorSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('CashCollector', cashCollectorSchema);
