const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Driver = require('../models/Driver');
const CashCollector = require('../models/CashCollector');
const Location = require('../models/Location');
const Pincode = require('../models/Pincode');
const { protect, superAdmin } = require('../middleware/auth');
const { connectDBByLocation } = require('../utils/db_manager');
const { seedLocationDB } = require('../utils/db_seeder');
const { getModel } = require('../utils/model_loader');

// Helper to format user response
const formatUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  profilePicture: user.profilePicture,
  isVerified: user.isVerified,
  isWaitingApproval: user.isWaitingApproval,
  gstPdf: user.gstPdf,
  storePic: user.storePic,
  gstNumber: user.gstNumber,
  panNumber: user.panNumber,
  aadhaarNumber: user.aadhaarNumber,
  savedAddresses: user.savedAddresses,
  businessName: user.businessName,
  pincode: user.pincode,
  bankDetails: user.bankDetails
});

const getSalesAssociateForUser = async (req, user) => {
  if (!user || user.role !== 'b2b') return null;
  try {
    const PincodeModel = req.models?.Pincode || Pincode;
    const activeDb = req.db || mongoose.connection;
    const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
    
    let salesAssociate = null;
    if (user.pincode) {
      const pincodeDoc = await PincodeModel.findOne({ code: user.pincode.trim() });
      if (pincodeDoc && pincodeDoc.locationId) {
        salesAssociate = await SalesModel.findOne({ 
          role: 'sales', 
          locationId: pincodeDoc.locationId 
        }).select('name email phone');
      }
    }
    
    if (!salesAssociate) {
      salesAssociate = await SalesModel.findOne({ role: 'sales' }).select('name email phone');
    }
    
    return salesAssociate;
  } catch (error) {
    console.error('Error fetching sales associate:', error);
    return null;
  }
};

// @route   GET /api/auth/login-logs
// @desc    View temporary login debug logs
router.get('/login-logs', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, '../login-debug.txt');
    
    if (req.query.clear === 'true') {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      return res.send('Logs cleared.');
    }

    if (!fs.existsSync(logPath)) {
      return res.send('No logs available yet.');
    }
    const logs = fs.readFileSync(logPath, 'utf8');
    res.setHeader('Content-Type', 'text/plain');
    res.send(logs);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// @route   POST /api/auth/login
