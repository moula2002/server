const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

// Helper to get models safely
const getModels = (req) => {
  return {
    Review: req.models?.Review || Review,
    Product: req.models?.Product || Product,
    Order: req.models?.Order || Order,
    User: req.models?.User || User
  };
};

/**
 * Recalculate average star rating and review count for a product
 */
const recalculateProductRating = async (ProductModel, ReviewModel, productId) => {
  try {
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) return;
    const pId = new mongoose.Types.ObjectId(productId);

    const stats = await ReviewModel.aggregate([
      { $match: { productId: pId, status: 'Approved' } },
      {
        $group: {
          _id: '$productId',
          avgRating: { $avg: '$rating' },
          numReviews: { $sum: 1 }
        }
      }
    ]);

    if (stats.length > 0) {
      const avg = Math.round(stats[0].avgRating * 10) / 10;
      const count = stats[0].numReviews;
      await ProductModel.findByIdAndUpdate(productId, { rating: avg, numReviews: count });
      return { rating: avg, numReviews: count };
    } else {
      await ProductModel.findByIdAndUpdate(productId, { rating: 0, numReviews: 0 });
      return { rating: 0, numReviews: 0 };
    }
  } catch (err) {
    console.error('[Reviews] Error recalculating product rating:', err);
  }
};

