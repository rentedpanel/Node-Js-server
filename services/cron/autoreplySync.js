const db = require('../../config/db');
const logger = require('../../config/logger');
const { nowSql, getSettings } = require('./cronHelpers');

async function runAutoreplySync() {
  const settings = await getSettings();
  const tickets = await db.query(
    'SELECT tickets.*, clients.email FROM tickets INNER JOIN clients ON clients.client_id = tickets.client_id'
  );

  for (const ticket of tickets) {
    const replies = await db.query(
      'SELECT * FROM ticket_reply WHERE ticket_id = ?',
      [ticket.ticket_id]
    );

    if (replies.length !== 1) continue;

    const message = "We have Sended You message to further support team. We're hardly working to solve you issues please be calm and wait for support team reply";
    const time = nowSql();

    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [insertResult] = await connection.execute(
        `INSERT INTO ticket_reply SET ticket_id = ?, time = ?, support = '2', message = ?, client_id = '0'`,
        [ticket.ticket_id, time, message]
      );

      await connection.execute(
        `UPDATE tickets SET canmessage = 2, status = 'answered', lastupdate_time = ?, support_new = 2 WHERE ticket_id = ?`,
        [time, ticket.ticket_id]
      );

      await connection.commit();

      if (String(settings.alert_newmessage) === '2' && ticket.email) {
        const siteUrl = (process.env.SITE_URL || process.env.PANEL_URL || '').replace(/\/$/, '');
        const ticketUrl = siteUrl ? `${siteUrl}/tickets/${insertResult.insertId}` : '';
        logger.info(`[CRON:autoreply] Ticket #${ticket.ticket_id} auto-replied. Email: ${ticket.email} URL: ${ticketUrl}`);
        // Email requires SMTP config — log only (same as optional mail() in PHP)
      }
    } catch (err) {
      await connection.rollback();
      logger.error(`[CRON:autoreply] Ticket #${ticket.ticket_id}: ${err.message}`);
    } finally {
      connection.release();
    }
  }
}

module.exports = { runAutoreplySync };
