const mongoose = require('mongoose');

const invoiceImageSchema = new mongoose.Schema({
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SellerInvoice',
    required: true,
    index: true
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },
  filename: {
    type: String,
    required: true
  },
  originalName: {
    type: String,
    required: false
  },
  mimeType: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: false
  },
  fileSize: {
    type: Number,
    required: false
  },
  imageData: {
    type: Buffer,
    required: false
  },
  data: {
    type: Buffer,
    required: false
  }
}, { timestamps: true });

module.exports = mongoose.model('InvoiceImage', invoiceImageSchema);

