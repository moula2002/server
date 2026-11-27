const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['super_admin', 'superadmin', 'normal_admin', 'sales', 'accounting', 'manager', 'logistics', 'cash_collector', 'b2b_admin', 'b2c_admin'], 
    default: 'manager' 
  },
  name: { type: String, required: true },
  phone: { type: String },
  locationId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Location',
    default: null 
  },
  targetSegment: {
    type: String,
    enum: ['B2B', 'B2C', 'Both'],
    default: 'Both'
  },
  permissions: [{
    type: String,
    enum: [
      'view_dashboard', 'manage_products', 'manage_categories', 'manage_subcategories',
      'manage_drivers', 'manage_sellers', 'manage_users', 'manage_b2b_verification',
      'manage_orders', 'manage_deliveries', 'manage_reviews', 'manage_bulk_upload',
      'manage_cash', 'manage_admins', 'manage_locations', 'manage_profile', 'manage_invoices'
    ]
  }],
  tokenVersion: { type: Number, default: 0 },
  currentSessionToken: { type: String, default: null },
  pincodes: [{ type: String }]
}, { timestamps: true });

adminSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

adminSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
