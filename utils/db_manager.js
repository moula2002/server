const mongoose = require('mongoose');

const connections = {};

/**
 * Connect to a specific location-based database
 * @param {string} locationId - The unique ID or name of the location
 * @returns {Promise<mongoose.Connection>}
 */
const connectDBByLocation = async (locationId, customName = null) => {
  if (!locationId) {
    return mongoose.connection; 
  }

  // Normalize/Sanitize locationId
  let sanitizedLocation = locationId.trim().toLowerCase();
  
  // Strip 'loc-' prefix if present (e.g. loc-6a1019f93bc692d82a2e4a7e -> 6a1019f93bc692d82a2e4a7e)
  let cleanLocationId = locationId.trim();
  if (sanitizedLocation.startsWith('loc-')) {
    cleanLocationId = cleanLocationId.substring(4);
    sanitizedLocation = sanitizedLocation.substring(4);
  }

  if (!customName && mongoose.Types.ObjectId.isValid(cleanLocationId) && cleanLocationId.length === 24) {
    try {
      console.log(`[Multi-Tenant] Resolving ObjectId: ${cleanLocationId}`);
      
      const fullUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/zudodb';
      const uriWithoutQuery = fullUri.split('?')[0];
      const query = fullUri.includes('?') ? '?' + fullUri.split('?')[1] : '';
      const lastSlashIndex = uriWithoutQuery.lastIndexOf('/');
      const centralUri = uriWithoutQuery.substring(0, lastSlashIndex + 1) + 'zudo-central' + query;
      
      if (!connections['zudo-central']) {
        connections['zudo-central'] = await mongoose.createConnection(centralUri).asPromise();
      }
      
      const centralConn = connections['zudo-central'];
      const LocationModel = centralConn.models.Location || centralConn.model('Location', require('../models/Location').schema);
      
      const locationDoc = await LocationModel.findById(cleanLocationId);
      console.log(`[Multi-Tenant] Found locationDoc in central:`, !!locationDoc);
      if (locationDoc && locationDoc.city) {
        sanitizedLocation = locationDoc.city.toLowerCase().replace(/\s+/g, '-');
        console.log(`[Multi-Tenant] Resolved city to: ${sanitizedLocation}`);
      }
    } catch (err) {
      console.error('[Multi-Tenant] Error resolving Location ID to city name:', err);
    }
  }
  
  while (sanitizedLocation.startsWith('zudo-zudo-')) {
    sanitizedLocation = sanitizedLocation.replace('zudo-zudo-', 'zudo-');
  }

  // Determine target database name
  let dbName;
  if (customName) {
    dbName = customName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  } else {
    // If it starts with zudo-, use it directly (e.g. "zudo-bengaluru")
    if (sanitizedLocation.startsWith('zudo-')) {
      dbName = sanitizedLocation;
    } else if (sanitizedLocation === 'zudodb') {
      dbName = 'zudodb';
    } else {
      // Otherwise, prefix with zudo- (e.g. "bengaluru" -> "zudo-bengaluru")
      dbName = `zudo-${sanitizedLocation}`;
    }
  }

  // Double check that we never have a "zudo-zudo-" prefix in the final dbName
  while (dbName.startsWith('zudo-zudo-')) {
    dbName = dbName.replace('zudo-zudo-', 'zudo-');
  }

  // Map Bangalore to Bengaluru explicitly to fix database mismatch
  if (dbName === 'zudo-bangalore') {
    dbName = 'zudo-bengaluru';
  }

  if (connections[dbName]) {
    return connections[dbName];
  }

  // Clean URI to append new DB name
  const fullUri = process.env.MONGODB_URI;
  const uriWithoutQuery = fullUri.split('?')[0];
  const query = fullUri.includes('?') ? '?' + fullUri.split('?')[1] : '';
  
  // Replace the default database name (zudodb) with the tenant-specific name
  const lastSlashIndex = uriWithoutQuery.lastIndexOf('/');
  const finalUri = uriWithoutQuery.substring(0, lastSlashIndex + 1) + dbName + query;

  console.log(`[Multi-Tenant] Provisioning/Connecting to database: ${dbName}`);

  const connection = await mongoose.createConnection(finalUri).asPromise();

  connections[dbName] = connection;

  return connection;
};

const getTenantConnections = () => connections;

module.exports = { connectDBByLocation, getTenantConnections };
