const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('sharp not available for image conversion:', e.message);
}

/**
 * Helper to convert image buffer (including WebP) to PNG if needed for pdfkit
 */
const prepareImageForPDF = async (buffer, mimeType) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const isWebP = (
    (mimeType && mimeType.toLowerCase().includes('webp')) ||
    (buffer.length > 12 &&
     buffer.toString('ascii', 0, 4) === 'RIFF' &&
     buffer.toString('ascii', 8, 12) === 'WEBP')
  );
  if (isWebP && sharp) {
    try {
      return await sharp(buffer).png().toBuffer();
    } catch (convErr) {
      console.warn('WebP conversion fallback:', convErr.message);
      return buffer;
    }
  }
  return buffer;
};

/**
 * Generate a professional Seller Invoice PDF with sequential images on exact A4 pages:
 * - 1 image -> exactly 1 page
 * - 3 images -> exactly 3 pages
 * - 5 images -> exactly 5 pages
 * - Each image occupies its own properly sized page in exact sequential order (Image 1 -> Page 1, Image 2 -> Page 2...).
 * - Uses object-fit contain logic without stretching, distortion, or unwanted empty pages.
 *
 * @param {Object} options
 * @param {Object} options.invoice - Invoice document/object
 * @param {Object} options.seller - Seller object
 * @param {Array} options.orders - Array of delivered orders in range
 * @param {Buffer|null} options.imageBuffer - Primary image buffer (fallback)
 * @param {string|null} options.imageMimeType - MIME type of the uploaded image
 * @param {Array} options.images - Array of { data: Buffer, mimeType: String, filename: String }
 * @returns {Promise<Buffer>}
 */
