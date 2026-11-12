const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

/**
 * Format currency amount to Indian Rupee format with commas
 */
const formatINR = (val) => {
  const num = Number(val) || 0;
  return 'Rs. ' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * Generate a professional, print-ready A4 Payment Settlement Receipt PDF
 * @param {Object} options
 * @param {Object} options.payment - SellerPayment record
 * @param {Object} options.seller - Seller object
 * @returns {Promise<Buffer>}
 */
const generatePaymentReceiptPDF = async ({ payment, seller }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 28,
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      const primaryColor = '#4f46e5';    // Indigo primary
      const secondaryColor = '#0f172a';  // Slate dark
      const mutedColor = '#64748b';      // Muted slate
      const borderColor = '#e2e8f0';     // Slate border
      const lightBg = '#f8fafc';         // Light slate card background
      const greenColor = '#16a34a';      // Green success
      const amberColor = '#d97706';      // Amber warning

      const PAGE_LEFT = 28;
      const PAGE_RIGHT = 567;
      const CONTENT_WIDTH = PAGE_RIGHT - PAGE_LEFT; // 539pt

      const receiptNum = payment.receiptNumber || (payment._id ? `ZUDO-PAY-${payment._id.toString().slice(-6).toUpperCase()}` : 'ZUDO-PAY-0001');
      const paymentDateStr = new Date(payment.date || payment.createdAt || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const generatedAtStr = new Date().toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      const isFullSettlement = payment.settlementType === 'Full Settlement' || (payment.remainingOutstanding !== undefined && payment.remainingOutstanding <= 0);
      const settlementStatusLabel = isFullSettlement ? 'FULL SETTLEMENT' : 'PARTIAL SETTLEMENT';
      const statusColor = isFullSettlement ? greenColor : amberColor;

      // ==========================================
      // 1. HEADER SECTION (Brand & Receipt Title)
      // ==========================================
      const logoPath = path.join(__dirname, '../logo.png');
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, PAGE_LEFT, 28, { fit: [110, 40] });
        } catch (e) {
          doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', PAGE_LEFT, 28, { lineBreak: false });
        }
      } else {
        doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', PAGE_LEFT, 28, { lineBreak: false });
      }

      // Title on right side
      doc.fontSize(16).font('Helvetica-Bold').fillColor(primaryColor).text('PAYMENT SETTLEMENT RECEIPT', 250, 28, { align: 'right', width: 317, lineBreak: false });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(secondaryColor).text(`RECEIPT #: ${receiptNum}`, 250, 48, { align: 'right', width: 317, lineBreak: false });
      doc.fontSize(8.5).font('Helvetica').fillColor(mutedColor).text(`Date: ${paymentDateStr}`, 250, 62, { align: 'right', width: 317, lineBreak: false });

      // Dividing Line
      doc.strokeColor(borderColor).lineWidth(1.2).moveTo(PAGE_LEFT, 80).lineTo(PAGE_RIGHT, 80).stroke();

      // ==========================================
      // 2. STATUS STRIP (Partial / Full Badge)
      // ==========================================
      const badgeY = 88;
      doc.roundedRect(PAGE_LEFT, badgeY, CONTENT_WIDTH, 26, 6)
        .fillAndStroke(isFullSettlement ? '#f0fdf4' : '#fffbeb', isFullSettlement ? '#bbf7d0' : '#fde68a');

      doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColor)
        .text(`STATUS: ${settlementStatusLabel}`, PAGE_LEFT + 14, badgeY + 8, { lineBreak: false });
      
      doc.font('Helvetica').fontSize(8.5).fillColor(mutedColor)
        .text(`Generated on ${generatedAtStr} | Authorized Platform Payout`, 200, badgeY + 8, { align: 'right', width: 350, lineBreak: false });

      // ==========================================
      // 3. COMPANY & SELLER DETAILS (2-COLUMN CARDS)
      // ==========================================
      const partiesY = 124;
      const cardWidth = (CONTENT_WIDTH - 14) / 2;
      const cardHeight = 90;

      // Platform Info Box (Left)
      doc.roundedRect(PAGE_LEFT, partiesY, cardWidth, cardHeight, 8).fillAndStroke(lightBg, borderColor);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(primaryColor).text('ISSUED BY (PLATFORM):', PAGE_LEFT + 12, partiesY + 10, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(secondaryColor).text('SNB TRADING CO. (ZUDO)', PAGE_LEFT + 12, partiesY + 23, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(mutedColor);
      doc.text('307 Ashrya Layout, Vishweshwaria 7th Block', PAGE_LEFT + 12, partiesY + 36, { lineBreak: false });
      doc.text('Bengaluru, Karnataka - 560091, India', PAGE_LEFT + 12, partiesY + 48, { lineBreak: false });
      doc.text('GSTIN: 29BQHPG3242G1ZYNO  |  support@snbtradingco.in', PAGE_LEFT + 12, partiesY + 60, { lineBreak: false });
      doc.text('Phone: +91 88920 41586', PAGE_LEFT + 12, partiesY + 72, { lineBreak: false });

      // Seller Beneficiary Box (Right)
      const rightCardX = PAGE_LEFT + cardWidth + 14;
      doc.roundedRect(rightCardX, partiesY, cardWidth, cardHeight, 8).fillAndStroke(lightBg, borderColor);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(primaryColor).text('PAID TO (SELLER BENEFICIARY):', rightCardX + 12, partiesY + 10, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(secondaryColor).text(seller?.name || 'Merchant Partner', rightCardX + 12, partiesY + 23, { lineBreak: false, width: cardWidth - 24 });
      doc.font('Helvetica').fontSize(8).fillColor(mutedColor);
      doc.text(`Store / Company: ${seller?.businessName || seller?.storeName || 'N/A'}`, rightCardX + 12, partiesY + 36, { lineBreak: false, width: cardWidth - 24 });
      doc.text(`Seller ID: ${seller?._id || payment.sellerId}`, rightCardX + 12, partiesY + 48, { lineBreak: false, width: cardWidth - 24 });
      doc.text(`Phone: ${seller?.phone || 'N/A'}  |  Email: ${seller?.email || 'N/A'}`, rightCardX + 12, partiesY + 60, { lineBreak: false, width: cardWidth - 24 });
      if (seller?.gstNumber) {
        doc.text(`GSTIN: ${seller.gstNumber}`, rightCardX + 12, partiesY + 72, { lineBreak: false });
      }

      // ==========================================
      // 4. TRANSACTION DETAILS META BAR
      // ==========================================
      const metaY = partiesY + cardHeight + 14;
      doc.roundedRect(PAGE_LEFT, metaY, CONTENT_WIDTH, 42, 8).fillAndStroke(lightBg, borderColor);

      const subCellWidth = CONTENT_WIDTH / 4;
      const metaItems = [
        { label: 'PAYMENT METHOD', val: payment.paymentMethod || 'Bank Transfer' },
        { label: 'TRANSACTION / UTR REF', val: payment.utrReference || payment.transactionId || 'Direct Settlement' },
        { label: 'PAYMENT DATE', val: paymentDateStr },
        { label: 'AUTHORIZED BY', val: payment.adminName || 'Super Admin' }
      ];

      metaItems.forEach((m, idx) => {
        const xPos = PAGE_LEFT + (idx * subCellWidth) + 12;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(mutedColor).text(m.label, xPos, metaY + 8, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(secondaryColor).text(m.val, xPos, metaY + 22, { lineBreak: false, width: subCellWidth - 16 });
      });

      // ==========================================
      // 5. PAYMENT BREAKDOWN TABLE (SECTION 2)
      // ==========================================
      const tableY = metaY + 54;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(secondaryColor).text('PAYMENT BREAKDOWN & BALANCE LEDGER', PAGE_LEFT, tableY, { lineBreak: false });

      const headerY = tableY + 16;
      doc.roundedRect(PAGE_LEFT, headerY, CONTENT_WIDTH, 24, 6).fill(primaryColor);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text('DESCRIPTION', PAGE_LEFT + 14, headerY + 7, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text('AMOUNT (INR)', PAGE_RIGHT - 120, headerY + 7, { align: 'right', width: 106, lineBreak: false });

      // Table Rows
      const prevOutstanding = Number(payment.previousOutstanding) || 0;
      const currentPaid = Number(payment.amount) || 0;
      const remOutstanding = Number(payment.remainingOutstanding) !== undefined 
        ? Number(payment.remainingOutstanding) 
        : Math.max(0, prevOutstanding - currentPaid);

      const totalPayableEstimate = payment.totalPayableAtSettlement || Math.max(prevOutstanding, (Number(payment.previouslySettledAtSettlement) || 0) + prevOutstanding);

      const rows = [
        {
          label: 'Total Seller Payable (Net of Platform Commission & GST)',
          sub: 'Total accrued earnings from confirmed delivered orders',
          amount: formatINR(totalPayableEstimate),
          bg: '#ffffff',
          color: secondaryColor,
          bold: false
        },
        {
          label: 'Previously Settled Amount',
          sub: 'Cumulative payouts processed prior to this payment',
          amount: formatINR(payment.previouslySettledAtSettlement || (totalPayableEstimate - prevOutstanding)),
          bg: lightBg,
          color: mutedColor,
          bold: false
        },
        {
          label: 'Current Payment Settlement (Amount Paid Now)',
          sub: `Settled via ${payment.paymentMethod || 'Bank Transfer'} on ${paymentDateStr}`,
          amount: formatINR(currentPaid),
          bg: '#ecfdf5',
          color: greenColor,
          bold: true
        },
        {
          label: 'Remaining Outstanding Dues (Balance Payable)',
          sub: isFullSettlement ? 'All outstanding platform dues for delivered orders are now fully cleared.' : 'Remaining balance will be cleared in subsequent settlements.',
          amount: formatINR(remOutstanding),
          bg: isFullSettlement ? '#f0fdf4' : '#fffbeb',
          color: isFullSettlement ? greenColor : amberColor,
          bold: true
        }
      ];

      let currentY = headerY + 26;
      rows.forEach((r, idx) => {
        const rowHeight = 36;
        doc.roundedRect(PAGE_LEFT, currentY, CONTENT_WIDTH, rowHeight, 4).fillAndStroke(r.bg, borderColor);

        doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(9.5).fillColor(r.color)
          .text(r.label, PAGE_LEFT + 14, currentY + 7, { lineBreak: false, width: 380 });
        
        doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor)
          .text(r.sub, PAGE_LEFT + 14, currentY + 20, { lineBreak: false, width: 380 });

        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(r.color)
          .text(r.amount, PAGE_RIGHT - 140, currentY + 11, { align: 'right', width: 126, lineBreak: false });

        currentY += rowHeight + 4;
      });

      // ==========================================
      // 6. ADMIN REMARKS & AUDIT NOTES
      // ==========================================
      const remarksY = currentY + 10;
      doc.roundedRect(PAGE_LEFT, remarksY, CONTENT_WIDTH, 48, 6).fillAndStroke(lightBg, borderColor);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(primaryColor).text('ADMIN REMARKS / SETTLEMENT NOTES:', PAGE_LEFT + 12, remarksY + 8, { lineBreak: false });
      
      const remarksText = payment.remarks || 'Official settlement disbursed as per approved platform payout terms.';
      doc.font('Helvetica').fontSize(8.5).fillColor(secondaryColor).text(remarksText, PAGE_LEFT + 12, remarksY + 22, { width: CONTENT_WIDTH - 24, lineBreak: true });

      // ==========================================
      // 7. SIGNATURE & VERIFICATION STAMP BOX
      // ==========================================
      const signY = remarksY + 62;
      doc.roundedRect(PAGE_LEFT, signY, CONTENT_WIDTH, 65, 8).fillAndStroke('#ffffff', borderColor);

      // Left: Verification Statement
      doc.font('Helvetica-Bold').fontSize(8).fillColor(primaryColor).text('OFFICIAL VERIFICATION & AUDIT COMPLIANCE', PAGE_LEFT + 14, signY + 10, { lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor);
      doc.text('This is a system-generated official payment voucher issued by ZUDO E-Commerce Platform.', PAGE_LEFT + 14, signY + 22, { lineBreak: false });
      doc.text('All calculations are validated against immutable order records, platform commission agreements, and commercial settlement policies.', PAGE_LEFT + 14, signY + 32, { width: 340, lineBreak: true });
      doc.text(`Transaction Reference: ${payment.utrReference || payment.transactionId || 'Direct Bank Settlement'}  |  Audit ID: ${payment._id}`, PAGE_LEFT + 14, signY + 48, { lineBreak: false });

      // Right: Authorized Signature Stamp
      const stampX = PAGE_RIGHT - 150;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(secondaryColor).text('For ZUDO Platform', stampX, signY + 10, { align: 'center', width: 136, lineBreak: false });
      
      // Stamp box
      doc.roundedRect(stampX + 10, signY + 22, 116, 26, 4).fillAndStroke('rgba(79, 70, 229, 0.05)', 'rgba(79, 70, 229, 0.3)');
      doc.font('Helvetica-Bold').fontSize(8).fillColor(primaryColor).text('FINANCE APPROVED', stampX + 10, signY + 30, { align: 'center', width: 116, lineBreak: false });

      doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor).text(`Auth: ${payment.adminName || 'Super Admin'}`, stampX, signY + 52, { align: 'center', width: 136, lineBreak: false });

      // Footer
      doc.font('Helvetica').fontSize(7).fillColor(mutedColor)
        .text('Page 1 of 1  •  ZUDO Merchant Partner Settlement  •  Confidential & Proprietary', PAGE_LEFT, 810, { align: 'center', width: CONTENT_WIDTH });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

module.exports = { generatePaymentReceiptPDF };
