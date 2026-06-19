const db = require('../config/db');
const cache = require('../config/cache');

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
  
  // POST /support/tickets
  async createTicket(req, res, next) {
    const connection = await db.pool.getConnection();
    try {
      const user = req.user;
      const subject = (req.body.subject || '').trim();
      const message = (req.body.message || '').trim();
      
      if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
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
}

module.exports = new SupportController();