const generateSellerInvoicePDF = async ({
  invoice,
  seller,
  orders = [],
  imageBuffer = null,
  imageMimeType = null,
  images = []
}) => {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Consolidate and preserve exact upload order of images
      const imageList = [];
      if (Array.isArray(images) && images.length > 0) {
        images.forEach(img => {
          const buf = img.data || img.imageData;
          if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
            imageList.push({
              buffer: buf,
              mimeType: img.mimeType || img.contentType || 'image/jpeg',
              filename: img.filename || img.originalName || 'Invoice Image'
            });
          }
        });
      } else if (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
        imageList.push({
          buffer: imageBuffer,
          mimeType: imageMimeType || 'image/jpeg',
          filename: 'Invoice Image'
        });
      }

      // 2. Pre-process images (WebP to PNG conversion if needed)
      const processedImages = [];
      for (const item of imageList) {
        try {
          const prepBuf = await prepareImageForPDF(item.buffer, item.mimeType);
          if (prepBuf) {
            processedImages.push({
              buffer: prepBuf,
              filename: item.filename
            });
          }
        } catch (e) {
          console.warn('Failed to prepare image for PDF:', e.message);
        }
      }

      // Total pages = max(1, processedImages.length)
      const totalPages = Math.max(1, processedImages.length);

      // Create PDFKit document with bottom margin 0 to eliminate auto-paging overflow
      const doc = new PDFDocument({
        margin: 24,
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
      const invoiceNumStr = invoice.orderNumber
        ? String(invoice.orderNumber).padStart(5, '0')
        : (invoice.invoiceNumber || (invoice._id ? invoice._id.toString().substring(0, 8).toUpperCase() : 'INV-001'));
      const generatedDateStr = new Date(invoice.createdAt || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const startDateStr = new Date(invoice.startDate || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const endDateStr = new Date(invoice.endDate || Date.now()).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });

      // Colors
      const primaryColor = '#1e3a8a';   // Deep navy blue
      const secondaryColor = '#0f172a'; // Slate dark
      const mutedColor = '#64748b';     // Muted grey
      const borderColor = '#cbd5e1';    // Slate border
      const lightBg = '#f8fafc';        // Off-white / light slate card background
      const successColor = '#15803d';    // Forest green

      const PAGE_LEFT = 24;
      const PAGE_RIGHT = 571;
      const CONTENT_WIDTH = PAGE_RIGHT - PAGE_LEFT; // 547pt
      const FOOTER_LINE_Y = 800;
      const FOOTER_TEXT_Y = 806;

      // ==========================================
      // PAGE 1: INVOICE DETAILS + IMAGE 1 (or placeholder)
      // ==========================================

      // 1. Header
      const logoPath = path.join(__dirname, '../logo.png');
      const hasLogo = fs.existsSync(logoPath);
      if (hasLogo) {
        try {
          doc.image(logoPath, PAGE_LEFT, 24, { fit: [100, 36] });
        } catch (e) {
          doc.fontSize(18).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', PAGE_LEFT, 24, { lineBreak: false });
        }
      } else {
        doc.fontSize(18).font('Helvetica-Bold').fillColor(primaryColor).text('ZUDO', PAGE_LEFT, 24, { lineBreak: false });
      }

      doc.fontSize(18).font('Helvetica-Bold').fillColor(primaryColor).text('SELLER INVOICE', 300, 20, { align: 'right', width: 271, lineBreak: false });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(secondaryColor).text(`INVOICE #${invoiceNumStr}`, 300, 42, { align: 'right', width: 271, lineBreak: false });
      doc.fontSize(8).font('Helvetica').fillColor(mutedColor).text(`Generated: ${generatedDateStr}`, 300, 56, { align: 'right', width: 271, lineBreak: false });

      doc.strokeColor(borderColor).lineWidth(1).moveTo(PAGE_LEFT, 72).lineTo(PAGE_RIGHT, 72).stroke();

      // 2. Company & Seller Details
      const infoY = 78;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(primaryColor).text('FROM (PLATFORM):', PAGE_LEFT, infoY, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(secondaryColor).text('SNB TRADING.CO (ZUDO PLATFORM)', PAGE_LEFT, infoY + 11, { lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor);
      doc.text('307 Ashrya Layout, Vishweshwaria 7th Block, Bengaluru, KA - 560091', PAGE_LEFT, infoY + 22, { lineBreak: false });
      doc.font('Helvetica-Bold').fillColor(secondaryColor).text('GSTIN: ', PAGE_LEFT, infoY + 32, { continued: true, lineBreak: false });
      doc.font('Helvetica').fillColor(mutedColor).text('29BQHPG3242G1ZYNO', { lineBreak: false });

      const col2Left = 320;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(primaryColor).text('BILL TO (SELLER):', col2Left, infoY, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(secondaryColor).text(sellerBusiness, col2Left, infoY + 11, { width: 251, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor);
      
      let sellerDetailsStr = '';
      if (seller?.name && seller.name !== sellerBusiness) {
        sellerDetailsStr += `Contact: ${seller.name}  •  `;
      }
      sellerDetailsStr += `Email: ${seller?.email || 'N/A'}`;
      doc.text(sellerDetailsStr, col2Left, infoY + 22, { width: 251, lineBreak: false });

      let sellerSubStr = `Phone: ${seller?.phone || 'N/A'}`;
      if (seller?.gstNumber) {
        sellerSubStr += `  •  GSTIN: ${seller.gstNumber}`;
      }
      doc.text(sellerSubStr, col2Left, infoY + 32, { width: 251, lineBreak: false });

      // 3. Invoice Meta Strip
      const metaBoxY = 126;
      const metaBoxHeight = 30;
      doc.roundedRect(PAGE_LEFT, metaBoxY, CONTENT_WIDTH, metaBoxHeight, 4).fillAndStroke(lightBg, borderColor);

      const cellWidth = CONTENT_WIDTH / 4;
      const metaLabels = [
        { label: 'ORDER / INVOICE REFERENCE', val: `#${invoiceNumStr}` },
        { label: 'BILLING PERIOD', val: `${startDateStr} - ${endDateStr}` },
        { label: 'SETTLEMENT STATUS', val: (invoice.status || 'Pending').toUpperCase() },
        { label: 'TOTAL ORDERS', val: `${invoice.orderCount || orders.length || 0} Orders` }
      ];

      metaLabels.forEach((item, i) => {
        const xPos = PAGE_LEFT + (i * cellWidth) + 8;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(mutedColor).text(item.label, xPos, metaBoxY + 5, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(
          item.label.includes('STATUS') ? (item.val === 'CLEARED' ? successColor : '#d97706') : secondaryColor
        ).text(item.val, xPos, metaBoxY + 16, { lineBreak: false });
      });

      // 4. Order Breakdown Table
      const tableStartY = 163;
      doc.y = tableStartY;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(secondaryColor).text('Order Breakdown & Commission Details', PAGE_LEFT, tableStartY, { lineBreak: false });

      let serialNo = 1;
      const tableRows = [];

      orders.forEach(order => {
        const orderIdShort = order.orderNumber
          ? String(order.orderNumber).padStart(5, '0')
          : (order.orderId || order.orderRef || (order._id ? order._id.toString().slice(-6).toUpperCase() : 'ORD'));
        const orderDateStr = new Date(order.createdAt || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const customerName = order.userId?.name || 'Customer';

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
            productSummaries.push(`${item.name || 'Item'} (x${qty})`);
          }
        });

        const netPayout = orderTotalSellerAmount;
        const productDesc = productSummaries.slice(0, 2).join(', ') + (productSummaries.length > 2 ? ` +${productSummaries.length - 2}` : '');

        tableRows.push([
          String(serialNo++),
          `#${orderIdShort}`,
          orderDateStr,
          customerName.length > 18 ? customerName.substring(0, 17) + '…' : customerName,
          productDesc.length > 38 ? productDesc.substring(0, 36) + '…' : (productDesc || 'Order Items'),
          `Rs. ${orderTotalSellerAmount.toFixed(2)}`,
          `Rs. ${netPayout.toFixed(2)}`
        ]);
      });

      if (tableRows.length === 0) {
        tableRows.push(['1', `#${invoiceNumStr}`, startDateStr, 'Bulk Delivery', 'Delivered Batch Items', `Rs. ${Number(invoice.totalAmount || 0).toFixed(2)}`, `Rs. ${Number(invoice.netAmount || invoice.totalAmount || 0).toFixed(2)}`]);
      }

      // Bound rows to 5 so summary and image fit perfectly on page 1
      const maxDisplayRows = 5;
      let displayRows = tableRows;
      let extraOrdersCount = 0;
      if (tableRows.length > maxDisplayRows) {
        displayRows = tableRows.slice(0, maxDisplayRows);
        extraOrdersCount = tableRows.length - maxDisplayRows;
      }

      const tableData = {
        headers: [
          "S.No",
          "Order ID",
          "Date",
          "Customer",
          "Product Details",
          "Order Amount",
          "Net Payout"
        ],
        rows: displayRows
      };

      doc.y = tableStartY + 14;
      await doc.table(tableData, {
        width: CONTENT_WIDTH,
        x: PAGE_LEFT,
        divider: {
          header: { disabled: false, width: 0.8, opacity: 0.8 },
          horizontal: { disabled: false, width: 0.4, opacity: 0.3 }
        },
        padding: [3, 4],
        prepareHeader: () => doc.font("Helvetica-Bold").fontSize(7).fillColor(secondaryColor),
        prepareRow: () => doc.font("Helvetica").fontSize(7).fillColor('#334155'),
        columnsSize: [30, 60, 55, 95, 177, 65, 65]
      });

      if (extraOrdersCount > 0) {
        doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(mutedColor).text(
          `+ ${extraOrdersCount} more order(s) included in total billing summary.`,
          PAGE_LEFT,
          doc.y + 2,
          { lineBreak: false }
        );
        doc.y += 10;
      }

      // 5. Payment Summary & Terms (Side-by-Side)
      const summaryY = Math.max(doc.y + 8, 255);
      const summaryCardHeight = 56;

      const termsWidth = 270;
      doc.roundedRect(PAGE_LEFT, summaryY, termsWidth, summaryCardHeight, 4).fillAndStroke(lightBg, borderColor);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(secondaryColor).text('Terms & Conditions:', PAGE_LEFT + 8, summaryY + 6, { lineBreak: false });
      doc.font('Helvetica').fontSize(6.5).fillColor(mutedColor).text(
        '1. Reflects verified deliveries and agreed wholesale seller payout.\n' +
        '2. Payments cleared sequentially per platform settlement schedule.\n' +
        '3. For tax & invoice discrepancies, email support@snbtradingco.in.',
        PAGE_LEFT + 8,
        summaryY + 17,
        { width: termsWidth - 16, lineGap: 1.5, lineBreak: false }
      );

      const sumWidth = 265;
      const sumX = PAGE_RIGHT - sumWidth;
      doc.roundedRect(sumX, summaryY, sumWidth, summaryCardHeight, 4).fillAndStroke(lightBg, borderColor);

      const totAmount = Number(invoice.totalAmount || 0);
      const totNet = Number(invoice.netAmount || totAmount);

      doc.font('Helvetica').fontSize(7.5).fillColor(mutedColor).text('Total Order Amount:', sumX + 8, summaryY + 8, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(secondaryColor).text(`Rs. ${totAmount.toFixed(2)}`, sumX + 130, summaryY + 8, { align: 'right', width: sumWidth - 140, lineBreak: false });

      doc.strokeColor(borderColor).lineWidth(0.6).moveTo(sumX + 8, summaryY + 24).lineTo(sumX + sumWidth - 8, summaryY + 24).stroke();

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(successColor).text('Net Payout to Seller:', sumX + 8, summaryY + 33, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(successColor).text(`Rs. ${totNet.toFixed(2)}`, sumX + 110, summaryY + 32, { align: 'right', width: sumWidth - 120, lineBreak: false });

      // 6. Page 1 Image Section (Only rendered if images exist)
      let page1FooterLineY = FOOTER_LINE_Y;
      let page1FooterTextY = FOOTER_TEXT_Y;

      if (processedImages && processedImages.length > 0) {
        const imageSectionTop = summaryY + summaryCardHeight + 8;
        const availableImageAreaHeight = FOOTER_LINE_Y - imageSectionTop - 24;

        const page1Label = processedImages.length > 1
          ? `Seller Uploaded Tax Invoice Copy (1 of ${totalPages})`
          : 'Seller Uploaded Tax Invoice Copy';

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(primaryColor).text(
          page1Label,
          PAGE_LEFT,
          imageSectionTop,
          { lineBreak: false }
        );

        const imgBoxY = imageSectionTop + 14;
        const imgBoxHeight = Math.max(availableImageAreaHeight, 180);

        doc.roundedRect(PAGE_LEFT, imgBoxY, CONTENT_WIDTH, imgBoxHeight, 4).fillAndStroke('#ffffff', borderColor);

        try {
          doc.image(processedImages[0].buffer, PAGE_LEFT + 6, imgBoxY + 6, {
            fit: [CONTENT_WIDTH - 12, imgBoxHeight - 12],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor('#ef4444').text(
            `Unable to render image 1: ${imgErr.message}`,
            PAGE_LEFT + 12,
            imgBoxY + 20,
            { lineBreak: false }
          );
        }
      } else {
        // When no images exist, pull the footer upward smoothly below the summary section
        page1FooterLineY = summaryY + summaryCardHeight + 20;
        page1FooterTextY = page1FooterLineY + 6;
      }

      // Page 1 Footer (Carefully positioned to stay within margins)
      doc.strokeColor(borderColor).lineWidth(0.5).moveTo(PAGE_LEFT, page1FooterLineY).lineTo(PAGE_RIGHT, page1FooterLineY).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(mutedColor).text(
        `SNB TRADING.CO (ZUDO PLATFORM)  •  Invoice #${invoiceNumStr}  •  Settlement Verification`,
        PAGE_LEFT,
        page1FooterTextY,
        { lineBreak: false }
      );
      doc.font('Helvetica').fontSize(7).fillColor(mutedColor).text(
        `Page 1 of ${totalPages}`,
        300,
        page1FooterTextY,
        { align: 'right', width: 271, lineBreak: false }
      );

      // ==========================================
      // SUBSEQUENT PAGES: IMAGES 2..N (Exact 1 page per image)
      // ==========================================
      for (let idx = 1; idx < processedImages.length; idx++) {
        doc.addPage({ margin: 24, size: 'A4' });
        const currPage = idx + 1;

        // Header Strip on Image Page
        doc.fontSize(12).font('Helvetica-Bold').fillColor(primaryColor).text('SELLER INVOICE - ATTACHED DOCUMENT', PAGE_LEFT, 24, { lineBreak: false });
        doc.fontSize(9).font('Helvetica-Bold').fillColor(secondaryColor).text(`INVOICE #${invoiceNumStr}  •  Image ${currPage} of ${totalPages}`, 300, 26, { align: 'right', width: 271, lineBreak: false });
        doc.strokeColor(borderColor).lineWidth(1).moveTo(PAGE_LEFT, 46).lineTo(PAGE_RIGHT, 46).stroke();

        const imgMetaTitle = processedImages[idx].filename || `Supporting Document ${currPage}`;
        doc.fontSize(9).font('Helvetica-Bold').fillColor(secondaryColor).text(
          `Document #${currPage}: ${imgMetaTitle}`,
          PAGE_LEFT,
          56,
          { lineBreak: false }
        );

        // Full Page Image Container (Calculated precisely to avoid pushing past bottom margin)
        const fullImgY = 72;
        const fullImgHeight = FOOTER_LINE_Y - fullImgY - 10;
        doc.roundedRect(PAGE_LEFT, fullImgY, CONTENT_WIDTH, fullImgHeight, 4).fillAndStroke('#ffffff', borderColor);

        try {
          doc.image(processedImages[idx].buffer, PAGE_LEFT + 6, fullImgY + 6, {
            fit: [CONTENT_WIDTH - 12, fullImgHeight - 12],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor('#ef4444').text(
            `Unable to render image ${currPage}: ${imgErr.message}`,
            PAGE_LEFT + 12,
            fullImgY + 20,
            { lineBreak: false }
          );
        }

        // Page Footer
        doc.strokeColor(borderColor).lineWidth(0.5).moveTo(PAGE_LEFT, FOOTER_LINE_Y).lineTo(PAGE_RIGHT, FOOTER_LINE_Y).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(mutedColor).text(
          `SNB TRADING.CO (ZUDO PLATFORM)  •  Invoice #${invoiceNumStr}  •  Settlement Verification`,
          PAGE_LEFT,
          FOOTER_TEXT_Y,
          { lineBreak: false }
        );
        doc.font('Helvetica').fontSize(7).fillColor(mutedColor).text(
          `Page ${currPage} of ${totalPages}`,
          300,
          FOOTER_TEXT_Y,
          { align: 'right', width: 271, lineBreak: false }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = { generateSellerInvoicePDF };