// @route   POST /api/reviews
// @desc    Create or update a product review
// @access  Private (Customer)
router.post('/', protect, async (req, res) => {
  try {
    const { productId, rating, title, comment, media } = req.body;
    const { Review: ReviewModel, Product: ProductModel, Order: OrderModel } = getModels(req);

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Valid Product ID is required' });
    }

    const numRating = Number(rating);
    if (!numRating || numRating < 1 || numRating > 5) {
      return res.status(400).json({ message: 'Rating must be an integer between 1 and 5' });
    }

    if (!comment || typeof comment !== 'string' || comment.trim().length < 3) {
      return res.status(400).json({ message: 'Review comment must be at least 3 characters long' });
    }

    // Check if product exists
    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Workflow Step: Verify Customer Purchase History
    let isVerifiedPurchase = false;
    const deliveredOrder = await OrderModel.findOne({
      userId: req.user._id,
      'items.productId': productId,
      orderStatus: 'Delivered'
    });
    if (deliveredOrder) {
      isVerifiedPurchase = true;
    }

    // Workflow Step: Duplicate Check & Upsert Handling
    const existingReview = await ReviewModel.findOne({
      userId: req.user._id,
      productId
    });

    if (existingReview) {
      // Update existing review
      existingReview.rating = numRating;
      existingReview.title = title ? String(title).trim() : existingReview.title;
      existingReview.comment = comment.trim();
      if (Array.isArray(media)) existingReview.media = media;
      existingReview.isVerifiedPurchase = isVerifiedPurchase || existingReview.isVerifiedPurchase;
      existingReview.status = 'Approved'; // Re-approved on user edit

      await existingReview.save();
      await recalculateProductRating(ProductModel, ReviewModel, productId);

      const populated = await ReviewModel.findById(existingReview._id)
        .populate('userId', 'name profilePicture role');

      return res.status(200).json({
        message: 'Your review was updated successfully!',
        review: populated,
        updated: true
      });
    }

    // Create fresh review
    const review = await ReviewModel.create({
      userId: req.user._id,
      productId,
      rating: numRating,
      title: title ? String(title).trim() : '',
      comment: comment.trim(),
      media: Array.isArray(media) ? media : [],
      isVerifiedPurchase,
      status: 'Approved'
    });

    // Update product rating and review count
    await recalculateProductRating(ProductModel, ReviewModel, productId);

    const populatedReview = await ReviewModel.findById(review._id)
      .populate('userId', 'name profilePicture role');

    res.status(201).json({
      message: 'Review posted successfully!',
      review: populatedReview,
      updated: false
    });
  } catch (error) {
    console.error('[POST /api/reviews] Error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'You have already submitted a review for this product.' });
    }
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/reviews/product/:id
// @desc    Get all approved reviews and rating breakdown for a product
// @access  Public
router.get('/product/:id', async (req, res) => {
  try {
    const { Review: ReviewModel } = getModels(req);
    const productId = req.params.id;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.json([]);
    }

    const reviews = await ReviewModel.find({
      productId,
      status: 'Approved'
    })
      .populate('userId', 'name profilePicture role')
      .sort({ createdAt: -1 });

    // Calculate rating breakdown distribution (1 to 5 stars)
    const totalReviews = reviews.length;
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let ratingSum = 0;

    reviews.forEach(r => {
      const star = Math.min(5, Math.max(1, Math.round(r.rating)));
      distribution[star] = (distribution[star] || 0) + 1;
      ratingSum += r.rating;
    });

    const averageRating = totalReviews > 0 ? (ratingSum / totalReviews).toFixed(1) : '0.0';

    // Format response ensuring backward compatibility (array) while allowing meta
    // If client queries ?detailed=true, return object with stats; otherwise return enriched array
    if (req.query.detailed === 'true') {
      return res.json({
        reviews,
        stats: {
          totalReviews,
          averageRating: Number(averageRating),
          distribution
        }
      });
    }

    // Default backward compatible array, with helpful attributes attached
    res.json(reviews);
  } catch (error) {
    console.error('[GET /api/reviews/product/:id] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/reviews/can-review/:productId
// @desc    Check if logged-in user has already reviewed or purchased the product
// @access  Private
router.get('/can-review/:productId', protect, async (req, res) => {
  try {
    const { Review: ReviewModel, Order: OrderModel } = getModels(req);
    const productId = req.params.productId;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product ID' });
    }

    const existingReview = await ReviewModel.findOne({
      userId: req.user._id,
      productId
    });

    const hasDeliveredOrder = await OrderModel.exists({
      userId: req.user._id,
      'items.productId': productId,
      orderStatus: 'Delivered'
    });

    res.json({
      hasReviewed: !!existingReview,
      existingReview: existingReview || null,
      isVerifiedBuyer: !!hasDeliveredOrder
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/reviews/:id
// @desc    Update an existing review
// @access  Private (Owner or Admin)
router.put('/:id', protect, async (req, res) => {
  try {
    const { Review: ReviewModel, Product: ProductModel } = getModels(req);
    const { rating, title, comment, media } = req.body;

    const review = await ReviewModel.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    // Authorization check
    const isOwner = review.userId.toString() === req.user._id.toString();
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager'].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to edit this review' });
    }

    if (rating != null) {
      const numRating = Number(rating);
      if (numRating >= 1 && numRating <= 5) review.rating = numRating;
    }
    if (title !== undefined) review.title = String(title).trim();
    if (comment) review.comment = String(comment).trim();
    if (Array.isArray(media)) review.media = media;

    await review.save();
    await recalculateProductRating(ProductModel, ReviewModel, review.productId);

    const populated = await ReviewModel.findById(review._id).populate('userId', 'name profilePicture role');
    res.json({
      success: true,
      message: 'Review updated successfully',
      review: populated
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/reviews/:id/helpful
// @desc    Upvote/Like a review as helpful
// @access  Private
router.post('/:id/helpful', protect, async (req, res) => {
  try {
    const { Review: ReviewModel } = getModels(req);
    const review = await ReviewModel.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    const userIdStr = req.user._id.toString();
    const existingIndex = (review.helpfulVotes || []).findIndex(v => v.toString() === userIdStr);

    if (existingIndex > -1) {
      // Toggle off
      review.helpfulVotes.splice(existingIndex, 1);
    } else {
      // Toggle on
      review.helpfulVotes = review.helpfulVotes || [];
      review.helpfulVotes.push(req.user._id);
    }

    review.helpfulCount = review.helpfulVotes.length;
    await review.save();

    res.json({
      helpfulCount: review.helpfulCount,
      isHelpful: existingIndex === -1
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==========================================
// 🛡️ ADMIN MODERATION ENDPOINTS
// ==========================================

// @route   GET /api/reviews
// @desc    Get all reviews with filters & stats (Admin)
// @access  Private (Admin only)
router.get('/', protect, async (req, res) => {
  try {
    const { Review: ReviewModel } = getModels(req);
    const { status, search, rating } = req.query;

    const filter = {};
    if (status && status !== 'All') {
      filter.status = status;
    }
    if (rating && rating !== 'All') {
      filter.rating = Number(rating);
    }

    let reviews;
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      reviews = await aggregateGET('Review', req, filter, ['userId', 'productId'], '', { createdAt: -1 });
    } else {
      reviews = await ReviewModel.find(filter)
        .populate('userId', 'name email role')
        .populate('productId', 'name imageUrl rating')
        .sort({ createdAt: -1 });
    }

    // Optional Search filter across populated user name or product name or comment
    if (search && search.trim() !== '') {
      const term = search.toLowerCase();
      reviews = reviews.filter(r => {
        const uName = (r.userId?.name || '').toLowerCase();
        const uEmail = (r.userId?.email || '').toLowerCase();
        const pName = (r.productId?.name || '').toLowerCase();
        const comment = (r.comment || '').toLowerCase();
        return uName.includes(term) || uEmail.includes(term) || pName.includes(term) || comment.includes(term);
      });
    }

    res.json(reviews);
  } catch (error) {
    console.error('[GET /api/reviews] Admin Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   PUT /api/reviews/:id/status
// @desc    Admin moderation action: Approve or Reject review
// @access  Private (Admin only)
router.put('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['Approved', 'Pending', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'Approved', 'Pending', or 'Rejected'" });
    }

    const { Review: ReviewModel, Product: ProductModel } = getModels(req);
    const review = await ReviewModel.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    review.status = status;
    await review.save();

    // Recalculate product rating since approval state changed
    await recalculateProductRating(ProductModel, ReviewModel, review.productId);

    res.json({
      message: `Review status updated to ${status}`,
      review
    });
  } catch (error) {
    console.error('[PUT /api/reviews/:id/status] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// @route   POST /api/reviews/:id/reply
// @desc    Admin moderation action: Post an official reply to customer review
// @access  Private (Admin only)
router.post('/:id/reply', protect, async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
      return res.status(400).json({ message: 'Reply comment is required' });
    }

    const { Review: ReviewModel } = getModels(req);
    const review = await ReviewModel.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    review.adminReply = {
      comment: comment.trim(),
      repliedAt: new Date(),
      repliedBy: req.user.name || 'Zudo Official Team'
    };

    await review.save();
    res.json({
      success: true,
      message: 'Admin reply posted successfully',
      review
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   DELETE /api/reviews/:id
// @desc    Delete a review and update product metrics
// @access  Private (Owner or Admin)
router.delete('/:id', protect, async (req, res) => {
  try {
    const { Review: ReviewModel, Product: ProductModel } = getModels(req);
    const review = await ReviewModel.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    // Authorization check
    const isOwner = review.userId.toString() === req.user._id.toString();
    const isAdmin = !!req.admin || ['super_admin', 'normal_admin', 'manager'].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this review' });
    }

    const productId = review.productId;
    await review.deleteOne();

    // Update product rating after review removal
    await recalculateProductRating(ProductModel, ReviewModel, productId);

    res.json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('[DELETE /api/reviews/:id] Error:', error);
    res.status(500).json({ message: error.message });
  }
});

router.recalculateProductRating = recalculateProductRating;
module.exports = router;
