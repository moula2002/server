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
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
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
    commissionRate: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    unitCommission: { type: Number, default: 0 },
    totalCommission: { type: Number, default: 0 },
    // Section 9 Immutable Pricing Snapshot
    packagingType: { type: String, default: null },
    measurementBasis: { type: String, default: null },
    measurementUnit: { type: String, default: null },
    productUnitSize: { type: Number, default: 1 },
    unitSize: { type: Number, default: 1 },
    sellerPriceBasis: { type: String, default: 'per_unit' },
    sellerPricePerBaseUnit: { type: Number, default: 0 },
    sellerPricePerPackage: { type: Number, default: 0 },
    sellerPricePerProductUnit: { type: Number, default: 0 },
    adminCommissionRate: { type: Number, default: 0 },
    adminCommissionPerBaseUnit: { type: Number, default: 0 },
    commissionMeasurementUnit: { type: String, default: null },
    commissionPerPackage: { type: Number, default: 0 },
    commissionPerProductUnit: { type: Number, default: 0 },
    orderedQuantity: { type: Number, default: 1 },
    totalMeasurementQuantity: { type: Number, default: 0 },
    totalMeasurement: { type: Number, default: null },
    totalSellerAmount: { type: Number, default: 0 },
    totalSellerPrice: { type: Number, default: 0 },
    gstRate: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    finalCustomerAmount: { type: Number, default: 0 },
    finalCustomerPrice: { type: Number, default: 0 },
    customerUnitBasePrice: { type: Number, default: 0 },
    unitCustomerPrice: { type: Number, default: 0 },
    sellingUnit: { type: String, default: null },
    commissionBasis: { type: String, default: null },
    sellerUnitPrice: { type: Number, default: 0 },
    availableStock: { type: Number },
    stockTotalCommission: { type: Number },
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
    unit: { type: String, default: null },
    totalProductWeight: { type: Number, default: 0 },
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
    default: 'Pending' // Customer Payment Status: Pending, Paid, Completed, Failed, Refunded
  },
  // COD Payment Management
  codCollectionStatus: {
    type: String,
    enum: ['Not Collected', 'Collected', 'Verified', 'Disputed'],
    default: 'Not Collected'
  },
  codCollectedAmount: {
    type: Number,
    default: 0
  },
  codCollectedAt: {
    type: Date,
    default: null
  },
  codCollectedBy: {
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String, default: null },
    role: { type: String, default: null }
  },
  codVerifiedAt: {
    type: Date,
    default: null
  },
  codVerifiedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    name: { type: String, default: null }
  },
  codReference: {
    type: String,
    default: null
  },
  codRemarks: {
    type: String,
    default: null
  },
  // Online Payment Management
  onlinePaymentGateway: {
    type: String,
    default: null
  },
  onlineTransactionId: {
    type: String,
    default: null
  },
  onlinePaymentStatus: {
    type: String,
    enum: ['Pending', 'Verified', 'Failed', 'Refunded'],
    default: 'Pending'
  },
  onlineVerifiedAt: {
    type: Date,
    default: null
  },
  onlineVerifiedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    name: { type: String, default: null }
  },
  onlineRemarks: {
    type: String,
    default: null
  },
  // Seller Settlement Status (distinct from customer payment and COD collection)
  sellerSettlementStatus: {
    type: String,
    enum: ['Pending', 'Approved', 'Processing', 'Partially Settled', 'Settled', 'Rejected'],
    default: 'Pending'
  },
  sellerSettledAmount: {
    type: Number,
    default: 0
  },
  sellerSettledAt: {
    type: Date,
    default: null
  },
  sellerSettlementRemarks: {
    type: String,
    default: null
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
  deliveryOtpExpiresAt: {
    type: Date,
    default: null
  },
  deliveryOtpCreatedAt: {
    type: Date,
    default: null
  },
  deliveryOtpAttempts: {
    type: Number,
    default: 0
  },
  deliveryOtpResendCount: {
    type: Number,
    default: 0
  },
  deliveryOtpLastResentAt: {
    type: Date,
    default: null
  },
  deliveryOtpVerifiedAt: {
    type: Date,
    default: null
  },
  deliveredAt: {
    type: Date,
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
    enum: ['None', 'Pending', 'Requested', 'Return Requested', 'Approved', 'Return Approved', 'Rejected', 'Return Rejected', 'Return Picked Up', 'Picked Up from Customer', 'Return Completed', 'Returned to Seller', 'Completed'], 
    default: 'None' 
  },
  returnImages: [{ type: String }],
  returnRequestedAt: { type: Date, default: null },
  returnApprovedAt: { type: Date, default: null },
  returnApprovedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    name: String,
    email: String
  },
  returnRejectedAt: { type: Date, default: null },
  returnRejectedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    name: String,
    email: String
  },
  returnRejectionReason: { type: String, default: null },
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
    enum: ['Pending', 'Packed', 'Picked Up', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Returned', 'Assigned', 'Accepted', 'Confirmed', 'Return Requested', 'Return Approved', 'Return Rejected', 'Return Driver Assigned', 'Out for Return', 'Return Picked Up', 'Partially Returned'],
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
  orderNumber: {
    type: Number,
    unique: true,
    sparse: true,
    index: true
  },
  orderRef: {
    type: String,
    default: null
  },
  invoiceNumber: {
    type: String,
    default: null
  },
  invoiceSequence: {
    type: Number,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
