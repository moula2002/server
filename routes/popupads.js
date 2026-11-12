const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getModel } = require('../utils/model_loader');

console.log('Popup Ads router loaded');

// @route   GET /api/popup-ads
// @desc    Get all popup ads
router.get('/', protect, async (req, res) => {
  try {
    const isGlobal = !req.locationId || req.locationId === 'global' || req.locationId === 'all';
    if (isGlobal) {
      const { aggregateGET } = require('../utils/aggregator');
      const ads = await aggregateGET('PopupAd', req, {}, [], '', { createdAt: -1 });
      return res.json(ads || []);
    }
    const PopupAdModel = getModel('PopupAd', req) || require('../models/PopupAd');
    const ads = await PopupAdModel.find().sort({ createdAt: -1 });
    res.json(ads || []);
  } catch (error) {
    console.error('[PopupAd GET Error]:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/popup-ads
// @desc    Create a new popup ad
router.post('/', protect, async (req, res) => {
  try {
    const { title, imageUrl, link, showOn, isActive, expiresAt, locationId } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Campaign title is required' });
    }

    if (!imageUrl || !imageUrl.trim()) {
      return res.status(400).json({ message: 'Creative image is required' });
    }

    const PopupAdModel = getModel('PopupAd', req) || require('../models/PopupAd');
    let effectiveLocationId = locationId !== undefined ? locationId : req.locationId;
    if (effectiveLocationId === 'global' || effectiveLocationId === 'all' || effectiveLocationId === 'null') {
      effectiveLocationId = null;
    }

    const ad = await PopupAdModel.create({
      title: title.trim(),
      imageUrl: imageUrl.trim(),
      link: link ? link.trim() : '',
      showOn: showOn || 'Home',
      isActive: isActive !== undefined ? isActive : true,
      expiresAt: expiresAt || null,
      locationId: effectiveLocationId
    });
    res.status(201).json(ad);
  } catch (error) {
    console.error('[PopupAd POST Error]:', error);
    res.status(400).json({ message: error.message });
  }
});

// @route   PUT /api/popup-ads/:id
// @desc    Update a popup ad
router.put('/:id', protect, async (req, res) => {
  try {
    if (!req.params.id || req.params.id === 'undefined') {
      return res.status(400).json({ message: 'Valid Ad ID is required' });
    }
    const PopupAdModel = getModel('PopupAd', req) || require('../models/PopupAd');
    const updateData = { ...req.body };
    if (updateData.expiresAt === '') {
      updateData.expiresAt = null;
    }
    const ad = await PopupAdModel.findByIdAndUpdate(req.params.id, updateData, { returnDocument: 'after' });
    if (!ad) return res.status(404).json({ message: 'Ad not found' });
    res.json(ad);
  } catch (error) {
    console.error('[PopupAd PUT Error]:', error);
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/popup-ads/:id
// @desc    Delete a popup ad
router.delete('/:id', protect, async (req, res) => {
  try {
    if (!req.params.id || req.params.id === 'undefined') {
      return res.status(400).json({ message: 'Valid Ad ID is required' });
    }
    const PopupAdModel = getModel('PopupAd', req) || require('../models/PopupAd');
    const ad = await PopupAdModel.findByIdAndDelete(req.params.id);
    if (!ad) return res.status(404).json({ message: 'Ad not found' });
    res.json({ message: 'Ad removed' });
  } catch (error) {
    console.error('[PopupAd DELETE Error]:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
