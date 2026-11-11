const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  unit: {
    type: String,
    required: true
  },
  commissionBasis: {
    type: String, // e.g. 'KG', 'LTR', 'G', 'ML'
    default: null
  },
  commissionRate: {
    type: Number,
    default: null
  },
  commissionStatus: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  commissionType: {
    type: String,
    enum: ['percentage', 'flat'],
    default: 'percentage'
  },
  commissionValue: {
    type: Number,
    required: true,
    default: 0
  },
  pincode: {
    type: String,
    default: 'All'
  }
}, { timestamps: true });

// Enforce unique combination of category, unit, and pincode
commissionSchema.index({ categoryId: 1, unit: 1, pincode: 1 }, { unique: true });

module.exports = mongoose.model('Commission', commissionSchema);
