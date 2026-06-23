const db = require('../config/db');
const cache = require('../config/cache');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Helper to check the number of active pending tickets (matching PHP open_ticket)
async function getOpenTicketCount(clientId) {
  const rows = await db.query("SELECT COUNT(*) AS total FROM tickets WHERE client_id = ? AND status = 'pending'", [clientId]);
  return parseInt(rows[0].total || 0);
}

// Helper to extract client IP address
function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

class SupportController {
  
  // GET /support/config
  async getConfig(req, res, next) {
    try {
      const settingsRows = await db.query('SELECT * FROM settings WHERE id = 1 LIMIT 1');
      const settings = settingsRows[0] || {};
      
      const siteName = settings.site_name || 'SMM Panel';
      let siteLogo = settings.site_logo || '';
      if (siteLogo && !siteLogo.startsWith('http')) {
        siteLogo = `https://smmtor.com/${siteLogo.replace(/^\//, '')}`;
      }
      
      // Parse Google login settings
      let googleLoginEnabled = false;
      try {
        if (settings.google_login) {
          const googleSettings = JSON.parse(settings.google_login);
          googleLoginEnabled = parseInt(googleSettings.status) === 1;
        }
      } catch (e) {}
      
      return res.status(200).json({
        site_name: siteName,
        site_logo: siteLogo,
        current_app_version: '1.0.0',
        force_update_required: false,
        server_maintenance_mode: parseInt(settings.site_maintenance) === 1,
        google_client_id: settings.google_client_id || '',
        google_login_enabled: googleLoginEnabled,
        chat_buttons: {
          whatsapp: {
            enabled: parseInt(settings.whatsappbutton) === 1,
            position: settings.whatsappposition || 'right',
            number: settings.whatsappnumber || '',
            message: settings.whatsappcolour || ''
          },
          telegram: {
            enabled: parseInt(settings.telegrambutton) === 1,
            position: settings.telegramposition || 'left',
            username: (settings.telegramusername || '').replace(/^@/, '')
          }
        },
        registration_fields: {
          name: parseInt(settings.name_fileds) === 1,
          phone: parseInt(settings.skype_feilds) === 2,
          whatsapp: parseInt(settings.whatsapp_field) === 1,
          telegram: parseInt(settings.telegram_field) === 1,
          website: parseInt(settings.website_field) === 1,
          terms: parseInt(settings.terms_checkbox) === 2
        },
        captcha: {
          recaptcha: {
            enabled: parseInt(settings.recaptcha_user) === 2,
            sitekey: settings.recaptcha_key || ''
          },
          hcaptcha: {
            enabled: parseInt(settings.hcaptcha_user) === 2,
            sitekey: settings.hcaptcha_site_key || ''
          },
          turnstile: {
            enabled: parseInt(settings.turnstile_user) === 2,
            sitekey: settings.turnstile_key || ''
          }
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/faq
  async getFaqs(req, res, next) {
    try {
      const cacheKey = 'site_faqs';
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.status(200).json({ faqs: cached });
      }

      // Hardcoded FAQs matching PHP SupportController.php
      const faqs = [
        {
          question: 'How long does order delivery take?',
          answer: 'Delivery times vary per service and are listed in the service details. Most orders start within minutes.'
        },
        {
          question: 'What is a Refill?',
          answer: 'If a service experiences a drop in followers/likes within the warranty period, clicking Refill will replenish the drop for free.'
        },
        {
          question: 'Is it safe to use SMMTor services?',
          answer: 'Yes, our social media growth services comply with play store standards and use safe delivery systems.'
        }
      ];

      cache.set(cacheKey, faqs, 600); // Cache for 10 minutes (600 seconds)
      return res.status(200).json({ faqs });
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/terms
  async getTerms(req, res, next) {
    try {
      return res.status(200).json({
        title: 'Terms of Service',
        content: 'By placing an order on our platform, you automatically accept all the terms of service listed below. We reserve the right to change these terms without notice.'
      });
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/privacy
  async getPrivacy(req, res, next) {
    try {
      return res.status(200).json({
        title: 'Privacy Policy',
        content: 'We value your privacy. We collect your username and email solely for account management and security. Your financial transactions are processed securely through payment gateways.'
      });
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/contact
  async submitContact(req, res, next) {
    try {
      // Fetch dynamic contact info from database admins table
      let email = 'support@smmtor.com';
      let phone = '+8801307644289';
      let whatsapp = '+8801307644289';
      let telegram = '@smmtor_support';
      let activeHours = '10:00 AM - 10:00 PM (GMT +6)';
      
      try {
        let adminRows = await db.query("SELECT * FROM admins WHERE admin_type = '3' LIMIT 1");
        if (!adminRows || adminRows.length === 0) {
          adminRows = await db.query('SELECT * FROM admins ORDER BY admin_id ASC LIMIT 1');
        }
        
        if (adminRows && adminRows.length > 0) {
          const admin = adminRows[0];
          if (admin.admin_email) email = admin.admin_email;
          if (admin.telephone) phone = admin.telephone;
          if (admin.whatsapp) {
            whatsapp = admin.whatsapp;
          } else if (admin.telephone) {
            whatsapp = admin.telephone;
          }
          if (admin.telegram) telegram = admin.telegram;
          if (admin.active_hours) activeHours = admin.active_hours;
        }
      } catch (ex) {
        // Ignore and fallback
      }
      
      return res.status(200).json({
        email,
        phone,
        whatsapp,
        telegram,
        active_hours: activeHours
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/tickets
  async getTickets(req, res, next) {
    try {
      const user = req.user;
      
      const tickets = await db.query(
        'SELECT ticket_id as id, subject, status, time, lastupdate_time FROM tickets WHERE client_id = ? ORDER BY lastupdate_time DESC',
        [user.client_id]
      );
      
      return res.status(200).json({ tickets });
      
    } catch (error) {
      next(error);
    }
  }
  
  // GET /support/ticket-subjects
  async getTicketSubjects(req, res, next) {
    try {
      const rows = await db.query(
        `SELECT subject_id, subject, extra_field_label, extra_field_placeholder, extra_field_required
         FROM ticket_subjects ORDER BY subject_id ASC`
      );

      const subjects = (rows || []).map((row) => ({
        id: parseInt(row.subject_id),
        subject: row.subject,
        extra_field_label: row.extra_field_label || '',
        extra_field_placeholder: row.extra_field_placeholder || '',
        extra_field_required: parseInt(row.extra_field_required || 0) === 1
      }));

      return res.status(200).json({ subjects });
    } catch (error) {
      next(error);
    }
  }

  // POST /support/tickets
  async createTicket(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const user = req.user;
      const subjectId = parseInt(req.body.subject_id || 0);
      let subject = (req.body.subject || '').trim();
      const extraField = (req.body.extra_field || '').trim();
      let message = (req.body.message || '').trim();

      let subjectRow = null;
      if (subjectId > 0) {
        const rows = await db.query('SELECT * FROM ticket_subjects WHERE subject_id = ? LIMIT 1', [subjectId]);
        subjectRow = rows && rows[0] ? rows[0] : null;
        if (subjectRow) subject = subjectRow.subject;
      } else if (subject) {
        const rows = await db.query('SELECT * FROM ticket_subjects WHERE subject = ? LIMIT 1', [subject]);
        subjectRow = rows && rows[0] ? rows[0] : null;
      }

      if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
      }

      if (subjectRow && subjectRow.extra_field_label) {
        if (parseInt(subjectRow.extra_field_required) === 1 && !extraField) {
          return res.status(400).json({ error: `${subjectRow.extra_field_label} is required for this subject` });
        }
        if (extraField) {
          message = `${subjectRow.extra_field_label}: ${extraField}\n\n${message}`;
        }
      }
      
      // Load user ticket limit constraint
      const settingsRows = await db.query('SELECT tickets_per_user FROM settings WHERE id = 1 LIMIT 1');
      const maxTickets = parseInt(settingsRows[0].tickets_per_user || '5');
      
      const openTicketsCount = await getOpenTicketCount(user.client_id);
      if (openTicketsCount >= maxTickets) {
        return res.status(400).json({ error: `You cannot open a new ticket because you have reached the maximum active support ticket limit of ${maxTickets}` });
      }
      
      const now = new Date();
      const formattedDotDate = now.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      const ip = getIP(req);
      
      // Start transaction
      await connection.beginTransaction();
      
      // 1. Insert support ticket
      const [insertTicketResult] = await connection.execute(
        "INSERT INTO tickets (client_id, subject, time, lastupdate_time, status, client_new, support_new) VALUES (?, ?, ?, ?, 'pending', '2', '1')",
        [user.client_id, subject, formattedDotDate, formattedDotDate]
      );
      
      const ticketId = insertTicketResult.insertId;
      
      // 2. Insert initial reply message
      await connection.execute(
        'INSERT INTO ticket_reply (ticket_id, message, time, support) VALUES (?, ?, ?, \'1\')',
        [ticketId, message, formattedDotDate]
      );
      
      // 3. Log action in client_report
      await connection.execute(
        'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
        [user.client_id, `New support ticket created via Mobile API. ID: #${ticketId}`, ip, formattedDate]
      );
      
      await connection.commit();
      
      return res.status(200).json({
        message: 'Support ticket created successfully',
        ticket_id: parseInt(ticketId)
      });
      
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }
  
  // GET /support/tickets/:id
  async getMessages(req, res, next) {
    try {
      const user = req.user;
      const ticketId = parseInt(req.params.id || 0);
      
      if (ticketId <= 0) {
        return res.status(400).json({ error: 'Ticket ID is required' });
      }
      
      // Verify ticket ownership
      const ticketRows = await db.query('SELECT * FROM tickets WHERE ticket_id = ? AND client_id = ? LIMIT 1', [ticketId, user.client_id]);
      if (!ticketRows || ticketRows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found or access denied' });
      }
      
      const ticket = ticketRows[0];
      
      // Fetch ticket replies
      const replies = await db.query(
        'SELECT id, message, time, support FROM ticket_reply WHERE ticket_id = ? ORDER BY id ASC',
        [ticketId]
      );
      
      const messages = replies.map(r => ({
        id: parseInt(r.id),
        message: r.message,
        time: r.time,
        is_admin: String(r.support) === '2' // '2' represents admin support response
      }));
      
      return res.status(200).json({
        ticket: {
          id: parseInt(ticket.ticket_id),
          subject: ticket.subject,
          status: ticket.status,
          time: ticket.time,
          lastupdate_time: ticket.lastupdate_time
        },
        messages
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  // POST /support/tickets/:id/reply
  async replyTicket(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const user = req.user;
      const ticketId = parseInt(req.params.id || 0);
      const message = (req.body.message || '').trim();
      
      if (ticketId <= 0 || !message) {
        return res.status(400).json({ error: 'Ticket ID and message are required' });
      }
      
      // Verify ownership
      const ticketRows = await db.query('SELECT * FROM tickets WHERE ticket_id = ? AND client_id = ? LIMIT 1', [ticketId, user.client_id]);
      if (!ticketRows || ticketRows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found or access denied' });
      }
      
      const ticket = ticketRows[0];
      if (parseInt(ticket.canmessage) === 1) {
        return res.status(400).json({ error: 'You cannot message this ticket thread at the moment' });
      }
      
      const now = new Date();
      const formattedDotDate = now.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      const ip = getIP(req);
      
      await connection.beginTransaction();
      
      // 1. Insert reply: support defaults to '1' (which is client)
      await connection.execute(
        'INSERT INTO ticket_reply (ticket_id, message, time, support) VALUES (?, ?, ?, \'1\')',
        [ticketId, message, formattedDotDate]
      );
      
      // 2. Update ticket meta status
      await connection.execute(
        "UPDATE tickets SET lastupdate_time = ?, status = 'pending', client_new = '2' WHERE ticket_id = ?",
        [formattedDotDate, ticketId]
      );
      
      // 3. Log action in client_report
      await connection.execute(
        'INSERT INTO client_report (client_id, action, report_ip, report_date) VALUES (?, ?, ?, ?)',
        [user.client_id, `Support request answered. ID: #${ticketId}`, ip, formattedDate]
      );
      
      await connection.commit();
      
      return res.status(200).json({
        message: 'Reply posted successfully',
        time: formattedDotDate
      });
      
    } catch (error) {
      await connection.rollback();
      next(error);
    } finally {
      connection.release();
    }
  }

  // POST /support/bug-report
  async submitBugReport(req, res, next) {
    try {
      const user = req.user;
      const category = (req.body.category || 'report_bug').trim();
      const message = (req.body.message || '').trim();
      const email = (req.body.email || user.email || '').trim();
      const imagesInput = req.body.images || [];
      const allowedCategories = ['report_bug', 'suggestion', 'other'];

      if (!allowedCategories.includes(category)) {
        return res.status(400).json({ error: 'Invalid report category' });
      }
      if (!message) {
        return res.status(400).json({ error: 'Please describe your issue or feedback' });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email address is required' });
      }

      const images = Array.isArray(imagesInput) ? imagesInput : [];
      if (images.length > 5) {
        return res.status(400).json({ error: 'You can upload a maximum of 5 images' });
      }

      const savedImageUrls = [];
      const uploadDir = path.join(__dirname, '..', 'uploads', 'bug_reports');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';

      for (let i = 0; i < images.length; i++) {
        const raw = String(images[i] || '').trim();
        if (!raw) continue;

        const match = raw.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
        const base64Data = match ? match[2] : raw;
        const ext = match ? (match[1].toLowerCase() === 'png' ? 'png' : 'jpg') : 'jpg';

        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > 1024 * 1024) {
          return res.status(400).json({ error: 'Each image must be 1MB or smaller' });
        }

        const fileName = `bug_${user.client_id}_${Date.now()}_${i}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const destPath = path.join(uploadDir, fileName);
        fs.writeFileSync(destPath, buffer);
        savedImageUrls.push(`${protocol}://${req.get('host')}/uploads/bug_reports/${fileName}`);
      }

      const platform = (req.body.platform || 'mobile_app').trim();
      const appVersion = (req.body.app_version || '').trim() || null;
      const deviceParts = [];
      if (appVersion) deviceParts.push(`App v${appVersion}`);
      if (req.body.device_os) deviceParts.push(req.body.device_os);
      if (req.body.device_model) deviceParts.push(req.body.device_model);
      const deviceInfo = deviceParts.length ? deviceParts.join(' | ') : null;

      const now = new Date();
      const formattedDate = now.toISOString().slice(0, 19).replace('T', ' ');
      const ip = getIP(req);

      const [result] = await db.pool.execute(
        `INSERT INTO app_bug_reports
          (client_id, category, message, email, images, platform, device_info, app_version, status, report_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          user.client_id,
          category,
          message,
          email,
          savedImageUrls.length ? JSON.stringify(savedImageUrls) : null,
          platform,
          deviceInfo,
          appVersion,
          ip,
          formattedDate
        ]
      );

      await db.query(
        'INSERT INTO client_report (client_id, action, report_ip, report_platform, device_info, report_date) VALUES (?, ?, ?, ?, ?, ?)',
        [user.client_id, `Bug/feedback report submitted. ID: #${result.insertId}`, ip, platform, deviceInfo, formattedDate]
      );

      return res.status(200).json({
        message: 'Your report has been submitted successfully. Thank you!',
        report_id: parseInt(result.insertId)
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new SupportController();
