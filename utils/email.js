const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[Email] Email configuration missing (EMAIL_USER or EMAIL_PASS not set). Skipping email.');
    return false;
  }

  const recipient = (options.to || options.email || options.recipient || '').trim();
  if (!recipient || !recipient.includes('@')) {
    console.warn(`[Email] Invalid or missing recipient email ("${recipient}"). Skipping email send.`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: `Zudo <${process.env.EMAIL_USER}>`,
    to: recipient,
    subject: options.subject || 'Notification from Zudo',
    html: options.html || (options.message ? `<p style="white-space: pre-wrap;">${options.message}</p>` : options.text || '')
  };

  if (options.attachments && Array.isArray(options.attachments)) {
    mailOptions.attachments = options.attachments;
  }

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
};

module.exports = sendEmail;
