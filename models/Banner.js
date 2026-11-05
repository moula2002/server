const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  imageUrl: { type: String, required: true },
  link: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  locationId: { 
    type: mongoose.Schema.Types.Mixed, 
    default: null 
  },
  type: {
    type: String,
    enum: ['Main', 'Sidebar', 'Promotion'],
    default: 'Main'
  }
}, { timestamps: true });

module.exports = mongoose.model('Banner', bannerSchema);