// @desc    Admin/Employee Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../login-debug.txt');
  const logToFile = (msg) => {
    const timestampedMsg = `[${new Date().toISOString()}] ${msg}`;
    console.log(timestampedMsg);
    try {
      fs.appendFileSync(logPath, timestampedMsg + '\n');
    } catch (err) {
      console.error('Failed to write login log to file:', err);
    }
  };

  try {
    const emailToSearch = email.trim().toLowerCase();
    logToFile(`Login attempt for: "${emailToSearch}"`);

    // 1. Check Global/Active Admin (Super Admin, Sales, or active tenant employees)
    let AdminModel = req.models?.Admin || Admin;
    let admin = await AdminModel.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
    logToFile(`Checked active Admin collection. Found: ${!!admin}`);
    if (!admin) {
      const activeDb = req.db || mongoose.connection;
      const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
      admin = await SalesModel.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
      logToFile(`Checked active Sales collection. Found: ${!!admin}`);
    }
    let tenantDbName = null;
    let isTenantAdmin = false;

    const { locationId } = req.body;
    logToFile(`Request body locationId: ${locationId}`);

    if (admin) {
      logToFile(`Admin found. Role: ${admin.role}, assigned locationId: ${admin.locationId}`);
      if (req.isTenant) {
        isTenantAdmin = true;
        tenantDbName = req.dbName;
        logToFile(`Admin operates in tenant context: ${tenantDbName}`);
      }
      // If the admin has a specific location assigned
      else if (admin.locationId) {
        const location = await Location.findById(admin.locationId);
        if (location) {
          tenantDbName = `zudo-${location.city.toLowerCase().replace(/\s+/g, '-')}`;
          isTenantAdmin = true;
          logToFile(`Resolved location from global admin's assigned locationId: ${tenantDbName}`);
        }
      } 
      // If it's a Super Admin switching context with selected locationId
      else if (locationId) {
        const location = await Location.findById(locationId);
        if (location) {
          tenantDbName = `zudo-${location.city.toLowerCase().replace(/\s+/g, '-')}`;
          isTenantAdmin = true;
          logToFile(`Resolved location from context locationId: ${tenantDbName}`);
        }
      }
    } else if (locationId) {
      // 2. Check if the user exists in the tenant's specific database
      const location = await Location.findById(locationId);
      if (location) {
        tenantDbName = `zudo-${location.city.toLowerCase().replace(/\s+/g, '-')}`;
        const tenantConn = await connectDBByLocation(locationId, tenantDbName);
        const TenantAdmin = tenantConn.models.Admin || tenantConn.model('Admin', Admin.schema);
        admin = await TenantAdmin.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
        logToFile(`Checked tenant Admin collection. Found: ${!!admin}`);
        if (!admin) {
          const TenantSales = tenantConn.models.Sales || tenantConn.model('Sales', Admin.schema, 'sales');
          admin = await TenantSales.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
          logToFile(`Checked tenant Sales collection. Found: ${!!admin}`);
        }
        if (admin) isTenantAdmin = true;
      }
    } else if (!admin) {
      // 3. Scan all tenant databases if admin not found globally and no locationId provided
      logToFile(`Scanning all tenant DBs for user...`);
      const LocationModel = req.models?.Location || Location;
      const locations = await LocationModel.find({ isActive: true });
      for (const loc of locations) {
        const tempDbName = `zudo-${loc.city.toLowerCase().replace(/\s+/g, '-')}`;
        const tenantConn = await connectDBByLocation(loc._id.toString(), tempDbName);
        const TenantAdmin = tenantConn.models.Admin || tenantConn.model('Admin', Admin.schema);
        admin = await TenantAdmin.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
        if (!admin) {
          const TenantSales = tenantConn.models.Sales || tenantConn.model('Sales', Admin.schema, 'sales');
          admin = await TenantSales.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });
        }
        if (admin) {
          tenantDbName = tempDbName;
          isTenantAdmin = true;
          logToFile(`Found user in tenant DB during scan: ${tenantDbName}`);
          break;
        }
      }
    }

    if (!admin) {
      logToFile(`Authentication failed: User "${emailToSearch}" not found in any collection.`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (admin) {
      const isMatch = await admin.comparePassword(password);
      logToFile(`User found: ${admin.email} (Role: ${admin.role}). Password comparison result: ${isMatch}`);
      if (isMatch) {
        // Increment tokenVersion on login for security
        admin.tokenVersion = (admin.tokenVersion || 0) + 1;
        await admin.save();

        // For Super Admins switching context, we use the selected locationId
        const effectiveLocationId = (admin.role === 'super_admin' && !admin.locationId && locationId)
          ? locationId
          : admin.locationId;

        const token = jwt.sign(
          {
            id: admin._id,
            locationId: effectiveLocationId,
            dbName: isTenantAdmin ? (admin.dbName || tenantDbName) : null,
            tokenVersion: admin.tokenVersion
          },
          process.env.JWT_SECRET,
          { expiresIn: '30d' }
        );

        return res.json({
          _id: admin._id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          locationId: effectiveLocationId,
          targetSegment: admin.targetSegment || 'Both',
          permissions: admin.permissions,
          token,
          isTenantAdmin
        });
      }
    }

    res.status(401).json({ message: 'Invalid email or password' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, phone, businessName, gstNumber, panNumber, aadhaarNumber, gstPdf, storePic, pincode } = req.body;
    const UserModel = req.models.User;
    
    const userExists = await UserModel.findOne({ email, role: role || 'b2c' });
    if (userExists) return res.status(400).json({ message: 'Account already exists' });

    const user = await UserModel.create({
      name, email, password, role: role || 'b2c', phone,
      businessName: businessName || '', gstNumber: gstNumber || '',
      panNumber: panNumber || '', aadhaarNumber: aadhaarNumber || '',
      gstPdf: gstPdf || '', storePic: storePic || '',
      pincode: pincode || '',
      isWaitingApproval: role === 'b2b'
    });

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    
    const token = jwt.sign({ id: user._id, tokenVersion: user.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const salesAssociate = await getSalesAssociateForUser(req, user);
    res.status(201).json({ 
      token, 
      user: {
        ...formatUser(user),
        salesAssociate
      } 
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   POST /api/auth/user-login
router.post('/user-login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const targetRole = role || 'b2c';
    const UserModel = req.models.User;
    const emailToSearch = email.trim().toLowerCase();

    console.log(`[User Login] Role: ${targetRole}, Email: ${emailToSearch}`);
    const user = await UserModel.findOne({
      email: new RegExp(`^${emailToSearch}$`, 'i'),
      role: targetRole
    });

    if (user && (await user.comparePassword(password))) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save();
      const token = jwt.sign({ id: user._id, tokenVersion: user.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '30d' });
      const salesAssociate = await getSalesAssociateForUser(req, user);
      res.json({ 
        token, 
        user: {
          ...formatUser(user),
          salesAssociate
        } 
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   GET /api/auth/profile
router.get('/profile', protect, async (req, res) => {
  try {
    let account = null;
    if (req.user.role === 'driver') {
      account = await req.models.Driver.findById(req.user._id).select('-password');
      if (account) return res.json(account);
    } else if (req.user.role === 'cash_collector') {
      account = await req.models.CashCollector.findById(req.user._id).select('-password');
      if (account) return res.json(account);
    } else if (req.user.role === 'seller') {
      account = await req.models.Seller.findById(req.user._id).select('-password');
      if (account) return res.json(account);
    } else {
      const UserModel = req.models.User;
      account = await UserModel.findById(req.user._id).select('-password');
      if (account) {
        const formatted = formatUser(account);
        const salesAssociate = await getSalesAssociateForUser(req, account);
        return res.json({
          ...formatted,
          salesAssociate
        });
      }
    }

    res.status(404).json({ message: 'User not found' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   GET /api/auth/users
// @desc    Get all users (for Admin Directory)
// @access  Private/Admin
router.get('/users', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.portal === 'B2B') filter.role = 'b2b';
    if (req.portal === 'B2C') filter.role = 'b2c';

    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const users = await aggregateGET('User', req, filter, [], '-password');
      res.json(users);
    } else {
      const UserModel = getModel('User', req);
      const users = await UserModel.find(filter).select('-password');
      res.json(users);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper to resolve phone number for B2B users with fallback lookups
const resolveUserPhone = async (user, req) => {
  if (user.phone && String(user.phone).trim() !== '') return String(user.phone).trim();

  // 1. Check saved addresses
  if (user.savedAddresses && user.savedAddresses.length > 0) {
    const addr = user.savedAddresses.find(a => a && a.phone && String(a.phone).trim() !== '');
    if (addr) return String(addr.phone).trim();
  }

  const UserModel = getModel('User', req);

  // 2. Check other user accounts with same email
  if (user.email && UserModel) {
    try {
      const sameEmailUser = await UserModel.findOne({
        email: user.email,
        phone: { $exists: true, $nin: [null, ''] }
      });
      if (sameEmailUser?.phone) return String(sameEmailUser.phone).trim();
    } catch (e) {}
  }

  // 3. Check seller profiles
  try {
    const SellerModel = getModel('Seller', req);
    if (SellerModel) {
      const seller = await SellerModel.findOne({
        $or: [
          ...(user.email ? [{ email: user.email }] : []),
          ...(user.name ? [{ name: user.name }] : [])
        ],
        phone: { $exists: true, $nin: [null, ''] }
      });
      if (seller?.phone) return String(seller.phone).trim();
    }
  } catch (e) {}

  // 4. Check sales profiles
  try {
    const activeDb = req.db || mongoose.connection;
    const SalesModel = activeDb.models?.Sales || activeDb.model('Sales', Admin.schema, 'sales');
    if (SalesModel) {
      const sales = await SalesModel.findOne({
        $or: [
          ...(user.email ? [{ email: user.email }] : []),
          ...(user.name ? [{ name: user.name }] : [])
        ],
        phone: { $exists: true, $nin: [null, ''] }
      });
      if (sales?.phone) return String(sales.phone).trim();
    }
  } catch (e) {}

  // 5. Check order history
  try {
    const OrderModel = getModel('Order', req);
    if (OrderModel) {
      const order = await OrderModel.findOne({
        $or: [
          ...(user.email ? [{ 'customerDetails.email': user.email }, { 'customer.email': user.email }] : []),
          { user: user._id }
        ]
      }).sort('-createdAt');
      const orderPhone = order?.customerDetails?.phone || order?.shippingAddress?.phone || order?.customer?.phone;
      if (orderPhone) return String(orderPhone).trim();
    }
  } catch (e) {}

  return null;
};

// @route   GET /api/auth/b2b-pending
// @desc    Get pending B2B users
router.get('/b2b-pending', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const users = await UserModel.find({ role: 'b2b', isVerified: false }).sort('-createdAt');
    const enrichedUsers = await Promise.all(users.map(async (u) => {
      const uObj = u.toObject ? u.toObject() : { ...u };
      if (!uObj.phone || String(uObj.phone).trim() === '') {
        const foundPhone = await resolveUserPhone(uObj, req);
        if (foundPhone) {
          uObj.phone = foundPhone;
          UserModel.updateOne({ _id: u._id }, { $set: { phone: foundPhone } }).catch(() => {});
        }
      }
      return uObj;
    }));
    res.json(enrichedUsers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/auth/b2b-verified
// @desc    Get verified B2B users
router.get('/b2b-verified', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const users = await UserModel.find({ role: 'b2b', isVerified: true }).sort('-createdAt');
    const enrichedUsers = await Promise.all(users.map(async (u) => {
      const uObj = u.toObject ? u.toObject() : { ...u };
      if (!uObj.phone || String(uObj.phone).trim() === '') {
        const foundPhone = await resolveUserPhone(uObj, req);
        if (foundPhone) {
          uObj.phone = foundPhone;
          UserModel.updateOne({ _id: u._id }, { $set: { phone: foundPhone } }).catch(() => {});
        }
      }
      return uObj;
    }));
    res.json(enrichedUsers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/b2b-verify-submit
// @desc    Submit B2B verification documents and details
router.post('/b2b-verify-submit', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const userId = req.user._id;
    const { gstPdf, storePic, gstNumber, panNumber, aadhaarNumber, pincode, businessName, phone } = req.body;
    
    const updateFields = {
      isWaitingApproval: true
    };
    if (gstPdf) updateFields.gstPdf = gstPdf;
    if (storePic) updateFields.storePic = storePic;
    if (gstNumber) updateFields.gstNumber = gstNumber;
    if (panNumber) updateFields.panNumber = panNumber;
    if (aadhaarNumber) updateFields.aadhaarNumber = aadhaarNumber;
    if (pincode) updateFields.pincode = pincode;
    if (businessName) updateFields.businessName = businessName;
    if (phone) updateFields.phone = phone;

    const user = await UserModel.findByIdAndUpdate(userId, updateFields, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    res.json(formatUser(user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/verify-b2b/:id
// @desc    Verify a B2B user
router.put('/verify-b2b/:id', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findByIdAndUpdate(req.params.id, {
      isVerified: true,
      isWaitingApproval: false,
      isBlocked: false
    }, { returnDocument: 'after' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Send notification to the user
    try {
      const NotificationModel = getModel('Notification', req);
      if (NotificationModel) {
        await NotificationModel.create({
          userId: user._id,
          title: 'Account Verified 🎉',
          message: 'Your B2B account has been verified by the admin. You can now access all B2B features!',
          type: 'system'
        });
      }
    } catch (notifErr) {
      console.error('Failed to send verification notification', notifErr);
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/reject-b2b/:id
// @desc    Reject a B2B user
router.put('/reject-b2b/:id', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findByIdAndUpdate(req.params.id, {
      isWaitingApproval: false,
      isVerified: false,
      isBlocked: false
    }, { returnDocument: 'after' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Send notification to the user
    try {
      const NotificationModel = getModel('Notification', req);
      if (NotificationModel) {
        await NotificationModel.create({
          userId: user._id,
          title: 'Account Rejected ❌',
          message: 'Your B2B account application has been rejected. Please contact support for more details.',
          type: 'system'
        });
      }
    } catch (notifErr) {
      console.error('Failed to send rejection notification', notifErr);
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/block-b2b/:id
// @desc    Block a B2B user
router.put('/block-b2b/:id', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findByIdAndUpdate(req.params.id, {
      isVerified: false,
      isWaitingApproval: false,
      isBlocked: true
    }, { returnDocument: 'after' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Send notification to the user
    try {
      const NotificationModel = getModel('Notification', req);
      if (NotificationModel) {
        await NotificationModel.create({
          userId: user._id,
          title: 'Account Blocked 🚫',
          message: 'Your B2B account has been blocked due to policy violations. Please contact support.',
          type: 'system'
        });
      }
    } catch (notifErr) {
      console.error('Failed to send blocking notification', notifErr);
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/auth/users/:id
// @desc    Delete a user
router.delete('/users/:id', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Admin Management
router.post('/create-admin', protect, superAdmin, async (req, res) => {
  const { name, email, password, role, locationId, permissions, targetSegment, phone, pincodes } = req.body;
  try {
    let finalTargetSegment = targetSegment || 'Both';
    let finalPermissions = permissions || [];

    if (role === 'super_admin') {
      finalTargetSegment = 'Both';
      finalPermissions = [
        'view_dashboard', 'manage_products', 'manage_categories', 'manage_subcategories', 
        'manage_orders', 'manage_drivers', 'manage_sellers', 'manage_users', 
        'manage_cash', 'manage_b2b_verification', 'manage_deliveries', 'manage_reviews', 
        'manage_bulk_upload', 'manage_admins', 'manage_locations', 'manage_profile', 'manage_invoices'
      ];
    } else if (role === 'b2b_admin') {
      finalTargetSegment = 'B2B';
    } else if (role === 'b2c_admin') {
      finalTargetSegment = 'B2C';
    }

    let newAdmin;
    if (locationId) {
      const location = await Location.findById(locationId);
      if (!location) return res.status(404).json({ message: 'Location not found' });

      const cityClean = location.city.toLowerCase().replace(/\s+/g, '-');
      const branchDbName = `zudo-${cityClean}`;
      const tenantConn = await connectDBByLocation(locationId, branchDbName);

      const TenantAdminModel = tenantConn.models.Admin || tenantConn.model('Admin', Admin.schema);

      // Check if admin already exists in this specific location
      const adminExists = await TenantAdminModel.findOne({ email });
      if (adminExists) return res.status(400).json({ message: 'Admin already exists in this location' });

      newAdmin = await TenantAdminModel.create({
        name, email, password, role, locationId,
        permissions: finalPermissions,
        phone: phone || '',
        pincodes: pincodes || [],
        targetSegment: finalTargetSegment
      });
    } else {
      // Check Global Admin (in main DB)
      const adminExists = await Admin.findOne({ email });
      if (adminExists) return res.status(400).json({ message: 'Global Admin already exists' });

      newAdmin = await Admin.create({
        name, email, password, role,
        locationId: null,
        phone: phone || '',
        pincodes: pincodes || [],
        permissions: finalPermissions,
        targetSegment: finalTargetSegment
      });
    }

    res.status(201).json({ _id: newAdmin._id, name: newAdmin.name, email: newAdmin.email });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/admins', protect, async (req, res) => {
  try {
    if (req.admin.role !== 'super_admin' && req.admin.role !== 'manager') {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const admins = await aggregateGET('Admin', req, {}, ['locationId'], '-password');
      res.json(admins);
    } else {
      const AdminModel = getModel('Admin', req);
      const admins = await AdminModel.find().populate('locationId', 'city pincode').select('-password');
      res.json(admins);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/admins/:id
// @desc    Update admin account
router.put('/admins/:id', protect, superAdmin, async (req, res) => {
  try {
    const AdminModel = getModel('Admin', req);
    const admin = await AdminModel.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });

    admin.name = req.body.name || admin.name;
    admin.email = req.body.email || admin.email;
    admin.phone = req.body.phone || admin.phone;
    admin.role = req.body.role || admin.role;
    admin.locationId = (req.body.locationId === '') ? null : (req.body.locationId || admin.locationId);
    admin.targetSegment = req.body.targetSegment || admin.targetSegment;
    admin.permissions = req.body.permissions || admin.permissions;
    
    if (req.body.pincodes !== undefined) {
      admin.pincodes = req.body.pincodes;
      admin.markModified('pincodes');
    }

    if (req.body.password) {
      admin.password = req.body.password;
    }

    await admin.save();
    res.json({ message: 'Admin updated successfully', admin: { _id: admin._id, name: admin.name, email: admin.email } });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/auth/admins/:id
// @desc    Delete admin account
router.delete('/admins/:id', protect, superAdmin, async (req, res) => {
  try {
    const AdminModel = getModel('Admin', req);
    const admin = await AdminModel.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });

    if (admin._id.toString() === req.admin._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    await admin.deleteOne();
    res.json({ message: 'Admin removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/change-password
// @desc    Change logged in admin's password
router.put('/change-password', protect, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    // For change password, we always use the model the user was found with
    const AdminModel = getModel('Admin', req);
    const admin = await AdminModel.findById(req.admin._id);

    if (!admin) return res.status(404).json({ message: 'Admin not found' });

    const isMatch = await admin.comparePassword(currentPassword);
    if (!isMatch) return res.status(400).json({ message: 'Invalid current password' });

    admin.password = newPassword;
    await admin.save();
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   PUT /api/auth/profile
router.put('/profile', protect, async (req, res) => {
  try {
    if (req.user.role === 'driver') {
      const DriverModel = req.models.Driver;
      const driver = await DriverModel.findById(req.user._id);
      if (driver) {
        driver.name = req.body.name || driver.name;
        driver.phone = req.body.phone || driver.phone;
        if (req.body.password) driver.password = req.body.password;
        const updatedDriver = await driver.save();
        return res.json(updatedDriver);
      }
    } else if (req.admin) {
      const AdminModel = getModel('Admin', req);
      const admin = await AdminModel.findById(req.admin._id);
      if (admin) {
        admin.name = req.body.name || admin.name;
        admin.email = req.body.email || admin.email;
        admin.phone = req.body.phone || admin.phone;
        admin.locationId = (req.body.locationId === '') ? null : (req.body.locationId || admin.locationId);
        
        if (req.body.pincodes !== undefined) {
          admin.pincodes = req.body.pincodes;
          admin.markModified('pincodes');
        }

        if (req.body.password) admin.password = req.body.password;
        const updatedAdmin = await admin.save();
        return res.json({
          _id: updatedAdmin._id,
          name: updatedAdmin.name,
          email: updatedAdmin.email,
          phone: updatedAdmin.phone,
          locationId: updatedAdmin.locationId,
          pincodes: updatedAdmin.pincodes,
          role: updatedAdmin.role,
          permissions: updatedAdmin.permissions
        });
      }
    } else {
      const UserModel = req.models.User;
      const user = await UserModel.findById(req.user._id);
      if (user) {
        user.name = req.body.name || user.name;
        user.phone = req.body.phone || user.phone;
        user.profilePicture = req.body.profilePicture || user.profilePicture;
        if (req.body.savedAddresses) {
          user.savedAddresses = req.body.savedAddresses;
        }
        if (req.body.bankDetails) {
          user.bankDetails = req.body.bankDetails;
        }
        if (req.body.password) {
          user.password = req.body.password;
        }

        const updatedUser = await user.save();
        const formatted = formatUser(updatedUser);
        const salesAssociate = await getSalesAssociateForUser(req, updatedUser);
        return res.json({
          ...formatted,
          salesAssociate
        });
      }
    }
    res.status(404).json({ message: 'User not found' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  const { name, email, profilePicture, role } = req.body;
  const targetRole = role || 'b2c';
  try {
    const UserModel = req.models.User;
    let user = await UserModel.findOne({ email, role: targetRole });

    if (!user) {
      if (targetRole === 'b2b') {
        return res.json({ newUser: true, email, name });
      }

      user = await UserModel.create({
        name,
        email,
        profilePicture,
        role: targetRole,
        password: Math.random().toString(36).slice(-10),
        isWaitingApproval: false
      });
    }

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    
    const token = jwt.sign({ id: user._id, tokenVersion: user.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const salesAssociate = await getSalesAssociateForUser(req, user);
    res.json({ 
      token, 
      user: {
        ...formatUser(user),
        salesAssociate
      } 
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   GET /api/auth/addresses
router.get('/addresses', protect, async (req, res) => {
  try {
    const UserModel = req.models?.User || User;
    const user = await UserModel.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user.savedAddresses || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/addresses
router.post('/addresses', protect, async (req, res) => {
  try {
    const UserModel = req.models?.User || User;
    const user = await UserModel.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const newAddress = req.body;
    if (!user.savedAddresses) user.savedAddresses = [];

    if (newAddress.isDefault) {
      user.savedAddresses.forEach(addr => addr.isDefault = false);
    }

    user.savedAddresses.push(newAddress);
    await user.save();
    res.status(201).json(user.savedAddresses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/auth/addresses/:id
router.delete('/addresses/:id', protect, async (req, res) => {
  try {
    const UserModel = req.models?.User || User;
    const user = await UserModel.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.savedAddresses = user.savedAddresses.filter(
      addr => addr._id.toString() !== req.params.id
    );
    await user.save();
    res.json(user.savedAddresses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/driver-login
// @desc    Driver Login
router.post('/driver-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const DriverModel = req.models.Driver;
    const emailToSearch = email.trim().toLowerCase();
    console.log(`[Driver Login] DB: ${req.headers['x-tenant-id']}, Email: ${emailToSearch}`);

    const driver = await DriverModel.findOne({ email: new RegExp(`^${emailToSearch}$`, 'i') });

    if (!driver) {
      console.log(`[Driver Login] Driver not found: ${emailToSearch}`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await driver.comparePassword(password);
    if (isMatch) {
      console.log(`[Driver Login] Success: ${emailToSearch}`);
      
      const nextVersion = (driver.tokenVersion || 0) + 1;
      await DriverModel.updateOne({ _id: driver._id }, { $set: { tokenVersion: nextVersion } });
      driver.tokenVersion = nextVersion;
      
      const token = jwt.sign({ id: driver._id, tokenVersion: driver.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '30d' });
      res.json({
        token,
        _id: driver._id,
        name: driver.name,
        email: driver.email,
        role: 'driver',
        phone: driver.phone,
        type: driver.type,
        wallet: driver.wallet
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/auth/cash-collector-login
// @desc    Cash Collector Login
router.post('/cash-collector-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const CashCollectorModel = getModel('CashCollector', req);
    const collector = await CashCollectorModel.findOne({ email });
    if (collector && (await collector.comparePassword(password))) {
      
      collector.tokenVersion = (collector.tokenVersion || 0) + 1;
      await collector.save();
      
      const token = jwt.sign({ id: collector._id, tokenVersion: collector.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '30d' });
      res.json({
        token,
        user: {
          _id: collector._id,
          name: collector.name,
          email: collector.email,
          role: 'cash_collector',
          phone: collector.phone,
          wallet: collector.amount || 0
        }
      });
    } else {
      res.status(401).json({ message: 'Invalid phone or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/auth/sales
// @desc    Get all sales associates
router.get('/sales', protect, async (req, res) => {
  try {
    const activeDb = req.db || mongoose.connection;
    const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
    const sales = await SalesModel.find({ role: 'sales' }).select('-password');
    res.json(sales);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/users/:id
// @desc    Edit user details
// @access  Private/Admin
router.put('/users/:id', protect, async (req, res) => {
  console.log(`[DEBUG] PUT /users/:id hit with id: ${req.params.id}`);
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findById(req.params.id);
    if (!user) {
      console.log(`[DEBUG] User not found for id: ${req.params.id}`);
      return res.status(404).json({ message: 'User not found' });
    }
    
    user.name = req.body.name || user.name;
    user.email = req.body.email || user.email;
    user.phone = req.body.phone !== undefined ? req.body.phone : user.phone;
    
    if (req.body.password) {
      user.password = req.body.password;
    }
    
    await user.save();
    console.log(`[DEBUG] User updated successfully: ${user._id}`);
    res.json(user);
  } catch (error) {
    console.error(`[DEBUG] Error in PUT /users/:id:`, error);
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/auth/users/:id
// @desc    Delete a user
// @access  Private/Admin
router.delete('/users/:id', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    await user.deleteOne();
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/auth/users/:id/block
// @desc    Toggle block status for a user
// @access  Private/Admin
router.put('/users/:id/block', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    const user = await UserModel.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    user.isBlocked = !user.isBlocked;
    await user.save();
    res.json({ message: user.isBlocked ? 'User blocked' : 'User unblocked', user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Sales Management
router.post('/sales', protect, superAdmin, async (req, res) => {
  const { name, email, password, phone, pincodes, locationId } = req.body;
  try {
    let newSales;
    if (locationId) {
      const location = await Location.findById(locationId);
      if (!location) return res.status(404).json({ message: 'Location not found' });
      const cityClean = location.city.toLowerCase().replace(/\s+/g, '-');
      const branchDbName = `zudo-${cityClean}`;
      const tenantConn = await connectDBByLocation(locationId, branchDbName);
      const TenantSales = tenantConn.models.Sales || tenantConn.model('Sales', Admin.schema, 'sales');

      const salesExists = await TenantSales.findOne({ email });
      if (salesExists) return res.status(400).json({ message: 'Sales account already exists in this location' });

      newSales = await TenantSales.create({
        name, email, password, locationId,
        phone: phone || '',
        pincodes: pincodes || []
      });
    } else {
      const activeDb = req.db || mongoose.connection;
      const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
      const salesExists = await SalesModel.findOne({ email });
      if (salesExists) return res.status(400).json({ message: 'Global Sales account already exists' });

      newSales = await SalesModel.create({
        name, email, password, locationId: null,
        phone: phone || '',
        pincodes: pincodes || []
      });
    }
    res.status(201).json(newSales);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.put('/sales/:id', protect, superAdmin, async (req, res) => {
  try {
    const activeDb = req.db || mongoose.connection;
    const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
    const salesAccount = await SalesModel.findById(req.params.id);
    if (!salesAccount) return res.status(404).json({ message: 'Sales account not found' });

    salesAccount.name = req.body.name || salesAccount.name;
    salesAccount.email = req.body.email || salesAccount.email;
    salesAccount.phone = req.body.phone || salesAccount.phone;
    salesAccount.locationId = (req.body.locationId === '') ? null : (req.body.locationId || salesAccount.locationId);
    
    if (req.body.pincodes !== undefined) {
      salesAccount.pincodes = req.body.pincodes;
      salesAccount.markModified('pincodes');
    }

    if (req.body.password) {
      salesAccount.password = req.body.password;
    }

    await salesAccount.save();
    res.json({ message: 'Sales account updated successfully', salesAccount });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/sales/:id', protect, superAdmin, async (req, res) => {
  try {
    const activeDb = req.db || mongoose.connection;
    const SalesModel = activeDb.models.Sales || activeDb.model('Sales', Admin.schema, 'sales');
    const salesAccount = await SalesModel.findById(req.params.id);
    if (!salesAccount) return res.status(404).json({ message: 'Sales account not found' });

    if (salesAccount._id.toString() === req.admin._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    await salesAccount.deleteOne();
    res.json({ message: 'Sales account removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
