const mongoose = require('mongoose');

const popupAdSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  imageUrl: { type: String, required: true },
  link: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  locationId: { 
    type: mongoose.Schema.Types.Mixed, 
    default: null 
  },
  showOn: {
    type: String,
    enum: ['Home', 'Categories', 'Products', 'All'],
    default: 'Home'
  },
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('PopupAd', popupAdSchema);
