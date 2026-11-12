const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Seller = require('../models/Seller');
const CashCollector = require('../models/CashCollector');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Location = require('../models/Location');
const DeliverySlot = require('../models/DeliverySlot');
const Notification = require('../models/Notification');
const PopupAd = require('../models/PopupAd');
const Banner = require('../models/Banner');
const { connectDBByLocation } = require('../utils/db_manager');

const protect = async (req, res, next) => {
  req.portal = req.headers['x-portal'] || 'Super Admin';
  let token;
  
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      let locationId = req.isGlobalAccess ? null : (req.locationId || decoded.locationId);
      const dbName = req.isGlobalAccess ? null : (req.dbName || decoded.dbName);
      let account;

      // 1. Try finding in Global DB first (for Super Admins or Global accounts)
      account = await Admin.findById(decoded.id).select('-password');
      if (!account) {
        const SalesModel = mongoose.models.Sales || mongoose.model('Sales', Admin.schema, 'sales');
        account = await SalesModel.findById(decoded.id).select('-password');
      }
      
      // 2. If not in Global, and it's a tenant session, try finding in Tenant DB
      if (!account && locationId) {
        console.log(`[DEBUG-PROTECT] Searching in tenant DB. locationId: ${locationId}, dbName: ${dbName}, decoded.id: ${decoded.id}`);
        const tenantConn = await connectDBByLocation(locationId, dbName);
        const TenantAdmin = tenantConn.models.Admin || tenantConn.model('Admin', Admin.schema);
        account = await TenantAdmin.findById(decoded.id).select('-password');
        console.log(`[DEBUG-PROTECT] Found in tenant Admin: ${!!account}`);
        if (!account) {
          const TenantSales = tenantConn.models.Sales || tenantConn.model('Sales', Admin.schema, 'sales');
          account = await TenantSales.findById(decoded.id).select('-password');
          console.log(`[DEBUG-PROTECT] Found in tenant Sales: ${!!account}`);
        }
      }

      // 3. If account found, and we have a locationId, set up tenant models
      if (account && locationId) {
        const tenantConn = await connectDBByLocation(locationId, dbName);
        const TenantAdmin = tenantConn.models.Admin || tenantConn.model('Admin', Admin.schema);
        const TenantSales = tenantConn.models.Sales || tenantConn.model('Sales', Admin.schema, 'sales');
        const CorrectAdminModel = account.role === 'sales' ? TenantSales : TenantAdmin;
        
        const tenantModels = {
          Admin: CorrectAdminModel,
          Category: tenantConn.models.Category || tenantConn.model('Category', Category.schema),
          SubCategory: tenantConn.models.SubCategory || tenantConn.model('SubCategory', SubCategory.schema),
          Product: tenantConn.models.Product || tenantConn.model('Product', Product.schema),
          Order: tenantConn.models.Order || tenantConn.model('Order', Order.schema),
          User: tenantConn.models.User || tenantConn.model('User', User.schema),
          Driver: tenantConn.models.Driver || tenantConn.model('Driver', Driver.schema),
          Seller: tenantConn.models.Seller || tenantConn.model('Seller', Seller.schema),
          Location: tenantConn.models.Location || tenantConn.model('Location', Location.schema),
          DeliverySlot: tenantConn.models.DeliverySlot || tenantConn.model('DeliverySlot', DeliverySlot.schema),
          Notification: tenantConn.models.Notification || tenantConn.model('Notification', Notification.schema),
          PopupAd: tenantConn.models.PopupAd || tenantConn.model('PopupAd', PopupAd.schema),
          Banner: tenantConn.models.Banner || tenantConn.model('Banner', Banner.schema),
          Review: tenantConn.models.Review || tenantConn.model('Review', require('../models/Review').schema),
          Deposit: tenantConn.models.Deposit || tenantConn.model('Deposit', require('../models/Deposit').schema),
          SellerPayment: tenantConn.models.SellerPayment || tenantConn.model('SellerPayment', require('../models/SellerPayment').schema),
          CashCollector: tenantConn.models.CashCollector || tenantConn.model('CashCollector', require('../models/CashCollector').schema),
          Feed: tenantConn.models.Feed || tenantConn.model('Feed', require('../models/Feed').schema),
          Attendance: tenantConn.models.Attendance || tenantConn.model('Attendance', require('../models/Attendance').schema),
          Commission: tenantConn.models.Commission || tenantConn.model('Commission', require('../models/Commission').schema),
          SellerInvoice: tenantConn.models.SellerInvoice || tenantConn.model('SellerInvoice', require('../models/SellerInvoice').schema),
          InvoiceImage: tenantConn.models.InvoiceImage || tenantConn.model('InvoiceImage', require('../models/InvoiceImage').schema)
        };

        req.tenantModels = tenantModels;
        req.models = tenantModels; // Inject into req.models for route compatibility
        req.isTenant = true;
      } else if (account) {
        req.isTenant = false;
        if (req.isGlobalAccess) {
          req.locationId = null;
          req.dbName = null;
        }
      }

      if (account) {
        if (account.tokenVersion !== undefined && decoded.tokenVersion !== account.tokenVersion) {
          return res.status(401).json({ message: 'Session expired, logged in from another device' });
        }
        req.admin = account;
        req.user = account; 
        req.dbName = req.isGlobalAccess ? null : (req.dbName || decoded.dbName);
        req.locationId = req.isGlobalAccess ? null : (req.locationId || decoded.locationId);
        return next();
      }

      // Check User
      const UserModel = req.models?.User || User;
      account = UserModel ? await UserModel.findById(decoded.id).select('-password') : null;
      if (account) {
        if (account.tokenVersion !== undefined && decoded.tokenVersion !== account.tokenVersion) {
          return res.status(401).json({ message: 'Session expired, logged in from another device' });
        }
        req.user = account;
        return next();
      }

      // Check Seller
      const SellerModel = req.models?.Seller || Seller;
      account = SellerModel ? await SellerModel.findById(decoded.id).select('-password') : null;
      if (account) {
        if (account.tokenVersion !== undefined && decoded.tokenVersion !== account.tokenVersion) {
          return res.status(401).json({ message: 'Session expired, logged in from another device' });
        }
        req.user = account;
        req.user.role = 'seller';
        return next();
      }

      // Check Driver
      const DriverModel = req.models?.Driver || Driver;
      account = DriverModel ? await DriverModel.findById(decoded.id).select('-password') : null;
      if (account) {
        if (account.tokenVersion !== undefined && decoded.tokenVersion !== account.tokenVersion) {
          return res.status(401).json({ message: 'Session expired, logged in from another device' });
        }
        req.user = account;
        req.user.role = 'driver';
        return next();
      }

      // Check CashCollector
      const CashCollectorModel = req.models?.CashCollector || CashCollector;
      account = CashCollectorModel ? await CashCollectorModel.findById(decoded.id).select('-password') : null;
      if (account) {
        if (account.tokenVersion !== undefined && decoded.tokenVersion !== account.tokenVersion) {
          return res.status(401).json({ message: 'Session expired, logged in from another device' });
        }
        req.user = account;
        req.user.role = 'cash_collector';
        return next();
      }

      return res.status(401).json({ message: 'Not authorized, account not found' });
    } catch (error) {
      console.error('[Protect Middleware Error]:', error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const superAdmin = (req, res, next) => {
  if (req.admin && req.admin.role === 'super_admin') {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as super admin' });
  }
};

const hasPermission = (permission) => {
  return (req, res, next) => {
    if (req.admin) {
      if (req.admin.role === 'super_admin') return next();
      if (req.admin.permissions && req.admin.permissions.includes(permission)) {
        return next();
      }
    }
    res.status(403).json({ message: `Access denied: missing permission ${permission}` });
  };
};

module.exports = { protect, superAdmin, hasPermission };
