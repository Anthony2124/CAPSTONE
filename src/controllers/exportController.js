const PDFDocument = require('pdfkit');
const { readDB } = require('../data/database');

exports.exportBillingPdf = (req, res) => {
  const db = readDB();
  const patientId = parseInt(req.params.id);
  const patient = db.patients.find(p => p.patient_id === patientId);
  const billing = db.billing_ledger.find(b => b.patient_id === patientId && b.status === 'active');

  if (!patient || !billing) {
    return res.status(404).json({ error: 'Patient or active ledger not found.' });
  }

  // Calculate totals
  const items = billing.items || [];
  const totalCharges = items.reduce((sum, item) => sum + item.amount, 0);
  const philhealth = billing.philhealth_deduction || 0;
  const discount = billing.statutory_discount || 0;
  const netAmount = totalCharges - philhealth - discount;

  // Create PDF
  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-disposition', `attachment; filename=Billing_Statement_${patientId}.pdf`);
  res.setHeader('Content-type', 'application/pdf');

  doc.pipe(res);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('AURORA MEMORIAL HOSPITAL', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text('D.I.E.T.S. Ecosystem Billing Statement', { align: 'center' });
  doc.moveDown(2);

  // Patient Info
  doc.fontSize(14).font('Helvetica-Bold').text('Patient Information');
  doc.fontSize(10).font('Helvetica');
  doc.text(`Name: ${patient.first_name} ${patient.last_name}`);
  doc.text(`Patient ID: ${patient.patient_id}`);
  doc.text(`Date: ${new Date().toLocaleDateString()}`);
  doc.moveDown();

  // Ledger Items
  doc.fontSize(14).font('Helvetica-Bold').text('Charges');
  doc.moveDown(0.5);
  
  items.forEach(item => {
    const dateStr = item.date ? `${item.date.split('T')[0]} - ` : '';
    doc.fontSize(10).font('Helvetica')
       .text(`${dateStr}[${item.category}] ${item.description}`, { continued: true })
       .text(`PHP ${item.amount.toFixed(2)}`, { align: 'right' });
  });

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Summary
  doc.fontSize(12).font('Helvetica-Bold')
     .text('Gross Total:', { continued: true })
     .text(`PHP ${totalCharges.toFixed(2)}`, { align: 'right' });

  if (philhealth > 0) {
    doc.font('Helvetica')
       .text('PhilHealth Deduction:', { continued: true })
       .text(`- PHP ${philhealth.toFixed(2)}`, { align: 'right' });
  }

  if (discount > 0) {
    doc.font('Helvetica')
       .text('Senior/PWD Discount:', { continued: true })
       .text(`- PHP ${discount.toFixed(2)}`, { align: 'right' });
  }

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  doc.fontSize(14).font('Helvetica-Bold')
     .text('Net Amount Due:', { continued: true })
     .text(`PHP ${netAmount.toFixed(2)}`, { align: 'right' });

  // Footer
  doc.moveDown(4);
  doc.fontSize(10).font('Helvetica-Oblique').text('Thank you for trusting Aurora Memorial Hospital.', { align: 'center' });

  doc.end();
};
