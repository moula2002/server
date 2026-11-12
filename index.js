require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
const { init: initSocket } = require('./utils/socket');
const io = initSocket(server);

io.on('connection', (socket) => {
  console.log('Client connected to socket.io');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Middleware
const { isOriginAllowed } = require('./utils/socket');
app.use(cors({
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true
}));
app.options('*', cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(require('./middleware/tenant'));

// Ensure uploads directory exists
const rawUploadDir = process.env.UPLOAD_DIR;
const uploadDir = (rawUploadDir && rawUploadDir.trim() !== '') 
  ? path.resolve(rawUploadDir) 
  : path.join(__dirname, 'uploads');

console.log('Upload directory configured at:', uploadDir);

if (!fs.existsSync(uploadDir)) {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created upload directory:', uploadDir);
  } catch (err) {
    console.error('Failed to create upload directory:', err.message);
  }
}
const staticOptions = {
  setHeaders: (res, path) => {
    if (path.endsWith('.jfif')) {
      res.setHeader('Content-Type', 'image/jpeg');
    }
  }
};
app.use('/api/uploads', express.static(uploadDir, staticOptions));
app.use('/api/upload', express.static(uploadDir, staticOptions));
app.use('/uploads', express.static(uploadDir, staticOptions)); // Maintain backward compatibility
// Apply Socket Mongoose Plugin
const socketPlugin = require('./utils/socketPlugin');
mongoose.plugin(socketPlugin);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/upload', require('./routes/uploads'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/subcategories', require('./routes/subcategories'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/deliveries', require('./routes/deliveries'));
app.use('/api/deliveryslots', require('./routes/deliverySlots'));
app.use('/api/sellers', require('./routes/sellers'));
app.use('/api/cash', require('./routes/cash'));
app.use('/api/cashcollectors', require('./routes/cashCollectors'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/users', require('./routes/users'));
app.use('/api/deposits', require('./routes/deposits'));
app.use('/api/tenancy', require('./routes/tenancy'));
app.use('/api/feed', require('./routes/feeds'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/notifications', require('./routes/notifications'));
console.log('Registering /api/popup-ads route...');
app.use('/api/popup-ads', require('./routes/popupads')); 
app.use('/api/popupads', require('./routes/popupads')); 
app.use('/api/banners', require('./routes/banners')); 
app.use('/api/ads', require('./routes/ads'));
app.use('/api/feeds', require('./routes/feeds'));
app.use('/api/commissions', require('./routes/commissions'));
app.use('/api/seller-invoices', require('./routes/sellerInvoices'));
app.use('/api/settings', require('./routes/settings'));

// Base route
app.get('/', (req, res) => {
  res.send('Zudo API is running...');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  console.error('Unhandled Error:', err);
  res.status(500).json({
    message: 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});


server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
