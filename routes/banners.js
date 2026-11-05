const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getModel } = require('../utils/model_loader');
const { connectDBByLocation } = require('../utils/db_manager');
const GlobalBanner = require('../models/Banner');

console.log('Banners router loaded');

// Helper to search across tenant connections
const findInTenantDatabases = async (callback) => {
  try {
    const { getCentralConn } = require('../utils/aggregator');
    const central = await getCentralConn();
    const CentralLocation = central.models.Location || central.model('Location', require('../models/Location').schema);
    const locations = await CentralLocation.find({ isActive: true }).lean();
    if (!locations || locations.length === 0) return null;

    for (const loc of locations) {
      try {
        const cityClean = loc.city.toLowerCase().replace(/\s+/g, '-');
        const dbName = `zudo-${cityClean}`;
        const connection = await connectDBByLocation(loc._id.toString(), dbName);
        const TenantBanner = connection.models.Banner || connection.model('Banner', GlobalBanner.schema);
        const result = await callback(TenantBanner, loc);
        if (result) return result;
      } catch (err) {
        console.error(`[Banners] Error operating on tenant DB for ${loc.city}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Banners] Error querying central location directory:', err.message);
  }
  return null;
};

// @route   GET /api/banners/public
// @desc    Get active banners for store/app without requiring authentication
router.get('/public', async (req, res) => {
  try {
    const { type, locationId } = req.query;
    const filter = { isActive: true };
    if (type) filter.type = type;

    let banners = [];
    if (locationId) {
      try {
        const conn = await connectDBByLocation(locationId);
        const TenantBanner = conn.models.Banner || conn.model('Banner', GlobalBanner.schema);
        banners = await TenantBanner.find(filter).sort({ createdAt: -1 }).lean();
      } catch (e) {
        console.warn('[Banners Public] Tenant lookup error:', e.message);
      }
    }

    // Always combine with global active banners
    const globalFilter = { ...filter, $or: [{ locationId: null }, { locationId: { $exists: false } }] };
    const globalBanners = await GlobalBanner.find(globalFilter).sort({ createdAt: -1 }).lean();

    const bannerMap = new Map();
    [...banners, ...globalBanners].forEach(b => {
      if (b && b._id) bannerMap.set(b._id.toString(), b);
    });

    const result = Array.from(bannerMap.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(result);
  } catch (error) {
    console.error('[Banners Public] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/banners
// @desc    Get all banners for admin panel
router.get('/', protect, async (req, res) => {
  try {
    const bannerMap = new Map();

    // 1. If scoped to a specific location tenant
    if (req.locationId) {
      const BannerModel = getModel('Banner', req);
      const tenantBanners = await BannerModel.find().sort({ createdAt: -1 }).lean();
      tenantBanners.forEach(b => {
        if (b && b._id) bannerMap.set(b._id.toString(), b);
      });

      // Also fetch global banners so tenant admins can view store-wide banners
      const globalBanners = await GlobalBanner.find({
        $or: [{ locationId: null }, { locationId: { $exists: false } }]
      }).sort({ createdAt: -1 }).lean();

      globalBanners.forEach(b => {
        if (b && b._id) bannerMap.set(b._id.toString(), b);
      });
    } else {
      // 2. Global View: Aggregate across all tenant DBs AND central DB
      try {
        const { aggregateGET } = require('../utils/aggregator');
        const aggregated = await aggregateGET('Banner', req, {}, [], '', { createdAt: -1 });
        if (Array.isArray(aggregated)) {
          aggregated.forEach(b => {
            if (b && b._id) bannerMap.set(b._id.toString(), b);
          });
        }
      } catch (aggErr) {
        console.warn('[Banners] Aggregate error:', aggErr.message);
      }

      // Always also fetch from Global/Central Banner model
      try {
        const globalBanners = await GlobalBanner.find().sort({ createdAt: -1 }).lean();
        globalBanners.forEach(b => {
          if (b && b._id) bannerMap.set(b._id.toString(), b);
        });
      } catch (globErr) {
        console.warn('[Banners] Global fetch error:', globErr.message);
      }
    }

    const allBanners = Array.from(bannerMap.values()).sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    res.json(allBanners);
  } catch (error) {
    console.error('[Banners GET] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/banners
// @desc    Create a new banner
router.post('/', protect, async (req, res) => {
  try {
    const { title, imageUrl, link, type, isActive, locationId } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ message: 'Banner creative image is required' });
    }

    const targetLocationId = locationId || req.locationId || null;
    let BannerModel = getModel('Banner', req) || GlobalBanner;

    // If specific location is targeted and we have a location connection
    if (targetLocationId && (!req.locationId || req.locationId !== targetLocationId)) {
      try {
        const conn = await connectDBByLocation(targetLocationId);
        BannerModel = conn.models.Banner || conn.model('Banner', GlobalBanner.schema);
      } catch (e) {
        console.warn('[Banners POST] Falling back to default model for location:', targetLocationId);
      }
    }

    const bannerData = {
      title: title || '',
      imageUrl,
      link: link || '',
      type: type || 'Main',
      isActive: isActive !== undefined ? isActive : true,
      locationId: targetLocationId
    };

    const banner = await BannerModel.create(bannerData);
    res.status(201).json(banner);
  } catch (error) {
    console.error('[Banners POST] Error:', error);
    res.status(400).json({ message: error.message });
  }
});

// @route   PUT /api/banners/:id
// @desc    Update a banner
router.put('/:id', protect, async (req, res) => {
  try {
    const BannerModel = getModel('Banner', req) || GlobalBanner;
    let banner = await BannerModel.findByIdAndUpdate(req.params.id, req.body, { new: true });

    // Fallback: Check GlobalBanner if not updated in tenant BannerModel
    if (!banner && BannerModel !== GlobalBanner) {
      banner = await GlobalBanner.findByIdAndUpdate(req.params.id, req.body, { new: true });
    }

    // Fallback: If still not found, search and update in tenant databases
    if (!banner) {
      banner = await findInTenantDatabases(async (TenantBanner) => {
        return await TenantBanner.findByIdAndUpdate(req.params.id, req.body, { new: true });
      });
    }

    if (!banner) {
      return res.status(404).json({ message: 'Banner not found' });
    }

    res.json(banner);
  } catch (error) {
    console.error('[Banners PUT] Error:', error);
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/banners/:id
// @desc    Delete a banner
router.delete('/:id', protect, async (req, res) => {
  try {
    const BannerModel = getModel('Banner', req) || GlobalBanner;
    let banner = await BannerModel.findByIdAndDelete(req.params.id);

    // Fallback: Check GlobalBanner
    if (!banner && BannerModel !== GlobalBanner) {
      banner = await GlobalBanner.findByIdAndDelete(req.params.id);
    }

    // Fallback: Search across tenant databases
    if (!banner) {
      banner = await findInTenantDatabases(async (TenantBanner) => {
        return await TenantBanner.findByIdAndDelete(req.params.id);
      });
    }

    if (!banner) {
      return res.status(404).json({ message: 'Banner not found' });
    }

    res.json({ message: 'Banner removed successfully', id: req.params.id });
  } catch (error) {
    console.error('[Banners DELETE] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
