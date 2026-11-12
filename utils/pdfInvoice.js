const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');

/**
 * Generate a professional A4 Seller Invoice PDF with embedded tax invoice image
 * @param {Object} options
 * @param {Object} options.invoice - Invoice document/object
 * @param {Object} options.seller - Seller object
 * @param {Array} options.orders - Array of delivered orders in range
 * @param {Buffer|null} options.imageBuffer - Raw binary image buffer from MongoDB
 * @param {string|null} options.imageMimeType - MIME type of the uploaded image
 * @returns {Promise<Buffer>}
 */
const generateSellerInvoicePDF = async ({ invoice, seller, orders = [], imageBuffer = null, imageMimeType = null }) => {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 36, // 0.5 inch margins for clean professional layout
        size: 'A4',
        bufferPages: true,
        autoFirstPage: true
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      const sellerIdStr = invoice.sellerId ? (invoice.sellerId._id ? invoice.sellerId._id.toString() : invoice.sellerId.toString()) : '';
      const sellerBusiness = seller ? (seller.businessName || seller.storeName || seller.name || 'Seller') : 'Seller';
      const invoiceNumStr = invoice.invoiceNumber || invoice._id.toString().substring(0, 8).toUpperCase();
      const generatedDateStr = new Date(invoice.createdAt || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const startDateStr = new Date(invoice.startDate).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const endDateStr = new Date(invoice.endDate).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

      // Colors
      const primaryColor = '#1e3a8a';   // Deep navy blue
      const secondaryColor = '#0f172a'; // Slate dark
      const mutedColor = '#64748b';     // Muted grey
      const borderColor = '#e2e8f0';    // Light grey border
      const lightBg = '#f8fafc';        // Off-white / light slate card background
      const successColor = '#15803d';    // Forest green

      // ==========================================
      // 1. HEADER SECTION (Logo & Invoice Title)
      // ==========================================
      const logoPath = path.join(__dirname, '../logo.png');
      const hasLogo = fs.existsSync(logoPath);

      if (hasLogo) {
        try {
          doc.image(logoPath, 36, 36, { fit: [120, 48] });
        } catch (e) {
          doc.fontSize(20).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', 36, 40);
        }
      } else {
        doc.fontSize(20).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', 36, 40);
      }

      // Title on right side
      doc.fontSize(22).font('Helvetica-Bold').fillColor(primaryColor).text('SELLER INVOICE', 250, 36, { align: 'right' });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(mutedColor).text(`INVOICE #: `, 250, 64, { align: 'right', continued: true });
      doc.font('Helvetica-Bold').fillColor(secondaryColor).text(`${invoiceNumStr}`);
      doc.fontSize(9).font('Helvetica').fillColor(mutedColor).text(`Generated: ${generatedDateStr}`, 250, 78, { align: 'right' });

      // Horizontal separator line
      doc.strokeColor(borderColor).lineWidth(1).moveTo(36, 96).lineTo(559, 96).stroke();

      // ==========================================
      // 2. COMPANY & SELLER INFORMATION (2 COLUMNS)
      // ==========================================
      const infoTop = 108;
      
      // LEFT COLUMN: Platform Info
      doc.fontSize(9).font('Helvetica-Bold').fillColor(primaryColor).text('FROM (PLATFORM):', 36, infoTop);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(secondaryColor).text('SNB TRADING.CO (ZUDO PLATFORM)', 36, infoTop + 14);
      doc.font('Helvetica').fontSize(9).fillColor(mutedColor);
      doc.text('307 Ashrya Layout, Vishweshwaria 7th Block', 36, infoTop + 28);
      doc.text('Bengaluru, Karnataka - 560091', 36, infoTop + 40);
      doc.font('Helvetica-Bold').fillColor(secondaryColor).text('GSTIN: ', 36, infoTop + 54, { continued: true });
      doc.font('Helvetica').fillColor(mutedColor).text('29BQHPG3242G1ZYNO');

      // RIGHT COLUMN: Seller Info
      const col2Left = 310;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(primaryColor).text('BILL TO (SELLER):', col2Left, infoTop);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(secondaryColor).text(sellerBusiness, col2Left, infoTop + 14);
      doc.font('Helvetica').fontSize(9).fillColor(mutedColor);
      if (seller?.name && seller.name !== sellerBusiness) {
        doc.text(`Contact: ${seller.name}`, col2Left, infoTop + 28);
      }
      doc.text(`Email: ${seller?.email || 'N/A'}`, col2Left, infoTop + 40);
      doc.text(`Phone: ${seller?.phone || 'N/A'}`, col2Left, infoTop + 52);
      if (seller?.gstNumber) {
        doc.font('Helvetica-Bold').fillColor(secondaryColor).text('GSTIN: ', col2Left, infoTop + 64, { continued: true });
        doc.font('Helvetica').fillColor(mutedColor).text(seller.gstNumber);
      }

      // ==========================================
      // 3. INVOICE META GRID (SUMMARY CARD)
      // ==========================================
      const metaBoxY = 190;
      const metaBoxHeight = 44;
      doc.roundedRect(36, metaBoxY, 523, metaBoxHeight, 6).fillAndStroke(lightBg, borderColor);

      const cellWidth = 523 / 4;
      const metaLabels = [
        { label: 'INVOICE NUMBER', val: `#${invoiceNumStr}` },
        { label: 'BILLING PERIOD', val: `${startDateStr} - ${endDateStr}` },
        { label: 'SETTLEMENT STATUS', val: (invoice.status || 'Pending').toUpperCase() },
        { label: 'TOTAL ORDERS', val: `${invoice.orderCount || orders.length || 0} Orders` }
      ];

      metaLabels.forEach((item, i) => {
        const xPos = 36 + (i * cellWidth) + 10;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(mutedColor).text(item.label, xPos, metaBoxY + 8);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(
          item.label.includes('STATUS') ? (item.val === 'CLEARED' ? successColor : '#d97706') : secondaryColor
        ).text(item.val, xPos, metaBoxY + 22);
      });

      // ==========================================
      // 4. ORDER BREAKDOWN TABLE
      // ==========================================
      doc.y = metaBoxY + metaBoxHeight + 16;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(secondaryColor).text('Order Breakdown & Commission Details', 36, doc.y);
      doc.moveDown(0.6);

      let serialNo = 1;
      const tableRows = [];

      orders.forEach(order => {
        const orderIdShort = order.orderId || order._id.toString().slice(-6).toUpperCase();
        const orderDateStr = new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const customerName = order.userId?.name || 'Customer';

        // Filter seller's specific items
        const sellerItems = (order.items || []).filter(item => {
          const mSellerId = item.seller && item.seller.sellerId && item.seller.sellerId.toString() === sellerIdStr;
          const mProductRef = item.productId && item.productId.sellerId && item.productId.sellerId.toString() === sellerIdStr;
          const mName = item.sellerName && seller?.name && item.sellerName.toLowerCase() === seller.name.toLowerCase();
          const mStore = item.sellerName && seller?.storeName && item.sellerName.toLowerCase() === seller.storeName.toLowerCase();
          const mBusiness = item.sellerName && seller?.businessName && item.sellerName.toLowerCase() === seller.businessName.toLowerCase();
          return mSellerId || mProductRef || mName || mStore || mBusiness;
        });

        const activeItems = sellerItems.length > 0 ? sellerItems : (order.items || []);
        
        let orderTotalSellerAmount = 0;
        let orderTotalCommission = 0;
        const productSummaries = [];

        activeItems.forEach(item => {
          if (item.returnStatus !== 'Returned to Seller') {
            const qty = Number(item.quantity) || 1;
            const itemCommission = Number(item.totalCommission) || ((Number(item.unitCommission) || 0) * qty) || 0;
            const itemSellerPrice = (Number(item.sellerUnitPrice) || Number(item.normalPrice) || Number(item.price) || 0) * qty;
            
            orderTotalSellerAmount += itemSellerPrice;
            orderTotalCommission += itemCommission;
            productSummaries.push(`${item.name || 'Product'} (x${qty})`);
          }
        });

        const netPayout = orderTotalSellerAmount;
        const productDesc = productSummaries.slice(0, 2).join(', ') + (productSummaries.length > 2 ? ` +${productSummaries.length - 2} more` : '');

        tableRows.push([
          String(serialNo++),
          `#${orderIdShort}`,
          orderDateStr,
          customerName,
          productDesc || 'Order Items',
          `Rs. ${orderTotalSellerAmount.toFixed(2)}`,
          `Rs. ${orderTotalCommission.toFixed(2)}`,
          `Rs. ${netPayout.toFixed(2)}`
        ]);
      });

      if (tableRows.length === 0) {
        tableRows.push(['1', `#${invoiceNumStr}`, startDateStr, 'Bulk Delivery', 'Delivered Batch Items', `Rs. ${Number(invoice.totalAmount || 0).toFixed(2)}`, `Rs. ${Number(invoice.totalCommission || 0).toFixed(2)}`, `Rs. ${Number(invoice.netAmount || invoice.totalAmount || 0).toFixed(2)}`]);
      }

      const tableData = {
        headers: [
          "S.No",
          "Order ID",
          "Date",
          "Customer",
          "Product Details",
          "Order Amount",
          "Commission",
          "Net Payout"
        ],
        rows: tableRows
      };

      await doc.table(tableData, {
        width: 523,
        x: 36,
        divider: {
          header: { disabled: false, width: 1, opacity: 0.8 },
          horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
        },
        prepareHeader: () => doc.font("Helvetica-Bold").fontSize(8).fillColor(secondaryColor),
        prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
          doc.font("Helvetica").fontSize(8).fillColor('#334155');
        },
        columnsSize: [28, 56, 52, 70, 145, 60, 56, 56]
      });

      // ==========================================
      // 5. FINANCIAL SUMMARY TOTALS CARD
      // ==========================================
      doc.moveDown(1.5);
      const summaryBoxY = doc.y;

      // Check page break for summary box
      if (summaryBoxY + 110 > doc.page.height - 40) {
        doc.addPage();
      }

      const currentSumY = doc.y;
      const sumWidth = 240;
      const sumX = 559 - sumWidth; // Right aligned
      doc.roundedRect(sumX, currentSumY, sumWidth, 90, 6).fillAndStroke(lightBg, borderColor);

      const totAmount = Number(invoice.totalAmount || 0);
      const totCommission = Number(invoice.totalCommission || 0);
      const totNet = Number(invoice.netAmount || totAmount);

      doc.font('Helvetica').fontSize(9).fillColor(mutedColor).text('Total Order Amount:', sumX + 12, currentSumY + 12);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(secondaryColor).text(`Rs. ${totAmount.toFixed(2)}`, sumX + 130, currentSumY + 12, { align: 'right', width: 95 });

      doc.font('Helvetica').fontSize(9).fillColor(mutedColor).text('Total Platform Commission:', sumX + 12, currentSumY + 30);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(secondaryColor).text(`Rs. ${totCommission.toFixed(2)}`, sumX + 130, currentSumY + 30, { align: 'right', width: 95 });

      doc.strokeColor(borderColor).lineWidth(0.8).moveTo(sumX + 10, currentSumY + 48).lineTo(sumX + sumWidth - 10, currentSumY + 48).stroke();

      doc.font('Helvetica-Bold').fontSize(11).fillColor(successColor).text('Net Payout to Seller:', sumX + 12, currentSumY + 60);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(successColor).text(`Rs. ${totNet.toFixed(2)}`, sumX + 120, currentSumY + 60, { align: 'right', width: 105 });

      // Note on left side of summary
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(secondaryColor).text('Terms & Remarks:', 36, currentSumY + 10);
      doc.font('Helvetica').fontSize(8).fillColor(mutedColor).text(
        '1. This invoice reflects verified order deliveries and corresponding seller wholesale payouts.\n' +
        '2. Payments are cleared sequentially as per platform settlement schedules.\n' +
        '3. For any discrepancies or tax inquiries, reach out to support@snbtradingco.in.',
        36, currentSumY + 24, { width: 260, lineGap: 3 }
      );

      // ==========================================
      // 6. SELLER UPLOADED TAX INVOICE IMAGE
      // ==========================================
      // Always present the attached tax invoice image on a dedicated clean section/page
      if (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
        doc.addPage(); // Start fresh page for the uploaded image

        doc.fontSize(16).font('Helvetica-Bold').fillColor(primaryColor).text('Seller Uploaded Tax Invoice', 36, 40);
        doc.fontSize(9).font('Helvetica').fillColor(mutedColor).text(
          `Attached signed tax invoice copy for Invoice #${invoiceNumStr} (${(imageBuffer.length / 1024).toFixed(1)} KB)`,
          36, 60
        );

        doc.strokeColor(borderColor).lineWidth(1).moveTo(36, 76).lineTo(559, 76).stroke();

        try {
          // Embed the buffer directly into the PDF with aspect ratio preservation
          const maxImgWidth = 523;
          const maxImgHeight = 680;
          const imgY = 90;

          // Box container around the image
          doc.roundedRect(36, imgY, maxImgWidth, maxImgHeight, 8).fillAndStroke('#ffffff', borderColor);

          // Center the image within container
          doc.image(imageBuffer, 46, imgY + 10, {
            fit: [maxImgWidth - 20, maxImgHeight - 20],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          console.error('Error embedding image in PDF:', imgErr.message);
          doc.font('Helvetica-Oblique').fontSize(10).fillColor('#ef4444').text(
            `Unable to render the uploaded invoice image format: ${imgErr.message}`,
            36, 120
          );
        }
      }

      // ==========================================
      // 7. FOOTER PAGE NUMBERS (All Pages)
      // ==========================================
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.strokeColor(borderColor).lineWidth(0.5).moveTo(36, doc.page.height - 30).lineTo(559, doc.page.height - 30).stroke();
        doc.font('Helvetica').fontSize(8).fillColor(mutedColor).text(
          `SNB TRADING.CO (ZUDO PLATFORM)  •  Invoice #${invoiceNumStr}`,
          36, doc.page.height - 22
        );
        doc.text(
          `Page ${i + 1} of ${pages.count}`,
          250, doc.page.height - 22,
          { align: 'right', width: 309 }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = { generateSellerInvoicePDF };

