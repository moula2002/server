const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  image: { type: String },
  type: { 
    type: String, 
    enum: ['info', 'success', 'warning', 'error', 'order', 'user'], 
    default: 'info' 
  },
  recipient: {
    type: String,
    enum: ['all', 'b2b', 'b2c', 'drivers', 'sellers'],
    default: 'all'
  },
  locationId: { 
    type: mongoose.Schema.Types.Mixed, 
    ref: 'Location',
    default: null 
  },
  isRead: { type: Boolean, default: false },
  scheduledAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
