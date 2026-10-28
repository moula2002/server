const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['b2b', 'b2c']
  },
  locationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    default: null
  },
  items: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    variantSize: {
      type: String,
      default: null
    },
    name: String,
    quantity: {
      type: Number,
      required: true
    },
    price: {
      type: Number,
      required: true
    },
    normalPrice: {
      type: Number,
      default: 0
    },
    commissionType: { type: String, default: 'flat' },
    commissionValue: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    totalCommission: { type: Number, default: 0 },
    image: String,
    seller: {
      sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
      name: String,
      phone: String,
      address: String,
      lat: Number,
      lng: Number
    },
    // Add nested product for frontend compatibility
    product: {
      name: String,
      image: String,
      imageUrl: String
    },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    returnStatus: { 
      type: String, 
      enum: ['None', 'Return Requested', 'Return Approved', 'Return Rejected', 'Picked Up from Customer', 'Returned to Seller'], 
      default: 'None' 
    },
    returnReason: { type: String, default: null },
    returnComment: { type: String, default: null },
    returnImage: { type: String, default: null },
    refundAccountName: { type: String, default: null },
    refundBankName: { type: String, default: null },
    refundAccountNumber: { type: String, default: null },
    refundIfscCode: { type: String, default: null }
  }],
  totalAmount: {
    type: Number,
    required: true
  },
  totalAmountWithoutCommissions: {
    type: Number,
    default: 0
  },
  totalCommissionAmount: {
    type: Number,
    default: 0
  },
  totalGstAmount: {
    type: Number,
    default: 0
  },
  shippingAddress: {
    name: String,
    phone: String,
    address: String,
    city: String,
    pincode: String,
    state: String,
    lat: Number,
    lng: Number
  },
  paymentMethod: {
    type: String,
    required: true
  },
  paymentStatus: {
    type: String,
    default: 'Pending' // Match frontend "Completed" or "Pending"
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver'
  },
  cashPersonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CashCollector'
  },
  pickupCode: {
    type: String
  },
  sellerPickups: [{
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
    status: { type: String, default: 'Pending' },
    pickupCode: String
  }],
  deliveryOtp: {
    type: String,
    default: null
  },
  returnReason: {
    type: String,
    default: null
  },
  returnImage: {
    type: String,
    default: null
  },
  returnComment: {
    type: String,
    default: null
  },
  returnStatus: { 
    type: String, 
    enum: ['None', 'Requested', 'Approved', 'Rejected', 'Completed'], 
    default: 'None' 
  },
  returnDriverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null
  },
  returnCustomerOtp: {
    type: String,
    default: null
  },
  sellerReturnPickups: [{
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller' },
    status: { type: String, enum: ['Pending', 'Returned to Seller'], default: 'Pending' },
    returnOtp: String
  }],
  orderStatus: {
    type: String,
    enum: ['Pending', 'Packed', 'Picked Up', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned', 'Assigned', 'Accepted', 'Confirmed', 'Return Requested', 'Return Driver Assigned', 'Out for Return', 'Return Picked Up', 'Partially Returned'],
    default: 'Pending'
  },
  paymentScreenshot: {
    type: String
  },
  paidAt: {
    type: Date
  },
  deliverySlot: {
    id: String,
    startTime: String,
    endTime: String
  },
  placedBySalesAssociate: {
    type: Boolean,
    default: false
  },
  salesAssociateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  isPrinted: {
    type: Boolean,
    default: false
  },
  qrCodeDoc: {
    type: String,
    default: null
  },
  qrOption: {
    type: String,
    default: null
  },
  route1: {
    type: String,
    default: null
  },
  route2: {
    type: String,
    default: null
  },
  route3: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
