require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { Resend } = require('resend');
const app = express();
app.use(cors({ origin: 'https://lionandlambpublishing.com' }));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const pool = new Pool({
  user: 'forteadmin',
  host: 'localhost',
  database: 'fortemusic',
  password: process.env.DB_PASSWORD,
  port: 5432,
});

const s3 = new S3Client({
  endpoint: 'https://' + process.env.SPACES_REGION + '.digitaloceanspaces.com',
  region: process.env.SPACES_REGION,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
});

const BUCKET = process.env.SPACES_BUCKET;
const SPACES_BASE = 'https://' + BUCKET + '.' + process.env.SPACES_REGION + '.digitaloceanspaces.com';

// List files in Spaces
app.get('/admin/files', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const prefix = req.query.prefix || '';
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 200 });
    const result = await s3.send(cmd);
    const files = (result.Contents || []).map(f => ({
      key: f.Key,
      url: SPACES_BASE + '/' + f.Key,
      size: f.Size,
      lastModified: f.LastModified,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get presigned upload URL
app.post('/admin/upload-url', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { filename, contentType, folder } = req.body;
    const key = (folder ? folder + '/' : '') + filename;
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ACL: 'public-read' });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    res.json({ uploadUrl: url, publicUrl: SPACES_BASE + '/' + key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get featured product
app.get('/products/featured', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE featured=TRUE ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) {
      const fallback = await pool.query('SELECT * FROM products ORDER BY created_at DESC LIMIT 1');
      res.json(fallback.rows[0] || null);
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all products
app.get('/products', async (req, res) => {
  try {
    const { ensemble, grade, search } = req.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (ensemble) { params.push(ensemble); query += ' AND ensemble=$' + params.length; }
    if (grade) { params.push(grade); query += ' AND grade=$' + params.length; }
    if (search) { params.push('%' + search + '%'); query += ' AND (title ILIKE $' + params.length + ' OR composer ILIKE $' + params.length + ')'; }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single product
app.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: add product
// Auto-create Stripe Price IDs for a product
async function syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, existingIds) {
  const ids = existingIds || {};
  let stripeProductId = ids.stripe_product_id;
  if (!stripeProductId) {
    const sp = await stripe.products.create({
      name: title + (composer ? ' — ' + composer : ''),
      metadata: { source: 'lionandlambpublishing' }
    });
    stripeProductId = sp.id;
  }
  async function makePrice(amount, nickname, existing) {
    if (!amount || parseFloat(amount) <= 0) return existing || '';
    if (existing) {
      try {
        const p = await stripe.prices.retrieve(existing);
        if (p.unit_amount === Math.round(parseFloat(amount) * 100)) return existing;
      } catch(e) {}
    }
    const p = await stripe.prices.create({
      product: stripeProductId,
      unit_amount: Math.round(parseFloat(amount) * 100),
      currency: 'usd',
      nickname: nickname
    });
    return p.id;
  }
  const results = await Promise.all([
    makePrice(price_print, 'Print', ids.stripe_price_print),
    makePrice(price_pdf, 'PDF', ids.stripe_price_pdf),
    makePrice(price_bundle, 'Bundle', ids.stripe_price_bundle)
  ]);
  return { stripe_product_id: stripeProductId, stripe_price_print: results[0], stripe_price_pdf: results[1], stripe_price_bundle: results[2] };
}

app.post('/admin/products', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured } = req.body;
    const stripeIds = await syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, {});
    const result = await pool.query(
      'INSERT INTO products (title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_product_id, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripeIds.stripe_product_id, stripeIds.stripe_price_print, stripeIds.stripe_price_pdf, stripeIds.stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url||null, featured||false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update product
app.put('/admin/products/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured } = req.body;
    const existing = await pool.query('SELECT stripe_product_id, stripe_price_print, stripe_price_pdf, stripe_price_bundle FROM products WHERE id=$1', [req.params.id]);
    const existingIds = existing.rows[0] || {};
    const stripeIds = await syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, existingIds);
    const result = await pool.query(
      'UPDATE products SET title=$1, composer=$2, ensemble=$3, grade=$4, format=$5, price_print=$6, price_pdf=$7, price_bundle=$8, stripe_product_id=$9, stripe_price_print=$10, stripe_price_pdf=$11, stripe_price_bundle=$12, audio_url=$13, pdf_preview_url=$14, image_url=$15, video_url=$16, download_url=$17, featured=$18 WHERE id=$19 RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripeIds.stripe_product_id, stripeIds.stripe_price_print, stripeIds.stripe_price_pdf, stripeIds.stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url||null, featured||false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete product
app.delete('/admin/products/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// List coupons + promo codes
app.get('/admin/coupons', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [coupons, promos] = await Promise.all([
      stripe.coupons.list({ limit: 50 }),
      stripe.promotionCodes.list({ limit: 50 })
    ]);
    const couponMap = {};
    coupons.data.forEach(c => { couponMap[c.id] = c; });
    const result = promos.data.map(p => ({
      promo_id: p.id,
      code: p.code,
      active: p.active,
      times_redeemed: p.times_redeemed,
      max_redemptions: p.max_redemptions,
      coupon_id: p.coupon.id,
      discount: p.coupon.percent_off ? p.coupon.percent_off + '%' : '$' + (p.coupon.amount_off / 100).toFixed(2),
      duration: p.coupon.duration,
      expires_at: p.expires_at
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create coupon + promo code
app.post('/admin/coupons', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { code, percent_off, amount_off, max_redemptions, expires_at } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    if (!percent_off && !amount_off) return res.status(400).json({ error: 'Provide percent_off or amount_off' });
    const couponData = { duration: 'once' };
    if (percent_off) couponData.percent_off = parseFloat(percent_off);
    else couponData.amount_off = Math.round(parseFloat(amount_off) * 100), couponData.currency = 'usd';
    const coupon = await stripe.coupons.create(couponData);
    const promoData = { coupon: coupon.id, code: code.toUpperCase() };
    if (max_redemptions) promoData.max_redemptions = parseInt(max_redemptions);
    if (expires_at) promoData.expires_at = Math.floor(new Date(expires_at).getTime() / 1000);
    const promo = await stripe.promotionCodes.create(promoData);
    res.json({ promo_id: promo.id, code: promo.code, discount: percent_off ? percent_off + '%' : '$' + amount_off, active: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deactivate promo code
app.delete('/admin/coupons/:promo_id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await stripe.promotionCodes.update(req.params.promo_id, { active: false });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ---- SCHOOL ACCOUNTS ----

// School applies for an account
app.post('/school-apply', async (req, res) => {
  try {
    const { school_name, director_name, email, phone, address, city, state, zip, district, po_contact_name, po_contact_email } = req.body;
    if (!school_name || !director_name || !email) return res.status(400).json({ error: 'School name, director name, and email are required.' });

    // Check if already applied
    const existing = await pool.query('SELECT id, status FROM school_accounts WHERE email=$1', [email]);
    if (existing.rows.length > 0) {
      const s = existing.rows[0].status;
      if (s === 'approved') return res.status(400).json({ error: 'This email is already approved. Check your inbox for your account code.' });
      if (s === 'pending') return res.status(400).json({ error: 'An application for this email is already under review.' });
    }

    const result = await pool.query(
      'INSERT INTO school_accounts (school_name, director_name, email, phone, address, city, state, zip, district, po_contact_name, po_contact_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [school_name, director_name, email, phone||'', address||'', city||'', state||'', zip||'', district||'', po_contact_name||'', po_contact_email||'']
    );

    // Notify admin
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: process.env.SMTP_USER || process.env.EMAIL_FROM || 'orders@lionandlambpublishing.com',
        subject: 'New School Account Application — ' + school_name,
        html: '<h2>New School Application</h2><p><strong>School:</strong> ' + school_name + '</p><p><strong>Director:</strong> ' + director_name + '</p><p><strong>Email:</strong> ' + email + '</p><p><strong>District:</strong> ' + (district||'N/A') + '</p><p><a href="https://lionandlambpublishing.com/admin.html">Review in Admin Panel</a></p>'
      });
    } catch(e) { console.error('Admin notify error:', e.message); }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List school accounts (admin)
app.get('/admin/schools', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query('SELECT * FROM school_accounts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve school
app.post('/admin/schools/:id/approve', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const code = 'LAL-' + Math.random().toString(36).substring(2,6).toUpperCase() + '-' + Math.random().toString(36).substring(2,6).toUpperCase();
    const result = await pool.query(
      'UPDATE school_accounts SET status=$1, account_code=$2, approved_at=NOW() WHERE id=$3 RETURNING *',
      ['approved', code, req.params.id]
    );
    const school = result.rows[0];

    // Email the school their approval + account code
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: school.email,
        subject: 'Your School Account is Approved — Lion and Lamb Publishing',
        html: '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
          + '<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
          + '<div style="background:#7b1f2e;padding:28px 36px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.3rem;font-weight:900">&#119070; Lion and Lamb Publishing</div></div>'
          + '<div style="padding:32px 36px">'
          + '<h2 style="font-family:Georgia,serif;font-size:1.4rem;margin-bottom:8px">Your account is approved!</h2>'
          + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:24px">Welcome, ' + school.director_name + '. ' + school.school_name + ' is now approved for school invoicing with Net 30 payment terms.</p>'
          + '<div style="background:#f7f3ec;border:1px solid #d6cfc2;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">'
          + '<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:#6b6257;margin-bottom:6px">Your Account Code</div>'
          + '<div style="font-family:monospace;font-size:1.6rem;font-weight:700;color:#0f0d0a;letter-spacing:0.05em">' + code + '</div>'
          + '<div style="font-size:0.78rem;color:#6b6257;margin-top:6px">Keep this code — you will need it to submit purchase orders.</div>'
          + '</div>'
          + '<p style="font-size:0.88rem;color:#6b6257;margin-bottom:20px"><strong>Payment terms:</strong> Net 30. You may pay by check or online via the invoice link.<br><strong>Checks payable to:</strong> Lion and Lamb Publishing</p>'
          + '<a href="https://lionandlambpublishing.com/for-directors.html" style="display:inline-block;background:#7b1f2e;color:#fff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">Submit Your First Order &#8594;</a>'
          + '</div></div></body></html>'
      });
    } catch(e) { console.error('Approval email error:', e.message); }

    res.json({ success: true, code, school });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deny school
app.post('/admin/schools/:id/deny', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { reason } = req.body;
    const result = await pool.query('UPDATE school_accounts SET status=$1, notes=$2 WHERE id=$3 RETURNING *', ['denied', reason||'', req.params.id]);
    const school = result.rows[0];
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM,
        to: school.email,
        subject: 'Lion and Lamb Publishing — Account Application Update',
        html: '<p>Dear ' + school.director_name + ',</p><p>Thank you for applying. Unfortunately we are unable to approve a school invoicing account at this time.' + (reason ? ' ' + reason : '') + '</p><p>You are still welcome to place orders using a credit card at <a href="https://lionandlambpublishing.com">lionandlambpublishing.com</a>.</p><p>Lion and Lamb Publishing</p>'
      });
    } catch(e) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify account code for PO submission
app.post('/school-verify', async (req, res) => {
  try {
    const { code, email } = req.body;
    const result = await pool.query('SELECT * FROM school_accounts WHERE account_code=$1 AND email=$2 AND status=$3', [code, email, 'approved']);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid account code or email. Please check and try again.' });
    res.json({ verified: true, school: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- INVOICING ----

// List invoices
app.get('/admin/invoices', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const invoices = await stripe.invoices.list({ limit: 50 });
    res.json(invoices.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      customer_name: inv.customer_name,
      customer_email: inv.customer_email,
      status: inv.status,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      due_date: inv.due_date,
      created: inv.created,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create + send invoice
app.post('/admin/invoices', async (req, res) => {
  const isAdmin = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  const accountCode = req.headers['x-account-code'];
  const accountEmail = req.headers['x-account-email'];
  let isSchoolOrder = false;
  if (!isAdmin && accountCode && accountEmail) {
    const schoolCheck = await pool.query('SELECT id FROM school_accounts WHERE account_code=$1 AND email=$2 AND status=$3', [accountCode, accountEmail, 'approved']);
    isSchoolOrder = schoolCheck.rows.length > 0;
    if (!isSchoolOrder) return res.status(401).json({ error: 'Your account code is invalid or not yet approved.' });
  } else if (!isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { customer_name, customer_email, school_name, items, days_until_due, notes } = req.body;
    if (!customer_email || !items || !items.length) return res.status(400).json({ error: 'Email and at least one item required' });

    // Find or create Stripe customer
    const existing = await stripe.customers.list({ email: customer_email, limit: 1 });
    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
      if (customer_name || school_name) {
        customer = await stripe.customers.update(customer.id, {
          name: customer_name || customer.name,
          metadata: { school: school_name || '' }
        });
      }
    } else {
      customer = await stripe.customers.create({
        email: customer_email,
        name: customer_name || '',
        metadata: { school: school_name || '' }
      });
    }

    // Create invoice
    const invoiceData = {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: parseInt(days_until_due) || 30,
      auto_advance: false
    };
    const checkInstructions = 'Payment by check accepted. Make checks payable to: Lion and Lamb Publishing. Net ' + (days_until_due || 30) + ' payment terms.';
    invoiceData.footer = [notes, checkInstructions].filter(Boolean).join(' | ');
    if (school_name) invoiceData.custom_fields = [{ name: 'School', value: school_name }];
    const invoice = await stripe.invoices.create(invoiceData);

    // Add line items
    for (const item of items) {
      const liData = {
        customer: customer.id,
        invoice: invoice.id,
        quantity: parseInt(item.quantity) || 1
      };
      if (item.price_id) {
        liData.price = item.price_id;
      } else {
        liData.price_data = {
          currency: 'usd',
          product_data: { name: item.description || 'Sheet Music' },
          unit_amount: Math.round(parseFloat(item.unit_amount) * 100)
        };
      }
      await stripe.invoiceItems.create(liData);
    }

    // Finalize and send invoice
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    const sent = await stripe.invoices.sendInvoice(finalized.id);

    // For school PO orders — send PDF download links immediately (don't wait for payment)
    if (isSchoolOrder) {
      try {
        // Find PDF products in the order — match by price_id first, fall back to title matching
        const priceIds = items.map(i => i.price_id).filter(Boolean);
        let matchedProducts = [];
        if (priceIds.length > 0) {
          const r = await pool.query(
            'SELECT * FROM products WHERE stripe_price_pdf = ANY($1) OR stripe_price_bundle = ANY($1)',
            [priceIds]
          );
          matchedProducts = r.rows.filter(p => p.download_url || p.audio_url);
        }
        if (matchedProducts.length === 0) {
          // fallback: match by description contains title
          const descriptions = items.map(i => (i.description || '').toLowerCase());
          const allProducts = await pool.query('SELECT * FROM products');
          matchedProducts = allProducts.rows.filter(p =>
            (p.download_url || p.audio_url) &&
            descriptions.some(d => d.includes(p.title.toLowerCase()))
          );
        }

        if (matchedProducts.length > 0) {
          const emailItems = await Promise.all(matchedProducts.map(async p => {
            let downloadUrl = null;
            try {
              let key = p.download_url || p.audio_url;
              if (key.startsWith('http')) key = new URL(key).pathname.replace(/^\//, '');
              downloadUrl = await getSignedDownloadUrl(key);
            } catch(e) { console.error('Sign URL error:', e.message); }
            return { title: p.title, composer: p.composer, ensemble: p.ensemble, downloadUrl };
          }));

          const html = buildEmailHtml(customer_name, emailItems);
          const mailer = getMailer();
          await mailer.emails.send({
            from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
            to: customer_email,
            subject: 'Your Lion and Lamb Publishing Order — Download Links Inside',
            html
          });
          console.log('School order PDF links sent immediately to', customer_email);
        } else {
          // No matched PDF products — send a confirmation email with invoice link
          const mailer = getMailer();
          const invoiceUrl = sent.hosted_invoice_url || '';
          await mailer.emails.send({
            from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
            to: customer_email,
            subject: 'Your Lion and Lamb Publishing Purchase Order — Confirmed',
            html: buildOrderConfirmHtml(customer_name, school_name, items, invoiceUrl, sent.number)
          });
          console.log('School order confirmation sent to', customer_email);
        }
      } catch (emailErr) {
        console.error('School order email error:', emailErr.message);
      }
    }

    res.json({
      id: sent.id,
      number: sent.number,
      customer_name: sent.customer_name,
      customer_email: sent.customer_email,
      status: sent.status,
      amount_due: sent.amount_due,
      due_date: sent.due_date,
      hosted_invoice_url: sent.hosted_invoice_url,
      invoice_pdf: sent.invoice_pdf
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Void invoice
app.delete('/admin/invoices/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const inv = await stripe.invoices.retrieve(req.params.id);
    let result;
    if (inv.status === 'draft') result = await stripe.invoices.del(req.params.id);
    else result = await stripe.invoices.voidInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend invoice
app.post('/admin/invoices/:id/resend', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await stripe.invoices.sendInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reset admin key
const fs = require('fs');
const path = require('path');
app.post('/admin/reset-key', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { newKey } = req.body;
  if (!newKey || newKey.length < 16) return res.status(400).json({ error: 'Key must be at least 16 characters' });
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  env = env.replace(/ADMIN_KEY=.*/, 'ADMIN_KEY=' + newKey);
  fs.writeFileSync(envPath, env);
  process.env.ADMIN_KEY = newKey;
  res.json({ success: true });
});

// Stripe checkout
function getMailer() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Generate a 48-hour signed download URL from Spaces
async function getSignedDownloadUrl(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new GetObjectCommand({ Bucket: process.env.SPACES_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: 172800 }); // 48 hours
}

// Build HTML email for order confirmation + download links
function buildEmailHtml(customerName, items) {
  const rows = items.map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e8e0d0">
        <strong style="font-family:Georgia,serif;font-size:1rem">${item.title}</strong><br>
        <span style="color:#6b6257;font-size:0.85rem">${item.composer || ''} ${item.ensemble ? '&middot; ' + item.ensemble : ''}</span>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e8e0d0;text-align:right;white-space:nowrap">
        ${item.downloadUrl
          ? `<a href="${item.downloadUrl}" style="background:#7b1f2e;color:#fff;padding:8px 16px;border-radius:5px;text-decoration:none;font-size:0.85rem;font-weight:600">Download PDF</a>`
          : `<span style="color:#6b6257;font-size:0.85rem">Print copy</span>`}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'DM Sans',Arial,sans-serif">
<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#7b1f2e;padding:32px 40px">
    <div style="color:#fff;font-family:Georgia,serif;font-size:1.4rem;font-weight:900">&#119070; Lion and Lamb Publishing</div>
    <div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:4px">Order Confirmation &amp; Download Links</div>
  </div>
  <div style="padding:32px 40px">
    <p style="font-size:1rem;color:#0f0d0a;margin-bottom:8px">Thank you${customerName ? ', ' + customerName : ''}!</p>
    <p style="color:#6b6257;font-size:0.9rem;margin-bottom:28px">Your order is confirmed. Download links below are valid for <strong>48 hours</strong>. Print as many copies as your ensemble needs.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="color:#6b6257;font-size:0.8rem;margin-top:28px">Need help? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>
  </div>
  <div style="background:#f7f3ec;padding:20px 40px;text-align:center;color:#6b6257;font-size:0.78rem;border-top:1px solid #e8e0d0">
    &copy; 2026 Lion and Lamb Publishing. All rights reserved.
  </div>
</div>
</body>
</html>`;
}

// Confirmation email for school PO orders (no PDF products matched)
function buildOrderConfirmHtml(name, school, items, invoiceUrl, invoiceNum) {
  const rows = items.map(i =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #e8e0d0;font-size:0.88rem"><strong>' + (i.description||'Item') + '</strong></td>'
    + '<td style="padding:10px 0;border-bottom:1px solid #e8e0d0;text-align:center;font-size:0.88rem;color:#6b6257">x' + (i.quantity||1) + '</td>'
    + '<td style="padding:10px 0;border-bottom:1px solid #e8e0d0;text-align:right;font-size:0.88rem">$' + parseFloat(i.unit_amount||0).toFixed(2) + '</td></tr>'
  ).join('');
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
    + '<div style="background:#7b1f2e;padding:32px 40px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.4rem;font-weight:900">&#119070; Lion and Lamb Publishing</div>'
    + '<div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:4px">Purchase Order Confirmed</div></div>'
    + '<div style="padding:32px 40px">'
    + '<p style="font-size:1rem;color:#0f0d0a;margin-bottom:8px">Thank you' + (name ? ', ' + name : '') + '!</p>'
    + (school ? '<p style="color:#6b6257;font-size:0.88rem;margin-bottom:16px">' + school + '</p>' : '')
    + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:24px">Your purchase order has been received. An invoice' + (invoiceNum ? ' (' + invoiceNum + ')' : '') + ' has been sent to your email with payment instructions.</p>'
    + '<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Item</th><th style="text-align:center;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Qty</th><th style="text-align:right;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Price</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (invoiceUrl ? '<div style="text-align:center;margin-top:28px"><a href="' + invoiceUrl + '" style="background:#7b1f2e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">View Invoice & Pay Online</a></div>' : '')
    + '<p style="color:#6b6257;font-size:0.78rem;margin-top:28px">Questions? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>'
    + '</div><div style="background:#f7f3ec;padding:16px 40px;text-align:center;color:#6b6257;font-size:0.75rem;border-top:1px solid #e8e0d0">&copy; 2026 Lion and Lamb Publishing</div></div></body></html>';
}

// Stripe Checkout — pass product IDs as metadata
app.post('/create-checkout-session', async (req, res) => {
  const { items } = req.body;
  try {
    // items should be: [{ price_id, product_id, quantity }]
    const lineItems = items.map(i => ({
      price: i.price_id,
      quantity: i.quantity || 1
    }));
    const productIds = items.map(i => i.product_id).filter(Boolean).join(',');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      line_items: lineItems,
      mode: 'payment',
      customer_creation: 'if_required',
      metadata: { product_ids: productIds },
      success_url: process.env.DOMAIN + '/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.DOMAIN + '/cart.html',
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stripe Webhook — send download links after successful payment
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details && session.customer_details.email;
    const customerName = session.customer_details && session.customer_details.name;
    const productIds = (session.metadata && session.metadata.product_ids || '').split(',').filter(Boolean);

    if (!customerEmail) {
      console.log('No customer email in session, skipping email');
      return res.json({ received: true });
    }

    try {
      // Look up products
      let emailItems = [];
      if (productIds.length > 0) {
        const placeholders = productIds.map((_, i) => '$' + (i + 1)).join(',');
        const result = await pool.query(
          'SELECT title, composer, ensemble, format, download_url, audio_url FROM products WHERE id IN (' + placeholders + ')',
          productIds.map(Number)
        );
        emailItems = await Promise.all(result.rows.map(async p => {
          let downloadUrl = null;
          const fileField = p.download_url || (p.format === 'PDF' ? p.audio_url : null);
          if (fileField) {
            let key = fileField;
            if (key.startsWith('http')) {
              const url = new URL(key);
              key = url.pathname.replace(/^\//, '');
            }
            try { downloadUrl = await getSignedDownloadUrl(key); } catch(e) { console.error('Sign URL error:', e.message); }
          }
          return { title: p.title, composer: p.composer, ensemble: p.ensemble, downloadUrl };
        }));
      }

      if (emailItems.length === 0) {
        emailItems = [{ title: 'Your order', composer: '', ensemble: '', downloadUrl: null }];
      }

      const html = buildEmailHtml(customerName, emailItems);
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <onboarding@resend.dev>',
        to: customerEmail,
        subject: 'Your Lion and Lamb Publishing Order — Download Links Inside',
        html
      });
      console.log('Order email sent to', customerEmail);
    } catch (err) {
      console.error('Email send error:', err.message);
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const customerEmail = invoice.customer_email;
    const customerName = invoice.customer_name;
    const invoiceUrl = invoice.hosted_invoice_url;
    const invoiceNum = invoice.number;
    if (customerEmail) {
      try {
        const mailer = getMailer();
        await mailer.emails.send({
          from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
          to: customerEmail,
          subject: 'Payment Received — Lion and Lamb Publishing' + (invoiceNum ? ' (' + invoiceNum + ')' : ''),
          html: '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
            + '<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
            + '<div style="background:#7b1f2e;padding:28px 36px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.3rem;font-weight:900">&#119070; Lion and Lamb Publishing</div></div>'
            + '<div style="padding:32px 36px">'
            + '<h2 style="font-family:Georgia,serif;font-size:1.4rem;margin-bottom:8px">Payment received!</h2>'
            + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:20px">Thank you' + (customerName ? ', ' + customerName : '') + '. We have received your payment' + (invoiceNum ? ' for invoice ' + invoiceNum : '') + '.</p>'
            + (invoiceUrl ? '<div style="text-align:center;margin-bottom:20px"><a href="' + invoiceUrl + '" style="background:#7b1f2e;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">View Invoice</a></div>' : '')
            + '<p style="color:#6b6257;font-size:0.8rem">Questions? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>'
            + '</div></div></body></html>'
        });
        console.log('Invoice payment confirmation sent to', customerEmail);
      } catch (err) {
        console.error('Invoice payment email error:', err.message);
      }
    }
  }

  res.json({ received: true });
});

// Get order details by Stripe session ID (for success page)
app.get('/order/:session_id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.session_id);
    res.json({
      email: session.customer_details && session.customer_details.email,
      name: session.customer_details && session.customer_details.name,
      amount: session.amount_total,
      currency: session.currency
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => console.log('Server running on port 3000'));
