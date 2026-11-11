const crypto = require('crypto');
const axios = require('axios');
const sendEmail = require('./email');
const firebaseService = require('./firebase');

// Configuration constants
const OTP_LENGTH = 6;
const OTP_EXPIRY_HOURS = 24; // 24 hours validity for delivery OTP
const OTP_COOLDOWN_SECONDS = 60; // 60 seconds minimum cooldown between resends
const MAX_OTP_ATTEMPTS = 5; // Lock/invalidate OTP after 5 consecutive failed attempts
const MAX_OTP_RESENDS = 5; // Max 5 resends allowed per order

/**
 * Generate a cryptographically secure 6-digit OTP
 */
const generate6DigitOTP = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Format phone number to clean 10-digit Indian mobile number
 */
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  const cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    return cleaned.slice(2);
  }
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    return cleaned.slice(1);
  }
  return cleaned;
};

/**
 * Send SMS using available SMS Gateway (Fast2SMS, Twilio, Generic Gateway) or graceful fallback
 */
const sendSms = async ({ phone, message }) => {
  const cleanPhone = normalizePhoneNumber(phone);
  if (!cleanPhone || cleanPhone.length !== 10) {
    console.warn(`[SMS] Invalid or missing phone number: ${phone}`);
    return { success: false, reason: 'Invalid phone number' };
  }

  // 1. Fast2SMS Integration
  if (process.env.FAST2SMS_API_KEY) {
    try {
      const response = await axios.post(
        'https://www.fast2sms.com/dev/bulkV2',
        {
          route: 'otp',
          variables_values: message,
          numbers: cleanPhone
        },
        {
          headers: {
            authorization: process.env.FAST2SMS_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 7000
        }
      );
      console.log(`[SMS] Fast2SMS dispatched successfully to ${cleanPhone}:`, response.data);
      return { success: true, provider: 'fast2sms', response: response.data };
    } catch (err) {
      console.error('[SMS] Fast2SMS dispatch failed:', err.response?.data || err.message);
    }
  }

  // 2. Twilio Integration
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const params = new URLSearchParams();
      params.append('To', `+91${cleanPhone}`);
      params.append('From', process.env.TWILIO_PHONE_NUMBER);
      params.append('Body', message);

      const response = await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
        params.toString(),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 7000
        }
      );
      console.log(`[SMS] Twilio dispatched successfully to +91${cleanPhone}`);
      return { success: true, provider: 'twilio', response: response.data };
    } catch (err) {
      console.error('[SMS] Twilio dispatch failed:', err.response?.data || err.message);
    }
  }

  // 3. Custom / Generic SMS Gateway Webhook
  if (process.env.SMS_GATEWAY_URL) {
    try {
      const response = await axios.post(
        process.env.SMS_GATEWAY_URL,
        {
          phone: cleanPhone,
          message,
          apiKey: process.env.SMS_GATEWAY_API_KEY
        },
        { timeout: 7000 }
      );
      console.log(`[SMS] Custom Gateway dispatched successfully to ${cleanPhone}`);
      return { success: true, provider: 'custom_gateway', response: response.data };
    } catch (err) {
      console.error('[SMS] Custom Gateway dispatch failed:', err.message);
    }
  }

  // Fallback / Development Simulation
  console.log(`[SMS SIMULATION] To: +91-${cleanPhone} | Message: "${message}"`);
  return { success: true, provider: 'simulated' };
};

/**
 * Dispatch multi-channel OTP delivery notification to Customer:
 * 1. SMS to registered mobile
 * 2. Push Notification via Firebase FCM
 * 3. Email Notification
 * 4. Real-time Socket.io update
 */
