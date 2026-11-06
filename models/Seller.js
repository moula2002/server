const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const sellerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String },
  password: { type: String, required: true },
  storeName: { type: String },
  businessName: { type: String },
  businessAddress: { type: String },
  gstNumber: { type: String },
  panNumber: { type: String },
  isVerified: { type: Boolean, default: false },
  isProfileComplete: { type: Boolean, default: false },
  gstDoc: { type: String },
  panDoc: { type: String },
  storePic: { type: String },
  tradeLicenseDoc: { type: String },
  rmcAmpcDoc: { type: String },
  foodLicenseDoc: { type: String },
  qrCodeDoc: { type: String },
  qrOption: { type: String },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  },
  profilePicture: { type: String },
  pickupLocation: {
    address: String,
    lat: Number,
    lng: Number
  },
  tokenVersion: { type: Number, default: 0 },
  creditDays: { type: Number, default: 0 },
  currentSessionToken: { type: String, default: null },
  b2b: { type: Boolean, default: false },
  b2c: { type: Boolean, default: false },
  isProductVisible: { type: Boolean, default: true }
}, { timestamps: true });

sellerSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

sellerSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Seller', sellerSchema);
