const mongoose = require('mongoose');

/**
 * Helper to get the correct model (Tenant or Global)
 * @param {string} modelName - The name of the model (e.g., 'Category')
 * @param {Object} req - The request object containing tenantModels or models
 * @returns {mongoose.Model}
 */
const getModel = (modelName, req) => {
  if (req) {
    if (req.tenantModels && req.tenantModels[modelName]) {
      return req.tenantModels[modelName];
    }
    if (req.models && req.models[modelName]) {
      return req.models[modelName];
    }
    if (req.db && req.db.models && req.db.models[modelName]) {
      return req.db.models[modelName];
    }
  }
  
  // Fallback to global model
  try {
    return require(`../models/${modelName}`);
  } catch (e) {
    return null;
  }
};

module.exports = { getModel };
