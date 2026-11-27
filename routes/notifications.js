const express = require('express');
const router = express.Router();
const { protect, superAdmin } = require('../middleware/auth');
const { getModel } = require('../utils/model_loader');
const firebaseService = require('../utils/firebase');

// @route   GET /api/notifications
// @desc    Get all notifications
router.get('/', protect, async (req, res) => {
  try {
    if (!req.locationId) {
      const { aggregateGET } = require('../utils/aggregator');
      const notifications = await aggregateGET('Notification', req, {}, [], '', { createdAt: -1 });
      return res.json(notifications.slice(0, 50));
    }
    const NotificationModel = getModel('Notification', req);
    const notifications = await NotificationModel.find()
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @route   GET /api/notifications/test-send
// @desc    Temporary route to easily test notifications via browser (No Auth required)
router.get('/test-send', async (req, res) => {
  try {
    const NotificationModel = getModel('Notification', req);
    const UserModel = getModel('User', req);
    
    const title = "Browser Test Flash Sale! 🚀";
    const notifMessage = "This was triggered from the browser without login.";
    const image = "https://images.unsplash.com/photo-1526289034009-0240ddb68ce3?q=80&w=2071&auto=format&fit=crop";
    const roleTarget = req.query.role || 'all'; // You can pass ?role=b2b in URL

    // 1. Save history
    const notification = await NotificationModel.create({
      title,
      message: notifMessage,
      image,
      type: 'info',
      recipient: roleTarget,
      locationId: req.locationId || null
    });

    // 2. Fetch users
    let query = { fcmToken: { $exists: true, $ne: '' } };
    if (roleTarget !== 'all') {
      query.role = roleTarget;
    }
    const users = await UserModel.find(query).select('fcmToken');
    const tokens = users.map(u => u.fcmToken).filter(t => t);

    // 3. Send via Firebase FCM
    let successCount = 0;
    let failureCount = 0;

    if (tokens.length > 0 && firebaseService.isConfigured && firebaseService.admin) {
      const chunkSize = 500;
      for (let i = 0; i < tokens.length; i += chunkSize) {
        const chunk = tokens.slice(i, i + chunkSize);
        
        const messagePayload = {
          tokens: chunk,
          notification: { title: title, body: notifMessage, imageUrl: image },
          data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', type: 'info' }
        };

        try {
          const response = await firebaseService.admin.messaging().sendEachForMulticast
            ? await firebaseService.admin.messaging().sendEachForMulticast(messagePayload)
            : await firebaseService.admin.messaging().sendMulticast(messagePayload);
            
          successCount += response.successCount;
          failureCount += response.failureCount;
        } catch (fcmErr) {
          console.error('[FCM] Error sending test multicast:', fcmErr);
        }
      }
    }

    res.status(200).json({
      success: true,
      message: "Test completed!",
      fcmDelivery: {
        totalTargeted: tokens.length,
        successCount,
        failureCount
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// @route   POST /api/notifications
// @desc    Create and Send a push notification
router.post('/', protect, async (req, res) => {
  try {
    const NotificationModel = getModel('Notification', req);
    const UserModel = getModel('User', req);
    
    // User requested: title, description (mapped to message), image, user role (recipient)
    const { title, message, description, image, type, recipient, locationId } = req.body;
    
    const notifMessage = message || description;
    const roleTarget = recipient || 'all';

    console.log(`\n[FCM DEBUG] --- NEW ADMIN NOTIFICATION REQUEST ---`);
    console.log(`[FCM DEBUG] Title: "${title}", Role: ${roleTarget}, LocationID: ${locationId || req.locationId}`);

    // 1. Save notification history in DB
    const notification = await NotificationModel.create({
      title,
      message: notifMessage,
      image,
      type: type || 'info',
      recipient: roleTarget,
      locationId: locationId || req.locationId,
      createdBy: req.admin?._id || req.user?._id
    });
    console.log(`[FCM DEBUG] Saved notification history to DB. ID: ${notification._id}`);

    // 2. Fetch users based on role targeting
    let query = { fcmToken: { $exists: true, $ne: '' } };
    if (roleTarget !== 'all') {
      // roleTarget will be 'b2b' or 'b2c'
      query.role = roleTarget;
    }
    
    console.log(`[FCM DEBUG] Querying users for tokens with query:`, JSON.stringify(query));
    const users = await UserModel.find(query).select('fcmToken role email');
    const tokens = users.map(u => u.fcmToken).filter(t => t);
    
    console.log(`[FCM DEBUG] Found ${users.length} users with FCM tokens.`);
    if (users.length > 0) {
      console.log(`[FCM DEBUG] Sample tokens found for users: ${users.slice(0, 3).map(u => u.email || 'Unknown').join(', ')}`);
    }

    // 3. Send via Firebase FCM
    let successCount = 0;
    let failureCount = 0;

    if (tokens.length > 0) {
      console.log(`[FCM DEBUG] Firebase Configured: ${firebaseService.isConfigured}, Admin initialized: ${!!firebaseService.admin}`);
      
      if (firebaseService.isConfigured && firebaseService.admin) {
        // Firebase allows max 500 tokens per multicast message
        const chunkSize = 500;
        for (let i = 0; i < tokens.length; i += chunkSize) {
          const chunk = tokens.slice(i, i + chunkSize);
          
          const messagePayload = {
            tokens: chunk,
            notification: {
              title: title,
              body: notifMessage,
            },
            data: {
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
              type: type || 'info',
            }
          };

          if (image) {
            messagePayload.notification.imageUrl = image;
          }

          console.log(`[FCM DEBUG] Sending multicast to ${chunk.length} tokens...`);
          
          try {
            const response = await firebaseService.admin.messaging().sendEachForMulticast
              ? await firebaseService.admin.messaging().sendEachForMulticast(messagePayload)
              : await firebaseService.admin.messaging().sendMulticast(messagePayload);
              
            successCount += response.successCount;
            failureCount += response.failureCount;
            
            // Log individual failures if any
            if (response.failureCount > 0) {
              const failedTokens = [];
              response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                  failedTokens.push(chunk[idx]);
                  console.error(`[FCM DEBUG] Failed token ${idx}:`, resp.error);
                }
              });
              console.log(`[FCM DEBUG] Tokens that failed:`, failedTokens);
            }
          } catch (fcmErr) {
            console.error('[FCM DEBUG] Critical Error sending multicast:', fcmErr);
          }
        }
        console.log(`[FCM DEBUG] Broadcast Complete. Success: ${successCount}, Failures: ${failureCount}\n`);
      } else {
        console.log(`[FCM DEBUG] SKIPPED FCM: Firebase Service is not properly configured on server.\n`);
      }
    } else {
      console.log(`[FCM DEBUG] SKIPPED FCM: No valid tokens found for role: ${roleTarget}.\n`);
    }

    res.status(201).json({
      notification,
      fcmDelivery: {
        totalTargeted: tokens.length,
        successCount,
        failureCount
      }
    });
  } catch (error) {
    console.error('[FCM DEBUG] [ERROR] Failed to process notification request:', error);
    res.status(400).json({ message: error.message });
  }
});

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
router.put('/:id/read', protect, async (req, res) => {
  try {
    const NotificationModel = getModel('Notification', req);
    const notification = await NotificationModel.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { returnDocument: 'after' }
    );
    res.json(notification);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Delete a notification
router.delete('/:id', protect, async (req, res) => {
  try {
    const NotificationModel = getModel('Notification', req);
    await NotificationModel.findByIdAndDelete(req.params.id);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// @route   POST /api/notifications/register-token
// @desc    Register user FCM token
router.post('/register-token', protect, async (req, res) => {
  try {
    const UserModel = getModel('User', req);
    
    // Support B2C/B2B User
    const user = await UserModel.findByIdAndUpdate(
      req.user._id,
      { fcmToken: req.body.fcmToken },
      { returnDocument: 'after' }
    );

    console.log(`[FCM] Registered token for user ${user.email}: ${req.body.fcmToken}`);
    res.json({ message: 'Token registered successfully', user });
  } catch (error) {
    console.error('[ERROR] Failed to register FCM token:', error);
    res.status(500).json({ message: error.message });
  }
});

// Deduplicate delayed exit/cart-abandon notifications per token + type
const pendingExitTimers = new Map();

// @route   POST /api/notifications/trigger-exit
// @desc    Trigger a delayed exit intent or cart abandonment notification
router.post('/trigger-exit', async (req, res) => {
  try {
    const { fcmToken, type, productName } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ message: 'FCM Token is required' });
    }

    let title = '';
    let body = '';

    if (type === 'low_session') {
      title = 'Why are you leaving so soon? 🥺';
      body = 'We miss you already! Open Zudo to explore our latest fresh deals.';
    } else if (type === 'cart_abandon') {
      const displayProd = productName || 'fresh produce';
      title = 'Your cart misses you! 🛒';
      body = `The ${displayProd} in your cart is lonely! Complete your order now.`;
    } else {
      return res.status(400).json({ message: 'Invalid exit type' });
    }

    const timerKey = `${fcmToken}:${type}`;
    if (pendingExitTimers.has(timerKey)) {
      clearTimeout(pendingExitTimers.get(timerKey));
      pendingExitTimers.delete(timerKey);
    }

    console.log(`[FCM] Queued delayed notification (${type}) for token: ${fcmToken} in 1 minute.`);

    // Schedule the notification with a 1-minute delay (60,000 ms)
    const timerId = setTimeout(async () => {
      pendingExitTimers.delete(timerKey);
      try {
        console.log(`
┌──────────────────────────────────────────────────────────┐
│ 🚀 [FCM PUSH NOTIFICATION TRIGGERED (1-MIN DELAY)]       │
├──────────────────────────────────────────────────────────┤
│ Type:  ${type.toUpperCase()}                              │
│ Token: ${fcmToken}                                       │
│ Title: ${title}                                           │
│ Body:  ${body}                                           │
└──────────────────────────────────────────────────────────┘
        `);

        // Send real FCM notification if Firebase Admin SDK is configured
        if (firebaseService.isConfigured && firebaseService.admin) {
          if (fcmToken.includes('mock-')) {
            console.log(`[FCM] (Mock Mode) Mock token detected. Skipping actual Firebase send for token: ${fcmToken}`);
          } else {
            const message = {
              token: fcmToken,
              notification: {
                title: title,
                body: body,
              },
              data: {
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                type: type,
              },
            };
            
            await firebaseService.admin.messaging().send(message);
            console.log(`[FCM] Real push notification successfully sent to device using token: ${fcmToken}`);
          }
        } else {
          console.log(`[FCM] (Mock Mode) Push notification would have been sent to device. Token: ${fcmToken}`);
        }

        // Also persist this notification in the correct tenant db so they can view it in the app!
        const NotificationModel = getModel('Notification', req);
        await NotificationModel.create({
          title,
          message: body,
          type: 'info',
          recipient: 'all'
        });

      } catch (timeoutErr) {
        console.error('[ERROR] Failed to process delayed notification timeout:', timeoutErr);
      }
    }, 60 * 1000);

    pendingExitTimers.set(timerKey, timerId);

    res.json({ message: 'Notification queued successfully' });
  } catch (error) {
    console.error('[ERROR] Failed to queue exit notification:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