const dispatchDeliveryOtpNotification = async ({ order, otp, user }) => {
  const shortOrderId = order._id.toString().slice(-6).toUpperCase();
  const customerPhone = order.shippingAddress?.phone || user?.phone;
  const customerEmail = user?.email;
  const customerName = order.shippingAddress?.name || user?.name || 'Customer';

  const smsText = `Your Zudo delivery OTP for order #${shortOrderId} is ${otp}. Please share this 6-digit OTP with your delivery partner only upon receiving your package. Valid for 24 hours. Do not share with anyone else.`;

  // 1. Send SMS
  if (customerPhone) {
    sendSms({ phone: customerPhone, message: smsText }).catch(err => {
      console.error('[OTP] Failed to send SMS:', err.message);
    });
  }

  // 2. Send Firebase FCM Push Notification
  if (user?.fcmToken && firebaseService.isConfigured && firebaseService.admin) {
    try {
      const messagePayload = {
        token: user.fcmToken,
        notification: {
          title: `Order #${shortOrderId} is Out for Delivery! 🚚`,
          body: `Your 6-digit Delivery OTP is ${otp}. Share this with the delivery agent when your order arrives.`
        },
        data: {
          type: 'order_delivery_otp',
          orderId: order._id.toString(),
          deliveryOtp: String(otp),
          click_action: 'FLUTTER_NOTIFICATION_CLICK'
        }
      };
      firebaseService.admin.messaging().send(messagePayload)
        .then(() => console.log(`[FCM] Delivery OTP push sent to customer ${customerName}`))
        .catch(err => console.error('[FCM] Push send error:', err.message));
    } catch (fcmErr) {
      console.error('[FCM] Push error:', fcmErr.message);
    }
  }

  // 3. Send Email
  if (customerEmail) {
    sendEmail({
      to: customerEmail,
      subject: `🚚 Delivery OTP for Order #${shortOrderId} - Zudo`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
          <div style="background-color: #059669; color: white; padding: 24px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Your Order is Out for Delivery!</h1>
            <p style="margin: 8px 0 0 0; opacity: 0.9;">Order #${shortOrderId}</p>
          </div>
          <div style="padding: 24px; text-align: center;">
            <p style="font-size: 16px; margin-bottom: 20px;">Hello <strong>${customerName}</strong>,</p>
            <p style="color: #666; margin-bottom: 24px;">Our delivery partner is on the way with your package. Please provide the following 6-digit OTP to the delivery agent to confirm delivery:</p>
            
            <div style="background: #f0fdf4; border: 2px dashed #059669; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 0 auto 24px;">
              <span style="font-size: 12px; color: #047857; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">Delivery Verification OTP</span>
              <div style="font-size: 38px; font-weight: 900; letter-spacing: 8px; color: #059669; font-family: monospace; margin-top: 6px;">
                ${otp}
              </div>
            </div>

            <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; text-align: left; border-radius: 6px; margin-bottom: 20px;">
              <p style="margin: 0; color: #991b1b; font-size: 13px;">
                <strong>Security Notice:</strong> Please share this code only after verifying that your package has been physically handed over to you.
              </p>
            </div>

            <p style="font-size: 12px; color: #888;">This OTP is valid for 24 hours and can only be used once.</p>
          </div>
          <div style="background-color: #f9fafb; padding: 14px; text-align: center; font-size: 12px; color: #6b7280; border-top: 1px solid #eee;">
            Team Zudo • Thank you for shopping with us!
          </div>
        </div>
      `
    }).catch(err => console.error('[Email] OTP email failed:', err.message));
  }

  // 4. Emit Socket.IO Event
  try {
    const { getIO } = require('./socket');
    const io = getIO();
    if (io) {
      io.emit('order:delivery_otp', {
        orderId: order._id.toString(),
        userId: user?._id?.toString() || order.userId?.toString(),
        deliveryOtp: otp,
        expiresAt: order.deliveryOtpExpiresAt
      });
      io.emit(`order:${order._id.toString()}`, {
        type: 'DELIVERY_OTP_GENERATED',
        orderId: order._id.toString(),
        deliveryOtp: otp
      });
    }
  } catch (ioErr) {
    // Socket might not be initialized in non-server contexts (e.g. scripts/tests)
  }
};

/**
 * Assigns or refreshes 6-digit delivery OTP on order
 */
const prepareOrderDeliveryOtp = (order) => {
  const otp = generate6DigitOTP();
  order.deliveryOtp = otp;
  order.deliveryOtpCreatedAt = new Date();
  order.deliveryOtpExpiresAt = new Date(Date.now() + OTP_EXPIRY_HOURS * 60 * 60 * 1000);
  order.deliveryOtpAttempts = 0;
  return otp;
};

/**
 * Check if OTP resend is permitted under rate limit and business rules
 */
const canResendDeliveryOtp = (order) => {
  if (order.orderStatus === 'Delivered') {
    return { allowed: false, message: 'Order is already delivered' };
  }
  if (order.orderStatus === 'Cancelled') {
    return { allowed: false, message: 'Cannot resend OTP for a cancelled order' };
  }
  if (!['Out for Delivery', 'Shipped', 'Picked Up'].includes(order.orderStatus)) {
    return { 
      allowed: false, 
      message: 'Order must be ready for delivery or out for delivery to request a delivery OTP' 
    };
  }

  if (order.deliveryOtpLastResentAt) {
    const diffMs = Date.now() - new Date(order.deliveryOtpLastResentAt).getTime();
    const cooldownMs = OTP_COOLDOWN_SECONDS * 1000;
    if (diffMs < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - diffMs) / 1000);
      return {
        allowed: false,
        message: `Please wait ${waitSec} seconds before requesting a new OTP.`,
        retryAfterSeconds: waitSec
      };
    }
  }

  if ((order.deliveryOtpResendCount || 0) >= MAX_OTP_RESENDS) {
    return {
      allowed: false,
      message: `Maximum OTP resend limit (${MAX_OTP_RESENDS}) reached for this order. Please contact customer support.`
    };
  }

  return { allowed: true };
};

/**
 * Verify Delivery OTP and update order state
 */
const verifyOrderDeliveryOtp = (order, inputOtp) => {
  if (order.orderStatus === 'Delivered') {
    return { success: false, message: 'Order is already marked as Delivered', code: 'ALREADY_DELIVERED' };
  }
  if (order.orderStatus === 'Cancelled') {
    return { success: false, message: 'Cannot deliver a cancelled order', code: 'ORDER_CANCELLED' };
  }

  if (!order.deliveryOtp) {
    return {
      success: false,
      message: 'No active delivery OTP found for this order. Please request or generate OTP first.',
      code: 'NO_OTP'
    };
  }

  // Check Expiry
  if (order.deliveryOtpExpiresAt && new Date() > new Date(order.deliveryOtpExpiresAt)) {
    return {
      success: false,
      message: 'The delivery OTP has expired. Please request a new OTP to be sent to the customer.',
      code: 'EXPIRED'
    };
  }

  // Check Max Attempts / Brute Force Protection
  if ((order.deliveryOtpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
    // Invalidate current OTP
    order.deliveryOtp = null;
    order.deliveryOtpExpiresAt = null;
    return {
      success: false,
      message: `Maximum OTP attempts (${MAX_OTP_ATTEMPTS}) exceeded. Current OTP has been invalidated. Please resend a new OTP.`,
      code: 'MAX_ATTEMPTS_EXCEEDED',
      remainingAttempts: 0
    };
  }

  const cleanInput = String(inputOtp || '').trim();
  const cleanStored = String(order.deliveryOtp).trim();

  if (cleanInput.length !== OTP_LENGTH || cleanInput !== cleanStored) {
    order.deliveryOtpAttempts = (order.deliveryOtpAttempts || 0) + 1;
    const remaining = Math.max(0, MAX_OTP_ATTEMPTS - order.deliveryOtpAttempts);

    if (remaining === 0) {
      order.deliveryOtp = null;
      order.deliveryOtpExpiresAt = null;
      return {
        success: false,
        message: 'Incorrect OTP. Maximum attempts exceeded. Current OTP invalidated.',
        code: 'MAX_ATTEMPTS_EXCEEDED',
        remainingAttempts: 0
      };
    }

    return {
      success: false,
      message: `Incorrect 6-digit OTP. Please verify with the customer. (${remaining} attempt${remaining > 1 ? 's' : ''} remaining)`,
      code: 'INCORRECT_OTP',
      remainingAttempts: remaining
    };
  }

  // Successful verification!
  order.orderStatus = 'Delivered';
  order.deliveredAt = new Date();
  order.deliveryOtpVerifiedAt = new Date();
  order.deliveryOtp = null; // Prevent OTP reuse after successful delivery!
  order.deliveryOtpExpiresAt = null;

  return { success: true };
};

module.exports = {
  OTP_LENGTH,
  OTP_EXPIRY_HOURS,
  OTP_COOLDOWN_SECONDS,
  MAX_OTP_ATTEMPTS,
  MAX_OTP_RESENDS,
  generate6DigitOTP,
  normalizePhoneNumber,
  sendSms,
  dispatchDeliveryOtpNotification,
  prepareOrderDeliveryOtp,
  canResendDeliveryOtp,
  verifyOrderDeliveryOtp
};

