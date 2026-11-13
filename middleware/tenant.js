const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { connectDBByLocation } = require('../utils/db_manager');

const tenantMiddleware = async (req, res, next) => {
  req.portal = req.headers['x-portal'] || 'Super Admin';
  let tenantId = req.headers['x-tenant-id'] || req.headers['x-location'];
  let dbName = null;

  if (tenantId === 'global' || tenantId === 'null' || tenantId === 'undefined') {
    req.isGlobalAccess = true;
    tenantId = null;
  } else if (!tenantId && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.locationId) {
        tenantId = decoded.locationId;
        dbName = decoded.dbName;
      }
    } catch (err) {
      // Ignore token errors here, they'll be caught by 'protect' middleware if needed
    }
  }
  
  if (tenantId) {
    try {
      // Use connectDBByLocation for consistency and hyphen support
      const connection = await connectDBByLocation(tenantId, dbName);
      
      const models = {
        User: connection.models.User || connection.model('User', require('../models/User').schema),
        Product: connection.models.Product || connection.model('Product', require('../models/Product').schema),
        Order: connection.models.Order || connection.model('Order', require('../models/Order').schema),
        Category: connection.models.Category || connection.model('Category', require('../models/Category').schema),
        SubCategory: connection.models.SubCategory || connection.model('SubCategory', require('../models/SubCategory').schema),
        Location: connection.models.Location || connection.model('Location', require('../models/Location').schema),
        Driver: connection.models.Driver || connection.model('Driver', require('../models/Driver').schema),
        Review: connection.models.Review || connection.model('Review', require('../models/Review').schema),
        Deposit: connection.models.Deposit || connection.model('Deposit', require('../models/Deposit').schema),
        Seller: connection.models.Seller || connection.model('Seller', require('../models/Seller').schema),
        SellerPayment: connection.models.SellerPayment || connection.model('SellerPayment', require('../models/SellerPayment').schema),
        SellerHistoryEvent: connection.models.SellerHistoryEvent || connection.model('SellerHistoryEvent', require('../models/SellerHistoryEvent').schema),
        PaymentAuditLog: connection.models.PaymentAuditLog || connection.model('PaymentAuditLog', require('../models/PaymentAuditLog').schema),
        SellerInvoice: connection.models.SellerInvoice || connection.model('SellerInvoice', require('../models/SellerInvoice').schema),
        InvoiceImage: connection.models.InvoiceImage || connection.model('InvoiceImage', require('../models/InvoiceImage').schema),
        Admin: connection.models.Admin || connection.model('Admin', require('../models/Admin').schema),
        CashCollector: connection.models.CashCollector || connection.model('CashCollector', require('../models/CashCollector').schema),
        DeliverySlot: connection.models.DeliverySlot || connection.model('DeliverySlot', require('../models/DeliverySlot').schema),
        Notification: connection.models.Notification || connection.model('Notification', require('../models/Notification').schema),
        PopupAd: connection.models.PopupAd || connection.model('PopupAd', require('../models/PopupAd').schema),
        Banner: connection.models.Banner || connection.model('Banner', require('../models/Banner').schema),
        Feed: connection.models.Feed || connection.model('Feed', require('../models/Feed').schema),
        Attendance: connection.models.Attendance || connection.model('Attendance', require('../models/Attendance').schema),
        Commission: connection.models.Commission || connection.model('Commission', require('../models/Commission').schema),
        Setting: connection.models.Setting || connection.model('Setting', require('../models/Setting').schema),
      };
 
      req.db = connection;
      req.models = models;
      req.tenantModels = models;
      req.isTenant = true;
      req.locationId = tenantId;
      req.dbName = connection.name;
    } catch (error) {
      console.error('[Tenant Middleware] Error switching DB:', error);
    }
  } else {
    // Use default models
    req.db = mongoose.connection;
    req.models = {
      User: require('../models/User'),
      Product: require('../models/Product'),
      Order: require('../models/Order'),
      Category: require('../models/Category'),
      SubCategory: require('../models/SubCategory'),
      Location: require('../models/Location'),
      Driver: require('../models/Driver'),
      Review: require('../models/Review'),
      Deposit: require('../models/Deposit'),
      Seller: require('../models/Seller'),
      SellerPayment: require('../models/SellerPayment'),
      SellerHistoryEvent: require('../models/SellerHistoryEvent'),
      PaymentAuditLog: require('../models/PaymentAuditLog'),
      SellerInvoice: require('../models/SellerInvoice'),
      InvoiceImage: require('../models/InvoiceImage'),
      Admin: require('../models/Admin'),
      CashCollector: require('../models/CashCollector'),
      DeliverySlot: require('../models/DeliverySlot'),
      Notification: require('../models/Notification'),
      PopupAd: require('../models/PopupAd'),
      Banner: require('../models/Banner'),
      Feed: require('../models/Feed'),
      Commission: require('../models/Commission'),
      Setting: require('../models/Setting'),
    };
    req.isTenant = false;
  }
  next();
};

module.exports = tenantMiddleware;
