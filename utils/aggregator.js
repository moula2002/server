const mongoose = require('mongoose');
const { connectDBByLocation } = require('./db_manager');

let centralConn;
const getCentralConn = async () => {
  if (centralConn) return centralConn;
  const URI = process.env.MONGODB_URI;
  const lastSlashIndex = URI.lastIndexOf('/');
  const lastQuestionIndex = URI.indexOf('?', lastSlashIndex);
  const CENTRAL_URI = URI.substring(0, lastSlashIndex + 1) + 'zudo-central' + (lastQuestionIndex !== -1 ? URI.substring(lastQuestionIndex) : '');
  centralConn = await mongoose.createConnection(CENTRAL_URI).asPromise();
  return centralConn;
};

/**
 * Aggregates data from all active tenant databases
 * @param {string} modelName - e.g. 'Product', 'Order', 'Category', 'Seller', 'Driver', 'User', 'SubCategory'
 * @param {Object} req - Express request
 * @param {Object} query - Mongoose find query
 * @param {Array|string} populate - Mongoose populate arguments
 * @param {string} select - Mongoose select fields
 * @param {Object} sort - Mongoose sort argument
 * @returns {Promise<Array>}
 */
const aggregateGET = async (modelName, req, query = {}, populate = [], select = '', sort = null) => {
  try {
    const central = await getCentralConn();
    const CentralLocation = central.models.Location || central.model('Location', require('../models/Location').schema);
    const locations = await CentralLocation.find({ isActive: true }).lean();

    if (!locations || locations.length === 0) {
      return [];
    }

    const schemas = {
      Product: require('../models/Product').schema,
      Order: require('../models/Order').schema,
      Category: require('../models/Category').schema,
      SubCategory: require('../models/SubCategory').schema,
      Seller: require('../models/Seller').schema,
      Driver: require('../models/Driver').schema,
      User: require('../models/User').schema,
      Admin: require('../models/Admin').schema,
      CashCollector: require('../models/CashCollector').schema,
      Location: require('../models/Location').schema,
      SellerPayment: require('../models/SellerPayment').schema,
      PaymentAuditLog: require('../models/PaymentAuditLog').schema,
      SellerInvoice: require('../models/SellerInvoice').schema,
      Review: require('../models/Review').schema,
      DeliverySlot: require('../models/DeliverySlot').schema,
      Commission: require('../models/Commission').schema,
      Deposit: require('../models/Deposit').schema,
      Attendance: require('../models/Attendance').schema,
      Banner: require('../models/Banner').schema,
      PopupAd: require('../models/PopupAd').schema,
      Notification: require('../models/Notification').schema,
      Feed: require('../models/Feed').schema,
    };

    const schema = schemas[modelName];
    if (!schema) {
      throw new Error(`Schema not found for model: ${modelName}`);
    }

    const aggregationPromises = locations.map(async (loc) => {
      try {
        const locationId = loc._id.toString();
        const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
        const dbName = `zudo-${cityClean}`;

        const connection = await connectDBByLocation(locationId, dbName);
        
        // Pre-register all models on this tenant connection to prevent populate schema errors
        Object.keys(schemas).forEach((name) => {
          if (!connection.models[name]) {
            connection.model(name, schemas[name]);
          }
        });

        const Model = connection.models[modelName];

        let mongooseQuery = Model.find(query);
        if (populate) {
          if (Array.isArray(populate)) {
            populate.forEach(p => {
              mongooseQuery = mongooseQuery.populate(p);
            });
          } else {
            mongooseQuery = mongooseQuery.populate(populate);
          }
        }
        if (select) {
          mongooseQuery = mongooseQuery.select(select);
        }
        if (sort) {
          mongooseQuery = mongooseQuery.sort(sort);
        }

        const items = await mongooseQuery.lean();

        // Enrich items with location info
        return items.map(item => ({
          ...item,
          locationId: loc._id,
          locationName: loc.city,
          location: {
            _id: loc._id,
            city: loc.city,
            name: loc.name || dbName,
            state: loc.state
          }
        }));
      } catch (err) {
        console.error(`[Aggregator] Error querying ${modelName} from ${loc.city}:`, err.message);
        return [];
      }
    });

    const results = await Promise.all(aggregationPromises);
    let flattened = results.flat();

    // Perform sorting in memory if sort is specified
    if (sort) {
      const keys = Object.keys(sort);
      if (keys.length > 0) {
        const key = keys[0];
        const direction = sort[key]; // 1 or -1 or 'asc' or 'desc'
        flattened.sort((a, b) => {
          let valA = a[key];
          let valB = b[key];

          // Handle date comparisons
          if (valA instanceof Date) valA = valA.getTime();
          if (valB instanceof Date) valB = valB.getTime();

          if (valA < valB) return direction === -1 || direction === 'desc' ? 1 : -1;
          if (valA > valB) return direction === -1 || direction === 'desc' ? -1 : 1;
          return 0;
        });
      }
    }

    return flattened;
  } catch (error) {
    console.error(`[Aggregator] Global aggregation failed for ${modelName}:`, error);
    throw error;
  }
};

module.exports = { aggregateGET, getCentralConn };
