const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const driverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, unique: true },
  password: { type: String, required: true },
  licenseNumber: { type: String, required: true },
  vehicleDetails: { type: String, required: true },
  vehicleNo: { type: String },
  drivingLicense: { type: String },
  aadharNumber: { type: String },
  wallet: { type: Number, default: 0 },
  type: { type: String, enum: ['b2b', 'b2c'], default: 'b2c' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  currentLocation: {
    lat: { type: Number },
    lng: { type: Number },
    updatedAt: { type: Date }
  },
  tokenVersion: { type: Number, default: 0 },
  cashManagement: { type: Boolean, default: false },
  currentSessionToken: { type: String, default: null },
  route1: { type: String, default: null },
  route2: { type: String, default: null },
  route3: { type: String, default: null },
  documents: [{
    name: { type: String, required: true },
    url: { type: String, required: true },
    validityDate: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'approved', 'expired'], default: 'approved' }
  }]
}, { timestamps: true });

// Hash password before saving
driverSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  
  // Skip if already a bcrypt hash to avoid double-hashing
  if (this.password && this.password.startsWith('$2') && this.password.length === 60) {
    return;
  }
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
driverSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Driver', driverSchema);
